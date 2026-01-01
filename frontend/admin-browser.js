import { VIEWPORT, validPairCode, AGENT_CLOSE } from '../shared/browser-agent-protocol.js';
import { createAgentStatusWatcher } from './admin-agent-status.js';

export function initBrowserAgent() {
  const el = (id) => document.getElementById(id);
  const canvas = el('agent-screen'); const ctx = canvas.getContext('2d');
  let socket; let online = false; let paired = false; let bitmapBusy = false; let dragging = false; let moveAt = 0;
  const values = new URLSearchParams(location.hash.slice(1));
  if (values.has('agent_pair')) {
    const code = values.get('agent_pair');
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    if (validPairCode(code)) el('agent-pair-code').value = code;
  }
  const notice = (text) => { if (el('agent-notice').textContent !== text) el('agent-notice').textContent = text; };
  const controls = (enabled) => {
    for (const button of document.querySelectorAll('[data-agent-command]')) button.disabled = !enabled;
    el('agent-text').disabled = !enabled; el('agent-send-text').disabled = !enabled;
  };
  async function api(path, body) {
    const response = await fetch(`/api/admin/browser-agent/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Feedfish-Admin': '1' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', redirect: 'error' });
    const result = await response.json();
    if (!response.ok) {
      const code = typeof result.error === 'string' ? result.error : result.error?.code;
      throw new Error(({ PAIRING_EXPIRED: '配对码已失效，请在服务端重新发起。', DEVICE_ALREADY_PAIRED: '已有已配对设备，请先确认是否更换。', ACCESS_DENIED: '请重新通过 Access 登录。', RATE_LIMITED: '操作过于频繁，请稍后重试。' })[code] || '操作未完成，请检查 Access 登录和服务状态。');
    }
    return result;
  }
  const statusWatcher = createAgentStatusWatcher({
    load: () => api('status'),
    visible: () => document.visibilityState !== 'hidden',
    onStatus: (data) => {
      const previousOnline = online; const previousPaired = paired;
      online = data.online === true; paired = data.configured === true;
      el('agent-status').textContent = online ? `${data.name} · 在线` : paired ? `${data.name} · 离线` : '未配对';
      el('agent-open').disabled = !online || [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket?.readyState);
      el('agent-revoke').disabled = !paired;
      el('agent-approve').disabled = !!data.demo;
      if (online && !previousOnline) notice('浏览器已在线。点击“打开实时窗口”查看画面。');
      else if (paired && !online && (!previousPaired || previousOnline)) notice('已配对，正在等待浏览器启动；上线后页面会自动更新。');
    },
    onError: (error) => notice(error.message),
    onTimeout: () => notice('尚未收到服务连接，请检查终端日志；点击“刷新”可重新等待。'),
  });
  const refresh = () => statusWatcher.start();
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
      if (data.type === 'presence' && !data.online) { clearScreen(); notice('浏览器服务已离线，正在等待重连。'); void refresh(); }
      if (data.type === 'error') notice('操作未发送：服务离线或请求无效。');
      if (data.type === 'result' && data.command === 'check-account') {
        const messages = { LOGIN_REQUIRED: '请先在画面中登录 DeepSeek。', ACCOUNT_MISMATCH: '登录账户与固定收款账户不一致。', ACCOUNT_INELIGIBLE: '账户币种或资格不符合要求。', SESSION_EXPIRED: '登录已失效，请在画面中重新登录。', AUTH_TOKEN_MISSING: '官方接口未识别登录 Token。', UPSTREAM_NOT_JSON: '本机账户接口仍未返回 JSON。', UPSTREAM_UNAVAILABLE: '本机暂未连通账户接口。' };
        notice(data.result.ok ? '本机浏览器已核对固定账户和 CNY。支付取码与到账尚待验证。' : `${messages[data.result.code] || '账户核验未完成。'}${data.result.httpStatus ? ` HTTP ${data.result.httpStatus}` : ''}`);
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
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') statusWatcher.stop(); else void refresh(); });
  window.addEventListener('pagehide', () => { statusWatcher.stop(); socket?.close(); clearScreen(); });
  controls(false); void refresh();
}
