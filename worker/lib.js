export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function withUpstreamDiagnostic(error, response, result) {
  if (response) error.upstreamStatus = response.status;
  if (Number.isInteger(result?.code)) error.upstreamCode = result.code;
  if (Number.isInteger(result?.data?.biz_code)) error.upstreamBizCode = result.data.biz_code;
  return error;
}
export function parseAmount(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(value)) throw new ApiError(400, 'INVALID_AMOUNT', '请输入有效的人民币金额，最多两位小数。');
  const [yuan, cents = ''] = value.split('.');
  const amount = Number(yuan) * 100 + Number(cents.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount < 100 || amount > 10000000) throw new ApiError(400, 'INVALID_AMOUNT', '金额须为 1.00–100000.00 CNY。');
  return amount;
}
export const formatAmount = (fen) => `${Math.floor(fen / 100)}.${String(fen % 100).padStart(2, '0')}`;
export function validateOrder(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'INVALID_BODY', '提交内容格式不正确。');
  const amountFen = parseAmount(body.amount);
  if (amountFen % 100 !== 0) throw new ApiError(400, 'INVALID_AMOUNT', 'DeepSeek 当前充值仅支持整数元。');
  if (!['wechat', 'alipay'].includes(body.paymentMethod)) throw new ApiError(400, 'INVALID_METHOD', '请选择微信或支付宝。');
  for (const [field, max] of [['nickname', 40], ['message', 300]]) {
    if (body[field] !== undefined && (typeof body[field] !== 'string' || body[field].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body[field]))) throw new ApiError(400, 'INVALID_TEXT', '昵称或留言不符合长度要求。');
  }
  return { amountFen, paymentMethod: body.paymentMethod, nickname: body.nickname?.trim() || '匿名', message: body.message?.trim() || '' };
}
export const isDemo = (request, env) => env.LOCAL_DEMO === 'true' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname);
const encode = new TextEncoder();
const hex = (value) => [...new Uint8Array(value)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const hash = async (value) => hex(await crypto.subtle.digest('SHA-256', encode.encode(value)));
export async function accessToken(id, secret) {
  const key = await crypto.subtle.importKey('raw', encode.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encode.encode(`feedfish-order:${id}`)));
}
export function publicOrder(row) {
  const canScan = row.status === 'pending' && row.expires_at > Date.now();
  return { id: row.id, amount: formatAmount(row.amount_fen), currency: 'CNY', paymentMethod: row.payment_method, status: row.status, paymentState: row.payment_state, qrCode: canScan ? row.qr_code : null, paymentUrl: canScan ? row.payment_url || null : null, expiresAt: new Date(row.expires_at).toISOString() };
}
export function assertOrigin(request, demo) {
  const origin = request.headers.get('Origin');
  if ((origin || !demo) && origin !== new URL(request.url).origin) throw new ApiError(403, 'INVALID_ORIGIN', '请从本站发起请求。');
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new ApiError(403, 'INVALID_ORIGIN', '请从本站发起请求。');
}
export async function readJson(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ApiError(415, 'INVALID_CONTENT_TYPE', '请求格式不正确。');
  if (Number(request.headers.get('content-length')) > 8192) throw new ApiError(413, 'BODY_TOO_LARGE', '提交内容过长。');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'INVALID_BODY', '请求不能为空。');
  const chunks = []; let length = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > 8192) { await reader.cancel(); throw new ApiError(413, 'BODY_TOO_LARGE', '提交内容过长。'); } chunks.push(value); }
  const bytes = new Uint8Array(length); let cursor = 0; for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ApiError(400, 'INVALID_JSON', '请求格式不正确。'); }
}
export async function verifyTurnstile(request, env, token, fetcher = fetch) {
  if (!env.TURNSTILE_SECRET_KEY || typeof token !== 'string' || !token || token.length > 2048) throw new ApiError(403, 'CAPTCHA_REQUIRED', '请完成人机验证。');
  const data = new FormData(); data.set('secret', env.TURNSTILE_SECRET_KEY); data.set('response', token);
  const ip = request.headers.get('CF-Connecting-IP'); if (ip) data.set('remoteip', ip);
  let result;
  try { const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: data, signal: AbortSignal.timeout(8000) }); if (!response.ok) throw new Error(); result = await response.json(); }
  catch { throw new ApiError(503, 'CAPTCHA_UNAVAILABLE', '验证服务暂不可用，请重试。'); }
  if (!result.success || result.action !== 'create_order' || result.hostname !== new URL(request.url).hostname) throw new ApiError(403, 'CAPTCHA_INVALID', '验证已过期或无效，请重新验证。');
}
