import test from 'node:test';
import assert from 'node:assert/strict';
import { beginLocalAuthorization } from '../frontend/admin-connection.js';

const now = Date.parse('2026-11-04T10:00:00Z');
const input = { callbackPort: 18487, state: 'A'.repeat(43) };
const pendingId = '12345678-1234-1234-1234-123456789abc';
const authorizeUrl = 'https://platform.deepseek.com/dsh/authorize?authorize_id=test-only-reference';
const success = { authorizeUrl, expiresAt: new Date(now + 60000).toISOString() };

test('the local connection starts once and navigates automatically with only the callback port and state', async () => {
  const calls = [];
  const value = await beginLocalAuthorization({
    input: { ...input, token: 'must-not-forward', ignored: 'extra input' }, now,
    request: async (path, body) => { calls.push({ path, body }); return success; },
    navigate: url => calls.push({ navigate: url }),
  });
  assert.equal(value, undefined);
  assert.deepEqual(calls, [
    { path: '/api/admin/account/authorize/start', body: input },
    { navigate: authorizeUrl },
  ]);
});

test('a pending credential is discarded and awaited before starting a fresh local authorization', async () => {
  const calls = []; let finishDiscard;
  const discarded = new Promise(resolve => { finishDiscard = resolve; });
  const connection = beginLocalAuthorization({
    input, pendingId, now,
    request: async (path, body) => {
      calls.push({ path, body });
      if (path.endsWith('/discard')) { await discarded; return { ok: true }; }
      return success;
    },
    navigate: url => calls.push({ navigate: url }),
  });
  assert.deepEqual(calls, [{ path: '/api/admin/account/authorize/discard', body: { id: pendingId } }]);
  finishDiscard(); await connection;
  assert.deepEqual(calls, [
    { path: '/api/admin/account/authorize/discard', body: { id: pendingId } },
    { path: '/api/admin/account/authorize/start', body: input },
    { navigate: authorizeUrl },
  ]);
});

test('a failed discard never starts another authorization or navigates', async () => {
  const failure = Object.assign(new Error('暂存清除失败'), { code: 'AUTH_BUSY' });
  const calls = [];
  await assert.rejects(beginLocalAuthorization({
    input, pendingId, now,
    request: async (path, body) => { calls.push({ path, body }); throw failure; },
    navigate: () => assert.fail('must not navigate'),
  }), error => error === failure);
  assert.deepEqual(calls, [{ path: '/api/admin/account/authorize/discard', body: { id: pendingId } }]);
  await assert.rejects(beginLocalAuthorization({
    input, pendingId, now,
    request: async path => { assert.equal(path, '/api/admin/account/authorize/discard'); return { ok: false }; },
    navigate: () => assert.fail('must not navigate'),
  }), { code: 'AUTH_PROTOCOL' });
});

test('invalid or expired authorization destinations cannot trigger navigation', async () => {
  const responses = [
    { ...success, authorizeUrl: 'https://evil.example/dsh/authorize?secret=do-not-echo' },
    { ...success, authorizeUrl: 'http://platform.deepseek.com/dsh/authorize' },
    { ...success, authorizeUrl: 'https://platform.deepseek.com:444/dsh/authorize' },
    { ...success, authorizeUrl: 'https://platform.deepseek.com/top_up' },
    { ...success, authorizeUrl: 'https://user:private@platform.deepseek.com/dsh/authorize' },
    { ...success, authorizeUrl: `${authorizeUrl}#do-not-echo` },
    { ...success, authorizeUrl: 'not-a-valid-url-do-not-echo' },
    { ...success, expiresAt: new Date(now).toISOString() },
    { ...success, expiresAt: new Date(now - 1).toISOString() },
    { ...success, expiresAt: 'invalid-date-do-not-echo' },
    { ...success, expiresAt: now + 60000 },
    { ...success, expiresAt: undefined },
    null,
  ];
  for (const response of responses) {
    let requests = 0;
    await assert.rejects(beginLocalAuthorization({
      input, now,
      request: async () => { requests++; return response; },
      navigate: () => assert.fail('must not navigate'),
    }), error => {
      assert.equal(error.code, 'AUTH_PROTOCOL');
      assert.doesNotMatch(error.message, /do-not-echo|private|evil\.example/);
      return true;
    });
    assert.equal(requests, 1);
  }
});

test('malformed local callback input and pending IDs fail before any request', async () => {
  const badInputs = [
    null, [], {}, { ...input, callbackPort: '18487' }, { ...input, callbackPort: 1023 },
    { ...input, callbackPort: 65536 }, { ...input, callbackPort: 18487.5 },
    { ...input, callbackPort: Infinity }, { ...input, state: 'A'.repeat(42) },
    { ...input, state: 'A'.repeat(44) }, { ...input, state: `${'A'.repeat(42)}=` },
    { ...input, state: 1 },
  ];
  const noRequest = () => assert.fail('must not request');
  const noNavigation = () => assert.fail('must not navigate');
  for (const value of badInputs) {
    await assert.rejects(beginLocalAuthorization({ input: value, request: noRequest, navigate: noNavigation, now }), { code: 'AUTH_PROTOCOL' });
  }
  for (const value of ['', 'malformed-private-id', 1]) {
    await assert.rejects(beginLocalAuthorization({ input, pendingId: value, request: noRequest, navigate: noNavigation, now }), { code: 'AUTH_PROTOCOL' });
  }
});

test('a start failure does not retry or navigate and a navigation failure stays sanitized', async () => {
  const failure = Object.assign(new Error('初始化失败'), { code: 'AUTH_NETWORK' });
  let requests = 0;
  await assert.rejects(beginLocalAuthorization({
    input, now,
    request: async () => { requests++; throw failure; },
    navigate: () => assert.fail('must not navigate'),
  }), error => error === failure);
  assert.equal(requests, 1);
  await assert.rejects(beginLocalAuthorization({
    input, now, request: async () => success,
    navigate: () => { throw new Error(`failed at ${authorizeUrl}`); },
  }), error => { assert.equal(error.code, 'AUTH_PROTOCOL'); assert.ok(!error.message.includes(authorizeUrl)); return true; });
});
