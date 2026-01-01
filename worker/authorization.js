import { ApiError } from './lib.js';
import { seal, unseal } from './vault.js';

const origin = 'https://platform.deepseek.com';
const lifetime = 600000;
export const platformClientHeaders = { 'x-client-bundle-id': '', 'x-client-platform': 'web', 'x-client-version': '0.1.0', 'x-client-locale': 'zh_CN', 'x-client-timezone-offset': '28800' };
const rowFor = (env) => env.DB.prepare('SELECT * FROM account_authorization WHERE singleton=1').first();
const closed = (env, id) => env.DB.prepare("UPDATE account_authorization SET state='closed',sealed_flow=NULL WHERE singleton=1 AND id=?").bind(id).run();
const expired = () => new ApiError(409, 'AUTH_EXPIRED', '本次授权已结束，请重新运行本机连接助手。');
const busy = () => new ApiError(409, 'AUTH_BUSY', '账户授权正在处理，请稍后重试。');
const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function authorizeUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin === origin && url.pathname === '/dsh/authorize' && !url.username && !url.password && !url.hash) return url.href;
  } catch { /* Do not expose an upstream URL or response. */ }
  throw new ApiError(502, 'AUTH_PROTOCOL', '官方授权响应格式不正确。');
}
async function authRequest(method, body, fetcher) {
  let response, data;
  try {
    response = await fetcher(`${origin}/auth-api/v0/dsh/${method}`, { method: 'POST', headers: { ...platformClientHeaders, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(12000) });
  } catch { throw new ApiError(503, 'AUTH_NETWORK', 'Cloudflare 暂未连通 DeepSeek 授权接口。'); }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    const challenge = response.headers.get('x-amzn-waf-action');
    if (challenge === 'captcha' || challenge === 'challenge') throw new ApiError(503, 'AUTH_CHALLENGE', `DeepSeek 要求验证 Cloudflare 出站请求（HTTP ${response.status}）。`);
    throw new ApiError(503, 'AUTH_NOT_JSON', `DeepSeek 授权接口未返回 JSON（HTTP ${response.status}）。`);
  }
  try {
    const text = await response.text();
    if (text.length > 131072) throw new Error();
    data = JSON.parse(text);
  } catch { throw new ApiError(502, 'AUTH_PROTOCOL', 'DeepSeek 授权响应格式不正确。'); }
  if (!response.ok || data.code !== 0 || data.data?.biz_code !== 0) throw new ApiError(502, 'AUTH_REJECTED', 'DeepSeek 未完成这次授权，请重新连接。');
  return data.data.biz_data;
}
async function cancelFlow(flow, fetcher) {
  if (flow?.kind === 'dsh' && flow.authorizeId && flow.verifier) await authRequest('auth_cancel', { authorize_id: flow.authorizeId, code_verifier: flow.verifier }, fetcher).catch(() => {});
}
export async function authorizationState(env, identity, now = Date.now()) {
  const row = await rowFor(env);
  if (!row || row.owner_sub !== identity.sub || row.state !== 'open' || row.expires_at <= now || !row.sealed_flow) return null;
  const flow = await unseal(row.sealed_flow, env.ACCOUNT_ENCRYPTION_KEY);
  if (flow.kind !== 'dsh') return null;
  return { id: row.id, expiresAt: new Date(row.expires_at).toISOString(), authorizeUrl: authorizeUrl(flow.authorizeUrl) };
}
export async function startAuthorization(env, identity, input, fetcher = fetch, now = Date.now()) {
  if (!Number.isInteger(input.callbackPort) || input.callbackPort < 1024 || input.callbackPort > 65535 || typeof input.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.state)) throw new ApiError(400, 'INVALID_AUTH', '请从可信设备上的本机连接助手发起授权。');
  const redirectUri = `http://127.0.0.1:${input.callbackPort}/oauth/callback`;
  const previous = await rowFor(env);
  if (previous && previous.state !== 'closed') {
    if (previous.expires_at > now && (previous.owner_sub !== identity.sub || previous.state !== 'open')) throw busy();
    if (previous.sealed_flow) {
      const flow = await unseal(previous.sealed_flow, env.ACCOUNT_ENCRYPTION_KEY);
      if (previous.expires_at > now && flow.kind === 'dsh' && flow.state === input.state && flow.redirectUri === redirectUri) return authorizationState(env, identity, now);
      await cancelFlow(flow, fetcher);
    }
    await closed(env, previous.id);
  }
  const id = crypto.randomUUID();
  const claim = await env.DB.prepare("INSERT INTO account_authorization (singleton,id,owner_sub,state,created_at,expires_at) VALUES (1,?,?,'starting',?,?) ON CONFLICT(singleton) DO UPDATE SET id=excluded.id,owner_sub=excluded.owner_sub,state='starting',sealed_flow=NULL,created_at=excluded.created_at,expires_at=excluded.expires_at WHERE account_authorization.state='closed'").bind(id, identity.sub, now, now + lifetime).run();
  if (!claim.meta.changes) throw busy();
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  let flow;
  try {
    const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const data = await authRequest('auth_init', { code_challenge: challenge, code_challenge_method: 'S256', state: input.state, redirect_uri: redirectUri, locale: 'zh_CN', login_source: 'web' }, fetcher);
    if (typeof data?.authorize_id !== 'string' || !data.authorize_id || typeof data.expires_in !== 'number' || data.expires_in <= 0) throw new ApiError(502, 'AUTH_PROTOCOL', '官方授权响应格式不正确。');
    flow = { kind: 'dsh', verifier, state: input.state, redirectUri, authorizeId: data.authorize_id, authorizeUrl: authorizeUrl(data.authorize_url), deviceId: crypto.randomUUID() };
    const expiresAt = Math.min(now + lifetime, Date.now() + data.expires_in * 1000);
    const sealed = await seal(flow, env.ACCOUNT_ENCRYPTION_KEY);
    const saved = await env.DB.prepare("UPDATE account_authorization SET state='open',sealed_flow=?,expires_at=? WHERE singleton=1 AND id=? AND state='starting' AND expires_at>?").bind(sealed, expiresAt, id, Date.now()).run();
    if (!saved.meta.changes) throw expired();
    return { id, expiresAt: new Date(expiresAt).toISOString(), authorizeUrl: flow.authorizeUrl };
  } catch (error) {
    await cancelFlow(flow, fetcher); await closed(env, id);
    throw error;
  }
}
export async function completeAuthorization(env, identity, input, saveSession, fetcher = fetch, now = Date.now()) {
  if (typeof input.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.state) || typeof input.code !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(input.code)) throw new ApiError(400, 'INVALID_AUTH', '授权回传无效，请重新连接。');
  const row = await rowFor(env);
  if (!row || row.owner_sub !== identity.sub || row.expires_at <= now || row.state === 'closed' || !row.sealed_flow) throw expired();
  if (row.state !== 'open') throw busy();
  const flow = await unseal(row.sealed_flow, env.ACCOUNT_ENCRYPTION_KEY);
  if (flow.kind !== 'dsh' || flow.state !== input.state) throw expired();
  const claim = await env.DB.prepare("UPDATE account_authorization SET state='saving' WHERE singleton=1 AND id=? AND state='open' AND expires_at>?").bind(row.id, now).run();
  if (!claim.meta.changes) throw busy();
  let token;
  try {
    const data = await authRequest('auth_exchange', { code: input.code, code_verifier: flow.verifier, redirect_uri: flow.redirectUri, device_id: flow.deviceId, device_model: 'feedfish-worker', os_version: 'Cloudflare Workers' }, fetcher);
    if (typeof data?.token !== 'string' || !/^[\x21-\x7e]{20,6000}$/.test(data.token)) throw new ApiError(502, 'AUTH_PROTOCOL', '官方授权响应格式不正确。');
    token = data.token;
    if (Date.now() >= row.expires_at) throw expired();
    return await saveSession({ dshToken: token, deviceId: '', deviceModel: '', shumeiDeviceId: '' });
  } catch (error) {
    // Only the newly issued grant is used here; never read an existing session.
    if (token) await fetcher(`${origin}/auth-api/v0/users/logout`, { method: 'POST', headers: { ...platformClientHeaders, 'x-dsh-auth-token': token }, redirect: 'error', signal: AbortSignal.timeout(10000) }).catch(() => {});
    throw error;
  } finally { await closed(env, row.id); }
}
export async function cancelAuthorization(env, identity, fetcher = fetch, now = Date.now()) {
  const row = await rowFor(env);
  if (!row || row.owner_sub !== identity.sub || row.state === 'closed') throw expired();
  if (row.state === 'saving' || row.state === 'starting') throw busy();
  const claim = await env.DB.prepare("UPDATE account_authorization SET state='closed',sealed_flow=NULL WHERE singleton=1 AND id=? AND state='open'").bind(row.id).run();
  if (!claim.meta.changes) throw busy();
  if (row.sealed_flow) await cancelFlow(await unseal(row.sealed_flow, env.ACCOUNT_ENCRYPTION_KEY), fetcher);
}
export async function cleanupAuthorization(env, fetcher = fetch, now = Date.now()) {
  const row = await rowFor(env);
  if (!row || row.state === 'closed' || row.expires_at > now) return;
  const claim = await env.DB.prepare("UPDATE account_authorization SET state='closed',sealed_flow=NULL WHERE singleton=1 AND id=? AND expires_at<=?").bind(row.id, now).run();
  if (claim.meta.changes && row.sealed_flow) await cancelFlow(await unseal(row.sealed_flow, env.ACCOUNT_ENCRYPTION_KEY), fetcher);
}
// A fixed anonymous request: no account data, caller headers, cookies, code or
// verifier can enter this diagnostic or its exception message.
export async function authorizationConnectivity(fetcher = fetch, mode = 'anonymous') {
  try {
    const headers = { Accept: 'application/json', ...(mode === 'client' ? platformClientHeaders : {}), ...(mode === 'dsh' ? { 'x-dsh-auth-token': 'feedfish-format-probe-not-a-credential' } : {}) };
    const response = await fetcher(`${origin}/auth-api/v0/users/current`, { headers, redirect: 'manual', signal: AbortSignal.timeout(12000) });
    const isJson = response.headers.get('content-type')?.includes('application/json') || false;
    let code = null;
    if (isJson) { const value = await response.json(); if (Number.isInteger(value.code)) code = value.code; }
    return { mode, reachable: true, httpStatus: response.status, isJson, code };
  } catch (error) { return { mode, reachable: false, errorType: String(error.name).slice(0,50), message: String(error.message).slice(0,240) }; }
}
