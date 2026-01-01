import QRCode from 'qrcode';
import { initFish } from './fish.js';

const $ = (id) => document.getElementById(id);
const form = $('sponsor-form');
const weChatMethod = form.querySelector('input[name="paymentMethod"][value="wechat"]');
const storageKey = 'feedfish-order-v1';
const inWeChat = /\bMicroMessenger\b/i.test(navigator.userAgent);
const checkDelays = [0, 0, 3000, 3000, 5000, 5000, 7000, 7000];
const checkFishMessages = {
  2: '人别戳了',
  4: '记得返回商家',
  6: '鱼在等回音',
  8: '付款后回来看',
  10: '让鱼喘口气',
};
let config, order, timer, countdown, turnstileId, token = '', requestKey, requestFingerprint, polling = false;
let backoff = 4000;
let animationKey, handoff, handoffTimer;
let checkingPayment = false, manualChecks = 0, nextCheckAt = 0, checkTimer, checkFish;
let reminderPulse;
let submitting = false;
const nicknameDialog = $('nickname-dialog');
const weChatChannelDialog = $('wechat-channel-dialog');
initFish();
const storage = { get() { try { return JSON.parse(sessionStorage.getItem(storageKey)); } catch { return null; } }, set(value) { try { value ? sessionStorage.setItem(storageKey, JSON.stringify(value)) : sessionStorage.removeItem(storageKey); } catch {} } };
function message(id, text = '') { $(id).textContent = text; $(id).hidden = !text; }
function busy(value) { $('submit-button').disabled = value || !config || (!config.demo && !config.paymentsAvailable); $('submit-label').textContent = value ? '正在准备付款码…' : '生成付款码'; }
async function api(path, options = {}) {
  const { timeout = 20000, ...request } = options;
  const response = await fetch(path, { ...request, signal: AbortSignal.timeout(timeout), headers: { 'Content-Type': 'application/json', ...request.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(body.error?.message || '暂时无法连接，请稍后再试。'); error.status = response.status; error.code = body.error?.code; throw error; }
  return body;
}
function resetCaptcha() { token = ''; if (turnstileId !== undefined && window.turnstile) window.turnstile.reset(turnstileId); }
function stopPolling() { clearTimeout(timer); clearInterval(countdown); }
function authenticated() { return { Authorization: `Bearer ${order.accessToken}` }; }
function schedulePoll() {
  clearTimeout(timer);
  if (order?.status === 'pending' && !checkingPayment && !handoff && !document.hidden) timer = setTimeout(poll, backoff);
}

function weChatPaymentUrl() {
  if (!inWeChat || config.demo || order?.status !== 'pending' || !(Date.parse(order.expiresAt) > Date.now())) return null;
  try {
    const url = new URL(order.qrCode);
    return url.origin === 'https://qr.95516.com' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function openPaymentPage() {
  if (!handoff || handoff.navigating) return;
  clearTimeout(handoffTimer);
  if (!weChatPaymentUrl()) { void resumePayment(); return; }
  handoff.navigating = true;
  $('start-again').textContent = '跳转支付ing';
  $('start-again').disabled = true;
  // If the WebView stays here, restore the order and its payment link.
  handoffTimer = setTimeout(resumePayment, 3000);
  try { location.assign(handoff.url); } catch { void resumePayment(); }
}

function countDownToPayment(seconds) {
  if (!handoff || document.hidden) return;
  if (!seconds) { openPaymentPage(); return; }
  $('start-again').textContent = `跳转支付……${seconds}`;
  handoffTimer = setTimeout(() => countDownToPayment(seconds - 1), 1000);
}

async function startWeChatPayment(url) {
  if (handoff) return;
  stopPolling();
  handoff = { url, navigating: false };
  await renderOrder();
  countDownToPayment(3);
}

async function resumePayment() {
  if (order?.status !== 'pending') return;
  updateCheckButton();
  if (handoff) {
    clearTimeout(handoffTimer);
    handoff = null;
    await renderOrder();
  } else {
    clearInterval(countdown);
    countdown = setInterval(tick, 1000);
  }
  await poll();
}

function updateCheckButton() {
  clearTimeout(checkTimer);
  const button = $('check-payment');
  const remaining = Math.max(0, nextCheckAt - Date.now());
  const seconds = Math.ceil(remaining / 1000);
  button.disabled = checkingPayment || seconds > 0;
  button.textContent = seconds ? `查看付款结果……${seconds}` : '查看付款结果';
  if (seconds) checkTimer = setTimeout(updateCheckButton, remaining - (seconds - 1) * 1000);
}

function removeCheckFish() {
  checkFish?.remove();
  checkFish = null;
  reminderPulse?.cancel();
  reminderPulse = null;
  $('return-merchant').classList.remove('is-highlighted');
}

function showCheckFish(text) {
  removeCheckFish();
  const reminder = $('return-merchant');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'payment-check-fish';
  button.setAttribute('aria-label', `${text}。点击关闭小鱼提示`);
  const image = new Image();
  image.src = '/assets/DSniang02.png';
  image.alt = '';
  const caption = document.createElement('strong');
  caption.textContent = text;
  button.append(image, caption);
  button.addEventListener('click', () => {
    reminderPulse?.cancel();
    reminder.classList.remove('is-highlighted');
    button.classList.add('is-retreating');
    const remove = () => { if (checkFish === button) removeCheckFish(); };
    button.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 300);
  }, { once: true });
  checkFish = button;
  document.body.append(button);
  reminder.classList.add('is-highlighted');
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    reminderPulse = reminder.animate?.([
      { boxShadow: '0 0 0 1px var(--primary)' },
      { boxShadow: '0 0 0 4px var(--primary)', filter: 'brightness(1.18)' },
      { boxShadow: '0 0 0 1px var(--primary)' },
    ], { duration: 1100, iterations: 3, easing: 'ease-in-out' });
  }
}

function resetManualCheck() {
  manualChecks = 0;
  nextCheckAt = 0;
  checkingPayment = false;
  updateCheckButton();
  removeCheckFish();
  message('manual-check-status');
}

function tick() {
  if (order?.status !== 'pending' || handoff) return;
  const seconds = Math.max(0, Math.ceil((Date.parse(order.expiresAt) - Date.now()) / 1000));
  $('countdown').textContent = seconds ? `付款码有效期 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '付款码已过期，正在确认最终状态…';
  if (!seconds) {
    $('qr-overlay').hidden = false;
    $('result-icon').textContent = '↻';
    $('payment-link').hidden = true;
    $('switch-wechat').hidden = true;
    $('order-status').textContent = '二维码已过期';
  }
}
async function renderOrder(verified = true) {
  form.hidden = true; $('hero').hidden = true; $('payment-view').hidden = false;
  $('order-amount').textContent = `¥${order.amount}`;
  const pending = order.status === 'pending';
  const success = order.status === 'paid' && verified;
  const redirecting = pending && !!handoff;
  $('order-method').textContent = redirecting || order.paymentMethod === 'wechat' ? '微信支付' : '支付宝';
  const showActions = pending && !redirecting;
  const animation = $('success-animation');
  animation.hidden = (!success && !redirecting) || matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('qr-frame').hidden = redirecting || (success && !animation.hidden);
  const nextAnimationKey = `${order.id}:${redirecting ? 'handoff' : 'success'}`;
  if (!animation.hidden && animationKey !== nextAnimationKey) {
    animationKey = nextAnimationKey;
    animation.src = '/assets/bubble-money1.gif';
  }
  $('order-status').textContent = ({ waiting: '等待付款', processing: '正在支付', paid: '支付成功', expired: '二维码已过期', failed: '支付失败', refunded: '已退款', chargeback: '已退单' })[order.paymentState] || ({ pending: '等待付款', paid: '支付成功', expired: '已过期', failed: '未能完成' })[order.status] || '正在确认';
  $('check-payment').hidden = !showActions;
  $('return-merchant').hidden = !showActions;
  if (!showActions) { message('manual-check-status'); removeCheckFish(); }
  $('demo-pay').hidden = !config.demo || !pending;
  const paymentLink = $('payment-link');
  const weChatUrl = showActions ? weChatPaymentUrl() : null;
  const weChatLink = order.paymentMethod === 'wechat' ? weChatUrl : null;
  const alipayLink = !inWeChat && order.paymentUrl?.startsWith('https://') ? order.paymentUrl : null;
  const directUrl = weChatLink || alipayLink;
  $('switch-wechat').hidden = !weChatUrl || order.paymentMethod !== 'alipay' || weChatMethod.disabled;
  paymentLink.hidden = !showActions || !directUrl;
  paymentLink.href = paymentLink.hidden ? '#' : directUrl;
  paymentLink.target = weChatLink ? '_self' : '_blank';
  paymentLink.textContent = weChatLink ? '打开付款页' : '打开支付宝付款页';
  $('qr-overlay').hidden = pending;
  $('start-again').disabled = false;
  $('start-again').textContent = redirecting ? '跳转支付……3' : pending ? '返回修改' : '再投喂一次';
  $('countdown').textContent = '';
  if (redirecting) {
    $('payment-title').textContent = '投喂中';
    $('payment-instruction').textContent = '谢谢投喂。';
    return;
  }
  if (pending) {
    $('payment-title').textContent = '扫码付款';
    $('payment-instruction').textContent = config.demo ? '演示二维码，不会扣款。' : `使用${order.paymentMethod === 'wechat' ? '微信' : '支付宝'}扫码`;
    if (order.qrCode) {
      try { await QRCode.toCanvas($('qr-canvas'), order.qrCode, { width: 210, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#19352f', light: '#ffffff' } }); }
      catch { message('poll-error', '二维码未能显示。请刷新恢复此订单，避免重复下单。'); }
    }
    tick(); clearInterval(countdown); countdown = setInterval(tick, 1000);
  } else {
    stopPolling();
    clearTimeout(handoffTimer);
    handoff = null;
    $('result-icon').textContent = order.status === 'paid' ? '✓' : '↻';
    $('payment-title').textContent = order.status === 'paid' ? (verified ? '投喂成功' : '正在核对') : ['refunded', 'chargeback'].includes(order.paymentState) ? '付款状态已更新' : order.status === 'expired' ? '二维码已过期' : '支付未完成';
    $('payment-instruction').textContent = order.status === 'paid' ? (verified ? (config.demo ? '演示完成，未发生真实付款。' : '谢谢投喂。') : '正在确认订单状态…') : '若已扣款，请先联系收款人核对。';
  }
}

async function applyOrderUpdate(update, force = false) {
  const changed = order.status !== update.status || order.paymentState !== update.paymentState;
  order = { ...order, ...update };
  storage.set(order);
  backoff = 4000;
  message('poll-error');
  if ((force || changed) && (!handoff || order.status !== 'pending')) await renderOrder(true);
}

async function poll(force = false) {
  if (!order || (!force && order.status !== 'pending') || polling || checkingPayment || handoff || document.hidden) return;
  polling = true;
  const previous = order;
  try {
    const update = await api(`/api/orders/${encodeURIComponent(previous.id)}`, { headers: authenticated() });
    if (order === previous && !checkingPayment) await applyOrderUpdate(update, force);
  } catch (error) {
    if (order !== previous || checkingPayment) return;
    message('poll-error', error.status === 429 ? '查询有点频繁，稍等片刻会自动重试。' : '暂时无法确认付款结果，正在重试。请勿重复付款。');
    backoff = Math.min(backoff * 2, 30000);
    if (error.status === 401 || error.status === 404) { backoff = 60000; message('poll-error', '无法读取这笔订单。若已付款，请联系收款人核对。'); }
  } finally {
    polling = false;
    schedulePoll();
  }
}

async function checkPayment() {
  if (order?.status !== 'pending' || handoff || checkingPayment || Date.now() < nextCheckAt) return;
  const id = order.id;
  checkingPayment = true;
  manualChecks++;
  nextCheckAt = Date.now() + (checkDelays[manualChecks - 1] ?? 10000);
  clearTimeout(timer);
  updateCheckButton();
  const fishMessage = checkFishMessages[manualChecks];
  if (fishMessage) showCheckFish(fishMessage);
  message('manual-check-status', config.demo ? '正在核对付款…' : '正在核对 DeepSeek 账单…');
  try {
    const update = await api(`/api/orders/${encodeURIComponent(id)}/check`, { method: 'POST', headers: authenticated(), timeout: 140000 });
    if (order?.id !== id) return;
    await applyOrderUpdate(update);
    if (!handoff) message('manual-check-status', order.status === 'pending' ? '已核对，账单尚未确认这笔付款。' : '');
  } catch (error) {
    if (order?.id === id && !handoff) message('manual-check-status', error.message);
  } finally {
    if (order?.id === id) {
      checkingPayment = false;
      updateCheckButton();
      schedulePoll();
    }
  }
}
$('message').addEventListener('input', () => { $('message-count').textContent = `${$('message').value.length} / 300`; });
$('nickname-skip').addEventListener('click', () => nicknameDialog.close('continue'));
$('nickname-edit').addEventListener('click', () => {
  nicknameDialog.close('edit');
  form.querySelector('.optional-fields').open = true;
  $('nickname').focus();
});
function chooseDialog(dialog) {
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    dialog.showModal();
  });
}
form.addEventListener('submit', async (event) => {
  event.preventDefault(); message('form-error');
  if (submitting) return;
  submitting = true;
  try {
    if (!config?.paymentsAvailable) { message('form-error', '收款暂时不可用，请稍后重试。'); return; }
    const amount = $('amount').value.trim();
    if (!/^(?:0|[1-9]\d{0,5})(?:\.0{1,2})?$/.test(amount) || Number(amount) < Number(config.minAmount) || Number(amount) > Number(config.maxAmount)) { message('form-error', `请输入 ${config.minAmount}–${config.maxAmount} CNY，仅支持整数元。`); $('amount').focus(); return; }
    if (!$('nickname').value.trim() && await chooseDialog(nicknameDialog) !== 'continue') return;
    let paymentMethod = new FormData(form).get('paymentMethod');
    if (inWeChat && !config.demo && paymentMethod === 'alipay' && !weChatMethod.disabled) {
      const choice = await chooseDialog(weChatChannelDialog);
      if (!['wechat', 'alipay'].includes(choice)) return;
      paymentMethod = choice;
      if (choice === 'wechat') weChatMethod.checked = true;
    }
    if (config.turnstileSiteKey && !token) { message('form-error', '请先完成人机验证。'); return; }
    const body = { amount, nickname: $('nickname').value.trim(), message: $('message').value.trim(), paymentMethod };
    const fingerprint = JSON.stringify(body);
    if (fingerprint !== requestFingerprint) { requestKey = crypto.randomUUID(); requestFingerprint = fingerprint; }
    busy(true);
    try {
      order = await api('/api/orders', { method: 'POST', headers: { 'Idempotency-Key': requestKey }, body: JSON.stringify({ ...body, turnstileToken: token }), timeout: 150000 });
      storage.set(order);
      resetManualCheck();
      const url = order.paymentMethod === 'wechat' ? weChatPaymentUrl() : null;
      if (url) await startWeChatPayment(url);
      else {
        await renderOrder();
        schedulePoll();
      }
    } catch (error) { message('form-error', error.name === 'TimeoutError' ? '请求暂未返回。请点击重试，同一笔请求不会重复创建订单。' : error.message); }
    finally { busy(false); resetCaptcha(); }
  } finally { submitting = false; }
});
$('check-payment').addEventListener('click', checkPayment);
$('switch-wechat').addEventListener('click', () => {
  const url = weChatPaymentUrl();
  if (url && order.paymentMethod === 'alipay' && !weChatMethod.disabled) void startWeChatPayment(url);
});
$('start-again').addEventListener('click', () => {
  if (handoff) { openPaymentPage(); return; }
  if (order?.status === 'pending' && !window.confirm('返回后仍可能完成这笔付款。若已经付款，请留在此页核对结果；确定返回修改吗？')) return;
  stopPolling(); resetManualCheck(); order = null; storage.set(null); requestFingerprint = null; requestKey = null;
  $('payment-view').hidden = true; $('success-animation').hidden = true; $('hero').hidden = false; form.hidden = false; message('poll-error'); resetCaptcha(); $('amount').focus();
});
$('demo-pay').addEventListener('click', async () => {
  $('demo-pay').disabled = true;
  try { await api(`/api/orders/${encodeURIComponent(order.id)}/demo-pay`, { method: 'POST', headers: authenticated(), body: '{}' }); await poll(); }
  catch (error) { message('poll-error', error.message); }
  finally { $('demo-pay').disabled = false; }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(timer); clearTimeout(handoffTimer); }
  else void resumePayment();
});
window.addEventListener('pagehide', () => {
  stopPolling();
  clearTimeout(handoffTimer);
  if (nicknameDialog.open) nicknameDialog.close();
  if (weChatChannelDialog.open) weChatChannelDialog.close();
});
window.addEventListener('pageshow', (event) => { if (event.persisted) void resumePayment(); });
async function loadCaptcha() {
  if (!config.turnstileSiteKey || !config.paymentsAvailable) return;
  await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.onload = resolve; script.onerror = reject; document.head.append(script); });
  turnstileId = window.turnstile.render('#turnstile', { sitekey: config.turnstileSiteKey, action: 'create_order', theme: 'auto', size: 'flexible', callback: (value) => { token = value; }, 'expired-callback': () => { token = ''; }, 'error-callback': () => { token = ''; message('form-error', '人机验证暂时未完成，请刷新后重试。'); } });
}
async function init() {
  try {
    config = await api('/api/config'); $('demo-notice').hidden = !config.demo;
    if (!config.paymentsAvailable) message('config-error', config.paymentsEnabled ? '收款暂时不可用，请稍后重试。' : '收款暂未开放，请晚一点再来。');
    const methods = config.paymentMethods || ['wechat', 'alipay'];
    const choices = [...form.querySelectorAll('input[name="paymentMethod"]')];
    for (const input of choices) {
      input.disabled = !methods.includes(input.value);
      if (input.disabled) input.checked = false;
      input.closest('label').title = input.disabled ? '暂未开放' : '';
    }
    if (!choices.some((input) => input.checked && !input.disabled)) { const first = choices.find((input) => !input.disabled); if (first) first.checked = true; }
    if (Number($('amount').value) > Number(config.maxAmount)) $('amount').value = String(Number(config.maxAmount));
    $('amount-help').textContent = `支持 ${config.minAmount} 至 ${config.maxAmount} CNY，仅限整数元。`;
    const saved = storage.get();
    if (saved?.id && saved?.accessToken && saved.currency === 'CNY') { order = saved; await renderOrder(false); poll(true); }
    busy(false);
    try { await loadCaptcha(); } catch { message('form-error', '人机验证暂时无法加载，请刷新后重试。已有订单仍会继续查询。'); }
  } catch { message('config-error', '暂时无法连接，请刷新页面重试。'); }
}
init();
