import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { downloadProviderAudio, prepareProviderTrack, readProviderDownload, providerDownloadLimit } from './providerDownload';
import type { ProviderSearchResult } from './providerSearch';

const song: ProviderSearchResult = { provider: 'qq', id: 'test001', title: '完整歌曲', artist: '歌手', album: '专辑', duration: 10, capabilities: { playback: true, download: true } };
function wave(seconds = 10) {
  const buffer = Buffer.alloc(44 + 8000 * seconds * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(buffer.length - 44, 40);
  return buffer;
}
afterEach(() => vi.unstubAllGlobals());
describe('provider download admission', () => {
  it('parses an actual audio container, hashes its bytes and produces an ordinary local track', async () => {
    const bytes = wave(); const track = await prepareProviderTrack(new Blob([bytes]), song, new AbortController().signal);
    expect(track).toMatchObject({ title: song.title, duration: 10, id: createHash('sha256').update(bytes).digest('hex'), favorite: false });
    expect(track.external).toBeUndefined(); expect(track.cloud).toBeUndefined();
  });
  it('rejects error pages, empty data and a short preview', async () => {
    for (const blob of [new Blob(), new Blob(['<html>login required</html>']), new Blob([wave(2)]), new Blob([wave().subarray(0, 100)])]) await expect(prepareProviderTrack(blob, song, new AbortController().signal)).rejects.toThrow();
  });
  it('rejects transport truncation, oversized responses and pre-cancelled saves', async () => {
    const signal = new AbortController().signal;
    await expect(readProviderDownload(new Response('abc', { headers: { 'content-length': '9' } }), signal, () => {})).rejects.toThrow(/不完整/);
    await expect(readProviderDownload(new Response('a', { headers: { 'content-length': String(providerDownloadLimit + 1) } }), signal, () => {})).rejects.toThrow(/200 MB/);
    const abort = new AbortController(); abort.abort(); await expect(prepareProviderTrack(new Blob([wave()]), song, abort.signal)).rejects.toThrow();
  });
  it('removes native temporary audio after a cancelled or inconsistent read', async () => {
    const remove = vi.fn(async () => {}); const abort = new AbortController();
    vi.stubGlobal('window', { tingyuDesktop: { downloadProvider: async () => ({ token: 'fixture', size: 5, type: 'audio/wav' }), readProviderDownload: async () => [1], removeProviderDownload: remove, cancelProvider: async () => {} } });
    await expect(downloadProviderAudio(song, 'https://ws.stream.qqmusic.qq.com/file.wav', abort.signal, () => {})).rejects.toThrow(/不完整/);
    expect(remove).toHaveBeenCalledWith('fixture');
  });
});
