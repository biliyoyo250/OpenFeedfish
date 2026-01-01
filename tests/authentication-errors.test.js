import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../worker/lib.js';
import { upstream } from '../worker/provider.js';

const endpoint = '/auth-api/v0/users/current';
const privateWebToken = 'test-private-platform-user-token';
const privateCookie = 'test-private-cookie-value';
const cookieCredentials = {
  cookies: [{ name: 'web_session', value: privateCookie, domain: 'platform.deepseek.com', path: '/', secure: true, expires: -1 }],
};
const rawFailure = `untrusted response echoes ${privateWebToken} ${privateCookie}`;

function assertSafeFailure(error, expectedCode, status, upstreamCode) {
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, expectedCode);
  assert.equal(error.upstreamStatus, status);
  if (upstreamCode !== undefined) assert.equal(error.upstreamCode, upstreamCode);
  const exposed = `${error.message}\n${JSON.stringify(error)}`;
  for (const value of [privateWebToken, privateCookie, rawFailure]) assert.ok(!exposed.includes(value));
  return true;
}

test('HTTP 200 with DeepSeek code 40002 reports a missing Token rather than an expired session', async () => {
  await assert.rejects(upstream(endpoint, cookieCredentials, undefined, async (_url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.Cookie, `web_session=${privateCookie}`);
    return Response.json({ code: 40002, msg: rawFailure, data: null });
  }), error => assertSafeFailure(error, 'AUTH_TOKEN_MISSING', 200, 40002));
});

test('DeepSeek code 40003 still classifies rejected authorization as an expired session', async () => {
  await assert.rejects(upstream(endpoint, { sessionToken: privateWebToken }, undefined,
    async () => Response.json({ code: 40003, msg: rawFailure, data: null })),
  error => assertSafeFailure(error, 'SESSION_EXPIRED', 200, 40003));
});

test('HTTP 401 remains an authorization rejection for JSON and non-JSON responses', async () => {
  for (const response of [
    Response.json({ code: 40002, msg: rawFailure, data: null }, { status: 401 }),
    new Response(rawFailure, { status: 401, headers: { 'Content-Type': 'text/html' } }),
  ]) {
    await assert.rejects(upstream(endpoint, { sessionToken: privateWebToken }, undefined, async () => response),
      error => assertSafeFailure(error, 'SESSION_EXPIRED', 401));
  }
});

test('Cookie-only requests use the fixed endpoint and never fabricate a Bearer header', async () => {
  const user = { id: 'test-fixed-account', currency: 'CNY' };
  assert.deepEqual(await upstream(endpoint, cookieCredentials, undefined, async (url, options) => {
    assert.equal(url, `https://platform.deepseek.com${endpoint}`);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers['x-dsh-auth-token'], undefined);
    assert.equal(options.headers.Cookie, `web_session=${privateCookie}`);
    return Response.json({ code: 0, data: { biz_code: 0, biz_data: user } });
  }), user);
});

test('web-session Tokens use the actual platform Token in Authorization independently of Cookie changes', async () => {
  const user = { id: 'test-fixed-account', currency: 'CNY' };
  for (const cookies of [undefined, cookieCredentials.cookies]) {
    assert.deepEqual(await upstream(endpoint, { sessionToken: privateWebToken, ...(cookies ? { cookies } : {}) }, undefined, async (_url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${privateWebToken}`);
      assert.equal(options.headers['x-dsh-auth-token'], undefined);
      assert.equal(options.headers.Cookie, cookies ? `web_session=${privateCookie}` : undefined);
      return Response.json({ code: 0, data: { biz_code: 0, biz_data: user } });
    }), user);
  }
});
