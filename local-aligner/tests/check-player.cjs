// Real Electron IPC + loopback HTTP; all audio/model outputs are isolated fixtures.
const path = require('node:path');
const projectRoot = path.resolve(process.env.XIANQIJI_PLAYER_ROOT || process.cwd());
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || require.resolve('playwright', { paths: [projectRoot] }));
const http = require('node:http');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
async function until(probe, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${label}`);
}
async function main() {
  const root = projectRoot;
  const output = path.resolve(__dirname, '../runtime');
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, 'player-test-'));
  const key = 'fixture-local-key-not-user-secret';
  let app, base, active = 0, peak = 0, pressure = false, partial = false, delay = 200;
  const calls = [];
  const server = http.createServer(async (req, res) => {
    res.on('error', () => {});
    try {
      if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401); res.end('{}'); return; }
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/health') { res.end(JSON.stringify({ service: 'xianqiji-forced-aligner', protocol: 1, model: 'fixture-aligner', ready: true, resource_ready: !pressure, reason: pressure ? '模拟显存繁忙' : '', concurrency: 2, alignment_strategies: 5 })); return; }
      assert.equal(req.url, '/v1/alignments');
      assert.ok(Number(req.headers['content-length']) > 0, 'Chromium multipart must supply Content-Length for the bounded server');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const form = await new Request(base + req.url, { method: 'POST', headers: { 'Content-Type': req.headers['content-type'] }, body: Buffer.concat(chunks) }).formData();
      const input = JSON.parse(form.get('alignment')); assert.ok(form.get('file').size > 0);
      const call = { trackId: input.trackId, ids: input.lines.map((line) => line.id), ends: input.lines.map((line) => line.end), attempt: input.attempt || 0 }; calls.push(call);
      active++; peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, delay));
        const lines = input.lines.map((line) => partial && line.id === 0 ? { id: line.id, text: line.text, error: 'fixture unmatched' } : { id: line.id, text: line.text, words: line.units.map((text, index) => ({ text, start: line.start + index * 2, end: line.start + index * 2 + 1 })) });
        res.end(JSON.stringify({ protocol: 1, trackId: input.trackId, model: 'fixture-aligner', lines }));
      } finally { active--; }
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    const env = { ...process.env, TINGYU_TEST: '1', TINGYU_TEST_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: process.env.TINGYU_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'), args: process.env.TINGYU_EXECUTABLE ? [] : [root], env, cwd: root });
    const page = await app.firstWindow(); const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForSelector('.empty-state');
    await page.locator('input[aria-label="选择音乐压缩包或歌曲文件"]').setInputFiles(path.join(root, 'public/demo/弦栖霁示例.zip'));
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3);
    const records = await page.evaluate(() => window.tingyuDesktop.listLibraryTracks()); const ids = records.map((record) => record.metadata.id);
    const missing = [{ time: 1, text: '你好', translation: 'Hello' }, { time: 7, text: '再见', translation: 'Goodbye' }];
    const genuine = missing.map((line) => ({ ...line, endTime: line.time + 3, words: [{ text: [...line.text][0], time: line.time, endTime: line.time + 1 }, { text: [...line.text][1], time: line.time + 2, endTime: line.time + 3 }] }));
    const estimated = [{ ...genuine[0], endTime: 6, words: [{ text: '你好', time: 1, endTime: 6 }], wordTiming: 'estimated', timingNote: 'wrong old estimate' }, missing[1]];
    await page.evaluate(async ({ ids, estimated, missing, genuine }) => {
      await window.tingyuDesktop.patchLibraryTrack(ids[0], { lyrics: estimated });
      await window.tingyuDesktop.patchLibraryTrack(ids[1], { lyrics: [genuine[0], missing[1]] });
      await window.tingyuDesktop.patchLibraryTrack(ids[2], { lyrics: genuine });
      localStorage.setItem('tingyu-ai-config', JSON.stringify({ url: 'https://api.deepseek.com', model: 'fixture-translation', autoAlign: false }));
      await window.tingyuDesktop.saveAIKey('fixture-translation-key');
    }, { ids, estimated, missing, genuine });
    await page.reload(); await page.waitForSelector('.track-row');
    async function settings() { await page.getByRole('button', { name: '偏好设置', exact: true }).first().click(); }
    async function saveConfig() { await page.getByRole('button', { name: '保存 AI 配置', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.config-save')?.textContent.includes('配置已保存')); }
    await settings();
    await page.waitForFunction(() => document.querySelector('input[aria-label="翻译 API Key"]')?.value === 'fixture-translation-key');
    await page.getByLabel('逐字时间生成方式', { exact: true }).selectOption('forced');
    await page.getByLabel('本地强对齐连接配置文件', { exact: true }).setInputFiles({ name: 'fixture-connection.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'xianqiji-local-aligner', url: base + '/v1', model: 'fixture-aligner', key })) });
    await page.getByText(/连接配置已导入/).waitFor();
    await page.getByRole('button', { name: '测试强对齐连接', exact: true }).click();
    await page.getByText(/连接成功：fixture-aligner/).waitFor();
    await page.getByLabel('AI 服务地址', { exact: true }).fill('');
    await page.getByLabel('AI 模型名称', { exact: true }).fill('');
    await saveConfig(); await page.waitForTimeout(1700);
    assert.equal(calls.length, 0, 'manual config save must not upload audio');
    assert.equal(await page.getByLabel('翻译 API Key', { exact: true }).inputValue(), 'fixture-translation-key');
    assert.equal(await page.evaluate(() => localStorage.getItem('tingyu-ai-config').includes('fixture-local-key')), false, 'local secret must not enter plaintext preferences');
    await page.getByRole('button', { name: '打开歌词设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '歌词设置', exact: true });
    await dialog.getByLabel('歌词歌曲', { exact: true }).selectOption(ids[0]);
    await dialog.getByRole('button', { name: 'AI 重新生成整首', exact: true }).click();
    await dialog.getByText('AI 生成完成，可继续调整；点击“保存歌词时间”后生效。', { exact: true }).waitFor();
    assert.deepEqual((await page.evaluate(() => window.tingyuDesktop.listLibraryTracks())).find((record) => record.metadata.id === ids[0]).metadata.lyrics, estimated);
    assert.deepEqual(calls[0].ids, [0, 1]); assert.equal(calls[0].ends[0], 7);
    await dialog.getByRole('button', { name: '保存歌词时间', exact: true }).click();
    await dialog.getByText('逐字时间已保存，主窗口和桌面歌词已更新。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭歌词设置', exact: true }).click();
    await page.evaluate(async ({ id, lyrics }) => { await window.tingyuDesktop.patchLibraryTrack(id, { lyrics }); }, { id: ids[0], lyrics: estimated });
    await page.reload(); await page.waitForSelector('.track-row'); await settings();
    assert.equal(await page.getByLabel('强对齐服务密钥', { exact: true }).inputValue(), key, 'DPAPI bundle must restore the independent local secret');
    pressure = true; partial = true;
    await page.getByLabel('自动本地强对齐', { exact: true }).check();
    await saveConfig(); await page.waitForTimeout(2300);
    assert.equal(calls.length, 1, 'resource pressure must pause before any new audio upload');
    pressure = false;
    await page.getByRole('button', { name: '重试本地强对齐失败项', exact: true }).click();
    await page.waitForFunction(async (ids) => {
      const records = await window.tingyuDesktop.listLibraryTracks();
      return ids.slice(0, 2).every((id) => records.find((record) => record.metadata.id === id).metadata.lyrics[1].words?.length === 2);
    }, ids);
    await page.waitForTimeout(1900);
    await until(() => calls.length === 7, 'bounded retries for remaining phrases');
    await until(async () => (await page.locator('.forced-alignment-settings').innerText()).includes('已检查 2 / 2 首'), 'all retry responses validated and saved before restart');
    assert.equal(calls.length, 7, 'one manual request, two initial automatic songs and four retries for the remaining phrase'); assert.equal(peak, 2);
    assert.deepEqual(calls.filter((call) => call.attempt).map((call) => [call.attempt, call.ids]), [[1, [0]], [2, [0]], [3, [0]], [4, [0]]]);
    const autoRecords = await page.evaluate(() => window.tingyuDesktop.listLibraryTracks());
    const autoStatus = await page.locator('.forced-alignment-settings').innerText();
    assert.equal(autoRecords.find((record) => record.metadata.id === ids[0]).metadata.lyrics[1].wordTiming, undefined, 'accepted phrase must not inherit estimated provenance');
    assert.equal(autoRecords.find((record) => record.metadata.id === ids[0]).metadata.lyrics[1].words.length, 2, 'accepted phrase must be saved before restart');
    const lyricFolder = path.join(profile, '音乐库', '歌曲', ids[0]);
    const lyricFile = (await fs.readdir(lyricFolder)).find((file) => file.endsWith('.lrc') && !file.endsWith('.zh.lrc'));
    const lyricText = await fs.readFile(path.join(lyricFolder, lyricFile), 'utf8');
    assert.ok(lyricText.startsWith('[00:01.000][x-timing:estimated]'), 'native library writes estimate provenance per phrase');
    assert.equal((lyricText.match(/\[x-timing:estimated\]/g) || []).length, 1);
    assert.equal(autoRecords.find((record) => record.metadata.id === ids[0]).metadata.lyrics[0].wordTiming, 'estimated', 'unmatched old estimate must remain intact');
    assert.deepEqual(autoRecords.find((record) => record.metadata.id === ids[2]).metadata.lyrics, genuine, 'genuine timings must be skipped');
    await page.reload(); await page.waitForSelector('.track-row'); await page.waitForTimeout(2200);
    assert.equal(calls.length, 7, 'exhausted distinct strategies must stop automatic retry loops across restart');
    await settings(); partial = false;
    await page.getByRole('button', { name: '重试本地强对齐失败项', exact: true }).click();
    await until(() => calls.length === 8, 'explicit retry request');
    await until(async () => (await page.evaluate(() => window.tingyuDesktop.listLibraryTracks())).find((record) => record.metadata.id === ids[0]).metadata.lyrics[0].wordTiming !== 'estimated', 'retry saved actual times');
    assert.equal(calls.length, 8); assert.deepEqual(calls[7].ids, [0], JSON.stringify({ autoStatus, calls, partial: autoRecords.map((record) => ({ id: record.metadata.id, lyrics: record.metadata.lyrics })) }));
    await page.getByLabel('自动本地强对齐', { exact: true }).uncheck(); await saveConfig();
    await page.getByLabel('强对齐服务密钥', { exact: true }).fill('wrong-fixture-key');
    await page.getByRole('button', { name: '测试强对齐连接', exact: true }).click(); await page.getByText(/HTTP 401/).waitFor();
    await page.getByLabel('强对齐服务密钥', { exact: true }).fill(key);
    await page.getByRole('button', { name: '导入本地强对齐配置', exact: true }).scrollIntoViewIfNeeded();
    await page.setViewportSize({ width: 390, height: 844 });
    const field = await page.getByLabel('强对齐服务地址', { exact: true }).boundingBox(); assert.ok(field.x >= 0 && field.x + field.width <= 392);
    await page.screenshot({ path: path.join(output, 'forced-settings-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: '打开歌词设置', exact: true }).click();
    await dialog.getByLabel('歌词歌曲', { exact: true }).selectOption(ids[0]);
    const beforeCancel = (await page.evaluate(() => window.tingyuDesktop.listLibraryTracks())).find((record) => record.metadata.id === ids[0]).metadata.lyrics;
    delay = 1500;
    await dialog.getByRole('button', { name: 'AI 重新生成整首', exact: true }).click();
    await page.waitForFunction(() => !!document.querySelector('.timing-status')?.textContent.includes('强对齐'));
    await dialog.getByRole('button', { name: '取消生成', exact: true }).click();
    await dialog.getByText('生成已取消，未保存的调整保留。', { exact: true }).waitFor();
    await page.waitForTimeout(1700);
    assert.deepEqual((await page.evaluate(() => window.tingyuDesktop.listLibraryTracks())).find((record) => record.metadata.id === ids[0]).metadata.lyrics, beforeCancel);
    await page.getByRole('button', { name: '关闭歌词设置', exact: true }).click();
    await page.evaluate(async ({ id, lyrics }) => window.tingyuDesktop.patchLibraryTrack(id, { lyrics }), { id: ids[0], lyrics: estimated });
    await page.reload(); await page.waitForSelector('.track-row'); await settings();
    const countBeforeStop = calls.length; delay = 2000;
    await page.getByLabel('自动本地强对齐', { exact: true }).check(); await saveConfig();
    await until(() => calls.length > countBeforeStop, 'automatic request before stop');
    await page.getByLabel('自动本地强对齐', { exact: true }).uncheck(); await saveConfig();
    await page.waitForTimeout(2300);
    assert.deepEqual((await page.evaluate(() => window.tingyuDesktop.listLibraryTracks())).find((record) => record.metadata.id === ids[0]).metadata.lyrics, estimated, 'turning automatic mode off must cancel before saving');
    assert.deepEqual(errors, []);
    console.log('PASS real loopback HTTP + Electron: independent encrypted configuration import/restart/401 checks, audio+reference multipart, manual drafts/save/cancel, two-song concurrency, pressure admission, genuine timing skip, old-estimate replacement, unmatched checkpoints across restart, explicit retry and mobile layout; mock model only');
  } finally { if (app) await app.close(); await new Promise((resolve) => server.close(resolve)); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
