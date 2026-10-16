module.exports = function installUpdates({ app, ipcMain, net, requireWindow, getWindow, shell, testing }) {
  const trustConfig = testing && process.env.TINGYU_UPDATE_TEST_PUBLIC_KEY ? { ...require('../updates/public.json'), publicKey: Buffer.from(process.env.TINGYU_UPDATE_TEST_PUBLIC_KEY, 'base64').toString('utf8') } : undefined;
  const updates = require('./updates.cjs')({ app, fetch: (...parameters) => net.fetch(...parameters), progress: (state) => getWindow()?.webContents.send('updates:state', state), testing, trustConfig });
  for (const method of ['config', 'saveConfig', 'check', 'download', 'pause', 'state']) ipcMain.handle(`updates:${method}`, (event, value) => { requireWindow(event, true); return updates[method](value); });
  ipcMain.handle('updates:install', async (event) => {
    requireWindow(event, true);
    const result = await updates.install();
    if (result.portable) shell.showItemInFolder(result.path);
    return result;
  });
  app.on('before-quit', () => updates.pause());
};
