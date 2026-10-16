const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const createLibrary = require('../electron/library.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = path.join(root, 'test-results', `existing-library-${Date.now()}`);
  const profile = path.join(directory, 'current');
  const otherProfile = path.join(directory, 'existing', 'Data');
  const target = path.join(otherProfile, '音乐库');
  const environment = { ...process.env, TINGYU_TEST: '1', TINGYU_TEST_DATA: profile };
  delete environment.ELECTRON_RUN_AS_NODE;
  const executable = process.env.TINGYU_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe');
  const args = process.env.TINGYU_EXECUTABLE ? [] : [root];
  const digest = async (filename) => createHash('sha256').update(await fs.readFile(filename)).digest('hex');
  let application;
  async function launch() { application = await _electron.launch({ executablePath: executable, args, env: environment, cwd: root, timeout: 60000 }); const page = await application.firstWindow(); page.setDefaultTimeout(15000); return page; }
  async function close(page) { const stopped = application.waitForEvent('close'); await page.evaluate(() => window.tingyuDesktop.control('quit')); await stopped; application = null; }
  async function choose(page, folder) {
    await application.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => selected ? { canceled: false, filePaths: [selected] } : { canceled: true, filePaths: [] }; }, folder);
    await page.getByRole('button', { name: '打开已有音乐库', exact: true }).click();
  }
  async function switchTo(page, folder, count) {
    await choose(page, folder);
    await page.getByRole('button', { name: '校验并切换到已有音乐库', exact: true }).click();
    await page.waitForFunction((expected) => document.querySelectorAll('.track-row').length === expected && !document.querySelector('.storage-settings'), count);
  }
  try {
    let page = await launch(); await page.waitForSelector('.empty-state');
    await page.getByRole('button', { name: '先听听示例', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3);
    await page.getByRole('button', { name: '播放全部', exact: true }).click(); await page.waitForFunction(() => document.querySelector('audio').currentTime > 0.2);
    await page.waitForFunction(async () => (await window.tingyuDesktop.listLibraryTracks()).some((record) => record.metadata.lastPlayed > 0));
    const original = (await page.evaluate(() => window.tingyuDesktop.getLibraryInfo())).path;
    await page.evaluate(() => { localStorage.setItem('tingyu-volume', '0.42'); return window.tingyuDesktop.setLibraryCache([['library-specific', '当前库缓存']]); });
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.cp(original, target, { recursive: true, errorOnExist: true, force: false });
    const candidate = createLibrary({ userData: otherProfile }); const records = await candidate.list();
    const shared = records.find((record) => record.metadata.lastPlayed > 0);
    assert.ok(shared);
    const removed = records.find((record) => record.metadata.id !== shared.metadata.id);
    await candidate.remove(removed.metadata.id);
    await candidate.patch(shared.metadata.id, { title: '已有库中的同一首歌', favorite: true, lyrics: shared.metadata.lyrics.map((line, index) => index === 0 ? { ...line, translation: '已有库的中文，不可复用旧缓存' } : line) });
    await candidate.setCache([['library-specific', '已有库缓存']]);
    const beforeOriginal = await digest(path.join(original, 'library.json'));
    const beforeTarget = await digest(path.join(target, 'library.json'));
    await fs.writeFile(path.join(profile, 'settings-retained.txt'), 'current settings retained');
    await page.getByRole('button', { name: '偏好设置', exact: true }).first().click();
    await choose(page, null); assert.equal(await page.getByLabel('已有音乐库路径', { exact: true }).count(), 0);
    await switchTo(page, otherProfile, 2);
    assert.equal(await page.locator('audio').evaluate((audio) => audio.paused), true);
    assert.ok(await page.getByText('已有库中的同一首歌', { exact: true }).count());
    assert.equal(await page.evaluate(() => window.tingyuDesktop.getLibraryCache('library-specific')), '已有库缓存');
    assert.equal(await page.evaluate(() => localStorage.getItem('tingyu-volume')), '0.42');
    const info = await page.evaluate(() => window.tingyuDesktop.getLibraryInfo()); assert.equal(info.path, target); assert.equal(info.internalPath, profile);
    assert.equal(await digest(path.join(original, 'library.json')), beforeOriginal); assert.equal(await digest(path.join(target, 'library.json')), beforeTarget);
    assert.equal(await fs.readFile(path.join(profile, 'settings-retained.txt'), 'utf8'), 'current settings retained');
    await page.getByRole('button', { name: '打开完整歌词', exact: true }).click(); await page.getByText('已有库的中文，不可复用旧缓存', { exact: true }).waitFor();
    await close(page); page = await launch(); await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 2);
    assert.equal((await page.evaluate(() => window.tingyuDesktop.getLibraryInfo())).path, target);
    await page.getByRole('button', { name: '偏好设置', exact: true }).first().click();
    await page.locator('.startup-screen').waitFor({ state: 'detached' });
    await page.locator('.storage-settings').screenshot({ path: path.join(root, 'test-results/existing-library-settings.png') });
    await switchTo(page, original, 3);
    assert.equal(await page.evaluate(() => window.tingyuDesktop.getLibraryCache('library-specific')), '当前库缓存');
    assert.equal(await digest(path.join(original, 'library.json')), beforeOriginal);
    const audioPath = path.join(target, '歌曲', shared.metadata.id, shared.audio.file);
    const handle = await fs.open(audioPath, 'r+'); try { await handle.write(new Uint8Array([123]), 0, 1, 0); } finally { await handle.close(); }
    const corrupted = await digest(audioPath);
    await page.getByRole('button', { name: '偏好设置', exact: true }).first().click(); await choose(page, target);
    await page.getByRole('button', { name: '校验并切换到已有音乐库', exact: true }).click(); await page.locator('.storage-settings [role="status"]').filter({ hasText: '校验失败' }).waitFor();
    assert.equal((await page.evaluate(() => window.tingyuDesktop.getLibraryInfo())).path, original);
    assert.equal(await digest(audioPath), corrupted); assert.equal(await digest(path.join(target, 'library.json')), beforeTarget);
    assert.equal(await digest(path.join(original, 'library.json')), beforeOriginal);
    await close(page);
    const result = { directDataSelection: true, noCopyOrMerge: true, existingChineseAndCache: true, settingsRetained: true, pauseAndReload: true, restartPersistence: true, switchBack: true, corruptionBlocked: true };
    await fs.writeFile(path.join(root, 'test-results/existing-library-check.json'), JSON.stringify(result, null, 2));
    console.log('PASS existing Data selection, full verification, pause + reload, same-ID metadata/cache isolation, settings retention, restart, switch-back and corrupt-file rejection');
  } catch (error) {
    if (application) {
      const page = await application.firstWindow();
      console.error(await page.evaluate(async () => ({ url: location.href, rows: document.querySelectorAll('.track-row').length, status: document.querySelector('.storage-settings [role="status"]')?.textContent, info: await window.tingyuDesktop.getLibraryInfo() })));
      await page.screenshot({ path: path.join(root, 'test-results/existing-library-error.png') });
    }
    throw error;
  } finally { if (application) await application.close().catch(() => {}); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
