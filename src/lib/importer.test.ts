import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { importFiles } from './importer';
import fs from 'node:fs/promises';

describe('music archive import', () => {
  it('imports an audio file on its own without requiring a ZIP or lyrics', async () => {
    const zip = await JSZip.loadAsync(await fs.readFile('public/demo/听屿示例.zip'));
    const entry = Object.values(zip.files).find((file) => /\.wav$/i.test(file.name))!;
    const bytes = await entry.async('uint8array');
    const result = await importFiles([new File([Uint8Array.from(bytes)], 'Demo - Alone.wav')], () => {});
    expect(result.tracks).toHaveLength(1); expect(result.tracks[0].lyrics).toEqual([]);
    expect(result.tracks[0].duration).toBe(36); expect(result.tracks[0].audio.size).toBe(bytes.length);
  });
  it('imports real demo audio, nested cover art, and timestamp-matched Chinese lyrics', async () => {
    const bytes = await fs.readFile('public/demo/听屿示例.zip');
    const result = await importFiles([new File([bytes], 'example.zip')], () => {});
    expect(result.tracks).toHaveLength(3);
    expect(result.warnings).toHaveLength(0);
    for (const track of result.tracks) {
      expect(track.duration).toBe(36);
      expect(track.cover?.type).toBe('image/png');
      expect(track.lyrics).toHaveLength(7);
      expect(track.lyrics.every((line) => line.translation)).toBe(true);
      expect(track.id).toHaveLength(64);
    }
    const again = await importFiles([new File([bytes], 'renamed.zip')], () => {});
    expect(again.tracks.map((track) => track.id)).toEqual(result.tracks.map((track) => track.id));
  });
  it('rejects an archive without any audio', async () => {
    const zip = new JSZip();
    zip.file('notes.txt', 'No music');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await expect(importFiles([new File([Uint8Array.from(bytes)], 'empty.zip')], () => {})).rejects.toThrow('没有找到歌曲');
  });
  it('skips completed songs after pause and rereads only unfinished songs', async () => {
    const bytes = await fs.readFile('public/demo/听屿示例.zip');
    const files = [new File([bytes], 'resume.zip', { lastModified: 1234 })];
    const completed = new Set<string>();
    const controller = new AbortController();
    await expect(importFiles(files, () => {}, { signal: controller.signal, completed, collect: false, onTrack: async (_track, entry) => { completed.add(entry); controller.abort(); } })).rejects.toThrow();
    expect(completed.size).toBe(1);
    const restored: string[] = [];
    await importFiles(files, () => {}, { completed, collect: false, onTrack: async (track) => { restored.push(track!.id); } });
    expect(restored).toHaveLength(2);
  });
});
