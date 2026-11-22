import { ApiError, publicOrder, validateOrder } from '../worker/lib.js';

const paymentUrl = 'https://example.com/';
const accessToken = 'debug-checkout';
const debugConfig = {
  currency: 'CNY',
  minAmount: '1.00',
  maxAmount: '100000.00',
  demo: false,
  paymentsEnabled: true,
  paymentsAvailable: true,
  paymentMethods: ['wechat', 'alipay'],
};

export function createDebugCheckout(saved, { readOwner } = {}) {
  const expiresAt = Date.parse(saved?.expiresAt);
  let row = saved?.accessToken === accessToken && Number.isFinite(expiresAt) ? {
    id: saved.id,
    amount_fen: Math.round(Number(saved.amount) * 100),
    payment_method: saved.paymentMethod,
    status: saved.status,
    payment_state: saved.paymentState,
    expires_at: expiresAt,
    qr_code: paymentUrl,
    payment_url: saved.paymentMethod === 'alipay' ? paymentUrl : null,
  } : null;

  async function fetch(path, { method = 'GET', body, headers } = {}) {
    if (method === 'GET' && path === '/api/config') {
      let owner;
      try { owner = await readOwner?.(); } catch { /* Debug checkout also works when the public profile cannot be read. */ }
      return Response.json({ ...debugConfig, owner });
    }
    if (method === 'POST' && path === '/api/orders') {
      try {
        const { amountFen, paymentMethod } = validateOrder(JSON.parse(body));
        row = {
          id: crypto.randomUUID(),
          amount_fen: amountFen,
          payment_method: paymentMethod,
          status: 'pending',
          payment_state: 'waiting',
          expires_at: Date.now() + 15 * 60 * 1000,
          qr_code: paymentUrl,
          payment_url: paymentMethod === 'alipay' ? paymentUrl : null,
        };
        return Response.json({ ...publicOrder(row), accessToken }, { status: 201 });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
      }
    }

    const orderPath = `/api/orders/${row?.id}`;
    const query = (method === 'GET' && path === orderPath) || (method === 'POST' && path === `${orderPath}/check`);
    const pay = method === 'POST' && path === `${orderPath}/demo-pay`;
    if (!row || (!query && !pay) || headers?.Authorization !== `Bearer ${accessToken}`) {
      return Response.json({ error: { code: 'NOT_FOUND', message: '无法读取这笔订单。' } }, { status: 404 });
    }
    if (row.status === 'pending' && row.expires_at <= Date.now()) row.status = row.payment_state = 'expired';
    if (pay) {
      if (row.status !== 'pending') return Response.json({ error: { code: 'ORDER_CLOSED', message: '这笔订单已关闭。' } }, { status: 409 });
      row.status = row.payment_state = 'paid';
      return Response.json({ ok: true });
    }
    return Response.json(publicOrder(row));
  }

  function expire() {
    if (row?.status === 'pending') row.expires_at = Date.now();
  }

  return { fetch, expire, paymentUrl };
}
