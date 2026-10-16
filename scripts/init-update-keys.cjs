const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, '.release-keys');
fs.mkdirSync(directory, { recursive: true });
const signing = path.join(directory, 'update-signing-private.pem');
if (!fs.existsSync(signing)) {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  fs.writeFileSync(signing, pair.privateKey, { flag: 'wx', mode: 0o600 });
}
for (const [name, comment] of [['bootstrap_ed25519', 'xianqiji-bootstrap-20261016'], ['publisher_ed25519', 'xianqiji-publisher']]) {
  const filename = path.join(directory, name);
  if (!fs.existsSync(filename)) {
    const result = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', filename, '-C', comment], { stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) throw new Error('SSH 密钥生成失败');
  }
}
const publicKey = crypto.createPublicKey(fs.readFileSync(signing)).export({ type: 'spki', format: 'pem' });
console.log(JSON.stringify({ product: 'xianqiji', defaultBaseUrl: 'https://39.106.55.218/music-updates/', publicKey }, null, 2));
