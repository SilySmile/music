const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { createInterface } = require('node:readline/promises');
const { compareVersions, assertSource, checksum, artifactNames, assertBuildDirectory, verifyPrepared } = require('./release-tools.cjs');
const { createGitHub } = require('./github-release.cjs');
const { verifyEnvelope, artifactUrl } = require('../updates/protocol.cjs');

const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const trust = require('../updates/public.json');
const directory = path.join(root, 'release', `v${version}`);
const stateFile = path.join(directory, 'publish-state.json');
const environment = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.TINGYU_EXECUTABLE;
delete environment.TINGYU_TEST_DATA;

function git(args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...environment, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function run(executable, args = []) {
  return new Promise((resolve, reject) => {
    let command = executable; let argumentsList = args;
    const batch = process.platform === 'win32' && /\.(bat|cmd)$/i.test(command);
    if (batch) {
      if ([command, ...args].some((value) => /["%\r\n&|<>^!]/.test(value))) return reject(new Error('批处理工具路径包含不支持的字符。'));
      argumentsList = ['/d', '/s', '/c', `"${[command, ...args].map((value) => `"${value}"`).join(' ')}"`];
      command = process.env.ComSpec || 'cmd.exe';
    }
    const child = spawn(command, argumentsList, { cwd: root, env: environment, windowsHide: true, windowsVerbatimArguments: batch, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`步骤失败：${path.basename(executable)}（退出码 ${code}），已停止后续发布。`)));
  });
}
function node(script, args = []) { return run(process.execPath, [path.join(root, script), ...args]); }
function findDirectory(parent, prefix) {
  if (!fs.existsSync(parent)) return '';
  const entries = fs.readdirSync(parent, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix));
  if (entries.length !== 1) return '';
  return path.join(parent, entries[0].name);
}
function tools() {
  environment.JAVA_HOME ||= findDirectory(path.join(root, '.tools/jdk'), '');
  environment.ANDROID_HOME ||= environment.ANDROID_SDK_ROOT || path.join(root, '.tools/android-sdk');
  const gradleHome = environment.GRADLE_HOME || findDirectory(path.join(root, '.tools/gradle'), 'gradle-');
  const gradle = gradleHome ? path.join(gradleHome, 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle') : path.join(root, 'android', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  const runtime = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies');
  environment.PYTHON_EXE ||= fs.existsSync(path.join(runtime, 'python/python.exe')) ? path.join(runtime, 'python/python.exe') : 'python';
  environment.PLAYWRIGHT_MODULE ||= fs.existsSync(path.join(runtime, 'node/node_modules/playwright')) ? path.join(runtime, 'node/node_modules/playwright') : 'playwright';
  environment.PLAYWRIGHT_CHANNEL ||= 'msedge';
  return { gradle, java: path.join(environment.JAVA_HOME || 'missing', 'bin', process.platform === 'win32' ? 'java.exe' : 'java') };
}
function localCheck() {
  compareVersions(version, version);
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 22 || nodeMajor === 22 && nodeMinor < 12) throw new Error('请使用 Node.js 22.12+。');
  const android = fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8');
  if (android.match(/versionName\s+"([^"]+)"/)?.[1] !== version) throw new Error('安卓 versionName 与 package.json 不一致。');
  const androidCode = Number(android.match(/versionCode\s+(\d+)/)?.[1]);
  if (!Number.isSafeInteger(androidCode) || androidCode < 1) throw new Error('安卓 versionCode 无效。');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  if (lock.version !== version || lock.packages[''].version !== version) throw new Error('package-lock.json 版本未同步。');
  const runtime = tools();
  for (const name of ['node_modules/vitest/vitest.mjs', 'node_modules/typescript/bin/tsc', 'node_modules/vite/bin/vite.js', 'node_modules/@capacitor/cli/bin/capacitor', 'node_modules/electron-builder/cli.js', 'node_modules/electron/dist/electron.exe', '.release-keys/android-release.p12', '.release-keys/android-keystore-password.txt', '.release-keys/update-signing-private.pem', '.release-keys/publisher.json', '.release-keys/publisher_ed25519', '.release-keys/known_hosts']) fs.accessSync(path.join(root, name));
  fs.accessSync(runtime.java); fs.accessSync(runtime.gradle); fs.accessSync(path.join(environment.ANDROID_HOME, 'build-tools'));
  require(environment.PLAYWRIGHT_MODULE);
  const remote = git(['remote', 'get-url', 'origin']);
  if (remote !== 'https://github.com/SilySmile/music.git') throw new Error('origin 不是预期 GitHub 仓库，拒绝发布。');
  console.log(`本机工具与版本检查通过：v${version}，Android versionCode ${androidCode}`);
  const status = git(['status', '--porcelain', '--untracked-files=all']);
  if (status) console.log('提示：工作区尚有未提交改动；正式发布会阻止，检查模式不会自动提交。');
  if (!fs.existsSync(path.join(directory, 'update-notes.txt'))) console.log(fs.existsSync(path.join(root, 'docs/releases', `v${version}.md`)) ? `将使用已提交的更新说明：docs/releases/v${version}.md` : `提示：发布前填写 ${path.join(directory, 'update-notes.txt')}`);
  return { runtime, androidCode, status, commit: git(['rev-parse', 'HEAD']) };
}
async function onlineManifest() {
  const response = await fetch(new URL('manifest.json', trust.defaultBaseUrl), { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`更新服务器预检查失败 HTTP ${response.status}`);
  const text = await response.text();
  return { text, payload: verifyEnvelope(text, trust.publicKey) };
}
async function remoteCheck(commit, resume) {
  assertSource(commit, git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0], git(['status', '--porcelain', '--untracked-files=all']));
  const current = await onlineManifest();
  const comparison = compareVersions(version, current.payload.version);
  if (comparison < 0 || (comparison === 0 && !resume)) throw new Error(`线上已有 v${current.payload.version}；请提高版本号。同版本只允许 --resume 续发原始文件。`);
  if (comparison === 0 && fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8') !== current.text) throw new Error('线上同版本签名清单不同，拒绝覆盖。');
  const publisher = JSON.parse(fs.readFileSync(path.join(root, '.release-keys/publisher.json'), 'utf8'));
  if (!/^[a-z0-9.-]+$/i.test(publisher.host) || !/^[a-z0-9_-]+$/i.test(publisher.user)) throw new Error('SSH 发布配置无效。');
  await run('ssh', ['-i', path.join(root, '.release-keys/publisher_ed25519'), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', `UserKnownHostsFile=${path.join(root, '.release-keys/known_hosts')}`, `${publisher.user}@${publisher.host}`, 'status']);
  const github = createGitHub(root, 'SilySmile/music', commit, version);
  const existing = await github.preflight();
  if (existing && !resume) throw new Error('GitHub 已有同版本 Release；只能用 --resume 校验并续发原始文件，不能重新打包。');
  const previousCode = await github.androidCode(current.payload.version);
  const androidCode = Number(fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8').match(/versionCode\s+(\d+)/)?.[1]);
  if (comparison > 0 && androidCode <= previousCode) throw new Error('安卓 versionCode 没有高于线上版本，不能覆盖安装，请先递增。');
  return github;
}
async function build(runtime, commit) {
  assertBuildDirectory(root, directory);
  if (fs.existsSync(stateFile)) throw new Error('当前版本已有发布检查点，请 --resume 续发；更改源码请提高版本，不重新覆盖原始包。');
  const notesFile = path.join(directory, 'update-notes.txt');
  const notes = fs.readFileSync(fs.existsSync(notesFile) ? notesFile : path.join(root, 'docs/releases', `v${version}.md`), 'utf8');
  if (!notes.trim() || notes.length > 12000) throw new Error('请先填写 update-notes.txt（1–12000 字符）。');
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(notesFile)) fs.writeFileSync(notesFile, notes, { flag: 'wx' });
  await node('node_modules/vitest/vitest.mjs', ['run']);
  await node('scripts/check-release-pipeline.cjs');
  await run(environment.PYTHON_EXE, ['deployment/test-library-server.py']);
  await node('scripts/sync-update-trust.cjs');
  await node('scripts/make-icon.mjs');
  await node('node_modules/typescript/bin/tsc', ['-b']);
  await node('node_modules/vite/bin/vite.js', ['build']);
  await node('node_modules/@capacitor/cli/bin/capacitor', ['sync', 'android']);
  await run(runtime.gradle, ['-p', 'android', 'assembleRelease', 'testReleaseUnitTest', '--no-daemon', '-Dorg.gradle.vfs.watch=false']);
  await node('scripts/sign-android-release.cjs');
  await node('scripts/package-library-server.cjs');
  assertBuildDirectory(root, directory);
  await node('node_modules/electron-builder/cli.js', ['--win', 'nsis', 'portable', '--x64', '--config.electronDist=node_modules/electron/dist', `--config.directories.output=release/v${version}`]);
  environment.TINGYU_EXECUTABLE = path.join(directory, 'win-unpacked', '弦栖霁.exe');
  for (const script of ['smoke', 'check-playback', 'check-updates', 'check-online-source', 'check-auto-source', 'check-android-storage-ui', 'check-portable']) await node(`scripts/${script}.cjs`);
  assertSource(commit, git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0], git(['status', '--porcelain', '--untracked-files=all']));
  if (git(['rev-parse', 'HEAD']) !== commit) throw new Error('打包过程中源码提交变化，未创建发布检查点。');
  await node('scripts/create-update-release.cjs');
  fs.copyFileSync(path.join(root, '.release-staging', `v${version}`, 'manifest.json'), path.join(directory, 'manifest.json'));
  const lines = [];
  for (const name of [...artifactNames(version), `Xianqiji-library-server-${version}.tar.gz`]) lines.push(`${await checksum(path.join(directory, name))}  ${name}`);
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
  await node('scripts/verify-release.cjs');
  const state = { schema: 1, version, commit, androidTested: true, preparedAt: new Date().toISOString(), stage: 'prepared', manifestSha256: await checksum(path.join(directory, 'manifest.json')), notesSha256: await checksum(path.join(directory, 'update-notes.txt')), serverBundleSha256: await checksum(path.join(directory, `Xianqiji-library-server-${version}.tar.gz`)), archiveSha256: await checksum(path.join(root, '.release-staging', `Xianqiji-update-${version}.tar`)) };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { flag: 'wx' });
}
async function verifyServer(prepared) {
  const current = await onlineManifest();
  if (current.text !== fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')) throw new Error('线上签名清单与本次文件不同。');
  for (const file of prepared.files.slice(0, 3)) {
    const artifact = Object.values(current.payload.artifacts).find((value) => path.basename(value.file) === file.name);
    const response = await fetch(artifactUrl(trust.defaultBaseUrl, artifact), { redirect: 'error', signal: AbortSignal.timeout(30 * 60000) });
    if (!response.ok) throw new Error(`线上安装包回读失败：${file.name}`);
    const digest = require('node:crypto').createHash('sha256'); let size = 0;
    for await (const bytes of response.body) { digest.update(bytes); size += bytes.length; }
    if (size !== file.size || digest.digest('hex') !== file.sha256) throw new Error(`线上安装包完整 SHA-256 不符：${file.name}`);
    console.log(`更新服务器完整回读通过：${file.name}`);
  }
  await node('scripts/check-published-updates.cjs');
}
async function main() {
  const args = process.argv.slice(2);
  if (args.some((argument) => !['--check', '--prepare', '--publish', '--resume', '--interactive'].includes(argument))) throw new Error('参数：--check（离线检查）、--prepare（只打包）、--publish（打包并发布）、--resume（续发），可配 --interactive。');
  const modes = args.filter((argument) => ['--check', '--prepare', '--publish', '--resume'].includes(argument));
  if (modes.length > 1) throw new Error('一次只能选择一种模式。');
  const mode = modes[0] || '--check';
  const local = localCheck();
  if (mode === '--check') { console.log('仅完成离线预检查，没有构建、提交、上传或发布。'); return; }
  assertSource(local.commit, local.commit, local.status);
  if (args.includes('--interactive')) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const expected = mode === '--prepare' ? `BUILD ${version}` : `PUBLISH ${version}`;
      const answer = await prompt.question(`目标：SilySmile/music + ${trust.defaultBaseUrl}\n${mode === '--prepare' ? '仅构建本地包，不公开。' : '将公开发布 PC/APK，不上传音乐库或本机配置。'}\n请输入 ${expected} 确认，其他输入取消：`);
      if (answer.trim() !== expected) { console.log('已取消，未发布。'); return; }
    } finally { prompt.close(); }
  }
  fs.mkdirSync(path.join(root, '.release-staging'), { recursive: true });
  const lock = path.join(root, '.release-staging/publish.lock');
  const handle = fs.openSync(lock, 'wx');
  fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, version, startedAt: new Date().toISOString() }));
  try {
    const github = await remoteCheck(local.commit, mode === '--resume');
    if (mode !== '--resume') await build(local.runtime, local.commit);
    const prepared = await verifyPrepared(root, version, local.commit, trust.publicKey);
    const archive = path.join(root, '.release-staging', `Xianqiji-update-${version}.tar`);
    if (await checksum(archive) !== prepared.state.archiveSha256) throw new Error('发布 TAR 已变化，拒绝上传。');
    const record = (stage, extra = {}) => { Object.assign(prepared.state, { stage, ...extra, updatedAt: new Date().toISOString() }); fs.writeFileSync(stateFile, JSON.stringify(prepared.state, null, 2)); };
    if (mode === '--prepare') { console.log(`本地包已验证。手机实测后运行 npm run publish:resume 续发，不会重新打包。\n${directory}`); return; }
    await github.stage(prepared); record('github-draft-verified');
    assertSource(local.commit, git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0], git(['status', '--porcelain', '--untracked-files=all']));
    const current = await onlineManifest();
    if (compareVersions(current.payload.version, version) > 0) throw new Error('线上已有更新版本，停止，禁止回退。');
    if (current.payload.version === version && current.text !== fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')) throw new Error('线上同版本清单发生变化，禁止替换。');
    if (current.text !== fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')) await node('scripts/publish-update.cjs');
    record('server-published');
    await verifyServer(prepared); record('server-verified');
    const url = await github.finalize(prepared); record('complete', { githubUrl: url });
    console.log(`发布完成：v${version}\n${url}\n${trust.defaultBaseUrl}`);
  } finally { fs.closeSync(handle); fs.unlinkSync(lock); }
}

if (require.main === module) main().catch((error) => { console.error(`发布停止：${error.message}\n有 publish-state.json 时使用 npm run publish:resume；不要重新打包同版本。日志和检查点不含密钥。`); process.exitCode = 1; });

module.exports = { run };
