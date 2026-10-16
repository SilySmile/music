const fs = require('node:fs/promises');
const path = require('node:path');

const defaults = { enabled: true, bindings: { 'play-pause': 'Ctrl+Alt+P', previous: 'Ctrl+Alt+Left', next: 'Ctrl+Alt+Right', 'volume-up': 'Ctrl+Alt+Up', 'volume-down': 'Ctrl+Alt+Down', 'toggle-favorite': 'Ctrl+Alt+V', 'show-main': 'Ctrl+Alt+Q', 'desktop-toggle': 'Ctrl+Alt+W', 'desktop-lock': 'Ctrl+Alt+L', 'cycle-mode': 'Ctrl+Alt+M' } };
function normalize(value) {
  if (typeof value !== 'string') throw new Error('快捷键格式无效');
  if (!value.trim()) return '';
  const parts = value.split('+').map((part) => part.trim());
  const key = parts.pop();
  const aliases = { Control: 'Ctrl', CommandOrControl: 'Ctrl', Meta: 'Super' };
  const modifiers = parts.map((part) => aliases[part] || part);
  if (!modifiers.length || modifiers.some((modifier) => !['Ctrl', 'Alt', 'Shift', 'Super'].includes(modifier)) || new Set(modifiers).size !== modifiers.length || !/^(?:[A-Za-z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Left|Right|Up|Down|Space|Home|End|PageUp|PageDown|Insert|Delete)$/.test(key || '')) throw new Error('请使用 Ctrl / Alt / Shift / Win 与按键的组合');
  return [...['Ctrl', 'Alt', 'Shift', 'Super'].filter((modifier) => modifiers.includes(modifier)), key.length === 1 ? key.toUpperCase() : key].join('+');
}

module.exports = function createShortcuts({ directory, globalShortcut, dispatch }) {
  const filename = path.join(directory, 'shortcuts.json');
  let config = structuredClone(defaults);
  let status = {};
  const active = new Set();
  function apply() {
    for (const accelerator of active) globalShortcut.unregister(accelerator);
    active.clear(); status = {};
    for (const [action, accelerator] of Object.entries(config.bindings)) {
      if (!config.enabled || !accelerator) { status[action] = 'disabled'; continue; }
      if (active.has(accelerator)) { status[action] = 'conflict'; continue; }
      let registered = false;
      try { registered = globalShortcut.register(accelerator, () => dispatch(action)); } catch {}
      status[action] = registered ? 'ok' : 'conflict';
      if (registered) active.add(accelerator);
    }
  }
  const info = () => ({ ...structuredClone(config), status: { ...status }, path: filename });
  return {
    async load() {
      try {
        const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
        config.enabled = saved.enabled !== false;
        for (const action of Object.keys(defaults.bindings)) if (typeof saved.bindings?.[action] === 'string') { try { config.bindings[action] = normalize(saved.bindings[action]); } catch {} }
      } catch {}
      apply(); return info();
    },
    get: info,
    async save(value) {
      if (!value || typeof value.enabled !== 'boolean' || !value.bindings) throw new Error('快捷键配置无效');
      const bindings = {};
      for (const action of Object.keys(defaults.bindings)) bindings[action] = normalize(value.bindings[action] ?? '');
      const previous = config;
      config = { enabled: value.enabled, bindings }; apply();
      const temporary = `${filename}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify(config, null, 2)); await fs.rename(temporary, filename); }
      catch (error) { config = previous; apply(); await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
      return info();
    },
    defaults: () => structuredClone(defaults),
  };
};
module.exports.normalize = normalize;
