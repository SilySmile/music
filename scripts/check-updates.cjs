const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const { generateKeyPairSync, sign, createHash } = require('node:crypto');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..'); const profile = path.join(root, 'test-results', `update-ui-${Date.now()}`);
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const size = 12 * 1024 * 1024 + 1; const bytes = Buffer.alloc(size, 41); const sha256 = createHash('sha256').update(bytes).digest('hex');
  const currentVersion = require('../package.json').version; const parts = currentVersion.split('.').map(Number); const version = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  const payload = Buffer.from(JSON.stringify({ product: 'xianqiji', schema: 1, version, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), notes: '测试清单，不会运行安装程序。', artifacts: { 'win-x64': { kind: 'nsis', file: `releases/v${version}/Fixture.exe`, size, sha256 } } }));
  const envelope = JSON.stringify({ algorithm: 'RSA-SHA256', payload: payload.toString('base64'), signature: sign('sha256', payload, keys.privateKey).toString('base64') });
  const env = { ...process.env, TINGYU_TEST: '1', TINGYU_TEST_DATA: profile, TINGYU_UPDATE_TEST_PUBLIC_KEY: Buffer.from(keys.publicKey).toString('base64') }; delete env.ELECTRON_RUN_AS_NODE;
  const executable = process.env.TINGYU_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'); const args = process.env.TINGYU_EXECUTABLE ? [] : [root];
  let application;
  async function launch() {
    application = await _electron.launch({ executablePath: executable, args, env, cwd: root, timeout: 60000 });
    await application.evaluate(({ net }, fixture) => {
      globalThis.updateRanges = []; globalThis.updateTampered = false;
      const original = net.fetch.bind(net);
      net.fetch = async (url, options = {}) => {
        if (new URL(url).hostname !== 'updates.example.test') return original(url, options);
        if (new URL(url).pathname.endsWith('manifest.json')) {
          const value = globalThis.updateTampered ? { ...JSON.parse(fixture.envelope), signature: 'AAAA' } : JSON.parse(fixture.envelope);
          return new Response(JSON.stringify(value));
        }
        const range = new Headers(options.headers).get('range'); globalThis.updateRanges.push(range);
        let offset = range ? Number(range.match(/\d+/)[0]) : 0; const start = offset;
        const stream = new ReadableStream({ async pull(controller) { await new Promise((resolve) => setTimeout(resolve, 150)); if (offset >= fixture.size) { controller.close(); return; } const length = Math.min(4 * 1024 * 1024, fixture.size - offset); controller.enqueue(new Uint8Array(length).fill(41)); offset += length; } });
        return new Response(stream, { status: range ? 206 : 200, headers: range ? { 'Content-Range': `bytes ${start}-${fixture.size - 1}/${fixture.size}` } : {} });
      };
    }, { envelope, size });
    const page = await application.firstWindow(); page.setDefaultTimeout(12000);
    await page.waitForSelector('.empty-state'); await page.getByRole('button', { name: '偏好设置', exact: true }).first().click();
    await page.getByLabel('更新服务器地址', { exact: true }).waitFor(); return page;
  }
  try {
    let page = await launch();
    await page.getByLabel('更新服务器地址', { exact: true }).fill('updates.example.test'); await page.getByRole('button', { name: '保存更新地址', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="更新服务器地址"]').value === 'https://updates.example.test/music-updates/');
    await application.evaluate(() => { globalThis.updateTampered = true; });
    await page.getByRole('button', { name: '检查更新', exact: true }).click(); await page.getByText('更新清单签名校验失败，拒绝下载或安装', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '下载更新', exact: true }).count(), 0);
    await application.evaluate(() => { globalThis.updateTampered = false; });
    await page.getByRole('button', { name: '检查更新', exact: true }).click(); await page.getByRole('button', { name: '下载更新', exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector('progress[aria-label="更新下载进度"]')?.value) >= 4 * 1024 * 1024);
    await page.getByRole('button', { name: '暂停下载', exact: true }).click(); await page.getByRole('button', { name: '继续下载更新', exact: true }).waitFor();
    const partial = path.join(profile, 'Updates', `${sha256}.exe.part`); const checkpoint = (await fs.stat(partial)).size; assert.ok(checkpoint > 0 && checkpoint < size);
    const exit = application.waitForEvent('close'); await page.evaluate(() => window.tingyuDesktop.control('quit')); await exit; application = null;
    page = await launch(); assert.equal(await page.getByLabel('更新服务器地址', { exact: true }).inputValue(), 'https://updates.example.test/music-updates/');
    await page.getByRole('button', { name: '检查更新', exact: true }).click(); await page.getByRole('button', { name: '继续下载更新', exact: true }).click();
    await page.getByRole('button', { name: '退出并安装更新', exact: true }).waitFor();
    assert.equal(await application.evaluate(() => globalThis.updateRanges[0]), `bytes=${checkpoint}-`);
    await page.getByRole('button', { name: '退出并安装更新', exact: true }).click(); await page.getByRole('button', { name: '确认安装更新', exact: true }).click();
    await page.getByText('测试模式已校验安装包，未执行安装。', { exact: true }).waitFor();
    const target = path.join(profile, 'Updates', `${sha256}.exe`); await fs.appendFile(target, 'tampered');
    await page.getByRole('button', { name: '退出并安装更新', exact: true }).click(); await page.getByRole('button', { name: '确认安装更新', exact: true }).click();
    await page.getByText(/安装包已改变，拒绝运行，请重新下载/).waitFor();
    await page.getByRole('button', { name: '暂不安装', exact: true }).click();
    await page.screenshot({ path: path.join(root, 'test-results/update-settings.png') });
    console.log('PASS actual update settings: custom domain persistence, tampered signature rejection, paused download, restart + HTTP Range resume, re-verification before installation');
    await fs.writeFile(path.join(root, 'test-results/update-check.json'), JSON.stringify({ customDomain: true, signatureVerified: true, restartResume: true, rangeOffset: checkpoint, installVerified: true, tamperedFileBlocked: true, installerExecuted: false }, null, 2));
  } finally { if (application) await application.close().catch(() => {}); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
