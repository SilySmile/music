import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { nativeAudio, nativeAudioUrl } from './nativeAudio';
afterEach(() => vi.unstubAllGlobals());
it('loads no audio at startup, preserves size and uses chunks only when exported', async () => {
  const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5]);
  const readLibraryChunk = vi.fn(async (_identifier: string, _kind: string, offset: number, length: number) => bytes.slice(offset, offset + length));
  vi.stubGlobal('window', { tingyuDesktop: { readLibraryChunk } });
  const blob = nativeAudio({ metadata: { id: 'song-1' }, audio: { file: 'test.wav', size: bytes.length, type: 'audio/wav', sha256: createHash('sha256').update(bytes).digest('hex') } } as Parameters<typeof nativeAudio>[0]);
  expect(blob.size).toBe(6); expect(blob.type).toBe('audio/wav'); expect(readLibraryChunk).not.toHaveBeenCalled();
  expect(nativeAudioUrl(blob)).toBe('xianqiji://library/song-1/audio');
  expect([...new Uint8Array(await blob.slice(2, 5).arrayBuffer())]).toEqual([2, 3, 4]);
  expect([...new Uint8Array(await blob.slice(-2).arrayBuffer())]).toEqual([4, 5]);
  expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([...bytes]);
  readLibraryChunk.mockResolvedValueOnce(Uint8Array.from([9, 9, 9, 9, 9, 9]));
  await expect(blob.arrayBuffer()).rejects.toThrow('校验失败');
});
