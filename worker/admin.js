import { ApiError, assertOrigin, readJson, readTurnstileSettings, formatAmount, publicOrder } from './lib.js';
import { requireAdmin } from './access.js';
import { accountState, credentialsFor, seal } from './vault.js';
import { inspectAccount, verifyAccount, accountFromProfile, queryPayment } from './provider.js';
import { browserLoginState, startBrowserLogin, completeBrowserLogin, cancelBrowserLogin, browserLoginDiagnostics, anonymousBrowserConnectivity, browserResourceStatus, verifyAccountInBrowser } from './browser-login.js';
import { authorizationState, startAuthorization, completeAuthorization, cancelAuthorization, authorizationConnectivity, lastAuthorizationFailure, recordAuthorizationFailure } from './authorization.js';
import { pendingAuthorizationState, verifyPendingAuthorization, discardPendingAuthorization } from './pending-authorization.js';
import { createAdminTestPayment, assertAdminPaymentTransport, readAgentTestOrder } from './admin-payments.js';
import { browserPaymentFetcher } from './browser-payments.js';
import { startPaymentChallenge, paymentChallengeView, completePaymentChallenge, cancelPaymentChallenge } from './payment-challenge.js';
import { connectManualSession } from './manual-session.js';
import { agentRequest, agentViewer } from './browser-agent.js';
import { agentPaymentFetcher } from './agent-payments.js';
import { reconcileOrder } from './reconcile.js';
import { PROFILE_AVATAR_ORIGINS } from '../shared/account-profile.js';
const contentSecurityPolicy = (socketOrigin = '') => `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: ${PROFILE_AVATAR_ORIGINS.join(' ')}; connect-src 'self'${socketOrigin}; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': contentSecurityPolicy() };
const json = (data, status = 200) => Response.json(data, { status, headers });
const demoAccount = { configured: false, accountId: 'demo-fixed-account', status: 'not_configured', updatedAt: null, lastCheckedAt: null };
async function paymentFailure(env, identity, event, error, transport) {
  if (!(error instanceof ApiError)) throw error;
  const diagnostic = { stage: ['limits', 'acquire', 'connect', 'context', 'navigate', 'prepare', 'view', 'persist'].includes(error.browserStage) ? `browser_${error.browserStage}` : 'payment', code: error.code };
  if (['agent', 'browser', 'worker'].includes(transport)) diagnostic.transport = transport;
  if (Number.isInteger(error.cloudflareStatus) && error.cloudflareStatus >= 100 && error.cloudflareStatus <= 599) diagnostic.cloudflareStatus = error.cloudflareStatus;
  for (const key of ['upstreamStatus', 'upstreamCode', 'upstreamBizCode']) if (Number.isSafeInteger(error[key])) diagnostic[key] = error[key];
  if (['captcha', 'challenge'].includes(error.upstreamChallenge)) diagnostic.upstreamChallenge = error.upstreamChallenge;
  await env.DB.prepare('INSERT INTO admin_audit (event,actor,created_at) VALUES (?,?,?)').bind(`${event}:${JSON.stringify(diagnostic)}`, identity.email, Date.now()).run().catch(() => {});
  return json({ error: { code: error.code, message: error.message, diagnostic } }, error.status);
}
export async function handleAdmin(request, env) {
  const identity = await requireAdmin(request, env); const path = new URL(request.url).pathname;
  // Serve the management bundle through the same service binding as its HTML.
  // A content-addressed path cannot cache an older Pages bundle under a new URL.
  const brandAsset = /^\/admin\/brand-(?:icon|mark)-(?:light|dark)\.svg$/.test(path);
  if ((brandAsset || path === '/admin/receiver.mjs' || /^\/admin\/(?:client\.[a-f0-9]{12}\.js|styles\.[a-f0-9]{12}\.css)$/.test(path)) && request.method === 'GET') {
    if (!env.ASSETS) throw new ApiError(503, 'ADMIN_UNAVAILABLE', '后台页面暂未就绪。');
    const response = await env.ASSETS.fetch(request);
    const assetHeaders = brandAsset ? {} : path === '/admin/receiver.mjs' ? { 'Content-Disposition': 'attachment; filename="connect-account.mjs"' } : { 'Cache-Control': 'private, max-age=31536000, immutable' };
    return new Response(response.body, { status: response.status, headers: { ...headers, 'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream', ...assetHeaders } });
  }
  if (path === '/admin' || path === '/admin/' || path === '/admin/index.html') {
    if (!env.ASSETS) throw new ApiError(503, 'ADMIN_UNAVAILABLE', '后台页面暂未就绪。');
    const url = new URL(request.url); url.pathname = '/admin/';
    const response = await env.ASSETS.fetch(new Request(url, { method: 'GET' }));
    const socketOrigin = `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`;
    return new Response(response.body, { status: response.status, headers: { ...headers, 'Content-Security-Policy': contentSecurityPolicy(` ${socketOrigin}`), 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (path === '/api/admin/session' && request.method === 'GET') return json({ email: identity.email, demo: identity.demo, ...await readTurnstileSettings(env, identity.demo), legacyPaymentTestingAvailable: !identity.demo && env.LEGACY_CLOUD_TESTS_ENABLED === 'true', authorizationAvailable: !identity.demo && !!env.ACCOUNT_ENCRYPTION_KEY, authorization: identity.demo ? null : await authorizationState(env, identity), pendingAuthorization: identity.demo ? null : await pendingAuthorizationState(env, identity), expectedAccountId: identity.demo ? 'demo-fixed-account' : env.DEEPSEEK_ACCOUNT_ID || null, account: identity.demo ? demoAccount : await accountState(env) });
  if (path === '/api/admin/browser-agent/status' && request.method === 'GET') return identity.demo ? json({ configured: false, online: false, demo: true, profile: null, profileUpdatedAt: null }) : agentRequest(env, '/status');
  if (path === '/api/admin/account/agent-payment/status' && request.method === 'GET') return json({ order: identity.demo ? null : await readAgentTestOrder(env, new URL(request.url).searchParams.get('id')) });
  if (path === '/api/admin/browser-agent/socket' && request.method === 'GET' && !identity.demo) { assertOrigin(request, false); return agentViewer(request, env, identity); }
  if (path === '/api/admin/account/login/status' && request.method === 'GET' && !identity.demo) return json(await browserLoginDiagnostics(env, identity));
  if (path === '/api/admin/account/authorize/diagnostics' && request.method === 'GET' && !identity.demo) return json({ failure: await lastAuthorizationFailure(env) });
  if (path === '/api/admin/account/payment-challenge/view' && request.method === 'GET' && !identity.demo) {
    const url = await paymentChallengeView(env, identity, new URL(request.url).searchParams.get('id'));
    return new Response(null, { status: 302, headers: { ...headers, Location: url } });
  }
  if (path === '/api/admin/account/authorize/connectivity' && request.method === 'GET' && !identity.demo) {
    const mode = new URL(request.url).searchParams.get('mode');
    if (mode === 'resources') return json(await browserResourceStatus(env));
    if (mode === 'browser') { assertAdminPaymentTransport(env, path, { transport: 'browser' }); return json(await anonymousBrowserConnectivity(env)); }
    return json(await authorizationConnectivity(fetch, mode === 'dsh' || mode === 'client' ? mode : 'anonymous'));
  }
  if (path === '/api/admin/orders' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT id,amount_fen,payment_method,nickname,message,status,payment_state,provider_status,provider_order_id,channel_order_id,created_at,paid_at,confirmed_at,last_check_error FROM orders WHERE is_demo=? ORDER BY created_at DESC LIMIT 50').bind(identity.demo ? 1 : 0).all();
    return json({ orders: rows.results.map((row) => ({ id: row.id, amount: formatAmount(row.amount_fen), currency: 'CNY', paymentMethod: row.payment_method, nickname: row.nickname, message: row.message, status: row.status, paymentState: row.payment_state, providerStatus: row.provider_status, providerOrderId: row.provider_order_id, channelOrderId: row.channel_order_id, lastCheckError: row.last_check_error, createdAt: new Date(row.created_at).toISOString(), paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null, confirmedAt: row.confirmed_at ? new Date(row.confirmed_at).toISOString() : null })) });
  }
  if (request.method !== 'POST') throw new ApiError(404, 'NOT_FOUND', '页面不存在。');
  assertOrigin(request, identity.demo);
  if (request.headers.get('X-Feedfish-Admin') !== '1') throw new ApiError(403, 'INVALID_REQUEST', '请从管理后台提交。');
  if (identity.demo) throw new ApiError(403, 'DEMO_READ_ONLY', '本地演示不接收真实账号凭证。');
  if (!env.DB) throw new ApiError(503, 'DATABASE_UNAVAILABLE', '账号存储暂未就绪。');
  const bucket = `admin:${identity.sub}:${Math.floor(Date.now() / 60000)}`;
  const limit = await env.DB.prepare('INSERT INTO rate_limits (bucket,count,expires_at) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count').bind(bucket, Date.now() + 120000).first();
  if (limit.count > 6) throw new ApiError(429, 'RATE_LIMITED', '操作过于频繁，请稍后重试。');
  const body = await readJson(request); const now = Date.now();
  if (path === '/api/admin/settings/turnstile') {
    if (typeof body?.enabled !== 'boolean') throw new ApiError(400, 'INVALID_TURNSTILE_SETTING', '请选择开启或关闭人机验证码。');
    const { turnstileConfigured } = await readTurnstileSettings(env);
    if (body.enabled && !turnstileConfigured) throw new ApiError(409, 'TURNSTILE_NOT_CONFIGURED', '请先配置 Turnstile 站点键和密钥。');
    await env.DB.batch([
      env.DB.prepare('INSERT INTO checkout_settings (singleton, turnstile_enabled) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET turnstile_enabled=excluded.turnstile_enabled').bind(body.enabled ? 1 : 0),
      env.DB.prepare('INSERT INTO admin_audit (event,actor,created_at) VALUES (?,?,?)').bind(body.enabled ? 'turnstile_enabled' : 'turnstile_disabled', identity.email, now),
    ]);
    return json({ turnstileEnabled: body.enabled, turnstileConfigured });
  }
  assertAdminPaymentTransport(env, path, body);
  if (path === '/api/admin/browser-agent/recipient') {
    if (!['select', 'clear'].includes(body.action)) throw new ApiError(400, 'INVALID_REQUEST', '请选择收款账号操作。');
    const selecting = body.action === 'select';
    const response = await agentRequest(env, selecting ? '/select-recipient' : '/clear-recipient', {});
    if (response.ok) await audit(env, selecting ? 'agent_recipient_selected' : 'agent_recipient_cleared', identity.email, now).catch(() => {});
    return response;
  }
  if (path === '/api/admin/account/agent-payment/check') {
    if (typeof body.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.id)) throw new ApiError(400, 'INVALID_ORDER_ID', '测试账单标识无效。');
    let row = await env.DB.prepare("SELECT * FROM orders WHERE id=? AND is_demo=0 AND provider_transport='agent'").bind(body.id).first();
    if (!row?.provider_order_id) throw new ApiError(404, 'NOT_FOUND', '该账单尚无可核对的平台订单号。');
    try { await reconcileOrder(env, row); }
    catch (error) { return paymentFailure(env, identity, 'agent_payment_check_failed', error); }
    row = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(row.id).first();
    return json(publicOrder(row));
  }
  if (path === '/api/admin/browser-agent/approve' || path === '/api/admin/browser-agent/revoke') {
    const approving = path.endsWith('/approve');
    const response = await agentRequest(env, approving ? '/approve' : '/revoke', approving ? { code: body.code, replace: body.replace === true } : {});
    if (response.ok) await audit(env, approving ? 'browser_agent_paired' : 'browser_agent_revoked', identity.email, now);
    return response;
  }
  if (path === '/api/admin/account/payment-challenge/start') {
    try { return json(await startPaymentChallenge(env, identity)); }
    catch (error) { return paymentFailure(env, identity, 'payment_challenge_start_failed', error instanceof ApiError ? error : new ApiError(503, 'LOGIN_UNAVAILABLE', 'Cloudflare 验证窗口暂不可用，请稍后重试。')); }
  }
  if (path === '/api/admin/account/payment-challenge/cancel') { await cancelPaymentChallenge(env, identity, body.id); return json({ ok: true }); }
  if (path === '/api/admin/account/payment-challenge/complete') {
    try { return json(await completePaymentChallenge(env, identity, body.id)); }
    catch (error) { return paymentFailure(env, identity, 'payment_challenge_failed', error instanceof ApiError ? error : new ApiError(503, 'PAYMENT_CHALLENGE_UNAVAILABLE', '官方验证或测试取码暂时未完成，请检查后台记录。')); }
  }
  if (path === '/api/admin/account/test-payment' || path === '/api/admin/account/check-payment') {
    const checking = path.endsWith('/check-payment');
    if (body.transport !== undefined && !['browser', 'agent'].includes(body.transport)) throw new ApiError(400, 'INVALID_REQUEST', '付款码测试方式无效。');
    try {
      const viaAgent = body.transport === 'agent';
      let paymentEnv = env;
      if (viaAgent) {
        const status = await (await agentRequest(env, '/status')).json();
        if (!status.receivingAccountId) throw new ApiError(503, 'ACCOUNT_NOT_CONFIGURED', '请先启用当前登录的收款账号。');
        paymentEnv = { ...env, PAYMENT_TRANSPORT: 'agent', DEEPSEEK_ACCOUNT_ID: status.receivingAccountId };
      }
      if (checking) {
        if (!body.providerOrderId) throw new ApiError(400, 'INVALID_ORDER_ID', '请输入 DeepSeek 订单号。');
        const fetcher = viaAgent ? agentPaymentFetcher(paymentEnv, { providerOrderId: body.providerOrderId }) : browserPaymentFetcher(env, await credentialsFor(env, true), undefined, body.providerOrderId);
        // Diagnostic only: capture is the official page's status polling API.
        // Never create or import a ledger record from caller-supplied fields.
        const result = await queryPayment(paymentEnv, { provider_order_id: body.providerOrderId, provider_transport: viaAgent ? 'agent' : 'worker', amount_fen: 100, created_at: now, paid_at: null }, fetcher);
        return json({ ...result, providerOrderId: body.providerOrderId });
      }
      const fetcher = body.transport === 'browser' ? browserPaymentFetcher(env, await credentialsFor(env)) : fetch;
      return json(await createAdminTestPayment(paymentEnv, identity, body, fetcher));
    }
    catch (error) {
      return paymentFailure(env, identity, checking ? 'payment_check_failed' : 'payment_test_failed', error, body.transport || 'worker');
    }
  }
  if (path === '/api/admin/account/authorize/start') {
    try { return json(await startAuthorization(env, identity, body)); }
    catch (error) {
      if (!(error instanceof ApiError) || !error.authorizationDiagnostic) throw error;
      return json({ error: { code: error.code, message: error.message, diagnostic: error.authorizationDiagnostic } }, error.status);
    }
  }
  if (path === '/api/admin/account/authorize/complete' || path === '/api/admin/account/authorize/retry') {
    try {
      const saveSession = (credentials, pendingId) => importSession(env, credentials, identity.email, Date.now(), fetch, pendingId);
      const account = path.endsWith('/retry') ? await verifyPendingAuthorization(env, identity, body.id, saveSession) : await completeAuthorization(env, identity, body, saveSession);
      return json({ ok: true, accountId: account.id, requiresPin: !env.DEEPSEEK_ACCOUNT_ID });
    } catch (error) {
      const failure = error instanceof ApiError ? error : new ApiError(503, 'AUTH_SAVE_FAILED', '账户连接未能保存，请管理员检查保险库和数据库状态。');
      if (path.endsWith('/retry')) await recordAuthorizationFailure(env, identity, 'account', failure);
      if (!failure.authorizationDiagnostic) throw failure;
      return json({ error: { code: failure.code, message: failure.message, diagnostic: failure.authorizationDiagnostic } }, failure.status);
    }
  }
  if (path === '/api/admin/account/authorize/discard') return json(await discardPendingAuthorization(env, identity, body.id));
  if (path === '/api/admin/account/authorize/cancel') { await cancelAuthorization(env, identity); return json({ ok: true }); }
  if (path === '/api/admin/account/login/start') return json(await startBrowserLogin(env, identity));
  if (path === '/api/admin/account/login/complete' || path === '/api/admin/account/login/cancel') {
    if (typeof body.id !== 'string' || !/^[0-9a-f-]{36}$/.test(body.id)) throw new ApiError(400, 'INVALID_LOGIN', '登录窗口标识无效。');
    if (path.endsWith('/cancel')) { await cancelBrowserLogin(env, identity, body.id); return json({ ok: true }); }
    const account = await completeBrowserLogin(env, identity, body.id, (credentials) => importSession(env, credentials, identity.email));
    return json({ ok: true, accountId: account.id, requiresPin: !env.DEEPSEEK_ACCOUNT_ID });
  }
  if (path === '/api/admin/account/session') {
    try {
      const account = await connectManualSession(env, identity, body, (credentials, pending) => importSession(env, credentials, identity.email, now, fetch, pending));
      return json({ ok: true, accountId: account.id, requiresPin: !env.DEEPSEEK_ACCOUNT_ID });
    } catch (error) {
      const failure = error instanceof ApiError ? error : new ApiError(503, 'AUTH_SAVE_FAILED', '会话导入未完成，请查看后台状态。');
      await recordAuthorizationFailure(env, identity, 'account', failure);
      return json({ error: { code: failure.code, message: failure.message, diagnostic: failure.authorizationDiagnostic } }, failure.status);
    }
  }
  if (path === '/api/admin/account/check') {
    if (body.transport !== undefined && !['browser', 'agent'].includes(body.transport)) throw new ApiError(400, 'INVALID_REQUEST', '账户核验方式无效。');
    if (body.paymentContext !== undefined && typeof body.paymentContext !== 'boolean') throw new ApiError(400, 'INVALID_REQUEST', '支付环境检查参数无效。');
    if (body.transport === 'agent') {
      const status = await (await agentRequest(env, '/status')).json();
      if (!status.receivingAccountId) throw new ApiError(503, 'ACCOUNT_NOT_CONFIGURED', '请先启用当前登录的收款账号。');
      const paymentEnv = { ...env, PAYMENT_TRANSPORT: 'agent', DEEPSEEK_ACCOUNT_ID: status.receivingAccountId };
      const account = await verifyAccount(paymentEnv, {}, agentPaymentFetcher(paymentEnv, { includeProfile: true }));
      const refreshed = await (await agentRequest(env, '/status')).json();
      if (refreshed.receivingAccountId !== account.id) throw new ApiError(409, 'ACCOUNT_MISMATCH', '收款账号已变化，请重新核验。');
      await audit(env, 'session_agent_checked', identity.email, now).catch(() => {});
      return json({ ok: true, profile: refreshed.profile ?? null, profileUpdatedAt: refreshed.profileUpdatedAt ?? null });
    }
    try {
      const credentials = await credentialsFor(env, true);
      const account = body.transport === 'browser' ? await verifyAccountInBrowser(env, credentials, undefined, body.paymentContext === true) : await verifyAccount(env, credentials);
      const sealed = await seal(credentials, env.ACCOUNT_ENCRYPTION_KEY);
      await env.DB.prepare('INSERT INTO account_session (singleton,account_id,sealed_credentials,status,updated_at,last_checked_at,updated_by) VALUES (1,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET last_checked_at=excluded.last_checked_at').bind(account.id, sealed, 'connected', now, now, identity.email).run();
    }
    catch (error) {
      if (error.code === 'SESSION_EXPIRED' || error.code === 'ACCOUNT_MISMATCH') await env.DB.prepare('UPDATE account_session SET status=?,last_checked_at=? WHERE singleton=1').bind('unverified', now).run();
      if (body.transport === 'browser' && error instanceof ApiError) {
        await recordAuthorizationFailure(env, identity, 'account', error);
        return json({ error: { code: error.code, message: error.message, diagnostic: error.authorizationDiagnostic } }, error.status);
      }
      throw error;
    }
    await audit(env, body.transport === 'browser' ? 'session_browser_checked' : 'session_checked', identity.email, now); return json({ ok: true });
  }
  if (path === '/api/admin/account/disable') {
    if (!env.DEEPSEEK_ACCOUNT_ID) throw new ApiError(503, 'ACCOUNT_NOT_CONFIGURED', '固定账号尚未配置。');
    const credentials = await credentialsFor(env, true);
    const sealed = await seal(credentials, env.ACCOUNT_ENCRYPTION_KEY);
    await env.DB.prepare('INSERT INTO account_session (singleton,account_id,sealed_credentials,status,updated_at,updated_by) VALUES (1,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,updated_by=excluded.updated_by').bind(env.DEEPSEEK_ACCOUNT_ID, sealed, 'disabled', now, identity.email).run();
    await audit(env, 'session_disabled', identity.email, now); return json({ ok: true });
  }
  throw new ApiError(404, 'NOT_FOUND', '页面不存在。');
}
// First import may stage a verified session, but orders still require the pinned
// deployment variable. The conditional upsert locks the first account atomically.
export async function importSession(env, credentials, actor, now = Date.now(), fetcher = fetch, pending) {
  const previous = await env.DB.prepare('SELECT account_id FROM account_session WHERE singleton=1').first();
  const expected = env.DEEPSEEK_ACCOUNT_ID || previous?.account_id;
  let account;
  if (pending && credentials.dshToken && credentials.issuedAccount?.id && ['CNY', 'USD'].includes(credentials.issuedAccount.currency)) {
    account = accountFromProfile(credentials.issuedAccount);
    if (expected && account.id !== expected) throw new ApiError(409, 'ACCOUNT_MISMATCH', '授权账户与固定收款账户不一致。');
    credentials = { ...credentials, accountBinding: { kind: 'dsh-exchange', accountId: account.id } };
  } else account = expected ? await verifyAccount({ ...env, DEEPSEEK_ACCOUNT_ID: expected }, credentials, fetcher) : await inspectAccount(credentials, fetcher);
  const sealed = await seal(credentials, env.ACCOUNT_ENCRYPTION_KEY);
  const time = Date.now();
  const insertion = pending ? 'SELECT 1,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM account_pending_authorization WHERE id=? AND owner_sub=? AND lease_until=? AND lease_until>? AND expires_at>?)' : 'VALUES (1,?,?,?,?,?,?)';
  const values = [account.id, sealed, 'connected', now, now, actor];
  if (pending) values.push(pending.id, pending.ownerSub, pending.leaseUntil, time, time);
  const statement = env.DB.prepare(`INSERT INTO account_session (singleton,account_id,sealed_credentials,status,updated_at,last_checked_at,updated_by) ${insertion} ON CONFLICT(singleton) DO UPDATE SET sealed_credentials=excluded.sealed_credentials,status=excluded.status,updated_at=excluded.updated_at,last_checked_at=excluded.last_checked_at,updated_by=excluded.updated_by WHERE account_session.account_id=excluded.account_id`).bind(...values);
  const result = pending ? (await env.DB.batch([statement, env.DB.prepare('DELETE FROM account_pending_authorization WHERE singleton=1 AND id=? AND owner_sub=? AND lease_until=? AND EXISTS (SELECT 1 FROM account_session WHERE account_id=? AND sealed_credentials=?)').bind(pending.id, pending.ownerSub, pending.leaseUntil, account.id, sealed)]))[0] : await statement.run();
  if (!result.meta.changes) throw new ApiError(409, pending ? 'AUTH_EXPIRED' : 'ACCOUNT_MISMATCH', pending ? '本次核验已取消或超时，请刷新后重试。' : '固定收款账号已锁定，不能导入其他账号的会话。');
  await audit(env, env.DEEPSEEK_ACCOUNT_ID ? 'session_connected' : 'session_staged', actor, now).catch(() => {});
  return pending ? { ...account, pendingCleared: true } : account;
}
async function audit(env, event, actor, now) { await env.DB.prepare('INSERT INTO admin_audit (event,actor,created_at) VALUES (?,?,?)').bind(event, actor, now).run(); }
