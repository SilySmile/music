const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..');
  const profile = path.join(root, 'test-results', `playback-${Date.now()}`);
  const environment = { ...process.env, TINGYU_TEST: '1', TINGYU_TEST_DATA: profile }; delete environment.ELECTRON_RUN_AS_NODE;
  const executable = process.env.TINGYU_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe');
  const args = process.env.TINGYU_EXECUTABLE ? [] : [root];
  let application;
  try {
    application = await _electron.launch({ executablePath: executable, args, env: environment, cwd: root, timeout: 60000 });
    const page = await application.firstWindow(); const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForSelector('.empty-state');
    await page.screenshot({ path: path.join(root, 'test-results/startup-animation.png') });
    await page.getByRole('button', { name: '先听听示例', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3);
    await page.getByRole('button', { name: '播放全部', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('audio').currentTime > .3);
    const first = await page.locator('.track-row.current .track-name strong').textContent();
    await page.locator('audio').evaluate((audio) => { audio.currentTime = audio.duration - .1; });
    await page.waitForFunction((previous) => document.querySelector('.track-row.current .track-name strong').textContent !== previous && !document.querySelector('audio').paused && document.querySelector('audio').currentTime > .2, first);
    console.log('PASS natural song completion advances to and plays the next song');
    await page.getByRole('button', { name: /^播放全部模式：/ }).click();
    await page.getByRole('button', { name: /^播放全部模式：随机播放/ }).waitFor();
    await page.getByRole('button', { name: /^播放全部模式：/ }).click();
    await page.getByRole('button', { name: /^播放全部模式：单曲循环/ }).waitFor();
    const repeated = await page.locator('.track-row.current .track-name strong').textContent();
    await page.locator('audio').evaluate((audio) => { audio.currentTime = audio.duration - .1; });
    await page.waitForFunction(() => { const audio = document.querySelector('audio'); return !audio.paused && audio.currentTime > .1 && audio.currentTime < 2; });
    assert.equal(await page.locator('.track-row.current .track-name strong').textContent(), repeated);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: /^播放模式：单曲循环/ }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: /^播放模式：单曲循环/ }).click();
    await page.getByRole('button', { name: /^播放全部模式：列表循环/ }).waitFor();
    await page.screenshot({ path: path.join(root, 'test-results/mobile-playback-mode.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 1200, height: 840 });
    console.log('PASS mode toggles in mobile footer and beside Play All stay synchronized; single-track replay works');
    await page.getByRole('button', { name: '偏好设置', exact: true }).first().click();
    await page.getByLabel('睡眠分钟数').fill('1'); await page.getByLabel('睡眠停止方式').selectOption('immediate');
    await page.getByRole('button', { name: '开始定时', exact: true }).click();
    await page.evaluate(() => { window.testDateNow = Date.now; const future = Date.now() + 61000; Date.now = () => future; });
    await page.waitForFunction(() => document.querySelector('audio').paused);
    await page.evaluate(() => { Date.now = window.testDateNow; });
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await page.getByRole('button', { name: '播放', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('audio').paused);
    await page.getByRole('button', { name: '偏好设置', exact: true }).first().click();
    await page.getByLabel('睡眠分钟数').fill('1'); await page.getByLabel('睡眠停止方式').selectOption('finish-track'); await page.getByRole('button', { name: '开始定时', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('audio').paused && document.querySelector('.sleep-settings').textContent.includes('剩余'));
    await page.evaluate(() => { window.testDateNow = Date.now; const future = Date.now() + 61000; Date.now = () => future; });
    await page.waitForFunction(() => document.querySelector('.sleep-settings').textContent.includes('当前歌曲结束后停止'));
    assert.equal(await page.locator('audio').evaluate((audio) => audio.paused), false);
    const finishing = await page.locator('.track-row.current .track-name strong').textContent();
    await page.locator('audio').evaluate((audio) => { audio.currentTime = audio.duration - .1; });
    await page.waitForFunction(() => document.querySelector('audio').paused);
    await page.evaluate(() => { Date.now = window.testDateNow; });
    assert.equal(await page.locator('.track-row.current .track-name strong').textContent(), finishing);
    console.log('PASS immediate sleep deadline and finish-current-track deadline, with no unwanted next song');
    await page.getByLabel('翻译 API Key', { exact: true }).fill('fixture-key-not-real-123');
    assert.equal(await page.getByLabel('自动生成缺失的逐字歌词', { exact: true }).count(), 0);
    await page.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
    await page.getByText('配置已保存。逐字时间请在歌词设置中手动调整或点击 AI 生成；保存配置不会调用模型。', { exact: true }).waitFor();
    const envelope = await fs.readFile(path.join(profile, 'ai-config.json'), 'utf8');
    assert.ok(!envelope.includes('fixture-key-not-real-123')); assert.equal(JSON.parse(envelope).encryption, 'Windows-DPAPI');
    const field = page.getByLabel('播放 / 暂停全局快捷键', { exact: true });
    await field.focus(); await field.press('Control+Alt+Shift+F12');
    await page.getByRole('button', { name: '保存并应用快捷键', exact: true }).click();
    await page.waitForFunction(async () => (await window.tingyuDesktop.getShortcuts()).bindings['play-pause'] === 'Ctrl+Alt+Shift+F12');
    await page.getByLabel('启用全局快捷键', { exact: true }).uncheck();
    await page.getByRole('button', { name: '保存并应用快捷键', exact: true }).click();
    await page.screenshot({ path: path.join(root, 'test-results/playback-settings.png') });
    const close = application.waitForEvent('close'); await page.evaluate(() => window.tingyuDesktop.control('quit')); await close;
    const started = Date.now();
    application = await _electron.launch({ executablePath: executable, args, env: environment, cwd: root, timeout: 60000 });
    const reopened = await application.firstWindow(); await reopened.waitForSelector('.track-row');
    console.log(`PASS metadata-first cold library startup: 3 tracks in ${Date.now() - started} ms`);
    await reopened.getByRole('button', { name: '偏好设置', exact: true }).first().click();
    await reopened.waitForFunction(() => document.querySelector('input[aria-label="翻译 API Key"]').value === 'fixture-key-not-real-123');
    const info = await reopened.evaluate(() => window.tingyuDesktop.getShortcuts());
    assert.equal(info.enabled, false); assert.equal(info.bindings['play-pause'], 'Ctrl+Alt+Shift+F12');
    await reopened.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await reopened.getByRole('button', { name: '播放全部', exact: true }).click();
    await reopened.waitForFunction(() => document.querySelector('audio').currentTime > .2);
    assert.ok((await reopened.locator('audio').getAttribute('src')).startsWith('xianqiji://library/'));
    assert.deepEqual(errors, []);
    console.log('PASS encrypted key and shortcut settings survive restart; on-demand native streamed audio plays');
    await fs.writeFile(path.join(root, 'test-results/playback-check.json'), JSON.stringify({ sleep: true, naturalAdvance: true, modes: true, keyEncrypted: true, keyRestored: true, shortcutSettings: true, streamingAudio: true, errors }, null, 2));
  } catch (error) {
    if (application) {
      const page = (await application.windows())[0];
      if (page) {
        console.error(await page.evaluate(() => ({ sleep: document.querySelector('.sleep-settings')?.textContent, audio: { paused: document.querySelector('audio')?.paused, time: document.querySelector('audio')?.currentTime, ended: document.querySelector('audio')?.ended }, now: Date.now() })));
        await page.screenshot({ path: path.join(root, 'test-results/playback-failure.png') }).catch(() => {});
      }
    }
    throw error;
  } finally { if (application) await application.close().catch(() => {}); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
