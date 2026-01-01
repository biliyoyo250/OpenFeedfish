import QRCode from 'qrcode';

const $ = (id) => document.getElementById(id);
const form = $('sponsor-form');
const storageKey = 'feedfish-order-v1';
let config, order, timer, countdown, turnstileId, token = '', requestKey, requestFingerprint, polling = false;
let backoff = 4000;
const storage = { get() { try { return JSON.parse(sessionStorage.getItem(storageKey)); } catch { return null; } }, set(value) { try { value ? sessionStorage.setItem(storageKey, JSON.stringify(value)) : sessionStorage.removeItem(storageKey); } catch {} } };
function message(id, text = '') { $(id).textContent = text; $(id).hidden = !text; }
function busy(value) { $('submit-button').disabled = value || !config || (!config.demo && !config.paymentsAvailable); $('submit-label').textContent = value ? '正在准备付款码…' : '生成付款码'; }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json', ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(body.error?.message || '暂时无法连接，请稍后再试。'); error.status = response.status; error.code = body.error?.code; throw error; }
  return body;
}
function resetCaptcha() { token = ''; if (turnstileId !== undefined && window.turnstile) window.turnstile.reset(turnstileId); }
function stopPolling() { clearTimeout(timer); clearInterval(countdown); }
function authenticated() { return { Authorization: `Bearer ${order.accessToken}` }; }
function tick() {
  if (!order || order.status !== 'pending') return;
  const seconds = Math.max(0, Math.ceil((Date.parse(order.expiresAt) - Date.now()) / 1000));
  $('countdown').textContent = seconds ? `付款码有效期 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '付款码已过期，正在确认最终状态…';
  if (!seconds) { $('qr-overlay').hidden = false; $('result-icon').textContent = '↻'; $('payment-link').hidden = true; $('order-status').textContent = '二维码已过期'; }
}
async function renderOrder() {
  form.hidden = true; $('payment-view').hidden = false;
  $('order-method').textContent = order.paymentMethod === 'wechat' ? '微信支付' : '支付宝';
  $('order-amount').textContent = `¥${order.amount}`;
  const pending = order.status === 'pending';
  $('order-status').textContent = ({ waiting: '等待付款', processing: '正在支付', paid: '支付成功', expired: '二维码已过期', failed: '支付失败', refunded: '已退款', chargeback: '已退单' })[order.paymentState] || ({ pending: '等待付款', paid: '支付成功', expired: '已过期', failed: '未能完成' })[order.status] || '正在确认';
  $('check-payment').hidden = !pending;
  $('demo-pay').hidden = !config.demo || !pending;
  const paymentLink = $('payment-link');
  paymentLink.hidden = !pending || !order.paymentUrl?.startsWith('https://');
  paymentLink.href = paymentLink.hidden ? '#' : order.paymentUrl;
  $('qr-overlay').hidden = pending;
  $('start-again').textContent = pending ? '返回修改' : '再投喂一次';
  $('countdown').textContent = '';
  if (pending) {
    $('payment-title').textContent = '给小鱼的加餐，准备好啦';
    $('payment-instruction').textContent = config.demo ? '演示二维码，不会扣款。' : `请使用${order.paymentMethod === 'wechat' ? '微信' : '支付宝'}扫描二维码付款`;
    if (order.qrCode) {
      try { await QRCode.toCanvas($('qr-canvas'), order.qrCode, { width: 210, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#19352f', light: '#ffffff' } }); }
      catch { message('poll-error', '二维码未能显示。请刷新恢复此订单，避免重复下单。'); }
    }
    tick(); clearInterval(countdown); countdown = setInterval(tick, 1000);
  } else {
    stopPolling();
    $('result-icon').textContent = order.status === 'paid' ? '✓' : '↻';
    $('payment-title').textContent = order.status === 'paid' ? '吃饱啦，谢谢你的投喂！' : ['refunded', 'chargeback'].includes(order.paymentState) ? '这笔付款的状态已更新' : order.status === 'expired' ? '这份加餐，等得有点久啦' : '这次投喂没有完成';
    $('payment-instruction').textContent = order.status === 'paid' ? (config.demo ? '演示完成，没有发生真实付款。' : '你的心意已收到，小鱼又有能量了。') : '可以重新生成付款码。如果已经扣款，请先联系收款人核对，避免重复付款。';
  }
}
async function poll(force = false) {
  if (!order || (!force && order.status !== 'pending') || polling || document.hidden) return;
  polling = true; $('check-payment').disabled = true;
  const id = order.id;
  try {
    const update = await api(`/api/orders/${encodeURIComponent(id)}`, { headers: authenticated() });
    if (!order || order.id !== id) return;
    const previousStatus = `${order.status}:${order.paymentState}`;
    order = { ...order, ...update }; storage.set(order); backoff = 4000; message('poll-error');
    if (previousStatus !== `${order.status}:${order.paymentState}`) await renderOrder();
  } catch (error) {
    if (order?.id !== id) return;
    message('poll-error', error.status === 429 ? '查询有点频繁，稍等片刻会自动重试。' : '暂时无法确认付款结果，正在重试。请勿重复付款。');
    backoff = Math.min(backoff * 2, 30000);
    if (error.status === 401 || error.status === 404) { backoff = 60000; message('poll-error', '无法读取这笔订单。若已付款，请联系收款人核对。'); }
  } finally {
    polling = false; $('check-payment').disabled = false;
    clearTimeout(timer); if (order?.status === 'pending' && !document.hidden) timer = setTimeout(poll, backoff);
  }
}
document.querySelectorAll('[data-amount]').forEach((button) => button.addEventListener('click', () => { $('amount').value = button.dataset.amount; selectPreset(); }));
function selectPreset() { document.querySelectorAll('[data-amount]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.amount) === Number($('amount').value)))); }
$('amount').addEventListener('input', selectPreset);
$('message').addEventListener('input', () => { $('message-count').textContent = `${$('message').value.length} / 300`; });
form.addEventListener('submit', async (event) => {
  event.preventDefault(); message('form-error');
  const amount = $('amount').value.trim();
  if (!/^(?:0|[1-9]\d{0,5})(?:\.0{1,2})?$/.test(amount) || Number(amount) < Number(config.minAmount) || Number(amount) > Number(config.maxAmount)) { message('form-error', `请输入 ${config.minAmount}–${config.maxAmount} CNY，仅支持整数元。`); $('amount').focus(); return; }
  if (config.turnstileSiteKey && !token) { message('form-error', '请先完成人机验证。'); return; }
  const body = { amount, nickname: $('nickname').value.trim(), message: $('message').value.trim(), paymentMethod: new FormData(form).get('paymentMethod') };
  const fingerprint = JSON.stringify(body);
  if (fingerprint !== requestFingerprint) { requestKey = crypto.randomUUID(); requestFingerprint = fingerprint; }
  busy(true);
  try {
    order = await api('/api/orders', { method: 'POST', headers: { 'Idempotency-Key': requestKey }, body: JSON.stringify({ ...body, turnstileToken: token }) });
    storage.set(order); await renderOrder(); timer = setTimeout(poll, 4000);
  } catch (error) { message('form-error', error.name === 'TimeoutError' ? '请求暂未返回。请点击重试，同一笔请求不会重复创建订单。' : error.message); }
  finally { busy(false); resetCaptcha(); }
});
$('check-payment').addEventListener('click', () => { clearTimeout(timer); poll(); });
$('start-again').addEventListener('click', () => {
  if (order?.status === 'pending' && !window.confirm('返回后仍可能完成这笔付款。若已经付款，请留在此页核对结果；确定返回修改吗？')) return;
  stopPolling(); order = null; storage.set(null); requestFingerprint = null; requestKey = null;
  $('payment-view').hidden = true; form.hidden = false; message('poll-error'); resetCaptcha(); $('amount').focus();
});
$('demo-pay').addEventListener('click', async () => {
  $('demo-pay').disabled = true;
  try { await api(`/api/orders/${encodeURIComponent(order.id)}/demo-pay`, { method: 'POST', headers: authenticated(), body: '{}' }); await poll(); }
  catch (error) { message('poll-error', error.message); }
  finally { $('demo-pay').disabled = false; }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else if (order?.status === 'pending') poll(); });
window.addEventListener('pagehide', stopPolling);
window.addEventListener('pageshow', () => { if (order?.status === 'pending') { clearInterval(countdown); countdown = setInterval(tick, 1000); poll(); } });
async function loadCaptcha() {
  if (!config.turnstileSiteKey) return;
  await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.onload = resolve; script.onerror = reject; document.head.append(script); });
  turnstileId = window.turnstile.render('#turnstile', { sitekey: config.turnstileSiteKey, action: 'create_order', theme: 'light', size: 'flexible', callback: (value) => { token = value; }, 'expired-callback': () => { token = ''; }, 'error-callback': () => { token = ''; message('form-error', '人机验证暂时未完成，请刷新后重试。'); } });
}
async function init() {
  try {
    config = await api('/api/config'); $('demo-notice').hidden = !config.demo;
    if (!config.paymentsAvailable) message('config-error', '收款暂未开放，请晚一点再来。');
    const saved = storage.get();
    if (saved?.id && saved?.accessToken && saved.currency === 'CNY') { order = saved; await renderOrder(); poll(true); }
    busy(false);
    try { await loadCaptcha(); } catch { message('form-error', '人机验证暂时无法加载，请刷新后重试。已有订单仍会继续查询。'); }
  } catch { message('config-error', '暂时无法连接，请刷新页面重试。'); }
}
init();
