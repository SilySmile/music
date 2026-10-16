const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { compareVersions, assertSource, artifactNames, assertBuildDirectory, checksum, verifyPrepared } = require('./release-tools.cjs');

async function checkPrepared() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xianqiji-publish-test-'));
  try {
    const version = '2.0.0'; const commit = 'a'.repeat(40);
    const directory = path.join(root, 'release', `v${version}`);
    fs.mkdirSync(directory, { recursive: true });
    assert.doesNotThrow(() => assertBuildDirectory(root, directory));
    assert.throws(() => assertBuildDirectory(root, path.join(root, 'unrelated')), /越界/);
    const data = path.join(directory, 'win-unpacked', 'Data');
    fs.mkdirSync(data, { recursive: true });
    assert.throws(() => assertBuildDirectory(root, directory), /用户库/);
    fs.rmdirSync(data);
    fs.writeFileSync(path.join(directory, 'win-unpacked', 'song.flac'), 'fixture');
    assert.throws(() => assertBuildDirectory(root, directory), /用户库/);
    fs.unlinkSync(path.join(directory, 'win-unpacked', 'song.flac'));
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const artifacts = {};
    const names = artifactNames(version);
    const notes = 'Release test only, no production credentials.';
    const lines = [];
    for (const [index, name] of names.entries()) {
      const filename = path.join(directory, name);
      fs.writeFileSync(filename, `fixture-${index}`);
      const digest = await checksum(filename);
      artifacts[['win-x64', 'win-x64-portable', 'android'][index]] = { kind: ['nsis', 'portable', 'apk'][index], file: `releases/v${version}/${name}`, size: fs.statSync(filename).size, sha256: digest };
      lines.push(`${digest}  ${name}`);
    }
    const payload = Buffer.from(JSON.stringify({ schema: 1, product: 'xianqiji', version, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), notes, artifacts }));
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ algorithm: 'RSA-SHA256', payload: payload.toString('base64'), signature: crypto.sign('sha256', payload, keys.privateKey).toString('base64') }));
    fs.writeFileSync(path.join(directory, 'update-notes.txt'), notes);
    fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
    const state = { schema: 1, version, commit, androidTested: true, notesSha256: await checksum(path.join(directory, 'update-notes.txt')), manifestSha256: await checksum(path.join(directory, 'manifest.json')) };
    const stateFile = path.join(directory, 'publish-state.json');
    fs.writeFileSync(stateFile, JSON.stringify(state));
    assert.equal((await verifyPrepared(root, version, commit, keys.publicKey)).files.length, 6);
    const bundle = path.join(directory, `Xianqiji-library-server-${version}.tar.gz`);
    fs.writeFileSync(bundle, 'fixture-server');
    const bundleHash = await checksum(bundle);
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, serverBundleSha256: bundleHash }));
    fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n${bundleHash}  ${path.basename(bundle)}\n`);
    assert.equal((await verifyPrepared(root, version, commit, keys.publicKey)).files.length, 7);
    fs.appendFileSync(bundle, 'tampered');
    await assert.rejects(verifyPrepared(root, version, commit, keys.publicKey), /部署包/);
    fs.writeFileSync(stateFile, JSON.stringify(state));
    fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
    await assert.rejects(verifyPrepared(root, version, 'b'.repeat(40), keys.publicKey), /当前源码/);
    const first = path.join(directory, names[0]);
    fs.writeFileSync(first, 'fixture-x');
    await assert.rejects(verifyPrepared(root, version, commit, keys.publicKey), /安装包/);
    fs.writeFileSync(first, 'fixture-0');
    fs.appendFileSync(path.join(directory, 'SHA256SUMS.txt'), 'tampered');
    await assert.rejects(verifyPrepared(root, version, commit, keys.publicKey), /SHA256SUMS/);
    fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
    fs.writeFileSync(path.join(directory, 'update-notes.txt'), 'tampered');
    await assert.rejects(verifyPrepared(root, version, commit, keys.publicKey), /更新说明/);
    fs.writeFileSync(path.join(directory, 'update-notes.txt'), notes);
    fs.appendFileSync(path.join(directory, 'manifest.json'), ' ');
    await assert.rejects(verifyPrepared(root, version, commit, keys.publicKey), /清单已变化/);
    console.log('PASS prepared checkpoint: source, signature, packages, notes, SHA256SUMS tamper protection');
  } finally {
    const absolute = fs.realpathSync(root);
    assert.equal(path.dirname(absolute).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(absolute).startsWith('xianqiji-publish-test-'));
    fs.rmSync(absolute, { recursive: true });
  }
}

async function checkGitHub() {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawnSync;
  const originalFetch = globalThis.fetch;
  const requests = [];
  const commit = 'a'.repeat(40); const content = Buffer.from('test artifact');
  const file = { name: 'fixture.txt', filename: __filename, size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') };
  let release = null; let mismatchTag = false; let mismatchAsset = false; let newerLatest = false;
  childProcess.spawnSync = () => ({ status: 0, stdout: 'username=fixture\npassword=test-only-never-production\n' });
  globalThis.fetch = async (url, options) => {
    const target = new URL(url); const method = options.method || 'GET';
    assert.equal(target.protocol, 'https:');
    assert.ok(['api.github.com', 'uploads.github.com'].includes(target.hostname));
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-only-never-production');
    requests.push({ method, path: target.pathname });
    let value;
    if (target.pathname.endsWith('/releases/latest')) {
      if (!newerLatest) return { status: 404, ok: false };
      value = { tag_name: 'v3.0.0' };
    } else if (target.pathname.endsWith('/git/ref/tags/v2.0.0')) {
      if (!mismatchTag) return { status: 404, ok: false };
      value = { object: { type: 'commit', sha: 'b'.repeat(40) } };
    } else if (target.pathname.endsWith('/releases/tags/v2.0.0')) {
      if (!release) return { status: 404, ok: false };
      value = structuredClone(release);
      if (mismatchAsset) value.assets[0].digest = `sha256:${'0'.repeat(64)}`;
    } else if (method === 'POST' && target.hostname === 'uploads.github.com') {
      assert.equal(options.headers['Content-Length'], String(file.size));
      value = { id: 7, name: file.name, size: file.size, state: 'uploaded', digest: `sha256:${file.sha256}` };
      release.assets.push(value);
      await options.body.cancel();
    } else if (method === 'POST') {
      const data = JSON.parse(options.body); assert.equal(data.draft, true); assert.equal(data.target_commitish, commit);
      release = { id: 1, target_commitish: commit, draft: true, prerelease: false, assets: [], upload_url: 'https://uploads.github.com/repos/SilySmile/music/releases/1/assets{?name}', html_url: 'https://github.com/SilySmile/music/releases/tag/v2.0.0' };
      value = release;
    } else if (method === 'PATCH') {
      assert.equal(JSON.parse(options.body).draft, false); release.draft = false; value = release;
    } else if (target.pathname.includes('/contents/')) {
      value = { encoding: 'base64', content: Buffer.from('versionCode 17').toString('base64') };
    } else value = { permissions: { push: true } };
    return { status: 200, ok: true, json: async () => structuredClone(value) };
  };
  const modulePath = require.resolve('./github-release.cjs');
  delete require.cache[modulePath];
  try {
    const github = require('./github-release.cjs').createGitHub(process.cwd(), 'SilySmile/music', commit, '2.0.0');
    const prepared = { directory: path.join(__dirname, '..'), files: [file] };
    const originalRead = fs.readFileSync;
    fs.readFileSync = (filename, ...args) => String(filename).endsWith('/update-notes.txt') ? 'fixture notes' : originalRead(filename, ...args);
    try {
      await github.preflight();
      assert.equal(requests.filter((request) => request.method !== 'GET').length, 0);
      await github.stage(prepared); assert.equal(release.draft, true);
      const uploads = requests.filter((request) => request.method === 'POST').length;
      await github.stage(prepared); assert.equal(requests.filter((request) => request.method === 'POST').length, uploads);
      mismatchAsset = true;
      await assert.rejects(github.stage(prepared), /校验不符/); assert.equal(release.draft, true);
      mismatchAsset = false;
      assert.match(await github.finalize(prepared), /github.com/); assert.equal(release.draft, false);
      mismatchTag = true;
      await assert.rejects(github.preflight(), /其他提交/);
      mismatchTag = false;
      newerLatest = true;
      await assert.rejects(github.preflight(), /禁止回退/);
      newerLatest = false;
      release.target_commitish = 'b'.repeat(40);
      await assert.rejects(github.preflight(), /不属于当前/);
      assert.equal(await github.androidCode('1.0.0'), 17);
      console.log('PASS GitHub mocked API: read-only preflight, draft-first, asset reuse, mismatch refusal, final publication, tag/commit checks');
    } finally { fs.readFileSync = originalRead; }
  } finally { childProcess.spawnSync = originalSpawn; globalThis.fetch = originalFetch; delete require.cache[modulePath]; }
}

function checkWindowsLauncher() {
  const { spawnSync } = require('node:child_process');
  const root = path.resolve(__dirname, '..');
  const batch = fs.readFileSync(path.join(root, '一键发布.cmd'), 'utf8');
  assert.match(batch, /^[\x00-\x7f]*$/);
  assert.doesNotMatch(batch, /\bchcp\b/i);
  assert.equal(fs.readFileSync(path.join(__dirname, 'release-launcher.ps1')).subarray(0, 3).toString('hex'), 'efbbbf');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xianqiji-publish-test-'));
  try {
    const workspace = path.join(directory, '中文 发布目录');
    const scripts = path.join(workspace, 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'release-launcher.ps1'), path.join(scripts, 'release-launcher.ps1'));
    fs.copyFileSync(path.join(root, '一键发布.ps1'), path.join(workspace, '一键发布.ps1'));
    fs.writeFileSync(path.join(scripts, 'release-one-click.cjs'), "require('node:assert/strict').deepEqual(process.argv.slice(2), ['--check', '--interactive']); console.log('LAUNCHER_FIXTURE_OK'); process.exit(Number(process.env.XIANQIJI_RELEASE_FIXTURE_EXIT || 0));\n");
    const environment = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, XIANQIJI_RELEASE_NO_PAUSE: '1' };
    const entry = path.join(workspace, '一键发布.cmd');
    const execute = (codePage, exitCode = 0) => spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `chcp ${codePage}>nul & "${entry}" -Mode check`], { cwd: os.tmpdir(), env: { ...environment, XIANQIJI_RELEASE_FIXTURE_EXIT: String(exitCode) }, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 30000 });
    for (const lineEnding of ['\n', '\r\n']) {
      fs.writeFileSync(entry, batch.replace(/\r?\n/g, lineEnding));
      for (const codePage of [936, 65001]) {
        const result = execute(codePage);
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /LAUNCHER_FIXTURE_OK/);
        assert.equal(result.stderr, '');
      }
    }
    const failure = execute(936, 37);
    assert.equal(failure.status, 1, 'Failed release steps must not report success');
    assert.match(failure.stdout, /LAUNCHER_FIXTURE_OK/);
    const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const compatibility = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(workspace, '一键发布.ps1'), '-Mode', 'check'], { cwd: os.tmpdir(), env: environment, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(compatibility.status, 0, `${compatibility.stdout}\n${compatibility.stderr}`);
    assert.match(compatibility.stdout, /LAUNCHER_FIXTURE_OK/);
    console.log('PASS actual Windows launcher: LF/CRLF, code pages 936/65001, Unicode/spaced paths, foreign cwd, arguments, failure exit, PowerShell compatibility');
  } finally {
    assert.equal(path.dirname(fs.realpathSync(directory)).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(directory).startsWith('xianqiji-publish-test-'));
    fs.rmSync(directory, { recursive: true });
  }
}

async function main() {
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('1.9.9', '2.0.0'), -1);
  for (const version of ['1.0', '../1.0.0', '1.0.0-beta', '01.0.0']) assert.throws(() => artifactNames(version));
  const commit = 'a'.repeat(40);
  assert.doesNotThrow(() => assertSource(commit, commit, ''));
  assert.throws(() => assertSource(commit, commit, '?? private.txt'), /工作区/);
  assert.throws(() => assertSource(commit, 'b'.repeat(40), ''), /HEAD/);
  await checkPrepared();
  await checkGitHub();
  if (process.platform === 'win32') {
    checkWindowsLauncher();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xianqiji-publish-test-'));
    try {
      const batch = path.join(directory, 'batch with spaces.cmd');
      fs.writeFileSync(batch, '@echo off\r\nif not "%~1"=="argument with spaces" exit /b 2\r\nexit /b 0\r\n');
      await require('./release-one-click.cjs').run(batch, ['argument with spaces']);
      fs.writeFileSync(batch, '@echo off\r\nexit /b 37\r\n');
      await assert.rejects(require('./release-one-click.cjs').run(batch), /37/);
      await assert.rejects(require('./release-one-click.cjs').run(batch, ['bad&argument']), /不支持/);
      console.log('PASS Windows batch execution: quoted spaces, failure propagation, shell metacharacter refusal');
    } finally {
      assert.equal(path.dirname(fs.realpathSync(directory)).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
      assert.ok(path.basename(directory).startsWith('xianqiji-publish-test-'));
      fs.rmSync(directory, { recursive: true });
    }
  }
  console.log('PASS release pipeline tests; no real uploads, credentials, music or server changes');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
