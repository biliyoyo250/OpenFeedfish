// Hosts used for profile pictures in Google's documented sign-in examples.
export const PROFILE_AVATAR_ORIGINS = Object.freeze([
  'https://lh3.googleusercontent.com',
  'https://lh4.googleusercontent.com',
]);

function avatarUrl(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\s\x00-\x1f\x7f]/.test(value)) return null;
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
