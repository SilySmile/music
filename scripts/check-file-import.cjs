const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

async function main() {
  const root = path.resolve(__dirname, '..');
  const profile = path.join(root, 'test-results', `file-import-${Date.now()}`);
  const env = { ...process.env, TINGYU_TEST: '1', TINGYU_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  let application;
  try {
    application = await _electron.launch({ executablePath: process.env.TINGYU_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'), args: process.env.TINGYU_EXECUTABLE ? [] : [root], env, cwd: root });
    const page = await application.firstWindow();
    await page.waitForSelector('.empty-state');
    const zip = await JSZip.loadAsync(await fs.readFile(path.join(root, 'public/demo/听屿示例.zip')));
    const audioEntry = Object.values(zip.files).find((entry) => /\.wav$/i.test(entry.name));
    const audio = await audioEntry.async('nodebuffer');
    await page.getByRole('button', { name: '导入音乐', exact: true }).first().click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '单独导入音频', exact: true }).click();
    await (await chooser).setFiles({ name: 'Fixture - Snow Light.wav', mimeType: 'audio/wav', buffer: audio });
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 1);
    const records = await page.evaluate(() => window.tingyuDesktop.listLibraryTracks());
    const track = records[0];
    assert.equal(track.metadata.lyrics.length, 0);
    const original = Buffer.from('[00:00]Snow falls\n[00:05]Stay here');
    const chinese = Buffer.from('[00:00]雪落下\n[00:05]留在这里');
    await page.getByRole('button', { name: '导入音乐', exact: true }).first().click();
    const lyricChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '单独导入歌词', exact: true }).click();
    await (await lyricChooser).setFiles([{ name: `${track.metadata.title}.lrc`, mimeType: 'text/plain', buffer: original }, { name: `${track.metadata.title}.zh.lrc`, mimeType: 'text/plain', buffer: chinese }]);
    await page.getByRole('dialog', { name: '单独导入歌词' }).waitFor();
    await page.getByRole('button', { name: '保存歌词到所选歌曲', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.lyric-import-file').length === 2);
    await page.screenshot({ path: path.join(root, 'test-results/separate-lyrics-import.png') });
    await page.getByRole('button', { name: '保存歌词到所选歌曲', exact: true }).click();
    await page.getByRole('dialog', { name: '单独导入歌词' }).waitFor({ state: 'hidden' });
    const saved = await page.evaluate(() => window.tingyuDesktop.listLibraryTracks());
    assert.equal(saved.length, 1); assert.equal(saved[0].audio.sha256, track.audio.sha256);
    assert.equal(saved[0].metadata.lyrics[0].translation, '雪落下');
    const folder = path.join(profile, '音乐库', '歌曲', track.metadata.id);
    const files = await fs.readdir(folder);
    assert.ok((await fs.readFile(path.join(folder, files.find((file) => file.endsWith('.zh.lrc'))), 'utf8')).includes('雪落下'));
    await page.getByRole('button', { name: '播放全部', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('audio').currentTime > .3);
    console.log('PASS separate audio picker, original + Chinese picker, unique auto match, preview, file persistence and real playback');
    const close = application.waitForEvent('close'); await page.evaluate(() => window.tingyuDesktop.control('quit')); await close;
    application = await _electron.launch({ executablePath: process.env.TINGYU_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'), args: process.env.TINGYU_EXECUTABLE ? [] : [root], env, cwd: root });
    const reopened = await application.firstWindow();
    await reopened.waitForSelector('.track-row');
    assert.equal((await reopened.evaluate(() => window.tingyuDesktop.listLibraryTracks()))[0].metadata.lyrics[1].translation, '留在这里');
    console.log('PASS Chinese lyrics survive app restart without reimporting audio or calling AI');
  } finally { if (application) await application.close().catch(() => {}); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
