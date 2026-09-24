const assert = require('node:assert/strict');
const db = require('../app/services/db');
const demo = require('../app/lib/demo');
function enter(cookie = '') {
  const headers = {};
  const req = { headers: { cookie }, method: 'GET' };
  demo.session(req, { setHeader: (name, value) => { headers[name] = value; } }, () => {});
  return { id: req.guestId, cookie: headers['Set-Cookie']?.split(';')[0] };
}
const first = enter();
assert.ok(first.cookie);
assert.equal(enter(first.cookie).id, first.id);
const forged = enter(first.cookie.slice(0, -1) + (first.cookie.endsWith('0') ? '1' : '0'));
assert.notEqual(forged.id, first.id);
const second = enter();
assert.notEqual(second.id, first.id);
const old = db.getPool;
const taskId = '00000000-0000-4000-8000-000000000001';
db.getPool = () => ({ query: async (_sql, params) => ({ rows: params[1] === first.id ? [{ '?column?': 1 }] : [] }) });
(async () => {
  assert.equal(await demo.ownsTask(taskId, first.id), true);
  assert.equal(await demo.ownsTask(taskId, second.id), false);
  assert.equal(await demo.ownsTask('invalid-id', first.id), false);
  console.log('Guest isolation PASS');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => { db.getPool = old; });
