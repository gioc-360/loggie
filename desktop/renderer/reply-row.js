// Reply on a To do move, one row for Workspaces and Today (docs/reply-yes/spec.md; mock workspace/loggie-reply-yes/
// mock-a.html): the yes is asked once, on the row, never in the ask box; then one still status line, writing, ready
// or held for a missing time. No motion: every state is drawn in one frame (feedback: "A BLINKS TOO MUCH").
//
//   createReplies({ api, onChange }) -> { send(moveId, said, who), node(moveId, { app, who }), stage(moveId) }
//     api: replyTo(id, line, cloud), replyYes() -> { always, offered }, setReplyYes('always' | 'offered'),
//          replyFill(id, askId, time), replyAgain(id, askId). onChange(): the views redraw (the state lives here).
//   Stages: yes (the three answers) · writing · ready (and the one offer after "Just this one") · hold (which time) ·
//   stuck (written but not opened: why, and Try again on the same draft) · failed. Only a real failure is red; the yes is a question, not an error.
import { APP_ICON, icon } from './icons.js';
import { button, el } from './move-view.js';

const APP = { outlook: 'Outlook', 'apple-mail': 'Mail', gmail: 'Gmail' };

export function createReplies({ api, onChange = () => {} }) {
  const states = new Map();
  const set = (id, state) => { states.set(id, state); onChange(); };

  // Enter in the note box. With Always on, it writes at once; else the row asks, with nothing sent yet.
  async function send(id, said, who = '') {
    let yes = { always: false, offered: false };
    try { yes = (await api.replyYes?.()) || yes; } catch { /* asked below instead */ }
    if (yes.always) return run(id, said, null, { who, offered: true });
    set(id, { stage: 'yes', said, who, offered: Boolean(yes.offered) });
  }

  async function run(id, said, cloud, { who = '', offered = true } = {}) {
    set(id, { stage: 'writing', said, who });
    let outcome;
    try { outcome = await api.replyTo(id, said || null, cloud); } catch (error) { outcome = { phase: 'failed', text: error.message }; }
    settle(id, outcome, { said, who, cloud, offered });
  }

  function settle(id, outcome, { said, who, cloud, offered }) {
    if (outcome?.kind === 'cloud-yes') return set(id, { stage: 'yes', said, who, offered });
    if (outcome?.kind === 'reply-time') return set(id, { stage: 'hold', said, who, askId: outcome.askId, text: outcome.text, fresh: true });
    // Written but not opened (Outlook on the Calendar): the row says why, and Try again opens this same draft.
    if (outcome?.phase === 'in-mail-app' && outcome.kind === 'clipboard' && outcome.askId) {
      return set(id, { stage: 'stuck', said, who, askId: outcome.askId, why: outcome.why || '', cloud, offered });
    }
    if (outcome?.phase === 'in-mail-app') {
      return set(id, { stage: 'ready', said, who, clipboard: outcome.kind === 'clipboard', words: cloud === 'words', offer: cloud === 'once' && !offered,
        check: outcome.check || '', typed: Boolean(outcome.typed) });
    }
    set(id, { stage: 'failed', said, who, text: String(outcome?.text || 'The reply could not be written.') });
  }

  async function fill(id, time) {
    const state = states.get(id);
    if (!state?.askId || !time.trim()) return;
    set(id, { ...state, stage: 'writing' });
    let outcome;
    try { outcome = await api.replyFill(id, state.askId, time.trim()); } catch (error) { outcome = { phase: 'failed', text: error.message }; }
    settle(id, outcome, { said: state.said, who: state.who, cloud: null, offered: true });
  }

  async function again(id) {
    const state = states.get(id);
    if (!state?.askId) return;
    set(id, { ...state, stage: 'writing' });
    let outcome;
    try { outcome = await api.replyAgain(id, state.askId); } catch (error) { outcome = { phase: 'failed', text: error.message }; }
    settle(id, outcome, { said: state.said, who: state.who, cloud: state.cloud, offered: state.offered });
  }

  async function answerOffer(id, always) {
    const state = states.get(id);
    set(id, { ...state, offer: false });
    try { await api.setReplyYes(always ? 'always' : 'offered'); } catch { /* the offer is not shown again this session */ }
  }

  // The row's part under the note box, or null when this move has no reply going.
  function node(id, { app = 'outlook' } = {}) {
    const state = states.get(id);
    if (!state) return null;
    const where = APP[app] || 'Outlook';
    const part = el('div', `reply-row is-${state.stage}`);
    part.setAttribute('role', 'status');
    if (state.stage === 'yes') {
      if (state.said) part.append(el('p', 'reply-said', state.said));
      const ask = el('div', 'reply-yes');
      ask.append(el('p', '', `Loggie's cloud AI reads ${state.who ? `${state.who}'s` : 'their'} one email and your note to write this. Nothing else leaves this Mac.`));
      const answers = el('div', 'reply-answers');
      answers.append(
        button('Always write my replies', () => run(id, state.said, 'always', state), 'reply-primary'),
        button('Just this one', () => run(id, state.said, 'once', state), 'reply-second'),
        button('Send my note as typed', () => run(id, state.said, 'words', state), 'reply-quiet'),
      );
      ask.append(answers);
      part.append(ask);
    } else if (state.stage === 'writing') {
      part.append(line(icon('ring', 'is-spin'), `Writing your reply in ${where}…`));
    } else if (state.stage === 'ready') {
      part.append(line(icon('check'), state.clipboard ? `On your clipboard: paste it in the ${where} reply and send.`
        : state.words || state.typed ? `In ${where}, your words as typed` : `In ${where}, ready to send`, state.clipboard ? '' : ` · Discard it there to take it back`));
      // What to look at before Send: the cloud AI's draft left the note's point out, so the note went as typed; and what
      // the helper read back in the reply window (no sign-off, a second signature, someone else on To).
      if (state.typed || state.check) {
        const look = el('div', 'reply-hold');
        if (state.typed) look.append(el('p', '', "The cloud AI's draft left out your point, so your note went in as you typed it. Read it before you send."));
        if (state.check) look.append(el('p', '', `Check before sending: ${state.check}`));
        part.append(look);
      }
      if (state.offer) {
        const offer = el('div', 'reply-answers');
        offer.append(el('span', 'reply-offer', 'Skip the question next time?'),
          button('Always write my replies', () => answerOffer(id, true), 'reply-second'),
          button('No', () => answerOffer(id, false), 'reply-quiet'));
        part.append(offer);
      }
    } else if (state.stage === 'hold') {
      const hold = el('div', 'reply-hold');
      hold.append(el('p', '', state.text || 'Which time should it say?'));
      const box = el('div', 'ws-line');
      const input = el('input', 'reply-time');
      input.placeholder = 'e.g. 3 PM EST';
      input.maxLength = 120;
      input.setAttribute('aria-label', 'The time the reply should say');
      const go = button('', () => fill(id, input.value), 'ws-go');
      go.setAttribute('aria-label', 'Put this time in the reply');
      go.title = 'Put this time in the reply';
      go.append(icon('up'));
      // What is typed, and the focus, survive the views' redraws (they reload every few seconds).
      input.value = state.typed || '';
      input.addEventListener('input', () => { state.typed = input.value; });
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) go.click(); });
      box.append(input, go);
      hold.append(box);
      part.append(hold);
      // The time box takes the focus once, when the hold first shows; a redraw keeps what was typed (the views' rule).
      // node() runs before the view swaps its children, so the old box still holds the focus here.
      const hadFocus = document.activeElement?.dataset?.replyId === id;
      input.dataset.replyId = id;
      if (state.fresh || hadFocus) { state.fresh = false; setTimeout(() => { if (input.isConnected) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } }, 0); }
    } else if (state.stage === 'stuck') {
      const stuck = el('div', 'reply-hold');
      stuck.append(el('p', '', `Written, but not opened in ${where}. ${state.why || `Check ${where}, then try again.`}`));
      const answers = el('div', 'reply-answers');
      answers.append(button('Try again', () => again(id), 'reply-primary'), el('span', 'reply-muted', 'The draft is on your clipboard too.'));
      stuck.append(answers);
      part.append(stuck);
    } else {
      const failed = line(icon('x'), state.text);
      failed.classList.add('is-failed');
      part.append(failed);
    }
    return part;

    function line(mark, text, quiet = '') {
      const row = el('p', 'ws-row-status');
      row.append(mark, icon(APP_ICON[app] || 'mail'), el('span', '', text));
      if (quiet) row.append(el('span', 'reply-muted', quiet));
      return row;
    }
  }

  return { send, node, fill, stage: (id) => states.get(id)?.stage || null };
}
