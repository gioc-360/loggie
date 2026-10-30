// Settings, "Your Mac" (loggie-diagnostics, mock workspace/loggie-diagnostics/mock-a.html): every system Loggie uses, as
// the same rows setup's Ready step draws (setup-model.js macRows), checked each time Settings opens and on Check again,
// with one press to fix each row that is off. Why: chats were never on for an install that had workspaces before the
// setup page existed, the doctor showed that as fine, and "message leah nakaima" said no one had that name.
//   createMacCheck({ root, api }) -> { check() }
//   api: setupStatus(), setupSave(patch), setupAsk(what), cloudYesAnswer(group, answer), openKeys(), onVoice(listener)
import { checklistItem } from './checklist.js';
import { el } from './move-view.js';
import { macRows, macSummary } from './setup-model.js';

export function createMacCheck({ root, api }) {
  const summary = root.querySelector('#macSummary');
  const list = root.querySelector('#macRows');
  const checked = root.querySelector('#macChecked');
  const again = root.querySelector('#macAgain');
  let status = null;
  let busy = false;

  function draw() {
    const rows = macRows(status || {});
    const text = macSummary(rows);
    summary.textContent = text;
    summary.classList.toggle('is-ok', !rows.some((row) => row.state === 'off' || row.state === 'after-reopen'));
    list.replaceChildren(...rows.map((row) => checklistItem(row, { onPress: press, onToggle: toggle, onChange: change, buttonClass: 'su-plain small' })));
  }

  async function check() {
    if (busy) return;
    busy = true;
    again.disabled = true;
    checked.textContent = 'Checking…';
    const started = performance.now();
    try {
      status = await api.setupStatus();
      // No "Checked just now" line (Gio, 2026-10-28): the rows themselves say what is on.
      checked.textContent = '';
      draw();
    } catch (error) {
      checked.textContent = '';
      summary.classList.remove('is-ok');
      summary.textContent = `The check could not run: ${error.message}`;
    } finally {
      busy = false;
      again.disabled = false;
    }
  }

  // A row's one button: the macOS pane or question it needs, the key box, or the texts' cloud yes; then check again.
  // An answer macOS gives here is recorded as setup records it (setup.js), or the row read Off again after Turn on:
  // Apple Mail control at once, voice typing when the helper reports (Codex review, 2026-10-23).
  async function press(row, item) {
    const button = item.querySelector('button.su-plain');
    button?.setAttribute('disabled', '');
    const voice = row.button?.ask === 'speech' ? hearVoice(item) : null;
    try {
      if (row.button?.go === 'keys') { api.openKeys?.(); return; }
      if (row.button?.yes) await api.cloudYesAnswer(row.button.yes === 'chats' ? 'chats' : 'ai', 'yes');
      else if (row.button?.ask) {
        const answer = await api.setupAsk(row.button.ask);
        if (row.button.ask === 'automation' && answer?.status) await api.setupSave({ automation: answer.status });
        if (voice && answer?.status === 'starting') return;
      }
      voice?.();
      await check();
    } catch (error) {
      voice?.();
      item.append(el('span', 'su-note', error.message));
    } finally {
      button?.removeAttribute('disabled');
    }
  }
  // Voice typing's answer comes later on the voice channel (main's setup-ask starts the helper): recorded, then checked.
  // Listening starts before the ask, so an answer that comes first is not missed. Returns the way to stop listening.
  function hearVoice(item) {
    const stop = api.onVoice?.(async (data) => {
      if (data?.status !== 'permissions-complete' && !data?.error) return;
      stop?.();
      try { await api.setupSave({ voice: data.status === 'permissions-complete' ? 'granted' : 'denied' }); await check(); }
      catch (error) { item.append(el('span', 'su-note', error.message)); }
    });
    return () => stop?.();
  }

  // The chats switch: on reads Messages (and WhatsApp when installed) on this Mac; the texts' cloud yes stays its own row.
  // A save that fails leaves the switch usable (Codex review, 2026-10-23: it stayed disabled until a later check drew).
  async function toggle(row, on, item) {
    const sw = item.querySelector('.switch');
    sw?.setAttribute('disabled', '');
    try {
      await api.setupSave({ chats: on });
      await check();
    } catch (error) {
      item.append(el('span', 'su-note', error.message));
    } finally {
      sw?.removeAttribute('disabled');
    }
  }

  // The mail app's Change: the pick is saved as setup saves it (the same setupSave, so setup and Settings agree), then the
  // row is checked again and shows what that app needs (Turn on). A failed save leaves the choices.
  async function change(row, mailApp, item) {
    const choices = [...item.querySelectorAll('.mac-choices .choice')];
    const off = choices.filter((node) => node.disabled);
    choices.forEach((node) => node.setAttribute('disabled', ''));
    try {
      await api.setupSave({ mailApp });
      await check();
    } catch (error) {
      item.append(el('span', 'su-note', error.message));
    } finally {
      choices.filter((node) => !off.includes(node)).forEach((node) => node.removeAttribute('disabled'));
    }
  }

  again.addEventListener('click', check);
  return { check };
}
