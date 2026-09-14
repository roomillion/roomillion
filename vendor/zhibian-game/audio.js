(function (global) {
  "use strict";

  function create() {
    let context = null;
    const ensure = async () => {
      if (!context) context = new (global.AudioContext || global.webkitAudioContext)();
      if (context.state === "suspended") await context.resume();
      return context;
    };
    const tone = async (kind = "collect") => {
      const ctx = await ensure();
      const now = ctx.currentTime;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const presets = {
        collect: [660, 880, 0.11, "sine"],
        jump: [240, 420, 0.09, "square"],
        win: [520, 1040, 0.42, "triangle"],
        fail: [180, 90, 0.28, "sawtooth"]
      };
      const [from, to, duration, type] = presets[kind] || presets.collect;
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(from, now);
      oscillator.frequency.exponentialRampToValueAtTime(to, now + duration);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.14, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(now);
      oscillator.stop(now + duration + 0.02);
    };
    return Object.freeze({ resume: ensure, tone, dispose: () => context?.close() });
  }

  global.ZhibianAudio = Object.freeze({ create });
})(globalThis);
