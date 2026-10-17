const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { assertBuildDirectory } = require('./release-tools.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const source = require('../package.json');
  const output = path.join(root, 'release', `v${source.version}`);
  assertBuildDirectory(root, output);
  const parent = path.join(root, '.release-staging');
  fs.mkdirSync(parent, { recursive: true });
  const project = fs.mkdtempSync(path.join(parent, `desktop-${source.version}-`));
  // Vite bundles renderer dependencies; Electron code uses only built-ins and
  // relative modules. Stage just the runtime so builder never scans dev modules.
  for (const name of ['dist', 'electron']) fs.cpSync(path.join(root, name), path.join(project, name), { recursive: true });
  fs.mkdirSync(path.join(project, 'updates'));
  for (const name of ['public.json', 'protocol.cjs']) fs.copyFileSync(path.join(root, 'updates', name), path.join(project, 'updates', name));
  const config = structuredClone(source.build);
  config.directories = { ...config.directories, output, buildResources: path.join(root, 'build') };
  config.win.icon = path.join(root, config.win.icon);
  config.nsis.include = path.join(root, config.nsis.include);
  config.electronDist = path.join(root, 'node_modules/electron/dist');
  config.electronVersion = require('electron/package.json').version;
  config.npmRebuild = false;
  const pkg = Object.fromEntries(['name', 'productName', 'version', 'type', 'description', 'main'].map((key) => [key, source[key]]));
  pkg.build = config;
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(project, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': { name: pkg.name, version: pkg.version } } }));
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'node_modules/electron-builder/cli.js'), '--projectDir', project, '--win', 'nsis', 'portable', '--x64'], { cwd: root, env: process.env, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`桌面打包失败（退出码 ${code}）`)));
  });
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
