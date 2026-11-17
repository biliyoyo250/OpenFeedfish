import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const responseHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };
export async function createReceiver({ serverUrl = process.env.FEEDFISH_SERVER, state = randomBytes(32).toString('base64url'), ttlMs = 600000 } = {}) {
  let adminUrl;
  try { adminUrl = new URL(serverUrl); } catch { throw new Error('INVALID_SERVER'); }
  const loopback = adminUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(adminUrl.hostname);
  if (adminUrl.username || adminUrl.password || adminUrl.pathname !== '/' || adminUrl.search || adminUrl.hash || (adminUrl.protocol !== 'https:' && !loopback)) throw new Error('INVALID_SERVER');
  const adminOrigin = adminUrl.origin;
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error('Invalid receiver state');
  let origin, consumed = false;
  const expiresAt = Date.now() + ttlMs;
  const server = createServer((request, response) => {
    const reply = (status, body = '', extra = {}) => { response.writeHead(status, { ...responseHeaders, 'Content-Type': 'text/html; charset=utf-8', ...extra }); response.end(body); };
    if (request.headers.host !== new URL(origin).host) return reply(403);
    const requestOrigin = request.headers.origin;
    if (requestOrigin && requestOrigin !== 'null' && requestOrigin !== origin && requestOrigin !== 'https://platform.deepseek.com') return reply(403);
    let url;
    try { url = new URL(request.url, origin); } catch { return reply(400); }
    if (url.origin !== origin) return reply(403);
    if (Date.now() >= expiresAt || consumed) return reply(410, '本次连接已结束。');
    if (request.method === 'GET' && url.pathname === '/') {
      const fragment = new URLSearchParams({ connect_port: new URL(origin).port, connect_state: state });
      const link = `${adminOrigin}/admin#${fragment}`.replace(/&/g, '&amp;');
      return reply(200, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>连接 DeepSeek</title><style>body{font:16px system-ui;margin:0;min-height:100vh;display:grid;place-items:center;background:#fbfaff;color:#202124}main{width:min(440px,calc(100% - 48px));padding:40px 0;line-height:1.7}h1{font-size:30px;font-weight:600;margin:0 0 16px}p{margin:0 0 24px;color:#62636b}a{display:inline-block;padding:12px 24px;border-radius:28px;background:#315da8;color:white;text-decoration:none;font-weight:500}a:focus-visible{outline:3px solid #708fcb;outline-offset:4px}.note{font-size:13px;margin:20px 0 0}@media(prefers-color-scheme:dark){body{background:#121318;color:#e4e2e9}p{color:#b8b8c3}a{background:#bac7ff;color:#122655}}</style><main><h1>连接 DeepSeek</h1><p>点击后开始官方授权，完成后自动返回喂鱼后台。</p><a href="${link}">连接 DeepSeek</a><p class="note">连接有效 10 分钟，请保持终端运行。账户凭证由 Cloudflare 核验并加密保存。</p></main></html>`);
    }
    if (request.method === 'GET' && url.pathname === '/oauth/callback') {
      const receivedState = url.searchParams.get('state') || '';
      if (url.searchParams.getAll('state').length !== 1 || Buffer.byteLength(receivedState) !== Buffer.byteLength(state) || !timingSafeEqual(Buffer.from(receivedState), Buffer.from(state))) return reply(400);
      const code = url.searchParams.get('code'), denied = url.searchParams.get('error') === 'access_denied';
      if ((!denied && (url.searchParams.getAll('code').length !== 1 || !code || !/^[\x21-\x7e]{1,2048}$/.test(code))) || (denied && (url.searchParams.has('code') || url.searchParams.getAll('error').length !== 1))) return reply(400);
      consumed = true;
      const fragment = new URLSearchParams({ connect_state: state, ...(denied ? { connect_error: 'access_denied' } : { connect_code: code }) });
      response.once('finish', () => setTimeout(() => server.close(), 300));
      reply(303, '', { Location: `${adminOrigin}/admin#${fragment}` });
      return;
    }
    reply(404);
  });
  server.keepAliveTimeout = 1000;
  server.headersTimeout = 10000;
  server.requestTimeout = 10000;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const timer = setTimeout(() => { server.close(); server.closeAllConnections(); }, ttlMs); timer.unref();
  server.once('close', () => clearTimeout(timer));
  return { server, receiverUrl: `${origin}/`, expiresAt, close: () => new Promise((accept) => server.close(accept)) };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes('--help')) {
    process.stdout.write('先将 FEEDFISH_SERVER 设为站点的 HTTPS 源地址，再运行 npm run connect-account。打开输出的本机地址并点击“连接 DeepSeek”。官方授权完成后自动返回管理后台。接收器只转交一次授权码，10 分钟后自动退出。\n');
  } else {
    try {
      const receiver = await createReceiver();
      process.stdout.write(`本机连接地址：${receiver.receiverUrl}\n请在侧边栏打开并点击“连接 DeepSeek”，官方授权完成后自动返回后台。\n请保持终端运行；接收器只转交一次授权码，不读取 Cookie 或密码，10 分钟后自动退出。\n`);
      process.once('SIGINT', () => { receiver.server.close(); });
    } catch (error) {
      process.stderr.write(error.message === 'INVALID_SERVER' ? '请将 FEEDFISH_SERVER 设为站点的 HTTPS 源地址。\n' : '无法启动本机接收器，请确认 Node.js 可用后重试。\n');
      process.exitCode = 1;
    }
  }
}
