const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => reject(new Error(`Installer timeout: ${executable}`)), 180000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Installer exit ${code}`)); });
  });
}
async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = path.join(root, 'test-results', `installed-${Date.now()}`, 'Custom Music Folder');
  const version = require('../package.json').version;
  const installer = path.join(root, `release/v${version}/Xianqiji-Setup-${version}-x64.exe`);
  const profile = path.join(directory, 'Data');
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, '保留数据.txt'), 'install-upgrade-uninstall-safe');
  await fs.mkdir(path.join(directory, '用户备份'), { recursive: true });
  await fs.writeFile(path.join(directory, '用户备份', 'keep.txt'), 'backup-safe');
  await run(installer, ['/S', '/currentuser', `/D=${directory}`]);
  const executable = path.join(directory, '弦栖霁.exe');
  await fs.access(executable);
  const env = { ...process.env, TINGYU_TEST: '1' }; delete env.TINGYU_TEST_DATA; delete env.ELECTRON_RUN_AS_NODE;
  let application;
  try {
    application = await _electron.launch({ executablePath: executable, args: [], env, cwd: directory, timeout: 60000 });
    const page = await application.firstWindow();
    await page.waitForSelector('.empty-state');
    const paths = await application.evaluate(({ app }) => Object.fromEntries(['userData', 'sessionData', 'temp', 'crashDumps', 'logs', 'downloads'].map((name) => [name, app.getPath(name)])));
    for (const value of Object.values(paths)) assert.ok(value === profile || value.startsWith(`${profile}${path.sep}`), value);
    assert.equal((await page.evaluate(() => window.tingyuDesktop.getLibraryInfo())).path, path.join(profile, '音乐库'));
    const close = application.waitForEvent('close'); await page.evaluate(() => window.tingyuDesktop.control('quit')); await close; application = null;
    console.log('PASS real NSIS installation to selected exact custom path, all Electron data paths under install/Data');
    await run(installer, ['/S', '/currentuser', `/D=${directory}`]);
    assert.equal(await fs.readFile(path.join(profile, '保留数据.txt'), 'utf8'), 'install-upgrade-uninstall-safe');
    await fs.access(path.join(profile, '音乐库', 'library.json'));
    const uninstaller = (await fs.readdir(directory)).find((name) => /^Uninstall.*\.exe$/i.test(name));
    assert.ok(uninstaller);
    await run(path.join(directory, uninstaller), ['/S', `_?=${directory}`]);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!(await fs.stat(executable).catch(() => null))) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(await fs.stat(executable).catch(() => null), null);
    assert.equal(await fs.readFile(path.join(profile, '保留数据.txt'), 'utf8'), 'install-upgrade-uninstall-safe');
    assert.equal(await fs.readFile(path.join(directory, '用户备份', 'keep.txt'), 'utf8'), 'backup-safe');
    await fs.access(path.join(profile, '音乐库', 'library.json'));
    console.log('PASS real reinstall upgrade and uninstall preserve Data, library and user backup folder');
    await fs.writeFile(path.join(root, 'test-results/installer-check.json'), JSON.stringify({ directory, paths, installed: true, upgraded: true, uninstalled: true, dataPreserved: true }, null, 2));
  } finally { if (application) await application.close().catch(() => {}); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
