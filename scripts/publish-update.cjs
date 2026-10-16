const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
async function main() {
  const root = path.resolve(__dirname, '..'); const version = require('../package.json').version;
  const archive = path.join(root, '.release-staging', `Xianqiji-update-${version}.tar`);
  const config = JSON.parse(fs.readFileSync(path.join(root, '.release-keys/publisher.json'), 'utf8'));
  if (!/^[a-z0-9.-]+$/i.test(config.host) || !/^[a-z0-9_-]+$/i.test(config.user)) throw new Error('发布服务器配置无效');
  const child = spawn('ssh', ['-i', path.join(root, '.release-keys/publisher_ed25519'), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${path.join(root, '.release-keys/known_hosts')}`, '-o', 'ServerAliveInterval=15', `${config.user}@${config.host}`, 'publish'], { windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] });
  const completion = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`服务器拒绝发布，退出码 ${code}`))); });
  await Promise.all([pipeline(fs.createReadStream(archive), child.stdin), completion]);
  const trust = require('../updates/public.json'); const response = await fetch(new URL('manifest.json', trust.defaultBaseUrl), { signal: AbortSignal.timeout(20000), cache: 'no-store' });
  if (!response.ok) throw new Error(`线上清单检查失败 ${response.status}`);
  const payload = require('../updates/protocol.cjs').verifyEnvelope(await response.text(), trust.publicKey);
  if (payload.version !== version) throw new Error('线上版本与本次发布版本不一致');
  console.log(`已发布并在线验签：v${version}`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
