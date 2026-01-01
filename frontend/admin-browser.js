import { VIEWPORT, validPairCode, AGENT_CLOSE } from '../shared/browser-agent-protocol.js';
import { createAgentStatusWatcher } from './admin-agent-status.js';
import { maxPaymentAmount, PAYMENT_PROTOCOL } from '../shared/agent-payment-protocol.js';
import QRCode from 'qrcode';

export function initBrowserAgent() {
  const el = (id) => document.getElementById(id);
  const canvas = el('agent-screen'); const ctx = canvas.getContext('2d');
  let socket; let online = false; let paired = false; let bitmapBusy = false; let dragging = false; let moveAt = 0;
  let paymentReady = false; let paymentBusy = false; let testOrder = null; let paymentRender = 0; let renderedQr = null;
  let receivingAccountId = null; let canSelectRecipient = false;
  const profileRefresh = el('admin-profile-refresh');
  const profileMessage = el('admin-profile-message');
  const profileAvatar = el('admin-profile-avatar');
  const profileFallback = el('admin-profile-fallback');
  const testIds = new Map(); const testButtons = [...document.querySelectorAll('[data-agent-test-method]')];
  const updatePaymentControls = () => {
    for (const button of testButtons) button.disabled = !online || !paymentReady || !receivingAccountId || paymentBusy;
    el('agent-test-check').disabled = !online || !paymentReady || paymentBusy || !testOrder?.id;
    el('agent-select-recipient').disabled = !online || !canSelectRecipient || paymentBusy;
    el('agent-clear-recipient').disabled = !receivingAccountId || paymentBusy;
    profileRefresh.disabled = !online || !canSelectRecipient || !receivingAccountId || paymentBusy;
  };
  function readPairingLink() {
    const values = new URLSearchParams(location.hash.slice(1));
    if (!values.has('agent_pair')) return;
    const code = values.get('agent_pair');
    history.replaceState(null, '', `${location.pathname}${location.search}#admin-account`);
    if (validPairCode(code)) el('agent-pair-code').value = code;
  }
  readPairingLink();
  window.addEventListener('hashchange', readPairingLink);
  const notice = (text) => { if (el('agent-notice').textContent !== text) el('agent-notice').textContent = text; };
  const paymentNotice = (text) => { el('agent-test-notice').textContent = text; };
  function showAvatar(loaded) {
    profileAvatar.hidden = !loaded;
    profileFallback.hidden = loaded;
  }
  profileAvatar.addEventListener('load', () => showAvatar(profileAvatar.hasAttribute('src')));
  profileAvatar.addEventListener('error', () => showAvatar(false));
  function renderProfile(profile, selected) {
    el('admin-profile-name').textContent = profile?.nickname || (selected ? 'DeepSeek 账号' : '未启用收款账号');
    el('admin-balance').textContent = typeof profile?.balance === 'string' ? `¥${profile.balance}` : '—';
    const avatar = profile?.avatarUrl || null;
    if (profileAvatar.getAttribute('src') === avatar) return;
    showAvatar(false);
    if (avatar) profileAvatar.src = avatar;
    else profileAvatar.removeAttribute('src');
  }
  const controls = (enabled) => {
    for (const button of document.querySelectorAll('[data-agent-command]')) button.disabled = !enabled;
    el('agent-text').disabled = !enabled; el('agent-send-text').disabled = !enabled;
  };
  async function api(path, body) {
    const response = await fetch(path.startsWith('/api/admin/') ? path : `/api/admin/browser-agent/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Feedfish-Admin': '1' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', redirect: 'error' });
    const result = await response.json();
    if (!response.ok) {
      const code = typeof result.error === 'string' ? result.error : result.error?.code;
      const message = ({ PAIRING_EXPIRED: '配对码已失效，请在服务端重新发起。', DEVICE_ALREADY_PAIRED: '已有已配对设备，请先确认是否更换。', ACCESS_DENIED: '请重新通过 Access 登录。', RATE_LIMITED: '操作过于频繁，请稍后重试。', AGENT_BUSY: '浏览器正在处理付款或账户核验，请稍后重试。', AGENT_OFFLINE: '请先启动自托管浏览器。', AGENT_UPDATE_REQUIRED: '请重启本机 browser-agent 加载更新。', LOGIN_REQUIRED: '请在实时窗口中登录 DeepSeek。', SESSION_EXPIRED: '请在实时窗口中重新登录 DeepSeek。', ACCOUNT_INELIGIBLE: '当前账号不符合 CNY 充值要求。', ACCOUNT_CHECK_FAILED: '未能核验当前登录账号，请检查实时窗口。' })[code] || result.error?.message || '操作未完成，请检查 Access 登录和服务状态。';
      const error = new Error(message); error.code = code; error.diagnostic = result.error?.diagnostic; throw error;
    }
    return result;
  }
  const statusWatcher = createAgentStatusWatcher({
    load: () => api('status'),
    visible: () => document.visibilityState !== 'hidden',
    onStatus: (data) => {
      const previousOnline = online; const previousPaired = paired;
      online = data.online === true; paired = data.configured === true;
      const nextRecipient = data.receivingAccountId || null;
      if (nextRecipient !== receivingAccountId) {
        testIds.clear();
        profileMessage.textContent = '';
      }
      receivingAccountId = nextRecipient;
      renderProfile(receivingAccountId ? data.profile : null, Boolean(receivingAccountId));
      canSelectRecipient = data.paymentProtocol === PAYMENT_PROTOCOL;
      paymentReady = maxPaymentAmount(data.paymentProtocol) > 0; updatePaymentControls();
      el('agent-recipient-status').textContent = receivingAccountId ? '收款账号已启用。' : '尚未启用收款账号。';
      el('agent-status').textContent = online ? `${data.name} · 在线` : paired ? `${data.name} · 离线` : '未配对';
      el('agent-open').disabled = !online || [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket?.readyState);
      el('agent-revoke').disabled = !paired;
      el('agent-approve').disabled = !!data.demo;
      if (online && !previousOnline) {
        if (receivingAccountId && paymentReady) notice('浏览器已在线，可以生成 1 CNY 未付款测试码。');
        else if (canSelectRecipient) notice('登录 DeepSeek 后，点击“启用当前登录账号”开始收款。');
        else notice('请重启本机 browser-agent 加载收款账号设置。');
      }
      else if (paired && !online && (!previousPaired || previousOnline)) notice('已配对，正在等待浏览器启动；上线后页面会自动更新。');
    },
    onError: (error) => {
      notice(error.message);
      if (error.code === 'ACCESS_DENIED') renderProfile(null, false);
    },
    onTimeout: () => notice('尚未收到服务连接，请检查终端日志；点击“刷新”可重新等待。'),
  });
  const refresh = () => statusWatcher.start();
  profileRefresh.addEventListener('click', async () => {
    if (profileRefresh.disabled) return;
    paymentBusy = true;
    updatePaymentControls();
    profileMessage.textContent = '正在核验收款账号并读取资料…';
    try {
      const result = await api('/api/admin/account/check', { transport: 'agent' });
      await refresh();
      profileMessage.textContent = result.profile ? '已同步账号资料。' : '账号已核验。请重启 browser-agent 加载新版，再刷新账号资料。';
    } catch (error) {
      await refresh();
      profileMessage.textContent = error.message;
    } finally {
      paymentBusy = false;
      updatePaymentControls();
    }
  });
  async function changeRecipient(action) {
    if (paymentBusy) return;
    paymentBusy = true;
    updatePaymentControls();
    try {
      await api('recipient', { action });
      await refresh();
      notice(action === 'select' ? '已核验并启用当前登录账号。' : '收款账号已解绑，已暂停生成新付款码。');
    } catch (error) { notice(error.message); }
    finally { paymentBusy = false; updatePaymentControls(); }
  }
  el('agent-select-recipient').addEventListener('click', () => void changeRecipient('select'));
  el('agent-clear-recipient').addEventListener('click', () => void changeRecipient('clear'));
  async function showTestOrder(order) {
    const render = ++paymentRender; const needsQr = order.qrCode && renderedQr !== order.qrCode;
    testOrder = order;
    el('agent-test-qr').hidden = !order.qrCode || !!needsQr;
    const labels = { waiting: '等待付款', processing: '平台处理中', paid: '已支付', expired: '二维码已过期', failed: '未成功', refunded: '已退款', chargeback: '已拒付', unknown: '待核对' };
    el('agent-test-result').textContent = `最近测试：${order.amount} CNY · ${order.paymentMethod === 'wechat' ? '微信' : '支付宝'} · ${labels[order.paymentState] || '等待确认'}`;
    el('agent-test-check').hidden = false; updatePaymentControls();
    if (needsQr) {
      const image = await QRCode.toDataURL(order.qrCode, { width: 440, margin: 3 });
      if (render !== paymentRender) return false;
      el('agent-test-qr').src = image; renderedQr = order.qrCode; el('agent-test-qr').hidden = false;
    }
    return render === paymentRender;
  }
  const ordersChanged = () => window.dispatchEvent(new Event('feedfish:agent-order-updated'));
  const orderWatcher = createAgentStatusWatcher({
    load: async () => (await api(`/api/admin/account/agent-payment/status${testOrder?.id ? `?id=${encodeURIComponent(testOrder.id)}` : ''}`)).order,
    visible: () => document.visibilityState !== 'hidden',
    keepWaiting: (order) => ['creating', 'pending'].includes(order?.status),
    interval: 3000, duration: 20 * 60000,
    onStatus: async (order) => {
      if (!order) return;
      const previous = testOrder;
      if (!await showTestOrder(order)) return;
      if (previous?.id !== order.id || previous?.paymentState !== order.paymentState) {
        ordersChanged();
        if (order.paymentState === 'paid') paymentNotice('DeepSeek 已确认付款，账单已记为“已支付”，付款码已收起。');
      }
    },
    onError: (error) => paymentNotice(`账单自动同步已暂停。${error.message}`),
    onTimeout: () => paymentNotice('自动同步已暂停，后台仍会定时核对。可点击“核对测试账单”查看最新结果。'),
  });
  for (const button of testButtons) button.addEventListener('click', async () => {
    if (button.disabled || paymentBusy) return;
    const method = button.dataset.agentTestMethod;
    if (!testIds.has(method)) testIds.set(method, crypto.randomUUID());
    const oldNotice = el('action-notice'); oldNotice.hidden = true; oldNotice.textContent = '';
    orderWatcher.stop(); paymentRender++;
    el('agent-test-qr').hidden = true; el('agent-test-result').textContent = ''; testOrder = null; el('agent-test-check').hidden = true;
    paymentBusy = true; updatePaymentControls(); paymentNotice('正在通过已登录浏览器生成 1 CNY 测试账单，只请求一次，请等待…');
    try {
      const order = await api('/api/admin/account/test-payment', { transport: 'agent', paymentMethod: method, requestId: testIds.get(method) });
      await showTestOrder(order); ordersChanged(); paymentNotice(order.qrCode ? '已生成 1 CNY 测试码。付款后会自动同步官方结果，也可手动核对。' : '已读取原测试账单，当前没有待付款二维码。');
    } catch (error) {
      const status = error.diagnostic?.upstreamStatus;
      const challenge = ['captcha', 'challenge'].includes(error.diagnostic?.upstreamChallenge) ? ' 官网要求浏览器验证。' : '';
      paymentNotice(`自托管取码未完成。${error.message}${Number.isInteger(status) ? `（HTTP ${status}）` : ''}${challenge} 若结果不确定，请核对原账单，避免新建另一笔。`);
      ordersChanged();
    } finally { paymentBusy = false; updatePaymentControls(); if (testOrder) void orderWatcher.start(); }
  });
  el('agent-test-check').addEventListener('click', async () => {
    if (!testOrder?.id || paymentBusy) return;
    orderWatcher.stop(); paymentRender++;
    paymentBusy = true; updatePaymentControls();
    try { await showTestOrder(await api('/api/admin/account/agent-payment/check', { id: testOrder.id })); ordersChanged(); paymentNotice('已核对官方订单，最近账单也已更新。'); }
    catch (error) { paymentNotice(error.message); }
    finally { paymentBusy = false; updatePaymentControls(); void orderWatcher.start(); }
  });
  function send(message) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message.type === 'frame-ack' ? message : { ...message, id: crypto.randomUUID() }));
  }
  function clearScreen() { ctx.clearRect(0, 0, canvas.width, canvas.height); el('agent-text').value = ''; controls(false); }
  el('agent-refresh').addEventListener('click', () => { void refresh(); });
  el('agent-approve').addEventListener('click', async () => {
    const code = el('agent-pair-code').value.trim().toUpperCase();
    if (!validPairCode(code)) { notice('请输入服务端显示的配对码，例如 ABCD-2345。'); return; }
    if (paired && !confirm('更换已配对的浏览器服务？旧设备的远程连接权限会被撤销；本地浏览器资料和现有账单会保留。')) return;
    el('agent-approve').disabled = true;
    try { const result = await api('approve', { code, replace: paired }); el('agent-pair-code').value = ''; notice(`已配对 ${result.name}，等待浏览器启动；状态会自动更新。`); await refresh(); }
    catch (error) { notice(error.message); }
    finally { el('agent-approve').disabled = false; }
  });
  el('agent-revoke').addEventListener('click', async () => {
    if (!confirm('解除设备配对后，服务会停止连接，需重新输入配对码。仅关闭画面请使用“关闭实时窗口”。确定解除设备配对吗？')) return;
    try { await api('revoke', {}); socket?.close(); notice('设备配对已解除。重新连接请运行 npm run browser-agent -- --pair；浏览器登录资料保留。'); await refresh(); } catch (error) { notice(error.message); }
  });
  el('agent-open').addEventListener('click', () => {
    if (!online || [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket?.readyState)) return;
    clearScreen();
    el('agent-open').disabled = true;
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/admin/browser-agent/socket`);
    socket.binaryType = 'blob';
    const connection = socket;
    let ping;
    socket.addEventListener('open', () => { el('agent-view').hidden = false; el('agent-open').disabled = true; notice('已连接。可直接点击画面、输入文字和手动完成官方验证码。'); ping = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send('ping'); }, 20000); });
    socket.addEventListener('message', async (event) => {
      if (connection !== socket) return;
      if (event.data instanceof Blob) {
        if (bitmapBusy) return;
        bitmapBusy = true;
        try { const bitmap = await createImageBitmap(event.data); ctx.drawImage(bitmap, 0, 0, VIEWPORT.width, VIEWPORT.height); bitmap.close(); controls(true); }
        catch { notice('画面未能解码，请关闭窗口后重连。'); }
        finally { bitmapBusy = false; send({ type: 'frame-ack' }); }
        return;
      }
      if (event.data === 'pong') return;
      let data; try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === 'order-updated') {
        if (data.id === testOrder?.id && !paymentBusy) void orderWatcher.start();
        else ordersChanged();
      }
      if (data.type === 'presence' && !data.online) { clearScreen(); notice('浏览器服务已离线，正在等待重连。'); void refresh(); }
      if (data.type === 'error') notice(data.code === 'AGENT_BUSY' ? '浏览器正在取码或查单，请等待当前任务结束。' : '操作未发送：服务离线或请求无效。');
      if (data.type === 'result' && data.command === 'check-account') {
        const messages = { LOGIN_REQUIRED: '请先在画面中登录 DeepSeek。', ACCOUNT_MISMATCH: '未能核验当前登录账号，请重启执行端后重试。', ACCOUNT_INELIGIBLE: '账户币种或资格不符合要求。', SESSION_EXPIRED: '登录已失效，请在画面中重新登录。', AUTH_TOKEN_MISSING: '官方接口未识别登录 Token。', UPSTREAM_NOT_JSON: '本机账户接口仍未返回 JSON。', UPSTREAM_UNAVAILABLE: '本机暂未连通账户接口。' };
        notice(data.result.ok ? '当前登录账号符合 CNY 充值要求。' : `${messages[data.result.code] || '账户核验未完成。'}${data.result.httpStatus ? ` HTTP ${data.result.httpStatus}` : ''}`);
      }
    });
    socket.addEventListener('close', (event) => {
      clearInterval(ping); if (connection !== socket) return; clearScreen();
      notice(event.code === AGENT_CLOSE.REVOKED ? '设备配对已解除或更换，请运行 npm run browser-agent -- --pair 后重新配对。' : event.code === AGENT_CLOSE.DEVICE_EXPIRED ? '设备授权已到期，请重新配对。' : event.code === AGENT_CLOSE.ACCESS_EXPIRED ? '控制窗口或 Access 会话已到期，请确认登录后重新打开窗口。' : '实时窗口已关闭，可重新打开；设备配对和浏览器登录保留。');
      void refresh();
    });
    socket.addEventListener('error', () => { notice('实时连接未建立。请确认 Access 有效、服务在线，且没有其他控制窗口。'); });
  });
  el('agent-close').addEventListener('click', () => { socket?.close(); el('agent-view').hidden = true; });
  for (const button of document.querySelectorAll('[data-agent-command]')) button.addEventListener('click', () => send({ type: button.dataset.agentCommand, ...(button.dataset.agentPage ? { page: button.dataset.agentPage } : {}) }));
  function point(event) { const r = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(VIEWPORT.width - 1, Math.round((event.clientX - r.left) * VIEWPORT.width / r.width))), y: Math.max(0, Math.min(VIEWPORT.height - 1, Math.round((event.clientY - r.top) * VIEWPORT.height / r.height))) }; }
  canvas.addEventListener('pointerdown', (event) => { if (event.button !== 0) return; event.preventDefault(); canvas.focus(); dragging = true; canvas.setPointerCapture(event.pointerId); send({ type: 'input', event: 'down', ...point(event) }); });
  canvas.addEventListener('pointermove', (event) => { if (dragging && Date.now() - moveAt > 40) { moveAt = Date.now(); send({ type: 'input', event: 'move', ...point(event) }); } });
  for (const name of ['pointerup', 'pointercancel']) canvas.addEventListener(name, (event) => { if (dragging) { dragging = false; send({ type: 'input', event: 'up', ...point(event) }); } });
  canvas.addEventListener('wheel', (event) => { event.preventDefault(); send({ type: 'input', event: 'wheel', deltaY: Math.round(Math.max(-800, Math.min(800, event.deltaY))) }); }, { passive: false });
  canvas.addEventListener('keydown', (event) => {
    if (event.isComposing || event.key === 'Process') return;
    const keys = ['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); send({ type: 'input', event: 'key', key: 'ControlOrMeta+A' }); }
    else if (keys.includes(event.key)) { event.preventDefault(); send({ type: 'input', event: 'key', key: event.key }); }
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); send({ type: 'input', event: 'text', text: event.key }); }
  });
  el('agent-text-form').addEventListener('submit', (event) => { event.preventDefault(); const text = el('agent-text').value; el('agent-text').value = ''; if (text) send({ type: 'input', event: 'text', text }); canvas.focus(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { statusWatcher.stop(); orderWatcher.stop(); paymentRender++; }
    else { void refresh(); if (!paymentBusy) void orderWatcher.start(); }
  });
  window.addEventListener('pagehide', () => { statusWatcher.stop(); orderWatcher.stop(); paymentRender++; socket?.close(); clearScreen(); });
  controls(false); void refresh(); void orderWatcher.start();
}
