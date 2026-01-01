import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { verifyAccountInBrowser } from '../worker/browser-login.js';

function browserSetup(response = () => Response.json({ code: 0, data: { biz_code: 0, biz_data: { id: 'fixed', currency: 'CNY', email: 'private@example.test', token: 'must-not-return' } } })) {
  const counts = { acquisitions: 0, connections: 0, evaluations: 0, requests: 0, terminations: 0, disconnects: 0 };
  const credentials = { dshToken: 'existing-private-grant', deviceId: 'existing-device', deviceModel: 'trusted-client' };
  const env = { BROWSER: {}, DEEPSEEK_ACCOUNT_ID: 'fixed' };
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
        headers, location: { origin: new URL(url).origin }, AbortSignal,
        fetch: async (target, options) => {
          counts.requests++;
          assert.equal(target, 'https://platform.deepseek.com/auth-api/v0/users/current');
          assert.equal(options.method, 'GET');
          assert.equal(options.redirect, 'error');
          assert.equal(options.headers['x-dsh-auth-token'], credentials.dshToken);
          assert.equal(options.headers['x-device-id'], credentials.deviceId);
          assert.equal(options.headers.Cookie, undefined);
          assert.equal(options.headers.Authorization, undefined);
          return response();
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
  return { env, credentials, sdk, page, browser, counts };
}

test('browser account checks authenticate only the fixed read-only endpoint and close the instance', async () => {
  const state = browserSetup();
  assert.deepEqual(await verifyAccountInBrowser(state.env, state.credentials, state.sdk), { id: 'fixed', currency: 'CNY' });
  assert.equal(state.counts.requests, 1);
  assert.equal(state.counts.acquisitions, 1);
  assert.equal(state.counts.terminations, 1);
  assert.equal(state.counts.disconnects, 1);
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
