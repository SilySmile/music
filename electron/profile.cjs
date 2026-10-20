const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function inventory(directory) {
  const files = [];
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const filename = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`拒绝迁移链接文件：${filename}`);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile()) {
        const descriptor = fs.openSync(path.join(directory, filename), 'r');
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(4 * 1024 * 1024);
        let size = 0;
        try {
          let length;
          while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null))) { hash.update(buffer.subarray(0, length)); size += length; }
        } finally { fs.closeSync(descriptor); }
        files.push({ file: filename, size, sha256: hash.digest('hex') });
      } else throw new Error(`不支持的文件类型：${filename}`);
    }
  }
  visit('');
  return files.sort((first, second) => first.file.localeCompare(second.file));
}

function verify(directory, expected) {
  if (JSON.stringify(inventory(directory)) !== JSON.stringify(expected)) throw new Error(`文件校验失败，原数据保留：${directory}`);
}

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function migrateProfile(source, target) {
  source = fs.realpathSync(source);
  target = path.resolve(target);
  if (inside(source, target) || inside(target, source)) throw new Error('新旧数据目录不能互相包含。');
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error('目标数据目录非空，拒绝覆盖。');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const backup = fs.mkdtempSync(path.join(path.dirname(target), '旧C盘数据备份-'));
  // Newer Node versions refuse cpSync into a directory that already exists when errorOnExist is
  // set, so the reserved (still empty) paths are removed first. Non-empty targets stay rejected.
  fs.rmdirSync(backup);
  const files = inventory(source);
  fs.cpSync(source, backup, { recursive: true, errorOnExist: true, force: false });
  verify(backup, files);
  verify(source, files);
  if (fs.existsSync(target)) fs.rmdirSync(target);
  fs.cpSync(backup, target, { recursive: true, errorOnExist: true, force: false });
  verify(target, files);
  const rebase = (value, destination) => typeof value === 'string' && path.isAbsolute(value) && inside(source, value) ? path.join(destination, path.relative(source, value)) : value;
  for (const name of ['library-location.json', 'export-destinations.json']) {
    const filename = path.join(target, name);
    if (!fs.existsSync(filename)) continue;
    const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (name === 'library-location.json') {
      config.path = rebase(config.path, target);
      config.previousPath = rebase(config.previousPath, backup);
    } else for (const key of Object.keys(config)) config[key] = rebase(config[key], target);
    fs.writeFileSync(filename, JSON.stringify(config, null, 2));
  }
  for (const name of ['lockfile', 'DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']) fs.rmSync(path.join(target, name), { force: true });
  const receipt = { format: 'xianqiji-profile-migration', source, target, backup, verifiedAt: new Date().toISOString(), files };
  const receiptPath = path.join(path.dirname(target), `数据迁移记录-${path.basename(backup)}.json`);
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return { receiptPath, source, target, backup, count: files.length, bytes: files.reduce((total, file) => total + file.size, 0) };
}

function cleanupProfile(receiptPath, expectedSource) {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const source = fs.realpathSync(expectedSource);
  if (receipt.format !== 'xianqiji-profile-migration' || source !== receipt.source || inside(source, receipt.backup) || inside(source, receipt.target)) throw new Error('迁移记录与待清理目录不匹配。');
  if (!fs.existsSync(path.join(receipt.target, '音乐库', 'library.json'))) throw new Error('请先验证新音乐库可读取，再清理旧目录。');
  verify(receipt.backup, receipt.files);
  verify(source, receipt.files);
  fs.rmSync(source, { recursive: true });
  receipt.cleanedAt = new Date().toISOString();
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  return { source, backup: receipt.backup, cleaned: !fs.existsSync(source) };
}

function profilePath({ packaged, executable, portableDirectory, workspace, testing, testData }) {
  if (testing && testData) return path.resolve(testData);
  return packaged ? path.join(portableDirectory || path.dirname(executable), 'Data') : path.join(workspace, '.dev-data');
}

module.exports = { migrateProfile, cleanupProfile, profilePath, inventory, verify };
