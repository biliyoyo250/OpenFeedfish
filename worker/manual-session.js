import { ApiError } from './lib.js';
import { assertNoPendingAuthorization, stagePendingAuthorization, verifyPendingAuthorization } from './pending-authorization.js';

export function credentialsFromInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'INVALID_SESSION', '请提交登录 Cookie 或 Token。');
  const credentials = { deviceId: '', deviceModel: '', shumeiDeviceId: '' };
  if (body.sessionToken !== undefined && typeof body.sessionToken !== 'string') throw new ApiError(400, 'INVALID_SESSION', '登录 Token 格式无效。');
  let token = (body.sessionToken || '').trim();
  if (token.startsWith('{') || token.startsWith('"')) {
    try {
      const stored = JSON.parse(token);
      token = typeof stored === 'string' ? stored : stored && typeof stored.value === 'string' ? stored.value : null;
    } catch { token = null; }
    if (token === null) throw new ApiError(400, 'INVALID_SESSION', 'userToken 内容无效，请复制完整的 userToken 值或 Authorization。');
  }
  token = token.trim().replace(/^Authorization:\s*/i, '').replace(/^Bearer\s+/i, '');
  if (body.sessionToken?.trim() && !token) throw new ApiError(400, 'INVALID_SESSION', 'userToken 为空，请确认官网已经登录。');
  if (token) {
    if (token.length < 20 || token.length > 6000 || /[^\x21-\x7e]/.test(token)) throw new ApiError(400, 'INVALID_SESSION', '请输入有效的网页登录 Token。');
    credentials.sessionToken = token;
  }
  if (body.cookie !== undefined && typeof body.cookie !== 'string') throw new ApiError(400, 'INVALID_COOKIE', 'Cookie 格式无效。');
  if (body.cookie && (body.cookie.length > 6000 || /[\r\n\x00-\x1f\x7f]/.test(body.cookie))) throw new ApiError(400, 'INVALID_COOKIE', '请只粘贴 Cookie 请求头的一行内容。');
  const cookie = (body.cookie || '').trim().replace(/^Cookie:\s*/i, '');
  if (cookie) {
    const names = new Set(); credentials.cookies = [];
    for (const part of cookie.split(';')) {
      if (!part.trim()) continue;
      const at = part.indexOf('=');
      const name = part.slice(0, at).trim(), value = part.slice(at + 1).trim();
      if (at < 1 || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || /[^\x21-\x3a\x3c-\x7e]/.test(value)) throw new ApiError(400, 'INVALID_COOKIE', 'Cookie 格式无效，请复制 Cookie 请求头，不要复制整组请求头或 Set-Cookie。');
      // Authentication imports do not transfer anti-abuse clearance proofs
      // from a user's browser to a different Cloudflare network client.
      if (/^(?:aws-waf-token|cf_clearance|__cf_bm|(?:__)?cf_chl.*)$/i.test(name)) continue;
      if (names.has(name)) throw new ApiError(400, 'INVALID_COOKIE', 'Cookie 包含重复名称，请核对复制内容。');
      names.add(name);
      credentials.cookies.push({ name, value, domain: 'platform.deepseek.com', path: '/', secure: true, expires: -1 });
    }
  }
  for (const name of ['deviceId', 'deviceModel', 'shumeiDeviceId']) {
    if (body[name] !== undefined && (typeof body[name] !== 'string' || body[name].length > 512 || /[\r\n]/.test(body[name]))) throw new ApiError(400, 'INVALID_DEVICE', '设备信息格式无效。');
    credentials[name] = body[name] || '';
  }
  if (!credentials.sessionToken && !credentials.cookies?.length) throw new ApiError(400, 'INVALID_SESSION', '请填写 DeepSeek 登录 Cookie 或 Token，至少一项。');
  // Project known fields only. A pasted document cannot supply the trusted
  // DSH exchange identity binding or change the fixed account.
  return credentials;
}

export async function connectManualSession(env, identity, body, saveSession, fetcher = fetch, now = Date.now()) {
  const credentials = credentialsFromInput(body);
  await assertNoPendingAuthorization(env, now);
  const id = await stagePendingAuthorization(env, identity, credentials, fetcher, now);
  return verifyPendingAuthorization(env, identity, id, saveSession, fetcher, now);
}
