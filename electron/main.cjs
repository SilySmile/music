const { app, BrowserWindow, session, ipcMain, screen, net, globalShortcut, safeStorage, dialog, shell, Tray, nativeImage, protocol } = require('electron');
const path = require('node:path');
const { timedWords } = require('./lyric-timing.cjs');
const fs = require('node:fs/promises');

app.setAppUserModelId('com.tingyu.music');
protocol.registerSchemesAsPrivileged([{ scheme: 'xianqiji', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const testing = process.env.TINGYU_TEST === '1';
// Keep the external Windows temp path before redirecting ordinary app data.
// Installers and their uninstallers must never inherit Data/Temp.
const installerTempRoot = app.getPath('temp');
const syncFs = require('node:fs');
const { profilePath, migrateProfile } = require('./profile.cjs');
const dataPath = profilePath({ packaged: app.isPackaged, executable: process.execPath, portableDirectory: process.env.PORTABLE_EXECUTABLE_DIR, workspace: path.join(__dirname, '..'), testing, testData: process.env.TINGYU_TEST_DATA });
const legacyPath = path.join(app.getPath('appData'), '\u542c\u5c7f\u97f3\u4e50');
if (!testing && !syncFs.existsSync(dataPath) && syncFs.existsSync(legacyPath)) {
  const choice = dialog.showMessageBoxSync({ type: 'question', buttons: ['旧版已退出，复制数据', '暂不启动'], defaultId: 0, cancelId: 1, title: '迁移旧版音乐数据', message: '请先从托盘退出旧版播放器。', detail: `将复制并校验旧数据到 ${dataPath}，旧目录暂不删除。请确保空间充足且磁盘稳定。` });
  if (choice !== 0) app.exit(0);
  else { try { migrateProfile(legacyPath, dataPath); } catch (error) { dialog.showErrorBox('迁移未完成，旧数据保留', error.message); app.exit(1); } }
}
for (const name of ['', 'Temp', 'Logs', 'CrashDumps', '下载', '导出']) syncFs.mkdirSync(path.join(dataPath, name), { recursive: true });
app.setPath('userData', dataPath);
app.setPath('sessionData', dataPath);
app.setPath('temp', path.join(dataPath, 'Temp'));
app.setPath('crashDumps', path.join(dataPath, 'CrashDumps'));
app.setPath('downloads', path.join(dataPath, '下载'));
app.setAppLogsPath(path.join(dataPath, 'Logs'));
process.env.TEMP = path.join(dataPath, 'Temp');
process.env.TMP = process.env.TEMP;
if (testing) app.disableHardwareAcceleration();

let mainWindow;
let desktopWindow;
let trayMenuWindow;
let trayMenuRequested = false;
let appPreferences = { closeAction: 'tray' };
let snapshot = null;
let desktopState = { visible: false, locked: false, theme: 'gold', fontSize: 34, opacity: 1, layout: 'horizontal', verticalContent: 'auto', lineGap: 24 };
let desktopBounds;
let desktopLayoutBounds = {};
let saveQueue = Promise.resolve();
let boundsTimer;
let pointerTimer;
let tray;
let quitting = false;
const shortcuts = require('./shortcuts.cjs')({ directory: dataPath, globalShortcut, dispatch: (action) => {
  if (action === 'show-main') { if (mainWindow?.isVisible() && !mainWindow.isMinimized()) mainWindow.hide(); else showMain(); }
  else if (action === 'desktop-toggle') setVisible(!desktopState.visible);
  else if (action === 'desktop-lock') { if (desktopState.visible) setLocked(!desktopState.locked); }
  else if (['play-pause', 'previous', 'next'].includes(action)) mainWindow?.webContents.send('desktop:control', action);
  else mainWindow?.webContents.send('tray:control', { action });
} });
const desktopPointer = require('./desktop-pointer.cjs')({ getWindow: () => desktopWindow, getState: () => desktopState, getCursor: () => screen.getCursorScreenPoint() });
const onlineSource = require('./online-source.cjs')({ directory: dataPath, safeStorage, fetch: (...parameters) => net.fetch(...parameters) });

function persistPreferences() {
  const contents = JSON.stringify({ ...desktopState, bounds: desktopBounds, layoutBounds: desktopLayoutBounds, appPreferences });
  const saved = saveQueue.then(() => fs.writeFile(path.join(app.getPath('userData'), 'desktop-lyrics.json'), contents));
  saveQueue = saved.catch(() => {});
  return saved;
}

function broadcastState() {
  for (const window of [mainWindow, desktopWindow, trayMenuWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('desktop:state', desktopState);
  }
  persistPreferences();
  desktopPointer.update(true);
  return { ...desktopState };
}

function requireWindow(event, mainOnly = false) {
  const main = mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
  const desktop = desktopWindow && !desktopWindow.isDestroyed() && event.sender === desktopWindow.webContents;
  const popup = trayMenuWindow && !trayMenuWindow.isDestroyed() && event.sender === trayMenuWindow.webContents;
  if (!main && (mainOnly || (!desktop && !popup))) throw new Error('无效的窗口请求');
}

function webPreferences() {
  return { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: testing, backgroundThrottling: false };
}

function protectWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
}

function showMain() {
  hideTrayMenu();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!testing) { mainWindow.show(); mainWindow.focus(); }
}

function ensureTray() {
  if (tray && !tray.isDestroyed()) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, '../dist/icon.png')).resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip('弦栖霁 · 音乐正在这里');
  tray.on('right-click', (_event, bounds) => showTrayMenu(bounds));
  tray.on('click', showMain);
  tray.on('double-click', showMain);
}

function hideTrayMenu() {
  trayMenuRequested = false;
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) trayMenuWindow.hide();
}

function showTrayMenu(anchor = tray.getBounds()) {
  trayMenuRequested = true;
  if (!trayMenuWindow || trayMenuWindow.isDestroyed()) {
    trayMenuWindow = new BrowserWindow({ width: 304, height: 400, show: false, frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: true, title: '弦栖霁 · 托盘菜单', backgroundColor: '#00000000', webPreferences: webPreferences() });
    protectWindow(trayMenuWindow);
    trayMenuWindow.on('blur', hideTrayMenu);
    trayMenuWindow.on('closed', () => { trayMenuWindow = undefined; });
    trayMenuWindow.webContents.on('did-finish-load', () => {
      trayMenuWindow.webContents.send('desktop:state', desktopState);
      if (snapshot) trayMenuWindow.webContents.send('desktop:snapshot', snapshot);
      if (trayMenuRequested && !testing) { trayMenuWindow.show(); trayMenuWindow.focus(); }
    });
    trayMenuWindow.loadFile(path.join(__dirname, '../dist/index.html'), { hash: 'tray-menu' });
  }
  const center = { x: Math.round(anchor.x + anchor.width / 2), y: Math.round(anchor.y + anchor.height / 2) };
  const area = screen.getDisplayNearestPoint(center).workArea;
  const width = Math.min(304, area.width - 16);
  const height = Math.min(400, area.height - 16);
  const top = center.y > area.y + area.height / 2 ? anchor.y - height - 5 : anchor.y + anchor.height + 5;
  trayMenuWindow.setBounds({ x: Math.round(Math.max(area.x + 8, Math.min(area.x + area.width - width - 8, center.x - width / 2))), y: Math.round(Math.max(area.y + 8, Math.min(area.y + area.height - height - 8, top))), width, height });
  if (!testing && !trayMenuWindow.webContents.isLoading()) { trayMenuWindow.show(); trayMenuWindow.focus(); }
}

function hideToTray() {
  ensureTray();
  mainWindow?.hide();
}

function createDesktopWindow() {
  if (desktopWindow && !desktopWindow.isDestroyed()) return desktopWindow;
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = Math.min(920, workArea.width);
  const initial = desktopState.layout === 'vertical'
    ? { x: workArea.x + Math.round((workArea.width - 160) / 2), y: workArea.y + Math.round((workArea.height - Math.min(720, workArea.height)) / 2), width: 160, height: Math.min(720, workArea.height) }
    : { x: workArea.x + Math.round((workArea.width - width) / 2), y: workArea.y + workArea.height - 220, width, height: 180 };
  const saved = desktopLayoutBounds[desktopState.layout] || desktopBounds;
  const visibleOnScreen = saved && screen.getAllDisplays().some(({ workArea: area }) => saved.x + saved.width > area.x + 60 && saved.x < area.x + area.width - 60 && saved.y + saved.height > area.y + 40 && saved.y < area.y + area.height - 40);
  desktopWindow = new BrowserWindow({ ...(visibleOnScreen ? saved : initial), minWidth: 120, minHeight: 130, maxHeight: Math.max(800, workArea.height), show: false, title: '弦栖霁 · 桌面歌词', frame: false, transparent: true, hasShadow: false, alwaysOnTop: true, skipTaskbar: true, resizable: true, backgroundColor: '#00000000', webPreferences: webPreferences() });
  protectWindow(desktopWindow);
  desktopWindow.setIgnoreMouseEvents(true, { forward: true });
  desktopWindow.webContents.on('did-finish-load', () => {
    if (snapshot) desktopWindow.webContents.send('desktop:snapshot', snapshot);
    desktopWindow.webContents.send('desktop:state', desktopState);
    if (desktopState.visible && !testing) desktopWindow.showInactive();
  });
  const rememberBounds = () => {
    desktopBounds = desktopWindow.getBounds();
    desktopLayoutBounds[desktopState.layout] = desktopBounds;
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(persistPreferences, 400);
  };
  desktopWindow.on('moved', rememberBounds);
  desktopWindow.on('resized', rememberBounds);
  desktopWindow.on('closed', () => { desktopWindow = undefined; desktopPointer.reset(); });
  desktopWindow.loadFile(path.join(__dirname, '../dist/index.html'), { hash: 'desktop-lyrics' });
  return desktopWindow;
}

function setVisible(visible) {
  desktopState.visible = visible;
  if (visible) {
    const window = createDesktopWindow();
    if (!testing && !window.webContents.isLoading()) window.showInactive();
  } else desktopWindow?.hide();
  return broadcastState();
}

function setLocked(locked) {
  desktopState.locked = locked;
  return broadcastState();
}

function setDesktopLayout(layout) {
  if (layout === desktopState.layout) return;
  const previous = desktopState.layout;
  const current = desktopWindow && !desktopWindow.isDestroyed() ? desktopWindow.getBounds() : desktopBounds;
  if (current) desktopLayoutBounds[previous] = current;
  desktopState.layout = layout;
  if (!desktopWindow || desktopWindow.isDestroyed()) return;
  const area = screen.getDisplayMatching(current || desktopWindow.getBounds()).workArea;
  const width = Math.min(area.width, layout === 'vertical' ? 160 : 920);
  const height = Math.min(area.height, layout === 'vertical' ? 720 : 180);
  const preferred = desktopLayoutBounds[layout] || { x: Math.round((current?.x ?? area.x) + (current?.width ?? width) / 2 - width / 2), y: Math.round((current?.y ?? area.y) + (current?.height ?? height) / 2 - height / 2), width, height };
  const fitted = { width: Math.max(120, Math.min(area.width, preferred.width)), height: Math.max(130, Math.min(area.height, preferred.height)) };
  desktopWindow.setBounds({ x: Math.max(area.x, Math.min(area.x + area.width - fitted.width, preferred.x)), y: Math.max(area.y, Math.min(area.y + area.height - fitted.height, preferred.y)), ...fitted });
  desktopBounds = desktopWindow.getBounds();
  desktopLayoutBounds[layout] = desktopBounds;
}

async function readJson(response) {
  if (!response.ok) {
    if (response.status === 401) throw new Error('API Key 无效，请检查翻译配置。');
    if (response.status === 402 || response.status === 429) throw new Error('服务余额不足或达到限额，请检查额度后重试。');
    throw new Error(`服务暂不可用（HTTP ${response.status}）`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2 * 1024 * 1024) throw new Error('服务返回内容过大');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function installIpc() {
  const audioAI = require('./audio-alignment.cjs')({ fetch: (...args) => net.fetch(...args) });
  ipcMain.handle('network:audio-ai', async (event, request) => { requireWindow(event, true); return audioAI.request(request); });
  ipcMain.handle('network:cancel-audio-ai', (event, id) => { requireWindow(event, true); audioAI.cancel(id); });
  ipcMain.handle('network:forced-health', (event, config) => { requireWindow(event, true); return audioAI.check(config); });
  require('./update-ipc.cjs')({ app, ipcMain, net, requireWindow, getWindow: () => mainWindow, shell, testing, installerTempRoot });
  require('./library-ipc.cjs')({ app, ipcMain, dialog, shell, requireWindow, getWindow: () => mainWindow });
  require('./transfers.cjs')({ app, ipcMain, dialog, shell, requireWindow, getWindow: () => mainWindow, testing });
  const keyPath = path.join(app.getPath('userData'), 'ai-config.json');
  ipcMain.handle('source:get-config', (event) => { requireWindow(event, true); return onlineSource.get(); });
  ipcMain.handle('source:save-config', (event, value) => { requireWindow(event, true); return onlineSource.save(value); });
  ipcMain.handle('source:request', (event, request) => { requireWindow(event, true); return onlineSource.request(request); });
  const legacyKeyPath = path.join(app.getPath('userData'), 'translation-key.bin');
  ipcMain.handle('shortcuts:get', (event) => { requireWindow(event, true); return shortcuts.get(); });
  ipcMain.handle('shortcuts:save', (event, value) => { requireWindow(event, true); return shortcuts.save(value); });
  ipcMain.handle('shortcuts:defaults', (event) => { requireWindow(event, true); return shortcuts.defaults(); });
  ipcMain.handle('app:get-preferences', (event) => { requireWindow(event, true); return { ...appPreferences }; });
  ipcMain.handle('app:set-preferences', async (event, value) => {
    requireWindow(event, true);
    if (!value || !['tray', 'quit'].includes(value.closeAction)) throw new Error('无效的关闭方式');
    const previous = appPreferences;
    appPreferences = { closeAction: value.closeAction };
    try { await persistPreferences(); }
    catch { appPreferences = previous; throw new Error('关闭方式保存失败，请检查磁盘状态。'); }
    mainWindow.webContents.send('app:preferences', appPreferences);
    return { ...appPreferences };
  });
  ipcMain.on('tray:hide', (event) => { if (trayMenuWindow && event.sender === trayMenuWindow.webContents) hideTrayMenu(); });
  ipcMain.on('tray:control', (event, request) => {
    if (!trayMenuWindow || event.sender !== trayMenuWindow.webContents || !request || typeof request !== 'object') return;
    const { action, value } = request;
    if (action === 'quit') { app.quit(); return; }
    if (action === 'desktop-toggle') { setVisible(!desktopState.visible); return; }
    if (action === 'settings' || action === 'show-main') {
      showMain();
      mainWindow?.webContents.send('desktop:control', action);
      return;
    }
    if (['play-pause', 'previous', 'next'].includes(action)) mainWindow?.webContents.send('desktop:control', action);
    else if (['toggle-favorite', 'cycle-mode'].includes(action)) mainWindow?.webContents.send('tray:control', { action });
    else if (action === 'set-volume' && Number.isFinite(value)) mainWindow?.webContents.send('tray:control', { action, value: Math.max(0, Math.min(1, value)) });
  });
  ipcMain.handle('ai:get-key', async (event) => {
    requireWindow(event, true);
    if (!safeStorage.isEncryptionAvailable()) return '';
    try {
      let encrypted;
      try { const envelope = JSON.parse(await fs.readFile(keyPath, 'utf8')); if (envelope.encryption !== 'Windows-DPAPI') throw new Error('不支持的加密格式'); encrypted = Buffer.from(envelope.ciphertext, 'base64'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; encrypted = await fs.readFile(legacyKeyPath); }
      const key = safeStorage.decryptString(encrypted);
      try {
        await fs.access(keyPath);
      } catch {
        const temporary = `${keyPath}.tmp`;
        await fs.writeFile(temporary, JSON.stringify({ version: 1, encryption: 'Windows-DPAPI', ciphertext: encrypted.toString('base64') }, null, 2));
        await fs.rename(temporary, keyPath);
      }
      return key;
    } catch (error) { if (error.code === 'ENOENT') return ''; throw new Error('已保存的密钥无法解密，请在当前 Windows 账户重新填写。'); }
  });
  ipcMain.handle('ai:save-key', async (event, key) => {
    requireWindow(event, true);
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，请仅在本次运行中使用密钥。');
    if (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[\r\n]/.test(key)) throw new Error('无效的 API Key');
    const temporary = `${keyPath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ version: 1, encryption: 'Windows-DPAPI', ciphertext: safeStorage.encryptString(key.trim()).toString('base64') }, null, 2));
    await fs.rename(temporary, keyPath);
  });
  ipcMain.handle('ai:clear-key', async (event) => { requireWindow(event, true); await fs.rm(keyPath, { force: true }); await fs.rm(legacyKeyPath, { force: true }); });
  ipcMain.handle('desktop:get-state', (event) => { requireWindow(event); return { ...desktopState }; });
  ipcMain.handle('desktop:get-snapshot', (event) => { requireWindow(event); return snapshot; });
  ipcMain.on('desktop:hit-regions', (event, regions) => {
    if (desktopWindow && !desktopWindow.isDestroyed() && event.sender === desktopWindow.webContents) desktopPointer.setRegions(regions);
  });
  ipcMain.handle('desktop:set-visible', (event, visible) => { requireWindow(event); return setVisible(visible === true); });
  ipcMain.handle('desktop:set-locked', (event, locked) => { requireWindow(event); return setLocked(locked === true); });
  ipcMain.handle('desktop:set-style', (event, style) => {
    requireWindow(event);
    if (!style || typeof style !== 'object') throw new Error('无效的歌词样式');
    if (['gold', 'cyan', 'green', 'coral'].includes(style.theme)) desktopState.theme = style.theme;
    if (Number.isFinite(style.fontSize)) desktopState.fontSize = Math.round(Math.max(20, Math.min(60, style.fontSize)));
    if (Number.isFinite(style.opacity)) desktopState.opacity = Math.max(0.45, Math.min(1, style.opacity));
    if (['horizontal', 'vertical'].includes(style.layout)) setDesktopLayout(style.layout);
    if (['auto', 'next', 'translation'].includes(style.verticalContent)) desktopState.verticalContent = style.verticalContent;
    if (Number.isFinite(style.lineGap)) desktopState.lineGap = Math.round(Math.max(8, Math.min(48, style.lineGap)));
    return broadcastState();
  });
  ipcMain.on('desktop:update', (event, value) => {
    requireWindow(event, true);
    if (!value || typeof value !== 'object') return;
    const text = (key, maximum) => typeof value[key] === 'string' ? value[key].slice(0, maximum) : '';
    const number = (key) => Number.isFinite(value[key]) ? Math.max(0, value[key]) : 0;
    snapshot = { title: text('title', 300), artist: text('artist', 300), text: text('text', 2000), translation: text('translation', 2000), nextText: text('nextText', 2000), previousText: text('previousText', 2000), lineIndex: Math.floor(number('lineIndex')), lineStart: number('lineStart'), lineEnd: number('lineEnd'), words: timedWords({ time: number('lineStart'), text: text('text', 2000), words: value.words })?.map(({time, endTime, text}) => ({time, endTime, text})), wordTiming: value.wordTiming === 'estimated' ? 'estimated' : undefined, advancing: value.advancing === true, playbackRate: Math.max(0.25, Math.min(4, Number(value.playbackRate) || 1)), position: number('position'), duration: number('duration'), playing: value.playing === true, showTranslation: value.showTranslation === true, favorite: value.favorite === true, volume: Math.min(1, number('volume')), mode: ['list', 'shuffle', 'one'].includes(value.mode) ? value.mode : 'list', hasTrack: value.hasTrack === true };
    for (const window of [desktopWindow, trayMenuWindow]) if (window && !window.isDestroyed()) window.webContents.send('desktop:snapshot', snapshot);
  });
  ipcMain.on('desktop:control', (event, action) => {
    requireWindow(event);
    if (action === 'quit') { app.quit(); return; }
    if (action === 'minimize') {
      hideToTray();
      return;
    }
    if (!['play-pause', 'previous', 'next', 'settings', 'show-main'].includes(action)) return;
    if (action === 'settings' || action === 'show-main') showMain();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:control', action);
  });
  ipcMain.handle('network:get', async (event, request) => {
    requireWindow(event, true);
    if (!request || typeof request !== 'object' || !request.params || typeof request.params !== 'object') throw new Error('无效的联网请求');
    let url;
    if (request.service === 'lyrics') {
      url = new URL('https://lrclib.net/api/search');
      for (const key of ['track_name', 'artist_name']) {
        if (typeof request.params[key] === 'string') url.searchParams.set(key, request.params[key].slice(0, 200));
      }
      if (!url.searchParams.get('track_name')) throw new Error('请填写歌名');
    } else if (request.service === 'translation') {
      const { q: query, langpair } = request.params;
      if (typeof query !== 'string' || !query.trim() || Buffer.byteLength(query, 'utf8') > 500 || typeof langpair !== 'string' || !/^(autodetect|en|ja|ko|fr|es|de|it|ru|pt)\|zh-CN$/.test(langpair)) throw new Error('无效的翻译参数');
      url = new URL('https://api.mymemory.translated.net/get');
      url.searchParams.set('q', query);
      url.searchParams.set('langpair', langpair);
    } else throw new Error('不支持的联网服务');
    return readJson(await net.fetch(url.href, { signal: AbortSignal.timeout(18000), redirect: 'error', credentials: 'omit', headers: { 'User-Agent': 'TingyuMusic/0.2.0' } }));
  });
  ipcMain.handle('network:ai', async (event, request) => {
    requireWindow(event, true);
    if (!request || typeof request !== 'object') throw new Error('无效的翻译请求');
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/chat/completions')) throw new Error('AI 接口必须是 HTTPS 的 chat/completions 地址');
    if (typeof request.key !== 'string' || !request.key.trim() || request.key.length > 1000 || /[\r\n]/.test(request.key)) throw new Error('请填写有效的 API Key');
    if (!request.body || typeof request.body !== 'object' || JSON.stringify(request.body).length > 60000) throw new Error('AI 翻译请求过大');
    return readJson(await net.fetch(url.href, { method: 'POST', signal: AbortSignal.timeout(90000), redirect: 'error', credentials: 'omit', headers: { Authorization: `Bearer ${request.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request.body) }));
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({ show: !testing, width: 1440, height: 960, minWidth: 900, minHeight: 680, title: '弦栖霁', backgroundColor: '#f5f3ee', icon: path.join(__dirname, '../dist/icon.png'), autoHideMenuBar: true, webPreferences: webPreferences() });
  protectWindow(mainWindow);
  mainWindow.on('close', (event) => {
    if (quitting || appPreferences.closeAction === 'quit') return;
    event.preventDefault();
    hideToTray();
  });
  mainWindow.on('closed', () => { desktopWindow?.destroy(); trayMenuWindow?.destroy(); mainWindow = undefined; });
  mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showMain);
  app.whenReady().then(async () => {
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    try {
      const saved = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'desktop-lyrics.json'), 'utf8'));
      appPreferences = { closeAction: saved.appPreferences?.closeAction === 'quit' ? 'quit' : 'tray' };
      desktopState = { visible: saved.visible === true, locked: saved.locked === true, theme: ['gold', 'cyan', 'green', 'coral'].includes(saved.theme) ? saved.theme : 'gold', fontSize: Number.isFinite(saved.fontSize) ? Math.max(20, Math.min(60, saved.fontSize)) : 34, opacity: Number.isFinite(saved.opacity) ? Math.max(0.45, Math.min(1, saved.opacity)) : 1, layout: ['horizontal', 'vertical'].includes(saved.layout) ? saved.layout : 'horizontal', verticalContent: saved.verticalContent === 'translation' ? 'translation' : Number.isFinite(saved.lineGap) && saved.verticalContent === 'next' ? 'next' : 'auto', lineGap: Number.isFinite(saved.lineGap) ? Math.max(8, Math.min(48, saved.lineGap)) : 24 };
      const validBounds = (bounds) => bounds && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key]));
      const sanitizeBounds = (bounds) => ({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(Math.max(120, Math.min(2400, bounds.width))), height: Math.round(Math.max(130, Math.min(1600, bounds.height))) });
      if (validBounds(saved.bounds)) desktopBounds = sanitizeBounds(saved.bounds);
      for (const layout of ['horizontal', 'vertical']) if (validBounds(saved.layoutBounds?.[layout])) desktopLayoutBounds[layout] = sanitizeBounds(saved.layoutBounds[layout]);
    } catch {}
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.on('will-download', (_event, item, contents) => {
      if (!mainWindow || contents !== mainWindow.webContents) { item.cancel(); return; }
      if (testing) item.setSavePath(path.join(app.getPath('userData'), path.basename(item.getFilename())));
      else item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
    });
    installIpc();
    createWindow();
    if (desktopState.visible) createDesktopWindow();
    pointerTimer = setInterval(() => desktopPointer.update(), 32);
    await shortcuts.load();
    app.on('activate', () => { if (!mainWindow || mainWindow.isDestroyed()) createWindow(); });
  });
}
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { clearTimeout(boundsTimer); clearInterval(pointerTimer); tray?.destroy(); globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
