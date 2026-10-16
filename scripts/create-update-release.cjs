const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');
const { spawn } = require('node:child_process');
const { verifyEnvelope } = require('../updates/protocol.cjs');
const trust = require('../updates/public.json');

async function checksum(filename) { const hash = crypto.createHash('sha256'); for await (const bytes of createReadStream(filename)) hash.update(bytes); return hash.digest('hex'); }
async function main() {
  const root = path.resolve(__dirname, '..'); const version = require('../package.json').version;
  const release = path.join(root, 'release', `v${version}`);
  const directory = path.join(root, '.release-staging', `v${version}`);
  const notes = await fs.readFile(path.join(release, 'update-notes.txt'), 'utf8');
  if (!notes.trim() || notes.length > 12000) throw new Error('请先填写 release/v<版本>/update-notes.txt（1–12000 字符）');
  await fs.mkdir(directory, { recursive: true });
  const artifacts = {};
  const files = ['manifest.json'];
  for (const [platform, name, kind] of [['win-x64', `Xianqiji-Setup-${version}-x64.exe`, 'nsis'], ['win-x64-portable', `Xianqiji-${version}-x64.exe`, 'portable'], ['android', `Xianqiji-${version}-android.apk`, 'apk']]) {
    const source = path.join(release, name); const file = `releases/v${version}/${name}`;
    const stat = await fs.stat(source); if (!stat.size) throw new Error(`空安装包：${source}`);
    const target = path.join(directory, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(source, target);
    artifacts[platform] = { kind, file, size: stat.size, sha256: await checksum(target) }; files.push(file);
  }
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ schema: 1, product: 'xianqiji', version, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 180 * 86400000).toISOString(), notes, artifacts }));
  const key = await fs.readFile(path.join(root, '.release-keys/update-signing-private.pem'));
  const envelope = JSON.stringify({ algorithm: 'RSA-SHA256', payload: payload.toString('base64'), signature: crypto.sign('sha256', payload, key).toString('base64') }, null, 2);
  verifyEnvelope(envelope, trust.publicKey);
  await fs.writeFile(path.join(directory, 'manifest.json'), envelope);
  await fs.writeFile(path.join(directory, 'files.json'), JSON.stringify(files, null, 2));
  const archive = path.join(root, '.release-staging', `Xianqiji-update-${version}.tar`);
  await new Promise((resolve, reject) => { const child = spawn('tar', ['-cf', archive, '-C', directory, ...files], { windowsHide: true, stdio: 'inherit' }); child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`tar 失败 ${code}`))); });
  console.log(JSON.stringify({ version, directory, archive, signed: true, expiresAt: new Date(now + 180 * 86400000).toISOString() }, null, 2));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
