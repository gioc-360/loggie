// The recording's own marks (loggie-pause-attach), the same on the Day card and the top strip: the clock that holds
// while paused and skips paused minutes, the one pause button whose mark and name flip (pause / resume), the pencil
// that writes while recording and lifts, still, while paused, and the fusen tab (a sticky tab, not Granola's clip) that
// tucks a page into the recording, with the card itself taking a dropped file.
import { icon } from './icons.js';

// Seconds recorded: since the recording began, less every closed pause and the open one.
export function recordedSeconds(call, now = Date.now()) {
  const since = Date.parse(call.since || call.start);
  if (!Number.isFinite(since)) return 0;
  const open = call.paused && call.pausedAt ? Math.max(0, now - Date.parse(call.pausedAt)) / 1000 : 0;
  return Math.max(0, (now - since) / 1000 - (Number(call.pausedSeconds) || 0) - open);
}

// One trigger in every state (interaction-design, loggie-diagnostics field note): the button is the same element, its
// mark and name say what a press does now. Pressed, it waits for the answer and then calls onDone.
export function pauseButton(call, { api, onDone = () => {}, className = 'rc-pause' } = {}) {
  const paused = Boolean(call.paused);
  const name = paused ? 'Resume recording' : 'Pause recording';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `${className}${paused ? ' is-paused' : ''}`;
  b.setAttribute('aria-label', name);
  b.title = paused ? 'Resume: the same recording goes on' : 'Pause: Loggie stops listening until you resume';
  b.append(icon(paused ? 'play' : 'pause'));
  b.addEventListener('click', async (event) => {
    event.stopPropagation();
    b.disabled = true;
    let error = null;
    try { await api.meetingPause(call.id, paused ? 'resume' : 'pause'); } catch (caught) { error = caught; }
    b.disabled = false;
    onDone(error);
  });
  return b;
}

// The pencil (replaces the red dot): ink scrolls under a still nib while recording, one seamless loop with nothing that
// jumps; paused, the pencil lifts and the ink stops. Reduce motion stops the ink too (meetings.css). `still`: the ink
// stays put where another pencil on screen is the one writing (one mover at a time: the top strip on the Day view).
export function pencil(paused, { still = false } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 40 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `rc-pencil${paused ? ' is-paused' : ''}${still ? ' is-still' : ''}`);
  const clip = document.createElementNS(NS, 'clipPath');
  const id = `rc-ink-${Math.random().toString(36).slice(2, 8)}`;
  clip.setAttribute('id', id);
  const rect = document.createElementNS(NS, 'rect');
  rect.setAttribute('x', '1'); rect.setAttribute('y', '0'); rect.setAttribute('width', '24'); rect.setAttribute('height', '24');
  clip.append(rect);
  const ink = document.createElementNS(NS, 'g');
  ink.setAttribute('clip-path', `url(#${id})`);
  const line = document.createElementNS(NS, 'path');
  // Two periods of one cursive scribble, 14 units each; the loop moves it one period, so its end matches its start.
  const loop = (x) => `M${x} 18c2-5 4-5 4-1s2 3 3-1 3-4 3 0 2 3 4 2`;
  line.setAttribute('d', [-14, 0, 14, 28].map(loop).join(' '));
  line.setAttribute('class', 'rc-ink');
  ink.append(line);
  const body = document.createElementNS(NS, 'g');
  body.setAttribute('class', 'rc-pencil-body');
  for (const d of ['M25 18l2.2-5.6L36 3.6l3.4 3.4-8.8 8.8z', 'M27.2 12.4l3.4 3.4', 'M34 5.6l3.4 3.4']) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    body.append(p);
  }
  svg.append(clip, ink, body);
  return svg;
}

// The fusen tab: the count of pages tucked in so far, and a press opens the Mac's open panel (main's).
export function fusenTab(call, { api, onDone = () => {}, className = 'rc-fusen', where = 'card' } = {}) {
  const count = (call.pages || []).length;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `${className}${count ? ' has-pages' : ''}`;
  const what = { recording: 'recording', before: 'meeting' }[call.state] || 'call';
  const name = count ? `Tuck in another page (${count} so far)` : `Tuck a page into this ${what}`;
  b.setAttribute('aria-label', name);
  b.title = ['recording', 'before'].includes(call.state) ? `${name}: slides, a sheet, an agenda or a reading. Its words fix spelling and the notes read it. Or drop a file here.`
    : `${name}: slides, a sheet, an agenda or a reading. Summarize adds it to the notes. Or drop a file here.`;
  b.append(icon('fusen'));
  if (count) { const n = document.createElement('span'); n.className = 'rc-fusen-count'; n.textContent = String(count); b.append(n); }
  b.addEventListener('click', async (event) => {
    event.stopPropagation();
    b.disabled = true;
    let error = null;
    try { await api.callPagePick(call.id, where); } catch (caught) { error = caught; }
    b.disabled = false;
    onDone(error);
  });
  return b;
}

// The card (or the open call's page) as a drop target: a file dropped on it is tucked in, each in turn; `is-dropping`
// while one hovers. `call` is the call, or a function giving the one shown now (a page that outlives its call).
export function takeDrops(box, call, { api, onDone = () => {}, where = 'card' } = {}) {
  const current = () => (typeof call === 'function' ? call() : call);
  const has = (event) => Boolean(current()?.id) && [...(event.dataTransfer?.types || [])].includes('Files');
  box.addEventListener('dragover', (event) => { if (!has(event)) return; event.preventDefault(); event.stopPropagation(); box.classList.add('is-dropping'); });
  box.addEventListener('dragleave', (event) => { if (!box.contains(event.relatedTarget)) box.classList.remove('is-dropping'); });
  box.addEventListener('drop', async (event) => {
    if (!has(event)) return;
    event.preventDefault(); event.stopPropagation();
    box.classList.remove('is-dropping');
    let error = null;
    const id = current().id;
    for (const file of [...event.dataTransfer.files]) {
      try { await api.callPageAdd(id, file, where); } catch (caught) { error = caught; }
    }
    onDone(error, id);
  });
}

// A file dropped anywhere else on the panel does nothing: the window would otherwise open it in place of Loggie.
export function guardDrops(root = document) {
  for (const type of ['dragover', 'drop']) root.addEventListener(type, (event) => { if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault(); });
}
