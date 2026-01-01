const debugConfig = {
  currency: 'CNY',
  minAmount: '1.00',
  maxAmount: '100000.00',
  demo: true,
  paymentsAvailable: true,
  paymentMethods: ['wechat', 'alipay'],
};

export function createDebugCheckout() {
  let order;

  function complete(status) {
    order = { ...order, status, paymentState: status, qrCode: null };
    return { ...order };
  }

  function expire() {
    if (order?.status === 'pending') {
      order.expiresAt = new Date().toISOString();
      return complete('expired');
    }
    return { ...order };
  }

  function request(path, { method = 'GET', body } = {}) {
    if (method === 'GET' && path === '/api/config') return debugConfig;
    if (method === 'POST' && path === '/api/orders') {
      const { amount, paymentMethod } = JSON.parse(body);
      const id = crypto.randomUUID();
      order = {
        id,
        amount: Number(amount).toFixed(2),
        currency: 'CNY',
        paymentMethod,
        status: 'pending',
        paymentState: 'waiting',
        qrCode: 'https://example.com/',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      };
      return { ...order };
    }

    const orderPath = `/api/orders/${order?.id}`;
    const query = (method === 'GET' && path === orderPath) || (method === 'POST' && path === `${orderPath}/check`);
    const pay = method === 'POST' && path === `${orderPath}/demo-pay`;
    if (!order || (!query && !pay)) throw new Error('调试模式不支持此操作。');
    if (order.status === 'pending' && Date.parse(order.expiresAt) <= Date.now()) return complete('expired');
    if (pay && order.status === 'pending') return complete('paid');
    return { ...order };
  }

  return { request, expire };
}
