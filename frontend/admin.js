const element = (id) => document.getElementById(id);
const fields = element('session-fields');
const form = element('session-form');
const refreshButton = element('refresh-button');
const checkButton = element('check-button');
const disableButton = element('disable-button');
const importButton = element('import-button');
let session = null;
let busy = false;

const accountStates = {
  connected: ['已连接', 'positive', '会话已连接，赞助将充入指定的 DeepSeek 账户。'],
  disabled: ['新订单已停止', 'neutral', '已停止接受新的赞助，已有账单仍由后端继续核对。'],
  unverified: ['待验证', 'warning', '已有会话，但连接尚未验证。请验证连接或更新登录会话。'],
  not_configured: ['未配置', 'neutral', '还没有可用的登录会话，请在下方导入。'],
};
const orderStates = {
  waiting: ['等待付款', 'warning'], processing: ['平台处理中', 'warning'],
  pending: ['等待付款', 'warning'], created: ['等待付款', 'warning'],
  paid: ['已支付', 'positive'], success: ['已支付', 'positive'],
  failed: ['未成功', 'negative'], expired: ['二维码已过期', 'neutral'],
  cancelled: ['已取消', 'neutral'], canceled: ['已取消', 'neutral'],
  refunded: ['已退款', 'neutral'], chargeback: ['已拒付', 'negative'],
  unknown: ['待核对', 'warning'], creating: ['订单生成中', 'warning'],
};

function setNotice(message, error = false) {
  const notice = element('action-notice');
  notice.textContent = message;
  notice.className = error ? 'banner error-banner' : 'banner';
  notice.hidden = !message;
}

function dateLabel(value) {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function updateControls() {
  const writable = Boolean(session && session.demo === false && !busy);
  fields.disabled = !writable;
  importButton.disabled = fields.disabled;
  refreshButton.disabled = !writable;
  checkButton.disabled = !writable || !(session?.account?.configured || session?.account?.status === 'disabled');
  disableButton.disabled = !writable || !session?.account?.configured || session.account.status === 'disabled';
}

function lockAccess() {
  session = null;
  form.reset();
  updateControls();
  element('access-state').textContent = '权限未就绪';
  element('access-error').textContent = '管理入口的 SSO 登录或访问权限尚未就绪。请通过 Cloudflare Access 登录后重新加载此页面，或联系管理员检查访问策略。';
  element('access-error').hidden = false;
  element('account-status').textContent = '未验证身份';
  element('account-status').className = 'status-badge neutral';
  element('account-description').textContent = '确认管理权限后才能查看和维护收款账户。';
  element('expected-account-id').textContent = '—';
  element('updated-at').textContent = '—';
  element('last-checked').textContent = '—';
  element('admin-identity').textContent = 'Cloudflare Access · 管理入口';
  element('orders-body').replaceChildren();
  element('orders-container').hidden = true;
  element('orders-loading').hidden = true;
  element('orders-empty').hidden = true;
}

async function request(path, body) {
  const options = { credentials: 'same-origin', cache: 'no-store', redirect: 'error' };
  if (body !== undefined) {
    options.method = 'POST';
    options.headers = { 'Content-Type': 'application/json', 'X-Feedfish-Admin': '1' };
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error('请求未能完成，请确认网络和管理入口的登录状态后重试。');
  }
  if (response.status === 401 || response.status === 403) {
    lockAccess();
    throw new Error('管理权限尚未就绪，请完成 Cloudflare Access 登录后重新加载页面。');
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('未收到有效的管理响应，请检查管理入口配置后重试。');
  }
  if (!response.ok) {
    const error = new Error(typeof data?.error?.message === 'string' ? data.error.message : '操作未完成，请稍后重试。');
    error.code = data?.error?.code;
    throw error;
  }
  return data;
}

function renderSession(data) {
  if (typeof data?.demo !== 'boolean' || !data.account || typeof data.account.configured !== 'boolean') {
    throw new Error('账户状态暂不可用，请稍后重新加载页面。');
  }
  session = data;
  element('access-error').hidden = true;
  element('demo-notice').hidden = !data.demo;
  element('access-state').textContent = data.demo ? '本地演示' : 'Access 身份已确认';
  element('admin-identity').textContent = data.demo ? '本地后台演示' : `管理员：${data.email || '已验证身份'}`;
  const staged = !data.expectedAccountId && data.account.accountId && !data.demo;
  const state = staged ? ['待固定账户', 'warning', '会话已验证并加密保存。请将此账户 ID 固定到部署配置后再开放收款。'] : accountStates[data.account.status] || accountStates.unverified;
  element('account-status').textContent = state[0];
  element('account-status').className = `status-badge ${state[1]}`;
  element('account-description').textContent = data.demo ? '以下为本地演示信息，不代表真实 DeepSeek 账户连接状态。' : state[2];
  element('expected-account-id').textContent = data.expectedAccountId || data.account.accountId || '尚未导入';
  element('account-id-warning').hidden = Boolean(data.expectedAccountId) || data.demo;
  element('updated-at').textContent = dateLabel(data.account.updatedAt);
  element('last-checked').textContent = dateLabel(data.account.lastCheckedAt);
  updateControls();
}

function textNode(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = String(text ?? '');
  return node;
}

function orderDetails(order) {
  const details = document.createElement('details');
  details.className = 'record-details';
  details.append(textNode('summary', '', '留言与订单编号'));
  details.append(textNode('p', 'record-message', order.message || '没有留下留言'));
  const list = document.createElement('dl');
  for (const [label, value] of [
    ['本站订单号', order.id || '—'],
    ['DeepSeek 订单号', order.providerOrderId || '尚未取得'],
    ['支付渠道订单号', order.channelOrderId || '平台未返回'],
    ['平台原始状态', order.providerStatus || '尚未取得'],
  ]) {
    const item = document.createElement('div');
    item.append(textNode('dt', '', label), textNode('dd', 'mono', value));
    list.append(item);
  }
  details.append(list);
  return details;
}

function renderOrders(orders) {
  const body = element('orders-body');
  const rows = document.createDocumentFragment();
  for (const order of orders.slice(0, 50)) {
    const row = document.createElement('tr');
    const timeCell = document.createElement('td');
    timeCell.append(
      textNode('div', 'order-time', `发起：${dateLabel(order.createdAt)}`),
      textNode('div', 'order-time payment-time', `付款：${order.paidAt ? dateLabel(order.paidAt) : '平台未返回'}`),
      textNode('div', 'confirmation-time', `到账确认：${order.confirmedAt ? dateLabel(order.confirmedAt) : '尚未确认'}`),
    );
    const noteCell = document.createElement('td');
    noteCell.append(textNode('div', 'order-nickname', order.nickname || '匿名的心意'), orderDetails(order));
    const amountCell = document.createElement('td');
    const amount = Number(order.amount);
    const amountLabel = order.currency === 'CNY' && Number.isFinite(amount) ? `¥${amount.toFixed(2)} CNY` : '金额待确认';
    amountCell.append(textNode('div', 'order-amount', amountLabel), textNode('div', 'order-method', order.paymentMethod === 'wechat' ? '微信支付' : order.paymentMethod === 'alipay' ? '支付宝' : '待确认'));
    const statusCell = document.createElement('td');
    const paymentState = String(order.paymentState || order.status).toLowerCase();
    const status = orderStates[paymentState] || ['待核对', 'neutral'];
    statusCell.append(textNode('span', `status-badge ${status[1]}`, status[0]));
    if (paymentState === 'expired') statusCell.append(textNode('div', 'status-detail', '仍核对最终结果'));
    row.append(timeCell, noteCell, amountCell, statusCell);
    rows.append(row);
  }
  body.replaceChildren(rows);
  element('orders-loading').hidden = true;
  element('orders-empty').hidden = orders.length !== 0;
  element('orders-container').hidden = orders.length === 0;
}

async function loadOrders() {
  element('orders-error').hidden = true;
  try {
    const data = await request('/api/admin/orders');
    if (!Array.isArray(data?.orders)) throw new Error('赞助记录暂不可用，请刷新后重试。');
    if (session) {
      renderOrders(data.orders);
      return true;
    }
  } catch (error) {
    element('orders-loading').hidden = true;
    if (session) {
      element('orders-error').textContent = error.message;
      element('orders-error').hidden = false;
    }
  }
  return false;
}

async function refresh() {
  renderSession(await request('/api/admin/session'));
  return loadOrders();
}

async function mutate(path, body, successMessage, sensitive = false) {
  if (!session || session.demo || busy) return;
  busy = true;
  updateControls();
  setNotice('');
  let saved = false;
  try {
    await request(path, body);
    saved = true;
    await refresh();
    setNotice(successMessage);
  } catch (error) {
    // Credential import failures use our own text, never an upstream response that could echo input.
    const message = sensitive ? '会话验证未完成，请确认这是收款账户的有效网页登录会话，必要时填写对应设备信息。' : error.message;
    setNotice(saved ? `操作已完成，但刷新状态失败。${message}` : message, true);
  } finally {
    busy = false;
    updateControls();
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (fields.disabled || busy || !form.reportValidity()) return;
  const payload = { sessionToken: element('session-token').value.trim().replace(/^Bearer\s+/i, '') };
  for (const [key, id] of [['deviceId', 'device-id'], ['deviceModel', 'device-model'], ['shumeiDeviceId', 'shumei-device-id']]) {
    const value = element(id).value.trim();
    if (value) payload[key] = value;
  }
  form.reset();
  if (!payload.sessionToken) {
    setNotice('请填写登录会话 Token。', true);
    return;
  }
  void mutate('/api/admin/account/session', payload, '会话已验证并保存，账户状态已更新。', true);
});

checkButton.addEventListener('click', () => {
  if (!checkButton.disabled) void mutate('/api/admin/account/check', {}, '连接验证已完成，账户状态已更新。');
});
disableButton.addEventListener('click', () => {
  if (!disableButton.disabled && window.confirm('确定停止创建新的赞助订单吗？已有账单仍会继续核对最终结果。')) {
    void mutate('/api/admin/account/disable', {}, '已停止新订单，已有账单仍会继续核对。');
  }
});
refreshButton.addEventListener('click', async () => {
  if (refreshButton.disabled) return;
  busy = true;
  updateControls();
  setNotice('');
  try {
    const ordersLoaded = await refresh();
    setNotice(ordersLoaded ? '账户状态与赞助记录已刷新。' : '账户状态已刷新，赞助记录暂未加载。');
  } catch (error) {
    setNotice(error.message, true);
  } finally {
    busy = false;
    updateControls();
  }
});

window.addEventListener('pagehide', () => { form.reset(); });
updateControls();
refresh().catch((error) => {
  session = null;
  updateControls();
  element('orders-loading').hidden = true;
  if (element('access-error').hidden) {
    element('access-state').textContent = '暂未连接';
    element('account-status').textContent = '加载未完成';
    element('account-description').textContent = '账户状态未能加载，请检查网络与管理入口配置后重新加载页面。';
    setNotice(error.message, true);
  }
});
