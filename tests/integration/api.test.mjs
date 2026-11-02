/* Integration: the real Worker and the real local D1, over HTTP.
   Covers every collection the router exposes; each phase adds a section. */
// Same default as before; the override only exists so a future phase can
// point the same suite at a different local port.
const BASE = process.env.TAQWA_API_BASE || 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};
const sec = (s) => console.log('\n-- ' + s + ' --');
// C-9 put a bearer-token gate in front of every mutation, so the suite has to
// authenticate. run.sh starts the Worker with this same token and passes it
// here; it is openly a test value, and the suite goes through the real gate
// rather than around it. Reads need none, and sending one anyway is harmless.
const TOKEN = process.env.TAQWA_API_TOKEN || '';
const authHeaders = (extra = {}) =>
  (TOKEN ? { authorization: `Bearer ${TOKEN}`, ...extra } : { ...extra });

async function get(path, init) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: authHeaders(init?.headers),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, ct: res.headers.get('content-type'), allow: res.headers.get('allow'), body };
}

/** Same shape as get(), for the write verbs. */
async function send(method, path, body) {
  return get(path, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  });
}

/** The same request WITHOUT credentials, for the authentication section. */
async function sendAnon(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  return {
    status: res.status,
    allow: res.headers.get('allow'),
    wwwAuthenticate: res.headers.get('www-authenticate'),
    body: parsed,
  };
}

sec('1. Health');
{
  const r = await get('/api/health');
  t('health 200', r.status === 200, r.status);
  t('health ok', r.body?.ok === true);
  t('database reachable', r.body?.data?.database?.reachable === true);
  t('migrated', r.body?.data?.database?.migrated === true);
  const routes = r.body?.data?.routes ?? [];
  t('advertises 144 routes', routes.length === 144, routes);
  {
    const byMethod = {};
    routes.forEach((r2) => { const m = r2.split(' ')[0]; byMethod[m] = (byMethod[m] || 0) + 1; });
    t('59 GET, 53 POST, 21 PUT, 11 DELETE',
      JSON.stringify(byMethod) === JSON.stringify({ GET: 59, POST: 53, PUT: 21, DELETE: 11 }), byMethod);
  }
  t('advertises services list', routes.includes('GET /api/services'));
  t('advertises services detail', routes.includes('GET /api/services/:id'));
  t('advertises customers routes', routes.includes('GET /api/customers') && routes.includes('GET /api/customers/:id'));
  t('advertises vehicles routes', routes.includes('GET /api/vehicles') && routes.includes('GET /api/vehicles/:id'));
  t('advertises mechanics routes', routes.includes('GET /api/mechanics') && routes.includes('GET /api/mechanics/:id'));
  t('advertises parts routes', routes.includes('GET /api/parts') && routes.includes('GET /api/parts/:id'));
  t('advertises appointments routes', routes.includes('GET /api/appointments') && routes.includes('GET /api/appointments/:id'));
  t('advertises job-cards routes', routes.includes('GET /api/job-cards') && routes.includes('GET /api/job-cards/:id'));
  t('advertises job-cards writes',
    ['POST /api/job-cards', 'PUT /api/job-cards/:id', 'DELETE /api/job-cards/:id']
      .every((r2) => routes.includes(r2)), routes);
  t('advertises every action route, and only as POSTs',
    JSON.stringify(routes.filter((r2) => /\/:id\/[a-z-]+$/.test(r2)))
      === JSON.stringify(['POST /api/job-cards/:id/status', 'POST /api/invoices/:id/void',
        'POST /api/payments/:id/void', 'POST /api/payments/:id/link',
        'POST /api/invoice-adjustments/:id/void',
        'POST /api/follow-ups/:id/complete', 'POST /api/follow-ups/:id/cancel',
        'POST /api/follow-ups/:id/contact', 'POST /api/follow-up-contacts/:id/void',
        'POST /api/follow-up-tasks/:id/start', 'POST /api/follow-up-tasks/:id/complete',
        'POST /api/follow-up-tasks/:id/cancel',
        'POST /api/estimates/:id/send', 'POST /api/estimates/:id/approve', 'POST /api/estimates/:id/reject',
        'POST /api/estimates/:id/cancel', 'POST /api/estimates/:id/convert',
        'POST /api/accounts/:id/password',
        'POST /api/leave-requests/:id/approve', 'POST /api/leave-requests/:id/reject',
        'POST /api/tools/:id/retire',
        'GET /api/messenger/conversations/:id/messages', 'POST /api/messenger/conversations/:id/reply',
        'POST /api/messenger/conversations/:id/read', 'PUT /api/messenger/conversations/:id/status',
        'GET /api/whatsapp/conversations/:id/messages', 'POST /api/whatsapp/conversations/:id/reply',
        'POST /api/whatsapp/conversations/:id/read', 'POST /api/whatsapp/conversations/:id/unread',
        'PUT /api/whatsapp/conversations/:id/status',
        'POST /api/notifications/:id/read', 'POST /api/notifications/:id/unread']), routes);
  t('advertises invoices routes', routes.includes('GET /api/invoices') && routes.includes('GET /api/invoices/:id'));
  t('advertises payments routes', routes.includes('GET /api/payments') && routes.includes('GET /api/payments/:id'));
  t('advertises expenses routes', routes.includes('GET /api/expenses') && routes.includes('GET /api/expenses/:id'));
  t('advertises inventory-transactions routes', routes.includes('GET /api/inventory-transactions') && routes.includes('GET /api/inventory-transactions/:id'));
  // Settings is the one singleton among the collections: one entry, no /:id.
  t('advertises the settings route', routes.includes('GET /api/settings'));
  t('advertises no settings detail route', !routes.includes('GET /api/settings/:id'));
  // C-9 gave the singleton its one write: a read and a write, and still no
  // create, no delete and nothing addressable below the path.
  t('exactly two settings entries', routes.filter((r2) => r2.includes('/api/settings')).length === 2, routes);
  t('   ...a read and a write, in that order',
    JSON.stringify(routes.slice(-5, -3)) === JSON.stringify(['GET /api/settings', 'PUT /api/settings']),
    routes.slice(-5, -3));
  // C-12 put the three public session routes after them.
  t('the session trio is advertised last',
    JSON.stringify(routes.slice(-3))
      === JSON.stringify(['GET /api/session', 'POST /api/session', 'DELETE /api/session']),
    routes.slice(-3));
}

sec('2. GET /api/services — list');
let list;
{
  const r = await get('/api/services');
  list = r.body;
  t('200', r.status === 200, r.status);
  t('json content-type', (r.ct || '').includes('application/json'), r.ct);
  t('no stray ok flag on list (envelope is {data,...meta})', !('ok' in list));
  t('data is an array', Array.isArray(list?.data));
  t('count 6', list?.count === 6, list?.count);
  t('total 6', list?.total === 6, list?.total);
  t('default limit 500', list?.limit === 500, list?.limit);
  t('default offset 0', list?.offset === 0, list?.offset);
  const ids = list.data.map(s => s.id);
  t('newest first, id DESC tie-break',
    JSON.stringify(ids) === JSON.stringify(['SRV-9006','SRV-9004','SRV-9003','SRV-9002','SRV-9001','SRV-9005']), ids);
}

sec('3. Record shape and NULL semantics');
{
  const byId = Object.fromEntries(list.data.map(s => [s.id, s]));
  const full = byId['SRV-9001'];
  t('camelCase keys only', Object.keys(full).every(k => !k.includes('_')), Object.keys(full));
  t('name', full.name === 'B4 Full Service', full.name);
  t('category', full.category === 'Engine');
  t('description', full.description === 'Complete engine overhaul');
  t('estTime is a number', full.estTime === 180, full.estTime);
  t('price is a number', full.price === 7500, full.price);
  t('status', full.status === 'Active');
  t('createdAt', full.createdAt === '2026-09-10T09:00:00', full.createdAt);
  t('updatedAt present when set', full.updatedAt === '2026-09-12T11:30:00', full.updatedAt);

  const sparse = byId['SRV-9002'];
  t('NULL category -> ""', sparse.category === '', sparse.category);
  t('NULL description -> ""', sparse.description === '', sparse.description);
  t('NULL est_time stays null, not 0', sparse.estTime === null, sparse.estTime);
  t('estTime is not 0', sparse.estTime !== 0);
  t('updatedAt omitted when NULL', !('updatedAt' in sparse), Object.keys(sparse));
  t('price keeps decimals', sparse.price === 1200.5, sparse.price);

  const retired = byId['SRV-9005'];
  t('Inactive status preserved', retired.status === 'Inactive', retired.status);
  t('price 0 stays 0', retired.price === 0, retired.price);
  t('est_time NULL -> null on inactive row', retired.estTime === null);

  const keys = new Set(list.data.flatMap(s => Object.keys(s)));
  t('no unexpected fields', [...keys].every(k =>
    ['id','name','category','description','estTime','price','status','createdAt','updatedAt'].includes(k)), [...keys]);
}

sec('4. Pagination');
{
  const r1 = await get('/api/services?limit=2');
  t('limit=2 returns 2', r1.body?.data?.length === 2, r1.body?.data?.length);
  t('limit echoed', r1.body?.limit === 2);
  t('total still 6', r1.body?.total === 6, r1.body?.total);
  t('count is page size', r1.body?.count === 2);

  const r2 = await get('/api/services?limit=2&offset=2');
  t('offset=2 returns next page', JSON.stringify(r2.body.data.map(s => s.id)) === JSON.stringify(['SRV-9003','SRV-9002']),
    r2.body.data.map(s => s.id));
  t('offset echoed', r2.body?.offset === 2);
  t('pages do not overlap', !r2.body.data.some(s => r1.body.data.find(x => x.id === s.id)));

  const r3 = await get('/api/services?offset=100');
  t('offset past end -> empty array', Array.isArray(r3.body?.data) && r3.body.data.length === 0);
  t('offset past end still 200', r3.status === 200);
  t('total unaffected by offset', r3.body?.total === 6);

  const r4 = await get('/api/services?limit=1000');
  t('max limit accepted', r4.status === 200);
}

sec('5. Invalid list parameters -> 400');
for (const [q, why] of [['limit=0','limit below min'], ['limit=1001','limit above max'], ['limit=abc','limit not a number'],
                        ['limit=1.5','limit not an integer'], ['offset=-1','offset negative'], ['offset=xyz','offset not a number']]) {
  const r = await get('/api/services?' + q);
  t(`${why} -> 400`, r.status === 400, { q, status: r.status });
  t(`${why} -> invalid_parameter`, r.body?.error?.code === 'invalid_parameter', r.body?.error);
  t(`${why} -> no data key on failure`, !('data' in r.body));
}

sec('6. GET /api/services/:id — detail');
{
  const r = await get('/api/services/SRV-9001');
  t('200', r.status === 200, r.status);
  t('no stray ok flag on detail', !('ok' in r.body));
  t('data is an object, not an array', r.body?.data && !Array.isArray(r.body.data));
  t('id matches', r.body?.data?.id === 'SRV-9001');
  const fromList = list.data.find(s => s.id === 'SRV-9001');
  t('detail record identical to list record', JSON.stringify(r.body.data) === JSON.stringify(fromList));
  t('no list meta on detail', r.body.count === undefined && r.body.total === undefined && r.body.limit === undefined);

  const r2 = await get('/api/services/SRV-9002');
  t('sparse detail keeps estTime null', r2.body?.data?.estTime === null);
  t('sparse detail omits updatedAt', !('updatedAt' in r2.body.data));
}

sec('7. Detail error paths');
{
  const r404 = await get('/api/services/SRV-8888');
  t('unknown id -> 404', r404.status === 404, r404.status);
  t('404 code', r404.body?.error?.code === 'not_found', r404.body?.error);
  t('404 message names a service', r404.body?.error?.message === 'No service with that id.', r404.body?.error?.message);

  const rWrong = await get('/api/services/VEH-9001');
  t('well-formed id from another collection -> 404 not 400', rWrong.status === 404, rWrong.status);
  t('cross-collection 404 message', rWrong.body?.error?.message === 'No service with that id.');

  for (const [id, why] of [['nonsense','no prefix shape'], ['SRV-','no number'], ['-9001','no prefix'],
                           ['SRVICES-9001','prefix too long'], ['S-1','prefix too short'], ['SRV-99999999999','number too long']]) {
    const r = await get('/api/services/' + encodeURIComponent(id));
    t(`${why} -> 400`, r.status === 400, { id, status: r.status });
    t(`${why} -> invalid_id`, r.body?.error?.code === 'invalid_id', r.body?.error);
  }

  const rEmpty = await get('/api/services/');
  t('trailing slash -> 400 not 404', rEmpty.status === 400, rEmpty.status);
  t('trailing slash code', rEmpty.body?.error?.code === 'invalid_id');

  const rBadEscape = await fetch(BASE + '/api/services/%zz');
  t('malformed percent-escape -> 400', rBadEscape.status === 400, rBadEscape.status);

  const rInject = await get('/api/services/' + encodeURIComponent("SRV-9001' OR '1'='1"));
  t('SQL-ish id rejected by validator -> 400', rInject.status === 400, rInject.status);
  const after = await get('/api/services');
  t('table intact after injection attempt', after.body?.total === 6, after.body?.total);
}

sec('8. Method handling');
// C-2 added POST here and PUT/DELETE on the detail; the Allow header names
// them. Section 13 covers the writes themselves.
for (const m of ['PUT','DELETE','PATCH']) {
  const rl = await get('/api/services', { method: m });
  t(`${m} list -> 405`, rl.status === 405, rl.status);
  t(`${m} list Allow names POST`, rl.allow === 'GET, POST', rl.allow);
}
for (const m of ['POST','PATCH']) {
  const rd = await get('/api/services/SRV-9001', { method: m });
  t(`${m} detail -> 405`, rd.status === 405, rd.status);
  t(`${m} detail Allow names PUT and DELETE`, rd.allow === 'GET, PUT, DELETE', rd.allow);
}
{
  const r = await get('/api/services', { method: 'HEAD' });
  t('HEAD -> 405 (not implemented, write or read)', r.status === 405, r.status);
}

sec('9. Customers regression — unchanged by the shared factory');
{
  const r = await get('/api/customers');
  t('200', r.status === 200, r.status);
  t('count 2', r.body?.count === 2, r.body?.count);
  t('total 2', r.body?.total === 2);
  t('meta keys unchanged', JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['count','data','limit','offset','total']),
    Object.keys(r.body));
  const c = r.body.data.find(x => x.id === 'CUS-9001');
  t('full customer record shape', JSON.stringify(c) === JSON.stringify({
    id:'CUS-9001', name:'B4 Test Customer', phone:'01900000001', altPhone:'01900000002',
    email:'b4@example.test', address:'Dhaka', notes:'regression row', status:'Active',
    createdAt:'2026-09-10T09:00:00', updatedAt:'2026-09-12T10:00:00' }), c);
  const sparse = r.body.data.find(x => x.id === 'CUS-9002');
  t('sparse customer nulls -> ""', sparse.altPhone === '' && sparse.email === '' && sparse.address === '' && sparse.notes === '');
  t('sparse customer omits updatedAt', !('updatedAt' in sparse));
  t('phone_digits never leaks', !('phoneDigits' in c) && !('phone_digits' in c), Object.keys(c));
  t('ordering newest first', JSON.stringify(r.body.data.map(x => x.id)) === JSON.stringify(['CUS-9002','CUS-9001']));

  const d = await get('/api/customers/CUS-9001');
  t('detail 200', d.status === 200);
  t('detail matches list record', JSON.stringify(d.body.data) === JSON.stringify(c));
  const d404 = await get('/api/customers/CUS-8888');
  t('customers 404 message unchanged', d404.status === 404 && d404.body?.error?.message === 'No customer with that id.', d404.body?.error);
  const d400 = await get('/api/customers/bad');
  t('customers 400 unchanged', d400.status === 400 && d400.body?.error?.code === 'invalid_id');
  const dCross = await get('/api/customers/SRV-9001');
  t('services id on customers route -> 404', dCross.status === 404 && dCross.body?.error?.message === 'No customer with that id.');
  const p = await get('/api/customers?limit=1&offset=1');
  t('customers pagination unchanged', p.body?.count === 1 && p.body?.total === 2 && p.body.data[0].id === 'CUS-9001', p.body);
  const m405 = await get('/api/customers', { method: 'PATCH' });
  t('customers still refuses PATCH, and Allow names POST',
    m405.status === 405 && m405.allow === 'GET, POST', { status: m405.status, allow: m405.allow });
}

sec('10. Vehicles regression — unchanged by the shared factory');
{
  const r = await get('/api/vehicles');
  t('200', r.status === 200, r.status);
  t('count 2', r.body?.count === 2, r.body?.count);
  const v = r.body.data.find(x => x.id === 'VEH-9001');
  t('full vehicle record shape', JSON.stringify(v) === JSON.stringify({
    id:'VEH-9001', customerId:'CUS-9001', regNo:'B4-TEST-01', brand:'Toyota', model:'Corolla',
    year:2019, color:'White', vin:'VIN9001', engineNo:'ENG9001', chassisNo:'CHS9001', mileage:52000,
    fuelType:'Petrol', transmission:'Automatic', nextServiceDate:'2026-12-01', notes:'regression row',
    status:'Active', createdAt:'2026-09-10T09:00:00', updatedAt:'2026-09-12T10:00:00' }), v);
  const sparse = r.body.data.find(x => x.id === 'VEH-9002');
  t('vehicle year null, not 0', sparse.year === null, sparse.year);
  t('vehicle mileage null, not 0', sparse.mileage === null, sparse.mileage);
  t('vehicle text nulls -> ""', sparse.color === '' && sparse.vin === '' && sparse.fuelType === '' && sparse.nextServiceDate === '');
  t('vehicle omits updatedAt', !('updatedAt' in sparse));
  const d = await get('/api/vehicles/VEH-9001');
  t('detail 200', d.status === 200);
  t('detail matches list record', JSON.stringify(d.body.data) === JSON.stringify(v));
  const d404 = await get('/api/vehicles/VEH-8888');
  t('vehicles 404 message unchanged', d404.status === 404 && d404.body?.error?.message === 'No vehicle with that id.', d404.body?.error);
  const dCross = await get('/api/vehicles/SRV-9001');
  t('services id on vehicles route -> 404', dCross.status === 404 && dCross.body?.error?.message === 'No vehicle with that id.');
  // DELETE is a real route as of C-2; PATCH is the method this path still
  // refuses. VEH-9001 is a fixture with job cards, so a real DELETE here
  // would be a 409 — which section 13 covers deliberately.
  const m405 = await get('/api/vehicles/VEH-9001', { method: 'PATCH' });
  t('vehicles still refuses PATCH, and Allow names the writes',
    m405.status === 405 && m405.allow === 'GET, PUT, DELETE', { status: m405.status, allow: m405.allow });
}

sec('10b. GET /api/mechanics — the new collection, over real HTTP');
{
  const r = await get('/api/mechanics');
  t('200', r.status === 200, r.status);
  t('count 3', r.body?.count === 3, r.body?.count);
  t('total 3', r.body?.total === 3, r.body?.total);
  t('meta keys match the other collections',
    JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['count','data','limit','offset','total']),
    Object.keys(r.body));
  t('newest first, id DESC tie-break',
    JSON.stringify(r.body.data.map(m => m.id)) === JSON.stringify(['MEC-9002','MEC-9001','MEC-9003']),
    r.body.data.map(m => m.id));

  const byId = Object.fromEntries(r.body.data.map(m => [m.id, m]));
  const full = byId['MEC-9001'];
  t('full mechanic record shape', JSON.stringify(full) === JSON.stringify({
    id:'MEC-9001', name:'B5 Full Mechanic', phone:'01911000001', altPhone:'01911000002',
    email:'b5@example.test', address:'Uttara, Dhaka', specialization:'Engine & Transmission',
    experience:12, joiningDate:'2021-03-15', employmentType:'Full Time', salaryType:'Monthly',
    salary:32000, commissionRate:5.5, availability:'Available', notes:'regression row',
    status:'Active', createdAt:'2026-09-10T09:00:00', updatedAt:'2026-09-12T10:00:00' }), full);
  t('camelCase keys only', Object.keys(full).every(k => !k.includes('_')), Object.keys(full));
  t('commissionRate keeps its decimal', full.commissionRate === 5.5, full.commissionRate);

  const sparse = byId['MEC-9002'];
  t('NULL text -> ""',
    sparse.altPhone === '' && sparse.email === '' && sparse.address === ''
      && sparse.specialization === '' && sparse.joiningDate === '' && sparse.notes === '');
  t('NULL experience stays null, not 0', sparse.experience === null, sparse.experience);
  t('NULL salary stays null, not 0', sparse.salary === null, sparse.salary);
  t('NULL commissionRate stays null, not 0', sparse.commissionRate === null, sparse.commissionRate);
  t('NULL employmentType -> "", API invents no default', sparse.employmentType === '', sparse.employmentType);
  t('NULL salaryType -> "", API invents no default', sparse.salaryType === '', sparse.salaryType);
  t('NULL availability -> "", API invents no default', sparse.availability === '', sparse.availability);
  t('sparse mechanic omits updatedAt', !('updatedAt' in sparse), Object.keys(sparse));

  const zeroed = byId['MEC-9003'];
  t('stored 0 experience stays 0', zeroed.experience === 0, zeroed.experience);
  t('stored 0 salary stays 0', zeroed.salary === 0, zeroed.salary);
  t('stored 0 commissionRate stays 0', zeroed.commissionRate === 0, zeroed.commissionRate);
  t('0 is distinguishable from null over the wire',
    zeroed.salary === 0 && sparse.salary === null, { zero: zeroed.salary, nul: sparse.salary });
  t('Inactive status preserved', zeroed.status === 'Inactive', zeroed.status);

  const p1 = await get('/api/mechanics?limit=2');
  t('limit=2 returns 2', p1.body?.data?.length === 2, p1.body?.data?.length);
  t('total still 3', p1.body?.total === 3, p1.body?.total);
  const p2 = await get('/api/mechanics?limit=2&offset=2');
  t('offset=2 returns the last one', JSON.stringify(p2.body.data.map(m => m.id)) === JSON.stringify(['MEC-9003']),
    p2.body.data.map(m => m.id));
  t('pages do not overlap', !p2.body.data.some(m => p1.body.data.find(x => x.id === m.id)));
  const p3 = await get('/api/mechanics?offset=99');
  t('offset past end -> empty array, still 200', p3.status === 200 && p3.body.data.length === 0);

  for (const [q, why] of [['limit=0','limit below min'], ['limit=1001','limit above max'],
                          ['limit=abc','limit not a number'], ['offset=-1','offset negative']]) {
    const bad = await get('/api/mechanics?' + q);
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_parameter', { q, status: bad.status });
  }

  const d = await get('/api/mechanics/MEC-9001');
  t('detail 200', d.status === 200, d.status);
  t('detail matches the list record', JSON.stringify(d.body.data) === JSON.stringify(full));
  t('no list meta on detail', d.body.count === undefined && d.body.limit === undefined);
  const dSparse = await get('/api/mechanics/MEC-9002');
  t('sparse detail keeps salary null', dSparse.body?.data?.salary === null, dSparse.body?.data?.salary);

  const d404 = await get('/api/mechanics/MEC-8888');
  t('unknown id -> 404', d404.status === 404, d404.status);
  t('404 message names a mechanic', d404.body?.error?.message === 'No mechanic with that id.', d404.body?.error?.message);
  const dCross = await get('/api/mechanics/SRV-9001');
  t('another collection\'s id -> 404, not 400', dCross.status === 404, dCross.status);
  t('cross-collection 404 message', dCross.body?.error?.message === 'No mechanic with that id.');
  const mOnCust = await get('/api/customers/MEC-9001');
  t('mechanics id on the customers route -> 404', mOnCust.status === 404 && mOnCust.body?.error?.message === 'No customer with that id.');

  for (const [id, why] of [['nonsense','no prefix shape'], ['MEC-','no number'], ['-9001','no prefix'],
                           ['MECHANICS-9001','prefix too long'], ['M-1','prefix too short']]) {
    const bad = await get('/api/mechanics/' + encodeURIComponent(id));
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_id', { id, status: bad.status });
  }
  const dEmpty = await get('/api/mechanics/');
  t('trailing slash -> 400', dEmpty.status === 400 && dEmpty.body?.error?.code === 'invalid_id');
  const dEsc = await fetch(BASE + '/api/mechanics/%zz');
  t('malformed percent-escape -> 400', dEsc.status === 400, dEsc.status);

  const inject = await get('/api/mechanics/' + encodeURIComponent("MEC-9001' OR '1'='1"));
  t('SQL-ish id rejected -> 400', inject.status === 400, inject.status);
  const after = await get('/api/mechanics');
  t('mechanics table intact after injection attempt', after.body?.total === 3, after.body?.total);

  // C-2 gave this collection writes, so only the methods it still refuses are
  // asserted here, and the Allow header now names the new ones. Section 13
  // covers the writes themselves.
  for (const m of ['PUT','DELETE','PATCH']) {
    const rl = await get('/api/mechanics', { method: m });
    t(`${m} list -> 405 + Allow`, rl.status === 405 && rl.allow === 'GET, POST', { status: rl.status, allow: rl.allow });
  }
  for (const m of ['POST','PATCH']) {
    const rd = await get('/api/mechanics/MEC-9001', { method: m });
    t(`${m} detail -> 405 + Allow`, rd.status === 405 && rd.allow === 'GET, PUT, DELETE', { status: rd.status, allow: rd.allow });
  }
}

sec('10c. GET /api/parts — stock comes from the column, not the ledger');
{
  const r = await get('/api/parts');
  t('200', r.status === 200, r.status);
  t('count 3', r.body?.count === 3, r.body?.count);
  t('total 3', r.body?.total === 3, r.body?.total);
  t('meta keys match the other collections',
    JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['count','data','limit','offset','total']),
    Object.keys(r.body));
  t('newest first, id DESC tie-break',
    JSON.stringify(r.body.data.map(p => p.id)) === JSON.stringify(['PRT-9002','PRT-9001','PRT-9003']),
    r.body.data.map(p => p.id));

  const byId = Object.fromEntries(r.body.data.map(p => [p.id, p]));
  const full = byId['PRT-9001'];
  t('full part record shape', JSON.stringify(full) === JSON.stringify({
    id:'PRT-9001', name:'B6 Full Part', partNo:'B6-OF-001', category:'Filters',
    brand:'Toyota', supplier:'Dhaka Auto Parts', location:'Rack A2', unit:'pc',
    purchasePrice:350, sellingPrice:500, stock:18, minStock:8, reorderQty:10,
    notes:'regression row', status:'Active', createdAt:'2026-09-10T09:00:00',
    updatedAt:'2026-09-12T10:00:00' }), full);
  t('camelCase keys only', Object.keys(full).every(k => !k.includes('_')), Object.keys(full));

  const sparse = byId['PRT-9002'];
  t('NULL text -> ""',
    sparse.partNo === '' && sparse.category === '' && sparse.brand === ''
      && sparse.supplier === '' && sparse.location === '' && sparse.unit === ''
      && sparse.notes === '');
  t('NULL reorderQty stays null — the UI supplies its own default',
    sparse.reorderQty === null, sparse.reorderQty);
  t('NOT NULL numbers always arrive as numbers',
    typeof sparse.purchasePrice === 'number' && typeof sparse.sellingPrice === 'number'
      && typeof sparse.stock === 'number' && typeof sparse.minStock === 'number');
  t('sparse part omits updatedAt', !('updatedAt' in sparse), Object.keys(sparse));

  const zero = byId['PRT-9003'];
  t('stock 0 stays 0 — out of stock is a real state', zero.stock === 0, zero.stock);
  t('reorderQty stored as 0 stays 0', zero.reorderQty === 0, zero.reorderQty);
  t('a stored 0 and a NULL are distinguishable over the wire',
    zero.reorderQty === 0 && sparse.reorderQty === null,
    { stored: zero.reorderQty, absent: sparse.reorderQty });
  t('Inactive status preserved', zero.status === 'Inactive', zero.status);

  // The API reports the stored balance. Nothing here is summed, joined or
  // reconciled against inventory_transactions.
  const keys = new Set(r.body.data.flatMap(p => Object.keys(p)));
  t('no derived low-stock flag', ![...keys].some(k => /low|alert|needsReorder/i.test(k)), [...keys]);
  t('no derived stock value', ![...keys].some(k => /value|worth/i.test(k)), [...keys]);
  t('no embedded transaction history',
    ![...keys].some(k => /transaction|history|movement|ledger/i.test(k)), [...keys]);
  t('no openingStock — it is not a stored column', !keys.has('openingStock'), [...keys]);

  const p1 = await get('/api/parts?limit=2');
  t('limit=2 returns 2', p1.body?.data?.length === 2, p1.body?.data?.length);
  t('total still 3', p1.body?.total === 3, p1.body?.total);
  const p2 = await get('/api/parts?limit=2&offset=2');
  t('offset=2 returns the last one', JSON.stringify(p2.body.data.map(p => p.id)) === JSON.stringify(['PRT-9003']),
    p2.body.data.map(p => p.id));
  t('pages do not overlap', !p2.body.data.some(p => p1.body.data.find(x => x.id === p.id)));
  const p3 = await get('/api/parts?offset=99');
  t('offset past end -> empty array, still 200', p3.status === 200 && p3.body.data.length === 0);
  const p4 = await get('/api/parts?limit=1000');
  t('limit at the maximum accepted', p4.status === 200, p4.status);

  for (const [q, why] of [['limit=0','limit below min'], ['limit=1001','limit above max'],
                          ['limit=abc','limit not a number'], ['offset=-1','offset negative']]) {
    const bad = await get('/api/parts?' + q);
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_parameter', { q, status: bad.status });
  }

  const d = await get('/api/parts/PRT-9001');
  t('detail 200', d.status === 200, d.status);
  t('detail matches the list record', JSON.stringify(d.body.data) === JSON.stringify(full));
  t('no list meta on detail', d.body.count === undefined && d.body.limit === undefined);
  const dZero = await get('/api/parts/PRT-9003');
  t('out-of-stock detail reports 0', dZero.body?.data?.stock === 0, dZero.body?.data?.stock);
  const dSparse = await get('/api/parts/PRT-9002');
  t('sparse detail keeps reorderQty null', dSparse.body?.data?.reorderQty === null, dSparse.body?.data?.reorderQty);

  const d404 = await get('/api/parts/PRT-8888');
  t('unknown id -> 404', d404.status === 404, d404.status);
  t('404 message names a part', d404.body?.error?.message === 'No part with that id.', d404.body?.error?.message);
  for (const other of ['MEC-9001', 'SRV-9001', 'CUS-9001', 'VEH-9001']) {
    const x = await get('/api/parts/' + other);
    t(`${other} on the parts route -> 404, not 400`, x.status === 404, x.status);
  }
  const pOnMech = await get('/api/mechanics/PRT-9001');
  t('parts id on the mechanics route -> 404',
    pOnMech.status === 404 && pOnMech.body?.error?.message === 'No mechanic with that id.');

  for (const [id, why] of [['nonsense','no prefix shape'], ['PRT-','no number'], ['-9001','no prefix'],
                           ['PARTSXX-9001','prefix too long'], ['P-1','prefix too short']]) {
    const bad = await get('/api/parts/' + encodeURIComponent(id));
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_id', { id, status: bad.status });
  }
  const dEmpty = await get('/api/parts/');
  t('trailing slash -> 400', dEmpty.status === 400 && dEmpty.body?.error?.code === 'invalid_id');
  const dEsc = await fetch(BASE + '/api/parts/%zz');
  t('malformed percent-escape -> 400', dEsc.status === 400, dEsc.status);

  // An injection that would zero the stock if it ever reached the database.
  const inject = await get('/api/parts/' + encodeURIComponent("PRT-9001'; UPDATE parts SET stock=0 --"));
  t('stock-mutating injection rejected -> 400', inject.status === 400, inject.status);
  const after = await get('/api/parts/PRT-9001');
  t('stock is untouched after the injection attempt', after.body?.data?.stock === 18, after.body?.data?.stock);
  const allAfter = await get('/api/parts');
  t('parts table intact after injection attempt', allAfter.body?.total === 3, allAfter.body?.total);

  // C-2 gave this collection writes, so only the methods it still refuses are
  // asserted here, and the Allow header now names the new ones. Section 13
  // covers the writes themselves.
  for (const m of ['PUT','DELETE','PATCH']) {
    const rl = await get('/api/parts', { method: m });
    t(`${m} list -> 405 + Allow`, rl.status === 405 && rl.allow === 'GET, POST', { status: rl.status, allow: rl.allow });
  }
  for (const m of ['POST','PATCH']) {
    const rd = await get('/api/parts/PRT-9001', { method: m });
    t(`${m} detail -> 405 + Allow`, rd.status === 405 && rd.allow === 'GET, PUT, DELETE', { status: rd.status, allow: rd.allow });
  }

  // B-13 shipped the ledger, so this is derived from what health advertises
  // rather than hardcoded: whatever is advertised must answer, whatever is not
  // must 404. Section 10i covers the ledger's own behaviour in full.
  const advertised = (await get('/api/health')).body?.data?.routes ?? [];
  for (const path of ['/api/inventory-transactions', '/api/inventory', '/api/stock']) {
    const x = await get(path);
    const isRouted = advertised.includes(`GET ${path}`);
    t(`${path} ${isRouted ? 'is a route -> 200' : 'is not a route -> 404'}`,
      isRouted ? x.status === 200 : x.status === 404, x.status);
  }
  t('the ledger is now advertised', advertised.includes('GET /api/inventory-transactions'));
  t('/api/inventory is still not a route', !advertised.includes('GET /api/inventory'));

  // Parts still reads stock from its own column, never from the ledger.
  const pOne = await get('/api/parts/PRT-9001');
  t('parts detail still answers independently of the ledger',
    pOne.status === 200 && pOne.body?.data?.stock === 18, pOne.body?.data?.stock);
}

sec('10d. GET /api/appointments — references stay as ids, values as stored');
{
  const SOURCES = ['Admin','Phone','Walk-in','Facebook','Website'];
  const r = await get('/api/appointments');
  t('200', r.status === 200, r.status);
  t('count 6', r.body?.count === 6, r.body?.count);
  t('total 6', r.body?.total === 6, r.body?.total);
  t('meta keys match the other collections',
    JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['count','data','limit','offset','total']),
    Object.keys(r.body));
  t('newest first by created_at, not by appointment date',
    JSON.stringify(r.body.data.map(a => a.id)) ===
      JSON.stringify(['APT-9006','APT-9005','APT-9004','APT-9003','APT-9002','APT-9001']),
    r.body.data.map(a => a.id));

  const byId = Object.fromEntries(r.body.data.map(a => [a.id, a]));

  const full = byId['APT-9002'];
  t('full appointment record shape', JSON.stringify(full) === JSON.stringify({
    id:'APT-9002', customerId:'CUS-9001', vehicleId:'VEH-9001', serviceId:'SRV-9002',
    mechanicId:'MEC-9001', jobCardId:null, date:'2026-09-21', time:'09:30', duration:60,
    status:'Confirmed', source:'Phone', complaint:'Battery draining overnight',
    notes:'Call before arrival', reminderSent:true, createdAt:'2026-09-11T09:00:00',
    updatedAt:'2026-09-12T10:00:00' }), full);
  t('camelCase keys only', Object.keys(full).every(k => !k.includes('_')), Object.keys(full));

  const sparse = byId['APT-9001'];
  t('NULL mechanic_id -> null, not ""', sparse.mechanicId === null, sparse.mechanicId);
  t('NULL job_card_id -> null, not ""', sparse.jobCardId === null, sparse.jobCardId);
  t('NULL complaint -> ""', sparse.complaint === '', sparse.complaint);
  t('NULL notes -> ""', sparse.notes === '', sparse.notes);
  t('sparse appointment omits updatedAt', !('updatedAt' in sparse), Object.keys(sparse));
  t('NOT NULL references always present',
    Boolean(sparse.customerId && sparse.vehicleId && sparse.serviceId),
    { c: sparse.customerId, v: sparse.vehicleId, s: sparse.serviceId });

  // reminder_sent is INTEGER 0/1 in D1 and a boolean in the app.
  t('reminder_sent 1 -> true', full.reminderSent === true, full.reminderSent);
  t('reminder_sent 0 -> false', sparse.reminderSent === false, sparse.reminderSent);
  t('reminderSent is a boolean over the wire, never 0/1',
    r.body.data.every(a => typeof a.reminderSent === 'boolean'),
    r.body.data.map(a => a.reminderSent));

  // Job card link, observed in both states against a real foreign key.
  const linked = byId['APT-9004'];
  t('a linked appointment reports its job card id', linked.jobCardId === 'JOB-9001', linked.jobCardId);
  t('the link is an id, not an embedded job card object', typeof linked.jobCardId === 'string');
  t('unlinked appointments report null, not the linked id',
    r.body.data.filter(a => a.jobCardId === null).length === 5,
    r.body.data.map(a => a.jobCardId));

  // Nothing is joined: no customer/vehicle/service/mechanic/job-card fields.
  const keys = new Set(r.body.data.flatMap(a => Object.keys(a)));
  t('no joined customer data', !['customerName','customer','customerPhone'].some(k => keys.has(k)), [...keys]);
  t('no joined vehicle data', !['vehicleName','vehicle','regNo','brand'].some(k => keys.has(k)), [...keys]);
  t('no joined service data', !['serviceName','service','price'].some(k => keys.has(k)), [...keys]);
  t('no joined mechanic data', !['mechanicName','mechanic','salary'].some(k => keys.has(k)), [...keys]);
  t('no joined job card data', !['jobCard','jobCardStatus','total'].some(k => keys.has(k)), [...keys]);
  t('exactly the five reference ids',
    ['customerId','vehicleId','serviceId','mechanicId','jobCardId'].every(k => keys.has(k)), [...keys]);

  // All five canonical sources, returned exactly as stored.
  const sources = r.body.data.map(a => a.source);
  t('Admin present', sources.includes('Admin'));
  t('Phone present', sources.includes('Phone'));
  t('Walk-in present', sources.includes('Walk-in'));
  t('Facebook present — not rewritten to Website', sources.includes('Facebook'), sources);
  t('Website present — not inferred from anything else', sources.includes('Website'), sources);
  t('every source is canonical', sources.every(s => SOURCES.includes(s)), sources);
  t('no source gained a suffix', sources.every(s => s === s.trim() && !s.includes('-api')), sources);
  t('Facebook and Website are distinct rows',
    byId['APT-9004'].source === 'Facebook' && byId['APT-9005'].source === 'Website');

  // Statuses, returned exactly as stored.
  const statuses = r.body.data.map(a => a.status);
  for (const s of ['Scheduled','Confirmed','In Progress','Completed','Cancelled','No Show']) {
    t(`status "${s}" round-trips`, statuses.includes(s), statuses);
  }
  t('"In Progress" keeps its space', byId['APT-9003'].status === 'In Progress', byId['APT-9003'].status);
  t('"No Show" keeps its space', byId['APT-9006'].status === 'No Show', byId['APT-9006'].status);

  // Date and time: stored text, returned unchanged. Midnight and 23:59 are
  // where a UTC round trip would move the day for Dhaka (UTC+6).
  t('midnight stays midnight on its own date',
    sparse.date === '2026-09-20' && sparse.time === '00:00', { d: sparse.date, t: sparse.time });
  t('23:59 stays on its own date',
    linked.date === '2026-09-23' && linked.time === '23:59', { d: linked.date, t: linked.time });
  t('an early-morning slot is not shifted',
    byId['APT-9006'].date === '2026-09-25' && byId['APT-9006'].time === '05:30');
  t('every date is a plain yyyy-mm-dd string',
    r.body.data.every(a => /^\d{4}-\d{2}-\d{2}$/.test(a.date)), r.body.data.map(a => a.date));
  t('every time is a plain HH:MM string',
    r.body.data.every(a => /^\d{2}:\d{2}$/.test(a.time)), r.body.data.map(a => a.time));
  t('no date became an ISO timestamp',
    !r.body.data.some(a => a.date.includes('T') || a.date.endsWith('Z')), r.body.data.map(a => a.date));
  t('duration is always a number', r.body.data.every(a => typeof a.duration === 'number'),
    r.body.data.map(a => a.duration));
  t('the 600-minute maximum survives', byId['APT-9006'].duration === 600, byId['APT-9006'].duration);

  // Pagination.
  const p1 = await get('/api/appointments?limit=2');
  t('limit=2 returns 2', p1.body?.data?.length === 2, p1.body?.data?.length);
  t('total still 6', p1.body?.total === 6, p1.body?.total);
  const p2 = await get('/api/appointments?limit=2&offset=2');
  t('offset=2 returns the next page',
    JSON.stringify(p2.body.data.map(a => a.id)) === JSON.stringify(['APT-9004','APT-9003']),
    p2.body.data.map(a => a.id));
  t('pages do not overlap', !p2.body.data.some(a => p1.body.data.find(x => x.id === a.id)));
  const p3 = await get('/api/appointments?offset=99');
  t('offset past end -> empty array, still 200', p3.status === 200 && p3.body.data.length === 0);
  const p4 = await get('/api/appointments?limit=1000');
  t('limit at the maximum accepted', p4.status === 200, p4.status);
  for (const [q, why] of [['limit=0','limit below min'], ['limit=1001','limit above max'],
                          ['limit=abc','limit not a number'], ['offset=-1','offset negative']]) {
    const bad = await get('/api/appointments?' + q);
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_parameter', { q, status: bad.status });
  }

  // Detail.
  const d = await get('/api/appointments/APT-9002');
  t('detail 200', d.status === 200, d.status);
  t('detail matches the list record', JSON.stringify(d.body.data) === JSON.stringify(full));
  t('no list meta on detail', d.body.count === undefined && d.body.limit === undefined);
  const dLinked = await get('/api/appointments/APT-9004');
  t('linked detail reports the job card id', dLinked.body?.data?.jobCardId === 'JOB-9001', dLinked.body?.data?.jobCardId);
  const dSparse = await get('/api/appointments/APT-9001');
  t('sparse detail keeps mechanicId null', dSparse.body?.data?.mechanicId === null, dSparse.body?.data?.mechanicId);

  const d404 = await get('/api/appointments/APT-8888');
  t('unknown id -> 404', d404.status === 404, d404.status);
  t('404 message names an appointment',
    d404.body?.error?.message === 'No appointment with that id.', d404.body?.error?.message);
  // Every id this appointment actually references is well-formed but elsewhere.
  for (const other of ['CUS-9001','VEH-9001','SRV-9001','MEC-9001','JOB-9001','PRT-9001']) {
    const x = await get('/api/appointments/' + other);
    t(`${other} on the appointments route -> 404, not 400`, x.status === 404, x.status);
  }
  const aOnPart = await get('/api/parts/APT-9001');
  t('appointment id on the parts route -> 404',
    aOnPart.status === 404 && aOnPart.body?.error?.message === 'No part with that id.');

  for (const [id, why] of [['nonsense','no prefix shape'], ['APT-','no number'], ['-9001','no prefix'],
                           ['APPOINTMENT-9001','prefix too long'], ['A-1','prefix too short']]) {
    const bad = await get('/api/appointments/' + encodeURIComponent(id));
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_id', { id, status: bad.status });
  }
  const dEmpty = await get('/api/appointments/');
  t('trailing slash -> 400', dEmpty.status === 400 && dEmpty.body?.error?.code === 'invalid_id');
  const dEsc = await fetch(BASE + '/api/appointments/%zz');
  t('malformed percent-escape -> 400', dEsc.status === 400, dEsc.status);

  // An injection that would rewrite a source, and one that would cancel
  // everything, with the data re-read afterwards to prove neither landed.
  const injSource = await get('/api/appointments/' + encodeURIComponent("APT-9004'; UPDATE appointments SET source='Website' --"));
  t('source-rewriting injection rejected -> 400', injSource.status === 400, injSource.status);
  const injStatus = await get('/api/appointments/' + encodeURIComponent("APT-9001'; UPDATE appointments SET status='Cancelled' --"));
  t('status-rewriting injection rejected -> 400', injStatus.status === 400, injStatus.status);
  const after = await get('/api/appointments');
  t('Facebook source survived the injection attempt',
    after.body.data.find(a => a.id === 'APT-9004')?.source === 'Facebook');
  t('statuses survived the injection attempt',
    after.body.data.filter(a => a.status === 'Cancelled').length === 1,
    after.body.data.map(a => a.status));
  t('appointments table intact after injection attempts', after.body?.total === 6, after.body?.total);

  // C-3 gave appointments writes; only the methods it still refuses are
  // asserted here. Section 14 covers the writes themselves.
  for (const m of ['PUT','DELETE','PATCH']) {
    const rl = await get('/api/appointments', { method: m });
    t(`${m} list -> 405 + Allow`, rl.status === 405 && rl.allow === 'GET, POST', { status: rl.status, allow: rl.allow });
  }
  for (const m of ['POST','PATCH']) {
    const rd = await get('/api/appointments/APT-9002', { method: m });
    t(`${m} detail -> 405 + Allow`, rd.status === 405 && rd.allow === 'GET, PUT, DELETE', { status: rd.status, allow: rd.allow });
  }

  // The appointment's job card link is an id; the job card itself is a
  // separate collection and is not embedded here.
  t('the job card link stays an id, with no job card object embedded',
    !Object.keys(linked).some(k => /^jobCard($|[A-Z])/.test(k) && k !== 'jobCardId'),
    Object.keys(linked));
}

sec('10e. GET /api/job-cards — parent plus child lines, snapshots preserved');
{
  const r = await get('/api/job-cards');
  t('200', r.status === 200, r.status);
  t('count 5', r.body?.count === 5, r.body?.count);
  t('total 5', r.body?.total === 5, r.body?.total);
  t('meta keys match the other collections',
    JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['count','data','limit','offset','total']),
    Object.keys(r.body));
  t('newest first by created_at',
    JSON.stringify(r.body.data.map(j => j.id)) === JSON.stringify(['JOB-9001','JOB-9002','JOB-9003','JOB-9004','JOB-9005']),
    r.body.data.map(j => j.id));

  const byId = Object.fromEntries(r.body.data.map(j => [j.id, j]));
  const full = byId['JOB-9001'];

  // ---- parent mapping ----
  t('camelCase keys only', Object.keys(full).every(k => !k.includes('_')), Object.keys(full));
  t('references are ids',
    full.customerId === 'CUS-9002' && full.vehicleId === 'VEH-9002'
      && full.mechanicId === 'MEC-9001' && full.appointmentId === 'APT-9004'
      && full.invoiceId === 'INV-9001',
    { c: full.customerId, v: full.vehicleId, m: full.mechanicId, a: full.appointmentId, i: full.invoiceId });
  t('date is stored text, not shifted', full.date === '2026-09-23', full.date);
  t('estDelivery / actualDelivery preserved',
    full.estDelivery === '2026-09-24' && full.actualDelivery === '2026-09-24');
  t('completedAt preserved', full.completedAt === '2026-09-24T16:00:00', full.completedAt);
  t('status and priority preserved', full.status === 'Delivered' && full.priority === 'high');
  t('mileage and mileageOut', full.mileage === 48200 && full.mileageOut === 48260);
  t('fuelLevel', full.fuelLevel === 'half', full.fuelLevel);
  t('prose fields mapped',
    full.technicianNotes === 'Oil, filter and pads replaced'
      && full.conditionNotes === 'Minor scratch on rear bumper'
      && full.recommendations === 'Air filter at next service');
  t('labourHours / labourRate / labourCost',
    full.labourHours === 1.5 && full.labourRate === 400 && full.labourCost === 600);
  t('updatedAt present when set', full.updatedAt === '2026-09-14T11:00:00', full.updatedAt);

  const sparse = byId['JOB-9002'];
  t('NULL references -> null', sparse.appointmentId === null && sparse.invoiceId === null);
  t('NULL mileage -> null, not 0', sparse.mileage === null, sparse.mileage);
  t('NULL labourHours/labourRate -> null', sparse.labourHours === null && sparse.labourRate === null);
  t('NULL prose -> ""',
    sparse.inspection === '' && sparse.diagnosis === '' && sparse.notes === ''
      && sparse.estDelivery === '' && sparse.completedAt === '' && sparse.fuelLevel === '');
  t('NOT NULL money 0 stays 0',
    sparse.subtotal === 0 && sparse.total === 0 && sparse.paid === 0 && sparse.due === 0);
  t('sparse job card omits updatedAt', !('updatedAt' in sparse), Object.keys(sparse));

  const manualJob = byId['JOB-9003'];
  t('mileage 0 stays 0 — a real reading, unlike JOB-9002 NULL',
    manualJob.mileage === 0 && sparse.mileage === null,
    { zero: manualJob.mileage, absent: sparse.mileage });
  t('0 and null are distinguishable over the wire', manualJob.mileage !== sparse.mileage);

  // ---- child lines ----
  t('full job card has 2 service lines', full.services.length === 2, full.services.length);
  t('full job card has 1 part line', full.partsUsed.length === 1, full.partsUsed.length);
  t('service line shape',
    JSON.stringify(Object.keys(full.services[0]).sort()) ===
      JSON.stringify(['name','qty','serviceId','total','unitPrice']), Object.keys(full.services[0]));
  t('part line shape',
    JSON.stringify(Object.keys(full.partsUsed[0]).sort()) ===
      JSON.stringify(['name','partId','partNo','qty','total','unitPrice']), Object.keys(full.partsUsed[0]));
  t('child rows expose no surrogate id, line_no or jobCardId',
    !['id','lineNo','line_no','jobCardId','job_card_id'].some(k => k in full.services[0]),
    Object.keys(full.services[0]));
  t('service lines in line_no order',
    JSON.stringify(full.services.map(s => s.name)) ===
      JSON.stringify(['Legacy Full Service (2024 price)','Brake Pad Replacement']),
    full.services.map(s => s.name));

  t('a job card with no lines gets services []',
    Array.isArray(sparse.services) && sparse.services.length === 0, sparse.services);
  t('a job card with no lines gets partsUsed []',
    Array.isArray(sparse.partsUsed) && sparse.partsUsed.length === 0, sparse.partsUsed);
  t('lines are attached to the right parents',
    full.services.length === 2 && manualJob.services.length === 0
      && byId['JOB-9004'].services.length === 2,
    { j1: full.services.length, j3: manualJob.services.length, j4: byId['JOB-9004'].services.length });

  // JOB-9004's two service lines share line_no = 1; the id tie-break must keep
  // their order stable across repeated requests.
  const dup = byId['JOB-9004'];
  t('duplicate line_no still yields 2 lines', dup.services.length === 2, dup.services.length);
  const again = await get('/api/job-cards/JOB-9004');
  t('duplicate line_no ordering is stable across requests',
    JSON.stringify(again.body.data.services.map(s => s.name)) === JSON.stringify(dup.services.map(s => s.name)),
    { first: dup.services.map(s => s.name), second: again.body.data.services.map(s => s.name) });

  // ---- historical snapshots ----
  const cat = await get('/api/services/SRV-9001');
  t('the catalogue currently says something different',
    cat.body.data.name === 'B4 Full Service' && cat.body.data.price === 7500,
    { name: cat.body.data.name, price: cat.body.data.price });
  t('the job card still reports the snapshot name',
    full.services[0].name === 'Legacy Full Service (2024 price)', full.services[0].name);
  t('the job card still reports the snapshot price',
    full.services[0].unitPrice === 4000, full.services[0].unitPrice);
  t('serviceId still points at the catalogue row', full.services[0].serviceId === 'SRV-9001');

  const catPart = await get('/api/parts/PRT-9001');
  t('the parts catalogue currently says something different',
    catPart.body.data.name === 'B6 Full Part' && catPart.body.data.partNo === 'B6-OF-001',
    { name: catPart.body.data.name, partNo: catPart.body.data.partNo });
  t('the job card still reports the snapshot part name',
    full.partsUsed[0].name === 'Legacy Oil Filter (2024 label)', full.partsUsed[0].name);
  t('the job card still reports the snapshot part number',
    full.partsUsed[0].partNo === 'LEGACY-OF-001', full.partsUsed[0].partNo);
  t('the job card still reports the snapshot part price',
    full.partsUsed[0].unitPrice === 600, full.partsUsed[0].unitPrice);

  // ---- manual part ----
  t('manual line has partId null', manualJob.partsUsed[0].partId === null, manualJob.partsUsed[0].partId);
  t('manual line keeps its name',
    manualJob.partsUsed[0].name === 'Custom heat shield bracket (hand cut)', manualJob.partsUsed[0].name);
  t('manual line keeps its part number', manualJob.partsUsed[0].partNo === 'MANUAL-01');
  t('manual line keeps its price and total',
    manualJob.partsUsed[0].unitPrice === 150 && manualJob.partsUsed[0].total === 300);
  t('manual line is not promoted into an inventory part',
    manualJob.partsUsed[0].partId !== '' && manualJob.partsUsed[0].partId === null);

  // ---- financial values as stored ----
  t('subtotal/tax/total as stored',
    full.subtotal === 8000 && full.tax === 395 && full.total === 8295,
    { s: full.subtotal, t: full.tax, tot: full.total });
  t('discount and taxRate as stored', full.discount === 100 && full.taxRate === 5);
  t('paid and due as stored', full.paid === 8295 && full.due === 0);
  // The line totals sum to 8000 here, but nothing was recomputed: JOB-9004
  // stores a subtotal of 2400 while its lines sum to 2400 and its total is
  // 2400 with paid 0 — all read back exactly.
  t('a cancelled job card keeps its stored figures',
    dup.subtotal === 2400 && dup.total === 2400 && dup.paid === 0 && dup.due === 0,
    { s: dup.subtotal, t: dup.total, p: dup.paid, d: dup.due });
  t('no live balance field invented',
    !Object.keys(full).some(k => /^live|balance/i.test(k)), Object.keys(full));
  t('paid/due are the job card snapshot, not the invoice-derived live balance',
    full.paid === 8295 && full.due === 0);

  // ---- inspectionChecklist ----
  t('valid JSON checklist is a parsed object',
    typeof full.inspectionChecklist === 'object' && full.inspectionChecklist.brakes === 'worn',
    full.inspectionChecklist);
  t('checklist keys survive',
    JSON.stringify(Object.keys(full.inspectionChecklist).sort()) === JSON.stringify(['battery','brakes','tyres']),
    Object.keys(full.inspectionChecklist));
  t('NULL checklist -> {}',
    JSON.stringify(sparse.inspectionChecklist) === '{}', sparse.inspectionChecklist);
  t('stored empty object stays {}',
    JSON.stringify(manualJob.inspectionChecklist) === '{}', manualJob.inspectionChecklist);
  t('malformed JSON checklist -> {}, not a 500',
    JSON.stringify(dup.inspectionChecklist) === '{}', dup.inspectionChecklist);
  t('the malformed row did not fail the whole list', r.status === 200 && r.body.count === 5);
  const dupDetail = await get('/api/job-cards/JOB-9004');
  t('malformed JSON checklist -> 200 on detail too', dupDetail.status === 200, dupDetail.status);
  t('and {} there as well', JSON.stringify(dupDetail.body.data.inspectionChecklist) === '{}');

  // ---- relationships are not embedded ----
  const keys = new Set(r.body.data.flatMap(j => Object.keys(j)));
  t('no customer/vehicle/mechanic object embedded',
    !['customer','customerName','vehicle','vehicleRegNo','mechanic','mechanicName'].some(k => keys.has(k)),
    [...keys]);
  t('no appointment or invoice object embedded',
    !['appointment','invoice','invoiceStatus','invoiceTotal'].some(k => keys.has(k)), [...keys]);
  t('no inventory field embedded',
    !['stock','issuedQty','currentStock'].some(k => keys.has(k)), [...keys]);

  // ---- pagination ----
  const p1 = await get('/api/job-cards?limit=2');
  t('limit=2 returns 2', p1.body?.data?.length === 2, p1.body?.data?.length);
  t('total still 5', p1.body?.total === 5, p1.body?.total);
  t('a paged result still carries its child lines',
    p1.body.data.find(j => j.id === 'JOB-9001').services.length === 2);
  const p2 = await get('/api/job-cards?limit=2&offset=2');
  t('offset=2 returns the next page',
    JSON.stringify(p2.body.data.map(j => j.id)) === JSON.stringify(['JOB-9003','JOB-9004']),
    p2.body.data.map(j => j.id));
  t('pages do not overlap', !p2.body.data.some(j => p1.body.data.find(x => x.id === j.id)));
  const p3 = await get('/api/job-cards?offset=99');
  t('offset past end -> empty array, still 200', p3.status === 200 && p3.body.data.length === 0);
  // The SQLite variable ceiling: a full-size page must work against a real D1.
  const p4 = await get('/api/job-cards?limit=1000');
  t('limit=1000 succeeds against real D1 — no variable-limit failure',
    p4.status === 200, { status: p4.status, err: p4.body?.error });
  t('and returns every job card', p4.body?.count === 5, p4.body?.count);
  for (const [q, why] of [['limit=0','limit below min'], ['limit=1001','limit above max'],
                          ['limit=abc','limit not a number'], ['offset=-1','offset negative']]) {
    const bad = await get('/api/job-cards?' + q);
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_parameter', { q, status: bad.status });
  }

  // ---- detail ----
  const d = await get('/api/job-cards/JOB-9001');
  t('detail 200', d.status === 200, d.status);
  t('detail matches the list record', JSON.stringify(d.body.data) === JSON.stringify(full));
  t('no list meta on detail', d.body.count === undefined && d.body.limit === undefined);
  const dEmpty = await get('/api/job-cards/JOB-9002');
  t('a line-less job card still returns both empty arrays',
    dEmpty.body.data.services.length === 0 && dEmpty.body.data.partsUsed.length === 0);

  const d404 = await get('/api/job-cards/JOB-8888');
  t('unknown id -> 404', d404.status === 404, d404.status);
  t('404 message names a job card',
    d404.body?.error?.message === 'No job card with that id.', d404.body?.error?.message);
  for (const other of ['CUS-9001','VEH-9001','APT-9001','SRV-9001','MEC-9001','PRT-9001','INV-9001']) {
    const x = await get('/api/job-cards/' + other);
    t(`${other} on the job-cards route -> 404, not 400`, x.status === 404, x.status);
  }
  const jOnAppt = await get('/api/appointments/JOB-9001');
  t('job card id on the appointments route -> 404',
    jOnAppt.status === 404 && jOnAppt.body?.error?.message === 'No appointment with that id.');

  for (const [id, why] of [['nonsense','no prefix shape'], ['JOB-','no number'], ['-9001','no prefix'],
                           ['JOBCARDS-9001','prefix too long'], ['J-1','prefix too short']]) {
    const bad = await get('/api/job-cards/' + encodeURIComponent(id));
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_id', { id, status: bad.status });
  }
  const dSlash = await get('/api/job-cards/');
  t('trailing slash -> 400', dSlash.status === 400 && dSlash.body?.error?.code === 'invalid_id');
  const dEsc = await fetch(BASE + '/api/job-cards/%zz');
  t('malformed percent-escape -> 400', dEsc.status === 400, dEsc.status);

  // Injections that would zero the money or delete the lines if they landed.
  const injMoney = await get('/api/job-cards/' + encodeURIComponent("JOB-9001'; UPDATE job_cards SET paid=0, due=0 --"));
  t('money-rewriting injection rejected -> 400', injMoney.status === 400, injMoney.status);
  const injLines = await get('/api/job-cards/' + encodeURIComponent("JOB-9001'; DELETE FROM job_card_parts --"));
  t('line-deleting injection rejected -> 400', injLines.status === 400, injLines.status);
  const after = await get('/api/job-cards/JOB-9001');
  t('money survived the injection attempts',
    after.body?.data?.paid === 8295 && after.body?.data?.due === 0,
    { paid: after.body?.data?.paid, due: after.body?.data?.due });
  t('child lines survived the injection attempts',
    after.body?.data?.partsUsed?.length === 1 && after.body?.data?.services?.length === 2);
  const allAfter = await get('/api/job-cards');
  t('job_cards table intact after injection attempts', allAfter.body?.total === 5, allAfter.body?.total);

  // C-5 gave this collection writes, so only the methods it still refuses are
  // asserted here, and the Allow header now names the new ones. Section 16
  // covers the writes themselves.
  for (const m of ['PUT','DELETE','PATCH']) {
    const rl = await get('/api/job-cards', { method: m });
    t(`${m} list -> 405 + Allow`, rl.status === 405 && rl.allow === 'GET, POST', { status: rl.status, allow: rl.allow });
  }
  for (const m of ['POST','PATCH']) {
    const rd = await get('/api/job-cards/JOB-9001', { method: m });
    t(`${m} detail -> 405 + Allow`, rd.status === 405 && rd.allow === 'GET, PUT, DELETE', { status: rd.status, allow: rd.allow });
  }

  // Names are derived from what health advertises so a phase that ships one
  // does not have to come back and edit this. As of B-13 every real collection
  // in that list HAS shipped, so `widgets` is appended as a permanent
  // sentinel -- it is not a collection and never will be, which keeps the
  // probe meaningful now that the read surface is complete. Section 12 uses
  // the same sentinel for the same reason.
  const live = (await get('/api/health')).body?.data?.routes ?? [];
  const notYet = ['invoices', 'payments', 'inventory-transactions', 'expenses', 'widgets']
    .filter(name => !live.includes(`GET /api/${name}`));
  t('at least one unshipped collection was found to probe', notYet.length > 0, live);
  for (const name of notYet) {
    const x = await get(`/api/${name}`);
    t(`/api/${name} is not a route yet -> 404`, x.status === 404, x.status);
  }
}

sec('10f. GET /api/invoices — stored money, billed snapshots, no payment lookup');
{
  const r = await get('/api/invoices');
  t('200', r.status === 200, r.status);
  t('count 4', r.body?.count === 4, r.body?.count);
  t('total 4', r.body?.total === 4, r.body?.total);
  t('meta keys match the other collections',
    JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['count','data','limit','offset','total']),
    Object.keys(r.body));
  t('newest first by created_at',
    JSON.stringify(r.body.data.map(i => i.id)) === JSON.stringify(['INV-9001','INV-9002','INV-9003','INV-9004']),
    r.body.data.map(i => i.id));

  const byId = Object.fromEntries(r.body.data.map(i => [i.id, i]));
  const full = byId['INV-9001'];

  // ---- parent mapping ----
  t('full invoice record shape', JSON.stringify({ ...full, services: undefined, partsUsed: undefined }) ===
    JSON.stringify({ id:'INV-9001', jobCardId:'JOB-9001', customerId:'CUS-9002', vehicleId:'VEH-9002',
      date:'2026-09-24', labourCost:600, discount:100, taxRate:5, subtotal:8000, tax:395,
      total:8295, paid:8295, writtenOff:0, due:0, status:'Paid', notes:'Settled on collection',
      services: undefined, partsUsed: undefined,
      createdAt:'2026-09-24T12:00:00', updatedAt:'2026-09-25T09:00:00' }),
    { ...full, services: undefined, partsUsed: undefined });
  t('camelCase keys only', Object.keys(full).every(k => !k.includes('_')), Object.keys(full));
  t('date is stored text, not shifted', full.date === '2026-09-24', full.date);
  t('the field is partsUsed, not parts', 'partsUsed' in full && !('parts' in full), Object.keys(full));

  const voided = byId['INV-9002'];
  t('NULL job_card_id -> null', voided.jobCardId === null, voided.jobCardId);
  t('NULL notes -> ""', voided.notes === '', voided.notes);
  t('voided invoice omits updatedAt', !('updatedAt' in voided), Object.keys(voided));
  t('stored empty-string notes stay ""', byId['INV-9004'].notes === '', byId['INV-9004'].notes);
  t('money 0 stays 0, never null',
    voided.labourCost === 0 && voided.tax === 0 && voided.taxRate === 0);

  // ---- child lines ----
  t('INV-9001 has 2 service lines', full.services.length === 2, full.services.length);
  t('INV-9001 has 1 part line', full.partsUsed.length === 1, full.partsUsed.length);
  t('service line shape',
    JSON.stringify(Object.keys(full.services[0]).sort()) ===
      JSON.stringify(['name','qty','serviceId','total','unitPrice']), Object.keys(full.services[0]));
  t('part line shape',
    JSON.stringify(Object.keys(full.partsUsed[0]).sort()) ===
      JSON.stringify(['name','partId','partNo','qty','total','unitPrice']), Object.keys(full.partsUsed[0]));
  t('child rows expose no surrogate id, line_no or invoiceId',
    !['id','lineNo','line_no','invoiceId','invoice_id'].some(k => k in full.services[0]),
    Object.keys(full.services[0]));
  t('service lines in line_no order',
    JSON.stringify(full.services.map(s => s.name)) ===
      JSON.stringify(['Billed Full Service (2024 rate)','Brake Pad Replacement']),
    full.services.map(s => s.name));

  const noLines = byId['INV-9004'];
  t('an invoice with no lines gets services []',
    Array.isArray(noLines.services) && noLines.services.length === 0, noLines.services);
  t('an invoice with no lines gets partsUsed []',
    Array.isArray(noLines.partsUsed) && noLines.partsUsed.length === 0, noLines.partsUsed);
  t('lines are attached to the right parents',
    full.services.length === 2 && voided.services.length === 2 && noLines.services.length === 0,
    { i1: full.services.length, i2: voided.services.length, i4: noLines.services.length });

  // INV-9002's two service lines share line_no = 1; the id tie-break must keep
  // their order stable across repeated requests.
  const again = await get('/api/invoices/INV-9002');
  t('duplicate line_no ordering is stable across requests',
    JSON.stringify(again.body.data.services.map(s => s.name)) === JSON.stringify(voided.services.map(s => s.name)),
    { first: voided.services.map(s => s.name), second: again.body.data.services.map(s => s.name) });

  // ---- historical snapshots ----
  const cat = await get('/api/services/SRV-9001');
  t('the services catalogue currently says something different',
    cat.body.data.name === 'B4 Full Service' && cat.body.data.price === 7500,
    { name: cat.body.data.name, price: cat.body.data.price });
  t('the invoice still reports the billed name',
    full.services[0].name === 'Billed Full Service (2024 rate)', full.services[0].name);
  t('the invoice still reports the billed price',
    full.services[0].unitPrice === 4000, full.services[0].unitPrice);
  t('serviceId still points at the catalogue row', full.services[0].serviceId === 'SRV-9001');

  const catPart = await get('/api/parts/PRT-9001');
  t('the parts catalogue currently says something different',
    catPart.body.data.name === 'B6 Full Part' && catPart.body.data.partNo === 'B6-OF-001',
    { name: catPart.body.data.name, partNo: catPart.body.data.partNo });
  t('the invoice still reports the billed part name',
    full.partsUsed[0].name === 'Billed Oil Filter (2024 label)', full.partsUsed[0].name);
  t('the invoice still reports the billed part number',
    full.partsUsed[0].partNo === 'BILLED-OF-001', full.partsUsed[0].partNo);
  t('the invoice still reports the billed part price',
    full.partsUsed[0].unitPrice === 600, full.partsUsed[0].unitPrice);

  // ---- manual part ----
  const manual = byId['INV-9003'];
  t('manual line has partId null', manual.partsUsed[0].partId === null, manual.partsUsed[0].partId);
  t('manual line keeps its name',
    manual.partsUsed[0].name === 'Custom bracket (hand cut)', manual.partsUsed[0].name);
  t('manual line keeps its part number', manual.partsUsed[0].partNo === 'MANUAL-01');
  t('manual line keeps its price and total',
    manual.partsUsed[0].unitPrice === 150 && manual.partsUsed[0].total === 300);
  t('manual line is not promoted into a catalogue part', manual.partsUsed[0].partId === null);

  // ---- financial values as stored, with payments deliberately disagreeing ----
  t('subtotal/tax/total as stored',
    full.subtotal === 8000 && full.tax === 395 && full.total === 8295,
    { s: full.subtotal, t: full.tax, tot: full.total });
  t('labourCost/discount/taxRate as stored',
    full.labourCost === 600 && full.discount === 100 && full.taxRate === 5);
  t('paid and due as stored', full.paid === 8295 && full.due === 0);
  t('status as stored', full.status === 'Paid');
  t('INV-9003 keeps its partial figures',
    manual.paid === 150 && manual.due === 150 && manual.status === 'Partial',
    { p: manual.paid, d: manual.due, s: manual.status });
  t('INV-9004 keeps its unpaid figures',
    noLines.paid === 0 && noLines.due === 1500 && noLines.status === 'Unpaid');
  t('no live balance field invented',
    !Object.keys(full).some(k => /^live|balance/i.test(k)), Object.keys(full));
  t('no payments array embedded', !('payments' in full), Object.keys(full));

  // ---- void invoice ----
  t('a Void invoice reports status Void', voided.status === 'Void', voided.status);
  // PAY-9002 is the released advance: it no longer points at INV-9002, so a
  // payment-derived reading would show 0 collected. The stored figures are
  // frozen at 3000/1935 and that is what the API reports.
  t('a Void invoice keeps its frozen paid', voided.paid === 3000, voided.paid);
  t('a Void invoice keeps its frozen due', voided.due === 1935, voided.due);
  t('due was not forced to 0 because the invoice is Void', voided.due !== 0);
  t('a Void invoice keeps its total', voided.total === 4935, voided.total);
  t('a Void invoice still returns its lines', voided.services.length === 2, voided.services.length);

  // The payments exist and disagree with the stored figures in both directions.
  // INV-9001 has an Active 8295 plus a Void 500; INV-9002 has none linked at
  // all. The API reports the stored column either way.
  t('an Active payment does not change the reported paid', full.paid === 8295);
  t('a Void payment does not change the reported paid', full.paid === 8295 && full.total === 8295);
  t('an invoice with no linked payments still reports its stored paid',
    voided.paid === 3000, voided.paid);

  // ---- relationships ----
  const keys = new Set(r.body.data.flatMap(i => Object.keys(i)));
  t('no customer/vehicle/job card object embedded',
    !['customer','customerName','vehicle','vehicleRegNo','jobCard','jobCardStatus'].some(k => keys.has(k)),
    [...keys]);
  t('services and partsUsed are the only nested arrays',
    JSON.stringify(Object.keys(full).filter(k => Array.isArray(full[k])).sort()) ===
      JSON.stringify(['partsUsed','services']), Object.keys(full));

  // ---- pagination ----
  const p1 = await get('/api/invoices?limit=2');
  t('limit=2 returns 2', p1.body?.data?.length === 2, p1.body?.data?.length);
  t('total still 4', p1.body?.total === 4, p1.body?.total);
  t('a paged result still carries its child lines',
    p1.body.data.find(i => i.id === 'INV-9001').services.length === 2);
  const p2 = await get('/api/invoices?limit=2&offset=2');
  t('offset=2 returns the next page',
    JSON.stringify(p2.body.data.map(i => i.id)) === JSON.stringify(['INV-9003','INV-9004']),
    p2.body.data.map(i => i.id));
  t('pages do not overlap', !p2.body.data.some(i => p1.body.data.find(x => x.id === i.id)));
  const p3 = await get('/api/invoices?offset=99');
  t('offset past end -> empty array, still 200', p3.status === 200 && p3.body.data.length === 0);
  const p4 = await get('/api/invoices?limit=1000');
  t('limit=1000 succeeds against real D1 — no variable-limit failure',
    p4.status === 200, { status: p4.status, err: p4.body?.error });
  t('and returns every invoice', p4.body?.count === 4, p4.body?.count);
  const p5 = await get('/api/invoices?limit=500');
  t('limit=500 succeeds', p5.status === 200, p5.status);
  for (const [q, why] of [['limit=0','limit below min'], ['limit=1001','limit above max'],
                          ['limit=abc','limit not a number'], ['offset=-1','offset negative']]) {
    const bad = await get('/api/invoices?' + q);
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_parameter', { q, status: bad.status });
  }

  // ---- detail and ids ----
  const d = await get('/api/invoices/INV-9001');
  t('detail 200', d.status === 200, d.status);
  t('detail matches the list record', JSON.stringify(d.body.data) === JSON.stringify(full));
  t('no list meta on detail', d.body.count === undefined && d.body.limit === undefined);
  const dEmpty = await get('/api/invoices/INV-9004');
  t('a line-less invoice returns both empty arrays',
    dEmpty.body.data.services.length === 0 && dEmpty.body.data.partsUsed.length === 0);

  const d404 = await get('/api/invoices/INV-8888');
  t('unknown id -> 404', d404.status === 404, d404.status);
  t('404 message names an invoice',
    d404.body?.error?.message === 'No invoice with that id.', d404.body?.error?.message);
  for (const other of ['JOB-9001','CUS-9001','PRT-9001','VEH-9001','APT-9001','SRV-9001','MEC-9001','PAY-9001']) {
    const x = await get('/api/invoices/' + other);
    t(`${other} on the invoices route -> 404, not 400`, x.status === 404, x.status);
  }
  const iOnJob = await get('/api/job-cards/INV-9001');
  t('invoice id on the job-cards route -> 404',
    iOnJob.status === 404 && iOnJob.body?.error?.message === 'No job card with that id.');

  for (const [id, why] of [['nonsense','no prefix shape'], ['INV-','no number'], ['-9001','no prefix'],
                           ['INVOICES-9001','prefix too long'], ['I-1','prefix too short']]) {
    const bad = await get('/api/invoices/' + encodeURIComponent(id));
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_id', { id, status: bad.status });
  }
  const dSlash = await get('/api/invoices/');
  t('trailing slash -> 400', dSlash.status === 400 && dSlash.body?.error?.code === 'invalid_id');
  const dEsc = await fetch(BASE + '/api/invoices/%zz');
  t('malformed percent-escape -> 400', dEsc.status === 400, dEsc.status);

  const injMoney = await get('/api/invoices/' + encodeURIComponent("INV-9001'; UPDATE invoices SET paid=0, due=0 --"));
  t('money-rewriting injection rejected -> 400', injMoney.status === 400, injMoney.status);
  const injVoid = await get('/api/invoices/' + encodeURIComponent("INV-9001'; UPDATE invoices SET status='Void' --"));
  t('status-rewriting injection rejected -> 400', injVoid.status === 400, injVoid.status);
  const injLines = await get('/api/invoices/' + encodeURIComponent("INV-9001'; DELETE FROM invoice_parts --"));
  t('line-deleting injection rejected -> 400', injLines.status === 400, injLines.status);
  const after = await get('/api/invoices/INV-9001');
  t('money survived the injection attempts',
    after.body?.data?.paid === 8295 && after.body?.data?.due === 0 && after.body?.data?.status === 'Paid',
    { paid: after.body?.data?.paid, status: after.body?.data?.status });
  t('child lines survived the injection attempts',
    after.body?.data?.partsUsed?.length === 1 && after.body?.data?.services?.length === 2);
  const allAfter = await get('/api/invoices');
  t('invoices table intact after injection attempts', allAfter.body?.total === 4, allAfter.body?.total);

  // C-7 gave this collection writes, so only the methods it still refuses are
  // asserted here, and the Allow header now names the new ones. Section 18
  // covers the writes themselves.
  for (const m of ['PUT','DELETE','PATCH']) {
    const rl = await get('/api/invoices', { method: m });
    t(`${m} list -> 405 + Allow`, rl.status === 405 && rl.allow === 'GET, POST', { status: rl.status, allow: rl.allow });
  }
  for (const m of ['POST','PATCH']) {
    const rd = await get('/api/invoices/INV-9001', { method: m });
    t(`${m} detail -> 405 + Allow`, rd.status === 405 && rd.allow === 'GET, PUT, DELETE', { status: rd.status, allow: rd.allow });
  }
}

sec('10g. GET /api/payments — stored cash facts, and a GET that changes nothing');
{
  // ---- the critical read-only check: snapshot the invoice BEFORE any
  // payments request, then again after, and require them identical. This is
  // the one collection whose write paths rewrite another table.
  const invBefore = (await get('/api/invoices/INV-9001')).body.data;
  const beforeSnapshot = { paid: invBefore.paid, due: invBefore.due, status: invBefore.status };

  const r = await get('/api/payments');
  t('200', r.status === 200, r.status);
  t('count 5', r.body?.count === 5, r.body?.count);
  t('total 5', r.body?.total === 5, r.body?.total);
  t('meta keys match the other collections',
    JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['count','data','limit','offset','total']),
    Object.keys(r.body));
  t('newest first by created_at',
    JSON.stringify(r.body.data.map(p => p.id)) ===
      JSON.stringify(['PAY-9003','PAY-9001','PAY-9002','PAY-9004','PAY-9005']),
    r.body.data.map(p => p.id));

  const byId = Object.fromEntries(r.body.data.map(p => [p.id, p]));

  // ---- exact field mapping ----
  const linked = byId['PAY-9001'];
  t('linked payment record shape', JSON.stringify(linked) === JSON.stringify({
    id:'PAY-9001', invoiceId:'INV-9001', customerId:'CUS-9002', jobCardId:null,
    date:'2026-09-25', amount:8295, method:'Cash', status:'Active',
    notes:'Full settlement', createdAt:'2026-09-25T09:00:00' }), linked);
  t('camelCase keys only', Object.keys(linked).every(k => !k.includes('_')), Object.keys(linked));
  t('date is stored text, not shifted', linked.date === '2026-09-25', linked.date);
  t('updatedAt omitted when never updated', !('updatedAt' in linked), Object.keys(linked));

  const updated = byId['PAY-9005'];
  t('updatedAt present when set', updated.updatedAt === '2026-09-26T11:00:00', updated.updatedAt);
  t('a decimal amount survives the round trip', updated.amount === 150.25, updated.amount);
  t('amount is a number over the wire', typeof updated.amount === 'number', typeof updated.amount);

  // ---- the four reference combinations ----
  t('1. invoiceId set + jobCardId set — none in this fixture set, checked via PAY-9002 inverse',
    byId['PAY-9002'].jobCardId === 'JOB-9001');
  t('2. invoiceId set + jobCardId null',
    linked.invoiceId === 'INV-9001' && linked.jobCardId === null,
    { i: linked.invoiceId, j: linked.jobCardId });
  t('3. invoiceId null + jobCardId set',
    byId['PAY-9002'].invoiceId === null && byId['PAY-9002'].jobCardId === 'JOB-9001',
    { i: byId['PAY-9002'].invoiceId, j: byId['PAY-9002'].jobCardId });
  t('4. invoiceId null + jobCardId null',
    byId['PAY-9004'].invoiceId === null && byId['PAY-9004'].jobCardId === null,
    { i: byId['PAY-9004'].invoiceId, j: byId['PAY-9004'].jobCardId });
  t('a null reference is null, not ""',
    byId['PAY-9004'].invoiceId === null && byId['PAY-9004'].jobCardId === null);
  t('NULL notes -> ""', byId['PAY-9004'].notes === '', byId['PAY-9004'].notes);

  // ---- the three lookalike states ----
  const released = byId['PAY-9002'];
  t('a released advance has invoiceId null and stays Active',
    released.invoiceId === null && released.status === 'Active',
    { i: released.invoiceId, s: released.status });
  t('a released advance keeps the inherited job card', released.jobCardId === 'JOB-9001');
  t('a released advance keeps its amount', released.amount === 3000, released.amount);

  const voided = byId['PAY-9003'];
  t('a voided payment reports status Void', voided.status === 'Void', voided.status);
  t('a voided payment KEEPS its invoiceId', voided.invoiceId === 'INV-9001', voided.invoiceId);
  t('a voided payment keeps its amount', voided.amount === 500, voided.amount);
  t('a voided payment keeps its date, method and notes',
    voided.date === '2026-09-25' && voided.method === 'Card' && voided.notes === 'Keyed twice');
  t('void and released-advance are different states over the wire',
    voided.invoiceId !== null && released.invoiceId === null,
    { voided: voided.invoiceId, released: released.invoiceId });

  // ---- methods and statuses ----
  const methods = new Set(r.body.data.map(p => p.method));
  t('Cash round-trips', methods.has('Cash'));
  t('Card round-trips', methods.has('Card'));
  t('Bank Transfer round-trips', methods.has('Bank Transfer'));
  t('Mobile Banking round-trips', methods.has('Mobile Banking'));
  t('both statuses present',
    r.body.data.some(p => p.status === 'Active') && r.body.data.some(p => p.status === 'Void'));

  // ---- nothing derived, nothing embedded ----
  const keys = new Set(r.body.data.flatMap(p => Object.keys(p)));
  t('no isAdvance / paymentType / releasedFromInvoice invented',
    !['isAdvance','advance','paymentType','releasedFromInvoice'].some(k => keys.has(k)), [...keys]);
  t('no livePaid / due / invoiceStatus invented',
    !['livePaid','due','invoiceStatus','invoiceTotal','paid'].some(k => keys.has(k)), [...keys]);
  t('no invoice / customer / job card object embedded',
    !['invoice','customer','customerName','jobCard','vehicle'].some(k => keys.has(k)), [...keys]);
  t('exactly the stored fields and nothing else',
    [...keys].every(k => ['id','invoiceId','customerId','jobCardId','date','amount',
      'method','status','notes','createdAt','updatedAt'].includes(k)), [...keys]);

  // ---- pagination ----
  const p1 = await get('/api/payments?limit=2');
  t('limit=2 returns 2', p1.body?.data?.length === 2, p1.body?.data?.length);
  t('total still 5', p1.body?.total === 5, p1.body?.total);
  const p2 = await get('/api/payments?limit=2&offset=2');
  t('offset=2 returns the next page',
    JSON.stringify(p2.body.data.map(p => p.id)) === JSON.stringify(['PAY-9002','PAY-9004']),
    p2.body.data.map(p => p.id));
  t('pages do not overlap', !p2.body.data.some(p => p1.body.data.find(x => x.id === p.id)));
  const p3 = await get('/api/payments?offset=99');
  t('offset past end -> empty array, still 200', p3.status === 200 && p3.body.data.length === 0);
  const p4 = await get('/api/payments?limit=1000');
  t('limit=1000 succeeds', p4.status === 200, p4.status);
  t('and returns every payment', p4.body?.count === 5, p4.body?.count);
  for (const [q, why] of [['limit=0','limit below min'], ['limit=1001','limit above max'],
                          ['limit=abc','limit not a number'], ['offset=-1','offset negative']]) {
    const bad = await get('/api/payments?' + q);
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_parameter', { q, status: bad.status });
  }

  // ---- detail ----
  const d = await get('/api/payments/PAY-9001');
  t('detail 200', d.status === 200, d.status);
  t('detail matches the list record', JSON.stringify(d.body.data) === JSON.stringify(linked));
  t('no list meta on detail', d.body.count === undefined && d.body.limit === undefined);
  const dAdvance = await get('/api/payments/PAY-9004');
  t('pure advance detail keeps both references null',
    dAdvance.body?.data?.invoiceId === null && dAdvance.body?.data?.jobCardId === null);
  const dVoid = await get('/api/payments/PAY-9003');
  t('voided detail keeps its invoice link', dVoid.body?.data?.invoiceId === 'INV-9001');

  const d404 = await get('/api/payments/PAY-8888');
  t('unknown id -> 404', d404.status === 404, d404.status);
  t('404 message names a payment',
    d404.body?.error?.message === 'No payment with that id.', d404.body?.error?.message);
  for (const other of ['INV-9001','JOB-9001','CUS-9001','VEH-9001','PRT-9001','APT-9001','SRV-9001','MEC-9001']) {
    const x = await get('/api/payments/' + other);
    t(`${other} on the payments route -> 404, not 400`, x.status === 404, x.status);
  }
  const pOnInv = await get('/api/invoices/PAY-9001');
  t('payment id on the invoices route -> 404',
    pOnInv.status === 404 && pOnInv.body?.error?.message === 'No invoice with that id.');

  for (const [id, why] of [['nonsense','no prefix shape'], ['PAY-','no number'], ['-9001','no prefix'],
                           ['PAYMENTS-9001','prefix too long'], ['P-1','prefix too short']]) {
    const bad = await get('/api/payments/' + encodeURIComponent(id));
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_id', { id, status: bad.status });
  }
  const dSlash = await get('/api/payments/');
  t('trailing slash -> 400', dSlash.status === 400 && dSlash.body?.error?.code === 'invalid_id');
  const dEsc = await fetch(BASE + '/api/payments/%zz');
  t('malformed percent-escape -> 400', dEsc.status === 400, dEsc.status);

  // Injections aimed at both the payment and the invoice it feeds.
  const injVoid = await get('/api/payments/' + encodeURIComponent("PAY-9001'; UPDATE payments SET status='Void' --"));
  t('status-rewriting injection rejected -> 400', injVoid.status === 400, injVoid.status);
  const injAmount = await get('/api/payments/' + encodeURIComponent("PAY-9001'; UPDATE payments SET amount=0 --"));
  t('amount-rewriting injection rejected -> 400', injAmount.status === 400, injAmount.status);
  const injInv = await get('/api/payments/' + encodeURIComponent("PAY-9001'; UPDATE invoices SET paid=0 --"));
  t('invoice-rewriting injection rejected -> 400', injInv.status === 400, injInv.status);
  const afterInj = await get('/api/payments/PAY-9001');
  t('payment survived the injection attempts',
    afterInj.body?.data?.amount === 8295 && afterInj.body?.data?.status === 'Active',
    { amount: afterInj.body?.data?.amount, status: afterInj.body?.data?.status });
  const allAfter = await get('/api/payments');
  t('payments table intact after injection attempts', allAfter.body?.total === 5, allAfter.body?.total);

  // C-8 gave this collection writes, so only the methods it still refuses are
  // asserted here, and the Allow header now names the new ones. Section 19
  // covers the writes themselves.
  for (const m of ['PUT','DELETE','PATCH']) {
    const rl = await get('/api/payments', { method: m });
    t(`${m} list -> 405 + Allow`, rl.status === 405 && rl.allow === 'GET, POST', { status: rl.status, allow: rl.allow });
  }
  for (const m of ['POST','PATCH']) {
    const rd = await get('/api/payments/PAY-9001', { method: m });
    t(`${m} detail -> 405 + Allow`, rd.status === 405 && rd.allow === 'GET, PUT, DELETE', { status: rd.status, allow: rd.allow });
  }

  // ---- and now the invoice again: nothing above may have moved it ----
  const invAfter = (await get('/api/invoices/INV-9001')).body.data;
  t('GET /api/payments did not change the invoice paid',
    invAfter.paid === beforeSnapshot.paid, { before: beforeSnapshot.paid, after: invAfter.paid });
  t('GET /api/payments did not change the invoice due',
    invAfter.due === beforeSnapshot.due, { before: beforeSnapshot.due, after: invAfter.due });
  t('GET /api/payments did not change the invoice status',
    invAfter.status === beforeSnapshot.status, { before: beforeSnapshot.status, after: invAfter.status });
  t('the whole invoice record is byte-identical before and after',
    JSON.stringify(invAfter) === JSON.stringify(invBefore),
    { before: invBefore, after: invAfter });
  // INV-9001 carries an Active 8295 and a Void 500; a route that recomputed
  // would have written 8295 either way, so check the voided invoice too, whose
  // stored 3000/1935 disagree with its (zero) linked payments.
  const voidedInv = (await get('/api/invoices/INV-9002')).body.data;
  t('the voided invoice still reports its frozen figures after reading payments',
    voidedInv.paid === 3000 && voidedInv.due === 1935 && voidedInv.status === 'Void',
    { paid: voidedInv.paid, due: voidedInv.due, status: voidedInv.status });
  // And the payments themselves are unchanged by having been read.
  const payAfter = await get('/api/payments');
  t('reading payments did not change any payment',
    JSON.stringify(payAfter.body.data) === JSON.stringify(r.body.data),
    'payment rows differ after a read');
}

sec('10h. GET /api/expenses — stored rows, Void included, no aggregates');
{
  const r = await get('/api/expenses');
  t('200', r.status === 200, r.status);
  t('count 5', r.body?.count === 5, r.body?.count);
  t('total 5', r.body?.total === 5, r.body?.total);
  t('meta keys match the other collections',
    JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['count','data','limit','offset','total']),
    Object.keys(r.body));
  t('newest first by created_at',
    JSON.stringify(r.body.data.map(e => e.id)) ===
      JSON.stringify(['EXP-9001','EXP-9002','EXP-9003','EXP-9004','EXP-9005']),
    r.body.data.map(e => e.id));

  const byId = Object.fromEntries(r.body.data.map(e => [e.id, e]));

  // ---- exact field mapping ----
  const full = byId['EXP-9001'];
  t('full expense record shape', JSON.stringify(full) === JSON.stringify({
    id:'EXP-9001', date:'2026-09-25', category:'Parts Purchase',
    description:'Engine oil restock — 12 cans', amount:26400, method:'Bank Transfer',
    payee:'Dhaka Auto Parts', reference:'INV-DAP-8842', notes:'Quarterly restock',
    status:'Active', createdAt:'2026-09-25T10:00:00' }), full);
  t('camelCase keys only', Object.keys(full).every(k => !k.includes('_')), Object.keys(full));
  t('date is stored text, not shifted', full.date === '2026-09-25', full.date);
  t('updatedAt omitted when never updated', !('updatedAt' in full), Object.keys(full));

  const nulls = byId['EXP-9003'];
  t('NULL payee -> ""', nulls.payee === '', nulls.payee);
  t('NULL reference -> ""', nulls.reference === '', nulls.reference);
  t('NULL notes -> ""', nulls.notes === '', nulls.notes);
  t('a NULL optional is "" and not null',
    nulls.payee !== null && nulls.reference !== null && nulls.notes !== null);
  t('stored empty strings stay ""',
    byId['EXP-9005'].payee === '' && byId['EXP-9005'].reference === '');

  const dec = byId['EXP-9004'];
  t('updatedAt present when set', dec.updatedAt === '2026-09-26T09:00:00', dec.updatedAt);
  t('a decimal amount survives the round trip', dec.amount === 612.5, dec.amount);
  t('a large amount survives', byId['EXP-9005'].amount === 1000000, byId['EXP-9005'].amount);
  t('amount is a number over the wire', typeof dec.amount === 'number', typeof dec.amount);

  // ---- categories and methods ----
  t('a non-canonical category round-trips',
    byId['EXP-9005'].category === 'Legacy Category', byId['EXP-9005'].category);
  t('it was not coerced to Other', byId['EXP-9005'].category !== 'Other');
  const methods = new Set(r.body.data.map(e => e.method));
  t('Cash round-trips', methods.has('Cash'));
  t('Card round-trips', methods.has('Card'));
  t('Bank Transfer round-trips', methods.has('Bank Transfer'));
  t('Mobile Banking round-trips', methods.has('Mobile Banking'));

  // ---- Void rows are returned, and the consumer still filters them ----
  const voided = byId['EXP-9002'];
  t('the Void expense is present in the list', Boolean(voided), r.body.data.map(e => e.id));
  t('it reports status Void', voided.status === 'Void', voided.status);
  t('its amount is intact', voided.amount === 8500, voided.amount);
  t('and every other field too',
    voided.date === '2026-09-24' && voided.category === 'Electricity'
      && voided.method === 'Mobile Banking' && voided.payee === 'DESCO');
  t('both statuses appear in one page',
    r.body.data.some(e => e.status === 'Active') && r.body.data.some(e => e.status === 'Void'));
  const dVoid = await get('/api/expenses/EXP-9002');
  t('a Void expense is retrievable by id', dVoid.status === 200, dVoid.status);
  t('and reports Void with its amount', dVoid.body?.data?.status === 'Void' && dVoid.body?.data?.amount === 8500);

  // reports.js and dashboard.js filter status !== 'Void' themselves before
  // summing; the API hands over every row and that logic still works on it.
  const active = r.body.data.filter(e => e.status !== 'Void');
  t('a consumer can still exclude Void rows from the API response', active.length === 4, active.length);
  t('and sum only the active ones, as reports.js does',
    active.reduce((s, e) => s + e.amount, 0) === 26400 + 4200 + 612.5 + 1000000,
    active.reduce((s, e) => s + e.amount, 0));
  t('the excluded row is exactly the voided one',
    !active.some(e => e.id === 'EXP-9002'), active.map(e => e.id));
  t('the API itself applied no status filter',
    r.body.count === 5 && active.length === 4, { api: r.body.count, afterFilter: active.length });

  // ---- no aggregates, nothing joined ----
  const keys = new Set(r.body.data.flatMap(e => Object.keys(e)));
  t('no total / byCategory / netResult invented',
    !['total','expenseTotal','byCategory','byMethod','byDay','netResult','net'].some(k => keys.has(k)),
    [...keys]);
  t('no isVoid / isActive invented', !['isVoid','isActive'].some(k => keys.has(k)), [...keys]);
  t('exactly the stored fields and nothing else',
    [...keys].every(k => ['id','date','category','description','amount','method','payee',
      'reference','notes','status','createdAt','updatedAt'].includes(k)), [...keys]);
  t('no reference id to any other collection',
    ![...keys].some(k => /Id$/.test(k)), [...keys]);

  // ---- pagination ----
  const p1 = await get('/api/expenses?limit=2');
  t('limit=2 returns 2', p1.body?.data?.length === 2, p1.body?.data?.length);
  t('total still 5', p1.body?.total === 5, p1.body?.total);
  const p2 = await get('/api/expenses?limit=2&offset=2');
  t('offset=2 returns the next page',
    JSON.stringify(p2.body.data.map(e => e.id)) === JSON.stringify(['EXP-9003','EXP-9004']),
    p2.body.data.map(e => e.id));
  t('pages do not overlap', !p2.body.data.some(e => p1.body.data.find(x => x.id === e.id)));
  const p3 = await get('/api/expenses?offset=99');
  t('offset past end -> empty array, still 200', p3.status === 200 && p3.body.data.length === 0);
  const p4 = await get('/api/expenses?limit=1000');
  t('limit=1000 succeeds', p4.status === 200, p4.status);
  t('and returns every expense', p4.body?.count === 5, p4.body?.count);
  const p5 = await get('/api/expenses?limit=500');
  t('limit=500 succeeds', p5.status === 200, p5.status);
  for (const [q, why] of [['limit=0','limit below min'], ['limit=1001','limit above max'],
                          ['limit=abc','limit not a number'], ['offset=-1','offset negative']]) {
    const bad = await get('/api/expenses?' + q);
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_parameter', { q, status: bad.status });
  }

  // ---- detail and ids ----
  const d = await get('/api/expenses/EXP-9001');
  t('detail 200', d.status === 200, d.status);
  t('detail matches the list record', JSON.stringify(d.body.data) === JSON.stringify(full));
  t('no list meta on detail', d.body.count === undefined && d.body.limit === undefined);

  const d404 = await get('/api/expenses/EXP-8888');
  t('unknown id -> 404', d404.status === 404, d404.status);
  t('404 message names an expense',
    d404.body?.error?.message === 'No expense with that id.', d404.body?.error?.message);
  for (const other of ['PAY-9001','INV-9001','JOB-9001','CUS-9001','VEH-9001','PRT-9001','APT-9001','MEC-9001']) {
    const x = await get('/api/expenses/' + other);
    t(`${other} on the expenses route -> 404, not 400`, x.status === 404, x.status);
  }
  const eOnPay = await get('/api/payments/EXP-9001');
  t('expense id on the payments route -> 404',
    eOnPay.status === 404 && eOnPay.body?.error?.message === 'No payment with that id.');

  for (const [id, why] of [['nonsense','no prefix shape'], ['EXP-','no number'], ['-9001','no prefix'],
                           ['EXPENSES-9001','prefix too long'], ['E-1','prefix too short']]) {
    const bad = await get('/api/expenses/' + encodeURIComponent(id));
    t(`${why} -> 400`, bad.status === 400 && bad.body?.error?.code === 'invalid_id', { id, status: bad.status });
  }
  const dSlash = await get('/api/expenses/');
  t('trailing slash -> 400', dSlash.status === 400 && dSlash.body?.error?.code === 'invalid_id');
  const dEsc = await fetch(BASE + '/api/expenses/%zz');
  t('malformed percent-escape -> 400', dEsc.status === 400, dEsc.status);

  const injVoid = await get('/api/expenses/' + encodeURIComponent("EXP-9001'; UPDATE expenses SET status='Void' --"));
  t('status-rewriting injection rejected -> 400', injVoid.status === 400, injVoid.status);
  const injAmount = await get('/api/expenses/' + encodeURIComponent("EXP-9001'; UPDATE expenses SET amount=0 --"));
  t('amount-rewriting injection rejected -> 400', injAmount.status === 400, injAmount.status);
  const afterInj = await get('/api/expenses/EXP-9001');
  t('expense survived the injection attempts',
    afterInj.body?.data?.amount === 26400 && afterInj.body?.data?.status === 'Active',
    { amount: afterInj.body?.data?.amount, status: afterInj.body?.data?.status });
  const allAfter = await get('/api/expenses');
  t('expenses table intact after injection attempts', allAfter.body?.total === 5, allAfter.body?.total);

  // C-2 gave this collection writes, so only the methods it still refuses are
  // asserted here, and the Allow header now names the new ones. Section 13
  // covers the writes themselves.
  for (const m of ['PUT','DELETE','PATCH']) {
    const rl = await get('/api/expenses', { method: m });
    t(`${m} list -> 405 + Allow`, rl.status === 405 && rl.allow === 'GET, POST', { status: rl.status, allow: rl.allow });
  }
  for (const m of ['POST','PATCH']) {
    const rd = await get('/api/expenses/EXP-9001', { method: m });
    t(`${m} detail -> 405 + Allow`, rd.status === 405 && rd.allow === 'GET, PUT, DELETE', { status: rd.status, allow: rd.allow });
  }
}

sec('10i. GET /api/inventory-transactions — the ledger, as history not balance');
{
  const r = await get('/api/inventory-transactions');
  t('ledger 200', r.status === 200, r.status);
  t('returns the 5 fixture rows', r.body?.count === 5, r.body?.count);
  t('total matches', r.body?.total === 5, r.body?.total);
  const rows = r.body?.data ?? [];
  const byId = Object.fromEntries(rows.map((x) => [x.id, x]));

  t('newest first', rows.map((x) => x.id).join(',') === 'STK-9005,STK-9004,STK-9003,STK-9002,STK-9001',
    rows.map((x) => x.id));

  // Exact mapping on the fully populated row.
  const a = byId['STK-9001'];
  t('partId maps from part_id', a?.partId === 'PRT-9001', a?.partId);
  t('type verbatim', a?.type === 'initial-stock', a?.type);
  t('quantity as stored', a?.quantity === 18, a?.quantity);
  t('unitCost as stored', a?.unitCost === 350, a?.unitCost);
  t('referenceType maps from reference_type', a?.referenceType === 'manual', a?.referenceType);
  t('prevStock maps from prev_stock', a?.prevStock === 0, a?.prevStock);
  t('newStock maps from new_stock', a?.newStock === 18, a?.newStock);
  t('createdAt maps from created_at', a?.createdAt === '2026-09-10T09:05:00', a?.createdAt);
  t('no snake_case leaked', !JSON.stringify(rows).includes('part_id'), JSON.stringify(a));
  t('no updatedAt — the ledger is append-only', rows.every((x) => !('updatedAt' in x)));
  t('exactly 12 fields per record', Object.keys(a ?? {}).length === 12, Object.keys(a ?? {}));

  // null versus zero — the distinction inventory.js:608 renders.
  t('a NULL unit_cost comes back null', byId['STK-9002']?.unitCost === null, byId['STK-9002']?.unitCost);
  t('a ZERO unit_cost comes back 0, not null', byId['STK-9004']?.unitCost === 0, byId['STK-9004']?.unitCost);
  t('zero is a number', typeof byId['STK-9004']?.unitCost === 'number');
  t('the two stay distinguishable',
    byId['STK-9002']?.unitCost == null && byId['STK-9004']?.unitCost != null);

  // References keep null; free text falls back to ''.
  t('manual movement has a null referenceId', byId['STK-9001']?.referenceId === null, byId['STK-9001']?.referenceId);
  t('job movement carries its job id', byId['STK-9002']?.referenceId === 'JOB-9001', byId['STK-9002']?.referenceId);
  t('an all-NULL row keeps null references',
    byId['STK-9005']?.referenceType === null && byId['STK-9005']?.referenceId === null, byId['STK-9005']);
  t('NULL reason -> \'\'', byId['STK-9005']?.reason === '', byId['STK-9005']?.reason);
  t('NULL notes -> \'\'', byId['STK-9005']?.notes === '', byId['STK-9005']?.notes);
  t('a real reason survives', byId['STK-9004']?.reason === 'Supplier sample', byId['STK-9004']?.reason);

  // Fractional quantities and stock survive the REAL columns.
  t('fractional quantity survives', byId['STK-9005']?.quantity === 1.5, byId['STK-9005']?.quantity);
  t('fractional prevStock survives', byId['STK-9005']?.prevStock === 4.5, byId['STK-9005']?.prevStock);

  // Both directions present, neither normalised.
  t('an outbound row keeps a positive quantity', byId['STK-9002']?.quantity === 2, byId['STK-9002']?.quantity);
  t('a return row is its own type', byId['STK-9003']?.type === 'return', byId['STK-9003']?.type);
  t('no direction/sign field is invented',
    rows.every((x) => !('direction' in x) && !('sign' in x)));

  // No aggregates anywhere in the envelope or the rows.
  for (const key of ['movementIn', 'movementOut', 'usageByPart', 'stockValue', 'balance', 'issued']) {
    t(`no invented \`${key}\``, !(key in (r.body ?? {})) && rows.every((x) => !(key in x)), key);
  }

  // The ledger and parts.stock are not reconciled by the API — B-6's rule.
  const partsRes = await get('/api/parts');
  const prt1 = (partsRes.body?.data ?? []).find((p) => p.id === 'PRT-9001');
  t('parts still reports its own stock column', prt1?.stock === 18, prt1?.stock);
  t('the ledger row carries no stock field of its own', !('stock' in (byId['STK-9001'] ?? {})));

  // Detail, paging, and failure modes.
  const d = await get('/api/inventory-transactions/STK-9002');
  t('detail 200', d.status === 200, d.status);
  t('detail returns the right row', d.body?.data?.id === 'STK-9002', d.body?.data?.id);
  t('detail has no paging metadata', !('count' in (d.body ?? {})));
  const miss = await get('/api/inventory-transactions/STK-7777');
  t('unknown id -> 404', miss.status === 404, miss.status);
  t('404 message names the singular',
    miss.body?.error?.message === 'No inventory transaction with that id.', miss.body?.error);
  const cross = await get('/api/inventory-transactions/PRT-9001');
  t('a well-formed id from another collection -> 404', cross.status === 404, cross.status);
  const bad = await get('/api/inventory-transactions/nope');
  t('a malformed id -> 400', bad.status === 400, bad.status);

  const paged = await get('/api/inventory-transactions?limit=2&offset=1');
  t('paging works', paged.body?.count === 2 && paged.body?.total === 5, paged.body);
  const badLimit = await get('/api/inventory-transactions?limit=0');
  t('limit=0 -> 400', badLimit.status === 400, badLimit.status);

  // C-4 made POST a real route on the list path. The ledger is append-only,
  // so PUT and DELETE stay refused -- on the detail path too, where a recorded
  // movement could otherwise be edited or erased. Section 15 covers the writes.
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const w = await get('/api/inventory-transactions', { method });
    t(`${method} -> 405`, w.status === 405, w.status);
    t(`${method} Allow names POST`, w.allow === 'GET, POST', w.allow);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const w = await get('/api/inventory-transactions/STK-9001', { method });
    t(`${method} on a recorded movement -> 405`, w.status === 405, w.status);
    t(`${method} sets Allow: GET`, w.allow === 'GET', w.allow);
  }

  // A GET changes nothing.
  const after = await get('/api/inventory-transactions');
  t('repeated GETs are byte-identical',
    JSON.stringify(after.body) === JSON.stringify(r.body));
  t('still 5 rows afterwards', after.body?.count === 5, after.body?.count);
}

sec('10j. GET /api/settings — the singleton, read whole and left alone');
{
  const r = await get('/api/settings');
  t('settings 200', r.status === 200, r.status);
  t('JSON content type', (r.ct || '').includes('application/json'), r.ct);

  const s = r.body?.data;
  t('data is an object', s !== null && typeof s === 'object');
  t('data is NOT an array', Array.isArray(s) === false, s);
  t('the envelope carries only data', JSON.stringify(Object.keys(r.body ?? {})) === '["data"]', Object.keys(r.body ?? {}));
  for (const key of ['count', 'total', 'limit', 'offset']) {
    t(`no \`${key}\` on a singleton`, !(key in (r.body ?? {})), key);
  }

  // Every value below is the literal in fixtures/seed.sql.
  t('businessName', s?.businessName === 'Taqwa Automobile Service Center', s?.businessName);
  t('phone', s?.phone === '+880 1712-345678', s?.phone);
  t('email', s?.email === 'info@taqwaauto.com', s?.email);
  t('website', s?.website === 'https://taqwaauto.com', s?.website);
  t('taxId maps from tax_id', s?.taxId === 'BIN-004471928', s?.taxId);
  t('address', s?.address === 'Sector #15, Block #C, Road #3/A, Plot #40, Diabari, Uttara, Dhaka', s?.address);
  t('businessDescription maps from business_description',
    s?.businessDescription === 'Full-service automobile workshop — servicing, diagnostics and parts.', s?.businessDescription);
  t('invoiceFooter maps from invoice_footer',
    s?.invoiceFooter === 'Thank you for servicing with Taqwa Automobile Service Center.', s?.invoiceFooter);
  t('paymentTerms maps from payment_terms', s?.paymentTerms === 'Payment due within 7 days of invoicing.', s?.paymentTerms);
  t('taxRate maps from tax_rate and stays numeric', s?.taxRate === 5 && typeof s?.taxRate === 'number', s?.taxRate);
  t('currency survives the round trip as a multi-byte symbol', s?.currency === '৳', s?.currency);
  t('defaultAppointmentDuration maps from default_appointment_duration',
    s?.defaultAppointmentDuration === 60, s?.defaultAppointmentDuration);
  t('openingTime maps from opening_time', s?.openingTime === '09:00', s?.openingTime);
  t('closingTime maps from closing_time', s?.closingTime === '20:00', s?.closingTime);
  t('updatedAt maps from updated_at', s?.updatedAt === '2026-09-26T09:00:00', s?.updatedAt);

  // working_days is JSON text in the column and must arrive as a real array.
  t('workingDays is an array, not the stored string', Array.isArray(s?.workingDays), s?.workingDays);
  t('workingDays parsed correctly',
    JSON.stringify(s?.workingDays) === JSON.stringify(['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu']), s?.workingDays);

  // The frontend's fifteen fields, all present; id and theme, neither.
  t('all 15 frontend fields present',
    ['businessName', 'phone', 'email', 'website', 'taxId', 'address', 'businessDescription',
      'invoiceFooter', 'paymentTerms', 'taxRate', 'currency', 'defaultAppointmentDuration',
      'openingTime', 'closingTime', 'workingDays'].every(k => k in (s ?? {})), Object.keys(s ?? {}));
  t('id is not exposed', !('id' in (s ?? {})));
  t('theme is not exposed — it stays in localStorage', !('theme' in (s ?? {})));
  t('no field came back null', Object.values(s ?? {}).every(v => v !== null), s);

  // A GET must not touch the row. Compare the whole payload before and after,
  // and confirm the singleton is still exactly one row afterwards.
  const before = JSON.stringify(s);
  await get('/api/settings');
  await get('/api/settings');
  const after = await get('/api/settings');
  t('repeated GETs return a byte-identical record', JSON.stringify(after.body?.data) === before,
    { before, after: JSON.stringify(after.body?.data) });

  // C-9 added PUT; the rule under test is unchanged, and the Allow header now
  // names both methods the singleton really takes. Section 20 covers the write.
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const w = await get('/api/settings', { method });
    t(`${method} /api/settings -> 405`, w.status === 405, w.status);
    t(`${method} sets Allow: GET, PUT`, w.allow === 'GET, PUT', w.allow);
    t(`${method} error code`, w.body?.error?.code === 'method_not_allowed', w.body);
  }

  // The singleton has no addressable id, so anything below the path is a
  // plain unknown route — not a 400 from an id validator, and not a crash.
  for (const path of ['/api/settings/1', '/api/settings/anything', '/api/settings/SET-0001', '/api/settings/']) {
    const d = await get(path);
    t(`${path} -> 404`, d.status === 404, d.status);
    t(`${path} uses the standard not-found shape`, d.body?.error?.code === 'not_found', d.body);
  }

  // Paging params are meaningless here and must not be echoed back.
  const paged = await get('/api/settings?limit=5&offset=3');
  t('query params are ignored, not treated as paging', paged.status === 200 && !('limit' in (paged.body ?? {})), paged.body);

  // And after all of the above, the row is still there, unchanged and single.
  const final = await get('/api/settings');
  t('the row survived every request above', final.status === 200 && JSON.stringify(final.body?.data) === before,
    { before, final: JSON.stringify(final.body?.data) });
}

sec('11. Collections stay separate over the wire');
{
  const [s, c, v, m, p, a, j, inv, pay, exp] = await Promise.all([
    get('/api/services'), get('/api/customers'), get('/api/vehicles'),
    get('/api/mechanics'), get('/api/parts'), get('/api/appointments'),
    get('/api/job-cards'), get('/api/invoices'), get('/api/payments'), get('/api/expenses')]);
  t('services returns only SRV ids', s.body.data.every(x => x.id.startsWith('SRV-')));
  t('customers returns only CUS ids', c.body.data.every(x => x.id.startsWith('CUS-')));
  t('vehicles returns only VEH ids', v.body.data.every(x => x.id.startsWith('VEH-')));
  t('services rows have no customer fields', !s.body.data.some(x => 'phone' in x || 'regNo' in x));
  t('customers rows have no service fields', !c.body.data.some(x => 'price' in x || 'estTime' in x));
  t('vehicles rows have no service fields', !v.body.data.some(x => 'price' in x || 'estTime' in x));
  t('mechanics returns only MEC ids', m.body.data.every(x => x.id.startsWith('MEC-')));
  t('mechanics rows have no vehicle or service fields',
    !m.body.data.some(x => 'regNo' in x || 'price' in x || 'estTime' in x));
  t('parts returns only PRT ids', p.body.data.every(x => x.id.startsWith('PRT-')));
  t('stock never appears outside parts',
    ![...s.body.data, ...c.body.data, ...v.body.data, ...m.body.data].some(x => 'stock' in x));
  t('parts rows carry no salary or service fields',
    !p.body.data.some(x => 'salary' in x || 'estTime' in x));
  t('appointments returns only APT ids', a.body.data.every(x => x.id.startsWith('APT-')));
  t('no other collection carries a source or reminderSent',
    ![...s.body.data, ...c.body.data, ...v.body.data, ...m.body.data, ...p.body.data]
      .some(x => 'source' in x || 'reminderSent' in x));
  t('appointments rows carry no stock or salary',
    !a.body.data.some(x => 'stock' in x || 'salary' in x));
  t('job cards returns only JOB ids', j.body.data.every(x => x.id.startsWith('JOB-')));
  t('only job cards carry child line arrays',
    ![...s.body.data, ...c.body.data, ...v.body.data, ...m.body.data, ...p.body.data, ...a.body.data]
      .some(x => 'services' in x || 'partsUsed' in x));
  t('job card rows carry no stock or salary',
    !j.body.data.some(x => 'stock' in x || 'salary' in x));
  t('invoices returns only INV ids', inv.body.data.every(x => x.id.startsWith('INV-')));
  t('only job cards and invoices carry child line arrays',
    ![...s.body.data, ...c.body.data, ...v.body.data, ...m.body.data, ...p.body.data, ...a.body.data]
      .some(x => 'services' in x || 'partsUsed' in x));
  t('invoice rows carry no stock, salary or complaint',
    !inv.body.data.some(x => 'stock' in x || 'salary' in x || 'complaint' in x));
  t('payments returns only PAY ids', pay.body.data.every(x => x.id.startsWith('PAY-')));
  t('only payments carry amount and method',
    ![...s.body.data, ...c.body.data, ...v.body.data, ...m.body.data, ...p.body.data,
      ...a.body.data, ...j.body.data, ...inv.body.data].some(x => 'amount' in x || 'method' in x));
  t('payment rows carry no totals or child line arrays',
    !pay.body.data.some(x => 'total' in x || 'services' in x || 'partsUsed' in x));
  t('expenses returns only EXP ids', exp.body.data.every(x => x.id.startsWith('EXP-')));
  t('only expenses carry category and payee',
    ![...c.body.data, ...v.body.data, ...m.body.data, ...a.body.data,
      ...j.body.data, ...inv.body.data, ...pay.body.data].some(x => 'payee' in x));
  t('expense rows carry no reference to any other collection',
    !exp.body.data.some(x => Object.keys(x).some(k => /Id$/.test(k))));
  t('salary never appears outside mechanics',
    ![...s.body.data, ...c.body.data, ...v.body.data].some(x => 'salary' in x || 'commissionRate' in x));
}

sec('12. Unknown routes');
{
  // Pick a collection the router does NOT know, derived from what health
  // advertises rather than hardcoded. B-4 hardcoded /api/mechanics here and
  // B-5 turned it into a real route, so the assertion started failing for the
  // wrong reason. Deriving it means the next phase inherits this unchanged.
  const advertised = (await get('/api/health')).body?.data?.routes ?? [];
  const unregistered = ['parts', 'invoices', 'payments', 'expenses', 'widgets']
    .find(name => !advertised.includes(`GET /api/${name}`));
  t('a collection to probe was found', Boolean(unregistered), advertised);

  const r = await get(`/api/${unregistered}`);
  t(`unregistered collection /api/${unregistered} -> 404`, r.status === 404, r.status);
  t('404 advertises exactly what health advertises',
    JSON.stringify(r.body?.error?.available) === JSON.stringify(advertised),
    { from404: r.body?.error?.available, fromHealth: advertised });
  // True through Phase B; C-2 made it false by design. The replacement says
  // strictly more: only these four methods are ever advertised, and the
  // collections that are still read-only advertise nothing but GET.
  t('only GET/POST/PUT/DELETE are advertised',
    advertised.every(x => ['GET', 'POST', 'PUT', 'DELETE'].includes(x.split(' ')[0])), advertised);
  // Every collection now has a write path: appointments left this list in C-3,
  // job cards in C-5, invoices in C-7, payments in C-8 and settings in C-9.
  // The ledger accepts POST as of C-4 and is asserted separately, since it is
  // append-only rather than read-only. What is still worth asserting is that
  // nothing acquired a method it has no business having.
  t('settings offers a read and a write, and nothing else',
    JSON.stringify(advertised.filter(x => x.includes('/api/settings')).sort())
      === JSON.stringify(['GET /api/settings', 'PUT /api/settings']),
    advertised.filter(x => x.includes('/api/settings')));
  t('   ...and no collection advertises a method twice',
    new Set(advertised).size === advertised.length, advertised.length);

  t('the ledger advertises POST but never PUT or DELETE',
    advertised.includes('POST /api/inventory-transactions')
      && !advertised.includes('PUT /api/inventory-transactions/:id')
      && !advertised.includes('DELETE /api/inventory-transactions/:id'),
    advertised.filter(x => x.includes('inventory-transactions')));

  const r2 = await get('/api/services/extra/segments');
  t('deep path under services -> 400 or 404, never 500', r2.status === 400 || r2.status === 404, r2.status);
  const r3 = await get('/nope');
  t('non-api path -> 404', r3.status === 404);
}

sec('13. Writes: the six simple entities, against real D1');
{
  // Everything created here is deleted again before the section ends, and
  // run.sh resets id_counters afterwards -- see cleanup.sql for why that is
  // safe. These ids are REAL sequential ones, not 9xxx fixtures.
  const created = {};

  // ---- create ----
  const cust = await send('POST', '/api/customers',
    { name: 'C-2 Write Test', phone: '01911-000111', email: 'w@t.com' });
  t('POST /api/customers -> 201', cust.status === 201, cust.body);
  created.customer = cust.body?.data?.id;
  t('   ...allocated a real CUS id', /^CUS-\d{4}$/.test(created.customer || ''), created.customer);
  t('   ...created_at was set', !!cust.body?.data?.createdAt, cust.body?.data);
  t('   ...updated_at absent on create', !('updatedAt' in (cust.body?.data ?? {})), cust.body?.data);
  t('   ...optional fields defaulted to \'\'', cust.body?.data?.address === '', cust.body?.data);

  // The row is really there, through the read route.
  const readBack = await get(`/api/customers/${created.customer}`);
  t('   ...and is readable immediately', readBack.status === 200 && readBack.body?.data?.name === 'C-2 Write Test',
    readBack.body);

  // ---- sequential ids ----
  const cust2 = await send('POST', '/api/customers', { name: 'Second', phone: '01911-000222' });
  t('a second create gets the next id',
    Number(cust2.body?.data?.id?.slice(4)) === Number(created.customer.slice(4)) + 1,
    [created.customer, cust2.body?.data?.id]);
  created.customer2 = cust2.body?.data?.id;

  // ---- application-level uniqueness ----
  const dup = await send('POST', '/api/customers', { name: 'Clash', phone: '+01911000111' });
  t('a differently-formatted duplicate phone -> 409', dup.status === 409, dup.body);
  t('   ...names the existing customer', dup.body?.error?.conflictsWith === created.customer, dup.body);

  // ---- merge ----
  const merged = await send('PUT', `/api/customers/${created.customer}`, { notes: 'merged note' });
  t('PUT merges -> 200', merged.status === 200, merged.body);
  t('   ...the supplied field changed', merged.body?.data?.notes === 'merged note', merged.body?.data);
  t('   ...the untouched fields survive',
    merged.body?.data?.name === 'C-2 Write Test' && merged.body?.data?.phone === '01911-000111',
    merged.body?.data);
  t('   ...updated_at now set', !!merged.body?.data?.updatedAt, merged.body?.data);
  t('   ...created_at unchanged', merged.body?.data?.createdAt === cust.body?.data?.createdAt);

  const ghost = await send('PUT', '/api/customers/CUS-7777', { notes: 'x' });
  t('PUT on an unknown id -> 404', ghost.status === 404, ghost.status);

  // ---- foreign keys are the database's job ----
  const orphan = await send('POST', '/api/vehicles',
    { customerId: 'CUS-7777', regNo: 'GHOST-1', brand: 'X', model: 'Y' });
  t('a vehicle for a missing customer -> 409', orphan.status === 409, orphan.body);
  t('   ...from the FK, with no table name leaked',
    orphan.body?.error?.code === 'conflict' && !JSON.stringify(orphan.body).includes('SQLITE'),
    orphan.body);

  const veh = await send('POST', '/api/vehicles',
    { customerId: created.customer, regNo: 'DHA-C2-01', brand: 'Toyota', model: 'Axio', year: 2019 });
  t('POST /api/vehicles -> 201', veh.status === 201, veh.body);
  created.vehicle = veh.body?.data?.id;
  t('   ...year survives', veh.body?.data?.year === 2019, veh.body?.data);
  t('   ...absent nullable numerics are null, not 0', veh.body?.data?.mileage === null, veh.body?.data);

  const regDup = await send('POST', '/api/vehicles',
    { customerId: created.customer, regNo: 'dha c2 01', brand: 'X', model: 'Y' });
  t('a normalised duplicate registration -> 409', regDup.status === 409, regDup.body);

  // ---- delete is blocked while referenced ----
  const blocked = await send('DELETE', `/api/customers/${created.customer}`);
  t('deleting a customer who still has a vehicle -> 409', blocked.status === 409, blocked.body);
  const still = await get(`/api/customers/${created.customer}`);
  t('   ...and the customer is still there', still.status === 200);

  // ---- the rest of the six ----
  const svc = await send('POST', '/api/services', { name: 'C-2 Service', category: 'Engine', price: 0 });
  t('POST /api/services with price 0 -> 201', svc.status === 201, svc.body);
  t('   ...price 0 stored as 0', svc.body?.data?.price === 0, svc.body?.data);
  created.service = svc.body?.data?.id;
  // Case-insensitive, trimmed — but NOT whitespace-collapsing, because
  // services.js:260 compares `s.name.trim().toLowerCase()` and nothing more.
  const svcDup = await send('POST', '/api/services', { name: '  c-2 service ', category: 'Engine', price: 5 });
  t('same name+category, different case -> 409', svcDup.status === 409, svcDup.body);
  const svcOtherCat = await send('POST', '/api/services', { name: 'C-2 Service', category: 'Brakes', price: 5 });
  t('the same name in another category is allowed', svcOtherCat.status === 201, svcOtherCat.body);
  created.service2 = svcOtherCat.body?.data?.id;

  const mec = await send('POST', '/api/mechanics',
    { name: 'C-2 Mechanic', phone: '01811-000111', specialization: 'Engine', experience: 0, commissionRate: 0 });
  t('POST /api/mechanics -> 201', mec.status === 201, mec.body);
  t('   ...experience 0 stays 0', mec.body?.data?.experience === 0, mec.body?.data);
  t('   ...commissionRate 0 stays 0', mec.body?.data?.commissionRate === 0, mec.body?.data);
  t('   ...absent salary is null', mec.body?.data?.salary === null, mec.body?.data);
  created.mechanic = mec.body?.data?.id;

  const part = await send('POST', '/api/parts',
    { name: 'C-2   Part', partNo: 'c2-p-1', category: 'Filters', unit: 'pc',
      purchasePrice: 100, sellingPrice: 150, minStock: 2 });
  t('POST /api/parts -> 201', part.status === 201, part.body);
  t('   ...stock starts at 0', part.body?.data?.stock === 0, part.body?.data);
  t('   ...partNo upper-cased', part.body?.data?.partNo === 'C2-P-1', part.body?.data);
  t('   ...name whitespace collapsed', part.body?.data?.name === 'C-2 Part', part.body?.data);
  created.part = part.body?.data?.id;

  const stockPost = await send('POST', '/api/parts',
    { name: 'X', partNo: 'c2-p-2', category: 'F', unit: 'pc',
      purchasePrice: 1, sellingPrice: 2, minStock: 0, stock: 99 });
  t('POST /api/parts carrying stock -> 422', stockPost.status === 422, stockPost.body);
  const stockPut = await send('PUT', `/api/parts/${created.part}`, { stock: 50 });
  t('PUT /api/parts carrying stock -> 422', stockPut.status === 422, stockPut.body);
  const stockCheck = await get(`/api/parts/${created.part}`);
  t('   ...and the stored stock is untouched', stockCheck.body?.data?.stock === 0, stockCheck.body?.data);
  const ledger = await get('/api/inventory-transactions');
  t('   ...no inventory transaction was written by part CRUD',
    (ledger.body?.data ?? []).every((x) => x.partId !== created.part), ledger.body?.count);

  const exp = await send('POST', '/api/expenses',
    { date: '2026-09-18', category: 'Tools', description: 'C-2 wrench', amount: 1500, method: 'Cash' });
  t('POST /api/expenses -> 201', exp.status === 201, exp.body);
  t('   ...created Active', exp.body?.data?.status === 'Active', exp.body?.data);
  created.expense = exp.body?.data?.id;

  const expDel = await send('DELETE', `/api/expenses/${created.expense}`);
  t('deleting an Active expense -> 409', expDel.status === 409, expDel.body);
  t('   ...with a machine-readable reason', expDel.body?.error?.reason === 'expense_is_active', expDel.body?.error);

  const expEdit = await send('PUT', `/api/expenses/${created.expense}`, { amount: 99 });
  t('editing an expense amount -> 422', expEdit.status === 422, expEdit.body);

  const voided = await send('PUT', `/api/expenses/${created.expense}`, { status: 'Void' });
  t('voiding an expense -> 200', voided.status === 200, voided.body);
  t('   ...the amount is preserved', voided.body?.data?.amount === 1500, voided.body?.data);
  t('   ...status is Void', voided.body?.data?.status === 'Void', voided.body?.data);

  // ---- tear down, newest reference first ----
  const delExp = await send('DELETE', `/api/expenses/${created.expense}`);
  t('deleting a Void expense -> 200', delExp.status === 200, delExp.body);

  const delPart = await send('DELETE', `/api/parts/${created.part}`);
  t('deleting an unused part -> 200', delPart.status === 200, delPart.body);

  for (const [label, path] of [
    ['service', `/api/services/${created.service}`],
    ['second service', `/api/services/${created.service2}`],
    ['mechanic', `/api/mechanics/${created.mechanic}`],
    ['vehicle', `/api/vehicles/${created.vehicle}`],
    ['customer', `/api/customers/${created.customer}`],
    ['second customer', `/api/customers/${created.customer2}`],
  ]) {
    const r = await send('DELETE', path);
    t(`deleting the ${label} -> 200`, r.status === 200, r.body);
    const after = await get(path);
    t(`   ...and it is gone`, after.status === 404, after.status);
  }

  // Nothing this section created is left behind.
  for (const [name, n] of [
    ['customers', 2], ['vehicles', 2], ['services', 6], ['mechanics', 3],
    ['parts', 3], ['expenses', 5],
  ]) {
    const r = await get(`/api/${name}`);
    t(`${name} is back to its ${n} fixture rows`, r.body?.total === n, r.body?.total);
  }
}

sec('14. Appointment writes: scheduling rules against real D1');
{
  // Each scenario gets its OWN far-future date. Sharing one date made every
  // scenario a neighbour of every other, which is exactly the interference
  // the overlap rule is designed to catch -- correct behaviour, useless test.
  const made = [];
  const book = (date, body) => send('POST', '/api/appointments', {
    customerId: 'CUS-9001', vehicleId: 'VEH-9001', serviceId: 'SRV-9001',
    mechanicId: 'MEC-9001', date, time: '10:00', duration: 60, source: 'Phone',
    ...body,
  });
  const keep = (r) => { if (r.status === 201 && r.body?.data?.id) made.push(r.body.data.id); return r; };

  // ---- 1. create ----------------------------------------------------------
  const D1 = '2099-01-05';
  const first = keep(await book(D1, {}));
  t('POST /api/appointments -> 201', first.status === 201, first.body);
  const firstId = first.body?.data?.id;
  t('   ...allocated a real APT id', /^APT-\d{4}$/.test(firstId || ''), firstId);
  t('   ...status defaults to Scheduled', first.body?.data?.status === 'Scheduled', first.body?.data);
  t('   ...reminderSent is a boolean, not 0', first.body?.data?.reminderSent === false, first.body?.data);
  t('   ...jobCardId is null', first.body?.data?.jobCardId === null, first.body?.data);
  t('   ...date and time stored verbatim',
    first.body?.data?.date === D1 && first.body?.data?.time === '10:00', first.body?.data);
  t('   ...createdAt set, updatedAt absent',
    !!first.body?.data?.createdAt && !('updatedAt' in (first.body?.data ?? {})), first.body?.data);
  const readBack = await get(`/api/appointments/${firstId}`);
  t('   ...and reads back identically',
    JSON.stringify(readBack.body?.data) === JSON.stringify(first.body?.data), readBack.body);

  // ---- 2. overlap, and the half-open boundary -----------------------------
  const clash = await book(D1, { time: '10:30', duration: 30, serviceId: 'SRV-9002' });
  t('an overlapping slot for the same mechanic -> 409', clash.status === 409, clash.body);
  t('   ...machine-readable reason', clash.body?.error?.reason === 'schedule_conflict', clash.body?.error);
  t('   ...names the appointment', clash.body?.error?.conflictsWith === firstId, clash.body?.error);
  t('   ...and the resource', clash.body?.error?.resource === 'mechanic', clash.body?.error);

  const after = keep(await book(D1, { time: '11:00', duration: 30, serviceId: 'SRV-9002' }));
  t('a slot starting exactly when the first ends -> 201', after.status === 201, after.body);
  const beforeIt = keep(await book(D1, { time: '09:00', duration: 60, serviceId: 'SRV-9003' }));
  t('a slot ending exactly when the first starts -> 201', beforeIt.status === 201, beforeIt.body);

  // ---- 3. overlap scope: mechanic OR vehicle, never workshop-wide ---------
  const D2 = '2099-02-05';
  keep(await book(D2, {}));                       // MEC-9001 + VEH-9001 at 10:00
  const otherBoth = keep(await book(D2, { time: '10:15', duration: 15, mechanicId: 'MEC-9002',
    vehicleId: 'VEH-9002', customerId: 'CUS-9002', serviceId: 'SRV-9004' }));
  t('a different mechanic AND vehicle does not clash', otherBoth.status === 201, otherBoth.body);

  const sameVehicle = await book(D2, { time: '10:15', duration: 15, mechanicId: 'MEC-9003',
    serviceId: 'SRV-9005' });
  t('the same VEHICLE clashes even with a different mechanic', sameVehicle.status === 409, sameVehicle.body);
  t('   ...and says so', sameVehicle.body?.error?.resource === 'vehicle', sameVehicle.body?.error);

  const sameMechanic = await book(D2, { time: '10:15', duration: 15, vehicleId: 'VEH-9002',
    customerId: 'CUS-9002', serviceId: 'SRV-9005' });
  t('the same MECHANIC clashes even with a different vehicle', sameMechanic.status === 409, sameMechanic.body);
  t('   ...and says so', sameMechanic.body?.error?.resource === 'mechanic', sameMechanic.body?.error);

  // A null mechanic drops the mechanic half of the rule and keeps the vehicle half.
  const D3 = '2099-03-05';
  keep(await book(D3, { mechanicId: null }));     // VEH-9001 at 10:00, no mechanic
  const nullVsVehicle = await book(D3, { time: '10:15', duration: 15, mechanicId: null,
    serviceId: 'SRV-9002' });
  t('a null mechanic still clashes on the vehicle', nullVsVehicle.status === 409, nullVsVehicle.body);
  t('   ...on the vehicle, necessarily', nullVsVehicle.body?.error?.resource === 'vehicle',
    nullVsVehicle.body?.error);
  const nullFree = keep(await book(D3, { time: '10:15', duration: 15, mechanicId: null,
    vehicleId: 'VEH-9002', customerId: 'CUS-9002', serviceId: 'SRV-9002' }));
  t('a null mechanic on another vehicle is free', nullFree.status === 201, nullFree.body);

  // ---- 4. terminal statuses never occupy the schedule ---------------------
  const D4 = '2099-04-05';
  const toCancel = keep(await book(D4, {}));
  await send('PUT', `/api/appointments/${toCancel.body?.data?.id}`, { status: 'Cancelled' });
  const overCancelled = keep(await book(D4, { serviceId: 'SRV-9002' }));
  t('a Cancelled appointment does not occupy its slot', overCancelled.status === 201, overCancelled.body);

  // ---- 5. duplicate booking, isolated from any overlap --------------------
  // Same customer, vehicle, service, date and time -- but the only appointment
  // it could overlap is the identical one, so the duplicate rule is what fires.
  const D5 = '2099-05-05';
  keep(await book(D5, { mechanicId: null }));
  const dup = await book(D5, { mechanicId: null });
  t('an identical booking -> 409', dup.status === 409, dup.body);
  t('   ...as a schedule conflict, which is checked first',
    dup.body?.error?.reason === 'schedule_conflict', dup.body?.error);
  // With the slot itself free, the duplicate rule is the one left standing:
  // a Cancelled twin does not occupy the slot but DOES still count as a
  // duplicate, because :123 ignores only Cancelled for overlap, not identity.
  const D6 = '2099-06-05';
  const twin = keep(await book(D6, { mechanicId: null }));
  await send('PUT', `/api/appointments/${twin.body?.data?.id}`, { status: 'Cancelled' });
  const dupOfCancelled = await book(D6, { mechanicId: null });
  t('an identical booking over a CANCELLED twin is allowed',
    dupOfCancelled.status === 201, dupOfCancelled.body);
  keep(dupOfCancelled);

  // ---- 6. referential rules ----------------------------------------------
  const D7 = '2099-07-05';
  const wrongOwner = await book(D7, { vehicleId: 'VEH-9002' });
  t('a vehicle belonging to another customer -> 422', wrongOwner.status === 422, wrongOwner.body);
  t('   ...names the field', !!wrongOwner.body?.error?.fields?.vehicleId, wrongOwner.body?.error);
  const ghostService = await book(D7, { serviceId: 'SRV-7777' });
  t('a missing service -> 409 from the foreign key', ghostService.status === 409, ghostService.body);
  t('   ...with no table name leaked',
    !JSON.stringify(ghostService.body).includes('SQLITE'), ghostService.body);

  // ---- 7. all five sources round-trip ------------------------------------
  const SOURCES = ['Admin', 'Phone', 'Walk-in', 'Facebook', 'Website'];
  for (let i = 0; i < SOURCES.length; i++) {
    const r = keep(await book(`2098-0${i + 1}-11`, { source: SOURCES[i], mechanicId: null }));
    t(`source ${SOURCES[i]} accepted`, r.status === 201, r.body);
    t(`   ...and stored verbatim`, r.body?.data?.source === SOURCES[i], r.body?.data);
  }
  const badSource = await book('2098-09-11', { source: 'Instagram' });
  t('an unknown source -> 422', badSource.status === 422, badSource.body);

  // ---- 8. merge -----------------------------------------------------------
  const merged = await send('PUT', `/api/appointments/${firstId}`, { notes: 'customer called back' });
  t('PUT merges -> 200', merged.status === 200, merged.body);
  t('   ...the supplied field changed', merged.body?.data?.notes === 'customer called back', merged.body?.data);
  t('   ...date, time and duration survive',
    merged.body?.data?.date === D1 && merged.body?.data?.time === '10:00'
      && merged.body?.data?.duration === 60, merged.body?.data);
  t('   ...as does the mechanic', merged.body?.data?.mechanicId === 'MEC-9001', merged.body?.data);
  t('   ...updatedAt now set', !!merged.body?.data?.updatedAt, merged.body?.data);
  t('   ...and it did not conflict with itself', merged.status !== 409);

  const grow = await send('PUT', `/api/appointments/${firstId}`, { duration: 120 });
  t('growing into the next appointment -> 409', grow.status === 409, grow.body);
  t('   ...naming the neighbour', grow.body?.error?.conflictsWith === after.body?.data?.id, grow.body?.error);

  // ---- 9. status transitions ---------------------------------------------
  const bad = await send('PUT', `/api/appointments/${firstId}`, { status: 'Completed' });
  t('Scheduled -> Completed -> 409', bad.status === 409, bad.body);
  t('   ...reason', bad.body?.error?.reason === 'illegal_status_transition', bad.body?.error);
  t('Scheduled -> Confirmed -> 200',
    (await send('PUT', `/api/appointments/${firstId}`, { status: 'Confirmed' })).status === 200);
  t('Confirmed -> In Progress -> 200',
    (await send('PUT', `/api/appointments/${firstId}`, { status: 'In Progress' })).status === 200);

  // ---- 10. delete guards --------------------------------------------------
  const busy = await send('DELETE', `/api/appointments/${firstId}`);
  t('deleting an In Progress appointment -> 409', busy.status === 409, busy.body);
  t('   ...reason', busy.body?.error?.reason === 'appointment_in_progress', busy.body?.error);

  const linked = await get('/api/appointments?limit=1000');
  const withJob = (linked.body?.data ?? []).find((a) => a.jobCardId);
  t('a fixture appointment is linked to a job card', !!withJob, withJob);
  if (withJob) {
    const r = await send('DELETE', `/api/appointments/${withJob.id}`);
    t('deleting a job-card-linked appointment -> 409', r.status === 409, r.body);
    t('   ...reason', r.body?.error?.reason === 'linked_to_job_card', r.body?.error);
  }
  const jobLink = await send('PUT', `/api/appointments/${firstId}`, { jobCardId: 'JOB-9001' });
  t('setting jobCardId through the API -> 422', jobLink.status === 422, jobLink.body);

  // firstId is In Progress; Cancelled is a legal move from Confirmed but not
  // from In Progress, so the only legal exit is Completed -- which cannot be
  // deleted. Proving that, then leaving it to cleanup.sql's sweep.
  await send('PUT', `/api/appointments/${firstId}`, { status: 'Completed' });
  const doneDel = await send('DELETE', `/api/appointments/${firstId}`);
  t('deleting a Completed appointment -> 409', doneDel.status === 409, doneDel.body);
  t('   ...reason', doneDel.body?.error?.reason === 'appointment_completed', doneDel.body?.error);

  // ---- 11. tear down ------------------------------------------------------
  let removed = 0;
  for (const id of made) {
    if (id === firstId) continue;                 // Completed, protected by design
    const r = await send('DELETE', `/api/appointments/${id}`);
    if (r.status === 200) removed++;
    else t(`deleting ${id} -> 200`, false, { status: r.status, body: r.body });
  }
  t(`removed every appointment this section created but the protected one`,
    removed === made.length - 1, { removed, made: made.length });

  const finalList = await get('/api/appointments?limit=1000');
  t('the six fixtures plus the one protected appointment remain',
    finalList.body?.total === 7, finalList.body?.total);
}

sec('15. Inventory movements: atomic stock + ledger, against real D1');
{
  // A part of its own, created and removed by this section, so the fixtures'
  // stock figures are never disturbed.
  const part = await send('POST', '/api/parts', {
    name: 'C-4 Movement Part', partNo: 'c4-mv-1', category: 'Filters', unit: 'pc',
    purchasePrice: 100, sellingPrice: 150, minStock: 0,
  });
  t('a part for the movement tests', part.status === 201, part.body);
  const P = part.body?.data?.id;
  t('   ...starts at zero stock', part.body?.data?.stock === 0, part.body?.data);

  const move = (body) => send('POST', '/api/inventory-transactions', { partId: P, ...body });
  const stockOf = async (id = P) => (await get(`/api/parts/${id}`)).body?.data?.stock;
  const ledgerFor = async (id = P) => {
    const r = await get('/api/inventory-transactions?limit=1000');
    return (r.body?.data ?? []).filter((x) => x.partId === id);
  };

  // ---- inbound ----
  const inbound = await move({ type: 'purchase', quantity: 10, unitCost: 100, referenceId: 'PO-1' });
  t('an inbound movement -> 201', inbound.status === 201, inbound.body);
  t('   ...allocated a real STK id', /^STK-\d{4}$/.test(inbound.body?.data?.id || ''), inbound.body?.data?.id);
  t('   ...prevStock is the balance before', inbound.body?.data?.prevStock === 0, inbound.body?.data);
  t('   ...newStock is the balance after', inbound.body?.data?.newStock === 10, inbound.body?.data);
  t('   ...referenceType is manual', inbound.body?.data?.referenceType === 'manual', inbound.body?.data);
  t('   ...the manual reference survives', inbound.body?.data?.referenceId === 'PO-1', inbound.body?.data);
  t('   ...and the part now holds 10', (await stockOf()) === 10, await stockOf());
  t('   ...in the same shape the GET route returns',
    JSON.stringify((await get(`/api/inventory-transactions/${inbound.body.data.id}`)).body?.data)
      === JSON.stringify(inbound.body.data));

  // ---- outbound ----
  const outbound = await move({ type: 'sale', quantity: 4 });
  t('an outbound movement -> 201', outbound.status === 201, outbound.body);
  t('   ...snapshots 10 -> 6',
    outbound.body?.data?.prevStock === 10 && outbound.body?.data?.newStock === 6, outbound.body?.data);
  t('   ...and the part now holds 6', (await stockOf()) === 6, await stockOf());

  // ---- every one of the eight types moves the balance the right way ----
  for (const [type, delta] of [
    ['purchase', 1], ['adjustment-in', 1], ['return', 1], ['initial-stock', 1],
    ['sale', -1], ['job-card-use', -1], ['adjustment-out', -1], ['damaged', -1],
  ]) {
    const before = await stockOf();
    const r = await move({ type, quantity: 1 });
    const after = await stockOf();
    t(`${type} -> 201`, r.status === 201, r.body);
    t(`   ...moves stock by ${delta}`, after === before + delta, { before, after });
    t('   ...and its snapshot agrees', r.body?.data?.prevStock === before
      && r.body?.data?.newStock === after, r.body?.data);
  }

  // ---- negative stock protection ----
  const current = await stockOf();
  const tooMuch = await move({ type: 'sale', quantity: current + 1 });
  t('an outbound movement larger than stock -> 409', tooMuch.status === 409, tooMuch.body);
  t('   ...machine-readable reason', tooMuch.body?.error?.reason === 'insufficient_stock', tooMuch.body?.error);
  t('   ...reports what is available', tooMuch.body?.error?.available === current, tooMuch.body?.error);
  t('   ...and what was required', tooMuch.body?.error?.required === current + 1, tooMuch.body?.error);
  t('   ...stock is unchanged', (await stockOf()) === current, await stockOf());
  const afterRefusal = await ledgerFor();
  t('   ...and NO ledger row was written', afterRefusal.every((x) => x.quantity !== current + 1),
    afterRefusal.map((x) => [x.id, x.quantity]));

  // Taking exactly the whole balance is allowed; one more is not.
  const exact = await move({ type: 'sale', quantity: current });
  t('taking exactly the whole balance -> 201', exact.status === 201, exact.body);
  t('   ...leaving zero', (await stockOf()) === 0, await stockOf());
  const fromZero = await move({ type: 'sale', quantity: 1 });
  t('any outbound movement from zero -> 409', fromZero.status === 409, fromZero.body);
  t('   ...stock never goes negative', (await stockOf()) === 0, await stockOf());

  // ---- an unknown part ----
  const ghost = await send('POST', '/api/inventory-transactions',
    { partId: 'PRT-7777', type: 'purchase', quantity: 1 });
  t('a movement against an unknown part -> 409', ghost.status === 409, ghost.body);
  t('   ...reason', ghost.body?.error?.reason === 'part_not_found', ghost.body?.error);

  // ---- server-owned fields ----
  for (const [key, value] of [['prevStock', 99], ['newStock', 99], ['id', 'STK-9999'], ['jobCardId', 'JOB-9001']]) {
    const r = await move({ type: 'purchase', quantity: 1, [key]: value });
    t(`\`${key}\` in the body -> 422`, r.status === 422, r.body);
  }
  const jobRef = await move({ type: 'job-card-use', quantity: 1, referenceType: 'job-card', referenceId: 'JOB-9001' });
  t('referenceType job-card -> 422 (C-5 writes those)', jobRef.status === 422, jobRef.body);

  // ---- unit cost keeps null apart from zero, through the real column ----
  await move({ type: 'purchase', quantity: 5 });
  const free = await move({ type: 'purchase', quantity: 1, unitCost: 0 });
  t('a zero unit cost is stored as 0', free.body?.data?.unitCost === 0, free.body?.data);
  const noCost = await move({ type: 'purchase', quantity: 1 });
  t('an absent unit cost is stored as null', noCost.body?.data?.unitCost === null, noCost.body?.data);

  /* ---- CONCURRENCY: the reason none of this reads stock first ---- */

  // Reset to a known balance.
  const toZero = await stockOf();
  if (toZero > 0) await move({ type: 'adjustment-out', quantity: toZero, reason: 'Recount' });
  await move({ type: 'adjustment-in', quantity: 10, reason: 'Recount' });
  t('the race starts from exactly 10', (await stockOf()) === 10, await stockOf());

  // A. 10 in stock, OUT 8 and OUT 7 at once: exactly one may win.
  {
    const [a, b] = await Promise.all([
      move({ type: 'sale', quantity: 8 }),
      move({ type: 'sale', quantity: 7 }),
    ]);
    const codes = [a.status, b.status].sort();
    t('OUT 8 + OUT 7 on 10: exactly one succeeds',
      JSON.stringify(codes) === JSON.stringify([201, 409]), { a: a.status, b: b.status });
    const left = await stockOf();
    t('   ...the balance is 2 or 3, never negative and never 10',
      left === 2 || left === 3, left);
    const loser = a.status === 409 ? a : b;
    t('   ...the loser says insufficient_stock',
      loser.body?.error?.reason === 'insufficient_stock', loser.body?.error);
    const rows = await ledgerFor();
    const eight = rows.filter((x) => x.quantity === 8 && x.type === 'sale');
    const seven = rows.filter((x) => x.quantity === 7 && x.type === 'sale');
    t('   ...exactly one of the two wrote a ledger row',
      eight.length + seven.length === 1, { eight: eight.length, seven: seven.length });
  }

  // B. Two outbound movements that exactly consume the balance: both win.
  {
    const now = await stockOf();
    if (now < 10) await move({ type: 'adjustment-in', quantity: 10 - now, reason: 'Recount' });
    t('reset to 10 for the second race', (await stockOf()) === 10, await stockOf());
    const [a, b] = await Promise.all([
      move({ type: 'sale', quantity: 5 }),
      move({ type: 'sale', quantity: 5 }),
    ]);
    t('OUT 5 + OUT 5 on 10: both succeed', a.status === 201 && b.status === 201,
      { a: a.status, b: b.status });
    t('   ...and the balance lands on exactly 0', (await stockOf()) === 0, await stockOf());
    t('   ...their snapshots chain, 10->5 and 5->0',
      JSON.stringify([a.body.data.prevStock, a.body.data.newStock,
        b.body.data.prevStock, b.body.data.newStock].sort((x, y) => x - y))
        === JSON.stringify([0, 5, 5, 10]),
      [a.body.data, b.body.data].map((d) => [d.prevStock, d.newStock]));
  }

  // C. Concurrent inbound: no lost update.
  {
    await move({ type: 'adjustment-in', quantity: 10, reason: 'Recount' });
    t('reset to 10 for the inbound race', (await stockOf()) === 10, await stockOf());
    const [a, b] = await Promise.all([
      move({ type: 'purchase', quantity: 5 }),
      move({ type: 'purchase', quantity: 7 }),
    ]);
    t('IN 5 + IN 7 on 10: both succeed', a.status === 201 && b.status === 201,
      { a: a.status, b: b.status });
    t('   ...and the balance is 22, not 15 or 17', (await stockOf()) === 22, await stockOf());
    t('   ...neither snapshot claims the same starting balance',
      a.body.data.prevStock !== b.body.data.prevStock,
      [a.body.data.prevStock, b.body.data.prevStock]);
  }

  // D. A larger burst, to show the invariant holds under real contention.
  {
    const before = await stockOf();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => move({ type: i % 2 ? 'purchase' : 'sale', quantity: 2 }))
    );
    const won = results.filter((r) => r.status === 201).length;
    const lost = results.filter((r) => r.status === 409).length;
    t('12 concurrent movements all resolve as 201 or 409', won + lost === 12, { won, lost });
    t('   ...and none returned a 5xx', results.every((r) => r.status < 500), results.map((r) => r.status));
    const after = await stockOf();
    t('   ...the balance never went negative', after >= 0, after);

    // The ledger must still reconcile: every snapshot is internally consistent,
    // and the chain of committed movements adds up to the live balance.
    const rows = (await ledgerFor()).sort((x, y) => x.id.localeCompare(y.id));
    const consistent = rows.every((r) => {
      const delta = ['purchase', 'adjustment-in', 'return', 'initial-stock'].includes(r.type)
        ? r.quantity : -r.quantity;
      return Math.abs((r.prevStock + delta) - r.newStock) < 1e-9;
    });
    t('   ...every ledger row is internally consistent (prev + delta === new)', consistent,
      rows.filter((r) => {
        const d = ['purchase', 'adjustment-in', 'return', 'initial-stock'].includes(r.type)
          ? r.quantity : -r.quantity;
        return Math.abs((r.prevStock + d) - r.newStock) >= 1e-9;
      }));
    const chained = rows.every((r, i) => i === 0 || r.prevStock === rows[i - 1].newStock);
    t('   ...and the rows chain end to end with no lost update', chained,
      rows.map((r) => [r.id, r.prevStock, r.newStock]));
    t('   ...the last snapshot equals the live balance',
      rows[rows.length - 1].newStock === after, { last: rows[rows.length - 1], after });
  }

  // ---- tear down: the ledger is append-only, so the rows go with the part ----
  const blocked = await send('DELETE', `/api/parts/${P}`);
  t('the part cannot be deleted while it has movements', blocked.status === 409, blocked.body);
  t('   ...reason', blocked.body?.error?.reason === 'part_in_use', blocked.body?.error);
  // Clearing the balance is not enough: the movements themselves still block it.
  const bal = await stockOf();
  if (bal > 0) await move({ type: 'adjustment-out', quantity: bal, reason: 'Recount' });
  const stillBlocked = await send('DELETE', `/api/parts/${P}`);
  t('   ...and still cannot once the balance is zero', stillBlocked.status === 409, stillBlocked.body);
  t('   ...because the movements remain', (await ledgerFor()).length > 0);
  // cleanup.sql's sweep removes both, in foreign-key order.
}

sec('16. Job card writes: parent, lines, inventory and the appointment link, against real D1');
{
  // This section's own customer, vehicle, mechanic, service and parts, so the
  // fixtures' figures are never disturbed. cleanup.sql's sweep removes them.
  const cust = await send('POST', '/api/customers', { name: 'C-5 Job Card Customer', phone: '01955-000001' });
  const C = cust.body?.data?.id;
  const veh = await send('POST', '/api/vehicles',
    { customerId: C, regNo: 'DHA-C5-01', brand: 'Toyota', model: 'Probe' });
  const V = veh.body?.data?.id;
  const other = await send('POST', '/api/customers', { name: 'C-5 Other Customer', phone: '01955-000002' });
  const C2 = other.body?.data?.id;
  const otherVeh = await send('POST', '/api/vehicles',
    { customerId: C2, regNo: 'DHA-C5-02', brand: 'Honda', model: 'Probe' });
  const V2 = otherVeh.body?.data?.id;
  const mech = await send('POST', '/api/mechanics',
    { name: 'C-5 Mechanic', phone: '01955-000003', specialization: 'Engine' });
  const M = mech.body?.data?.id;
  const svc = await send('POST', '/api/services',
    { name: 'C-5 Full Service', category: 'Engine', price: 1500 });
  const S = svc.body?.data?.id;
  t('the section has its own customer, vehicle, mechanic and service',
    [C, V, C2, V2, M, S].every(Boolean), { C, V, C2, V2, M, S });

  const newPart = async (name, partNo, stock) => {
    const p = await send('POST', '/api/parts',
      { name, partNo, category: 'Filters', unit: 'pc',
        purchasePrice: 100, sellingPrice: 200, minStock: 0 });
    const id = p.body?.data?.id;
    t(`a part for ${name} -> 201`, p.status === 201, p.body);
    if (stock > 0) {
      await send('POST', '/api/inventory-transactions',
        { partId: id, type: 'initial-stock', quantity: stock });
    }
    return id;
  };
  const stockOf = async (id) => (await get(`/api/parts/${id}`)).body?.data?.stock;
  // The ledger route returns newest first; these assertions read a job card's
  // movements as a story, so they are turned back into chronological order.
  const ledgerFor = async (jobId, partId) => {
    const r = await get('/api/inventory-transactions?limit=1000');
    return (r.body?.data ?? [])
      .filter((x) => x.referenceType === 'job-card' && x.referenceId === jobId
        && (partId === undefined || x.partId === partId))
      .sort((x, y) => (x.createdAt || '').localeCompare(y.createdAt || '') || x.id.localeCompare(y.id));
  };
  const issuedFor = async (jobId, partId) => (await ledgerFor(jobId, partId)).reduce(
    (s, x) => s + (x.type === 'job-card-use' ? x.quantity : x.type === 'return' ? -x.quantity : 0), 0);

  const JOB = {
    customerId: C, vehicleId: V, mechanicId: M,
    date: '2026-09-18', complaint: 'C-5: engine noise under load',
    services: [{ serviceId: S, name: 'C-5 Full Service (as sold)', qty: 1, unitPrice: 1500 }],
  };

  /* ---- 16a. create ---- */
  const created = await send('POST', '/api/job-cards', JOB);
  t('POST /api/job-cards -> 201', created.status === 201, created.body);
  const J = created.body?.data?.id;
  t('   ...allocated a real JOB id', /^JOB-\d{4}$/.test(J || ''), J);
  t('   ...status is Received', created.body?.data?.status === 'Received', created.body?.data?.status);
  t('   ...priority defaults to normal', created.body?.data?.priority === 'normal');
  t('   ...createdAt set, updatedAt absent',
    !!created.body?.data?.createdAt && !('updatedAt' in (created.body?.data ?? {})), created.body?.data);
  t('   ...invoiceId starts null', created.body?.data?.invoiceId === null);
  t('   ...appointmentId starts null', created.body?.data?.appointmentId === null);
  t('   ...totals computed from the lines',
    created.body?.data?.subtotal === 1500 && created.body?.data?.total === 1500
      && created.body?.data?.due === 1500 && created.body?.data?.paid === 0, created.body?.data);
  t('   ...one service line, no part lines',
    created.body?.data?.services?.length === 1 && created.body?.data?.partsUsed?.length === 0,
    created.body?.data);
  t('   ...the line is named partsUsed, never parts',
    'partsUsed' in created.body.data && !('parts' in created.body.data));

  const readBack = await get(`/api/job-cards/${J}`);
  t('   ...and a GET returns exactly what the POST reported',
    JSON.stringify(readBack.body?.data) === JSON.stringify(created.body?.data),
    { post: created.body?.data, get: readBack.body?.data });
  t('   ...the line snapshot is the name that was sold, not the catalogue\'s',
    readBack.body?.data?.services[0]?.name === 'C-5 Full Service (as sold)',
    readBack.body?.data?.services[0]);

  /* ---- 16b. a create writes no stock, even with an inventory part line ---- */
  const stockPart = await newPart('C-5 Stocked Part', 'c5-p-1', 20);
  const withPart = await send('POST', '/api/job-cards', {
    ...JOB, complaint: 'C-5: create with an inventory part',
    partsUsed: [{ partId: stockPart, name: 'C-5 Stocked Part', partNo: 'c5-p-1', qty: 5, unitPrice: 200 }],
  });
  t('a create carrying an inventory part -> 201', withPart.status === 201, withPart.body);
  t('   ...stores the part line', withPart.body?.data?.partsUsed?.length === 1, withPart.body?.data);
  t('   ...but moves NO stock, because a new job card is Received',
    (await stockOf(stockPart)) === 20, await stockOf(stockPart));
  t('   ...and writes no ledger row for it',
    (await ledgerFor(withPart.body?.data?.id)).length === 0);
  const delWithPart = await send('DELETE', `/api/job-cards/${withPart.body?.data?.id}`);
  t('   ...and it can be deleted again while Received', delWithPart.status === 200, delWithPart.body);

  /* ---- 16c. create validation ---- */
  for (const [why, body] of [
    ['a missing customer', { ...JOB, customerId: undefined }],
    ['a missing vehicle', { ...JOB, vehicleId: undefined }],
    ['a missing mechanic', { ...JOB, mechanicId: undefined }],
    ['a missing date', { ...JOB, date: undefined }],
    ['a blank complaint', { ...JOB, complaint: '   ' }],
    ['nothing recorded at all', { ...JOB, services: [] }],
    ['a discount above the subtotal', { ...JOB, discount: 99999 }],
    ['paid above the total', { ...JOB, paid: 99999 }],
    ['mileage out below mileage in', { ...JOB, mileage: 100, mileageOut: 50 }],
    ['an estimated delivery before the job date', { ...JOB, estDelivery: '2026-09-17' }],
    ['a server-computed total', { ...JOB, total: 1 }],
    ['a status other than Received', { ...JOB, status: 'In Progress' }],
  ]) {
    const r = await send('POST', '/api/job-cards', body);
    t(`${why} -> 422`, r.status === 422, { status: r.status, body: r.body });
  }
  {
    const r = await send('POST', '/api/job-cards', { ...JOB, vehicleId: V2 });
    t('a vehicle belonging to another customer -> 422', r.status === 422, r.body);
    t('   ...naming the vehicle field',
      r.body?.error?.fields?.vehicleId === 'Selected vehicle does not belong to this customer.', r.body?.error);
  }
  for (const [why, body] of [
    // The customer and vehicle move together: an unknown customer with a REAL
    // vehicle is caught by the ownership rule first, which is a 422 about the
    // vehicle. Both unknown leaves the foreign keys to answer, which is the
    // division C-3 established -- no per-reference preflight SELECT.
    ['an unknown customer and vehicle', { ...JOB, customerId: 'CUS-7777', vehicleId: 'VEH-7777' }],
    ['an unknown mechanic', { ...JOB, mechanicId: 'MEC-7777' }],
    ['an unknown service on a line', { ...JOB, services: [{ serviceId: 'SRV-7777', name: 'Ghost', qty: 1, unitPrice: 10 }] }],
    ['an unknown part on a line', { ...JOB, partsUsed: [{ partId: 'PRT-7777', name: 'Ghost', qty: 1, unitPrice: 10 }] }],
  ]) {
    const before = (await get('/api/job-cards?limit=1000')).body?.total;
    const r = await send('POST', '/api/job-cards', body);
    t(`${why} -> 409 from the schema's own foreign key`, r.status === 409, { status: r.status, body: r.body });
    t('   ...with no SQL leaked', !JSON.stringify(r.body).includes('SQLITE'), r.body);
    t('   ...and no job card was left behind',
      (await get('/api/job-cards?limit=1000')).body?.total === before,
      (await get('/api/job-cards?limit=1000')).body?.total);
  }
  {
    const r = await send('POST', '/api/job-cards', 'not json');
    t('a malformed body -> 400', r.status === 400, r.status);
  }

  /* ---- 16d. the appointment link ---- */
  {
    const appt = await send('POST', '/api/appointments', {
      customerId: C, vehicleId: V, serviceId: S, date: '2099-06-01', time: '09:00',
      duration: 60, source: 'Phone',
    });
    t('an appointment for the link tests -> 201', appt.status === 201, appt.body);
    const A = appt.body?.data?.id;

    const mismatch = await send('POST', '/api/job-cards', { ...JOB, customerId: C2, vehicleId: V2, appointmentId: A });
    t('an appointment for a different customer -> 422', mismatch.status === 422, mismatch.body);

    const linked = await send('POST', '/api/job-cards', { ...JOB, appointmentId: A, complaint: 'C-5: from an appointment' });
    t('a job card created from a free, matching appointment -> 201', linked.status === 201, linked.body);
    const LJ = linked.body?.data?.id;
    t('   ...carries the appointment id', linked.body?.data?.appointmentId === A, linked.body?.data);
    const back = await get(`/api/appointments/${A}`);
    t('   ...and the appointment now points back at it', back.body?.data?.jobCardId === LJ, back.body?.data);
    t('   ...its status is UNCHANGED — work has not started',
      back.body?.data?.status === 'Scheduled', back.body?.data?.status);
    t('   ...and its source is untouched', back.body?.data?.source === 'Phone', back.body?.data?.source);
    t('   ...its updated_at was refreshed, as Storage.updateData does',
      !!back.body?.data?.updatedAt, back.body?.data);

    const second = await send('POST', '/api/job-cards', { ...JOB, appointmentId: A });
    t('a second job card for the same appointment -> 409', second.status === 409, second.body);
    t('   ...reason', second.body?.error?.reason === 'appointment_already_claimed', second.body?.error);
    t('   ...naming the job card that has it', second.body?.error?.conflictsWith === LJ, second.body?.error);

    const moveIt = await send('PUT', `/api/job-cards/${LJ}`, { appointmentId: null });
    t('an edit cannot unlink the appointment -> 409', moveIt.status === 409, moveIt.body);
    t('   ...reason', moveIt.body?.error?.reason === 'appointment_link_immutable', moveIt.body?.error);

    const apptDel = await send('DELETE', `/api/appointments/${A}`);
    t('the appointment cannot be deleted while a job card holds it -> 409',
      apptDel.status === 409, apptDel.body);

    const gone = await send('DELETE', `/api/job-cards/${LJ}`);
    t('deleting the job card -> 200', gone.status === 200, gone.body);
    const after = await get(`/api/appointments/${A}`);
    t('   ...unlinks the appointment', after.body?.data?.jobCardId === null, after.body?.data);
    t('   ...and leaves everything else about it alone',
      after.body?.data?.status === 'Scheduled' && after.body?.data?.source === 'Phone', after.body?.data);
    await send('DELETE', `/api/appointments/${A}`);
  }

  /* ---- 16e. update: merge, lines and snapshots ---- */
  {
    const before = (await get(`/api/job-cards/${J}`)).body?.data;
    const patched = await send('PUT', `/api/job-cards/${J}`, { notes: 'C-5 merged note' });
    t('PUT merges -> 200', patched.status === 200, patched.body);
    t('   ...the supplied field changed', patched.body?.data?.notes === 'C-5 merged note');
    t('   ...the untouched fields survive',
      patched.body?.data?.complaint === before.complaint && patched.body?.data?.date === before.date,
      patched.body?.data);
    t('   ...the untouched lines survive',
      JSON.stringify(patched.body?.data?.services) === JSON.stringify(before.services),
      patched.body?.data?.services);
    t('   ...createdAt unchanged', patched.body?.data?.createdAt === before.createdAt);
    t('   ...updatedAt now set', !!patched.body?.data?.updatedAt, patched.body?.data);
    t('   ...status untouched', patched.body?.data?.status === 'Received');

    const cleared = await send('PUT', `/api/job-cards/${J}`, { mileage: 3000 });
    t('setting a nullable number -> 200', cleared.status === 200 && cleared.body?.data?.mileage === 3000,
      cleared.body?.data);
    const nulled = await send('PUT', `/api/job-cards/${J}`, { mileage: null });
    t('   ...and an explicit null clears it to null, not 0',
      nulled.body?.data?.mileage === null, nulled.body?.data);

    const money = await send('PUT', `/api/job-cards/${J}`, { discount: 100, taxRate: 10, paid: 200 });
    t('totals are recomputed from the STORED lines', money.body?.data?.subtotal === 1500, money.body?.data);
    t('   ...tax = round((1500 - 100) x 10 / 100)', money.body?.data?.tax === 140, money.body?.data);
    t('   ...total = 1500 - 100 + 140', money.body?.data?.total === 1540, money.body?.data);
    t('   ...paid is stored as sent', money.body?.data?.paid === 200, money.body?.data);
    t('   ...due = total - paid', money.body?.data?.due === 1340, money.body?.data);
    await send('PUT', `/api/job-cards/${J}`, { discount: 0, taxRate: 0, paid: 0 });

    const relined = await send('PUT', `/api/job-cards/${J}`, {
      services: [
        { serviceId: S, name: 'C-5 Full Service (as sold)', qty: 2, unitPrice: 1500 },
        { serviceId: S, name: 'Second helping', qty: 1, unitPrice: 500 },
      ],
      partsUsed: [{ name: 'Hand-cut bracket', partNo: 'MANUAL-1', qty: 2, unitPrice: 150 }],
    });
    t('supplying a line array replaces that set', relined.body?.data?.services?.length === 2, relined.body?.data);
    t('   ...in the order supplied',
      relined.body?.data?.services?.map((l) => l.name).join('|') === 'C-5 Full Service (as sold)|Second helping',
      relined.body?.data?.services);
    t('   ...a manual part line keeps a null partId',
      relined.body?.data?.partsUsed[0]?.partId === null, relined.body?.data?.partsUsed);
    t('   ...and the totals follow the new lines',
      relined.body?.data?.subtotal === 3800, relined.body?.data);

    const emptied = await send('PUT', `/api/job-cards/${J}`, { partsUsed: [] });
    t('an empty array really clears that line table',
      emptied.body?.data?.partsUsed?.length === 0, emptied.body?.data);
    t('   ...and leaves the other line table alone',
      emptied.body?.data?.services?.length === 2, emptied.body?.data);

    const ghost = await send('PUT', '/api/job-cards/JOB-7777', { notes: 'x' });
    t('PUT on an unknown id -> 404', ghost.status === 404, ghost.status);
    const empty = await send('PUT', `/api/job-cards/${J}`, {});
    t('PUT with no fields -> 422', empty.status === 422, empty.body);
    const owned = await send('PUT', `/api/job-cards/${J}`, { due: 0 });
    t('PUT of a computed field -> 422', owned.status === 422, owned.body);
    const moved = await send('PUT', `/api/job-cards/${J}`, { status: 'In Progress' });
    t('PUT of a status change -> 409, C-6 owns transitions', moved.status === 409, moved.body);
    t('   ...reason', moved.body?.error?.reason === 'status_change_not_supported', moved.body?.error);
    const same = await send('PUT', `/api/job-cards/${J}`, { status: 'Received', notes: 'still fine' });
    t('   ...but echoing the stored status back is accepted', same.status === 200, same.body);
  }

  /* ---- 16f. delete guards, against the fixtures' real states ---- */
  {
    const invoiced = await send('DELETE', '/api/job-cards/JOB-9001');
    t('deleting an invoiced job card -> 409', invoiced.status === 409, invoiced.body);
    t('   ...reason', invoiced.body?.error?.reason === 'job_card_invoiced', invoiced.body?.error);
    t('   ...naming the invoice', invoiced.body?.error?.invoiceId === 'INV-9001', invoiced.body?.error);
    const started = await send('DELETE', '/api/job-cards/JOB-9003');
    t('deleting an In Progress job card -> 409', started.status === 409, started.body);
    t('   ...reason', started.body?.error?.reason === 'work_started', started.body?.error);
    t('   ...and it is still there', (await get('/api/job-cards/JOB-9003')).status === 200);
    const unknown = await send('DELETE', '/api/job-cards/JOB-7777');
    t('deleting an unknown job card -> 404', unknown.status === 404, unknown.status);
    const badId = await send('DELETE', '/api/job-cards/nope');
    t('a malformed id -> 400', badId.status === 400, badId.status);

    const gone = await send('DELETE', `/api/job-cards/${J}`);
    t('deleting a Received job card -> 200', gone.status === 200, gone.body);
    t('   ...reporting what went', JSON.stringify(gone.body?.data) === JSON.stringify({ id: J, deleted: true }),
      gone.body?.data);
    t('   ...and it is really gone', (await get(`/api/job-cards/${J}`)).status === 404);
    const lines = await get('/api/job-cards?limit=1000');
    t('   ...with its child lines cascaded away',
      !(lines.body?.data ?? []).some((x) => x.id === J), lines.body?.data?.map((x) => x.id));
  }

  /* ---- 16g. inventory reconciliation, on a job card that is already issuing ---- */
  // JOB-9003 is the In Progress fixture. Reconciliation only happens for a job
  // that has already started issuing stock, and this phase deliberately does
  // not change status, so a job card created above could never reach this path.
  {
    const A = await newPart('C-5 Reconcile Part A', 'c5-r-a', 20);
    const B = await newPart('C-5 Reconcile Part B', 'c5-r-b', 20);
    const R = 'JOB-9003';
    const setParts = (partsUsed, extra = {}) => send('PUT', `/api/job-cards/${R}`, { partsUsed, ...extra });
    const line = (id, name, qty) => ({ partId: id, name, partNo: 'x', qty, unitPrice: 100 });

    const first = await setParts([line(A, 'C-5 Reconcile Part A', 5)]);
    t('a first inventory line deducts it -> 200', first.status === 200, first.body);
    t('   ...stock 20 -> 15', (await stockOf(A)) === 15, await stockOf(A));
    t('   ...one ledger row, of 5', (await ledgerFor(R, A)).length === 1
      && (await ledgerFor(R, A))[0].quantity === 5, await ledgerFor(R, A));
    t('   ...recorded as job-card-use against this job card',
      (await ledgerFor(R, A))[0].type === 'job-card-use'
      && (await ledgerFor(R, A))[0].referenceType === 'job-card', (await ledgerFor(R, A))[0]);
    t('   ...with the engine\'s own note',
      (await ledgerFor(R, A))[0].notes === `Adjusted on ${R} (qty change)`, (await ledgerFor(R, A))[0]);
    t('   ...snapshotting 20 -> 15',
      (await ledgerFor(R, A))[0].prevStock === 20 && (await ledgerFor(R, A))[0].newStock === 15,
      (await ledgerFor(R, A))[0]);

    const more = await setParts([line(A, 'C-5 Reconcile Part A', 8)]);
    t('raising the quantity deducts only the difference -> 200', more.status === 200, more.body);
    t('   ...stock 15 -> 12', (await stockOf(A)) === 12, await stockOf(A));
    t('   ...the extra movement is 3', (await ledgerFor(R, A))[1]?.quantity === 3, await ledgerFor(R, A));
    t('   ...and 8 are now issued', (await issuedFor(R, A)) === 8, await issuedFor(R, A));

    const again = await setParts([line(A, 'C-5 Reconcile Part A', 8)]);
    t('submitting the SAME lines again -> 200', again.status === 200, again.body);
    t('   ...deducts nothing — this is the idempotency rule',
      (await stockOf(A)) === 12, await stockOf(A));
    t('   ...and writes no ledger row', (await ledgerFor(R, A)).length === 2, await ledgerFor(R, A));

    const fewer = await setParts([line(A, 'C-5 Reconcile Part A', 3)]);
    t('lowering the quantity returns the difference -> 200', fewer.status === 200, fewer.body);
    t('   ...stock 12 -> 17', (await stockOf(A)) === 17, await stockOf(A));
    t('   ...as a return of 5',
      (await ledgerFor(R, A))[2]?.type === 'return' && (await ledgerFor(R, A))[2]?.quantity === 5,
      await ledgerFor(R, A));
    t('   ...leaving 3 issued', (await issuedFor(R, A)) === 3, await issuedFor(R, A));

    const both = await setParts([line(A, 'C-5 Reconcile Part A', 3), line(B, 'C-5 Reconcile Part B', 4)]);
    t('adding a second part deducts only that one -> 200', both.status === 200, both.body);
    t('   ...part A is untouched at 17', (await stockOf(A)) === 17, await stockOf(A));
    t('   ...part B is 20 -> 16', (await stockOf(B)) === 16, await stockOf(B));

    const swapped = await setParts([line(B, 'C-5 Reconcile Part B', 4)]);
    t('removing a part returns everything it was issued -> 200', swapped.status === 200, swapped.body);
    t('   ...part A is back to 20', (await stockOf(A)) === 20, await stockOf(A));
    t('   ...with nothing issued', (await issuedFor(R, A)) === 0, await issuedFor(R, A));
    t('   ...and part B is unchanged at 16', (await stockOf(B)) === 16, await stockOf(B));

    const summed = await setParts([
      line(B, 'C-5 Reconcile Part B', 2), line(B, 'C-5 Reconcile Part B', 3),
    ]);
    t('two lines for the same part are one requirement -> 200', summed.status === 200, summed.body);
    t('   ...2 + 3 against 4 issued deducts 1', (await stockOf(B)) === 15, await stockOf(B));
    t('   ...and 5 are issued', (await issuedFor(R, B)) === 5, await issuedFor(R, B));

    const manual = await setParts([
      line(B, 'C-5 Reconcile Part B', 5),
      { name: 'Hand-cut bracket', partNo: 'MANUAL-9', qty: 9, unitPrice: 20 },
    ]);
    t('a manual line never enters the calculation -> 200', manual.status === 200, manual.body);
    t('   ...so stock is unchanged at 15', (await stockOf(B)) === 15, await stockOf(B));
    t('   ...and it is stored with a null partId',
      manual.body?.data?.partsUsed?.some((l) => l.partId === null && l.qty === 9),
      manual.body?.data?.partsUsed);

    /* ---- shortage: nothing moves, and the edit itself is refused ---- */
    const jcBefore = (await get(`/api/job-cards/${R}`)).body?.data;
    const short = await setParts([line(B, 'C-5 Reconcile Part B', 999)], { notes: 'must not be saved' });
    t('a shortage -> 409', short.status === 409, short.body);
    t('   ...reason', short.body?.error?.reason === 'insufficient_stock', short.body?.error);
    t('   ...naming the part, what is there and what more is needed',
      short.body?.error?.shortages?.[0]?.name === 'C-5 Reconcile Part B'
      && short.body?.error?.shortages?.[0]?.available === 15
      && short.body?.error?.shortages?.[0]?.required === 994, short.body?.error);
    t('   ...stock is untouched', (await stockOf(B)) === 15, await stockOf(B));
    const jcAfterShort = (await get(`/api/job-cards/${R}`)).body?.data;
    t('   ...and the job card itself was NOT saved',
      JSON.stringify(jcAfterShort) === JSON.stringify(jcBefore), { before: jcBefore, after: jcAfterShort });

    /* ---- multiple parts: one short fails all of them ---- */
    const aBefore = await stockOf(A);
    const bBefore = await stockOf(B);
    const multi = await setParts([
      line(A, 'C-5 Reconcile Part A', 6),
      line(B, 'C-5 Reconcile Part B', 999),
    ]);
    t('one short part fails the whole edit -> 409', multi.status === 409, multi.body);
    t('   ...the part that WAS available did not move',
      (await stockOf(A)) === aBefore, { before: aBefore, after: await stockOf(A) });
    t('   ...nor did the short one', (await stockOf(B)) === bBefore, await stockOf(B));
    t('   ...and no ledger row was written for either',
      (await issuedFor(R, A)) === 0 && (await issuedFor(R, B)) === 5,
      { a: await issuedFor(R, A), b: await issuedFor(R, B) });

    /* ---- a child line that fails takes the whole batch with it ---- */
    const rollbackBefore = (await get(`/api/job-cards/${R}`)).body?.data;
    const rollback = await send('PUT', `/api/job-cards/${R}`, {
      notes: 'must not be saved either',
      services: [{ serviceId: 'SRV-7777', name: 'Ghost service', qty: 1, unitPrice: 100 }],
      partsUsed: [line(B, 'C-5 Reconcile Part B', 7)],
    });
    t('a job card whose service line breaks a foreign key -> 409', rollback.status === 409, rollback.body);
    const rollbackAfter = (await get(`/api/job-cards/${R}`)).body?.data;
    t('   ...the parent row rolled back',
      JSON.stringify(rollbackAfter) === JSON.stringify(rollbackBefore),
      { before: rollbackBefore, after: rollbackAfter });
    t('   ...and the stock change it carried rolled back with it',
      (await stockOf(B)) === bBefore && (await issuedFor(R, B)) === 5,
      { stock: await stockOf(B), issued: await issuedFor(R, B) });

    /* ---- reconciliation does not touch a job card that has not started ---- */
    const notStarted = await send('POST', '/api/job-cards', {
      ...JOB, complaint: 'C-5: Received, with parts on it',
      partsUsed: [line(B, 'C-5 Reconcile Part B', 5)],
    });
    const NS = notStarted.body?.data?.id;
    const nsStock = await stockOf(B);
    const nsEdit = await send('PUT', `/api/job-cards/${NS}`, {
      partsUsed: [line(B, 'C-5 Reconcile Part B', 12)],
    });
    t('editing the parts of a Received job card -> 200', nsEdit.status === 200, nsEdit.body);
    t('   ...changes the lines', nsEdit.body?.data?.partsUsed[0]?.qty === 12, nsEdit.body?.data);
    t('   ...and moves no stock at all', (await stockOf(B)) === nsStock, await stockOf(B));
    t('   ...and issues nothing', (await issuedFor(NS, B)) === 0, await issuedFor(NS, B));
    await send('DELETE', `/api/job-cards/${NS}`);

    /* ---- Completed / Delivered / Cancelled are read-only ---- */
    for (const [id, status] of [['JOB-9001', 'Delivered'], ['JOB-9004', 'Cancelled']]) {
      const locked = await send('PUT', `/api/job-cards/${id}`, { notes: 'nope' });
      t(`editing a ${status} job card -> 409`, locked.status === 409, locked.body);
      t('   ...reason', locked.body?.error?.reason === 'job_card_read_only', locked.body?.error);
    }

    /* ---- 16h. concurrency ---- */
    // A. the SAME job card, submitted twice at once. Whether the second
    //    request plans before or after the first commits, the outcome must be
    //    the same: five units leave stock, once.
    {
      const startStock = await stockOf(A);
      const startIssued = await issuedFor(R, A);
      const bodyFor = (note) => ({
        notes: note,
        partsUsed: [line(B, 'C-5 Reconcile Part B', 5), line(A, 'C-5 Reconcile Part A', 5)],
      });
      const [r1, r2] = await Promise.all([
        send('PUT', `/api/job-cards/${R}`, bodyFor('C-5 concurrent one')),
        send('PUT', `/api/job-cards/${R}`, bodyFor('C-5 concurrent two')),
      ]);
      const codes = [r1.status, r2.status].sort();
      t('two concurrent identical edits: at least one succeeds',
        codes.includes(200), { r1: r1.status, r2: r2.status });
      t('   ...and neither is a 5xx', !codes.some((c) => c >= 500), codes);
      t('   ...every refusal is a 409 the caller can act on',
        [r1, r2].filter((r) => r.status !== 200)
          .every((r) => r.status === 409
            && ['concurrent_modification', 'insufficient_stock'].includes(r.body?.error?.reason)),
        [r1.body?.error, r2.body?.error]);
      t('   ...stock moved by exactly 5, never 10',
        (await stockOf(A)) === startStock - 5, { start: startStock, now: await stockOf(A) });
      t('   ...and exactly 5 are issued, never 10',
        (await issuedFor(R, A)) === startIssued + 5,
        { start: startIssued, now: await issuedFor(R, A) });
      const loser = [r1, r2].find((r) => r.status === 409);
      if (loser) {
        const stored = (await get(`/api/job-cards/${R}`)).body?.data;
        t('   ...and the refused edit left nothing of itself behind',
          stored.notes !== (loser === r1 ? 'C-5 concurrent one' : 'C-5 concurrent two'),
          { notes: stored.notes });
      } else {
        t('   ...both were serialised, so the second simply found nothing to do', true);
      }
    }

    // B. TWO job cards competing for the same limited part. JOB-9005 is the
    //    second In Progress fixture; it exists for exactly this.
    {
      const L = await newPart('C-5 Limited Part', 'c5-lim', 10);
      const R2 = 'JOB-9005';
      const [r1, r2] = await Promise.all([
        send('PUT', `/api/job-cards/${R}`, { partsUsed: [line(L, 'C-5 Limited Part', 8)] }),
        send('PUT', `/api/job-cards/${R2}`, { partsUsed: [line(L, 'C-5 Limited Part', 7)] }),
      ]);
      const left = await stockOf(L);
      t('two job cards, 8 + 7 against a stock of 10: one succeeds',
        [r1.status, r2.status].filter((c) => c === 200).length === 1,
        { r1: r1.status, r2: r2.status });
      t('   ...and one is refused', [r1.status, r2.status].filter((c) => c === 409).length === 1,
        { r1: r1.status, r2: r2.status });
      t('   ...the refusal is a stock conflict',
        [r1, r2].find((r) => r.status === 409)?.body?.error?.reason === 'insufficient_stock',
        [r1.body?.error, r2.body?.error]);
      t('   ...stock is 2 or 3, and never negative', left === 2 || left === 3, left);
      t('   ...and only the winner issued anything',
        (await issuedFor(R, L)) + (await issuedFor(R2, L)) === 10 - left,
        { a: await issuedFor(R, L), b: await issuedFor(R2, L), left });

      // C. Both job cards taking exactly what is there: both may succeed.
      const E = await newPart('C-5 Exact Part', 'c5-exact', 10);
      const [e1, e2] = await Promise.all([
        send('PUT', `/api/job-cards/${R}`, { partsUsed: [line(L, 'C-5 Limited Part', 0.0001), line(E, 'C-5 Exact Part', 5)] }),
        send('PUT', `/api/job-cards/${R2}`, { partsUsed: [line(E, 'C-5 Exact Part', 5)] }),
      ]);
      t('two job cards taking 5 each from a stock of 10: neither is a 5xx',
        e1.status < 500 && e2.status < 500, { e1: e1.status, e2: e2.status });
      const exactLeft = await stockOf(E);
      t('   ...stock never goes below zero', exactLeft >= 0, exactLeft);
      t('   ...and what left stock is exactly what the ledger says was issued',
        (await issuedFor(R, E)) + (await issuedFor(R2, E)) === 10 - exactLeft,
        { a: await issuedFor(R, E), b: await issuedFor(R2, E), exactLeft });
    }

    /* ---- 16i. the ledger explains the balance, row by row ---- */
    for (const [label, partId] of [['part A', A], ['part B', B]]) {
      const rows = (await get('/api/inventory-transactions?limit=1000')).body?.data
        ?.filter((x) => x.partId === partId)
        ?.sort((x, y) => (x.createdAt || '').localeCompare(y.createdAt || '') || x.id.localeCompare(y.id));
      const live = await stockOf(partId);
      t(`${label}: every ledger row is internally consistent (prev + delta === new)`,
        rows.every((x) => {
          const d = ['purchase', 'adjustment-in', 'return', 'initial-stock'].includes(x.type)
            ? x.quantity : -x.quantity;
          return Math.abs((x.prevStock + d) - x.newStock) < 1e-9;
        }), rows);
      t(`   ...${label}'s rows chain end to end with no lost update`,
        rows.every((x, i) => i === 0 || x.prevStock === rows[i - 1].newStock),
        rows.map((x) => [x.id, x.prevStock, x.newStock]));
      t(`   ...and its last snapshot equals the live balance`,
        rows[rows.length - 1].newStock === live, { last: rows[rows.length - 1], live });
      t(`   ...no ledger row is negative`, rows.every((x) => x.prevStock >= 0 && x.newStock >= 0));
    }
    t('every job-card ledger row this section wrote names its job card',
      (await ledgerFor('JOB-9003')).every((x) => x.referenceType === 'job-card'
        && x.referenceId === 'JOB-9003' && ['job-card-use', 'return'].includes(x.type)),
      await ledgerFor('JOB-9003'));
  }

  // cleanup.sql's sweep removes the rows this section created, in FK order,
  // and resets the counters the ids came from.
}

sec('17. Job card status transitions: the state machine, inventory and the appointment, against real D1');
{
  // The transition table as job-cards.js:46-56 states it. The invalid cases
  // below are derived from it rather than listed, so a table that drifted from
  // the route's own copy fails here loudly.
  const TRANSITIONS = {
    'Received': ['Inspection', 'Cancelled'],
    'Inspection': ['In Progress', 'Waiting for Approval', 'Cancelled'],
    'Waiting for Approval': ['In Progress', 'Cancelled'],
    'In Progress': ['Waiting for Parts', 'Waiting for Approval', 'Completed', 'Cancelled'],
    'Waiting for Parts': ['In Progress'],
    'Completed': ['Delivered'],
    'Delivered': [],
    'Cancelled': [],
  };
  const JOB_STATUSES = Object.keys(TRANSITIONS);

  const cust = await send('POST', '/api/customers', { name: 'C-6 Status Customer', phone: '01966-000001' });
  const C = cust.body?.data?.id;
  const veh = await send('POST', '/api/vehicles',
    { customerId: C, regNo: 'DHA-C6-01', brand: 'Toyota', model: 'Probe' });
  const V = veh.body?.data?.id;
  const mech = await send('POST', '/api/mechanics',
    { name: 'C-6 Status Mechanic', phone: '01966-000002', specialization: 'Engine' });
  const M = mech.body?.data?.id;
  const svc = await send('POST', '/api/services',
    { name: 'C-6 Status Service', category: 'Engine', price: 1200 });
  const S = svc.body?.data?.id;
  t('the section has its own customer, vehicle, mechanic and service',
    [C, V, M, S].every(Boolean), { C, V, M, S });

  const newPart = async (name, partNo, stock) => {
    const p = await send('POST', '/api/parts',
      { name, partNo, category: 'Filters', unit: 'pc',
        purchasePrice: 100, sellingPrice: 200, minStock: 0 });
    t(`a part for ${name} -> 201`, p.status === 201, p.body);
    const id = p.body?.data?.id;
    if (stock > 0) {
      const m = await send('POST', '/api/inventory-transactions',
        { partId: id, type: 'initial-stock', quantity: stock });
      t(`   ...stocked to ${stock}`, m.status === 201, m.body);
    }
    return id;
  };
  const stockOf = async (id) => (await get(`/api/parts/${id}`)).body?.data?.stock;
  const partLine = (id, name, qty) => ({ partId: id, name, partNo: 'x', qty, unitPrice: 100 });
  const newJob = async (partsUsed = [], extra = {}) => {
    const r = await send('POST', '/api/job-cards', {
      customerId: C, vehicleId: V, mechanicId: M,
      date: '2026-09-18', complaint: 'C-6: status walk',
      services: [{ serviceId: S, name: 'C-6 Status Service (as sold)', qty: 1, unitPrice: 1200 }],
      partsUsed, ...extra,
    });
    return r.body?.data?.id;
  };
  const setStatus = (id, status) => send('POST', `/api/job-cards/${id}/status`, { status });
  const statusOf = async (id) => (await get(`/api/job-cards/${id}`)).body?.data?.status;
  // The ledger route returns newest first; a job card's movements read as a
  // story here, so they are turned back into chronological order.
  const ledgerFor = async (jobId, partId) => {
    const r = await get('/api/inventory-transactions?limit=1000');
    return (r.body?.data ?? [])
      .filter((x) => x.referenceType === 'job-card' && x.referenceId === jobId
        && (partId === undefined || x.partId === partId))
      .sort((x, y) => (x.createdAt || '').localeCompare(y.createdAt || '') || x.id.localeCompare(y.id));
  };
  const issuedFor = async (jobId, partId) => (await ledgerFor(jobId, partId)).reduce(
    (s, x) => s + (x.type === 'job-card-use' ? x.quantity : x.type === 'return' ? -x.quantity : 0), 0);

  /* ---- 17a. the whole lifecycle, in order ---- */
  {
    const P = await newPart('C-6 Lifecycle Part', 'c6-life', 20);
    const J = await newJob([partLine(P, 'C-6 Lifecycle Part', 5)]);
    t('a new job card starts Received', (await statusOf(J)) === 'Received', await statusOf(J));
    t('   ...and creating it moved no stock', (await stockOf(P)) === 20, await stockOf(P));

    const insp = await setStatus(J, 'Inspection');
    t('Received -> Inspection -> 200', insp.status === 200, insp.body);
    t('   ...the record comes back with the new status', insp.body?.data?.status === 'Inspection');
    t('   ...in the same shape a GET returns',
      JSON.stringify((await get(`/api/job-cards/${J}`)).body?.data) === JSON.stringify(insp.body?.data));
    t('   ...and still moved no stock', (await stockOf(P)) === 20, await stockOf(P));
    t('   ...completedAt and actualDelivery are still empty',
      insp.body?.data?.completedAt === '' && insp.body?.data?.actualDelivery === '', insp.body?.data);

    const start = await setStatus(J, 'In Progress');
    t('Inspection -> In Progress -> 200', start.status === 200, start.body);
    t('   ...issues the part line in full', (await stockOf(P)) === 15, await stockOf(P));
    const rows = await ledgerFor(J, P);
    t('   ...writing exactly one ledger row', rows.length === 1, rows);
    t('   ...as job-card-use against this job card',
      rows[0]?.type === 'job-card-use' && rows[0]?.referenceType === 'job-card'
        && rows[0]?.referenceId === J, rows[0]);
    t('   ...with the engine\'s own note', rows[0]?.notes === `Used on ${J}`, rows[0]);
    t('   ...snapshotting 20 -> 15', rows[0]?.prevStock === 20 && rows[0]?.newStock === 15, rows[0]);
    t('   ...and no unit cost, as move() records none', rows[0]?.unitCost === null, rows[0]);

    const wait = await setStatus(J, 'Waiting for Parts');
    t('In Progress -> Waiting for Parts -> 200', wait.status === 200, wait.body);
    t('   ...returns nothing — what was issued stays issued',
      (await stockOf(P)) === 15 && (await ledgerFor(J, P)).length === 1, await stockOf(P));

    const resume = await setStatus(J, 'In Progress');
    t('Waiting for Parts -> In Progress -> 200', resume.status === 200, resume.body);
    t('   ...deducts nothing a second time', (await stockOf(P)) === 15, await stockOf(P));
    t('   ...and writes no second ledger row', (await ledgerFor(J, P)).length === 1);

    const done = await setStatus(J, 'Completed');
    t('In Progress -> Completed -> 200', done.status === 200, done.body);
    t('   ...stamps completedAt', /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(done.body?.data?.completedAt || ''),
      done.body?.data?.completedAt);
    t('   ...and leaves actualDelivery empty', done.body?.data?.actualDelivery === '', done.body?.data);
    t('   ...and moves no stock', (await stockOf(P)) === 15, await stockOf(P));

    const delivered = await setStatus(J, 'Delivered');
    t('Completed -> Delivered -> 200', delivered.status === 200, delivered.body);
    t('   ...stamps actualDelivery as a calendar day',
      /^\d{4}-\d{2}-\d{2}$/.test(delivered.body?.data?.actualDelivery || ''),
      delivered.body?.data?.actualDelivery);
    t('   ...in the workshop\'s timezone, not the Worker\'s UTC one',
      delivered.body?.data?.actualDelivery === new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date()), delivered.body?.data?.actualDelivery);
    t('   ...and keeps the completedAt it already had',
      delivered.body?.data?.completedAt === done.body?.data?.completedAt, delivered.body?.data);

    const past = await setStatus(J, 'Cancelled');
    t('a Delivered job card cannot move again -> 409', past.status === 409, past.body);
    t('   ...reason', past.body?.error?.reason === 'job_card_terminal', past.body?.error);
    t('   ...reporting an empty allowed list',
      JSON.stringify(past.body?.error?.allowed) === '[]', past.body?.error);
    t('   ...and its stock is untouched', (await stockOf(P)) === 15, await stockOf(P));

    // C-5's delete guards still apply to what a transition produced.
    const del = await send('DELETE', `/api/job-cards/${J}`);
    t('a Delivered job card still cannot be deleted -> 409', del.status === 409, del.body);
    t('   ...reason', del.body?.error?.reason === 'job_card_completed', del.body?.error);
  }

  /* ---- 17b. every transition the table does not list ---- */
  {
    const J = await newJob();
    let refused = 0, wrongly = [];
    for (const to of JOB_STATUSES) {
      if (TRANSITIONS.Received.includes(to)) continue;
      const r = await setStatus(J, to);
      if (r.status === 409 && (await statusOf(J)) === 'Received') refused += 1;
      else wrongly.push({ to, status: r.status, body: r.body });
    }
    t('a Received job card refuses every move the table does not list',
      refused === JOB_STATUSES.length - TRANSITIONS.Received.length, wrongly);
    const same = await setStatus(J, 'Received');
    t('   ...including a request for the status it already has -> 409', same.status === 409, same.body);
    t('   ...with its own reason', same.body?.error?.reason === 'same_status', same.body?.error);
    t('   ...and the client\'s own wording',
      same.body?.error?.message === 'Cannot change Received job card to Received.', same.body?.error);
    const skip = await setStatus(J, 'Completed');
    t('   ...a skipped step reports what IS reachable',
      JSON.stringify(skip.body?.error?.allowed) === JSON.stringify(['Inspection', 'Cancelled']),
      skip.body?.error);
    await send('DELETE', `/api/job-cards/${J}`);
  }
  {
    // PUT still refuses a status change, so there is exactly one state machine.
    const J = await newJob();
    const viaPut = await send('PUT', `/api/job-cards/${J}`, { status: 'Inspection' });
    t('PUT still refuses a status change -> 409', viaPut.status === 409, viaPut.body);
    t('   ...reason', viaPut.body?.error?.reason === 'status_change_not_supported', viaPut.body?.error);
    t('   ...and the job card did not move', (await statusOf(J)) === 'Received');
    await send('DELETE', `/api/job-cards/${J}`);
  }

  /* ---- 17c. the request itself ---- */
  {
    const J = await newJob();
    for (const [why, body] of [
      ['a missing status', {}],
      ['a null status', { status: null }],
      ['an empty status', { status: '' }],
      ['a status of the wrong type', { status: 7 }],
      ['an unknown status', { status: 'Nonsense' }],
      ['a lower-case status', { status: 'inspection' }],
      ['a client-supplied completedAt', { status: 'Inspection', completedAt: '2020-01-01T00:00:00Z' }],
      ['a client-supplied actualDelivery', { status: 'Inspection', actualDelivery: '2020-01-01' }],
      ['a client-supplied paid', { status: 'Inspection', paid: 1 }],
      ['a client-supplied prevStock', { status: 'Inspection', prevStock: 1 }],
    ]) {
      const r = await send('POST', `/api/job-cards/${J}/status`, body);
      t(`${why} -> 422`, r.status === 422, { status: r.status, body: r.body });
    }
    const bad = await send('POST', `/api/job-cards/${J}/status`, 'not json');
    t('a malformed body -> 400', bad.status === 400, bad.status);
    const ghost = await send('POST', '/api/job-cards/JOB-7777/status', { status: 'Inspection' });
    t('an unknown job card -> 404', ghost.status === 404, ghost.status);
    const badId = await send('POST', '/api/job-cards/nope/status', { status: 'Inspection' });
    t('a malformed job card id -> 400', badId.status === 400, badId.status);
    for (const m of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const r = await get(`/api/job-cards/${J}/status`, { method: m });
      t(`${m} on the status path -> 405 + Allow: POST`,
        r.status === 405 && r.allow === 'POST', { status: r.status, allow: r.allow });
    }
    const unknownAction = await send('POST', `/api/job-cards/${J}/invoice`, {});
    t('an action the router does not declare is not routed',
      unknownAction.status === 400 || unknownAction.status === 405, unknownAction.status);
    t('   ...and the job card never moved', (await statusOf(J)) === 'Received');
    await send('DELETE', `/api/job-cards/${J}`);
  }

  /* ---- 17d. insufficient stock stops the whole transition ---- */
  {
    const P = await newPart('C-6 Short Part', 'c6-short', 3);
    const J = await newJob([partLine(P, 'C-6 Short Part', 9)]);
    await setStatus(J, 'Inspection');
    const before = (await get(`/api/job-cards/${J}`)).body?.data;
    const r = await setStatus(J, 'In Progress');
    t('entering In Progress without the stock -> 409', r.status === 409, r.body);
    t('   ...reason', r.body?.error?.reason === 'insufficient_stock', r.body?.error);
    t('   ...with the client\'s own wording',
      r.body?.error?.message === 'Insufficient stock for C-6 Short Part. Available: 3, Required: 9.',
      r.body?.error?.message);
    t('   ...naming the line', r.body?.error?.shortages?.[0]?.name === 'C-6 Short Part', r.body?.error);
    t('   ...the status did not move', (await statusOf(J)) === 'Inspection', await statusOf(J));
    t('   ...the stock did not move', (await stockOf(P)) === 3, await stockOf(P));
    t('   ...no ledger row was written', (await ledgerFor(J)).length === 0, await ledgerFor(J));
    t('   ...and nothing at all about the job card changed',
      JSON.stringify((await get(`/api/job-cards/${J}`)).body?.data) === JSON.stringify(before),
      { before, after: (await get(`/api/job-cards/${J}`)).body?.data });

    // Waiting for Parts is exactly where the client tells you to put it.
    const parked = await setStatus(J, 'Cancelled');
    t('   ...and it can still be cancelled', parked.status === 200, parked.body);
    t('   ...returning nothing, because nothing was issued',
      (await stockOf(P)) === 3 && (await ledgerFor(J)).length === 0, await stockOf(P));
  }

  /* ---- 17e. multiple parts: one short fails all of them ---- */
  {
    const A = await newPart('C-6 Multi Part A', 'c6-mA', 10);
    const B = await newPart('C-6 Multi Part B', 'c6-mB', 5);
    const J = await newJob([
      partLine(A, 'C-6 Multi Part A', 8),
      partLine(B, 'C-6 Multi Part B', 7),
    ]);
    await setStatus(J, 'Inspection');
    const r = await setStatus(J, 'In Progress');
    t('one short part of two -> 409', r.status === 409, r.body);
    t('   ...naming the short one', r.body?.error?.shortages?.[0]?.name === 'C-6 Multi Part B',
      r.body?.error);
    t('   ...the part that WAS available did not move', (await stockOf(A)) === 10, await stockOf(A));
    t('   ...nor did the short one', (await stockOf(B)) === 5, await stockOf(B));
    t('   ...no ledger row exists for either', (await ledgerFor(J)).length === 0, await ledgerFor(J));
    t('   ...and the status did not move', (await statusOf(J)) === 'Inspection', await statusOf(J));

    // Give it the stock it needs, and all three parts move together.
    await send('POST', '/api/inventory-transactions', { partId: B, type: 'purchase', quantity: 5 });
    const ok2 = await setStatus(J, 'In Progress');
    t('once the stock is there, both parts issue together -> 200', ok2.status === 200, ok2.body);
    t('   ...part A is 10 -> 2', (await stockOf(A)) === 2, await stockOf(A));
    t('   ...part B is 10 -> 3', (await stockOf(B)) === 3, await stockOf(B));
    t('   ...with one ledger row each', (await ledgerFor(J)).length === 2, await ledgerFor(J));

    /* ---- 17f. cancelling returns exactly what is outstanding ---- */
    // C-5's edit reduces part A to 3 while the job is In Progress, so the
    // ledger and the line disagree with what was first issued.
    const reduced = await send('PUT', `/api/job-cards/${J}`, {
      partsUsed: [partLine(A, 'C-6 Multi Part A', 3), partLine(B, 'C-6 Multi Part B', 7)],
    });
    t('reducing part A to 3 returns the difference -> 200', reduced.status === 200, reduced.body);
    t('   ...so 3 are outstanding on A', (await issuedFor(J, A)) === 3, await issuedFor(J, A));
    t('   ...and 7 on B', (await issuedFor(J, B)) === 7, await issuedFor(J, B));
    const aBefore = await stockOf(A);
    const bBefore = await stockOf(B);

    const cancelled = await setStatus(J, 'Cancelled');
    t('cancelling -> 200', cancelled.status === 200, cancelled.body);
    t('   ...returns THREE of part A, not the eight first issued',
      (await stockOf(A)) === aBefore + 3, { before: aBefore, after: await stockOf(A) });
    t('   ...and seven of part B', (await stockOf(B)) === bBefore + 7,
      { before: bBefore, after: await stockOf(B) });
    t('   ...leaving nothing outstanding on either',
      (await issuedFor(J, A)) === 0 && (await issuedFor(J, B)) === 0,
      { a: await issuedFor(J, A), b: await issuedFor(J, B) });
    // Both engines write `return` rows, so they are told apart by their note:
    // C-5's reconciliation says "Adjusted", a cancellation says "Returned".
    const returns = (await ledgerFor(J)).filter((x) => x.type === 'return');
    const cancelReturns = returns.filter((x) => x.notes === `Returned — ${J} cancelled`);
    t('   ...the cancellation wrote one return per outstanding part',
      cancelReturns.length === 2, returns.map((x) => [x.partId, x.notes]));
    t('   ...and C-5\'s earlier reconciliation kept its own note',
      returns.filter((x) => x.notes === `Adjusted on ${J} (qty change)`).length === 1,
      returns.map((x) => x.notes));
    t('   ...and its stock is back where it started', (await stockOf(A)) === 10, await stockOf(A));

    const again = await setStatus(J, 'Cancelled');
    t('cancelling a second time -> 409', again.status === 409, again.body);
    t('   ...and returns nothing twice', (await stockOf(A)) === 10, await stockOf(A));
    t('   ...leaving the ledger as it was',
      (await ledgerFor(J)).filter((x) => x.notes === `Returned — ${J} cancelled`).length === 2,
      (await ledgerFor(J)).map((x) => x.notes));
  }

  /* ---- 17g. repeating a transition never moves stock twice ---- */
  {
    const P = await newPart('C-6 Repeat Part', 'c6-rep', 20);
    const J = await newJob([partLine(P, 'C-6 Repeat Part', 4)]);
    await setStatus(J, 'Inspection');
    const first = await setStatus(J, 'In Progress');
    t('the first In Progress request succeeds', first.status === 200, first.body);
    t('   ...deducting 4', (await stockOf(P)) === 16, await stockOf(P));
    const second = await setStatus(J, 'In Progress');
    t('the second is refused -> 409', second.status === 409, second.body);
    t('   ...as a same-status request', second.body?.error?.reason === 'same_status', second.body?.error);
    t('   ...and deducts nothing', (await stockOf(P)) === 16, await stockOf(P));
    t('   ...leaving exactly one ledger row', (await ledgerFor(J, P)).length === 1, await ledgerFor(J, P));
  }

  /* ---- 17h. the appointment follows, one way only ---- */
  {
    const appt = await send('POST', '/api/appointments', {
      customerId: C, vehicleId: V, serviceId: S, date: '2099-07-01', time: '10:00',
      duration: 60, source: 'Facebook',
    });
    t('an appointment for the sync tests -> 201', appt.status === 201, appt.body);
    const A = appt.body?.data?.id;
    const J = await newJob([], { appointmentId: A });
    t('   ...linked to a new job card', (await get(`/api/appointments/${A}`)).body?.data?.jobCardId === J);
    t('   ...whose creation left its status alone',
      (await get(`/api/appointments/${A}`)).body?.data?.status === 'Scheduled');

    await setStatus(J, 'Inspection');
    t('Received -> Inspection leaves the appointment alone',
      (await get(`/api/appointments/${A}`)).body?.data?.status === 'Scheduled',
      (await get(`/api/appointments/${A}`)).body?.data);

    await setStatus(J, 'In Progress');
    const started = (await get(`/api/appointments/${A}`)).body?.data;
    t('Inspection -> In Progress moves the appointment to In Progress',
      started.status === 'In Progress', started);
    t('   ...even though its own transition table would not allow Scheduled -> In Progress',
      started.status === 'In Progress');
    t('   ...its source is untouched', started.source === 'Facebook', started);
    t('   ...its job card link is untouched', started.jobCardId === J, started);
    t('   ...and its updated_at was refreshed', !!started.updatedAt, started);

    await setStatus(J, 'Waiting for Parts');
    t('In Progress -> Waiting for Parts leaves the appointment alone',
      (await get(`/api/appointments/${A}`)).body?.data?.status === 'In Progress');
    await setStatus(J, 'In Progress');
    await setStatus(J, 'Completed');
    const completed = (await get(`/api/appointments/${A}`)).body?.data;
    t('In Progress -> Completed completes the appointment', completed.status === 'Completed', completed);
    t('   ...source still untouched', completed.source === 'Facebook', completed);
    t('   ...and the link still intact', completed.jobCardId === J, completed);

    // The appointment is terminal now, so nothing moves it again.
    await setStatus(J, 'Delivered');
    t('Completed -> Delivered leaves the finished appointment alone',
      (await get(`/api/appointments/${A}`)).body?.data?.status === 'Completed');

    // And nothing ever flows back: changing the appointment does not move the
    // job card. A Completed appointment is terminal, so this is a 409 from
    // C-3's own rules -- the point is that the job card is unaffected either way.
    const back = await send('PUT', `/api/appointments/${A}`, { status: 'Cancelled' });
    t('an appointment cannot be dragged out of Completed -> 409', back.status === 409, back.body);
    t('   ...and the job card is still Delivered', (await statusOf(J)) === 'Delivered');
  }
  {
    // A cancelled job card leaves its appointment exactly where it was.
    const appt = await send('POST', '/api/appointments', {
      customerId: C, vehicleId: V, serviceId: S, date: '2099-07-02', time: '10:00',
      duration: 60, source: 'Website',
    });
    const A = appt.body?.data?.id;
    const J = await newJob([], { appointmentId: A });
    await setStatus(J, 'Cancelled');
    const after = (await get(`/api/appointments/${A}`)).body?.data;
    t('cancelling a job card does NOT cancel its appointment', after.status === 'Scheduled', after);
    t('   ...and does not unlink it either', after.jobCardId === J, after);
    t('   ...nor touch its source', after.source === 'Website', after);
  }
  {
    // An unrelated appointment is never touched by another job card's transition.
    const appt = await send('POST', '/api/appointments', {
      customerId: C, vehicleId: V, serviceId: S, date: '2099-07-03', time: '10:00',
      duration: 60, source: 'Phone',
    });
    const A = appt.body?.data?.id;
    const J = await newJob();
    await setStatus(J, 'Inspection');
    await setStatus(J, 'In Progress');
    const untouched = (await get(`/api/appointments/${A}`)).body?.data;
    t('an unlinked job card\'s transition touches no appointment',
      untouched.status === 'Scheduled' && untouched.jobCardId === null, untouched);
    await setStatus(J, 'Cancelled');
    await send('DELETE', `/api/appointments/${A}`);
  }

  /* ---- 17i. concurrency ---- */
  {
    // A. the SAME job card, two simultaneous transitions into In Progress.
    const P = await newPart('C-6 Race Part', 'c6-race', 20);
    const J = await newJob([partLine(P, 'C-6 Race Part', 6)]);
    await setStatus(J, 'Inspection');
    const [r1, r2] = await Promise.all([setStatus(J, 'In Progress'), setStatus(J, 'In Progress')]);
    const codes = [r1.status, r2.status].sort();
    t('two simultaneous In Progress requests: exactly one succeeds',
      codes.filter((c) => c === 200).length === 1, { r1: r1.status, r2: r2.status });
    t('   ...and exactly one is refused', codes.filter((c) => c === 409).length === 1, codes);
    t('   ...neither is a 5xx', !codes.some((c) => c >= 500), codes);
    t('   ...the refusal names a state the caller can act on',
      ['concurrent_modification', 'same_status'].includes(
        [r1, r2].find((r) => r.status === 409)?.body?.error?.reason),
      [r1.body?.error, r2.body?.error]);
    t('   ...the job card is In Progress', (await statusOf(J)) === 'In Progress', await statusOf(J));
    t('   ...stock moved by exactly 6, never 12', (await stockOf(P)) === 14, await stockOf(P));
    t('   ...and exactly one ledger row exists', (await ledgerFor(J, P)).length === 1, await ledgerFor(J, P));

    // D. a cancellation race on the same job card.
    const [c1, c2] = await Promise.all([setStatus(J, 'Cancelled'), setStatus(J, 'Cancelled')]);
    t('two simultaneous cancellations: exactly one succeeds',
      [c1.status, c2.status].filter((c) => c === 200).length === 1,
      { c1: c1.status, c2: c2.status });
    t('   ...neither is a 5xx', ![c1.status, c2.status].some((c) => c >= 500), [c1.status, c2.status]);
    t('   ...the six units come back once', (await stockOf(P)) === 20, await stockOf(P));
    t('   ...with exactly one return row',
      (await ledgerFor(J, P)).filter((x) => x.type === 'return').length === 1, await ledgerFor(J, P));
    t('   ...and nothing is outstanding', (await issuedFor(J, P)) === 0, await issuedFor(J, P));
  }
  {
    // B. two job cards, 8 + 7 against a stock of 10.
    const L = await newPart('C-6 Limited Part', 'c6-lim6', 10);
    const JA = await newJob([partLine(L, 'C-6 Limited Part', 8)]);
    const JB = await newJob([partLine(L, 'C-6 Limited Part', 7)]);
    await Promise.all([setStatus(JA, 'Inspection'), setStatus(JB, 'Inspection')]);
    const [a, b] = await Promise.all([setStatus(JA, 'In Progress'), setStatus(JB, 'In Progress')]);
    const left = await stockOf(L);
    t('two job cards, 8 + 7 against a stock of 10: one succeeds',
      [a.status, b.status].filter((c) => c === 200).length === 1, { a: a.status, b: b.status });
    t('   ...and one is refused for stock',
      [a, b].find((r) => r.status === 409)?.body?.error?.reason === 'insufficient_stock',
      [a.body?.error, b.body?.error]);
    t('   ...stock is 2 or 3, and never negative', left === 2 || left === 3, left);
    t('   ...only the winner moved to In Progress',
      [await statusOf(JA), await statusOf(JB)].filter((s) => s === 'In Progress').length === 1,
      [await statusOf(JA), await statusOf(JB)]);
    t('   ...and the ledger accounts for every unit that left',
      (await issuedFor(JA, L)) + (await issuedFor(JB, L)) === 10 - left,
      { a: await issuedFor(JA, L), b: await issuedFor(JB, L), left });

    // C. two job cards taking exactly what is there.
    const E = await newPart('C-6 Exact Part', 'c6-ex6', 10);
    const JC = await newJob([partLine(E, 'C-6 Exact Part', 5)]);
    const JD = await newJob([partLine(E, 'C-6 Exact Part', 5)]);
    await Promise.all([setStatus(JC, 'Inspection'), setStatus(JD, 'Inspection')]);
    const [c, d] = await Promise.all([setStatus(JC, 'In Progress'), setStatus(JD, 'In Progress')]);
    t('two job cards taking 5 each from a stock of 10: both succeed',
      c.status === 200 && d.status === 200, { c: c.status, d: d.status });
    t('   ...and the stock is exactly zero', (await stockOf(E)) === 0, await stockOf(E));
    t('   ...with five issued to each',
      (await issuedFor(JC, E)) === 5 && (await issuedFor(JD, E)) === 5,
      { c: await issuedFor(JC, E), d: await issuedFor(JD, E) });
  }
  {
    // E. a twelve-way burst on one scarce part.
    const B = await newPart('C-6 Burst Part', 'c6-burst', 5);
    const jobs = [];
    for (let i = 0; i < 12; i += 1) jobs.push(await newJob([partLine(B, 'C-6 Burst Part', 1)]));
    await Promise.all(jobs.map((j) => setStatus(j, 'Inspection')));
    const results = await Promise.all(jobs.map((j) => setStatus(j, 'In Progress')));
    const won = results.filter((r) => r.status === 200).length;
    const lost = results.filter((r) => r.status === 409).length;
    t('twelve job cards racing for five units: five succeed', won === 5, { won, lost });
    t('   ...seven are refused', lost === 7, { won, lost });
    t('   ...none is a 5xx', !results.some((r) => r.status >= 500), results.map((r) => r.status));
    t('   ...every refusal is a stock conflict',
      results.filter((r) => r.status === 409)
        .every((r) => r.body?.error?.reason === 'insufficient_stock'),
      results.filter((r) => r.status === 409).map((r) => r.body?.error?.reason));
    t('   ...the stock is exactly zero, never negative', (await stockOf(B)) === 0, await stockOf(B));
    t('   ...exactly five job cards are In Progress',
      (await Promise.all(jobs.map(statusOf))).filter((s) => s === 'In Progress').length === 5,
      await Promise.all(jobs.map(statusOf)));

    /* ---- 17j. the ledger explains the balance, row by row ---- */
    const rows = (await get('/api/inventory-transactions?limit=1000')).body?.data
      ?.filter((x) => x.partId === B)
      ?.sort((x, y) => (x.createdAt || '').localeCompare(y.createdAt || '') || x.id.localeCompare(y.id));
    t('every burst ledger row is internally consistent (prev + delta === new)',
      rows.every((x) => {
        const delta = ['purchase', 'adjustment-in', 'return', 'initial-stock'].includes(x.type)
          ? x.quantity : -x.quantity;
        return Math.abs((x.prevStock + delta) - x.newStock) < 1e-9;
      }), rows);
    t('   ...the rows chain end to end with no lost update',
      rows.every((x, i) => i === 0 || x.prevStock === rows[i - 1].newStock),
      rows.map((x) => [x.id, x.prevStock, x.newStock]));
    t('   ...the last snapshot equals the live balance',
      rows[rows.length - 1].newStock === (await stockOf(B)),
      { last: rows[rows.length - 1], live: await stockOf(B) });
    t('   ...no snapshot is ever negative', rows.every((x) => x.prevStock >= 0 && x.newStock >= 0));
    t('   ...and there are exactly six: the stocking, plus one per winner',
      rows.length === 6, rows.length);
    t('every job-card row the burst wrote names its own job card',
      rows.filter((x) => x.referenceType === 'job-card')
        .every((x) => jobs.includes(x.referenceId) && x.type === 'job-card-use'),
      rows.filter((x) => x.referenceType === 'job-card').map((x) => [x.referenceId, x.type]));
  }

  // cleanup.sql's sweep removes the rows this section created, in FK order,
  // and resets the counters the ids came from.
}

sec('18. Invoice writes: copied from a job card, voided into advances, against real D1');
{
  const cust = await send('POST', '/api/customers', { name: 'C-7 Invoice Customer', phone: '01977-000001' });
  const C = cust.body?.data?.id;
  const veh = await send('POST', '/api/vehicles',
    { customerId: C, regNo: 'DHA-C7-01', brand: 'Toyota', model: 'Probe' });
  const V = veh.body?.data?.id;
  const mech = await send('POST', '/api/mechanics',
    { name: 'C-7 Invoice Mechanic', phone: '01977-000002', specialization: 'Engine' });
  const M = mech.body?.data?.id;
  const svc = await send('POST', '/api/services',
    { name: 'C-7 Catalogue Service', category: 'Engine', price: 1200 });
  const S = svc.body?.data?.id;
  const part = await send('POST', '/api/parts',
    { name: 'C-7 Catalogue Part', partNo: 'c7-cat', category: 'Filters', unit: 'pc',
      purchasePrice: 100, sellingPrice: 200, minStock: 0 });
  const P = part.body?.data?.id;
  await send('POST', '/api/inventory-transactions', { partId: P, type: 'initial-stock', quantity: 20 });
  t('the section has its own customer, vehicle, mechanic, service and part',
    [C, V, M, S, P].every(Boolean), { C, V, M, S, P });

  const stockOf = async (id) => (await get(`/api/parts/${id}`)).body?.data?.stock;
  const setStatus = (id, status) => send('POST', `/api/job-cards/${id}/status`, { status });
  const ledgerRows = async () => (await get('/api/inventory-transactions?limit=1000')).body?.data ?? [];

  /**
   * A job card carried all the way to Completed, so it is invoiceable. The
   * part line makes the walk issue stock, which is what lets the tests below
   * prove that invoicing then leaves it alone.
   */
  const completedJob = async (over = {}) => {
    const r = await send('POST', '/api/job-cards', {
      customerId: C, vehicleId: V, mechanicId: M,
      date: '2026-09-18', complaint: 'C-7: ready to bill',
      services: [{ serviceId: S, name: 'C-7 Service (as sold)', qty: 1, unitPrice: 1000 }],
      partsUsed: [{ partId: P, name: 'C-7 Part (as sold)', partNo: 'sold-1', qty: 1, unitPrice: 500 }],
      paid: 300, ...over,
    });
    const id = r.body?.data?.id;
    await setStatus(id, 'Inspection');
    await setStatus(id, 'In Progress');
    await setStatus(id, 'Completed');
    return id;
  };

  /* ---- 18a. create ---- */
  {
    const J = await completedJob();
    const job = (await get(`/api/job-cards/${J}`)).body?.data;
    t('a job card ready to bill is Completed', job?.status === 'Completed', job?.status);
    const stockBefore = await stockOf(P);
    const ledgerBefore = (await ledgerRows()).length;

    const inv = await send('POST', '/api/invoices', { jobCardId: J });
    t('POST /api/invoices -> 201', inv.status === 201, inv.body);
    const I = inv.body?.data?.id;
    t('   ...allocated a real INV id', /^INV-\d{4}$/.test(I || ''), I);
    t('   ...linked to the job card', inv.body?.data?.jobCardId === J, inv.body?.data);
    t('   ...with the job card\'s customer and vehicle',
      inv.body?.data?.customerId === C && inv.body?.data?.vehicleId === V, inv.body?.data);
    t('   ...and a GET returns exactly what the POST reported',
      JSON.stringify((await get(`/api/invoices/${I}`)).body?.data) === JSON.stringify(inv.body?.data));

    t('every figure is copied from the job card',
      inv.body?.data?.subtotal === job.subtotal && inv.body?.data?.total === job.total
        && inv.body?.data?.labourCost === job.labourCost && inv.body?.data?.tax === job.tax
        && inv.body?.data?.discount === job.discount && inv.body?.data?.taxRate === job.taxRate,
      { invoice: inv.body?.data, job });
    // 0002, decision (a): the job card's typed paid (300 here) is not a
    // recorded payment, so it is NOT copied. A new invoice starts unpaid.
    t('   ...except the job card\'s typed paid: the invoice starts at paid 0',
      inv.body?.data?.paid === 0, inv.body?.data);
    t('   ...so due is the whole total', inv.body?.data?.due === job.total, inv.body?.data);
    t('   ...and it starts Unpaid', inv.body?.data?.status === 'Unpaid', inv.body?.data);
    t('   ...with nothing written off', inv.body?.data?.writtenOff === 0, inv.body?.data);
    t('   ...while the job card keeps its own typed paid',
      (await get(`/api/job-cards/${J}`)).body?.data?.paid === 300);

    t('the line snapshots came across',
      inv.body?.data?.services?.length === 1 && inv.body?.data?.partsUsed?.length === 1,
      inv.body?.data);
    t('   ...naming what was SOLD, not the catalogue',
      inv.body?.data?.services[0]?.name === 'C-7 Service (as sold)'
        && inv.body?.data?.partsUsed[0]?.name === 'C-7 Part (as sold)', inv.body?.data);
    t('   ...at the price it was sold for',
      inv.body?.data?.services[0]?.unitPrice === 1000
        && inv.body?.data?.partsUsed[0]?.unitPrice === 500, inv.body?.data);
    t('   ...the part number too', inv.body?.data?.partsUsed[0]?.partNo === 'sold-1', inv.body?.data);
    t('   ...and it is partsUsed, never parts',
      'partsUsed' in inv.body.data && !('parts' in inv.body.data));

    t('the job card now points at the invoice',
      (await get(`/api/job-cards/${J}`)).body?.data?.invoiceId === I,
      (await get(`/api/job-cards/${J}`)).body?.data?.invoiceId);
    t('   ...and its own status is unchanged',
      (await get(`/api/job-cards/${J}`)).body?.data?.status === 'Completed');
    t('   ...while its own paid/due stay exactly as they were',
      (await get(`/api/job-cards/${J}`)).body?.data?.paid === job.paid
        && (await get(`/api/job-cards/${J}`)).body?.data?.due === job.due,
      (await get(`/api/job-cards/${J}`)).body?.data);

    // Step 23: invoicing bills for stock the job card already issued.
    t('invoicing moved no stock', (await stockOf(P)) === stockBefore,
      { before: stockBefore, after: await stockOf(P) });
    t('   ...and wrote no ledger row', (await ledgerRows()).length === ledgerBefore,
      { before: ledgerBefore, after: (await ledgerRows()).length });

    /* ---- 18b. the snapshots are historical ---- */
    const renamed = await send('PUT', `/api/services/${S}`, { name: 'C-7 RENAMED Service', price: 9999 });
    t('renaming and repricing the catalogue service -> 200', renamed.status === 200, renamed.body);
    const repriced = await send('PUT', `/api/parts/${P}`,
      { name: 'C-7 RENAMED Part', partNo: 'c7-renamed', sellingPrice: 8888 });
    t('renaming and repricing the catalogue part -> 200', repriced.status === 200, repriced.body);
    const after = (await get(`/api/invoices/${I}`)).body?.data;
    t('the invoice is untouched by either', JSON.stringify(after) === JSON.stringify(inv.body?.data),
      { before: inv.body?.data, after });
    t('   ...the billed service name still says what was sold',
      after.services[0].name === 'C-7 Service (as sold)', after.services[0]);
    t('   ...at the price it was sold for', after.services[0].unitPrice === 1000, after.services[0]);
    t('   ...the billed part name too', after.partsUsed[0].name === 'C-7 Part (as sold)', after.partsUsed[0]);
    t('   ...with its own part number', after.partsUsed[0].partNo === 'sold-1', after.partsUsed[0]);
    t('   ...and its own price', after.partsUsed[0].unitPrice === 500, after.partsUsed[0]);

    /* ---- 18c. notes are the only edit ---- */
    const noted = await send('PUT', `/api/invoices/${I}`, { notes: '  paid by bank transfer  ' });
    t('PUT notes -> 200', noted.status === 200, noted.body);
    t('   ...stored trimmed', noted.body?.data?.notes === 'paid by bank transfer', noted.body?.data);
    t('   ...updatedAt now set', !!noted.body?.data?.updatedAt, noted.body?.data);
    t('   ...and every figure survives untouched',
      noted.body?.data?.total === after.total && noted.body?.data?.paid === after.paid
        && noted.body?.data?.due === after.due && noted.body?.data?.status === after.status,
      noted.body?.data);
    for (const [field, value] of [
      ['total', 1], ['paid', 1], ['due', 1], ['status', 'Paid'], ['services', []],
      ['jobCardId', 'JOB-9002'], ['date', '2026-01-01'], ['discount', 1],
    ]) {
      const bad = await send('PUT', `/api/invoices/${I}`, { [field]: value });
      t(`editing \`${field}\` -> 422`, bad.status === 422, { status: bad.status, body: bad.body });
    }
    const nothing = await send('PUT', `/api/invoices/${I}`, {});
    t('an empty edit -> 422', nothing.status === 422, nothing.body);

    /* ---- 18d. a second invoice for the same job card ---- */
    const dup = await send('POST', '/api/invoices', { jobCardId: J });
    t('a second invoice for the same job card -> 409', dup.status === 409, dup.body);
    t('   ...reason', dup.body?.error?.reason === 'invoice_exists', dup.body?.error);
    t('   ...naming the one that exists', dup.body?.error?.conflictsWith === I, dup.body?.error);

    /* ---- 18e. delete guards ---- */
    const delActive = await send('DELETE', `/api/invoices/${I}`);
    t('deleting an active invoice -> 409', delActive.status === 409, delActive.body);
    t('   ...reason', delActive.body?.error?.reason === 'invoice_not_void', delActive.body?.error);
    t('   ...and it is still there', (await get(`/api/invoices/${I}`)).status === 200);
    // C-5's job card delete guard still sees the link.
    const delJob = await send('DELETE', `/api/job-cards/${J}`);
    t('the invoiced job card still cannot be deleted -> 409', delJob.status === 409, delJob.body);
    t('   ...reason', delJob.body?.error?.reason === 'job_card_invoiced', delJob.body?.error);

    /* ---- 18f. void, and re-invoice ---- */
    const voided = await send('POST', `/api/invoices/${I}/void`);
    t('POST /api/invoices/:id/void -> 200', voided.status === 200, voided.body);
    t('   ...the invoice is Void', voided.body?.data?.status === 'Void', voided.body?.data);
    t('   ...its paid stays frozen at what it had collected (nothing)',
      voided.body?.data?.paid === 0, voided.body?.data);
    t('   ...and its due with it', voided.body?.data?.due === after.due, voided.body?.data);
    t('   ...its line snapshots are kept',
      voided.body?.data?.services?.length === 1 && voided.body?.data?.partsUsed?.length === 1,
      voided.body?.data);
    t('   ...it still names the job card it billed', voided.body?.data?.jobCardId === J, voided.body?.data);
    t('   ...but the job card is un-invoiced again',
      (await get(`/api/job-cards/${J}`)).body?.data?.invoiceId === null,
      (await get(`/api/job-cards/${J}`)).body?.data?.invoiceId);
    t('   ...no payments were linked, so none were released',
      voided.body?.released === 0, voided.body?.released);
    t('   ...and no stock moved', (await stockOf(P)) === stockBefore, await stockOf(P));

    const again = await send('POST', `/api/invoices/${I}/void`);
    t('voiding a second time -> 409', again.status === 409, again.body);
    t('   ...reason', again.body?.error?.reason === 'invoice_void', again.body?.error);
    t('   ...and its figures are still frozen',
      (await get(`/api/invoices/${I}`)).body?.data?.paid === 0);

    const reInvoice = await send('POST', '/api/invoices', { jobCardId: J });
    t('the job card can be invoiced again -> 201', reInvoice.status === 201, reInvoice.body);
    const I2 = reInvoice.body?.data?.id;
    t('   ...as a new invoice', I2 !== I, { I, I2 });
    t('   ...and the job card points at the new one',
      (await get(`/api/job-cards/${J}`)).body?.data?.invoiceId === I2);
    const old = (await get(`/api/invoices/${I}`)).body?.data;
    t('   ...while the voided one is unchanged',
      old.status === 'Void' && old.paid === 0 && old.services.length === 1, old);

    /* ---- 18g. delete a void invoice ---- */
    await send('POST', `/api/invoices/${I2}/void`);
    // An invoice only collects money through a payment now, so record one,
    // then void the invoice: it keeps the frozen figure and cannot be deleted.
    const cashJob = await completedJob({ paid: 0, complaint: 'C-7: collected, then voided' });
    const cashInv = (await send('POST', '/api/invoices', { jobCardId: cashJob })).body?.data?.id;
    const cashPay = await send('POST', '/api/payments', { customerId: C, invoiceId: cashInv, amount: 300 });
    t('a real payment of 300 is recorded against it', cashPay.status === 201, cashPay.body);
    await send('POST', `/api/invoices/${cashInv}/void`);
    t('   ...voided, it keeps 300 as its frozen paid',
      (await get(`/api/invoices/${cashInv}`)).body?.data?.paid === 300);
    const paidVoid = await send('DELETE', `/api/invoices/${cashInv}`);
    t('deleting a Void invoice that collected money -> 409', paidVoid.status === 409, paidVoid.body);
    t('   ...reason', paidVoid.body?.error?.reason === 'invoice_has_payments', paidVoid.body?.error);

    const zeroJob = await completedJob({ paid: 0, complaint: 'C-7: nothing collected' });
    const zeroInv = await send('POST', '/api/invoices', { jobCardId: zeroJob });
    t('an invoice that collected nothing is Unpaid',
      zeroInv.body?.data?.status === 'Unpaid' && zeroInv.body?.data?.paid === 0, zeroInv.body?.data);
    const Z = zeroInv.body?.data?.id;
    await send('POST', `/api/invoices/${Z}/void`);
    const gone = await send('DELETE', `/api/invoices/${Z}`);
    t('deleting a Void invoice that collected nothing -> 200', gone.status === 200, gone.body);
    t('   ...reporting what went', JSON.stringify(gone.body?.data) === JSON.stringify({ id: Z, deleted: true }),
      gone.body?.data);
    t('   ...it is really gone', (await get(`/api/invoices/${Z}`)).status === 404);
    t('   ...its child lines went with it',
      !(await get('/api/invoices?limit=1000')).body?.data?.some((x) => x.id === Z));
    t('   ...and the job card was already unlinked by the void',
      (await get(`/api/job-cards/${zeroJob}`)).body?.data?.invoiceId === null);
    await send('DELETE', `/api/job-cards/${zeroJob}`);
  }

  /* ---- 18h. eligibility, over real HTTP ---- */
  {
    const ghost = await send('POST', '/api/invoices', { jobCardId: 'JOB-7777' });
    t('an unknown job card -> 404', ghost.status === 404, ghost.status);
    t('   ...with the client\'s wording', ghost.body?.error?.message === 'Job Card not found.',
      ghost.body?.error);

    for (const [status, id] of [['Received', null], ['In Progress', 'JOB-9003'], ['Cancelled', 'JOB-9004']]) {
      const target = id ?? (await send('POST', '/api/job-cards', {
        customerId: C, vehicleId: V, mechanicId: M, date: '2026-09-18',
        complaint: 'C-7: not ready', services: [{ serviceId: S, name: 'x', qty: 1, unitPrice: 100 }],
      })).body?.data?.id;
      const r = await send('POST', '/api/invoices', { jobCardId: target });
      t(`a ${status} job card cannot be invoiced -> 409`, r.status === 409, { status: r.status, body: r.body });
      t('   ...reason', r.body?.error?.reason === 'job_card_not_invoiceable', r.body?.error);
      t('   ...naming the status it is in', r.body?.error?.status === status, r.body?.error);
      if (!id) await send('DELETE', `/api/job-cards/${target}`);
    }
    {
      // A Completed job card with nothing to bill.
      const free = await send('POST', '/api/job-cards', {
        customerId: C, vehicleId: V, mechanicId: M, date: '2026-09-18',
        complaint: 'C-7: goodwill, no charge',
        services: [{ serviceId: S, name: 'Goodwill check', qty: 1, unitPrice: 0 }],
      });
      const F = free.body?.data?.id;
      t('a job card can total zero', free.body?.data?.total === 0, free.body?.data);
      await setStatus(F, 'Inspection');
      await setStatus(F, 'In Progress');
      await setStatus(F, 'Completed');
      const r = await send('POST', '/api/invoices', { jobCardId: F });
      t('a job card with nothing to bill -> 409', r.status === 409, r.body);
      t('   ...reason', r.body?.error?.reason === 'nothing_to_invoice', r.body?.error);
      t('   ...with the client\'s wording',
        r.body?.error?.message === 'This Job Card has no billable amount.', r.body?.error);
    }
    for (const [why, body] of [
      ['a missing jobCardId', {}],
      ['a blank jobCardId', { jobCardId: '   ' }],
      ['a client-supplied total', { jobCardId: 'JOB-9002', total: 1 }],
      ['a client-supplied paid', { jobCardId: 'JOB-9002', paid: 1 }],
      ['client-supplied lines', { jobCardId: 'JOB-9002', services: [] }],
      ['a client-supplied status', { jobCardId: 'JOB-9002', status: 'Paid' }],
    ]) {
      const r = await send('POST', '/api/invoices', body);
      t(`${why} -> 422`, r.status === 422, { status: r.status, body: r.body });
    }
    const bad = await send('POST', '/api/invoices', 'not json');
    t('a malformed body -> 400', bad.status === 400, bad.status);
    for (const m of ['PUT', 'DELETE', 'PATCH']) {
      const r = await get('/api/invoices', { method: m });
      t(`${m} on the invoice list -> 405 + Allow`,
        r.status === 405 && r.allow === 'GET, POST', { status: r.status, allow: r.allow });
    }
    for (const m of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const r = await get('/api/invoices/INV-9001/void', { method: m });
      t(`${m} on the void path -> 405 + Allow: POST`,
        r.status === 405 && r.allow === 'POST', { status: r.status, allow: r.allow });
    }
  }

  /* ---- 18i. audit Finding 7, on the fixtures that were built for it ---- */
  {
    // INV-9001 carries PAY-9001 (Active, no job card of its own) and PAY-9003
    // (already Void). Its job card JOB-9001 points back at it.
    const before = (await get('/api/invoices/INV-9001')).body?.data;
    const payBefore = (await get('/api/payments?limit=1000')).body?.data ?? [];
    const p1Before = payBefore.find((p) => p.id === 'PAY-9001');
    const p3Before = payBefore.find((p) => p.id === 'PAY-9003');
    t('the fixture invoice starts Paid with both payments attached',
      before.status === 'Paid' && p1Before.invoiceId === 'INV-9001'
        && p3Before.invoiceId === 'INV-9001', { before, p1Before, p3Before });
    t('   ...one Active and one already Void',
      p1Before.status === 'Active' && p3Before.status === 'Void', { p1Before, p3Before });
    t('   ...and the Active one has no job card of its own', p1Before.jobCardId === null, p1Before);

    const voided = await send('POST', '/api/invoices/INV-9001/void');
    t('voiding it -> 200', voided.status === 200, voided.body);
    t('   ...releases exactly one payment', voided.body?.released === 1, voided.body?.released);

    const payAfter = (await get('/api/payments?limit=1000')).body?.data ?? [];
    const p1 = payAfter.find((p) => p.id === 'PAY-9001');
    const p3 = payAfter.find((p) => p.id === 'PAY-9003');
    t('the Active payment became an advance', p1.invoiceId === null, p1);
    t('   ...inheriting the invoice\'s job card so Reports can still trace it',
      p1.jobCardId === 'JOB-9001', p1);
    t('   ...with its amount untouched', p1.amount === p1Before.amount, { before: p1Before, after: p1 });
    t('   ...its date untouched', p1.date === p1Before.date, p1);
    t('   ...its method untouched', p1.method === p1Before.method, p1);
    t('   ...its notes untouched', p1.notes === p1Before.notes, p1);
    t('   ...its customer untouched', p1.customerId === p1Before.customerId, p1);
    t('   ...and it is still Active — the cash arrived, only the document was cancelled',
      p1.status === 'Active', p1);
    t('the Void payment was left exactly as it was',
      JSON.stringify(p3) === JSON.stringify(p3Before), { before: p3Before, after: p3 });
    t('   ...link and all', p3.invoiceId === 'INV-9001', p3);

    const inv = (await get('/api/invoices/INV-9001')).body?.data;
    t('the invoice is Void', inv.status === 'Void', inv);
    t('   ...its paid stays frozen at what it had collected', inv.paid === before.paid, {
      before: before.paid, after: inv.paid });
    t('   ...and its due with it', inv.due === before.due, { before: before.due, after: inv.due });
    t('   ...its total is unchanged', inv.total === before.total, inv);
    t('   ...and so are its line snapshots',
      JSON.stringify(inv.services) === JSON.stringify(before.services)
        && JSON.stringify(inv.partsUsed) === JSON.stringify(before.partsUsed), inv);
    t('   ...it still names the job card it billed', inv.jobCardId === 'JOB-9001', inv);
    t('the job card is un-invoiced again',
      (await get('/api/job-cards/JOB-9001')).body?.data?.invoiceId === null,
      (await get('/api/job-cards/JOB-9001')).body?.data?.invoiceId);

    // An invoice with no job card of its own: the released payment inherits
    // nothing, because there is nothing to inherit.
    const p5Before = payBefore.find((p) => p.id === 'PAY-9005');
    t('INV-9003 has an Active payment and no job card',
      p5Before.invoiceId === 'INV-9003' && p5Before.jobCardId === null, p5Before);
    const v3 = await send('POST', '/api/invoices/INV-9003/void');
    t('voiding it -> 200', v3.status === 200, v3.body);
    t('   ...releases its one payment', v3.body?.released === 1, v3.body?.released);
    const p5 = (await get('/api/payments/PAY-9005')).body?.data;
    t('   ...which becomes an advance with no job card to inherit',
      p5.invoiceId === null && p5.jobCardId === null, p5);
    t('   ...its amount kept to the paisa', p5.amount === 150.25, p5);
    t('   ...and the invoice keeps its frozen figures',
      (await get('/api/invoices/INV-9003')).body?.data?.paid === 150, 
      (await get('/api/invoices/INV-9003')).body?.data);

    // An invoice with no payments at all.
    const v4 = await send('POST', '/api/invoices/INV-9004/void');
    t('voiding an invoice with no payments -> 200', v4.status === 200, v4.body);
    t('   ...releases none', v4.body?.released === 0, v4.body?.released);

    // And the already-Void fixture refuses.
    const v2 = await send('POST', '/api/invoices/INV-9002/void');
    t('voiding the already-Void fixture -> 409', v2.status === 409, v2.body);
    t('   ...and its released advance PAY-9002 is untouched',
      (await get('/api/payments/PAY-9002')).body?.data?.jobCardId === 'JOB-9001');

    const ghost = await send('POST', '/api/invoices/INV-7777/void');
    t('voiding an unknown invoice -> 404', ghost.status === 404, ghost.status);
    t('   ...with the client\'s wording', ghost.body?.error?.message === 'Invoice not found.',
      ghost.body?.error);

    // A Void payment still points here, so the schema itself refuses the delete
    // even though the frontend's own two guards would have allowed it.
    const frozen = await send('PUT', '/api/invoices/INV-9004', { notes: 'voided in error' });
    t('a Void invoice\'s notes are still editable', frozen.status === 200, frozen.body);
    const delPaid = await send('DELETE', '/api/invoices/INV-9001');
    t('deleting the Void invoice that collected money -> 409', delPaid.status === 409, delPaid.body);
    t('   ...reason', delPaid.body?.error?.reason === 'invoice_has_payments', delPaid.body?.error);
  }

  /* ---- 18j. concurrency ---- */
  {
    // A. two simultaneous creates for one job card.
    const J = await completedJob({ complaint: 'C-7: create race' });
    const [a, b] = await Promise.all([
      send('POST', '/api/invoices', { jobCardId: J }),
      send('POST', '/api/invoices', { jobCardId: J }),
    ]);
    t('two simultaneous creates for one job card: exactly one succeeds',
      [a.status, b.status].filter((c) => c === 201).length === 1, { a: a.status, b: b.status });
    t('   ...and exactly one is refused', [a.status, b.status].filter((c) => c === 409).length === 1,
      { a: a.status, b: b.status });
    t('   ...neither is a 5xx', ![a.status, b.status].some((c) => c >= 500), [a.status, b.status]);
    t('   ...the refusal names the duplicate rule',
      [a, b].find((r) => r.status === 409)?.body?.error?.reason === 'invoice_exists',
      [a.body?.error, b.body?.error]);
    const live = (await get('/api/invoices?limit=1000')).body?.data
      ?.filter((x) => x.jobCardId === J && x.status !== 'Void');
    t('   ...and the job card has exactly ONE live invoice', live.length === 1, live);
    const I = live[0].id;
    t('   ...which is the one the job card points at',
      (await get(`/api/job-cards/${J}`)).body?.data?.invoiceId === I);

    // B. two simultaneous voids of the same invoice.
    const [v1, v2] = await Promise.all([
      send('POST', `/api/invoices/${I}/void`),
      send('POST', `/api/invoices/${I}/void`),
    ]);
    t('two simultaneous voids: exactly one succeeds',
      [v1.status, v2.status].filter((c) => c === 200).length === 1, { v1: v1.status, v2: v2.status });
    t('   ...and exactly one is refused', [v1.status, v2.status].filter((c) => c === 409).length === 1,
      { v1: v1.status, v2: v2.status });
    t('   ...neither is a 5xx', ![v1.status, v2.status].some((c) => c >= 500), [v1.status, v2.status]);
    t('   ...the invoice is Void', (await get(`/api/invoices/${I}`)).body?.data?.status === 'Void');
    t('   ...and the job card is unlinked once',
      (await get(`/api/job-cards/${J}`)).body?.data?.invoiceId === null);

    // C. a void racing a create for the same job card.
    const J2 = await completedJob({ complaint: 'C-7: void and create race' });
    const first = await send('POST', '/api/invoices', { jobCardId: J2 });
    const I2 = first.body?.data?.id;
    const [vr, cr] = await Promise.all([
      send('POST', `/api/invoices/${I2}/void`),
      send('POST', '/api/invoices', { jobCardId: J2 }),
    ]);
    t('a void racing a create: neither is a 5xx',
      vr.status < 500 && cr.status < 500, { void: vr.status, create: cr.status });
    const liveNow = (await get('/api/invoices?limit=1000')).body?.data
      ?.filter((x) => x.jobCardId === J2 && x.status !== 'Void');
    t('   ...and the job card never ends with two live invoices',
      liveNow.length <= 1, liveNow.map((x) => [x.id, x.status]));
    const linked = (await get(`/api/job-cards/${J2}`)).body?.data?.invoiceId;
    t('   ...the job card points at the live one, or at none',
      liveNow.length === 1 ? linked === liveNow[0].id : linked === null,
      { linked, live: liveNow.map((x) => x.id) });

    // D. a twelve-way burst of creates for one job card.
    const J3 = await completedJob({ complaint: 'C-7: burst' });
    const results = await Promise.all(
      Array.from({ length: 12 }, () => send('POST', '/api/invoices', { jobCardId: J3 })));
    t('twelve simultaneous creates for one job card: exactly one succeeds',
      results.filter((r) => r.status === 201).length === 1, results.map((r) => r.status));
    t('   ...the other eleven are refused',
      results.filter((r) => r.status === 409).length === 11, results.map((r) => r.status));
    t('   ...none is a 5xx', !results.some((r) => r.status >= 500), results.map((r) => r.status));
    t('   ...and exactly one invoice exists for it',
      (await get('/api/invoices?limit=1000')).body?.data?.filter((x) => x.jobCardId === J3).length === 1);
  }

  /* ---- 18k. nothing anywhere in this section moved stock ---- */
  {
    const rows = (await get('/api/inventory-transactions?limit=1000')).body?.data ?? [];
    t('no ledger row in this database mentions an invoice',
      rows.every((x) => x.referenceType !== 'invoice'), rows.map((x) => x.referenceType));
    t('   ...and every job-card row still chains prev -> new',
      rows.every((x) => {
        const delta = ['purchase', 'adjustment-in', 'return', 'initial-stock'].includes(x.type)
          ? x.quantity : -x.quantity;
        return Math.abs((x.prevStock + delta) - x.newStock) < 1e-9;
      }), rows.filter((x) => {
        const delta = ['purchase', 'adjustment-in', 'return', 'initial-stock'].includes(x.type)
          ? x.quantity : -x.quantity;
        return Math.abs((x.prevStock + delta) - x.newStock) >= 1e-9;
      }));
  }

  // cleanup.sql's sweep removes the rows this section created, in FK order,
  // and resets the counters the ids came from.
}

sec('19. Payment writes: the invoice balance follows the money, against real D1');
{
  const cust = await send('POST', '/api/customers', { name: 'C-8 Payment Customer', phone: '01988-000001' });
  const C = cust.body?.data?.id;
  const other = await send('POST', '/api/customers', { name: 'C-8 Other Customer', phone: '01988-000002' });
  const C2 = other.body?.data?.id;
  const veh = await send('POST', '/api/vehicles',
    { customerId: C, regNo: 'DHA-C8-01', brand: 'Toyota', model: 'Probe' });
  const V = veh.body?.data?.id;
  const mech = await send('POST', '/api/mechanics',
    { name: 'C-8 Payment Mechanic', phone: '01988-000003', specialization: 'Engine' });
  const M = mech.body?.data?.id;
  const svc = await send('POST', '/api/services',
    { name: 'C-8 Payment Service', category: 'Engine', price: 100 });
  const S = svc.body?.data?.id;
  t('the section has its own customer, vehicle, mechanic and service',
    [C, V, C2, M, S].every(Boolean), { C, V, C2, M, S });

  const setStatus = (id, status) => send('POST', `/api/job-cards/${id}/status`, { status });
  const invoiceOf = async (id) => (await get(`/api/invoices/${id}`)).body?.data;
  const paymentOf = async (id) => (await get(`/api/payments/${id}`)).body?.data;
  const jobOf = async (id) => (await get(`/api/job-cards/${id}`)).body?.data;

  /** A Completed job card billed for `total`, and the invoice made from it. */
  const billed = async (total, over = {}) => {
    const j = await send('POST', '/api/job-cards', {
      customerId: C, vehicleId: V, mechanicId: M,
      date: '2026-09-18', complaint: 'C-8: to be paid',
      services: [{ serviceId: S, name: 'C-8 Service (as sold)', qty: 1, unitPrice: total }],
      ...over,
    });
    const J = j.body?.data?.id;
    await setStatus(J, 'Inspection');
    await setStatus(J, 'In Progress');
    await setStatus(J, 'Completed');
    const inv = await send('POST', '/api/invoices', { jobCardId: J });
    return { J, I: inv.body?.data?.id, invoice: inv.body?.data, job: j.body?.data };
  };
  // Every invoice this section records or links a payment against. The balance
  // invariant below holds for these and only these: an invoice created from a
  // job card INHERITS that job card's `paid` (C-7), which no payment row backs,
  // and it keeps that figure until a payment operation recomputes it.
  const settled = new Set();
  const pay = async (body) => {
    const r = await send('POST', '/api/payments', { customerId: C, ...body });
    if (body.invoiceId) settled.add(body.invoiceId);
    return r;
  };
  const linkTo = async (paymentId, invoiceId) => {
    const r = await send('POST', `/api/payments/${paymentId}/link`, { invoiceId });
    settled.add(invoiceId);
    return r;
  };

  /* ---- 19a. an advance touches no invoice ---- */
  {
    const before = (await get('/api/invoices?limit=1000')).body?.data ?? [];
    const adv = await pay({ amount: 500, method: 'Cash', notes: '  counter cash  ' });
    t('POST an advance -> 201', adv.status === 201, adv.body);
    const A = adv.body?.data?.id;
    t('   ...allocated a real PAY id', /^PAY-\d{4}$/.test(A || ''), A);
    t('   ...with no invoice', adv.body?.data?.invoiceId === null, adv.body?.data);
    t('   ...and no job card', adv.body?.data?.jobCardId === null, adv.body?.data);
    t('   ...status Active', adv.body?.data?.status === 'Active', adv.body?.data);
    t('   ...the note trimmed', adv.body?.data?.notes === 'counter cash', adv.body?.data);
    t('   ...the date defaulted to the workshop\'s calendar day',
      adv.body?.data?.date === new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date()), adv.body?.data?.date);
    t('   ...and a GET returns exactly what the POST reported',
      JSON.stringify(await paymentOf(A)) === JSON.stringify(adv.body?.data));
    const after = (await get('/api/invoices?limit=1000')).body?.data ?? [];
    t('   ...and no invoice changed at all',
      JSON.stringify(after) === JSON.stringify(before), { before, after });
    await send('POST', `/api/payments/${A}/void`);
    await send('DELETE', `/api/payments/${A}`);
  }

  /* ---- 19b. a linked payment moves the balance ---- */
  {
    const { J, I, invoice, job } = await billed(1000);
    t('a fresh invoice is Unpaid with the whole total due',
      invoice.status === 'Unpaid' && invoice.paid === 0 && invoice.due === 1000, invoice);
    const jobBefore = await jobOf(J);

    const p1 = await pay({ invoiceId: I, amount: 400, method: 'Card' });
    t('a part payment -> 201', p1.status === 201, p1.body);
    const inv1 = await invoiceOf(I);
    t('   ...the invoice is Partial', inv1.status === 'Partial', inv1);
    t('   ...paid is the sum of its Active payments', inv1.paid === 400, inv1);
    t('   ...and due is the rest', inv1.due === 600, inv1);
    t('   ...its total is untouched', inv1.total === 1000, inv1);

    const over = await pay({ invoiceId: I, amount: 700 });
    t('a payment larger than the due -> 409', over.status === 409, over.body);
    t('   ...reason', over.body?.error?.reason === 'overpayment', over.body?.error);
    t('   ...reporting the live outstanding due', over.body?.error?.outstandingDue === 600,
      over.body?.error);
    t('   ...and the balance did not move', (await invoiceOf(I)).paid === 400);
    t('   ...nor was a payment written',
      ((await get('/api/payments?limit=1000')).body?.data ?? [])
        .filter((p) => p.invoiceId === I).length === 1);

    const exact = await pay({ invoiceId: I, amount: 600 });
    t('the exact remaining balance -> 201', exact.status === 201, exact.body);
    const inv2 = await invoiceOf(I);
    t('   ...settles the invoice', inv2.status === 'Paid' && inv2.paid === 1000 && inv2.due === 0, inv2);

    const another = await pay({ invoiceId: I, amount: 1 });
    t('anything more -> 409', another.status === 409, another.body);
    t('   ...with nothing outstanding', another.body?.error?.outstandingDue === 0, another.body?.error);

    // The whole point of the phase: a job card's money never moves.
    const jobAfter = await jobOf(J);
    t('the job card\'s paid and due never changed',
      jobAfter.paid === jobBefore.paid && jobAfter.due === jobBefore.due,
      { before: jobBefore, after: jobAfter });
    t('   ...nor anything else about it', JSON.stringify(jobAfter) === JSON.stringify(jobBefore));

    /* ---- 19c. voiding a payment gives the balance back ---- */
    const P = exact.body?.data?.id;
    const voided = await send('POST', `/api/payments/${P}/void`);
    t('voiding a payment -> 200', voided.status === 200, voided.body);
    t('   ...the payment is Void', voided.body?.data?.status === 'Void', voided.body?.data);
    t('   ...its amount is untouched', voided.body?.data?.amount === 600, voided.body?.data);
    t('   ...its date, method and customer too',
      voided.body?.data?.date === exact.body?.data?.date
        && voided.body?.data?.method === exact.body?.data?.method
        && voided.body?.data?.customerId === C, voided.body?.data);
    t('   ...and it keeps its invoice link', voided.body?.data?.invoiceId === I, voided.body?.data);
    const inv3 = await invoiceOf(I);
    t('   ...but the invoice stops counting it',
      inv3.paid === 400 && inv3.due === 600 && inv3.status === 'Partial', inv3);

    const again = await send('POST', `/api/payments/${P}/void`);
    t('voiding it a second time -> 409', again.status === 409, again.body);
    t('   ...reason', again.body?.error?.reason === 'payment_void', again.body?.error);
    t('   ...and the balance did not fall twice', (await invoiceOf(I)).paid === 400);

    /* ---- 19d. delete is void-only ---- */
    const activeDel = await send('DELETE', `/api/payments/${p1.body?.data?.id}`);
    t('deleting an Active payment -> 409', activeDel.status === 409, activeDel.body);
    t('   ...reason', activeDel.body?.error?.reason === 'payment_active', activeDel.body?.error);
    t('   ...and it is still there', (await paymentOf(p1.body?.data?.id))?.status === 'Active');

    const voidDel = await send('DELETE', `/api/payments/${P}`);
    t('deleting a Void payment -> 200', voidDel.status === 200, voidDel.body);
    t('   ...it is really gone', (await get(`/api/payments/${P}`)).status === 404);
    t('   ...and the balance is unchanged, because a Void payment counted for nothing',
      (await invoiceOf(I)).paid === 400, await invoiceOf(I));

    /* ---- 19e. notes are the only edit ---- */
    const PA = p1.body?.data?.id;
    const noted = await send('PUT', `/api/payments/${PA}`, { notes: '  receipt 42  ' });
    t('PUT notes -> 200', noted.status === 200, noted.body);
    t('   ...stored trimmed', noted.body?.data?.notes === 'receipt 42', noted.body?.data);
    t('   ...and every historical figure survives',
      noted.body?.data?.amount === 400 && noted.body?.data?.method === 'Card'
        && noted.body?.data?.invoiceId === I, noted.body?.data);
    t('   ...the invoice balance did not move', (await invoiceOf(I)).paid === 400);
    for (const [field, value] of [
      ['amount', 1], ['date', '2026-01-01'], ['method', 'Cash'], ['status', 'Void'],
      ['invoiceId', 'INV-9004'], ['customerId', C2], ['jobCardId', J],
    ]) {
      const bad = await send('PUT', `/api/payments/${PA}`, { [field]: value });
      t(`editing \`${field}\` -> 422`, bad.status === 422, { status: bad.status, body: bad.body });
    }
    const nothing = await send('PUT', `/api/payments/${PA}`, {});
    t('an empty edit -> 422', nothing.status === 422, nothing.body);
  }

  /* ---- 19f. field validation, over real HTTP ---- */
  {
    for (const [why, body] of [
      ['a missing customerId', { amount: 100 }],
      ['a missing amount', { customerId: C }],
      ['a zero amount', { customerId: C, amount: 0 }],
      ['a negative amount', { customerId: C, amount: -1 }],
      ['an unknown method', { customerId: C, amount: 10, method: 'Cheque' }],
      ['a non-ISO date', { customerId: C, amount: 10, date: '18/09/2026' }],
      ['a client-supplied status', { customerId: C, amount: 10, status: 'Void' }],
      ['a client-supplied id', { customerId: C, amount: 10, id: 'PAY-9999' }],
    ]) {
      const r = await send('POST', '/api/payments', body);
      t(`${why} -> 422`, r.status === 422, { status: r.status, body: r.body });
    }
    const badCustomer = await send('POST', '/api/payments', { customerId: 'CUS-7777', amount: 10 });
    t('an unknown customer -> 409, from the foreign key', badCustomer.status === 409, badCustomer.body);
    const badInvoice = await pay({ invoiceId: 'INV-7777', amount: 10 });
    t('an unknown invoice -> 409', badInvoice.status === 409, badInvoice.body);
    t('   ...reason', badInvoice.body?.error?.reason === 'invoice_not_found', badInvoice.body?.error);
    const voidInv = await pay({ invoiceId: 'INV-9002', amount: 10 });
    t('a payment against a Void invoice -> 409', voidInv.status === 409, voidInv.body);
    t('   ...reason', voidInv.body?.error?.reason === 'invoice_void', voidInv.body?.error);
    t('   ...with the client\'s wording',
      voidInv.body?.error?.message === 'Cannot record a payment against a Void invoice.',
      voidInv.body?.error);
    const bad = await send('POST', '/api/payments', 'not json');
    t('a malformed body -> 400', bad.status === 400, bad.status);
    for (const m of ['PUT', 'DELETE', 'PATCH']) {
      const r = await get('/api/payments', { method: m });
      t(`${m} on the payment list -> 405 + Allow`,
        r.status === 405 && r.allow === 'GET, POST', { status: r.status, allow: r.allow });
    }
    for (const action of ['void', 'link']) {
      const r = await get(`/api/payments/PAY-9001/${action}`, { method: 'GET' });
      t(`GET on the ${action} path -> 405 + Allow: POST`,
        r.status === 405 && r.allow === 'POST', { status: r.status, allow: r.allow });
    }
  }

  /* ---- 19g. linking an advance ---- */
  {
    const { I } = await billed(1000);
    const adv = await pay({ amount: 300 });
    const A = adv.body?.data?.id;

    const wrongCustomer = await send('POST', '/api/payments', { customerId: C2, amount: 100 });
    const W = wrongCustomer.body?.data?.id;
    const mismatched = await linkTo(W, I);
    t('linking another customer\'s advance -> 409', mismatched.status === 409, mismatched.body);
    t('   ...reason', mismatched.body?.error?.reason === 'customer_mismatch', mismatched.body?.error);
    t('   ...and the balance did not move', (await invoiceOf(I)).paid === 0);

    const linked = await linkTo(A, I);
    t('linking an advance -> 200', linked.status === 200, linked.body);
    t('   ...the payment now names the invoice', linked.body?.data?.invoiceId === I, linked.body?.data);
    t('   ...its amount is unchanged', linked.body?.data?.amount === 300, linked.body?.data);
    const inv = await invoiceOf(I);
    t('   ...and the invoice counts it',
      inv.paid === 300 && inv.due === 700 && inv.status === 'Partial', inv);

    const twice = await linkTo(A, I);
    t('linking it again -> 409', twice.status === 409, twice.body);
    t('   ...reason', twice.body?.error?.reason === 'payment_already_linked', twice.body?.error);
    t('   ...and the balance did not double', (await invoiceOf(I)).paid === 300);

    const big = await pay({ amount: 9999 });
    const B = big.body?.data?.id;
    const overLink = await linkTo(B, I);
    t('linking an advance larger than the due -> 409', overLink.status === 409, overLink.body);
    t('   ...reason', overLink.body?.error?.reason === 'overpayment', overLink.body?.error);
    t('   ...reporting the live outstanding due', overLink.body?.error?.outstandingDue === 700,
      overLink.body?.error);
    t('   ...and the payment is still an advance', (await paymentOf(B))?.invoiceId === null);

    await send('POST', `/api/payments/${B}/void`);
    const voidLink = await linkTo(B, I);
    t('linking a voided payment -> 409', voidLink.status === 409, voidLink.body);
    t('   ...reason', voidLink.body?.error?.reason === 'payment_void', voidLink.body?.error);

    const ghost = await send('POST', '/api/payments/PAY-7777/link', { invoiceId: I });
    t('linking an unknown payment -> 404', ghost.status === 404, ghost.status);
    t('   ...with the client\'s wording', ghost.body?.error?.message === 'Payment not found.',
      ghost.body?.error);
    const noTarget = await send('POST', `/api/payments/${W}/link`, {});
    t('linking with no invoice named -> 422', noTarget.status === 422, noTarget.body);
  }

  /* ---- 19h. C-7 compatibility: void an invoice, then re-apply its advance ---- */
  {
    const { J, I } = await billed(1000);
    const jobBefore = await jobOf(J);
    const p = await pay({ invoiceId: I, amount: 400 });
    const P = p.body?.data?.id;
    t('an invoice with a payment on it is Partial', (await invoiceOf(I)).status === 'Partial');

    const voidedInv = await send('POST', `/api/invoices/${I}/void`);
    t('voiding the invoice -> 200', voidedInv.status === 200, voidedInv.body);
    t('   ...releases its one payment', voidedInv.body?.released === 1, voidedInv.body?.released);

    const released = await paymentOf(P);
    t('the payment became an advance', released.invoiceId === null, released);
    t('   ...and is still Active', released.status === 'Active', released);
    t('   ...inheriting the voided invoice\'s job card', released.jobCardId === J, released);
    t('   ...with its amount, date and method untouched',
      released.amount === 400 && released.date === p.body?.data?.date
        && released.method === p.body?.data?.method, released);
    const oldInv = await invoiceOf(I);
    t('the voided invoice keeps its frozen figures',
      oldInv.status === 'Void' && oldInv.paid === 400 && oldInv.due === 600, oldInv);

    const reInvoice = await send('POST', '/api/invoices', { jobCardId: J });
    t('the job card can be invoiced again -> 201', reInvoice.status === 201, reInvoice.body);
    const I2 = reInvoice.body?.data?.id;
    // The released payment inherited J, so it is J's advance, and creating
    // J's new invoice applies it in the same write (Job Card Advance).
    t('   ...and applies the released advance on create',
      JSON.stringify((reInvoice.body?.appliedAdvances || []).map((a) => a.id)) === JSON.stringify([P])
        && reInvoice.body?.data?.status === 'Partial' && reInvoice.body?.data?.paid === 400,
      reInvoice.body);
    t('   ...linking it again by hand is refused',
      (await linkTo(P, I2)).body?.error?.reason === 'payment_already_linked');
    t('the released advance is linked to the new invoice', (await paymentOf(P))?.invoiceId === I2, await paymentOf(P));
    const inv2 = await invoiceOf(I2);
    t('   ...which now counts it',
      inv2.paid === 400 && inv2.due === 600 && inv2.status === 'Partial', inv2);
    t('   ...and the payment keeps the job card it inherited',
      (await paymentOf(P))?.jobCardId === J, await paymentOf(P));

    const stillOld = await invoiceOf(I);
    t('the voided invoice is untouched by any of it',
      JSON.stringify(stillOld) === JSON.stringify(oldInv), { before: oldInv, after: stillOld });
    const jobAfter = await jobOf(J);
    t('and the job card\'s own money never moved through the whole flow',
      jobAfter.paid === jobBefore.paid && jobAfter.due === jobBefore.due,
      { before: jobBefore, after: jobAfter });
  }

  /* ---- 19h2. Job Card Advance: recorded advances applied on invoice create ---- */
  {
    /** A job card walked to In Progress (not yet invoiceable). */
    const openJob = async (total) => {
      const j = await send('POST', '/api/job-cards', {
        customerId: C, vehicleId: V, mechanicId: M,
        date: '2026-09-18', complaint: 'Job Card Advance',
        services: [{ serviceId: S, name: 'Advance Service (as sold)', qty: 1, unitPrice: total }],
        paid: 250,   // a typed figure: never applied, never copied
      });
      const J = j.body?.data?.id;
      await setStatus(J, 'Inspection');
      await setStatus(J, 'In Progress');
      return J;
    };
    const createFor = async (J) => {
      const r = await send('POST', '/api/invoices', { jobCardId: J });
      if (r.body?.data?.id) settled.add(r.body.data.id);
      return r;
    };

    const J = await openJob(2000);
    const a1 = await send('POST', '/api/payments',
      { customerId: C, jobCardId: J, amount: 600, date: '2026-09-19', method: 'Mobile Banking' });
    t('an advance on an In Progress job card -> 201', a1.status === 201, a1.body);
    const A1 = a1.body?.data?.id;
    const wrongCust = await send('POST', '/api/payments', { customerId: C2, jobCardId: J, amount: 100 });
    t('an advance from another customer for it -> 409 job_card_customer_mismatch',
      wrongCust.status === 409 && wrongCust.body?.error?.reason === 'job_card_customer_mismatch', wrongCust.body);
    await setStatus(J, 'Completed');
    const a2 = await send('POST', '/api/payments', { customerId: C, jobCardId: J, amount: 400, date: '2026-09-20' });
    const A2 = a2.body?.data?.id;
    const voided = await send('POST', '/api/payments', { customerId: C, jobCardId: J, amount: 50 });
    await send('POST', `/api/payments/${voided.body?.data?.id}/void`);

    const inv = await createFor(J);
    t('creating the invoice -> 201', inv.status === 201, inv.body);
    const I = inv.body?.data?.id;
    t('   ...applies both Active advances, oldest first, and not the void one',
      JSON.stringify((inv.body?.appliedAdvances || []).map((a) => a.id)) === JSON.stringify([A1, A2])
        && inv.body?.appliedAdvanceTotal === 1000, inv.body);
    const live = await invoiceOf(I);
    t('   ...paid/due/status from the ledger, not the typed 250',
      live.paid === 1000 && live.due === 1000 && live.status === 'Partial', live);
    const p1 = await paymentOf(A1);
    t('   ...the advance keeps its date, method and amount, and names both records',
      p1.invoiceId === I && p1.jobCardId === J && p1.date === '2026-09-19'
        && p1.method === 'Mobile Banking' && p1.amount === 600, p1);
    t('   ...the void advance stays unlinked', (await paymentOf(voided.body?.data?.id))?.invoiceId === null);
    const late = await send('POST', '/api/payments', { customerId: C, jobCardId: J, amount: 10 });
    t('an advance after invoicing -> 409 job_card_invoiced',
      late.status === 409 && late.body?.error?.reason === 'job_card_invoiced', late.body);
    const dup = await createFor(J);
    t('creating the invoice again -> 409, nothing doubled',
      dup.status === 409 && (await invoiceOf(I)).paid === 1000, dup.body);

    // over the total: refused whole, nothing written
    const J2 = await openJob(500);
    await send('POST', '/api/payments', { customerId: C, jobCardId: J2, amount: 300 });
    await send('POST', '/api/payments', { customerId: C, jobCardId: J2, amount: 300 });
    await setStatus(J2, 'Completed');
    const over = await createFor(J2);
    t('advances over the total -> 409 advance_exceeds_total',
      over.status === 409 && over.body?.error?.reason === 'advance_exceeds_total'
        && over.body?.error?.advanceTotal === 600 && over.body?.error?.invoiceTotal === 500, over.body);
    t('   ...and the job card is still un-invoiced', (await jobOf(J2))?.invoiceId === null, await jobOf(J2));
  }

  /* ---- 19i. concurrency ---- */
  {
    // C. an overpayment race: 60 + 60 against a total of 100.
    const { I } = await billed(100);
    const [a, b] = await Promise.all([
      pay({ invoiceId: I, amount: 60 }), pay({ invoiceId: I, amount: 60 }),
    ]);
    t('60 + 60 against a total of 100: exactly one succeeds',
      [a.status, b.status].filter((c) => c === 201).length === 1, { a: a.status, b: b.status });
    t('   ...and exactly one is refused', [a.status, b.status].filter((c) => c === 409).length === 1,
      { a: a.status, b: b.status });
    t('   ...neither is a 5xx', ![a.status, b.status].some((c) => c >= 500), [a.status, b.status]);
    t('   ...the refusal is an overpayment',
      [a, b].find((r) => r.status === 409)?.body?.error?.reason === 'overpayment',
      [a.body?.error, b.body?.error]);
    const inv = await invoiceOf(I);
    t('   ...the invoice is never overpaid', inv.paid === 60 && inv.due === 40, inv);
    t('   ...and its due is never negative', inv.due >= 0, inv);
  }
  {
    // D. an exact-balance race: 50 + 50 against a total of 100.
    const { I } = await billed(100);
    const [a, b] = await Promise.all([
      pay({ invoiceId: I, amount: 50 }), pay({ invoiceId: I, amount: 50 }),
    ]);
    t('50 + 50 against a total of 100: both succeed',
      a.status === 201 && b.status === 201, { a: a.status, b: b.status });
    const inv = await invoiceOf(I);
    t('   ...and the invoice settles exactly',
      inv.paid === 100 && inv.due === 0 && inv.status === 'Paid', inv);
  }
  {
    // E. a twelve-way burst of 10 each against a total of 50.
    const { I } = await billed(50);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => pay({ invoiceId: I, amount: 10 })));
    const won = results.filter((r) => r.status === 201);
    t('twelve payments of 10 against a total of 50: five succeed', won.length === 5,
      results.map((r) => r.status));
    t('   ...seven are refused', results.filter((r) => r.status === 409).length === 7,
      results.map((r) => r.status));
    t('   ...none is a 5xx', !results.some((r) => r.status >= 500), results.map((r) => r.status));
    t('   ...every refusal is an overpayment',
      results.filter((r) => r.status === 409)
        .every((r) => r.body?.error?.reason === 'overpayment'),
      results.filter((r) => r.status === 409).map((r) => r.body?.error?.reason));
    const inv = await invoiceOf(I);
    const live = ((await get('/api/payments?limit=1000')).body?.data ?? [])
      .filter((p) => p.invoiceId === I && p.status !== 'Void');
    t('   ...the invoice is exactly Paid', inv.paid === 50 && inv.due === 0 && inv.status === 'Paid', inv);
    t('   ...and paid equals the sum of its live payments',
      inv.paid === live.reduce((s, p) => s + p.amount, 0), { paid: inv.paid, live: live.map((p) => p.amount) });
    t('   ...with exactly five of them', live.length === 5, live.length);

    // A. the same payment voided concurrently.
    const P = won[0].body?.data?.id;
    const [v1, v2] = await Promise.all([
      send('POST', `/api/payments/${P}/void`), send('POST', `/api/payments/${P}/void`),
    ]);
    t('two simultaneous voids of one payment: exactly one succeeds',
      [v1.status, v2.status].filter((c) => c === 200).length === 1, { v1: v1.status, v2: v2.status });
    t('   ...and exactly one is refused', [v1.status, v2.status].filter((c) => c === 409).length === 1,
      { v1: v1.status, v2: v2.status });
    t('   ...neither is a 5xx', ![v1.status, v2.status].some((c) => c >= 500), [v1.status, v2.status]);
    const after = await invoiceOf(I);
    t('   ...the balance fell exactly once', after.paid === 40 && after.due === 10, after);
    t('   ...and the payment is Void once', (await paymentOf(P))?.status === 'Void');
  }
  {
    // B. the same advance linked concurrently, to two different invoices.
    const first = await billed(1000);
    const second = await billed(1000);
    const adv = await pay({ amount: 300 });
    const A = adv.body?.data?.id;
    const [l1, l2] = await Promise.all([linkTo(A, first.I), linkTo(A, second.I)]);
    t('one advance linked to two invoices at once: exactly one succeeds',
      [l1.status, l2.status].filter((c) => c === 200).length === 1, { l1: l1.status, l2: l2.status });
    t('   ...neither is a 5xx', ![l1.status, l2.status].some((c) => c >= 500), [l1.status, l2.status]);
    const p = await paymentOf(A);
    const inv1 = await invoiceOf(first.I);
    const inv2 = await invoiceOf(second.I);
    t('   ...the payment names exactly one of them',
      p.invoiceId === first.I || p.invoiceId === second.I, p);
    t('   ...only that invoice counts it',
      (p.invoiceId === first.I ? inv1.paid === 300 && inv2.paid === 0
        : inv2.paid === 300 && inv1.paid === 0),
      { linked: p.invoiceId, inv1, inv2 });
    t('   ...and the other is still Unpaid with its whole total due',
      (p.invoiceId === first.I ? inv2.due === 1000 && inv2.status === 'Unpaid'
        : inv1.due === 1000 && inv1.status === 'Unpaid'), { inv1, inv2 });

    // F. the same advance linked twice to the SAME invoice.
    const adv2 = await pay({ amount: 200 });
    const A2 = adv2.body?.data?.id;
    const target = p.invoiceId === first.I ? second.I : first.I;
    const [s1, s2] = await Promise.all([linkTo(A2, target), linkTo(A2, target)]);
    t('one advance linked twice to one invoice: exactly one succeeds',
      [s1.status, s2.status].filter((c) => c === 200).length === 1, { s1: s1.status, s2: s2.status });
    t('   ...and the invoice counts it once',
      (await invoiceOf(target)).paid === 200, await invoiceOf(target));
  }

  /* ---- 19j. the invariant, across every invoice this database holds ---- */
  {
    const invoices = (await get('/api/invoices?limit=1000')).body?.data ?? [];
    const payments = (await get('/api/payments?limit=1000')).body?.data ?? [];
    const live = (id) => payments
      .filter((p) => p.invoiceId === id && p.status !== 'Void')
      .reduce((s, p) => s + p.amount, 0);

    const wrong = invoices.filter((i) => {
      if (i.status === 'Void') return false;          // frozen, never recomputed
      if (!settled.has(i.id)) return false;           // still carrying C-7's inherited figure
      const paid = Math.min(i.total, Math.max(0, live(i.id)));
      const due = Math.max(i.total - paid, 0);
      const status = i.total > 0 && paid >= i.total ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid';
      return i.paid !== paid || i.due !== due || i.status !== status;
    });
    t('the section really did record payments against several invoices',
      settled.size >= 6, settled.size);
    t('every invoice a payment touched agrees with the sum of its Active payments',
      wrong.length === 0,
      wrong.map((i) => ({ id: i.id, paid: i.paid, due: i.due, status: i.status, live: live(i.id) })));
    // And the other half of the same rule: an invoice no payment has touched
    // still holds exactly what its job card handed it, which is what makes
    // C-7's snapshot and C-8's recomputation two different things.
    const untouched = invoices.filter((i) => i.status !== 'Void' && !settled.has(i.id));
    t('   ...while one no payment has touched keeps its inherited figure',
      untouched.every((i) => i.paid >= 0 && i.paid <= i.total),
      untouched.map((i) => ({ id: i.id, paid: i.paid, total: i.total })));
    t('   ...no invoice has a negative due', invoices.every((i) => i.due >= 0),
      invoices.filter((i) => i.due < 0));
    t('   ...and none is overpaid', invoices.every((i) => i.paid <= i.total),
      invoices.filter((i) => i.paid > i.total));
    t('a Void payment counts towards nothing',
      payments.filter((p) => p.status === 'Void').every((p) => {
        const inv = invoices.find((i) => i.id === p.invoiceId);
        return !inv || inv.status === 'Void' || inv.paid === live(inv.id);
      }), payments.filter((p) => p.status === 'Void').map((p) => [p.id, p.invoiceId]));
  }

  // cleanup.sql's sweep removes the rows this section created, in FK order,
  // and resets the counters the ids came from.
}

sec('20. Settings writes: the singleton, merged, against real D1');
{
  const before = (await get('/api/settings')).body?.data;
  t('the fixture settings row is there', !!before?.businessName, before);
  const others = async () => ({
    customers: (await get('/api/customers')).body?.total,
    invoices: (await get('/api/invoices')).body?.total,
    payments: (await get('/api/payments')).body?.total,
    jobCards: (await get('/api/job-cards')).body?.total,
  });
  const othersBefore = await others();

  /* ---- 20a. a merge ---- */
  {
    const r = await send('PUT', '/api/settings', { taxRate: 12.5 });
    t('PUT one field -> 200', r.status === 200, r.body);
    t('   ...the field changed', r.body?.data?.taxRate === 12.5, r.body?.data);
    t('   ...and every other field survived',
      r.body?.data?.businessName === before.businessName
        && r.body?.data?.currency === before.currency
        && r.body?.data?.address === before.address
        && JSON.stringify(r.body?.data?.workingDays) === JSON.stringify(before.workingDays),
      { before, after: r.body?.data });
    t('   ...updatedAt is set', !!r.body?.data?.updatedAt, r.body?.data);
    t('   ...and a GET returns exactly what the PUT reported',
      JSON.stringify((await get('/api/settings')).body?.data) === JSON.stringify(r.body?.data));
  }

  /* ---- 20b. updatedAt is the server's ---- */
  {
    const first = await send('PUT', '/api/settings', { taxRate: 6 });
    await new Promise((r) => setTimeout(r, 5));
    const second = await send('PUT', '/api/settings', { taxRate: 6 });
    t('saving the same value again -> 200', second.status === 200, second.body);
    t('   ...and updatedAt moves forward',
      second.body?.data?.updatedAt > first.body?.data?.updatedAt,
      { first: first.body?.data?.updatedAt, second: second.body?.data?.updatedAt });
    const forged = await send('PUT', '/api/settings',
      { taxRate: 6, updatedAt: '2020-01-01T00:00:00.000Z' });
    t('a client-supplied updatedAt -> 422', forged.status === 422, forged.body);
    t('   ...and the stored one is untouched',
      (await get('/api/settings')).body?.data?.updatedAt === second.body?.data?.updatedAt);
  }

  /* ---- 20c. working days round-trip ---- */
  {
    for (const days of [
      ['Sat', 'Sun', 'Mon', 'Tue', 'Wed'],
      ['Sun'],
      [],
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      ['Fri', 'Sat'],
    ]) {
      const r = await send('PUT', '/api/settings', { workingDays: days });
      t(`workingDays ${JSON.stringify(days)} -> 200`, r.status === 200, r.body);
      t('   ...round-trips exactly, order included',
        JSON.stringify(r.body?.data?.workingDays) === JSON.stringify(days), r.body?.data?.workingDays);
      t('   ...and a fresh GET agrees',
        JSON.stringify((await get('/api/settings')).body?.data?.workingDays) === JSON.stringify(days));
    }
    for (const bad of ['Mon', { Mon: true }, ['Monday'], ['mon'], [1], ['Mon', 'Mon']]) {
      const r = await send('PUT', '/api/settings', { workingDays: bad });
      t(`workingDays ${JSON.stringify(bad)} -> 422`, r.status === 422, { status: r.status, body: r.body });
    }
    t('   ...and the last good value survived every refusal',
      JSON.stringify((await get('/api/settings')).body?.data?.workingDays) === JSON.stringify(['Fri', 'Sat']),
      (await get('/api/settings')).body?.data?.workingDays);
  }

  /* ---- 20d. numbers, text and the cross-field rules ---- */
  {
    const full = await send('PUT', '/api/settings', {
      businessName: 'C-9 Workshop', phone: '01999-000001', email: 'c9@example.com',
      website: 'https://c9.example.com', taxId: 'BIN-C9', address: 'C-9 Road, Dhaka',
      businessDescription: 'C-9 description', invoiceFooter: 'C-9 footer',
      paymentTerms: 'C-9 terms', taxRate: 0, currency: 'USD',
      defaultAppointmentDuration: 45, openingTime: '08:30', closingTime: '17:30',
      workingDays: ['Sat', 'Sun'],
    });
    t('a full save -> 200', full.status === 200, full.body);
    t('   ...a tax rate of 0 is a real rate, not a default',
      full.body?.data?.taxRate === 0, full.body?.data);
    t('   ...and persists as 0', (await get('/api/settings')).body?.data?.taxRate === 0);
    t('   ...every field came back as sent',
      full.body?.data?.businessName === 'C-9 Workshop'
        && full.body?.data?.currency === 'USD'
        && full.body?.data?.defaultAppointmentDuration === 45
        && full.body?.data?.openingTime === '08:30', full.body?.data);

    const cleared = await send('PUT', '/api/settings', { defaultAppointmentDuration: '' });
    t('clearing the duration -> 200', cleared.status === 200, cleared.body);
    t('   ...reads back as \'\', the "not recorded" state',
      cleared.body?.data?.defaultAppointmentDuration === '', cleared.body?.data);

    for (const [why, body] of [
      ['a blank business name', { businessName: '  ' }],
      ['a blank phone', { phone: '' }],
      ['a blank address', { address: '   ' }],
      ['a blank currency', { currency: ' ' }],
      ['a long currency', { currency: 'TAKA!!' }],
      ['a malformed email', { email: 'nope' }],
      ['a malformed website', { website: 'not a website' }],
      ['a tax rate above 100', { taxRate: 101 }],
      ['a negative tax rate', { taxRate: -1 }],
      ['a tax rate that is not a number', { taxRate: 'lots' }],
      ['a zero duration', { defaultAppointmentDuration: 0 }],
      ['a malformed opening time', { openingTime: '99:99' }],
      ['a closing time before the stored opening time', { closingTime: '01:00' }],
      ['an id', { id: 2 }],
      ['a theme', { theme: 'dark' }],
    ]) {
      const r = await send('PUT', '/api/settings', body);
      t(`${why} -> 422`, r.status === 422, { status: r.status, body: r.body });
    }
    const bad = await send('PUT', '/api/settings', 'not json');
    t('a malformed body -> 400', bad.status === 400, bad.status);
    const none = await send('PUT', '/api/settings', {});
    t('an empty body -> 422', none.status === 422, none.body);

    t('and the settings survived every refusal intact',
      (await get('/api/settings')).body?.data?.businessName === 'C-9 Workshop',
      (await get('/api/settings')).body?.data);
  }

  /* ---- 20e. methods, and what a settings write never touches ---- */
  {
    for (const m of ['POST', 'PATCH', 'DELETE']) {
      const r = await get('/api/settings', { method: m });
      t(`${m} /api/settings -> 405 + Allow`,
        r.status === 405 && r.allow === 'GET, PUT', { status: r.status, allow: r.allow });
    }
    for (const path of ['/api/settings/1', '/api/settings/', '/api/settings/anything']) {
      const r = await send('PUT', path, { taxRate: 5 });
      t(`PUT ${path} -> 404, a singleton has nothing to address`, r.status === 404, r.status);
    }
    const othersAfter = await others();
    t('no other table changed through any of it',
      JSON.stringify(othersAfter) === JSON.stringify(othersBefore),
      { before: othersBefore, after: othersAfter });
  }
}

sec('21. Authentication: every mutation is gated, against the real Worker');
{
  t('the suite was given a test token to authenticate with', TOKEN.length > 0, TOKEN.length);

  const advertised = (await get('/api/health')).body?.data?.routes ?? [];
  t('health is reachable with no credentials at all',
    (await sendAnon('GET', '/api/health')).status === 200);

  const ID = {
    customers: 'CUS-9001', vehicles: 'VEH-9001', services: 'SRV-9001',
    mechanics: 'MEC-9001', parts: 'PRT-9001', appointments: 'APT-9001',
    'job-cards': 'JOB-9001', invoices: 'INV-9001', payments: 'PAY-9001',
    expenses: 'EXP-9001', 'inventory-transactions': 'STK-9001',
  };
  const concrete = (path) => path.replace(':id', ID[path.split('/')[2]] ?? 'REC-9001');

  /* ---- 21a. every advertised mutation refuses an anonymous caller ---- */
  {
    // POST and DELETE /api/session are how a browser GETS and gives up a
    // credential, so requiring one there would be a closed loop. They are
    // public by necessity and are checked on their own terms in section 22.
    // The Messenger webhook (0014) is public by necessity -- Meta has no
    // session -- and is protected by Meta's App Secret signature instead
    // (tests/unit/api-messenger.test.mjs proves an unsigned POST is refused).
    const SESSION_ROUTES = new Set(['POST /api/session', 'DELETE /api/session', 'POST /api/webhooks/messenger', 'POST /api/webhooks/whatsapp', 'POST /api/forms/submit']);
    const mutations = advertised.filter(
      (r) => /^(POST|PUT|PATCH|DELETE) /.test(r) && !SESSION_ROUTES.has(r));
    t('the registry advertises the mutations to check', mutations.length >= 30, mutations.length);

    const wrong = [];
    for (const route of mutations) {
      const [method, path] = route.split(' ');
      const r = await sendAnon(method, concrete(path), { probe: true });
      if (r.status !== 401 || r.body?.error?.code !== 'unauthorized') {
        wrong.push({ route, status: r.status, code: r.body?.error?.code });
      }
    }
    t('EVERY advertised mutation answers 401 without a token', wrong.length === 0, wrong);
    t('   ...which is all of them', mutations.length - wrong.length === mutations.length);

    const noScheme = [];
    for (const route of mutations) {
      const [method, path] = route.split(' ');
      const r = await sendAnon(method, concrete(path), { probe: true },
        { authorization: `Bearer ${TOKEN}x` });
      if (r.status !== 401) noScheme.push({ route, status: r.status });
    }
    t('   ...and 401 with a wrong token', noScheme.length === 0, noScheme);

    const refused = [];
    for (const route of mutations) {
      const [method, path] = route.split(' ');
      const r = await sendAnon(method, concrete(path), { probe: true },
        { authorization: `Bearer ${TOKEN}` });
      if (r.status === 401) refused.push(route);
    }
    t('   ...and lets the right token through, every time', refused.length === 0, refused);
  }

  /* ---- 21b. every advertised read now needs a credential ----
     C-12 inverted this. Reads were public; a customer list is the shop's
     book of names, phone numbers and addresses, so now they are not. The
     check keeps its shape -- enumerate EVERY advertised GET from the
     registry rather than spot-checking -- and asserts the opposite. */
  {
    const PUBLIC = new Set(['GET /api/health', 'GET /api/session', 'GET /api/webhooks/messenger', 'GET /api/webhooks/whatsapp']);
    const open = [];
    for (const route of advertised.filter((r) => r.startsWith('GET ') && !PUBLIC.has(r))) {
      const [, path] = route.split(' ');
      const r = await sendAnon('GET', concrete(path));
      if (r.status !== 401) open.push({ route, status: r.status });
    }
    t('every advertised GET refuses an unauthenticated caller', open.length === 0, open);

    const health = await sendAnon('GET', '/api/health');
    t('health stays public, because it is how you see the Worker is up',
      health.status === 200, health.status);
    const sess = await sendAnon('GET', '/api/session');
    t('GET /api/session stays public, because it is how you get a credential',
      sess.status === 200, sess.status);
    // `accounts` (0009): whether a staff member may sign in with their own account here.
    t('   ...and reports only whether this caller is signed in, and how signing in works',
      JSON.stringify(Object.keys(sess.body.data).sort()) === '["accounts","authenticated","passphrase"]',
      sess.body.data);
  }

  /* ---- 21c. the refusal itself ---- */
  {
    const shapes = new Set();
    for (const [why, headers] of [
      ['no header', {}],
      ['an empty header', { authorization: '' }],
      ['Basic auth', { authorization: 'Basic dXNlcjpwYXNz' }],
      ['a scheme with no token', { authorization: 'Bearer' }],
      ['a wrong token', { authorization: 'Bearer wrong-token' }],
      ['a prefix of the token', { authorization: `Bearer ${TOKEN.slice(0, -1)}` }],
      ['the token under the wrong scheme', { authorization: `Token ${TOKEN}` }],
      ['the token with no scheme', { authorization: TOKEN }],
    ]) {
      const r = await sendAnon('POST', '/api/customers',
        { name: 'C-9 Should Not Exist', phone: '01900-999999' }, headers);
      t(`${why} -> 401`, r.status === 401, { status: r.status, body: r.body });
      t('   ...with the standard error shape', r.body?.error?.code === 'unauthorized', r.body);
      t('   ...and the Bearer challenge', r.wwwAuthenticate === 'Bearer', r.wwwAuthenticate);
      t('   ...leaking nothing about the secret',
        !JSON.stringify(r.body).includes(TOKEN) && !JSON.stringify(r.body).includes('API_TOKEN'),
        r.body);
      shapes.add(JSON.stringify(r.body));
    }
    t('every refusal is byte-identical — none says which rule it met',
      shapes.size === 1, [...shapes]);
  }

  /* ---- 21d. a refused write changes nothing ---- */
  {
    const before = {
      customers: (await get('/api/customers?limit=1000')).body?.total,
      invoices: (await get('/api/invoices?limit=1000')).body?.total,
      payments: (await get('/api/payments?limit=1000')).body?.total,
      jobCards: (await get('/api/job-cards?limit=1000')).body?.total,
      ledger: (await get('/api/inventory-transactions?limit=1000')).body?.total,
      part: (await get('/api/parts/PRT-9001')).body?.data?.stock,
      invoice: JSON.stringify((await get('/api/invoices/INV-9001')).body?.data),
      payment: JSON.stringify((await get('/api/payments/PAY-9001')).body?.data),
      jobCard: JSON.stringify((await get('/api/job-cards/JOB-9001')).body?.data),
      settings: JSON.stringify((await get('/api/settings')).body?.data),
    };

    // One anonymous attempt at every kind of damage this API can do.
    const attempts = [
      ['POST', '/api/customers', { name: 'Ghost', phone: '01900-000001' }],
      ['DELETE', '/api/customers/CUS-9001', undefined],
      ['PUT', '/api/parts/PRT-9001', { sellingPrice: 1 }],
      ['POST', '/api/inventory-transactions', { partId: 'PRT-9001', type: 'sale', quantity: 5 }],
      ['POST', '/api/job-cards', { customerId: 'CUS-9001', vehicleId: 'VEH-9001', mechanicId: 'MEC-9001', date: '2026-09-18', complaint: 'ghost' }],
      ['POST', '/api/job-cards/JOB-9003/status', { status: 'Completed' }],
      ['PUT', '/api/job-cards/JOB-9003', { notes: 'ghost' }],
      ['DELETE', '/api/job-cards/JOB-9002', undefined],
      ['POST', '/api/invoices', { jobCardId: 'JOB-9001' }],
      ['POST', '/api/invoices/INV-9001/void', {}],
      ['PUT', '/api/invoices/INV-9001', { notes: 'ghost' }],
      ['DELETE', '/api/invoices/INV-9002', undefined],
      ['POST', '/api/payments', { customerId: 'CUS-9001', amount: 100 }],
      ['POST', '/api/payments/PAY-9001/void', {}],
      ['POST', '/api/payments/PAY-9004/link', { invoiceId: 'INV-9004' }],
      ['PUT', '/api/payments/PAY-9001', { notes: 'ghost' }],
      ['DELETE', '/api/payments/PAY-9003', undefined],
      ['PUT', '/api/settings', { businessName: 'Ghost Workshop', taxRate: 99 }],
    ];
    let allRefused = true;
    for (const [method, path, body] of attempts) {
      const r = await sendAnon(method, path, body);
      if (r.status !== 401) { allRefused = false; t(`${method} ${path} -> 401`, false, r); }
    }
    t(`all ${attempts.length} anonymous attempts were refused`, allRefused);

    const after = {
      customers: (await get('/api/customers?limit=1000')).body?.total,
      invoices: (await get('/api/invoices?limit=1000')).body?.total,
      payments: (await get('/api/payments?limit=1000')).body?.total,
      jobCards: (await get('/api/job-cards?limit=1000')).body?.total,
      ledger: (await get('/api/inventory-transactions?limit=1000')).body?.total,
      part: (await get('/api/parts/PRT-9001')).body?.data?.stock,
      invoice: JSON.stringify((await get('/api/invoices/INV-9001')).body?.data),
      payment: JSON.stringify((await get('/api/payments/PAY-9001')).body?.data),
      jobCard: JSON.stringify((await get('/api/job-cards/JOB-9001')).body?.data),
      settings: JSON.stringify((await get('/api/settings')).body?.data),
    };
    t('not one row changed', JSON.stringify(after) === JSON.stringify(before),
      { before, after });
    t('   ...no record was created', after.customers === before.customers
      && after.jobCards === before.jobCards && after.invoices === before.invoices
      && after.payments === before.payments, { before, after });
    t('   ...no stock moved and no ledger row was written',
      after.part === before.part && after.ledger === before.ledger, { before, after });
    t('   ...no invoice balance moved', after.invoice === before.invoice);
    t('   ...no payment was voided or released', after.payment === before.payment);
    t('   ...no job card moved or was reconciled', after.jobCard === before.jobCard);
    t('   ...and the settings are untouched', after.settings === before.settings);
  }

  /* ---- 21e. what the gate does not touch ---- */
  {
    const health = await sendAnon('POST', '/api/health', {});
    t('POST /api/health -> 405, a method error rather than an auth one',
      health.status === 405, health.status);
    t('   ...with Allow: GET', health.allow === 'GET', health.allow);

    const options = await sendAnon('OPTIONS', '/api/customers');
    t('OPTIONS is not treated as a business mutation',
      options.status !== 401, options.status);

    // A record that does not exist must not be distinguishable from one that
    // does, to a caller with no credentials.
    const real = await sendAnon('DELETE', '/api/customers/CUS-9001');
    const ghost = await sendAnon('DELETE', '/api/customers/CUS-7777');
    t('an anonymous DELETE cannot tell a real record from a missing one',
      real.status === 401 && ghost.status === 401
        && JSON.stringify(real.body) === JSON.stringify(ghost.body),
      { real, ghost });
    const badId = await sendAnon('DELETE', '/api/customers/nope');
    t('   ...nor a valid id from a malformed one', badId.status === 401, badId.status);
  }

  /* ---- 21f. the token never appears in a response ---- */
  {
    const surfaces = [
      await sendAnon('GET', '/api/health'),
      await sendAnon('GET', '/api/settings'),
      await sendAnon('GET', '/api/nope'),
      await sendAnon('POST', '/api/customers', { name: 'X' }),
    ];
    t('no response anywhere contains the token',
      surfaces.every((r) => !JSON.stringify(r.body ?? {}).includes(TOKEN)), surfaces.map((r) => r.status));
    t('   ...nor names the secret binding',
      surfaces.every((r) => !JSON.stringify(r.body ?? {}).includes('API_TOKEN')));
    const healthBody = JSON.stringify((await get('/api/health')).body);
    t('   ...and health, which reports configuration, reveals neither',
      !healthBody.includes(TOKEN) && !healthBody.includes('API_TOKEN'), healthBody.slice(0, 120));
  }
}

sec('22. Sessions: the signed cookie, against the real Worker');
{
  const PASSPHRASE = process.env.TAQWA_PASSPHRASE || '';
  const login = async (passphrase, headers = {}) => {
    const res = await fetch(`${BASE}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ passphrase }),
    });
    return { status: res.status, setCookie: res.headers.get('set-cookie') };
  };
  const withCookie = async (method, path, cookie, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, body: parsed, setCookie: res.headers.get('set-cookie') };
  };

  t('the suite was given a passphrase to exercise', PASSPHRASE !== '', 'TAQWA_PASSPHRASE unset');

  /* ---- 22a. wrong, then right ---- */
  const bad = await login('definitely-not-the-passphrase');
  t('a wrong passphrase is refused', bad.status === 401, bad.status);
  t('   ...and sets no cookie', bad.setCookie === null, bad.setCookie);

  const good = await login(PASSPHRASE);
  t('the right passphrase is accepted', good.status === 204, good.status);
  t('   ...and sets a cookie', typeof good.setCookie === 'string', good.setCookie);
  const cookie = good.setCookie.split(';')[0];

  /* ---- 22b. the flags a browser will actually enforce ---- */
  {
    const flags = good.setCookie.toLowerCase();
    t('HttpOnly, so script cannot read it', flags.includes('httponly'), good.setCookie);
    t('Secure, so it never crosses plain HTTP', flags.includes('secure'), good.setCookie);
    t('SameSite=Strict, which is what makes CSRF a non-event',
      flags.includes('samesite=strict'), good.setCookie);
    t('   ...and the value carries no passphrase',
      !good.setCookie.includes(PASSPHRASE), 'the passphrase is in the cookie');
  }

  /* ---- 22c. a session reads and writes real D1 ---- */
  {
    const read = await withCookie('GET', '/api/customers', cookie);
    t('a session can read', read.status === 200, read.status);
    t('   ...and gets real rows', Array.isArray(read.body?.data), typeof read.body?.data);

    const made = await withCookie('POST', '/api/customers', cookie,
      { name: 'Session Probe', phone: '01733-222111' });
    t('a session can write', made.status === 201, made.status);
    if (made.status === 201) {
      const id = made.body.data.id;
      const gone = await withCookie('DELETE', `/api/customers/${id}`, cookie);
      t('   ...and delete what it made', gone.status === 200, gone.status);
    }
  }

  /* ---- 22d. a forged session gets nothing ---- */
  {
    const value = cookie.split('=')[1];
    const [v, exp, sig] = value.split('.');
    const forged = {
      'a flipped signature': `${v}.${exp}.${sig.slice(0, -1)}${sig.slice(-1) === 'A' ? 'B' : 'A'}`,
      'a stretched expiry': `${v}.${Number(exp) + 999999}.${sig}`,
      'no signature': `${v}.${exp}`,
      'nonsense': 'garbage',
    };
    const accepted = [];
    for (const [why, bad2] of Object.entries(forged)) {
      const r = await withCookie('GET', '/api/customers', `taqwa_session=${bad2}`);
      if (r.status !== 401) accepted.push({ why, status: r.status });
    }
    t('no forged cookie is accepted', accepted.length === 0, accepted);
  }

  /* ---- 22e. signing out ---- */
  {
    const out = await withCookie('DELETE', '/api/session', cookie);
    t('sign out succeeds', out.status === 204, out.status);
    t('   ...by clearing the cookie', /^taqwa_session=;/.test(out.setCookie || ''), out.setCookie);
    t('   ...with Max-Age=0', (out.setCookie || '').includes('Max-Age=0'), out.setCookie);
    // The cookie is signed rather than stored, so the server cannot revoke
    // this one copy -- the browser dropping it is what ends the session.
    // That limitation is stated in README rather than papered over here.
  }

  /* ---- 22f. the public pair, and nothing else ---- */
  {
    const anon = await sendAnon('GET', '/api/session');
    t('GET /api/session is public', anon.status === 200, anon.status);
    t('   ...and says this caller is not signed in', anon.body?.data?.authenticated === false,
      anon.body?.data);
    const signedIn = await withCookie('GET', '/api/session', cookie);
    t('   ...and says so when it is', signedIn.body?.data?.authenticated === true, signedIn.body?.data);
  }

  /* ---- 22g. nothing leaks ---- */
  {
    const surfaces = [
      await sendAnon('GET', '/api/session'),
      await sendAnon('POST', '/api/session', { passphrase: 'wrong' }),
      await sendAnon('GET', '/api/customers'),
    ];
    t('no response contains the passphrase',
      surfaces.every((r) => !JSON.stringify(r.body ?? {}).includes(PASSPHRASE)),
      surfaces.map((r) => r.status));
    t('   ...nor names the secret bindings',
      surfaces.every((r) => !/AUTH_PASSPHRASE|AUTH_SECRET/.test(JSON.stringify(r.body ?? {}))));
    t('   ...and a wrong passphrase is answered exactly like any other refusal',
      surfaces[1].body?.error?.message === 'Authentication required.', surfaces[1].body);
  }
}

sec('23. Security headers: every response, over real HTTP');
{
  const raw = async (method, path, headers = {}, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return res;
  };
  const auth = { authorization: `Bearer ${TOKEN}` };

  const cases = [
    ['200 an authenticated read', await raw('GET', '/api/customers', auth)],
    ['200 a detail', await raw('GET', '/api/customers/CUS-9001', auth)],
    ['401 an anonymous read', await raw('GET', '/api/customers')],
    ['404 an unknown endpoint', await raw('GET', '/api/nope', auth)],
    ['405 a wrong method', await raw('POST', '/api/health', auth)],
    ['200 health', await raw('GET', '/api/health')],
    ['200 session', await raw('GET', '/api/session')],
  ];
  const missing = [];
  for (const [label, res] of cases) {
    for (const [h, want] of [['cache-control', 'no-store'], ['x-content-type-options', 'nosniff'],
                             ['referrer-policy', 'no-referrer'], ['x-frame-options', 'DENY']]) {
      if (res.headers.get(h) !== want) missing.push({ label, h, got: res.headers.get(h) });
    }
  }
  t('every response class carries every security header', missing.length === 0, missing);

  // The one that matters: this body is the shop's customer list.
  const read = await raw('GET', '/api/customers', auth);
  t('an authenticated read is marked no-store', read.headers.get('cache-control') === 'no-store',
    read.headers.get('cache-control'));
  t('   ...and really did return customer rows', (await read.json()).data.length > 0);

  const login = await raw('POST', '/api/session', {}, { passphrase: process.env.TAQWA_PASSPHRASE || '' });
  t('a Set-Cookie response is no-store, so a session cannot be served twice',
    login.headers.get('cache-control') === 'no-store' && !!login.headers.get('set-cookie'),
    login.headers.get('cache-control'));

  // Strict cookie parsing: a padded value is malformed and is not accepted.
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const value = cookie.split('=').slice(1).join('=');
  const padded = await raw('GET', '/api/customers', { cookie: `taqwa_session=  ${value}  ` });
  t('a whitespace-padded cookie value is refused', padded.status === 401, padded.status);
  const plain = await raw('GET', '/api/customers', { cookie });
  t('   ...while the cookie as issued is accepted', plain.status === 200, plain.status);
}

sec('24. Write-offs (0002): a waived balance is not a payment, against real D1');
{
  const cust = await send('POST', '/api/customers', { name: '0002 Write-off Customer', phone: '01933-000201' });
  const C = cust.body?.data?.id;
  const veh = await send('POST', '/api/vehicles',
    { customerId: C, regNo: 'DHAKA-WO-0002', brand: 'Toyota', model: 'Axio' });
  const V = veh.body?.data?.id;
  const mech = await send('POST', '/api/mechanics', { name: '0002 Mechanic', phone: '01933-000202', specialization: 'Electrical' });
  const M = mech.body?.data?.id;
  t('the section has its own customer, vehicle and mechanic', [C, V, M].every(Boolean),
    { C, V, M, customer: cust.body, vehicle: veh.body, mechanic: mech.body });

  const setStatus = (id, status) => send('POST', `/api/job-cards/${id}/status`, { status });
  /** A Completed job card worth `total` (custom work, no stock), invoiced. */
  const invoiceOf = async (total, over = {}) => {
    const j = await send('POST', '/api/job-cards', {
      customerId: C, vehicleId: V, mechanicId: M, date: '2026-10-01', complaint: '0002: to bill',
      services: [{ serviceId: null, name: 'Electric wiring', qty: 1, unitPrice: total }], partsUsed: [], ...over,
    });
    const J = j.body?.data?.id;
    for (const st of ['Inspection', 'In Progress', 'Completed']) await setStatus(J, st);
    return (await send('POST', '/api/invoices', { jobCardId: J })).body?.data?.id;
  };
  const inv = async (id) => (await get(`/api/invoices/${id}`)).body?.data;
  const figures = async (id) => { const i = await inv(id); return [i.paid, i.writtenOff, i.due, i.status]; };
  const pay = (id, amount) => send('POST', '/api/payments', { customerId: C, invoiceId: id, amount });
  const writeOff = (id, amount, expectedDue, extra = {}) =>
    send('POST', '/api/invoice-adjustments', { invoiceId: id, amount, reason: 'Customer concession', expectedDue, ...extra });
  const reverse = (adj, voidReason) => send('POST', `/api/invoice-adjustments/${adj}/void`,
    voidReason === undefined ? {} : { voidReason });

  /* ---- 24a. payment, then a write-off of the rest (the business case) ---- */
  const A = await invoiceOf(1775, { paid: 500 });
  t('a new invoice starts unpaid, whatever the job card typed', JSON.stringify(await figures(A))
    === JSON.stringify([0, 0, 1775, 'Unpaid']), await figures(A));
  await pay(A, 1500);
  t('a payment of 1500 leaves 275 due', JSON.stringify(await figures(A))
    === JSON.stringify([1500, 0, 275, 'Partial']), await figures(A));
  const w1 = await writeOff(A, 275, 275, { recordedBy: 'Front desk' });
  t('POST /api/invoice-adjustments -> 201', w1.status === 201, w1.body);
  const adj1 = w1.body?.data;
  t('   ...an ADJ id', /^ADJ-\d{4}$/.test(adj1?.id || ''), adj1);
  t('   ...the server took the customer from the invoice', adj1?.customerId === C, adj1);
  t('   ...and worked out the before/after due', adj1?.dueBefore === 275 && adj1?.dueAfter === 0, adj1);
  t('   ...dated today (YYYY-MM-DD), Active, recorded by the name given',
    /^\d{4}-\d{2}-\d{2}$/.test(adj1?.date || '') && adj1?.status === 'Active' && adj1?.recordedBy === 'Front desk', adj1);
  t('the invoice: paid stays cash (1500), 275 written off, due 0, Paid',
    JSON.stringify(await figures(A)) === JSON.stringify([1500, 275, 0, 'Paid']), await figures(A));
  t('   ...and its total is untouched', (await inv(A)).total === 1775);
  const payments = (await get('/api/payments?limit=1000')).body?.data ?? [];
  t('a write-off is not a payment: the invoice still has exactly one payment, of 1500',
    JSON.stringify(payments.filter((p) => p.invoiceId === A).map((p) => p.amount)) === JSON.stringify([1500]));

  /* ---- 24b. duplicate submission, stale balance, over-adjustment ---- */
  const dupe = await writeOff(A, 275, 275, { recordedBy: 'Front desk' });
  t('the same write-off sent again -> 409 stale_balance', dupe.status === 409
    && dupe.body?.error?.reason === 'stale_balance' && dupe.body?.error?.currentDue === 0, dupe.body);
  t('a payment after the balance is cleared -> 409 overpayment',
    (await pay(A, 1)).body?.error?.reason === 'overpayment');
  const B = await invoiceOf(1000);
  t('a write-off above the due -> 409 over_adjustment',
    (await writeOff(B, 1001, 1000)).body?.error?.reason === 'over_adjustment');
  t('a write-off against a due the user no longer sees -> 409 stale_balance',
    (await writeOff(B, 100, 900)).body?.error?.reason === 'stale_balance');
  t('   ...and neither wrote anything', JSON.stringify(await figures(B)) === JSON.stringify([0, 0, 1000, 'Unpaid']));

  /* ---- 24c. validation and refused fields ---- */
  const bad = await send('POST', '/api/invoice-adjustments', {
    invoiceId: B, amount: 0, expectedDue: 1000, date: '2026-01-01', customerId: C, status: 'Void', dueBefore: 1, dueAfter: 0,
  });
  t('amount 0, no reason, and server-owned fields -> 422', bad.status === 422, bad.body);
  t('   ...each named', ['amount', 'reason', 'date', 'customerId', 'status', 'dueBefore', 'dueAfter']
    .every((k) => bad.body?.error?.fields?.[k]), bad.body?.error?.fields);
  t('a missing expectedDue -> 422', (await send('POST', '/api/invoice-adjustments',
    { invoiceId: B, amount: 10, reason: 'x' })).body?.error?.fields?.expectedDue !== undefined);
  t('an unknown type -> 422', (await writeOff(B, 10, 1000, { type: 'discount' })).status === 422);
  t('an unknown invoice -> 409 invoice_not_found',
    (await writeOff('INV-8888', 10, 0)).body?.error?.reason === 'invoice_not_found');

  /* ---- 24d. reversal ---- */
  t('reversing without a reason -> 422', (await reverse(adj1.id)).status === 422);
  const r1 = await reverse(adj1.id, 'Customer agreed to pay');
  t('reversing -> 200, the write-off is Void with its reason and time',
    r1.status === 200 && r1.body?.data?.status === 'Void' && r1.body?.data?.voidReason === 'Customer agreed to pay'
      && !!r1.body?.data?.voidedAt, r1.body);
  t('   ...the row is kept, amount and snapshots untouched',
    r1.body?.data?.amount === 275 && r1.body?.data?.dueBefore === 275 && r1.body?.data?.dueAfter === 0, r1.body?.data);
  t('   ...and the invoice is owed 275 again', JSON.stringify(await figures(A))
    === JSON.stringify([1500, 0, 275, 'Partial']), await figures(A));
  t('reversing twice -> 409 adjustment_void', (await reverse(adj1.id, 'again')).body?.error?.reason === 'adjustment_void');
  t('no PUT or DELETE on a write-off -> 405',
    (await send('PUT', `/api/invoice-adjustments/${adj1.id}`, { reason: 'x' })).status === 405
      && (await send('DELETE', `/api/invoice-adjustments/${adj1.id}`)).status === 405);
  const one = await get(`/api/invoice-adjustments/${adj1.id}`);
  t('GET /api/invoice-adjustments/:id returns the record', one.status === 200 && one.body?.data?.id === adj1.id, one.body);

  /* ---- 24e. write-off before payment, several write-offs, a full write-off ---- */
  await writeOff(B, 200, 1000);
  t('a write-off on an unpaid invoice: still Unpaid (no cash), due 800',
    JSON.stringify(await figures(B)) === JSON.stringify([0, 200, 800, 'Unpaid']), await figures(B));
  await pay(B, 800);
  t('   ...then paying the rest: paid 800, written off 200, due 0, Paid',
    JSON.stringify(await figures(B)) === JSON.stringify([800, 200, 0, 'Paid']), await figures(B));
  const D = await invoiceOf(1000);
  await writeOff(D, 100, 1000); await writeOff(D, 150, 900);
  t('two write-offs add up', JSON.stringify(await figures(D)) === JSON.stringify([0, 250, 750, 'Unpaid']), await figures(D));
  const full = await writeOff(D, 750, 750);
  t('writing off everything on an unpaid invoice clears it (stored status Paid)',
    full.status === 201 && JSON.stringify(await figures(D)) === JSON.stringify([0, 1000, 0, 'Paid']), await figures(D));

  /* ---- 24f. a Void invoice is frozen ---- */
  const voided = await send('POST', `/api/invoices/${D}/void`);
  t('voiding an invoice with write-offs -> 200, figures frozen',
    voided.status === 200 && JSON.stringify(await figures(D)) === JSON.stringify([0, 1000, 0, 'Void']), await figures(D));
  t('   ...a write-off on it -> 409 invoice_void', (await writeOff(D, 1, 0)).body?.error?.reason === 'invoice_void');
  t('   ...reversing one of its write-offs -> 409 invoice_void',
    (await reverse(full.body?.data?.id, 'x')).body?.error?.reason === 'invoice_void');
  t('   ...and it cannot be deleted -> 409 invoice_has_adjustments',
    (await send('DELETE', `/api/invoices/${D}`)).body?.error?.reason === 'invoice_has_adjustments');

  /* ---- 24g. concurrency ---- */
  {
    const E = await invoiceOf(500);
    const [p, w] = await Promise.all([pay(E, 500), writeOff(E, 500, 500)]);
    t('a payment and a write-off racing for the same 500: exactly one wins',
      [p.status, w.status].filter((c) => c === 201).length === 1, { payment: p.status, writeOff: w.status });
    const [paid, wo, due] = await figures(E);
    t('   ...and the invoice is never over-settled', paid + wo === 500 && due === 0, await figures(E));
    const F = await invoiceOf(300);
    const many = await Promise.all(Array.from({ length: 5 }, () => writeOff(F, 300, 300)));
    t('five identical write-offs at once: exactly one 201',
      many.filter((r) => r.status === 201).length === 1, many.map((r) => r.status));
    t('   ...the rest refused as stale or over', many.filter((r) => r.status === 409).length === 4, many.map((r) => r.status));
    t('   ...and the invoice counts 300 once', JSON.stringify(await figures(F)) === JSON.stringify([0, 300, 0, 'Paid']));
  }

  /* ---- 24h. the invariant, across every invoice this database holds ---- */
  {
    const invoices = (await get('/api/invoices?limit=1000')).body?.data ?? [];
    const pays = (await get('/api/payments?limit=1000')).body?.data ?? [];
    const adjs = (await get('/api/invoice-adjustments?limit=1000')).body?.data ?? [];
    t('GET /api/invoice-adjustments lists the section\'s write-offs', adjs.length >= 6, adjs.length);  // 6, or 7 if the write-off won 24g's race
    const sum = (rows, id) => rows.filter((r) => r.invoiceId === id && r.status !== 'Void')
      .reduce((s2, r) => s2 + r.amount, 0);
    const touched = new Set([...pays.map((p) => p.invoiceId), ...adjs.map((a) => a.invoiceId)].filter(Boolean));
    const wrong = invoices.filter((i) => {
      if (i.status === 'Void' || !touched.has(i.id)) return false;
      const paid = Math.min(i.total, Math.max(0, sum(pays, i.id)));
      const wo = Math.min(i.total - paid, Math.max(0, sum(adjs, i.id)));
      const due = Math.max(i.total - paid - wo, 0);
      const status = i.total > 0 && paid + wo >= i.total ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid';
      return i.paid !== paid || i.writtenOff !== wo || i.due !== due || i.status !== status;
    });
    t('every live invoice agrees with its payments AND its write-offs', wrong.length === 0,
      wrong.map((i) => ({ id: i.id, paid: i.paid, writtenOff: i.writtenOff, due: i.due, status: i.status })));
    t('   ...and no invoice ever has paid + written off above its total',
      invoices.every((i) => i.paid + i.writtenOff <= i.total + 1e-9), invoices.filter((i) => i.paid + i.writtenOff > i.total));
  }

  // cleanup.sql removes these rows (write-offs first) and resets the counters.
}

sec('25. Customer follow-ups (0005): idempotent creates, append-only contacts, against real D1');
{
  const cust = await send('POST', '/api/customers', { name: '0005 Follow-up Customer', phone: '01933-000501' });
  const C = cust.body?.data?.id;
  const other = await send('POST', '/api/customers', { name: '0005 Other Customer', phone: '01933-000502' });
  const C2 = other.body?.data?.id;
  const veh = await send('POST', '/api/vehicles', { customerId: C, regNo: 'DHAKA-FU-0005', brand: 'Toyota', model: 'Premio' });
  const V = veh.body?.data?.id;
  const vehOther = await send('POST', '/api/vehicles', { customerId: C2, regNo: 'DHAKA-FU-0006', brand: 'Honda', model: 'Grace' });
  const V2 = vehOther.body?.data?.id;
  const vehOff = await send('POST', '/api/vehicles', { customerId: C, regNo: 'DHAKA-FU-0007', brand: 'Kia', model: 'Rio', status: 'Inactive' });
  const V3 = vehOff.body?.data?.id;
  t('the section has its own customers and vehicles', [C, C2, V, V2, V3].every(Boolean),
    { cust: cust.body, other: other.body, veh: veh.body, vehOther: vehOther.body, vehOff: vehOff.body });

  let seq = 0;
  const key = () => `integration-0005-${Date.now()}-${++seq}`;
  const body = (extra = {}) => ({ customerId: C, vehicleId: V, reason: 'Ask about the brake squeal', priority: 'high',
    dueDate: '2026-10-20', idempotencyKey: key(), ...extra });

  // 25a. create, duplicates allowed, idempotent replay
  const a = await send('POST', '/api/follow-ups', body());
  t('25a create -> 201 Open', a.status === 201 && a.body?.data?.status === 'Open', a);
  const F = a.body?.data?.id;
  const dup = await send('POST', '/api/follow-ups', body());
  t('   ...the same customer + vehicle + reason with a new key -> 201 (several Open allowed)', dup.status === 201, dup);
  const fixed = body();
  const r1 = await send('POST', '/api/follow-ups', fixed);
  const r2 = await send('POST', '/api/follow-ups', fixed);
  t('   ...same key + same payload -> 201 then 200 replayed, same id',
    r1.status === 201 && r2.status === 200 && r2.body?.replayed === true && r2.body?.data?.id === r1.body?.data?.id, [r1.status, r2.status, r2.body]);
  const r3 = await send('POST', '/api/follow-ups', { ...fixed, reason: 'Something else' });
  t('   ...same key + different payload -> 409 idempotency_key_reused', r3.status === 409 && r3.body?.error?.reason === 'idempotency_key_reused', r3);
  t('   ...past and far-future due dates are accepted',
    (await send('POST', '/api/follow-ups', body({ dueDate: '1999-01-01' }))).status === 201
      && (await send('POST', '/api/follow-ups', body({ dueDate: '2099-12-31' }))).status === 201);
  const imp = await send('POST', '/api/follow-ups', body({ dueDate: '2026-02-30' }));
  t('   ...an impossible date -> 422', imp.status === 422 && 'dueDate' in (imp.body?.error?.fields ?? {}), imp);
  const extraKey = await send('POST', '/api/follow-ups', body({ status: 'Completed' }));
  t('   ...an unlisted field -> 422', extraKey.status === 422 && 'status' in (extraKey.body?.error?.fields ?? {}), extraKey);
  const own = await send('POST', '/api/follow-ups', body({ vehicleId: V2 }));
  t("   ...another customer's vehicle -> 422 fields.vehicleId", own.status === 422 && !!own.body?.error?.fields?.vehicleId, own);
  const off = await send('POST', '/api/follow-ups', body({ vehicleId: V3 }));
  t('   ...an Inactive vehicle -> 409 vehicle_inactive', off.status === 409 && off.body?.error?.reason === 'vehicle_inactive', off);

  // 25b. truly parallel same-key requests against real D1
  const parallel = body();
  const burst = await Promise.all(Array.from({ length: 8 }, () => send('POST', '/api/follow-ups', parallel)));
  const ids = new Set(burst.map((r) => r.body?.data?.id));
  t('25b eight parallel creates with one key -> one follow-up', ids.size === 1 && burst.every((r) => r.status === 201 || r.status === 200),
    burst.map((r) => [r.status, r.body?.data?.id, r.body?.error]));
  t('   ...exactly one 201, the rest 200 replayed',
    burst.filter((r) => r.status === 201).length === 1 && burst.filter((r) => r.status === 200).every((r) => r.body?.replayed === true),
    burst.map((r) => r.status));

  // 25c. contacts: batch, cache, due date, parallel same key
  const c1 = await send('POST', `/api/follow-ups/${F}/contact`, { idempotencyKey: key(), outcome: 'reached', note: 'Happy' });
  t('25c contact -> 201, data = follow-up, contact = the new contact',
    c1.status === 201 && c1.body?.data?.id === F && c1.body?.contact?.followUpId === F && c1.body?.data?.lastOutcome === 'reached', c1);
  const c2 = await send('POST', `/api/follow-ups/${F}/contact`,
    { idempotencyKey: key(), outcome: 'callback_requested', nextContactDate: '2025-12-01' });
  t('   ...a past nextContactDate becomes the due date and the latest outcome',
    c2.status === 201 && c2.body?.data?.dueDate === '2025-12-01' && c2.body?.data?.lastOutcome === 'callback_requested', c2);
  const ck = { idempotencyKey: key(), outcome: 'unreachable', note: 'No answer' };
  const cburst = await Promise.all(Array.from({ length: 8 }, () => send('POST', `/api/follow-ups/${F}/contact`, ck)));
  t('   ...eight parallel contacts with one key -> one contact',
    new Set(cburst.map((r) => r.body?.contact?.id)).size === 1 && cburst.filter((r) => r.status === 201).length === 1,
    cburst.map((r) => [r.status, r.body?.contact?.id, r.body?.error]));
  const twin1 = await send('POST', `/api/follow-ups/${F}/contact`, { idempotencyKey: key(), outcome: 'unreachable', note: 'No answer' });
  const twin2 = await send('POST', `/api/follow-ups/${F}/contact`, { idempotencyKey: key(), outcome: 'unreachable', note: 'No answer' });
  t('   ...two identical contacts with new keys are both recorded', twin1.status === 201 && twin2.status === 201
    && twin1.body?.contact?.id !== twin2.body?.contact?.id, [twin1.status, twin2.status]);
  const history = (await get('/api/follow-up-contacts?limit=1000')).body?.data?.filter((x) => x.followUpId === F) ?? [];
  t('   ...the history holds 5 contacts for the follow-up', history.length === 5, history.length);

  // 25d. void restores the previous Active outcome, leaves the due date
  const lastThree = [twin2, twin1, cburst.find((r) => r.status === 201)].map((r) => r.body?.contact?.id);
  for (const id of lastThree) {
    const v = await send('POST', `/api/follow-up-contacts/${id}/void`, { reason: 'Logged twice', voidedBy: 'Integration' });
    if (v.status !== 200) t('   ...void ' + id, false, v);
  }
  const fu = (await get(`/api/follow-ups/${F}`)).body?.data;
  t('25d after voiding the three latest, the callback counts again; the due date is not restored',
    fu?.lastOutcome === 'callback_requested' && fu?.dueDate === '2025-12-01', fu);
  const vAgain = await send('POST', `/api/follow-up-contacts/${lastThree[0]}/void`, { reason: 'again' });
  t('   ...voiding again -> 409 contact_void', vAgain.status === 409 && vAgain.body?.error?.reason === 'contact_void', vAgain);
  const put = await send('PUT', `/api/follow-up-contacts/${lastThree[0]}`, { note: 'edit' });
  const del = await send('DELETE', `/api/follow-up-contacts/${lastThree[0]}`);
  const post = await send('POST', '/api/follow-up-contacts', { followUpId: F, outcome: 'reached' });
  t('   ...the history cannot be edited, deleted or written directly (405)', [put.status, del.status, post.status].every((s) => s === 405),
    [put.status, del.status, post.status]);

  // 25e. lifecycle and deletion
  const done = await send('POST', `/api/follow-ups/${F}/complete`, {});
  const again = await send('POST', `/api/follow-ups/${F}/complete`, {});
  t('25e complete -> 200; again -> 409 follow_up_closed, currentStatus Completed',
    done.status === 200 && again.status === 409 && again.body?.error?.currentStatus === 'Completed', [done.status, again.body]);
  const late = await send('POST', `/api/follow-ups/${F}/contact`, { idempotencyKey: key(), outcome: 'reached' });
  t('   ...no contact on a closed follow-up', late.status === 409 && late.body?.error?.reason === 'follow_up_closed', late);
  const cx = await send('POST', `/api/follow-ups/${dup.body?.data?.id}/cancel`, {});
  t('   ...cancel needs a reason', cx.status === 422, cx);
  const delV = await send('DELETE', `/api/vehicles/${V}`);
  const delC = await send('DELETE', `/api/customers/${C}`);
  t('   ...a customer and vehicle referenced by follow-ups cannot be deleted (409)', delV.status === 409 && delC.status === 409,
    [delV.status, delC.status]);

  // 25f. the gate
  const anon = await sendAnon('POST', '/api/follow-ups', body());
  const anonC = await sendAnon('POST', `/api/follow-ups/${F}/contact`, { idempotencyKey: key(), outcome: 'reached' });
  const anonL = await sendAnon('GET', '/api/follow-up-contacts');
  t('25f without credentials every follow-up route is 401', [anon.status, anonC.status, anonL.status].every((s) => s === 401),
    [anon.status, anonC.status, anonL.status]);

  // cleanup.sql removes these rows (contacts first) and resets the counters.
}

sec('26. Follow-up tasks (0006): references, assignment, idempotent creates and the status machine, against real D1');
{
  const cust = await send('POST', '/api/customers', { name: '0006 Task Customer', phone: '01933-000601' });
  const C = cust.body?.data?.id;
  const other = await send('POST', '/api/customers', { name: '0006 Other Customer', phone: '01933-000602' });
  const C2 = other.body?.data?.id;
  const veh = await send('POST', '/api/vehicles', { customerId: C, regNo: 'DHAKA-TK-0006', brand: 'Toyota', model: 'Axio' });
  const V = veh.body?.data?.id;
  const vehOther = await send('POST', '/api/vehicles', { customerId: C2, regNo: 'DHAKA-TK-0007', brand: 'Honda', model: 'Fit' });
  const V2 = vehOther.body?.data?.id;
  const mech = await send('POST', '/api/mechanics', { name: '0006 Task Mechanic', phone: '01933-000603', specialization: 'Brakes' });
  const M = mech.body?.data?.id;
  const mechOff = await send('POST', '/api/mechanics', { name: '0006 Retired Mechanic', phone: '01933-000604', specialization: 'Body', status: 'Inactive' });
  const M2 = mechOff.body?.data?.id;
  const svc = await send('POST', '/api/services', { name: '0006 Brake Check', category: 'Brakes', price: 500 });
  const S = svc.body?.data?.id;
  const job = await send('POST', '/api/job-cards', { customerId: C, vehicleId: V, mechanicId: M, date: '2026-10-10',
    complaint: '0006: brake squeal', services: [{ serviceId: S, name: '0006 Brake Check', qty: 1, unitPrice: 500 }] });
  const J = job.body?.data?.id;
  t('the section has its own customers, vehicles, mechanics and job card', [C, C2, V, V2, M, M2, S, J].every(Boolean),
    { cust: cust.body, veh: veh.body, mech: mech.body, mechOff: mechOff.body, job: job.body });

  let seq = 0;
  const key = () => `integration-0006-${Date.now()}-${++seq}`;
  const body = (extra = {}) => ({ title: 'Call about the brake squeal', customerId: C, vehicleId: V, jobCardId: J,
    assignedTo: M, priority: 'high', dueDate: '2026-10-20', createdBy: 'Integration', idempotencyKey: key(), ...extra });

  // 26a. create, references, idempotent replay
  const a = await send('POST', '/api/follow-up-tasks', body());
  const T = a.body?.data?.id;
  t('26a create -> 201 Pending, with its references and audit',
    a.status === 201 && /^TSK-\d{4}$/.test(T || '') && a.body?.data?.status === 'Pending' && a.body?.data?.jobCardId === J
      && a.body?.data?.assignedTo === M && a.body?.data?.createdBy === 'Integration' && !!a.body?.data?.createdAt, a);
  t('   ...the idempotency key is never echoed', a.body?.data && !('idempotencyKey' in a.body.data), a.body?.data);
  const bare = await send('POST', '/api/follow-up-tasks', { title: 'Restock brake fluid', dueDate: '2026-10-25', idempotencyKey: key() });
  t('   ...a task needs no customer, staff or job card (priority defaults to medium)',
    bare.status === 201 && bare.body?.data?.customerId === null && bare.body?.data?.priority === 'medium', bare);
  const fixed = body();
  const r1 = await send('POST', '/api/follow-up-tasks', fixed);
  const r2 = await send('POST', '/api/follow-up-tasks', fixed);
  t('   ...same key + same payload -> 201 then 200 replayed, same id',
    r1.status === 201 && r2.status === 200 && r2.body?.replayed === true && r2.body?.data?.id === r1.body?.data?.id, [r1.status, r2.status, r2.body]);
  const r3 = await send('POST', '/api/follow-up-tasks', { ...fixed, title: 'Something else' });
  t('   ...same key + different payload -> 409 idempotency_key_reused', r3.status === 409 && r3.body?.error?.reason === 'idempotency_key_reused', r3);
  const parallel = body();
  const burst = await Promise.all(Array.from({ length: 8 }, () => send('POST', '/api/follow-up-tasks', parallel)));
  t('   ...eight parallel creates with one key -> one task, exactly one 201',
    new Set(burst.map((r) => r.body?.data?.id)).size === 1 && burst.filter((r) => r.status === 201).length === 1,
    burst.map((r) => [r.status, r.body?.data?.id, r.body?.error]));

  // 26b. validation and references, all refused by the Worker
  const bad = async (extra) => send('POST', '/api/follow-up-tasks', body(extra));
  const v1 = await bad({ title: '  ' });
  const v2 = await bad({ dueDate: '2026-02-30' });
  const v3 = await bad({ priority: 'normal' });
  const v4 = await bad({ status: 'Completed' });
  t('26b blank title, impossible date, unknown priority, server-owned field -> 422 each',
    [v1, v2, v3, v4].every((r) => r.status === 422) && 'title' in (v1.body?.error?.fields ?? {}) && 'dueDate' in (v2.body?.error?.fields ?? {})
      && 'priority' in (v3.body?.error?.fields ?? {}) && 'status' in (v4.body?.error?.fields ?? {}), [v1, v2, v3, v4].map((r) => r.body));
  const v5 = await bad({ customerId: null });
  t('   ...a vehicle or job card without a customer -> 422', v5.status === 422, v5);
  const v6 = await bad({ vehicleId: V2, jobCardId: null });
  t("   ...another customer's vehicle -> 422 fields.vehicleId", v6.status === 422 && !!v6.body?.error?.fields?.vehicleId, v6);
  const v7 = await bad({ customerId: C2, vehicleId: V2 });
  t("   ...a job card of another customer -> 422 fields.jobCardId", v7.status === 422 && !!v7.body?.error?.fields?.jobCardId, v7);
  const v8 = await bad({ assignedTo: M2 });
  const v9 = await bad({ assignedTo: 'MEC-7777' });
  const v10 = await bad({ customerId: 'CUS-7777', vehicleId: null, jobCardId: null });
  t('   ...inactive / unknown staff and an unknown customer -> 409 with a reason',
    v8.body?.error?.reason === 'staff_inactive' && v9.body?.error?.reason === 'staff_not_found' && v10.body?.error?.reason === 'customer_not_found'
      && [v8, v9, v10].every((r) => r.status === 409), [v8.body, v9.body, v10.body]);

  // 26c. edit and assignment, with optimistic concurrency
  const cur = (await get(`/api/follow-up-tasks/${T}`)).body?.data;
  const e1 = await send('PUT', `/api/follow-up-tasks/${T}`, { assignedTo: null, priority: 'urgent', updatedBy: 'Integration', expectedUpdatedAt: cur?.updatedAt });
  t('26c edit -> 200: unassigned, urgent, updatedBy recorded', e1.status === 200 && e1.body?.data?.assignedTo === null
    && e1.body?.data?.priority === 'urgent' && e1.body?.data?.updatedBy === 'Integration', e1);
  const stale = await send('PUT', `/api/follow-up-tasks/${T}`, { title: 'Stale edit', expectedUpdatedAt: cur?.updatedAt });
  t('   ...an edit made from an older version -> 409 concurrent_modification',
    e1.body?.data?.updatedAt === cur?.updatedAt || (stale.status === 409 && stale.body?.error?.reason === 'concurrent_modification'), [cur?.updatedAt, e1.body?.data?.updatedAt, stale.body]);
  const e2 = await send('PUT', `/api/follow-up-tasks/${T}`, { assignedTo: M });
  t('   ...reassigned to the active mechanic', e2.status === 200 && e2.body?.data?.assignedTo === M, e2);
  const e3 = await send('PUT', `/api/follow-up-tasks/${T}`, { assignedTo: M2 });
  t('   ...never to an inactive one (409 staff_inactive)', e3.status === 409 && e3.body?.error?.reason === 'staff_inactive', e3);

  // 26d. the status machine
  const s1 = await send('POST', `/api/follow-up-tasks/${T}/start`, {});
  const s2 = await send('POST', `/api/follow-up-tasks/${T}/start`, {});
  t('26d start -> 200 In Progress with startedAt; again -> 409 invalid_transition',
    s1.status === 200 && s1.body?.data?.status === 'In Progress' && !!s1.body?.data?.startedAt
      && s2.status === 409 && s2.body?.error?.reason === 'invalid_transition' && s2.body?.error?.currentStatus === 'In Progress', [s1.body, s2.body]);
  const c1 = await send('POST', `/api/follow-up-tasks/${T}/complete`, { note: 'Called, all fine', by: 'Integration' });
  t('   ...complete -> 200 with completedAt and the note', c1.status === 200 && c1.body?.data?.status === 'Completed'
    && !!c1.body?.data?.completedAt && c1.body?.data?.completionNote === 'Called, all fine', c1);
  const c2 = await send('POST', `/api/follow-up-tasks/${T}/cancel`, { reason: 'too late' });
  const c3 = await send('PUT', `/api/follow-up-tasks/${T}`, { title: 'Edit after close' });
  t('   ...a completed task cannot be cancelled or edited (409 task_closed)',
    [c2, c3].every((r) => r.status === 409 && r.body?.error?.reason === 'task_closed'), [c2.body, c3.body]);
  const B = bare.body?.data?.id;
  const x1 = await send('POST', `/api/follow-up-tasks/${B}/cancel`, {});
  const x2 = await send('POST', `/api/follow-up-tasks/${B}/cancel`, { reason: 'Not needed', by: 'Integration' });
  t('   ...cancel needs a reason (422), then -> 200 Cancelled with the reason',
    x1.status === 422 && x2.status === 200 && x2.body?.data?.status === 'Cancelled' && x2.body?.data?.cancelReason === 'Not needed', [x1.body, x2.body]);
  const x3 = await send('POST', `/api/follow-up-tasks/${B}/start`, {});
  t('   ...a cancelled task cannot be started', x3.status === 409, x3);

  // 26e. listing, deletion and references that cannot go away
  const list = (await get('/api/follow-up-tasks?limit=1000')).body?.data ?? [];
  t('26e the list returns the tasks with their status', list.some((x) => x.id === T && x.status === 'Completed') && list.some((x) => x.id === B && x.status === 'Cancelled'),
    list.length);
  const del = await send('DELETE', `/api/follow-up-tasks/${T}`);
  t('   ...tasks are never deleted (405)', del.status === 405, del);
  const delM = await send('DELETE', `/api/mechanics/${M}`);
  const delC = await send('DELETE', `/api/customers/${C}`);
  t('   ...a mechanic and a customer referenced by tasks cannot be deleted (409)', delM.status === 409 && delC.status === 409, [delM.status, delC.status]);

  // 26f. the gate
  const anon = await sendAnon('POST', '/api/follow-up-tasks', body());
  const anonL = await sendAnon('GET', '/api/follow-up-tasks');
  const anonA = await sendAnon('POST', `/api/follow-up-tasks/${T}/start`, {});
  t('26f without credentials every task route is 401', [anon.status, anonL.status, anonA.status].every((s) => s === 401),
    [anon.status, anonL.status, anonA.status]);

  // cleanup.sql removes these rows (tasks first) and resets the counters.
}

sec('27. Estimates (0007): server totals, idempotent creates, the lifecycle and conversion to a job card, against real D1');
{
  const cust = await send('POST', '/api/customers', { name: '0007 Estimate Customer', phone: '01933-000701' });
  const C = cust.body?.data?.id;
  const veh = await send('POST', '/api/vehicles', { customerId: C, regNo: 'DHAKA-ES-0007', brand: 'Toyota', model: 'Premio' });
  const V = veh.body?.data?.id;
  const svc = await send('POST', '/api/services', { name: '0007 Brake Service', category: 'Brakes', price: 1200 });
  const S = svc.body?.data?.id;
  const prt = await send('POST', '/api/parts', { name: '0007 Brake Pad', partNo: 'ES-BP-1', category: 'Brakes', unit: 'set', minStock: 0, sellingPrice: 3200, purchasePrice: 2500 });
  const P = prt.body?.data?.id;
  const mech = await send('POST', '/api/mechanics', { name: '0007 Estimate Mechanic', phone: '01933-000702', specialization: 'Brakes' });
  const M = mech.body?.data?.id;
  t('27 fixtures for the estimate section were created', [cust, veh, svc, prt, mech].every((r) => r.status === 201),
    [cust.status, veh.status, svc.status, prt.status, mech.status]);

  // 27a. create: totals on the server, an override kept, idempotent replay
  const key = `integration-0007-${Date.now()}-abcdef`;
  const body = {
    customerId: C, vehicleId: V, complaint: '0007: brakes grinding', createdBy: 'Integration',
    services: [{ serviceId: S, name: '0007 Brake Service', qty: 1, unitPrice: 1500 }],
    partsUsed: [{ partId: P, name: '0007 Brake Pad', partNo: 'ES-BP-1', qty: 2, unitPrice: 3200 }],
    discount: 500, taxRate: 5, idempotencyKey: key,
  };
  const c1 = await send('POST', '/api/estimates', body);
  const E = c1.body?.data;
  t('27a create -> 201 Draft, totals from the server (1500 + 6400 - 500, 5% tax = 7,770)',
    c1.status === 201 && E?.status === 'Draft' && E?.total === 7770 && E?.services?.[0]?.unitPrice === 1500, c1.body);
  const c2 = await send('POST', '/api/estimates', body);
  t('   ...the same key and payload replays the same estimate', c2.status === 200 && c2.body?.replayed === true && c2.body?.data?.id === E?.id, c2.body);
  const c3 = await send('POST', '/api/estimates', { ...body, total: 1 });
  t('   ...a client-sent total is refused (422)', c3.status === 422 && 'total' in (c3.body?.error?.fields ?? {}), c3.body);

  // 27b. edit and lifecycle
  const e1 = await send('PUT', `/api/estimates/${E?.id}`, { complaint: '0007: brakes and pads' });
  const e2 = await send('PUT', `/api/estimates/${E?.id}`, { complaint: '0007: brakes and pads', expectedUpdatedAt: E?.updatedAt });
  t('27b an edit needs expectedUpdatedAt (422), then -> version 2', e1.status === 422 && e2.status === 200 && e2.body?.data?.version === 2, [e1.body, e2.body]);
  const s1 = await send('POST', `/api/estimates/${E?.id}/send`, { by: 'Integration' });
  t('   ...send -> Pending', s1.status === 200 && s1.body?.data?.status === 'Pending', s1.body);
  const a0 = await send('POST', `/api/estimates/${E?.id}/approve`, {});
  const a1 = await send('POST', `/api/estimates/${E?.id}/approve`, { note: 'Approved by phone', by: 'Integration' });
  t('   ...approve needs a note (422), then -> Approved, decidedVia staff',
    a0.status === 422 && a1.status === 200 && a1.body?.data?.status === 'Approved' && a1.body?.data?.decidedVia === 'staff', [a0.body, a1.body]);

  // 27c. conversion through the job card route
  const stockBefore = (await get(`/api/parts/${P}`)).body?.data?.stock;
  const v0 = await send('POST', `/api/estimates/${E?.id}/convert`, {});
  const v1 = await send('POST', `/api/estimates/${E?.id}/convert`, { mechanicId: M, priority: 'high' });
  const J = v1.body?.jobCardId;
  t('27c convert needs a mechanic (422), then -> 200 with a job card id', v0.status === 422 && v1.status === 200 && /^JOB-\d+$/.test(J ?? ''), [v0.body, v1.body]);
  const job = await get(`/api/job-cards/${J}`);
  t('   ...the job card is Received, with the estimate total and lines',
    job.status === 200 && job.body?.data?.status === 'Received' && job.body?.data?.total === 7770 && job.body?.data?.partsUsed?.length === 1, job.body);
  const part = await get(`/api/parts/${P}`);
  t('   ...no stock moved', typeof stockBefore === 'number' && part.body?.data?.stock === stockBefore, [stockBefore, part.body]);
  const v2 = await send('POST', `/api/estimates/${E?.id}/convert`, { mechanicId: M });
  t('   ...converting again -> 409', v2.status === 409, v2.body);
  const dj = await send('DELETE', `/api/job-cards/${J}`);
  t('   ...the linked job card cannot be deleted (409)', dj.status === 409, dj.body);

  // 27d. cancel, no delete, and the gate
  const k2 = await send('POST', '/api/estimates', { ...body, idempotencyKey: `${key}-2` });
  const x1 = await send('POST', `/api/estimates/${k2.body?.data?.id}/cancel`, {});
  const x2 = await send('POST', `/api/estimates/${k2.body?.data?.id}/cancel`, { reason: 'Customer postponed', by: 'Integration' });
  t('27d cancel needs a reason (422), then -> Cancelled and kept',
    x1.status === 422 && x2.status === 200 && x2.body?.data?.status === 'Cancelled' && x2.body?.data?.cancelReason === 'Customer postponed', [x1.body, x2.body]);
  const del = await send('DELETE', `/api/estimates/${E?.id}`);
  t('   ...estimates are never deleted (405)', del.status === 405, del.status);
  const anon = await sendAnon('POST', '/api/estimates', body);
  const anonL = await sendAnon('GET', '/api/estimates');
  t('   ...without credentials every estimate route is 401', anon.status === 401 && anonL.status === 401, [anon.status, anonL.status]);

  // cleanup.sql removes these rows (estimates first) and resets the counters.
}

sec('28. Staff (0008): one roster of mechanics and other employees, against real D1');
{
  // 28a. every mechanic is on the roster, with no profile needed and no pay
  const list = await get('/api/staff?limit=1000');
  const ids = (list.body?.data ?? []).map((s) => s.id);
  t('28a GET /api/staff -> 200, listing the seeded mechanics as mechanics',
    list.status === 200 && ['MEC-9001', 'MEC-9002', 'MEC-9003'].every((id) => ids.includes(id))
      && list.body.data.filter((s) => /^MEC-9/.test(s.id)).every((s) => s.isMechanic === true && s.designation === 'Mechanic'), list.body);
  t('   ...and no pay anywhere, though MEC-9001 has a salary and commission', !/salary|commission/i.test(JSON.stringify(list.body)), '');

  // 28b. an employee who is not a mechanic
  const body = { name: 'Integration Accountant', phone: '01755000101', email: 'acct@example.test', employeeCode: 'IT-101',
    designation: 'Accountant', department: 'Accounts', joiningDate: '2025-01-15' };
  const c = await send('POST', '/api/staff', body);
  const S = c.body?.data?.id;
  t('28b create -> 201 with an STF id', c.status === 201 && /^STF-\d+$/.test(S ?? '') && c.body?.data?.isMechanic === false, c.body);
  const again = await get(`/api/staff?q=${encodeURIComponent('integration acc')}`);
  t('   ...a later read finds it (it was persisted)', again.status === 200 && again.body?.data?.length === 1 && again.body.data[0].id === S, again.body);
  const dupCode = await send('POST', '/api/staff', { ...body, phone: '01755000102', employeeCode: 'it-101' });
  t('   ...a duplicate employee code, any case -> 409 on employeeCode', dupCode.status === 409 && dupCode.body?.error?.field === 'employeeCode', dupCode.body);
  const dupPhone = await send('POST', '/api/staff', { ...body, employeeCode: 'IT-102', phone: '01911000001' });
  t('   ...an active mechanic\'s phone -> 409 naming the mechanic', dupPhone.status === 409 && dupPhone.body?.error?.conflictsWith === 'MEC-9001', dupPhone.body);
  const bad = await send('POST', '/api/staff', { name: 'X', phone: '01755000103', salary: 1 });
  t('   ...missing designation/department and a pay field -> 422 naming each',
    bad.status === 422 && ['designation', 'department', 'joiningDate', 'salary'].every((k) => k in (bad.body?.error?.fields ?? {})), bad.body);
  const forged = await send('POST', '/api/staff', { ...body, phone: '01755000105', employeeCode: 'IT-105', id: 'STF-0999', mechanicId: 'MEC-9001' });
  const notThere = await get('/api/staff/STF-0999');
  t('   ...an id or mechanicId chosen by the browser -> 422 naming each, and nothing is created',
    forged.status === 422 && ['id', 'mechanicId'].every((k) => k in (forged.body?.error?.fields ?? {})) && notThere.status === 404, [forged.body, notThere.status]);

  // 28c. deactivate, filter, no delete
  const off = await send('PUT', `/api/staff/${S}`, { status: 'Inactive' });
  const inactive = await get('/api/staff?status=Inactive');
  t('28c deactivate -> 200 Inactive, and the status filter finds it',
    off.status === 200 && off.body?.data?.status === 'Inactive' && inactive.body?.data?.some((s) => s.id === S), [off.body, inactive.body]);
  const del = await send('DELETE', `/api/staff/${S}`);
  t('   ...staff are never deleted (405, Allow: GET, PUT)', del.status === 405 && del.allow === 'GET, PUT', [del.status, del.allow]);

  // 28d. a mechanic, edited from the staff list, is the same record the Mechanics page shows
  const e = await send('PUT', '/api/staff/MEC-9001', { employeeCode: 'IT-001', department: 'Workshop', designation: 'Head Mechanic' });
  const mech = await get('/api/mechanics/MEC-9001');
  t('28d editing a mechanic\'s profile -> 200; the Mechanics record keeps its name and pay',
    e.status === 200 && e.body?.data?.designation === 'Head Mechanic' && mech.body?.data?.name === 'B5 Full Mechanic' && mech.body?.data?.salary === 32000, [e.body, mech.body]);
  const undated = await send('POST', '/api/staff', { isMechanic: true, name: 'Integration Mechanic', phone: '01755000104', specialization: 'Tyres' });
  t('   ...a new mechanic needs a joining date here (422), as every new employee does', undated.status === 422 && 'joiningDate' in (undated.body?.error?.fields ?? {}), undated.body);
  const m = await send('POST', '/api/staff', { isMechanic: true, name: 'Integration Mechanic', phone: '01755000104', specialization: 'Tyres', employeeCode: 'IT-104', joiningDate: '2025-03-01' });
  const MID = m.body?.data?.id;
  const viaMech = await get(`/api/mechanics/${MID}`);
  t('   ...a mechanic added from the staff list gets a MEC id the Mechanics API returns',
    m.status === 201 && /^MEC-\d+$/.test(MID ?? '') && viaMech.status === 200 && viaMech.body?.data?.specialization === 'Tyres', [m.body, viaMech.body]);
  const gone = await send('DELETE', `/api/mechanics/${MID}`);
  const after = await get(`/api/staff/${MID}`);
  t('   ...deleting that unused mechanic on the Mechanics page also removes its profile', gone.status === 200 && after.status === 404, [gone.status, after.status]);
  const used = await send('DELETE', '/api/mechanics/MEC-9001');
  t('   ...a mechanic with job cards still cannot be deleted (409), profile and all', used.status === 409 && (await get('/api/staff/MEC-9001')).status === 200, used.body);

  // 28e. the gate
  const anon = await sendAnon('GET', '/api/staff');
  const anonW = await sendAnon('POST', '/api/staff', body);
  t('28e without credentials every staff route is 401', anon.status === 401 && anonW.status === 401, [anon.status, anonW.status]);

  // cleanup.sql removes these rows (staff first) and resets the counters.
}

sec('29. User accounts (0009): sign-in for a staff member, against the real Worker');
{
  const PW = 'Integration-Pass-1';
  const SECRET_RE = /pbkdf2|password_hash|passwordHash|session_version|sessionVersion|failed_logins/i;
  const login = async (body) => {
    const res = await fetch(BASE + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  const as = async (method, path, cookie, body) => {
    const res = await fetch(BASE + path, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let parsed = null; try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, body: parsed };
  };

  // 29a. create, for an existing active staff member
  const made = await send('POST', '/api/accounts', { staffId: 'MEC-9001', username: 'It.Mechanic', role: 'Administrator', password: PW });
  const A = made.body?.data?.id;
  t('29a create -> 201 with a USR id, the username in lower case, linked to the mechanic by its MEC id',
    made.status === 201 && /^USR-\d+$/.test(A ?? '') && made.body?.data?.username === 'it.mechanic' && made.body?.data?.staffId === 'MEC-9001', made.body);
  t('   ...the response carries no password, hash or session value', !SECRET_RE.test(JSON.stringify(made.body)) && !JSON.stringify(made.body).includes(PW), made.body);
  const again = await send('POST', '/api/accounts', { staffId: 'MEC-9001', username: 'it.other', role: 'Administrator', password: PW });
  t('   ...a second account for the same person -> 409 naming the first', again.status === 409 && again.body?.error?.conflictsWith === A, again.body);
  const forged = await send('POST', '/api/accounts', { staffId: 'MEC-9001', username: 'it.forged', role: 'Administrator', password: PW, id: 'USR-0999', status: 'Inactive', passwordHash: 'x' });
  t('   ...unsupported properties (id, status, a hash) -> 422 naming each', forged.status === 422 && ['id', 'passwordHash', 'status'].every((k) => k in (forged.body?.error?.fields ?? {})), forged.body);
  const role = await send('POST', '/api/accounts', { staffId: 'MEC-9001', username: 'it.role', role: 'Mechanic', password: PW });
  t('   ...a role the Worker cannot enforce -> 422', role.status === 422 && 'role' in (role.body?.error?.fields ?? {}), role.body);

  // 29b. sign in with it
  const s1 = await login({ username: 'IT.MECHANIC', password: PW });
  t('29b username + password -> 204 and an account session cookie', s1.status === 204 && s1.cookie.startsWith('taqwa_session=a1.'), s1);
  t('   ...the cookie does not carry the password', !s1.cookie.includes(PW));
  const read = await as('GET', '/api/customers', s1.cookie);
  t('   ...the gate accepts it for business data', read.status === 200, read.status);
  const me = await as('GET', '/api/session', s1.cookie);
  t('   ...GET /api/session names the account (id, username, role only)',
    me.body?.data?.account?.id === A && me.body?.data?.account?.username === 'it.mechanic' && Object.keys(me.body?.data?.account ?? {}).sort().join() === 'id,role,username', me.body);
  const list = await as('GET', '/api/accounts', s1.cookie);
  t('   ...an Administrator account may list accounts; its own row is marked, nothing secret',
    list.status === 200 && list.body?.data?.some((a) => a.id === A && a.self === true) && !SECRET_RE.test(JSON.stringify(list.body)), list.body);
  const wrong = await login({ username: 'it.mechanic', password: 'Wrong-Password-9' });
  const nobody = await login({ username: 'it.nobody', password: PW });
  t('   ...a wrong password and an unknown username are the same 401, with no cookie', wrong.status === 401 && nobody.status === 401 && !wrong.cookie && !nobody.cookie, [wrong, nobody]);
  const pass = await login({ passphrase: process.env.TAQWA_PASSPHRASE || '' });
  t('   ...the workshop passphrase still signs in', pass.status === 204 && pass.cookie.startsWith('taqwa_session=v1.'), pass.status);
  const self = await as('PUT', `/api/accounts/${A}`, s1.cookie, { status: 'Inactive' });
  t('   ...nobody can deactivate their own account (409)', self.status === 409, self.body);

  // 29c. revocation and a new password
  const off = await send('PUT', `/api/accounts/${A}`, { status: 'Inactive' });
  const after = await as('GET', '/api/customers', s1.cookie);
  t('29c deactivate -> 200, and the account session stops working at once', off.status === 200 && off.body?.data?.status === 'Inactive' && after.status === 401, [off.status, after.status]);
  const on = await send('PUT', `/api/accounts/${A}`, { status: 'Active' });
  const stillOff = await as('GET', '/api/customers', s1.cookie);
  t('   ...re-activated: the old session stays dead', on.status === 200 && stillOff.status === 401, [on.status, stillOff.status]);
  const reset = await send('POST', `/api/accounts/${A}/password`, { password: 'Integration-Pass-2' });
  t('   ...a new password is set (200, nothing secret returned)', reset.status === 200 && !SECRET_RE.test(JSON.stringify(reset.body)), reset.body);
  t('   ...the old password no longer signs in, the new one does',
    (await login({ username: 'it.mechanic', password: PW })).status === 401 && (await login({ username: 'it.mechanic', password: 'Integration-Pass-2' })).status === 204);

  // 29d. the gate, and the people the account belongs to
  const anonList = await sendAnon('GET', '/api/accounts');
  const anonMake = await sendAnon('POST', '/api/accounts', { staffId: 'MEC-9001', username: 'x.y', role: 'Administrator', password: PW });
  t('29d without credentials every account route is 401', anonList.status === 401 && anonMake.status === 401, [anonList.status, anonMake.status]);
  const mech = await get('/api/mechanics/MEC-9001');
  t('   ...the mechanic is unchanged: same id, pay and name', mech.status === 200 && mech.body?.data?.salary === 32000 && mech.body?.data?.name === 'B5 Full Mechanic', mech.body);
  t('   ...there is no DELETE for accounts (405)', (await send('DELETE', `/api/accounts/${A}`)).status === 405);

  // cleanup.sql removes the account (user_accounts first) and resets the counters.
}

sec('30. Attendance (0010): one record per staff member per day, against real D1');
{
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const made = await send('POST', '/api/attendance', { staffId: 'MEC-9001', date: today, status: 'Present', checkIn: '09:00', checkOut: '18:00', notes: 'integration' });
  t('30a record a day -> 201, a server id, the mechanic joined in', made.status === 201 && /^ATT-\d{4,}$/.test(made.body?.data?.id || '')
    && made.body?.data?.staffName === 'B5 Full Mechanic' && made.body?.data?.date === today, made.body);
  const R = made.body?.data;
  const dup = await send('POST', '/api/attendance', { staffId: 'MEC-9001', date: today, status: 'Absent' });
  t('   ...a second record for the same person and day -> 409, naming the first', dup.status === 409 && dup.body?.error?.conflictsWith === R?.id, dup.body);
  const future = await send('POST', '/api/attendance', { staffId: 'MEC-9001', date: '2999-01-01', status: 'Present' });
  const forged = await send('POST', '/api/attendance', { staffId: 'MEC-9001', date: today, status: 'Present', id: 'ATT-0999', updatedAt: 'x' });
  t('   ...a future day and unknown properties -> 422', future.status === 422 && forged.status === 422, [future.status, forged.status]);
  const list = await get(`/api/attendance?date=${today}`);
  t('30b list one day -> the record', list.status === 200 && (list.body?.data ?? []).some((a) => a.id === R?.id), list.body);
  const edit = await send('PUT', `/api/attendance/${R?.id}`, { status: 'Late', checkIn: '10:00', expectedUpdatedAt: R?.updatedAt });
  t('30c correct it with the updatedAt it was made from -> 200', edit.status === 200 && edit.body?.data?.status === 'Late' && edit.body?.data?.checkIn === '10:00', edit.body);
  const stale = await send('PUT', `/api/attendance/${R?.id}`, { status: 'Absent', checkIn: '', checkOut: '', expectedUpdatedAt: R?.updatedAt });
  t('   ...a second edit made from the old copy -> 409, the correction stays', stale.status === 409 && (await get(`/api/attendance/${R?.id}`)).body?.data?.status === 'Late', stale.body);
  const anon = await sendAnon('GET', '/api/attendance');
  t('30d without credentials -> 401; there is no DELETE (405)', anon.status === 401 && (await send('DELETE', `/api/attendance/${R?.id}`)).status === 405, anon.status);
  // cleanup.sql removes the record (attendance first) and resets the counters.
}

sec('31. Notifications (0017): raised by real events in the Workers runtime, against real D1');
{
  // The notification is written after the answer (ctx.waitUntil), so allow it a moment.
  const find = async (q) => {
    for (let i = 0; i < 20; i++) {
      const r = await get(`/api/notifications?q=${encodeURIComponent(q)}`);
      if ((r.body?.data ?? []).length) return r;
      await new Promise((res) => setTimeout(res, 100));
    }
    return get(`/api/notifications?q=${encodeURIComponent(q)}`);
  };
  const made = await send('POST', '/api/customers', { name: 'Notify Integration Customer', phone: '01700009031' });
  t('31a creating a customer -> 201', made.status === 201, made.body);
  const listed = await find('Notify Integration Customer');
  const n = (listed.body?.data ?? [])[0];
  t('   ...raises one "New customer registered", unread, linked to it', listed.status === 200 && listed.body?.data?.length === 1
    && n?.title === 'New customer registered' && n?.recordType === 'customer' && n?.recordId === made.body?.data?.id && n?.read === false, listed.body);
  const count = await get('/api/notifications/unread-count');
  t('31b unread-count answers for polling', count.status === 200 && count.body?.data?.unread >= 1 && count.body?.data?.latestId >= n?.id, count.body);
  const read = await send('POST', `/api/notifications/${n?.id}/read`, {});
  t('31c mark it read -> 200, read, and the count drops', read.status === 200 && read.body?.data?.read === true
    && read.body?.summary?.unread === count.body?.data?.unread - 1, read.body);
  const unread = await send('POST', `/api/notifications/${n?.id}/unread`, {});
  t('   ...mark it unread again -> 200', unread.status === 200 && unread.body?.data?.read === false, unread.body);
  const all = await send('POST', '/api/notifications/read-all', {});
  t('31d mark all read -> nothing unread', all.status === 200 && all.body?.summary?.unread === 0, all.body);
  const before = (await get('/api/notifications')).body?.total;
  const bad = await send('POST', '/api/customers', { name: '' });
  await new Promise((res) => setTimeout(res, 300));
  t('31e a refused create (422) raises nothing', bad.status === 422 && (await get('/api/notifications')).body?.total === before);
  const anon = await sendAnon('GET', '/api/notifications');
  t('31f without credentials -> 401', anon.status === 401, anon.status);
  // cleanup.sql removes the notifications and read markers with the other fixture rows.
}

console.log(`\nAPI integration: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
