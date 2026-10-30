// The motion check (first-run-polish B2.5): the real setup page on the fake bridge and a fake clock (fake-clock.js),
// in a hidden 760 x 540 window. Each trigger starts from a fresh load with a preset setup state, does one press, then
// steps the clock one 120 Hz frame at a time and measures every animation: which motion it is, that the ones the press
// must start all ran, one mover at a time, no jump, a calm speed, no pop, no text crossed, and the end state. Then the
// same trigger again under prefers-reduced-motion: nothing may animate and the end state lands at the same tick.
// A screenshot cannot see a motion that overlaps another or a pill that pops; this can. Run: npm run check:motion
// With --frames <dir> it also films the two silent clips of B2.6 into <dir>/a and <dir>/b (60 Hz PNG frames).
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { join, extname } = require('node:path');

// Gio's answer B (B2.6) flips this one line: every trigger then asserts that nothing animates, plus its end state.
const MOTION = false;
const FRAME_MS = 1000 / 120;
// A trigger is over when every animation it started has ended and nothing new started for this long (longer than
// PAY_MS, the hold between a pay line and the next card), or at the cap.
const QUIET_MS = 1000;
const CAP_MS = 8000;

const ROOT = join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
// While filming, the bridge answers each app icon with this Mac's own (read here as main.js appIcon does), so the clips
// show the marks a person sees; the measured triggers keep the bridge's made-up 1 x 1 icons.
let filmIcons = null;
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  // The real panel with the fake clock and then the stand-in bridge loaded first, so panel.js runs on virtual time.
  if (pathname === '/motion-check.html') {
    const icons = filmIcons ? '\n    <script type="module" src="preview/film-icons.js"></script>' : '';
    const html = (await readFile(join(ROOT, 'panel.html'), 'utf8')).replace('<script type="module" src="workspace.js">', `<script src="preview/fake-clock.js"></script>\n    <script type="module" src="preview/panel-bridge.js"></script>${icons}\n    <script type="module" src="workspace.js">`);
    res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    return;
  }
  if (pathname === '/preview/film-icons.js' && filmIcons) {
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(`const ICONS = ${JSON.stringify(filmIcons)};\nwindow.__data['hikyaku.appIcon'] = (app) => ICONS[app];\n`);
    return;
  }
  const path = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }).end(await readFile(path)); } catch { res.writeHead(404).end(); }
});

// The spec's Ready preset plus mailApp 'outlook' (the bridge's fresh state has none), so the mail app row is the 11th On.
const READY_PRESET = {
  step: 'ready', mailApp: 'outlook', 'permissions.calendar': 'granted', 'permissions.fullDisk': 'granted', 'permissions.microphone': 'granted', 'permissions.screen': 'granted',
  'permissions.accessibility': 'granted', 'permissions.automation': 'granted', 'keys.nebius': true, 'keys.tavily': true, 'yes.ai': true, 'mail.accounts': 2, chats: false, 'voice.answer': 'granted',
};
const press = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.textContent.trim() === ${JSON.stringify(text)}).click();`;
const OUTLOOK_TILE = `[...document.querySelectorAll('.setup-page .choice')].find((node) => node.querySelector('.su-tile-name')?.textContent === 'Outlook').click();`;
const TAVILY_KEY = `{ const box = document.querySelector('.setup-page input[data-key="tavily"]'); box.focus(); box.value = 'tvly-made-up-motion-0001'; box.dispatchEvent(new Event('input')); }`;
const checks = (list = []) => `[${list.map(([name, code]) => `[${JSON.stringify(name)}, () => (${code})]`).join(', ')}]`;
const pill = (label) => `[...document.querySelectorAll('.setup-page .su-steps li')].find((node) => node.textContent === ${JSON.stringify(label)})`;
// The Found step (first-run-polish B4): setup done with the step not answered opens it searching (the bridge's
// foundStatus); the check fires main's discover events on hikyaku.onMoved as main sends them.
const FOUND_PRESET = { ...READY_PRESET, done: true, found: 'pending' };
const fire = (outcome) => `(window.__listeners['hikyaku.onMoved'] || []).forEach((listener) => listener(${JSON.stringify(outcome)}));`;
const PROGRESS = fire({ taskId: null, phase: 'discover', text: '', done: false, data: { read: 280, total: 2214, naming: false } });
const SEARCHING = `document.querySelector('.setup-page .su-card[data-step="found"] h3')?.textContent === 'Looking through your last 30 days of mail…'`;
const FILLED = `(() => { const m = /matrix\\(([^,]+),/.exec(getComputedStyle(document.querySelector('.setup-page .su-fill > i')).transform); return !!m && Math.abs(Number(m[1]) - 280 / 2214) < 0.001; })()`;
// The speech download on Ready (first-run-polish B5): the Ready preset with the models wanted; the check fires main's
// setup.download event on hikyaku.onEntry as the run tail sends it.
const DOWNLOAD_PRESET = { ...READY_PRESET, 'speech.wanted': true };
const DOWNLOAD = `(window.__listeners['hikyaku.onEntry'] || []).forEach((listener) => listener(${JSON.stringify({ type: 'setup.download', text: 'Getting meeting transcription ready', data: { done_bytes: 412e6, total_bytes: 1460555318, state: 'downloading' } })}));`;
const SPEECH_FILLED = `(() => { const bar = document.querySelector('.setup-page li[data-row="speech"] .su-fill > i'); const m = bar && /matrix\\(([^,]+),/.exec(getComputedStyle(bar).transform); return !!m && Math.abs(Number(m[1]) - 412e6 / 1460555318) < 0.001; })()`;

// The B2 triggers (spec B2.5). `see`: the motions the press must start, in this order; `any`: true at some frame;
// `end`: true when the trigger is over (each an expression, compiled into the page script: the panel's CSP has no
// eval). B4 and B5 add theirs here.
const TRIGGERS = [
  { name: 'Start', preset: {}, action: press('.setup-page .btn-big', 'Start'), see: ['pill-move', 'card-in'],
    end: [['the Email card', `!!document.querySelector('.setup-page .su-card[data-step="email"]')`], ['the Email pill is now', `${pill('Email')}?.classList.contains('now')`]] },
  { name: 'first tile', preset: { step: 'email' }, action: OUTLOOK_TILE, see: ['lift', 'card-in'],
    end: [['Continue enabled at opacity 1', `(() => { const next = [...document.querySelectorAll('.setup-page .btn-big')].find((node) => node.textContent === 'Continue'); return !!next && !next.disabled && getComputedStyle(next).opacity === '1'; })()`],
      ['the pay line', `document.querySelector('.setup-page .su-pay')?.textContent === 'Drafts will open in Outlook, unsent.'`]] },
  { name: 'Calendar grant', preset: { step: 'calendar', mailApp: 'outlook' }, action: press('.setup-page .btn-big', 'Allow Calendar'), see: ['tick', 'card-in', 'pill-move', 'card-in'],
    any: [['the tick on the mark', `!!document.querySelector('.setup-page .su-logo .su-tick')`]], end: [['the Disk card', `!!document.querySelector('.setup-page .su-card[data-step="disk"]')`]] },
  { name: 'Full Disk', preset: { step: 'disk', mailApp: 'outlook', 'permissions.calendar': 'granted' }, action: press('.setup-page .btn-big', 'Open Full Disk Access'), see: ['mirror', 'card-in', 'pill-move', 'card-in'],
    any: [['the mirror on', `!!document.querySelector('.setup-page .su-mirror[data-on="true"]')`], ['the pay line', `[...document.querySelectorAll('.setup-page .su-pay')].some((node) => node.textContent === '2 accounts in Apple Mail')`]] },
  { name: 'second key', preset: { step: 'keys', 'keys.nebius': true }, action: TAVILY_KEY, see: ['lift'],
    end: [['Yes lifted', `(() => { const yes = document.querySelector('.setup-page .su-yes'); return !!yes && yes.classList.contains('is-lifted') && yes.classList.contains('btn-big'); })()`]] },
  { name: 'Ready', preset: READY_PRESET, action: null, see: ['card-in', 'ready cascade'],
    end: [['11 On pills at opacity 1', `(() => { const on = [...document.querySelectorAll('.setup-page .st.on')]; return on.length === 11 && on.every((node) => getComputedStyle(node).opacity === '1'); })()`]] },
  // B4: Ready to Found has no now pill, so no pill-move; the bar fills on each progress event and jumps when it lands
  // during a card-in (`settle: false` fires it 100 ms into the load's own card).
  { name: 'Found opens', preset: READY_PRESET, action: press('.setup-page .btn-big', 'Find my workspaces'), see: ['card-in'], end: [['the Found card, searching', SEARCHING]] },
  { name: 'progress', preset: FOUND_PRESET, action: PROGRESS, see: ['fill'], end: [['the bar at 280 / 2214', FILLED], ['the line', `document.querySelector('.setup-page .su-fill + .su-note')?.textContent === 'Read 280 of 2,214 email threads'`]] },
  { name: 'progress during card-in', preset: FOUND_PRESET, settle: false, action: `await window.__clock.tick(100); ${PROGRESS}`, see: ['card-in'], end: [['the bar jumped to 280 / 2214', FILLED]] },
  { name: 'look ends', preset: FOUND_PRESET, action: fire({ taskId: null, phase: 'discover', text: 'Found 2 workspaces in the last 30 days.', done: true }), see: ['card-in'],
    end: [['two found rows', `document.querySelectorAll('.setup-page .su-card[data-step="found"] li[data-name]').length === 2`]] },
  // B5: the speech row's bar fills on a download event, and jumps when the event lands during Ready's card-in.
  { name: 'download', preset: DOWNLOAD_PRESET, action: DOWNLOAD, see: ['fill'],
    end: [['the speech bar at 412e6 / 1460555318', SPEECH_FILLED], ['the label', `document.querySelector('.setup-page li[data-row="speech"] .lbl')?.textContent === 'NVIDIA speech on this Mac · 412 of 1,461 MB'`]] },
  { name: 'download during card-in', preset: DOWNLOAD_PRESET, settle: false, action: `await window.__clock.tick(100); ${DOWNLOAD}`, see: ['card-in'], end: [['the speech bar jumped to 412e6 / 1460555318', SPEECH_FILLED]] },
];

// The page side: names each animation, samples every frame and judges the run. Serialized into the page.
function pageProbe() {
  const MOVERS = new Set(['card-in', 'tick', 'mirror', 'fill']);
  const nameOf = (animation) => {
    const target = animation.effect?.target;
    const pseudo = animation.effect?.pseudoElement || '';
    const name = animation.animationName;
    const property = animation.transitionProperty;
    if (!target?.matches) return 'unknown';
    if (name === 'su-in' && target.matches('.su-card, .su-pay')) return 'card-in';
    if (name === 'su-tick') return 'tick';
    if ((name === 'su-fade-in' || name === 'su-fade-out') && target.matches('li') && pseudo === '::before') return 'pill-move';
    if ((name === 'su-label-now' || name === 'su-label-done') && target.matches('li') && !pseudo) return 'pill-move';
    if (property === 'opacity' && ((target.matches('.btn-big') && !pseudo) || (target.matches('.su-yes') && pseudo === '::before'))) return 'lift';
    if (property === 'transform' && target.matches('.su-mirror') && pseudo === '::after') return 'mirror';
    if (property === 'transform' && target.matches('.su-fill > i')) return 'fill';
    if (name === 'su-fade-in' && target.matches('.st.on')) return 'ready cascade';
    return 'unknown';
  };
  const label = (animation) => {
    const target = animation.effect?.target;
    return `${target?.tagName?.toLowerCase() || '?'}.${String(target?.className || '').trim().replace(/\s+/g, '.')}${animation.effect?.pseudoElement || ''} ${animation.animationName || animation.transitionProperty || ''}`;
  };
  const isNone = (transform) => transform === 'none' || /^matrix\(1, 0, 0, 1, 0, 0\)$/.test(transform);
  const translateOf = (transform) => {
    const m = /matrix\(([^)]+)\)/.exec(transform || '');
    if (!m) return [0, 0];
    const v = m[1].split(',').map(Number);
    return [v[4] || 0, v[5] || 0];
  };
  // An animated thing's box: the element's own, or for ::before and ::after the parent's moved by the pseudo's translate.
  const rectOf = (target, pseudo) => {
    const r = target.getBoundingClientRect();
    if (!pseudo) return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    const [x, y] = translateOf(getComputedStyle(target, pseudo).transform);
    return { left: r.left + x, top: r.top + y, right: r.right + x, bottom: r.bottom + y };
  };
  const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.01 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.01;
  const textElements = () => [...document.querySelectorAll('.setup-page *')].filter((node) => [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim()));

  window.__probe = {
    // `fromLoad`: the trigger is the load itself, so the load's own animations are its motions.
    begin({ inside = true, fromLoad = false } = {}) {
      this.inside = inside;
      this.before = new Set(fromLoad ? [] : document.getAnimations());
      this.info = new Map();
      this.last = new Map();
      this.fails = [];
      this.maxStep = 0;
      this.maxOpacityStep = 0;
      this.anyMet = {};
      this.lastActivity = window.__clock.now;
      this.began = window.__clock.now;
      // Any change to the page counts as activity too, so a trigger with no motion still runs past PAY_MS and the poll.
      this.observer?.disconnect();
      this.observer = new MutationObserver(() => { this.lastActivity = Math.max(this.lastActivity, window.__clock.now); });
      this.observer.observe(document.querySelector('.setup-page'), { subtree: true, childList: true, attributes: true, characterData: true });
    },
    fail(text) { if (this.fails.length < 12 && !this.fails.includes(text)) this.fails.push(text); },
    active(entry, t) { return entry.removedAt === null ? t >= entry.from && t <= entry.end : t >= entry.from && t < entry.removedAt; },
    sample(any = []) {
      const t = window.__clock.now;
      const live = new Set(document.getAnimations());
      for (const animation of live) {
        if (this.before.has(animation) || this.info.has(animation)) continue;
        const target = animation.effect?.target;
        if (this.inside && !target?.closest?.('.setup-page')) continue;
        const timing = animation.effect.getComputedTiming();
        const start = window.__clock.startOf(animation) ?? t;
        const entry = { animation, name: nameOf(animation), label: label(animation), start, from: start + timing.delay, end: start + timing.delay + timing.activeDuration, target, pseudo: animation.effect.pseudoElement || '', removedAt: null };
        this.info.set(animation, entry);
        this.lastActivity = Math.max(this.lastActivity, t);
        if (entry.name === 'unknown') this.fail(`an unknown animation: ${entry.label}`);
      }
      for (const entry of this.info.values()) {
        if (entry.removedAt === null && !live.has(entry.animation) && t < entry.end) { entry.removedAt = t; this.lastActivity = Math.max(this.lastActivity, t); }
        if (entry.removedAt === null) this.lastActivity = Math.max(this.lastActivity, Math.min(t, entry.end));
      }
      // Position and opacity of every animated thing, frame to frame, while its motion runs.
      const texts = textElements().map((node) => ({ node, rect: node.getBoundingClientRect() })).filter((item) => item.rect.width > 0 && item.rect.height > 0);
      for (const entry of this.info.values()) {
        if (!entry.target.isConnected) continue;
        const key = entry.target;
        const rect = rectOf(entry.target, entry.pseudo);
        const opacity = Number(getComputedStyle(entry.target, entry.pseudo || null).opacity);
        const slot = `${entry.pseudo}`;
        const keyed = this.last.get(key) || {};
        const before = keyed[slot];
        const running = this.active(entry, t);
        if (before && (running || this.active(entry, before.t))) {
          const step = Math.max(Math.abs(rect.left - before.rect.left), Math.abs(rect.top - before.rect.top), Math.abs(rect.right - before.rect.right), Math.abs(rect.bottom - before.rect.bottom));
          this.maxStep = Math.max(this.maxStep, step);
          if (step > 4) this.fail(`jump: ${entry.label} moved ${step.toFixed(2)} px in one frame at ${t.toFixed(0)} ms`);
          if (entry.name !== 'pill-move' || entry.pseudo) {
            const opacityStep = Math.abs(opacity - before.opacity);
            this.maxOpacityStep = Math.max(this.maxOpacityStep, opacityStep);
            if (opacityStep > 0.08) this.fail(`pop: ${entry.label} opacity stepped ${opacityStep.toFixed(3)} at ${t.toFixed(0)} ms`);
          }
        }
        keyed[slot] = { t, rect, opacity };
        this.last.set(key, keyed);
        // Text clear: a moving thing never covers text outside it.
        if (running && MOVERS.has(entry.name)) {
          for (const { node, rect: box } of texts) {
            if (entry.target.contains(node) || node.contains(entry.target)) continue;
            if (overlaps(rect, box)) this.fail(`text: ${entry.label} covers "${node.textContent.trim().slice(0, 30)}" at ${t.toFixed(0)} ms`);
          }
        }
      }
      // Each pill label stays inside its pill, 2 px in.
      for (const item of document.querySelectorAll('.setup-page .su-steps li')) {
        const text = [...item.childNodes].find((child) => child.nodeType === 3);
        if (!text) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        const r = range.getBoundingClientRect();
        const box = item.getBoundingClientRect();
        if (r.left < box.left + 2 - 0.01 || r.right > box.right - 2 + 0.01 || r.top < box.top + 2 - 0.01 || r.bottom > box.bottom - 2 + 0.01) this.fail(`label: "${text.textContent}" is not 2 px inside its pill`);
      }
      for (const [name, check] of any) if (!this.anyMet[name]) { try { this.anyMet[name] = Boolean(check()); } catch { this.anyMet[name] = false; } }
    },
    running() {
      const t = window.__clock.now;
      return [...this.info.values()].some((entry) => entry.removedAt === null && t < entry.end);
    },
    // Groups: the animations of one motion that started in the same frame. Active from the first one's start plus
    // delay to the last one's end; no two may be active at once.
    groups() {
      const groups = new Map();
      for (const entry of this.info.values()) {
        const end = entry.removedAt === null ? entry.end : Math.min(entry.end, entry.removedAt);
        if (end <= entry.from) continue;
        const key = `${entry.name}@${entry.start}`;
        const group = groups.get(key) || { name: entry.name, from: Infinity, to: -Infinity, labels: [] };
        group.from = Math.min(group.from, entry.from);
        group.to = Math.max(group.to, end);
        group.labels.push(entry.label);
        groups.set(key, group);
      }
      return [...groups.values()].sort((a, b) => a.from - b.from || a.to - b.to);
    },
    judge(see) {
      const groups = this.groups();
      for (let i = 0; i < groups.length; i += 1) {
        for (let j = i + 1; j < groups.length; j += 1) {
          const a = groups[i];
          const b = groups[j];
          if (a.from < b.to - 0.5 && b.from < a.to - 0.5) this.fail(`two movers: ${a.name} ${a.from.toFixed(0)}-${a.to.toFixed(0)} ms and ${b.name} ${b.from.toFixed(0)}-${b.to.toFixed(0)} ms`);
        }
      }
      const names = groups.map((group) => group.name);
      let at = 0;
      for (const name of names) if (at < see.length && name === see[at]) at += 1;
      if (at < see.length) this.fail(`must see ${see.join(', ')}; saw ${names.join(', ') || 'nothing'}`);
      // Each animated thing ends at its final look: opacity 1 and no transform, but a light that fades out ends at 0
      // and the mirror's knob ends on.
      for (const entry of this.info.values()) {
        if (!entry.target.isConnected || entry.name === 'unknown') continue;
        const style = getComputedStyle(entry.target, entry.pseudo || null);
        const fadesOut = entry.animation.animationName === 'su-fade-out';
        const opacityOk = Number(style.opacity) === (fadesOut ? 0 : 1);
        const transformOk = entry.name === 'mirror' ? translateOf(style.transform)[0] === 18 : entry.name === 'fill' || isNone(style.transform);
        if (!opacityOk || !transformOk) this.fail(`end: ${entry.label} ends at opacity ${style.opacity}, transform ${style.transform}`);
      }
      const peak = this.maxStep / (FRAME_MS_PAGE / 1000);
      if (peak >= 400) this.fail(`speed: peak ${peak.toFixed(0)} px/s`);
      return { groups: names, maxStep: this.maxStep, peak, opacityStep: this.maxOpacityStep, fails: this.fails, ms: window.__clock.now - this.began };
    },
  };
}

app.on('window-all-closed', () => {});
process.on('unhandledRejection', (error) => { console.log(`\nFAIL check crashed: ${error.message}`); app.exit(1); });

// A fresh load of the setup page on the given preset (dotted paths into the bridge's fresh Outlook setup state).
async function load(win, base, preset) {
  const url = `${base}/motion-check.html?setup=outlook`;
  await win.loadURL(url);
  await win.webContents.executeJavaScript('sessionStorage.clear()');
  await win.loadURL(url);
  await win.webContents.executeJavaScript(`(async () => {
    const fresh = (await window.loggie.hikyaku.setupStatus()).data;
    for (const [path, value] of Object.entries(${JSON.stringify(preset)})) {
      const keys = path.split('.');
      let at = fresh;
      for (const key of keys.slice(0, -1)) at = at[key];
      at[keys.at(-1)] = value;
    }
    sessionStorage.setItem('setup-state', JSON.stringify(fresh));
  })()`);
  await win.loadURL(url);
  for (let i = 0; i < 100; i += 1) {
    if (await win.webContents.executeJavaScript(`!!document.querySelector('.setup-page .su-card') && !!window.__clock`)) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  await win.webContents.executeJavaScript(`const FRAME_MS_PAGE = ${FRAME_MS}; (${pageProbe.toString()})(); true`);
}

async function reduce(win, on) {
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: on ? 'reduce' : 'no-preference' }] });
}

// One trigger with motion: settle the load (its own card-in is not this trigger's), press, then frame by frame.
async function withMotion(win, base, trigger) {
  await load(win, base, trigger.preset);
  return win.webContents.executeJavaScript(`(async () => {
    const probe = window.__probe;
    if (${trigger.action && trigger.settle !== false ? 'true' : 'false'}) await window.__clock.tick(600);
    probe.begin({ fromLoad: ${trigger.action && trigger.settle !== false ? 'false' : 'true'} });
    ${trigger.action || ''}
    let ticks = 0;
    const any = ${checks(trigger.any)};
    for (;;) {
      await window.__clock.tick(${FRAME_MS});
      ticks += 1;
      probe.sample(any);
      const t = window.__clock.now;
      if (!probe.running() && t - probe.lastActivity >= ${QUIET_MS}) break;
      if (t - probe.began >= ${CAP_MS}) break;
    }
    const result = probe.judge(${JSON.stringify(MOTION ? trigger.see : [])});
    if (!${MOTION ? 'true' : 'false'} && result.groups.length) result.fails.push('must not see any motion; saw ' + result.groups.join(', '));
    for (const [name] of any) if (!probe.anyMet[name]) result.fails.push('never: ' + name);
    for (const [name, check] of ${checks(trigger.end)}) { let ok = false; try { ok = Boolean(check()); } catch {} if (!ok) result.fails.push('end: ' + name); }
    return { ...result, ticks };
  })()`);
}

// The same trigger under reduced motion: no animation right after the press or at any tick, and the same end state at
// the same tick (PAY_MS still holds).
async function reduced(win, base, trigger, ticks) {
  await load(win, base, trigger.preset);
  return win.webContents.executeJavaScript(`(async () => {
    const fails = [];
    const say = (text) => { if (fails.length < 8 && !fails.includes(text)) fails.push(text); };
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) say('the page does not see reduced motion');
    if (${trigger.action && trigger.settle !== false ? 'true' : 'false'}) await window.__clock.tick(600);
    if (document.getAnimations().length) say('animations at load: ' + document.getAnimations().length);
    ${trigger.action || ''}
    if (document.getAnimations().length) say('an animation right after the trigger: ' + document.getAnimations().length);
    const anyMet = {};
    const any = ${checks(trigger.any)};
    for (let i = 0; i < ${ticks}; i += 1) {
      await window.__clock.tick(${FRAME_MS});
      const live = document.getAnimations();
      if (live.length) say('an animation at ' + window.__clock.now.toFixed(0) + ' ms: ' + live.map((a) => (a.effect?.target?.className || '') + (a.effect?.pseudoElement || '') + ' ' + (a.animationName || a.transitionProperty)).join('; '));
      for (const [name, check] of any) if (!anyMet[name]) { try { anyMet[name] = Boolean(check()); } catch {} }
    }
    for (const [name] of any) if (!anyMet[name]) say('never: ' + name);
    for (const [name, check] of ${checks(trigger.end)}) { let ok = false; try { ok = Boolean(check()); } catch {} if (!ok) say('end: ' + name); }
    return { fails };
  })()`);
}

// B2.6: the two silent clips, 60 Hz, 10 s, six segments on one frame counter per clip.
const SEGMENTS = [
  { from: 0, to: 1.6, preset: {}, at: 0.3, action: press('.setup-page .btn-big', 'Start') },
  { from: 1.6, to: 3.2, preset: { step: 'email' }, at: 1.9, action: OUTLOOK_TILE },
  { from: 3.2, to: 5.0, preset: { step: 'calendar', mailApp: 'outlook' }, at: 3.5, action: press('.setup-page .btn-big', 'Allow Calendar') },
  { from: 5.0, to: 6.6, preset: { step: 'disk', mailApp: 'outlook', 'permissions.calendar': 'granted' }, at: 5.1, action: press('.setup-page .btn-big', 'Open Full Disk Access') },
  { from: 6.6, to: 8.2, preset: { step: 'keys', 'keys.nebius': true }, at: 6.9, action: TAVILY_KEY },
  { from: 8.2, to: 10.0, preset: READY_PRESET, at: null, action: null },
];
const APP_PATHS = { outlook: '/Applications/Microsoft Outlook.app', 'apple-mail': '/System/Applications/Mail.app', calendar: '/System/Applications/Calendar.app',
  'system-settings': '/System/Applications/System Settings.app', messages: '/System/Applications/Messages.app', whatsapp: '/Applications/WhatsApp.app' };
// Each app's own icon for the clips: its bundle's .icns at 64 px (sips, into <dir>/icons), which is what the app's
// getFileIcon draws on a Mac; where that cannot be read, getFileIcon itself; a missing app is not installed.
async function macIcons(dir) {
  const { stat } = require('node:fs/promises');
  const { execFile } = require('node:child_process');
  const run = (file, args) => new Promise((resolve, reject) => execFile(file, args, (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))));
  await mkdir(join(dir, 'icons'), { recursive: true });
  const out = {};
  for (const [id, path] of Object.entries(APP_PATHS)) {
    try { await stat(path); } catch { out[id] = { app: id, installed: false, icon: null }; continue; }
    try {
      const name = await run('/usr/bin/plutil', ['-extract', 'CFBundleIconFile', 'raw', join(path, 'Contents', 'Info.plist')]);
      const png = join(dir, 'icons', `${id}.png`);
      await run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '64', join(path, 'Contents', 'Resources', name.endsWith('.icns') ? name : `${name}.icns`), '--out', png]);
      out[id] = { app: id, installed: true, icon: `data:image/png;base64,${(await readFile(png)).toString('base64')}` };
    } catch {
      try { const image = await app.getFileIcon(path, { size: 'normal' }); out[id] = { app: id, installed: true, icon: image.isEmpty() ? null : image.toDataURL() }; } catch { out[id] = { app: id, installed: true, icon: null }; }
    }
  }
  return out;
}
async function film(win, base, dir, clip) {
  const out = join(dir, clip);
  await mkdir(out, { recursive: true });
  let frame = 0;
  for (const segment of SEGMENTS) {
    await load(win, base, segment.preset);
    // The segments after a press start with the loaded card already in; the Ready segment films its load.
    if (segment.action) await win.webContents.executeJavaScript('window.__clock.tick(600).then(() => true)');
    const frames = Math.round((segment.to - segment.from) * 60);
    const actionAt = segment.at === null ? -1 : Math.round((segment.at - segment.from) * 60);
    for (let i = 0; i < frames; i += 1) {
      if (i === actionAt) await win.webContents.executeJavaScript(`${segment.action}; true`);
      await win.webContents.executeJavaScript(`window.__clock.tick(${1000 / 60}).then(() => true)`);
      const image = await win.webContents.capturePage();
      await writeFile(join(out, `${String(frame).padStart(4, '0')}.png`), image.toPNG());
      frame += 1;
    }
  }
  return frame;
}

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const framesAt = process.argv.indexOf('--frames');
  const framesDir = framesAt > 0 ? process.argv[framesAt + 1] : null;
  const win = new BrowserWindow({ show: false, width: 760, height: 540, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${String(event.sourceId).split('/').pop()}:${event.lineNumber})`); });
  let failed = 0;
  const ticksOf = {};
  console.log(`Motion ${MOTION ? 'on' : 'cut (B)'}, 760x540, 120 Hz frames`);
  await win.loadURL(`${base}/motion-check.html?setup=outlook`);
  await reduce(win, false);
  for (const trigger of TRIGGERS) {
    const out = await withMotion(win, base, trigger);
    ticksOf[trigger.name] = out.ticks;
    if (out.fails.length) { failed += 1; console.log(`NOTHING ${trigger.name}: ${out.fails.join(' | ')}`); }
    else console.log(`ok   ${trigger.name}: ${out.groups.join(', ') || 'no motion'} max step ${out.maxStep.toFixed(2)} px peak ${out.peak.toFixed(0)} px/s opacity step ${out.opacityStep.toFixed(3)}`);
  }
  console.log('\nReduced motion');
  await reduce(win, true);
  for (const trigger of TRIGGERS) {
    const out = await reduced(win, base, trigger, ticksOf[trigger.name]);
    if (out.fails.length) { failed += 1; console.log(`NOTHING ${trigger.name} (reduced): ${out.fails.join(' | ')}`); }
    else console.log(`ok   ${trigger.name} (reduced): no animation, the same end state at tick ${ticksOf[trigger.name]}`);
  }
  for (const error of errors) { console.log(`console: ${error}`); failed += 1; }
  if (framesDir) {
    filmIcons = await macIcons(framesDir);
    await reduce(win, false);
    const a = await film(win, base, framesDir, 'a');
    await reduce(win, true);
    const b = await film(win, base, framesDir, 'b');
    console.log(`\nFilmed ${a} frames into ${join(framesDir, 'a')} and ${b} into ${join(framesDir, 'b')}`);
  }
  console.log(failed ? `\nFAIL ${failed}` : '\nPASS');
  app.exit(failed ? 1 : 0);
});
