import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { browserCommand, accountResult, MAX_FRAME_BYTES, VIEWPORT, AGENT_PROTOCOL, AGENT_CLOSE, validDeviceKey } from '../shared/browser-agent-protocol.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const platform = 'https://platform.deepseek.com';
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const attentionCodes = new Set(['PAIRING_EXPIRED', 'PAIRING_BUSY', 'DEVICE_REVOKED', 'DEVICE_NOT_PAIRED', 'DEVICE_DENIED', 'DEVICE_EXPIRED', 'DEVICE_BUSY', 'EDGE_FORBIDDEN', 'HANDSHAKE_REDIRECT', 'HANDSHAKE_DENIED', 'INVALID_SERVER', 'AGENT_START_FAILED']);
export function handshakeFailure(status, body) {
  let code; try { const value = JSON.parse(body); code = typeof value?.error === 'string' ? value.error : value?.error?.code; } catch {}
  if (status === 403 && ['DEVICE_NOT_PAIRED', 'DEVICE_DENIED', 'DEVICE_EXPIRED'].includes(code)) return code;
  if (status === 403) return 'EDGE_FORBIDDEN';
  if (status === 409 && code === 'DEVICE_BUSY') return 'DEVICE_BUSY';
  if (status >= 300 && status < 400) return 'HANDSHAKE_REDIRECT';
  if (status === 401) return 'HANDSHAKE_DENIED';
  return 'SERVER_UNAVAILABLE';
}
export function closeFailure(code) {
  return code === AGENT_CLOSE.REVOKED ? 'DEVICE_REVOKED' : code === AGENT_CLOSE.DEVICE_EXPIRED ? 'DEVICE_EXPIRED' : null;
}
export function agentFailureMessage(code) {
  if (['DEVICE_REVOKED', 'DEVICE_NOT_PAIRED', 'DEVICE_DENIED', 'DEVICE_EXPIRED'].includes(code)) return `设备配对已解除、失效或被替换（${code}）。请运行 npm run browser-agent -- --pair 并在后台重新配对；浏览器登录资料保留。`;
  if (code === 'DEVICE_BUSY') return '同一设备已有服务连接（DEVICE_BUSY）。请保留一个运行实例，再重启此服务。';
  if (code === 'EDGE_FORBIDDEN') return 'Cloudflare 入口拒绝控制连接（HTTP 403 · EDGE_FORBIDDEN），不能据此判定设备已解除配对。请检查 Worker 入口与网络策略。';
  if (['PAIRING_EXPIRED', 'PAIRING_BUSY'].includes(code)) return `配对未完成（${code}）。准备好后台后运行 npm run browser-agent -- --pair，使用新配对码。`;
  if (['HANDSHAKE_REDIRECT', 'HANDSHAKE_DENIED'].includes(code)) return `控制连接未能鉴权（${code}），请检查 Worker 入口和路由配置。`;
  if (code === 'AGENT_START_FAILED') return '浏览器服务未能启动（AGENT_START_FAILED）。请检查浏览器安装、独立 profile 是否被其他实例占用及系统依赖。首次安装命令为 npm run browser:install。';
  return `浏览器服务未能继续（${code === 'INVALID_SERVER' ? code : 'SERVER_UNAVAILABLE'}），请检查服务地址和网络后重试。`;
}
export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const run = promisify(execFile);
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { windowsHide: true });
    const sid = stdout.trim();
    if (!/^S-1-[0-9-]+$/.test(sid)) throw new Error('PRIVATE_STORAGE_UNAVAILABLE');
    await run('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true });
  } else await chmod(directory, 0o700);
}
export function serverOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('INVALID_SERVER');
  return url.origin;
}

// Runs inside this product's dedicated browser. Only a projected account result
// leaves it; userToken and Cookie are never returned to Node or Cloudflare.
export async function checkBrowserAccount(page, expectedId) {
  if (new URL(page.url()).origin !== platform) return { ok: false, code: 'LOGIN_REQUIRED' };
  const result = await page.evaluate(async () => {
    let token;
    try {
      const raw = localStorage.getItem('userToken');
      if (!raw) return { ok: false, code: 'LOGIN_REQUIRED' };
      try { const value = JSON.parse(raw); token = typeof value === 'string' ? value : value?.value; } catch { token = raw; }
      if (typeof token !== 'string' || !token || token.length > 6000 || /[\r\n\x00]/.test(token)) return { ok: false, code: 'LOGIN_REQUIRED' };
      const response = await fetch('/auth-api/v0/users/current', { credentials: 'same-origin', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(12000) });
      let value; try { value = await response.json(); } catch { return { ok: false, code: 'UPSTREAM_NOT_JSON', httpStatus: response.status }; }
      if (response.status === 401 || value?.code === 40003) return { ok: false, code: 'SESSION_EXPIRED', httpStatus: response.status };
      if (value?.code === 40002) return { ok: false, code: 'AUTH_TOKEN_MISSING', httpStatus: response.status };
      const user = value?.data?.biz_data;
      if (!response.ok || value?.code !== 0 || value?.data?.biz_code !== 0 || typeof user?.id !== 'string') return { ok: false, code: 'ACCOUNT_CHECK_FAILED', httpStatus: response.status };
      return { ok: true, accountId: user.id, currency: user.currency, eligible: user.is_api_banned !== true && user.feature_gates?.PAYMENT !== false };
    } catch { return { ok: false, code: 'UPSTREAM_UNAVAILABLE' }; }
    finally { token = undefined; }
  });
  return accountResult(result, expectedId);
}

export async function executeBrowserCommand(page, input, expectedId) {
  const command = browserCommand(input);
  if (command.type === 'navigate') await page.goto(`${platform}/${command.page}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  else if (command.type === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  else if (command.type === 'check-account') return checkBrowserAccount(page, expectedId);
  else {
    if (new URL(page.url()).origin !== platform) return { ok: false, code: 'ACTION_FAILED' };
    if (command.event === 'down') { await page.mouse.move(command.x, command.y); await page.mouse.down(); }
    if (command.event === 'move') await page.mouse.move(command.x, command.y);
    if (command.event === 'up') { await page.mouse.move(command.x, command.y); await page.mouse.up(); }
    if (command.event === 'key') await page.keyboard.press(command.key);
    if (command.event === 'text') await page.keyboard.insertText(command.text);
    if (command.event === 'wheel') await page.mouse.wheel(0, command.deltaY);
  }
  return { ok: true };
}

async function request(origin, path, body, key) {
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(response.status === 410 ? 'PAIRING_EXPIRED' : response.status === 429 ? 'PAIRING_BUSY' : 'SERVER_UNAVAILABLE');
  const data = await response.json();
  return data;
}

async function pair(origin, directory) {
  const key = randomBytes(32).toString('base64url');
  const name = (process.env.FEEDFISH_AGENT_NAME || hostname()).replace(/[^\p{L}\p{N} ._()-]/gu, '').slice(0, 48) || 'browser-agent';
  const keyHash = createHash('sha256').update(key).digest('hex');
  const result = await request(origin, '/api/browser-agent/pair', { protocol: AGENT_PROTOCOL, name, keyHash });
  if (!result.id || !result.code || !Number.isFinite(result.expiresAt)) throw new Error('PAIRING_FAILED');
  console.log(`在已登录的管理后台配对，核对设备名称 ${name} 和配对码 ${result.code}。`);
  console.log(`${origin}/admin#agent_pair=${result.code}`);
  console.log('配对码有效 5 分钟；浏览器不会自动打开。Ctrl+C 可停止。');
  while (Date.now() < result.expiresAt) {
    const status = await request(origin, '/api/browser-agent/pair-status', { id: result.id }, key);
    if (status.approved === true && Number.isFinite(status.expiresAt)) {
      const device = { origin, key, expiresAt: status.expiresAt };
      await writeFile(join(directory, 'device.json'), JSON.stringify(device), { mode: 0o600 });
      await chmod(join(directory, 'device.json'), 0o600);
      return device;
    }
    await sleep(3000);
  }
  throw new Error('PAIRING_EXPIRED');
}

async function browser(directory) {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(root, '.local', 'playwright');
  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(join(directory, 'profile'), {
    headless: !process.argv.includes('--headed'), channel: process.env.FEEDFISH_BROWSER_CHANNEL || 'chromium',
    ...(process.env.FEEDFISH_BROWSER_EXECUTABLE ? { executablePath: process.env.FEEDFISH_BROWSER_EXECUTABLE } : {}),
    viewport: VIEWPORT, acceptDownloads: false,
  });
  try {
  const page = context.pages()[0] || await context.newPage();
  await context.route('**/*', async (route) => {
    const req = route.request(); let url;
    try { url = new URL(req.url()); } catch { return route.abort(); }
    if (!['https:', 'about:'].includes(url.protocol)) return route.abort();
    if (req.isNavigationRequest() && req.frame() === page.mainFrame() && url.origin !== platform) return route.abort();
    return route.continue();
  });
  for (const other of context.pages()) if (other !== page) await other.close();
  context.on('page', (popup) => { if (popup !== page) void popup.close().catch(() => {}); });
  await page.goto(`${platform}/top_up`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  return { context, page };
  } catch (error) { await context.close().catch(() => {}); throw error; }
}

export async function runAgent() {
  const origin = serverOrigin(process.env.FEEDFISH_SERVER || 'https://feedfish.example');
  const directory = resolve(process.env.FEEDFISH_AGENT_DIR || join(root, '.local', 'browser-agent'));
  await privateDirectory(directory);
  let device;
  if (!process.argv.includes('--pair')) {
    try { const stored = JSON.parse(await readFile(join(directory, 'device.json'), 'utf8')); if (stored.origin === origin && validDeviceKey(stored.key) && stored.expiresAt > Date.now()) device = stored; } catch {}
  }
  device ||= await pair(origin, directory);
  const { context, page } = await browser(directory);
  let cdp;
  try { cdp = await context.newCDPSession(page); } catch (error) { await context.close().catch(() => {}); throw error; }
  let socket; let stopping = false; let viewing = false; let credit = false; let lastFrame = null; let queue = Promise.resolve(); let expectedId; let queued = 0; let frameAt = 0; let pumpTimer;
  const seen = new Set();
  const send = (value) => { if (socket?.readyState === WebSocket.OPEN) socket.send(Buffer.isBuffer(value) ? value : JSON.stringify(value)); };
  const pump = () => {
    if (!viewing || !credit || !lastFrame || socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount >= MAX_FRAME_BYTES) return;
    const remaining = frameAt + 125 - Date.now();
    if (remaining > 0) { clearTimeout(pumpTimer); pumpTimer = setTimeout(pump, remaining); return; }
    send(lastFrame); frameAt = Date.now(); credit = false; lastFrame = null;
  };
  const capture = async () => { try { const frame = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 5000 }); if (frame.length <= MAX_FRAME_BYTES) { lastFrame = frame; pump(); } } catch {} };
  cdp.on('Page.screencastFrame', (frame) => {
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    const data = Buffer.from(frame.data, 'base64');
    if (data.length <= MAX_FRAME_BYTES) { lastFrame = data; pump(); }
  });
  const view = async (active) => {
    viewing = active; credit = active; lastFrame = null; clearTimeout(pumpTimer);
    await page.mouse.up().catch(() => {});
    if (active) { await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 }); await capture(); }
    else await cdp.send('Page.stopScreencast').catch(() => {});
  };
  const close = async () => { stopping = true; socket?.close(); await context.close().catch(() => {}); };
  context.on('close', () => { stopping = true; socket?.close(); });
  process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
  try {
    let attempt = 0;
    while (!stopping && device.expiresAt > Date.now()) {
      let failure = null;
      await new Promise((finished) => {
        socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/browser-agent/connect`, { headers: { Authorization: `Bearer ${device.key}` }, maxPayload: 8192, followRedirects: false, handshakeTimeout: 15000 });
        let lastPong = Date.now();
        const timer = setInterval(() => { if (Date.now() - lastPong > 45000) socket.terminate(); else if (socket.readyState === WebSocket.OPEN) socket.send('ping'); }, 15000);
        socket.on('open', () => { attempt = 0; console.log('浏览器服务已连接。请在 /admin 打开实时窗口。'); });
        socket.on('unexpected-response', (_request, response) => {
          // Only known JSON device errors can establish a pairing failure.
          // Never echo edge HTML, headers, credentials, or upstream messages.
          let body = ''; let oversized = false;
          response.on('data', (chunk) => { if (body.length + chunk.length <= 8192) body += chunk.toString(); else oversized = true; });
          const rejected = () => { failure = handshakeFailure(response.statusCode, oversized ? '' : body); socket.terminate(); };
          response.once('end', rejected); response.once('error', rejected);
        });
        const connection = socket;
        socket.on('message', (bytes) => {
          const raw = bytes.toString(); if (raw === 'pong') { lastPong = Date.now(); return; }
          let message; try { message = JSON.parse(raw); } catch { return; }
          const receivedAt = Date.now();
          if (queued >= 100) return;
          queued++;
          queue = queue.then(async () => {
            if (connection !== socket || connection.readyState !== WebSocket.OPEN) return;
            if (message.type === 'view') return view(message.active === true);
            if (message.type === 'frame-ack') { credit = true; pump(); return; }
            if (message.type === 'ready') { expectedId = message.expectedAccountId; return; }
            if (!viewing) return;
            let command; try { command = browserCommand(message); } catch { return; }
            if (command.type === 'input' && Date.now() - receivedAt > 5000) return;
            if (seen.has(command.id)) return;
            seen.add(command.id); if (seen.size > 512) seen.delete(seen.values().next().value);
            // No action is replayed after a lost response or reconnection.
            let result;
            try { result = await executeBrowserCommand(page, command, expectedId); }
            catch { result = { ok: false, code: command.type === 'check-account' ? 'ACCOUNT_CHECK_FAILED' : 'ACTION_FAILED' }; }
            if (command.type !== 'input') send({ type: 'result', id: command.id, command: command.type, result });
          }).catch(() => { console.log('浏览器操作未完成，请在后台检查当前画面。'); }).finally(() => { queued--; });
        });
        socket.on('error', () => {});
        socket.on('close', (code) => { clearInterval(timer); failure = closeFailure(code) || failure; viewing = false; credit = false; void view(false); finished(); });
      });
      if (attentionCodes.has(failure)) throw new Error(failure);
      if (!stopping) { console.log('控制连接已断开，正在重连；不会重放浏览器操作。'); await sleep(Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5))); }
    }
    if (!stopping && device.expiresAt <= Date.now()) throw new Error('DEVICE_EXPIRED');
  } finally { await close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAgent().catch((error) => {
    const code = attentionCodes.has(error.message) || error.message === 'SERVER_UNAVAILABLE' ? error.message : 'AGENT_START_FAILED';
    console.error(agentFailureMessage(code));
    // Service managers must not turn a required human action into an endless
    // sequence of pairing requests or rejected device handshakes.
    process.exitCode = attentionCodes.has(code) ? 78 : 1;
  });
}
