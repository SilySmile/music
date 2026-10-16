const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = path.join(root, 'test-results', `cleanup-fixture-${Date.now()}`);
  for (const name of ['scripts', 'updates', 'release/v1.0.0/win-unpacked/resources', 'release/v0.3.8/win-unpacked/Data/音乐库', '.release-staging/v0.3.11', '.release-keys']) await fs.mkdir(path.join(directory, name), { recursive: true });
  for (const name of ['clean-release-artifacts.ps1', 'verify-release.cjs']) await fs.copyFile(path.join(root, 'scripts', name), path.join(directory, 'scripts', name));
  await fs.copyFile(path.join(root, 'updates/protocol.cjs'), path.join(directory, 'updates/protocol.cjs'));
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  await fs.writeFile(path.join(directory, 'updates/public.json'), JSON.stringify({ publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) }));
  const artifacts = {};
  for (const [platform, name, kind] of [['win-x64', 'Xianqiji-Setup-1.0.0-x64.exe', 'nsis'], ['win-x64-portable', 'Xianqiji-1.0.0-x64.exe', 'portable'], ['android', 'Xianqiji-1.0.0-android.apk', 'apk']]) {
    const bytes = Buffer.from(`fixture-${name}`); await fs.writeFile(path.join(directory, 'release/v1.0.0', name), bytes);
    artifacts[platform] = { file: `releases/v1.0.0/${name}`, kind, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }
  const payload = Buffer.from(JSON.stringify({ product: 'xianqiji', schema: 1, version: '1.0.0', issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), notes: 'Fixture only', artifacts }));
  await fs.writeFile(path.join(directory, 'release/v1.0.0/manifest.json'), JSON.stringify({ algorithm: 'RSA-SHA256', payload: payload.toString('base64'), signature: crypto.sign('sha256', payload, keys.privateKey).toString('base64') }));
  const sentinels = {
    'release/v1.0.0/SHA256SUMS.txt': 'fixture hashes', 'release/v1.0.0/win-unpacked/resources/app.asar': 'new extracted runtime',
    'release/v0.3.8/Xianqiji-0.3.8-x64.exe': 'old package', 'release/v0.3.8/win-unpacked/弦栖霁.exe': 'old runtime',
    'release/v0.3.8/win-unpacked/Data/音乐库/library.json': 'never delete library', 'release/v0.3.8/win-unpacked/Data/settings.json': 'never delete settings',
    'release/v0.3.8/private-song.mp3': 'unknown user file', '.release-keys/private.pem': 'never delete private key', '.release-staging/v0.3.11/package.exe': 'staged copy', '.release-staging/Xianqiji-update-0.3.11.tar': 'duplicate archive',
  };
  for (const [name, text] of Object.entries(sentinels)) await fs.writeFile(path.join(directory, name), text);
  function run(apply) {
    const result = spawnSync(process.env.POWERSHELL_EXE || 'pwsh.exe', ['-NoProfile', '-File', path.join(directory, 'scripts/clean-release-artifacts.ps1'), ...(apply ? ['-Apply'] : [])], { windowsHide: true, encoding: 'utf8', env: process.env });
    if (result.error) throw result.error;
    return result;
  }
  const dry = run(false); assert.equal(dry.status, 0, dry.stderr);
  assert.equal(await fs.readFile(path.join(directory, 'release/v0.3.8/Xianqiji-0.3.8-x64.exe'), 'utf8'), 'old package');
  const applied = run(true); assert.equal(applied.status, 0, applied.stderr);
  for (const name of ['release/v0.3.8/Xianqiji-0.3.8-x64.exe', 'release/v0.3.8/win-unpacked/弦栖霁.exe', 'release/v1.0.0/win-unpacked', '.release-staging/v0.3.11', '.release-staging/Xianqiji-update-0.3.11.tar']) assert.equal(await fs.stat(path.join(directory, name)).catch(() => null), null, name);
  for (const name of ['release/v0.3.8/win-unpacked/Data/音乐库/library.json', 'release/v0.3.8/win-unpacked/Data/settings.json', 'release/v0.3.8/private-song.mp3', '.release-keys/private.pem']) assert.equal(await fs.readFile(path.join(directory, name), 'utf8'), sentinels[name]);
  const repeated = run(true); assert.equal(repeated.status, 0, repeated.stderr);
  const external = path.join(directory, 'outside-release'); await fs.mkdir(external); await fs.writeFile(path.join(external, '弦栖霁.exe'), 'outside must survive');
  await fs.mkdir(path.join(directory, 'release/v0.2.0'));
  await fs.symlink(external, path.join(directory, 'release/v0.2.0/win-unpacked'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = run(true); assert.notEqual(linked.status, 0);
  assert.equal(await fs.readFile(path.join(external, '弦栖霁.exe'), 'utf8'), 'outside must survive');
  await fs.writeFile(path.join(directory, 'release/v0.3.8/Xianqiji-0.3.8-x64.exe'), 'must survive failed integrity check');
  await fs.appendFile(path.join(directory, 'release/v1.0.0/Xianqiji-1.0.0-android.apk'), 'tampered');
  const refused = run(true); assert.notEqual(refused.status, 0);
  assert.equal(await fs.readFile(path.join(directory, 'release/v0.3.8/Xianqiji-0.3.8-x64.exe'), 'utf8'), 'must survive failed integrity check');
  console.log('PASS cleanup dry-run, package deletion, Data/key/unknown-file retention, idempotence, parent-junction rejection and signature/hash fail-closed protection');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
