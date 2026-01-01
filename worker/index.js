import { ApiError, parseAmount, formatAmount, validateOrder, isDemo, hash, accessToken, publicOrder, assertOrigin, readJson, readTurnstileSettings, verifyTurnstile } from './lib.js';
import { providerReady, createPayment, queryPaymentInvoice } from './provider.js';
import { handleAdmin } from './admin.js';
import { AGENT_CHECK_INTERVAL, applyPaymentResult, reconcileOrder, reconcileScheduled } from './reconcile.js';
import { cleanupBrowserLogin } from './browser-login.js';
import { cleanupAuthorization } from './authorization.js';
import { cleanupPendingAuthorization } from './pending-authorization.js';
import { handleAgentPublic, agentRequest } from './browser-agent.js';
import { maxPaymentAmount, PAYMENT_PROTOCOL } from '../shared/agent-payment-protocol.js';
export { BrowserAgentRelay } from './browser-agent-relay.js';

const localSecret = 'feedfish-local-demo-not-valid-in-production';
const secretFor = (env, demo) => demo ? localSecret : env.ORDER_TOKEN_SECRET;
async function paymentConfig(env, demo) {
  const paymentMethods = demo ? ['wechat', 'alipay'] : (env.PUBLIC_PAYMENT_METHODS || 'wechat,alipay').split(',').map((value) => value.trim()).filter((value, index, all) => ['wechat', 'alipay'].includes(value) && all.indexOf(value) === index);
  const { turnstileEnabled, turnstileConfigured } = await readTurnstileSettings(env, demo);
  const config = { currency: 'CNY', minAmount: '1.00', maxAmount: '100000.00', amountStep: '1.00', turnstileEnabled, turnstileSiteKey: turnstileEnabled ? env.TURNSTILE_SITE_KEY || '' : '', demo, paymentMethods, paymentsEnabled: demo || env.PAYMENTS_ENABLED === 'true', paymentsAvailable: demo };
  let accountId = demo ? null : env.DEEPSEEK_ACCOUNT_ID || null;
  if (demo || !config.paymentsEnabled || !paymentMethods.length || env.ORDER_TOKEN_SECRET?.length < 32 || !env.ORDER_TOKEN_SECRET || (turnstileEnabled && !turnstileConfigured)) return { config, accountId };
  if (env.PUBLIC_PAYMENT_TRANSPORT === 'agent') {
    try {
      const response = await agentRequest(env, '/status'); const status = response.ok ? await response.json() : {};
      const limit = maxPaymentAmount(status.paymentProtocol);
      accountId = status.receivingAccountId || null;
      config.maxAmount = formatAmount(limit || 10000000);
      const canUseAccount = status.paymentProtocol === PAYMENT_PROTOCOL || accountId === env.DEEPSEEK_ACCOUNT_ID;
      config.paymentsAvailable = !!accountId && canUseAccount && status.configured === true && status.online === true && limit > 0;
    } catch { /* Offline/unconfigured executors fail closed without creating a bill. */ }
  } else if (!env.PUBLIC_PAYMENT_TRANSPORT || env.PUBLIC_PAYMENT_TRANSPORT === 'worker') config.paymentsAvailable = await providerReady(env);
  return { config, accountId };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(status === 429 ? { 'Retry-After': '60' } : {}) } });
}
async function rateLimit(request, env, name, limit, demo, orderId) {
  const subject = orderId || request.headers.get('CF-Connecting-IP') || (demo ? 'local' : 'unknown');
  const now = Date.now(); const bucket = `${name}:${Math.floor(now / 60000)}:${await hash(subject)}`;
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
  const { config, accountId } = await paymentConfig(env, demo);
  if (!config.paymentsEnabled) throw new ApiError(503, 'PAYMENTS_UNAVAILABLE', '收款暂未开放，请晚一点再来。');
  await rateLimit(request, env, 'create', 6, demo);
  const key = request.headers.get('Idempotency-Key') || '';
  if (!uuid.test(key)) throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', '请求标识无效，请刷新后重试。');
  const body = await readJson(request); const input = validateOrder(body);
  const keyHash = await hash(key); const fingerprint = await hash(JSON.stringify(input));
  let existing = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_hash=?').bind(keyHash).first();
  const transport = !demo && env.PUBLIC_PAYMENT_TRANSPORT === 'agent' ? 'agent' : 'worker';
  const sameRecipient = transport !== 'agent' || existing?.provider_account_id === accountId;
  const canRetry = existing && existing.request_hash === fingerprint && existing.status === 'failed' && existing.is_demo === 0 && existing.provider_transport === transport && sameRecipient && !existing.provider_order_id && !existing.provider_status && !existing.qr_code;
  if (existing && !canRetry) return existingResponse(existing, fingerprint, env, demo);
  if (!config.paymentsAvailable) throw new ApiError(503, 'PAYMENTS_UNAVAILABLE', '收款暂时不可用，请稍后重试。');
  if (!config.paymentMethods.includes(input.paymentMethod)) throw new ApiError(409, 'METHOD_UNAVAILABLE', '此支付方式暂未开放，请选择可用方式。');
  if (input.amountFen > parseAmount(config.maxAmount)) throw new ApiError(400, 'INVALID_AMOUNT', `当前支持 ${config.minAmount}–${config.maxAmount} CNY。`);
  if (config.turnstileEnabled) await verifyTurnstile(request, env, body.turnstileToken);
  const now = Date.now(); const id = canRetry ? existing.id : crypto.randomUUID(); const token = await accessToken(id, secretFor(env, demo));
  const insert = canRetry
    ? await env.DB.prepare("UPDATE orders SET status='creating',payment_state='creating',last_check_error=NULL,expires_at=? WHERE id=? AND status='failed' AND provider_order_id IS NULL AND provider_status IS NULL AND qr_code IS NULL").bind(now + 900000, id).run()
    : await env.DB.prepare('INSERT OR IGNORE INTO orders (id,idempotency_hash,request_hash,token_hash,amount_fen,payment_method,nickname,message,status,payment_state,is_demo,created_at,expires_at,provider_transport,provider_account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, keyHash, fingerprint, await hash(token), input.amountFen, input.paymentMethod, input.nickname, input.message, 'creating', 'creating', demo ? 1 : 0, now, now + 900000, transport, accountId).run();
  if (!insert.meta.changes) { existing = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_hash=?').bind(keyHash).first(); return existingResponse(existing, fingerprint, env, demo); }
  try {
    const payment = demo ? { providerOrderId: `demo-${id}`, qrCode: `feedfish-demo:${id}`, expiresAt: now + 1800000 } : await createPayment(transport === 'agent' ? { ...env, PAYMENT_TRANSPORT: 'agent', DEEPSEEK_ACCOUNT_ID: accountId } : env, { ...input, requestId: id });
    await env.DB.prepare('UPDATE orders SET status=?,payment_state=?,provider_order_id=?,qr_code=?,payment_url=?,expires_at=? WHERE id=? AND status=?').bind('pending', 'waiting', payment.providerOrderId, payment.qrCode, payment.paymentUrl || null, payment.expiresAt, id, 'creating').run();
  } catch (error) {
    // A timed-out create may have reached the provider. Never retry it automatically.
    const status = error.creationAttempted === false ? 'failed' : 'unknown';
    await env.DB.prepare('UPDATE orders SET status=?,payment_state=?,last_check_error=? WHERE id=? AND status=?').bind(status, status, error instanceof ApiError ? error.code : 'UPSTREAM_UNAVAILABLE', id, 'creating').run();
    if (transport === 'agent') throw new ApiError(503, status === 'failed' ? 'PAYMENT_NOT_READY' : 'ORDER_UNCERTAIN', status === 'failed' ? '暂时无法生成付款码，请稍后重试。' : '暂未确认付款码是否生成。请重试同一请求或联系收款人核对，避免重复下单。');
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
async function getOrder(request, env, ctx, id, demo) {
  await rateLimit(request, env, 'query', 60, demo);
  let row = await loadOrder(request, env, id, demo);
  if (row.status !== 'pending') return json(publicOrder(row));
  if (row.provider_transport === 'agent') {
    const now = Date.now();
    if (row.provider_order_id && row.expires_at + 60000 > now && row.last_checked_at <= now - AGENT_CHECK_INTERVAL && ctx?.waitUntil) {
      ctx.waitUntil(reconcileOrder(env, row).catch(() => {}));
    }
  } else {
    await reconcileOrder(env, row);
    row = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
  }
  return json(publicOrder(row));
}

async function checkOrder(request, env, id, demo) {
  assertOrigin(request, demo);
  let row = await loadOrder(request, env, id, demo);
  if (row.status !== 'pending') return json(publicOrder(row));
  await rateLimit(request, env, 'manual-check', 15, demo, id);
  try {
    if (row.provider_transport === 'agent') {
      const result = await queryPaymentInvoice(env, row);
      if (result) {
        row = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
        await applyPaymentResult(env, row, result, 'poll');
      }
    } else await reconcileOrder(env, row);
  } catch (error) {
    if (error?.code === 'AGENT_BUSY') throw new ApiError(503, 'PAYMENT_CHECK_BUSY', '正在核对其他付款，请稍后再试。');
    throw new ApiError(503, 'PAYMENT_CHECK_UNAVAILABLE', '暂时无法核对付款，请稍后再试。');
  }
  return json(publicOrder(await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first()));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url); const demo = isDemo(request, env);
    try {
      if (url.pathname.startsWith('/api/browser-agent/')) return await handleAgentPublic(request, env);
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/') || url.pathname.startsWith('/api/admin/')) return await handleAdmin(request, env);
      if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
      if (url.pathname === '/api/config' && request.method === 'GET') return json((await paymentConfig(env, demo)).config);
      const creatingOrder = url.pathname === '/api/orders' && request.method === 'POST';
      if (creatingOrder && url.searchParams.get('debug') === '1') {
        throw new ApiError(400, 'DEBUG_ORDER_DISABLED', '调试模式不会创建真实订单。');
      }
      if (!env.DB) throw new ApiError(503, 'DATABASE_UNAVAILABLE', '服务暂未就绪，请稍后再试。');
      if (Math.random() < 0.02 && ctx?.waitUntil) ctx.waitUntil(env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(Date.now()).run().catch(() => {}));
      if (creatingOrder) return await createOrder(request, env, demo);
      const match = url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})(\/(?:demo-pay|check))?$/);
      if (match && uuid.test(match[1])) {
        if (!match[2] && request.method === 'GET') return await getOrder(request, env, ctx, match[1], demo);
        if (match[2] === '/check' && request.method === 'POST') return await checkOrder(request, env, match[1], demo);
        if (match[2] === '/demo-pay' && request.method === 'POST' && demo) {
          assertOrigin(request, demo); const row = await loadOrder(request, env, match[1], demo);
          if (row.status !== 'pending' || row.expires_at <= Date.now()) throw new ApiError(409, 'ORDER_CLOSED', '该演示订单已关闭。');
          await applyPaymentResult(env, row, { status: 'paid', providerStatus: 'SUCCESS' }, 'demo');
          return json({ ok: true });
        }
      }
      throw new ApiError(404, 'NOT_FOUND', '页面不存在。');
    } catch (error) {
      // Never log request bodies, private messages, tokens, or raw upstream responses.
      return json({ error: { code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR', message: error instanceof ApiError ? error.message : '服务暂不可用，请稍后再试。' } }, error instanceof ApiError ? error.status : 500);
    }
  },
  async scheduled(_controller, env, ctx) { ctx.waitUntil(Promise.allSettled([reconcileScheduled(env), cleanupBrowserLogin(env), cleanupAuthorization(env), cleanupPendingAuthorization(env)])); }
};
