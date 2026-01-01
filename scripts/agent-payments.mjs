import { paymentJob, paymentJobResult, PAYMENT_JOB_TTL } from '../shared/agent-payment-protocol.js';
import { paymentDeviceId } from '../worker/payment-device.js';
import { paymentVerification } from '../worker/payment-verification.js';
const origin = 'https://platform.deepseek.com';

export async function executePaymentJob(page, value, { accountId, checkAccount, active, receivedAt = Date.now(), device = paymentDeviceId, verification = paymentVerification }) {
  const job = paymentJob(value, accountId); let attempted = false;
  const deadline = receivedAt + PAYMENT_JOB_TTL;
  const assertActive = (reserve = 0) => { if (!active() || Date.now() + reserve >= deadline) throw Object.assign(new Error(), { code: 'JOB_EXPIRED' }); };
  try {
    assertActive();
    if (new URL(page.url()).origin !== origin) throw Object.assign(new Error(), { code: 'LOGIN_REQUIRED' });
    if (job.operation === 'create' && new URL(page.url()).pathname !== '/top_up') await page.goto(`${origin}/top_up`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const account = await checkAccount();
    if (!account.ok) return paymentJobResult(job, { ok: false, code: account.code, httpStatus: account.httpStatus, creationAttempted: false });
    if (account.accountId !== accountId || account.currency !== 'CNY' || account.eligible !== true) return paymentJobResult(job, { ok: false, code: account.accountId !== accountId ? 'ACCOUNT_MISMATCH' : 'ACCOUNT_INELIGIBLE', creationAttempted: false });
    if (job.operation === 'profile') return paymentJobResult(job, { ok: true, httpStatus: 200, isJson: true, creationAttempted: false, data: { code: 0, data: { biz_code: 0, biz_data: { id: accountId, currency: 'CNY' } } } });
    const deviceId = job.operation === 'create' ? await device(page) : null;
    if (job.operation === 'create') await verification(page);
    assertActive(11000);
    attempted = job.operation === 'create';
    const response = await page.evaluate(async ({ job, deviceId }) => {
      if (location.origin !== 'https://platform.deepseek.com') return { wrongOrigin: true };
      let token;
      try {
        const raw = localStorage.getItem('userToken');
        try { const value = JSON.parse(raw); token = typeof value === 'string' ? value : value?.value; } catch { token = raw; }
        if (typeof token !== 'string' || !token || token.length > 6000 || /[\r\n\x00]/.test(token)) return { noToken: true };
        const path = job.operation === 'create' ? '/api/v1/payments' : job.operation === 'capture' ? `/api/v1/payments/${encodeURIComponent(job.providerOrderId)}/capture` : '/auth-api/v0/users/get_all_invoice';
        const body = job.operation === 'create' ? { order_info: { payment_method_type: 'CMB_UNIONPAY', fallback_method_type: job.paymentMethod === 'wechat' ? 'WECHAT' : 'ALIPAY', amount: '1', currency: 'CNY', request_id: job.requestId }, shumei_device_id: deviceId } : undefined;
        const response = await fetch(path, { method: job.operation === 'invoice' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(10000) });
        const isJson = response.headers.get('content-type')?.includes('application/json') === true;
        const challenge = response.headers.get('x-amzn-waf-action') || response.headers.get('cf-mitigated');
        const result = { httpStatus: response.status, isJson, ...(['captcha', 'challenge'].includes(challenge) ? { challenge } : {}) };
        if (isJson) {
          const rawData = await response.json(); const source = rawData?.data?.biz_data;
          const pick = (item, fields) => item ? Object.fromEntries(fields.filter((key) => item[key] !== undefined).map((key) => [key, ['string', 'number', 'boolean'].includes(typeof item[key]) ? item[key] : null])) : null;
          let data = null;
          if (job.operation === 'create') data = pick(source, ['payment_order_id', 'amount', 'currency', 'url', 'fallback']);
          if (job.operation === 'capture') data = source?.order ? { order: pick(source.order, ['id', 'payment_order_id', 'amount', 'currency', 'status']) } : null;
          if (job.operation === 'invoice') { const invoice = source?.invoices?.payment_orders?.find((item) => item.payment_order_id === job.providerOrderId); data = { invoices: { payment_orders: invoice ? [pick(invoice, ['payment_order_id', 'amount', 'currency', 'payment_order_status', 'paid_at'])] : [] } }; }
          result.data = { code: Number.isSafeInteger(rawData?.code) ? rawData.code : null, data: { biz_code: Number.isSafeInteger(rawData?.data?.biz_code) ? rawData.data.biz_code : null, biz_data: data } };
        }
        return result;
      } finally { token = undefined; }
    }, { job, deviceId });
    if (response.wrongOrigin || response.noToken) return paymentJobResult(job, { ok: false, code: response.wrongOrigin ? 'UPSTREAM_REDIRECT' : 'LOGIN_REQUIRED', creationAttempted: false });
    return paymentJobResult(job, { ...response, ok: true, creationAttempted: attempted });
  } catch (error) { return paymentJobResult(job, { ok: false, code: error.code || 'UPSTREAM_UNAVAILABLE', creationAttempted: attempted }); }
}
