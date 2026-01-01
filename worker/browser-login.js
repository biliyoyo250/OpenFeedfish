import { ApiError } from './lib.js';
import { seal, unseal } from './vault.js';
import { accountFromProfile } from './provider.js';
import { platformClientHeaders } from './platform-client.js';
import { paymentDeviceId } from './payment-device.js';

const origin = 'https://platform.deepseek.com';
const lifetime = 5 * 60 * 1000;
const missing = () => new ApiError(409, 'LOGIN_EXPIRED', '登录窗口已结束，请重新打开。');
const sdkFor = async () => import('@cloudflare/playwright');
const rowFor = (env) => env.DB.prepare('SELECT * FROM account_login WHERE singleton=1').first();
const closed = (env, id) => env.DB.prepare("UPDATE account_login SET state='closed',sealed_session=NULL WHERE singleton=1 AND id=?").bind(id).run();
function available(env) {
  if (!env.BROWSER || env.BROWSER_LOGIN_ENABLED !== 'true') throw new ApiError(503, 'BROWSER_NOT_CONFIGURED', '云端登录已停用，请使用本机授权连接。');
}
function owned(row, identity, id, now) {
  if (!row || row.id !== id || row.owner_sub !== identity.sub || row.state === 'closed' || row.expires_at <= now) throw missing();
}
export async function browserLoginState(env, identity, now = Date.now()) {
  if (!env.BROWSER) return null;
  const row = await rowFor(env);
  return row && row.owner_sub === identity.sub && row.state !== 'closed' && row.expires_at > now ? { id: row.id, expiresAt: new Date(row.expires_at).toISOString() } : null;
}
function safeLiveUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin === 'https://live.browser.run' && url.pathname.startsWith('/ui/') && !url.username && !url.password) return url.href;
  } catch { /* No raw response or capability URL in errors. */ }
  throw new ApiError(503, 'LOGIN_UNAVAILABLE', '暂时无法打开官方登录窗口。');
}
async function pageFor(browser) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  return pages.find((page) => { try { return new URL(page.url()).origin === origin; } catch { return false; } });
}
async function viewFor(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { devtoolsFrontendUrl } = await cdp.send('Cloudflare.getLiveView', { mode: 'tab', expiresInMs: lifetime });
    return safeLiveUrl(devtoolsFrontendUrl);
  } finally { await cdp.detach(); }
}
async function terminate(browser) {
  // A Playwright connect() client disconnects on browser.close(). The CDP
  // Browser.close command terminates the remote instance and its Live View.
  try { const cdp = await browser.newBrowserCDPSession(); await cdp.send('Browser.close'); } catch { /* The connection closes with the browser. */ }
  await browser.close().catch(() => {});
}
async function connect(env, sdk, sessionId) {
  // Use the browser's persistent default context. Contexts created by
  // newContext() are disposed with the Worker connection, killing Live View.
  // This public endpoint form is also used by the SDK's connectOverCDP helper.
  const endpoint = new URL(sdk.endpointURLString(env.BROWSER, { sessionId }));
  endpoint.searchParams.set('persistent', 'true');
  return sdk.connect(endpoint);
}
export async function startBrowserLogin(env, identity, sdk, now = Date.now()) {
  available(env);
  sdk ||= await sdkFor();
  const previous = await rowFor(env);
  if (previous && previous.state !== 'closed' && previous.expires_at > now) {
    if (previous.owner_sub !== identity.sub) throw new ApiError(409, 'LOGIN_BUSY', '另一位管理员正在维护登录会话。');
    if (previous.state !== 'open') throw new ApiError(409, 'LOGIN_BUSY', '登录窗口正在处理，请稍后重试。');
    let browser;
    try {
      const saved = await unseal(previous.sealed_session, env.ACCOUNT_ENCRYPTION_KEY);
      browser = await connect(env, sdk, saved.sessionId);
      const page = await pageFor(browser);
      if (!page) throw missing();
      return { id: previous.id, expiresAt: new Date(previous.expires_at).toISOString(), liveViewUrl: await viewFor(page) };
    } catch (error) {
      if (browser) await terminate(browser);
      await closed(env, previous.id);
      throw error instanceof ApiError ? error : missing();
    } finally { if (browser) await browser.close().catch(() => {}); }
  }
  // Close expired instances before replacing the singleton; concurrent starts
  // still compete for one conditional database claim.
  await cleanupBrowserLogin(env, sdk, now);
  const id = crypto.randomUUID(); const expiresAt = now + lifetime;
  const claim = await env.DB.prepare("INSERT INTO account_login (singleton,id,owner_sub,state,created_at,expires_at) VALUES (1,?,?,'starting',?,?) ON CONFLICT(singleton) DO UPDATE SET id=excluded.id,owner_sub=excluded.owner_sub,state=excluded.state,sealed_session=NULL,created_at=excluded.created_at,expires_at=excluded.expires_at WHERE account_login.state='closed'").bind(id, identity.sub, now, expiresAt).run();
  if (!claim.meta.changes) throw new ApiError(409, 'LOGIN_BUSY', '登录窗口正在处理，请稍后重试。');
  let browser;
  try {
    const { sessionId } = await sdk.acquire(env.BROWSER, { keep_alive: lifetime, recording: false });
    browser = await connect(env, sdk, sessionId);
    const context = browser.contexts()[0];
    if (!context) throw new ApiError(503, 'LOGIN_UNAVAILABLE', '登录窗口暂不可用，请稍后重试。');
    const page = await context.newPage();
    await page.goto(`${origin}/sign_in`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const liveViewUrl = await viewFor(page);
    const sealed = await seal({ sessionId }, env.ACCOUNT_ENCRYPTION_KEY);
    const saved = await env.DB.prepare("UPDATE account_login SET state='open',sealed_session=? WHERE singleton=1 AND id=? AND state='starting' AND expires_at>?").bind(sealed, id, Date.now()).run();
    if (!saved.meta.changes) throw missing();
    return { id, expiresAt: new Date(expiresAt).toISOString(), liveViewUrl };
  } catch (error) {
    if (browser) await terminate(browser);
    await closed(env, id);
    throw error instanceof ApiError ? error : new ApiError(503, 'LOGIN_UNAVAILABLE', '登录窗口暂不可用，请稍后重试；也可检查 Cloudflare 浏览器额度。');
  } finally { if (browser) await browser.close().catch(() => {}); }
}

export function credentialsFromBrowser(headers, cookies) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const credentials = { deviceId: normalized['x-device-id'] || '', deviceModel: normalized['x-device-model'] || '', shumeiDeviceId: '' };
  if (normalized.authorization?.startsWith('Bearer ')) credentials.sessionToken = normalized.authorization.slice(7);
  if (normalized['x-dsh-auth-token']) credentials.dshToken = normalized['x-dsh-auth-token'];
  // Persist only cookies applicable to the fixed upstream host, never Google,
  // Cloudflare Access, or another origin used during an identity-provider login.
  credentials.cookies = cookies.filter((cookie) => {
    const domain = cookie.domain.replace(/^\./, '').toLowerCase();
    return domain === 'platform.deepseek.com' || domain === 'deepseek.com';
  }).map(({ name, value, domain, path, secure, expires }) => ({ name, value, domain, path, secure, expires }));
  if (!credentials.sessionToken && !credentials.dshToken && !credentials.cookies.length) throw new ApiError(409, 'LOGIN_PENDING', '尚未取得有效登录会话，请在官方窗口完成登录后再保存。');
  return credentials;
}
export async function browserLoginDiagnostics(env, identity, sdk) {
  available(env);
  const row = await rowFor(env);
  if (!row || row.owner_sub !== identity.sub || !row.sealed_session) return { state: 'unavailable', active: false };
  const saved = await unseal(row.sealed_session, env.ACCOUNT_ENCRYPTION_KEY);
  sdk ||= await sdkFor();
  const active = (await sdk.sessions(env.BROWSER)).some((session) => session.sessionId === saved.sessionId);
  const result = { state: row.state, active, createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() };
  if (!active) {
    const previous = (await sdk.history(env.BROWSER)).find((session) => session.sessionId === saved.sessionId);
    result.closeReason = previous?.closeReasonText || 'Unavailable';
    result.closedAt = previous?.endTime ? new Date(previous.endTime).toISOString() : null;
  }
  return result;
}
export async function completeBrowserLogin(env, identity, id, saveSession, sdk, now = Date.now()) {
  available(env);
  const row = await rowFor(env); owned(row, identity, id, now);
  if (row.state !== 'open') throw new ApiError(409, 'LOGIN_BUSY', '登录会话正在保存，请稍后重试。');
  const claim = await env.DB.prepare("UPDATE account_login SET state='saving' WHERE singleton=1 AND id=? AND state='open' AND expires_at>?").bind(id, now).run();
  if (!claim.meta.changes) throw missing();
  let browser, saved = false;
  try {
    sdk ||= await sdkFor();
    const session = await unseal(row.sealed_session, env.ACCOUNT_ENCRYPTION_KEY);
    browser = await connect(env, sdk, session.sessionId);
    const page = await pageFor(browser); if (!page) throw missing();
    const responsePromise = page.waitForResponse((response) => response.url() === `${origin}/auth-api/v0/users/current` && response.request().method() === 'GET', { timeout: 15000 });
    // Attach the rejection handler before navigation to avoid an unhandled
    // timeout when navigation itself fails.
    const observed = responsePromise.then((value) => ({ value }), () => ({ value: null }));
    await page.goto(`${origin}/top_up`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const { value: response } = await observed;
    if (!response || !response.ok()) throw new ApiError(409, 'LOGIN_PENDING', '请先在官方登录窗口完成登录和验证，再保存会话。');
    const result = await response.json();
    if (result.code !== 0 || result.data?.biz_code !== 0 || !result.data.biz_data?.id) throw new ApiError(409, 'LOGIN_PENDING', '官方平台尚未确认登录，请完成登录后重试。');
    const credentials = credentialsFromBrowser(await response.request().allHeaders(), await page.context().cookies());
    owned(await rowFor(env), identity, id, Date.now());
    // The existing account importer independently verifies these credentials
    // from the Worker, checks CNY and atomically enforces the fixed account.
    const account = await saveSession(credentials);
    saved = true;
    return account;
  } catch (error) {
    if (error.code === 'ACCOUNT_MISMATCH' || error.code === 'LOGIN_EXPIRED') saved = true;
    throw error instanceof ApiError ? error : new ApiError(503, 'LOGIN_UNAVAILABLE', '暂未完成会话保存，请确认官方窗口已登录后重试。');
  } finally {
    if (saved) {
      if (browser) await terminate(browser);
      await closed(env, id);
    } else {
      await env.DB.prepare("UPDATE account_login SET state='open' WHERE singleton=1 AND id=? AND state='saving'").bind(id).run();
    }
    if (browser) await browser.close().catch(() => {});
  }
}
export async function cancelBrowserLogin(env, identity, id, sdk, now = Date.now()) {
  available(env);
  const row = await rowFor(env); owned(row, identity, id, now);
  if (row.state === 'saving' || row.state === 'starting') throw new ApiError(409, 'LOGIN_BUSY', '登录窗口正在处理，请稍后重试。');
  const claim = await env.DB.prepare("UPDATE account_login SET state='closed' WHERE singleton=1 AND id=? AND state='open'").bind(id).run();
  if (!claim.meta.changes) throw new ApiError(409, 'LOGIN_BUSY', '登录窗口正在处理，请稍后重试。');
  await closeRow(env, row, sdk);
}
async function closeRow(env, row, sdk) {
  try {
    if (row.sealed_session && env.BROWSER) {
      sdk ||= await sdkFor();
      const saved = await unseal(row.sealed_session, env.ACCOUNT_ENCRYPTION_KEY);
      const browser = await connect(env, sdk, saved.sessionId);
      await terminate(browser);
    }
  } catch { /* Expired sessions may already have been closed by Cloudflare. */ }
  finally { await closed(env, row.id); }
}
export async function cleanupBrowserLogin(env, sdk, now = Date.now()) {
  if (!env.BROWSER) return;
  const row = await rowFor(env);
  if (row && row.state !== 'closed' && row.expires_at <= now) await closeRow(env, row, sdk);
}
export async function browserResourceStatus(env, sdk) {
  if (!env.BROWSER) return { mode: 'resources', configured: false };
  try {
    sdk ||= await sdkFor();
    const limits = await sdk.limits(env.BROWSER);
    const count = (value) => Number.isFinite(value) && value >= 0 ? value : null;
    // Return counts only. Session IDs and connection capabilities stay private.
    return {
      mode: 'resources', configured: true,
      activeSessions: Array.isArray(limits.activeSessions) ? limits.activeSessions.length : null,
      maxConcurrentSessions: count(limits.maxConcurrentSessions),
      allowedBrowserAcquisitions: count(limits.allowedBrowserAcquisitions),
      timeUntilNextAllowedBrowserAcquisition: count(limits.timeUntilNextAllowedBrowserAcquisition),
    };
  } catch {
    return { mode: 'resources', configured: true, code: 'BROWSER_RESOURCES_UNAVAILABLE' };
  }
}
export async function anonymousBrowserConnectivity(env) {
  let browser;
  try {
    if (!env.BROWSER) return { mode: 'browser', reachable: false, code: 'BROWSER_NOT_CONFIGURED' };
    const sdk = await sdkFor();
    const { sessionId } = await sdk.acquire(env.BROWSER, { keep_alive: 10000, recording: false });
    browser = await connect(env, sdk, sessionId);
    const page = await browser.contexts()[0].newPage();
    await page.goto(`${origin}/sign_in`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const result = await page.evaluate(async () => {
      const response = await fetch('/auth-api/v0/users/current', { headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
      const isJson = response.headers.get('content-type')?.includes('application/json') || false;
      let code = null;
      if (isJson) { const data = await response.json(); if (Number.isInteger(data.code)) code = data.code; }
      return { httpStatus: response.status, isJson, code };
    });
    return { mode: 'browser', reachable: true, ...result };
  } catch (error) {
    const message = String(error.message);
    const code = /Browser time limit exceeded|daily.*(?:limit|quota)/i.test(message) ? 'BROWSER_QUOTA' : /429/.test(message) ? 'BROWSER_RATE_LIMIT' : 'BROWSER_UNAVAILABLE';
    return { mode: 'browser', reachable: false, code };
  }
  finally { if (browser) await terminate(browser); }
}

// Access-protected, read-only check of an existing PKCE grant. Authentication
// headers belong only to the fixed account fetch, never to page navigation or
// third-party assets. No login, CAPTCHA solving, or payment happens here.
export async function verifyAccountInBrowser(env, credentials, sdk, paymentContext = false) {
  return withVerifiedAccountBrowser(env, credentials, paymentContext ? async (page, _headers, account) => { await paymentDeviceId(page); return account; } : undefined, sdk);
}
// Callers are server-side, fixed-operation adapters; this is never a remote
// evaluation or arbitrary-URL API exposed to the management client.
export async function withVerifiedAccountBrowser(env, credentials, operation, sdk) {
  if (!env.BROWSER || !env.DEEPSEEK_ACCOUNT_ID) throw new ApiError(503, 'BROWSER_NOT_CONFIGURED', '请先配置云浏览器和固定账户。');
  if (typeof credentials.dshToken !== 'string' || !credentials.dshToken) throw new ApiError(409, 'BROWSER_GRANT_REQUIRED', '此检查需要已保存的官方授权。');
  sdk ||= await sdkFor();
  let browser, sessionId;
  try {
    const limits = await sdk.limits(env.BROWSER);
    if (!(limits.allowedBrowserAcquisitions > 0) || limits.timeUntilNextAllowedBrowserAcquisition > 0 || limits.activeSessions?.length >= limits.maxConcurrentSessions) throw new ApiError(503, 'BROWSER_BUSY', '云浏览器资源暂不可用，请稍后再核验。');
    ({ sessionId } = await sdk.acquire(env.BROWSER, { keep_alive: 10000, recording: false }));
    browser = await connect(env, sdk, sessionId);
    const page = await browser.contexts()[0].newPage();
    await page.goto(`${origin}/sign_in`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (new URL(page.url()).origin !== origin) throw new ApiError(503, 'UPSTREAM_REDIRECT', '官方页面发生跳转，已停止传递账户凭证。');
    const headers = { Accept: 'application/json', ...platformClientHeaders, 'x-dsh-auth-token': credentials.dshToken, ...(credentials.deviceId ? { 'x-device-id': credentials.deviceId } : {}), ...(credentials.deviceModel ? { 'x-device-model': credentials.deviceModel } : {}) };
    const result = await page.evaluate(async (headers) => {
      if (location.origin !== 'https://platform.deepseek.com') return { wrongOrigin: true };
      const response = await fetch('https://platform.deepseek.com/auth-api/v0/users/current', { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
      const isJson = response.headers.get('content-type')?.includes('application/json') || false;
      const challenge = response.headers.get('x-amzn-waf-action') || response.headers.get('cf-mitigated');
      const result = { httpStatus: response.status, isJson, ...(challenge === 'challenge' || challenge === 'captcha' ? { challenge } : {}) };
      if (!isJson) return result;
      const data = await response.json();
      if (Number.isSafeInteger(data?.code)) result.code = data.code;
      if (Number.isSafeInteger(data?.data?.biz_code)) result.bizCode = data.data.biz_code;
      const user = data?.data?.biz_data;
      if (data?.code === 0 && data?.data?.biz_code === 0 && user) result.user = { id: user.id, currency: user.currency, is_api_banned: user.is_api_banned, feature_gates: { PAYMENT: user.feature_gates?.PAYMENT } };
      return result;
    }, headers);
    const diagnostic = (error) => {
      if (Number.isInteger(result.httpStatus)) error.upstreamStatus = result.httpStatus;
      if (Number.isSafeInteger(result.code)) error.upstreamCode = result.code;
      if (Number.isSafeInteger(result.bizCode)) error.upstreamBizCode = result.bizCode;
      if (['captcha', 'challenge'].includes(result.challenge)) error.upstreamChallenge = result.challenge;
      return error;
    };
    if (result.wrongOrigin) throw new ApiError(503, 'UPSTREAM_REDIRECT', '官方页面发生跳转，已停止账户请求。');
    if (result.httpStatus === 401 || result.code === 40002 || result.code === 40003) throw diagnostic(new ApiError(503, 'SESSION_EXPIRED', 'DeepSeek 未接受保存的账户授权。'));
    if (!result.isJson) throw diagnostic(new ApiError(503, 'UPSTREAM_NOT_JSON', '云浏览器未取得 JSON；请管理员检查官方页面是否要求人机验证。'));
    if (result.httpStatus < 200 || result.httpStatus >= 300 || result.code !== 0 || result.bizCode !== 0) throw diagnostic(new ApiError(503, 'UPSTREAM_REJECTED', 'DeepSeek 未接受云浏览器中的账户请求。'));
    const account = accountFromProfile(result.user);
    if (account.id !== env.DEEPSEEK_ACCOUNT_ID) throw new ApiError(409, 'ACCOUNT_MISMATCH', '授权账户与固定收款账户不一致。');
    return operation ? await operation(page, headers, account) : account;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, /429/.test(String(error?.message)) ? 'BROWSER_RATE_LIMIT' : 'BROWSER_UNAVAILABLE', '云浏览器账户核验暂不可用，请稍后再检查。');
  } finally {
    // If connecting failed after acquisition, retry only the connection for
    // cleanup, never acquire another instance. The idle fuse is ten seconds.
    if (!browser && sessionId) { try { browser = await connect(env, sdk, sessionId); } catch { /* Backend idle expiry remains the final fuse. */ } }
    if (browser) await terminate(browser);
  }
}
