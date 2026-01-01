import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentJob, paymentJobResult, PAYMENT_JOB_TTL, PAYMENT_RPC_TIMEOUT } from '../shared/agent-payment-protocol.js';
import { executePaymentJob } from '../scripts/agent-payments.mjs';
import { agentPaymentFetcher } from '../worker/agent-payments.js';
import { BrowserAgentRelay } from '../worker/browser-agent-relay.js';
import { createPayment, queryPayment, mapPaymentResult } from '../worker/provider.js';
import { assertAdminPaymentTransport } from '../worker/admin-payments.js';
const base = (operation = 'create') => ({ type: 'payment-job', id: crypto.randomUUID(), accountId: 'fixed', operation, requestId: crypto.randomUUID(), paymentMethod: 'wechat', amountFen: 100 });
const envelope = (data) => ({ ok: true, creationAttempted: true, httpStatus: 200, isJson: true, data: { code: 0, data: { biz_code: 0, biz_data: data } } });
const account = async () => ({ ok: true, accountId: 'fixed', currency: 'CNY', eligible: true });
const rpcEnv = (respond) => ({ DEEPSEEK_ACCOUNT_ID: 'fixed', PAYMENT_TRANSPORT: 'agent', AGENT_RELAY: { idFromName: (value) => value, get: () => ({ fetch: async (request) => Response.json(await respond(await request.json())) }) } });

test('cached legacy admin clients cannot create more Cloudflare tests or acquire a challenge browser', () => {
  for (const [path, body] of [
    ['/api/admin/account/test-payment', {}], ['/api/admin/account/test-payment', { transport: 'browser' }],
    ['/api/admin/account/check-payment', {}], ['/api/admin/account/payment-challenge/start', {}],
    ['/api/admin/account/payment-challenge/complete', {}], ['/api/admin/account/check', { transport: 'browser' }],
    ['/api/admin/account/authorize/connectivity', { transport: 'browser' }],
  ]) assert.throws(() => assertAdminPaymentTransport({}, path, body), { code: 'LEGACY_TRANSPORT_RETIRED', status: 409 });
  for (const path of ['/api/admin/account/test-payment', '/api/admin/account/check-payment']) assert.doesNotThrow(() => assertAdminPaymentTransport({}, path, { transport: 'agent' }));
  assert.doesNotThrow(() => assertAdminPaymentTransport({}, '/api/admin/account/agent-payment/check', {}));
  assert.doesNotThrow(() => assertAdminPaymentTransport({}, '/api/admin/account/check', {}));
  assert.doesNotThrow(() => assertAdminPaymentTransport({ LEGACY_CLOUD_TESTS_ENABLED: 'true' }, '/api/admin/account/test-payment', {}));
});

test('payment jobs are limited to the fixed account, one CNY tests and scoped order reads', () => {
  const input = { ...base(), url: 'https://untrusted.invalid', headers: { Cookie: 'private' }, script: 'private' };
  const job = paymentJob(input, 'fixed'); assert.equal(job.url, undefined); assert.equal(job.headers, undefined); assert.equal(job.script, undefined);
  assert.equal(job.ttlMs, PAYMENT_JOB_TTL);
  for (const extra of [{ accountId: 'other' }, { amountFen: 200 }, { paymentMethod: 'card' }, { operation: 'evaluate' }, { operation: 'capture', providerOrderId: '../private' }]) assert.throws(() => paymentJob({ ...input, ...extra }, 'fixed'));
});

test('payment response projection strips private data without hiding invalid amount or currency', () => {
  const job = paymentJob(base(), 'fixed');
  const result = paymentJobResult(job, envelope({ payment_order_id: 'synthetic-order', amount: '1', currency: 'private-value', url: 'weixin://synthetic', cookie: 'private-value', user: { token: 'private-value' } }));
  assert.equal(result.data.data.biz_data.currency, 'INVALID'); assert.equal(JSON.stringify(result).includes('private-value'), false);
  const capture = paymentJob({ ...base('capture'), providerOrderId: 'synthetic-order' }, 'fixed');
  const filtered = paymentJobResult(capture, envelope({ order: { status: 'SUCCESS', amount: {}, currency: 'private' } }));
  assert.throws(() => mapPaymentResult(filtered.data.data.biz_data, { provider_order_id: 'synthetic-order', amount_fen: 100 }));
});

test('executing host sends a creation once and preserves challenge uncertainty', async () => {
  let posts = 0;
  const page = { url: () => 'https://platform.deepseek.com/top_up', evaluate: async () => { posts++; return { httpStatus: 202, isJson: false, challenge: 'captcha', private: 'private-token' }; } };
  const result = await executePaymentJob(page, base(), { accountId: 'fixed', checkAccount: account, active: () => true, device: async () => 'synthetic-device', verification: async () => {} });
  assert.equal(posts, 1); assert.equal(result.creationAttempted, true); assert.equal(result.challenge, 'captcha'); assert.equal(result.isJson, false); assert.equal(JSON.stringify(result).includes('private-token'), false);
});

test('expired, disconnected, wrong-account and unprepared jobs stop before a payment POST', async () => {
  let posts = 0; let active = true;
  const page = { url: () => 'https://platform.deepseek.com/top_up', evaluate: async () => { posts++; throw new Error('must not send'); } };
  const options = { accountId: 'fixed', checkAccount: account, active: () => active, device: async () => 'device', verification: async () => {} };
  const expired = await executePaymentJob(page, base(), { ...options, receivedAt: Date.now() - PAYMENT_JOB_TTL - 1 });
  assert.equal(expired.code, 'JOB_EXPIRED'); assert.equal(expired.creationAttempted, false);
  const mismatch = await executePaymentJob(page, base(), { ...options, checkAccount: async () => ({ ok: false, code: 'ACCOUNT_MISMATCH' }) });
  assert.equal(mismatch.creationAttempted, false);
  const sdk = await executePaymentJob(page, base(), { ...options, device: async () => { throw Object.assign(new Error('private-cookie'), { code: 'PAYMENT_DEVICE_UNAVAILABLE' }); } });
  assert.equal(sdk.code, 'PAYMENT_DEVICE_UNAVAILABLE'); assert.equal(sdk.creationAttempted, false); assert.equal(JSON.stringify(sdk).includes('private-cookie'), false);
  const disconnected = await executePaymentJob(page, base(), { ...options, verification: async () => { active = false; } });
  assert.equal(disconnected.code, 'JOB_EXPIRED'); assert.equal(disconnected.creationAttempted, false); assert.equal(posts, 0);
});

test('a failed response after sending cannot be retried as an unsent creation', async () => {
  let calls = 0;
  const page = { url: () => 'https://platform.deepseek.com/top_up', evaluate: async () => { calls++; throw new Error('private-token'); } };
  const result = await executePaymentJob(page, base(), { accountId: 'fixed', checkAccount: account, active: () => true, device: async () => 'device', verification: async () => {} });
  assert.equal(result.code, 'UPSTREAM_UNAVAILABLE'); assert.equal(result.creationAttempted, true); assert.equal(calls, 1); assert.equal(JSON.stringify(result).includes('private-token'), false);
});

test('Worker provider uses local login without exporting vault credentials and still checks amount', async () => {
  const jobs = [];
  const env = rpcEnv((job) => { jobs.push(job); return envelope(job.operation === 'profile' ? { id: 'fixed', currency: 'CNY' } : { payment_order_id: 'synthetic-order', amount: '1', currency: 'CNY', url: 'weixin://synthetic' }); });
  const input = { amountFen: 100, paymentMethod: 'wechat', requestId: crypto.randomUUID() };
  const result = await createPayment(env, input);
  assert.equal(result.providerOrderId, 'synthetic-order'); assert.deepEqual(jobs.map((job) => job.operation), ['profile', 'create']);
  const fetcher = agentPaymentFetcher(env, { requestId: input.requestId, paymentMethod: 'wechat' });
  await fetcher('https://platform.deepseek.com/auth-api/v0/users/current', { method: 'GET', headers: { Authorization: 'Bearer private-vault-token', Cookie: 'private-cookie' } });
  assert.equal(JSON.stringify(jobs).includes('private'), false);
  const before = jobs.length;
  await assert.rejects(fetcher('https://untrusted.invalid', { method: 'GET' }), { code: 'INVALID_REQUEST', creationAttempted: false });
  await assert.rejects(fetcher('https://platform.deepseek.com/api/v1/payments', { method: 'POST', body: JSON.stringify({ order_info: { amount: '2', request_id: input.requestId } }) }), { code: 'INVALID_REQUEST', creationAttempted: false });
  assert.equal(jobs.length, before);
});

test('an invalid HTTP response after RPC dispatch remains uncertain rather than unsent', async () => {
  const env = rpcEnv(() => ({ ok: true, httpStatus: 204, isJson: true, creationAttempted: true, data: { code: 0, data: { biz_code: 0, biz_data: null } } }));
  const input = { requestId: crypto.randomUUID(), paymentMethod: 'wechat' };
  const fetcher = agentPaymentFetcher(env, input);
  await assert.rejects(fetcher('https://platform.deepseek.com/api/v1/payments', { method: 'POST', body: JSON.stringify({ order_info: { payment_method_type: 'CMB_UNIONPAY', fallback_method_type: 'WECHAT', amount: '1', currency: 'CNY', request_id: input.requestId } }) }), { code: 'AGENT_PROTOCOL', creationAttempted: true });
});

test('agent-marked ledger rows query the same host and use only matched official paid time', async () => {
  const operations = []; const now = Date.now(); const paidAt = new Date(now - 5000).toISOString();
  const env = rpcEnv((job) => {
    operations.push(job.operation);
    return envelope(job.operation === 'capture' ? { order: { id: 'synthetic-order', status: 'SUCCESS', amount: '1', currency: 'CNY' } } : { invoices: { payment_orders: [{ payment_order_id: 'synthetic-order', amount: '1', currency: 'CNY', payment_order_status: 'SUCCESS', paid_at: paidAt, private: 'never-forward' }] } });
  });
  const result = await queryPayment(env, { provider_transport: 'agent', provider_order_id: 'synthetic-order', amount_fen: 100, created_at: now - 60000, paid_at: null });
  assert.deepEqual(operations, ['capture', 'invoice']);
  assert.deepEqual(result, { status: 'paid', providerStatus: 'SUCCESS', paidAt: Date.parse(paidAt) });
});

test('relay RPC times out without replay and reports dispatched creation as uncertain', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = []; const attachment = { role: 'agent', connectionId: crypto.randomUUID(), paymentProtocol: 1, expiresAt: Date.now() + 100000 };
  const ws = { readyState: 1, deserializeAttachment: () => attachment, send: (value) => sent.push(JSON.parse(value)) };
  const relay = new BrowserAgentRelay({ getWebSockets: () => [ws] }, { DEEPSEEK_ACCOUNT_ID: 'fixed' });
  const request = () => new Request('https://relay.internal/execute', { method: 'POST', body: JSON.stringify(base()) });
  const pending = relay.fetch(request());
  for (let i = 0; i < 30 && !relay.pendingJobs.size; i++) await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  const busy = await (await relay.fetch(request())).json(); assert.equal(busy.code, 'AGENT_BUSY'); assert.equal(busy.creationAttempted, false);
  t.mock.timers.tick(PAYMENT_RPC_TIMEOUT);
  const result = await (await pending).json();
  assert.equal(result.code, 'AGENT_TIMEOUT'); assert.equal(result.creationAttempted, true); assert.equal(sent.length, 1); assert.equal(relay.pendingJobs.size, 0);
});
