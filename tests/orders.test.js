import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { parseAmount, formatAmount, isDemo, validateOrder, verifyTurnstile } from '../worker/lib.js';

function setup() {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const wrap = (sql, values = []) => ({ bind: (...args) => wrap(sql, args), first: async () => db.prepare(sql).get(...values) || null, run: async () => ({ meta: { changes: db.prepare(sql).run(...values).changes } }) });
  const env = { DB: { prepare: wrap }, LOCAL_DEMO: 'true' };
  const request = (path, options = {}) => worker.fetch(new Request(`http://localhost${path}`, options), env);
  const create = (body = {}, key = crypto.randomUUID()) => request('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ amount: '10.00', paymentMethod: 'wechat', nickname: '小鱼', message: '继续加油', ...body }) });
  return { db, env, request, create };
}
test('CNY money uses integer fen and rejects coercion/rounding/overflow', () => {
  assert.equal(parseAmount('1.01'), 101); assert.equal(parseAmount('100000.00'), 10000000); assert.equal(formatAmount(1001), '10.01');
  for (const value of [1, null, undefined, '', '0.99', '-1', '1e2', '1.001', 'Infinity', '100000.01', '01', ' 10', '.5', '1.']) assert.throws(() => parseAmount(value));
});
test('text and method validation rejects malformed values', () => {
  assert.equal(validateOrder({ amount: '1', paymentMethod: 'alipay' }).nickname, '匿名');
  assert.throws(() => validateOrder({ amount: '1', paymentMethod: 'paypal' }));
  assert.throws(() => validateOrder({ amount: '1', paymentMethod: 'wechat', message: 'x'.repeat(301) }));
});
test('demo cannot be enabled on an internet hostname', async () => {
  const env = { LOCAL_DEMO: 'true' }; const request = new Request('https://feedfish.example/api/config');
  assert.equal(isDemo(request, env), false);
  const response = await worker.fetch(request, env); const body = await response.json();
  assert.equal(body.demo, false); assert.equal(body.paymentsAvailable, false);
  const payment = await worker.fetch(new Request('https://feedfish.example/api/orders', { method: 'POST', headers: { Origin: 'https://feedfish.example' } }), { ...env, DB: {} });
  assert.equal(payment.status, 503);
});
test('idempotent replay returns one order and same credential; altered body conflicts', async () => {
  const { db, create } = setup(); const key = crypto.randomUUID();
  const first = await create({}, key); assert.equal(first.status, 201); const a = await first.json();
  const second = await create({}, key); assert.equal(second.status, 200); const b = await second.json();
  assert.equal(a.id, b.id); assert.equal(a.accessToken, b.accessToken); assert.equal(a.status, 'pending'); assert.match(a.qrCode, /^feedfish-demo:/);
  assert.equal((await create({ amount: '11' }, key)).status, 409);
  assert.equal(db.prepare('SELECT count(*) AS n FROM orders').get().n, 1);
  assert.equal(db.prepare('SELECT token_hash FROM orders').get().token_hash.includes(a.accessToken), false);
});
test('concurrent duplicate create reserves one order', async () => {
  const { db, create } = setup(); const key = crypto.randomUUID();
  const responses = await Promise.all([create({}, key), create({}, key)]);
  assert.equal(responses.filter((response) => response.status === 201).length, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM orders').get().n, 1);
});
test('order queries isolate access and never expose nickname, message or upstream ID', async () => {
  const { request, create } = setup(); const a = await (await create()).json(); const b = await (await create()).json();
  assert.equal((await request(`/api/orders/${a.id}`)).status, 401);
  assert.equal((await request(`/api/orders/${a.id}`, { headers: { Authorization: `Bearer ${b.accessToken}` } })).status, 404);
  const response = await request(`/api/orders/${a.id}`, { headers: { Authorization: `Bearer ${a.accessToken}` } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const data = await response.json();
  for (const key of ['nickname', 'message', 'provider_order_id', 'token_hash', 'accessToken']) assert.equal(key in data, false);
  assert.equal(data.status, 'pending');
});
test('only explicit local demo action can mark a demo paid', async () => {
  const { create, request } = setup(); const order = await (await create()).json(); const headers = { Authorization: `Bearer ${order.accessToken}` };
  assert.equal((await (await request(`/api/orders/${order.id}`, { headers })).json()).status, 'pending');
  assert.equal((await request(`/api/orders/${order.id}/demo-pay`, { method: 'POST', headers })).status, 200);
  const paid = await (await request(`/api/orders/${order.id}`, { headers })).json();
  assert.equal(paid.status, 'paid'); assert.equal(paid.qrCode, null);
});
test('expired demo hides QR and cannot be paid', async () => {
  const { create, request, db } = setup(); const order = await (await create()).json();
  db.prepare('UPDATE orders SET expires_at=? WHERE id=?').run(Date.now() - 1000, order.id);
  const headers = { Authorization: `Bearer ${order.accessToken}` };
  assert.equal((await request(`/api/orders/${order.id}/demo-pay`, { method: 'POST', headers })).status, 409);
  const expired = await (await request(`/api/orders/${order.id}`, { headers })).json(); assert.equal(expired.status, 'expired'); assert.equal(expired.qrCode, null);
});
test('cross-origin writes, oversized bodies and excessive creation are blocked', async () => {
  const { request, create } = setup();
  assert.equal((await request('/api/orders', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await create({ message: 'x'.repeat(9000) })).status, 413);
  for (let i = 0; i < 5; i++) await create();
  assert.equal((await create()).status, 429);
});
test('Turnstile validates action and hostname as well as success', async () => {
  const request = new Request('https://feedfish.example/api/orders'); const env = { TURNSTILE_SECRET_KEY: 'secret' };
  for (const result of [{ success: false }, { success: true, hostname: 'evil.example', action: 'create_order' }, { success: true, hostname: 'feedfish.example', action: 'other' }]) {
    await assert.rejects(verifyTurnstile(request, env, 'test', async () => Response.json(result)), { code: 'CAPTCHA_INVALID' });
  }
  await verifyTurnstile(request, env, 'test', async () => Response.json({ success: true, hostname: 'feedfish.example', action: 'create_order' }));
});
