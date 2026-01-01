import { ApiError } from './lib.js';

// Match the public platform's SDK initialization. The SDK observes this actual
// Cloudflare browser; no device identity is copied from another browser or made
// up here. The value stays inside the server-side operation and is not logged.
export async function paymentDeviceId(page) {
  const result = await page.evaluate(async () => {
    if (location.origin !== 'https://platform.deepseek.com') return { value: null, stage: 'origin' };
    return new Promise((resolve) => {
      let finished = false;
      const done = (value, stage) => { if (finished) return; finished = true; clearTimeout(timer); resolve({ value, stage }); };
      const timer = setTimeout(() => done(null, 'timeout'), 10000);
      const ready = () => {
        try {
          if (typeof window.SMSdk?.ready !== 'function' || typeof window.SMSdk.getDeviceId !== 'function') { done(null, 'sdk'); return; }
          window.SMSdk.ready(() => { const value = window.SMSdk.getDeviceId(); done(value, value ? 'ready' : 'empty'); });
        } catch { done(null, 'sdk'); }
      };
      if (typeof window.SMSdk?.ready === 'function' && typeof window.SMSdk.getDeviceId === 'function') { ready(); return; }
      let script = document.querySelector('script[data-fp]');
      const existing = Boolean(script);
      if (!existing) {
        window._smReadyFuncs ||= [];
        window.SMSdk ||= { ready: (callback) => window._smReadyFuncs.push(callback) };
        script = document.createElement('script');
        script.src = '/static/fp.min.js'; script.dataset.fp = 'true';
      }
      // An existing script may still be loading. Keep the platform's onload
      // handler and wait for its actual SDK instead of treating it as failure.
      script.addEventListener('load', ready, { once: true });
      script.addEventListener('error', () => done(null, 'script'), { once: true });
      if (!existing) document.head.appendChild(script);
    });
  });
  const value = result?.value;
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\r\n\x00]/.test(value)) {
    const stages = { origin: '页面来源', timeout: '等待设备 SDK 超时', sdk: '设备组件未就绪', script: '设备脚本加载', empty: '设备信息为空' };
    const stage = Object.hasOwn(stages, result?.stage) ? stages[result.stage] : '设备信息无效';
    throw new ApiError(503, 'PAYMENT_DEVICE_UNAVAILABLE', `未能取得官网 SDK 的设备信息（${stage}），未发起付款请求。`);
  }
  return value;
}
