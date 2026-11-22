import { ApiError } from './lib.js';
import { profileSummary } from '../shared/account-profile.js';

const defaultHomepage = 'https://bonjour.bio/b36y9x';
const emptySettings = () => ({ nickname: '', homepageUrl: '', homepageDescription: '' });
const invalidText = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;

export async function readOwnerSettings(env, demo = false) {
  if (demo || !env.DB?.prepare) return emptySettings();
  const row = await env.DB.prepare('SELECT nickname,homepage_url,homepage_description FROM owner_settings WHERE singleton=1').first();
  return { nickname: row?.nickname || '', homepageUrl: row?.homepage_url || '', homepageDescription: row?.homepage_description || '' };
}

export function validateOwnerSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'INVALID_OWNER_SETTINGS', '主人资料格式不正确。');
  const settings = emptySettings();
  for (const [field, limit] of [['nickname', 80], ['homepageUrl', 2048], ['homepageDescription', 80]]) {
    const value = body[field] === undefined ? '' : body[field];
    if (typeof value !== 'string' || value.length > limit || invalidText.test(value)) throw new ApiError(400, 'INVALID_OWNER_SETTINGS', '主人昵称或主页信息不符合长度或格式要求。');
    settings[field] = value.trim();
  }
  if (!settings.homepageUrl) {
    settings.homepageDescription = '';
    return settings;
  }
  let url;
  try { url = new URL(settings.homepageUrl); } catch { throw new ApiError(400, 'INVALID_HOMEPAGE_URL', '请填写完整的 HTTP 或 HTTPS 主页网址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /\s/.test(settings.homepageUrl) || url.href.length > 2048) throw new ApiError(400, 'INVALID_HOMEPAGE_URL', '请填写有效且不含登录凭证的 HTTP 或 HTTPS 主页网址。');
  const bonjour = ['bonjour.bio', 'www.bonjour.bio'].includes(url.hostname);
  if (!bonjour && !settings.homepageDescription) throw new ApiError(400, 'HOMEPAGE_DESCRIPTION_REQUIRED', '请填写主页描述，例如博客或 GitHub 主页。');
  settings.homepageUrl = url.href;
  return settings;
}

export function publicOwnerSettings(settings, profile) {
  return {
    nickname: settings.nickname || profileSummary(profile)?.nickname || '鲸鲸的主人',
    homepageUrl: settings.homepageUrl || defaultHomepage,
    homepageDescription: settings.homepageDescription,
    usesDefaultHomepage: !settings.homepageUrl,
  };
}
