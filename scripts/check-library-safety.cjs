const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

async function main() {
  const root = path.resolve(__dirname, '..');
  const profile = path.join(root, 'test-results', `library-safety-${Date.now()}`);
  const env = { ...process.env, TINGYU_TEST: '1', TINGYU_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  let application;
  const errors = [];
  try {
    application = await _electron.launch({ executablePath: process.env.TINGYU_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'), args: process.env.TINGYU_EXECUTABLE ? [] : [root], env, cwd: root });
    const page = await application.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForSelector('.empty-state');
    await page.getByRole('button', { name: '先听听示例', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3);
    assert.equal(await page.locator('.delete-song,.remove-favorite').count(), 0);
    const before = await page.evaluate(() => window.tingyuDesktop.listLibraryTracks());
    await page.locator('.track-row').first().locator('.favorite').click();
    await page.locator('.sidebar nav button').nth(1).click();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 1);
    await page.getByRole('button', { name: /^移出我喜欢 / }).click();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 0);
    const after = await page.evaluate(() => window.tingyuDesktop.listLibraryTracks());
    assert.equal(after.length, 3);
    assert.deepEqual(after.map((record) => record.audio), before.map((record) => record.audio));
    await page.locator('.sidebar nav button').nth(0).click();
    const zip = await JSZip.loadAsync(await fs.readFile(path.join(root, 'public/demo/弦栖霁示例.zip')));
    const audio = await Object.values(zip.files).find((entry) => /\.wav$/i.test(entry.name)).async('nodebuffer');
    const record = before.find((item) => item.audio.sha256 === require('node:crypto').createHash('sha256').update(audio).digest('hex'));
    assert.ok(record);
    const library = await page.evaluate(() => window.tingyuDesktop.getLibraryInfo());
    const audioFile = path.join(library.path, '歌曲', record.metadata.id, record.audio.file);
    const statBefore = await fs.stat(audioFile);
    await page.getByLabel('选择单独音频文件', { exact: true }).setInputFiles({ name: '改名重复歌曲.wav', mimeType: 'audio/wav', buffer: audio });
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('导入完成'));
    assert.equal((await page.evaluate(() => window.tingyuDesktop.listLibraryTracks())).length, 3);
    assert.equal((await fs.stat(audioFile)).mtimeMs, statBefore.mtimeMs);
    const current = (await page.evaluate(() => window.tingyuDesktop.listLibraryTracks())).find((item) => item.metadata.id === record.metadata.id);
    assert.deepEqual(current.metadata.lyrics, record.metadata.lyrics);
    await page.evaluate(async () => {
      const bridge = window.tingyuDesktop;
      for (let index = 0; index < 301; index++) {
        const bytes = new Uint8Array(52);
        const data = new DataView(bytes.buffer);
        const text = (offset, value) => [...value].forEach((character, position) => { bytes[offset + position] = character.charCodeAt(0); });
        text(0, 'RIFF'); data.setUint32(4, 44, true); text(8, 'WAVEfmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true); data.setUint32(24, 8000, true); data.setUint32(28, 16000, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true); text(36, 'data'); data.setUint32(40, 8, true); data.setUint32(44, index, true);
        const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        const metadata = { id, title: `分页样例 ${String(index).padStart(3, '0')}`, artist: '测试', album: '隔离测试', format: 'WAV', duration: 0.0005, lyrics: [], favorite: false, addedAt: 10000 + index };
        const token = await bridge.beginLibraryTrack(metadata, { size: bytes.length, type: 'audio/wav' });
        await bridge.writeLibraryChunk(token, 'audio', 0, bytes);
        await bridge.finishLibraryTrack(token, { audio: id });
      }
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 100);
    await page.getByRole('navigation', { name: '歌曲分页' }).waitFor();
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.row-index')?.textContent === '101');
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 4);
    await page.locator('.track-row').first().locator('.row-number').click();
    await page.getByRole('button', { name: '播放队列', exact: true }).click();
    assert.equal(await page.locator('.queue-row').count(), 304);
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await page.getByRole('textbox', { name: '搜索音乐', exact: true }).fill('分页样例 000');
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 1);
    assert.equal(await page.getByRole('navigation', { name: '歌曲分页' }).count(), 0);
    await page.getByRole('button', { name: '清除搜索', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 100);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('navigation', { name: '歌曲分页' }).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(profile, 'mobile-pagination.png') });
    console.log('PASS no library delete controls; favorite removal retains files; renamed audio dedup preserves file timestamp and translations; 304-song list mounts at most 100 rows; global search/full queue/mobile pagination; isolated fixtures only');
  } finally { if (application) await application.close().catch(() => {}); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
