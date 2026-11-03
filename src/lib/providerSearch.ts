import { Capacitor, registerPlugin } from '@capacitor/core';
import QRCode from 'qrcode';
export type MusicProvider = 'qq' | 'netease';
export type ProviderSearchResult = { id: string; provider: MusicProvider; title: string; artist: string; album: string; duration: number; coverUrl?: string; capabilities: { playback: boolean; download: boolean } };
export type ProviderSession = { loggedIn: boolean; accountName?: string };
export type ProviderLogin = { status: 'waiting' | 'confirmed' | 'expired' | 'logged-in'; key: string; qrImageUrl?: string; expiresAt: number };
export type ProviderPlayback = { url: string; expiresAt: number; previewOnly: boolean; format: string };
export type ProviderAction = 'session' | 'search' | 'login-create' | 'login-check' | 'detail' | 'playback' | 'download' | 'logout';
export type ProviderRequest = { id: string; provider: MusicProvider; action: ProviderAction; data: Record<string, unknown> };
const native = registerPlugin<{ request(options: ProviderRequest): Promise<unknown>; cancel(options: { id: string }): Promise<void> }>('MusicProviders');
export const providerLabel = (provider: MusicProvider) => provider === 'qq' ? 'QQ 音乐' : '网易云音乐';
export const providerIdentifier = (provider: MusicProvider, id: string) => `${provider}:${id}`;
export const providersAvailable = () => !!window.tingyuDesktop?.requestProvider || Capacitor.getPlatform() === 'android';
// Platform responses are validated below before entering application state.
export async function providerRequest<T = Record<string, any>>(provider: MusicProvider, action: ProviderAction, data: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const request = { id: crypto.randomUUID(), provider, action, data }; const bridge = window.tingyuDesktop;
  const cancel = () => { void (bridge?.cancelProvider ? bridge.cancelProvider(request.id) : native.cancel({ id: request.id })).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (!providersAvailable()) throw Error('请在 Windows 或安卓安装版中使用在线音源。');
    const value = await (bridge?.requestProvider ? bridge.requestProvider(request) : native.request(request)); signal?.throwIfAborted();
    if (!value || typeof value !== 'object') throw Error('音乐平台返回了无效数据。');
    const response = value as Record<string, any>;
    if (provider === 'qq') {
      const item = response.req_0;
      if (action === 'login-check' && response.code === 0 && [40000, 40001, 40002].includes(item?.code)) return { code: item.code } as T;
      if (action !== 'logout' && (!item || response.code !== 0 || item.code !== 0)) throw Error('QQ 音乐暂时拒绝了请求，请稍后重试或重新登录。');
      if (action === 'login-check' && item?.data) return { code: item.code, ...item.data } as T;
      return (item?.data || response) as T;
    }
    return value as T;
  } finally { signal?.removeEventListener('abort', cancel); }
}
export function validateProviderResult(value: unknown): ProviderSearchResult {
  const item = value as ProviderSearchResult;
  if (!item || !['qq', 'netease'].includes(item.provider) || typeof item.id !== 'string' || !(item.provider === 'qq' ? /^[a-zA-Z0-9]{1,40}$/ : /^\d{1,20}$/).test(item.id) || typeof item.title !== 'string' || !item.title.trim() || typeof item.artist !== 'string' || typeof item.album !== 'string' || !Number.isFinite(item.duration) || item.duration < 0 || !item.capabilities || typeof item.capabilities.playback !== 'boolean' || typeof item.capabilities.download !== 'boolean') throw Error('歌曲信息不完整。');
  return item;
}
const text = (value: unknown, fallback = '') => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').trim() || fallback : fallback;
const cover = (value: unknown) => { try { const url = new URL(String(value).replace(/^http:/, 'https:')); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } };
export function parseProviderSearch(provider: MusicProvider, value: Record<string, any>) {
  if (provider === 'netease' && value.code !== 200) throw Error('网易云搜索暂不可用，请稍后重试。');
  const body = provider === 'qq' ? value.body || value : value.result || {};
  const raw = provider === 'qq' ? body.song?.list || body.item_song || body.songs || [] : body.songs || [];
  const items = Array.isArray(raw) ? raw : raw.items || [];
  const results: ProviderSearchResult[] = items.map((song: Record<string, any>) => {
    const album = provider === 'qq' ? song.album : song.al || song.album;
    return validateProviderResult({ provider, id: String(provider === 'qq' ? song.mid || song.songmid : song.id), title: text(song.title || song.name || song.songname, '未知歌曲'), artist: (song.singer || song.ar || song.artists || []).map((item: Record<string, any>) => text(item.name || item.title)).filter(Boolean).join(' / ') || '未知歌手', album: text(album?.name || song.albumname), duration: Math.max(0, Number(provider === 'qq' ? song.interval : song.dt || song.duration) || 0) / (provider === 'qq' ? 1 : 1000), coverUrl: cover(album?.picUrl || (provider === 'qq' && album?.mid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${album.mid}.jpg` : undefined)), capabilities: { playback: provider === 'qq' || !song.privilege || Number(song.privilege.st) >= 0, download: true } });
  });
  return { results, more: results.length === 20 };
}
export async function searchProvider(provider: MusicProvider, query: string, page = 1, signal?: AbortSignal) {
  if (!query.trim() || query.length > 200) throw Error('请输入 1–200 个字符的搜索内容。');
  return parseProviderSearch(provider, await providerRequest(provider, 'search', { query: query.trim(), page }, signal));
}
export async function providerSession(provider: MusicProvider, signal?: AbortSignal): Promise<ProviderSession> {
  const response = await providerRequest(provider, 'session', {}, signal);
  const profile = provider === 'qq' ? response.user || response.userInfo || response : response.profile;
  const loggedIn = provider === 'qq' ? (response.code === 0 || response.code === undefined) && !!(profile?.uin || profile?.encryptUin) : response.code === 200 && !!response.account && !!profile;
  return { loggedIn, accountName: loggedIn ? text(profile.nick || profile.nickname, '已登录账号') : undefined };
}
export async function beginProviderLogin(provider: MusicProvider, signal?: AbortSignal): Promise<ProviderLogin> {
  const response = await providerRequest(provider, 'login-create', {}, signal); const key = provider === 'qq' ? response.qrcodeID : response.unikey;
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(key)) throw Error('平台未返回有效的扫码会话。');
  const qr = provider === 'qq' ? response.qrcode : `https://music.163.com/login?codekey=${encodeURIComponent(key)}`;
  if (typeof qr !== 'string' || qr.length > 100000) throw Error('平台未返回有效的登录二维码。');
  const qrImageUrl = /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(qr) ? qr : await QRCode.toDataURL(qr, { width: 240, margin: 2 });
  return { status: 'waiting', key, qrImageUrl, expiresAt: Date.now() + Math.min(Number(response.expiresIn) || 180, 300) * 1000 };
}
export async function checkProviderLogin(provider: MusicProvider, previous: ProviderLogin, signal?: AbortSignal): Promise<ProviderLogin> {
  if (Date.now() >= previous.expiresAt) return { ...previous, status: 'expired' };
  const response = await providerRequest(provider, 'login-check', { key: previous.key }, signal); const code = provider === 'qq' ? response.code ?? response.ret : response.code;
  return { ...previous, status: provider === 'qq' ? code === 0 ? 'logged-in' : code === 40002 ? 'expired' : code === 40001 ? 'confirmed' : 'waiting' : code === 803 ? 'logged-in' : code === 800 ? 'expired' : code === 802 ? 'confirmed' : 'waiting' };
}
export function validateProviderAudioUrl(provider: MusicProvider, value: string) {
  let url: URL; try { url = new URL(value.replace(/^http:/, 'https:')); } catch { throw Error('平台未提供可用音频。'); }
  const suffixes = provider === 'qq' ? ['qqmusic.qq.com', 'music.qq.com', 'aqqmusic.tc.qq.com'] : ['music.126.net', 'music.163.com'];
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || !suffixes.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))) throw Error('音频地址不属于当前音乐平台。');
  return url.href;
}
export function parseProviderMedia(provider: MusicProvider, response: Record<string, any>, download = false): ProviderPlayback {
  let value: Record<string, any>, url: string;
  if (provider === 'qq') { value = response.midurlinfo?.[0]; if (!value?.purl) throw Error('QQ 音乐未提供此歌曲的音频，可能需登录、购买或歌曲已下架。'); url = new URL(value.purl, String(response.sip?.[0] || 'https://isure.stream.qqmusic.qq.com/').replace(/^http:/, 'https:')).href; }
  else { value = Array.isArray(response.data) ? response.data[0] : response.data; if (response.code !== 200 || !value?.url || (value.code !== undefined && value.code !== 200)) throw Error('网易云未提供此歌曲的音频，请检查登录状态和歌曲权限。'); url = value.url; }
  const previewOnly = provider === 'qq' ? /RS02|try|trial/i.test(value.purl) : !!value.freeTrialInfo && value.freeTrialInfo !== 'null';
  if (download && previewOnly) throw Error('当前仅提供试听片段，不能作为完整歌曲入库。');
  const cleanUrl = validateProviderAudioUrl(provider, url); const format = String(value.type || new URL(cleanUrl).pathname.split('.').pop() || '').toLowerCase();
  if (!['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus'].includes(format)) throw Error('平台返回的音频格式暂不支持。');
  return { url: cleanUrl, format, previewOnly, expiresAt: Date.now() + Math.max(60, Number(value.expi) || 600) * 1000 };
}
export async function resolveProviderMedia(song: ProviderSearchResult, download = false, signal?: AbortSignal) {
  validateProviderResult(song);
  if (download && song.provider === 'qq') { const detail = await providerRequest('qq', 'detail', { id: song.id }, signal); if (detail.track_info?.pay?.pay_down !== 0) throw Error('此 QQ 歌曲未标记为可直接下载，暂不提供音频导出；可按账号权限在线播放。'); }
  return parseProviderMedia(song.provider, await providerRequest(song.provider, download ? 'download' : 'playback', { id: song.id }, signal), download);
}
