import { ApiError } from './lib.js';
import { queryPayment } from './provider.js';
import { agentRequest } from './browser-agent.js';

export const AGENT_CHECK_INTERVAL = 12000;

export function detailedState(result, row, now) {
  const states = { CREATED: row.expires_at <= now ? 'expired' : 'waiting', PENDING: 'processing', SUCCESS: 'paid', FAILED: 'failed', REFUNDED: 'refunded', CHARGEBACK: 'chargeback' };
  return result.providerStatus ? states[result.providerStatus] : result.status === 'pending' ? 'waiting' : result.status;
}
// Shared, idempotent internal payment callback. Only trusted upstream polling invokes it.
export async function applyPaymentResult(env, row, result, source, now = Date.now()) {
  if (!['pending', 'paid', 'failed', 'expired'].includes(result.status)) throw new ApiError(502, 'INVALID_PAYMENT_STATUS', '暂时无法确认付款结果。');
  const state = detailedState(result, row, now);
  if (!state) throw new ApiError(502, 'INVALID_PAYMENT_STATUS', '暂时无法确认付款结果。');
  if (['paid', 'refunded', 'chargeback'].includes(row.payment_state) && !['paid', 'refunded', 'chargeback'].includes(state)) return;
  if (['refunded', 'chargeback'].includes(row.payment_state) && state === 'paid') return;
  const confirmed = result.status === 'paid' ? row.confirmed_at || now : row.confirmed_at;
  const paidAt = row.paid_at || result.paidAt || null;
  if (row.payment_state === state && row.provider_status === (result.providerStatus || null) && row.paid_at === paidAt) return;
  const updates = await env.DB.batch([
    env.DB.prepare('UPDATE orders SET status=?,payment_state=?,provider_status=?,paid_at=?,confirmed_at=?,last_check_error=NULL,revision=revision+1 WHERE id=? AND revision=?').bind(result.status, state, result.providerStatus || null, paidAt, confirmed || null, row.id, row.revision),
    env.DB.prepare('INSERT INTO payment_events (order_id,state,provider_status,source,observed_at) SELECT ?,?,?,?,? WHERE changes()=1').bind(row.id, state, result.providerStatus || null, source, now)
  ]);
  // Notify only after the conditional ledger update committed. Delivery is a
  // hint to re-read D1, never a second authority for payment or a new order.
  if (updates[0]?.meta?.changes > 0 && row.provider_transport === 'agent' && env.AGENT_RELAY) {
    await agentRequest(env, '/notify-order', { id: row.id }).catch(() => {});
  }
}
export async function reconcileOrder(env, row, source = 'poll', query = queryPayment) {
  const now = Date.now();
  const interval = row.provider_transport === 'agent' ? AGENT_CHECK_INTERVAL : 4000;
  const lease = await env.DB.prepare('UPDATE orders SET last_checked_at=? WHERE id=? AND revision=? AND last_checked_at<=? RETURNING id').bind(now, row.id, row.revision, now - interval).first();
  if (!lease) return;
  try {
    const result = row.is_demo ? { status: row.expires_at <= now ? 'expired' : 'pending' } : await query(env, row);
    await applyPaymentResult(env, row, result, source, now);
    await env.DB.prepare('UPDATE orders SET last_check_error=NULL WHERE id=? AND last_checked_at=?').bind(row.id, now).run();
  } catch (error) {
    await env.DB.prepare('UPDATE orders SET last_check_error=? WHERE id=? AND last_checked_at=? AND revision=?').bind(error instanceof ApiError ? error.code : 'QUERY_UNAVAILABLE', row.id, now, row.revision).run();
    throw error;
  }
}

async function reconcileAgentOrders(env, rows) {
  for (const row of rows) {
    try { await reconcileOrder(env, row, 'scheduled'); }
    catch (error) {
      // A different run or checkout owns the browser slot. Leave the rest due.
      if (['AGENT_BUSY', 'AGENT_OFFLINE'].includes(error?.code)) break;
    }
  }
}

export async function reconcileScheduled(env) {
  if (!env.DB) return;
  const now = Date.now();
  const { results } = await env.DB.prepare(`
    SELECT * FROM orders
    WHERE is_demo=0 AND provider_order_id IS NOT NULL
      AND ((status='pending' AND created_at>?) OR (status='paid' AND confirmed_at>? AND last_checked_at<?))
    ORDER BY CASE WHEN status='pending' AND expires_at>? THEN 0 ELSE 1 END, last_checked_at
    LIMIT 20`).bind(now - 7 * 86400000, now - 86400000, now - 900000, now).all();
  const agentChecks = reconcileAgentOrders(env, results.filter((row) => row.provider_transport === 'agent'));
  const workerOrders = results.filter((row) => row.provider_transport !== 'agent');
  for (let i = 0; i < workerOrders.length; i += 3) {
    await Promise.allSettled(workerOrders.slice(i, i + 3).map((row) => reconcileOrder(env, row, 'scheduled')));
  }
  await agentChecks;
  await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(now).run();
}
