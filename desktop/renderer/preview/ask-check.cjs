// The ask box check (loggie-ask-wordmap): the real panel in a window, its ask bridge answered by the real readers on
// made-up people (scripts/ask-corpus/grade.mjs). Types sentences, reads every underline and slot, presses every button
// the box offers (the app chip, each fix-it, an address swap), and the keys (Esc, Up, Down, Enter), and fails when a
// press changes nothing or a slot is wrong. ASK_SHOT_DIR=<dir> also saves a picture of each state.
// Run: npm run check:ask
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { join, extname } = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = join(__dirname, '..');
const REPO = join(ROOT, '..', '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
let asker;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/ask-preview') {
    const preview = await asker.preview(url.searchParams.get('text') || '');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(preview));
    return;
  }
  if (url.pathname === '/panel-check.html') {
    const html = (await readFile(join(ROOT, 'panel.html'), 'utf8')).replace('<script type="module" src="workspace.js">', '<script type="module" src="preview/panel-bridge.js"></script>\n    <script type="module" src="preview/ask-bridge.js"></script>\n    <script type="module" src="workspace.js">');
    res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    return;
  }
  const path = join(ROOT, decodeURIComponent(url.pathname));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }).end(await readFile(path)); } catch { res.writeHead(404).end(); }
});

app.on('window-all-closed', () => {});
process.on('unhandledRejection', (error) => { console.log(`\nFAIL check crashed: ${error.stack || error.message}`); app.exit(1); });
app.whenReady().then(async () => {
  const { PEOPLE, ENTRIES, PLACES } = await import(pathToFileURL(join(REPO, 'scripts', 'ask-corpus', 'grade.mjs')).href);
  const { createAsker } = await import(pathToFileURL(join(REPO, 'src', 'hikyaku', 'ask-run.js')).href);
  const { threadsFrom } = await import(pathToFileURL(join(REPO, 'src', 'hikyaku', 'ask-thread.js')).href);
  // Every made-up Outlook person has three threads: the newest only copied the user (loggie-ask-thread).
  const mailOf = (address) => [
    { id: 'm3', from: `X <${address}>`, to: 'someone@example.com', cc: 'me@example.com', subject: 'Re: Budget review', timestamp: '2026-10-11T10:00:00Z', body: 'numbers attached' },
    { id: 'm2', from: `X <${address}>`, to: 'me@example.com', cc: '', subject: 'Hackathon rules', timestamp: '2026-10-08T10:00:00Z', body: 'judging is on the pitch' },
    { id: 'm1', from: `X <${address}>`, to: 'me@example.com', cc: '', subject: 'Lunch Friday', timestamp: '2026-10-02T10:00:00Z', body: 'noon works' },
  ];
  asker = createAsker({ home: '/nonexistent', loadIndex: async () => ENTRIES, openChat: async () => ({}), invite: { people: async () => PEOPLE, places: async () => PLACES },
    email: { threads: async (address) => threadsFrom(mailOf(address), address, ['me@example.com']) } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const shots = process.env.ASK_SHOT_DIR || '';
  if (shots) await mkdir(shots, { recursive: true });
  let failed = 0;
  for (const w of [460, 1000]) {
    const win = new BrowserWindow({ show: false, width: w, height: 900 });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${String(event.sourceId).split('/').pop()}:${event.lineNumber})`); });
    await win.loadURL(`${base}/panel-check.html`);
    await new Promise((r) => setTimeout(r, 1200));
    const shot = async (name) => { if (shots) await writeFile(join(shots, `${w}-${name}.png`), (await win.webContents.capturePage({ x: 0, y: 0, width: w, height: 260 })).toPNG()); };
    const run = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
    // helpers inside the page: type, read the underlines and the slots, press a button by its text
    await run(`
      window.__box = document.querySelector('#message');
      window.__wait = (ms = 450) => new Promise((r) => setTimeout(r, ms));
      window.__type = async (text) => { __box.focus(); __box.value = text; __box.dispatchEvent(new Event('input')); await __wait(); };
      window.__key = async (key) => { __box.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); await __wait(); };
      window.__read = () => ({
        text: __box.value,
        underlines: [...document.querySelectorAll('#askMirror .ask-u')].map((u) => u.className.replace(/.*ask-u-/, '') + ':' + u.textContent),
        labels: [...document.querySelectorAll('#askMirror .ask-u[data-label]')].map((u) => u.dataset.label),
        chip: document.querySelector('#askUnder .ask-act')?.textContent || '',
        slots: Object.fromEntries([...document.querySelectorAll('#askUnder .ask-slot')].map((s) => [s.querySelector('b').textContent, s.querySelector('.ask-slot-v').textContent])),
        listening: [...document.querySelectorAll('#askUnder .ask-slot-listen b')].map((b) => b.textContent),
        hint: document.querySelector('#askUnder .ask-hint')?.textContent || '',
        flags: [...document.querySelectorAll('#askUnder .ask-flag')].map((f) => f.textContent),
        send: !document.querySelector('#searchButton').disabled,
      });
      window.__press = async (label) => { const b = [...document.querySelectorAll('#askUnder button')].find((x) => x.textContent.includes(label)); if (!b) return false; b.click(); await __wait(); return true; };
    `);
    const lines = [];
    const expect = (label, ok, got) => { lines.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got ${JSON.stringify(got)}`}`); if (!ok) failed++; };
    const read = () => run('return __read()');

    // 0. The empty box: the word map opens from its fold and lists every small word.
    const map = await run(`const d = document.querySelector('#askUnder .ask-map'); if (!d) return null; d.querySelector('summary').click(); await __wait(150); return { open: d.open, rows: d.querySelectorAll('tr').length };`);
    expect('word map: opens with every small word', map && map.open && map.rows >= 14, map);
    await shot('0-map');
    // 1. A whole invite: every word underlined in its role, every slot filled.
    await run(`await __type('invite lena and jamie tomorrow 1730 at maplewood about hackathon rules')`);
    let r = await read(); await shot('1-invite');
    expect('invite: words underlined by role', JSON.stringify(r.underlines) === JSON.stringify(['action:invite', 'who:lena', 'who:jamie', 'when:tomorrow', 'when:1730', 'where:maplewood', 'about:hackathon', 'about:rules']), r.underlines);
    expect('invite: role names under the words', JSON.stringify(r.labels) === JSON.stringify(['who', 'who', 'when', 'where', 'about']), r.labels);
    expect('invite: slots filled', r.slots.Who === 'Lena Ortiz · Jamie Chen' && /5:30 PM/.test(r.slots.When) && r.slots.Where === 'maplewood' && r.slots.About === 'hackathon rules' && /Invite.*Outlook/.test(r.chip) && r.send, r);
    // 2. The same invite in another order fills the same slots.
    await run(`await __type('tomorrow 1730 invite jamie and lena about hackathon rules at maplewood')`);
    const r2 = await read();
    expect('any order: same slots', r2.slots.Where === 'maplewood' && r2.slots.About === 'hackathon rules' && r2.slots.When === r.slots.When && r2.slots.Who === 'Jamie Chen · Lena Ortiz', r2.slots);
    // 3. A word nobody asked for, and a person with two addresses: each fix-it button changes the sentence.
    await run(`await __type('invite lena and ilona for meeting tomorrow ahackathon')`);
    r = await read(); await shot('3-flags');
    expect('unused word: dotted and flagged', r.underlines.includes('unused:ahackathon') && r.flags.some((f) => /ahackathon/.test(f)), r);
    expect('two addresses: flagged, the most-used picked', r.flags.some((f) => /Ilona Varga has 2 addresses/.test(f)), r.flags);
    await run(`await __press('Make it the subject')`);
    r = await read();
    expect('Make it the subject', /"ahackathon"/.test(r.text) && r.slots.About === 'ahackathon', r);
    await run(`await __press('ilona.varga@example.org')`);
    r = await read();
    expect('address swap', /ilona\.varga@example\.org/.test(r.text) && /Ilona Varga/.test(r.slots.Who), r);
    await run(`await __type('invite jamie tomorrow zzplace')`);
    await run(`await __press('Make it the place')`);
    r = await read();
    expect('Make it the place', /at zzplace/.test(r.text) && r.slots.Where === 'zzplace', r);
    await run(`await __type('invite jamie tomorrow zzplace noon')`);
    await run(`await __press('Drop it')`);
    r = await read();
    expect('Drop it', r.text === 'invite jamie tomorrow noon' && !r.flags.length, r);
    // 4. The app chip moves the invite to Google by changing the sentence, and back.
    await run(`await __press('Outlook')`);
    r = await read();
    expect('chip: to Google', /on google$/.test(r.text) && /Google Calendar/.test(r.chip), r);
    await run(`await __press('Google Calendar')`);
    r = await read();
    expect('chip: back to Outlook', !/google/.test(r.text) && /Outlook/.test(r.chip), r);
    // 5. A text in any order, and its chip to WhatsApp.
    await run(`await __type('running late, text lena')`);
    r = await read(); await shot('5-text');
    expect('text: message first, verb last', /Text.*Messages/.test(r.chip) && r.slots.Who === 'Lena Ortiz' && r.slots.Says === '"Running late"' && r.underlines.join() === 'message:running,message:late,action:text,who:lena', r);
    await run(`await __press('Messages')`);
    r = await read();
    expect('chip: text to WhatsApp', /on whatsapp$/.test(r.text) && /WhatsApp/.test(r.chip), r);
    // 6. A signal word says what comes next, and the slot it fills listens.
    await run(`await __type('invite lena at ')`);
    r = await read(); await shot('6-hint');
    expect('hint after "at"', /a time .* or a place/.test(r.hint) && r.listening.includes('When') && r.listening.includes('Where'), r);
    await run(`await __type('text lena ')`);
    r = await read();
    expect('a text with no words: Enter is off', !r.send && r.listening.join() === '' && r.slots.Says === '┄┄┄┄', r);
    // 7. Esc clears the box.
    await run(`await __key('Escape')`);
    r = await read();
    expect('Esc clears', r.text === '' && !r.chip, r);
    // 8. Enter sends; Up brings it back, then the one before; Down goes forward to the empty box.
    const before = await run('return (window.__calls || []).length');
    await run(`await __type('text lena running late'); document.querySelector('#composer').requestSubmit(); await __wait();`);
    let calls = await run(`return (window.__calls || []).slice(${before})`);
    expect('Enter runs the text', calls.some((c) => c === 'ask.run text lena running late') && calls.some((c) => /uiAct/.test(c)), calls);
    await run(`__box.value = ''; __box.dispatchEvent(new Event('input')); await __wait(); document.querySelector('#composer').requestSubmit(); await __wait();`);
    await run(`await __type('tomorrow noon lunch with jamie'); document.querySelector('#composer').requestSubmit(); await __wait(800);`);
    calls = await run(`return (window.__calls || []).slice(${before})`);
    expect('an invite with no verb runs as an invite', calls.some((c) => c === 'command.execute'), calls);
    await run(`__box.value = ''; __box.dispatchEvent(new Event('input')); await __wait();`);
    await run(`await __key('ArrowUp')`);
    r = await read();
    expect('Up: the last ask', r.text === 'tomorrow noon lunch with jamie', r.text);
    await run(`await __key('ArrowUp')`);
    r = await read();
    expect('Up again: the one before', r.text === 'text lena running late', r.text);
    await run(`await __key('ArrowDown')`); await run(`await __key('ArrowDown')`);
    r = await read();
    expect('Down past the last: back to the empty box', r.text === '', r.text);
    // 9. A name no one has: Enter does nothing.
    const b9 = await run('return (window.__calls || []).length');
    await run(`await __type('text zelda hi there'); document.querySelector('#composer').requestSubmit(); await __wait();`);
    calls = await run(`return (window.__calls || []).slice(${b9}).filter((c) => /ask.run|command.execute/.test(c))`);
    r = await read(); await shot('9-none');
    expect('unknown name: flagged, Enter does nothing', !calls.length && r.flags.some((f) => /zelda/i.test(f)) && !r.send, { calls, r });
    // 11. An email answers the thread it should: the newest only copied the user, so the In slot shows the one before,
    // says why, opens the threads on a press, and a pick reaches the run (loggie-ask-thread, 2026-10-12).
    await run(`await __type('email lena sending my notes')`);
    const inSlot = () => run(`return { text: document.querySelector('#askUnder .ask-in')?.textContent || '', why: document.querySelector('#askUnder .ask-why')?.textContent || '', picks: [...document.querySelectorAll('#askUnder .ask-threads button')].map((b) => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')) }`);
    let t = await inSlot(); await shot('11-thread');
    expect('email: In shows the thread sent to the user, not the Cc-only newest', /^Re: Hackathon rules/.test(t.text) && /only copied you/.test(t.why), t);
    await run(`document.querySelector('#askUnder .ask-in').click(); await __wait(100);`);
    t = await inSlot(); await shot('11-threads');
    expect('email: a press on In lists every thread and New email, the pick marked', t.picks.length === 4 && t.picks.some((p) => /^Hackathon rules.*\*$/.test(p)) && t.picks.some((p) => /Budget review.*you were on Cc/.test(p)) && t.picks.at(-1) === 'New email', t.picks);
    await run(`[...document.querySelectorAll('#askUnder .ask-threads button')].find((b) => b.textContent.startsWith('Budget review')).click(); await __wait(100);`);
    t = await inSlot();
    expect('email: the picked thread shows in In and the why line goes', /^Re: Budget review/.test(t.text) && !t.why && !t.picks.length, t);
    const b11 = await run('return (window.__calls || []).length');
    await run(`document.querySelector('#composer').requestSubmit(); await __wait(200);`);
    calls = await run(`return (window.__calls || []).slice(${b11})`);
    expect('email: the pick reaches the run', calls.includes('ask.choices {"@thread":"m3"}'), calls);
    // 12. Card first: the draft shows while the box still works on Outlook.
    const drafting = await run(`const c = document.querySelector('#askCard'); return { shown: !c.hidden, head: c.querySelector('.ask-card-head')?.textContent || '', body: c.querySelector('.ask-draft')?.textContent || '', where: c.querySelector('.ask-to + .ask-muted')?.textContent || '', working: !document.querySelector('#askStatus').hidden }`);
    await shot('12-drafting');
    expect('email: the draft shows in the card while Outlook places it, in the picked thread', drafting.shown && /Placing it in Outlook/.test(drafting.head) && /Sending my notes/.test(drafting.body) && /In Re: Budget review/.test(drafting.where) && drafting.working, drafting);
    await run('await __wait(700);');
    await run(`await __type('email lena sending my notes'); document.querySelector('#askUnder .ask-in').click(); await __wait(100); [...document.querySelectorAll('#askUnder .ask-threads button')].find((b) => b.textContent === 'New email').click(); await __wait(100);`);
    t = await inSlot();
    expect('email: New email is one press away', t.text.startsWith('New email'), t);
    await run(`await __type('email jamie sending my notes'); await __wait(100);`);
    t = await inSlot();
    expect('email: a pick is kept for that person only', /^Re: Hackathon rules/.test(t.text), t);
    // 10. While an ask runs, the progress line covers the sentence: nothing typed shows through it (2026-10-12).
    const cover = await run(`await __type('email rosa sending my assignment 2'); const s = document.querySelector('#askStatus'); s.hidden = false;
      const b = __box.getBoundingClientRect(); const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      s.hidden = true; return Boolean(top && s.contains(top));`);
    await shot('10-working');
    expect('working: the progress line is on top of the sentence', cover, cover);
    console.log(`\n${w}px`);
    for (const line of lines) console.log('  ' + line);
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }
  server.close();
  console.log(failed ? `\nFAIL: ${failed} check(s) failed` : '\nPASS: every press reached something and every slot read right');
  app.exit(failed ? 1 : 0);
});
