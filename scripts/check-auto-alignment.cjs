const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..');
  const textMode = process.argv.includes('--text');
  const profile = path.join(root, 'test-results', `auto-alignment-${Date.now()}`);
  const env = { ...process.env, TINGYU_TEST: '1', TINGYU_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({ executablePath: process.env.TINGYU_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'), args: process.env.TINGYU_EXECUTABLE ? [] : [root], env, cwd: root });
    const page = await app.firstWindow(); const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForSelector('.empty-state');
    await page.locator('input[aria-label="选择音乐压缩包或歌曲文件"]').setInputFiles(path.join(root, 'public/demo/弦栖霁示例.zip'));
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3);
    const original = await page.evaluate(() => window.tingyuDesktop.listLibraryTracks());
    const readyId = original[0].metadata.id;
    await page.evaluate(async (id) => {
      const record = (await window.tingyuDesktop.listLibraryTracks()).find((track) => track.metadata.id === id);
      await window.tingyuDesktop.patchLibraryTrack(id, { lyrics: record.metadata.lyrics.map((line) => ({ ...line, words: [{ time: line.time, endTime: line.time + 1, text: line.text }] })) });
    }, readyId);
    await page.reload(); await page.waitForSelector('.track-row');
    await app.evaluate(({ net }, { fixtures, textMode }) => {
      const originalFetch = net.fetch.bind(net);
      globalThis.audioCalls = [];
      globalThis.audioRequests = 0;
      globalThis.repairAlignmentFixtures = false;
      net.fetch = async (url, options) => {
        if (textMode && String(url) === 'https://api.deepseek.com/chat/completions') {
          globalThis.audioRequests++;
          const body = JSON.parse(options.body);
          const data = JSON.parse(body.messages[1].content);
          const fixture = fixtures.find((record) => record.metadata.title === data.song.title && (globalThis.repairAlignmentFixtures || data.lines.every((line) => record.metadata.lyrics[line.id]?.text === line.source)));
          if (!fixture) return new Response('{}', { status: 404 });
          globalThis.audioCalls.push({ id: fixture.metadata.id, model: body.model, fileSize: 0, responseFormat: body.response_format.type });
          const legacyOverflow = globalThis.audioCalls.length === 1;
          const lines = data.lines.map((line) => ({ id: line.id, source: line.source, singing: '模拟唱法分析：短暂停顿、句尾拖音；未经录音验证', tailPause: .5, words: line.units.map((text, i) => legacyOverflow ? { text, start: line.start + i * .01, end: line.end + 1 } : { text, duration: i === line.units.length - 1 ? '3' : '1', pauseBefore: i ? '.2' : 0 }) }));
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ song: data.song, lines }) } }] }), { status: 200 });
        }
        if (!textMode && String(url) === 'https://alignment.example.test/v1/audio/transcriptions') {
          globalThis.audioRequests++;
          const form = options.body; const prompt = form.get('prompt');
          const fixture = fixtures.find((record) => record.metadata.lyrics.map((line) => line.text).join('\n').slice(0, 2500) === prompt);
          if (!fixture) return new Response('{}', { status: 404 });
          globalThis.audioCalls.push({ id: fixture.metadata.id, model: form.get('model'), fileSize: form.get('file').size, responseFormat: form.get('response_format'), granularity: form.get('timestamp_granularities[]') });
          const words = fixture.metadata.lyrics.flatMap((line, index, lines) => {
            const parts = line.text.trim().split(/\s+/); const span = Math.min(3, (lines[index + 1]?.time || fixture.metadata.duration) - line.time - .1);
            return parts.map((word, i) => ({ word, start: line.time + .01 + i / parts.length * span, end: line.time + .01 + (i + .8) / parts.length * span }));
          });
          return new Response(JSON.stringify({ words }), { status: 200 });
        }
        if (/^https?:/.test(String(url))) throw new Error('Unexpected external network in isolated test');
        return originalFetch(url, options);
      };
    }, { fixtures: original, textMode });
    await page.getByRole('button', { name: '偏好设置', exact: true }).first().click();
    await page.getByLabel('AI 服务地址', { exact: true }).fill(textMode ? 'https://api.deepseek.com' : 'https://alignment.example.test/v1');
    if (!textMode) await page.getByLabel('逐字时间生成方式', { exact: true }).selectOption('audio');
    else assert.equal(await page.getByLabel('逐字时间生成方式', { exact: true }).inputValue(), 'text');
    await page.getByLabel('AI 模型名称', { exact: true }).fill('fixture-text-model');
    await page.getByLabel('翻译 API Key', { exact: true }).fill('fixture-not-a-real-key');
    assert.equal(await page.getByLabel('自动生成缺失的逐字歌词', { exact: true }).isChecked(), true);
    await page.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.alignment-status')?.textContent.includes('生成 2 首'), { timeout: 20000 });
    const calls = await app.evaluate(() => globalThis.audioCalls);
    assert.equal(calls.length, 2); assert.ok(calls.every((call) => call.id !== readyId && (textMode ? call.model === 'fixture-text-model' && call.fileSize === 0 : call.model === 'whisper-1' && call.fileSize > 0 && call.responseFormat === 'verbose_json' && call.granularity === 'word')));
    const saved = await page.evaluate(() => window.tingyuDesktop.listLibraryTracks());
    for (const record of saved) {
      assert.ok(record.metadata.lyrics.every((line) => line.words?.length));
      if (textMode && record.metadata.id !== readyId) {
        assert.ok(record.metadata.lyrics.every((line) => line.wordTiming === 'estimated'));
        assert.deepEqual(record.metadata.lyrics.map((line) => line.time), original.find((old) => old.metadata.id === record.metadata.id).metadata.lyrics.map((line) => line.time));
        for (const [index, line] of record.metadata.lyrics.entries()) {
          const end = record.metadata.lyrics[index + 1]?.time ?? record.metadata.duration;
          for (const [wordIndex, word] of line.words.entries()) {
            assert.ok(word.time >= (line.words[wordIndex - 1]?.endTime ?? line.time));
            assert.ok(word.endTime > word.time && word.endTime <= end);
          }
        }
      }
      const old = original.find((item) => item.metadata.id === record.metadata.id);
      assert.deepEqual(record.metadata.lyrics.map((line) => line.translation), old.metadata.lyrics.map((line) => line.translation));
      const directory = path.join(profile, '音乐库', '歌曲', record.metadata.id);
      const lrc = (await fs.readdir(directory)).find((name) => name.endsWith('.lrc') && !name.endsWith('.zh.lrc'));
      const lrcText = await fs.readFile(path.join(directory, lrc), 'utf8');
      assert.match(lrcText, /<\d\d:\d\d\.\d\d\d>/);
      if (textMode && record.metadata.id !== readyId) assert.ok(lrcText.includes('[x-timing:estimated]'));
    }
    await page.screenshot({ path: path.join(root, 'test-results/automatic-word-alignment.png'), fullPage: true });
    await page.reload(); await page.waitForSelector('.track-row');
    await page.getByRole('button', { name: '偏好设置', exact: true }).first().click();
    await page.waitForFunction(() => document.querySelector('.alignment-status')?.textContent.includes('生成 0 首'), { timeout: 20000 });
    assert.equal((await app.evaluate(() => globalThis.audioCalls)).length, 2);
    await page.evaluate(async (readyId) => {
      for (const record of await window.tingyuDesktop.listLibraryTracks()) {
        if (record.metadata.id === readyId) continue;
        const lyrics = record.metadata.lyrics.map((line, index) => index === 0 ? { ...line, words: undefined, text: line.text + ' changed source' } : line);
        await window.tingyuDesktop.patchLibraryTrack(record.metadata.id, { lyrics });
      }
    }, readyId);
    await page.reload(); await page.waitForSelector('.track-row');
    await page.getByRole('button', { name: '偏好设置', exact: true }).first().click();
    await page.waitForFunction(() => document.querySelector('.alignment-status')?.textContent.includes('404'), { timeout: 20000 });
    assert.equal(await app.evaluate(() => globalThis.audioRequests), 3, 'a provider error must stop the rest of the queue');
    await page.reload(); await page.waitForSelector('.track-row');
    await page.getByRole('button', { name: '偏好设置', exact: true }).first().click();
    await page.waitForFunction(() => document.querySelector('.alignment-status')?.textContent.includes('上次识别未确认完成'), { timeout: 20000 });
    assert.equal(await app.evaluate(() => globalThis.audioRequests), 3, 'failed / uncertain paid calls must not be retried on reload');
    if (textMode) {
      await app.evaluate(() => { globalThis.repairAlignmentFixtures = true; });
      await page.getByRole('button', { name: '重试未完成项（可能计费）', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.alignment-status')?.textContent.includes('生成 2 首'), { timeout: 20000 });
      assert.equal(await app.evaluate(() => globalThis.audioRequests), 5, 'manual retry recovers failed checkpoints with one request per remaining song');
      const retried = await page.evaluate(() => window.tingyuDesktop.listLibraryTracks());
      assert.ok(retried.every((record) => record.metadata.lyrics.every((line) => line.words?.length)));
    }
    assert.deepEqual(errors, []);
    console.log((textMode ? 'CHAT ESTIMATION (mock DeepSeek, zero audio uploads): PASS local repair of legacy overflow/overlap, vocal-length and pause weights, bounded word times, manual recovery of failed checkpoints; ' : 'AUDIO ALIGNMENT: PASS word-timestamp model; ') + 'automatic check after saved AI configuration, zero-call skip of existing word timing, enhanced LRC, Chinese retention, zero duplicate calls, queue stops on provider error and failed / uncertain jobs stay paused after reload');
  } finally { if (app) await app.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
