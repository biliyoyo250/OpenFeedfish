import { ApiError } from './lib.js';
const encoder = new TextEncoder();
const context = encoder.encode('feedfish:deepseek-session:v1');
const base64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
function decode(value) { try { return Uint8Array.from(atob(value), (c) => c.charCodeAt(0)); } catch { throw new ApiError(503, 'VAULT_UNAVAILABLE', '账号保险库配置无效。'); } }
async function keyFor(secret) {
  const key = decode(secret || '');
  if (key.length !== 32) throw new ApiError(503, 'VAULT_UNAVAILABLE', '请先配置账号保险库密钥。');
  return crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(credentials, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context }, await keyFor(secret), encoder.encode(JSON.stringify(credentials)));
  return JSON.stringify({ v: 1, iv: base64(iv), data: base64(ciphertext) });
}
export async function unseal(value, secret) {
  try {
    const { v, iv, data } = JSON.parse(value); if (v !== 1) throw new Error();
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData: context }, await keyFor(secret), decode(data));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { throw new ApiError(503, 'VAULT_UNAVAILABLE', '无法读取账号凭证，请管理员重新连接。'); }
}
export async function accountState(env) {
  const row = env.DB ? await env.DB.prepare('SELECT account_id,status,updated_at,last_checked_at FROM account_session WHERE singleton=1').first() : null;
  if (row) return { configured: !!env.DEEPSEEK_ACCOUNT_ID && row.account_id === env.DEEPSEEK_ACCOUNT_ID && row.status === 'connected', source: 'vault', accountId: row.account_id, status: row.status, updatedAt: new Date(row.updated_at).toISOString(), lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null };
  return { configured: !!env.DEEPSEEK_ACCOUNT_ID && !!env.DEEPSEEK_SESSION_TOKEN, source: 'secret', accountId: env.DEEPSEEK_ACCOUNT_ID || null, status: env.DEEPSEEK_SESSION_TOKEN ? 'unverified' : 'not_configured', updatedAt: null, lastCheckedAt: null };
}
export async function credentialsFor(env, allowDisabled = false) {
  if (!env.DEEPSEEK_ACCOUNT_ID) throw new ApiError(503, 'ACCOUNT_NOT_CONFIGURED', '请管理员连接固定收款账号。');
  const row = env.DB ? await env.DB.prepare('SELECT * FROM account_session WHERE singleton=1').first() : null;
  if (row) {
    if (!(row.status === 'connected' || (allowDisabled && row.status === 'disabled')) || row.account_id !== env.DEEPSEEK_ACCOUNT_ID || !row.sealed_credentials) throw new ApiError(503, 'ACCOUNT_UNAVAILABLE', '收款账号暂不可用，请稍后再试。');
    return unseal(row.sealed_credentials, env.ACCOUNT_ENCRYPTION_KEY);
  }
  if (env.DEEPSEEK_SESSION_TOKEN) return { sessionToken: env.DEEPSEEK_SESSION_TOKEN, deviceId: env.DEEPSEEK_DEVICE_ID || '', deviceModel: env.DEEPSEEK_DEVICE_MODEL || '', shumeiDeviceId: env.DEEPSEEK_SHUMEI_DEVICE_ID || '' };
  throw new ApiError(503, 'ACCOUNT_NOT_CONFIGURED', '收款账号暂未连接。');
}
