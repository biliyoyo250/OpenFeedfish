import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const adminOrigin = 'https://feedfish.example';
const responseHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };
export async function createReceiver({ state = randomBytes(32).toString('base64url'), ttlMs = 600000 } = {}) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error('Invalid receiver state');
  let origin, consumed = false;
  const expiresAt = Date.now() + ttlMs;
  const server = createServer((request, response) => {
    const reply = (status, body = '', extra = {}) => { response.writeHead(status, { ...responseHeaders, 'Content-Type': 'text/html; charset=utf-8', ...extra }); response.end(body); };
    if (request.headers.host !== new URL(origin).host) return reply(403);
    let url;
    try { url = new URL(request.url, origin); } catch { return reply(400); }
    if (url.origin !== origin) return reply(403);
    if (Date.now() >= expiresAt || consumed) return reply(410, '本次连接已结束。');
    if (request.method === 'GET' && url.pathname === '/') return reply(200, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接固定账户</title><style>body{font:16px system-ui;max-width:520px;margin:12vh auto;padding:24px;line-height:1.7}button{font:inherit;padding:12px 24px;border:0;border-radius:24px;background:#315da8;color:white}</style><h1>连接固定账户</h1><p>本机接收器只转交一次授权码，不读取 Cookie，不接触账户令牌。账户核验与令牌保存由 Cloudflare 完成。</p><form method="post" action="/start"><button>前往受保护的管理后台</button></form>');
    if (request.method === 'POST' && url.pathname === '/start') {
      request.resume();
      if (request.headers.origin !== origin) return reply(403);
      const fragment = new URLSearchParams({ connect_port: new URL(origin).port, connect_state: state });
      return reply(303, '', { Location: `${adminOrigin}/admin#${fragment}` });
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
    process.stdout.write('在可信设备运行 npm run connect-account，打开输出的本机地址。接收器只转交一次 PKCE 授权码，10 分钟后自动退出。\n');
  } else {
    try {
      const receiver = await createReceiver();
      process.stdout.write(`本机连接地址：${receiver.receiverUrl}\n只转交一次授权码，不读取 Cookie 或已有凭证；10 分钟后自动退出。\n`);
      process.once('SIGINT', () => { receiver.server.close(); });
    } catch { process.stderr.write('无法启动本机接收器，请确认 Node.js 可用后重试。\n'); process.exitCode = 1; }
  }
}
