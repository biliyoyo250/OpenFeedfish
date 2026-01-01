import { ApiError } from './lib.js';

// Match the public platform's SDK initialization. The SDK observes this actual
// Cloudflare browser; no device identity is copied from another browser or made
// up here. The value stays inside the server-side operation and is not logged.
export async function paymentDeviceId(page) {
  const value = await page.evaluate(async () => {
    if (location.origin !== 'https://platform.deepseek.com') return null;
    return new Promise((resolve) => {
      let finished = false;
      const done = (value) => { if (finished) return; finished = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => done(null), 6000);
      const ready = () => {
        try { window.SMSdk?.ready(() => done(typeof window.SMSdk.getDeviceId === 'function' ? window.SMSdk.getDeviceId() : null)); }
        catch { done(null); }
      };
      if (window.SMSdk?.ready) { ready(); return; }
      if (document.querySelector('script[data-fp]')) { done(null); return; }
      window._smReadyFuncs ||= [];
      window.SMSdk = { ready: (callback) => window._smReadyFuncs.push(callback) };
      const script = document.createElement('script');
      script.src = '/static/fp.min.js'; script.dataset.fp = 'true';
      script.onload = ready; script.onerror = () => done(null);
      document.head.appendChild(script);
    });
  });
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\r\n\x00]/.test(value)) throw new ApiError(503, 'PAYMENT_DEVICE_UNAVAILABLE', '未能取得官网 SDK 的设备信息，未发起付款请求。');
  return value;
}
