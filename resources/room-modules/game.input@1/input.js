(function (global) {
  "use strict";

  function create(target = global) {
    const held = new Set();
    const pressed = new Set();
    const virtual = new Set();
    const blocked = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"]);
    const onKeyDown = (event) => {
      if (!held.has(event.code)) pressed.add(event.code);
      held.add(event.code);
      if (blocked.has(event.code)) event.preventDefault();
    };
    const onKeyUp = (event) => {
      held.delete(event.code);
      if (blocked.has(event.code)) event.preventDefault();
    };
    const onBlur = () => { held.clear(); virtual.clear(); };
    target.addEventListener("keydown", onKeyDown);
    target.addEventListener("keyup", onKeyUp);
    global.addEventListener("blur", onBlur);

    return Object.freeze({
      down: (code) => held.has(code) || virtual.has(code),
      consume: (code) => {
        const value = pressed.has(code);
        pressed.delete(code);
        return value;
      },
      axis: (negative, positive) => Number(held.has(positive) || virtual.has(positive)) - Number(held.has(negative) || virtual.has(negative)),
      setVirtual: (code, active) => active ? virtual.add(code) : virtual.delete(code),
      clearVirtual: () => virtual.clear(),
      dispose: () => {
        target.removeEventListener("keydown", onKeyDown);
        target.removeEventListener("keyup", onKeyUp);
        global.removeEventListener("blur", onBlur);
        held.clear(); pressed.clear(); virtual.clear();
      }
    });
  }

  global.ZhibianInput = Object.freeze({ create });
})(globalThis);
