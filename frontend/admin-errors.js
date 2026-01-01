const messages = {
  INVALID_SESSION: '请填写有效的 DeepSeek 登录 Cookie 或 Token，至少一项。',
  INVALID_COOKIE: 'Cookie 格式无效，请只复制 Cookie 请求头的一行内容。',
  INVALID_DEVICE: '设备信息格式无效。',
  BODY_TOO_LARGE: '凭证内容过长，请只填写所需的 Cookie / Token。',
  AUTH_TOKEN_MISSING: 'DeepSeek 未收到有效的鉴权 Token。请导入官网 Local Storage 中的 userToken，或请求头的 Authorization。',
  PAYMENT_DEVICE_UNAVAILABLE: '未能取得官网 SDK 的设备信息，未发起付款请求。',
  PAYMENT_VERIFICATION_REQUIRED: '官网浏览器验证未完成，未发起付款请求。',
  BROWSER_NOT_CONFIGURED: '云浏览器或固定账户尚未配置。',
  BROWSER_GRANT_REQUIRED: '云浏览器核验需要已保存的官方授权。',
  BROWSER_BUSY: '云浏览器资源暂不可用，请稍后再核验。',
  BROWSER_RATE_LIMIT: 'Cloudflare 暂时限制了云浏览器请求，请稍后再核验。',
  BROWSER_UNAVAILABLE: '云浏览器账户核验暂不可用，请稍后再检查。',
  AUTH_EXPIRED: '暂存凭证或授权已结束，请重新导入会话或授权。',
  AUTH_BUSY: '账户核验正在处理，请稍后重试。',
  AUTH_PENDING: '已有暂存凭证，请重试账户核验或清除暂存。',
  AUTH_REJECTED: 'DeepSeek 未接受本次授权码兑换。',
  AUTH_NETWORK: 'Cloudflare 未能连通 DeepSeek 授权接口。',
  AUTH_CHALLENGE: 'DeepSeek 要求验证 Cloudflare 的出站请求。',
  AUTH_NOT_JSON: 'DeepSeek 授权接口未返回 JSON，不能完成授权。',
  AUTH_PROTOCOL: 'DeepSeek 授权响应不符合预期格式。',
  AUTH_SAVE_FAILED: '会话未能保存，请检查后台存储。',
  ACCOUNT_INVALID: '未能从 DeepSeek 账户资料中确认账户 ID。',
  ACCOUNT_UNAVAILABLE: '账户资料未通过 CNY 充值资格核验。',
  ACCOUNT_MISMATCH: '此登录账号与固定收款账户不一致，未替换已有会话。',
  SESSION_EXPIRED: 'DeepSeek 拒绝了 Cloudflare 提交的登录会话。',
  VAULT_UNAVAILABLE: '账户保险库暂不可用，请检查后台配置。',
  UPSTREAM_UNAVAILABLE: 'Cloudflare 未能连通 DeepSeek 账户接口。',
  UPSTREAM_NOT_JSON: 'DeepSeek 账户接口未返回 JSON，账户核验未完成。',
  UPSTREAM_PROTOCOL: 'DeepSeek 账户接口响应格式异常。',
  UPSTREAM_HTTP: 'DeepSeek 账户接口返回了 HTTP 错误。',
  UPSTREAM_REDIRECT: 'DeepSeek 账户接口返回重定向，已停止请求以保护凭证。',
  UPSTREAM_REJECTED: 'DeepSeek 账户接口未接受本次请求。',
  ACCESS_DENIED: '管理权限尚未就绪，请完成 Cloudflare Access 登录后重新加载页面。',
  ADMIN_NETWORK: '管理请求未能完成，请检查网络和 Access 登录状态。',
  ADMIN_RESPONSE: '管理入口未返回有效的接口响应。',
};
export function accountErrorMessage(error) {
  const message = Object.hasOwn(messages, error?.code) ? messages[error.code] : '连接未完成，请查看后台诊断后重试。';
  const diagnostic = error?.diagnostic;
  const stages = { initialize: '授权初始化', exchange: '授权码兑换', account: '账户核验' };
  const stage = Object.hasOwn(stages, diagnostic?.stage) ? stages[diagnostic.stage] : null;
  const details = stage ? [stage] : [];
  if (Number.isInteger(diagnostic?.upstreamStatus) && diagnostic.upstreamStatus >= 100 && diagnostic.upstreamStatus <= 599) details.push(`HTTP ${diagnostic.upstreamStatus}`);
  for (const [key, label] of [['upstreamCode', 'code'], ['upstreamBizCode', 'biz_code']]) if (Number.isSafeInteger(diagnostic?.[key])) details.push(`${label} ${diagnostic[key]}`);
  const checks = { identity: '账户 ID', currency: 'CNY 币种', banned: 'API 使用资格', payment: '充值权限' };
  const check = Object.hasOwn(checks, diagnostic?.accountCheck) ? checks[diagnostic.accountCheck] : null;
  if (check) details.push(check);
  if (['captcha', 'challenge'].includes(diagnostic?.upstreamChallenge)) details.push('上游人机验证');
  if (diagnostic?.credentialMode === 'cookie') details.push('仅有 Cookie');
  if (Object.hasOwn(messages, error?.code)) details.push(error.code);
  return details.length ? `${message}（${details.join(' · ')}）` : message;
}
