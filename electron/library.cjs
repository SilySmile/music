const fs = require('node:fs/promises');
const { createReadStream, constants } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const { timedWords, timestamp, enhancedText } = require('./lyric-timing.cjs');

const format = 'xianqiji-library-folder';
const chunkSize = 4 * 1024 * 1024;
const safeName = (value) => {
  const name = String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 90).trim();
  return name && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? name : '歌曲';
};
async function digest(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx');
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}
function lyricsText(lines, translated) {
  const timed = lines.some((line) => line.time >= 0);
  const header = !translated && lines.some((line) => timedWords(line) && line.wordTiming === 'estimated') ? '[x-timing:estimated]\n' : '';
  return header + lines.map((line) => {
    const text = translated ? line.translation || '' : enhancedText(line);
    if (!text) return timed ? '' : ' ';
    if (line.time < 0) return text;
    if (timedWords(line)) return `[${timestamp(line.time)}]${text}`;
    const value = Math.round(line.time * 100);
    return `[${String(Math.floor(value / 6000)).padStart(2, '0')}:${String(Math.floor(value / 100 % 60)).padStart(2, '0')}.${String(value % 100).padStart(2, '0')}]${text}`;
  }).filter((line) => line !== '').join('\n');
}

module.exports = function createLibrary({ userData, onProgress = () => {}, copyFile = fs.copyFile }) {
  const locationFile = path.join(userData, 'library-location.json');
  let root;
  let previousPath = '';
  let manifest;
  let cache;
  let configured = false;
  let skipLegacyMigration = false;
  let moving = false;
  let queue = Promise.resolve();
  const uploads = new Map();
  const verifiedMedia = new Map();
  const contained = (base, ...parts) => {
    const target = path.resolve(base, ...parts);
    const relative = path.relative(path.resolve(base), target);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('音乐库文件路径无效。');
    return target;
  };
  const identify = (id) => { if (typeof id !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(id)) throw new Error('歌曲标识无效。'); return id; };
  const songDirectory = (id) => contained(root, '歌曲', identify(id));
  const saveManifest = (value) => atomicJSON(path.join(root, 'library.json'), value);
  async function ensure() {
    if (manifest) { await fs.access(path.join(root, 'library.json')); return; }
    if (!root) {
      try {
        const saved = JSON.parse(await fs.readFile(locationFile, 'utf8'));
        if (!path.isAbsolute(saved.path)) throw new Error('音乐库目录配置无效。');
        root = saved.path; previousPath = saved.previousPath || ''; configured = true; skipLegacyMigration = saved.skipLegacyMigration === true;
        await fs.access(root);
      } catch (error) {
        if (error.code !== 'ENOENT' || root) throw new Error(`已配置的音乐库不可用，请恢复磁盘或原目录：${root || locationFile}`);
        root = path.join(userData, '音乐库');
      }
    }
    if (configured) await fs.access(root);
    await fs.mkdir(root, { recursive: true });
    try {
      manifest = JSON.parse(await fs.readFile(path.join(root, 'library.json'), 'utf8'));
      if (manifest.format !== format || manifest.version !== 1 || !manifest.tracks || typeof manifest.tracks !== 'object') throw new Error('音乐库清单损坏，未覆盖原文件。');
    } catch (error) {
      manifest = undefined;
      if (error.code !== 'ENOENT') throw error;
      if (configured) throw new Error('已配置音乐库缺少 library.json，未创建替代空库。请恢复清单或打开另一份已有音乐库。');
      if ((await fs.readdir(root)).length) throw new Error('目录内已有文件但缺少音乐库清单，未覆盖原文件。');
      manifest = { format, version: 1, libraryId: randomUUID(), legacyMigrated: false, tracks: {} };
      await saveManifest(manifest);
    }
    try { cache = JSON.parse(await fs.readFile(path.join(root, 'translations-cache.json'), 'utf8')); if (!cache || Array.isArray(cache) || typeof cache !== 'object' || Object.values(cache).some((value) => typeof value !== 'string')) throw new Error('Invalid cache'); }
    catch (error) { if (error.code !== 'ENOENT') { manifest = undefined; throw new Error('译文缓存文件无法读取，未覆盖原文件。'); } cache = {}; }
  }
  function run(operation) {
    if (moving) return Promise.reject(new Error('正在校验或切换音乐库，请完成后再导入或修改歌曲。'));
    const result = queue.then(async () => { await ensure(); return operation(); });
    queue = result.catch(() => {});
    return result;
  }
  const info = () => ({ path: root, previousPath, internalPath: userData, trackCount: Object.keys(manifest.tracks).length, legacyMigrated: skipLegacyMigration || manifest.legacyMigrated, moving });
  async function writeLyrics(directory, metadata, filename) {
    const base = safeName(filename || `${metadata.artist} - ${metadata.title}`);
    const extension = metadata.lyrics.some((line) => line.time >= 0) ? 'lrc' : 'txt';
    const writeText = async (file, text) => {
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, 'wx');
      try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, file);
    };
    await writeText(path.join(directory, `${base}.${extension}`), lyricsText(metadata.lyrics, false));
    await writeText(path.join(directory, `${base}.zh.${extension}`), lyricsText(metadata.lyrics, true));
    await atomicJSON(path.join(directory, 'tingyu-library.json'), { format: 'xianqiji-library', version: 1, tracks: [metadata] });
  }
  function metadataOnly(value) {
    if (!value || typeof value !== 'object' || typeof value.title !== 'string' || typeof value.artist !== 'string' || !Array.isArray(value.lyrics)) throw new Error('歌曲信息无效。');
    identify(value.id);
    const { audio: _audio, cover: _cover, ...metadata } = value;
    for (const line of metadata.lyrics) if (!line || typeof line.text !== 'string' || !Number.isFinite(line.time) || (line.translation !== undefined && typeof line.translation !== 'string')) throw new Error('歌词格式无效。');
    return metadata;
  }
  const descriptor = (value) => {
    if (!value || !Number.isSafeInteger(value.size) || value.size < 0 || typeof value.type !== 'string') throw new Error('歌曲文件信息无效。');
    return { size: value.size, type: value.type };
  };
  async function existingLibrary(destination, verifyFiles = false) {
    if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('请选择已有音乐库的完整目录。');
    let target = await fs.realpath(destination);
    if (!(await fs.stat(path.join(target, 'library.json')).catch((error) => { if (error.code === 'ENOENT') return null; throw error; }))) {
      const candidates = [];
      for (const name of ['音乐库', '弦栖霁音乐库']) {
        const candidate = path.join(target, name);
        if (await fs.stat(path.join(candidate, 'library.json')).catch((error) => { if (error.code === 'ENOENT') return null; throw error; })) candidates.push(candidate);
      }
      if (candidates.length !== 1) throw new Error(candidates.length ? '该位置有多个音乐库，请直接选择其中包含 library.json 的文件夹。' : '未找到音乐库清单。请选择包含 library.json 的音乐库文件夹；普通音频目录请使用导入功能。');
      target = await fs.realpath(candidates[0]);
    }
    const regularFile = async (filename) => {
      const relative = path.relative(target, filename);
      contained(target, relative);
      let current = target;
      for (const part of relative.split(path.sep)) {
        current = path.join(current, part);
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('已有音乐库包含链接，未切换或修改文件。');
      }
      const stat = await fs.stat(filename);
      if (!stat.isFile()) throw new Error('音乐库引用的文件类型无效。');
      return stat;
    };
    const indexPath = path.join(target, 'library.json');
    await regularFile(indexPath);
    const indexText = await fs.readFile(indexPath, 'utf8');
    let index;
    try { index = JSON.parse(indexText); } catch { throw new Error('已有音乐库清单无法解析，未切换或覆盖文件。'); }
    if (index?.format !== format || index.version !== 1 || typeof index.libraryId !== 'string' || !index.libraryId || !index.tracks || Array.isArray(index.tracks) || typeof index.tracks !== 'object') throw new Error('该目录不是受支持的文件音乐库，未切换或覆盖文件。');
    const cachePath = path.join(target, 'translations-cache.json');
    let cacheText;
    let translations = {};
    try {
      await regularFile(cachePath); cacheText = await fs.readFile(cachePath, 'utf8'); translations = JSON.parse(cacheText);
      if (!translations || Array.isArray(translations) || typeof translations !== 'object' || Object.values(translations).some((value) => typeof value !== 'string')) throw new Error('Invalid cache');
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('已有库的译文缓存无法读取，未切换或覆盖文件。'); }
    const files = [];
    for (const [id, record] of Object.entries(index.tracks)) {
      identify(id);
      if (!record || metadataOnly(record.metadata).id !== id) throw new Error('音乐库歌曲标识与清单不一致。');
      if (!record.audio) throw new Error('音乐库缺少歌曲音频记录。');
      for (const kind of ['audio', 'cover']) if (record[kind]) {
        const media = record[kind]; descriptor(media);
        if (typeof media.file !== 'string' || !media.file || /[\\/:]/.test(media.file) || media.file === '.' || media.file === '..' || typeof media.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(media.sha256)) throw new Error('已有音乐库文件记录无效。');
        const filename = contained(target, '歌曲', id, media.file);
        const stat = await regularFile(filename);
        if (stat.size !== media.size) throw new Error(`《${record.metadata.title}》文件缺失或长度不符，仍使用原音乐库。`);
        if (kind === 'audio' && /^[a-f0-9]{64}$/i.test(id) && media.sha256 !== id.toLowerCase()) throw new Error('歌曲内容指纹与歌曲标识不一致。');
        files.push({ filename, sha256: media.sha256, title: record.metadata.title });
      }
    }
    if (verifyFiles) {
      onProgress({ stage: '正在校验已有音乐库', completed: 0, total: files.length });
      let completed = 0;
      for (const file of files) {
        if (await digest(file.filename) !== file.sha256) throw new Error(`《${file.title}》文件校验失败，仍使用原音乐库，未修改两个目录。`);
        onProgress({ stage: '正在校验已有音乐库', completed: ++completed, total: files.length });
      }
      if (await fs.readFile(indexPath, 'utf8') !== indexText || await fs.readFile(cachePath, 'utf8').catch((error) => { if (error.code === 'ENOENT') return undefined; throw error; }) !== cacheText) throw new Error('校验期间音乐库发生变化，请退出其他播放器后重试。');
      await fs.access(target, constants.W_OK); await fs.access(indexPath, constants.W_OK);
    }
    return { path: target, manifest: index, cache: translations };
  }
  const api = {
    location: () => ({ path: root || path.join(userData, '音乐库'), previousPath, internalPath: userData, trackCount: manifest ? Object.keys(manifest.tracks).length : 0, legacyMigrated: skipLegacyMigration || manifest?.legacyMigrated === true, moving }),
    async inspect(destination) {
      const candidate = await existingLibrary(destination);
      return { path: candidate.path, trackCount: Object.keys(candidate.manifest.tracks).length };
    },
    async useExisting(destination) {
      if (moving) throw new Error('已有音乐库切换正在进行。');
      moving = true;
      try {
        await queue;
        if (uploads.size) throw new Error('请先完成或取消当前歌曲导入，再切换音乐库。');
        const candidate = await existingLibrary(destination, true);
        let original = root;
        if (!original) {
          try { original = JSON.parse(await fs.readFile(locationFile, 'utf8')).path; } catch {}
          original ||= path.join(userData, '音乐库');
        }
        if (path.resolve(original) === candidate.path) throw new Error('这已经是当前音乐库，无需切换。');
        await fs.mkdir(userData, { recursive: true });
        await atomicJSON(locationFile, { path: candidate.path, previousPath: original, skipLegacyMigration: true });
        previousPath = original; root = candidate.path; manifest = candidate.manifest; cache = candidate.cache;
        configured = true; skipLegacyMigration = true; verifiedMedia.clear();
        return { ...info(), moving: false };
      } finally { moving = false; }
    },
    info: () => run(info),
    list: () => run(() => Object.values(manifest.tracks)),
    media: (id) => run(async () => {
      const record = manifest.tracks[identify(id)];
      if (!record) throw new Error('这首歌曲已被移除。');
      const filename = contained(songDirectory(id), record.audio.file);
      const stat = await fs.stat(filename);
      const fingerprint = `${filename}|${stat.size}|${stat.mtimeMs}|${record.audio.sha256}`;
      if (verifiedMedia.get(id) !== fingerprint) {
        if (stat.size !== record.audio.size || await digest(filename) !== record.audio.sha256) throw new Error('音频文件已改变或损坏，请恢复备份。');
        verifiedMedia.set(id, fingerprint);
      }
      return { path: filename, size: stat.size, type: record.audio.type };
    }),
    begin: (value, audio, cover) => run(async () => {
      const metadata = metadataOnly(value);
      const token = randomUUID();
      const directory = contained(root, '.pending', token);
      await fs.mkdir(directory, { recursive: true });
      const base = safeName(`${metadata.artist} - ${metadata.title}`);
      const extension = /^[a-z0-9]{2,5}$/i.test(metadata.format) ? metadata.format.toLowerCase() : 'mp3';
      const upload = { directory, metadata, audio: { ...descriptor(audio), file: `${base}.${extension}`, written: 0 } };
      if (cover) upload.cover = { ...descriptor(cover), file: `cover.${cover.type === 'image/png' ? 'png' : cover.type === 'image/webp' ? 'webp' : 'jpg'}`, written: 0 };
      for (const kind of ['audio', 'cover']) if (upload[kind]) await fs.writeFile(contained(directory, upload[kind].file), new Uint8Array());
      uploads.set(token, upload);
      return token;
    }),
    write: (token, kind, offset, bytes) => run(async () => {
      const upload = uploads.get(token);
      const media = ['audio', 'cover'].includes(kind) && upload?.[kind];
      if (!media || !(bytes instanceof Uint8Array) || bytes.length > chunkSize || offset !== media.written || offset + bytes.length > media.size) throw new Error('音乐文件分块无效。');
      const handle = await fs.open(contained(upload.directory, media.file), 'r+');
      try {
        let written = 0;
        while (written < bytes.length) {
          const result = await handle.write(bytes, written, bytes.length - written, offset + written);
          if (!result.bytesWritten) throw new Error('磁盘无法继续写入，请检查剩余空间。');
          written += result.bytesWritten;
        }
        await handle.sync();
        media.written += written;
      } finally { await handle.close(); }
    }),
    finish: (token, hashes) => run(async () => {
      const upload = uploads.get(token);
      if (!upload) throw new Error('音乐保存任务不存在。');
      const record = { metadata: upload.metadata };
      for (const kind of ['audio', 'cover']) if (upload[kind]) {
        const media = upload[kind];
        const checksum = await digest(contained(upload.directory, media.file));
        if (media.written !== media.size || checksum !== hashes?.[kind]) throw new Error('音乐文件完整性校验失败，旧数据已保留。');
        if (kind === 'audio' && /^[a-f0-9]{64}$/i.test(record.metadata.id) && checksum !== record.metadata.id.toLowerCase()) throw new Error('歌曲内容与歌曲标识不一致，旧数据已保留。');
        record[kind] = { file: media.file, type: media.type, size: media.size, sha256: checksum };
      }
      await writeLyrics(upload.directory, upload.metadata);
      const destination = songDirectory(upload.metadata.id);
      const backup = contained(root, '.pending', `old-${randomUUID()}`);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      let backedUp = false;
      try { await fs.rename(destination, backup); backedUp = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try {
        await fs.rename(upload.directory, destination);
        const next = { ...manifest, tracks: { ...manifest.tracks, [upload.metadata.id]: record } };
        await saveManifest(next); manifest = next; uploads.delete(token);
      } catch (error) {
        await fs.rm(destination, { recursive: true, force: true });
        if (backedUp) await fs.rename(backup, destination);
        throw error;
      }
      if (backedUp) await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
      return record;
    }),
    cancel: (token) => run(async () => {
      const upload = uploads.get(token);
      if (upload) { await fs.rm(upload.directory, { recursive: true, force: true }); uploads.delete(token); }
    }),
    read: (id, kind, offset, length) => run(async () => {
      const media = ['audio', 'cover'].includes(kind) && manifest.tracks[identify(id)]?.[kind];
      if (!media || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > chunkSize || offset + length > media.size) throw new Error('读取音乐文件的范围无效。');
      const handle = await fs.open(contained(songDirectory(id), media.file), 'r');
      try {
        const bytes = Buffer.alloc(length);
        let received = 0;
        while (received < length) { const result = await handle.read(bytes, received, length - received, offset + received); if (!result.bytesRead) throw new Error('音乐文件不完整，请恢复音乐库备份。'); received += result.bytesRead; }
        return bytes;
      } finally { await handle.close(); }
    }),
    patch: (id, patch) => run(async () => {
      const existing = manifest.tracks[identify(id)];
      if (!existing) throw new Error('这首歌曲已被移除。');
      const metadata = metadataOnly({ ...existing.metadata, ...patch, id });
      await writeLyrics(songDirectory(id), metadata, path.parse(existing.audio.file).name);
      const record = { ...existing, metadata };
      const next = { ...manifest, tracks: { ...manifest.tracks, [id]: record } };
      await saveManifest(next); manifest = next;
      return record;
    }),
    remove: (id) => run(async () => {
      identify(id);
      const next = { ...manifest, tracks: { ...manifest.tracks } };
      delete next.tracks[id];
      await saveManifest(next); manifest = next;
      await fs.rm(songDirectory(id), { recursive: true, force: true });
    }),
    getCache: (key) => run(() => Object.hasOwn(cache, key) ? cache[key] : undefined),
    setCache: (entries) => run(async () => {
      const next = { ...cache };
      for (const [key, value] of entries) { if (typeof key !== 'string' || typeof value !== 'string') throw new Error('译文缓存无效。'); Object.defineProperty(next, key, { value, enumerable: true, writable: true, configurable: true }); }
      await atomicJSON(path.join(root, 'translations-cache.json'), next); cache = next;
    }),
    markMigrated: () => run(async () => { const next = { ...manifest, legacyMigrated: true }; await saveManifest(next); manifest = next; }),
    async move(destination) {
      if (moving) throw new Error('已有音乐库迁移正在进行。');
      moving = true;
      try {
        await queue; await ensure();
        if (uploads.size) throw new Error('请先完成当前歌曲导入，再更换目录。');
        const target = path.resolve(destination);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const parent = await fs.realpath(path.dirname(target));
        const resolved = path.join(parent, path.basename(target));
        const source = await fs.realpath(root);
        const inside = (base, target) => { const relative = path.relative(base, target); return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
        if (resolved === source || inside(source, resolved) || inside(resolved, source)) throw new Error('新目录不能是当前音乐库或其父、子目录。');
        try { if ((await fs.readdir(resolved)).length) throw new Error('目标目录已有文件，为避免覆盖，请选择其他位置。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const files = [];
        const expected = new Map();
        for (const [id, record] of Object.entries(manifest.tracks)) for (const kind of ['audio', 'cover']) if (record[kind]) expected.set(path.join('歌曲', identify(id), record[kind].file), record[kind].sha256);
        async function visit(directory, prefix = '') {
          for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (!prefix && entry.name === '.pending') continue;
            if (entry.isSymbolicLink()) throw new Error('音乐库中存在链接文件，请移除链接后重试。');
            const name = path.join(prefix, entry.name);
            if (entry.isDirectory()) await visit(path.join(directory, entry.name), name);
            else if (entry.isFile()) files.push(name);
          }
        }
        await visit(source);
        await fs.mkdir(resolved, { recursive: true });
        let completed = 0;
        for (const name of files) {
          const original = contained(source, name);
          const copied = contained(resolved, name);
          await fs.mkdir(path.dirname(copied), { recursive: true });
          await copyFile(original, copied, constants.COPYFILE_EXCL);
          const checksum = await digest(original);
          if (expected.has(name) && checksum !== expected.get(name)) throw new Error('源音乐文件与已保存的校验记录不一致，仍使用旧目录。请恢复原文件或重新导入后再迁移。');
          if (checksum !== await digest(copied)) throw new Error('复制校验失败，仍使用旧目录，原数据没有删除。新目录的半成品请保留或自行清理。');
          onProgress({ stage: '正在复制并校验音乐库', completed: ++completed, total: files.length });
        }
        await atomicJSON(locationFile, { path: resolved, previousPath: root, skipLegacyMigration });
        previousPath = root; root = resolved; configured = true;
        return { ...info(), moving: false };
      } finally { moving = false; }
    },
  };
  return api;
};
