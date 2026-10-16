import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ loadKey: vi.fn(), saveKey: vi.fn(), clearKey: vi.fn(), get: vi.fn(), post: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'android' }, CapacitorHttp: { get: native.get, post: native.post }, registerPlugin: () => native }));
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); vi.stubGlobal('window', new EventTarget());
  const values = new Map<string, string>(); vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value) });
  native.loadKey.mockResolvedValue({ key: '', path: '/private/no_backup/config/online-source.json' }); native.saveKey.mockResolvedValue(undefined); native.clearKey.mockResolvedValue(undefined);
  native.get.mockResolvedValue({ status: 200, data: { product: 'xianqiji-online-library' } }); native.post.mockResolvedValue({ status: 200, data: { id: 'fixture' } });
});
afterEach(() => vi.unstubAllGlobals());
it('uses a separate encrypted native slot and persists no plaintext token in localStorage', async () => {
  const source = await import('./onlineSource'); const config = { baseUrl: 'https://example.com/library/', token: 'private-library-only-token', remember: true };
  await source.saveSourceConfig(config);
  expect(native.saveKey).toHaveBeenCalledWith({ slot: 'cloud', key: JSON.stringify({ ...config, autoSync: false, connected: true }) });
  expect(localStorage.getItem('xianqiji-source-url')).toBe(config.baseUrl);
  native.loadKey.mockResolvedValue({ key: JSON.stringify(config), path: '/private/no_backup/config/online-source.json' }); vi.resetModules();
  expect((await (await import('./onlineSource')).loadSourceConfig()).token).toBe(config.token);
  expect(native.loadKey).toHaveBeenCalledWith({ slot: 'cloud' });
});
it('uses native authenticated HTTPS without redirecting credentials and maps read-only failures', async () => {
  const source = await import('./onlineSource'); await source.saveSourceConfig({ baseUrl: 'https://example.com/library/', token: 'private-library-only-token', remember: false });
  await source.sourceRequest({ method: 'GET', path: '/info' });
  expect(native.get).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com/library/info', disableRedirects: true, headers: expect.objectContaining({ Authorization: 'Bearer private-library-only-token' }) }));
  native.post.mockResolvedValueOnce({ status: 403, data: { error: 'Read only' } });
  await expect(source.sourceRequest({ method: 'POST', path: '/uploads', body: {} })).rejects.toThrow('只有读取权限');
  expect(native.clearKey).toHaveBeenCalledWith({ slot: 'cloud' });
});
it('remembers an anonymous connection and refuses uploads without a write key', async () => {
  const source = await import('./onlineSource');
  await source.saveSourceConfig({ baseUrl: 'example.com', token: '', connected: true, remember: true });
  await source.sourceRequest({ method: 'GET', path: '/info' });
  expect(native.get).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com/music-library/info', headers: { 'Content-Type': 'application/json' } }));
  await expect(source.sourceRequest({ method: 'POST', path: '/uploads' })).rejects.toThrow('留空只能听歌');
  expect(native.post).not.toHaveBeenCalled(); expect(native.saveKey).not.toHaveBeenCalled();
  expect(localStorage.getItem('xianqiji-source-connected')).toBe('true');
  vi.resetModules();
  const restored = await (await import('./onlineSource')).loadSourceConfig();
  expect(restored.connected).toBe(true); expect(restored.token).toBe('');
});
