import { describe, expect, it } from 'vitest';
import type { Track } from '../types';
import { lyricPatches, readLyricFile } from './lyricImport';

const track: Track = { id: 'track-1', title: 'Snow Light', artist: 'Demo', album: 'Winter', duration: 36, format: 'wav', audio: new Blob(['audio']), lyrics: [{ time: 1, text: 'Snow falls', translation: '旧中文' }], favorite: true, addedAt: 1 };
describe('separate lyrics import', () => {
  it('auto matches unique artist-title and identifies Chinese suffix without touching audio', async () => {
    const original = await readLyricFile(new File(['[00:01]Snow falls\n[00:03]Stay here'], 'Demo - Snow Light.lrc'), [track]);
    const translation = await readLyricFile(new File(['[00:01]雪落下\n[00:03]留在这里'], 'Snow Light.zh.lrc'), [track]);
    expect(original.trackId).toBe(track.id); expect(translation.role).toBe('translation');
    const [{ patch }] = lyricPatches([original, translation], [track]);
    expect(patch.lyrics?.map((line) => line.translation)).toEqual(['雪落下', '留在这里']);
    expect(patch).not.toHaveProperty('audio'); expect(patch).not.toHaveProperty('favorite');
    expect(patch.translationSource).toContain('.zh.lrc'); expect(patch.translationAudit).toBeUndefined();
  });
  it('does not guess among ambiguous versions, and requires selecting a song', async () => {
    const file = await readLyricFile(new File(['[00:01]Snow'], 'Snow Light.lrc'), [track, { ...track, id: 'live', album: 'Live' }]);
    expect(file.trackId).toBe(''); expect(() => lyricPatches([file], [track])).toThrow('选择对应歌曲');
  });
  it('retains existing translations for matching source lines after timing edits', async () => {
    const file = await readLyricFile(new File(['[00:02]Snow falls\n[00:05]New line'], 'Snow Light.lrc'), [track]);
    const [{ patch }] = lyricPatches([file], [track]);
    expect(patch.lyrics?.[0].translation).toBe('旧中文'); expect(patch.lyrics?.[1].translation).toBeUndefined();
  });
  it('rejects duplicate originals and translation-only songs without source', async () => {
    const file = await readLyricFile(new File(['[00:01]雪落下'], 'Snow Light.zh.lrc'), [track]);
    expect(() => lyricPatches([file, file], [track])).toThrow('重复文件');
    expect(() => lyricPatches([file], [{ ...track, lyrics: [] }])).toThrow('尚无原文');
  });
  it('rejects mismatched timed translations, supports UTF-16 TXT by line', async () => {
    const wrong = await readLyricFile(new File(['[00:25]中文'], 'Snow Light.zh.lrc'), [track]);
    expect(() => lyricPatches([wrong], [track])).toThrow('时间轴未匹配');
    const bytes = Uint8Array.from([0xff, 0xfe, ...new Uint8Array(new Uint16Array([...('雪落下')].map((character) => character.charCodeAt(0))).buffer)]);
    const plain = await readLyricFile(new File([bytes], 'Snow Light.zh.txt'), [track]);
    expect(lyricPatches([plain], [track])[0].patch.lyrics?.[0].translation).toBe('雪落下');
  });
});
