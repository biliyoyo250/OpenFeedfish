import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ApiError, isDemo } from './lib.js';
const keysets = new Map();
export async function verifyAccessToken(token, env, keyset) {
  const issuer = env.ACCESS_TEAM_DOMAIN?.replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer || '') || !env.ACCESS_AUD || !env.ADMIN_EMAILS) throw new ApiError(503, 'ACCESS_NOT_CONFIGURED', '管理入口尚未配置 Cloudflare Access。');
  if (!token || token.length > 16384) throw new ApiError(403, 'ACCESS_DENIED', '请通过 Cloudflare Access 登录。');
  try {
    if (!keyset) { if (!keysets.has(issuer)) keysets.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 8000 })); keyset = keysets.get(issuer); }
    const { payload } = await jwtVerify(token, keyset, { issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'email'], clockTolerance: 5 });
    const allowed = env.ADMIN_EMAILS.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean);
    if (typeof payload.email !== 'string' || !allowed.includes(payload.email.toLowerCase())) throw new Error();
    return { email: payload.email, sub: payload.sub, expiresAt: payload.exp * 1000, demo: false };
  } catch { throw new ApiError(403, 'ACCESS_DENIED', '当前身份无权访问管理后台。'); }
}
export async function requireAdmin(request, env) {
  // Local demo exposes synthetic data only; credential writes remain forbidden.
  if (isDemo(request, env)) return { email: 'local-demo@example.invalid', sub: 'local-demo', demo: true };
  return verifyAccessToken(request.headers.get('Cf-Access-Jwt-Assertion'), env);
}
