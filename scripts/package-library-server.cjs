const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
async function main() {
  const root = path.resolve(__dirname, '..');
  const version = require('../package.json').version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid version');
  const directory = path.join(root, 'release', `v${version}`);
  await fs.mkdir(directory, { recursive: true });
  const output = path.join(directory, `Xianqiji-library-server-${version}.tar.gz`);
  const files = ['install-library.sh', 'library-server.py', 'library.service', 'library-nginx-location.conf', 'provision-library.sh', 'test-library-server.py'];
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-czf', output, '-C', path.join(root, 'deployment'), ...files], { windowsHide: true, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`tar exit ${code}`)));
  });
  console.log(`在线曲库一键部署包（不含密钥或音乐）：${output}`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
