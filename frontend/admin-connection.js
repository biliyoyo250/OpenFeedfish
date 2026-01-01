const protocolError = message => Object.assign(new Error(message), { code: 'AUTH_PROTOCOL' });

export async function beginLocalAuthorization({ input, pendingId, request, navigate, now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !Number.isInteger(input.callbackPort) || input.callbackPort < 1024 || input.callbackPort > 65535
    || typeof input.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.state)
    || typeof request !== 'function' || typeof navigate !== 'function' || !Number.isFinite(now)) {
    throw protocolError('本机连接参数无效，请重新运行连接助手。');
  }
  if (pendingId !== undefined && pendingId !== null
    && (typeof pendingId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pendingId))) {
    throw protocolError('暂存凭证标识无效，请刷新后台后重试。');
  }
  const payload = { callbackPort: input.callbackPort, state: input.state };
  if (pendingId !== undefined && pendingId !== null) {
    const discarded = await request('/api/admin/account/authorize/discard', { id: pendingId });
    if (discarded?.ok !== true) throw protocolError('未能确认暂存凭证已清除，请刷新后台后重试。');
  }
  const result = await request('/api/admin/account/authorize/start', payload);
  let url;
  try { url = new URL(result?.authorizeUrl); }
  catch { throw protocolError('官方授权地址无效，请重新连接。'); }
  const expiresAt = typeof result?.expiresAt === 'string' ? Date.parse(result.expiresAt) : NaN;
  if (typeof result?.authorizeUrl !== 'string' || url.origin !== 'https://platform.deepseek.com'
    || url.pathname !== '/dsh/authorize' || url.username || url.password || url.hash
    || !Number.isFinite(expiresAt) || expiresAt <= now) {
    throw protocolError('官方授权地址或有效期无效，请重新连接。');
  }
  try { await navigate(url.href); }
  catch { throw protocolError('暂时无法打开 DeepSeek 官方授权页，请稍后重试。'); }
}
