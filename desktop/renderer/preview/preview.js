// The preview page's driver: the real workspaces.js on made-up cards (fixture-cards.js) with a fake bridge that records
// what the screen asked for. ?w=<px> sets the frame width; ?focus=<name> opens that workspace; ?real=1 draws
// real-cards.local.js instead (built on the Mac from the user's own files, never committed).
import { createWorkspacesView } from '../workspaces.js';
import { createReplies } from '../reply-row.js';
import * as fixture from './fixture-cards.js';

const params = new URLSearchParams(location.search);
const { CARDS, TODAY } = params.get('real') ? await import('./real-cards.local.js') : fixture;
document.querySelector('.preview-frame').style.setProperty('--w', `${Number(params.get('w')) || 460}px`);
const log = document.getElementById('log');
let retired = [];
let cards = structuredClone(CARDS);
for (const [key, stake] of [['more', 'more'], ['less', 'less']]) {
  if (params.get(key)) cards = cards.map((c) => (c.name === params.get(key) ? { ...c, stake, priority: { ...c.priority, stake } } : c));
}
const say = (text) => { log.textContent = text; };
const api = {
  uiAct: async (act) => say(`act ${act.act}${act.name ? ` · ${act.name}` : ''}`),
  refresh: async () => say('refresh'),
  refreshOne: async (name) => { cards = cards.map((c) => (c.name === name ? { ...c, current: true, unread: 0, news: [], asOf: `${TODAY}T20:00:00.000Z` } : c)); say(`refresh ${name}`); return {}; },
  doIt: async (id, line = null) => { say(`do it ${id}${line ? ` saying "${line}"` : ''}`); return { started: true, phase: 'queued', text: 'Queued.' }; },
  markMove: async (id, why) => { say(`mark ${id} ${why}`); return { taskId: id, why }; },
  moveDate: async (id, date) => { say(`date ${id} ${date}`); return { taskId: id, due: date }; },
  unretire: async (id) => { say(`unretire ${id}`); return { ok: true }; },
  openDraft: async (id, options) => { say(`open draft ${id}${options?.again ? ' again' : ''}`); return {}; },
  setStake: async (name, stake) => { cards = cards.map((c) => (c.name === name ? { ...c, stake: stake || 'normal', priority: { ...c.priority, stake: stake || 'normal' } } : c)); say(`stake ${name} ${stake}`); },
  park: async (name, until) => { cards = cards.map((c) => (c.name === name ? { ...c, priority: { ...c.priority, parked: Boolean(until), parkedUntil: until } } : c)); say(`park ${name} ${until}`); },
  renameWorkstream: async (name, label) => { cards = cards.map((c) => (c.name === name ? { ...c, label: label || undefined } : c)); say(`rename ${name} ${label}`); return {}; },
  dismissWorkstream: async (name) => { cards = cards.filter((c) => c.name !== name); say(`dismiss ${name}`); return { name }; },
  // Retire (loggie-workspaces-integration F1): a card with open moves asks once; the choice settles them and it retires.
  retireWorkstream: async (name, choice = null, target = null) => {
    const card = cards.find((c) => c.name === name);
    const open = (card?.moves || []).length;
    if (open && !choice) return { needsChoice: true, open };
    cards = cards.filter((c) => c.name !== name);
    retired.push({ name, label: card?.label || null, retired: `${TODAY}T12:00:00.000Z`, recordings: [{ id: '2026-10-09-1300-weekly-sync', title: 'Weekly sync with Lena', start: '2026-10-09T17:00:00Z', minutes: 33 }] });
    say(`retire ${name} ${choice || 'none'}${target ? ` to ${target}` : ''}`);
    return { name, settled: open, choice };
  },
  // Delete (loggie-delete-workspace): the same once-asked choice, then gone for good, not under Retired.
  deleteWorkstream: async (name, choice = null, target = null) => {
    const card = cards.find((c) => c.name === name);
    const open = (card?.moves || []).length;
    if (open && !choice) return { needsChoice: true, open };
    cards = cards.filter((c) => c.name !== name);
    say(`delete ${name} ${choice || 'none'}${target ? ` to ${target}` : ''}`);
    return { name, settled: open, choice, unfiled: 1 };
  },
  retiredWorkstreams: async () => retired.map((item) => ({ ...item })),
  confirmGoal: async (name, text) => { cards = cards.map((c) => (c.name === name ? { ...c, goalText: text, goalConfirmed: true } : c)); say(`goal yes ${name}`); return {}; },
  moveThread: async (id, name) => { say(`move ${id} to ${name}`); return { moved: 2, from: 'Bank Offer', to: name, reading: true }; },
  fileCall: async (id, name, source) => { say(`file ${id} under ${name} from ${source}`); return { to: name, created: [], notes: true }; },
  unretireWorkstream: async (name) => { retired = retired.filter((item) => item.name !== name); say(`bring back ${name}`); return { name }; },
};
// Reply on a To do move (reply-row.js): the yes asked on the row, then ready; nothing leaves the preview.
const replies = createReplies({
  api: {
    replyYes: async () => ({ always: false, offered: false }),
    setReplyYes: async (what) => { say(`reply yes ${what}`); return {}; },
    replyTo: async (id, line = null, cloud = null) => { say(`reply to ${id}${line ? ` saying "${line}"` : ''}${cloud ? ` (${cloud})` : ''}`); return { started: true, phase: 'in-mail-app', text: 'Ready in Outlook.' }; },
    replyFill: async (id, askId, time) => { say(`fill ${id} with "${time}"`); return { started: true, phase: 'in-mail-app', text: 'Ready in Outlook.' }; },
  },
  onChange: () => view.draw(cards),
});
const view = createWorkspacesView({ root: document.getElementById('workstreamView'), api, today: TODAY, onChanged: async () => view.draw(cards), replies });
view.draw(cards);
if (params.get('focus')) view.open(params.get('focus'));
