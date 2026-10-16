module.exports = function createDesktopPointer({ getWindow, getState, getCursor }) {
  let regions = [];
  let previousWindow;
  let previousInside;
  let previousIgnoring;

  function update(force = false) {
    const window = getWindow();
    if (!window || window.isDestroyed()) return { inside: false, interactive: false };
    if (window !== previousWindow) {
      previousWindow = window;
      previousInside = undefined;
      previousIgnoring = undefined;
    }
    const state = getState();
    const bounds = window.getContentBounds();
    const cursor = getCursor();
    const position = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
    const zoom = window.webContents.getZoomFactor();
    const inside = state.visible && position.x >= 0 && position.y >= 0 && position.x < bounds.width && position.y < bounds.height;
    const interactive = inside && regions.some((region) => region.kind === (state.locked ? 'unlock' : 'toolbar') && position.x >= region.x * zoom && position.y >= region.y * zoom && position.x < (region.x + region.width) * zoom && position.y < (region.y + region.height) * zoom);
    if (previousIgnoring !== !interactive) {
      window.setIgnoreMouseEvents(!interactive, { forward: true });
      previousIgnoring = !interactive;
    }
    if (force || previousInside !== inside) {
      window.webContents.send('desktop:pointer', inside);
      previousInside = inside;
    }
    return { inside, interactive };
  }

  function setRegions(value) {
    regions = Array.isArray(value) ? value.slice(0, 16).filter((region) => region && ['toolbar', 'unlock'].includes(region.kind) && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(region[key])) && region.width > 0 && region.height > 0).map((region) => ({ kind: region.kind, x: Math.max(0, region.x), y: Math.max(0, region.y), width: Math.min(2400, region.width), height: Math.min(1600, region.height) })) : [];
    return update(true);
  }

  function reset() {
    regions = [];
    previousWindow = undefined;
    previousInside = undefined;
    previousIgnoring = undefined;
  }

  return { update, setRegions, reset };
};
