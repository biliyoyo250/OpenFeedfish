import { ApiError } from './lib.js';
import { credentialsFor } from './vault.js';
import { startBrowserLogin, browserTaskView, completeBrowserTask, cancelBrowserLogin, runInAccountBrowser } from './browser-login.js';
import { paymentDeviceId } from './payment-device.js';
import { paymentVerification } from './payment-verification.js';
import { browserPaymentFetcher } from './browser-payments.js';
import { createAdminTestPayment } from './admin-payments.js';

const purpose = 'payment-captcha';
const sourceUrl = 'https://fe-static.deepseek.com/platform/static/4099.0741c5b665.js';
const captchaScript = 'https://a0fea896111e.edge.captcha-sdk.awswaf.com/a0fea896111e/jsapi.js';
const taskEnv = env => ({ ...env, BROWSER_LOGIN_ENABLED: 'true' });
const validId = id => { if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(400, 'INVALID_LOGIN', '官方验证窗口标识无效。'); };

// The domain-bound CAPTCHA configuration is published by the official client.
// Fetch it without account headers; never copy a user credential into the key.
export async function publicCaptchaKey(fetcher = fetch) {
  let response;
  try { response = await fetcher(sourceUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
  catch { throw new ApiError(503, 'CAPTCHA_CONFIGURATION_UNAVAILABLE', '暂时无法读取官网验证码配置。'); }
  if (!response.ok) throw new ApiError(503, 'CAPTCHA_CONFIGURATION_UNAVAILABLE', '官网验证码配置暂不可用。');
  const text = await response.text();
  if (text.length > 2097152) throw new ApiError(503, 'CAPTCHA_CONFIGURATION_UNAVAILABLE', '官网验证码配置格式已变化。');
  const keys = [...new Set([...text.matchAll(/["']([A-Za-z0-9+/=]{200,4096}_1_1)["']/g)].map(match => match[1]))];
  if (keys.length !== 1) throw new ApiError(503, 'CAPTCHA_CONFIGURATION_UNAVAILABLE', '官网验证码配置已变化，请管理员核对。');
  return keys[0];
}

export async function renderPaymentChallenge(page, apiKey) {
  const initialized = await page.evaluate(async ({ apiKey, scriptUrl }) => {
    if (location.origin !== 'https://platform.deepseek.com') return false;
    if (!window.AwsWafCaptcha) {
      const loaded = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 10000);
        const script = document.createElement('script'); script.src = scriptUrl;
        script.onload = () => { clearTimeout(timer); resolve(true); };
        script.onerror = () => { clearTimeout(timer); resolve(false); };
        document.head.appendChild(script);
      });
      if (!loaded) return false;
    }
    if (typeof window.AwsWafCaptcha?.renderCaptcha !== 'function') return false;
    const panel = document.createElement('section'); panel.id = 'feedfish-payment-captcha'; panel.dataset.complete = 'false';
    panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:white;color:#202124;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px;overflow:auto';
    const title = document.createElement('h1'); title.textContent = 'DeepSeek 支付验证';
    const note = document.createElement('p'); note.textContent = '请手动完成官方验证码。完成后返回喂鱼后台继续，无需重新登录 DeepSeek。';
    const puzzle = document.createElement('div'); const state = document.createElement('p'); state.textContent = '正在加载官方验证码…';
    panel.append(title, note, puzzle, state); document.body.appendChild(panel);
    try {
      window.AwsWafCaptcha.renderCaptcha(puzzle, { apiKey, defaultLocale: 'zh-CN', dynamicWidth: true,
        onLoad: () => { state.textContent = '请在此手动完成验证码。'; },
        onSuccess: () => { panel.dataset.complete = 'true'; state.textContent = '验证已完成，请返回喂鱼后台继续。'; },
        onError: () => { state.textContent = '官方验证码暂不可用，请返回后台关闭窗口。'; },
      });
      return true;
    } catch { return false; }
  }, { apiKey, scriptUrl: captchaScript });
  if (!initialized) throw new ApiError(503, 'PAYMENT_CHALLENGE_UNAVAILABLE', '暂时无法显示官方验证码。');
}

export async function startPaymentChallenge(env, identity, sdk, fetcher = fetch, now = Date.now()) {
  // The legacy browser-login entry remains disabled. This is a separate,
  // five-minute, SSO-owned task with no account credentials in its viewer.
  const credentials = await credentialsFor(env);
  if (!credentials.dshToken) throw new ApiError(409, 'BROWSER_GRANT_REQUIRED', '请先保存固定账户的官方授权。');
  const result = await startBrowserLogin(taskEnv(env), identity, sdk, now, {
    purpose, checkLimits: true, data: { requestId: crypto.randomUUID() },
    prepare: async page => { await paymentDeviceId(page); await paymentVerification(page); await renderPaymentChallenge(page, await publicCaptchaKey(fetcher)); },
  });
  return { id: result.id, expiresAt: result.expiresAt, viewPath: `/api/admin/account/payment-challenge/view?id=${result.id}` };
}
export async function paymentChallengeView(env, identity, id, sdk) {
  validId(id); return browserTaskView(taskEnv(env), identity, id, purpose, sdk);
}
export async function completePaymentChallenge(env, identity, id, sdk) {
  validId(id);
  return completeBrowserTask(taskEnv(env), identity, id, purpose,
    page => page.evaluate(() => document.getElementById('feedfish-payment-captcha')?.dataset.complete === 'true'),
    async (browser, page, saved) => {
      const credentials = await credentialsFor(env);
      const runner = (_env, credentials, operation) => runInAccountBrowser(env, credentials, browser, operation, page);
      const fetcher = browserPaymentFetcher(env, credentials, undefined, undefined, runner);
      return createAdminTestPayment(env, identity, { requestId: saved.requestId, paymentMethod: 'wechat' }, fetcher);
    }, sdk);
}
export async function cancelPaymentChallenge(env, identity, id, sdk) {
  validId(id); await cancelBrowserLogin(taskEnv(env), identity, id, sdk, Date.now(), purpose);
}
