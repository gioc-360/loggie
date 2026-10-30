// The made-up Orchard workstream both next-move check files press Send on: two screened threads, a fake screen runner,
// a fake Core and the Token Factory reply shape. Tilde words so nothing here can be mistaken for real mail. Each file
// keeps its own thread A: the no-move file's adds a past date (Oct 7).
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareNextMove } from '../../src/hikyaku/send-gate.js';
import { buildRequest, parseOutbound } from '../../src/hikyaku/next-move.js';
import { storeCore } from './fake-core.js';

export const SUPER = 'nvidia/nemotron-3-super-120b-a12b';
export const TRANSCRIBER = '/fake/transcriber/spike';
// Thread B: one sentence held, with an inline placeholder that is not a kept sentence.
export const OUT_B = '# Barn paint\n\n_Screened on this Mac by local-test: 1 of 3 sentences kept back (code 0, model 1, unchecked 0); see HELD.json._\n\n## Rook Dale · 2026-10-02T09:00:00Z\n\nThe barn paint is drying. [health kept on this Mac] We can talk next week.\n';
export const HELD = (held) => ({ source: 'thread', counts: { sentences: 4, sent: 4 - held, held, turns: 2, turns_fully_held: 0, layer: { code: 0, model: held, unchecked: 0 }, category: {} }, held: [] });
export const THREAD_MD = '# Re: Orchard tour\n\n## Quill Ashe <quill@example.org> · 2026-10-03T14:00:00Z\n\nCould you send it?\n';
export const DRAFTS = [
  'Hi Quill,\n\nThe cider list is on its way. Which day suits you for the planning call?\n\nPell',
  'Hi Quill,\n\nSending the cider list now. Tell me a day that works for the call.\n\nPell',
  'Hi Quill,\n\nThe cider list comes before the tour. What day is good for the call?\n\nPell',
];
export const GOOD = { thread_id: 'thread-a', title: 'Ask Quill which day suits the planning call', kind: 'reply', why: ['f1'], drafts: DRAFTS, slots: [], steps: [], quote: 'Let me know which day works for a planning call.' };

// Token Factory's chat completion around a reply.
export const tf = (content, { finish = 'stop', model = SUPER } = {}) => ({ id: 'chatcmpl-test', model, choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 } });

// The screen, faked: writes the file's thread A or B and its HELD.json, B with heldB sentences held.
const runnerFor = (outA, heldB) => async (command, args) => {
  const out = args[args.indexOf('--out') + 1];
  const a = out.endsWith('thread-a');
  await writeFile(join(out, 'OUTBOUND.md'), a ? outA : OUT_B);
  await writeFile(join(out, 'HELD.json'), JSON.stringify(HELD(a ? 0 : heldB)));
  return { code: 0, stdout: '', stderr: '' };
};

// A temp home with the Orchard workstream; prepare() makes a fresh prepared send of both threads in it.
export async function orchard(prefix, outA, { heldB = 1 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(dir, 'workstreams.json'), JSON.stringify([{ name: 'Orchard', kind: 'other', goal: null, domains: [], words: [] }]));
  const workstreamDirectory = join(dir, 'work', 'orchard');
  const runner = runnerFor(outA, heldB);
  const prepare = () => prepareNextMove({ home: dir, workstream: 'Orchard', workstreamDirectory, transcriber: TRANSCRIBER, runner,
    threads: [{ id: 'thread-a', md: THREAD_MD, source: 'gmail' }, { id: 'thread-b', md: '# Barn paint\n', source: 'gmail' }] });
  return { dir, prepare, workstreamDirectory, core: storeCore({ projectId: (n) => `proj_${n}` }) };
}

// A request built directly, for checkMove alone: both threads, the whose-move fact f1 and any more facts.
export const orchardRequest = (outA, { slots = [], facts = [], ...rest } = {}) => buildRequest({ stream: { stream_id: 'orchard', name: 'Orchard', goal: null, people: [] },
  threads: [{ thread_id: 'thread-a', ...parseOutbound(outA) }, { thread_id: 'thread-b', ...parseOutbound(OUT_B) }],
  facts: [{ id: 'f1', kind: 'whose_move', thread_id: 'thread-a', value: 'yours', text: 'Quill Ashe wrote last in "Re: Orchard tour", so it is your move.' }, ...facts], slots, ...rest });
