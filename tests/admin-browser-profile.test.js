import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { BrowserAgentRelay } from '../worker/browser-agent-relay.js';
import worker from '../worker/index.js';

const summary = { nickname: '小鱼', avatarUrl: null, balance: '13.14' };
const envelope = (profile, id = 'fixed') => ({ ok: true, httpStatus: 200, isJson: true, data: { code: 0, data: { biz_code: 0, biz_data: { id, currency: 'CNY', ...(profile === undefined ? {} : { profile }), token: 'must-not-forward' } } } });

function fixture() {
  const storage = new Map([['device', { id: 'paired-device', receivingAccountId: 'fixed', name: 'Test browser', expiresAt: Date.now() + 600000 }]]);
  let attachment = { role: 'agent', connectionId: crypto.randomUUID(), paymentProtocol: 3, expiresAt: Date.now() + 600000, lastSeen: Date.now(), bucket: 0, count: 0 };
  const jobs = [];
  const socket = { readyState: 1, deserializeAttachment: () => attachment, serializeAttachment: (value) => { attachment = value; }, send: (value) => jobs.push(JSON.parse(value)), close: () => { socket.readyState = 3; } };
  const context = { getWebSockets: (role) => role === 'viewer' ? [] : [socket], blockConcurrencyWhile: (fn) => fn(), storage: { get: async (key) => storage.get(key), put: async (key, value) => storage.set(key, value), delete: async (key) => storage.delete(key) } };
  const relay = new BrowserAgentRelay(context, { DEEPSEEK_ACCOUNT_ID: 'fixed' });
  const request = (path, body) => relay.fetch(new Request(`https://relay.internal${path}`, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const state = async () => (await request('/status')).json();
  const start = async (selecting = false, accountId = 'fixed', includeProfile = true) => {
    const before = jobs.length;
    const pending = request(selecting ? '/select-recipient' : '/execute', selecting ? {} : { type: 'payment-job', id: crypto.randomUUID(), operation: 'profile', accountId, ...(includeProfile ? { includeProfile: true } : {}) });
    for (let attempt = 0; attempt < 30 && jobs.length === before; attempt++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(jobs.length, before + 1);
    return { pending, job: jobs.at(-1) };
  };
  const finish = async (entry, value) => {
    await relay.webSocketMessage(socket, JSON.stringify({ type: 'payment-job-result', id: entry.job.id, result: value }));
    return (await entry.pending).json();
  };
  return { relay, request, storage, socket, state, start, finish, jobs };
}

test('verified profile jobs cache only safe fields and status reads do not contact the browser', async () => {
  const f = fixture();
  assert.equal((await f.state()).profile, null);
  const entry = await f.start();
  const result = await f.finish(entry, envelope({ ...summary, email: 'private@example.invalid', token: 'private-token' }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.data.biz_data.profile, summary);
  const state = await f.state();
  assert.deepEqual(state.profile, summary);
  assert.ok(Number.isFinite(Date.parse(state.profileUpdatedAt)));
  assert.doesNotMatch(JSON.stringify(state), /private|must-not-forward/);
  await f.state();
  assert.equal(f.jobs.length, 1);
});

test('profile is scoped to both active receiving account and paired device', async () => {
  const f = fixture();
  await f.finish(await f.start(true), envelope(summary, 'selected-account'));
  assert.equal((await f.state()).receivingAccountId, 'selected-account');
  assert.deepEqual((await f.state()).profile, summary);
  const device = f.storage.get('device');
  f.storage.set('device', { ...device, receivingAccountId: 'different-account' });
  assert.equal((await f.state()).profile, null);
  f.storage.set('device', { ...device, id: 'different-device' });
  assert.equal((await f.state()).profile, null);
  f.storage.set('device', { ...device, expiresAt: Date.now() - 1 });
  assert.equal((await f.state()).profile, null);
  f.storage.set('device', device);
  await f.request('/clear-recipient', {});
  assert.equal((await f.state()).profile, null);
  assert.equal(f.storage.has('profile'), false);
});

test('old agents clear obsolete summaries without breaking protocol 3 verification', async () => {
  const f = fixture();
  await f.finish(await f.start(), envelope(summary));
  const result = await f.finish(await f.start(), envelope(undefined));
  assert.equal(result.ok, true);
  assert.equal((await f.state()).profile, null);
  assert.equal((await f.state()).profileUpdatedAt, null);
  await f.finish(await f.start(), envelope({ nickname: null, avatarUrl: null, balance: null }));
  assert.deepEqual((await f.state()).profile, { nickname: null, avatarUrl: null, balance: null });
  assert.ok((await f.state()).profileUpdatedAt);
});

test('ordinary payment preflight does not erase or refresh the admin profile snapshot', async () => {
  const f = fixture();
  await f.finish(await f.start(), envelope(summary));
  const before = await f.state();
  await f.finish(await f.start(false, 'fixed', false), envelope(undefined));
  const after = await f.state();
  assert.deepEqual(after.profile, summary);
  assert.equal(after.profileUpdatedAt, before.profileUpdatedAt);
  assert.equal(f.jobs.at(-1).includeProfile, undefined);
});

test('failed account checks and revocation clear a previously verified summary', async () => {
  const f = fixture();
  await f.finish(await f.start(), envelope(summary));
  const result = await f.finish(await f.start(), envelope(summary, 'another-account'));
  assert.equal(result.code, 'ACCOUNT_MISMATCH');
  assert.equal((await f.state()).profile, null);
  await f.finish(await f.start(), envelope(summary));
  await f.request('/revoke', {});
  assert.equal(f.storage.has('profile'), false);
  assert.equal((await f.state()).profile, null);
});

test('a profile response cannot attach to a replacement device or a cleared recipient', async () => {
  const f = fixture();
  const entry = await f.start();
  f.storage.set('device', { ...f.storage.get('device'), id: 'replacement' });
  assert.equal((await f.finish(entry, envelope(summary))).code, 'AGENT_OFFLINE');
  assert.equal((await f.state()).profile, null);
  const cleared = await f.start();
  await f.request('/clear-recipient', {});
  assert.equal((await f.finish(cleared, envelope(summary))).code, 'ACCOUNT_MISMATCH');
  assert.equal((await f.state()).profile, null);
});

test('admin profile refresh requires Access and same-origin POST; public config exposes no summary', async (t) => {
  const issuer = 'https://browser-profile-fixture.cloudflareaccess.com';
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'browser-profile-fixture' };
  t.mock.method(globalThis, 'fetch', async (url) => { assert.equal(url, `${issuer}/cdn-cgi/access/certs`); return Response.json({ keys: [jwk] }); });
  const token = await new SignJWT({ email: 'owner@example.invalid' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setAudience('profile-admin').setSubject('owner').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const jobs = [];
  const env = {
    ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: 'profile-admin', ADMIN_EMAILS: 'owner@example.invalid',
    PUBLIC_PAYMENT_TRANSPORT: 'agent', PAYMENTS_ENABLED: 'true', ORDER_TOKEN_SECRET: 's'.repeat(40),
    DB: { prepare: (sql) => ({ bind() { return this; }, async first() { return sql.includes('rate_limits') ? { count: 1 } : { turnstile_enabled: 0 }; }, async run() { return { meta: { changes: 1 } }; } }) },
    AGENT_RELAY: { idFromName: () => 'fixed', get: () => ({ fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/status') return Response.json({ configured: true, online: true, receivingAccountId: 'current-recipient', paymentProtocol: 3, profile: summary, profileUpdatedAt: '2026-11-07T00:00:00.000Z' });
      assert.equal(path, '/execute'); const job = await request.json(); jobs.push(job);
      return Response.json(envelope(summary, 'current-recipient'));
    } }) }
  };
  const headers = { 'Cf-Access-Jwt-Assertion': token, 'X-Feedfish-Admin': '1', 'Content-Type': 'application/json', Origin: 'https://feedfish.example' };
  const post = (changes = {}) => worker.fetch(new Request('https://feedfish.example/api/admin/account/check', { method: 'POST', headers: { ...headers, ...changes }, body: JSON.stringify({ transport: 'agent' }) }), env);
  assert.equal((await post({ 'Cf-Access-Jwt-Assertion': '' })).status, 403);
  assert.equal((await post({ Origin: 'https://foreign.example' })).status, 403);
  assert.equal(jobs.length, 0);
  const checked = await post();
  assert.equal(checked.status, 200, await checked.clone().text());
  assert.equal(checked.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await checked.json(), { ok: true, profile: summary, profileUpdatedAt: '2026-11-07T00:00:00.000Z' });
  assert.deepEqual(jobs.map(({ operation, accountId }) => ({ operation, accountId })), [{ operation: 'profile', accountId: 'current-recipient' }]);
  assert.equal(jobs[0].includeProfile, true);
  const config = await (await worker.fetch(new Request('https://feedfish.example/api/config'), env)).json();
  assert.equal(config.paymentsAvailable, true);
  assert.doesNotMatch(JSON.stringify(config), /小鱼|13\.14|current-recipient|profileUpdatedAt|avatarUrl/);
  const deniedStatus = await worker.fetch(new Request('https://feedfish.example/api/admin/browser-agent/status'), env);
  assert.equal(deniedStatus.status, 403);
});
