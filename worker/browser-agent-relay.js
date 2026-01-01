import { hash } from './lib.js';
import { browserCommand, accountResult, MAX_FRAME_BYTES, validDeviceKey, validPairCode, validCommandId, AGENT_PROTOCOL } from '../shared/browser-agent-protocol.js';

const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
const send = (ws, value) => { try { ws.send(typeof value === 'string' || value instanceof ArrayBuffer ? value : JSON.stringify(value)); } catch { /* A disconnected peer cannot receive. */ } };
const shut = (ws, code = 1000) => { try { ws.close(code, 'Connection closed'); } catch {} };
const codeFor = () => { const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const bytes = crypto.getRandomValues(new Uint8Array(8)); return [...bytes].map((v) => alphabet[v % alphabet.length]).join('').replace(/^(.{4})/, '$1-'); };

// One object coordinates the fixed account, not a generic browser proxy. Its
// durable storage contains pairing metadata and hashes, never frames or input.
export class BrowserAgentRelay {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  sockets(role) { return this.ctx.getWebSockets(role); }
  live(role) {
    return this.sockets(role).filter((ws) => {
      const a = ws.deserializeAttachment();
      if (!a || a.expiresAt <= Date.now()) { shut(ws, 4001); return false; }
      return ws.readyState === 1;
    });
  }
  notifyPresence() { for (const ws of this.live('viewer')) send(ws, { type: 'presence', online: this.live('agent').length === 1 }); }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/init' && request.method === 'POST') return this.ctx.blockConcurrencyWhile(async () => {
      const body = await request.json();
      if (body.protocol !== AGENT_PROTOCOL || typeof body.keyHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.keyHash) || typeof body.name !== 'string' || !/^[\p{L}\p{N} ._()-]{1,48}$/u.test(body.name)) return reply({ error: 'INVALID_PAIRING' }, 400);
      const now = Date.now(); const pending = (await this.ctx.storage.get('pending') || []).filter((p) => p.expiresAt > now);
      if (pending.length >= 4) return reply({ error: 'PAIRING_BUSY' }, 429);
      const pairing = { id: crypto.randomUUID(), code: codeFor(), keyHash: body.keyHash, name: body.name, createdAt: now, expiresAt: now + 300000 };
      pending.push(pairing); await this.ctx.storage.put('pending', pending);
      return reply({ id: pairing.id, code: pairing.code, expiresAt: pairing.expiresAt });
    });
    if (path === '/pair-status' && request.method === 'POST') {
      const body = await request.json(); const keyHash = await this.keyHash(request);
      if (!keyHash || !validCommandId(body.id)) return reply({ error: 'PAIRING_DENIED' }, 403);
      const active = await this.ctx.storage.get('device');
      if (active?.id === body.id && active.keyHash === keyHash && active.expiresAt > Date.now()) return reply({ approved: true, expiresAt: active.expiresAt });
      const pending = (await this.ctx.storage.get('pending') || []).find((p) => p.id === body.id && p.keyHash === keyHash && p.expiresAt > Date.now());
      return pending ? reply({ approved: false }) : reply({ error: 'PAIRING_EXPIRED' }, 410);
    }
    if (path === '/status') {
      const device = await this.ctx.storage.get('device');
      const agent = this.live('agent')[0]?.deserializeAttachment();
      return reply({ configured: !!device && device.expiresAt > Date.now(), online: !!agent && agent.lastSeen > Date.now() - 45000, name: device?.name || null, expiresAt: device?.expiresAt || null, controlling: this.live('viewer').length > 0 });
    }
    if (path === '/approve' && request.method === 'POST') return this.ctx.blockConcurrencyWhile(async () => {
      const body = await request.json();
      if (!validPairCode(body.code)) return reply({ error: 'INVALID_PAIRING' }, 400);
      const pending = (await this.ctx.storage.get('pending') || []).filter((p) => p.expiresAt > Date.now());
      const entry = pending.find((p) => p.code === body.code);
      if (!entry) return reply({ error: 'PAIRING_EXPIRED' }, 410);
      // The authenticated admin explicitly approves replacement in the UI.
      if (await this.ctx.storage.get('device') && body.replace !== true) return reply({ error: 'DEVICE_ALREADY_PAIRED' }, 409);
      for (const ws of this.ctx.getWebSockets()) shut(ws, 4001);
      const device = { id: entry.id, keyHash: entry.keyHash, name: entry.name, expiresAt: Date.now() + 30 * 86400000 };
      await this.ctx.storage.put('device', device); await this.ctx.storage.delete('pending');
      return reply({ ok: true, name: device.name, expiresAt: device.expiresAt });
    });
    if (path === '/revoke' && request.method === 'POST') return this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.delete('device'); await this.ctx.storage.delete('pending');
      for (const ws of this.ctx.getWebSockets()) shut(ws, 4001);
      return reply({ ok: true });
    });
    if (path === '/agent' || path === '/viewer') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return reply({ error: 'WEBSOCKET_REQUIRED' }, 426);
      const role = path === '/agent' ? 'agent' : 'viewer';
      const adminExpiresAt = Number(request.headers.get('X-Agent-Admin-Expires'));
      const device = await this.ctx.storage.get('device');
      if (!device || device.expiresAt <= Date.now()) return reply({ error: 'DEVICE_NOT_PAIRED' }, 403);
      if (role === 'agent' && await this.keyHash(request) !== device.keyHash) return reply({ error: 'DEVICE_DENIED' }, 403);
      if (role === 'viewer' && (!request.headers.get('X-Agent-Admin-Sub') || !Number.isSafeInteger(adminExpiresAt) || adminExpiresAt <= Date.now())) return reply({ error: 'ACCESS_DENIED' }, 403);
      if (role === 'agent') {
        for (const ws of this.live('agent')) {
          if (ws.deserializeAttachment().lastSeen > Date.now() - 45000) return reply({ error: 'DEVICE_BUSY' }, 409);
          shut(ws, 4000);
        }
      } else if (this.live('viewer').length) return reply({ error: 'VIEWER_BUSY' }, 409);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, [role]);
      server.serializeAttachment({ role, expiresAt: Math.min(device.expiresAt, role === 'viewer' ? Math.min(adminExpiresAt, Date.now() + 600000) : device.expiresAt), lastSeen: Date.now(), owner: role === 'viewer' ? request.headers.get('X-Agent-Admin-Sub') : '', bucket: 0, count: 0, framePending: false });
      send(server, { type: 'ready', role, protocol: AGENT_PROTOCOL, ...(role === 'agent' ? { expectedAccountId: this.env.DEEPSEEK_ACCOUNT_ID } : {}) });
      if (role === 'agent') this.notifyPresence();
      const agent = this.live('agent')[0];
      if (agent) send(agent, { type: 'view', active: this.live('viewer').length > 0 });
      return new Response(null, { status: 101, webSocket: client });
    }
    return reply({ error: 'NOT_FOUND' }, 404);
  }
  async keyHash(request) {
    const authorization = request.headers.get('Authorization') || '';
    const key = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    return validDeviceKey(key) ? hash(key) : null;
  }
  async webSocketMessage(ws, raw) {
    const a = ws.deserializeAttachment();
    if (!a || a.expiresAt <= Date.now()) { shut(ws, 4001); return; }
    const now = Date.now(); const bucket = Math.floor(now / 1000);
    a.count = a.bucket === bucket ? a.count + 1 : 1; a.bucket = bucket; a.lastSeen = now;
    if (a.count > (a.role === 'viewer' ? 70 : 20)) { shut(ws, 1008); return; }
    ws.serializeAttachment(a);
    if (raw === 'ping') { send(ws, 'pong'); return; }
    if (raw instanceof ArrayBuffer) {
      const bytes = new Uint8Array(raw);
      if (a.role !== 'agent' || bytes.byteLength > MAX_FRAME_BYTES || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) { shut(ws, 1008); return; }
      for (const viewer of this.live('viewer')) {
        const v = viewer.deserializeAttachment();
        if (!v.framePending) { v.framePending = true; viewer.serializeAttachment(v); send(viewer, raw); }
      }
      return;
    }
    if (typeof raw !== 'string' || raw.length > 8192) { shut(ws, 1008); return; }
    let value; try { value = JSON.parse(raw); } catch { shut(ws, 1008); return; }
    if (a.role === 'viewer') {
      if (value.type === 'frame-ack') {
        a.framePending = false; ws.serializeAttachment(a);
        for (const agent of this.live('agent')) send(agent, { type: 'frame-ack' });
        return;
      }
      let command; try { command = browserCommand(value); } catch { send(ws, { type: 'error', code: 'INVALID_COMMAND' }); return; }
      const agent = this.live('agent')[0];
      if (!agent) { send(ws, { type: 'error', code: 'AGENT_OFFLINE' }); return; }
      send(agent, command);
    } else if (value.type === 'result' && validCommandId(value.id)) {
      const result = value.command === 'check-account' ? accountResult(value.result, this.env.DEEPSEEK_ACCOUNT_ID) : { ok: value.result?.ok === true, ...(value.result?.ok === true ? {} : { code: 'ACTION_FAILED' }) };
      for (const viewer of this.live('viewer')) send(viewer, { type: 'result', id: value.id, command: value.command === 'check-account' ? 'check-account' : 'action', result });
    }
  }
  async webSocketClose(ws, code) {
    shut(ws, code === 1006 ? 1000 : code);
    if (ws.deserializeAttachment()?.role === 'agent') this.notifyPresence();
    else for (const agent of this.live('agent')) send(agent, { type: 'view', active: this.live('viewer').length > 0 });
  }
  async webSocketError(ws) { await this.webSocketClose(ws, 1011); }
}
