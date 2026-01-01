import test from 'node:test';
import assert from 'node:assert/strict';
import { browserCommand, accountResult, AGENT_CLOSE } from '../shared/browser-agent-protocol.js';
import { serverOrigin, executeBrowserCommand, handshakeFailure, closeFailure, agentFailureMessage } from '../scripts/browser-agent.mjs';
import { BrowserAgentRelay } from '../worker/browser-agent-relay.js';
import worker from '../worker/index.js';
const id = () => crypto.randomUUID();

test('reverse browser protocol only accepts bounded input and named page actions', () => {
  const command = { id: id(), type: 'input', event: 'down', x: 100, y: 200, url: 'file:///private', evaluate: 'secret' };
  assert.deepEqual(browserCommand(command), { id: command.id, type: 'input', event: 'down', x: 100, y: 200 });
  for (const input of [
    { type: 'evaluate', source: 'process.exit()' }, { type: 'navigate', page: 'https://untrusted.invalid' },
    { type: 'input', event: 'down', x: -1, y: 10 }, { type: 'input', event: 'up', x: 1024, y: 10 },
    { type: 'input', event: 'key', key: 'Control+L' }, { type: 'input', event: 'key', key: 'Control+C' },
    { type: 'input', event: 'text', text: 'x'.repeat(1025) }, { type: 'input', event: 'text', text: '\x00' },
    { type: 'input', event: 'wheel', deltaY: 801 },
  ]) assert.throws(() => browserCommand({ id: id(), ...input }), /INVALID_COMMAND/);
  assert.equal(browserCommand({ id: id(), type: 'input', event: 'text', text: '中文输入' }).text, '中文输入');
});

test('account results project fixed identity and never echo upstream credentials or messages', () => {
  assert.deepEqual(accountResult({ ok: true, accountId: 'fixed', currency: 'CNY', eligible: true, token: 'private' }, 'fixed'), { ok: true, accountId: 'fixed', currency: 'CNY' });
  assert.deepEqual(accountResult({ ok: true, accountId: 'other', currency: 'CNY', eligible: true }, 'fixed'), { ok: false, code: 'ACCOUNT_MISMATCH' });
  assert.deepEqual(accountResult({ ok: true, accountId: 'fixed', currency: 'USD', eligible: true }, 'fixed'), { ok: false, code: 'ACCOUNT_INELIGIBLE' });
  assert.deepEqual(accountResult({ ok: false, code: 'UPSTREAM_NOT_JSON', httpStatus: 403, body: 'private', token: 'private' }, 'fixed'), { ok: false, code: 'UPSTREAM_NOT_JSON', httpStatus: 403 });
  assert.deepEqual(accountResult({ ok: false, code: 'private', httpStatus: 'private' }, 'fixed'), { ok: false, code: 'ACCOUNT_CHECK_FAILED' });
});

test('agent server URLs reject plaintext remote hosts and credential-bearing URLs', () => {
  assert.equal(serverOrigin('https://feedfish.example'), 'https://feedfish.example');
  assert.equal(serverOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  for (const value of ['http://remote.invalid', 'https://user:pass@feedfish.example', 'https://feedfish.example/private', 'https://feedfish.example/?key=private']) assert.throws(() => serverOrigin(value));
});

test('local browser executor forwards human input without arbitrary evaluation or URL execution', async () => {
  const calls = [];
  const page = { url: () => 'https://platform.deepseek.com/top_up', mouse: { move: async (...v) => calls.push(['move', ...v]), down: async () => calls.push(['down']), up: async () => calls.push(['up']) }, keyboard: { insertText: async (text) => calls.push(['text', text]) }, goto: async (...args) => calls.push(['goto', ...args]) };
  await executeBrowserCommand(page, { id: id(), type: 'input', event: 'down', x: 5, y: 6 }, 'fixed');
  await executeBrowserCommand(page, { id: id(), type: 'input', event: 'text', text: 'synthetic-test-only' }, 'fixed');
  assert.deepEqual(calls.slice(0, 3), [['move', 5, 6], ['down'], ['text', 'synthetic-test-only']]);
  await assert.rejects(executeBrowserCommand(page, { id: id(), type: 'evaluate', expression: 'secret' }, 'fixed'));
  page.url = () => 'https://untrusted.invalid';
  assert.deepEqual(await executeBrowserCommand(page, { id: id(), type: 'input', event: 'text', text: 'private' }, 'fixed'), { ok: false, code: 'ACTION_FAILED' });
  assert.equal(calls.length, 3);
});

test('browser-agent public enrollment refuses browser-origin requests and admin routes still require Access', async () => {
  const response = await worker.fetch(new Request('https://feedfish.example/api/browser-agent/pair', { method: 'POST', headers: { Origin: 'https://untrusted.invalid' } }), {});
  assert.equal(response.status, 403);
  const admin = await worker.fetch(new Request('https://feedfish.example/api/admin/browser-agent/status'), {});
  assert.equal(admin.status, 503); assert.equal((await admin.json()).error.code, 'ACCESS_NOT_CONFIGURED');
});

test('agent handshake distinguishes a missing device binding from an unclassified edge 403', () => {
  for (const code of ['DEVICE_NOT_PAIRED', 'DEVICE_DENIED', 'DEVICE_EXPIRED']) assert.equal(handshakeFailure(403, JSON.stringify({ error: code })), code);
  for (const body of ['<html>private-cookie</html>', '{"error":"private-token"}', '{"error":{"message":"private-token"}}']) {
    assert.equal(handshakeFailure(403, body), 'EDGE_FORBIDDEN');
    assert.equal(agentFailureMessage(handshakeFailure(403, body)).includes('private'), false);
  }
  assert.equal(handshakeFailure(409, '{"error":"DEVICE_BUSY"}'), 'DEVICE_BUSY');
  assert.equal(handshakeFailure(302, ''), 'HANDSHAKE_REDIRECT');
  assert.equal(handshakeFailure(503, ''), 'SERVER_UNAVAILABLE');
});

test('repair guidance preserves the profile and does not suggest reinstalling for an unpaired device', () => {
  for (const code of ['DEVICE_REVOKED', 'DEVICE_NOT_PAIRED', 'DEVICE_DENIED', 'DEVICE_EXPIRED']) {
    const message = agentFailureMessage(code);
    assert.ok(message.includes('npm run browser-agent -- --pair'));
    assert.ok(message.includes('登录资料保留'));
    assert.equal(message.includes('browser:install'), false);
  }
});

test('only explicit revocation or device expiry is a fatal device close', () => {
  assert.equal(closeFailure(AGENT_CLOSE.REVOKED), 'DEVICE_REVOKED');
  assert.equal(closeFailure(AGENT_CLOSE.DEVICE_EXPIRED), 'DEVICE_EXPIRED');
  for (const code of [1000, 1006, 1011, AGENT_CLOSE.REPLACED, AGENT_CLOSE.SESSION_LOST, AGENT_CLOSE.ACCESS_EXPIRED]) assert.equal(closeFailure(code), null);
});

test('relay window expiry and lost attachments cannot masquerade as device revocation', async () => {
  for (const [attachment, expected] of [
    [{ role: 'viewer', expiresAt: Date.now() - 1 }, AGENT_CLOSE.ACCESS_EXPIRED],
    [{ role: 'agent', expiresAt: Date.now() - 1 }, AGENT_CLOSE.DEVICE_EXPIRED],
    [null, AGENT_CLOSE.SESSION_LOST],
  ]) {
    let closed; const ws = { deserializeAttachment: () => attachment, close: (code) => { closed = code; } };
    const relay = new BrowserAgentRelay({ getWebSockets: () => [ws] }, {});
    assert.deepEqual(relay.live('agent'), []); assert.equal(closed, expected);
    closed = undefined; await relay.webSocketMessage(ws, 'ping'); assert.equal(closed, expected);
  }
});
