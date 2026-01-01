import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { parseAmount, formatAmount, isDemo, validateOrder, verifyTurnstile } from '../worker/lib.js';
import { verifyAccessToken } from '../worker/access.js';
import { seal, unseal, credentialsFor, accountState } from '../worker/vault.js';
import { createPayment, queryPayment, mapPaymentResult, upstream, verifyAccount } from '../worker/provider.js';
import { applyPaymentResult, reconcileOrder, reconcileScheduled } from '../worker/reconcile.js';
import { importSession } from '../worker/admin.js';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';

function setup() {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0002_account.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0003_reconciliation.sql', import.meta.url), 'utf8'));
  const wrap = (sql, values = []) => ({ bind: (...args) => wrap(sql, args), first: async () => db.prepare(sql).get(...values) || null, all: async () => ({results:db.prepare(sql).all(...values)}), run: async () => ({ meta: { changes: db.prepare(sql).run(...values).changes } }) });
  const env = { DB: { prepare: wrap, batch: async (statements) => { db.exec('BEGIN'); try { const result = []; for (const stmt of statements) result.push(await stmt.run()); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } } }, LOCAL_DEMO: 'true' };
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
test('account and admin APIs reject missing SSO even with forged email headers', async () => {
  const { env } = setup(); env.LOCAL_DEMO = 'false';
  const response = await worker.fetch(new Request('https://feedfish.example/api/admin/session', { headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.com' } }), env);
  assert.equal(response.status, 503);
  const protectedPage = await worker.fetch(new Request('https://feedfish.example/admin/'), env);
  assert.equal(protectedPage.status, 503);
});
test('Access JWT checks real signatures, audience, issuer, expiration and email allowlist', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'test';
  const keys = createLocalJWKSet({ keys: [jwk] });
  const env = { ACCESS_TEAM_DOMAIN: 'https://test-team.cloudflareaccess.com', ACCESS_AUD: 'admin-app', ADMIN_EMAILS: 'owner@example.com' };
  const sign = (claims = {}) => new SignJWT({ email: 'owner@example.com', sub: 'owner', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, iss: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(privateKey);
  assert.equal((await verifyAccessToken(await sign(), env, keys)).email, 'owner@example.com');
  for (const claims of [{ aud: 'other' }, { iss: 'https://evil.example' }, { email: 'other@example.com' }, { exp: 1 }]) await assert.rejects(verifyAccessToken(await sign(claims), env, keys), { code: 'ACCESS_DENIED' });
  const token = await sign(); const parts = token.split('.'); parts[1] = Buffer.from(JSON.stringify({ email: 'owner@example.com', sub: 'forged' })).toString('base64url');
  await assert.rejects(verifyAccessToken(parts.join('.'), env, keys), { code: 'ACCESS_DENIED' });
});
test('vault uses unique nonces and authenticated encryption with no plaintext token', async () => {
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'); const credentials = { sessionToken: 'private-session-token', deviceId: 'device' };
  const a = await seal(credentials, key); const b = await seal(credentials, key);
  assert.notEqual(a, b); assert.equal(a.includes(credentials.sessionToken), false); assert.deepEqual(await unseal(a, key), credentials);
  await assert.rejects(unseal(a, Buffer.alloc(32).toString('base64')), { code: 'VAULT_UNAVAILABLE' });
  const corrupted = JSON.parse(a); corrupted.data = `AAAA${corrupted.data.slice(4)}`;
  await assert.rejects(unseal(JSON.stringify(corrupted), key), { code: 'VAULT_UNAVAILABLE' });
});
test('disabled account blocks new orders but preserves credentials for existing order queries', async () => {
  const { env, db } = setup(); env.DEEPSEEK_ACCOUNT_ID = 'fixed-account'; env.ACCOUNT_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64'); env.DEEPSEEK_SESSION_TOKEN = 'old-secret-must-not-override';
  const value = await seal({ sessionToken: 'saved-session' }, env.ACCOUNT_ENCRYPTION_KEY);
  db.prepare('INSERT INTO account_session VALUES (1,?,?,?,?,?,?)').run('fixed-account', value, 'disabled', Date.now(), Date.now(), 'owner@example.com');
  assert.equal((await accountState(env)).configured, false);
  await assert.rejects(credentialsFor(env), { code: 'ACCOUNT_UNAVAILABLE' });
  assert.equal((await credentialsFor(env, true)).sessionToken, 'saved-session');
});
test('local demo admin is read-only and never returns configured secrets', async () => {
  const { env, request } = setup(); env.DEEPSEEK_SESSION_TOKEN = 'super-secret';
  const response = await request('/api/admin/session'); const text = await response.text();
  assert.equal(response.status, 200); assert.equal(text.includes('super-secret'), false);
  assert.equal((await request('/api/admin/account/session', { method: 'POST', headers: { 'X-Feedfish-Admin': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: 'never-save' }) })).status, 403);
});
const success = (data) => Response.json({ code: 0, data: { biz_code: 0, biz_data: data } });
test('first trusted session import encrypts credentials but cannot collect before deployment pin', async () => {
  const { env, db } = setup(); env.LOCAL_DEMO = 'false'; env.ACCOUNT_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
  const credentials = { sessionToken: 'owner-session-not-for-logs' };
  await importSession(env, credentials, 'owner@example.com', Date.now(), async () => success({ id: 'fixed-owner', currency: 'CNY' }));
  const row = db.prepare('SELECT * FROM account_session').get();
  assert.equal(row.account_id, 'fixed-owner'); assert.equal(row.sealed_credentials.includes(credentials.sessionToken), false);
  assert.equal((await accountState(env)).configured, false);
  await assert.rejects(credentialsFor(env), { code: 'ACCOUNT_NOT_CONFIGURED' });
  env.DEEPSEEK_ACCOUNT_ID = 'fixed-owner';
  assert.equal((await accountState(env)).configured, true);
  assert.equal((await credentialsFor(env)).sessionToken, credentials.sessionToken);
});
test('staged and pinned sessions reject account replacement and unusable CNY accounts', async () => {
  const { env, db } = setup(); env.ACCOUNT_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
  const credentials = { sessionToken: 'owner-session' };
  for (const user of [{ id: 'owner', currency: 'USD' }, { id: 'owner', currency: 'CNY', is_api_banned: true }, { id: 'owner', currency: 'CNY', feature_gates: { PAYMENT: false } }]) await assert.rejects(importSession(env, credentials, 'owner@example.com', Date.now(), async () => success(user)), { code: 'ACCOUNT_UNAVAILABLE' });
  assert.equal(db.prepare('SELECT count(*) n FROM account_session').get().n, 0);
  await importSession(env, credentials, 'owner@example.com', Date.now(), async () => success({ id: 'owner', currency: 'CNY' }));
  await assert.rejects(importSession(env, { sessionToken: 'other' }, 'owner@example.com', Date.now(), async () => success({ id: 'other', currency: 'CNY' })), { code: 'ACCOUNT_MISMATCH' });
  env.DEEPSEEK_ACCOUNT_ID = 'other';
  await assert.rejects(importSession(env, { sessionToken: 'other' }, 'owner@example.com', Date.now(), async () => success({ id: 'other', currency: 'CNY' })), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(db.prepare('SELECT account_id FROM account_session').get().account_id, 'owner');
});
test('concurrent first imports can lock only one fixed account', async () => {
  const { env, db } = setup(); env.ACCOUNT_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
  const results = await Promise.allSettled(['owner-a', 'owner-b'].map(id => importSession(env, { sessionToken: id }, 'owner@example.com', Date.now(), async () => success({ id, currency: 'CNY' }))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'ACCOUNT_MISMATCH');
  assert.equal(db.prepare('SELECT count(*) n FROM account_session').get().n, 1);
});
test('provider uses observed CNY endpoints, integer yuan, fixed account and preserves fallback URL', async () => {
  const env = { DEEPSEEK_ACCOUNT_ID: 'fixed', DEEPSEEK_SESSION_TOKEN: 'private-token' }; const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options }); return url.endsWith('/current') ? success({ id: 'fixed', currency: 'CNY' }) : success({ payment_order_id: 'upstream-1', amount: '10.000000', url: 'https://payment.example/code', fallback: true }); };
  const payment = await createPayment(env, { amountFen: 1000, paymentMethod: 'alipay', requestId: crypto.randomUUID() }, fetcher);
  assert.equal(calls[0].url, 'https://platform.deepseek.com/auth-api/v0/users/current');
  assert.equal(calls[1].url, 'https://platform.deepseek.com/api/v1/payments');
  const body = JSON.parse(calls[1].options.body); assert.equal(body.order_info.amount, '10'); assert.equal(body.order_info.currency, 'CNY'); assert.equal(body.order_info.fallback_method_type, 'ALIPAY'); assert.equal(body.order_info.payment_method_type, 'CMB_UNIONPAY');
  assert.equal(payment.providerOrderId, 'upstream-1'); assert.equal(payment.paymentUrl, 'https://payment.example/code'); assert.equal(JSON.stringify(payment).includes('private-token'), false);
  await assert.rejects(verifyAccount(env, { sessionToken: 'wrong-account-token' }, async () => success({ id: 'someone-else', currency: 'CNY' })), { code: 'ACCOUNT_MISMATCH' });
});
test('provider recognizes expired tokens even in HTTP errors and never leaks raw error text', async () => {
  await assert.rejects(upstream('/auth-api/v0/users/current', { sessionToken: 'private' }, undefined, async () => Response.json({ code: 40003, msg: 'private' }, { status: 401 })), { code: 'SESSION_EXPIRED' });
  await assert.rejects(upstream('/auth-api/v0/users/current', { sessionToken: 'private' }, undefined, async () => new Response('<html>challenge private</html>', { status: 403 })), (error) => error.code === 'UPSTREAM_UNAVAILABLE' && !error.message.includes('private'));
});
test('capture status cannot accept mismatched IDs, amounts or currencies', () => {
  const row = { provider_order_id: 'upstream-1', amount_fen: 1000 };
  assert.equal(mapPaymentResult({ order: { status: 'SUCCESS' } }, row).status, 'paid');
  for (const extra of [{ id: 'another-order' }, { payment_order_id: 'another-order' }, { amount: '11' }, { currency: 'USD' }, { status: 'UNRECOGNIZED' }]) assert.throws(() => mapPaymentResult({ order: { status: 'SUCCESS', ...extra } }, row));
  assert.equal(mapPaymentResult({ order: { status: 'PENDING' } }, row).providerStatus, 'PENDING');
});
test('confirmed time is separate from provider paid_at; stale duplicate callbacks do not create events', async () => {
  const { env, create, db } = setup(); const order = await (await create()).json(); const row = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  const now = Date.now();
  await applyPaymentResult(env, row, { status: 'paid', providerStatus: 'SUCCESS' }, 'scheduled', now);
  await applyPaymentResult(env, row, { status: 'paid', providerStatus: 'SUCCESS' }, 'poll', now + 1000);
  const paid = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  assert.equal(paid.paid_at, null); assert.equal(paid.confirmed_at, now); assert.equal(paid.payment_state, 'paid');
  assert.equal(db.prepare('SELECT count(*) AS n FROM payment_events').get().n, 1);
  await applyPaymentResult(env, paid, { status: 'pending', providerStatus: 'CREATED' }, 'poll', now + 2000);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(order.id).status, 'paid');
});
test('local QR timeout remains pending upstream and can later reconcile success', async () => {
  const { env, create, db } = setup(); const order = await (await create()).json();
  db.prepare('UPDATE orders SET expires_at=?,is_demo=0 WHERE id=?').run(Date.now() - 1000, order.id);
  let row = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  await reconcileOrder(env, row, 'scheduled', async () => ({ status: 'pending', providerStatus: 'CREATED' }));
  row = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  assert.equal(row.status, 'pending'); assert.equal(row.payment_state, 'expired');
  await applyPaymentResult(env, row, { status: 'paid', providerStatus: 'SUCCESS' }, 'scheduled');
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(order.id).status, 'paid');
});
test('upstream network failure records a query error without declaring payment failed', async () => {
  const { env, create, db } = setup(); const order = await (await create()).json(); db.prepare('UPDATE orders SET is_demo=0 WHERE id=?').run(order.id);
  const row = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  await assert.rejects(reconcileOrder(env, row, 'scheduled', async () => { throw new Error('network'); }));
  const latest = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id); assert.equal(latest.status, 'pending'); assert.equal(latest.last_check_error, 'QUERY_UNAVAILABLE');
});
test('refund is a later terminal event and is not overwritten by a stale success', async () => {
  const { env, create, db } = setup(); const order = await (await create()).json();
  let row = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  await applyPaymentResult(env, row, { status: 'paid', providerStatus: 'SUCCESS' }, 'scheduled');
  row = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  await applyPaymentResult(env, row, { status: 'failed', providerStatus: 'REFUNDED' }, 'scheduled');
  row = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  await applyPaymentResult(env, row, { status: 'paid', providerStatus: 'SUCCESS' }, 'poll');
  assert.equal(db.prepare('SELECT payment_state FROM orders WHERE id=?').get(order.id).payment_state, 'refunded');
});
test('admin ledger exposes notes and distinct timestamps only behind admin endpoint', async () => {
  const { create, request } = setup(); await create({ message: '<script>do not execute</script>' });
  const data = await (await request('/api/admin/orders')).json();
  assert.equal(data.orders[0].nickname, '小鱼'); assert.equal(data.orders[0].message, '<script>do not execute</script>'); assert.equal(data.orders[0].paidAt, null); assert.equal(data.orders[0].confirmedAt, null); assert.equal(data.orders[0].channelOrderId, null);
  assert.equal((await request('/api/payments/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'SUCCESS' }) })).status, 404);
});
