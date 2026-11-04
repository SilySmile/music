import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkProviderLogin, findProviderLyrics, parseProviderMedia, parseProviderSearch, providerIdentifier, providerRequest, providerSession, resolveProviderMedia, validateProviderAudioUrl } from './providerSearch';
afterEach(() => vi.unstubAllGlobals());
describe('device-local music providers', () => {
  it('tracks NetEase scan, authorization and expiration and rejects terminal platform errors', async () => {
    let code = 801;
    vi.stubGlobal('window', { tingyuDesktop: { requestProvider: async () => ({ code, message: '平台错误' }) } });
    const previous = { status: 'waiting' as const, key: 'fixture', expiresAt: Date.now() + 60000 };
    expect((await checkProviderLogin('netease', previous)).status).toBe('waiting');
    code = 802; expect((await checkProviderLogin('netease', previous)).status).toBe('confirmed');
    code = 803; expect((await checkProviderLogin('netease', previous)).status).toBe('logged-in');
    code = 800; expect((await checkProviderLogin('netease', previous)).status).toBe('expired');
    code = 8821; await expect(checkProviderLogin('netease', previous)).rejects.toThrow(/8821/);
    code = 999; await expect(checkProviderLogin('netease', previous)).rejects.toThrow(/999/);
  });
  it('recognizes actual QQ info/retCode account responses and the anonymous 1000 response', async () => {
    let response: unknown = { code: 0, req_0: { code: 0, data: { info: { retCode: 0, nick: '已确认账号' } } } };
    vi.stubGlobal('window', { tingyuDesktop: { requestProvider: async () => response } });
    expect(await providerSession('qq')).toEqual({ loggedIn: true, accountName: '已确认账号' });
    response = { code: 0, req_0: { code: 1000 } }; expect((await providerSession('qq')).loggedIn).toBe(false);
  });
  it('accepts QQ waiting and scanned states returned in the CGI envelope', async () => {
    let code = 40000;
    vi.stubGlobal('window', { tingyuDesktop: { requestProvider: async () => ({ code: 0, req_0: { code } }) } });
    const previous = { status: 'waiting' as const, key: 'fixture', expiresAt: Date.now() + 60000 };
    expect((await checkProviderLogin('qq', previous)).status).toBe('waiting');
    code = 40001; expect((await checkProviderLogin('qq', previous)).status).toBe('confirmed');
    code = 40002; expect((await checkProviderLogin('qq', previous)).status).toBe('expired');
  });
  it('normalizes real platform song shapes without mixing platform identities', () => {
    const qq = parseProviderSearch('qq', { body: { item_song: [{ mid: '001abc', title: '<em>一首歌</em>', singer: [{ name: '歌手' }], album: { name: '专辑', mid: 'album' }, interval: 180 }] } });
    expect(qq.results[0]).toMatchObject({ id: '001abc', provider: 'qq', title: '一首歌', artist: '歌手', duration: 180 });
    const netease = parseProviderSearch('netease', { code: 200, result: { songs: [{ id: 123, name: '歌', ar: [{ name: '歌手' }], al: { name: '专辑', picUrl: 'http://p2.music.126.net/cover.jpg' }, dt: 123000 }] } });
    expect(netease.results[0]).toMatchObject({ id: '123', provider: 'netease', duration: 123, coverUrl: 'https://p2.music.126.net/cover.jpg' });
    expect(providerIdentifier('qq', '123')).not.toEqual(providerIdentifier('netease', '123'));
    expect(() => parseProviderSearch('netease', { code: 301 })).toThrow();
  });
  it('finds timed lyrics by the exact online track and refuses non-MP3 download formats', async () => {
    const song = { provider: 'qq' as const, id: 'fixture1', title: '在线歌曲', artist: '歌手', album: '专辑', duration: 180, capabilities: { playback: true, download: true } };
    vi.stubGlobal('window', { tingyuDesktop: { request: async (request: { service: string }) => { expect(request.service).toBe('lyrics'); return [{ id: 1, trackName: '在线歌曲', artistName: '歌手', duration: 180, syncedLyrics: '[00:01.00]歌词行' }]; }, requestProvider: async (request: { action: string }) => request.action === 'detail' ? { code: 0, req_0: { code: 0, data: { track_info: { pay: { pay_down: 0 } } } } } : ({ code: 0, req_0: { code: 0, data: { sip: ['https://aqqmusic.tc.qq.com/'], midurlinfo: [{ purl: 'C400fixture.m4a?vkey=x', type: 'm4a' }] } } }) } });
    expect((await findProviderLyrics(song))[0].lyrics[0]).toMatchObject({ time: 1, text: '歌词行' });
    await expect(resolveProviderMedia(song, true)).rejects.toThrow(/未返回可直接保存的 MP3/);
  });
  it('refuses forged media hosts, credentials, ports and a preview disguised as a full download', () => {
    const valid = 'https://m801.music.126.net/path/audio.mp3?auth=temporary';
    expect(validateProviderAudioUrl('netease', valid)).toBe(valid);
    for (const url of ['https://music.126.net.attacker.example/a.mp3', 'https://user:secret@m801.music.126.net/a.mp3', 'https://m801.music.126.net:8443/a.mp3', 'http://127.0.0.1/a.mp3', 'https://ws.stream.qqmusic.qq.com/a.mp3']) expect(() => validateProviderAudioUrl('netease', url)).toThrow();
    const preview = { code: 200, data: [{ code: 200, url: valid, type: 'mp3', freeTrialInfo: { start: 0, end: 30 } }] };
    expect(parseProviderMedia('netease', preview).previewOnly).toBe(true);
    expect(() => parseProviderMedia('netease', preview, true)).toThrow(/试听/);
    expect(() => parseProviderMedia('netease', { code: 301 })).toThrow(/权限/);
    const qq = { sip: ['http://aqqmusic.tc.qq.com/'], midurlinfo: [{ purl: 'C400001abc.m4a?vkey=temporary' }] };
    expect(parseProviderMedia('qq', qq, true)).toMatchObject({ url: 'https://aqqmusic.tc.qq.com/C400001abc.m4a?vkey=temporary', format: 'm4a', previewOnly: false });
    expect(() => parseProviderMedia('qq', { ...qq, midurlinfo: [{ purl: 'RS02001abc.m4a' }] }, true)).toThrow(/试听/);
  });
  it('uses the native request bridge and discards a late result after cancellation', async () => {
    let finish!: (value: unknown) => void;
    const cancel = vi.fn(async () => {}), request = vi.fn((_request: unknown) => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal('window', { tingyuDesktop: { requestProvider: request, cancelProvider: cancel } });
    const abort = new AbortController(); const pending = providerRequest('netease', 'search', { query: '歌曲' }, abort.signal);
    abort.abort(); finish({ code: 200, result: { songs: [] } });
    await expect(pending).rejects.toThrow(); expect(cancel).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).not.toHaveProperty('cookie');
  });
});
