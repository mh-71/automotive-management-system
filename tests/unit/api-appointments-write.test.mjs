/* POST / PUT / DELETE /api/appointments — unit tests against the REAL Worker
   handlers with a stubbed D1 binding.

   Appointments reuse the C-2 shared writer, so the plumbing it owns -- body
   parsing, id allocation, merge semantics, envelopes -- is already covered by
   write-crud.test.mjs. What is specific to appointments, and therefore what
   this suite is about, is the four scheduling rules:

     1. overlap, scoped to the SAME MECHANIC OR THE SAME VEHICLE, against
        blocking statuses only, on the half-open interval
        (existingStart < newEnd AND existingEnd > newStart);
     2. an exact duplicate booking, which ignores only Cancelled -- not every
        terminal status;
     3. status transitions, which are legal only where TRANSITIONS says so,
        and never at all out of a terminal status;
     4. three delete blockers, none of which is a foreign key.

   Every one of them is a question about the record as it will be AFTER the
   write, so the update tests care as much about what is merged in as about
   what was sent. */
import worker from '../../src/index.js';

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  good ? pass++ : fail++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name}`);
  if (!good) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
};
const ok_ = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
};

/**
 * Answers the five statement shapes an appointment write produces, each keyed
 * by something unmistakable in its SQL.
 *
 * `guard`   what the combined scheduling query reports. All four answers null
 *           means "the slot is free and the vehicle belongs to the customer".
 * `current` the stored row an update merges over.
 * `target`  the row the delete guard reads.
 */
function stubDB({
  guard = { vehicle_owner: null, clash_id: null, clash_reason: null, duplicate_id: null },
  current = null,
  target = null,
  returning = { id: 'APT-0001' },
  changes = 1,
  counter = { last_value: 1, prefix: 'APT' },
  throwOnInsert = null,
} = {}) {
  const calls = [];
  return {
    calls,
    get sql() { return calls.map((c) => c.sql).join('\n'); },
    find(fragment) { return calls.find((c) => c.sql.includes(fragment)); },
    prepare(sql) {
      const entry = { sql, binds: null };
      // The router logs each successful write for offline sync (0020, lib/changes.js)
      // AFTER it commits; these assertions are about the route's own statements.
      if (!/INSERT INTO change_log/.test(sql)) calls.push(entry);
      const stmt = {
        bind(...args) { entry.binds = args; return stmt; },
        async first() {
          if (sql.includes('id_counters')) return counter;
          if (sql.includes('WITH clash')) return guard;
          if (sql.includes('job_card_id, status')) return target;
          if (/^\s*SELECT customer_id, vehicle_id/.test(sql.trim())) return current;
          if (/^\s*(INSERT|UPDATE)\s+(INTO\s+)?appointments/i.test(sql.trim())) {
            if (throwOnInsert) throw new Error(throwOnInsert);
            return returning;
          }
          return null;
        },
        async all() { return { results: [] }; },
        async run() { return { success: true, meta: { changes } }; },
      };
      return stmt;
    },
  };
}

// C-9 put a bearer-token gate in front of every mutation, so this suite
// authenticates the way any caller does: the token in the header, and the
// Worker's own secret in the env it is handed. The gate itself is tested in
// api-auth.test.mjs -- here it is simply satisfied, so these assertions stay
// about the route. An env without a DB still has the token, so a missing
// binding is still answered by the route rather than by the gate.
const TEST_TOKEN = 'unit-test-token';
const call = (path, env, method, body) =>
  worker.fetch(new Request('http://worker.local' + path, {
    method,
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), { API_TOKEN: TEST_TOKEN, ...env });
const post = (body, db) => call('/api/appointments', { DB: db ?? stubDB() }, 'POST', body);
const put = (id, body, db) => call(`/api/appointments/${id}`, { DB: db ?? stubDB() }, 'PUT', body);
const del = (id, db) => call(`/api/appointments/${id}`, { DB: db ?? stubDB() }, 'DELETE');

// Far enough ahead that the "no new appointments in the past" rule never fires
// for reasons of the calendar rather than the test.
const FUTURE = '2099-06-15';
const VALID = {
  customerId: 'CUS-0001', vehicleId: 'VEH-0001', serviceId: 'SRV-0001',
  mechanicId: 'MEC-0001', date: FUTURE, time: '10:00', duration: 60, source: 'Phone',
};
const STORED = {
  customer_id: 'CUS-0001', vehicle_id: 'VEH-0001', service_id: 'SRV-0001',
  mechanic_id: 'MEC-0001', date: FUTURE, time: '10:00', duration: 60, status: 'Scheduled',
};
const FREE = { vehicle_owner: 'CUS-0001', clash_id: null, clash_reason: null, duplicate_id: null };

console.log('\n-- 1. Create --');
{
  const db = stubDB({ guard: FREE });
  const res = await post(VALID, db);
  ok_('POST -> 201', res.status === 201, `got ${res.status} ${JSON.stringify(await res.clone().json())}`);
  const b = await res.json();
  check('returns the created record', b.data.id, 'APT-0001');

  ok_('allocates an APT id through id_counters', !!db.find('id_counters'), db.sql);
  const insert = db.find('INSERT INTO appointments');
  ok_('one INSERT', !!insert, db.sql);
  ok_('   ...with RETURNING rather than a second SELECT', /RETURNING/i.test(insert.sql));
  const cols = insert.sql.slice(insert.sql.indexOf('('), insert.sql.indexOf(')'));
  ok_('   ...sets created_at', cols.includes('created_at'));
  ok_('   ...not updated_at', !cols.includes('updated_at'));
  ok_('   ...every value bound', /\?\d/.test(insert.sql) && !insert.sql.includes("'"), insert.sql);

  check('exactly 3 statements: guard, allocate, insert', db.calls.length, 3);
}

console.log('\n-- 2. Create: defaults and required fields --');
{
  const db = stubDB({ guard: FREE });
  await post(VALID, db);
  const binds = db.find('INSERT INTO appointments').binds;
  ok_('status defaults to Scheduled', binds.includes('Scheduled'), JSON.stringify(binds));
  ok_('reminder_sent defaults to 0, not null', binds.includes(0), JSON.stringify(binds));
  const cols = db.find('INSERT INTO appointments').sql;
  ok_('reminder_sent is written on create', cols.includes('reminder_sent'), cols);

  for (const field of ['customerId', 'vehicleId', 'serviceId', 'date', 'time', 'duration', 'source']) {
    const body = { ...VALID };
    delete body[field];
    const d = stubDB({ guard: FREE });
    const r = await post(body, d);
    const rb = await r.json();
    ok_(`without \`${field}\` -> 422`, r.status === 422, `got ${r.status}`);
    ok_('   ...names the field', rb.error.fields && field in rb.error.fields, rb.error);
    ok_('   ...nothing reached the database', d.calls.length === 0, `${d.calls.length}`);
  }

  // mechanicId is the one optional reference.
  const noMech = await post({ ...VALID, mechanicId: undefined }, stubDB({ guard: FREE }));
  ok_('mechanicId is optional', noMech.status === 201, `got ${noMech.status}`);
  const blankMech = stubDB({ guard: FREE });
  await post({ ...VALID, mechanicId: '' }, blankMech);
  ok_("an empty mechanicId is stored as NULL, not ''",
    blankMech.find('INSERT INTO appointments').binds.includes(null),
    JSON.stringify(blankMech.find('INSERT INTO appointments').binds));
  const nullMech = await post({ ...VALID, mechanicId: null }, stubDB({ guard: FREE }));
  ok_('an explicit null mechanicId is accepted', nullMech.status === 201, `got ${nullMech.status}`);
}

console.log('\n-- 3. Create: the five sources and the two creatable statuses --');
{
  for (const source of ['Admin', 'Phone', 'Walk-in', 'Facebook', 'Website']) {
    const db = stubDB({ guard: FREE });
    const r = await post({ ...VALID, source }, db);
    ok_(`source "${source}" accepted`, r.status === 201, `got ${r.status}`);
    ok_(`   ...and bound verbatim`, db.find('INSERT INTO appointments').binds.includes(source),
      JSON.stringify(db.find('INSERT INTO appointments').binds));
  }
  for (const bad of ['website', 'WALK-IN', 'Walk in', 'Instagram', 'Referral', '', 'Phone ']) {
    const r = await post({ ...VALID, source: bad }, stubDB({ guard: FREE }));
    ok_(`source ${JSON.stringify(bad)} refused`, r.status === 422, `got ${r.status}`);
  }

  // :391 — a new appointment may only be Scheduled or Confirmed.
  for (const status of ['Scheduled', 'Confirmed']) {
    const r = await post({ ...VALID, status }, stubDB({ guard: FREE }));
    ok_(`status "${status}" creatable`, r.status === 201, `got ${r.status}`);
  }
  for (const status of ['In Progress', 'Completed', 'Cancelled', 'No Show']) {
    const r = await post({ ...VALID, status }, stubDB({ guard: FREE }));
    ok_(`status "${status}" not creatable`, r.status === 422, `got ${r.status}`);
  }
}

console.log('\n-- 4. Create: field values --');
{
  for (const [field, value] of [
    ['duration', 0], ['duration', -30], ['duration', 601], ['duration', 1.5], ['duration', 'abc'],
    ['time', '25:00'], ['time', '10:60'], ['time', '9:00'], ['time', '10'], ['time', 'morning'],
    ['date', '15-06-2099'], ['date', '2099-02-31'], ['date', 'tomorrow'],
  ]) {
    const r = await post({ ...VALID, [field]: value }, stubDB({ guard: FREE }));
    const b = await r.json();
    ok_(`${field}=${JSON.stringify(value)} -> 422`, r.status === 422, `got ${r.status}`);
    ok_('   ...names the field', b.error.fields && field in b.error.fields, b.error);
  }
  for (const duration of [1, 30, 60, 600]) {
    const r = await post({ ...VALID, duration }, stubDB({ guard: FREE }));
    ok_(`duration ${duration} accepted`, r.status === 201, `got ${r.status}`);
  }
  for (const time of ['00:00', '09:05', '23:59']) {
    const r = await post({ ...VALID, time }, stubDB({ guard: FREE }));
    ok_(`time ${time} accepted`, r.status === 201, `got ${r.status}`);
  }

  // :457 — only a NEW appointment is barred from the past.
  const past = await post({ ...VALID, date: '2020-01-01' }, stubDB({ guard: FREE }));
  const pb = await past.json();
  ok_('a past date on create -> 422', past.status === 422, `got ${past.status}`);
  check('   ...with the frontend\'s own wording', pb.error.fields.date,
    'New appointments cannot be in the past.');

  // reminderSent is the app's only boolean.
  const t = stubDB({ guard: FREE });
  await post({ ...VALID, reminderSent: true }, t);
  ok_('reminderSent true binds 1', t.find('INSERT INTO appointments').binds.includes(1),
    JSON.stringify(t.find('INSERT INTO appointments').binds));
  for (const bad of ['true', 1, 0, 'yes']) {
    const r = await post({ ...VALID, reminderSent: bad }, stubDB({ guard: FREE }));
    ok_(`reminderSent ${JSON.stringify(bad)} refused — it is a boolean`, r.status === 422, `got ${r.status}`);
  }

  // Linking a job card belongs to the Job Card phase.
  for (const value of ['JOB-0001', null, '']) {
    const d = stubDB({ guard: FREE });
    const r = await post({ ...VALID, jobCardId: value }, d);
    const b = await r.json();
    ok_(`jobCardId ${JSON.stringify(value)} refused`, r.status === 422, `got ${r.status}`);
    ok_('   ...by name', b.error.fields && 'jobCardId' in b.error.fields, b.error);
    ok_('   ...nothing reached the database', d.calls.length === 0);
  }
}

console.log('\n-- 5. Create: malformed bodies --');
for (const [label, raw] of [
  ['no body', ''], ['malformed JSON', '{oops'], ['an array', '[]'], ['null', 'null'],
]) {
  const db = stubDB();
  const res = await call('/api/appointments', { DB: db }, 'POST', raw);
  ok_(`${label} -> 400`, res.status === 400, `got ${res.status}`);
  ok_('   ...nothing prepared', db.calls.length === 0);
}

console.log('\n-- 6. The vehicle must belong to the customer --');
{
  const wrong = await post(VALID, stubDB({ guard: { ...FREE, vehicle_owner: 'CUS-0099' } }));
  const b = await wrong.json();
  ok_('a vehicle owned by someone else -> 422', wrong.status === 422, `got ${wrong.status}`);
  check('   ...with the frontend\'s wording', b.error.fields.vehicleId,
    'This vehicle does not belong to the selected customer.');

  // A vehicle that does not exist at all is left to the foreign key, not
  // pre-checked here.
  const missing = await post(VALID, stubDB({ guard: { ...FREE, vehicle_owner: null } }));
  ok_('a missing vehicle is not rejected here — the FK will do it',
    missing.status === 201, `got ${missing.status}`);
}

console.log('\n-- 7. Overlap --');
{
  const clash = await post(VALID, stubDB({
    guard: { ...FREE, clash_id: 'APT-0007', clash_reason: 'mechanic' },
  }));
  const b = await clash.json();
  ok_('an overlapping slot -> 409', clash.status === 409, `got ${clash.status}`);
  check('   ...code', b.error.code, 'conflict');
  check('   ...machine-readable reason', b.error.reason, 'schedule_conflict');
  check('   ...names the appointment', b.error.conflictsWith, 'APT-0007');
  check('   ...and the resource', b.error.resource, 'mechanic');

  const byVehicle = await post(VALID, stubDB({
    guard: { ...FREE, clash_id: 'APT-0008', clash_reason: 'vehicle' },
  }));
  check('a vehicle clash reports the vehicle', (await byVehicle.json()).error.resource, 'vehicle');

  // Nothing is written when the slot is taken.
  const db = stubDB({ guard: { ...FREE, clash_id: 'APT-0007', clash_reason: 'mechanic' } });
  await post(VALID, db);
  ok_('no INSERT on a conflict', !db.find('INSERT INTO appointments'), db.sql);
  ok_('and no id is burned', !db.find('id_counters'), db.sql);
}

console.log('\n-- 8. The overlap query itself --');
{
  const db = stubDB({ guard: FREE });
  await post({ ...VALID, time: '10:30', duration: 45 }, db);
  const q = db.find('WITH clash');
  ok_('one combined guard query, not three', !!q, db.sql);
  check('   ...and it is the only SELECT before the write',
    db.calls.filter((c) => /^\s*(SELECT|WITH)/i.test(c.sql.trim())).length, 1);

  ok_('scoped to the date', /date = \?1/.test(q.sql), q.sql);
  ok_('only blocking statuses occupy the schedule',
    q.sql.includes("'Scheduled', 'Confirmed', 'In Progress'"), q.sql);
  ok_('   ...so Completed never blocks', !/status IN \([^)]*Completed/.test(q.sql), q.sql);
  ok_('   ...nor Cancelled', !/status IN \([^)]*Cancelled/.test(q.sql), q.sql);
  ok_('   ...nor No Show', !/status IN \([^)]*No Show/.test(q.sql), q.sql);

  ok_('matches the same mechanic OR the same vehicle',
    /mechanic_id = \?5/.test(q.sql) && /vehicle_id = \?6/.test(q.sql) && /OR/.test(q.sql), q.sql);
  ok_('the half-open interval test is present',
    q.sql.includes('< ?4') && q.sql.includes('> ?3'), q.sql);
  ok_('reads minutes out of the stored HH:MM text', /substr\(time, 1, 2\)/.test(q.sql), q.sql);
  ok_('the duplicate check ignores only Cancelled',
    q.sql.includes("status <> 'Cancelled'"), q.sql);
  ok_('nothing is interpolated from the request',
    !q.sql.includes('CUS-') && !q.sql.includes('VEH-') && !q.sql.includes('10:30'), q.sql);

  // 10:30 for 45 minutes -> [630, 675).
  check('binds the computed start and end minutes', [q.binds[2], q.binds[3]], [630, 675]);
  check('binds a null excludeId on create', q.binds[1], null);
  check('binds the date', q.binds[0], FUTURE);

  for (const [time, duration, start, end] of [
    ['00:00', 60, 0, 60], ['09:05', 30, 545, 575], ['23:00', 60, 1380, 1440],
  ]) {
    const d = stubDB({ guard: FREE });
    await post({ ...VALID, time, duration }, d);
    check(`${time} +${duration} -> [${start}, ${end})`,
      [d.find('WITH clash').binds[2], d.find('WITH clash').binds[3]], [start, end]);
  }
}

console.log('\n-- 9. Duplicate booking --');
{
  const dup = await post(VALID, stubDB({ guard: { ...FREE, duplicate_id: 'APT-0009' } }));
  const b = await dup.json();
  ok_('an identical booking -> 409', dup.status === 409, `got ${dup.status}`);
  check('   ...reason', b.error.reason, 'duplicate_appointment');
  check('   ...names it', b.error.conflictsWith, 'APT-0009');

  // A conflict outranks a duplicate, the order scheduleProblems() uses.
  const both = await post(VALID, stubDB({
    guard: { ...FREE, clash_id: 'APT-0007', clash_reason: 'vehicle', duplicate_id: 'APT-0009' },
  }));
  check('an overlap is reported before a duplicate',
    (await both.json()).error.reason, 'schedule_conflict');
}

console.log('\n-- 10. Update merges, and the rules judge the merged record --');
{
  const db = stubDB({ guard: FREE, current: STORED });
  const res = await put('APT-0001', { notes: 'called back' }, db);
  ok_('PUT one field -> 200', res.status === 200, `got ${res.status} ${JSON.stringify(await res.clone().json())}`);

  const upd = db.calls.find((c) => /^\s*UPDATE appointments/i.test(c.sql.trim()));
  const setClause = upd.sql.slice(upd.sql.indexOf('SET'), upd.sql.indexOf('WHERE'));
  check('sets exactly the supplied column plus updated_at',
    (setClause.match(/=\s*\?\d+/g) || []).length, 2);
  ok_('   ...touches notes', setClause.includes('notes ='), setClause);
  ok_('   ...refreshes updated_at', setClause.includes('updated_at ='), setClause);
  ok_('   ...leaves date, time, duration and status alone',
    !/\b(date|time|duration|status)\s*=/.test(setClause), setClause);
  ok_('no id is allocated on an update', !db.find('id_counters'), db.sql);

  // The stored row is read so the guards can judge the result, not the patch.
  ok_('reads the stored row first', !!db.find('SELECT customer_id, vehicle_id'), db.sql);
  const guard = db.find('WITH clash');
  check('the overlap query uses the STORED date', guard.binds[0], FUTURE);
  check('   ...and the stored time as minutes', [guard.binds[2], guard.binds[3]], [600, 660]);
  check('   ...excluding the appointment being updated', guard.binds[1], 'APT-0001');
}
{
  // Changing only the duration must be judged against the stored start time.
  const db = stubDB({ guard: FREE, current: STORED });
  await put('APT-0001', { duration: 120 }, db);
  const g = db.find('WITH clash');
  check('a duration-only change re-checks the slot', [g.binds[2], g.binds[3]], [600, 720]);

  // Changing only the time must be judged against the stored duration.
  const db2 = stubDB({ guard: FREE, current: STORED });
  await put('APT-0001', { time: '14:00' }, db2);
  check('a time-only change re-checks the slot',
    [db2.find('WITH clash').binds[2], db2.find('WITH clash').binds[3]], [840, 900]);

  // Clearing the mechanic must override the stored one, not fall back to it.
  const db3 = stubDB({ guard: FREE, current: STORED });
  await put('APT-0001', { mechanicId: null }, db3);
  check('a cleared mechanic is null in the overlap query',
    db3.find('WITH clash').binds[4], null);
  const db4 = stubDB({ guard: FREE, current: STORED });
  await put('APT-0001', { notes: 'x' }, db4);
  check('an untouched mechanic keeps the stored one',
    db4.find('WITH clash').binds[4], 'MEC-0001');
}
{
  // Self-exclusion: an appointment must not conflict with itself.
  const db = stubDB({ guard: FREE, current: STORED });
  await put('APT-0001', { time: '10:00' }, db);
  check('the update excludes itself from the overlap query',
    db.find('WITH clash').binds[1], 'APT-0001');
  ok_('   ...and the duplicate check too',
    db.find('WITH clash').sql.includes('(?2 IS NULL OR id <> ?2)'));

  const clash = await put('APT-0001', { time: '11:00' },
    stubDB({ guard: { ...FREE, clash_id: 'APT-0022', clash_reason: 'mechanic' }, current: STORED }));
  ok_('an update into an occupied slot -> 409', clash.status === 409, `got ${clash.status}`);
}
{
  const empty = await put('APT-0001', {}, stubDB({ current: STORED }));
  ok_('an empty body -> 422', empty.status === 422, `got ${empty.status}`);
  const bad = await put('nope', { notes: 'x' }, stubDB({ current: STORED }));
  ok_('a malformed id -> 400', bad.status === 400, `got ${bad.status}`);
  const missing = await put('APT-7777', { notes: 'x' },
    stubDB({ guard: FREE, current: null, returning: null }));
  ok_('an unknown id -> 404', missing.status === 404, `got ${missing.status}`);

  // An update may move a date into the past; only creation is barred.
  const back = await put('APT-0001', { date: '2020-01-01' },
    stubDB({ guard: FREE, current: STORED }));
  ok_('an update may set a past date', back.status === 200, `got ${back.status}`);
}

console.log('\n-- 11. Status transitions --');
{
  const legal = [
    ['Scheduled', 'Confirmed'], ['Scheduled', 'Cancelled'], ['Scheduled', 'No Show'],
    ['Confirmed', 'In Progress'], ['Confirmed', 'Cancelled'], ['Confirmed', 'No Show'],
    ['In Progress', 'Completed'],
  ];
  for (const [from, to] of legal) {
    const r = await put('APT-0001', { status: to },
      stubDB({ guard: FREE, current: { ...STORED, status: from } }));
    ok_(`${from} -> ${to} allowed`, r.status === 200, `got ${r.status}`);
  }

  const illegal = [
    ['Scheduled', 'In Progress'], ['Scheduled', 'Completed'],
    ['Confirmed', 'Completed'], ['Confirmed', 'Scheduled'],
    ['In Progress', 'Cancelled'], ['In Progress', 'Confirmed'],
  ];
  for (const [from, to] of illegal) {
    const db = stubDB({ guard: FREE, current: { ...STORED, status: from } });
    const r = await put('APT-0001', { status: to }, db);
    const b = await r.json();
    ok_(`${from} -> ${to} refused`, r.status === 409, `got ${r.status}`);
    check('   ...reason', b.error.reason, 'illegal_status_transition');
    check('   ...reports where it is', b.error.from, from);
    check('   ...and what was asked', b.error.to, to);
    ok_('   ...and what would be legal', Array.isArray(b.error.allowed), b.error);
    ok_('   ...nothing was written', !db.calls.some((c) => /^\s*UPDATE appointments/i.test(c.sql.trim())), db.sql);
  }

  // A terminal appointment cannot move at all.
  for (const from of ['Completed', 'Cancelled', 'No Show']) {
    for (const to of ['Scheduled', 'Confirmed', 'In Progress', 'Completed', 'Cancelled', 'No Show']) {
      if (to === from) continue;
      const r = await put('APT-0001', { status: to },
        stubDB({ guard: FREE, current: { ...STORED, status: from } }));
      ok_(`terminal ${from} -> ${to} refused`, r.status === 409, `got ${r.status}`);
    }
    // ...but its other fields are still editable, and re-sending its own
    // status is not a transition at all.
    const same = await put('APT-0001', { status: from },
      stubDB({ guard: FREE, current: { ...STORED, status: from } }));
    ok_(`re-sending ${from} is not a transition`, same.status === 200, `got ${same.status}`);
    const notes = await put('APT-0001', { notes: 'history note' },
      stubDB({ guard: FREE, current: { ...STORED, status: from } }));
    ok_(`a ${from} appointment can still be annotated`, notes.status === 200, `got ${notes.status}`);
  }
}

console.log('\n-- 12. Delete --');
{
  const okDel = await del('APT-0001', stubDB({ target: { job_card_id: null, status: 'Scheduled' } }));
  ok_('a Scheduled appointment deletes -> 200', okDel.status === 200, `got ${okDel.status}`);
  check('   ...reports what went', await okDel.json(), { data: { id: 'APT-0001', deleted: true } });

  for (const status of ['Scheduled', 'Confirmed', 'Cancelled', 'No Show']) {
    const r = await del('APT-0001', stubDB({ target: { job_card_id: null, status } }));
    ok_(`${status} may be deleted`, r.status === 200, `got ${r.status}`);
  }

  // :610 — three blockers, none of them a foreign key.
  const linked = await del('APT-0001', stubDB({ target: { job_card_id: 'JOB-0004', status: 'Confirmed' } }));
  const lb = await linked.json();
  ok_('a linked appointment -> 409', linked.status === 409, `got ${linked.status}`);
  check('   ...reason', lb.error.reason, 'linked_to_job_card');
  check('   ...names the job card', lb.error.jobCardId, 'JOB-0004');

  const done = await del('APT-0001', stubDB({ target: { job_card_id: null, status: 'Completed' } }));
  check('a Completed appointment -> 409', (await done.clone().json()).error.reason, 'appointment_completed');
  ok_('   ...status 409', done.status === 409, `got ${done.status}`);

  const busy = await del('APT-0001', stubDB({ target: { job_card_id: null, status: 'In Progress' } }));
  check('an In Progress appointment -> 409', (await busy.clone().json()).error.reason, 'appointment_in_progress');
  ok_('   ...status 409', busy.status === 409, `got ${busy.status}`);

  // A blocked delete must not touch the table.
  const db = stubDB({ target: { job_card_id: 'JOB-0004', status: 'Confirmed' } });
  await del('APT-0001', db);
  ok_('a blocked delete issues no DELETE', !db.calls.some((c) => /^\s*DELETE/i.test(c.sql.trim())), db.sql);
  check('   ...one guard query only', db.calls.length, 1);

  const gone = await del('APT-7777', stubDB({ target: null, changes: 0 }));
  ok_('an unknown id -> 404', gone.status === 404, `got ${gone.status}`);
  const bad = await del('nope');
  ok_('a malformed id -> 400', bad.status === 400, `got ${bad.status}`);
}

console.log('\n-- 13. Failure modes --');
{
  for (const [message, status] of [
    ['D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT', 409],
    ['D1_ERROR: CHECK constraint failed: duration > 0: SQLITE_CONSTRAINT', 422],
    ['D1_ERROR: NOT NULL constraint failed: appointments.time: SQLITE_CONSTRAINT', 422],
  ]) {
    const res = await post(VALID, stubDB({ guard: FREE, throwOnInsert: message }));
    const b = await res.json();
    ok_(`${message.slice(10, 34)}... -> ${status}`, res.status === status, `got ${res.status}`);
    ok_('   ...no SQLite text leaks',
      !JSON.stringify(b).includes('SQLITE') && !JSON.stringify(b).includes('appointments.'), b);
  }
  const boom = await post(VALID, stubDB({ guard: FREE, throwOnInsert: 'D1_ERROR: no such column: zzz' }));
  ok_('a non-constraint failure -> 500', boom.status === 500, `got ${boom.status}`);

  for (const [method, body] of [['POST', VALID], ['PUT', { notes: 'x' }], ['DELETE', undefined]]) {
    const path = method === 'POST' ? '/api/appointments' : '/api/appointments/APT-0001';
    const r = await call(path, {}, method, body);
    ok_(`${method} without a D1 binding -> 503`, r.status === 503, `got ${r.status}`);
  }
}

console.log('\n-- 14. Routing --');
{
  const db = {
    prepare(sql) {
      return {
        async all() { return { results: sql.includes("type = 'table'") ? [{ name: 'customers' }] : [] }; },
        async first() { return { n: 1 }; },
      };
    },
  };
  const routes = (await (await call('/api/health', { DB: db }, 'GET')).json()).data.routes;
  check('the registry advertises 180 routes', routes.length, 180);
  for (const r of ['GET /api/appointments', 'POST /api/appointments', 'GET /api/appointments/:id',
    'PUT /api/appointments/:id', 'DELETE /api/appointments/:id']) {
    ok_(`advertises ${r}`, routes.includes(r), routes.filter((x) => x.includes('appointments')));
  }
  const byMethod = {};
  routes.forEach((r) => { const m = r.split(' ')[0]; byMethod[m] = (byMethod[m] || 0) + 1; });
  check('73 GET, 67 POST, 25 PUT, 15 DELETE (0024 maintenance, 0023 bookings, 0021 equipment delete and reactivate, 0005 added follow-ups, 0006 follow-up tasks, 0007 estimates, 0008 staff, 0009 accounts, 0010 attendance, 0011 leave requests, 0012 the activity log, 0013 tools, 0014 Messenger, 0015 WhatsApp, 0016 Website Forms, 0017 Notifications, 0018 Roles, 0019 individual login, 0020 offline sync)', byMethod, { GET: 73, POST: 67, PUT: 25, DELETE: 15 });

  const patchList = await call('/api/appointments', { DB: stubDB() }, 'PATCH', {});
  check('PATCH on the list -> 405', patchList.status, 405);
  check('   ...Allow is GET, POST', patchList.headers.get('allow'), 'GET, POST');
  const patchDetail = await call('/api/appointments/APT-0001', { DB: stubDB() }, 'PATCH', {});
  check('PATCH on the detail -> 405', patchDetail.status, 405);
  check('   ...Allow is GET, PUT, DELETE', patchDetail.headers.get('allow'), 'GET, PUT, DELETE');

  // Job cards remain read-only: C-3 ships no linking route. The router judges
  // method-allowance from the path shape before it validates the id, so this
  // is a 405 rather than a 404 -- the same pre-existing behaviour a POST to
  // any deep path already had. What matters is that nothing is created and
  // no linking route is advertised.
  const linkDb = stubDB();
  const link = await call('/api/appointments/APT-0001/job-card', { DB: linkDb }, 'POST', {});
  ok_('no /job-card route creates anything', link.status >= 400, `got ${link.status}`);
  ok_('   ...and it reaches no database', linkDb.calls.length === 0, `${linkDb.calls.length}`);
  ok_('   ...nor is such a route advertised',
    !routes.some((r) => r.includes('job-card') && r.includes('/api/appointments')),
    routes.filter((r) => r.includes('appointments')));
  // A GET to the same deep path is the id validator's 400, unchanged by C-3.
  const deep = await call('/api/appointments/APT-0001/job-card', { DB: stubDB() }, 'GET');
  ok_('a GET to the deep path is 400 or 404, never 500',
    deep.status === 400 || deep.status === 404, `got ${deep.status}`);
}

console.log(`\nAppointment writes unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
