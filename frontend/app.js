import QRCode from 'qrcode';
import { initFish } from './fish.js';
import { createDebugCheckout } from './debug-checkout.js';

const $ = (id) => document.getElementById(id);
const form = $('sponsor-form');
const amountInput = $('amount');
const amountField = $('amount-field');
const keypadPanel = $('keypad-panel');
const keypadToggle = $('keypad-toggle');
const compactKeypad = matchMedia('(max-width: 899px), (max-height: 640px), (pointer: coarse)');
const paymentView = $('payment-view');
const weChatMethod = form.querySelector('input[name="paymentMethod"][value="wechat"]');
const debugMode = new URLSearchParams(location.search).get('debug') === '1';
const storageKey = debugMode ? 'feedfish-debug-order-v1' : 'feedfish-order-v1';
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
let handoff, handoffTimer;
let checkingPayment = false, manualChecks = 0, nextCheckAt = 0, checkTimer, checkFish;
let reminderPulse;
let submitting = false;
const nicknameDialog = $('nickname-dialog');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const weChatChannelDialog = $('wechat-channel-dialog');
const qrImage = $('qr-image');
const qrDownload = $('qr-download');
const expiredQrBackdrop = $('expired-qr-backdrop');
const unavailableImage = $('payment-unavailable-image');
const unavailableAnimation = '/assets/payment-peek.webp?v=2';
const unavailablePoster = '/assets/payment-peek.png';
function setKeypadOpen(open) {
  const compact = compactKeypad.matches;
  $('keypad-amount').textContent = amountInput.value || '0';
  keypadPanel.hidden = compact && !open;
  keypadToggle.hidden = !compact;
  keypadToggle.setAttribute('aria-expanded', String(!keypadPanel.hidden));
  document.querySelector('.page').classList.toggle('keypad-open', compact && open);
}
setKeypadOpen(false);
compactKeypad.addEventListener('change', () => setKeypadOpen(false));
amountField.addEventListener('click', () => {
  if (!compactKeypad.matches) return;
  setKeypadOpen(true);
  amountInput.focus({ preventScroll: true });
});
keypadToggle.addEventListener('click', (event) => {
  event.stopPropagation();
  setKeypadOpen(keypadPanel.hidden);
  amountInput.focus({ preventScroll: true });
});
$('keypad-close').addEventListener('click', () => {
  setKeypadOpen(false);
  amountInput.focus({ preventScroll: true });
});
amountInput.addEventListener('input', () => { $('keypad-amount').textContent = amountInput.value || '0'; });
amountInput.addEventListener('keydown', (event) => {
  if (compactKeypad.matches && keypadPanel.hidden && event.key === 'ArrowDown') {
    event.preventDefault();
    setKeypadOpen(true);
  }
});
function dismissKeypadOutside(event) {
  if (compactKeypad.matches && !amountField.contains(event.target) && !keypadPanel.contains(event.target)) setKeypadOpen(false);
}
document.addEventListener('pointerdown', dismissKeypadOutside);
document.addEventListener('focusin', dismissKeypadOutside);
document.addEventListener('keydown', (event) => {
  if (compactKeypad.matches && !keypadPanel.hidden && event.key === 'Escape') {
    event.preventDefault();
    setKeypadOpen(false);
    amountInput.focus({ preventScroll: true });
  }
});
initFish();
const storage = {
  get() {
    try { return JSON.parse(sessionStorage.getItem(storageKey)); } catch { return null; }
  },
  set(value) {
    try { value ? sessionStorage.setItem(storageKey, JSON.stringify(value)) : sessionStorage.removeItem(storageKey); } catch {}
  },
};
const debugCheckout = debugMode ? createDebugCheckout(storage.get(), {
  readOwner: async () => {
    const response = await fetch('/api/config', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000) });
    return response.ok ? (await response.json()).owner : undefined;
  },
}) : null;
const fetchCheckout = debugCheckout?.fetch ?? fetch;
function message(id, text = '') { $(id).textContent = text; $(id).hidden = !text; }
function busy(value) { $('submit-button').disabled = value || !config || (!config.demo && !config.paymentsAvailable); $('submit-label').textContent = value ? '正在准备付款码…' : '生成付款码'; }
async function api(path, options = {}) {
  const { timeout = 20000, ...request } = options;
  const response = await fetchCheckout(path, { ...request, signal: AbortSignal.timeout(timeout), headers: { 'Content-Type': 'application/json', ...request.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(body.error?.message || '暂时无法连接，请稍后再试。'); error.status = response.status; error.code = body.error?.code; throw error; }
  return body;
}
function renderOwner(owner) {
  const nickname = owner?.nickname || '鲸鲸的主人';
  const title = `投喂给 ${nickname} 的哦鲸鲸`;
  $('owner-title').textContent = title;
  $('owner-title').title = title;
  let homepage;
  try { homepage = new URL(owner?.homepageUrl || 'https://bonjour.bio/b36y9x'); } catch { return; }
  if (!['https:', 'http:'].includes(homepage.protocol) || homepage.username || homepage.password) return;
  const bonjour = ['bonjour.bio', 'www.bonjour.bio'].includes(homepage.hostname);
  let label = owner?.homepageDescription || '';
  if (bonjour) label = owner?.usesDefaultHomepage === false ? `${nickname}的Bonjour主页` : '开发者MirageBIN的Bonjour主页';
  $('owner-homepage').href = homepage.href;
  $('owner-homepage-label').textContent = label;
  $('bonjour-icon').hidden = !bonjour;
}
function resetCaptcha() { token = ''; if (turnstileId !== undefined && window.turnstile) window.turnstile.reset(turnstileId); }
function stopPolling() { clearTimeout(timer); clearInterval(countdown); }
function authenticated() { return { Authorization: `Bearer ${order.accessToken}` }; }
function schedulePoll() {
  clearTimeout(timer);
  if (order?.status === 'pending' && !checkingPayment && !handoff && !document.hidden) timer = setTimeout(poll, backoff);
}

function weChatPaymentUrl() {
  if (!inWeChat || config.demo || order?.status !== 'pending' || order.paymentState === 'expired' || !(Date.parse(order.expiresAt) > Date.now())) return null;
  try {
    const url = new URL(order.qrCode);
    const allowed = debugCheckout ? url.href === debugCheckout.paymentUrl : url.origin === 'https://qr.95516.com';
    return allowed && !url.username && !url.password ? url.href : null;
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
  button.textContent = seconds ? `手动查看投喂结果……${seconds}` : '手动查看投喂结果';
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

function setQrImage(src) {
  if (src) {
    qrImage.src = src;
    qrDownload.href = src;
  } else {
    qrImage.removeAttribute('src');
    qrDownload.removeAttribute('href');
  }
  qrImage.hidden = !src;
  qrDownload.hidden = !src;
}

function renderQrOverlay(pending, unavailable) {
  $('qr-overlay').hidden = pending && !unavailable;
  $('result-icon').hidden = unavailable;
  $('payment-unavailable').hidden = !unavailable;
  const timedOut = unavailable && Date.parse(order.expiresAt) <= Date.now();
  const expired = unavailable && (timedOut || order.status === 'expired' || order.paymentState === 'expired');
  expiredQrBackdrop.hidden = !expired || expiredQrBackdrop.dataset.orderId !== order.id;
  if (!unavailable) {
    unavailableImage.removeAttribute('src');
    message('payment-unavailable-caption');
    return;
  }
  const caption = timedOut && !config.demo ? '你盯着人家15分钟？！QAQ' : '';
  if ($('payment-unavailable-caption').textContent !== caption) message('payment-unavailable-caption', caption);
  if (!unavailableImage.hasAttribute('src')) unavailableImage.src = reducedMotion.matches ? unavailablePoster : unavailableAnimation;
}

reducedMotion.addEventListener('change', (event) => {
  if (event.matches && unavailableImage.getAttribute('src') === unavailableAnimation) unavailableImage.src = unavailablePoster;
});
unavailableImage.addEventListener('error', () => {
  if (unavailableImage.getAttribute('src') === unavailableAnimation) unavailableImage.src = unavailablePoster;
});

function renderUnavailablePayment(expired) {
  paymentView.dataset.state = expired ? 'expired' : 'failed';
  $('payment-total').hidden = true;
  $('payment-meta').hidden = true;
  $('countdown').hidden = true;
  $('payment-title').textContent = expired ? '二维码过期力！' : '投喂还没完成喵';
  $('payment-instruction').textContent = '若已扣款，请找收款人核对喵~';
  $('start-again').textContent = '再喂一次！';
  $('dismiss-payment').hidden = false;
}

function tick() {
  if (order?.status !== 'pending' || handoff) return;
  const seconds = order.paymentState === 'expired' ? 0 : Math.max(0, Math.ceil((Date.parse(order.expiresAt) - Date.now()) / 1000));
  $('countdown').textContent = seconds ? `投喂码有效期 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '正在确认付款结果…';
  if (!seconds) {
    if (!qrImage.hidden) setQrImage();
    renderQrOverlay(true, true);
    const paymentLink = $('payment-link');
    paymentLink.hidden = true;
    paymentLink.removeAttribute('href');
    $('switch-wechat').hidden = true;
    $('demo-pay').hidden = true;
    $('debug-expire').hidden = true;
    $('order-status').textContent = '二维码已过期';
    renderUnavailablePayment(true);
  }
}
async function renderOrder(verified = true) {
  setKeypadOpen(false);
  setQrImage();
  form.hidden = true; $('hero').hidden = true; $('payment-view').hidden = false;
  $('order-amount').textContent = `¥${order.amount}`;
  const pending = order.status === 'pending';
  const qrAvailable = order.paymentState !== 'expired' && Date.parse(order.expiresAt) > Date.now();
  const refunded = ['refunded', 'chargeback'].includes(order.paymentState);
  const unavailable = pending ? !qrAvailable : order.status === 'expired' || (order.status === 'failed' && !refunded);
  const success = order.status === 'paid' && verified;
  const redirecting = pending && !unavailable && !!handoff;
  paymentView.dataset.state = redirecting ? 'handoff' : success ? 'paid' : 'pending';
  $('payment-total').hidden = false;
  $('payment-meta').hidden = false;
  $('countdown').hidden = !pending || unavailable || redirecting;
  $('success-thanks').hidden = !success;
  $('dismiss-payment').hidden = true;
  $('order-method').textContent = redirecting || order.paymentMethod === 'wechat' ? '微信支付' : '支付宝';
  const showActions = pending && !redirecting;
  const animation = $('success-animation');
  animation.hidden = !success && !redirecting;
  $('qr-frame').hidden = redirecting || success;
  $('order-status').textContent = ({ waiting: '等待付款', processing: '正在支付', paid: '支付成功', expired: '二维码已过期', failed: '支付失败', refunded: '已退款', chargeback: '已退单' })[order.paymentState] || ({ pending: '等待付款', paid: '支付成功', expired: '已过期', failed: '未能完成' })[order.status] || '正在确认';
  $('check-payment').hidden = !showActions;
  $('return-merchant').hidden = !showActions;
  if (!showActions) { message('manual-check-status'); removeCheckFish(); }
  $('demo-pay').hidden = !(config.demo || debugCheckout) || !pending || unavailable;
  $('debug-expire').hidden = !debugCheckout || !pending || unavailable;
  const paymentLink = $('payment-link');
  const weChatUrl = showActions && !unavailable ? weChatPaymentUrl() : null;
  const weChatLink = order.paymentMethod === 'wechat' ? weChatUrl : null;
  const allowedPaymentUrl = debugCheckout ? order.paymentUrl === debugCheckout.paymentUrl : order.paymentUrl?.startsWith('https://');
  const alipayLink = !inWeChat && allowedPaymentUrl ? order.paymentUrl : null;
  const directUrl = weChatLink || alipayLink;
  $('switch-wechat').hidden = !weChatUrl || order.paymentMethod !== 'alipay' || weChatMethod.disabled;
  paymentLink.hidden = !showActions || unavailable || !directUrl;
  if (paymentLink.hidden) paymentLink.removeAttribute('href');
  else paymentLink.href = directUrl;
  paymentLink.target = weChatLink ? '_self' : '_blank';
  paymentLink.textContent = weChatLink ? '打开付款页' : '打开支付宝付款页';
  renderQrOverlay(pending, unavailable);
  $('start-again').disabled = false;
  $('start-again').textContent = redirecting ? '跳转支付……3' : pending ? '返回修改' : '再喂一次';
  $('countdown').textContent = '';
  if (redirecting) {
    $('payment-title').textContent = '投喂中';
    $('payment-instruction').textContent = '谢谢投喂喵！';
    return;
  }
  if (pending) {
    $('payment-title').textContent = '扫一扫上面就行了喵！';
    $('payment-instruction').textContent = config.demo ? '演示二维码，不会扣款。' : '投喂的款项直接充入 DeepSeek 开放平台变成我的白米饭喵~';
    const { id, qrCode } = order;
    if (qrCode && qrAvailable) {
      const stillScannable = () => order?.id === id && order.status === 'pending' && order.paymentState !== 'expired' && order.qrCode === qrCode && !handoff && Date.parse(order.expiresAt) > Date.now();
      try {
        const canvas = await QRCode.toCanvas(qrCode, { width: 420, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#151527', light: '#ffffff' } });
        if (stillScannable()) {
          setQrImage(canvas.toDataURL());
          const backdrop = expiredQrBackdrop.getContext('2d');
          if (backdrop) {
            backdrop.imageSmoothingQuality = 'high';
            const { width, height } = expiredQrBackdrop;
            backdrop.drawImage(canvas, 0, 0, width, height);
            const pixels = backdrop.getImageData(0, 0, width, height);
            // Use the sampled QR ink as opacity so the quiet zone stays transparent.
            const { data } = pixels;
            for (let offset = 0; offset < data.length; offset += 4) {
              data[offset + 3] = 255 - data[offset];
              data[offset] = 112;
              data[offset + 1] = 131;
              data[offset + 2] = 139;
            }
            backdrop.putImageData(pixels, 0, 0);
            expiredQrBackdrop.dataset.orderId = id;
          }
        }
      } catch {
        if (stillScannable()) message('poll-error', '二维码未能显示。请刷新恢复此订单，避免重复下单。');
      }
    }
    if (order?.id !== id || order.status !== 'pending' || handoff) return;
    tick(); clearInterval(countdown); countdown = setInterval(tick, 1000);
  } else {
    stopPolling();
    clearTimeout(handoffTimer);
    handoff = null;
    $('result-icon').textContent = order.status === 'paid' ? '✓' : '↻';
    $('payment-title').textContent = order.status === 'paid' ? (verified ? '投喂成功喵！' : '正在核对') : refunded ? '付款状态已更新' : '投喂还没完成喵';
    $('payment-instruction').textContent = order.status === 'paid' ? (verified ? (config.demo ? '演示完成，未发生真实付款。' : '投喂的款项直接充入 DeepSeek 开放平台变成我的白米饭喵~') : '正在确认订单状态…') : '若已扣款，请找收款人核对喵~';
  }
  if (unavailable) renderUnavailablePayment(order.status === 'expired' || order.paymentState === 'expired' || !qrAvailable);
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
$('amount-keypad').addEventListener('click', (event) => {
  const key = event.target.closest('button[data-key]')?.dataset.key;
  if (!key) return;
  const start = amountInput.selectionStart ?? amountInput.value.length;
  const end = amountInput.selectionEnd ?? start;
  const from = key === 'delete' && start === end ? Math.max(0, start - 1) : start;
  const insert = key === 'delete' ? '' : key;
  const value = (amountInput.value.slice(0, from) + insert + amountInput.value.slice(end)).replace(/^0+(?=\d)/, '');
  if (key !== 'delete' && !/^\d{0,6}$/.test(value)) return;
  amountInput.value = value;
  const caret = Math.min(value.length, from + insert.length);
  amountInput.focus({ preventScroll: true });
  amountInput.setSelectionRange(caret, caret);
  amountInput.dispatchEvent(new Event('input', { bubbles: true }));
});
$('nickname-skip').addEventListener('click', () => nicknameDialog.close('continue'));
$('nickname-edit').addEventListener('click', () => {
  nicknameDialog.close('edit');
  form.querySelector('.optional-fields').open = true;
  $('nickname').focus();
});
function chooseDialog(dialog) {
  setKeypadOpen(false);
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    dialog.showModal();
  });
}
form.addEventListener('submit', async (event) => {
  event.preventDefault(); message('form-error');
  setKeypadOpen(false);
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
    const request = { method: 'POST', headers: { 'Idempotency-Key': requestKey }, body: JSON.stringify({ ...body, turnstileToken: token }), timeout: 150000 };
    busy(true);
    try {
      order = await api('/api/orders', request);
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
function returnToForm() {
  if (handoff) { openPaymentPage(); return; }
  if (order?.status === 'pending' && !window.confirm('返回后仍可能完成这笔付款。若已经付款，请留在此页核对结果；确定返回修改吗？')) return;
  setKeypadOpen(false);
  stopPolling(); resetManualCheck(); setQrImage(); order = null; storage.set(null); requestFingerprint = null; requestKey = null;
  renderQrOverlay(true, false);
  $('payment-view').hidden = true; $('success-animation').hidden = true; $('hero').hidden = false; form.hidden = false; message('poll-error'); resetCaptcha(); $('amount').focus();
}
$('start-again').addEventListener('click', returnToForm);
$('dismiss-payment').addEventListener('click', returnToForm);
$('demo-pay').addEventListener('click', async () => {
  $('demo-pay').disabled = true;
  try {
    await api(`/api/orders/${encodeURIComponent(order.id)}/demo-pay`, { method: 'POST', headers: authenticated(), body: '{}' });
    await poll();
  }
  catch (error) { message('poll-error', error.message); }
  finally { $('demo-pay').disabled = false; }
});
$('debug-expire').addEventListener('click', async () => {
  if (!debugCheckout || order?.status !== 'pending') return;
  debugCheckout.expire();
  await poll();
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
  $('debug-notice').hidden = !debugCheckout;
  try {
    config = await api('/api/config'); $('demo-notice').hidden = !config.demo;
    renderOwner(config.owner);
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
