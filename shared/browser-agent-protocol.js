import { profileSummary } from './account-profile.js';

export const VIEWPORT = Object.freeze({ width: 1024, height: 768 });
export const MAX_FRAME_BYTES = 300000;
export const AGENT_PROTOCOL = 1;
export const AGENT_CLOSE = Object.freeze({ REPLACED: 4000, REVOKED: 4001, DEVICE_EXPIRED: 4002, SESSION_LOST: 4003, ACCESS_EXPIRED: 4004 });
const keys = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'ControlOrMeta+A']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validCommandId = (id) => typeof id === 'string' && uuid.test(id);
export const validDeviceKey = (key) => typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key);
export const validPairCode = (code) => typeof code === 'string' && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code);
export const validAccountId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 200;

// Both ends project the same small protocol. No URL, selector, JavaScript, file,
// clipboard-read, browser-debugging or shell command can cross this boundary.
export function browserCommand(value) {
  if (!value || typeof value !== 'object' || !validCommandId(value.id)) throw new Error('INVALID_COMMAND');
  const base = { id: value.id, type: value.type };
  if (value.type === 'navigate' && ['top_up', 'sign_in'].includes(value.page)) return { ...base, page: value.page };
  if (['reload', 'check-account'].includes(value.type)) return base;
  if (value.type !== 'input') throw new Error('INVALID_COMMAND');
  const event = value.event;
  if (['down', 'move', 'up'].includes(event) && Number.isInteger(value.x) && value.x >= 0 && value.x < VIEWPORT.width && Number.isInteger(value.y) && value.y >= 0 && value.y < VIEWPORT.height) return { ...base, event, x: value.x, y: value.y };
  if (event === 'key' && keys.has(value.key)) return { ...base, event, key: value.key };
  if (event === 'text' && typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 1024 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value.text)) return { ...base, event, text: value.text };
  if (event === 'wheel' && Number.isInteger(value.deltaY) && Math.abs(value.deltaY) <= 800) return { ...base, event, deltaY: value.deltaY };
  throw new Error('INVALID_COMMAND');
}

export function accountResult(value, expectedId) {
  if (!value || typeof value !== 'object') return { ok: false, code: 'ACCOUNT_CHECK_FAILED' };
  if (value.ok !== true) {
    const code = ['LOGIN_REQUIRED', 'UPSTREAM_NOT_JSON', 'UPSTREAM_UNAVAILABLE', 'AUTH_TOKEN_MISSING', 'SESSION_EXPIRED', 'ACCOUNT_MISMATCH', 'ACCOUNT_INELIGIBLE', 'ACCOUNT_CHECK_FAILED'].includes(value.code) ? value.code : 'ACCOUNT_CHECK_FAILED';
    return { ok: false, code, ...(Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? { httpStatus: value.httpStatus } : {}) };
  }
  if (!validAccountId(value.accountId) || (expectedId !== null && value.accountId !== expectedId)) return { ok: false, code: 'ACCOUNT_MISMATCH' };
  if (value.currency !== 'CNY' || value.eligible !== true) return { ok: false, code: 'ACCOUNT_INELIGIBLE' };
  const profile = profileSummary(value.profile);
  return { ok: true, accountId: value.accountId, currency: 'CNY', ...(profile ? { profile } : {}) };
}
