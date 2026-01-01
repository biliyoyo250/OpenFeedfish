import { ApiError, validateOrder, hash, accessToken, publicOrder } from './lib.js';
import { createPayment } from './provider.js';

// Receives requests after the admin route's Access, Origin, JSON and rate checks.
export async function createAdminTestPayment(env, identity, body, fetcher = fetch) {
  if (!env.DEEPSEEK_ACCOUNT_ID || env.ORDER_TOKEN_SECRET?.length < 32 || !env.ORDER_TOKEN_SECRET) throw new ApiError(503, 'ACCOUNT_NOT_CONFIGURED', '请先固定收款账户并配置订单密钥。');
  if (typeof body.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', '测试请求标识无效。');
  const input = validateOrder({ amount: '1', paymentMethod: body.paymentMethod, nickname: '通道测试', message: '管理员验证支付通道' });
  const key = await hash(`admin-test:${identity.sub}:${body.requestId}`);
  const fingerprint = await hash(input.paymentMethod);
  const existing = async () => {
    const row = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_hash=?').bind(key).first();
    if (!row) return null;
    if (row.request_hash !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '此测试请求的支付方式已改变。');
    if (row.status === 'creating' || row.status === 'unknown') throw new ApiError(409, 'ORDER_UNCERTAIN', '这笔测试账单尚未确认，请先核对已有账单。');
    if (row.status === 'failed') throw new ApiError(503, 'PAYMENT_TEST_FAILED', '这笔测试账单未能创建，请核对后台记录。');
    return publicOrder(row);
  };
  const previous = await existing(); if (previous) return previous;
  const now = Date.now(), id = crypto.randomUUID();
  const tokenHash = await hash(await accessToken(id, env.ORDER_TOKEN_SECRET));
  const inserted = await env.DB.prepare('INSERT OR IGNORE INTO orders (id,idempotency_hash,request_hash,token_hash,amount_fen,payment_method,nickname,message,status,payment_state,is_demo,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, key, fingerprint, tokenHash, 100, input.paymentMethod, input.nickname, input.message, 'creating', 'creating', 0, now, now + 900000).run();
  if (!inserted.meta.changes) return existing();
  try {
    const payment = await createPayment(env, { ...input, requestId: id }, fetcher);
    await env.DB.prepare('UPDATE orders SET status=?,payment_state=?,provider_order_id=?,qr_code=?,payment_url=?,expires_at=? WHERE id=? AND status=?').bind('pending', 'waiting', payment.providerOrderId, payment.qrCode, payment.paymentUrl || null, payment.expiresAt, id, 'creating').run();
  } catch (error) {
    const status = error.creationAttempted === false ? 'failed' : 'unknown';
    await env.DB.prepare('UPDATE orders SET status=?,payment_state=?,last_check_error=? WHERE id=? AND status=?').bind(status, status, error instanceof ApiError ? error.code : 'UPSTREAM_UNAVAILABLE', id, 'creating').run();
    throw error;
  }
  return publicOrder(await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first());
}
