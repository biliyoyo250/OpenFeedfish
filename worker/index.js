import { ApiError, parseAmount, formatAmount, validateOrder, isDemo, hash, accessToken, publicOrder, assertOrigin, readJson, verifyTurnstile } from './lib.js';
import { providerReady, createPayment, queryPayment } from './provider.js';

const localSecret = 'feedfish-local-demo-not-valid-in-production';
const secretFor = (env, demo) => demo ? localSecret : env.ORDER_TOKEN_SECRET;
const ready = (env, demo) => demo || (env.PAYMENTS_ENABLED === 'true' && env.ORDER_TOKEN_SECRET?.length >= 32 && !!env.TURNSTILE_SITE_KEY && !!env.TURNSTILE_SECRET_KEY && providerReady(env));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(status === 429 ? { 'Retry-After': '60' } : {}) } });
}
async function rateLimit(request, env, name, limit, demo) {
  const ip = request.headers.get('CF-Connecting-IP') || (demo ? 'local' : 'unknown');
  const now = Date.now(); const bucket = `${name}:${Math.floor(now / 60000)}:${await hash(ip)}`;
  const row = await env.DB.prepare('INSERT INTO rate_limits (bucket,count,expires_at) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count').bind(bucket, now + 120000).first();
  if (row.count > limit) throw new ApiError(429, 'RATE_LIMITED', '操作有点频繁，请稍等一分钟。');
}
async function existingResponse(row, fingerprint, env, demo) {
  if (row.request_hash !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '这次请求的内容已变化，请重新填写。');
  if (row.status === 'creating') throw new ApiError(409, 'ORDER_CREATING', '订单正在生成，请稍后重试。');
  if (row.status === 'unknown') throw new ApiError(409, 'ORDER_UNCERTAIN', '暂未确认订单是否创建成功。请联系收款人核对，避免重复下单。');
  return json({ ...publicOrder(row), accessToken: await accessToken(row.id, secretFor(env, demo)) });
}
async function createOrder(request, env, demo) {
  assertOrigin(request, demo);
  if (!ready(env, demo)) throw new ApiError(503, 'PAYMENTS_UNAVAILABLE', '收款暂未开放，请晚一点再来。');
  await rateLimit(request, env, 'create', 6, demo);
  const key = request.headers.get('Idempotency-Key') || '';
  if (!uuid.test(key)) throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', '请求标识无效，请刷新后重试。');
  const body = await readJson(request); const input = validateOrder(body);
  const keyHash = await hash(key); const fingerprint = await hash(JSON.stringify(input));
  let existing = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_hash=?').bind(keyHash).first();
  if (existing) return existingResponse(existing, fingerprint, env, demo);
  if (!demo) await verifyTurnstile(request, env, body.turnstileToken);
  const now = Date.now(); const id = crypto.randomUUID(); const token = await accessToken(id, secretFor(env, demo));
  const insert = await env.DB.prepare('INSERT OR IGNORE INTO orders (id,idempotency_hash,request_hash,token_hash,amount_fen,payment_method,nickname,message,status,is_demo,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, keyHash, fingerprint, await hash(token), input.amountFen, input.paymentMethod, input.nickname, input.message, 'creating', demo ? 1 : 0, now, now + 1800000).run();
  if (!insert.meta.changes) { existing = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_hash=?').bind(keyHash).first(); return existingResponse(existing, fingerprint, env, demo); }
  try {
    const payment = demo ? { providerOrderId: `demo-${id}`, qrCode: `feedfish-demo:${id}`, expiresAt: now + 1800000 } : await createPayment(env, { ...input, requestId: id });
    await env.DB.prepare('UPDATE orders SET status=?,provider_order_id=?,qr_code=?,expires_at=? WHERE id=? AND status=?').bind('pending', payment.providerOrderId, payment.qrCode, payment.expiresAt, id, 'creating').run();
  } catch (error) {
    // A timed-out create may have reached the provider. Never retry it automatically.
    await env.DB.prepare('UPDATE orders SET status=? WHERE id=? AND status=?').bind('unknown', id, 'creating').run();
    throw error instanceof ApiError ? error : new ApiError(503, 'ORDER_UNCERTAIN', '订单暂未确认，请重试同一请求或联系收款人核对。');
  }
  const row = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
  return json({ ...publicOrder(row), accessToken: token }, 201);
}
async function loadOrder(request, env, id, demo) {
  const authorization = request.headers.get('Authorization') || '';
  if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) throw new ApiError(401, 'UNAUTHORIZED', '无法读取这笔订单。');
  const row = await env.DB.prepare('SELECT * FROM orders WHERE id=? AND token_hash=? AND is_demo=?').bind(id, await hash(authorization.slice(7)), demo ? 1 : 0).first();
  if (!row) throw new ApiError(404, 'NOT_FOUND', '无法读取这笔订单。');
  return row;
}
async function getOrder(request, env, id, demo) {
  await rateLimit(request, env, 'query', 60, demo);
  let row = await loadOrder(request, env, id, demo);
  if (row.status === 'pending') {
    const now = Date.now();
    const lease = await env.DB.prepare('UPDATE orders SET last_checked_at=? WHERE id=? AND status=? AND last_checked_at<? RETURNING id').bind(now, id, 'pending', now - 3000).first();
    if (lease) {
      const result = demo ? { status: row.expires_at <= now ? 'expired' : 'pending' } : await queryPayment(env, row);
      if (!['pending', 'paid', 'failed', 'expired'].includes(result.status)) throw new ApiError(502, 'INVALID_PAYMENT_STATUS', '暂时无法确认付款结果。');
      if (result.status !== 'pending') await env.DB.prepare('UPDATE orders SET status=?,paid_at=? WHERE id=? AND status=?').bind(result.status, result.status === 'paid' ? now : null, id, 'pending').run();
      row = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
    }
  }
  return json(publicOrder(row));
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url); const demo = isDemo(request, env);
    try {
      if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
      if (url.pathname === '/api/config' && request.method === 'GET') return json({ currency: 'CNY', minAmount: '1.00', maxAmount: '100000.00', turnstileSiteKey: demo ? '' : env.TURNSTILE_SITE_KEY || '', demo, paymentsAvailable: ready(env, demo) });
      if (!env.DB) throw new ApiError(503, 'DATABASE_UNAVAILABLE', '服务暂未就绪，请稍后再试。');
      if (Math.random() < 0.02 && ctx?.waitUntil) ctx.waitUntil(env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(Date.now()).run().catch(() => {}));
      if (url.pathname === '/api/orders' && request.method === 'POST') return await createOrder(request, env, demo);
      const match = url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})(\/demo-pay)?$/);
      if (match && uuid.test(match[1])) {
        if (!match[2] && request.method === 'GET') return await getOrder(request, env, match[1], demo);
        if (match[2] && request.method === 'POST' && demo) {
          assertOrigin(request, demo); const row = await loadOrder(request, env, match[1], demo);
          if (row.status !== 'pending' || row.expires_at <= Date.now()) throw new ApiError(409, 'ORDER_CLOSED', '该演示订单已关闭。');
          await env.DB.prepare('UPDATE orders SET status=?,paid_at=? WHERE id=? AND status=? AND is_demo=1').bind('paid', Date.now(), row.id, 'pending').run();
          return json({ ok: true });
        }
      }
      throw new ApiError(404, 'NOT_FOUND', '页面不存在。');
    } catch (error) {
      // Never log request bodies, private messages, tokens, or raw upstream responses.
      return json({ error: { code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR', message: error instanceof ApiError ? error.message : '服务暂不可用，请稍后再试。' } }, error instanceof ApiError ? error.status : 500);
    }
  }
};
