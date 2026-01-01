import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { verifyAccountInBrowser } from '../worker/browser-login.js';
import { browserPaymentFetcher } from '../worker/browser-payments.js';
import { mapPaymentResult } from '../worker/provider.js';
import { paymentDeviceId } from '../worker/payment-device.js';
import { paymentVerification } from '../worker/payment-verification.js';

function browserSetup(response = () => Response.json({ code: 0, data: { biz_code: 0, biz_data: { id: 'fixed', currency: 'CNY', email: 'private@example.test', token: 'must-not-return' } } })) {
  const counts = { acquisitions: 0, connections: 0, evaluations: 0, requests: 0, terminations: 0, disconnects: 0 };
  const credentials = { dshToken: 'existing-private-grant', deviceId: 'existing-device', deviceModel: 'trusted-client' };
  const env = { BROWSER: {}, DEEPSEEK_ACCOUNT_ID: 'fixed' };
  const device = { value: 'generated-cloud-device' };
  const verification = { calls: 0, valid: true, reject: false };
  let url = 'about:blank';
  const page = {
    url: () => url,
    goto: async (target, options) => {
      assert.equal(target, 'https://platform.deepseek.com/sign_in');
      assert.ok(!JSON.stringify(options).includes(credentials.dshToken));
      url = target;
    },
    evaluate: async (fn, headers) => {
      counts.evaluations++;
      return runInNewContext(`(${fn.toString()})(headers)`, {
        headers, location: { origin: new URL(url).origin }, AbortSignal, setTimeout, clearTimeout,
        window: { SMSdk: { ready: (callback) => callback(), getDeviceId: () => device.value }, AwsWafIntegration: { getToken: async () => { verification.calls++; if (verification.reject) throw new Error('private SDK failure'); return 'private-vendor-token'; }, hasToken: () => verification.valid } },
        fetch: async (target, options) => {
          counts.requests++;
          assert.ok(['https://platform.deepseek.com/auth-api/v0/users/current', 'https://platform.deepseek.com/api/v1/payments', 'https://platform.deepseek.com/api/v1/payments/known-order/capture'].includes(target));
          assert.equal(options.method, target.endsWith('/current') ? 'GET' : 'POST');
          assert.equal(options.redirect, 'error');
          assert.equal(options.headers['x-dsh-auth-token'], credentials.dshToken);
          assert.equal(options.headers['x-device-id'], credentials.deviceId);
          assert.equal(options.headers.Cookie, undefined);
          assert.equal(options.headers.Authorization, undefined);
          assert.equal(options.headers['x-aws-waf-token'], undefined);
          return response(target, options);
        },
      });
    },
  };
  const browser = {
    contexts: () => [{ newPage: async () => page }],
    close: async () => { counts.disconnects++; },
    newBrowserCDPSession: async () => ({ send: async (command) => { assert.equal(command, 'Browser.close'); counts.terminations++; } }),
  };
  const sdk = {
    limits: async () => ({ activeSessions: [], maxConcurrentSessions: 3, allowedBrowserAcquisitions: 1, timeUntilNextAllowedBrowserAcquisition: 0 }),
    acquire: async (_, options) => { counts.acquisitions++; assert.deepEqual(options, { keep_alive: 10000, recording: false }); return { sessionId: 'private-session' }; },
    endpointURLString: () => 'http://fake.test/v1/devtools/browser/private-session',
    connect: async () => { counts.connections++; return browser; },
  };
  return { env, credentials, sdk, page, browser, counts, device, verification };
}

test('browser account checks authenticate only the fixed read-only endpoint and close the instance', async () => {
  const state = browserSetup();
  assert.deepEqual(await verifyAccountInBrowser(state.env, state.credentials, state.sdk), { id: 'fixed', currency: 'CNY' });
  assert.equal(state.counts.requests, 1);
  assert.equal(state.counts.acquisitions, 1);
  assert.equal(state.counts.terminations, 1);
  assert.equal(state.counts.disconnects, 1);
});

test('browser QR transport binds the live account, sends one fixed payment request and filters response fields', async () => {
  let paymentCalls = 0;
  const profile = () => Response.json({ code: 0, data: { biz_code: 0, biz_data: { id: 'fixed', currency: 'CNY' } } });
  const state = browserSetup((url, options) => {
    if (url.endsWith('/current')) return profile();
    paymentCalls++;
    const body = JSON.parse(options.body);
    assert.equal(body.order_info.amount, '1'); assert.equal(body.order_info.currency, 'CNY');
    assert.equal(body.shumei_device_id, 'generated-cloud-device');
    assert.equal(body.untrusted, undefined);
    return Response.json({ code: 0, data: { biz_code: 0, secret: 'must-not-return', biz_data: { payment_order_id: 'test-order', amount: '1', currency: 'CNY', url: 'weixin://test', private: 'must-not-return' } } });
  });
  const body = { order_info: { amount: '1', currency: 'CNY', payment_method_type: 'CMB_UNIONPAY', fallback_method_type: 'WECHAT', request_id: crypto.randomUUID() }, untrusted: 'drop' };
  state.credentials.shumeiDeviceId = 'stale-device-from-another-browser';
  const response = await browserPaymentFetcher(state.env, state.credentials, state.sdk)('https://platform.deepseek.com/api/v1/payments', { method: 'POST', body: JSON.stringify(body) });
  const text = await response.text();
  assert.equal(JSON.parse(text).data.biz_data.payment_order_id, 'test-order');
  assert.ok(!text.includes('must-not-return'));
  assert.equal(paymentCalls, 1); assert.equal(state.counts.acquisitions, 1); assert.equal(state.counts.terminations, 1);
  assert.equal(state.verification.calls, 1);
});

test('browser QR failures distinguish an unattempted request from an uncertain creation without retrying', async () => {
  const options = { method: 'POST', body: JSON.stringify({ order_info: { amount: '1', currency: 'CNY', payment_method_type: 'CMB_UNIONPAY', fallback_method_type: 'ALIPAY', request_id: crypto.randomUUID() } }) };
  const wrong = browserSetup(() => Response.json({ code: 0, data: { biz_code: 0, biz_data: { id: 'other', currency: 'CNY' } } }));
  await assert.rejects(browserPaymentFetcher(wrong.env, wrong.credentials, wrong.sdk)('https://platform.deepseek.com/api/v1/payments', options), (error) => error.code === 'ACCOUNT_MISMATCH' && error.creationAttempted === false);
  assert.equal(wrong.counts.requests, 1);
  const invalid = browserSetup();
  await assert.rejects(browserPaymentFetcher(invalid.env, invalid.credentials, invalid.sdk)('https://other.test/api/v1/payments', options), (error) => error.code === 'INVALID_REQUEST' && error.creationAttempted === false);
  assert.equal(invalid.counts.acquisitions, 0);
  const failed = browserSetup((url) => { if (url.endsWith('/current')) return Response.json({ code: 0, data: { biz_code: 0, biz_data: { id: 'fixed', currency: 'CNY' } } }); throw new Error('private request failure'); });
  await assert.rejects(browserPaymentFetcher(failed.env, failed.credentials, failed.sdk)('https://platform.deepseek.com/api/v1/payments', options), (error) => error.code === 'BROWSER_UNAVAILABLE' && error.creationAttempted !== false);
  assert.equal(failed.counts.requests, 2); assert.equal(failed.counts.acquisitions, 1); assert.equal(failed.counts.terminations, 1);
});

test('a scoped browser capture polls one existing order without a body or a new payment request', async () => {
  let captures = 0;
  const state = browserSetup((url, options) => {
    if (url.endsWith('/current')) return Response.json({ code: 0, data: { biz_code: 0, biz_data: { id: 'fixed', currency: 'CNY' } } });
    assert.equal(url, 'https://platform.deepseek.com/api/v1/payments/known-order/capture');
    assert.equal(options.body, undefined); assert.equal(options.headers['Content-Type'], undefined);
    captures++;
    return Response.json({ code: 0, data: { biz_code: 0, biz_data: { order: { id: 'known-order', amount: '1', currency: 'CNY', status: 'CREATED', private: 'must-not-return' } } } });
  });
  const response = await browserPaymentFetcher(state.env, state.credentials, state.sdk, 'known-order')('https://platform.deepseek.com/api/v1/payments/known-order/capture', { method: 'POST' });
  const text = await response.text(), result = JSON.parse(text).data.biz_data;
  assert.ok(!text.includes('must-not-return'));
  assert.deepEqual(mapPaymentResult(result, { provider_order_id: 'known-order', amount_fen: 100 }), { status: 'pending', providerStatus: 'CREATED' });
  assert.equal(captures, 1); assert.equal(state.counts.acquisitions, 1); assert.equal(state.counts.terminations, 1);
  assert.equal(state.verification.calls, 0);
});

test('capture scopes reject different orders, injected bodies and creation requests before browser acquisition', async () => {
  const state = browserSetup();
  const fetcher = browserPaymentFetcher(state.env, state.credentials, state.sdk, 'known-order');
  for (const [url, options] of [
    ['https://platform.deepseek.com/api/v1/payments/other-order/capture', { method: 'POST' }],
    ['https://platform.deepseek.com/api/v1/payments/known-order/capture', { method: 'POST', body: '{}' }],
    ['https://platform.deepseek.com/api/v1/payments', { method: 'POST' }],
    ['https://other.test/api/v1/payments/known-order/capture', { method: 'POST' }],
  ]) await assert.rejects(fetcher(url, options), { code: 'INVALID_REQUEST' });
  for (const id of [null, '', '../other', 'https://other.test', 'a'.repeat(201)]) assert.throws(() => browserPaymentFetcher(state.env, state.credentials, state.sdk, id), { code: 'INVALID_ORDER_ID' });
  assert.equal(state.counts.acquisitions, 0);
});

test('browser capture retains only the safe challenge marker and never repeats a status request', async () => {
  const state = browserSetup(url => url.endsWith('/current')
    ? Response.json({ code: 0, data: { biz_code: 0, biz_data: { id: 'fixed', currency: 'CNY' } } })
    : new Response('private challenge document', { status: 202, headers: { 'x-amzn-waf-action': 'challenge' } }));
  const response = await browserPaymentFetcher(state.env, state.credentials, state.sdk, 'known-order')('https://platform.deepseek.com/api/v1/payments/known-order/capture', { method: 'POST' });
  assert.equal(response.status, 202); assert.equal(response.headers.get('x-amzn-waf-action'), 'challenge');
  assert.equal(await response.text(), '');
  assert.equal(state.counts.requests, 2); assert.equal(state.counts.terminations, 1);
});

test('payment context checks read the actual SDK device without creating a bill or returning the device', async () => {
  const state = browserSetup();
  const account = await verifyAccountInBrowser(state.env, state.credentials, state.sdk, true);
  assert.deepEqual(account, { id: 'fixed', currency: 'CNY' });
  assert.ok(!JSON.stringify(account).includes(state.device.value));
  assert.equal(state.counts.requests, 1); assert.equal(state.counts.terminations, 1);
  assert.equal(state.verification.calls, 1);
});

test('official verification failure stops before payment and never retries or exposes the vendor token', async () => {
  const state = browserSetup(); state.verification.reject = true;
  const options = { method: 'POST', body: JSON.stringify({ order_info: { amount: '1', currency: 'CNY', payment_method_type: 'CMB_UNIONPAY', fallback_method_type: 'WECHAT', request_id: crypto.randomUUID() } }) };
  await assert.rejects(browserPaymentFetcher(state.env, state.credentials, state.sdk)('https://platform.deepseek.com/api/v1/payments', options), error => error.code === 'PAYMENT_VERIFICATION_REQUIRED' && error.creationAttempted === false && !error.message.includes('private'));
  assert.equal(state.counts.requests, 1); assert.equal(state.verification.calls, 1); assert.equal(state.counts.terminations, 1);
});

test('ordinary vendor SDK initialization uses the official fixed script and returns no token', async () => {
  const runtime = { location: { origin: 'https://platform.deepseek.com' }, window: {}, setTimeout, clearTimeout };
  let scriptLoads = 0;
  runtime.document = {
    querySelector: () => null,
    createElement: () => { const handlers = {}; return { addEventListener: (type, fn) => { handlers[type] = fn; }, handlers }; },
    head: { appendChild: (script) => {
      assert.equal(script.src, 'https://a0fea896111e.edge.sdk.awswaf.com/a0fea896111e/3a8b889b892b/challenge.js');
      scriptLoads++;
      runtime.window.AwsWafIntegration = { getToken: async () => 'private-token-must-not-return', hasToken: () => true };
      script.handlers.load();
    } },
  };
  const page = { evaluate: (fn, argument) => runInNewContext(`(${fn.toString()})(argument)`, { ...runtime, argument }) };
  assert.equal(await paymentVerification(page), undefined);
  assert.equal(scriptLoads, 1);
  runtime.location.origin = 'https://other.example';
  await assert.rejects(paymentVerification(page), { code: 'PAYMENT_VERIFICATION_REQUIRED' });
  assert.equal(scriptLoads, 1);
});

test('a vendor SDK without a valid verification result cannot trigger a payment request', async () => {
  const state = browserSetup(); state.verification.valid = false;
  await assert.rejects(verifyAccountInBrowser(state.env, state.credentials, state.sdk, true), { code: 'PAYMENT_VERIFICATION_REQUIRED' });
  assert.equal(state.counts.requests, 1); assert.equal(state.verification.calls, 1); assert.equal(state.counts.terminations, 1);
});

test('a missing SDK identity stops creation before the payment POST and closes the browser', async () => {
  const state = browserSetup(); state.device.value = '';
  const options = { method: 'POST', body: JSON.stringify({ order_info: { amount: '1', currency: 'CNY', payment_method_type: 'CMB_UNIONPAY', fallback_method_type: 'WECHAT', request_id: crypto.randomUUID() } }) };
  await assert.rejects(browserPaymentFetcher(state.env, state.credentials, state.sdk)('https://platform.deepseek.com/api/v1/payments', options), (error) => error.code === 'PAYMENT_DEVICE_UNAVAILABLE' && error.creationAttempted === false);
  assert.equal(state.counts.requests, 1); assert.equal(state.counts.terminations, 1);
});

test('SDK initialization loads only the official fixed script and fails closed on another origin', async () => {
  const runtime = { location: { origin: 'https://platform.deepseek.com' }, window: {}, setTimeout, clearTimeout };
  runtime.document = {
    querySelector: () => null,
    createElement: (tag) => { assert.equal(tag, 'script'); const handlers = {}; return { dataset: {}, addEventListener: (name, fn) => { handlers[name] = fn; }, handlers }; },
    head: { appendChild: (script) => {
      assert.equal(script.src, '/static/fp.min.js'); assert.equal(script.dataset.fp, 'true');
      runtime.window.SMSdk = { ready: (callback) => callback(), getDeviceId: () => 'actual-sdk-value' };
      script.handlers.load();
    } },
  };
  const page = { evaluate: (fn) => runInNewContext(`(${fn.toString()})()`, runtime) };
  assert.equal(await paymentDeviceId(page), 'actual-sdk-value');
  runtime.location.origin = 'https://other.example';
  await assert.rejects(paymentDeviceId(page), { code: 'PAYMENT_DEVICE_UNAVAILABLE' });
});

test('a device script already in flight is awaited without replacing or loading it twice', async () => {
  const runtime = { location: { origin: 'https://platform.deepseek.com' }, window: {}, setTimeout, clearTimeout };
  const script = { addEventListener: (name, fn) => {
    if (name === 'load') queueMicrotask(() => { runtime.window.SMSdk = { ready: (callback) => callback(), getDeviceId: () => 'existing-script-device' }; fn(); });
  } };
  runtime.document = { querySelector: () => script, createElement: () => assert.fail('must reuse the existing script'), head: { appendChild: () => assert.fail('must not load twice') } };
  const page = { evaluate: (fn) => runInNewContext(`(${fn.toString()})()`, runtime) };
  assert.equal(await paymentDeviceId(page), 'existing-script-device');
});

test('browser checks reject challenges, expired grants, wrong accounts and unavailable CNY permissions', async () => {
  const cases = [
    [() => new Response('private challenge body', { status: 403, headers: { 'x-amzn-waf-action': 'challenge' } }), 'UPSTREAM_NOT_JSON'],
    [() => Response.json({ code: 40003 }), 'SESSION_EXPIRED'],
    [() => new Response('', { status: 401 }), 'SESSION_EXPIRED'],
    ...[
      [{ id: 'other', currency: 'CNY' }, 'ACCOUNT_MISMATCH'],
      [{ id: 'fixed', currency: 'USD' }, 'ACCOUNT_UNAVAILABLE'],
      [{ id: 'fixed', currency: 'CNY', is_api_banned: true }, 'ACCOUNT_UNAVAILABLE'],
      [{ id: 'fixed', currency: 'CNY', feature_gates: { PAYMENT: false } }, 'ACCOUNT_UNAVAILABLE'],
    ].map(([user, code]) => [() => Response.json({ code: 0, data: { biz_code: 0, biz_data: user } }), code]),
  ];
  for (const [response, code] of cases) {
    const state = browserSetup(response);
    await assert.rejects(verifyAccountInBrowser(state.env, state.credentials, state.sdk), (error) => {
      assert.equal(error.code, code);
      assert.ok(!error.message.includes('private'));
      if (code === 'UPSTREAM_NOT_JSON') { assert.equal(error.upstreamStatus, 403); assert.equal(error.upstreamChallenge, 'challenge'); }
      return true;
    });
    assert.equal(state.counts.terminations, 1);
  }
});

test('redirected pages never receive the grant and failed requests never expose raw errors', async () => {
  const redirected = browserSetup();
  redirected.page.goto = async () => {};
  redirected.page.url = () => 'https://other.example/sign_in';
  await assert.rejects(verifyAccountInBrowser(redirected.env, redirected.credentials, redirected.sdk), { code: 'UPSTREAM_REDIRECT' });
  assert.equal(redirected.counts.evaluations, 0);
  assert.equal(redirected.counts.terminations, 1);
  const failed = browserSetup(() => { throw new Error('private upstream body and credential'); });
  await assert.rejects(verifyAccountInBrowser(failed.env, failed.credentials, failed.sdk), (error) => error.code === 'BROWSER_UNAVAILABLE' && !error.message.includes('private'));
  assert.equal(failed.counts.terminations, 1);
});

test('unavailable resources and missing grants do not acquire a browser', async () => {
  for (const limits of [
    { allowedBrowserAcquisitions: 0 },
    { allowedBrowserAcquisitions: 1, timeUntilNextAllowedBrowserAcquisition: 20 },
    { allowedBrowserAcquisitions: 1, activeSessions: [{}, {}, {}], maxConcurrentSessions: 3 },
  ]) {
    const state = browserSetup(); state.sdk.limits = async () => limits;
    await assert.rejects(verifyAccountInBrowser(state.env, state.credentials, state.sdk), { code: 'BROWSER_BUSY' });
    assert.equal(state.counts.acquisitions, 0);
  }
  const state = browserSetup();
  await assert.rejects(verifyAccountInBrowser(state.env, {}, state.sdk), { code: 'BROWSER_GRANT_REQUIRED' });
  assert.equal(state.counts.acquisitions, 0);
});

test('connection cleanup reuses its acquired session and never acquires another instance', async () => {
  const state = browserSetup();
  const connect = state.sdk.connect;
  let attempts = 0;
  state.sdk.connect = async () => { if (++attempts === 1) throw new Error('private connection failure'); return connect(); };
  await assert.rejects(verifyAccountInBrowser(state.env, state.credentials, state.sdk), { code: 'BROWSER_UNAVAILABLE' });
  assert.equal(attempts, 2);
  assert.equal(state.counts.acquisitions, 1);
  assert.equal(state.counts.terminations, 1);
  const limited = browserSetup();
  limited.sdk.acquire = async () => { throw new Error('429: private provider details'); };
  await assert.rejects(verifyAccountInBrowser(limited.env, limited.credentials, limited.sdk), (error) => error.code === 'BROWSER_RATE_LIMIT' && !error.message.includes('private'));
});
