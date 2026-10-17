import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const createLibrary = createRequire(import.meta.url)('../../electron/library.cjs');
import { parseLyrics } from './lyrics';
const directories: string[] = [];
async function fixture(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xianqiji-library-test-'));
  directories.push(directory);
  const userData = path.join(directory, 'profile');
  return { directory, userData, library: createLibrary({ userData, ...options }) };
}
const metadata = { id: 'song-1', title: 'Quiet Room', artist: 'Demo', album: 'Season', duration: 12, format: 'wav', favorite: true, addedAt: 1, lyrics: [{ time: 1, text: 'Soft light', translation: '柔和的光' }] };
async function put(library: ReturnType<typeof createLibrary>, value = metadata) {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const token = await library.begin(value, { size: bytes.length, type: 'audio/wav' });
  await library.write(token, 'audio', 0, bytes);
  await library.finish(token, { audio: createHash('sha256').update(bytes).digest('hex') });
}
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const resolved = path.resolve(directory);
    expect(path.dirname(resolved)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(resolved)).toMatch(/^xianqiji-library-test-/);
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

describe('ordinary-file music library', () => {
  it('keeps genuine word timestamps in files and restores them on restart', async () => {
    const { library, userData } = await fixture();
    await put(library);
    const lyrics = parseLyrics('[1000,4000](1000,500,0)Soft (3000,2000,0)light');
    await library.patch(metadata.id, { lyrics });
    const info = await library.info();
    const file = await fs.readFile(path.join(info.path, '歌曲', metadata.id, 'Demo - Quiet Room.lrc'), 'utf8');
    expect(parseLyrics(file)).toEqual(lyrics);
    expect((await createLibrary({ userData }).list())[0].metadata.lyrics).toEqual(lyrics);
  });
  it('writes real audio, matching timed source / Chinese files and metadata, preserving edits after restart', async () => {
    const { library, userData } = await fixture();
    await put(library);
    const info = await library.info();
    const directory = path.join(info.path, '歌曲', metadata.id);
    expect(await fs.readFile(path.join(directory, 'Demo - Quiet Room.lrc'), 'utf8')).toBe('[00:01.00]Soft light');
    expect(await fs.readFile(path.join(directory, 'Demo - Quiet Room.zh.lrc'), 'utf8')).toBe('[00:01.00]柔和的光');
    await library.patch(metadata.id, { lyrics: [{ time: 1, text: 'Soft light', translation: '人工校对中文' }] });
    await library.setCache([['song-aware-cache', '缓存中文']]);
    const restored = createLibrary({ userData });
    expect((await restored.list())[0].metadata.lyrics[0].translation).toBe('人工校对中文');
    expect(await restored.getCache('song-aware-cache')).toBe('缓存中文');
    expect(await restored.read(metadata.id, 'audio', 1, 3)).toEqual(Buffer.from([2, 3, 4]));
    expect(await fs.readFile(path.join(directory, 'Demo - Quiet Room.zh.lrc'), 'utf8')).toContain('人工校对中文');
  });
  it('copies and verifies the entire library, preserves old files and remembers the new location', async () => {
    const { library, directory, userData } = await fixture();
    await put(library); await library.setCache([['checked', '中文']]); await library.markMigrated();
    const original = (await library.info()).path;
    const destination = path.join(directory, 'chosen', '弦栖霁音乐库');
    const moved = await library.move(destination);
    expect(moved.path).toBe(destination);
    expect(moved.previousPath).toBe(original);
    expect(moved.moving).toBe(false);
    await expect(fs.access(path.join(original, 'library.json'))).resolves.toBeUndefined();
    const restored = createLibrary({ userData });
    expect((await restored.info()).path).toBe(destination);
    expect((await restored.list())[0].metadata.favorite).toBe(true);
    expect(await restored.getCache('checked')).toBe('中文');
  });
  it('does not switch on corrupt copy and never overwrites a non-empty destination', async () => {
    const { library, directory } = await fixture({ copyFile: async (_source: string, target: string) => fs.writeFile(target, 'corrupt') });
    await put(library);
    const original = (await library.info()).path;
    await expect(library.move(path.join(directory, 'corrupt-target'))).rejects.toThrow('校验失败');
    expect((await library.info()).path).toBe(original);
    const target = path.join(directory, 'occupied'); await fs.mkdir(target); await fs.writeFile(path.join(target, 'keep.txt'), 'do not overwrite');
    await expect(library.move(target)).rejects.toThrow('已有文件');
    expect(await fs.readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('do not overwrite');
  });
  it('protects existing audio from invalid IDs, bad checksums and unfinished upload migration', async () => {
    const { library, directory } = await fixture();
    await put(library);
    await expect(library.begin({ ...metadata, id: '../outside' }, { size: 1, type: 'audio/wav' })).rejects.toThrow('标识');
    const token = await library.begin(metadata, { size: 1, type: 'audio/wav' });
    await library.write(token, 'audio', 0, new Uint8Array([9]));
    await expect(library.finish(token, { audio: 'wrong' })).rejects.toThrow('校验失败');
    await expect(library.move(path.join(directory, 'new'))).rejects.toThrow('先完成');
    await library.cancel(token);
    expect(await library.read(metadata.id, 'audio', 0, 5)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    await expect(library.move(path.join((await library.info()).path, 'child'))).rejects.toThrow('父、子目录');
  });
  it('never silently creates an empty replacement when a configured drive or folder is missing', async () => {
    const { library, directory, userData } = await fixture();
    await put(library);
    const destination = path.join(directory, 'configured'); await library.move(destination);
    await fs.rename(destination, `${destination}-offline`);
    const restored = createLibrary({ userData });
    await expect(restored.info()).rejects.toThrow();
    await expect(restored.info()).rejects.toThrow();
    await expect(fs.access(destination)).rejects.toThrow();
    await expect(fs.access(path.join(`${destination}-offline`, 'library.json'))).resolves.toBeUndefined();
  });
  it('refuses to migrate a changed source audio instead of certifying its copy as intact', async () => {
    const { library, directory } = await fixture();
    await put(library);
    const original = (await library.info()).path;
    const record = (await library.list())[0];
    await fs.writeFile(path.join(original, '歌曲', metadata.id, record.audio.file), new Uint8Array([9, 9, 9, 9, 9]));
    await expect(library.move(path.join(directory, 'changed-audio'))).rejects.toThrow('源音乐文件');
    expect((await library.info()).path).toBe(original);
  });
  it('opens an existing Data library without copying or changing either library and remembers it after restart', async () => {
    const { library, userData } = await fixture();
    await put(library); await library.setCache([['checked', '当前缓存']]);
    const original = (await library.info()).path;
    const candidate = await fixture();
    await put(candidate.library, { ...metadata, title: 'Existing Library', favorite: false });
    await candidate.library.setCache([['checked', '已有库中文缓存']]);
    const target = (await candidate.library.info()).path;
    const before = await fs.readFile(path.join(target, 'library.json'), 'utf8');
    const originalBefore = await fs.readFile(path.join(original, 'library.json'), 'utf8');
    expect(await library.inspect(candidate.userData)).toEqual({ path: target, trackCount: 1 });
    const opened = await library.useExisting(candidate.userData);
    expect(opened.path).toBe(target);
    expect(opened.previousPath).toBe(original);
    expect(opened.moving).toBe(false);
    expect((await library.list())[0].metadata.title).toBe('Existing Library');
    expect((await library.list())[0].metadata.favorite).toBe(false);
    expect(await library.getCache('checked')).toBe('已有库中文缓存');
    expect(await fs.readFile(path.join(target, 'library.json'), 'utf8')).toBe(before);
    expect(await fs.readFile(path.join(original, 'library.json'), 'utf8')).toBe(originalBefore);
    const restored = createLibrary({ userData });
    expect((await restored.info()).path).toBe(target);
    expect((await restored.info()).legacyMigrated).toBe(true);
    expect(JSON.parse(before).legacyMigrated).toBe(false);
    await restored.useExisting(original);
    expect((await restored.list())[0].metadata.title).toBe(metadata.title);
    expect(await restored.getCache('checked')).toBe('当前缓存');
  });
  it('rejects corrupt audio and keeps the original location and both sets of files', async () => {
    const { library, userData } = await fixture(); await put(library);
    const original = (await library.info()).path;
    const candidate = await fixture(); await put(candidate.library);
    const target = (await candidate.library.info()).path;
    const record = (await candidate.library.list())[0];
    const audio = path.join(target, '歌曲', metadata.id, record.audio.file);
    await fs.writeFile(audio, new Uint8Array([5, 4, 3, 2, 1]));
    await expect(library.useExisting(target)).rejects.toThrow('校验失败');
    expect((await library.info()).path).toBe(original);
    expect(await fs.readFile(audio)).toEqual(Buffer.from([5, 4, 3, 2, 1]));
    await expect(fs.access(path.join(userData, 'library-location.json'))).rejects.toThrow();
    expect(await library.read(metadata.id, 'audio', 0, 5)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
  });
  it('rejects ordinary folders, malformed manifests, unsafe paths and corrupt translation caches without creating a replacement', async () => {
    const { library, directory } = await fixture(); await put(library);
    const original = (await library.info()).path;
    const ordinary = path.join(directory, 'ordinary'); await fs.mkdir(ordinary); await fs.writeFile(path.join(ordinary, 'song.mp3'), 'keep');
    await expect(library.inspect(ordinary)).rejects.toThrow('未找到');
    expect(await fs.readdir(ordinary)).toEqual(['song.mp3']);
    const absent = path.join(directory, 'absent');
    await expect(library.useExisting(absent)).rejects.toThrow();
    await expect(fs.access(absent)).rejects.toThrow();
    const candidate = await fixture(); await put(candidate.library);
    const target = (await candidate.library.info()).path;
    const filename = path.join(target, 'library.json');
    const valid = await fs.readFile(filename, 'utf8');
    await fs.writeFile(filename, '{'); await expect(library.useExisting(target)).rejects.toThrow('无法解析');
    await fs.writeFile(filename, JSON.stringify({ format: 'xianqiji-library-folder', version: 1, libraryId: 'bad', tracks: [] }));
    await expect(library.useExisting(target)).rejects.toThrow('不是受支持');
    const invalid = JSON.parse(valid); invalid.tracks[metadata.id].audio.file = '../outside.wav';
    await fs.writeFile(filename, JSON.stringify(invalid)); await expect(library.useExisting(target)).rejects.toThrow('文件记录无效');
    await fs.writeFile(filename, valid); await fs.writeFile(path.join(target, 'translations-cache.json'), JSON.stringify({ bad: 42 }));
    await expect(library.useExisting(target)).rejects.toThrow('译文缓存');
    expect((await library.info()).path).toBe(original);
    expect(await fs.readFile(path.join(ordinary, 'song.mp3'), 'utf8')).toBe('keep');
  });
  it('can recover from an unavailable configured library by opening another existing library', async () => {
    const { library, directory, userData } = await fixture(); await put(library);
    const offline = path.join(directory, 'offline'); await library.move(offline); await fs.rename(offline, `${offline}-removed`);
    const restored = createLibrary({ userData }); await expect(restored.info()).rejects.toThrow();
    const candidate = await fixture(); await put(candidate.library, { ...metadata, title: 'Recovery' });
    const target = (await candidate.library.info()).path;
    await restored.useExisting(target);
    expect((await restored.list())[0].metadata.title).toBe('Recovery');
    expect((await restored.info()).previousPath).toBe(offline);
    await expect(fs.access(offline)).rejects.toThrow();
  });
  it('rejects switching during an unfinished upload and preserves location when its config cannot be committed', async () => {
    const { library, userData } = await fixture(); await put(library);
    const candidate = await fixture(); await put(candidate.library);
    const target = (await candidate.library.info()).path;
    const original = (await library.info()).path;
    const token = await library.begin(metadata, { size: 1, type: 'audio/wav' });
    await expect(library.useExisting(target)).rejects.toThrow('先完成或取消');
    await library.cancel(token);
    await fs.mkdir(path.join(userData, 'library-location.json'));
    await expect(library.useExisting(target)).rejects.toThrow();
    expect((await library.info()).path).toBe(original);
    expect((await library.list())[0].metadata.title).toBe(metadata.title);
  });
  it('does not recreate an empty configured library when its manifest disappears', async () => {
    const { library, userData } = await fixture();
    const candidate = await fixture();
    const target = (await candidate.library.info()).path;
    await library.useExisting(target);
    await fs.unlink(path.join(target, 'library.json'));
    const restored = createLibrary({ userData });
    await expect(restored.info()).rejects.toThrow('未创建替代空库');
    await expect(fs.access(path.join(target, 'library.json'))).rejects.toThrow();
    expect(await fs.readdir(target)).toEqual([]);
  });
  it('rejects a library whose song directory is a junction or symbolic link', async () => {
    const { library, directory } = await fixture(); await put(library);
    const original = (await library.info()).path;
    const candidate = await fixture(); await put(candidate.library);
    const source = (await candidate.library.info()).path;
    const target = path.join(directory, 'linked-library'); await fs.mkdir(target);
    await fs.copyFile(path.join(source, 'library.json'), path.join(target, 'library.json'));
    await fs.symlink(path.join(source, '歌曲'), path.join(target, '歌曲'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(library.useExisting(target)).rejects.toThrow('链接');
    expect((await library.info()).path).toBe(original);
    expect((await candidate.library.list()).length).toBe(1);
  });
  it('blocks queued edits while validating and rejects an index changed during verification', async () => {
    const candidate = await fixture(); await put(candidate.library);
    const target = (await candidate.library.info()).path;
    const indexPath = path.join(target, 'library.json'); const index = await fs.readFile(indexPath, 'utf8');
    let attempt: Promise<boolean> | undefined;
    const { library } = await fixture({ onProgress: () => {
      if (!attempt) { attempt = library.patch(metadata.id, { title: 'Must not write' }).then(() => false, () => true); writeFileSync(indexPath, `${index}\n`); }
    } });
    await put(library); const original = (await library.info()).path;
    await expect(library.useExisting(target)).rejects.toThrow('发生变化');
    expect(await attempt).toBe(true);
    expect((await library.info()).path).toBe(original);
    expect((await library.list())[0].metadata.title).toBe(metadata.title);
  });
});
