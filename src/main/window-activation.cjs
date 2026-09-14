"use strict";

function activateWindow(window, contents = window?.webContents) {
  if (!window || window.isDestroyed?.()) return false;
  if (window.isMinimized?.()) window.restore();
  window.show?.();
  window.moveTop?.();
  window.focus?.();
  if (contents && !contents.isDestroyed?.()) contents.focus?.();
  return true;
}

module.exports = { activateWindow };
