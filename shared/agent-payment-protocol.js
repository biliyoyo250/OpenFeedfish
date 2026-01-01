import { validAccountId, validCommandId } from './browser-agent-protocol.js';
import { profileSummary } from './account-profile.js';
export const PAYMENT_PROTOCOL = 3;
export const PAYMENT_JOB_TTL = 55000;
export const PAYMENT_RPC_TIMEOUT = 65000;
export const maxPaymentAmount = (protocol) => protocol === 1 ? 100 : [2, PAYMENT_PROTOCOL].includes(protocol) ? 10000000 : 0;
const orderId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{6,200}$/.test(value);
const errors = new Set(['LOGIN_REQUIRED', 'ACCOUNT_NOT_CONFIGURED', 'ACCOUNT_MISMATCH', 'ACCOUNT_INELIGIBLE', 'AUTH_TOKEN_MISSING', 'SESSION_EXPIRED', 'UPSTREAM_NOT_JSON', 'UPSTREAM_UNAVAILABLE', 'UPSTREAM_REDIRECT', 'PAYMENT_DEVICE_UNAVAILABLE', 'PAYMENT_VERIFICATION_REQUIRED', 'JOB_EXPIRED', 'AGENT_OFFLINE', 'AGENT_BUSY', 'AGENT_PROTOCOL', 'AGENT_TIMEOUT', 'AGENT_UPDATE_REQUIRED']);
export function paymentJob(value, accountId) {
  if (!value || value.type !== 'payment-job' || !validCommandId(value.id) || value.accountId !== accountId) throw new Error('INVALID_PAYMENT_JOB');
  const base = { type: 'payment-job', id: value.id, accountId, operation: value.operation, ttlMs: PAYMENT_JOB_TTL };
  if (value.operation === 'profile' && (accountId === null || validAccountId(accountId))) return value.includeProfile === true ? { ...base, includeProfile: true } : base;
  if (!validAccountId(accountId)) throw new Error('INVALID_PAYMENT_JOB');
  if (value.operation === 'create' && validCommandId(value.requestId) && ['wechat', 'alipay'].includes(value.paymentMethod) && Number.isSafeInteger(value.amountFen) && value.amountFen >= 100 && value.amountFen <= maxPaymentAmount(PAYMENT_PROTOCOL) && value.amountFen % 100 === 0) return { ...base, requestId: value.requestId, paymentMethod: value.paymentMethod, amountFen: value.amountFen };
  if (['capture', 'invoice'].includes(value.operation) && orderId(value.providerOrderId)) return { ...base, providerOrderId: value.providerOrderId };
  throw new Error('INVALID_PAYMENT_JOB');
}
const text = (value, max) => typeof value === 'string' && value.length <= max ? value : 'INVALID';
const money = (value) => typeof value === 'string' && /^\d{1,7}(?:\.\d{1,8})?$/.test(value) ? value : 'INVALID';
const currency = (value) => ['CNY', 'USD'].includes(value) ? value : 'INVALID';
const status = (value) => ['CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'REFUNDED', 'CHARGEBACK'].includes(value) ? value : 'UNKNOWN';
const integer = (value) => Number.isSafeInteger(value) ? value : null;

// Apply at both the executing host and the relay. Invalid optional values stay
// invalid rather than disappearing and accidentally bypassing provider checks.
export function paymentJobResult(job, value) {
  const attempted = job.operation === 'create' && value?.creationAttempted !== false;
  if (value?.ok !== true) return { ok: false, code: errors.has(value?.code) ? value.code : 'AGENT_PROTOCOL', creationAttempted: attempted, ...(Number.isInteger(value?.httpStatus) && value.httpStatus >= 200 && value.httpStatus <= 599 ? { httpStatus: value.httpStatus } : {}) };
  if (!Number.isInteger(value.httpStatus) || value.httpStatus < 200 || value.httpStatus > 599 || typeof value.isJson !== 'boolean') return { ok: false, code: 'AGENT_PROTOCOL', creationAttempted: attempted };
  const safe = { ok: true, creationAttempted: attempted, httpStatus: value.httpStatus, isJson: value.isJson, ...(['captcha', 'challenge'].includes(value.challenge) ? { challenge: value.challenge } : {}) };
  if (!value.isJson) return safe;
  const source = value.data?.data?.biz_data;
  let data = null;
  if (source && job.operation === 'profile') {
    if (!validAccountId(source.id) || (job.accountId !== null && source.id !== job.accountId)) return { ok: false, code: 'ACCOUNT_MISMATCH', creationAttempted: false };
    if (source.currency !== 'CNY') return { ok: false, code: 'ACCOUNT_INELIGIBLE', creationAttempted: false };
    const profile = job.includeProfile === true ? profileSummary(source.profile) : null;
    data = { id: source.id, currency: 'CNY', ...(profile ? { profile } : {}) };
  } else if (source && job.operation === 'create') {
    data = { payment_order_id: text(source.payment_order_id, 200), amount: money(source.amount), url: text(source.url, 4096), ...(source.currency !== undefined ? { currency: currency(source.currency) } : {}), ...(typeof source.fallback === 'boolean' ? { fallback: source.fallback } : {}) };
  } else if (source?.order && job.operation === 'capture') {
    const order = source.order;
    data = { order: { status: status(order.status), ...(order.id !== undefined ? { id: text(order.id, 200) } : {}), ...(order.payment_order_id !== undefined ? { payment_order_id: text(order.payment_order_id, 200) } : {}), ...(order.amount !== undefined ? { amount: money(order.amount) } : {}), ...(order.currency !== undefined ? { currency: currency(order.currency) } : {}) } };
  } else if (source && job.operation === 'invoice') {
    const orders = source.invoices?.payment_orders;
    if (!Array.isArray(orders)) return { ok: false, code: 'AGENT_PROTOCOL', creationAttempted: false };
    const invoice = orders.find((item) => item?.payment_order_id === job.providerOrderId);
    data = { invoices: { payment_orders: invoice ? [{ payment_order_id: job.providerOrderId, amount: money(invoice.amount), currency: currency(invoice.currency), payment_order_status: status(invoice.payment_order_status), paid_at: typeof invoice.paid_at === 'string' && invoice.paid_at.length <= 64 && Number.isFinite(Date.parse(invoice.paid_at)) ? invoice.paid_at : null }] : [] } };
  }
  return { ...safe, data: { code: integer(value.data?.code), data: { biz_code: integer(value.data?.data?.biz_code), biz_data: data } } };
}
