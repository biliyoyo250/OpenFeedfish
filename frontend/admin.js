import { accountErrorMessage } from './admin-errors.js';
import { beginLocalAuthorization } from './admin-connection.js';
import { initBrowserAgent } from './admin-browser.js';
const element = (id) => document.getElementById(id);
const fields = element('session-fields');
const form = element('session-form');
const refreshButton = element('refresh-button');
const retryButton = element('retry-button');
const importButton = element('import-button');
const loginStart = element('login-start');
const loginCancel = element('login-cancel');
let session = null;
let busy = false;
const connectionInput = (() => {
  const values = new URLSearchParams(window.location.hash.slice(1));
  if (![...values.keys()].some((key) => key.startsWith('connect_'))) return null;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  const state = values.get('connect_state');
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state)) return { invalid: true };
  if (values.has('connect_code')) return { code: values.get('connect_code'), state };
  if (values.get('connect_error') === 'access_denied') return { denied: true };
  const callbackPort = Number(values.get('connect_port'));
  return Number.isInteger(callbackPort) && callbackPort >= 1024 && callbackPort <= 65535 ? { callbackPort, state } : { invalid: true };
})();

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
  fields.disabled = !writable || Boolean(session?.pendingAuthorization);
  importButton.disabled = fields.disabled;
  const authorizationReady = writable && session.authorizationAvailable;
  const activeLogin = Boolean(session?.authorization && Date.parse(session.authorization.expiresAt) > Date.now());
  const pending = session?.pendingAuthorization;
  const localStart = Boolean(connectionInput?.callbackPort && !connectionInput.invalid && !connectionInput.code && !connectionInput.denied);
  loginStart.disabled = !authorizationReady || Boolean(pending?.busy) || !(localStart || (activeLogin && !pending));
  loginStart.textContent = localStart && pending ? '改用官方授权' : localStart || activeLogin ? '前往 DeepSeek 授权' : '等待本机连接';
  loginCancel.hidden = !activeLogin && !pending;
  loginCancel.textContent = pending ? '清除暂存凭证' : '取消授权';
  loginCancel.disabled = !authorizationReady || Boolean(pending?.busy);
  refreshButton.disabled = !writable;
  retryButton.hidden = !pending;
  retryButton.disabled = !writable || Boolean(pending?.busy);
}

function lockAccess() {
  session = null;
  form.reset();
  updateControls();
  element('access-state').textContent = '权限未就绪';
  element('access-error').textContent = '管理入口的 SSO 登录或访问权限尚未就绪。请通过 Cloudflare Access 登录后重新加载此页面，或联系管理员检查访问策略。';
  element('access-error').hidden = false;
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
    throw Object.assign(new Error('请求未能完成，请确认网络和管理入口的登录状态后重试。'), { code: 'ADMIN_NETWORK' });
  }
  if (response.status === 401 || response.status === 403) {
    lockAccess();
    throw Object.assign(new Error('管理权限尚未就绪，请完成 Cloudflare Access 登录后重新加载页面。'), { code: 'ACCESS_DENIED' });
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw Object.assign(new Error('未收到有效的管理响应，请检查管理入口配置后重试。'), { code: 'ADMIN_RESPONSE' });
  }
  if (!response.ok) {
    const error = new Error(typeof data?.error?.message === 'string' ? data.error.message : '操作未完成，请稍后重试。');
    error.code = data?.error?.code;
    error.diagnostic = data?.error?.diagnostic;
    throw error;
  }
  return data;
}

function renderSession(data) {
  if (typeof data?.demo !== 'boolean' || !data.account || typeof data.account.configured !== 'boolean') {
    throw new Error('账户状态暂不可用，请稍后重新加载页面。');
  }
  session = data;
  element('login-state').textContent = data.pendingAuthorization
    ? `会话凭证已加密暂存，可点击“重试账户核验”，有效至 ${dateLabel(data.pendingAuthorization.expiresAt)}。`
    : data.authorization
    ? `请在 DeepSeek 页面核对账户并授权。有效至 ${dateLabel(data.authorization.expiresAt)}，完成后自动核验并保存。`
    : '运行本机连接助手，点击“连接 DeepSeek”后会自动进入官方授权。无需复制 Cookie 或 Token。';
  element('access-error').hidden = true;
  element('demo-notice').hidden = !data.demo;
  element('access-state').textContent = data.demo ? '本地演示' : 'Access 身份已确认';
  element('admin-identity').textContent = data.demo ? '本地后台演示' : `管理员：${data.email || '已验证身份'}`;
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
    const result = await request(path, body);
    saved = true;
    await refresh();
    setNotice(path.endsWith('/discard') && result.revoked === false ? '本站暂存已清除，上游注销未能确认。' : successMessage);
  } catch (error) {
    if (['/api/admin/account/session', '/api/admin/account/authorize/complete', '/api/admin/account/authorize/retry'].includes(path)) await refresh().catch(() => {});
    // Credential import failures use our own text, never an upstream response that could echo input.
    const message = sensitive ? accountErrorMessage(error) : error.message;
    const pending = session?.pendingAuthorization ? ' 凭证已加密暂存，可点击“重试账户核验”。' : '';
    setNotice(saved ? `操作已完成，但刷新状态失败。${message}` : message + pending, true);
  } finally {
    busy = false;
    updateControls();
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (fields.disabled || busy || !form.reportValidity()) return;
  const payload = { sessionToken: element('session-token').value.trim().replace(/^Bearer\s+/i, '') };
  payload.cookie = element('session-cookie').value.trim();
  for (const [key, id] of [['deviceId', 'device-id'], ['deviceModel', 'device-model'], ['shumeiDeviceId', 'shumei-device-id']]) {
    const value = element(id).value.trim();
    if (value) payload[key] = value;
  }
  if (!payload.sessionToken) {
    setNotice('请填写网页登录 Token（userToken）或 Authorization。', true);
    return;
  }
  if (new TextEncoder().encode(JSON.stringify(payload)).length > 8192) { setNotice('凭证内容过长，请只填写所需的 Cookie / Token。', true); return; }
  form.reset();
  void mutate('/api/admin/account/session', payload, '会话已验证并保存，账户状态已更新。', true);
});

async function connectFromLocal(replacePending = false) {
  if (!session || session.demo || busy) return;
  busy = true; updateControls(); setNotice('正在准备官方授权，完成后自动返回…');
  try {
    await beginLocalAuthorization({ input: connectionInput, pendingId: replacePending ? session.pendingAuthorization?.id : undefined, request, navigate: url => window.location.assign(url) });
  } catch (error) {
    await refresh().catch(() => {}); setNotice(accountErrorMessage(error), true);
  } finally { busy = false; updateControls(); }
}
loginStart.addEventListener('click', () => {
  if (loginStart.disabled) return;
  if (connectionInput?.callbackPort && !connectionInput.invalid) { void connectFromLocal(Boolean(session?.pendingAuthorization)); return; }
  try {
    const url = new URL(session.authorization.authorizeUrl);
    if (url.origin !== 'https://platform.deepseek.com' || url.pathname !== '/dsh/authorize') throw new Error('授权地址无效。');
    window.location.assign(url.href);
  } catch (error) { setNotice(error.message, true); }
});
loginCancel.addEventListener('click', () => {
  if (!loginCancel.disabled && session?.pendingAuthorization) { void mutate('/api/admin/account/authorize/discard', { id: session.pendingAuthorization.id }, '本站暂存凭证已清除。'); return; }
  if (!loginCancel.disabled && session?.authorization) void mutate('/api/admin/account/authorize/cancel', {}, '本次授权已取消。');
});

retryButton.addEventListener('click', () => {
  if (!retryButton.disabled && session?.pendingAuthorization) void mutate('/api/admin/account/authorize/retry', { id: session.pendingAuthorization.id }, '会话已验证并加密保存。', true);
});
refreshButton.addEventListener('click', async () => {
  if (refreshButton.disabled) return;
  busy = true;
  updateControls();
  setNotice('');
  try {
    const ordersLoaded = await refresh();
    setNotice(ordersLoaded ? '账单已刷新。' : '账单暂未加载，请稍后重试。');
  } catch (error) {
    setNotice(error.message, true);
  } finally {
    busy = false;
    updateControls();
  }
});

window.addEventListener('pagehide', () => { form.reset(); });
window.addEventListener('feedfish:agent-order-updated', () => { void loadOrders(); });
initBrowserAgent();
updateControls();
refresh().then(async () => {
  if (!connectionInput) return;
  if (connectionInput.invalid) { setNotice('连接参数无效，请从本机连接助手重新开始。', true); return; }
  if (connectionInput.denied) { setNotice('官方授权未获确认，可重新发起连接。', true); return; }
  if (session?.pendingAuthorization) {
    setNotice(connectionInput.callbackPort ? '已有待核验凭证，可继续重试；如需更换为这次官方授权，请点击“改用官方授权”。该操作会清除旧的暂存凭证。' : '凭证已加密暂存，可直接点击“重试账户核验”。');
    return;
  }
  if (connectionInput.code) {
    try { await mutate('/api/admin/account/authorize/complete', connectionInput, '授权会话已验证并加密保存。', true); }
    finally { connectionInput.code = ''; connectionInput.state = ''; }
    return;
  }
  await connectFromLocal();
}).catch((error) => {
  session = null;
  updateControls();
  element('orders-loading').hidden = true;
  if (element('access-error').hidden) {
    element('access-state').textContent = '暂未连接';
    setNotice(error.message, true);
  }
});
