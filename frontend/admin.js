import { accountErrorMessage } from './admin-errors.js';
import QRCode from 'qrcode';
const element = (id) => document.getElementById(id);
const fields = element('session-fields');
const form = element('session-form');
const refreshButton = element('refresh-button');
const checkButton = element('check-button');
const browserCheckButton = element('browser-check-button');
const disableButton = element('disable-button');
const importButton = element('import-button');
const loginStart = element('login-start');
const loginCancel = element('login-cancel');
let session = null;
let busy = false;
const testButtons = [...document.querySelectorAll('[data-test-method]')];
const testRequests = new Map();
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

const accountStates = {
  connected: ['身份已确认', 'positive', '固定账户身份已核对。收款仍需通过支付通道验证并启用。'],
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
  const authorizationReady = writable && session.authorizationAvailable;
  const activeLogin = Boolean(session?.authorization && Date.parse(session.authorization.expiresAt) > Date.now());
  const pending = session?.pendingAuthorization;
  loginStart.disabled = !authorizationReady || !activeLogin || Boolean(pending);
  loginCancel.hidden = !activeLogin && !pending;
  loginCancel.textContent = pending ? '取消待核验授权' : '取消';
  loginCancel.disabled = !authorizationReady || Boolean(pending?.busy);
  refreshButton.disabled = !writable;
  checkButton.disabled = !writable || Boolean(pending?.busy) || !(pending || session?.account?.configured || session?.account?.status === 'disabled');
  checkButton.textContent = pending ? '重试账户核验' : '验证连接';
  browserCheckButton.disabled = !writable || Boolean(pending) || !session?.account?.configured;
  disableButton.disabled = !writable || !session?.account?.configured || session.account.status === 'disabled';
  for (const button of testButtons) button.disabled = !writable || Boolean(pending) || !session?.account?.configured || !session.expectedAccountId;
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
    ? `授权已加密暂存。可点击“重试账户核验”，无需重新登录；暂存有效至 ${dateLabel(data.pendingAuthorization.expiresAt)}。`
    : data.authorization
    ? `请在 DeepSeek 页面核对账户并授权。有效至 ${dateLabel(data.authorization.expiresAt)}，完成后自动核验并保存。`
    : '从本机连接助手开始。账户令牌仅由 Cloudflare 接收、核验并加密保存。';
  element('access-error').hidden = true;
  element('demo-notice').hidden = !data.demo;
  element('access-state').textContent = data.demo ? '本地演示' : 'Access 身份已确认';
  element('admin-identity').textContent = data.demo ? '本地后台演示' : `管理员：${data.email || '已验证身份'}`;
  const staged = !data.expectedAccountId && data.account.accountId && !data.demo;
  const state = data.pendingAuthorization ? ['待核验', 'warning', '官方授权已收到，账户资料尚未核验。暂存会话不会用于创建付款账单。'] : staged ? ['待固定账户', 'warning', '账户身份已确认，凭证已加密保存。固定此账户 ID 后仍需验证支付通道；收款保持关闭。'] : accountStates[data.account.status] || accountStates.unverified;
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
    const result = await request(path, body);
    saved = true;
    await refresh();
    setNotice(path.endsWith('/discard') && result.revoked === false ? '本站暂存已清除，上游注销未能确认。' : successMessage);
  } catch (error) {
    if (path === '/api/admin/account/authorize/complete' || path === '/api/admin/account/authorize/retry') await refresh().catch(() => {});
    // Credential import failures use our own text, never an upstream response that could echo input.
    const message = sensitive ? accountErrorMessage(error) : error.message;
    const pending = session?.pendingAuthorization ? ' 授权已加密暂存，可点击“重试账户核验”。' : '';
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

loginStart.addEventListener('click', () => {
  if (loginStart.disabled) return;
  try {
    const url = new URL(session.authorization.authorizeUrl);
    if (url.origin !== 'https://platform.deepseek.com' || url.pathname !== '/dsh/authorize') throw new Error('授权地址无效。');
    window.location.assign(url.href);
  } catch (error) { setNotice(error.message, true); }
});
loginCancel.addEventListener('click', () => {
  if (!loginCancel.disabled && session?.pendingAuthorization) { void mutate('/api/admin/account/authorize/discard', { id: session.pendingAuthorization.id }, '本站暂存授权已清除。'); return; }
  if (!loginCancel.disabled && session?.authorization) void mutate('/api/admin/account/authorize/cancel', {}, '本次授权已取消。');
});

checkButton.addEventListener('click', () => {
  if (!checkButton.disabled && session?.pendingAuthorization) { void mutate('/api/admin/account/authorize/retry', { id: session.pendingAuthorization.id }, '会话已验证并加密保存。', true); return; }
  if (!checkButton.disabled) void mutate('/api/admin/account/check', {}, '连接验证已完成，账户状态已更新。');
});
browserCheckButton.addEventListener('click', () => {
  if (!browserCheckButton.disabled) void mutate('/api/admin/account/check', { transport: 'browser' }, 'Cloudflare 云浏览器已核验固定账户，未创建付款账单。');
});

for (const button of testButtons) button.addEventListener('click', async () => {
  if (button.disabled || busy) return;
  const method = button.dataset.testMethod;
  if (!testRequests.has(method)) testRequests.set(method, crypto.randomUUID());
  busy = true; updateControls(); setNotice('正在创建 1 CNY 测试账单…');
  element('payment-test-result').hidden = true;
  try {
    const order = await request('/api/admin/account/test-payment', { paymentMethod: method, requestId: testRequests.get(method) });
    if (!order.qrCode) throw new Error('这笔测试账单已关闭，请核对最近账单。');
    element('payment-test-qr').src = await QRCode.toDataURL(order.qrCode, { width: 440, margin: 3, errorCorrectionLevel: 'M' });
    element('payment-test-description').textContent = `1.00 CNY · ${method === 'wechat' ? '微信支付' : '支付宝'} · 有效至 ${dateLabel(order.expiresAt)}`;
    element('payment-test-link').hidden = !order.paymentUrl;
    if (order.paymentUrl) element('payment-test-link').href = order.paymentUrl;
    element('payment-test-result').hidden = false;
    await loadOrders(); setNotice('测试码已生成，请核对支付方式与金额。');
  } catch (error) {
    const status = Number.isInteger(error.diagnostic?.upstreamStatus) ? `（HTTP ${error.diagnostic.upstreamStatus}）` : '';
    const challenge = ['captcha', 'challenge'].includes(error.diagnostic?.upstreamChallenge) ? ' 上游要求浏览器验证。' : '';
    setNotice(`测试码未生成。${error.message}${status}${challenge}`, true);
    await loadOrders();
  } finally { busy = false; updateControls(); }
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
refresh().then(async () => {
  if (!connectionInput) return;
  if (session?.pendingAuthorization) { setNotice('授权已加密暂存，可直接点击“重试账户核验”。'); return; }
  if (connectionInput.invalid) { setNotice('连接参数无效，请从本机连接助手重新开始。', true); return; }
  if (connectionInput.denied) { setNotice('官方授权未获确认，可重新发起连接。', true); return; }
  if (connectionInput.code) {
    try { await mutate('/api/admin/account/authorize/complete', connectionInput, '授权会话已验证并加密保存。', true); }
    finally { connectionInput.code = ''; connectionInput.state = ''; }
    return;
  }
  busy = true; updateControls(); setNotice('正在准备账户授权…');
  try {
    await request('/api/admin/account/authorize/start', connectionInput);
    await refresh(); setNotice('授权入口已准备好，请核对账户后在官方页面授权。');
  } catch (error) { setNotice(error.message, true); }
  finally { connectionInput.state = ''; busy = false; updateControls(); }
}).catch((error) => {
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
