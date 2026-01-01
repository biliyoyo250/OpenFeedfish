import { ApiError } from './lib.js';
import { seal, unseal } from './vault.js';

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
