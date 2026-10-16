const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyEnvelope } = require('../updates/protocol.cjs');
async function main() {
  const version = require('../package.json').version;
  const directory = path.resolve(__dirname, '..', 'release', `v${version}`);
  const release = verifyEnvelope(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'), require('../updates/public.json').publicKey);
  if (release.version !== version) throw new Error('正式包清单版本不符，拒绝清理历史包');
  const expected = { 'win-x64': `Xianqiji-Setup-${version}-x64.exe`, 'win-x64-portable': `Xianqiji-${version}-x64.exe`, android: `Xianqiji-${version}-android.apk` };
  for (const [platform, name] of Object.entries(expected)) {
    const artifact = release.artifacts[platform];
    if (!artifact || path.basename(artifact.file) !== name) throw new Error(`正式包清单缺少 ${platform}`);
    const filename = path.join(directory, name);
    if (fs.statSync(filename).size !== artifact.size) throw new Error(`正式包长度不符 ${name}`);
    const digest = crypto.createHash('sha256');
    for await (const bytes of fs.createReadStream(filename)) digest.update(bytes);
    if (digest.digest('hex') !== artifact.sha256) throw new Error(`正式包哈希不符 ${name}`);
  }
  console.log(`PASS v${version}: signed manifest and all three local release package hashes`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
