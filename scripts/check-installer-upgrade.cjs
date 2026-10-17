// Real electron-builder NSIS install -> legacy updater -> old uninstall ->
// replacement. Unique app ID/GUID and shortcuts disabled: never touches the
// registered player or its library. Payload is a harmless tiny fixture.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore', ...options });
    const timer = setTimeout(() => { child.kill(); reject(Error(`Fixture timed out: ${file}`)); }, 90000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}
async function main() {
  assert.equal(process.platform, 'win32');
  const root = path.resolve(__dirname, '..');
  process.env.ELECTRON_BUILDER_NSIS_DIR ||= path.join(root, '.tools/word-sync-builder/nsis-3.0.4.1');
  process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR ||= path.join(root, '.tools/word-sync-builder/nsis-resources-3.4.1');
  process.env.ELECTRON_BUILDER_7ZIP_PATH ||= path.join(root, '.tools/word-sync-builder/7zip/7zip/bin/7za.exe');
  const directory = await fs.mkdtemp(path.join(root, 'test-results', 'installer-upgrade-'));
  const guid = randomUUID();
  const product = `XqUpgradeFixture-${guid.slice(0, 8)}`;
  const install = path.join(directory, '旧版播放器 with spaces');
  const pollutedTemp = path.join(install, 'Data', 'Temp');
  const updates = path.join(install, 'Data', 'Updates');
  const sentinel = path.join(install, 'Data', 'library-sentinel.txt');
  await fs.mkdir(pollutedTemp, { recursive: true }); await fs.mkdir(updates, { recursive: true });
  await fs.writeFile(sentinel, 'original fixture library and AI config');
  const oldInclude = path.join(directory, 'old.nsh');
  const oldSource = execFileSync('git', ['show', '1b40cba:build/installer.nsh'], { cwd: root, encoding: 'utf8', windowsHide: true });
  await fs.writeFile(oldInclude, '\uFEFF' + oldSource);
  const executable = path.join(install, `${product}.exe`);
  async function pack(version, include) {
    const project = path.join(directory, `project-${version}`);
    const payload = path.join(project, 'payload'); const output = path.join(project, 'output');
    await fs.mkdir(path.join(payload, 'resources'), { recursive: true });
    await fs.writeFile(path.join(payload, 'resources', 'version.txt'), version);
    const fixtureScript = path.join(project, 'app.nsi');
    await fs.writeFile(fixtureScript, `Unicode true\nName "${product}"\nOutFile "${path.join(payload, `${product}.exe`)}"\nRequestExecutionLevel user\nSilentInstall silent\nSection\nSectionEnd\n`);
    execFileSync(path.join(process.env.ELECTRON_BUILDER_NSIS_DIR, 'Bin', 'makensis.exe'), ['/V2', fixtureScript], { windowsHide: true, stdio: 'pipe' });
    const wrapper = path.join(project, 'include.nsh');
    // Explicitly exercise the builder's PowerShell branch. Its availability
    // probe varies with shell policy/module configuration on the test host.
    // The actual FIND_PROCESS/KILL_PROCESS/_CHECK_APP_RUNNING macros are intact.
    await fs.writeFile(wrapper, `\uFEFF!include "${path.join(root, 'node_modules/app-builder-lib/templates/nsis/include/getProcessInfo.nsh')}"\nVar pid\nVar IsPowerShellAvailable\n!macro customCheckAppRunning\nStrCpy $IsPowerShellAvailable 0\n!insertmacro _CHECK_APP_RUNNING\n!macroend\n!include "${include}"\n!macro customInstall\nFileOpen $0 "$INSTDIR\\completed-${version}.txt" w\nFileWrite $0 "complete"\nFileClose $0\n!macroend\n`);
    const config = {
      electronVersion: require('electron/package.json').version,
      appId: `com.xianqiji.installer-test.${guid}`, productName: product,
      directories: { output, buildResources: path.join(root, 'build') },
      win: { signExecutable: false, icon: path.join(root, 'build/icon.ico') },
      nsis: { guid, include: wrapper, oneClick: false, perMachine: false, allowElevation: false,
        allowToChangeInstallationDirectory: false, runAfterFinish: false, deleteAppDataOnUninstall: false,
        createDesktopShortcut: false, createStartMenuShortcut: false,
        installerLanguages: ['zh_CN'], artifactName: `fixture-${version}.exe` },
    };
    await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: product.toLowerCase(), productName: product, version, description: 'Isolated installer regression fixture', main: 'index.js', build: config }));
    assert.equal(await run(process.execPath, [path.join(root, 'node_modules/electron-builder/cli.js'), '--projectDir', project, '--prepackaged', payload, '--win', 'nsis', '--x64'], { stdio: 'inherit' }), 0);
    return path.join(output, `fixture-${version}.exe`);
  }
  const uninstaller = path.join(install, `Uninstall ${product}.exe`);
  try {
  const oldInstaller = await pack('1.0.6', oldInclude);
  const previousInclude = path.join(directory, 'previous.nsh');
  await fs.writeFile(previousInclude, '\uFEFF' + execFileSync('git', ['show', '99867a4:build/installer.nsh'], { cwd: root, encoding: 'utf8', windowsHide: true }));
  const previousInstaller = await pack('1.0.8', previousInclude);
  const fixedInstaller = await pack('1.0.9', path.join(root, 'build', 'installer.nsh'));
  assert.equal(await run(oldInstaller, ['/S', '/currentuser', `/D=${install}`], { windowsVerbatimArguments: true, argv0: `"${oldInstaller}"` }), 0);
  await fs.access(executable);
  assert.equal(await fs.readFile(path.join(install, 'resources', 'version.txt'), 'utf8'), '1.0.6');
  const broken = path.join(updates, 'previous-downloaded-update.exe');
  await fs.copyFile(previousInstaller, broken);
  assert.equal(await run(broken, ['/S', '/currentuser', `/D=${install}`], { cwd: install, env: { ...process.env, TEMP: pollutedTemp, TMP: pollutedTemp } }), 0);
  // The old bootstrap reports success as it hands off; its real installer then
  // kills itself/its old-uninstaller from the inherited in-install temp path.
  await pause(15000);
  assert.equal(await fs.stat(path.join(install, 'completed-1.0.8.txt')).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(install, 'resources', 'version.txt'), 'utf8'), '1.0.6');
  console.log('PASS reproduced v1.0.8 mid-upgrade exit with inherited Data/Temp; old version remains installed');
  const cached = path.join(updates, 'legacy-downloaded-update.exe');
  await fs.copyFile(fixedInstaller, cached);
  // Exact 1.0.6 behavior: normal Node argument quoting, cached executable under
  // Data/Updates, and TEMP/TMP inherited from the running player's Data/Temp.
  assert.equal(await run(cached, ['/S', '/currentuser', `/D=${install}`], { cwd: install, env: { ...process.env, TEMP: pollutedTemp, TMP: pollutedTemp } }), 0);
  let complete = false;
  for (let attempt = 0; attempt < 450; attempt++) {
    complete = !!await fs.stat(path.join(install, 'completed-1.0.9.txt')).catch(() => null);
    if (complete) break;
    await pause(200);
  }
  assert.ok(complete, 'The detached bootstrap must finish the full old-uninstaller and file replacement flow.');
  assert.equal(await fs.readFile(path.join(install, 'resources', 'version.txt'), 'utf8'), '1.0.9');
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'original fixture library and AI config');
  await fs.access(cached);
  const nativeTemp = path.join(directory, 'external-installer-stage');
  await fs.mkdir(nativeTemp);
  const nativeInstaller = path.join(nativeTemp, 'setup.exe'); await fs.copyFile(fixedInstaller, nativeInstaller);
  assert.equal(await run(nativeInstaller, ['/S', '/currentuser', '/XQ_STAGED', `/D=${install}`], { env: { ...process.env, TEMP: nativeTemp, TMP: nativeTemp }, windowsVerbatimArguments: true, argv0: `"${nativeInstaller}"` }), 0);
  assert.equal(await fs.readFile(path.join(install, 'resources', 'version.txt'), 'utf8'), '1.0.9');
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'original fixture library and AI config');
  assert.equal(await run(uninstaller, ['/S', '/currentuser', `_?=${install}`], { windowsVerbatimArguments: true, argv0: `"${uninstaller}"` }), 0);
  for (let attempt = 0; attempt < 100 && await fs.stat(executable).catch(() => null); attempt++) await pause(100);
  assert.equal(await fs.stat(executable).catch(() => null), null);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'original fixture library and AI config');
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ guid, product, install, installed: true, legacyUpgrade: true, uninstalled: true, dataPreserved: true }, null, 2));
  console.log('PASS full isolated electron-builder NSIS lifecycle: 1.0.6 install, old-client update with TEMP/TMP inside Data, old uninstall, 1.0.9 replacement, final uninstall, Unicode/spaced path, Data and original cached update preserved');
  } finally {
    // Only this run's random-GUID fixture can be removed, even after a failure.
    assert.ok(path.relative(path.join(root, 'test-results'), install).startsWith('installer-upgrade-'));
    if (await fs.stat(uninstaller).catch(() => null)) {
      assert.equal(await run(uninstaller, ['/S', '/currentuser', `_?=${install}`], { windowsVerbatimArguments: true, argv0: `"${uninstaller}"` }), 0);
    }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
