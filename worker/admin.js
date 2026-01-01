import { ApiError, assertOrigin, readJson, formatAmount } from './lib.js';
import { requireAdmin } from './access.js';
import { accountState, credentialsFor, seal } from './vault.js';
import { inspectAccount, verifyAccount } from './provider.js';
import { browserLoginState, startBrowserLogin, completeBrowserLogin, cancelBrowserLogin, browserLoginDiagnostics, anonymousBrowserConnectivity, browserResourceStatus } from './browser-login.js';
import { authorizationState, startAuthorization, completeAuthorization, cancelAuthorization, authorizationConnectivity } from './authorization.js';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
const json = (data, status = 200) => Response.json(data, { status, headers });
const demoAccount = { configured: false, accountId: 'demo-fixed-account', status: 'not_configured', updatedAt: null, lastCheckedAt: null };
export async function handleAdmin(request, env) {
  const identity = await requireAdmin(request, env); const path = new URL(request.url).pathname;
  // Serve the management bundle through the same service binding as its HTML.
  // A content-addressed path cannot cache an older Pages bundle under a new URL.
  if ((path === '/admin/receiver.mjs' || /^\/admin\/(?:client\.[a-f0-9]{12}\.js|styles\.[a-f0-9]{12}\.css)$/.test(path)) && request.method === 'GET') {
    if (!env.ASSETS) throw new ApiError(503, 'ADMIN_UNAVAILABLE', '后台页面暂未就绪。');
    const response = await env.ASSETS.fetch(request);
    return new Response(response.body, { status: response.status, headers: { ...headers, 'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream', ...(path === '/admin/receiver.mjs' ? { 'Content-Disposition': 'attachment; filename="connect-account.mjs"' } : { 'Cache-Control': 'private, max-age=31536000, immutable' }) } });
  }
  if (path === '/admin' || path === '/admin/' || path === '/admin/index.html') {
    if (!env.ASSETS) throw new ApiError(503, 'ADMIN_UNAVAILABLE', '后台页面暂未就绪。');
    const url = new URL(request.url); url.pathname = '/admin/';
    const response = await env.ASSETS.fetch(new Request(url, { method: 'GET' }));
    return new Response(response.body, { status: response.status, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (path === '/api/admin/session' && request.method === 'GET') return json({ email: identity.email, demo: identity.demo, authorizationAvailable: !identity.demo && !!env.ACCOUNT_ENCRYPTION_KEY, authorization: identity.demo ? null : await authorizationState(env, identity), expectedAccountId: identity.demo ? 'demo-fixed-account' : env.DEEPSEEK_ACCOUNT_ID || null, account: identity.demo ? demoAccount : await accountState(env) });
  if (path === '/api/admin/account/login/status' && request.method === 'GET' && !identity.demo) return json(await browserLoginDiagnostics(env, identity));
  if (path === '/api/admin/account/authorize/connectivity' && request.method === 'GET' && !identity.demo) {
    const mode = new URL(request.url).searchParams.get('mode');
    if (mode === 'resources') return json(await browserResourceStatus(env));
    if (mode === 'browser') return json(await anonymousBrowserConnectivity(env));
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
  if (path === '/api/admin/account/authorize/start') return json(await startAuthorization(env, identity, body));
  if (path === '/api/admin/account/authorize/complete') {
    const account = await completeAuthorization(env, identity, body, (credentials) => importSession(env, credentials, identity.email));
    return json({ ok: true, accountId: account.id, requiresPin: !env.DEEPSEEK_ACCOUNT_ID });
  }
  if (path === '/api/admin/account/authorize/cancel') { await cancelAuthorization(env, identity); return json({ ok: true }); }
  if (path === '/api/admin/account/login/start') return json(await startBrowserLogin(env, identity));
  if (path === '/api/admin/account/login/complete' || path === '/api/admin/account/login/cancel') {
    if (typeof body.id !== 'string' || !/^[0-9a-f-]{36}$/.test(body.id)) throw new ApiError(400, 'INVALID_LOGIN', '登录窗口标识无效。');
    if (path.endsWith('/cancel')) { await cancelBrowserLogin(env, identity, body.id); return json({ ok: true }); }
    const account = await completeBrowserLogin(env, identity, body.id, (credentials) => importSession(env, credentials, identity.email));
    return json({ ok: true, accountId: account.id, requiresPin: !env.DEEPSEEK_ACCOUNT_ID });
  }
  if (path === '/api/admin/account/session') {
    if (typeof body.sessionToken !== 'string' || body.sessionToken.length < 20 || body.sessionToken.length > 6000 || /\s/.test(body.sessionToken)) throw new ApiError(400, 'INVALID_SESSION', '请输入有效的网页登录 token，不包含 Bearer 前缀。');
    for (const name of ['deviceId', 'deviceModel', 'shumeiDeviceId']) if (body[name] !== undefined && (typeof body[name] !== 'string' || body[name].length > 512 || /[\r\n]/.test(body[name]))) throw new ApiError(400, 'INVALID_DEVICE', '设备信息格式无效。');
    const credentials = { sessionToken: body.sessionToken, deviceId: body.deviceId || '', deviceModel: body.deviceModel || '', shumeiDeviceId: body.shumeiDeviceId || '' };
    const account = await importSession(env, credentials, identity.email, now);
    return json({ ok: true, accountId: account.id, requiresPin: !env.DEEPSEEK_ACCOUNT_ID });
  }
  if (path === '/api/admin/account/check') {
    try {
      const credentials = await credentialsFor(env, true); const account = await verifyAccount(env, credentials);
      const sealed = await seal(credentials, env.ACCOUNT_ENCRYPTION_KEY);
      await env.DB.prepare('INSERT INTO account_session (singleton,account_id,sealed_credentials,status,updated_at,last_checked_at,updated_by) VALUES (1,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET last_checked_at=excluded.last_checked_at').bind(account.id, sealed, 'connected', now, now, identity.email).run();
    }
    catch (error) { if (error.code === 'SESSION_EXPIRED' || error.code === 'ACCOUNT_MISMATCH') await env.DB.prepare('UPDATE account_session SET status=?,last_checked_at=? WHERE singleton=1').bind('unverified', now).run(); throw error; }
    await audit(env, 'session_checked', identity.email, now); return json({ ok: true });
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
export async function importSession(env, credentials, actor, now = Date.now(), fetcher = fetch) {
  const previous = await env.DB.prepare('SELECT account_id FROM account_session WHERE singleton=1').first();
  const expected = env.DEEPSEEK_ACCOUNT_ID || previous?.account_id;
  const sealed = await seal(credentials, env.ACCOUNT_ENCRYPTION_KEY);
  const account = expected ? await verifyAccount({ ...env, DEEPSEEK_ACCOUNT_ID: expected }, credentials, fetcher) : await inspectAccount(credentials, fetcher);
  const result = await env.DB.prepare('INSERT INTO account_session (singleton,account_id,sealed_credentials,status,updated_at,last_checked_at,updated_by) VALUES (1,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET sealed_credentials=excluded.sealed_credentials,status=excluded.status,updated_at=excluded.updated_at,last_checked_at=excluded.last_checked_at,updated_by=excluded.updated_by WHERE account_session.account_id=excluded.account_id').bind(account.id, sealed, 'connected', now, now, actor).run();
  if (!result.meta.changes) throw new ApiError(409, 'ACCOUNT_MISMATCH', '固定收款账号已锁定，不能导入其他账号的会话。');
  await audit(env, env.DEEPSEEK_ACCOUNT_ID ? 'session_connected' : 'session_staged', actor, now);
  return account;
}
async function audit(env, event, actor, now) { await env.DB.prepare('INSERT INTO admin_audit (event,actor,created_at) VALUES (?,?,?)').bind(event, actor, now).run(); }
