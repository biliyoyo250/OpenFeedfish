import { ApiError } from './lib.js';
import { agentRequest } from './browser-agent.js';
import { paymentJob, paymentJobResult } from '../shared/agent-payment-protocol.js';

// A fetch-compatible adapter for existing provider parsing and ledger checks.
// Upstream authorization headers are intentionally never forwarded to the host.
export function agentPaymentFetcher(env, scope) {
  return async (url, options = {}) => {
    let operation; let fields = {}; let dispatched = false;
    try {
      if (url === 'https://platform.deepseek.com/auth-api/v0/users/current' && options.method === 'GET' && options.body === undefined) operation = 'profile';
      else if (scope?.requestId && url === 'https://platform.deepseek.com/api/v1/payments' && options.method === 'POST') {
        const body = JSON.parse(options.body || 'null'); const info = body?.order_info;
        const amountFen = scope.amountFen ?? 100;
        if (info?.request_id !== scope.requestId || info.amount !== String(amountFen / 100) || info.currency !== 'CNY' || info.payment_method_type !== 'CMB_UNIONPAY' || info.fallback_method_type !== (scope.paymentMethod === 'wechat' ? 'WECHAT' : 'ALIPAY')) throw new Error();
        operation = 'create'; fields = { requestId: scope.requestId, paymentMethod: scope.paymentMethod, amountFen };
      } else if (scope?.providerOrderId && url === `https://platform.deepseek.com/api/v1/payments/${encodeURIComponent(scope.providerOrderId)}/capture` && options.method === 'POST' && options.body === undefined) { operation = 'capture'; fields = { providerOrderId: scope.providerOrderId }; }
      else if (scope?.providerOrderId && url === 'https://platform.deepseek.com/auth-api/v0/users/get_all_invoice' && options.method === 'GET' && options.body === undefined) { operation = 'invoice'; fields = { providerOrderId: scope.providerOrderId }; }
      else throw new Error();
      const job = paymentJob({ type: 'payment-job', id: crypto.randomUUID(), accountId: env.DEEPSEEK_ACCOUNT_ID, operation, ...fields }, env.DEEPSEEK_ACCOUNT_ID);
      const rpc = operation === 'invoice' && scope.waitForBrowser ? { ...job, waitForBrowser: true } : job;
      let result;
      try { dispatched = true; result = paymentJobResult(job, await (await agentRequest(env, '/execute', rpc)).json()); }
      catch { throw Object.assign(new ApiError(503, 'AGENT_UNAVAILABLE', '自托管浏览器请求未完成，请检查原账单；不会自动重复创建。'), { creationAttempted: operation === 'create' }); }
      if (!result.ok) {
        const messages = { AGENT_OFFLINE: '自托管浏览器离线，请保持执行端运行。', AGENT_UPDATE_REQUIRED: '请重启本机 browser-agent 加载更新。', AGENT_BUSY: '浏览器正在处理另一项任务，请稍后查看。', AGENT_TIMEOUT: '浏览器任务超时，请核对原账单，避免重复创建。', ACCOUNT_NOT_CONFIGURED: '请先启用当前登录的收款账号。', ACCOUNT_MISMATCH: '当前登录的账号与本次订单的收款账号不一致。', ACCOUNT_INELIGIBLE: '浏览器账户不符合 CNY 充值要求。', LOGIN_REQUIRED: '请先在实时窗口中登录 DeepSeek。', PAYMENT_VERIFICATION_REQUIRED: '官方浏览器验证未完成，请在实时窗口手动处理。', PAYMENT_DEVICE_UNAVAILABLE: '官网设备组件未就绪，尚未发起支付请求。', JOB_EXPIRED: '本次浏览器任务已超时或连接已失效。' };
        throw Object.assign(new ApiError(503, result.code, messages[result.code] || '浏览器中的官方请求未完成，请检查实时画面。'), { creationAttempted: result.creationAttempted, ...(result.httpStatus ? { upstreamStatus: result.httpStatus } : {}) });
      }
      return new Response(result.isJson ? JSON.stringify(result.data) : null, { status: result.httpStatus, headers: { ...(result.isJson ? { 'Content-Type': 'application/json' } : {}), ...(result.challenge ? { 'x-amzn-waf-action': result.challenge } : {}) } });
    } catch (error) {
      if (!(error instanceof ApiError)) throw Object.assign(new ApiError(dispatched ? 503 : 400, dispatched ? 'AGENT_PROTOCOL' : 'INVALID_REQUEST', dispatched ? '浏览器返回的数据未能核对，请检查原账单。' : '请求超出本次订单范围。'), { creationAttempted: dispatched && operation === 'create' });
      throw error;
    }
  };
}
