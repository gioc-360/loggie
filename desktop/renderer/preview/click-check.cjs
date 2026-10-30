// The Workstreams click check: loads the preview (made-up cards, a fake bridge) at a standard, a wide and a full width,
// presses every action, and fails if any press does not reach the bridge or the page logs an error. Pixel captures
// cannot see a button that does nothing; this can. Run: npm run check:clicks
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { join, extname } = require('node:path');

const ROOT = join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  // The real panel with the stand-in bridge loaded first (panel-bridge.js), so panel.js runs without Electron.
  if (new URL(req.url, 'http://x').pathname === '/panel-check.html') {
    const html = (await readFile(join(ROOT, 'panel.html'), 'utf8')).replace('<script type="module" src="workspace.js">', '<script type="module" src="preview/panel-bridge.js"></script>\n    <script type="module" src="workspace.js">');
    res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    return;
  }
  const path = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }).end(await readFile(path)); } catch { res.writeHead(404).end(); }
});
const widths = [460, 760, 1000];
// Every visible icon-only button names what it does in the panel's own tooltip (tooltip.js reads data-tip; Gio
// 2026-10-21: "im not seeing the tool tips", the Mac's title waits a still second) that starts with its aria-label's
// first word (FA build loggie-availability, Gio 2026-10-21: "there has to be tool tips so user know what to press?"),
// and keeps no title, so the Mac never shows a second one. Icon-only: no letter or digit once its icons and aria-hidden
// parts are taken out. A switch has its words beside it.
const TIPS = `
      const untitled = () => [...document.querySelectorAll('button')]
        .filter((b) => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden' && b.getAttribute('role') !== 'switch')
        .filter((b) => { const c = b.cloneNode(true); c.querySelectorAll('[aria-hidden="true"], svg, img').forEach((n) => n.remove()); return !/[\\p{L}\\p{N}]/u.test(c.textContent); })
        .filter((b) => { const tip = (b.dataset.tip || '').trim(); const first = (t) => String(t || '').trim().split(/[\\s:]/)[0].toLowerCase(); return !tip || b.hasAttribute('title') || (b.getAttribute('aria-label') && first(tip) !== first(b.getAttribute('aria-label'))); })
        .map((b) => (b.className || 'button') + ' "' + (b.getAttribute('aria-label') || '') + '" tip "' + (b.dataset.tip || '') + '"' + (b.hasAttribute('title') ? ' and a native title "' + b.title + '"' : ''));`;
app.on('window-all-closed', () => {});
process.on('unhandledRejection', (error) => { console.log(`\nFAIL check crashed: ${error.message}`); app.exit(1); });
app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let failed = 0;
  for (const w of widths) {
    const win = new BrowserWindow({ show: false, width: w + 80, height: 1400 });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error' || /error|undelivered/i.test(event.message)) errors.push(event.message); });
    for (let i = 0; i < 4; i++) { try { await win.loadURL(`${base}/preview/workstreams.html?w=${w}`); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
    await new Promise((r) => setTimeout(r, 1200));
    const out = await win.webContents.executeJavaScript(`(async () => {
      const seen = [];
      new MutationObserver(() => seen.push(document.getElementById('log').textContent)).observe(document.getElementById('log'), { childList: true, characterData: true, subtree: true });
      const wait = () => new Promise((r) => setTimeout(r, 350));
      const clicks = [];
      // expect: the bridge call the press must reach; a logged act alone is not enough.
      const press = async (label, node, expect = null) => { if (!node) { clicks.push(label + ': NOTHING (no button)'); return; } const before = seen.length; node.click(); await wait(); const got = seen.slice(before).join(' | '); clicks.push(label + ': ' + (got && (!expect || expect.test(got)) ? got : 'NOTHING ' + got)); };
      const byText = (t) => [...document.querySelectorAll('.ws-view button')].find((b) => (b.textContent.trim() || b.getAttribute('aria-label') || '').startsWith(t));
      const openBank = async () => { [...document.querySelectorAll('.ws-row')].find((r) => /Bank Offer|Renamed in the check/.test(r.textContent))?.click(); await wait(); };
      // The list: one row per workspace, named ones first; a row opens its page and Back returns.
      const rows = [...document.querySelectorAll('.ws-row')].map((r) => r.dataset.name);
      clicks.push('List: ' + (rows.length === 6 && rows[0] === 'Bank Offer' ? rows.length + ' rows, Bank Offer first' : 'NOTHING ' + rows.join(',')));
      const firstTab = document.querySelector('.ws-view button');
      clicks.push('Tab order: ' + (firstTab?.classList.contains('ws-refresh') || firstTab?.classList.contains('ws-row') ? 'refresh, then the rows' : 'NOTHING ' + firstTab?.className));
      await openBank();
      clicks.push('Open a workspace: ' + (document.querySelector('.ws-view[data-mode="detail"] .ws-card-title')?.textContent === 'Bank Offer' ? 'its page' : 'NOTHING'));
      document.querySelector('.ws-back')?.click(); await wait();
      clicks.push('Back: ' + (document.querySelector('.ws-view[data-mode="list"]') ? 'the list' : 'NOTHING'));
      await openBank();
      // A move: its title opens what was said; the app button opens the line box and Enter drafts with the line;
      // done, new date (then save) and drop each reach the bridge.
      document.querySelector('.ws-move-open')?.click(); await wait();
      clicks.push('Open the move: ' + (document.querySelector('.ws-detail .ws-bubble, .ws-detail .ws-callnote') ? 'shows what was said' : 'NOTHING'));
      document.querySelector('.ws-go[aria-label^="Draft it in"]')?.click(); await wait();
      const say = document.querySelector('.ws-say');
      if (say) { say.value = 'say Monday at 3 works'; await press('Draft with a line', document.querySelector('.ws-line .ws-go'), /do it task_a saying "say Monday at 3 works"/); }
      else clicks.push('Draft with a line: NOTHING (no box)');
      clicks.push('Row says it: ' + (document.querySelector('.ws-row-status') ? 'yes' : 'NOTHING'));
      await press('Done', document.querySelector('.ws-act[aria-label^="Done"]'), /mark task_a done/);
      document.querySelector('.ws-act[aria-label^="New date"]')?.click(); await wait();
      await press('Save new date', document.querySelector('.ws-line .ws-go'), /date task_a [0-9-]{10}/);
      await press('Drop', document.querySelector('.ws-act[aria-label^="Drop"]'), /mark task_a dropped/);
      clicks.push('Late move: ' + (document.querySelector('.ws-due.is-late') ? 'red with a clock' : 'NOTHING'));
      clicks.push('Not-sure move: ' + (document.querySelector('.ws-move.is-unsure') ? 'yellow' : 'NOTHING'));
      // An SMS/RCS chat: its app sign is grayed and disabled, and pressing it reaches nothing.
      const off = document.querySelector('.ws-go.is-off');
      if (off) { const b4 = seen.length; off.click(); await wait(); clicks.push('SMS move: ' + (off.disabled && seen.length === b4 && !document.querySelector('.ws-say') ? 'grayed, does nothing' : 'NOTHING (it acted)')); }
      else clicks.push('SMS move: NOTHING (not grayed)');
      // A move from a text: the box opens with what the text asked, cursor at the end, and the user's added words go.
      document.querySelector('.ws-go[aria-label*="Lucky Star"]')?.click(); await wait(); await wait();
      const box = document.querySelector('.ws-say');
      if (box && box.value === 'ask about the bar tab' && box.selectionStart === box.value.length) { box.value += ' for the 22nd'; await press('Text move: box opens with the ask', document.querySelector('.ws-line .ws-go'), /do it task_c saying "ask about the bar tab for the 22nd"/); }
      else clicks.push('Text move: box opens with the ask: NOTHING (' + (box ? JSON.stringify(box.value) + ' caret ' + box.selectionStart : 'no box') + ')');
      // A call named on a move opens Notes & Meetings (no meetings page in the preview: the event is enough).
      let navigated = null;
      document.addEventListener('loggie:navigate', (e) => { navigated = e.detail; }, { once: true });
      for (const t of document.querySelectorAll('.ws-move-open')) { if (document.querySelector('.ws-open-call')) break; t.click(); await wait(); }
      document.querySelector('.ws-open-call')?.click(); await wait();
      clicks.push('Call link: ' + (navigated?.view === 'meetings' && navigated?.call ? 'opens the call' : 'NOTHING'));
      await press('Open (To send)', document.querySelector('.ws-to-send .ws-do'), /open draft task_ty/);
      // The retired fold opens and Undo reaches the bridge.
      const fold = document.querySelector('.ws-retired-fold');
      if (fold) { fold.querySelector('summary').click(); await wait(); }
      await press('Undo (retired)', byText('Undo'), /unretire task_r1/);
      // The "..." row: stake, park, refresh this, edit name, dismiss.
      await openBank();
      const more = document.querySelector('.ws-more');
      more?.click(); await wait();
      clicks.push('More: ' + (document.querySelector('.ws-more')?.getAttribute('aria-expanded') === 'true' && byText('Matters more') ? 'opens' : 'NOTHING'));
      await press('Matters more', byText('Matters more'), /stake Bank Offer more/);
      document.querySelector('.ws-more[aria-expanded="false"]')?.click(); await wait();
      await press('Matters less', byText('Matters less'), /stake Bank Offer less/);
      document.querySelector('.ws-more[aria-expanded="false"]')?.click(); await wait();
      byText('Park until')?.click(); await wait();
      await press('Park 1 week', byText('1 week'), /park Bank Offer \\d{4}-\\d{2}-\\d{2}/);
      document.querySelector('.ws-more[aria-expanded="false"]')?.click(); await wait();
      clicks.push('Merged move says where else: ' + (/also in email: RE: Interview time · WhatsApp: Prep chat/.test(document.querySelector('.ws-also')?.textContent || '') ? 'yes' : 'NOTHING'));
      // What it is for (F2): a drafted "for" shows its source and one Yes makes it his; then the line is his words.
      document.querySelector('.ws-back')?.click(); await wait();
      [...document.querySelectorAll('.ws-row')].find((r) => r.dataset.name === 'Hotel Hackathon')?.click(); await wait();
      clicks.push('For line shows its source: ' + (/for: win the guest experience challenge · from “We are going to win the guest experience challenge this weekend\.” · Yes/.test(document.querySelector('.ws-for')?.textContent || '') ? 'yes' : 'NOTHING ' + document.querySelector('.ws-for')?.textContent));
      await press('Yes makes the for line his', document.querySelector('.ws-for-yes'), /goal yes Hotel Hackathon/);
      document.querySelector('.ws-back')?.click(); await wait();
      await openBank();
      document.querySelector('.ws-more[aria-expanded="false"]')?.click(); await wait();
      // File here (F4): a New line's chip names this workspace; a pick moves the whole thread and says its card reads it.
      const line = [...document.querySelectorAll('.ws-news-line')].find((li) => /Introductions/.test(li.textContent));
      clicks.push('New line carries the chip: ' + (line?.querySelector('.mr-chip.is-placed') ? 'yes' : 'NOTHING'));
      line?.querySelector('.mr-chip')?.click(); await wait();
      await press('File here moves the thread', [...document.querySelectorAll('.ws-news-line .mr-pick')].find((b) => !b.matches('.is-on, .is-cancel, .is-new')), /move outlook:b to /);
      clicks.push('File here says what it did: ' + (/Filed under .+ · its card reads it now/.test(document.querySelector('.ws-news-line .mr-payoff')?.textContent || '') ? 'yes' : 'NOTHING'));
      // Refresh this checks one workspace and says so (cleanup audit bug 7: it said "Checking every source").
      const one = document.querySelector('.ws-refresh-one'); one?.click();
      clicks.push('Refresh this names its workspace: ' + (/^Checking Bank Offer…$/.test(document.querySelector('.ws-status')?.textContent || '') ? 'yes' : 'NOTHING'));
      await wait(); document.querySelector('.ws-more[aria-expanded="false"]')?.click(); await wait();
      await press('Refresh this', document.querySelector('.ws-refresh-one'), /refresh Bank Offer/);
      document.querySelector('.ws-more[aria-expanded="false"]')?.click(); await wait();
      byText('Edit name')?.click(); await wait();
      const nameBox = document.querySelector('.ws-name-edit input');
      if (nameBox) { nameBox.value = 'Renamed in the check'; await press('Edit name, Save', [...document.querySelectorAll('.ws-name-edit button')].find((b) => b.textContent === 'Save'), /rename .+ Renamed in the check/); }
      else clicks.push('Edit name: NOTHING (no box)');
      clicks.push('Renamed: ' + (document.querySelector('.ws-card-title')?.textContent === 'Renamed in the check' ? 'the page says the new name' : 'NOTHING ' + document.querySelector('.ws-card-title')?.textContent));
      document.querySelector('.ws-more[aria-expanded="false"]')?.click(); await wait();
      // A kept workspace ends by Retire (loggie-workspaces-integration F1): with open moves it asks once, then retires
      // and sits under "Retired · 1", whose page brings it back. Dismiss is only for a found card never kept.
      // Recordings on the card (F3): the recording filed here, its next steps, the same chip; the picker files it elsewhere.
      document.querySelector('.ws-more[aria-expanded="true"]')?.click(); await wait();
      clicks.push('Recordings block: ' + (/Recordings · 1/.test(document.querySelector('.ws-view')?.textContent || '') && document.querySelector('.ws-recording .mr-chip.is-placed') && /1 next step on this card/.test(document.querySelector('.ws-recording')?.textContent || '') ? 'the recording, its chip and its step' : 'NOTHING'));
      document.querySelector('.ws-recording .mr-chip')?.click(); await wait();
      await press('A recording files elsewhere from the card', [...document.querySelectorAll('.ws-recording .mr-pick')].find((b) => !b.matches('.is-on, .is-cancel, .is-new')), /file 2026-10-09-1300-weekly-sync under .+ from workspace/);
      document.querySelector('.ws-more[aria-expanded="false"]')?.click(); await wait();
      clicks.push('Kept card has Retire, not Dismiss: ' + (byText('Retire') && !byText('Dismiss') ? 'yes' : 'NOTHING'));
      const r0 = seen.length; byText('Retire')?.click(); await wait();
      clicks.push('Retire with open moves asks once: ' + (seen.length === r0 && /open moves?\. Before it retires:/.test(document.querySelector('.ws-retire-choice')?.textContent || '') ? 'yes' : 'NOTHING'));
      await press('Drop them, then retire', byText('Drop them'), /retire .+ drop/);
      await wait();
      clicks.push('Retired fold: ' + (/Retired · 1/.test(document.querySelector('.ws-retired-fold summary')?.textContent || '') ? 'Retired · 1' : 'NOTHING'));
      document.querySelector('.ws-retired-fold .ws-row')?.click(); await wait();
      clicks.push('Retired page: ' + (document.querySelector('.ws-focus.is-retired .ws-recording') ? 'its recording is kept' : 'NOTHING'));
      await press('Bring back', document.querySelector('.ws-bring-back'), /bring back /);
      // Delete (loggie-delete-workspace): in the "..." row beside Retire, a second press, the same moves choice once,
      // then gone for good: not in the list and not under Retired.
      document.querySelector('.ws-back')?.click(); await wait();
      [...document.querySelectorAll('.ws-row')].find((r) => /Hotel Hackathon/.test(r.textContent))?.click(); await wait();
      document.querySelector('.ws-more[aria-expanded="false"]')?.click(); await wait();
      const d0 = seen.length; document.querySelector('.ws-delete')?.click(); await wait();
      clicks.push('Delete asks for a second press: ' + (seen.length === d0 && document.querySelector('.ws-delete.is-armed')?.textContent === 'Press again to delete' ? 'yes' : 'NOTHING'));
      document.querySelector('.ws-delete')?.click(); await wait();
      const choice = document.querySelector('.ws-retire-choice')?.textContent || '';
      if (/Before it is deleted:/.test(choice)) await press('Drop them, then delete', byText('Drop them'), /delete Hotel Hackathon drop/);
      else clicks.push('Delete with no open moves: ' + (seen.some((line) => /delete Hotel Hackathon none/.test(line)) ? 'yes' : 'NOTHING'));
      await wait();
      const rowsLeft = [...document.querySelectorAll('.ws-row')].map((r) => r.textContent).join(' | ');
      const retiredNow = document.querySelector('.ws-retired-fold summary')?.textContent || '';
      clicks.push('Deleted is gone, not under Retired: ' + (!/Hotel Hackathon/.test(rowsLeft) && !/Hotel Hackathon/.test(document.querySelector('.ws-retired-fold')?.textContent || '') && /Deleted Hotel Hackathon/.test(document.querySelector('.ws-status')?.textContent || '') ? 'yes' : 'NOTHING ' + retiredNow));
      // Inbox and Chats are not the user's workspaces: no Edit, no Dismiss (fixture has none; a made-up Inbox row checks it).
      await press('Refresh', document.querySelector('.ws-refresh'), /(^| \| )refresh($| \|)/);
      const warn = document.querySelector('.ws-status')?.textContent || '';
      return { clicks, status: warn };
    })()`);
    console.log(`\nWorkspaces preview ${w}px`);
    for (const c of out.clicks) { console.log('  ' + c); if (/NOTHING|Maximum call stack/.test(c)) failed++; }
    if (/Maximum call stack|RangeError/.test(out.status)) { console.log('  status: ' + out.status); failed++; }
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }
  // Today (spec-b T2): the first pick open with the one filled button, its line box prefilled with the caret at the
  // end, Enter reaching doIt with the line, the other picks, the ready drafts, the "?" rows, and the four states.
  for (const [w, h] of [[760, 540], [1500, 1200]]) {
    const win = new BrowserWindow({ show: false, width: w, height: h });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${String(event.sourceId).split('/').pop()}:${event.lineNumber})`); });
    await win.loadURL(`${base}/panel-check.html`);
    await win.webContents.executeJavaScript(`document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: 'today' }))`);
    await new Promise((r) => setTimeout(r, 1500));
    const out = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 350) => new Promise((r) => setTimeout(r, ms));
      const lines = [];
      const say = (ok, label, seen = '') => lines.push((ok ? 'ok   ' : 'NOTHING ') + label + (ok || !seen ? '' : ' (' + seen + ')'));
      const last = (path) => [...(window.__args || [])].reverse().find((a) => a.path === path)?.args;
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const q = (sel) => document.querySelector(sel);
      const key = (node, k) => node.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      const filled = () => [...document.querySelectorAll('[data-page="today"] button')].filter((b) => b.offsetParent && /gradient/.test(getComputedStyle(b).backgroundImage));
      const first = q('#todayView .today-card.is-first[data-task-id="task_c"]');
      say(first && first.querySelector('.today-title').textContent === 'Email Lucky Star: ask about the bar tab' && /^Bank Offer/.test(first.querySelector('.today-meta').textContent), 'first card', first?.textContent.slice(0, 60));
      const f = filled();
      say(f.length === 1 && f[0].matches('.is-first .today-go'), 'one filled button', f.length + ' filled');
      if (window.innerHeight <= 600) say(f[0] && f[0].getBoundingClientRect().bottom <= window.innerHeight, 'filled button in view', f[0] && Math.round(f[0].getBoundingClientRect().bottom) + ' of ' + window.innerHeight);
      const tabbable = [...document.querySelectorAll('#todayView button, #todayView input')];
      const firstGo = tabbable.findIndex((n) => n.matches('.is-first .today-go'));
      const firstRow = tabbable.findIndex((n) => n.matches('.qrow'));
      say(firstGo >= 0 && firstRow > firstGo, 'tab order: the first card before the rows', firstGo + ' / ' + firstRow);
      const go = q('.is-first .today-go');
      say(go?.textContent === 'Draft it in Outlook', 'button says where', go?.textContent);
      go?.click(); await wait();
      let box = q('.is-first .today-say');
      say(box && box.value === 'ask about the bar tab' && document.activeElement === box && box.selectionStart === 21, 'box opens prefilled, caret at end', box && box.value + ' @' + box.selectionStart);
      const doIts = () => (window.__args || []).filter((a) => a.path === 'hikyaku.doIt').length;
      const before = doIts();
      if (box) key(box, 'Escape'); await wait();
      say(!q('.today-say') && doIts() === before, 'Esc closes, nothing called');
      q('.is-first .today-go')?.click(); await wait();
      box = q('.is-first .today-say');
      if (box) { box.value += ' for the 22nd'; key(box, 'Enter'); }
      await wait(600);
      say(same(last('hikyaku.doIt'), ['task_c', null, 'ask about the bar tab for the 22nd']) && q('.is-first .move-status:not([hidden])')?.textContent, 'Enter reaches doIt with the line', JSON.stringify(last('hikyaku.doIt')));
      for (const listener of window.__listeners['hikyaku.onMoved'] || []) listener({ taskId: 'task_c', phase: 'in-mail-app', text: 'The reply is open in Outlook with the draft in it.' });
      await wait(600);
      say(/open in Outlook/.test(q('[data-task-id="task_c"] .move-status')?.textContent || ''), 'landed run updates the card', q('[data-task-id="task_c"] .move-status')?.textContent);
      q('.is-first .ws-act[aria-label^="Done"]')?.click(); await wait(500);
      say(same(last('hikyaku.markMove'), ['task_c', 'done']), 'Done', JSON.stringify(last('hikyaku.markMove')));
      q('.is-first .ws-act[aria-label^="New date"]')?.click(); await wait();
      const date = q('.today-date');
      if (date) { date.value = '2026-10-20'; key(date, 'Enter'); }
      await wait(500);
      say(same(last('hikyaku.moveDate'), ['task_c', '2026-10-20']), 'New date', JSON.stringify(last('hikyaku.moveDate')));
      q('.is-first .today-not')?.click(); await wait(500);
      say(same(last('hikyaku.notThis'), ['task_c']), 'Not this', JSON.stringify(last('hikyaku.notThis')));
      q('.today-line[data-task-id="task_a"] .today-line-open')?.click(); await wait();
      const other = q('.today-card[data-task-id="task_a"]');
      const nowFilled = filled();
      say(other && q('.today-line[data-task-id="task_c"]') && nowFilled.length === 1 && other.contains(nowFilled[0]), 'other pick opens in place, the first closes, still one filled button', nowFilled.length + ' filled');
      other?.querySelector('.today-go')?.click(); await wait();
      box = q('[data-task-id="task_a"] .today-say');
      const empty = box?.value === '';
      // A redraw while typing (the lists reload every few seconds) keeps the words and the focus.
      if (box) { box.value = 'say Monday'; box.focus(); }
      for (const l of window.__listeners['hikyaku.onRanked'] || []) l();
      await wait(800);
      box = q('[data-task-id="task_a"] .today-say');
      say(box?.value === 'say Monday' && document.activeElement === box, 'typed words survive a redraw', box ? JSON.stringify(box.value) + (document.activeElement === box ? ' focused' : ' not focused') : 'no box');
      if (box) { box.value = 'say Monday at 3 works'; key(box, 'Enter'); }
      await wait(600);
      say(empty && same(last('hikyaku.doIt'), ['task_a', null, 'say Monday at 3 works']), 'other pick drafts with its line', JSON.stringify(last('hikyaku.doIt')));
      say(/^\\? .*Loggie needs your answer/.test(q('.today-line[data-task-id="task_q1"] .today-line-open')?.textContent || ''), 'a closed pick with a question says so', q('.today-line[data-task-id="task_q1"] .today-line-open')?.textContent);
      q('.today-line[data-task-id="task_q1"] .today-line-open')?.click(); await wait();
      const qcard = q('.today-card[data-task-id="task_q1"] .needs-card');
      const again = qcard?.querySelector('.task-actions button');
      again?.click(); await wait(600);
      say(qcard && again?.textContent === 'Again' && same(last('hikyaku.answer'), ['task_q1', 'again']) && !q('#todayView [data-key="ask:task_q1"]'), 'question in the pick card', again?.textContent + ' ' + JSON.stringify(last('hikyaku.answer')));
      q('[data-ready="task_ty"] button')?.click(); await wait(500);
      say(same(last('hikyaku.openDraft'), ['task_ty', { again: false }]), 'ready line Open', JSON.stringify(last('hikyaku.openDraft')));
      const replies = [...document.querySelectorAll('#batchActions button')].find((b) => b.textContent.startsWith('Open my replies (1)'));
      const r0 = window.__calls.length; replies?.click(); await wait(500);
      say(window.__calls.slice(r0).includes('hikyaku.openReplies'), 'batch Open my replies');
      // Each "?" row opens its card under it, and that card's first button reaches the app.
      const rows = () => [...document.querySelectorAll('#todayView .today-row .qrow:not(.is-guess)')];
      const count = rows().length;
      say(count === 5, '"?" rows, one each', count + ' rows');
      for (let i = 0; i < count; i++) {
        const row = rows()[i];
        const label = row.textContent.slice(1, 40);
        const rowKey = row.closest('.today-row').dataset.key;
        const item = () => document.querySelector('.today-row[data-key="' + CSS.escape(rowKey) + '"]');
        if (row.getAttribute('aria-expanded') !== 'true') row.click();
        await wait();
        const card = item()?.querySelector('.today-row-card');
        if (!card) { say(false, 'row ' + label, 'no card'); continue; }
        const b0 = window.__calls.length;
        const press = card.querySelector('.task-actions button.primary') || card.querySelector('.task-actions button');
        press.click(); await wait(600);
        let calls = window.__calls.slice(b0).filter((c) => !/workstreams|firstToday|sends|usage|nextMeeting|uiAct/.test(c));
        const pick = card.querySelector('.next-move .task-actions button');
        if (calls.includes('hikyaku.decide') && pick) { const b2 = window.__calls.length; pick.click(); await wait(600); calls = calls.concat(window.__calls.slice(b2).filter((c) => /send/.test(c))); }
        say(calls.length, 'row ' + label + ' -> ' + press.textContent + ' -> ' + [...new Set(calls)].join(', '));
        if (press.textContent === '✓') {
          const again = item()?.querySelector('.qrow');
          if (again && again.getAttribute('aria-expanded') !== 'true') { again.click(); await wait(); }
          const no = [...(item()?.querySelectorAll('.today-row-card .task-actions button') || [])].find((b) => b.textContent === '✕');
          const b3 = window.__calls.length; no?.click(); await wait(600);
          say(window.__calls.slice(b3).some((c) => /answerAsk/.test(c)), 'row ' + label + ' -> ✕');
        }
      }
      const guess = q('.qrow.is-guess');
      guess?.click(); await wait(900);
      say(guess && !q('[data-page="meetings"]').hidden && q('#viewMeetings .mr-picker'), 'guess row opens the picker');
      document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: 'today' })); await wait();
      // A pick opens its workspace's card, where the same move wears Today's ★ (loggie-workspaces-integration F7).
      const pickRow = [...document.querySelectorAll('#todayView .today-card .today-ws')].find((b) => b.textContent === 'Bank Offer');
      pickRow?.click(); await wait(900);
      say(pickRow && !q('[data-page="workspaces"]').hidden && q('.ws-card-title')?.textContent === 'Bank Offer' && q('.ws-pick'), 'a pick opens its card, the move starred', q('.ws-card-title')?.textContent);
      document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: 'today' })); await wait();
      // The four states, from the same calls with other answers.
      const ranked = async () => { for (const l of window.__listeners['hikyaku.onRanked'] || []) l(); await wait(800); };
      const saved = { first: window.__data['hikyaku.firstToday'], ws: window.__data['hikyaku.workstreams'] };
      window.__data['hikyaku.firstToday'] = { picks: [], source: 'ai' }; await ranked();
      say(q('#todayHeading').textContent === 'Nothing first today.' && !q('.today-card, .today-line') && q('[data-ready="task_ty"]') && rows().length === 6, 'state nothing', q('#todayHeading').textContent + ' ' + rows().length + ' rows');
      window.__data['hikyaku.workstreams'] = [{ name: 'Inbox', inbox: true, kind: 'other', moves: [], active: [], asks: [], priority: null }];
      window.__data['hikyaku.firstToday'] = { picks: [], source: null }; await ranked();
      say(q('#todayHeading').textContent === 'Nothing first today.' && q('.today-empty')?.textContent === 'No workspaces yet. They come from your mail once Loggie may read it.', 'state first-run', q('.today-empty')?.textContent);
      window.__data['hikyaku.workstreams'] = saved.ws;
      window.__data['hikyaku.firstToday'] = { ...saved.first, source: 'date' }; await ranked();
      say(/· by date$/.test(q('.is-first .today-meta')?.textContent || ''), 'state by date', q('.is-first .today-meta')?.textContent);
      // A pick with no move: Draft it with the Loggie mark, never Do it, and the press reaches doIt (first-run-polish B3.1).
      window.__data['hikyaku.firstToday'] = { picks: [{ taskId: 'task_gone', name: 'Bank Offer', move: 'Ask about the start date', due: null, why: null, quote: null }], source: 'ai' }; await ranked();
      say(![...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Do it'), 'no Do it button');
      say(q('.today-do')?.textContent.trim() === 'Draft it' && q('.today-do svg.today-mark') && q('.today-do').getAttribute('aria-label') === 'Draft it with Loggie', 'Draft it with the mark', q('.today-do')?.outerHTML.slice(0, 80));
      q('.today-do')?.click(); await wait(600);
      say(same(last('hikyaku.doIt'), ['task_gone', null, null]) && /^Queued/.test(q('[data-task-id="task_gone"] .move-status')?.textContent || ''), 'Draft it reaches doIt and says Queued', JSON.stringify(last('hikyaku.doIt')) + ' ' + q('[data-task-id="task_gone"] .move-status')?.textContent);
      window.__data['hikyaku.firstToday'] = saved.first; await ranked();
      // Today redraws on main's change signal, no Refresh pressed (Gio, 2026-10-23: "I have to refresh Workspaces for
      // the Today tab to update"). A stand-in Done from a call page: main retires the move and sends 'refreshed'; the
      // saved picks still name it. Three signals in a burst cost one reload.
      const fireMoved = (outcome) => (window.__listeners['hikyaku.onMoved'] || []).forEach((listener) => listener(outcome));
      const loads = () => window.__calls.filter((c) => c === 'hikyaku.workstreams').length;
      say(q('#todayView [data-task-id="task_c"]'), 'before: task_c on Today');
      window.__data['hikyaku.workstreams'] = saved.ws.map((card) => ((card.moves || []).some((m) => m.id === 'task_c')
        ? { ...card, moves: card.moves.filter((m) => m.id !== 'task_c'), retired: [...(card.retired || []), { id: 'task_c', title: 'Email Lucky Star', why: 'done' }] } : card));
      const l0 = loads();
      fireMoved({ taskId: null, phase: 'refreshed', text: '' }); fireMoved({ taskId: null, phase: 'refreshed', text: '' });
      for (const l of window.__listeners['core.onEvents'] || []) l([]);
      await wait(800);
      say(!q('#todayView [data-task-id="task_c"]') && loads() - l0 === 1, 'a move marked Done elsewhere leaves Today on the change signal, one reload', (q('#todayView [data-task-id="task_c"]') ? 'still shown' : 'gone') + ', ' + (loads() - l0) + ' reloads');
      // A background refresh that ranked new picks: the signal alone draws them.
      window.__data['hikyaku.workstreams'] = saved.ws;
      window.__data['hikyaku.firstToday'] = { ...saved.first, picks: [...saved.first.picks].reverse() };
      const want = window.__data['hikyaku.firstToday'].picks[0].taskId;
      fireMoved({ taskId: null, phase: 'refreshed', text: '' }); await wait(800);
      say(q('#todayView .today-card.is-first')?.dataset.taskId === want, 'a background refresh redraws the picks on Today', q('#todayView .today-card.is-first')?.dataset.taskId + ' vs ' + want);
      window.__data['hikyaku.firstToday'] = saved.first; await ranked();
      return { lines };
    })()`);
    console.log(`\nToday ${w}x${h}:`);
    for (const l of out.lines) { console.log('  ' + l); if (!l.startsWith('ok')) failed++; }
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }

  // The call notes card (first-run-polish B5.4, S15): an install whose yes came before call notes wrote themselves is
  // asked once on Today; its Yes reaches cloudYesAnswer with the calls group, and the answer takes the card away.
  {
    const win = new BrowserWindow({ show: false, width: 760, height: 540 });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${String(event.sourceId).split('/').pop()}:${event.lineNumber})`); });
    await win.loadURL(`${base}/panel-check.html`);
    await win.webContents.executeJavaScript(`document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: 'today' }))`);
    await new Promise((r) => setTimeout(r, 1200));
    const out = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
      const lines = [];
      const say = (ok, label, detail = '') => lines.push((ok ? 'ok   ' : 'NOTHING ') + label + (detail ? ' -> ' + detail : ''));
      const last = (path) => [...(window.__args || [])].reverse().find((a) => a.path === path)?.args;
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const HEADING = 'Write call notes on their own after each call?';
      const card = () => [...document.querySelectorAll('#liveCards article')].find((a) => a.querySelector('header strong')?.textContent === HEADING);
      (window.__listeners['hikyaku.onEntry'] || []).forEach((listener) => listener({ type: 'setup.cloud_yes', data: { group: 'calls' } })); await wait();
      const buttons = [...(card()?.querySelectorAll('button') || [])].map((b) => b.textContent);
      say(!!card() && card().offsetParent !== null && same(buttons, ['Yes', 'Not now']), 'S15 the call notes card shows on Today with Yes and Not now', buttons.join(' + ') || 'no card');
      [...(card()?.querySelectorAll('button') || [])].find((b) => b.textContent === 'Yes')?.click(); await wait(600);
      say(same(last('hikyaku.cloudYesAnswer'), ['calls', 'yes']) && !card(), 'S15 its Yes reaches cloudYesAnswer with calls, yes, and the card leaves', JSON.stringify(last('hikyaku.cloudYesAnswer')) + (card() ? ' (card still there)' : ''));
      return { lines };
    })()`);
    console.log('\nToday, the call notes card, 760x540');
    for (const l of out.lines) { console.log('  ' + l); if (!l.startsWith('ok')) failed++; }
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }

  // The shell (S3): three tabs in the header, the three dots hold Settings and stay lit on it, the brand goes to Today,
  // Esc closes the menu, and no Activity or Connections tab is left.
  {
    const win = new BrowserWindow({ show: false, width: 760, height: 540 });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${String(event.sourceId).split('/').pop()}:${event.lineNumber})`); });
    await win.loadURL(`${base}/panel-check.html`);
    await new Promise((r) => setTimeout(r, 1500));
    const out = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));
      const lines = [];
      const say = (ok, label, seen = '') => lines.push((ok ? 'ok   ' : 'NOTHING ') + label + (ok || !seen ? '' : ' (' + seen + ')'));
      const q = (sel) => document.querySelector(sel);
      const tabs = [...document.querySelectorAll('.panel-header .workspace-nav button')].map((b) => b.dataset.view);
      say(tabs.join() === 'today,workspaces,meetings' && !q('[data-view="activity"], [data-page="activity"], [data-page="tasks"]'), 'three tabs in the header, no Activity', tabs.join());
      // The gear opens Settings in one press, with no menu; a second press stays on Settings (2026-10-28).
      const gear = q('#settingsButton');
      say(!!gear && gear.getAttribute('aria-label') === 'Settings' && gear.dataset.tip === 'Settings' && !!gear.querySelector('svg'), 'the header has a gear named Settings, tooltip Settings');
      gear.click(); await wait();
      say(!q('[data-page="settings"]').hidden && !q('#moreButton, #moreMenu, .menu-popover, .panel-header [role="menu"]') && gear.tagName === 'BUTTON' && gear.getAttribute('aria-pressed') === 'true', 'one press of the gear shows Settings, no menu, the gear stays lit');
      gear.click(); await wait();
      say(!q('[data-page="settings"]').hidden, 'a second press of the gear keeps Settings');
      say(!q('#connectionLabel, #connectGmail, #accountSection, #authorizationCard'), 'Settings has no Gmail sign-in');
      q('#brandHome').click(); await wait();
      say(!q('[data-page="today"]').hidden && q('#settingsButton').getAttribute('aria-pressed') === 'false', 'the brand goes to Today, the gear goes dark');
      const box = q('#composer').getBoundingClientRect(), page = q('#conversation').getBoundingClientRect();
      say(box.bottom <= page.top + 1 && q('.panel-header').getBoundingClientRect().bottom <= box.top + 1, 'header, then the ask bar, then the page');
      say(q('#askResults').hidden, 'no results box until a request has one');
      return { lines };
    })()`);
    console.log('\nShell 760x540:');
    for (const l of out.lines) { console.log('  ' + l); if (!l.startsWith('ok')) failed++; }
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }

  // "Your free times" on Settings (loggie-availability I3): the five rows open on the defaults, and a change in each
  // reaches setAvailability with exactly its key and value, and its row reads "Saved".
  {
    const win = new BrowserWindow({ show: false, width: 760, height: 900 });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${String(event.sourceId).split('/').pop()}:${event.lineNumber})`); });
    await win.loadURL(`${base}/panel-check.html`);
    await new Promise((r) => setTimeout(r, 1500));
    const out = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));
      const lines = [];
      const say = (ok, label, seen = '') => lines.push((ok ? 'ok   ' : 'NOTHING ') + label + (ok || !seen ? '' : ' (' + seen + ')'));
      const last = (path) => [...(window.__args || [])].reverse().find((a) => a.path === path)?.args;
      const q = (sel) => document.querySelector(sel);
      q('#settingsButton').click(); await wait();
      const section = q('[data-page="settings"] #timesSection');
      say(!!section && section.offsetParent !== null && section.querySelector('h2')?.textContent === 'Your free times' && section.querySelectorAll('.settings-row').length === 5, 'the Your free times section shows five rows on Settings');
      // No grey line under the heading or a row (Gio, 2026-10-28, a marked screenshot): label and control only, plus the
      // row's "Saved" after a change (checked below).
      say(!section?.querySelector('.section-note') && [...(section?.querySelectorAll('.row-copy span') || [])].every((span) => span.classList.contains('times-said')), 'no grey subtext under Your free times or its rows');
      const selected = (id) => q('#' + id).selectedOptions[0]?.textContent;
      const defaults = [selected('timesStart'), selected('timesEnd'), selected('timesZone'), selected('timesShortest'), selected('timesDays'), q('#timesSelf').checked];
      say(JSON.stringify(defaults) === JSON.stringify(['9 AM', '5 PM', 'This Mac (America/New_York)', '30 min', '5 weekdays', true]), 'the rows open on the defaults: 9 AM, 5 PM, This Mac, 30 min, 5, on', JSON.stringify(defaults));
      const change = async (id, value) => { const el = q('#' + id); if (el.type === 'checkhouse') el.checked = value; else el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); await wait(); };
      const rows = [
        ['timesStart', '8', { startHour: 8 }, 'timesHoursSaid', 'Working hours start 8 AM'],
        ['timesEnd', '18', { endHour: 18 }, 'timesHoursSaid', 'Working hours end 6 PM'],
        ['timesZone', 'Europe/London', { timeZone: 'Europe/London' }, 'timesZoneSaid', 'Time zone Europe/London'],
        ['timesZone', '', { timeZone: null }, 'timesZoneSaid', 'Time zone back to This Mac'],
        ['timesShortest', '60', { minMinutes: 60 }, 'timesShortestSaid', 'Shortest opening 60 min'],
        ['timesDays', '3', { daysAhead: 3 }, 'timesDaysSaid', 'Days ahead 3'],
        ['timesSelf', false, { selfBlocks: false }, 'timesSelfSaid', 'Events with no one invited off'],
      ];
      for (const [id, value, want, said, label] of rows) {
        await change(id, value);
        const sent = last('hikyaku.setAvailability')?.[0];
        say(JSON.stringify(sent) === JSON.stringify(want) && q('#' + said).textContent === 'Saved', label + ' calls setAvailability(' + JSON.stringify(want) + ') and its row reads "Saved"', JSON.stringify(sent) + ' / ' + q('#' + said).textContent);
      }
      say(q('#timesShortest').value === '60' && q('#timesDays').value === '3' && !q('#timesSelf').checked && q('#timesZone').value === '', 'the rows show what was saved');
      // Record from these calendars (2026-10-27): one checkhouse per calendar, the main ones on, Work off; checking one
      // saves every checked id and says "Saved".
      const record = q('[data-page="settings"] #recordSection');
      const boxes = () => [...(record?.querySelectorAll('input[type="checkhouse"]') || [])];
      say(!!record && record.offsetParent !== null && record.querySelector('h2')?.textContent === 'Calendar' && boxes().length === 4
        && JSON.stringify(boxes().map((b) => b.checked)) === JSON.stringify([true, false, true, false]), 'Calendar: four calendars, the main two checked, school and Work not', JSON.stringify(boxes().map((b) => b.checked)));
      const work = boxes().find((b) => b.dataset.calendar === 'cal-icloud-work');
      if (work) { work.checked = true; work.dispatchEvent(new Event('change', { bubbles: true })); await wait(); }
      say(JSON.stringify(last('hikyaku.setRecordCalendars')?.[0]) === JSON.stringify(['cal-ex-main', 'cal-google', 'cal-icloud-work']) && q('#recordCalendarsSaid').textContent === 'Saved', 'Calendar: checking Work saves the three checked ids and reads "Saved"', JSON.stringify(last('hikyaku.setRecordCalendars')));
      // Your Mac (loggie-diagnostics): opening Settings checks every system; the chats row has its switch, and turning
      // it on reaches setupSave({ chats: true }), then checks again.
      const mac = q('#macCheck');
      const chats = mac?.querySelector('li[data-row="chats"]');
      say(!!mac && mac.offsetParent !== null && mac.querySelectorAll('#macRows li').length >= 8 && !!last('hikyaku.setupStatus') && q('#macChecked').textContent === '', 'Your Mac: Settings checks every system on open, with no "Checked just now" line', mac ? q('#macChecked').textContent + ' / ' + mac.querySelectorAll('#macRows li').length : 'no section');
      const sw = chats?.querySelector('.switch');
      say(!!sw && sw.getAttribute('aria-checked') === 'false' && /Off/.test(chats.textContent), 'Your Mac: chats show Off with a switch', chats ? chats.textContent : 'no chats row');
      const before = (window.__args || []).filter((a) => a.path === 'hikyaku.setupStatus').length;
      sw?.click(); await wait(500);
      const saved = last('hikyaku.setupSave')?.[0];
      say(JSON.stringify(saved) === JSON.stringify({ chats: true }) && (window.__args || []).filter((a) => a.path === 'hikyaku.setupStatus').length > before, 'Your Mac: the chats switch saves chats on and checks again', JSON.stringify(saved));
      q('#macAgain')?.click(); await wait(400);
      say((window.__args || []).filter((a) => a.path === 'hikyaku.setupStatus').length > before + 1, 'Your Mac: Check again checks again');
      // The mail app's Change (loggie-mail-app-switch): two choices since 2026-10-28 open in the row, the current one pressed; picking
      // another saves it through setupSave and checks again.
      const mailRow = mac?.querySelector('li[data-row="mailApp"]');
      const changeMail = [...(mailRow?.querySelectorAll('button') || [])].find((b) => b.textContent === 'Change');
      changeMail?.click(); await wait(200);
      const picks = [...(mailRow?.querySelectorAll('.mac-choices .choice') || [])];
      const current = picks.find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.choice;
      say(picks.map((b) => b.dataset.choice).join() === 'outlook,apple-mail' && !!current && mailRow.querySelector('.mac-choices').hidden === false, 'Your Mac: Change opens Outlook and Apple Mail, no Gmail', picks.map((b) => b.textContent).join(' | '));
      const other = picks.find((b) => b.dataset.choice !== current && !b.disabled);
      const checks = (window.__args || []).filter((a) => a.path === 'hikyaku.setupStatus').length;
      other?.click(); await wait(500);
      say(JSON.stringify(last('hikyaku.setupSave')?.[0]) === JSON.stringify({ mailApp: other?.dataset.choice }) && (window.__args || []).filter((a) => a.path === 'hikyaku.setupStatus').length > checks, 'Your Mac: a pick saves the mail app and checks again', JSON.stringify(last('hikyaku.setupSave')?.[0]));
      return { lines };
    })()`);
    console.log('\nSettings, Your free times, 760x900');
    for (const l of out.lines) { console.log('  ' + l); if (!l.startsWith('ok')) failed++; }
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }

  // Find your files (2026-10-28): before access Enable file search is live; a partial denial keeps it live with Open
  // folder permissions; once granted the button reads "Enabled", disabled, with no "Allowed:" paths, and a reload that
  // reads access already granted shows the same. Choose other folders and Check access again still reach the bridge.
  {
    const win = new BrowserWindow({ show: false, width: 760, height: 900 });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${String(event.sourceId).split('/').pop()}:${event.lineNumber})`); });
    const lines = [];
    const FOLDERS = `
      const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));
      const say = (ok, label, seen = '') => lines.push((ok ? 'ok   ' : 'NOTHING ') + label + (ok || !seen ? '' : ' (' + seen + ')'));
      const q = (sel) => document.querySelector(sel);
      const calls = (path) => (window.__calls || []).filter((c) => c === path).length;
      const seen = () => JSON.stringify(q('#allowFolders').textContent) + (q('#allowFolders').disabled ? ' disabled' : ' active') + ', status ' + JSON.stringify(q('#folderStatus').textContent);
      const granted = () => q('#allowFolders').textContent === 'Enabled' && q('#allowFolders').disabled && getComputedStyle(q('#allowFolders')).cursor === 'not-allowed'
        && !/Allowed|\\/tmp\\//.test(q('#folderStatus').textContent) && q('#folderSettings').hidden;
      q('#settingsButton').click(); await wait();`;
    await win.loadURL(`${base}/panel-check.html?folders=new`);
    await new Promise((r) => setTimeout(r, 1500));
    lines.push(...await win.webContents.executeJavaScript(`(async () => { const lines = [];${FOLDERS}
      say(q('#allowFolders').textContent === 'Enable file search' && !q('#allowFolders').disabled, 'before access: Enable file search is live', seen());
      const grant = window.__data['folders.allowDefaults'];
      window.__data['folders.allowDefaults'] = [{ path: '/tmp/Documents', accessible: true }, { path: '/tmp/Desktop', accessible: false }];
      q('#allowFolders').click(); await wait();
      say(q('#allowFolders').textContent === 'Enable file search' && !q('#allowFolders').disabled && /Access blocked/.test(q('#folderStatus').textContent) && !q('#folderSettings').hidden, 'a partial denial: Enable file search stays live, with Open folder permissions', seen());
      window.__data['folders.allowDefaults'] = grant;
      q('#allowFolders').click(); await wait();
      say(granted(), 'access granted: the button reads Enabled, disabled, no Allowed: paths', seen());
      const before = calls('folders.allowDefaults');
      q('#allowFolders').click(); await wait();
      say(calls('folders.allowDefaults') === before, 'Enabled cannot be pressed', (calls('folders.allowDefaults') - before) + ' more calls');
      const chose = calls('folders.choose');
      q('#chooseFolders').click(); await wait();
      say(calls('folders.choose') === chose + 1 && granted(), 'Choose other folders still reaches the bridge, the button stays Enabled', seen());
      const checked = calls('folders.status');
      q('#recheckFolders').click(); await wait();
      say(calls('folders.status') === checked + 1 && granted(), 'Check access again still reaches the bridge, the button stays Enabled', seen());
      return lines;
    })()`));
    win.webContents.reload();
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await new Promise((r) => setTimeout(r, 1500));
    lines.push(...await win.webContents.executeJavaScript(`(async () => { const lines = [];${FOLDERS}
      say(granted(), 'after a reload with access already granted: Enabled, disabled, no Allowed: paths', seen());
      return lines;
    })()`));
    console.log('\nSettings, Find your files, 760x900');
    for (const l of lines) { console.log('  ' + l); if (!l.startsWith('ok')) failed++; }
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }

  // Workspaces in the real panel: the list, a workspace's page, a call named on a move opening Notes & Meetings, and the
  // presses panel.js once dropped (Open, Edit name, Dismiss), each reaching the app through panel.js's own wrappers.
  for (const w of [760, 1500]) {
    const win = new BrowserWindow({ show: false, width: w, height: 1000 });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${String(event.sourceId).split('/').pop()}:${event.lineNumber})`); });
    await win.loadURL(`${base}/panel-check.html`);
    await new Promise((r) => setTimeout(r, 1500));
    const out = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 350) => new Promise((r) => setTimeout(r, ms));
      const lines = [];
      const say = (ok, label, seen = '') => lines.push((ok ? 'ok   ' : 'NOTHING ') + label + (ok || !seen ? '' : ' (' + seen + ')'));
      document.querySelector('[data-view="workspaces"]').click(); await wait();
      say(!document.querySelector('[data-page="workspaces"]').hidden && document.querySelectorAll('.ws-row').length === 6, 'list on the Workspaces tab', document.querySelectorAll('.ws-row').length + ' rows');
      const openBank = async () => { [...document.querySelectorAll('.ws-row')].find((r) => /Bank Offer|Renamed in the check/.test(r.textContent))?.click(); await wait(500); };
      await openBank();
      say(document.querySelector('.ws-card-title')?.textContent === 'Bank Offer', 'a row opens its page');
      say(document.querySelector('.ws-move.is-unsure'), 'a not-sure move is yellow');
      for (const open of document.querySelectorAll('.ws-move-open')) { if (document.querySelector('.ws-open-call')) break; open.click(); await wait(); }
      document.querySelector('.ws-open-call')?.click(); await wait(800);
      say(!document.querySelector('[data-page="meetings"]').hidden, 'a call on a move opens Notes & Meetings');
      document.querySelector('[data-view="workspaces"]').click(); await wait();
      const reach = async (label, run, re) => { const b = window.__calls.length; const ran = await run(); await wait(600); const got = window.__calls.slice(b); say(ran !== false && got.some((c) => re.test(c)), label, got.join(', ')); };
      const byText = (t) => [...document.querySelectorAll('.ws-view button')].find((b) => (b.textContent.trim() || b.getAttribute('aria-label') || '') === t);
      const more = async () => { const m = document.querySelector('.ws-more[aria-expanded="false"]'); m?.click(); await wait(); };
      if (!document.querySelector('.ws-card-title')) await openBank();
      await reach('Open (To send)', () => { const b = document.querySelector('.ws-to-send .ws-do'); if (!b) return false; b.click(); }, /hikyaku\\.openDraft/);
      await more();
      await reach('Edit name, Save', async () => { const e = byText('Edit name'); if (!e) return false; e.click(); await wait(); const input = document.querySelector('.ws-name-edit input'); if (!input) return false; input.value = 'Renamed in the check'; byText('Save').click(); }, /hikyaku\\.renameWorkstream/);
      if (!document.querySelector('.ws-card-title')) await openBank();
      await more();
      await reach('Retire, then Drop them', async () => { const b = byText('Retire'); if (!b) return false; b.click(); await wait(); const d = byText('Drop them'); if (!d) return false; d.click(); }, /hikyaku\\.retireWorkstream/);
      // The goal and cloud settings sit in the "..." row of a workspace's page.
      if (!document.querySelector('.ws-card-title')) await openBank();
      await more();
      say(document.querySelector('.ws-settings .goal-chips, .ws-settings .workstream-cloud'), 'goal and cloud in the ... row');
      // New workspace (loggie-new-workspace): from the list, name it, Look shows what was found and who, one person left
      // out, Save makes it with only the people still checked, and its page opens.
      document.querySelector('.ws-back')?.click(); await wait();
      document.querySelector('.ws-new-open')?.click(); await wait();
      say(document.querySelector('.ws-new-name') && document.activeElement === document.querySelector('.ws-new-name'), 'New workspace opens its box, the name box focused');
      const nameBox = document.querySelector('.ws-new-name');
      if (nameBox) { nameBox.value = 'Hotel hackathon'; nameBox.dispatchEvent(new Event('input', { bubbles: true })); }
      await reach('Look', () => { const b = document.querySelector('.ws-new-look'); if (!b) return false; b.click(); }, /hikyaku\.workspaceLook/);
      await wait();
      say(/4 emails, 1 chat and 1 call say “Hotel” or “hackathon”/.test(document.querySelector('.ws-new-found')?.textContent || '') && document.querySelectorAll('.ws-new-person input:checked').length === 3, 'Look shows the counts and the people, all checked', document.querySelector('.ws-new-found')?.textContent);
      const second = document.querySelectorAll('.ws-new-person input')[1]; if (second) { second.click(); await wait(100); }
      await reach('Save', () => { const b = document.querySelector('.ws-new-save'); if (!b) return false; b.click(); }, /hikyaku\.workspaceNew/);
      await wait(600);
      say(JSON.stringify(window.__madeWith) === JSON.stringify(['dana@hotel.example', 'lee@hotel.example']), 'Save keeps only the people left checked', JSON.stringify(window.__madeWith));
      say(document.querySelector('.ws-card-title')?.textContent === 'Hotel hackathon' && !document.querySelector('.ws-new-box'), 'the new workspace opens', document.querySelector('.ws-card-title')?.textContent);
      return { lines };
    })()`);
    console.log(`\nWorkspaces ${w}px:`);
    for (const l of out.lines) { console.log('  ' + l); if (!l.startsWith('ok')) failed++; }
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }
  // The Notes & Meetings tab (meetings.js): each press names the bridge call it must reach, or the change on screen it
  // must make; a press that does neither fails.
  for (const w of [460, 1000, 1500]) {
    const win = new BrowserWindow({ show: false, width: w, height: 1000 });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${String(event.sourceId).split('/').pop()}:${event.lineNumber})`); });
    await win.loadURL(`${base}/panel-check.html`);
    await new Promise((r) => setTimeout(r, 1200));
    const out = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
      const lines = [];
      const press = (node) => (node ? (node.click(), true) : false);
      const check = async (label, act, expect) => {
        const before = window.__calls.length;
        const ok = await act();
        await wait();
        const calls = window.__calls.slice(before);
        const reached = typeof expect === 'string' ? calls.includes(expect) : expect(calls);
        lines.push((ok !== false && reached ? 'ok   ' : 'NOTHING ') + label + ' -> ' + ([...new Set(calls)].filter((c) => !/uiAct/.test(c)).join(', ') || '(screen)'));
      };
      // The Day view reads the clock: pin it to 10:35 AM today for these checks, so a run at 10:27 PM does not push the
      // fixture's class past midnight (2026-10-25). Restored before the next section.
      const RealDate = Date;
      const pinned = new RealDate(); pinned.setHours(10, 35, 0, 0);
      const offset = pinned.getTime() - RealDate.now();
      window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [RealDate.now() + offset])); } static now() { return RealDate.now() + offset; } };
      await check('tab Notes & Meetings', () => document.querySelector('[data-view="meetings"]').click(), (c) => c.includes('hikyaku.calls') && c.includes('hikyaku.call'));
      // The Day view (meetings-day.js, loggie-meetings-focus): home is today, one card (the next meeting with people,
      // with Record), the rest as quiet rows each with Record, what the sort hid as one line, and the week as dots.
      await wait(600);
      const dayNode = () => document.querySelector('#viewMeetings .dy');
      const lastArgs = (path) => [...(window.__args || [])].reverse().find((a) => a.path === path)?.args;
      await check('Day is home, the next meeting on the card', () => true, () => document.querySelector('#viewMeetings').dataset.view === 'day' && !dayNode()?.hidden
        && document.querySelector('#viewMeetings .dy-card.is-next .dy-card-title')?.textContent === 'Coffee chat with Michael' && /^Next · in 2[45] min · 30 min long$/.test(document.querySelector('#viewMeetings .dy-card .dy-card-meta')?.textContent || '')
        && document.querySelectorAll('#viewMeetings .dy-card').length === 1);
      await check('the week strip has seven days, today picked', () => true, () => document.querySelectorAll('#viewMeetings .dy-daypick').length === 7 && document.querySelector('#viewMeetings .dy-daypick.is-picked')?.classList.contains('is-today'));
      await check('the block is a band, the class grey, neither on the card', () => true, () => !!document.querySelector('#viewMeetings .dy-row.is-block') && !!document.querySelector('#viewMeetings .dy-row.is-class') && !document.querySelector('#viewMeetings .dy-row[data-event="ev_now"]'));
      await check('Record on a block records it by its title', () => press(document.querySelector('#viewMeetings .dy-row.is-block .dy-row-record')), () => JSON.stringify(lastArgs('hikyaku.recordStart')) === JSON.stringify(['Macro: assignment work', 'row', null, 'ev_block', null]));
      document.querySelector('[data-view="meetings"]').click(); await wait(600);
      if (document.querySelector('#viewMeetings').dataset.view !== 'day') { document.querySelector('#viewMeetings .mt-back')?.click(); await wait(); }
      await check('no to-file badge on the tab', () => true, () => !document.querySelector('#meetingsBadge'));
      await check('Hidden line, Show lists what was hidden', () => press([...document.querySelectorAll('#viewMeetings .dy-foot .dy-link')].find((b) => b.textContent === 'Show')), () => /^Hidden: 1 school item, 1 duplicate · /.test(document.querySelector('#viewMeetings .dy-foot')?.textContent || '') && document.querySelectorAll('#viewMeetings .dy-hidden li').length === 2);
      // The card's chip: Pick a workspace opens the names, New workspace… last (a meeting with no recording, R3), and
      // the box holds the meeting's title with the preview line; Save sends only its id, start and the name.
      const wsNames = () => new Set((window.__data['hikyaku.workstreams'] || []).flatMap((w) => [w.name, w.label]).filter(Boolean));
      await check('Pick a workspace lists workspaces, then New workspace…', () => press(document.querySelector('#viewMeetings .dy-card .mr-chip.is-none')), () => {
        const picks = [...document.querySelectorAll('#viewMeetings .dy-card .mr-picker .mr-pick')].filter((b) => !b.classList.contains('is-cancel'));
        return picks.length >= 2 && picks.at(-1).textContent === 'New workspace…' && picks.slice(0, -1).every((b) => wsNames().has(b.textContent));
      });
      await check('New workspace… opens the box with the meeting’s name', () => press([...document.querySelectorAll('#viewMeetings .dy-card .mr-pick')].find((b) => b.textContent === 'New workspace…')), (c) => c.includes('hikyaku.eventSeed') && lastArgs('hikyaku.eventSeed')?.[0] === 'ev_now' && document.querySelector('#viewMeetings .dy-new-name')?.value === 'Coffee chat with Michael');
      await check('the preview says what will file there', () => true, () => document.querySelector('#viewMeetings .dy-new .dy-muted')?.textContent === 'Mail from 3 people at bank.example, and mail that says “Case”.');
      await check('Save makes it from the meeting', () => { const input = document.querySelector('#viewMeetings .dy-new-name'); if (!input) return false; input.value = 'Coffee Team'; return press([...document.querySelectorAll('#viewMeetings .dy-new .mr-pick')].find((b) => b.textContent === 'Save')); }, (c) => c.includes('hikyaku.workspaceFromEvent') && lastArgs('hikyaku.workspaceFromEvent')?.[0] === 'ev_now' && lastArgs('hikyaku.workspaceFromEvent')?.[2] === 'Coffee Team');
      await check('the card says the new workspace', () => true, () => document.querySelector('#viewMeetings .dy-card .mr-chip.is-placed')?.textContent === 'Coffee Team' && !document.querySelector('#viewMeetings .dy-new'));
      // loggie-pages-anytime: Record's mark is the still pencil (nothing moves at rest), and the next meeting takes a page.
      { const moving = document.getAnimations().filter((a) => a.animationName === 'rc-write' && a.playState === 'running').length;
        const still = Boolean(document.querySelector('#viewMeetings .dy-card.is-next .dy-record .rc-pencil.is-still')) && !document.querySelector('#viewMeetings .dy-record-dot');
        lines.push((moving === 0 && still ? 'ok   ' : 'NOTHING ') + 'Record shows the still pencil, nothing writes at rest (' + moving + ' moving)'); }
      await check('Fusen tab on the next meeting holds a page for it', () => press(document.querySelector('#viewMeetings .dy-card.is-next .dy-fusen')), (c) => c.includes('hikyaku.eventPagePick'));
      await check('Record on the card records the meeting by its title and its event id', () => press(document.querySelector('#viewMeetings .dy-card .dy-record')), () => JSON.stringify(lastArgs('hikyaku.recordStart')) === JSON.stringify(['Coffee chat with Michael', 'card', 'Coffee Team', 'ev_now', null]));
      if (document.querySelector('#viewMeetings').dataset.view !== 'day') { document.querySelector('#viewMeetings .mt-views .mt-view')?.click(); await wait(); }
      // Record both (split-recording-proposal.md, 2026-10-28): one meeting under way alone gives no button; two made-up
      // meetings of his at once put Record both on the card, and one press sends both ids, the one in the room first.
      await check('one meeting under way: no Record both', () => true, () => !document.querySelector('#viewMeetings .dy-both') && !!document.querySelector('#viewMeetings .dy-card.is-next'));
      { const plain = window.__data['hikyaku.events'];
        const at = (minutes) => new Date(Math.floor(Date.now() / 60000) * 60000 + minutes * 60000).toISOString();
        const made = (id, title, start, end, extra) => ({ kind: 'event', id, title, start: at(start), end: at(end), allDay: false, people: 0, who: [], call: null, workstream: null, guess: null, state: null, mark: 'none', mine: true, link: false, place: null, ...extra });
        window.__data['hikyaku.events'] = (...args) => { const week = plain(...args); return { ...week, items: [...week.items, made('ev_zoom', 'Case kickoff', -10, 40, { sort: 'people' }), made('ev_room', 'NBA 5245 Macro', 0, 75, { sort: 'class', place: 'Hall 223' })] }; };
        document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: 'today' })); await wait(200);
        document.querySelector('[data-view="meetings"]').click(); await wait(700);
        if (document.querySelector('#viewMeetings').dataset.view !== 'day') { press([...document.querySelectorAll('#viewMeetings .mt-view')].find((b) => b.textContent === 'Day')); await wait(); }
        await check('two of his at once: Record both on the card, each side named', () => true, () => document.querySelector('#viewMeetings .dy-card.is-both .dy-both')?.textContent.trim() === 'Record both'
          && /NBA 5245 Macro.*Room/.test(document.querySelector('#viewMeetings .dy-card.is-both')?.textContent || '') && /Case kickoff.*Mac sound/.test(document.querySelector('#viewMeetings .dy-card.is-both')?.textContent || ''));
        await check('Record both records both, the room first', () => press(document.querySelector('#viewMeetings .dy-card .dy-both')), () => JSON.stringify(lastArgs('hikyaku.recordStart')) === JSON.stringify(['NBA 5245 Macro', 'card', null, 'ev_room', 'ev_zoom']));
        window.__data['hikyaku.events'] = plain;
        document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: 'today' })); await wait(200);
        document.querySelector('[data-view="meetings"]').click(); await wait(700);
        if (document.querySelector('#viewMeetings').dataset.view !== 'day') { press([...document.querySelectorAll('#viewMeetings .mt-view')].find((b) => b.textContent === 'Day')); await wait(); } }
      await check('Previous day', () => press(document.querySelector('#viewMeetings .dy-step[aria-label="Previous day"]')), () => !document.querySelector('#viewMeetings .dy-card') && !!document.querySelector('#viewMeetings .dy-today'));
      await check('Today', () => press(document.querySelector('#viewMeetings .dy-today')), () => !!document.querySelector('#viewMeetings .dy-card') && !document.querySelector('#viewMeetings .dy-today'));
      // The andon (cycle 2): a call that ended today and is not filed holds the card past an hour; Leave it gives the
      // card back to the next meeting.
      const ended = { id: '2026-10-25-0950-kickoff-today', title: 'Hackathon kickoff', start: new Date(Date.now() - 105 * 60000).toISOString(), minutes: 30, people: 0, workstream: null, guess: null, state: 'done', run: null };
      window.__data['hikyaku.calls'].push(ended);
      document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: 'today' })); await wait(200);
      document.querySelector('[data-view="meetings"]').click(); await wait(700);
      await check('a call that ended over an hour ago, unfiled, holds the card', () => true, () => /^Just ended/.test(document.querySelector('#viewMeetings .dy-card .dy-card-top')?.textContent || '') && document.querySelector('#viewMeetings .dy-card .dy-card-title')?.textContent === 'Hackathon kickoff' && !!document.querySelector('#viewMeetings .dy-card .mr-chip.is-none'));
      await check('Leave it gives the card to the next meeting', () => press([...document.querySelectorAll('#viewMeetings .dy-card .dy-link')].find((b) => b.textContent === 'Leave it')), () => document.querySelector('#viewMeetings .dy-card .dy-card-title')?.textContent === 'Coffee chat with Michael');
      window.__data['hikyaku.calls'].pop();
      document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: 'today' })); await wait(200);
      document.querySelector('[data-view="meetings"]').click(); await wait(700);
      // Recordings: every call by day, and the old badge as a filter; a call opens with Back naming where it came from.
      await check('Recordings shows every call', () => press([...document.querySelectorAll('#viewMeetings .mt-view')].find((b) => b.textContent === 'Recordings')), () => document.querySelector('#viewMeetings').dataset.view === 'recordings' && !document.querySelector('#viewMeetings .mt-rail').hidden && dayNode().hidden && /^All · \\d+$/.test(document.querySelector('#viewMeetings .mt-filter')?.textContent || ''));
      await check('the to-file filter keeps only unfiled calls', () => press([...document.querySelectorAll('#viewMeetings .mt-filter')].find((b) => / to file$/.test(b.textContent))), () => { const shown = [...document.querySelectorAll('#viewMeetings .mt-item')].map((n) => n.dataset.call); const calls = window.__data['hikyaku.calls']; return shown.length > 0 && shown.every((id) => { const c = calls.find((x) => x.id === id); return c && !c.workstream; }); });
      press([...document.querySelectorAll('#viewMeetings .mt-filter')].find((b) => /^All/.test(b.textContent))); await wait();
      await check('a recording opens, Back says Recordings', () => press(document.querySelector('#viewMeetings .mt-item-open')), (c) => c.includes('hikyaku.call') && document.querySelector('#viewMeetings').dataset.view === 'call' && /Recordings/.test(document.querySelector('#viewMeetings .mt-back')?.textContent || ''));
      await check('Back returns to Recordings', () => press(document.querySelector('#viewMeetings .mt-back')), () => document.querySelector('#viewMeetings').dataset.view === 'recordings');
      await check('typing a search on Day shows Recordings; clearing it goes back', async () => { press([...document.querySelectorAll('#viewMeetings .mt-view')].find((b) => b.textContent === 'Day')); await wait(); const s = document.querySelector('#viewMeetings .mt-search'); s.value = 'yuki'; s.dispatchEvent(new Event('input')); await wait(); const there = document.querySelector('#viewMeetings').dataset.view === 'recordings'; s.value = ''; s.dispatchEvent(new Event('input')); await wait(); return there; }, () => document.querySelector('#viewMeetings').dataset.view === 'day');
      await check('a recorded row opens its notes, Back says Day', async () => { press(document.querySelector('#viewMeetings .dy-step[aria-label="Previous day"]')); await wait(); for (let i = 0; i < 7 && !document.querySelector('#viewMeetings .dy-open'); i += 1) { press(document.querySelector('#viewMeetings .dy-step[aria-label="Previous day"]')); await wait(); } if (!document.querySelector('#viewMeetings .dy-row.has-call .mr-chip')) lines.push('NOTHING a recorded row on the Day has no chip'); return press(document.querySelector('#viewMeetings .dy-open')); }, () => document.querySelector('#viewMeetings').dataset.view === 'call' && /Day/.test(document.querySelector('#viewMeetings .mt-back')?.textContent || ''));
      press(document.querySelector('#viewMeetings .mt-back')); await wait();
      press(document.querySelector('#viewMeetings .dy-today')); await wait();
      window.Date = RealDate;
      // A call-open row means he opened a call, not that a 2 s refresh reopened it (2026-10-26: 40,116 rows on his Mac):
      // while a call records the tab refreshes every 2 s; holding one call open for 4.5 s adds no row.
      { const count = () => (window.__args || []).filter((a) => a.path === 'hikyaku.uiAct' && a.args[0]?.act === 'call-open').length;
        const calls = window.__data['hikyaku.calls'];
        const was = calls[0];
        calls[0] = { ...was, state: 'recording', since: new Date(Date.now() - 60000).toISOString() };
        document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: 'today' })); await wait(200);
        document.querySelector('[data-view="meetings"]').click(); await wait(600);
        [...document.querySelectorAll('#viewMeetings .mt-view')].find((b) => b.textContent === 'Recordings')?.click(); await wait();
        document.querySelectorAll('#viewMeetings .mt-item-open')[1]?.click(); await wait(800);
        const before = count(); await wait(4500); const after = count();
        lines.push((after === before ? 'ok   ' : 'NOTHING ') + 'call-open is logged per open, not per refresh (' + (after - before) + ' rows in 4.5 s)');
        calls[0] = was; document.querySelector('#viewMeetings .mt-back')?.click(); await wait(); }
      await check('⌘K puts the caret in the ask bar', () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })); return true; }, () => document.activeElement?.id === 'message');
      document.activeElement?.blur();
      const rows = document.querySelectorAll('#viewMeetings .mt-item-open');
      await check('rail row', () => press(rows[1]), 'hikyaku.call');
      // A call opens at its top: the notes box is in view, not under the sticky header.
      const scroller = document.querySelector('#viewMeetings .mt-canvas'); if (scroller) scroller.scrollTop = 200;
      press(rows[0]); await wait(600);
      const canvasTop = document.querySelector('#viewMeetings .mt-canvas')?.scrollTop;
      if (canvasTop !== 0) lines.push('NOTHING a call opens scrolled down (' + canvasTop + ' px)');
      await check('time button', () => press(document.querySelector('#viewMeetings .mt-time')), () => !!document.querySelector('#viewMeetings .mt-line.is-hit') && document.querySelector('.mt-seg-button[data-sub="transcript"]')?.getAttribute('aria-pressed') === 'true');
      await check('Notes toggle', () => press(document.querySelector('.mt-seg-button[data-sub="notes"]')), () => !!document.querySelector('#viewMeetings .mt-steps'));
      await check('search', () => { const s = document.querySelector('#viewMeetings .mt-search'); s.value = 'yuki'; s.dispatchEvent(new Event('input')); }, () => document.querySelectorAll('#viewMeetings .mt-item').length === 1);
      await check('search what was said', async () => { const s = document.querySelector('#viewMeetings .mt-search'); s.value = 'deck'; s.dispatchEvent(new Event('input')); await wait(500); return true; }, (c) => c.includes('hikyaku.searchCalls') && !!document.querySelector('#viewMeetings .mt-item-hit mark.mt-found'));
      await check('found call opens on the line', async () => { press(document.querySelector('#viewMeetings .mt-item-hit')?.closest('.mt-item-open')); await wait(500); return true; }, () => document.querySelector('.mt-seg-button[data-sub="transcript"]')?.getAttribute('aria-pressed') === 'true' && !!document.querySelector('#viewMeetings .mt-line.is-hit mark.mt-found') && document.querySelector('#viewMeetings .mt-find-box')?.value === 'deck');
      press(document.querySelector('.mt-seg-button[data-sub="notes"]')); await wait();
      const s = document.querySelector('#viewMeetings .mt-search'); s.value = ''; s.dispatchEvent(new Event('input'));
      await check('type notes', async () => { const box = document.querySelector('#viewMeetings .mt-notes'); if (!box) return false; box.focus(); box.value = 'deck by friday'; box.dispatchEvent(new Event('input')); await wait(700); return true; }, 'hikyaku.callNotes');
      // Rename (meetings-granola-proposal c 2A, 2026-10-27): a done call's title is editable in place. It looks so on hover
      // (a dotted underline) and on focus (the ring); Enter saves, Escape puts it back; a meeting under it renames the call.
      { const title = () => document.querySelector('#viewMeetings .mt-title');
        // The check's window is never shown, so :hover and :focus cannot match here: their rules are read instead.
        const rules = [...document.styleSheets].flatMap((sheet) => { try { return [...sheet.cssRules]; } catch { return []; } });
        const hover = rules.find((rule) => rule.selectorText === '.mt-title.is-editable:hover');
        const focus = rules.find((rule) => rule.selectorText === '.mt-title.is-editable:focus');
        const t = title();
        const ring = focus?.style.boxShadow || '';
        lines.push((t?.isContentEditable && t.dataset.tip === 'Click to rename' && /dotted/.test(hover?.style.textDecoration || '') && /blue-deep/.test(ring) && !/transition|animation/.test((hover?.cssText || '') + (focus?.cssText || '')) ? 'ok   ' : 'NOTHING ') + 'the title looks editable on hover and focus, no motion (' + (hover?.style.textDecoration || 'no hover rule') + ', ' + (ring || 'no focus ring') + ')'); }
      // A hidden window gets no focus events from focus(): the check sends the one a click would.
      const focusTitle = async (t) => { t.focus(); t.dispatchEvent(new FocusEvent('focus')); await wait(); };
      await check('Enter saves a typed title', async () => { const t = document.querySelector('#viewMeetings .mt-title'); if (!t) return false; t.focus(); await wait(200); t.textContent = 'Interview with Northwind'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; },
        (c) => c.includes('hikyaku.callTitle') && JSON.stringify(lastArgs('hikyaku.callTitle')?.slice(1)) === JSON.stringify(['Interview with Northwind', null]));
      await check('Escape puts the title back and saves nothing', async () => { const t = document.querySelector('#viewMeetings .mt-title'); if (!t) return false; const was = t.textContent; t.focus(); await wait(200); t.textContent = 'Not this'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(); return t.textContent === was && document.activeElement !== t; },
        (c) => !c.includes('hikyaku.callTitle'));
      await check('a meeting under the title renames the call after it', async () => { const t = document.querySelector('#viewMeetings .mt-title'); if (!t) return false; await focusTitle(t); const pick = document.querySelector('#viewMeetings .mt-title-choice'); if (!pick || !/^Video Meeting with Northwind · /.test(pick.textContent)) return false; return press(pick); },
        (c) => c.includes('hikyaku.callTitle') && JSON.stringify(lastArgs('hikyaku.callTitle')?.slice(1)) === JSON.stringify(['Video Meeting with Northwind', { id: 'ev_mt', start: '2026-10-09T17:00:00Z' }]));
      // Who was this? (2B): when Loggie was not sure who Them was, a quiet line of names; a press names them.
      { const call = window.__data['hikyaku.call'];
        call.them = { label: 'Them', choices: ['Ana Reyes', 'Kai Brooks'], invite: null };
        const reopen = async () => { press(document.querySelectorAll('#viewMeetings .mt-item-open')[0]); await wait(700); };
        await reopen();
        await check('Who was this? names Them in one press', () => press([...document.querySelectorAll('#viewMeetings .mt-them-pick')].find((b) => b.textContent === 'Ana Reyes')),
          (c) => c.includes('hikyaku.themName') && JSON.stringify(lastArgs('hikyaku.themName')?.slice(1)) === JSON.stringify(['Ana Reyes']) && document.querySelector('#viewMeetings .mt-them')?.textContent === 'Who was this?Ana ReyesKai Brookssomeone else');
        await check('someone else opens the name box', async () => { press(document.querySelector('#viewMeetings .mt-them-pick.is-other')); await wait(); const box = document.querySelector('#viewMeetings .mt-them-box'); if (!box) return false; box.value = 'Sam Field'; box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; },
          (c) => c.includes('hikyaku.themName') && lastArgs('hikyaku.themName')?.[1] === 'Sam Field');
        delete call.them; await reopen(); }
      // New recording stays a compact button, also with a notice under it (2026-10-23: the grid slot stretched it into a
      // full-width red bar); its mark is a red dot in a ring on a plain button.
      { const rec = document.querySelector('#viewMeetings .mt-top .mt-record'); const width = rec?.getBoundingClientRect().width || 0;
        const plain = rec && getComputedStyle(rec).backgroundColor !== 'rgb(198, 40, 40)';
        if (!(width > 0 && width <= 180 && plain)) lines.push('NOTHING New recording is not a compact plain button (' + Math.round(width) + ' px)'); }
      await check('Record', () => press(document.querySelector('#viewMeetings .mt-record')), 'hikyaku.recordStart');
      // main now says the first call is recording: the rail shows its clock and ■, and the tab its red dot.
      window.__data['hikyaku.calls'][0] = { ...window.__data['hikyaku.calls'][0], state: 'recording', since: new Date(Date.now() - 65000).toISOString() };
      document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: 'today' })); await wait(200);
      document.querySelector('[data-view="meetings"]').click(); await wait(700);
      const dot = !document.querySelector('#meetingsDot').hidden;
      // The pencil (loggie-pause-attach): one mover on the page. On the Day view the card's pencil writes and the top
      // strip's stays still; off it, the top strip's writes.
      { const writing = () => document.getAnimations().filter((a) => a.animationName === 'rc-write' && a.playState === 'running').length;
        lines.push((writing() === 1 ? 'ok   ' : 'NOTHING ') + 'one pencil writes on the Day view (' + writing() + ')'); }
      await check('Pause (Day card)', () => press(document.querySelector('#viewMeetings .dy-card.is-recording .dy-pause')), (c) => c.includes('hikyaku.meetingPause'));
      await check('Fusen tab (Day card) opens the page picker', () => press(document.querySelector('#viewMeetings .dy-card.is-recording .dy-fusen')), (c) => c.includes('hikyaku.callPagePick'));
      await check('Fusen tab (top strip) opens the page picker', () => press(document.querySelector('#viewMeetings .mt-recording .mt-fusen')), (c) => c.includes('hikyaku.callPagePick'));
      // While it records, its Transcript reads the live file alone about every 0.3 s (proposal-live-stream.md): the
      // streamed words land in place without the 2 s reload.
      const recId = window.__data['hikyaku.calls'][0].id;
      press([...document.querySelectorAll('#viewMeetings .mt-item')].find((n) => n.dataset.call === recId)?.querySelector('.mt-item-open')); await wait(600);
      lines.push((document.querySelector('#viewMeetings .mt-head') && !document.querySelector('#viewMeetings .mt-head .mt-fusen') ? 'ok   ' : 'NOTHING ') + 'no second fusen in the head of a recording call (the strip has it)');
      window.__data['hikyaku.callLive'] = { id: recId, transcript: [{ at: 1, who: 'Them', text: 'Streamed words just now', raw: 'Streamed words just now' }] };
      await check('live transcript streams in', async () => { press(document.querySelector('.mt-seg-button[data-sub="transcript"]')); await wait(900); return true; },
        (c) => c.includes('hikyaku.callLive') && /Streamed words just now/.test(document.querySelector('#viewMeetings ol.mt-said')?.textContent || ''));
      press(document.querySelector('.mt-seg-button[data-sub="notes"]')); await wait();
      // While a call records the list reloads every 2 s; an open picker stays open through it (2026-10-23: it vanished
      // within a second, so no call could be filed during a recording).
      press(document.querySelector('#viewMeetings .mt-item[data-call="2026-10-08-0900-coffee-chat"] .mr-chip')); await wait(2600);
      if (!document.querySelector('#viewMeetings .mt-item[data-call="2026-10-08-0900-coffee-chat"] .mr-picker .mr-pick')) lines.push('NOTHING the picker closed by itself while a call records');
      document.querySelector('#viewMeetings')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait();
      // Pause and resume (loggie-pause-attach): one button on the top strip and the Day card; paused, it says Resume and
      // the pencil lifts, and the same press reaches hikyaku:meeting-pause.
      await check('Pause (top strip)', () => press(document.querySelector('#viewMeetings .mt-pause')), (c) => c.includes('hikyaku.meetingPause'));
      window.__data['hikyaku.calls'][0] = { ...window.__data['hikyaku.calls'][0], paused: true, pausedAt: new Date().toISOString(), pausedSeconds: 0 };
      await check('Resume (top strip)', async () => { await wait(2200); press(document.querySelector('#viewMeetings .mt-pause.is-paused')); return true; },
        (c) => c.includes('hikyaku.meetingPause') && Boolean(document.querySelector('#viewMeetings .mt-recording.is-paused .rc-pencil.is-paused')));
      window.__data['hikyaku.calls'][0] = { ...window.__data['hikyaku.calls'][0], paused: false, pausedAt: null };
      // after Stop main says the call is done, and the reload Stop makes shows it so
      window.__data['hikyaku.calls'][0] = { ...window.__data['hikyaku.calls'][0], state: 'done', since: undefined };
      await check('Stop', () => press(document.querySelector('#viewMeetings .mt-stop')), (c) => c.includes('hikyaku.meetingEnd'));
      const waitingRow = [...document.querySelectorAll('#viewMeetings .mt-item')].find((n) => n.dataset.call === '2026-10-07-1600-team-readout');
      // A waiting call (loggie-one-click-summarize): Summarize is there and pressing it is the yes; no card, no spinner.
      await check('waiting call shows Summarize, no spinner', () => press(waitingRow?.querySelector('.mt-item-open')), () => /^Summarize( again)?$/.test(document.querySelector('#viewMeetings .mt-again')?.getAttribute('aria-label') || '') && !document.querySelector('#viewMeetings .mt-status .mt-spin, #viewMeetings .mt-status .decision-card'));
      await check('Summarize on a waiting call', () => press(document.querySelector('#viewMeetings .mt-again:not(:disabled)')), 'hikyaku.summarize');
      if (!dot) lines.push('NOTHING red dot on the tab while recording');
      // The picker: the Tasks tab has loaded the cards, so it lists their names.
      const chipOf = (id) => document.querySelector('#viewMeetings .mt-item[data-call="' + id + '"] .mr-chip');
      await check('chip opens the picker', () => press(chipOf('2026-10-09-1300-weekly-sync')), () => document.querySelectorAll('#viewMeetings .mr-pick').length >= 2);
      await check('picker entry files the call', () => press([...document.querySelectorAll('#viewMeetings .mr-pick')].find((b) => !b.matches('.is-on, .is-cancel, .is-new'))), 'hikyaku.fileCall');
      // What filing did shows where the chip was (cycle 2): the workspace, what landed on its card, and the way there.
      await check('filing says what it did', () => true, () => /^Filed under .+ · notes on its card · 2 next steps on its card · Open the workspace$/.test(document.querySelector('#viewMeetings .mt-item[data-call="2026-10-09-1300-weekly-sync"] .mr-payoff')?.textContent || ''));
      await check('Open the workspace goes to its card', () => press(document.querySelector('#viewMeetings .mr-payoff .mr-link')), () => !document.querySelector('[data-page="workspaces"]')?.hidden);
      document.querySelector('[data-view="meetings"]').click(); await wait(600);
      if (document.querySelector('#viewMeetings').dataset.view !== 'recordings') { [...document.querySelectorAll('#viewMeetings .mt-view')].find((b) => b.textContent === 'Recordings')?.click(); await wait(); }
      // "No workspace" (2026-10-26: a one-time recording, or a wrong pick), on a call still showing its chip: last before Cancel, it files with no name and
      // says what it took off; the page reloads the call as in no workspace.
      await check('the picker offers No workspace last', () => press(chipOf('2026-10-07-1600-team-readout')), () => { const picks = [...document.querySelectorAll('#viewMeetings .mr-picker .mr-pick')]; return picks.at(-2)?.textContent === 'No workspace' && picks.at(-1)?.classList.contains('is-cancel'); });
      await check('No workspace files with no name', () => press([...document.querySelectorAll('#viewMeetings .mr-pick')].find((b) => b.textContent === 'No workspace')), (c) => c.includes('hikyaku.fileCall') && JSON.stringify(lastArgs('hikyaku.fileCall')?.[1]) === 'null');
      await check('and says what it took off', () => true, () => document.querySelector('#viewMeetings .mt-item[data-call="2026-10-07-1600-team-readout"] .mr-payoff')?.textContent === 'Taken off Acme Bank · 1 move set aside there');
      const guess = chipOf('2026-10-08-0900-coffee-chat');
      const guessYellow = guess?.classList.contains('is-guess') && getComputedStyle(guess).backgroundColor === 'rgb(255, 242, 179)';
      await check('guess chip', () => press(guess), () => document.querySelector('#viewMeetings .mr-pick')?.classList.contains('is-guess'));
      await check('confirm the guess', () => press(document.querySelector('#viewMeetings .mr-pick.is-guess')), (c) => c.includes('hikyaku.fileCall') && c.includes('hikyaku.answerAsk'));
      if (!guessYellow) lines.push('NOTHING the guess chip is not yellow');
      // My steps that became moves: the move row's signs, each reaching its call.
      press(document.querySelector('#viewMeetings .mt-item[data-call="2026-10-09-1300-weekly-sync"] .mt-item-open')); await wait(600);
      // Your steps (2026-10-12, mock A): the round box is Done; Draft it (message steps only), New date and Drop are in
      // the line's popup. Nothing floats over the row.
      const stepOf = (re) => [...document.querySelectorAll('#viewMeetings .mt-steps .mt-move')].find((r) => re.test(r.textContent));
      await check('step box marks it done', () => press(stepOf(/Send Lena the deck/)?.querySelector('.mt-done')), (c) => c.includes('hikyaku.markMove'));
      await check('a message step drafts from its popup', async () => { document.body.click(); await wait(); press(stepOf(/Send Lena the deck/)?.querySelector('.mt-text')); await wait(); const go = document.querySelector('#viewMeetings .mt-ask-pop .mt-step-go'); if (!go || !/to Lena/.test(go.textContent)) return false; return press(go); }, (c) => c.includes('hikyaku.doIt'));
      await check('a work step has no Draft it', async () => { document.body.click(); await wait(); press(stepOf(/Ask Jamie/)?.querySelector('.mt-text')); await wait(); return true; }, () => !!document.querySelector('#viewMeetings .mt-ask-pop') && /New date/.test(document.querySelector('#viewMeetings .mt-ask-pop').textContent) && (!document.querySelector('#viewMeetings .mt-ask-pop .mt-step-go') || /to Jamie/.test(document.querySelector('#viewMeetings .mt-ask-pop .mt-step-go').textContent)));
      await check('New date, then Save', async () => { const nd = [...document.querySelectorAll('#viewMeetings .mt-ask-pop .mt-link')].find((b) => b.textContent === 'New date'); if (!press(nd)) return false; await wait(); const d = document.querySelector('#viewMeetings .mt-step-date'); if (!d) return false; d.value = '2026-10-20'; return press([...document.querySelectorAll('#viewMeetings .mt-ask-pop .mt-step-go')].find((b) => b.textContent === 'Save')); }, (c) => c.includes('hikyaku.moveDate'));
      await check('Drop', async () => { document.body.click(); await wait(); press(stepOf(/Send Lena the deck/)?.querySelector('.mt-text')); await wait(); return press([...document.querySelectorAll('#viewMeetings .mt-ask-pop .mt-link')].find((b) => b.textContent === 'Drop')); }, (c) => c.includes('hikyaku.markMove'));
      document.body.click(); await wait();
      const nothingOnRows = [...document.querySelectorAll('#viewMeetings .mt-steps .mt-row')].every((r) => !r.querySelector('.ws-go, .ws-act'));
      if (!nothingOnRows) lines.push('NOTHING a step row still has hover buttons');
      const theirsHaveNone = [...document.querySelectorAll('#viewMeetings .mt-steps .mt-row')].filter((r) => r.querySelector('.mt-owner')).every((r) => !r.querySelector('.mt-done'));
      if (!theirsHaveNone) lines.push("NOTHING another person's step has buttons");
      await check('Summarize again', () => press(document.querySelector('#viewMeetings .mt-again:not(:disabled)')), 'hikyaku.summarize');
      await check('Fusen tab on a done call tucks a page in', () => press(document.querySelector('#viewMeetings .mt-head .mt-fusen')), (c) => c.includes('hikyaku.callPagePick'));
      await wait(600);
      await check('fix a transcript line', async () => { if (!press(document.querySelector('.mt-seg-button[data-sub="transcript"]'))) return false; await wait(); const line = document.querySelector('#viewMeetings .mt-said-text[role="textbox"]'); if (!line) return false; line.click(); await wait(100); if (!line.classList.contains('is-editing')) return false; line.textContent = 'The team owns the whole roadmap.'; line.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; }, 'hikyaku.transcriptLine');
      press(document.querySelector('.mt-seg-button[data-sub="notes"]')); await wait();
      // One Copy, for the page it is on (loggie-one-click-summarize, TC3): Copy notes on Notes, Copy transcript on Transcript.
      // What reached the clipboard is the check, not the logged act (Codex review, 2026-10-23: a copy that failed still
      // logged it and passed). The clipboard is a recorder here, so the Mac's own clipboard is never written.
      const copied = [];
      navigator.clipboard.writeText = async (text) => { copied.push(text); };
      await check('Copy on Notes copies notes', () => document.querySelectorAll('#viewMeetings .mt-copy').length === 1 && press([...document.querySelectorAll('#viewMeetings .mt-copy')].find((b) => b.getAttribute('aria-label') === 'Copy notes')), (c) => c.includes('hikyaku.uiAct') && copied.length === 1 && /The role\\n- The team owns the analytics roadmap/.test(copied[0]) && /Next steps\\n- Send Lena the deck/.test(copied[0]));
      await check('Copy on Transcript copies the transcript', async () => { press(document.querySelector('.mt-seg-button[data-sub="transcript"]')); await wait(); return document.querySelectorAll('#viewMeetings .mt-copy').length === 1 && press([...document.querySelectorAll('#viewMeetings .mt-copy')].find((b) => b.getAttribute('aria-label') === 'Copy transcript')); }, (c) => c.includes('hikyaku.uiAct') && copied.length === 2 && /\\] Lena: The team owns the analytics roadmap\\./.test(copied[1]));
      press(document.querySelector('.mt-seg-button[data-sub="notes"]')); await wait();
      // No way to add a workspace here: the picker lists workspaces only (decision 13, 2026-10-17).
      press(document.querySelector('#viewMeetings .mt-item[data-call="2026-10-09-1300-weekly-sync"] .mr-chip')); await wait();
      if ([...document.querySelectorAll('#viewMeetings .mr-picker *')].some((n) => /New workstream|New workspace/.test(n.textContent))) lines.push('NOTHING the picker still offers to add a workspace');
      document.querySelector('#viewMeetings')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait();
      // The name check (mock a, loggie-search-check): the dot word opens its suggestion with a source; ✓ uses it, Undo takes
      // it back, ✕ keeps the heard spelling; a person's name is yellow, says so, and opens nothing.
      press(document.querySelector('#viewMeetings .mt-item[data-call="2026-10-09-1300-weekly-sync"] .mt-item-open')); await wait(600);
      await check('name with a dot opens its suggestion', () => press(document.querySelector('#viewMeetings .mt-unclear.has')), () => /Heard as "MNT"/.test(document.querySelector('#viewMeetings .mt-name-pop')?.textContent || '') && document.querySelector('#viewMeetings .mt-name-src a')?.href === 'https://www.bank.example/');
      await check('✓ uses the name', () => press(document.querySelector('#viewMeetings .mt-name-ok')), (c) => c.includes('hikyaku.nameAccept') && /everywhere in this call/.test(document.querySelector('#viewMeetings .mt-toast')?.textContent || ''));
      await check('Undo', () => press(document.querySelector('#viewMeetings .mt-toast-undo')), 'hikyaku.nameUndo');
      await check('✕ keeps the heard name', async () => { if (!press(document.querySelector('#viewMeetings .mt-unclear.has'))) return false; await wait(); return press(document.querySelector('#viewMeetings .mt-name-no')); }, 'hikyaku.nameKeep');
      await check('a person is never a suggestion', () => true, () => { const p = [...document.querySelectorAll('#viewMeetings .mt-unclear')].find((n) => n.textContent === 'Jamy'); return !!p && !p.classList.contains('has') && p.title === 'A name: never searched'; });
      await check('transcript marks the same words', () => press(document.querySelector('.mt-seg-button[data-sub="transcript"]')), () => document.querySelectorAll('#viewMeetings .mt-said .mt-unclear.has, #viewMeetings .mt-said-text .mt-unclear.has').length === 1 && !/\(unclear\)/.test(document.querySelector('#viewMeetings .mt-canvas')?.textContent || ''));
      press(document.querySelector('.mt-seg-button[data-sub="notes"]')); await wait();
      await check('Checking names while the check runs', async () => { window.__data['hikyaku.call'].nameCheck.status = 'checking'; press(document.querySelector('#viewMeetings .mt-item[data-call="2026-10-09-1300-weekly-sync"] .mt-item-open')); await wait(600); return true; }, () => document.querySelector('#viewMeetings .mt-status .mt-working')?.textContent === 'Checking names' && !document.querySelector('#viewMeetings .mt-unclear.has'));
      window.__data['hikyaku.call'].nameCheck.status = 'done';
      press(document.querySelector('#viewMeetings .mt-item[data-call="2026-10-09-1300-weekly-sync"] .mt-item-open')); await wait(600);
      // A point Loggie could not confirm is a link to its explanation (2026-10-12): the popup opens with what the call
      // says, and "It's right" and "Fix it" reach the bridge. Yellow is left only on unclear words and workstream guesses.
      await check('a not-confirmed point opens its explanation', () => press([...document.querySelectorAll('#viewMeetings .mt-row.is-ask')].find((r) => /June/.test(r.textContent))), () => /nobody named June/.test(document.querySelector('#viewMeetings .mt-ask-pop')?.textContent || '') && !!document.querySelector('#viewMeetings .mt-ask-pop .mt-said-quote .mt-time'));
      await check('a confirmed point shows where it came from', async () => { document.body.click(); await wait(); return press([...document.querySelectorAll('#viewMeetings .mt-row.is-source')].find((r) => /analytics roadmap/.test(r.textContent))); }, () => /Where this came from/i.test(document.querySelector('#viewMeetings .mt-ask-pop')?.textContent || '') && !document.querySelector('#viewMeetings .mt-ask-pop .mt-ask-yes'));
      await check('the popup minute opens the transcript', () => press(document.querySelector('#viewMeetings .mt-ask-pop .mt-time')), () => document.querySelector('.mt-seg-button[data-sub="transcript"]')?.getAttribute('aria-pressed') === 'true' && !!document.querySelector('#viewMeetings .mt-line.is-hit'));
      press(document.querySelector('.mt-seg-button[data-sub="notes"]')); await wait();
      press([...document.querySelectorAll('#viewMeetings .mt-row.is-ask')].find((r) => /June/.test(r.textContent))); await wait();
      await check("It's right", () => press(document.querySelector('#viewMeetings .mt-ask-yes')), (c) => c.includes('hikyaku.noteLine'));
      await check('Fix it, then Enter', async () => { if (!press([...document.querySelectorAll('#viewMeetings .mt-row.is-ask')].find((r) => /June/.test(r.textContent)))) return false; await wait(); if (!press(document.querySelector('#viewMeetings .mt-ask-no'))) return false; await wait(); const i = document.querySelector('#viewMeetings .mt-ask-fix'); if (!i) return false; i.value = 'Start date may move; June not said'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; }, (c) => c.includes('hikyaku.noteLine'));
      const unsure = document.querySelectorAll('#viewMeetings .mt-row.is-ask').length;
      const yellowOnlyUnsure = [...document.querySelectorAll('#viewMeetings *')].every((n) => getComputedStyle(n).backgroundColor !== 'rgb(255, 242, 179)' || n.classList.contains('is-guess') || n.classList.contains('mt-unclear'));
      const theirs = [...document.querySelectorAll('#viewMeetings .mt-steps .mt-row')].filter((r) => r.querySelector('.mt-owner')).length;
      return { lines, unsure, yellowOnlyUnsure, theirs };
    })()`);
    console.log(`\nMeetings ${w}px: ${out.unsure} not-confirmed rows open their popup, ${out.yellowOnlyUnsure ? 'yellow only on unclear words and guesses' : 'YELLOW ON A ROW'}, ${out.theirs} step(s) with an owner name`);
    for (const l of out.lines) { console.log('  ' + l); if (!l.startsWith('ok')) failed++; }
    if (out.unsure < 2 || !out.yellowOnlyUnsure || out.theirs !== 1) failed++;
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }
  // Codex review, 2026-10-23: presses that raced the notes box, failed out of sight, or left a control dead. The stand-in
  // keeps what main keeps: notes saved by callNotes are the call's notes and Summarize reads the saved ones (main reads
  // my-notes.md); a permission's ask answers and records nothing, and only setupSave records an answer (main's
  // setup-ask and setup-save).
  {
    const win = new BrowserWindow({ show: false, width: 1000, height: 1000 });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${String(event.sourceId).split('/').pop()}:${event.lineNumber})`); });
    await win.loadURL(`${base}/panel-check.html`);
    await new Promise((r) => setTimeout(r, 1200));
    const out = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
      const lines = [];
      const say = (ok, label, seen = '') => lines.push((ok ? 'ok   ' : 'NOTHING ') + label + (ok || !seen ? '' : ' (' + seen + ')'));
      const q = (sel) => document.querySelector(sel);
      const call = window.__data['hikyaku.call'];
      const saves = [];
      window.__data['hikyaku.callNotes'] = (id, text) => { saves.push(text); call.notes = text; return { saved: true, chars: text.length }; };
      let summarizedWith = null;
      window.__data['hikyaku.summarize'] = () => { summarizedWith = call.notes; return { ok: true, run: 'run_9' }; };
      q('[data-view="meetings"]').click(); await wait(800);
      q('#viewMeetings .mt-item[data-call="2026-10-09-1300-weekly-sync"] .mt-item-open')?.click(); await wait(800);
      // Notes typed, then Summarize pressed inside the 600 ms the box waits before it saves (finding 2).
      const box = q('#viewMeetings .mt-notes');
      box.focus(); box.value = 'typed just now'; box.dispatchEvent(new Event('input'));
      const again = q('#viewMeetings .mt-again:not(:disabled)');
      again?.focus(); again?.click();
      await wait(1200);
      say(summarizedWith === 'typed just now', 'Summarize right after typing summarizes the new notes', JSON.stringify(summarizedWith));
      say(q('#viewMeetings .mt-notes')?.value === 'typed just now', 'Summarize right after typing keeps them in the box', JSON.stringify(q('#viewMeetings .mt-notes')?.value));
      say(saves.at(-1) === 'typed just now', 'the last save is the new notes', JSON.stringify(saves));
      // A copy the clipboard refuses says so where notices show; one it takes copies the notes and says Copied (finding 8).
      const copy = () => [...document.querySelectorAll('#viewMeetings .mt-copy')].find((b) => b.getAttribute('aria-label') === 'Copy notes');
      navigator.clipboard.writeText = async () => { throw new Error('Document is not focused.'); };
      copy()?.click(); await wait();
      const notice = q('#viewMeetings .mt-notice');
      say(!!notice && notice.offsetParent !== null && /Could not copy: Document is not focused/.test(notice.textContent) && !!copy(), 'a copy that fails says so', notice?.textContent || 'no notice');
      const copied = [];
      navigator.clipboard.writeText = async (text) => { copied.push(text); };
      const button = copy();
      button?.click(); await wait(100);
      say(copied.length === 1 && copied[0].startsWith('typed just now') && button?.getAttribute('aria-label') === 'Copied' && !q('#viewMeetings .mt-notice'), 'a copy that works copies the notes, says Copied and clears the notice', JSON.stringify(copied) + ' / ' + button?.textContent);
      // Settings, Your Mac: Turn on records what macOS answered, so the row shows it (finding 4).
      const status = { done: true, step: null, signName: 'Alex', mailApp: 'apple-mail', chats: false, installed: { outlook: true, whatsapp: false }, hostApp: 'Terminal',
        permissions: { calendar: 'granted', fullDisk: 'granted', microphone: 'granted', screen: 'granted', accessibility: 'granted', automation: 'unknown' }, mail: { accounts: 1 },
        keys: { nebius: true, tavily: true }, yes: { ai: true, chats: false }, voice: { answer: null, helper: 'built' }, fileVault: 'on' };
      window.__data['hikyaku.setupStatus'] = () => structuredClone(status);
      window.__data['hikyaku.setupAsk'] = (what) => {
        if (what === 'automation') return { status: 'granted', mail: 'granted', systemEvents: 'granted' };
        if (what === 'speech') { setTimeout(() => (window.__listeners['voice.onUpdate'] || []).forEach((listener) => listener({ status: 'permissions-complete' })), 80); return { status: 'starting' }; }
        return { opened: true };
      };
      const recorded = [];
      window.__data['hikyaku.setupSave'] = (patch) => { recorded.push(patch); if ('automation' in patch) status.permissions.automation = patch.automation; if ('voice' in patch) status.voice.answer = patch.voice; if ('chats' in patch) status.chats = patch.chats; if ('mailApp' in patch) status.mailApp = patch.mailApp; return {}; };
      q('#settingsButton').click(); await wait(600);
      const row = (key) => q('#macRows li[data-row="' + key + '"]');
      const on = (key) => row(key)?.querySelector('.st')?.classList.contains('on');
      const turnOn = (key) => [...(row(key)?.querySelectorAll('button') || [])].find((b) => b.textContent === 'Turn on');
      say(!on('mailApp') && !!turnOn('mailApp'), 'Your Mac: Apple Mail control is not on yet, with Turn on', row('mailApp')?.textContent);
      turnOn('mailApp')?.click(); await wait(600);
      say(on('mailApp') && JSON.stringify(recorded.at(-1)) === JSON.stringify({ automation: 'granted' }), 'Your Mac: Turn on for Apple Mail records the answer and the row says On', JSON.stringify(recorded) + ' / ' + row('mailApp')?.textContent);
      turnOn('voice')?.click(); await wait(800);
      say(on('voice') && JSON.stringify(recorded.at(-1)) === JSON.stringify({ voice: 'granted' }), 'Your Mac: Turn on for voice typing waits for macOS, records it and the row says On', JSON.stringify(recorded) + ' / ' + row('voice')?.textContent);
      // A save that fails says why and leaves its control usable (finding 5).
      window.__data['hikyaku.setupSave'] = () => { throw new Error('settings.json could not be read.'); };
      row('chats')?.querySelector('.switch')?.click(); await wait(500);
      say(/settings\\.json could not be read/.test(row('chats')?.textContent || '') && row('chats')?.querySelector('.switch')?.disabled === false, 'Your Mac: a chats save that fails says why and the switch still works', row('chats')?.textContent);
      [...(row('mailApp')?.querySelectorAll('button') || [])].find((b) => b.textContent === 'Change')?.click(); await wait(200);
      const other = [...(row('mailApp')?.querySelectorAll('.mac-choices .choice') || [])].find((b) => b.getAttribute('aria-pressed') !== 'true' && !b.disabled);
      other?.click(); await wait(500);
      const picks = [...(row('mailApp')?.querySelectorAll('.mac-choices .choice') || [])];
      say(!!other && /settings\\.json could not be read/.test(row('mailApp')?.textContent || '') && picks.length === 2 && picks.every((b) => b.disabled === false), 'Your Mac: a mail app save that fails says why and the choices still work', picks.map((b) => b.textContent + (b.disabled ? ' (off)' : '')).join(' | '));
      return { lines };
    })()`);
    console.log('\nCodex review 2026-10-23: notes before Summarize, Copy, Your Mac');
    for (const l of out.lines) { console.log('  ' + l); if (!l.startsWith('ok')) failed++; }
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }
  // The ask box: an example fills the box, a two-person name offers both as buttons and a choice runs, the status
  // line shows the step and Stop reaches the bridge, and the card says where the draft is and closes.
  for (const w of [460, 1000]) {
    const win = new BrowserWindow({ show: false, width: w, height: 900 });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${String(event.sourceId).split('/').pop()}:${event.lineNumber})`); });
    await win.loadURL(`${base}/panel-check.html`);
    await new Promise((r) => setTimeout(r, 1200));
    const out = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
      const lines = [];
      const calls = (from) => window.__calls.slice(from).filter((c) => /^ask\./.test(c));
      const chip = document.querySelector('.ask-chip');
      if (!chip) return { lines: ['NOTHING example chips missing'] };
      chip.click(); await wait();
      lines.push((document.querySelector('#message').value === 'Text ' ? 'ok   ' : 'NOTHING ') + 'example chip -> starts the sentence');
      const choice = document.querySelector('.ask-under .ask-choice');
      lines.push((choice ? 'ok   ' : 'NOTHING ') + 'two Lenas -> ' + (choice ? document.querySelectorAll('.ask-under .ask-choice').length + ' choices' : 'no choices'));
      // Which Lena: every choice shows the address beside the name (loggie-intros fix 1: two Rowenas were two equal buttons).
      const choiceTexts = [...document.querySelectorAll('.ask-under .ask-choice')].map((x) => x.textContent);
      lines.push((choiceTexts.length === 2 && choiceTexts[0].includes('Lena Ortiz <+13235550100>') && choiceTexts[1].includes('Lena Brooks <lena.brooks@example.org>') ? 'ok   ' : 'NOTHING ') + 'which Lena -> each choice holds the address: ' + choiceTexts.join(' | '));
      let b = window.__calls.length;
      choice?.click(); await wait();
      lines.push((calls(b).includes('ask.run') ? 'ok   ' : 'NOTHING ') + 'pick Lena Ortiz -> ' + calls(b).join(', '));
      for (const l of window.__listeners['ask.onStep'] || []) l({ askId: '2026-10-11-abcdef12', step: 1, of: 2, label: 'Finding your chat with Lena Ortiz' });
      await wait(100);
      const status = document.querySelector('#askStatus');
      lines.push((!status.hidden && /Finding your chat/.test(status.textContent) && /step 1 of 2/.test(status.textContent) ? 'ok   ' : 'NOTHING ') + 'status line -> ' + status.textContent.trim().slice(0, 60));
      b = window.__calls.length;
      status.querySelector('.ask-stop').click(); await wait();
      lines.push((calls(b).includes('ask.stop') ? 'ok   ' : 'NOTHING ') + 'Stop -> ' + calls(b).join(', '));
      for (const l of window.__listeners['ask.onDone'] || []) l({ askId: '2026-10-11-abcdef12', outcome: 'placed', action: 'message', words: 'Running late', lines: ['Ready in Messages: Lena Ortiz. You send it there.'], results: [{ to: 'Lena Ortiz', app: 'messages', kind: 'person', outcome: 'placed', detail: '' }], did: ['Matched "lena" to Lena Ortiz in Messages', 'Typed it into the chat with Lena Ortiz in Messages, unsent'], ms: 900, undoable: true });
      await wait(100);
      const card = document.querySelector('#askCard');
      lines.push((!card.hidden && /Ready/.test(card.textContent) && /Lena Ortiz/.test(card.textContent) && status.hidden ? 'ok   ' : 'NOTHING ') + 'card -> ' + card.textContent.trim().slice(0, 60));
      card.querySelector('summary')?.click(); await wait(100);
      lines.push((card.querySelector('details')?.open ? 'ok   ' : 'NOTHING ') + 'What I did -> opens');
      const undoButton = [...card.querySelectorAll('.ask-close')].find((x) => x.textContent === 'Undo');
      b = window.__calls.length; undoButton?.click(); await wait();
      lines.push((undoButton && calls(b).includes('ask.undo') && /Cleared the draft/.test(card.textContent) ? 'ok   ' : 'NOTHING ') + 'Undo -> ' + calls(b).join(', '));
      card.querySelector('.ask-close')?.click(); await wait(100);
      lines.push((card.hidden ? 'ok   ' : 'NOTHING ') + 'Done -> closes the card');
      // A sentence code could not read: the yes card's answers run it again; Did you mean's Yes runs the reading.
      for (const l of window.__listeners['ask.onDone'] || []) l({ askId: '2026-10-11-abcdef12', outcome: 'question', status: 'needs-yes', yesFor: 'sentence', action: 'unknown', lines: ['Code could not read this.'], did: [], ms: 3 });
      await wait(100);
      let yesOnce = [...card.querySelectorAll('.ask-choice')].find((x) => x.textContent === 'Yes, this time');
      b = window.__calls.length; yesOnce?.click(); await wait();
      lines.push((yesOnce && calls(b).includes('ask.run') ? 'ok   ' : 'NOTHING ') + 'sentence yes -> ' + calls(b).join(', '));
      for (const l of window.__listeners['ask.onDone'] || []) l({ askId: '2026-10-11-abcdef12', outcome: 'question', status: 'did-you-mean', action: 'message', rewrite: 'text bruno and arlo Running late', lines: ['text bruno and arlo Running late'], did: [], ms: 900 });
      await wait(100);
      const doThat = [...card.querySelectorAll('.ask-choice')].find((x) => x.textContent === 'Yes, do that');
      b = window.__calls.length; doThat?.click(); await wait();
      lines.push((doThat && calls(b).includes('ask.run') && document.querySelector('#message').value === 'text bruno and arlo Running late' ? 'ok   ' : 'NOTHING ') + 'did you mean yes -> ' + calls(b).join(', '));
      for (const l of window.__listeners['ask.onDone'] || []) l({ askId: '2026-10-11-abcdef12', outcome: 'stopped', lines: [], did: [], ms: 1 });
      await wait(100);
      // Moving a meeting: two that fit are buttons, and a pick runs the ask with that meeting.
      for (const l of window.__listeners['ask.onDone'] || []) l({ askId: '2026-10-11-abcdef12', outcome: 'question', status: 'which', action: 'move', lines: ['Which meeting?'], who: [{ text: 'meeting', status: 'many', candidates: [{ name: 'Case team sync · Mon 10:00 AM', app: 'outlook', kind: 'meeting', key: 'e2', last: '' }, { name: 'Case team sync · Wed 10:00 AM', app: 'outlook', kind: 'meeting', key: 'e3', last: '' }] }], did: [], ms: 40 });
      await wait(100);
      const meetingPick = card.querySelector('.ask-choice');
      b = window.__calls.length; meetingPick?.click(); await wait();
      lines.push((meetingPick && calls(b).includes('ask.run') ? 'ok   ' : 'NOTHING ') + 'which meeting -> ' + calls(b).join(', '));
      for (const l of window.__listeners['ask.onDone'] || []) l({ askId: '2026-10-11-abcdef12', outcome: 'placed', action: 'move', words: '', lines: ['Moved in Outlook: Case team sync. Press Send there to tell everyone.'], results: [{ to: 'Case team sync', app: 'outlook', kind: 'meeting', outcome: 'placed', detail: '' }], did: ['Moved it'], ms: 3500 });
      await wait(100);
      lines.push((/moved in its window/.test(card.textContent) ? 'ok   ' : 'NOTHING ') + 'move card -> ' + card.textContent.trim().slice(0, 50));
      card.querySelector('.ask-close')?.click(); await wait(100);
      // What someone said: the card lists their messages and Done closes it.
      for (const l of window.__listeners['ask.onDone'] || []) l({ askId: '2026-10-11-abcdef12', outcome: 'answered', action: 'said', lines: ['Last from Gideon Hale: Oct 11'], results: [{ to: 'Gideon Hale', app: 'whatsapp', kind: 'person', outcome: 'answered', messages: [{ from: 'Gideon Hale', fromMe: false, text: 'Great, thanks', at: '2026-10-11T08:00:00Z' }] }], did: ['Read 1 recent message in WhatsApp (Gideon Hale)'], ms: 300 });
      await wait(100);
      lines.push((!card.hidden && /Great, thanks/.test(card.textContent) && /Last from Gideon/.test(card.textContent) ? 'ok   ' : 'NOTHING ') + 'said card -> ' + card.textContent.trim().slice(0, 50));
      card.querySelector('.ask-close')?.click(); await wait(100);
      lines.push((card.hidden ? 'ok   ' : 'NOTHING ') + 'said Done -> closes');
      // An email reply waits for the cloud yes: each of its three answers runs the ask again with that answer.
      for (const label of ['Always write my replies', 'Just this one', 'Send my note as typed']) {
        for (const l of window.__listeners['ask.onDone'] || []) l({ askId: '2026-10-11-abcdef12', outcome: 'question', status: 'needs-yes', action: 'reply', to: 'Jamie Park', lines: ['To write the reply, the cloud AI would read the last email from Jamie Park and your line.'], did: [], ms: 5 });
        await wait(100);
        const button = [...card.querySelectorAll('.ask-choice')].find((b) => b.textContent === label);
        b = window.__calls.length;
        button?.click(); await wait();
        lines.push((button && calls(b).includes('ask.run') ? 'ok   ' : 'NOTHING ') + 'reply yes "' + label + '" -> ' + calls(b).join(', '));
        for (const l of window.__listeners['ask.onDone'] || []) l({ askId: '2026-10-11-abcdef12', outcome: 'stopped', lines: [], did: [], ms: 1 });
        await wait(100);
      }
      // loggie-reply-yes: a run a Reply row started (origin 'row') never draws the box's card, even a yes question.
      card.hidden = true;
      for (const l of window.__listeners['ask.onDone'] || []) l({ askId: '2026-10-21-rowrun01', origin: 'row', outcome: 'question', status: 'needs-yes', action: 'reply', to: 'Jamie Park', lines: ['x'], did: [], ms: 5 });
      await wait(100);
      lines.push((card.hidden ? 'ok   ' : 'NOTHING ') + 'a run a Reply row started draws no ask box card');
      // A draft held for a time: the card asks for it, and Put it in reaches the fill call, then says ready.
      for (const l of window.__listeners['ask.onDone'] || []) l({ askId: '2026-10-11-abcdef12', outcome: 'question', status: 'needs-time', action: 'reply', to: 'Jamie Park', lines: ['Jamie asked about a time and Loggie could not tell which. Which time works?'], results: [{ to: 'Jamie Park', app: 'outlook', kind: 'person', outcome: 'held', detail: 'Jamie asked about a time and Loggie could not tell which. Which time works?' }], did: [], ms: 5 });
      await wait(100);
      const timeBox = card.querySelector('.ask-time');
      if (timeBox) timeBox.value = '3 PM';
      const putIt = [...card.querySelectorAll('.ask-choice')].find((x) => x.textContent === 'Put it in');
      b = window.__calls.length; putIt?.click(); await wait();
      lines.push((timeBox && putIt && calls(b).includes('ask.fill') && /Ready/.test(card.textContent) ? 'ok   ' : 'NOTHING ') + 'held for a time -> ' + calls(b).join(', ') + ' | ' + card.textContent.trim().slice(0, 40));
      card.querySelector('.ask-close')?.click(); await wait(100);
      // A placed reply with the helper's read-back: the card says what to check before Send.
      for (const l of window.__listeners['ask.onDone'] || []) l({ askId: '2026-10-11-abcdef12', outcome: 'placed', action: 'reply', words: 'Hi Jamie, Tuesday works.', lines: ['Ready in Outlook: Jamie Park. You send it there.'], results: [{ to: 'Jamie Park', app: 'outlook', kind: 'person', outcome: 'placed', detail: '', drafted: 'ai', check: 'Your signature appears 2 times; delete one.' }], did: [], ms: 5 });
      await wait(100);
      lines.push((/Check before sending: Your signature appears 2 times/.test(card.textContent) ? 'ok   ' : 'NOTHING ') + 'placed reply shows what to check before Send');
      card.querySelector('.ask-close')?.click(); await wait(100);
      // An email written but not opened: the card says so, and Try again reaches the again call.
      for (const l of window.__listeners['ask.onDone'] || []) l({ askId: '2026-10-11-abcdef12', outcome: 'clipboard', action: 'reply', lines: ['Jamie Park: Outlook is showing the Calendar.'], results: [{ to: 'Jamie Park', app: 'outlook', kind: 'person', outcome: 'clipboard', detail: 'Outlook is showing the Calendar.' }], did: [], ms: 5 });
      await wait(100);
      const retry = [...card.querySelectorAll('.ask-choice')].find((x) => x.textContent === 'Try again');
      b = window.__calls.length; retry?.click(); await wait();
      lines.push((retry && /not opened in Outlook/.test(card.textContent) === false && calls(b).includes('ask.again') ? 'ok   ' : 'NOTHING ') + 'not opened -> Try again -> ' + calls(b).join(', '));
      card.querySelector('.ask-close')?.click(); await wait(100);
      return { lines };
    })()`);
    console.log(`\nAsk box ${w}px`);
    for (const l of out.lines) { console.log('  ' + l); if (!l.startsWith('ok')) failed++; }
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }
  // The setup page (setup.js, spec B5): a fresh Mac on each mail path opens on Welcome with the tabs and the ask bar
  // away; every step has at most one filled button, in view at 760 x 540; each press reaches its call; the paths reach
  // Ready; Quit & Reopen lands on Ready; Done saves done and shows Today. ?slow=1: the button disables and the waiting
  // line draws within 50 ms of the press. The marks (first-run-polish B2): each card's mark, the Email tiles' icons and
  // a grant's tick on the mark; with &icons=none (the Mac gives no icon) Gio's bundled marks, and the pay line's own ✓.
  for (const [path, icons, mail] of [['outlook', '', ''], ['apple-mail', '', '0'], ['outlook', 'none', '']]) {
    const win = new BrowserWindow({ show: false, width: 760, height: 540, useContentSize: true });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${String(event.sourceId).split('/').pop()}:${event.lineNumber})`); });
    const url = `${base}/panel-check.html?setup=${path}${icons ? `&icons=${icons}` : ''}${mail ? `&mail=${mail}` : ''}`;
    await win.loadURL(url);
    await win.webContents.executeJavaScript('sessionStorage.clear()');
    await win.loadURL(url);
    await new Promise((r) => setTimeout(r, 1200));
    const walk = (reopen) => win.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
      const lines = [];
      const say = (ok, label, detail = '') => lines.push((ok ? 'ok   ' : 'NOTHING ') + label + (detail ? ' -> ' + detail : ''));
      const step = () => document.querySelector('.setup-page .su-card')?.dataset.step;
      const bigs = () => [...document.querySelectorAll('.setup-page .btn-big')].filter((b) => !b.disabled && b.offsetParent);
      const inView = (b) => { const r = b.getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; };
      const sent = (path) => (window.__args || []).filter((a) => a.path === path).map((a) => a.args[0]);
      const last = (path) => [...(window.__args || [])].reverse().find((a) => a.path === path)?.args;
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const press = async (b, ms = 500) => { if (!b) return false; b.click(); await wait(ms); return true; };
      const bigLabelled = (re) => bigs().find((b) => re.test(b.textContent));
      const noIcons = ${icons === 'none' ? 'true' : 'false'};
      const tile = (name) => [...document.querySelectorAll('.setup-page .choice')].find((b) => b.querySelector('.su-tile-name')?.textContent === name);
      // M1: the card's mark. With every icon given, six cards wear one; with none given, only the ones that need no icon.
      const marked = noIcons ? ['welcome', 'apps', 'voice'] : ['welcome', 'calendar', 'disk', 'apps', 'voice', 'calls'];
      const logoSays = (s) => {
        const logo = document.querySelector('.setup-page .su-card .su-logo');
        if (!marked.includes(s)) return say(!logo, s + ': no mark on the card', logo?.outerHTML.slice(0, 80));
        const ok = noIcons && s === 'apps' ? !!logo?.querySelector('img[src$="marks/outlook.png"]') : !!logo?.querySelector('img[src^="data:"], svg');
        say(ok, s + ': the card wears its mark', logo?.outerHTML.slice(0, 80) || 'none');
      };
      // M3 and M5: a grant ticks the mark, and then the ok pay line has no ✓ of its own; with no mark, it keeps it.
      const tickSays = (s, text) => {
        const line = document.querySelector('.setup-page .su-pay.ok');
        const ticked = !!document.querySelector('.setup-page .su-logo .su-tick');
        const own = !!line?.querySelector('.tick');
        const ok = noIcons && s === 'calendar' ? !ticked && own && !line.classList.contains('after-cue') : ticked && !!line && !own && (!text || line.textContent === text);
        say(ok, s + (noIcons && s === 'calendar' ? ': no mark, so the ok pay line keeps its ✓ and no delay' : ': the grant ticks the mark, the ok pay line has no ✓'), (line?.className || 'no ok line') + ' ' + (line?.textContent || ''));
      };
      if (${reopen ? 'true' : 'false'}) {
        say(step() === 'ready', 'Quit & Reopen lands on Ready', step());
        // C6 (first-run-polish B4.7): a first run's Ready names the Found step that comes next.
        const find = bigLabelled(/^Find my workspaces$/);
        const note = document.querySelector('.setup-page .su-ready-foot .su-note')?.textContent;
        say(!!find && note === 'Next, Loggie reads your last 30 days of mail and shows what it found. A few minutes.', 'C6 Ready reads Find my workspaces and says what comes next', (find?.textContent || 'no button') + ' | ' + note);
        return { lines, step: step() };
      }
      logoSays('welcome');${TIPS}
      const tipsMissed = [];
      const tipsAt = (where) => { for (const b of untitled()) tipsMissed.push(where + ': ' + b); };
      tipsAt('welcome');
      say(document.body.classList.contains('is-setup') && step() === 'welcome' && !document.querySelector('#composer').offsetParent && getComputedStyle(document.querySelector('.workspace-nav')).visibility === 'hidden', 'opens on Welcome, tabs and ask bar away', step());
      const name = document.querySelector('.setup-page .su-name');
      say(document.activeElement === name && name.value === 'Alex', 'the name is prefilled from the Mac and focused');
      say(document.querySelector('.setup-page h3').textContent === 'Set up Loggie once', 'welcome says it in one line');
      name.value = 'Sam'; await press(bigLabelled(/^Start$/));
      say(sent('hikyaku.setupSave').some((p) => p.signName === 'Sam' && p.step === 'email'), 'Start saves the name');
      const label = { outlook: 'Outlook', 'apple-mail': 'Apple Mail' }['${path}'];
      say(bigs().length === 0, 'Continue waits for a choice');
      logoSays('email');
      tipsAt('email');
      // M2: the tiles' icons. Fix 2 (2026-10-28): one question, two tiles, and the line that mail is read through Apple Mail.
      const tileImg = (name, src) => !!tile(name)?.querySelector(noIcons ? '.su-tile-icon img[src$="' + src + '"]' : '.su-tile-icon img[src^="data:"]');
      say(tileImg('Outlook', 'marks/outlook.png') && tileImg('Apple Mail', 'marks/apple-mail.png'), 'email: the Outlook and Apple Mail tiles wear ' + (noIcons ? 'the bundled marks' : 'their app icons'));
      const tiles = [...document.querySelectorAll('.setup-page .choice .su-tile-name')].map((n) => n.textContent);
      const why = document.querySelector('.setup-page .su-card[data-step="email"] .why')?.textContent;
      say(document.querySelector('.setup-page .su-card[data-step="email"] h3')?.textContent === 'Where do you write email?' && tiles.join(' | ') === 'Outlook | Apple Mail' && /^Loggie reads your mail through Apple Mail/.test(why || ''), 'email: one question, two tiles, the Apple Mail line', tiles.join(' | ') + ' / ' + why);
      if (noIcons) { document.querySelector('.setup-page .switch[role="switch"]').click(); await wait(100); }
      await press(tile(label), 100);
      say(document.activeElement?.textContent === 'Continue', 'a choice moves focus to Continue');
      await press(bigLabelled(/^Continue$/));
      say(sent('hikyaku.setupSave').some((p) => p.mailApp === '${path}'), 'Continue saves the mail app');
      const seen = [];
      for (let guard = 0; guard < 14 && step() !== 'ready'; guard += 1) {
        const now = step();
        if (seen.at(-1) !== now) {
          seen.push(now);
          logoSays(now);
          tipsAt(now);
          if (noIcons && now === 'apps') say(!!document.querySelector('.setup-page .su-top img.su-logo-small[src$="marks/messages.png"]'), 'apps: texts on, the Messages mark beside it');
          const filled = bigs();
          if (filled.length > 1) say(false, now + ': one filled button', filled.map((b) => b.textContent).join(' + '));
          if (filled[0] && !inView(filled[0])) say(false, now + ': its button is in view at 760 x 540');
        }
        if (now === 'keys') {
          for (const box of document.querySelectorAll('.setup-page .keyrow input')) { box.value = 'nb-made-up-key-0001'; box.dispatchEvent(new Event('input')); await wait(150); }
          say(![...document.querySelectorAll('.setup-page *')].some((n) => n.childElementCount === 0 && /made-up-key/.test(n.textContent)) && [...document.querySelectorAll('.setup-page .keyrow input')].every((i) => i.value === ''), 'keys: the key is never drawn');
          say([...document.querySelectorAll('.setup-page .keyrow .state')].every((n) => /^Works, /.test(n.textContent)), 'keys: both say Works');
          await press(document.querySelector('.setup-page .su-yes'), 1000);
          say(sent('hikyaku.cloudYesAnswer').includes('ai'), 'keys: Yes reaches the cloud yes');
          continue;
        }
        if (now === 'calls') {
          // first-run-polish B5.2 (S6): the speech switch starts on, says NVIDIA and the size; every way out saves it.
          const sw = document.querySelector('.setup-page .su-card[data-step="calls"] .rowx-plain .switch[role="switch"]');
          const note = document.querySelector('.setup-page .su-card[data-step="calls"] .rowx-plain .su-note');
          say(sw?.getAttribute('aria-checked') === 'true' && sw.getAttribute('aria-label') === 'Write down my calls on this Mac' && note?.querySelector('.su-nvidia')?.textContent === 'NVIDIA' && note.textContent === 'NVIDIA Parakeet and Nemotron speech, 1.46 GB, in the background.', 'calls: the speech switch is on, NVIDIA, 1.46 GB', (sw?.outerHTML.slice(0, 80) || 'no switch') + ' | ' + (note?.textContent || ''));
          const savedSwitch = () => sent('hikyaku.setupSave').some((p) => p.speechModels === true && p.step === 'ready');
          await press(bigLabelled(/microphone/));
          await press(bigLabelled(/Screen/));
          say(sent('hikyaku.setupAsk').includes('screen'), 'calls: the screen pane opens');
          if (${path === 'apple-mail' ? 'true' : 'false'}) {
            await press(bigLabelled(/Quit & Reopen/), 50);
            say(savedSwitch(), 'calls: Quit & Reopen saves the switch on first', JSON.stringify(last('hikyaku.setupSave')));
            say(!tipsMissed.length, 'Setup: every icon-only button on every step has a tooltip', tipsMissed.join(', '));
            return { lines, step: 'reopening', seen };
          }
          await press([...document.querySelectorAll('.setup-page button')].find((b) => b.textContent === 'Later'), 600);
          say(savedSwitch(), 'calls: Later saves the switch on, with the step', JSON.stringify(last('hikyaku.setupSave')));
          continue;
        }
        if (now === 'disk') {
          // Fix 1 and 3 (2026-10-28): after the switch, the live mail check. With 0 accounts (mail=0): the plain steps and
          // the skip that says its cost; adding the account (Open Internet Accounts here) is read again by the poll.
          // With 2: one line per kind with the newest mail, and Continue.
          await press(bigLabelled(/^Open Full Disk Access$/), 1800);
          const card = () => document.querySelector('.setup-page .su-card[data-step="disk"]');
          const payText = () => card()?.querySelector('.su-pay > span:last-child')?.textContent;
          const checkLines = () => [...(card()?.querySelectorAll('.su-mail-check li') || [])].map((li) => li.textContent);
          if (${mail === '0' ? 'true' : 'false'}) {
            const steps = [...(card()?.querySelectorAll('.su-mail-steps li') || [])].map((li) => li.textContent);
            say(payText() === 'Your mail is not in Apple Mail yet.' && steps.length === 4 && /Internet Accounts/.test(steps[0]) && /Microsoft Exchange for Outlook/.test(steps[1]) && /Google for Gmail/.test(steps[1]) && /Turn on Mail/.test(steps[2]) && /Open Mail once/.test(steps[3]),
              'disk, 0 accounts: the plain steps, Microsoft Exchange or Google', payText() + ' | ' + steps.join(' | '));
            const skip = bigLabelled(/^Skip for now/);
            say(skip?.textContent === 'Skip for now: no workspaces until your mail is in Apple Mail' && bigs().length === 1 && !bigLabelled(/^Continue/) && inView(skip),
              'disk, 0 accounts: the one filled button is the skip that says its cost, in view', bigs().map((x) => x.textContent).join(' + '));
            await press([...(card()?.querySelectorAll('button.su-plain') || [])].find((x) => x.textContent === 'Open Internet Accounts'), 1800);
            say(sent('hikyaku.setupAsk').includes('mailAccounts'), 'disk: Open Internet Accounts opens the pane');
          }
          say(payText() === '2 accounts in Apple Mail' && same(checkLines(), ['Microsoft Exchange: 1 account, newest mail today', 'Google: 1 account, newest mail yesterday']),
            'disk, 2 accounts: one live line per kind with the newest mail' + (${mail === '0' ? 'true' : 'false'} ? ', read again after the account was added' : ''), payText() + ' | ' + checkLines().join(' | '));
          const cont = bigLabelled(/^Continue$/);
          say(!!cont && bigs().length === 1 && !bigLabelled(/^Skip for now/) && inView(cont), 'disk, 2 accounts: Continue is the one filled button, in view', bigs().map((x) => x.textContent).join(' + '));
          await press(cont, 1100);
          continue;
        }
        const b = bigs()[0];
        if (!b) { say(false, now + ': nothing to press'); break; }
        if (now === 'calendar' || now === 'voice') {
          await press(b, 300);
          tickSays(now, now === 'voice' ? 'Voice typing is on.' : null);
          await wait(900);
          continue;
        }
        await press(b, now === 'disk' ? 1800 : 1100);
      }
      say(step() === 'ready', 'reaches Ready', seen.join(' > '));
      logoSays('ready');
      tipsAt('ready');
      say(!tipsMissed.length, 'Setup: every icon-only button on every step has a tooltip', tipsMissed.join(', '));
      await wait(500);
      const rows = [...document.querySelectorAll('.setup-page .checklist li')].map((li) => li.dataset.row + ':' + li.querySelector('.st').textContent);
      say(rows.length >= 8 && /^(All|Nearly) set/.test(document.querySelector('.setup-page h3').textContent), 'Ready lists everything', document.querySelector('.setup-page h3').textContent + ' | ' + rows.join(' '));
      // The switch saved on: Ready reads the speech row, starting, and the python row (B5.2).
      say(rows.includes('speech:Note') && rows.includes('python:On') && rows.indexOf('speech:Note') === rows.findIndex((r) => r.startsWith('screen:')) + 1 && document.querySelector('.setup-page li[data-row="speech"] .lbl')?.textContent === 'NVIDIA speech on this Mac · starting', 'Ready: the speech row, starting, then the python row', rows.join(' '));
      // Ready's foot is pinned: Done is fully in view at 760 x 540, inside every box that scrolls, and nothing covers it.
      const done = bigLabelled(/^Find my workspaces$/);
      const fully = (b) => {
        if (!b) return false;
        const r = b.getBoundingClientRect();
        if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) return false;
        for (let n = b.parentElement; n; n = n.parentElement) {
          if (getComputedStyle(n).overflowY === 'visible') continue;
          const box = n.getBoundingClientRect();
          if (r.top < box.top || r.bottom > box.bottom) return false;
        }
        return b.contains(document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2));
      };
      say(fully(done), 'Ready: Find my workspaces is fully in view at 760 x 540', rows.length + ' rows, the button at ' + (done ? Math.round(done.getBoundingClientRect().top) + '-' + Math.round(done.getBoundingClientRect().bottom) + ' of ' + innerHeight : 'none'));
      // The Found step (first-run-polish B4.7, C1 to C5): searching with its bar, the look's end, the rows, Keep or Later.
      await press(done, 600);
      const found = () => document.querySelector('.setup-page .su-card[data-step="found"]');
      const fire = (outcome) => (window.__listeners['hikyaku.onMoved'] || []).forEach((listener) => listener(outcome));
      const today = () => !document.body.classList.contains('is-setup') && !document.querySelector('[data-page="today"]').hidden && !!document.querySelector('#composer').offsetParent;
      const lastSent = (path) => sent(path).at(-1);
      say(sent('hikyaku.setupSave').some((p) => p.done === true) && found()?.querySelector('h3')?.textContent === 'Looking through your last 30 days of mail…', 'C1 Find my workspaces saves done and opens the Found step, searching', found()?.textContent.slice(0, 60) || step());
      say(bigs().length === 0 && !!found()?.querySelector('.su-fill > i'), 'C4 searching: no filled button, the bar drawn');
      fire({ taskId: null, phase: 'discover', text: '', done: false, data: { read: 280, total: 2214, naming: false } }); await wait(100);
      say(found()?.querySelector('.su-fill + .su-note')?.textContent === 'Read 280 of 2,214 email threads', 'C1 a progress event says how far the look is', found()?.querySelector('.su-fill + .su-note')?.textContent);
      fire({ taskId: null, phase: 'discover', text: 'Found 2 workspaces in the last 30 days.', done: true }); await wait(500);
      const rowsNow = () => [...(found()?.querySelectorAll('li[data-name]') || [])];
      say(rowsNow().map((li) => li.dataset.name).join(' | ') === 'Robotics Club Treasurer | Teaching Assistant ECON 1110', 'C1 the look ends: two rows', rowsNow().length + ' rows');
      tipsMissed.length = 0; tipsAt('found');
      say(!tipsMissed.length, 'Setup: every icon-only button on the Found step has a tooltip', tipsMissed.join(', '));
      const foot = found()?.querySelector('.su-ready-foot');
      say(bigs().length === 1 && fully(bigs()[0]) && !!foot && getComputedStyle(foot).position === 'sticky', 'C4 found: one filled button, fully in view, the foot sticky', bigs().map((b) => b.textContent).join(' + '));
      const rowButton = (i, label) => [...(rowsNow()[i]?.querySelectorAll('button') || [])].find((b) => b.textContent === label);
      const keepText = () => found()?.querySelector('.su-ready-foot .btn-big')?.textContent;
      if ('${path}' === 'outlook' && !noIcons) {
        say(/“You have been elected treasurer of the Robotics Club\.” · Dana, Oct 9 · Club officers/.test(rowsNow()[0]?.textContent) && /3 threads · 2 from you/.test(rowsNow()[0]?.textContent), 'C1 a row says its quote, who and when, and its counts', rowsNow()[0]?.textContent);
        const before = found().innerHTML;
        fire({ taskId: 'task_a', phase: 'drafting', done: true }); await wait(400);
        say(!!found() && found().innerHTML === before, 'C5 a move event while the Found step shows changes nothing on it');
        await press(rowButton(1, 'Dismiss'), 100);
        say(keepText() === 'Keep 1 of 2 and continue' && rowsNow()[1].classList.contains('is-dismissed') && !rowButton(1, 'Edit name'), 'C1 Dismiss: the foot recounts, the row dims, Edit name hides', keepText());
        await press(rowButton(1, 'Undo'), 100);
        say(keepText() === 'Keep all 2 and continue', 'C1 Undo: the foot counts it again', keepText());
        // Edit name: Enter saves the new label; the row draws it.
        await press(rowButton(0, 'Edit name'), 100);
        const input = rowsNow()[0]?.querySelector('input');
        if (input) { input.value = 'Robotics Treasurer'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(300); }
        say(same(last('hikyaku.renameWorkstream'), ['Robotics Club Treasurer', 'Robotics Treasurer']) && rowsNow()[0]?.querySelector('strong')?.textContent === 'Robotics Treasurer', 'C1 Edit name saves the label at once and the row shows it', JSON.stringify(last('hikyaku.renameWorkstream')));
        await press(rowButton(1, 'Dismiss'), 100);
        await press(found().querySelector('.su-ready-foot .btn-big'), 700);
        say(same(lastSent('hikyaku.foundKeep'), { keep: ['Robotics Club Treasurer'], dismiss: ['Teaching Assistant ECON 1110'], end: 'done' }), 'C1 Keep sends the kept and the dismissed in one call', JSON.stringify(lastSent('hikyaku.foundKeep')));
        say(today(), 'C1 Keep lands on Today with the ask bar');
        fire({ taskId: null, phase: 'discover', text: 'No new workspaces in the last 7 days.', done: true }); await wait(400);
        say(today() && document.querySelector('[data-page="setup"]').hidden, 'C5 a look that ends after Keep leaves Today showing, body without is-setup');
        document.querySelector('[data-view="workspaces"]').click(); await wait(500);
        const names = [...document.querySelectorAll('.ws-row')].map((r) => r.dataset.name);
        say(names.includes('Robotics Club Treasurer') && !names.includes('Teaching Assistant ECON 1110'), 'C1 Workspaces lists the kept card, not the dismissed one', names.join(', '));
        document.querySelector('[data-view="today"]').click(); await wait(200);
      } else if (noIcons) {
        await press(rowButton(1, 'Dismiss'), 100);
        await press([...found().querySelectorAll('.su-ready-foot button.linkish')].find((b) => b.textContent === 'Later'), 800);
        say(same(lastSent('hikyaku.foundKeep'), { keep: [], dismiss: ['Teaching Assistant ECON 1110'], end: 'later' }), 'C2 Later writes the dismissals and keeps nothing', JSON.stringify(lastSent('hikyaku.foundKeep')));
        const row = document.querySelector('#todayView .today-row[data-key="found"] .qrow');
        say(today() && row?.querySelector('.qtext')?.textContent === 'Loggie found 1 workspace. Keep it if it is yours.', 'C2 Today shows the found row', row?.textContent || 'no row');
        await press(row, 700);
        say(!!found() && document.body.classList.contains('is-setup') && rowsNow().map((li) => li.dataset.name).join() === 'Robotics Club Treasurer', 'C2 the row opens the Found step again', found()?.textContent.slice(0, 60) || 'no card');
        await press(found()?.querySelector('.su-ready-foot .btn-big'), 700);
        say(today() && !document.querySelector('#todayView .today-row[data-key="found"]'), 'C2 Keep from it lands on Today, the row gone');
      } else {
        await press(found()?.querySelector('.su-ready-foot .btn-big'), 700);
        say(today(), 'Keep lands on Today with the ask bar');
      }
      return { lines, step: step(), seen };
    })()`);
    let out = await walk(false);
    if (out.step === 'reopening') {
      await new Promise((r) => setTimeout(r, 1500));
      const back = await walk(true);
      out = { ...out, lines: [...out.lines, ...back.lines] };
    }
    console.log(`\nSetup, ${path}${icons ? `, icons=${icons}` : ''}${mail ? `, mail=${mail}` : ''}, 760x540: ${(out.seen || []).join(' > ')}`);
    for (const l of out.lines) { console.log('  ' + l); if (!l.startsWith('ok')) failed++; }
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }
  // Back and Forward (2026-10-28): all nine steps forward, then Back from Ready to Welcome one step at a time, each step
  // keeping its answer (the name, the mail app and texts, every grant drawn as granted, the keys, the speech switch) and
  // Back saving nothing; a pick changed and left by Back is still there; then forward again to Ready on each step's own
  // button. Then Settings' Set up again on a Mac that is set up: Welcome, filled in, and Done marks it done again.
  for (const mode of ['back', 'again']) {
    const win = new BrowserWindow({ show: false, width: 760, height: 540, useContentSize: true });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${String(event.sourceId).split('/').pop()}:${event.lineNumber})`); });
    const url = `${base}/panel-check.html?setup=${mode === 'back' ? 'outlook' : 'done'}`;
    await win.loadURL(url);
    await win.webContents.executeJavaScript('sessionStorage.clear()');
    await win.loadURL(url);
    await new Promise((r) => setTimeout(r, 1200));
    const out = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
      const lines = [];
      const say = (ok, label, detail = '') => lines.push((ok ? 'ok   ' : 'NOTHING ') + label + (detail ? ' -> ' + detail : ''));
      const card = () => document.querySelector('.setup-page .su-card');
      const step = () => card()?.dataset.step;
      const bigs = () => [...document.querySelectorAll('.setup-page .btn-big')].filter((b) => !b.disabled && b.offsetParent);
      const big = (re) => bigs().find((b) => re.test(b.textContent));
      const backLink = () => [...document.querySelectorAll('.setup-page .su-top button')].find((b) => b.textContent === '‹ Back');
      const press = async (b, ms = 500) => { if (!b) return false; b.click(); await wait(ms); return true; };
      const sent = (path) => (window.__args || []).filter((a) => a.path === path).map((a) => a.args[0]);
      const tile = (name) => [...document.querySelectorAll('.setup-page .choice')].find((b) => b.querySelector('.su-tile-name')?.textContent === name);
      const texts = () => document.querySelector('.setup-page .su-card[data-step="email"] .switch[role="switch"]')?.getAttribute('aria-checked');
      const name = () => document.querySelector('.setup-page .su-name')?.value;
      const today = () => !document.body.classList.contains('is-setup') && !document.querySelector('[data-page="today"]').hidden;
      if ('${mode}' === 'again') {
        say(today(), 'a Mac that is set up opens on Today, never on setup');
        document.querySelector('[data-view="settings"]').click(); await wait(600);
        const again = document.querySelector('#setupAgain');
        say(!!again?.offsetParent && again.className === document.querySelector('#macAgain').className && again.textContent === 'Set up again', 'Settings: Set up again beside Check again, as quiet', again?.outerHTML || 'none');
        const saves = sent('hikyaku.setupSave').length;
        await press(again, 600);
        say(document.body.classList.contains('is-setup') && step() === 'welcome' && name() === 'Sam' && !backLink(), 'Set up again opens Welcome with the saved name, no Back', step() + ' / ' + name());
        await press(big(/^Start$/));
        say(step() === 'email' && tile('Outlook')?.getAttribute('aria-pressed') === 'true' && texts() === 'true' && !!big(/^Continue$/) && !!backLink(), 'Set up again: Email has Outlook and texts filled in', step());
        await press(backLink());
        say(step() === 'welcome' && name() === 'Sam', 'Set up again: Back to Welcome keeps the name');
        await press(big(/^Start$/));
        await press(big(/^Continue$/));
        say(step() === 'voice' && /Voice typing is on\\./.test(card().textContent) && !big(/Allow voice/), 'Set up again: voice typing already on shows as on', step());
        await press(big(/^Continue$/), 800);
        say(step() === 'ready' && !!big(/^Done$/), 'Set up again: on to Ready, its button Done', step());
        await press(big(/^Done$/), 700);
        const made = sent('hikyaku.setupSave').slice(saves);
        say(today() && made.some((p) => p.done === true), 'Set up again: Done marks it done again and lands on Today', JSON.stringify(made));
        say(!made.some((p) => p.signName === '' || p.chats === false || ('mailApp' in p && p.mailApp !== 'outlook')), 'Set up again: nothing saved is lost', JSON.stringify(made));
        return { lines };
      }
      document.querySelector('.setup-page .su-name').value = 'Sam';
      say(step() === 'welcome' && !backLink(), 'welcome: no Back on the first step');
      const forward = [];
      for (let guard = 0; guard < 20 && step() !== 'ready'; guard += 1) {
        const now = step();
        if (forward.at(-1) !== now) { forward.push(now); if (now !== 'welcome' && !backLink()) say(false, now + ': a Back'); }
        if (now === 'welcome') { await press(big(/^Start$/)); continue; }
        if (now === 'email') { await press(tile('Outlook'), 100); document.querySelector('.setup-page .switch[role="switch"]').click(); await press(big(/^Continue$/)); continue; }
        if (now === 'disk') { await press(big(/^Open Full Disk Access$/), 1800); await press(big(/^Continue$/), 600); continue; }
        if (now === 'keys') {
          for (const box of document.querySelectorAll('.setup-page .keyrow input')) { box.value = 'nb-made-up-key-0001'; box.dispatchEvent(new Event('input')); await wait(150); }
          await press(document.querySelector('.setup-page .su-yes'), 1000);
          continue;
        }
        if (now === 'calls') { await press(big(/microphone/)); await press(big(/Screen/)); await press([...document.querySelectorAll('.setup-page button')].find((b) => b.textContent === 'Later'), 600); continue; }
        await press(bigs()[0], 1300);
      }
      say(forward.join() === 'welcome,email,calendar,disk,apps,voice,keys,calls' && step() === 'ready' && !!backLink(), 'forward through every step to Ready, which has Back', forward.join(' > '));
      await wait(500);
      const saves = sent('hikyaku.setupSave').length;
      const back = [step()];
      const kept = {};
      for (let guard = 0; guard < 12 && backLink(); guard += 1) {
        await press(backLink(), 450);
        const now = step();
        back.push(now);
        const c = card();
        const ok = (c?.querySelector('.su-pay.ok')?.textContent || '');
        if (now === 'calls') kept.calls = c.querySelector('.rowx-plain .switch')?.getAttribute('aria-checked') === 'true' && /Microphone: on\\./.test(ok) && !big(/Allow the microphone/) && !!big(/^Continue$/);
        if (now === 'keys') kept.keys = [...c.querySelectorAll('.keyrow .state')].every((n) => n.textContent === 'Saved') && !!big(/^Continue$/);
        if (now === 'voice') kept.voice = ok === 'Voice typing is on.' && !!c.querySelector('.su-logo .su-tick') && !!big(/^Continue$/) && !big(/Allow voice/);
        if (now === 'apps') kept.apps = !!big(/^Continue$/) && !big(/^Allow/);
        if (now === 'disk') kept.disk = ok === '2 accounts in Apple Mail' && !!big(/^Continue$/) && !big(/Open Full Disk/);
        if (now === 'calendar') kept.calendar = /Case team sync/.test(ok) && !!c.querySelector('.su-logo .su-tick') && !!big(/^Continue$/) && !big(/Allow Calendar/);
        if (now === 'email') {
          kept.email = tile('Outlook')?.getAttribute('aria-pressed') === 'true' && texts() === 'true' && !!big(/^Continue$/);
          await press(tile('Apple Mail'), 100);
        }
        if (now === 'welcome') kept.welcome = name() === 'Sam';
      }
      say(back.join() === [...forward, 'ready'].reverse().join(), 'Back from Ready to Welcome, one step at a time', back.join(' < '));
      for (const s of ['calls', 'keys', 'voice', 'apps', 'disk', 'calendar', 'email', 'welcome']) say(kept[s] === true, 'Back: ' + s + ' keeps its answer' + (['calendar', 'disk', 'apps', 'voice', 'calls'].includes(s) ? ', its grant drawn as granted' : ''));
      say(sent('hikyaku.setupSave').length === saves, 'Back saves nothing, so the speech download never starts from it', JSON.stringify(sent('hikyaku.setupSave').slice(saves)));
      const again = [];
      for (let guard = 0; guard < 12 && step() !== 'ready'; guard += 1) {
        const now = step();
        again.push(now);
        if (now === 'welcome') { await press(big(/^Start$/)); continue; }
        if (now === 'email') {
          say(tile('Apple Mail')?.getAttribute('aria-pressed') === 'true', 'a pick changed and left by Back is still there, editable');
          await press(tile('Outlook'), 100);
          await press(big(/^Continue$/));
          continue;
        }
        const b = big(/^Continue$/);
        if (!b) { say(false, now + ': no Continue to go forward', bigs().map((x) => x.textContent).join(' + ')); break; }
        await press(b, 800);
      }
      say(step() === 'ready' && !!big(/^Find my workspaces$/), 'forward again to Ready, past every step already on', again.join(' > '));
      const made = sent('hikyaku.setupSave').slice(saves);
      say(made.some((p) => p.signName === 'Sam') && made.some((p) => p.mailApp === 'outlook' && p.chats === true), 'forward again saves the same name, mail app and texts', JSON.stringify(made));
      return { lines };
    })()`);
    console.log(`\nSetup, ${mode === 'back' ? 'Back and Forward through every step' : 'Set up again from Settings'}, 760x540`);
    for (const l of out.lines) { console.log('  ' + l); if (!l.startsWith('ok')) failed++; }
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }
  {
    // An app that is not installed (first-run-polish B2.3): its tile wears the bundled mark, greyed, says so, and still
    // takes the press.
    const win = new BrowserWindow({ show: false, width: 760, height: 540, useContentSize: true });
    await win.loadURL(`${base}/panel-check.html?setup=outlook&icons=missing`);
    await win.webContents.executeJavaScript('sessionStorage.clear()');
    await win.loadURL(`${base}/panel-check.html?setup=outlook&icons=missing`);
    await new Promise((r) => setTimeout(r, 1200));
    const out = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.setup-page .btn-big').click(); await wait(300);
      const outlook = [...document.querySelectorAll('.setup-page .choice')].find((b) => b.querySelector('.su-tile-name')?.textContent === 'Outlook');
      const looks = !!outlook?.querySelector('img[src$="marks/outlook.png"]') && outlook.classList.contains('is-missing') && outlook.querySelector('.su-tile-note')?.textContent === 'not installed';
      outlook?.click(); await wait(300);
      const next = [...document.querySelectorAll('.setup-page .btn-big')].find((b) => b.textContent === 'Continue');
      return { looks, enabled: !!next && !next.disabled };
    })()`);
    const ok = out.looks && out.enabled;
    console.log(`\nSetup, Outlook not installed: ${ok ? 'ok   its tile wears the bundled mark, greyed, says not installed, and pressing it enables Continue' : 'NOTHING ' + JSON.stringify(out)}`);
    if (!ok) failed++;
    win.destroy();
  }
  {
    const win = new BrowserWindow({ show: false, width: 760, height: 540, useContentSize: true });
    await win.loadURL(`${base}/panel-check.html?setup=outlook&slow=1`);
    await win.webContents.executeJavaScript('sessionStorage.clear()');
    await win.loadURL(`${base}/panel-check.html?setup=outlook&slow=1`);
    await new Promise((r) => setTimeout(r, 1200));
    const out = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.setup-page .btn-big').click(); await wait(300);
      document.querySelector('.setup-page .choice').click(); document.querySelector('.setup-page .btn-big').click(); await wait(300);
      const allow = document.querySelector('.setup-page .btn-big');
      allow.click(); await wait(50);
      return { step: document.querySelector('.setup-page .su-card').dataset.step, disabled: allow.disabled, waiting: document.querySelector('.setup-page .su-pay')?.textContent || '' };
    })()`);
    const ok = out.step === 'calendar' && out.disabled && /macOS is asking/.test(out.waiting);
    console.log(`\nSetup, slow ask: ${ok ? 'ok   the button disables and the waiting line draws within 50 ms' : 'NOTHING ' + JSON.stringify(out)}`);
    if (!ok) failed++;
    win.destroy();
  }
  // The Calls step for the switch alone (first-run-polish B5.2, S6): every permission granted, so Calls shows only the
  // speech switch, Microphone: on. and a filled Continue that saves it; on Ready a download event moves the speech row.
  {
    const win = new BrowserWindow({ show: false, width: 760, height: 540, useContentSize: true });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${String(event.sourceId).split('/').pop()}:${event.lineNumber})`); });
    const url = `${base}/panel-check.html?setup=outlook&speech=wanted`;
    const granted = { calendar: 'granted', fullDisk: 'granted', microphone: 'granted', screen: 'granted', accessibility: 'granted', automation: 'granted' };
    const preset = { step: 'calls', mailApp: 'outlook', signName: 'Sam', permissions: granted, mail: { accounts: 2 }, keys: { nebius: true, tavily: true }, yes: { ai: true, chats: false }, voice: { answer: 'granted', helper: 'built' } };
    await win.loadURL(url);
    await win.webContents.executeJavaScript(`(async () => { sessionStorage.clear(); const fresh = (await window.loggie.hikyaku.setupStatus()).data; Object.assign(fresh, ${JSON.stringify(preset)}); sessionStorage.setItem('setup-state', JSON.stringify(fresh)); return true; })()`);
    await win.loadURL(url);
    await new Promise((r) => setTimeout(r, 1200));
    const lines = [];
    const card = await win.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('.setup-page .su-card[data-step="calls"]');
      const sw = card?.querySelector('.rowx-plain .switch[role="switch"]');
      const bigs = [...document.querySelectorAll('.setup-page .btn-big')].filter((b) => !b.disabled && b.offsetParent).map((b) => b.textContent);
      return { step: document.querySelector('.setup-page .su-card')?.dataset.step, on: sw?.getAttribute('aria-checked'), nvidia: card?.querySelector('.su-nvidia')?.textContent, pay: card?.querySelector('.su-pay.ok')?.textContent, bigs };
    })()`);
    const ok1 = card.step === 'calls' && card.on === 'true' && card.nvidia === 'NVIDIA' && card.pay === 'Microphone: on.' && card.bigs.join() === 'Continue';
    lines.push(`${ok1 ? 'ok   ' : 'NOTHING '}both grants in: Calls shows the switch on, Microphone: on. and one filled Continue${ok1 ? '' : ' -> ' + JSON.stringify(card)}`);
    if (process.env.LOGGIE_SHOT_DIR) {
      const shot = await win.webContents.capturePage();
      await require('node:fs/promises').writeFile(join(process.env.LOGGIE_SHOT_DIR, 'calls.png'), shot.toPNG());
      lines.push(`ok   the Calls card saved as ${join(process.env.LOGGIE_SHOT_DIR, 'calls.png')}`);
    }
    const out = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
      const lines = [];
      const say = (ok, label, detail = '') => lines.push((ok ? 'ok   ' : 'NOTHING ') + label + (detail ? ' -> ' + detail : ''));
      const last = (path) => [...(window.__args || [])].reverse().find((a) => a.path === path)?.args;
      const sw = () => document.querySelector('.setup-page .su-card[data-step="calls"] .rowx-plain .switch[role="switch"]');
      const saves = () => (window.__args || []).filter((a) => a.path === 'hikyaku.setupSave').length;
      const before = saves();
      sw().click(); await wait(100);
      const off = sw().getAttribute('aria-checked');
      sw().click(); await wait(100);
      say(off === 'false' && sw().getAttribute('aria-checked') === 'true' && saves() === before, 'the switch flips off and on, and saves nothing yet', off + ' / ' + sw().getAttribute('aria-checked'));
      [...document.querySelectorAll('.setup-page .btn-big')].find((b) => b.textContent === 'Continue').click(); await wait(800);
      const saved = (window.__args || []).filter((a) => a.path === 'hikyaku.setupSave').map((a) => a.args[0]);
      say(saved.some((p) => p.speechModels === true && p.step === 'ready'), 'Continue saves speechModels true with the step', JSON.stringify(saved));
      const row = () => document.querySelector('.setup-page li[data-row="speech"]');
      say(document.querySelector('.setup-page .su-card')?.dataset.step === 'ready' && row()?.querySelector('.lbl')?.textContent === 'NVIDIA speech on this Mac · starting', 'Ready: the speech row, starting', row()?.textContent);
      const list = document.querySelector('.setup-page .su-checklist');
      const fire = (data) => (window.__listeners['hikyaku.onEntry'] || []).forEach((listener) => listener({ type: 'setup.download', text: 'Getting meeting transcription ready', data }));
      fire({ done_bytes: 412e6, total_bytes: 1460555318, state: 'downloading' }); await wait(100);
      const scale = (() => { const m = /matrix\\(([^,]+),/.exec(getComputedStyle(row()?.querySelector('.su-fill > i') || document.body).transform); return m ? Number(m[1]) : null; })();
      say(row()?.querySelector('.lbl')?.textContent === 'NVIDIA speech on this Mac · 412 of 1,461 MB' && Math.abs(scale - 412e6 / 1460555318) < 0.001 && document.querySelector('.setup-page .su-checklist') === list, 'a download event moves the speech row in place: 412 of 1,461 MB, the bar at 412 / 1,461', row()?.querySelector('.lbl')?.textContent + ' ' + scale);
      fire({ done_bytes: 412e6, total_bytes: 1460555318, state: 'paused' }); await wait(100);
      say(row()?.querySelector('.lbl')?.textContent === 'NVIDIA speech on this Mac · Paused, trying again in a minute' && row()?.querySelector('.st')?.textContent === 'Note', 'paused says so and keeps its bar', row()?.textContent);
      fire({ done_bytes: 1460555318, total_bytes: 1460555318, state: 'ready' }); await wait(100);
      say(row()?.querySelector('.st')?.textContent === 'On' && row()?.querySelector('.lbl')?.textContent === 'NVIDIA speech on this Mac' && !row()?.querySelector('.su-fill') && document.querySelector('.setup-page .su-checklist') === list, 'ready flips the pill to On and drops the bar, no list redraw', row()?.textContent);
      const find = [...document.querySelectorAll('.setup-page .btn-big')].find((b) => b.textContent === 'Find my workspaces');
      say(!!find && !find.disabled, 'Find my workspaces never waits on the download');
      return { lines };
    })()`);
    console.log('\nSetup, Calls for the switch alone (speech=wanted), 760x540');
    for (const l of [...lines, ...out.lines]) { console.log('  ' + l); if (!l.startsWith('ok')) failed++; }
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }

  // The Found step on its own (first-run-polish B4.7): a Mac whose setup is done and whose Found step is not answered
  // yet opens on it (C7); each zero reason has its one fix (C3, C3b), the keys detour comes back and looks again.
  const PENDING = { done: true, found: 'pending', step: 'ready', mailApp: 'outlook', signName: 'Sam' };
  const foundPage = async (query) => {
    const win = new BrowserWindow({ show: false, width: 760, height: 540, useContentSize: true });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${String(event.sourceId).split('/').pop()}:${event.lineNumber})`); });
    const url = `${base}/panel-check.html?setup=outlook${query}`;
    await win.loadURL(url);
    await win.webContents.executeJavaScript(`(async () => { sessionStorage.clear(); const fresh = (await window.loggie.hikyaku.setupStatus()).data; Object.assign(fresh, ${JSON.stringify(PENDING)}); sessionStorage.setItem('setup-state', JSON.stringify(fresh)); return true; })()`);
    await win.loadURL(url);
    await new Promise((r) => setTimeout(r, 1200));
    return { win, errors };
  };
  const FOUND_HELPERS = `
      const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
      const lines = [];
      const say = (ok, label, detail = '') => lines.push((ok ? 'ok   ' : 'NOTHING ') + label + (detail ? ' -> ' + detail : ''));
      const found = () => document.querySelector('.setup-page .su-card[data-step="found"]');
      const bigs = () => [...document.querySelectorAll('.setup-page .btn-big')].filter((b) => !b.disabled && b.offsetParent);
      const inView = (b) => { const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; };
      const fire = (outcome) => (window.__listeners['hikyaku.onMoved'] || []).forEach((listener) => listener(outcome));
      const ended = async () => { fire({ taskId: null, phase: 'discover', text: '', done: true }); await wait(); };
      const calls = () => window.__calls || [];
      const last = (path) => [...(window.__args || [])].reverse().find((a) => a.path === path)?.args;
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const link = (label) => [...(found()?.querySelectorAll('button.linkish') || [])].find((b) => b.textContent === label);
  `;
  {
    const { win, errors } = await foundPage('&found=zero-key');
    const out = await win.webContents.executeJavaScript(`(async () => {${FOUND_HELPERS}
      say(!!found() && document.body.classList.contains('is-setup') && document.querySelector('[data-page="settings"]').hidden, 'C7 setup done, the Found step not answered: it opens, Settings does not', found()?.textContent.slice(0, 50) || 'no card');
      say(found()?.querySelector('h3')?.textContent === 'Looking through your last 30 days of mail…', 'C7 the step searches while the look runs');
      await ended();
      const foot = found()?.querySelector('.su-ready-foot');
      say(found()?.querySelector('h3')?.textContent === 'Nothing to keep yet' && bigs().map((b) => b.textContent).join() === 'Add key' && !link('Later'), 'C3 no key: Nothing to keep yet, a filled Add key, no Later', found()?.textContent.slice(0, 80));
      say(bigs().length === 1 && inView(bigs()[0]) && !!foot && getComputedStyle(foot).position === 'sticky', 'C4 zero: one filled button in view, the foot sticky');
      bigs()[0].click(); await wait();
      const pills = [...document.querySelectorAll('.setup-page .su-steps li')].map((li) => li.textContent + ':' + li.className.split(' ')[0]);
      say(!!document.querySelector('.setup-page .su-card[data-step="keys"]') && pills.filter((p) => !p.endsWith(':done')).join() === 'Keys:now', 'C3 Add key: the Keys card with every other pill done', pills.join(' '));
      const looksBefore = calls().filter((c) => c === 'hikyaku.foundLook').length;
      [...document.querySelectorAll('.setup-page button.linkish')].find((b) => b.textContent === 'Skip for now')?.click(); await wait();
      say(found()?.querySelector('h3')?.textContent === 'Looking through your last 30 days of mail…' && calls().filter((c) => c === 'hikyaku.foundLook').length === looksBefore + 1, 'C3 Skip for now: back on the Found step, looking again');
      say(!(window.__args || []).some((a) => a.path === 'hikyaku.setupSave' && a.args[0]?.step === 'found'), 'C3 no step found is ever saved');
      return { lines };
    })()`);
    console.log('\nFound step: zero key, relaunch mid-step, 760x540');
    for (const l of out.lines) { console.log('  ' + l); if (!l.startsWith('ok')) failed++; }
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }
  for (const [mode, label, expect] of [
    ['zero-mail', 'Add an account', `same(last('hikyaku.setupAsk'), ['mailAccounts']) && !!found()`],
    ['zero-yes', 'Yes', `(() => { const at = (path) => (window.__calls || []).lastIndexOf(path); return same(last('hikyaku.cloudYesAnswer'), ['ai', 'yes']) && at('hikyaku.foundLook') > at('hikyaku.cloudYesAnswer') && found()?.querySelector('h3')?.textContent === 'Looking through your last 30 days of mail…'; })()`],
    ['zero-failed', 'Look again', `(window.__calls || []).includes('hikyaku.foundLook') && found()?.querySelector('h3')?.textContent === 'Looking through your last 30 days of mail…'`],
    ['zero-none', 'Continue', `same(last('hikyaku.foundKeep'), [{ keep: [], dismiss: [], end: 'done' }]) && !document.body.classList.contains('is-setup')`],
  ]) {
    const { win, errors } = await foundPage(`&found=${mode}`);
    const out = await win.webContents.executeJavaScript(`(async () => {${FOUND_HELPERS}
      await ended();
      const filled = bigs();
      say(filled.length === 1 && filled[0].textContent === ${JSON.stringify(label)}, 'C3b ${mode}: the filled button is ${label}', filled.map((b) => b.textContent).join(' + ') + ' | ' + (found()?.querySelector('.why')?.textContent || ''));
      filled[0]?.click(); await wait(600);
      say(${expect}, 'C3b ${mode}: ${label} reaches its call', (window.__calls || []).slice(-4).join(', '));
      return { lines };
    })()`);
    console.log(`\nFound step: ${mode}`);
    for (const l of out.lines) { console.log('  ' + l); if (!l.startsWith('ok')) failed++; }
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }
  {
    // C8 (first-run-polish B4.8): a found card nobody kept wears New on Workspaces; its page's band keeps or dismisses it.
    const win = new BrowserWindow({ show: false, width: 760, height: 540, useContentSize: true });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${String(event.sourceId).split('/').pop()}:${event.lineNumber})`); });
    await win.loadURL(`${base}/panel-check.html`);
    await new Promise((r) => setTimeout(r, 1200));
    const out = await win.webContents.executeJavaScript(`(async () => {${FOUND_HELPERS}
      const base = window.__data['hikyaku.workstreams'][4];
      const card = (name, foundRow) => ({ ...base, name, label: null, goalText: null, quiet: false, priority: { rank: 9, due: null, idle: false, stake: 'normal' }, moves: [], active: [], newFound: true, confirmed: null, foundRow });
      window.__data['hikyaku.workstreams'].push(
        card('Robotics Club Treasurer', { name: 'Robotics Club Treasurer', label: null, quote: 'You have been elected treasurer of the Robotics Club.', sender: 'Dana', date: '2026-10-09T15:00:00Z', subject: 'Club officers', fromSent: 0, threads: 3, yours: 2 }),
        card('Teaching Assistant ECON 1110', { name: 'Teaching Assistant ECON 1110', label: null, quote: '', sender: '', date: '2026-10-12T15:00:00Z', subject: 'TA hours', fromSent: 4, threads: 0, yours: 4 }));
      fire({ taskId: null, phase: 'refreshed', text: '' }); await wait();
      document.querySelector('[data-view="workspaces"]').click(); await wait();
      const row = (name) => document.querySelector('.ws-row[data-name="' + name + '"]');
      say(row('Robotics Club Treasurer')?.querySelector('.ws-found-new')?.textContent === 'New' && !row('Bank Offer')?.querySelector('.ws-found-new'), 'C8 a found card nobody kept says New in its row');
      row('Robotics Club Treasurer')?.click(); await wait();
      const band = () => document.querySelector('.ws-found');
      say(band()?.querySelector('.ws-found-head')?.textContent === 'Loggie found this in your mail.' && /Dana, Oct 9/.test(band()?.textContent) && /3 threads · 2 from you/.test(band()?.textContent), 'C8 its page shows what Loggie found', band()?.textContent.slice(0, 90) || 'no band');
      band()?.querySelector('.ws-do')?.click(); await wait(600);
      say(same(last('hikyaku.foundKeep'), [{ keep: ['Robotics Club Treasurer'], dismiss: [], end: null }]) && !band(), 'C8 Keep reaches foundKeep for that card, and the band goes', JSON.stringify(last('hikyaku.foundKeep')));
      document.querySelector('.ws-back')?.click(); await wait();
      row('Teaching Assistant ECON 1110')?.click(); await wait();
      // One Dismiss: the band's, beside Keep; the "..." row of a found card has none (cleanup 2026-10-27).
      document.querySelector('.ws-more[aria-expanded="false"]')?.click(); await wait();
      say(document.querySelectorAll('.ws-dismiss').length === 1 && band()?.querySelector('.ws-dismiss'), 'C8 a found card has one Dismiss, in its band');
      document.querySelector('.ws-more[aria-expanded="true"]')?.click(); await wait();
      const dismiss = () => band()?.querySelector('.ws-dismiss');
      const before = (window.__calls || []).filter((c) => c === 'hikyaku.dismissWorkstream').length;
      dismiss()?.click(); await wait();
      say(dismiss()?.textContent === 'Press again to dismiss' && (window.__calls || []).filter((c) => c === 'hikyaku.dismissWorkstream').length === before, 'C8 Dismiss asks for a second press');
      dismiss()?.click(); await wait(600);
      say(same(last('hikyaku.dismissWorkstream'), ['Teaching Assistant ECON 1110']), 'C8 the second press reaches dismissWorkstream', JSON.stringify(last('hikyaku.dismissWorkstream')));
      return { lines };
    })()`);
    console.log('\nWorkspaces band, 760x540');
    for (const l of out.lines) { console.log('  ' + l); if (!l.startsWith('ok')) failed++; }
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }
  {
    // C9 (loggie-intros live fix): a kept found card with no approval, on an install whose yes has no `found`, asks the
    // cloud yes where Keep was; Keep on such a card shows the same line at once; Yes reaches cloudYesAnswer, then the
    // card's approval and first read (foundRead), and the line goes.
    const win = new BrowserWindow({ show: false, width: 760, height: 540, useContentSize: true });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${String(event.sourceId).split('/').pop()}:${event.lineNumber})`); });
    await win.loadURL(`${base}/panel-check.html`);
    await new Promise((r) => setTimeout(r, 1200));
    const out = await win.webContents.executeJavaScript(`(async () => {${FOUND_HELPERS}
      const base = window.__data['hikyaku.workstreams'][4];
      const card = (name, extra) => ({ ...base, name, label: null, goalText: null, quiet: false, cloud: 'off', priority: { rank: 9, due: null, idle: false, stake: 'normal' }, moves: [], active: [], found: { quote: 'Welcome to the outreach list.', subject: 'Outreach', date: '2026-10-09T15:00:00Z' }, ...extra });
      window.__data['hikyaku.workstreams'].push(
        card('Bank Outreach', { newFound: false, confirmed: '2026-10-19T11:00:00.000Z', foundRow: null, readYes: true }),
        card('Robotics Club Treasurer', { newFound: true, confirmed: null, readYes: false, foundRow: { name: 'Robotics Club Treasurer', label: null, quote: 'You have been elected treasurer of the Robotics Club.', sender: 'Dana', date: '2026-10-09T15:00:00Z', subject: 'Club officers', fromSent: 0, threads: 3, yours: 2 } }));
      fire({ taskId: null, phase: 'refreshed', text: '' }); await wait();
      document.querySelector('[data-view="workspaces"]').click(); await wait();
      const row = (name) => document.querySelector('.ws-row[data-name="' + name + '"]');
      const yesLine = () => document.querySelector('.ws-read-yes');
      const WORDS = 'Let Loggie send screened mail and call transcripts to Nemotron, to find your workspaces, sort new mail, write your call notes and learn how you write?';
      row('Bank Outreach')?.click(); await wait();
      say(yesLine()?.querySelector('.ws-found-head')?.textContent === WORDS && yesLine()?.querySelector('.ws-do')?.textContent === 'Yes' && !document.querySelector('.ws-found'), 'C9 a kept found card, cloud off, no found yes: its page shows the cloud yes line with Yes', yesLine()?.textContent.slice(0, 60) || 'no line');
      document.querySelector('.ws-back')?.click(); await wait();
      row('Robotics Club Treasurer')?.click(); await wait();
      document.querySelector('.ws-found .ws-do')?.click(); await wait(600);
      say(same(last('hikyaku.foundKeep'), [{ keep: ['Robotics Club Treasurer'], dismiss: [], end: null }]) && !document.querySelector('.ws-found') && yesLine()?.querySelector('.ws-found-head')?.textContent === WORDS, 'C9 Keep on such a card shows the same Yes line right after Keep', yesLine()?.textContent.slice(0, 40) || 'no line');
      const at = (path) => calls().lastIndexOf(path);
      const before = calls().length;
      yesLine()?.querySelector('.ws-do')?.click(); await wait(600);
      say(same(last('hikyaku.cloudYesAnswer'), ['ai', 'yes']) && same(last('hikyaku.foundRead'), ['Robotics Club Treasurer']) && at('hikyaku.cloudYesAnswer') >= before && at('hikyaku.foundRead') > at('hikyaku.cloudYesAnswer'), 'C9 its Yes reaches cloudYesAnswer(ai, yes), then foundRead for that card', JSON.stringify([last('hikyaku.cloudYesAnswer'), last('hikyaku.foundRead')]));
      say(!yesLine() && !/Loggie reads a workspace/.test(document.querySelector('.ws-status')?.textContent || ''), 'C9 after the yes the line goes and nothing failed', document.querySelector('.ws-status')?.textContent || '');
      document.querySelector('.ws-back')?.click(); await wait();
      row('Bank Outreach')?.click(); await wait();
      say(!yesLine(), 'C9 the other kept card is approved by the same yes: its line is gone too');
      const sends = calls().filter((c) => /send|openDraft|doIt/i.test(c) && !/sends$/.test(c));
      say(!sends.length, 'C9 the yes sends nothing and opens no draft', sends.join(', '));
      return { lines };
    })()`);
    console.log('\nWorkspaces read yes, 760x540');
    for (const l of out.lines) { console.log('  ' + l); if (!l.startsWith('ok')) failed++; }
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }
  // Tooltips, and To send / To do (FA build loggie-availability; Gio, 2026-10-21, on a prepare move under To send with a
  // mail button: "what do we want the users to do?"). Every visible icon-only button on Today, Workspaces and Meetings
  // has a tooltip (Setup's are checked in its walk above). A workspace page groups its moves under To send and To do;
  // a To do move has Done, New date and Drop it and no mail button, and Today shows it no Draft it.
  {
    const win = new BrowserWindow({ show: false, width: 760, height: 900 });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${String(event.sourceId).split('/').pop()}:${event.lineNumber})`); });
    await win.loadURL(`${base}/panel-check.html`);
    await new Promise((r) => setTimeout(r, 1500));
    const out = await win.webContents.executeJavaScript(`(async () => {${TIPS}
      const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
      const lines = [];
      const say = (ok, label, detail = '') => lines.push((ok ? 'ok   ' : 'NOTHING ') + label + (ok || !detail ? '' : ' -> ' + detail));
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const tips = (where) => { const bad = untitled(); say(!bad.length, where + ': every icon-only button has a tooltip', bad.join(', ')); };
      const ranked = async () => { for (const l of window.__listeners['hikyaku.onRanked'] || []) l(); await wait(800); };
      document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: 'today' })); await wait(800);
      tips('Today');
      document.querySelector('.is-first .today-go')?.click(); await wait();
      say(!!document.querySelector('.is-first .today-send'), 'Today: the line box opens'); tips('Today, the line box open');
      document.querySelector('.is-first .today-say')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait();
      document.querySelector('.is-first .ws-act[aria-label^="New date"]')?.click(); await wait();
      say(!!document.querySelector('.is-first .today-date'), 'Today: the date box opens'); tips('Today, the date box open');
      // A To do pick on Today: Done and New date, never Draft it.
      const saved = window.__data['hikyaku.firstToday'];
      window.__data['hikyaku.firstToday'] = { picks: [{ taskId: 'task_p2', name: 'Bank Offer', move: 'Prepare two stories for the team round', due: '2026-10-16', why: null, quote: null }], source: 'ai' }; await ranked();
      const todo = document.querySelector('.today-card[data-task-id="task_p2"]');
      const todoTips = [...(todo?.querySelectorAll('footer button') || [])].map((b) => b.dataset.tip || b.textContent.trim());
      say(!!todo && same(todoTips, ['Not this', 'Done', 'New date']) && !todo.querySelector('.today-go, .today-do'), 'Today: a To do move has Done and New date, no Draft it', todoTips.join(', ') || 'no card');
      tips('Today, a To do move');
      say(!todo?.querySelector('.ws-act[aria-label^="Reply"]'), 'Today: a To do move without an email has no Reply');
      // The same rule on Today: the To do move from an email has Reply beside Done and New date, and its box reaches replyTo.
      window.__data['hikyaku.firstToday'] = { picks: [{ taskId: 'task_p3', name: 'Bank Offer', move: 'Prepare for the video interview with Dana on Tuesday', due: '2026-10-20', why: null, quote: null }], source: 'ai' }; await ranked();
      const todoMail = document.querySelector('.today-card[data-task-id="task_p3"]');
      const mailTips = [...(todoMail?.querySelectorAll('footer button') || [])].map((b) => b.dataset.tip || b.title || b.textContent.trim());
      say(!!todoMail && same(mailTips, ['Not this', 'Done', 'New date', 'Reply to Robin in Outlook']) && !todoMail.querySelector('.today-go, .today-do'), 'Today: the To do move from an email has Reply, tooltip "Reply to Robin in Outlook"', mailTips.join(', ') || 'no card');
      todoMail?.querySelector('.ws-act[aria-label^="Reply"]')?.click(); await wait();
      const todaySay = document.querySelector('.today-card[data-task-id="task_p3"] .today-say');
      if (todaySay) { todaySay.value = 'tuesday works'; todaySay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(); }
      // loggie-reply-yes: Enter shows the one yes on the card's own row (nothing sent yet, no ask box card); "Just this
      // one" reaches the reply call with 'once', the row says it is ready, and offers once to skip the question.
      const lastReply = () => [...(window.__args || [])].reverse().find((a) => a.path === 'hikyaku.replyTo')?.args;
      const yesRow = document.querySelector('.today-card[data-task-id="task_p3"] .reply-row.is-yes');
      const yesLabels = [...(yesRow?.querySelectorAll('button') || [])].map((b) => b.textContent.trim());
      const askCardShown = () => { const c = document.querySelector('.ask-card'); return !!c && !c.hidden && /reply/i.test(c.textContent); };
      say(!!todaySay && same(yesLabels, ['Always write my replies', 'Just this one', 'Send my note as typed']) && !lastReply() && !askCardShown(), 'Today: Enter shows the one yes on the card (three answers), nothing sent, no ask box card', yesLabels.join(', ') || 'no yes row');
      yesRow?.querySelector('.reply-second')?.click(); await wait();
      const todayReply = lastReply();
      const readyRow = document.querySelector('.today-card[data-task-id="task_p3"] .reply-row.is-ready');
      say(same(todayReply, ['task_p3', 'tuesday works', 'once']) && /In Outlook, ready to send/.test(readyRow?.textContent || '') && /Skip the question next time\?/.test(readyRow?.textContent || '') && !askCardShown(), 'Today: Just this one reaches the reply call once; the card says ready and offers Always once', JSON.stringify(todayReply) + ' | ' + (readyRow?.textContent || 'no ready row'));
      [...(readyRow?.querySelectorAll('button') || [])].find((b) => b.textContent === 'No')?.click(); await wait();
      const offered = [...(window.__args || [])].reverse().find((a) => a.path === 'hikyaku.setReplyYes')?.args;
      say(same(offered, ['offered']) && !/Skip the question/.test(document.querySelector('.today-card[data-task-id="task_p3"] .reply-row')?.textContent || ''), 'Today: No on the offer saves it as shown and takes it away', JSON.stringify(offered));
      window.__data['hikyaku.firstToday'] = saved; await ranked();
      // Full screen: the label and pressed state follow the answer (the handler once read event.currentTarget after its
      // await, so nothing changed and the first setAttribute threw).
      window.__data['toggleFullScreen'] = true;
      const full = document.querySelector('#fullscreen');
      full?.click(); await wait();
      say(full?.getAttribute('aria-pressed') === 'true' && full?.getAttribute('aria-label') === 'Exit full screen', 'Header: full screen says Exit full screen once on', full ? full.getAttribute('aria-label') : 'no button');
      window.__data['toggleFullScreen'] = false;
      full?.click(); await wait();
      say(full?.getAttribute('aria-pressed') === 'false' && full?.getAttribute('aria-label') === 'Enter full screen', 'Header: full screen says Enter full screen once off', full ? full.getAttribute('aria-label') : 'no button');
      // Workspaces: the list, then a workspace's page.
      document.querySelector('[data-view="workspaces"]').click(); await wait(800);
      tips('Workspaces list');
      document.querySelector('.ws-row[data-name="Bank Offer"]')?.click(); await wait();
      tips('a workspace page');
      const heads = [...document.querySelectorAll('.ws-focus .ws-label-line')].map((n) => n.textContent);
      say(heads.includes('To send') && heads.includes('To do') && heads.indexOf('To send') < heads.indexOf('To do'), 'Workspaces: the page says To send, then To do', heads.join(' / '));
      const titlesIn = (list) => [...(list?.querySelectorAll(':scope > .ws-move .ws-move-title') || [])].map((n) => n.textContent.replace(/^↩ /, ''));
      const sendList = document.querySelector('.ws-to-send-head ~ .ws-moves:not(.ws-to-do)');
      const doList = document.querySelector('.ws-to-do');
      say(same(titlesIn(sendList), ['Follow up with the recruiter on interview status', 'Send a thank-you note after the call', 'Email Lucky Star: ask about the bar tab']), 'Workspaces: To send holds the reply, the text and the email', titlesIn(sendList).join(' | '));
      say(same(titlesIn(doList), ['Prepare two stories for the team round', 'Prepare for the video interview with Dana on Tuesday']) && document.querySelector('.ws-to-do-head')?.nextElementSibling === doList, 'Workspaces: To do holds the prepare moves', titlesIn(doList).join(' | '));
      const rowTips = (li) => [...(li?.querySelectorAll('.ws-move-top > .ws-marks button, .ws-move-top > .ws-go') || [])].map((b) => b.dataset.tip);
      const prep = doList?.querySelector('.ws-move');
      say(same(rowTips(prep), ['Done', 'New date', 'Drop it']) && !prep.querySelector('.ws-go'), 'Workspaces: a To do move has Done, New date, Drop it and no mail button', rowTips(prep).join(', '));
      // The tooltip is there in the same frame as the hover (no timer, no fade): hover Done on the prepare move and read
      // the chip before anything else runs.
      const doneMark = prep?.querySelector('.ws-marks button');
      doneMark?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
      const chip = document.querySelector('.loggie-tip');
      const chipBox = chip?.getBoundingClientRect();
      const still = chip && getComputedStyle(chip).transitionDuration.split(',').every((d) => parseFloat(d) === 0) && !chip.getAnimations().length;
      say(!!chip && !chip.hidden && chipBox.width > 0 && chip.textContent === 'Done' && still && !doneMark.hasAttribute('title'), 'Workspaces: hovering Done shows a tooltip reading Done in the same frame, still', chip ? (chip.hidden ? 'hidden' : '"' + chip.textContent + '"') + ' ' + Math.round(chipBox.width) + 'px' : 'no tooltip');
      doneMark?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body }));
      say(chip?.hidden === true, 'Workspaces: leaving Done hides the tooltip');
      const reply = sendList?.querySelector('.ws-move');
      say(same(rowTips(reply), ['Done', 'New date', 'Drop it', 'Draft it in Outlook']), 'Workspaces: a To send move has Done, New date, Drop it, Draft it in Outlook', rowTips(reply).join(', '));
      reply?.querySelector('.ws-move-open')?.click(); await wait();
      document.querySelector('.ws-go[aria-label^="Draft it in"]')?.click(); await wait();
      say(!!document.querySelector('.ws-say'), 'Workspaces: Draft it in Outlook opens the line box'); tips('a workspace page, the line box open');
      document.querySelector('.ws-say')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait();
      document.querySelector('.ws-view .ws-act[aria-label^="New date"]')?.click(); await wait();
      say(!!document.querySelector('.ws-date'), 'Workspaces: New date opens the date box'); tips('a workspace page, the date box open');
      // Reply on a To do move (today-model.js canReplyTo; Gio, 2026-10-21: "how come it doesnt allow me to reply
      // though?"): only the move whose source is a person's email has it, and its press reaches the reply call.
      say(!prep?.querySelector('.ws-reply'), 'Workspaces: a To do move without an email has no Reply');
      const interview = document.querySelectorAll('.ws-to-do > .ws-move')[1];
      say(same(rowTips(interview), ['Done', 'New date', 'Drop it', 'Reply to Robin in Outlook']) && !!interview.querySelector('.ws-go.ws-reply'), 'Workspaces: the To do move from an email shows Reply, tooltip "Reply to Robin in Outlook"', rowTips(interview).join(', '));
      interview?.querySelector('.ws-reply')?.click(); await wait();
      const replySay = interview && document.querySelector('.ws-to-do .ws-say');
      say(!!replySay && replySay.value === '' && replySay.closest('.ws-move') === document.querySelectorAll('.ws-to-do > .ws-move')[1], 'Workspaces: Reply opens the line box on that move', replySay ? 'value "' + replySay.value + '"' : 'no box');
      tips('a workspace page, the Reply box open');
      if (replySay) { replySay.value = 'happy to, here are my times'; replySay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(); }
      const interviewRow = () => document.querySelectorAll('.ws-to-do > .ws-move')[1];
      const wsYes = interviewRow()?.querySelector('.reply-row.is-yes');
      say(!!wsYes && /Robin's one email and your note/.test(wsYes.textContent) && !/Nemotron/.test(wsYes.textContent) && !askCardShown(), 'Workspaces: Enter shows the one yes on the row, in the one name (cloud AI), no ask box card', wsYes ? wsYes.textContent.slice(0, 120) : 'no yes row');
      tips('a workspace page, the reply yes shown');
      wsYes?.querySelector('.reply-primary')?.click(); await wait();
      const replyArgs = lastReply();
      const replyStatus = interviewRow()?.querySelector('.reply-row')?.textContent || '';
      say(same(replyArgs, ['task_p3', 'happy to, here are my times', 'always']) && /In Outlook, ready to send/.test(replyStatus) && !/Skip the question/.test(replyStatus) && !(window.__args || []).some((a) => a.path === 'hikyaku.doIt' && a.args[0] === 'task_p3'), 'Workspaces: Always write my replies reaches the reply call (replyTo, always), not Draft it; ready, no offer', JSON.stringify(replyArgs) + ' | ' + replyStatus);
      // A draft held for a time: the row asks which time; the typed time reaches the fill call, and the row says ready.
      window.__data['hikyaku.replyYes'] = { always: true, offered: true };
      window.__data['hikyaku.replyTo'] = { started: false, phase: 'needs-you', kind: 'reply-time', askId: '2026-10-21-held0001', text: 'Robin asked about a time and Loggie could not tell which. Which time works?' };
      interviewRow()?.querySelector('.ws-reply')?.click(); await wait();
      const again = document.querySelector('.ws-to-do .ws-say');
      if (again) { again.value = 'yes that works'; again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(); }
      const hold = interviewRow()?.querySelector('.reply-row.is-hold');
      say(!!hold && /Which time works\?/.test(hold.textContent) && same(lastReply(), ['task_p3', 'yes that works', null]), 'Workspaces: with Always on, Enter writes at once; a draft missing a time is held on the row and asks which', hold ? hold.textContent : 'no hold row');
      tips('a workspace page, a reply held for a time');
      const time = hold?.querySelector('.reply-time');
      if (time) { time.value = '3 PM EST'; time.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(); }
      const filled = [...(window.__args || [])].reverse().find((a) => a.path === 'hikyaku.replyFill')?.args;
      say(same(filled, ['task_p3', '2026-10-21-held0001', '3 PM EST']) && /ready to send/.test(interviewRow()?.querySelector('.reply-row')?.textContent || ''), 'Workspaces: the typed time reaches the fill call, then the row says ready', JSON.stringify(filled));
      // Written but not opened (Outlook on the Calendar): the row says why and Try again opens the same draft.
      window.__data['hikyaku.replyTo'] = { started: true, phase: 'in-mail-app', kind: 'clipboard', askId: '2026-10-21-stuck001', why: 'Outlook is showing the Calendar, and background mode never types. Open Mail in Outlook, then try again.', text: 'Robin Park: The Outlook helper failed.' };
      interviewRow()?.querySelector('.ws-reply')?.click(); await wait();
      const third = document.querySelector('.ws-to-do .ws-say');
      if (third) { third.value = 'tuesday works'; third.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(); }
      const stuck = interviewRow()?.querySelector('.reply-row.is-stuck');
      say(!!stuck && /not opened in Outlook\. Outlook is showing the Calendar/.test(stuck.textContent), 'Workspaces: a reply that did not open says why', stuck ? stuck.textContent : 'no stuck row');
      tips('a workspace page, a reply that did not open');
      stuck?.querySelector('.reply-primary')?.click(); await wait();
      const againArgs = [...(window.__args || [])].reverse().find((a) => a.path === 'hikyaku.replyAgain')?.args;
      say(same(againArgs, ['task_p3', '2026-10-21-stuck001']) && /ready to send/.test(interviewRow()?.querySelector('.reply-row')?.textContent || ''), 'Workspaces: Try again opens the same draft (replyAgain), then the row says ready', JSON.stringify(againArgs));
      // Placed, with what to look at before Send: the note went as typed, and the helper's read-back.
      window.__data['hikyaku.replyTo'] = { started: true, phase: 'in-mail-app', kind: null, typed: true, check: 'The reply ends with no closing line and no signature; add one.', text: 'Ready in Outlook: Robin Park. You send it there.' };
      interviewRow()?.querySelector('.ws-reply')?.click(); await wait();
      const fourth = document.querySelector('.ws-to-do .ws-say');
      if (fourth) { fourth.value = 'tuesday 3 works'; fourth.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(); }
      const looked = interviewRow()?.querySelector('.reply-row.is-ready')?.textContent || '';
      say(/your words as typed/.test(looked) && /went in as you typed it/.test(looked) && /Check before sending: The reply ends with no closing line/.test(looked) && !/ready to send/.test(looked), 'Workspaces: a placed reply says what to check before Send and that the note went as typed', looked.slice(0, 160));
      window.__data['hikyaku.replyTo'] = { started: true, phase: 'in-mail-app', kind: null, text: 'Ready in Outlook: Robin Park. You send it there.' };
      document.querySelector('.ws-more')?.click(); await wait(); tips('a workspace page, More open');
      // Notes & Meetings: the Day, Recordings, then a call's own page.
      document.querySelector('[data-view="meetings"]').click(); await wait(1200);
      tips('Meetings day');
      [...document.querySelectorAll('#viewMeetings .mt-view')].find((b) => b.textContent === 'Recordings')?.click(); await wait(400);
      tips('Meetings recordings');
      document.querySelector('#viewMeetings .mt-item-open')?.click(); await wait(1000);
      say(document.querySelector('#viewMeetings')?.dataset.view === 'call', 'Meetings: a recording opens its page');
      tips('a call page');
      return { lines };
    })()`);
    console.log('\nTooltips and To send / To do, 760x900');
    for (const l of out.lines) { console.log('  ' + l); if (!l.startsWith('ok')) failed++; }
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }
  // Right-click and Share (loggie right-click, 2026-10-28): the stand-in bridge plays the Mac's menu, so a check says
  // which items a right-click or a press asked for, picks one, and names the call the pick must reach: the same call the
  // visible control makes. Nothing native opens.
  {
    const win = new BrowserWindow({ show: false, width: 1000, height: 1000 });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${String(event.sourceId).split('/').pop()}:${event.lineNumber})`); });
    await win.loadURL(`${base}/panel-check.html`);
    await new Promise((r) => setTimeout(r, 1200));
    const out = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
      const lines = [];
      const say = (ok, label, seen = '') => lines.push((ok ? 'ok   ' : 'NOTHING ') + label + (ok || !seen ? '' : ' (' + seen + ')'));
      const q = (sel) => document.querySelector(sel);
      const lastArgs = (path) => [...(window.__args || [])].reverse().find((a) => a.path === path)?.args;
      const asked = () => lastArgs('hikyaku.contextMenu')?.[0] || null;
      const ids = (menu) => (menu?.items || []).map((item) => item.id).join(',');
      // The Mac's menu, played: the next popup answers this pick.
      const answer = (pick) => { window.__data['hikyaku.contextMenu'] = () => pick; };
      q('[data-view="meetings"]').click(); await wait(800);
      [...document.querySelectorAll('#viewMeetings .mt-view')].find((b) => b.textContent === 'Recordings')?.click(); await wait();
      q('#viewMeetings .mt-item[data-call="2026-10-09-1300-weekly-sync"] .mt-item-open')?.click(); await wait(800);
      // Share, beside Copy notes: one press shows the two lines; a pick of the first sends nothing, it opens his mail app.
      window.__data['hikyaku.callShare'] = (id, how) => ({ how, people: 2, line: 'Open in Outlook, unsent: 2 people. You send it there.' });
      const share = q('#viewMeetings .mt-head .mt-share');
      say(share?.getAttribute('aria-label') === 'Share' && share.previousElementSibling?.getAttribute('aria-label') === 'Copy notes', 'Share sits beside Copy notes', share?.previousElementSibling?.getAttribute('aria-label'));
      answer({ id: 'people', value: null });
      share?.click(); await wait();
      say(asked()?.kind === 'share' && ids(asked()) === 'people,sheet' && asked()?.target?.id === '2026-10-09-1300-weekly-sync', 'the Share button shows the two lines', JSON.stringify(asked()));
      say(JSON.stringify(lastArgs('hikyaku.callShare')) === JSON.stringify(['2026-10-09-1300-weekly-sync', 'people']) && q('#viewMeetings .mt-foot .mt-shared')?.textContent === 'Open in Outlook, unsent: 2 people. You send it there.', 'Send notes to the people reaches callShare and says where it opened', JSON.stringify(lastArgs('hikyaku.callShare')));
      const shares = (window.__calls || []).filter((c) => c === 'hikyaku.callShare').length;
      answer({ id: null, value: null });
      share?.click(); await wait();
      say((window.__calls || []).filter((c) => c === 'hikyaku.callShare').length === shares, 'Esc on the Share menu shares nothing');
      // A recording's right-click: the guess with its evidence first, and one press files it as the chip's picker does.
      const right = (node) => (node ? (node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })), true) : false);
      const row = (id) => q('#viewMeetings .mt-item[data-call="' + id + '"]');
      const count = (path) => (window.__calls || []).filter((c) => c === path).length;
      // The text menu first, on this page: the notes box, then the ask box.
      answer({ id: null, value: null });
      right(q('#viewMeetings .mt-notes')); await wait();
      say(asked()?.kind === 'text' && ids(asked()) === 'cut,copy,paste,selectAll' && asked()?.target === null, 'a text field keeps Cut, Copy, Paste and Select All', JSON.stringify(asked()));
      right(q('#message')); await wait();
      say(asked()?.kind === 'text' && asked()?.items.find((i) => i.id === 'paste')?.enabled === true, 'the ask box too');
      right(q('#viewMeetings .mt-title')); await wait();
      say(asked()?.kind === 'recording' && asked()?.target?.id === '2026-10-09-1300-weekly-sync', 'the open call’s title, not being edited, has the recording menu', JSON.stringify(asked()?.target));
      // Delete recording, the quiet link at the page's foot, and the same call from the menu.
      window.__data['hikyaku.callTrash'] = (id) => ({ trashed: true, title: id, from: null, setAside: 0 });
      const link = q('#viewMeetings .mt-foot .mt-trash');
      say(link?.textContent === 'Delete recording' && !link.disabled, 'Delete recording sits quiet at the page foot');
      link?.click(); await wait(600);
      say(JSON.stringify(lastArgs('hikyaku.callTrash')) === JSON.stringify(['2026-10-09-1300-weekly-sync']) && q('#viewMeetings')?.dataset.view === 'recordings', 'Delete recording reaches callTrash, and the page goes back to Recordings', q('#viewMeetings')?.dataset.view);
      answer({ id: 'guess', value: 'Hotel Hackathon' });
      const asks = count('hikyaku.answerAsk');
      right(row('2026-10-08-0900-coffee-chat')?.querySelector('.mt-item-title')); await wait(700);
      say(asked()?.kind === 'recording' && ids(asked()) === 'guess,file,share,open,copy,rename,trash' && asked()?.target?.id === '2026-10-08-0900-coffee-chat', 'a right-click on a recording row asks for its seven items', ids(asked()));
      const first = asked()?.items?.[0];
      say(first?.enabled && first.value === 'Hotel Hackathon' && first.line === 'said “hackathon” 4 times', 'its first line is the guess with its evidence', JSON.stringify(first));
      say(JSON.stringify(lastArgs('hikyaku.fileCall')) === JSON.stringify(['2026-10-08-0900-coffee-chat', 'Hotel Hackathon', 'menu']) && count('hikyaku.answerAsk') === asks + 1
        && /^Filed under Hotel Hackathon/.test(row('2026-10-08-0900-coffee-chat')?.querySelector('.mr-payoff')?.textContent || ''), 'one press on the guess files it as the chip does (source menu), answers the guess, and says what it did', JSON.stringify(lastArgs('hikyaku.fileCall')));
      // Add to workspace > a name: the chip's fileCall, source menu. The waiting call: Delete greyed with its reason.
      answer({ id: 'file', value: 'Bank Offer' });
      right(row('2026-10-07-1600-team-readout')); await wait(700);
      const sub = asked()?.items?.find((i) => i.id === 'file')?.submenu || [];
      say(sub.find((e) => e.on)?.value === 'Hotel Hackathon' && sub.at(-1)?.value === null && !sub.some((e) => /new/i.test(String(e.value))), 'Add to workspace checks the current one, No workspace last, no new workspace', JSON.stringify(sub));
      say(JSON.stringify(lastArgs('hikyaku.fileCall')) === JSON.stringify(['2026-10-07-1600-team-readout', 'Bank Offer', 'menu']), 'Add to workspace > Bank Offer calls the chip’s fileCall with source menu', JSON.stringify(lastArgs('hikyaku.fileCall')));
      const trash = asked()?.items?.at(-1);
      say(trash?.id === 'trash' && trash.enabled === false && trash.line === 'not now: it is waiting for your yes to summarize', 'Delete waits on a call waiting for its yes, and says why', JSON.stringify(trash));
      const files = count('hikyaku.fileCall');
      answer({ id: null, value: null });
      right(row('2026-10-07-1600-team-readout')); await wait();
      say(count('hikyaku.fileCall') === files, 'Esc on a recording menu files nothing');
      // Copy notes, Open notes, Rename and Delete from a row run what the Copy button, the row, the title and the link run.
      const copied = [];
      navigator.clipboard.writeText = async (text) => { copied.push(text); };
      answer({ id: 'copy', value: null });
      right(row('2026-10-09-1300-weekly-sync')); await wait(700);
      say(copied.length === 1 && /The role\\n- The team owns the analytics roadmap/.test(copied[0]) && /Copied the notes of Weekly sync with Lena/.test(row('2026-10-09-1300-weekly-sync')?.textContent || ''), 'Copy notes from the menu copies what Copy notes copies, and says so under the row', copied[0]?.slice(0, 60));
      answer({ id: 'trash', value: null });
      right(row('2026-10-08-0900-coffee-chat')); await wait(600);
      say(JSON.stringify(lastArgs('hikyaku.callTrash')) === JSON.stringify(['2026-10-08-0900-coffee-chat']), 'Delete recording from the menu reaches the same callTrash', JSON.stringify(lastArgs('hikyaku.callTrash')));
      answer({ id: 'rename', value: null });
      right(row('2026-10-09-1300-weekly-sync')); await wait(900);
      say(q('#viewMeetings')?.dataset.view === 'call' && document.activeElement === q('#viewMeetings .mt-title'), 'Rename opens the call with the caret in its title', document.activeElement?.className);
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait();
      q('#viewMeetings .mt-back')?.click(); await wait();
      answer({ id: 'open', value: null });
      const opens = count('hikyaku.call');
      right(row('2026-10-08-0900-coffee-chat')); await wait(700);
      say(q('#viewMeetings')?.dataset.view === 'call' && count('hikyaku.call') > opens, 'Open notes opens the call as the row does');
      // The waiting call's own page: the link greyed, its reason beside it.
      window.__data['hikyaku.call'] = { ...window.__data['hikyaku.call'], id: '2026-10-07-1600-team-readout', state: 'waiting' };
      q('#viewMeetings .mt-back')?.click(); await wait();
      row('2026-10-07-1600-team-readout')?.querySelector('.mt-item-open')?.click(); await wait(800);
      say(q('#viewMeetings .mt-foot .mt-trash')?.disabled === true && q('#viewMeetings .mt-foot .mt-trash-why')?.textContent === 'Not now: it is waiting for your yes to summarize', 'on a waiting call Delete recording is greyed with its reason', q('#viewMeetings .mt-foot')?.textContent);
      // A workspace row's right-click: Catch up now is Refresh this, the stakes are the More taps, Park and Edit name open
      // what their More buttons open.
      q('[data-view="workspaces"]').click(); await wait(700);
      const wsRow = () => q('.ws-row[data-name="Hotel Hackathon"]');
      answer({ id: 'catch-up', value: null });
      right(wsRow()?.querySelector('.ws-label')); await wait(700);
      say(asked()?.kind === 'workspace' && ids(asked()) === 'catch-up,open,more,less,park,rename,retire' && asked()?.target?.id === 'Hotel Hackathon', 'a right-click on a workspace row asks for its seven items', ids(asked()) + ' ' + JSON.stringify(asked()?.target));
      say(asked()?.items?.[0]?.enabled === true && typeof asked()?.items?.[0]?.line === 'string', 'its first line is Catch up now, with what its row says is new', JSON.stringify(asked()?.items?.[0]));
      say(JSON.stringify(lastArgs('hikyaku.refreshOne')) === JSON.stringify(['Hotel Hackathon']), 'Catch up now reaches refreshOne, as Refresh this does', JSON.stringify(lastArgs('hikyaku.refreshOne')));
      answer({ id: 'more', value: null });
      right(wsRow()); await wait(700);
      say(JSON.stringify(lastArgs('hikyaku.setStake')) === JSON.stringify(['Hotel Hackathon', 'more']), 'Matters more reaches setStake, as its More tap does', JSON.stringify(lastArgs('hikyaku.setStake')));
      answer({ id: 'park', value: null });
      right(wsRow()); await wait(700);
      say(/Hotel Hackathon/.test(q('.ws-card-title')?.textContent || '') && !!q('.ws-park-pick'), 'Park until… opens its page with the days to park it', q('.ws-card-title')?.textContent);
      q('.ws-back')?.click(); await wait();
      answer({ id: 'rename', value: null });
      right(wsRow()); await wait(700);
      say(!!q('.ws-name-edit input') && /Hotel Hackathon/.test(q('.ws-card-title')?.textContent || ''), 'Edit name opens its page with the name box open');
      q('.ws-back')?.click(); await wait();
      const stakes = count('hikyaku.setStake');
      answer({ id: null, value: null });
      right(wsRow()); await wait();
      say(count('hikyaku.setStake') === stakes && !q('.ws-card-title'), 'Esc on a workspace menu does nothing');
      // A move's right-click on its workspace's page: Draft it opens the row's line box, Done and New date are its marks,
      // and the call it came from opens Notes & Meetings.
      q('.ws-row[data-name="Bank Offer"]')?.click(); await wait(600);
      const moveRow = (id) => q('.ws-move[data-move="' + id + '"]');
      answer({ id: 'done', value: null });
      right(moveRow('task_c')?.querySelector('.ws-move-title')); await wait(700);
      say(asked()?.kind === 'move' && ids(asked()) === 'draft,done,date,drop,call' && asked()?.target?.id === 'task_c', 'a right-click on a move asks for its five items', ids(asked()) + ' ' + JSON.stringify(asked()?.target));
      say(asked()?.items?.[0]?.enabled === true && /^in Outlook/.test(asked()?.items?.[0]?.line || ''), 'its first line is Draft it, with the app it lands in', JSON.stringify(asked()?.items?.[0]));
      say(JSON.stringify(lastArgs('hikyaku.markMove')) === JSON.stringify(['task_c', 'done']), 'Done reaches markMove, as the row’s ✓ does', JSON.stringify(lastArgs('hikyaku.markMove')));
      answer({ id: 'draft', value: null });
      right(moveRow('task_c')); await wait(600);
      say(!!moveRow('task_c')?.querySelector('.ws-say'), 'Draft it with Loggie opens the row’s line box');
      answer({ id: 'date', value: null });
      right(moveRow('task_c')); await wait(600);
      say(!!moveRow('task_c')?.querySelector('.ws-date') && !moveRow('task_c')?.querySelector('.ws-say'), 'New date… opens the row’s date box');
      answer({ id: 'call', value: null });
      right(moveRow('task_b')); await wait(700);
      say(asked()?.items?.[0]?.enabled === false && /iPhone/.test(asked()?.items?.[0]?.line || '') && asked()?.items?.at(-1)?.enabled === true, 'a text this Mac cannot send greys Draft it with why; its call line is there', JSON.stringify(asked()?.items));
      say(!q('[data-page="meetings"]')?.hidden, 'Open the call it came from opens Notes & Meetings');
      return { lines };
    })()`);
    console.log('\nRight-click and Share, 1000px');
    for (const l of out.lines) { console.log('  ' + l); if (!l.startsWith('ok')) failed++; }
    for (const e of errors) { console.log('  console: ' + e); failed++; }
    win.destroy();
  }
  console.log(failed ? `\nFAIL ${failed}` : '\nPASS');
  app.exit(failed ? 1 : 0);
});
