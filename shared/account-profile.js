// Hosts used for profile pictures in Google's documented sign-in examples.
export const PROFILE_AVATAR_ORIGINS = Object.freeze([
  'https://lh3.googleusercontent.com',
  'https://lh4.googleusercontent.com',
]);
export const PROFILE_AVATAR_MAX_BYTES = 4096;
const jpegPrefix = 'data:image/jpeg;base64,';
const jpegBase64Limit = Math.ceil(PROFILE_AVATAR_MAX_BYTES / 3) * 4;

function jpegAvatar(value) {
  if (value.length > jpegPrefix.length + jpegBase64Limit) return null;
  const encoded = value.slice(jpegPrefix.length);
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
  try {
    const bytes = atob(encoded);
    // Re-encoding rejects nonzero padding bits accepted by permissive decoders.
    if (bytes.length < 4 || bytes.length > PROFILE_AVATAR_MAX_BYTES || btoa(bytes) !== encoded) return null;
    if (bytes.charCodeAt(0) !== 0xff || bytes.charCodeAt(1) !== 0xd8 || bytes.charCodeAt(2) !== 0xff || bytes.charCodeAt(bytes.length - 2) !== 0xff || bytes.charCodeAt(bytes.length - 1) !== 0xd9) return null;
    return value;
  } catch { return null; }
}

function avatarUrl(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith(jpegPrefix)) return jpegAvatar(value);
  if (value.length > 1024 || /[\s\x00-\x1f\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && PROFILE_AVATAR_ORIGINS.includes(url.origin) && !url.username && !url.password && !url.search && !url.hash) return url.href;
  } catch { /* Invalid avatar URL. */ }
  return null;
}

export function profileSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const nickname = typeof value.nickname === 'string' ? value.nickname.trim() : '';
  return {
    nickname: nickname && nickname.length <= 80 && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(nickname) ? nickname : null,
    avatarUrl: avatarUrl(value.avatarUrl),
    balance: typeof value.balance === 'string' && /^-?(?:0|[1-9]\d{0,11})\.\d{2}$/.test(value.balance) ? value.balance : null,
  };
}
