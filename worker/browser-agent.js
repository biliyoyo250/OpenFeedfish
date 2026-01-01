import { ApiError, readJson, hash } from './lib.js';

function relay(env) {
  if (!env.AGENT_RELAY) throw new ApiError(503, 'AGENT_NOT_CONFIGURED', '本地浏览器服务尚未配置。');
  return env.AGENT_RELAY.get(env.AGENT_RELAY.idFromName('fixed-account-browser'));
}
export async function agentRequest(env, path, body, headers = {}) {
  const response = await relay(env).fetch(new Request(`https://relay.internal${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  return response;
}
export async function handleAgentPublic(request, env) {
  const path = new URL(request.url).pathname;
  if (request.headers.has('Origin')) throw new ApiError(403, 'AGENT_DENIED', '请使用浏览器服务连接。');
  if (path === '/api/browser-agent/connect' && request.method === 'GET') return relay(env).fetch(new Request('https://relay.internal/agent', { headers: { Upgrade: request.headers.get('Upgrade') || '', Authorization: request.headers.get('Authorization') || '' } }));
  if (request.method !== 'POST') throw new ApiError(404, 'NOT_FOUND', '页面不存在。');
  if (!['/api/browser-agent/pair', '/api/browser-agent/pair-status'].includes(path)) throw new ApiError(404, 'NOT_FOUND', '页面不存在。');
  if (path.endsWith('/pair')) {
    const bucket = `agent-pair:${Math.floor(Date.now() / 60000)}:${await hash(request.headers.get('CF-Connecting-IP') || 'unknown')}`;
    const row = await env.DB.prepare('INSERT INTO rate_limits (bucket,count,expires_at) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count').bind(bucket, Date.now() + 120000).first();
    if (row.count > 4) throw new ApiError(429, 'RATE_LIMITED', '配对请求过于频繁，请稍后重试。');
  }
  return agentRequest(env, path.endsWith('/pair') ? '/init' : '/pair-status', await readJson(request), { Authorization: request.headers.get('Authorization') || '' });
}
export function agentViewer(request, env, identity) {
  return relay(env).fetch(new Request('https://relay.internal/viewer', { headers: { Upgrade: request.headers.get('Upgrade') || '', 'X-Agent-Admin-Sub': identity.sub, 'X-Agent-Admin-Expires': String(identity.expiresAt) } }));
}
