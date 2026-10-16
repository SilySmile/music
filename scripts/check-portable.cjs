const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..');
  const version = require('../package.json').version;
  const executable = path.join(root, `release/v${version}/Xianqiji-${version}-x64.exe`);
  const endpoint = 'http://127.0.0.1:9226/json/version';
  if (await fetch(endpoint).then(() => true, () => false)) throw new Error('测试端口 9226 已占用');
  const environment = { ...process.env, TINGYU_TEST: '1', TINGYU_TEST_DATA: path.join(root, 'test-results', `portable-${Date.now()}`) };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, ['--remote-debugging-port=9226'], { env: environment, windowsHide: true });
  let browser;
  let page;
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error(`便携启动器提前退出：${child.exitCode}`);
      if (await fetch(endpoint).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    browser = await chromium.connectOverCDP('http://127.0.0.1:9226');
    page = browser.contexts()[0].pages().find((window) => !window.url().endsWith('#desktop-lyrics'));
    await page.waitForSelector('.empty-state');
    assert.ok((await page.title()).includes('弦栖霁'));
    assert.equal((await page.evaluate(() => window.tingyuDesktop.getState())).verticalContent, 'auto');
    let library;
    const deadline = Date.now() + 15000;
    do {
      library = await page.evaluate(() => window.tingyuDesktop.getLibraryInfo());
      if (library.legacyMigrated) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.equal(library.legacyMigrated, true, JSON.stringify({ library, notices: await page.locator('.toast').allTextContents() }));
    assert.equal(library.path, path.join(environment.TINGYU_TEST_DATA, '音乐库'));
    assert.equal(JSON.parse(await fs.readFile(path.join(library.path, 'library.json'), 'utf8')).format, 'xianqiji-library-folder');
    const end = page.url().indexOf('/app.asar/');
    assert.ok(end > 0);
    const extracted = fileURLToPath(page.url().slice(0, end + '/app.asar'.length));
    const source = path.join(root, `release/v${version}/win-unpacked/resources/app.asar`);
    const digest = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
    assert.equal(await digest(extracted), await digest(source));
    const exited = new Promise((resolve) => child.once('exit', resolve));
    await page.evaluate(() => window.tingyuDesktop.control('quit'));
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('便携程序未正常退出')), 10000))]);
    console.log(`PASS portable v${version} startup, exact tested payload and clean exit`);
  } finally {
    if (page && !page.isClosed()) {
      const closed = page.waitForEvent('close', { timeout: 5000 }).catch(() => {});
      await page.evaluate(() => window.tingyuDesktop.control('quit')).catch(() => {});
      await closed;
    }
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null) child.kill();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
