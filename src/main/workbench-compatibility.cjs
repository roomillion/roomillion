"use strict";
const currentVersion = require("../../package.json").version;
function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(String(value));
  if (!match || match.slice(1, 4).some(n => !Number.isSafeInteger(Number(n)))) throw new Error("最低工作台版本必须是有效语义版本");
  const pre = match[4]?.split(".") || [];
  if (pre.some(p => /^\d+$/.test(p) && (p.length > 1 && p.startsWith("0") || !Number.isSafeInteger(Number(p))))) throw new Error("预发布版本号无效");
  return { core: match.slice(1, 4).map(Number), pre };
}
function compare(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return Math.sign(a.core[i] - b.core[i]);
  if (!a.pre.length || !b.pre.length) return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Math.sign(Number(x) - Number(y));
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
function assertWorkbenchCompatible(manifest, version = currentVersion) {
  const minimum = manifest.runtime?.minimumWorkbench;
  if (compare(version, minimum) < 0) throw new Error(`此房间需要千万间 Roomillion ${minimum} 或更新版本；当前 ${version}，请先升级工作台`);
}
module.exports = { currentVersion, parseVersion, compare, assertWorkbenchCompatible };
