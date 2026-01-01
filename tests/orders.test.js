import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import worker from '../worker/index.js';
import { ApiError, parseAmount, formatAmount, isDemo, validateOrder, verifyTurnstile } from '../worker/lib.js';
import { startAuthorization, completeAuthorization, authorizationState, cancelAuthorization, cleanupAuthorization, lastAuthorizationFailure } from '../worker/authorization.js';
import { accountErrorMessage } from '../frontend/admin-errors.js';
import { createAdminTestPayment, readAgentTestOrder } from '../worker/admin-payments.js';
import { credentialsFromInput, connectManualSession } from '../worker/manual-session.js';
import { stagePendingAuthorization, pendingAuthorizationState, verifyPendingAuthorization, discardPendingAuthorization, cleanupPendingAuthorization } from '../worker/pending-authorization.js';
import { createReceiver } from '../scripts/connect-account.mjs';
import { verifyAccessToken } from '../worker/access.js';
import { seal, unseal, credentialsFor, accountState } from '../worker/vault.js';
import { createPayment, queryPayment, mapPaymentResult, upstream, verifyAccount } from '../worker/provider.js';
import { AGENT_CHECK_INTERVAL, applyPaymentResult, reconcileOrder, reconcileScheduled } from '../worker/reconcile.js';
import { importSession } from '../worker/admin.js';
import { startBrowserLogin, completeBrowserLogin, cancelBrowserLogin, browserLoginState, cleanupBrowserLogin, credentialsFromBrowser, browserLoginDiagnostics, browserResourceStatus, browserTaskView, completeBrowserTask } from '../worker/browser-login.js';
import { cookieHeader } from '../worker/provider.js';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';

function setup({ migrateAdminTests = true } = {}) {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0002_account.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0003_reconciliation.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0004_browser_login.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0005_authorization.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0006_pending_authorization.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0007_agent_transport.sql', import.meta.url), 'utf8'));
  if (migrateAdminTests) db.exec(readFileSync(new URL('../migrations/0008_admin_test_orders.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0009_order_receiving_account.sql', import.meta.url), 'utf8'));
  const wrap = (sql, values = []) => ({ bind: (...args) => wrap(sql, args), first: async () => db.prepare(sql).get(...values) || null, all: async () => ({results:db.prepare(sql).all(...values)}), run: async () => ({ meta: { changes: db.prepare(sql).run(...values).changes } }) });
  const env = { DB: { prepare: wrap, batch: async (statements) => { db.exec('BEGIN'); try { const result = []; for (const stmt of statements) result.push(await stmt.run()); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } } }, LOCAL_DEMO: 'true' };
  const request = (path, options = {}) => worker.fetch(new Request(`http://localhost${path}`, options), env);
  const create = (body = {}, key = crypto.randomUUID()) => request('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ amount: '10.00', paymentMethod: 'wechat', nickname: '小鱼', message: '继续加油', ...body }) });
  return { db, env, request, create };
}

function publicAgentSetup(t) {
  const state = setup(); const { env } = state;
  Object.assign(env, { LOCAL_DEMO: 'false', DEEPSEEK_ACCOUNT_ID: 'fixed', PAYMENTS_ENABLED: 'true', PUBLIC_PAYMENT_TRANSPORT: 'agent', PUBLIC_PAYMENT_METHODS: 'alipay', ORDER_TOKEN_SECRET: 's'.repeat(40), TURNSTILE_SITE_KEY: 'fixture-site', TURNSTILE_SECRET_KEY: 'private-fixture-secret' });
  const control = { online: true, protocol: 2, receivingAccountId: 'fixed', jobs: [], failure: null, paid: false, amount: '37' };
  env.AGENT_RELAY = { idFromName: () => 'fixed-account-browser', get: () => ({ fetch: async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/status') return Response.json({ configured: true, online: control.online, paymentProtocol: control.protocol, receivingAccountId: control.receivingAccountId });
    if (path === '/notify-order') return Response.json({ ok: true });
    assert.equal(path, '/execute'); const job = await request.json(); control.jobs.push(job);
    if (job.operation === 'create' && control.failure === 'unsent') return Response.json({ ok: false, code: 'AGENT_BUSY', creationAttempted: false });
    if (job.operation === 'create' && control.failure === 'uncertain') return Response.json({ ok: true, httpStatus: 202, isJson: false, challenge: 'challenge', creationAttempted: true });
    const data = job.operation === 'profile' ? { id: job.accountId, currency: 'CNY' }
      : job.operation === 'create' ? { payment_order_id: 'synthetic-public-order', amount: String(job.amountFen / 100), currency: 'CNY', url: 'https://payments.example.invalid/synthetic-qr', fallback: true }
        : job.operation === 'capture' ? { order: { id: job.providerOrderId, amount: control.amount, currency: 'CNY', status: control.paid ? 'SUCCESS' : 'CREATED' } }
          : { invoices: { payment_orders: [{ payment_order_id: job.providerOrderId, amount: control.amount, currency: 'CNY', payment_order_status: 'SUCCESS', paid_at: new Date().toISOString() }] } };
    return Response.json({ ok: true, httpStatus: 200, isJson: true, creationAttempted: job.operation === 'create', data: { code: 0, data: { biz_code: 0, biz_data: data } } });
  } }) };
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    return Response.json({ success: true, hostname: 'feedfish.example', action: 'create_order' });
  });
  const request = (path, options = {}, ctx) => worker.fetch(new Request(`https://feedfish.example${path}`, options), env, ctx);
  const create = (body = {}, key = crypto.randomUUID()) => request('/api/orders', { method: 'POST', headers: { Origin: 'https://feedfish.example', 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ amount: '37', paymentMethod: 'alipay', nickname: '访客', message: '留言', turnstileToken: 'fixture-token', ...body }) });
  return { ...state, request, create, control };
}

function loginSetup() {
  const state = setup();
  state.env.BROWSER = {};
  state.env.BROWSER_LOGIN_ENABLED = 'true';
  state.env.ACCOUNT_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString('base64');
  const user = { id: 'fixed-browser-account', currency: 'CNY', feature_gates: { PAYMENT: true } };
  const counts = { acquisitions: 0, terminations: 0, disconnects: 0 };
  const cookies = [{ name: 'platform_session', value: 'private-cookie-value', domain: 'platform.deepseek.com', path: '/', secure: true, expires: -1 }, { name: 'google_session', value: 'must-not-save', domain: '.google.com', path: '/' }];
  let currentUrl = 'about:blank';
  const context = { pages: () => [page], newPage: async () => page, cookies: async () => cookies, newCDPSession: async () => ({ send: async () => ({ devtoolsFrontendUrl: 'https://live.browser.run/ui/view?mode=tab&wss=private-capability' }), detach: async () => {} }) };
  const page = { url: () => currentUrl, goto: async (url) => { currentUrl = url; }, context: () => context, waitForResponse: async () => ({ ok: () => true, json: async () => ({ code: 0, data: { biz_code: 0, biz_data: user } }), request: () => ({ headers: () => ({}), allHeaders: async () => ({ authorization: 'Bearer private-web-session-token', 'x-device-id': 'trusted-device' }) }) }) };
  const browser = { contexts: () => [context], close: async () => { counts.disconnects++; }, newBrowserCDPSession: async () => ({ send: async () => { counts.terminations++; } }) };
  const sdk = { acquire: async () => { counts.acquisitions++; return { sessionId: 'private-browser-session' }; }, endpointURLString: () => 'http://fake.host/v1/devtools/browser/private-browser-session?browser_binding=BROWSER', connect: async (endpoint) => {
    assert.equal(endpoint.searchParams.get('persistent'), 'true', 'the login page must survive a Worker disconnect');
    return browser;
  } };
  return { ...state, sdk, user, counts, cookies };
}

function authorizationSetup() {
  const state = setup(); state.env.ACCOUNT_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString('base64');
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    const value = url.endsWith('/auth_init') ? { authorize_id: 'pending-grant', authorize_url: 'https://platform.deepseek.com/dsh/authorize?authorize_id=pending-grant', expires_in: 600 }
      : url.endsWith('/auth_exchange') ? { token: 'new-private-dsh-grant-token' } : {};
    return Response.json({ code: 0, data: { biz_code: 0, biz_data: value } });
  };
  return { ...state, calls, fetcher, owner: { sub: 'owner' }, input: { callbackPort: 16487, state: 'a'.repeat(43) } };
}

test('PKCE authorization keeps verifier and grant out of browser responses and pins only a verified CNY account', async () => {
  const { env, db, calls, fetcher, owner, input } = authorizationSetup();
  const started = await startAuthorization(env, owner, input, fetcher);
  const row = db.prepare('SELECT * FROM account_authorization').get();
  const flow = await unseal(row.sealed_flow, env.ACCOUNT_ENCRYPTION_KEY);
  const expected = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(flow.verifier))).toString('base64url');
  assert.equal(calls[0].body.code_challenge, expected);
  assert.equal(calls[0].body.redirect_uri, 'http://127.0.0.1:16487/oauth/callback');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.doesNotMatch(JSON.stringify(started), new RegExp(flow.verifier));
  assert.equal(row.sealed_flow.includes(flow.verifier), false);
  const account = await completeAuthorization(env, owner, { state: input.state, code: 'one-time-code' }, (credentials) => importSession(env, credentials, 'owner@example.com', Date.now(), async (_url, options) => {
    assert.equal(options.headers['x-dsh-auth-token'], 'new-private-dsh-grant-token');
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({ code: 0, data: { biz_code: 0, biz_data: { id: 'fixed-dsh-account', currency: 'CNY', feature_gates: { PAYMENT: true } } } });
  }), fetcher);
  assert.equal(account.id, 'fixed-dsh-account'); assert.equal((await accountState(env)).configured, false);
  assert.equal(calls[1].body.code_verifier, flow.verifier);
  assert.equal(db.prepare('SELECT sealed_flow FROM account_authorization').get().sealed_flow, null);
  assert.equal(db.prepare('SELECT sealed_credentials FROM account_session').get().sealed_credentials.includes('new-private-dsh-grant-token'), false);
  await assert.rejects(completeAuthorization(env, owner, { state: input.state, code: 'one-time-code' }, () => assert.fail('replay'), fetcher), { code: 'AUTH_EXPIRED' });
});

test('authorization rejects a foreign SSO subject, forged state and non-loopback callback input', async () => {
  const { env, calls, fetcher, owner, input } = authorizationSetup();
  for (const callbackPort of [-1, 0, 80, 65536, '16487', 1.5]) await assert.rejects(startAuthorization(env, owner, { ...input, callbackPort }, fetcher), { code: 'INVALID_AUTH' });
  await startAuthorization(env, owner, input, fetcher);
  assert.equal(await authorizationState(env, { sub: 'other' }), null);
  await assert.rejects(startAuthorization(env, { sub: 'other' }, input, fetcher), { code: 'AUTH_BUSY' });
  for (const [identity, state] of [[{ sub: 'other' }, input.state], [owner, 'b'.repeat(43)]]) await assert.rejects(completeAuthorization(env, identity, { state, code: 'code' }, () => assert.fail('untrusted callback'), fetcher), { code: 'AUTH_EXPIRED' });
  assert.equal(calls.length, 1);
  await assert.rejects(cancelAuthorization(env, { sub: 'other' }, fetcher), { code: 'AUTH_EXPIRED' });
  await cancelAuthorization(env, owner, fetcher); assert.equal(calls[1].url.endsWith('/auth_cancel'), true);
});

test('concurrent authorization initialization and exchange admit one upstream operation', async () => {
  const { env, calls, fetcher, owner, input } = authorizationSetup();
  const starts = await Promise.allSettled([startAuthorization(env, owner, input, fetcher), startAuthorization(env, owner, input, fetcher)]);
  assert.equal(starts.filter((r) => r.status === 'fulfilled').length, 1);
  let saves = 0;
  const finish = () => completeAuthorization(env, owner, { state: input.state, code: 'code' }, async () => { saves++; return { id: 'account' }; }, fetcher);
  const results = await Promise.allSettled([finish(), finish()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1); assert.equal(saves, 1);
  assert.equal(calls.filter((c) => c.url.endsWith('/auth_exchange')).length, 1);
});

test('expiry cancels the pending grant and failed account checks revoke only the newly issued token', async () => {
  const { env, db, calls, fetcher, owner, input } = authorizationSetup();
  await startAuthorization(env, owner, input, fetcher);
  db.prepare('UPDATE account_authorization SET expires_at=?').run(Date.now() - 1);
  await cleanupAuthorization(env, fetcher);
  assert.equal(calls.at(-1).url.endsWith('/auth_cancel'), true);
  assert.equal(db.prepare('SELECT sealed_flow FROM account_authorization').get().sealed_flow, null);
  await startAuthorization(env, owner, input, fetcher);
  await assert.rejects(completeAuthorization(env, owner, { state: input.state, code: 'code' }, async () => { throw new ApiError(409, 'ACCOUNT_MISMATCH', 'wrong account'); }, fetcher), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(calls.at(-1).url, 'https://platform.deepseek.com/auth-api/v0/users/logout');
  assert.equal(calls.at(-1).options.redirect, 'manual');
  assert.equal(calls.at(-1).options.headers['x-dsh-auth-token'], 'new-private-dsh-grant-token');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_session').get().n, 0);
});

test('authorization initialization never forwards an off-origin approval URL', async () => {
  const { env, owner, input } = authorizationSetup();
  await assert.rejects(startAuthorization(env, owner, input, async () => Response.json({ code: 0, data: { biz_code: 0, biz_data: { authorize_id: 'id', authorize_url: 'https://evil.example/dsh/authorize', expires_in: 600 } } })), { code: 'AUTH_PROTOCOL' });
});

test('authorization classifies a cloud egress challenge without echoing upstream content', async () => {
  const { env, owner, input } = authorizationSetup();
  await assert.rejects(startAuthorization(env, owner, input, async () => new Response('private-upstream-content', { status: 405, headers: { 'Content-Type': 'text/html', 'x-amzn-waf-action': 'captcha' } })), (error) => error.code === 'AUTH_CHALLENGE' && error.message.includes('405') && !error.message.includes('private-upstream-content'));
});

test('failed code exchange records only its stage and numeric upstream codes', async () => {
  const { env, db, owner, input, fetcher } = authorizationSetup();
  await startAuthorization(env, owner, input, fetcher);
  await assert.rejects(completeAuthorization(env, owner, { state: input.state, code: 'private-one-time-code' }, () => assert.fail('no account check before exchange'), async () => Response.json({ code: 10001, msg: 'private-response-token', data: { biz_code: 7 } })), (error) => {
    assert.deepEqual(error.authorizationDiagnostic, { stage: 'exchange', code: 'AUTH_REJECTED', upstreamStatus: 200, upstreamCode: 10001, upstreamBizCode: 7 });
    return true;
  });
  const failure = await lastAuthorizationFailure(env);
  assert.equal(failure.stage, 'exchange'); assert.equal(failure.upstreamBizCode, 7);
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT event FROM admin_audit').all()), /private|code_verifier|authorize_url/);
  assert.equal(db.prepare('SELECT state FROM account_authorization').get().state, 'closed');
});

test('a blocked account read retains an encrypted grant for one-code exchange and later atomic verification', async () => {
  const { env, db, owner, input, fetcher, calls } = authorizationSetup();
  await startAuthorization(env, owner, input, fetcher);
  await assert.rejects(completeAuthorization(env, owner, { state: input.state, code: 'private-code' }, (credentials) => importSession(env, credentials, 'owner@example.com', Date.now(), async () => new Response('private-html-body', { status: 403, headers: { 'Content-Type': 'text/html' } })), fetcher), (error) => {
    assert.deepEqual(error.authorizationDiagnostic, { stage: 'account', code: 'UPSTREAM_NOT_JSON', upstreamStatus: 403 });
    assert.match(accountErrorMessage({ code: error.code, diagnostic: error.authorizationDiagnostic }), /账户核验 · HTTP 403/);
    return true;
  });
  assert.equal((await lastAuthorizationFailure(env)).code, 'UPSTREAM_NOT_JSON');
  assert.equal(calls.at(-1).url.endsWith('/auth_exchange'), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_session').get().n, 0);
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT event FROM admin_audit').all()), /private|token/);
  const pending = await pendingAuthorizationState(env, owner);
  assert.doesNotMatch(JSON.stringify(pending), /token|sealed|credentials|owner/);
  assert.equal(db.prepare('SELECT sealed_credentials FROM account_pending_authorization').get().sealed_credentials.includes('new-private-dsh-grant-token'), false);
  await assert.rejects(startAuthorization(env, owner, input, fetcher), { code: 'AUTH_PENDING' });
  const account = await verifyPendingAuthorization(env, owner, pending.id, (credentials, pendingId) => importSession(env, credentials, 'owner@example.com', Date.now(), async (_url, options) => {
    assert.equal(options.headers.Origin, undefined); assert.equal(options.headers.Referer, undefined);
    return Response.json({ code: 0, data: { biz_code: 0, biz_data: { id: 'fixed-after-retry', currency: 'CNY' } } });
  }, pendingId), fetcher, Date.now() + 15 * 60000);
  assert.equal(account.id, 'fixed-after-retry');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_pending_authorization').get().n, 0);
  assert.equal(db.prepare('SELECT account_id FROM account_session').get().account_id, 'fixed-after-retry');
  assert.equal((await accountState(env)).configured, false, 'deployment pin is still required');
  assert.equal(calls.filter(call => call.url.endsWith('/auth_exchange')).length, 1);
});

test('pending grants enforce SSO ownership, serialize retries and recover an expired lease', async () => {
  const { env, db, owner, fetcher } = authorizationSetup();
  const id = await stagePendingAuthorization(env, owner, { dshToken: 'private-pending-token' }, fetcher);
  const foreign = { sub: 'other' };
  assert.equal(await pendingAuthorizationState(env, foreign), null);
  await assert.rejects(verifyPendingAuthorization(env, foreign, id, () => assert.fail('foreign')), { code: 'AUTH_EXPIRED' });
  await assert.rejects(discardPendingAuthorization(env, foreign, id, fetcher), { code: 'AUTH_EXPIRED' });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const first = verifyPendingAuthorization(env, owner, id, () => { entered(); return gate; }, fetcher);
  await started;
  await assert.rejects(verifyPendingAuthorization(env, owner, id, () => assert.fail('parallel')), { code: 'AUTH_BUSY' });
  await assert.rejects(discardPendingAuthorization(env, owner, id, fetcher), { code: 'AUTH_BUSY' });
  release({ id: 'verified' }); await first;
  const nextId = await stagePendingAuthorization(env, owner, { dshToken: 'private-pending-token' }, fetcher);
  db.prepare('UPDATE account_pending_authorization SET lease_until=?').run(Date.now() - 1);
  assert.equal((await verifyPendingAuthorization(env, owner, nextId, async () => ({ id: 'after-lease' }), fetcher)).id, 'after-lease');
});

test('the exchange profile is retained privately without copying contact information into pending credentials', async () => {
  const { env, db, owner, input, fetcher } = authorizationSetup();
  await startAuthorization(env, owner, input, fetcher);
  const exchange = async (url, options) => url.endsWith('/auth_exchange') ? Response.json({ code: 0, data: { biz_code: 0, biz_data: { token: 'new-private-dsh-grant-token', user: { id: 'issued-account', currency: 'CNY', email: 'private@example.com', mobile: 'private-mobile', is_api_banned: false } } } }) : fetcher(url, options);
  await assert.rejects(completeAuthorization(env, owner, { state: input.state, code: 'code' }, async () => { throw new ApiError(503, 'UPSTREAM_NOT_JSON', 'blocked'); }, exchange), error => {
    assert.equal(error.authorizationDiagnostic.issuedIdentity, true); assert.equal(error.authorizationDiagnostic.issuedCurrency, 'CNY'); return true;
  });
  const row = db.prepare('SELECT sealed_credentials FROM account_pending_authorization').get();
  const stored = await unseal(row.sealed_credentials, env.ACCOUNT_ENCRYPTION_KEY);
  assert.deepEqual(stored.issuedAccount, { id: 'issued-account', currency: 'CNY', is_api_banned: false });
  assert.doesNotMatch(JSON.stringify(stored), /private@example|private-mobile/);
  assert.doesNotMatch(JSON.stringify(await lastAuthorizationFailure(env)), /issued-account|private/);
});

test('pending promotion rolls back the trusted vault if removing the candidate fails', async () => {
  const { env, db, owner, fetcher } = authorizationSetup();
  const id = await stagePendingAuthorization(env, owner, { dshToken: 'private-pending-token' }, fetcher);
  const prepare = env.DB.prepare;
  env.DB.prepare = (sql) => sql.startsWith('DELETE FROM account_pending_authorization') ? { bind: () => ({ run: async () => { throw new Error('delete unavailable'); } }) } : prepare(sql);
  await assert.rejects(verifyPendingAuthorization(env, owner, id, (credentials, pendingId) => importSession(env, credentials, 'owner', Date.now(), async () => Response.json({ code: 0, data: { biz_code: 0, biz_data: { id: 'fixed', currency: 'CNY' } } }), pendingId), fetcher), /delete unavailable/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_session').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_pending_authorization').get().n, 1);
  assert.equal((await pendingAuthorizationState(env, owner)).busy, false);
  env.DB.prepare = prepare;
});

test('a private exchange profile can bind its grant while manual input cannot forge an issuer binding', async () => {
  const { env, db, owner, fetcher } = authorizationSetup();
  const credentials = { dshToken: 'private-issued-token', issuedAccount: { id: 'fixed-issuer-account', currency: 'CNY' } };
  await assert.rejects(importSession(env, credentials, 'owner', Date.now(), async () => new Response('blocked', { status: 403 })), { code: 'UPSTREAM_NOT_JSON' });
  const id = await stagePendingAuthorization(env, owner, credentials, fetcher);
  await verifyPendingAuthorization(env, owner, id, (value, pending) => importSession(env, value, 'owner', Date.now(), () => assert.fail('exchange supplied the identity'), pending), fetcher);
  env.DEEPSEEK_ACCOUNT_ID = 'fixed-issuer-account';
  const stored = await credentialsFor(env);
  assert.deepEqual(stored.accountBinding, { kind: 'dsh-exchange', accountId: 'fixed-issuer-account' });
  const calls = [];
  await createPayment(env, { amountFen: 100, paymentMethod: 'wechat', requestId: crypto.randomUUID() }, async (url) => { calls.push(url); return Response.json({ code: 0, data: { biz_code: 0, biz_data: { payment_order_id: 'real-test-order', amount: '1', currency: 'CNY', url: 'weixin://wxpay/test-only' } } }); });
  assert.deepEqual(calls, ['https://platform.deepseek.com/api/v1/payments']);
  env.DEEPSEEK_ACCOUNT_ID = 'other-account';
  await assert.rejects(createPayment(env, { amountFen: 100, paymentMethod: 'wechat' }, () => assert.fail('wrong account')), { code: 'ACCOUNT_UNAVAILABLE' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_pending_authorization').get().n, 0);
});

test('a canceled pending grant cannot be promoted by a late account response', async () => {
  const { env, db, owner, fetcher } = authorizationSetup();
  const id = await stagePendingAuthorization(env, owner, { dshToken: 'private-pending-token' }, fetcher);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const verification = verifyPendingAuthorization(env, owner, id, (credentials, pending) => importSession(env, credentials, 'owner', Date.now(), async () => { entered(); await gate; return Response.json({ code: 0, data: { biz_code: 0, biz_data: { id: 'fixed', currency: 'CNY' } } }); }, pending), fetcher);
  await started;
  await discardPendingAuthorization(env, owner, id, fetcher, Date.now() + 31000);
  release();
  await assert.rejects(verification, { code: 'AUTH_EXPIRED' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_session').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_pending_authorization').get().n, 0);
});

test('expired and discarded pending credentials are removed even when upstream logout is blocked', async () => {
  const { env, db, owner } = authorizationSetup(); const now = Date.now(); const requests = [];
  const blocked = async (url, options) => { requests.push({ url, options }); return new Response('private-block-page', { status: 403 }); };
  await stagePendingAuthorization(env, owner, { dshToken: 'private-expiring-token' }, blocked, now);
  assert.equal(await pendingAuthorizationState(env, owner, now + 7200001), null);
  await cleanupPendingAuthorization(env, blocked, now + 7200001);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_pending_authorization').get().n, 0);
  const id = await stagePendingAuthorization(env, owner, { dshToken: 'private-discard-token' }, blocked);
  assert.deepEqual(await discardPendingAuthorization(env, owner, id, blocked), { ok: true, revoked: false });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers['x-dsh-auth-token'], 'private-discard-token');
  assert.equal(requests[1].options.redirect, 'manual');
});

test('an actually rejected credential is not retained for retry', async () => {
  const { env, db, owner, fetcher } = authorizationSetup();
  const id = await stagePendingAuthorization(env, owner, { dshToken: 'private-invalid-token' }, fetcher);
  await assert.rejects(verifyPendingAuthorization(env, owner, id, async () => { throw new ApiError(503, 'SESSION_EXPIRED', 'invalid'); }, fetcher), { code: 'SESSION_EXPIRED' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_pending_authorization').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_session').get().n, 0);
});

test('admin errors never echo credential-related exception text or unknown diagnostic strings', () => {
  const message = accountErrorMessage({ code: 'ACCOUNT_UNAVAILABLE', message: 'private-token', diagnostic: { stage: 'account', accountCheck: 'currency', upstreamStatus: 'private-token', upstreamCode: 'private-token' } });
  assert.match(message, /CNY 币种/); assert.doesNotMatch(message, /private-token|已经登录/);
  assert.doesNotMatch(accountErrorMessage({ code: 'private-token', message: 'private-token', diagnostic: { stage: 'constructor', accountCheck: '__proto__' } }), /private-token|constructor|Object/);
  assert.match(accountErrorMessage({ code: 'ACCESS_DENIED' }), /Cloudflare Access/);
});

test('loopback receiver enforces Host, Origin, state and one callback; forwards only code in a fragment', async () => {
  const state = 'a'.repeat(43); const receiver = await createReceiver({ state, ttlMs: 10000 }); const local = new URL(receiver.receiverUrl);
  try {
    const forgedHost = await new Promise((accept, reject) => {
      const request = httpRequest({ hostname: local.hostname, port: local.port, path: '/', headers: { Host: 'evil.example' } }, (response) => { response.resume(); accept(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(forgedHost, 403);
    assert.equal((await fetch(new URL('/start', local), { method: 'POST', headers: { Origin: 'https://evil.example' }, redirect: 'manual' })).status, 403);
    const start = await fetch(local);
    const body = await start.text();
    const link = body.match(/href="(https:\/\/feedfish\.example\/admin#[^"]+)"/)[1].replace(/&amp;/g, '&');
    const target = new URL(link); assert.equal(target.origin, 'https://feedfish.example'); assert.equal(target.search, '');
    assert.equal(new URLSearchParams(target.hash.slice(1)).get('connect_state'), state);
    assert.equal((await fetch(new URL('/oauth/callback?state=wrong&code=code', local), { redirect: 'manual' })).status, 400);
    const callback = new URL('/oauth/callback', local); callback.searchParams.set('state', state); callback.searchParams.set('code', 'one-time-code');
    const complete = await fetch(callback, { redirect: 'manual' }); assert.equal(complete.status, 303);
    const result = new URL(complete.headers.get('location')); assert.equal(result.search, '');
    assert.equal(new URLSearchParams(result.hash.slice(1)).get('connect_code'), 'one-time-code');
    const replay = await fetch(callback, { redirect: 'manual' }).then((r) => r.status, () => 410); assert.equal(replay, 410);
  } finally { await receiver.close(); }
});

test('official login saves only verified fixed-origin credentials and destroys its capability', async () => {
  const { env, db, sdk, user, counts } = loginSetup(); const identity = { sub: 'owner-one' };
  const attempt = await startBrowserLogin(env, identity, sdk);
  const loginRow = db.prepare('SELECT * FROM account_login').get();
  assert.equal(loginRow.sealed_session.includes('private-browser-session'), false);
  const account = await completeBrowserLogin(env, identity, attempt.id,
    (credentials) => importSession(env, credentials, 'owner@example.com', Date.now(), async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer private-web-session-token');
      assert.equal(options.headers.Cookie, 'platform_session=private-cookie-value');
      return Response.json({ code: 0, data: { biz_code: 0, biz_data: user } });
    }), sdk);
  assert.equal(account.id, user.id);
  assert.equal((await accountState(env)).configured, false);
  env.DEEPSEEK_ACCOUNT_ID = user.id;
  const stored = await credentialsFor(env);
  assert.equal(stored.cookies.length, 1); assert.equal(stored.cookies[0].name, 'platform_session');
  assert.equal(db.prepare('SELECT sealed_credentials FROM account_session').get().sealed_credentials.includes('private-cookie-value'), false);
  assert.equal(db.prepare('SELECT state,sealed_session FROM account_login').get().sealed_session, null);
  assert.equal(counts.terminations, 1);
  await assert.rejects(completeBrowserLogin(env, identity, attempt.id, () => assert.fail('replayed login'), sdk), { code: 'LOGIN_EXPIRED' });
});

test('login attempts enforce SSO subject ownership, single launch and cancellation', async () => {
  const { env, sdk, db, counts } = loginSetup(); const owner = { sub: 'owner' }, other = { sub: 'other' };
  const attempt = await startBrowserLogin(env, owner, sdk);
  assert.equal(await browserLoginState(env, other), null);
  await assert.rejects(startBrowserLogin(env, other, sdk), { code: 'LOGIN_BUSY' });
  await assert.rejects(completeBrowserLogin(env, other, attempt.id, () => assert.fail('wrong owner'), sdk), { code: 'LOGIN_EXPIRED' });
  await assert.rejects(cancelBrowserLogin(env, other, attempt.id, sdk), { code: 'LOGIN_EXPIRED' });
  const resumed = await startBrowserLogin(env, owner, sdk);
  assert.equal(resumed.id, attempt.id); assert.equal(counts.acquisitions, 1);
  await cancelBrowserLogin(env, owner, attempt.id, sdk);
  assert.equal(counts.terminations, 1); assert.equal(db.prepare('SELECT state FROM account_login').get().state, 'closed');
});

test('expired login is closed and failed credential verification never replaces the vault', async () => {
  const { env, sdk, db, counts } = loginSetup(); const identity = { sub: 'owner' };
  const attempt = await startBrowserLogin(env, identity, sdk);
  await assert.rejects(completeBrowserLogin(env, identity, attempt.id, async () => { throw Object.assign(new Error('unusable'), { code: 'SESSION_EXPIRED' }); }, sdk));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_session').get().n, 0);
  assert.equal(db.prepare('SELECT state FROM account_login').get().state, 'open');
  db.prepare('UPDATE account_login SET expires_at=?').run(Date.now() - 1);
  await cleanupBrowserLogin(env, sdk);
  assert.equal(counts.terminations, 1); assert.equal(db.prepare('SELECT sealed_session FROM account_login').get().sealed_session, null);
});

test('browser authentication preserves cookie-only sessions and filters origin, path, expiry and header injection', async () => {
  const valid = { name: 'session', value: 'valid', domain: '.deepseek.com', path: '/auth-api', expires: -1 };
  const credentials = credentialsFromBrowser({}, [valid, { ...valid, domain: 'other.deepseek.com' }, { ...valid, domain: 'evil.example' }]);
  assert.equal(credentials.sessionToken, undefined); assert.equal(credentials.cookies.length, 1);
  const cookies = [...credentials.cookies, { ...valid, name: 'expired', expires: 1 }, { ...valid, name: 'bad\r\nheader' }, { ...valid, value: 'bad;injected=value' }];
  assert.equal(cookieHeader(cookies, '/auth-api/v0/users/current'), 'session=valid');
  assert.equal(cookieHeader(cookies, '/api/v1/payments'), '');
  assert.equal(cookieHeader(cookies, '/auth-api-other'), '');
  await upstream('/auth-api/v0/users/current', credentials, undefined, async (_url, options) => {
    assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.Cookie, 'session=valid');
    return Response.json({ code: 0, data: { biz_code: 0, biz_data: {} } });
  });
});

test('manual imports accept Cookie-only or Token sessions but cannot forge a trusted exchange binding', async () => {
  const credentials = credentialsFromInput({ cookie: 'Cookie: web_session=private-cookie==; locale=zh-CN; cf_clearance=not-an-auth-cookie; aws-waf-token=not-an-auth-cookie', dshToken: 'forged', accountBinding: { kind: 'dsh-exchange' }, issuedAccount: { id: 'forged' } });
  assert.equal(credentials.sessionToken, undefined); assert.equal(credentials.dshToken, undefined); assert.equal(credentials.accountBinding, undefined); assert.equal(credentials.issuedAccount, undefined);
  assert.equal(cookieHeader(credentials.cookies, '/api/v1/payments'), 'web_session=private-cookie==; locale=zh-CN');
  assert.ok(credentials.cookies.every(cookie => cookie.domain === 'platform.deepseek.com' && cookie.secure));
  await upstream('/auth-api/v0/users/current', credentials, undefined, async (_url, options) => { assert.equal(options.headers.Authorization, undefined); assert.match(options.headers.Cookie, /^web_session=/); return Response.json({ code: 0, data: { biz_code: 0, biz_data: {} } }); });
  assert.equal(credentialsFromInput({ sessionToken: 'Bearer private-web-token-at-least-twenty' }).sessionToken, 'private-web-token-at-least-twenty');
  const token = 'private-web-token-at-least-twenty';
  for (const sessionToken of [token, `Authorization: Bearer ${token}`, JSON.stringify(token), JSON.stringify({ value: token, __version: '0' }), JSON.stringify({ value: token, __version: '0' }, null, 2)]) assert.equal(credentialsFromInput({ sessionToken }).sessionToken, token);
});
test('manual imports reject malformed Cookie headers and device injection without echoing credentials', () => {
  for (const input of [null, [], 1, 'invalid']) assert.throws(() => credentialsFromInput(input), { code: 'INVALID_SESSION' });
  for (const sessionToken of ['{"value":null,"__version":"0"}', '{"value":{"token":"private"}}', '""', '"   "', '{bad-json']) assert.throws(() => credentialsFromInput({ sessionToken, cookie: 'session=valid' }), { code: 'INVALID_SESSION' });
  for (const cookie of ['session=private\r\nOther: header', 'session=private; session=other', 'Set-Cookie: session=private; HttpOnly', 'session=bad value', 'no-equals', 'x'.repeat(6001), ['session=private']]) {
    assert.throws(() => credentialsFromInput({ cookie }), error => { assert.equal(error.code, 'INVALID_COOKIE'); assert.doesNotMatch(error.message, /private/); return true; });
  }
  assert.throws(() => credentialsFromInput({ cookie: 'cf_clearance=proof; aws-waf-token=proof' }), { code: 'INVALID_SESSION' });
  assert.throws(() => credentialsFromInput({ cookie: 'session=valid', deviceId: 'invalid\r\nheader' }), { code: 'INVALID_DEVICE' });
});
test('a blocked manual Cookie import stays encrypted for its owner and preserves the active account until real verification', async () => {
  const { env, db, user } = loginSetup(); const owner = { sub: 'owner', email: 'owner@example.com' }; env.DEEPSEEK_ACCOUNT_ID = user.id;
  const existing = { dshToken: 'existing-private-grant' };
  await importSession(env, existing, owner.email, Date.now(), async () => Response.json({ code: 0, data: { biz_code: 0, biz_data: user } }));
  const blocked = async () => new Response('private upstream page', { status: 403, headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(connectManualSession(env, owner, { cookie: 'web_session=private-cookie' }, (credentials, pending) => importSession(env, credentials, owner.email, Date.now(), blocked, pending), blocked), { code: 'UPSTREAM_NOT_JSON' });
  assert.deepEqual(await credentialsFor(env), existing);
  const state = await pendingAuthorizationState(env, owner);
  assert.ok(state.id); assert.equal(await pendingAuthorizationState(env, { sub: 'other' }), null);
  assert.doesNotMatch(db.prepare('SELECT sealed_credentials FROM account_pending_authorization').get().sealed_credentials, /private-cookie/);
  await assert.rejects(verifyPendingAuthorization(env, { sub: 'other' }, state.id, () => assert.fail('foreign owner')), { code: 'AUTH_EXPIRED' });
  const success = async (_url, options) => { assert.equal(options.headers.Cookie, 'web_session=private-cookie'); assert.equal(options.headers.Authorization, undefined); return Response.json({ code: 0, data: { biz_code: 0, biz_data: user } }); };
  await verifyPendingAuthorization(env, owner, state.id, (credentials, pending) => importSession(env, credentials, owner.email, Date.now(), success, pending), success);
  assert.equal(await pendingAuthorizationState(env, owner), null);
  assert.equal(cookieHeader((await credentialsFor(env)).cookies, '/auth-api/v0/users/current'), 'web_session=private-cookie');
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT event FROM admin_audit').all()), /private-cookie|existing-private-grant/);
});
test('manual candidate mismatch and cancellation remove the candidate without logging the official browser out', async () => {
  const { env, user } = loginSetup(); const owner = { sub: 'owner', email: 'owner@example.com' }; env.DEEPSEEK_ACCOUNT_ID = user.id;
  const existing = { dshToken: 'existing-private-grant' };
  await importSession(env, existing, owner.email, Date.now(), async () => Response.json({ code: 0, data: { biz_code: 0, biz_data: user } }));
  const other = async () => Response.json({ code: 0, data: { biz_code: 0, biz_data: { ...user, id: 'another-account' } } });
  await assert.rejects(connectManualSession(env, owner, { cookie: 'web_session=other' }, (credentials, pending) => importSession(env, credentials, owner.email, Date.now(), other, pending), () => assert.fail('must not call browser logout')), { code: 'ACCOUNT_MISMATCH' });
  assert.deepEqual(await credentialsFor(env), existing); assert.equal(await pendingAuthorizationState(env, owner), null);
  const id = await stagePendingAuthorization(env, owner, credentialsFromInput({ cookie: 'web_session=candidate' }));
  assert.deepEqual(await discardPendingAuthorization(env, owner, id, () => assert.fail('must not log out official browser')), { ok: true, revoked: null });
  assert.equal(await pendingAuthorizationState(env, owner), null);
});
test('Missing Token removes an incomplete Cookie candidate without treating the saved grant as expired', async () => {
  const { env, user } = loginSetup(); const owner = { sub: 'owner', email: 'owner@example.com' }; env.DEEPSEEK_ACCOUNT_ID = user.id;
  const existing = { dshToken: 'existing-private-grant' };
  await importSession(env, existing, owner.email, Date.now(), async () => Response.json({ code: 0, data: { biz_code: 0, biz_data: user } }));
  const missing = async () => Response.json({ code: 40002, msg: 'Missing Token' });
  await assert.rejects(connectManualSession(env, owner, { cookie: 'web_session=candidate' }, (credentials, pending) => importSession(env, credentials, owner.email, Date.now(), missing, pending), () => assert.fail('must not revoke the official browser')), { code: 'AUTH_TOKEN_MISSING', credentialMode: 'cookie' });
  assert.equal(await pendingAuthorizationState(env, owner), null); assert.deepEqual(await credentialsFor(env), existing);
  const id = await stagePendingAuthorization(env, owner, existing);
  await assert.rejects(verifyPendingAuthorization(env, owner, id, () => { throw new ApiError(503, 'AUTH_TOKEN_MISSING', 'Missing Token'); }, () => assert.fail('a missing token is not a rejected grant')), { code: 'AUTH_TOKEN_MISSING' });
  assert.equal((await pendingAuthorizationState(env, owner)).id, id); assert.deepEqual(await credentialsFor(env), existing);
});

test('login diagnostics expose only the current SSO subject and never browser connection capabilities', async () => {
  const { env, sdk } = loginSetup(); const identity = { sub: 'owner' };
  await startBrowserLogin(env, identity, sdk);
  sdk.sessions = async () => [{ sessionId: 'private-browser-session', connectionId: 'secret-connection' }];
  assert.equal((await browserLoginDiagnostics(env, identity, sdk)).active, true);
  assert.deepEqual(await browserLoginDiagnostics(env, { sub: 'other' }, sdk), { state: 'unavailable', active: false });
  sdk.sessions = async () => [];
  sdk.history = async () => [{ sessionId: 'other', closeReasonText: 'must-not-leak' }, { sessionId: 'private-browser-session', closeReasonText: 'BrowserIdle', endTime: Date.now() }];
  const result = await browserLoginDiagnostics(env, identity, sdk);
  assert.equal(result.active, false); assert.equal(result.closeReason, 'BrowserIdle');
  assert.doesNotMatch(JSON.stringify(result), /private-browser-session|secret-connection|must-not-leak/);
});
test('resource checks do not launch browsers or expose session capabilities or SDK errors', async () => {
  const sdk = {
    acquire: () => { throw new Error('must not launch'); },
    limits: async () => ({ activeSessions: [{ id: 'private-session', connectionId: 'private-connection' }], maxConcurrentSessions: 3, allowedBrowserAcquisitions: 0, timeUntilNextAllowedBrowserAcquisition: 20, extra: 'private-extra' }),
  };
  const result = await browserResourceStatus({ BROWSER: {} }, sdk);
  assert.deepEqual(result, { mode: 'resources', configured: true, activeSessions: 1, maxConcurrentSessions: 3, allowedBrowserAcquisitions: 0, timeUntilNextAllowedBrowserAcquisition: 20 });
  sdk.limits = async () => { throw new Error('private-error'); };
  assert.deepEqual(await browserResourceStatus({ BROWSER: {} }, sdk), { mode: 'resources', configured: true, code: 'BROWSER_RESOURCES_UNAVAILABLE' });
  assert.deepEqual(await browserResourceStatus({}, sdk), { mode: 'resources', configured: false });
});

test('interactive browser tasks bind purpose, owner and expiry and terminate after one completion', async () => {
  const { env, db, sdk, counts } = loginSetup(); const owner = { sub: 'owner' }, other = { sub: 'other' };
  sdk.limits = async () => ({ allowedBrowserAcquisitions: 1, activeSessions: [], maxConcurrentSessions: 3, timeUntilNextAllowedBrowserAcquisition: 0 });
  let prepared = 0, completed = 0;
  const task = { purpose: 'payment-captcha', checkLimits: true, data: { requestId: 'fixed-task-request' }, prepare: async () => { prepared++; } };
  const attempt = await startBrowserLogin(env, owner, sdk, Date.now(), task);
  await assert.rejects(startBrowserLogin(env, owner, sdk), { code: 'LOGIN_BUSY' });
  assert.equal(db.prepare('SELECT state FROM account_login').get().state, 'open'); assert.equal(counts.terminations, 0);
  await assert.rejects(browserTaskView(env, other, attempt.id, 'payment-captcha', sdk), { code: 'LOGIN_EXPIRED' });
  await assert.rejects(browserTaskView(env, owner, attempt.id, 'login', sdk), { code: 'LOGIN_EXPIRED' });
  const resumed = await startBrowserLogin(env, owner, sdk, Date.now(), task);
  assert.equal(resumed.id, attempt.id); assert.equal(prepared, 1); assert.equal(counts.acquisitions, 1);
  await assert.rejects(completeBrowserTask(env, owner, attempt.id, 'payment-captcha', async () => false, () => assert.fail('must wait for human'), sdk), { code: 'LOGIN_PENDING' });
  assert.equal(counts.terminations, 0); assert.equal(db.prepare('SELECT state FROM account_login').get().state, 'open');
  const result = await completeBrowserTask(env, owner, attempt.id, 'payment-captcha', async () => true, async (_browser, _page, saved) => { completed++; assert.equal(saved.requestId, 'fixed-task-request'); return { ok: true }; }, sdk);
  assert.deepEqual(result, { ok: true }); assert.equal(completed, 1); assert.equal(counts.terminations, 1);
  assert.equal(db.prepare('SELECT sealed_session FROM account_login').get().sealed_session, null);
  await assert.rejects(completeBrowserTask(env, owner, attempt.id, 'payment-captcha', async () => true, () => assert.fail('must not repeat'), sdk), { code: 'LOGIN_EXPIRED' });
});

test('interactive browser preparation failures close the instance and resource denial acquires none', async () => {
  const state = loginSetup(); state.sdk.limits = async () => ({ allowedBrowserAcquisitions: 1 });
  await assert.rejects(startBrowserLogin(state.env, { sub: 'owner' }, state.sdk, Date.now(), { purpose: 'payment-captcha', checkLimits: true, prepare: async () => { throw new Error('private preparation failure'); } }));
  assert.equal(state.counts.terminations, 1); assert.equal(state.db.prepare('SELECT state FROM account_login').get().state, 'closed');
  const denied = loginSetup(); denied.sdk.limits = async () => ({ allowedBrowserAcquisitions: 0 });
  await assert.rejects(startBrowserLogin(denied.env, { sub: 'owner' }, denied.sdk, Date.now(), { purpose: 'payment-captcha', checkLimits: true }), { code: 'BROWSER_BUSY' });
  assert.equal(denied.counts.acquisitions, 0);
});
test('interactive task connection failure closes only its already acquired instance', async () => {
  const { env, db, sdk, counts } = loginSetup();
  const originalConnect = sdk.connect; let connections = 0;
  sdk.connect = async endpoint => { if (++connections === 1) throw new Error('private connection failure'); return originalConnect(endpoint); };
  await assert.rejects(startBrowserLogin(env, { sub: 'owner' }, sdk, Date.now(), { purpose: 'payment-captcha' }), { code: 'LOGIN_UNAVAILABLE', browserStage: 'connect' });
  assert.equal(counts.acquisitions, 1); assert.equal(connections, 2); assert.equal(counts.terminations, 1);
  assert.equal(db.prepare('SELECT state FROM account_login').get().state, 'closed');
});
test('browser creation distinguishes explicit daily quota from an unexplained 429 without leaking SDK text or retrying', async () => {
  for (const [text, code] of [
    ['Unable to create new browser: code: 429: message: Browser time limit exceeded for today', 'BROWSER_QUOTA_EXCEEDED'],
    ['Unable to create new browser: code: 429: message: unknown restriction', 'BROWSER_RATE_LIMIT'],
    ['Unable to create new browser: code: 503: message: unavailable', 'LOGIN_UNAVAILABLE'],
  ]) {
    const { env, db, sdk, counts } = loginSetup();
    sdk.acquire = async () => { counts.acquisitions++; throw new Error(`${text} private-capability-url private-session`); };
    await assert.rejects(startBrowserLogin(env, { sub: 'owner' }, sdk, Date.now(), { purpose: 'payment-captcha' }), error => {
      assert.equal(error.code, code); assert.equal(error.browserStage, 'acquire'); assert.equal(error.cloudflareStatus, code === 'LOGIN_UNAVAILABLE' ? 503 : 429);
      assert.doesNotMatch(`${error.message}${JSON.stringify(error)}`, /private-capability|private-session|unknown restriction/);
      if (code === 'BROWSER_RATE_LIMIT') assert.doesNotMatch(error.message, /额度用尽/);
      return true;
    });
    assert.equal(counts.acquisitions, 1); assert.equal(counts.terminations, 0); assert.equal(db.prepare('SELECT state FROM account_login').get().state, 'closed');
  }
});
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

test('public Alipay checkout pins amount and transport, saves notes, and reads scheduled settlement without browser polling', async (t) => {
  const { env, db, request, create, control } = publicAgentSetup(t);
  const config = await (await request('/api/config')).json();
  assert.equal(config.paymentsAvailable, true); assert.deepEqual(config.paymentMethods, ['alipay']); assert.equal(config.maxAmount, '100000.00');
  const response = await create({ transport: 'worker' }); assert.equal(response.status, 201); const order = await response.json();
  assert.equal(order.amount, '37.00'); assert.equal(order.currency, 'CNY'); assert.match(order.accessToken, /^[a-f0-9]{64}$/);
  assert.deepEqual(control.jobs.map((job) => job.operation), ['profile', 'create']); assert.equal(control.jobs[1].amountFen, 3700);
  const row = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  assert.equal(row.provider_transport, 'agent'); assert.equal(row.is_admin_test, 0); assert.equal(row.nickname, '访客'); assert.equal(row.message, '留言');
  for (const key of ['nickname', 'message', 'providerOrderId', 'channelOrderId', 'token_hash']) assert.equal(key in order, false);
  assert.doesNotMatch(JSON.stringify(control.jobs), /private-fixture-secret|nickname|message|Cookie|Authorization/);
  control.online = false;
  const headers = { Authorization: `Bearer ${order.accessToken}` };
  assert.equal((await (await request(`/api/orders/${order.id}`, { headers })).json()).status, 'pending');
  assert.equal(control.jobs.length, 2, 'the ledger is readable while the executor is offline');
  control.online = true; control.paid = true; await reconcileOrder(env, row, 'scheduled');
  const paid = await (await request(`/api/orders/${order.id}`, { headers })).json();
  assert.equal(paid.status, 'paid'); assert.equal(paid.qrCode, null); assert.equal(control.jobs.length, 4);
  const saved = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  assert.equal(saved.provider_status, 'SUCCESS'); assert.ok(saved.paid_at); assert.ok(saved.confirmed_at);
});

test('scheduled browser checks finish the active checkout before processing older bills', async (t) => {
  const { env, db, create, control } = publicAgentSetup(t);
  const old = await (await create()).json();
  db.prepare("UPDATE orders SET provider_order_id='synthetic-older-order',expires_at=? WHERE id=?").run(Date.now() - 1000, old.id);
  const active = await (await create()).json();
  db.prepare('UPDATE orders SET last_checked_at=? WHERE id=?').run(Date.now() - AGENT_CHECK_INTERVAL - 1000, active.id);
  control.jobs.length = 0;
  control.paid = true;

  await reconcileScheduled(env);

  assert.deepEqual(control.jobs.map((job) => [job.operation, job.providerOrderId]), [
    ['capture', 'synthetic-public-order'],
    ['invoice', 'synthetic-public-order'],
    ['capture', 'synthetic-older-order'],
    ['invoice', 'synthetic-older-order']
  ]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM orders WHERE status='paid'").get().n, 2);
});

test('active checkout starts a rate-limited background check for the authenticated order', async (t) => {
  const { db, request, create, control } = publicAgentSetup(t);
  const order = await (await create()).json();
  const path = `/api/orders/${order.id}`;
  const headers = { Authorization: `Bearer ${order.accessToken}` };
  const tasks = [];
  const ctx = { waitUntil: (task) => tasks.push(task) };
  control.jobs.length = 0;

  assert.equal((await request(path, {}, ctx)).status, 401);
  assert.equal(control.jobs.length, 0);
  const reads = await Promise.all([request(path, { headers }, ctx), request(path, { headers }, ctx)]);
  for (const read of reads) assert.equal((await read.json()).status, 'pending');
  await Promise.all(tasks.splice(0));
  assert.deepEqual(control.jobs.map((job) => job.operation), ['capture']);

  control.paid = true;
  assert.equal((await (await request(path, { headers }, ctx)).json()).status, 'pending');
  await Promise.all(tasks.splice(0));
  assert.equal(control.jobs.length, 1);

  db.prepare('UPDATE orders SET last_checked_at=? WHERE id=?').run(Date.now() - AGENT_CHECK_INTERVAL - 1000, order.id);
  await request(path, { headers }, ctx);
  await Promise.all(tasks.splice(0));
  const confirmed = await (await request(path, { headers }, ctx)).json();
  assert.equal(confirmed.status, 'paid');
  assert.equal(confirmed.qrCode, null);
  assert.deepEqual(control.jobs.map((job) => job.operation), ['capture', 'capture', 'invoice']);
  assert.equal(db.prepare("SELECT source FROM payment_events WHERE state='paid'").get().source, 'poll');
});

test('public checkout rejects disabled methods, legacy oversized amounts, offline devices and invalid Turnstile before creating', async (t) => {
  const { env, db, request, create, control } = publicAgentSetup(t);
  assert.equal((await create({ paymentMethod: 'wechat' })).status, 409);
  control.protocol = 1;
  assert.equal((await (await request('/api/config')).json()).maxAmount, '1.00');
  assert.equal((await create()).status, 400);
  control.online = false;
  assert.equal((await (await request('/api/config')).json()).paymentsAvailable, false);
  assert.equal((await create({ amount: '1' })).status, 503);
  control.online = true; control.protocol = 2;
  assert.equal((await create({ turnstileToken: '' })).status, 403);
  env.PAYMENTS_ENABLED = 'false';
  assert.equal((await create()).status, 503);
  assert.equal(control.jobs.length, 0); assert.equal(db.prepare('SELECT count(*) AS n FROM orders').get().n, 0);
});

test('public retries reuse an unsent reservation but an uncertain creation cannot be replayed', async (t) => {
  const { db, create, control } = publicAgentSetup(t); const key = crypto.randomUUID();
  control.failure = 'unsent'; const rejected = await create({}, key);
  assert.equal(rejected.status, 503); assert.doesNotMatch(JSON.stringify(await rejected.json()), /browser|浏览器|实时窗口|AGENT_BUSY/);
  const first = db.prepare('SELECT * FROM orders').get(); assert.equal(first.status, 'failed'); assert.equal(first.last_check_error, 'AGENT_BUSY');
  control.failure = null; const retried = await (await create({}, key)).json(); assert.equal(retried.id, first.id);
  const replay = await (await create({}, key)).json(); assert.equal(replay.id, first.id);
  assert.equal(control.jobs.filter((job) => job.operation === 'create').length, 2); assert.equal(db.prepare('SELECT count(*) AS n FROM orders').get().n, 1);
  const anotherKey = crypto.randomUUID(); control.failure = 'uncertain';
  assert.equal((await create({}, anotherKey)).status, 503); const before = control.jobs.length;
  const uncertain = await create({}, anotherKey); assert.equal(uncertain.status, 409); assert.equal(control.jobs.length, before);
  assert.equal(db.prepare("SELECT count(*) AS n FROM orders WHERE status='unknown'").get().n, 1);
});

test('public checkout pauses without a recipient and never retries an order with a different recipient', async (t) => {
  const { env, db, request, create, control } = publicAgentSetup(t);
  delete env.DEEPSEEK_ACCOUNT_ID;
  control.protocol = 3;
  control.receivingAccountId = null;
  assert.equal((await (await request('/api/config')).json()).paymentsAvailable, false);
  assert.equal((await create()).status, 503);
  assert.equal(control.jobs.length, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM orders').get().n, 0);

  const key = crypto.randomUUID();
  control.receivingAccountId = 'first-recipient';
  control.failure = 'unsent';
  assert.equal((await create({}, key)).status, 503);
  assert.equal(db.prepare('SELECT provider_account_id FROM orders').get().provider_account_id, 'first-recipient');

  control.receivingAccountId = 'second-recipient';
  control.failure = null;
  const before = control.jobs.length;
  const repeated = await (await create({}, key)).json();
  assert.equal(repeated.status, 'failed');
  assert.equal(control.jobs.length, before);

  const response = await create();
  assert.equal(response.status, 201);
  const order = await response.json();
  assert.equal(db.prepare('SELECT provider_account_id FROM orders WHERE id=?').get(order.id).provider_account_id, 'second-recipient');
  assert.equal(control.jobs.at(-1).accountId, 'second-recipient');
  assert.equal('receivingAccountId' in (await (await request('/api/config')).json()), false);
});

test('admin test migration preserves old agent tests and excludes newer public agent bills from test restoration', async () => {
  const { env, db, create } = setup({ migrateAdminTests: false });
  const old = await (await create()).json(); db.prepare("UPDATE orders SET provider_transport='agent',is_demo=0,created_at=1 WHERE id=?").run(old.id);
  db.exec(readFileSync(new URL('../migrations/0008_admin_test_orders.sql', import.meta.url), 'utf8'));
  assert.equal(db.prepare('SELECT is_admin_test FROM orders WHERE id=?').get(old.id).is_admin_test, 1);
  const visitor = await (await create()).json(); db.prepare("UPDATE orders SET provider_transport='agent',is_demo=0,created_at=2 WHERE id=?").run(visitor.id);
  assert.equal((await readAgentTestOrder(env)).id, old.id);
  await assert.rejects(readAgentTestOrder(env, visitor.id), { code: 'NOT_FOUND' });
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
  assert.equal((await worker.fetch(new Request('https://feedfish.example/admin/client.012345abcdef.js'), env)).status, 503);
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
  await assert.rejects(upstream('/auth-api/v0/users/current', { sessionToken: 'private' }, undefined, async () => new Response('<html>challenge private</html>', { status: 403 })), (error) => error.code === 'UPSTREAM_NOT_JSON' && error.upstreamStatus === 403 && !error.message.includes('private'));
});

test('admin channel tests create one real CNY bill per request and cannot change the amount', async () => {
  const { env, db } = setup(); env.DEEPSEEK_ACCOUNT_ID = 'fixed'; env.DEEPSEEK_SESSION_TOKEN = 'private-test-token'; env.ORDER_TOKEN_SECRET = 's'.repeat(40);
  const calls = [], identity = { sub: 'owner' }, requestId = crypto.randomUUID();
  const fetcher = async (url, options) => { calls.push({ url, options }); return url.endsWith('/current') ? success({ id: 'fixed', currency: 'CNY' }) : success({ payment_order_id: 'test-remote-order', amount: '1', currency: 'CNY', url: 'weixin://wxpay/test-only' }); };
  const first = await createAdminTestPayment(env, identity, { requestId, paymentMethod: 'wechat', amount: '99999', currency: 'USD' }, fetcher);
  const second = await createAdminTestPayment(env, identity, { requestId, paymentMethod: 'wechat' }, fetcher);
  assert.equal(first.id, second.id); assert.equal(first.amount, '1.00'); assert.equal(first.currency, 'CNY'); assert.equal(first.status, 'pending');
  assert.equal(first.accessToken, undefined); assert.doesNotMatch(JSON.stringify(first), /private-test-token/);
  assert.equal(JSON.parse(calls.at(-1).options.body).order_info.amount, '1');
  assert.equal(JSON.parse(calls.at(-1).options.body).order_info.currency, 'CNY');
  assert.equal(calls.length, 2);
  const row = db.prepare('SELECT * FROM orders').get(); assert.equal(row.is_demo, 0); assert.equal(row.nickname, '通道测试'); assert.equal(row.amount_fen, 100);
  await assert.rejects(createAdminTestPayment(env, identity, { requestId, paymentMethod: 'alipay' }, fetcher), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('an uncertain admin payment test is recorded and never silently recreated', async () => {
  const { env, db } = setup(); env.DEEPSEEK_ACCOUNT_ID = 'fixed'; env.DEEPSEEK_SESSION_TOKEN = 'private-test-token'; env.ORDER_TOKEN_SECRET = 's'.repeat(40);
  const body = { requestId: crypto.randomUUID(), paymentMethod: 'wechat' }; let calls = 0;
  const blocked = async (url) => { calls++; return url.endsWith('/current') ? success({ id: 'fixed', currency: 'CNY' }) : new Response('private-block-page', { status: 403 }); };
  await assert.rejects(createAdminTestPayment(env, { sub: 'owner' }, body, blocked), { code: 'UPSTREAM_NOT_JSON' });
  await assert.rejects(createAdminTestPayment(env, { sub: 'owner' }, body, blocked), { code: 'ORDER_UNCERTAIN' });
  assert.equal(calls, 2); const row = db.prepare('SELECT * FROM orders').get();
  assert.equal(row.status, 'unknown'); assert.equal(row.qr_code, null); assert.equal(row.last_check_error, 'UPSTREAM_NOT_JSON');
  assert.doesNotMatch(JSON.stringify(row), /private-block-page|private-test-token/);
});

test('self-hosted admin bills retain their transport and reuse the same successful request', async () => {
  const { env, db } = setup(); env.DEEPSEEK_ACCOUNT_ID = 'fixed'; env.ORDER_TOKEN_SECRET = 's'.repeat(40); env.PAYMENT_TRANSPORT = 'agent';
  const body = { requestId: crypto.randomUUID(), paymentMethod: 'wechat' }; let posts = 0;
  const fetcher = async (url) => url.endsWith('/current') ? success({ id: 'fixed', currency: 'CNY' }) : (posts++, success({ payment_order_id: 'agent-test-order', amount: '1', currency: 'CNY', url: 'weixin://synthetic' }));
  const first = await createAdminTestPayment(env, { sub: 'owner' }, body, fetcher);
  const second = await createAdminTestPayment(env, { sub: 'owner' }, body, fetcher);
  assert.equal(first.id, second.id); assert.equal(posts, 1);
  const row = db.prepare('SELECT * FROM orders WHERE id=?').get(first.id); assert.equal(row.provider_transport, 'agent'); assert.equal(row.amount_fen, 100);
  await assert.rejects(createAdminTestPayment({ ...env, PAYMENT_TRANSPORT: undefined }, { sub: 'owner' }, body, fetcher), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('an uncertain self-hosted creation is retained without another upstream POST', async () => {
  const { env, db } = setup(); env.DEEPSEEK_ACCOUNT_ID = 'fixed'; env.ORDER_TOKEN_SECRET = 's'.repeat(40); env.PAYMENT_TRANSPORT = 'agent';
  const body = { requestId: crypto.randomUUID(), paymentMethod: 'alipay' }; let posts = 0;
  const fetcher = async (url) => url.endsWith('/current') ? success({ id: 'fixed', currency: 'CNY' }) : (posts++, new Response(null, { status: 202 }));
  await assert.rejects(createAdminTestPayment(env, { sub: 'owner' }, body, fetcher), { code: 'UPSTREAM_NOT_JSON' });
  await assert.rejects(createAdminTestPayment(env, { sub: 'owner' }, body, fetcher), { code: 'ORDER_UNCERTAIN' });
  assert.equal(posts, 1); const row = db.prepare('SELECT * FROM orders').get(); assert.equal(row.provider_transport, 'agent'); assert.equal(row.status, 'unknown');
});

test('an admin test rejected before sending reuses its original row and upstream request ID', async () => {
  const { env, db } = setup(); env.DEEPSEEK_ACCOUNT_ID = 'fixed'; env.DEEPSEEK_SESSION_TOKEN = 'private-test-token'; env.ORDER_TOKEN_SECRET = 's'.repeat(40);
  const identity = { sub: 'owner' }, body = { requestId: crypto.randomUUID(), paymentMethod: 'wechat' };
  await assert.rejects(createAdminTestPayment(env, identity, body, async () => Response.json({ code: 40003 })), { code: 'SESSION_EXPIRED' });
  const failed = db.prepare('SELECT * FROM orders').get(); assert.equal(failed.status, 'failed');
  let creations = 0;
  const fetcher = async (url, options) => {
    if (url.endsWith('/current')) return success({ id: 'fixed', currency: 'CNY' });
    creations++; assert.equal(JSON.parse(options.body).order_info.request_id, failed.id);
    return success({ payment_order_id: 'retried-order', amount: '1', currency: 'CNY', url: 'weixin://test' });
  };
  const retried = await createAdminTestPayment(env, identity, body, fetcher);
  assert.equal(retried.id, failed.id); assert.equal(retried.status, 'pending'); assert.equal(creations, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
  assert.equal(db.prepare('SELECT created_at FROM orders').get().created_at, failed.created_at);
  await createAdminTestPayment(env, identity, body, fetcher); assert.equal(creations, 1);
  db.prepare("UPDATE orders SET status='failed',payment_state='failed'").run();
  await assert.rejects(createAdminTestPayment(env, identity, body, fetcher), { code: 'PAYMENT_TEST_FAILED' });
  assert.equal(creations, 1);
});

test('concurrent retries of an unsent admin test admit one creation', async () => {
  const { env, db } = setup(); env.DEEPSEEK_ACCOUNT_ID = 'fixed'; env.DEEPSEEK_SESSION_TOKEN = 'private-test-token'; env.ORDER_TOKEN_SECRET = 's'.repeat(40);
  const identity = { sub: 'owner' }, body = { requestId: crypto.randomUUID(), paymentMethod: 'wechat' };
  await assert.rejects(createAdminTestPayment(env, identity, body, async () => Response.json({ code: 40003 })));
  let release, started, creations = 0;
  const gate = new Promise(resolve => { release = resolve; }); const posting = new Promise(resolve => { started = resolve; });
  const fetcher = async (url) => {
    if (url.endsWith('/current')) return success({ id: 'fixed', currency: 'CNY' });
    creations++; started(); await gate;
    return success({ payment_order_id: 'one-retried-order', amount: '1', currency: 'CNY', url: 'weixin://test' });
  };
  const first = createAdminTestPayment(env, identity, body, fetcher); await posting;
  await assert.rejects(createAdminTestPayment(env, identity, body, fetcher), { code: 'ORDER_UNCERTAIN' });
  release(); await first;
  assert.equal(creations, 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
});

test('admin payment tests require the pinned account, a strong order key and a known method', async () => {
  const { env, db } = setup(); const identity = { sub: 'owner' }, requestId = crypto.randomUUID();
  await assert.rejects(createAdminTestPayment(env, identity, { requestId, paymentMethod: 'wechat' }), { code: 'ACCOUNT_NOT_CONFIGURED' });
  env.DEEPSEEK_ACCOUNT_ID = 'fixed'; env.ORDER_TOKEN_SECRET = 'short';
  await assert.rejects(createAdminTestPayment(env, identity, { requestId, paymentMethod: 'wechat' }), { code: 'ACCOUNT_NOT_CONFIGURED' });
  env.ORDER_TOKEN_SECRET = 's'.repeat(40);
  await assert.rejects(createAdminTestPayment(env, identity, { requestId, paymentMethod: 'card' }), { code: 'INVALID_METHOD' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
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
test('self-hosted ledger notifications follow committed changes, ignore stale duplicates and tolerate delivery failure', async () => {
  const { env, create, db } = setup(); const order = await (await create()).json();
  db.prepare("UPDATE orders SET is_demo=0,provider_transport='agent' WHERE id=?").run(order.id);
  const notices = [];
  env.AGENT_RELAY = { idFromName: () => 'fixed-account-browser', get: () => ({ fetch: async (request) => {
    assert.equal(new URL(request.url).pathname, '/notify-order');
    const body = await request.json(); assert.deepEqual(body, { id: order.id });
    assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(order.id).status, 'paid');
    assert.equal(db.prepare('SELECT count(*) AS n FROM payment_events').get().n, notices.length + 1);
    notices.push(body); throw new Error('viewer unavailable');
  } }) };
  const row = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  await applyPaymentResult(env, row, { status: 'paid', providerStatus: 'SUCCESS' }, 'scheduled');
  await applyPaymentResult(env, row, { status: 'paid', providerStatus: 'SUCCESS' }, 'poll');
  let paid = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  await applyPaymentResult(env, paid, { status: 'paid', providerStatus: 'SUCCESS' }, 'poll');
  assert.equal(notices.length, 1); assert.equal(paid.last_check_error, null);
  env.DB.batch = async () => { throw new Error('transaction failed'); };
  await assert.rejects(applyPaymentResult(env, paid, { status: 'failed', providerStatus: 'REFUNDED' }, 'scheduled'), /transaction failed/);
  assert.equal(notices.length, 1); assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(order.id).status, 'paid');
});

test('saved agent test status restores only real self-hosted orders, without credentials or writes', async () => {
  const { env, create, db, request } = setup();
  assert.equal(await readAgentTestOrder(env), null);
  const first = await (await create()).json(); const second = await (await create()).json(); const legacy = await (await create()).json();
  db.prepare("UPDATE orders SET is_demo=0,provider_transport='agent',is_admin_test=1,created_at=1 WHERE id=?").run(first.id);
  db.prepare("UPDATE orders SET is_demo=0,provider_transport='agent',is_admin_test=1,created_at=2,status='paid',payment_state='paid' WHERE id=?").run(second.id);
  db.prepare('UPDATE orders SET is_demo=0,created_at=3 WHERE id=?').run(legacy.id);
  const latest = await readAgentTestOrder(env);
  assert.equal(latest.id, second.id); assert.equal(latest.status, 'paid'); assert.equal(latest.qrCode, null);
  for (const field of ['accessToken', 'token_hash', 'provider_order_id', 'nickname', 'message', 'sealed_credentials']) assert.equal(field in latest, false);
  assert.equal((await readAgentTestOrder(env, first.id)).id, first.id);
  await assert.rejects(readAgentTestOrder(env, legacy.id), { code: 'NOT_FOUND' });
  await assert.rejects(readAgentTestOrder(env, 'bad-id'), { code: 'INVALID_ORDER_ID' });
  const local = await request('/api/admin/account/agent-payment/status');
  assert.equal(local.headers.get('Cache-Control'), 'no-store'); assert.deepEqual(await local.json(), { order: null });
  Object.assign(env, { LOCAL_DEMO: 'false', ACCESS_TEAM_DOMAIN: 'https://test.cloudflareaccess.com', ACCESS_AUD: 'test-audience', ADMIN_EMAILS: 'owner@example.invalid' });
  assert.equal((await request('/api/admin/account/agent-payment/status')).status, 403);
  assert.equal(db.prepare('SELECT count(*) AS n FROM orders').get().n, 3);
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
