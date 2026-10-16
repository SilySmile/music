const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = function installTransfers({ app, ipcMain, dialog, shell, requireWindow, getWindow, testing }) {
  const mappingsPath = path.join(app.getPath('userData'), 'export-destinations.json');
  let destinations;
  async function mappings() {
    if (destinations) return destinations;
    try { destinations = JSON.parse(await fs.readFile(mappingsPath, 'utf8')); }
    catch { destinations = {}; }
    return destinations;
  }
  function validateId(id) { if (typeof id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(id)) throw new Error('无效的传输任务'); }
  async function location(id) {
    validateId(id);
    const target = (await mappings())[id];
    if (typeof target !== 'string') throw new Error('导出目标不存在，请重新创建导出任务。');
    return target;
  }
  ipcMain.handle('transfer:open-export', async (event, id, filename) => {
    requireWindow(event, true); validateId(id);
    const records = await mappings();
    if (!records[id]) {
      if (typeof filename !== 'string' || path.basename(filename) !== filename || !filename.endsWith('.zip')) throw new Error('无效的导出文件名');
      let target;
      if (testing) {
        const directory = path.join(app.getPath('userData'), 'exports');
        await fs.mkdir(directory, { recursive: true });
        target = path.join(directory, filename);
      } else {
        const directory = path.join(app.getPath('userData'), '导出');
        await fs.mkdir(directory, { recursive: true });
        const result = await dialog.showSaveDialog(getWindow(), { title: '保存可恢复的音乐包', defaultPath: path.join(directory, filename), filters: [{ name: 'ZIP 音乐包', extensions: ['zip'] }] });
        if (result.canceled || !result.filePath) throw new Error('已取消选择保存位置，任务已保留。');
        target = result.filePath;
      }
      await fs.writeFile(target, new Uint8Array());
      records[id] = target;
      await fs.writeFile(mappingsPath, JSON.stringify(records));
    }
    const target = await location(id);
    try { return { location: target, size: (await fs.stat(target)).size }; }
    catch { throw new Error('导出目标已移动或删除。请恢复原路径后继续，或新建导出任务。'); }
  });
  ipcMain.handle('transfer:write-export', async (event, id, offset, data) => {
    requireWindow(event, true);
    if (!Number.isSafeInteger(offset) || offset < 0 || !(data instanceof Uint8Array) || data.byteLength > 8 * 1024 * 1024) throw new Error('无效的文件分块');
    const handle = await fs.open(await location(id), 'r+');
    try {
      let written = 0;
      while (written < data.length) {
        const result = await handle.write(data, written, data.length - written, offset + written);
        if (!result.bytesWritten) throw new Error('目标文件无法继续写入，请检查磁盘空间。');
        written += result.bytesWritten;
      }
      await handle.sync();
    } finally { await handle.close(); }
  });
  ipcMain.handle('transfer:finish-export', async (event, id, size) => {
    requireWindow(event, true);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('无效的归档长度');
    const target = await location(id);
    const handle = await fs.open(target, 'r+');
    try { await handle.truncate(size); await handle.sync(); }
    finally { await handle.close(); }
    return target;
  });
  ipcMain.handle('transfer:reveal-export', async (event, id) => { requireWindow(event, true); shell.showItemInFolder(await location(id)); });
};
