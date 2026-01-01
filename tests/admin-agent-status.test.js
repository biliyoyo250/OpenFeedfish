import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentStatusWatcher } from '../frontend/admin-agent-status.js';

function clock() {
  const jobs = new Map(); let time = 0; let id = 0;
  return { now: () => time, schedule: (fn, delay) => { jobs.set(++id, { fn, delay }); return id; }, cancel: (key) => jobs.delete(key), pending: () => jobs.size, async next() { const [key, job] = jobs.entries().next().value; jobs.delete(key); time += job.delay; job.fn(); await Promise.resolve(); await Promise.resolve(); } };
}

test('a delayed browser startup updates the initial offline result without another click', async () => {
  const timers = clock(); const statuses = []; let requests = 0;
  const watch = createAgentStatusWatcher({ ...timers, load: async () => ({ configured: true, online: ++requests >= 3 }), onStatus: (data) => statuses.push(data.online), onError: assert.fail });
  await watch.start(); assert.deepEqual(statuses, [false]);
  await timers.next(); await timers.next();
  assert.deepEqual(statuses, [false, false, true]); assert.equal(timers.pending(), 0);
});

test('a late older response cannot overwrite a newer online status or restart polling', async () => {
  const timers = clock(); const statuses = []; let resolveOld; let count = 0;
  const watch = createAgentStatusWatcher({ ...timers, load: () => ++count === 1 ? new Promise((r) => { resolveOld = r; }) : Promise.resolve({ configured: true, online: true }), onStatus: (data) => statuses.push(data.online), onError: assert.fail });
  const first = watch.start(); await watch.start();
  resolveOld({ configured: true, online: false }); await first;
  assert.deepEqual(statuses, [true]); assert.equal(timers.pending(), 0);
});

test('offline waiting is bounded and stops after hiding the page, an error, or no paired device', async () => {
  const timers = clock(); let timeouts = 0; let requests = 0; let visible = true; const errors = [];
  const watch = createAgentStatusWatcher({ ...timers, interval: 10, duration: 20, visible: () => visible, load: async () => { requests++; return { configured: true, online: false }; }, onStatus: () => {}, onError: (e) => errors.push(e.message), onTimeout: () => timeouts++ });
  await watch.start(); await timers.next(); await timers.next();
  assert.equal(requests, 3); assert.equal(timeouts, 1); assert.equal(timers.pending(), 0);
  await watch.start(); visible = false; watch.stop(); assert.equal(timers.pending(), 0);
  const denied = createAgentStatusWatcher({ ...timers, load: async () => { throw new Error('Access expired'); }, onStatus: assert.fail, onError: (e) => errors.push(e.message) });
  await denied.start(); assert.deepEqual(errors, ['Access expired']); assert.equal(timers.pending(), 0);
  const unpaired = createAgentStatusWatcher({ ...timers, load: async () => ({ configured: false, online: false }), onStatus: () => {}, onError: assert.fail });
  await unpaired.start(); assert.equal(timers.pending(), 0);
});

test('payment status watching reads until confirmed success, then stops without creating or checking an upstream order', async () => {
  const timers = clock(); const states = ['waiting', 'processing', 'paid']; const observed = [];
  const watch = createAgentStatusWatcher({ ...timers, interval: 3000, load: async () => ({ status: states.length > 1 ? 'pending' : 'paid', paymentState: states.shift() }), keepWaiting: (order) => order.status === 'pending', onStatus: async (order) => { observed.push(order.paymentState); }, onError: assert.fail });
  await watch.start(); await timers.next(); await timers.next();
  assert.deepEqual(observed, ['waiting', 'processing', 'paid']); assert.equal(timers.pending(), 0);
});

test('stopping during asynchronous status rendering cannot restart a stale payment watcher', async () => {
  const timers = clock(); let finishRender;
  const watch = createAgentStatusWatcher({ ...timers, load: async () => ({ status: 'pending' }), keepWaiting: () => true, onStatus: () => new Promise((resolve) => { finishRender = resolve; }), onError: assert.fail });
  const waiting = watch.start(); await Promise.resolve();
  watch.stop(); finishRender(); await waiting;
  assert.equal(timers.pending(), 0);
});
