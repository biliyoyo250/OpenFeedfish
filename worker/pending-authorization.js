import { ApiError } from './lib.js';
import { seal, unseal } from './vault.js';
import { platformOrigin, platformClientHeaders } from './platform-client.js';

const lifetime = 2 * 60 * 60 * 1000;
const rowFor = (env) => env.DB.prepare('SELECT * FROM account_pending_authorization WHERE singleton=1').first();
const expired = () => new ApiError(409, 'AUTH_EXPIRED', '暂存凭证已结束，请重新导入会话或授权。');
const busy = () => new ApiError(409, 'AUTH_BUSY', '账户核验正在处理，请稍后重试。');
const removeOwned = (env, id, owner, lease) => env.DB.prepare('DELETE FROM account_pending_authorization WHERE singleton=1 AND id=? AND owner_sub=? AND lease_until=?').bind(id, owner, lease).run();
export async function revokeGrant(credentials, fetcher = fetch) {
  // Clearing a manually imported web session removes only our encrypted
  // candidate; it must not log the user out of the official browser session.
  if (typeof credentials.dshToken !== 'string' || !credentials.dshToken) return false;
  try {
    const response = await fetcher(`${platformOrigin}/auth-api/v0/users/logout`, { method: 'POST', headers: { ...platformClientHeaders, 'x-dsh-auth-token': credentials.dshToken }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (response.status === 401) { await response.body?.cancel(); return true; }
    if (!response.headers.get('content-type')?.includes('application/json')) { await response.body?.cancel(); return false; }
    const data = await response.json();
    return data?.code === 40003 || (response.ok && data?.code === 0 && data.data?.biz_code === 0);
  } catch { return false; }
}
export async function cleanupPendingAuthorization(env, fetcher = fetch, now = Date.now()) {
  const row = await rowFor(env);
  if (!row || row.expires_at > now) return;
  const result = await env.DB.prepare('DELETE FROM account_pending_authorization WHERE singleton=1 AND id=? AND expires_at<=?').bind(row.id, now).run();
  if (result.meta.changes) {
    try { await revokeGrant(await unseal(row.sealed_credentials, env.ACCOUNT_ENCRYPTION_KEY), fetcher); }
    catch { /* Expired unverified credentials are removed even if revocation is unavailable. */ }
  }
}
export async function assertNoPendingAuthorization(env, now = Date.now()) {
  const row = await rowFor(env);
  if (row && row.expires_at > now) throw new ApiError(409, 'AUTH_PENDING', '已有加密暂存的凭证，请重试账户核验或先清除暂存。');
}
export async function pendingAuthorizationState(env, identity, now = Date.now()) {
  const row = await rowFor(env);
  return row && row.owner_sub === identity.sub && row.expires_at > now ? { id: row.id, expiresAt: new Date(row.expires_at).toISOString(), busy: row.lease_until > now } : null;
}
export async function stagePendingAuthorization(env, identity, credentials, fetcher = fetch, now = Date.now()) {
  await cleanupPendingAuthorization(env, fetcher, now);
  const id = crypto.randomUUID();
  const encrypted = await seal(credentials, env.ACCOUNT_ENCRYPTION_KEY);
  const result = await env.DB.prepare('INSERT OR IGNORE INTO account_pending_authorization (singleton,id,owner_sub,sealed_credentials,created_at,expires_at) VALUES (1,?,?,?,?,?)').bind(id, identity.sub, encrypted, now, now + lifetime).run();
  if (!result.meta.changes) throw busy();
  return id;
}
function owned(row, identity, id, now) {
  if (!row || row.id !== id || row.owner_sub !== identity.sub || row.expires_at <= now) throw expired();
}
export async function verifyPendingAuthorization(env, identity, id, saveSession, fetcher = fetch, now = Date.now()) {
  const row = await rowFor(env); owned(row, identity, id, now);
  const claim = await env.DB.prepare('UPDATE account_pending_authorization SET lease_until=? WHERE singleton=1 AND id=? AND owner_sub=? AND expires_at>? AND lease_until<=?').bind(now + 30000, id, identity.sub, now, now).run();
  if (!claim.meta.changes) throw busy();
  let credentials;
  try {
    credentials = await unseal(row.sealed_credentials, env.ACCOUNT_ENCRYPTION_KEY);
    const account = await saveSession(credentials, { id, ownerSub: identity.sub, leaseUntil: now + 30000 });
    if (!account.pendingCleared && !(await removeOwned(env, id, identity.sub, now + 30000)).meta.changes) throw expired();
    return account;
  } catch (error) {
    if (credentials?.issuedAccount) {
      error.issuedIdentity = typeof credentials.issuedAccount.id === 'string' && credentials.issuedAccount.id.length > 0;
      if (['CNY', 'USD'].includes(credentials.issuedAccount.currency)) error.issuedCurrency = credentials.issuedAccount.currency;
    }
    if (['SESSION_EXPIRED', 'ACCOUNT_MISMATCH', 'VAULT_UNAVAILABLE', 'AUTH_EXPIRED'].includes(error.code)) {
      const removed = await removeOwned(env, id, identity.sub, now + 30000);
      if (removed.meta.changes && credentials) await revokeGrant(credentials, fetcher);
    }
    throw error;
  } finally { await env.DB.prepare('UPDATE account_pending_authorization SET lease_until=0 WHERE singleton=1 AND id=? AND lease_until=?').bind(id, now + 30000).run().catch(() => {}); }
}
export async function discardPendingAuthorization(env, identity, id, fetcher = fetch, now = Date.now()) {
  const row = await rowFor(env); owned(row, identity, id, now);
  if (row.lease_until > now) throw busy();
  const claimed = await env.DB.prepare('DELETE FROM account_pending_authorization WHERE singleton=1 AND id=? AND owner_sub=? AND lease_until<=?').bind(id, identity.sub, now).run();
  if (!claimed.meta.changes) throw busy();
  const credentials = await unseal(row.sealed_credentials, env.ACCOUNT_ENCRYPTION_KEY);
  return { ok: true, revoked: credentials.dshToken ? await revokeGrant(credentials, fetcher) : null };
}
