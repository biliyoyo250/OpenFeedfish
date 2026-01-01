import { ApiError } from './lib.js';

// Public integration script used by the current official platform client.
// Use the vendor's ordinary browser SDK; never read/export its token, forge
// cookies, change the browser identity, or invoke the interactive CAPTCHA API.
const scriptUrl = 'https://a0fea896111e.edge.sdk.awswaf.com/a0fea896111e/3a8b889b892b/challenge.js';
export async function paymentVerification(page) {
  const result = await page.evaluate(async (scriptUrl) => {
    if (location.origin !== 'https://platform.deepseek.com') return { ok: false, step: 'origin' };
    return new Promise((resolve) => {
      let finished = false;
      const done = (ok, step) => { if (finished) return; finished = true; clearTimeout(timer); resolve({ ok, step }); };
      const timer = setTimeout(() => done(false, 'timeout'), 10000);
      const ready = () => {
        if (finished) return;
        const sdk = window.AwsWafIntegration;
        if (typeof sdk?.getToken !== 'function' || typeof sdk?.hasToken !== 'function') { done(false, 'sdk'); return; }
        // The SDK handles its own same-origin cookie. Ignore the token value.
        Promise.resolve().then(() => sdk.getToken()).then(() => sdk.hasToken() === true).then(ok => done(ok, 'verification'), () => done(false, 'verification'));
      };
      if (window.AwsWafIntegration) { ready(); return; }
      let script = document.querySelector(`script[src="${scriptUrl}"]`);
      const existing = Boolean(script);
      script ||= document.createElement('script');
      script.addEventListener('load', ready, { once: true });
      script.addEventListener('error', () => done(false, 'script'), { once: true });
      if (!existing) { script.src = scriptUrl; document.head.appendChild(script); }
    });
  }, scriptUrl);
  if (result?.ok !== true) {
    const steps = { origin: '页面来源', script: '验证脚本', sdk: '验证组件', verification: '官方静默验证', timeout: '验证超时' };
    const step = Object.hasOwn(steps, result?.step) ? steps[result.step] : '验证环境';
    throw new ApiError(503, 'PAYMENT_VERIFICATION_REQUIRED', `官网浏览器验证未完成（${step}），未发起付款请求。`);
  }
}
