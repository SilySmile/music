const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..');
  const profile = path.join(root, 'test-results', `legacy-library-${Date.now()}`);
  const environment = { ...process.env, TINGYU_TEST: '1', TINGYU_TEST_DATA: profile };
  delete environment.ELECTRON_RUN_AS_NODE;
  const legacy = process.env.TINGYU_LEGACY_EXECUTABLE || path.join(root, 'release/v0.3.6/win-unpacked/弦栖霁.exe');
  await fs.access(legacy).catch(() => { throw new Error('历史安装包已清理。请将 TINGYU_LEGACY_EXECUTABLE 指向另行保存的 v0.3.6 主程序后再运行历史迁移回归。'); });
  let application;
  try {
    application = await _electron.launch({ executablePath: legacy, args: [], env: environment, cwd: root, timeout: 60000 });
    const oldPage = await application.firstWindow();
    await oldPage.waitForSelector('.empty-state');
    await oldPage.getByRole('button', { name: '先听听示例', exact: true }).click();
    await oldPage.waitForFunction(() => document.querySelectorAll('.track-row').length === 3);
    const id = await oldPage.evaluate(async () => {
      const database = await new Promise((resolve) => { const request = indexedDB.open('tingyu-library', 3); request.onsuccess = () => resolve(request.result); });
      const tracks = await new Promise((resolve) => { const request = database.transaction('tracks').objectStore('tracks').getAll(); request.onsuccess = () => resolve(request.result); });
      const track = tracks[0]; track.lyrics[0].translation = '旧版保留的人工中文'; track.favorite = true;
      await new Promise((resolve, reject) => { const transaction = database.transaction(['tracks', 'translations'], 'readwrite'); transaction.objectStore('tracks').put(track); transaction.objectStore('translations').put('旧版核对缓存', 'legacy-reviewed-cache'); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
      database.close(); return track.id;
    });
    const oldExit = application.waitForEvent('close'); await oldPage.evaluate(() => window.tingyuDesktop.control('quit')); await oldExit;
    const executable = process.env.TINGYU_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe');
    application = await _electron.launch({ executablePath: executable, args: process.env.TINGYU_EXECUTABLE ? [] : [root], env: environment, cwd: root, timeout: 60000 });
    const page = await application.firstWindow();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3, { timeout: 30000 });
    const info = await page.evaluate(() => window.tingyuDesktop.getLibraryInfo());
    assert.equal(info.legacyMigrated, true);
    const records = await page.evaluate(() => window.tingyuDesktop.listLibraryTracks());
    const retained = records.find((record) => record.metadata.id === id);
    assert.equal(retained.metadata.lyrics[0].translation, '旧版保留的人工中文'); assert.equal(retained.metadata.favorite, true);
    assert.equal(await page.evaluate(() => window.tingyuDesktop.getLibraryCache('legacy-reviewed-cache')), '旧版核对缓存');
    const count = await page.evaluate(async () => {
      const database = await new Promise((resolve) => { const request = indexedDB.open('tingyu-library', 3); request.onsuccess = () => resolve(request.result); });
      const result = await new Promise((resolve) => { const request = database.transaction('tracks').objectStore('tracks').count(); request.onsuccess = () => resolve(request.result); }); database.close(); return result;
    });
    assert.equal(count, 0);
    const files = await fs.readdir(path.join(info.path, '歌曲', id));
    assert.ok((await fs.readFile(path.join(info.path, '歌曲', id, files.find((file) => file.endsWith('.zh.lrc'))), 'utf8')).includes('旧版保留的人工中文'));
    await page.getByRole('button', { name: '播放全部', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('audio').currentTime > .3);
    const exit = application.waitForEvent('close'); await page.evaluate(() => window.tingyuDesktop.control('quit')); await exit;
    console.log('PASS real v0.3.6 Chromium IndexedDB upgrade: audio, Chinese, favorites and reviewed cache retained, old blobs cleared after verification');
  } finally { if (application) await application.close().catch(() => {}); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
