import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { createMusicArchive, safeFilename } from './exporter';
import { importFiles } from './importer';
import { parseLyrics } from './lyrics';

describe('portable music archive', () => {
  it('retains word timing and pauses in both metadata and standalone LRC', async () => {
    const demo = await fs.readFile('public/demo/弦栖霁示例.zip');
    const { tracks } = await importFiles([new File([demo], 'demo.zip')], () => {});
    tracks[0].lyrics = parseLyrics('[1000,4000](1000,500,0)Snow (3000,2000,0)falls');
    const bytes = await createMusicArchive([tracks[0]], () => {});
    const restored = await importFiles([new File([bytes], 'word-timing.zip')], () => {});
    expect(restored.tracks[0].lyrics).toEqual(tracks[0].lyrics);
    const zip = await JSZip.loadAsync(bytes);
    const file = Object.keys(zip.files).find((name) => name.endsWith('.lrc'))!;
    expect(parseLyrics(await zip.file(file)!.async('string'))).toEqual(tracks[0].lyrics);
  });
  it('round trips original audio, metadata, favorites, artwork and sparse bilingual lyrics', async () => {
    const demo = await fs.readFile('public/demo/弦栖霁示例.zip');
    const imported = await importFiles([new File([demo], 'demo.zip')], () => {});
    const original = imported.tracks[0];
    original.favorite = true;
    original.album = '迁移测试专辑';
    original.lyrics = [{ time: -1, text: 'First' }, { time: -1, text: 'Second', translation: '第二行' }];
    original.translationSource = 'AI 机器翻译 · 测试模型';
    const bytes = await createMusicArchive([original], () => {});
    const restored = await importFiles([new File([bytes], 'export.zip')], () => {});
    expect(restored.tracks).toHaveLength(1);
    const track = restored.tracks[0];
    expect(track.id).toBe(original.id);
    expect(track.favorite).toBe(true);
    expect(track.title).toBe(original.title);
    expect(track.album).toBe('迁移测试专辑');
    expect(track.lyrics).toEqual(original.lyrics);
    expect(track.translationSource).toBe(original.translationSource);
    expect(await track.audio.arrayBuffer()).toEqual(await original.audio.arrayBuffer());
    expect(await track.cover!.arrayBuffer()).toEqual(await original.cover!.arrayBuffer());
    const zip = await JSZip.loadAsync(bytes);
    const manifest = await zip.file('tingyu-library.json')!.async('string');
    expect(manifest).not.toContain('apiKey');
    expect(manifest).not.toContain('tingyu-ai-config');
  });
  it('exports timed lyrics and translations as standard matching files', async () => {
    const demo = await fs.readFile('public/demo/弦栖霁示例.zip');
    const { tracks } = await importFiles([new File([demo], 'demo.zip')], () => {});
    const bytes = await createMusicArchive(tracks, () => {});
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).filter((name) => name.endsWith('.zh.lrc'))).toHaveLength(3);
    const { tracks: restored } = await importFiles([new File([bytes], 'backup.zip')], () => {});
    expect(restored.map((track) => track.lyrics)).toEqual(tracks.map((track) => track.lyrics));
  });
  it('cleans unsafe filenames and supports cancellation before work', async () => {
    expect(safeFilename('a/b:c?d')).toBe('a_b_c_d');
    expect(safeFilename('CON')).toBe('歌曲');
    await expect(createMusicArchive([], () => {})).rejects.toThrow('选择');
    const controller = new AbortController(); controller.abort();
    const demo = await fs.readFile('public/demo/弦栖霁示例.zip');
    const { tracks } = await importFiles([new File([demo], 'demo.zip')], () => {});
    await expect(createMusicArchive(tracks, () => {}, controller.signal)).rejects.toThrow();
  });
});
