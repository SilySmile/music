const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = path.join(root, 'test-results', `background-ui-${Date.now()}`);
  const env = { ...process.env, TINGYU_TEST: '1', TINGYU_TEST_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({ executablePath: process.env.TINGYU_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'), args: process.env.TINGYU_EXECUTABLE ? [] : [root], env, cwd: root });
    const page = await app.firstWindow(); const errors = [];
    page.setDefaultTimeout(25000); page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForSelector('.empty-state');
    await page.getByRole('button', { name: '先听听示例', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3);
    await app.evaluate(({ ipcMain }) => {
      for (const channel of ['library:write', 'transfer:write-export']) {
        const original = ipcMain._invokeHandlers.get(channel); if (!original) throw Error('Fixture handler missing: ' + channel);
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, ...args) => { if (channel === 'library:write' || args.some((value) => value?.byteLength > 65536)) await new Promise((resolve) => setTimeout(resolve, 400)); return original(event, ...args); });
      }
    });
    const zip = await JSZip.loadAsync(await fs.readFile(path.join(root, 'public/demo/弦栖霁示例.zip')));
    for (const entry of Object.values(zip.files).filter((entry) => /\.wav$/i.test(entry.name))) zip.file(entry.name, Buffer.concat([await entry.async('nodebuffer'), Buffer.from([42])]));
    const input = path.join(directory, 'more-music.zip'); await fs.writeFile(input, await zip.generateAsync({ type: 'nodebuffer' }));
    await page.getByLabel('选择音乐压缩包或歌曲文件', { exact: true }).setInputFiles(input);
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await page.locator('.track-row').first().locator('.track-name').click();
    await page.waitForFunction(() => document.querySelector('audio').currentTime > .1);
    await page.getByRole('button', { name: '传输任务', exact: true }).first().click();
    await page.locator('.transfer-task').filter({ hasText: 'more-music.zip' }).getByText('已完成', { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.tingyuDesktop.listLibraryTracks())).length, 6);
    await page.getByRole('button', { name: '关闭传输任务', exact: true }).click();
    await page.getByRole('button', { name: '导出音乐', exact: true }).click();
    await page.getByRole('button', { name: '导出 ZIP 音乐包', exact: true }).click();
    await page.getByRole('button', { name: '关闭音乐导出', exact: true }).click();
    await page.getByRole('button', { name: '传输任务', exact: true }).first().click();
    const exported = page.locator('.transfer-task').filter({ hasText: '6 首歌曲' });
    await exported.getByText('进行中', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭传输任务', exact: true }).click();
    await page.getByRole('button', { name: '偏好设置', exact: true }).first().click();
    assert.equal(await page.getByRole('button', { name: '打开已有音乐库', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await page.getByRole('button', { name: '传输任务', exact: true }).first().click();
    await exported.getByText('已完成', { exact: true }).waitFor();
    const task = await page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => { const request = indexedDB.open('tingyu-library', 3); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      return new Promise((resolve, reject) => { const request = database.transaction('transfers').objectStore('transfers').getAll(); request.onsuccess = () => { resolve(request.result.find((task) => task.kind === 'export' && task.status === 'completed')); database.close(); }; request.onerror = () => reject(request.error); });
    });
    const result = await JSZip.loadAsync(await fs.readFile(task.location));
    assert.equal(Object.values(result.files).filter((entry) => /\.wav$/i.test(entry.name)).length, 6);
    assert.equal(Object.values(result.files).filter((entry) => /\.zh\.lrc$/i.test(entry.name)).length, 6);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(directory, 'completed-background-tasks.png') });
    const records = await page.evaluate(() => window.tingyuDesktop.listLibraryTracks());
    const target = records[0].metadata.id;
    await page.evaluate(async (id) => {
      await window.tingyuDesktop.patchLibraryTrack(id, { title: 'Background Translation Fixture', lyrics: [{ time: 0, text: 'Hello' }, { time: 5, text: 'Stay' }] });
      await window.tingyuDesktop.saveAIKey('fixture-no-real-ai-key');
      localStorage.setItem('tingyu-ai-config', JSON.stringify({ url: 'https://translation.fixture.test/v1', model: 'fixture', autoAlign: false }));
    }, target);
    await app.evaluate(({ net }) => {
      const original = net.fetch.bind(net); globalThis.translationFixtureCalls = 0;
      net.fetch = async (url, options) => {
        if (String(url) === 'https://translation.fixture.test/v1/chat/completions') {
          globalThis.translationFixtureCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 700));
          const input = JSON.parse(JSON.parse(options.body).messages[1].content);
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ song: input.song, translations: input.lines.map((line) => ({ ...line, text: '后台译文' + line.id })) }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { status: 200 });
        }
        if (/^https?:/.test(String(url))) throw Error('External network forbidden in isolated background UI test');
        return original(url, options);
      };
    });
    await page.reload(); await page.waitForSelector('.track-row');
    await page.getByRole('button', { name: '播放 Background Translation Fixture', exact: true }).click();
    await page.getByRole('button', { name: '联网补全歌词', exact: true }).click();
    await page.getByRole('button', { name: '翻译缺失中文', exact: true }).click();
    await page.getByRole('button', { name: '关闭联网歌词', exact: true }).click();
    await page.getByRole('button', { name: '下一首', exact: true }).first().click();
    await page.getByRole('button', { name: '传输任务', exact: true }).first().click();
    await page.locator('.transfer-task').filter({ hasText: '翻译与校对 · Background Translation Fixture' }).getByText('已完成', { exact: true }).waitFor();
    const translated = await page.evaluate(() => window.tingyuDesktop.listLibraryTracks());
    assert.ok(translated.find((record) => record.metadata.id === target).metadata.lyrics.every((line) => line.translation?.includes('后台译文')));
    for (const record of translated.filter((record) => record.metadata.id !== target)) assert.deepEqual(record.metadata.lyrics, records.find((before) => before.metadata.id === record.metadata.id).metadata.lyrics);
    assert.equal(await app.evaluate(() => globalThis.translationFixtureCalls), 2);
    assert.deepEqual(errors, []);
    console.log('PASS import while listening after closing dialog; export continues after hiding export and task-center windows; full ZIP/audio/Chinese output; no user files or paid requests');
    console.log('PASS hidden translation + review continues while switching songs; result saved only to its original song, no extra AI calls');
  } finally { if (app) await app.close().catch(() => {}); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
