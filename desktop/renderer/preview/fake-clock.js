// A virtual clock for the motion check (motion-check.cjs, first-run-polish B2.5). Loaded as a classic script before
// the bridge and the panel, it replaces setTimeout, setInterval, their clears and performance.now with versions on a
// clock that starts at 0 and moves only through window.__clock.tick(ms). Each tick also holds every animation on the
// page to that clock: one not seen before is paused and starts now; a seen one is set to (now - its start). So a
// motion is measured frame by frame, the same on every run, however slow the machine. panel.js and setup.js do not
// change for it.
(() => {
  const real = { now: performance.now.bind(performance), raf: window.requestAnimationFrame.bind(window) };
  const timers = new Map();
  let now = 0;
  let order = 0;
  let nextId = 1;
  const delayOf = (ms) => Math.max(0, Number(ms) || 0);
  window.setTimeout = (fn, ms, ...args) => { const id = nextId++; timers.set(id, { at: now + delayOf(ms), fn, args, every: 0, order: order++ }); return id; };
  window.setInterval = (fn, ms, ...args) => { const id = nextId++; const every = Math.max(1, delayOf(ms)); timers.set(id, { at: now + every, fn, args, every, order: order++ }); return id; };
  window.clearTimeout = (id) => { timers.delete(id); };
  window.clearInterval = (id) => { timers.delete(id); };
  performance.now = () => now;

  // A real macrotask: every promise the last timer or press started settles before the clock looks at the page.
  const settle = () => new Promise((resolve) => { const channel = new MessageChannel(); channel.port1.onmessage = () => resolve(); channel.port2.postMessage(0); });
  const frame = () => new Promise((resolve) => real.raf(() => resolve()));

  const starts = new Map();
  function hold() {
    for (const animation of document.getAnimations()) {
      if (!starts.has(animation)) { animation.pause(); starts.set(animation, now); }
      animation.currentTime = now - starts.get(animation);
    }
  }
  function due(until) {
    let next = null;
    for (const [id, timer] of timers) if (timer.at <= until && (!next || timer.at < next.timer.at || (timer.at === next.timer.at && timer.order < next.timer.order))) next = { id, timer };
    return next;
  }

  async function tick(ms) {
    const until = now + delayOf(ms);
    for (let next = due(until); next; next = due(until)) {
      const { id, timer } = next;
      now = timer.at;
      if (timer.every) { timer.at += timer.every; timer.order = order++; } else timers.delete(id);
      try { if (typeof timer.fn === 'function') timer.fn(...timer.args); } catch (error) { console.error(String(error?.stack || error)); }
      await settle();
      hold();
    }
    now = until;
    await settle();
    hold();
    await frame();
    await frame();
  }
  window.__clock = {
    tick,
    get now() { return now; },
    // When an animation started on this clock (null when the clock has not seen it yet).
    startOf: (animation) => (starts.has(animation) ? starts.get(animation) : null),
    settle,
  };
})();
