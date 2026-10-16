import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const handler = createRequire(import.meta.url)('../../electron/media.cjs');
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) { expect(path.dirname(directory)).toBe(path.resolve('test-results')); expect(path.basename(directory)).toMatch(/^media-/); await fs.rm(directory, { recursive: true }); } });
describe('on-demand native music streaming', () => {
  it('streams byte ranges, suffixes and HEAD without copying the whole library', async () => {
    await fs.mkdir('test-results', { recursive: true }); const directory = await fs.mkdtemp(path.resolve('test-results/media-')); directories.push(directory);
    const filename = path.join(directory, 'test.wav'); await fs.writeFile(filename, new Uint8Array([0, 1, 2, 3, 4, 5]));
    const respond = handler({ media: async () => ({ path: filename, size: 6, type: 'audio/wav' }) });
    const response = await respond(new Request('xianqiji://library/song-1/audio', { headers: { range: 'bytes=2-4' } }));
    expect(response.status).toBe(206); expect(response.headers.get('content-range')).toBe('bytes 2-4/6'); expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([2, 3, 4]);
    const suffix = await respond(new Request('xianqiji://library/song-1/audio', { headers: { range: 'bytes=-2' } })); expect([...new Uint8Array(await suffix.arrayBuffer())]).toEqual([4, 5]);
    const head = await respond(new Request('xianqiji://library/song-1/audio', { method: 'HEAD' })); expect(head.headers.get('content-length')).toBe('6'); expect(await head.text()).toBe('');
    expect((await respond(new Request('xianqiji://library/song-1/audio', { headers: { range: 'bytes=6-' } }))).status).toBe(416);
    expect((await respond(new Request('xianqiji://other/song-1/audio'))).status).toBe(404);
  });
});
