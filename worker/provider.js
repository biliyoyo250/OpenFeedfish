import { ApiError, parseAmount } from './lib.js';
import { credentialsFor, accountState } from './vault.js';
const origin = 'https://platform.deepseek.com';
export async function providerReady(env) {
  const state = await accountState(env);
  return !!env.DEEPSEEK_ACCOUNT_ID && state.configured;
}
export async function upstream(path, credentials, body, fetcher = fetch) {
  const headers = { Accept: 'application/json', Origin: origin, Referer: `${origin}/top_up` };
  if (credentials.sessionToken) headers.Authorization = `Bearer ${credentials.sessionToken}`;
  if (credentials.dshToken) headers['x-dsh-auth-token'] = credentials.dshToken;
  const cookie = cookieHeader(credentials.cookies || [], path);
  if (cookie) headers.Cookie = cookie;
  if (credentials.deviceId) headers['x-device-id'] = credentials.deviceId;
  if (credentials.deviceModel) headers['x-device-model'] = credentials.deviceModel;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response, result;
  try {
    response = await fetcher(`${origin}${path}`, { method: path.endsWith('/capture') || body !== undefined ? 'POST' : 'GET', headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(12000) });
    if (!response.headers.get('content-type')?.includes('application/json')) {
      if (response.status === 401) throw new ApiError(503, 'SESSION_EXPIRED', '收款账号登录已失效，请联系收款人。');
      throw new Error();
    }
    result = await response.json();
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(503, 'UPSTREAM_UNAVAILABLE', '收款平台暂不可用，请稍后重试。'); }
  if (response.status === 401 || result.code === 40002 || result.code === 40003) throw new ApiError(503, 'SESSION_EXPIRED', '收款账号登录已失效，请联系收款人。');
  if (!response.ok) throw new ApiError(503, 'UPSTREAM_UNAVAILABLE', '收款平台暂不可用，请稍后重试。');
  if (result.code !== 0 || result.data?.biz_code !== 0) throw new ApiError(502, 'UPSTREAM_REJECTED', '收款平台未接受请求，请管理员检查账号状态。');
  return result.data.biz_data;
}
export function cookieHeader(cookies, path, now = Date.now()) {
  return cookies.filter((cookie) => {
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    const cookiePath = cookie.path || '/';
    return (domain === 'platform.deepseek.com' || domain === 'deepseek.com') &&
      (path === cookiePath || path.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`)) &&
      (!cookie.expires || cookie.expires < 0 || cookie.expires * 1000 > now) &&
      typeof cookie.name === 'string' && /^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(cookie.name) &&
      typeof cookie.value === 'string' && !/[^\x21-\x3A\x3C-\x7E]/.test(cookie.value);
  }).sort((a, b) => (b.path || '/').length - (a.path || '/').length).map(({ name, value }) => `${name}=${value}`).join('; ');
}
export async function inspectAccount(credentials, fetcher = fetch) {
  const user = await upstream('/auth-api/v0/users/current', credentials, undefined, fetcher);
  if (typeof user?.id !== 'string' || !user.id || user.id.length > 200) throw new ApiError(502, 'ACCOUNT_INVALID', '未能核对收款账号。');
  if (user.currency !== 'CNY' || user.is_api_banned === true || user.feature_gates?.PAYMENT === false) throw new ApiError(409, 'ACCOUNT_UNAVAILABLE', '该账号当前不能用于 CNY 充值。');
  return { id: user.id, currency: user.currency };
}
export async function verifyAccount(env, credentials, fetcher = fetch) {
  if (!env.DEEPSEEK_ACCOUNT_ID) throw new ApiError(503, 'ACCOUNT_NOT_CONFIGURED', '请先设置固定的 DEEPSEEK_ACCOUNT_ID。');
  const account = await inspectAccount(credentials, fetcher);
  if (account.id !== env.DEEPSEEK_ACCOUNT_ID) throw new ApiError(409, 'ACCOUNT_MISMATCH', '会话所属账号与固定收款账号不一致。');
  return account;
}
function responseFen(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw new ApiError(502, 'UPSTREAM_AMOUNT_INVALID', '付款金额未能核对，请联系收款人。');
  const normalized = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return parseAmount(normalized);
}
export async function createPayment(env, input, fetcher = fetch) {
  let credentials;
  try { credentials = await credentialsFor(env); await verifyAccount(env, credentials, fetcher); }
  catch (error) { error.creationAttempted = false; throw error; }
  const data = await upstream('/api/v1/payments', credentials, { order_info: { payment_method_type: 'CMB_UNIONPAY', fallback_method_type: input.paymentMethod === 'wechat' ? 'WECHAT' : 'ALIPAY', amount: String(input.amountFen / 100), currency: 'CNY', request_id: input.requestId }, shumei_device_id: credentials.shumeiDeviceId || null }, fetcher);
  if (typeof data?.payment_order_id !== 'string' || !data.payment_order_id || data.payment_order_id.length > 200 || typeof data.url !== 'string' || data.url.length > 4096 || !/^(https:\/\/|weixin:\/\/|alipays:\/\/)/i.test(data.url)) throw new ApiError(502, 'UPSTREAM_ORDER_INVALID', '付款码未能核对，请联系收款人。');
  if (responseFen(data.amount) !== input.amountFen || (data.currency !== undefined && data.currency !== 'CNY')) throw new ApiError(502, 'UPSTREAM_AMOUNT_MISMATCH', '付款金额未能核对，请联系收款人。');
  // For Alipay fallback the official UI opens this URL; retain an explicit link.
  const paymentUrl = data.fallback === true && input.paymentMethod === 'alipay' && data.url.startsWith('https://') ? data.url : null;
  return { providerOrderId: data.payment_order_id, qrCode: data.url, paymentUrl, expiresAt: Date.now() + 900000 };
}
export function mapPaymentResult(data, row) {
  const order = data?.order;
  if (!order || (order.id !== undefined && order.id !== row.provider_order_id) || (order.payment_order_id !== undefined && order.payment_order_id !== row.provider_order_id) || (order.currency !== undefined && order.currency !== 'CNY') || (order.amount !== undefined && responseFen(order.amount) !== row.amount_fen)) throw new ApiError(502, 'UPSTREAM_ORDER_MISMATCH', '订单信息未能核对，请稍后再试。');
  const statuses = { CREATED: 'pending', PENDING: 'pending', SUCCESS: 'paid', FAILED: 'failed', REFUNDED: 'failed', CHARGEBACK: 'failed' };
  if (!statuses[order.status]) throw new ApiError(502, 'UPSTREAM_STATUS_UNKNOWN', '暂时无法确认付款结果。');
  return { status: statuses[order.status], providerStatus: order.status };
}
export async function queryPayment(env, row, fetcher = fetch) {
  const credentials = await credentialsFor(env, true);
  const data = await upstream(`/api/v1/payments/${encodeURIComponent(row.provider_order_id)}/capture`, credentials, undefined, fetcher);
  const result = mapPaymentResult(data, row);
  // The official invoices UI documents paid_at; capture only guarantees status.
  if (result.status === 'paid' && !row.paid_at) {
    try {
      const invoices = await upstream('/auth-api/v0/users/get_all_invoice', credentials, undefined, fetcher);
      const invoice = invoices?.invoices?.payment_orders?.find((item) => item.payment_order_id === row.provider_order_id);
      if (invoice && invoice.currency === 'CNY' && responseFen(invoice.amount) === row.amount_fen && invoice.payment_order_status === 'SUCCESS' && typeof invoice.paid_at === 'string') {
        const time = Date.parse(invoice.paid_at);
        if (Number.isFinite(time) && time >= row.created_at - 300000 && time <= Date.now() + 300000) result.paidAt = time;
      }
    } catch { /* Successful capture remains authoritative; missing paid_at stays null. */ }
  }
  return result;
}
