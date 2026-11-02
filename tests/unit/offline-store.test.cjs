/* offline-store — the encrypted, read-only offline copy (js/offline.js), with
   the REAL WebCrypto of Node and an in-memory store in place of IndexedDB.

     1. A person enrolled online can open their copy offline with the same
        password, by username, Staff ID or e-mail (any case).
     2. A wrong password, an unknown identifier, and someone else's password
        all get the same refusal; nothing secret is stored in clear.
     3. A copy older than 14 days will not open, and editing the stored
        timestamps cannot extend it (the age is read from inside the
        authenticated copy); a tampered copy does not open.
     4. Two people on one computer each open only their own copy.
     5. After a password change the old password stops working and the new
        one works once the copy is saved again; forget / forgetAll remove
        entries; the device id is stable. */
const path = require('path'), fs = require('fs'), vm = require('vm');
const { check, ok, summary } = require('../lib/harness.cjs');
// The browser script, run as the browser runs it, with Node's real WebCrypto.
const ctx = { crypto: globalThis.crypto, btoa, atob, TextEncoder, TextDecoder, Uint8Array, JSON, Date, Map, Set, Promise, Error, Number, String, Object, Array, Math };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../js/offline.js'), 'utf8') + '\nglobalThis.Offline = Offline;', ctx);
const { Offline } = ctx;

(async () => {
  console.log('=== offline-store: the encrypted offline copy ===\n');
  const store = Offline.memoryStore();
  Offline.useStore(store);
  const PW = 'My-Own-Secret-22';
  const nadia = { id: 'USR-0001', username: 'nadia', name: 'Test Nadia', staffId: 'STF-0001', role: 'Accountant' };
  const rafi = { id: 'USR-0002', username: 'rafi', name: 'Test Rafi', staffId: 'MEC-0002', role: 'Mechanic' };
  const DATA = { collections: { customers: [{ id: 'CUS-0001', name: 'Test Customer' }], invoices: [{ id: 'INV-0001', total: 1000 }] }, settings: { businessName: 'Test Workshop' }, permissions: ['customers.view'] };

  console.log('-- 1. enrol, save, open --');
  const dev1 = await Offline.deviceId();
  check('a device id is made once and kept', [/^[0-9a-f-]{36}$/.test(dev1), await Offline.deviceId()], [true, dev1]);
  ok('enrolling needs an account and a password', !(await Offline.enroll(nadia, '')) && !(await Offline.enroll(null, PW)), '');
  ok('enrol after an online sign-in', await Offline.enroll(nadia, PW, 'Nadia@Example.com'), '');
  check('saving the copy needs no secret (only the public key)', await Offline.saveSnapshot('USR-0001', DATA), true);
  check('...and nothing is saved for someone not enrolled here', await Offline.saveSnapshot('USR-0099', DATA), false);
  for (const id of ['nadia', 'NADIA', 'stf-0001', 'nadia@example.com']) {
    const r = await Offline.unlock(id, PW);
    check(`opens with "${id}" and the password`, [r.ok, r.ok && r.data.collections.customers[0].name, r.ok && r.user.role], [true, 'Test Customer', 'Accountant']);
  }

  const opened = await Offline.unlock('nadia', PW);
  check('the next page of the same tab re-opens it with the tab\'s session key, no password', (await Offline.openWithSession('USR-0001', opened.sessionKey)).ok, true);
  check('   ...a wrong key, or someone else\'s account, does not', [(await Offline.openWithSession('USR-0001', btoa('x'.repeat(32)))).ok, (await Offline.openWithSession('USR-0099', opened.sessionKey)).ok], [false, false]);
  check('   ...nor after 14 days', (await Offline.openWithSession('USR-0001', opened.sessionKey, Date.now() + 15 * 86400000)).code, 'expired');
  await Offline.saveSnapshot('USR-0001', DATA);
  check('   ...nor once a newer copy has been saved (new key)', (await Offline.openWithSession('USR-0001', opened.sessionKey)).ok, false);

  console.log('\n-- 2. refusals, and nothing in clear --');
  const wrong = await Offline.unlock('nadia', 'Wrong-Password-1');
  const unknown = await Offline.unlock('nobody', PW);
  check('a wrong password and an unknown identifier: the same answer', [wrong.ok, unknown.ok, wrong.message === unknown.message], [false, false, true]);
  const raw = JSON.stringify([await store.all('users'), await store.all('snapshots')]);
  ok('the store holds no password and no business data in clear', !raw.includes(PW) && !raw.includes('Test Customer') && !raw.includes('INV-0001'), raw.slice(0, 200));
  const user = (await store.all('users'))[0];
  check('the private key is wrapped (PBKDF2-SHA-256, 310,000 rounds, random salt)', [user.iterations, typeof user.wrappedPrivateKey, user.salt.length > 10], [310000, 'string', true]);

  console.log('\n-- 3. age and tampering --');
  const in8days = Date.now() + 15 * 86400000;
  check('a copy more than 14 days old will not open', (await Offline.unlock('nadia', PW, in8days)).code, 'expired');
  const snap = await store.get('snapshots', 'USR-0001');
  await store.put('snapshots', { ...snap, savedAt: new Date(in8days).toISOString() });
  await store.put('users', { ...(await store.get('users', 'USR-0001')), lastOnlineAt: new Date(in8days).toISOString() });
  check('   ...and editing the stored dates does not extend it (the age is inside the sealed copy)', (await Offline.unlock('nadia', PW, in8days)).code, 'expired');
  const ct = Buffer.from(snap.ciphertext, 'base64'); ct[5] ^= 1;
  await store.put('snapshots', { ...snap, ciphertext: ct.toString('base64') });
  check('a tampered copy does not open', (await Offline.unlock('nadia', PW)).code, 'damaged');
  await Offline.saveSnapshot('USR-0001', DATA);

  console.log('\n-- 4. two people, one computer --');
  await Offline.enroll(rafi, 'Rafi-Own-Pass-33');
  await Offline.saveSnapshot('USR-0002', { ...DATA, collections: { customers: [{ id: 'CUS-0002', name: 'Rafi Copy' }] } });
  check('each opens only their own copy', [(await Offline.unlock('rafi', 'Rafi-Own-Pass-33')).data.collections.customers[0].name, (await Offline.unlock('nadia', PW)).data.collections.customers[0].name],
    ['Rafi Copy', 'Test Customer']);
  check('one person\'s password does not open the other\'s copy', (await Offline.unlock('rafi', PW)).ok, false);
  check('status lists who can open a copy here -- names and times only', (await Offline.status()).map((s) => [s.accountId, s.role, !!s.savedAt, Object.keys(s).includes('wrappedPrivateKey')]),
    [['USR-0001', 'Accountant', true, false], ['USR-0002', 'Mechanic', true, false]]);

  console.log('\n-- 5. password change, forget --');
  await Offline.enroll(nadia, 'Changed-Pass-44');
  check('after a password change the copy must be saved again (the old key is gone)', (await Offline.unlock('nadia', 'Changed-Pass-44')).code, 'no_copy');
  await Offline.saveSnapshot('USR-0001', DATA);
  check('   ...then the new password opens it and the old one does not', [(await Offline.unlock('nadia', 'Changed-Pass-44')).ok, (await Offline.unlock('nadia', PW)).ok], [true, false]);
  await Offline.forget('USR-0002');
  check('forget removes one person', [(await Offline.status()).length, (await Offline.unlock('rafi', 'Rafi-Own-Pass-33')).ok], [1, false]);
  await Offline.forgetAll();
  check('forgetAll removes every copy; the device id stays', [await Offline.hasCopies(), (await Offline.status()).length, await Offline.deviceId()], [false, 0, dev1]);
  check('identifiers are normalised like the server does', [Offline.normalise(' MEC-0012 '), Offline.normalise('Nadia.A'), Offline.normalise('A@B.COM')], ['MEC-0012', 'nadia.a', 'a@b.com']);

  process.exit(summary('offline-store') === 0 ? 0 : 1);
})();
