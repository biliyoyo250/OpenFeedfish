import { ApiError } from './lib.js';
import { withVerifiedAccountBrowser } from './browser-login.js';

// An opt-in transport for the admin's fixed one-yuan QR test only. It cannot
// navigate to a caller-supplied URL, query arbitrary paths, or perform payment.
export function browserPaymentFetcher(env, credentials, sdk) {
  return async (url, options) => {
    let attempted = false;
    try {
      const body = JSON.parse(options?.body || 'null');
      const info = body?.order_info;
      if (url !== 'https://platform.deepseek.com/api/v1/payments' || options?.method !== 'POST' || info?.amount !== '1' || info.currency !== 'CNY' || info.payment_method_type !== 'CMB_UNIONPAY' || !['WECHAT', 'ALIPAY'].includes(info.fallback_method_type) || !/^[0-9a-f-]{36}$/i.test(info.request_id || '')) throw new ApiError(400, 'INVALID_REQUEST', '云浏览器仅支持后台固定 1 CNY 测试账单。');
      return await withVerifiedAccountBrowser(env, credentials, async (page, headers) => {
        if (new URL(page.url()).origin !== 'https://platform.deepseek.com') throw new ApiError(503, 'UPSTREAM_REDIRECT', '官方页面发生跳转，已停止付款码请求。');
        attempted = true;
        const result = await page.evaluate(async ({ headers, body }) => {
          if (location.origin !== 'https://platform.deepseek.com') return { wrongOrigin: true };
          const response = await fetch('https://platform.deepseek.com/api/v1/payments', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000) });
          const isJson = response.headers.get('content-type')?.includes('application/json') || false;
          const challenge = response.headers.get('x-amzn-waf-action') || response.headers.get('cf-mitigated');
          const result = { httpStatus: response.status, isJson, ...(challenge === 'challenge' || challenge === 'captcha' ? { challenge } : {}) };
          if (isJson) {
            const data = await response.json(), payment = data?.data?.biz_data;
            result.data = { code: data?.code, data: { biz_code: data?.data?.biz_code, biz_data: payment ? { payment_order_id: payment.payment_order_id, amount: payment.amount, currency: payment.currency, url: payment.url, fallback: payment.fallback } : null } };
          }
          return result;
        }, { headers, body: { order_info: { payment_method_type: 'CMB_UNIONPAY', fallback_method_type: info.fallback_method_type, amount: '1', currency: 'CNY', request_id: info.request_id }, shumei_device_id: credentials.shumeiDeviceId || null } });
        if (result.wrongOrigin) throw new ApiError(503, 'UPSTREAM_REDIRECT', '官方页面发生跳转，已停止付款码请求。');
        return new Response(result.isJson ? JSON.stringify(result.data) : '', { status: result.httpStatus, headers: { ...(result.isJson ? { 'Content-Type': 'application/json' } : {}), ...(result.challenge ? { 'x-amzn-waf-action': result.challenge } : {}) } });
      }, sdk);
    } catch (error) {
      if (!attempted) error.creationAttempted = false;
      throw error;
    }
  };
}
