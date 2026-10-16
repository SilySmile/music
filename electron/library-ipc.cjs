const path = require('node:path');

module.exports = function installLibrary({ app, ipcMain, dialog, shell, requireWindow, getWindow }) {
  const library = require('./library.cjs')({ userData: app.getPath('userData'), onProgress: (progress) => getWindow()?.webContents.send('library:progress', progress) });
  require('electron').protocol.handle('xianqiji', require('./media.cjs')(library));
  let selected;
  let existing;
  const methods = { list: 'list', begin: 'begin', write: 'write', finish: 'finish', cancel: 'cancel', read: 'read', patch: 'patch', remove: 'remove', 'get-cache': 'getCache', 'set-cache': 'setCache', migrated: 'markMigrated' };
  for (const [channel, method] of Object.entries(methods)) ipcMain.handle(`library:${channel}`, (event, ...parameters) => { requireWindow(event, true); return library[method](...parameters); });
  ipcMain.handle('library:info', async (event) => {
    requireWindow(event, true);
    try { return await library.info(); }
    catch (error) { return { ...library.location(), error: error instanceof Error ? error.message : '音乐库目录不可用。' }; }
  });
  ipcMain.handle('library:choose', async (event) => {
    requireWindow(event, true);
    const result = await dialog.showOpenDialog(getWindow(), { title: '选择音乐库保存位置（会创建弦栖霁音乐库子文件夹）', properties: ['openDirectory', 'createDirectory'] });
    selected = result.canceled || !result.filePaths[0] ? undefined : path.join(result.filePaths[0], '弦栖霁音乐库');
    return selected || null;
  });
  ipcMain.handle('library:move', async (event) => {
    requireWindow(event, true);
    if (!selected) throw new Error('请先选择新的保存文件夹。');
    const result = await library.move(selected);
    selected = undefined;
    return result;
  });
  ipcMain.handle('library:choose-existing', async (event) => {
    requireWindow(event, true);
    existing = undefined;
    const result = await dialog.showOpenDialog(getWindow(), { title: '打开已有音乐库（含 library.json 的文件夹，也可选择 Data）', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const preview = await library.inspect(result.filePaths[0]);
    existing = preview.path;
    return preview;
  });
  ipcMain.handle('library:use-existing', async (event) => {
    requireWindow(event, true);
    if (!existing) throw new Error('请先选择已有音乐库。');
    const result = await library.useExisting(existing);
    existing = undefined;
    setTimeout(() => {
      const window = getWindow();
      if (window && !window.isDestroyed()) window.webContents.reload();
    }, 100);
    return result;
  });
  ipcMain.handle('library:open', async (event) => {
    requireWindow(event, true);
    const location = library.location();
    const error = await shell.openPath(location.path);
    if (error) throw new Error(`无法打开音乐库目录：${error}`);
  });
};
