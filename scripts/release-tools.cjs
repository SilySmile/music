const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function compareVersions(first, second) {
  const parse = (value) => {
    if (!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)) throw new Error('正式版本必须为数字 x.y.z，每段最多六位');
    return value.split('.').map(Number);
  };
  const left = parse(first); const right = parse(second);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return Math.sign(left[index] - right[index]);
  }
  return 0;
}

function assertSource(commit, remoteCommit, status) {
  if (!/^[a-f0-9]{40}$/.test(commit) || commit !== remoteCommit) throw new Error('本地 HEAD 与 origin/main 不一致；请先人工提交、审核并推送源码。不会自动提交或推送。');
  if (status.trim()) throw new Error('工作区有未提交或未跟踪文件；请先人工整理并提交源码，不会自动提交或删除文件。');
}

async function checksum(filename) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
}

function artifactNames(version) {
  compareVersions(version, version);
  return [`Xianqiji-Setup-${version}-x64.exe`, `Xianqiji-${version}-x64.exe`, `Xianqiji-${version}-android.apk`];
}

function assertBuildDirectory(root, directory) {
  const release = path.join(root, 'release');
  if (path.dirname(directory) !== release || !/^v\d+\.\d+\.\d+$/.test(path.basename(directory))) throw new Error('构建目录越界。');
  for (const ancestor of [release, directory]) if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('构建目录是链接，拒绝覆盖。');
  function inspect(parent) {
    if (!fs.existsSync(parent)) return;
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      const filename = path.join(parent, entry.name);
      if (entry.isSymbolicLink()) throw new Error('发行目录包含链接，拒绝覆盖。');
      if (/^(Data|音乐库|\.release-keys)$/i.test(entry.name) || /^library\.json$/i.test(entry.name) || /\.(mp3|flac|wav|m4a|ogg|opus|aac|lrc|p12|pem|key)$/i.test(entry.name)) throw new Error(`发行目录存在用户库或密钥文件，拒绝清理 / 打包：${filename}`);
      if (entry.isDirectory()) inspect(filename);
    }
  }
  inspect(directory);
}

async function verifyPrepared(root, version, commit, publicKey) {
  const directory = path.join(root, 'release', `v${version}`);
  const state = JSON.parse(fs.readFileSync(path.join(directory, 'publish-state.json'), 'utf8'));
  if (state.schema !== 1 || state.version !== version || state.commit !== commit || state.androidTested !== true) throw new Error('发布检查点不属于当前源码或缺少验证，不能续发。');
  const manifestFile = path.join(directory, 'manifest.json');
  if (await checksum(manifestFile) !== state.manifestSha256) throw new Error('发布清单已变化，不能续发。');
  const manifest = require('../updates/protocol.cjs').verifyEnvelope(fs.readFileSync(manifestFile, 'utf8'), publicKey);
  if (manifest.version !== version) throw new Error('签名版本与源码版本不一致。');
  if (manifest.notes !== fs.readFileSync(path.join(directory, 'update-notes.txt'), 'utf8')) throw new Error('更新说明与签名清单不一致。');
  const files = [];
  for (const name of artifactNames(version)) {
    const artifact = Object.values(manifest.artifacts).find((value) => value.file === `releases/v${version}/${name}`);
    const filename = path.join(directory, name);
    if (!artifact || fs.statSync(filename).size !== artifact.size || await checksum(filename) !== artifact.sha256) throw new Error(`安装包与签名不一致：${name}`);
    files.push({ name, filename, size: artifact.size, sha256: artifact.sha256 });
  }
  if (state.serverBundleSha256) {
    const name = `Xianqiji-library-server-${version}.tar.gz`; const filename = path.join(directory, name);
    if (await checksum(filename) !== state.serverBundleSha256) throw new Error('在线曲库部署包已变化，不能续发。');
    files.push({ name, filename, size: fs.statSync(filename).size, sha256: state.serverBundleSha256 });
  }
  const sums = files.map((file) => `${file.sha256}  ${file.name}`).join('\n') + '\n';
  for (const name of ['manifest.json', 'SHA256SUMS.txt', 'update-notes.txt']) {
    const filename = path.join(directory, name);
    const digest = await checksum(filename);
    if (name === 'update-notes.txt' && digest !== state.notesSha256) throw new Error('更新说明已变化，不能续发。');
    if (name === 'SHA256SUMS.txt' && fs.readFileSync(filename, 'utf8') !== sums) throw new Error('SHA256SUMS.txt 已变化。');
    files.push({ name, filename, size: fs.statSync(filename).size, sha256: digest });
  }
  return { state, manifest, files, directory };
}

module.exports = { compareVersions, assertSource, checksum, artifactNames, assertBuildDirectory, verifyPrepared };
