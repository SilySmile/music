import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { migrateProfile, cleanupProfile, profilePath, inventory } = createRequire(import.meta.url)('../../electron/profile.cjs');
const roots: string[] = [];
function fixture() {
  const parent = path.resolve('test-results/profile-unit'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-')); roots.push(root);
  const source = path.join(root, 'old'); const target = path.join(root, 'install', 'Data');
  fs.mkdirSync(path.join(source, '音乐库'), { recursive: true });
  fs.writeFileSync(path.join(source, '音乐库', 'library.json'), '{"tracks":{}}');
  fs.writeFileSync(path.join(source, '音乐库', '歌曲.wav'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(source, 'translation-key.bin'), 'encrypted');
  fs.writeFileSync(path.join(source, 'library-location.json'), JSON.stringify({ path: path.join(source, '音乐库') }));
  return { root, source, target };
}
afterEach(() => { for (const root of roots.splice(0)) { expect(path.dirname(root)).toBe(path.resolve('test-results/profile-unit')); fs.rmSync(root, { recursive: true }); } });
describe('installation-local profile', () => {
  it('uses install Data, portable launcher folder and isolated test overrides', () => {
    expect(profilePath({ packaged: true, executable: path.resolve('install/app.exe') })).toBe(path.resolve('install/Data'));
    expect(profilePath({ packaged: true, executable: path.resolve('temp/app.exe'), portableDirectory: path.resolve('portable') })).toBe(path.resolve('portable/Data'));
    expect(profilePath({ packaged: true, testing: true, testData: path.resolve('test-profile') })).toBe(path.resolve('test-profile'));
  });
  it('copies every file, verifies an immutable backup, rebases paths and cleans only the matching source', () => {
    const { source, target } = fixture(); const original = inventory(source);
    const result = migrateProfile(source, target);
    expect(inventory(result.backup)).toEqual(original);
    expect(fs.readFileSync(path.join(target, 'translation-key.bin'), 'utf8')).toBe('encrypted');
    expect(JSON.parse(fs.readFileSync(path.join(target, 'library-location.json'), 'utf8')).path).toBe(path.join(target, '音乐库'));
    expect(() => cleanupProfile(result.receiptPath, target)).toThrow('不匹配');
    expect(cleanupProfile(result.receiptPath, source).cleaned).toBe(true);
    expect(inventory(result.backup)).toEqual(original); expect(fs.existsSync(target)).toBe(true);
  });
  it('never overwrites an existing destination or deletes a source changed since verification', () => {
    const { source, target } = fixture(); const result = migrateProfile(source, target);
    expect(() => migrateProfile(source, target)).toThrow('非空');
    fs.writeFileSync(path.join(source, 'new-song'), 'new');
    expect(() => cleanupProfile(result.receiptPath, source)).toThrow('校验失败');
    expect(fs.existsSync(source)).toBe(true);
  });
});
