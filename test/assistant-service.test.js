import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantService } from '../desktop/assistant-service.js';
function fixture(actions, overrides = {}) {
  const prompts = [], calendars = [];
  const service = createAssistantService({ completeForRequest: async () => async prompt => { prompts.push(prompt); return JSON.stringify(actions.shift()); }, listEvents: async range => { calendars.push(range); return [{ id: 'event', title: 'Product sync', start: '2026-10-10T14:00:00Z', end: '2026-10-10T15:00:00Z', calendar: 'Work' }]; }, now: () => new Date('2026-10-09T12:00:00Z'), timeZone: 'America/New_York', ...overrides });
  return { service, prompts, calendars };
}
test('upcoming meeting questions read the calendar rather than creating invitations', async () => {
  const f = fixture([{ tool: 'calendar_list', from: '2026-10-09T12:00:00Z', days: 7 }, { tool: 'answer', answer: 'Product sync is tomorrow. [C1]', citations: ['C1'] }]);
  const result = await f.service.ask("What's my upcoming meeting?"); assert.equal(f.calendars.length, 1); assert.equal(result.sources[0].title, 'Product sync'); assert.match(f.prompts[1], /America\/New_York/);
});
// 2026-10-28 (teammates' mail fix 5): the Gmail search left with the Gmail sign-in. A model asking for it is refused,
// and the prompt offers no email tool, so nothing claims to have read mail.
test('the Gmail search is gone: the prompt offers no email tool, and asking for one is not supported', async () => {
  const f = fixture([{ tool: 'calendar_list', days: 7 }, { tool: 'answer', answer: 'Approve $200.', citations: ['C1'] }, { tool: 'answer', answer: 'Do the sync first.', citations: ['C1'] }]);
  assert.equal((await f.service.ask('Prepare me for the sync')).sources.length, 1);
  assert.equal((await f.service.ask('What should I do first?')).sources[0].id, 'C1'); assert.match(f.prompts.at(-1), /Prepare me for the sync/);
  assert.doesNotMatch(f.prompts[0], /gmail_search/);
  assert.match(f.prompts[0], /Email cannot be searched here/);
  await assert.rejects(fixture([{ tool: 'gmail_search', query: 'is:unread' }]).service.ask('What needs a reply?'), /not supported/);
});
test('denied calendar access is distinct from no events', async () => {
  const f = fixture([{ tool: 'calendar_list', days: 7 }, { tool: 'answer', answer: 'Allow Calendar access first.', citations: [] }], { listEvents: async () => { throw new Error('denied'); } });
  await f.service.ask('Am I free tomorrow?'); assert.match(f.prompts[1], /Calendar access failed/);
});
test('no cloud consent returns setup before reading data', async () => {
  const f = fixture([], { completeForRequest: async () => null }); assert.equal((await f.service.ask('Summarize my week')).status, 'setup_needed'); assert.equal(f.calendars.length, 0);
});
test('rejects unsupported tool execution and malformed model responses', async () => {
  await assert.rejects(fixture([{ tool: 'delete_email' }]).service.ask('Delete mail'), /not supported/);
  await assert.rejects(fixture([null]).service.ask('Hello'), /unreadable/);
  await assert.rejects(fixture([{ tool: 'calendar_list', days: 900 }]).service.ask('My meetings'), /invalid calendar range/);
});
test('caps repeated retrieval and always releases the busy state', async () => {
  const f = fixture(Array.from({ length: 12 }, () => ({ tool: 'calendar_list', days: 7 })));
  assert.equal((await f.service.ask('All meetings')).status, 'clarify'); assert.equal(f.calendars.length, 2);
  await f.service.ask('Retry'); assert.equal(f.calendars.length, 4);
});

test('exact addresses stay on this Mac rather than being sent in the user request', async () => {
  const f = fixture([{ tool: 'answer', answer: 'No meeting with them this week.', citations: [] }]);
  await f.service.ask('Do I meet sarah@example.com this week?');
  assert.ok(!f.prompts[0].includes('sarah@example.com')); assert.match(f.prompts[0], /LOGGIE_ADDRESS_1/);
});

// In the ask box (2026-10-12): a question code cannot read goes to the assistant after a yes; other sentences do not.
test('the ask box sends a question to the assistant only with a yes, and other sentences keep their path', async () => {
  const { createAsker, QUESTION } = await import('../src/hikyaku/ask-run.js');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = await mkdtemp(join(tmpdir(), 'assistant-box-'));
  const asked = [];
  let yes = false;
  const done = [];
  const asker = createAsker({ home, loadIndex: async () => [], openChat: async () => ({}), emit: (kind, data) => { if (kind === 'done') done.push(data); },
    assistant: { consent: async () => yes, allowAlways: async () => { yes = true; }, ask: async (text, options) => { asked.push([text, options]); return { status: 'answered', message: 'Product sync is tomorrow.', sources: [{ id: 'C1', kind: 'calendar', title: 'Product sync', start: '2026-10-13T15:00:00Z' }] }; } } });
  const wait = async (n) => { for (let i = 0; i < 100 && done.length < n; i++) await new Promise((r) => setTimeout(r, 10)); };
  await asker.run("what's on my calendar thursday?"); await wait(1);
  assert.equal(done[0].status, 'needs-yes'); assert.equal(done[0].yesFor, 'question'); assert.equal(asked.length, 0, 'nothing is read before the yes');
  await asker.run("what's on my calendar thursday?", { cloud: 'once' }); await wait(2);
  assert.equal(done[1].outcome, 'answered'); assert.equal(done[1].sources[0].title, 'Product sync'); assert.deepEqual(asked[0][1], { once: true });
  await asker.run("what's on my calendar thursday?", { cloud: 'always' }); await wait(3);
  assert.equal(yes, true, 'Always saves the yes');
  assert.ok(!QUESTION.test('lena running late') && QUESTION.test('did the recruiter reply'));
});

// A calendar question with no invite word is a question, not an invite (2026-10-12: "what meetings do I have
// tomorrow?" read as an invite and never reached the assistant).
test('a question about meetings is not an invite unless it says invite, schedule, meet, book or set up', async () => {
  const { readAsk } = await import('../src/hikyaku/ask.js');
  const action = (text) => readAsk(text, { names: ['Lena Park', 'Sam Lee'] }).action;
  assert.equal(action('what meetings do I have tomorrow?'), 'unknown');
  assert.equal(action('when is my next meeting?'), 'unknown');
  assert.equal(action('invite lena tomorrow at 3'), 'invite');
  assert.equal(action('lunch with sam friday'), 'invite');
  assert.equal(action('can we meet lena thursday?'), 'invite');
});
