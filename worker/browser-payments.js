import { ApiError } from './lib.js';
import { withVerifiedAccountBrowser } from './browser-login.js';
import { paymentDeviceId } from './payment-device.js';
import { paymentVerification } from './payment-verification.js';

// Scoped admin transport: either a one-yuan QR test or polling one existing
// order. A capture scope cannot create orders or query any other order.
export function browserPaymentFetcher(env, credentials, sdk, providerOrderId) {
  if (providerOrderId !== undefined && (typeof providerOrderId !== 'string' || !/^[A-Za-z0-9_-]{6,200}$/.test(providerOrderId))) throw new ApiError(400, 'INVALID_ORDER_ID', '请输入有效的 DeepSeek 订单号。');
  const capturePath = providerOrderId === undefined ? null : `/api/v1/payments/${encodeURIComponent(providerOrderId)}/capture`;
  return async (url, options) => {
    let attempted = false;
    try {
      const body = JSON.parse(options?.body || 'null');
      const info = body?.order_info;
      const permitted = capturePath
        ? url === `https://platform.deepseek.com${capturePath}` && options?.method === 'POST' && options.body === undefined
        : url === 'https://platform.deepseek.com/api/v1/payments' && options?.method === 'POST' && info?.amount === '1' && info.currency === 'CNY' && info.payment_method_type === 'CMB_UNIONPAY' && ['WECHAT', 'ALIPAY'].includes(info.fallback_method_type) && /^[0-9a-f-]{36}$/i.test(info.request_id || '');
      if (!permitted) throw new ApiError(400, 'INVALID_REQUEST', '请求不符合本次固定支付测试或查单范围。');
      return await withVerifiedAccountBrowser(env, credentials, async (page, headers) => {
        if (new URL(page.url()).origin !== 'https://platform.deepseek.com') throw new ApiError(503, 'UPSTREAM_REDIRECT', '官方页面发生跳转，已停止付款码请求。');
        const deviceId = capturePath ? null : await paymentDeviceId(page);
        if (!capturePath) await paymentVerification(page);
        attempted = true;
        const result = await page.evaluate(async ({ headers, body, capturePath }) => {
          if (location.origin !== 'https://platform.deepseek.com') return { wrongOrigin: true };
          const response = await fetch(`https://platform.deepseek.com${capturePath || '/api/v1/payments'}`, { method: 'POST', headers: { ...headers, ...(capturePath ? {} : { 'Content-Type': 'application/json' }) }, ...(capturePath ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(10000) });
          const isJson = response.headers.get('content-type')?.includes('application/json') || false;
          const challenge = response.headers.get('x-amzn-waf-action') || response.headers.get('cf-mitigated');
          const result = { httpStatus: response.status, isJson, ...(challenge === 'challenge' || challenge === 'captcha' ? { challenge } : {}) };
          if (isJson) {
            const data = await response.json(), payment = data?.data?.biz_data;
            const order = payment?.order;
            const filtered = capturePath ? (order ? { order: { id: order.id, payment_order_id: order.payment_order_id, amount: order.amount, currency: order.currency, status: order.status } } : null) : (payment ? { payment_order_id: payment.payment_order_id, amount: payment.amount, currency: payment.currency, url: payment.url, fallback: payment.fallback } : null);
            result.data = { code: data?.code, data: { biz_code: data?.data?.biz_code, biz_data: filtered } };
          }
          return result;
        }, { headers, capturePath, body: capturePath ? null : { order_info: { payment_method_type: 'CMB_UNIONPAY', fallback_method_type: info.fallback_method_type, amount: '1', currency: 'CNY', request_id: info.request_id }, shumei_device_id: deviceId } });
        if (result.wrongOrigin) throw new ApiError(503, 'UPSTREAM_REDIRECT', '官方页面发生跳转，已停止付款码请求。');
        return new Response(result.isJson ? JSON.stringify(result.data) : '', { status: result.httpStatus, headers: { ...(result.isJson ? { 'Content-Type': 'application/json' } : {}), ...(result.challenge ? { 'x-amzn-waf-action': result.challenge } : {}) } });
      }, sdk);
    } catch (error) {
      if (!attempted) error.creationAttempted = false;
      throw error;
    }
  };
}
