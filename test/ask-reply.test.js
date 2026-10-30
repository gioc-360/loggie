// An email from the ask box (loggie-ask-box increment 5; the thread pick, the draft check and the card-first draft:
// loggie-ask-thread). The real runner, the real task files and the real draft.js openDraft run; only Outlook (the
// reply helper, the compose window) and the cloud AI are fakes. Made-up people.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAsker } from '../src/hikyaku/ask-run.js';
import { openDraft } from '../src/hikyaku/draft.js';
import { typedBody, parseReplyBody, newestFrom, keepsLine, typedSubject } from '../src/hikyaku/ask-reply.js';
import { threadsFrom } from '../src/hikyaku/ask-thread.js';

const entries = [
  { name: 'Jamie Park', kind: 'person', app: 'outlook', email: 'jamie@acmebank.example', last: '2026-10-11T07:00:00Z' },
  { name: 'Jamie Park', kind: 'person', app: 'messages', chatId: '4', address: '+13235550100', isGroup: false, last: '2026-10-01T09:00:00Z' },
  { name: 'Yuki Sato', kind: 'person', app: 'whatsapp', chatId: '12', address: null, isGroup: false, last: '2026-10-11T09:00:00Z' },
  { name: 'Dana Wu', kind: 'person', app: 'outlook', email: 'dana@example.org', last: '2026-10-05T07:00:00Z' },
  { name: 'Rosa Kim', kind: 'person', app: 'outlook', email: 'rk@school.example', last: '2026-10-11T22:07:05Z' },
];
const mail = [
  { from: 'Jamie Park <jamie@acmebank.example>', subject: 'Offer call notes', timestamp: '2026-10-11T07:00:00.000Z', body: 'Hi, does Thursday work for the offer call?' },
  { from: 'Jamie Park <jamie@acmebank.example>', subject: 'Older', timestamp: '2026-10-02T07:00:00.000Z', body: 'old' },
  // The 2026-10-12 shape: the newest email went to someone else with the user on Cc; the one he meant came earlier.
  { id: 'apple-mail-30', from: 'Rosa Kim <rk@school.example>', to: 'alex@school.example', cc: 'me@school.example', subject: 'Re: Presentation date - conflict on Nov 19', timestamp: '2026-10-11T22:07:05.000Z', body: 'I will assign your presentation on one of the dates you propose.' },
  { id: 'apple-mail-20', from: 'Rosa Kim <rk@school.example>', to: 'me@school.example', cc: '', subject: 'Re: Request to attend remotely (travel)', timestamp: '2026-10-06T07:06:44.000Z', body: 'If you need extra time with our assignment, please let me know.' },
].map((m, i) => ({ id: `apple-mail-${i + 1}`, to: 'me@school.example', cc: '', ...m }));

async function setup({ consent = false, cloudAnswer = '{"body": "Hi Jamie,\\n\\nThursday works for me. I will send the deck right after.\\n\\nBest,\\nGio"}', helper = 'replied' } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ask-reply-'));
  await writeFile(join(home, 'settings.json'), JSON.stringify({ mailApp: 'outlook', signName: 'Gio' }));
  const seen = { prompts: [], helper: [], always: 0, chats: [], spawned: [], events: [] };
  const asker = createAsker({
    emit: (kind, data) => seen.events.push([kind, data]),
    home, loadIndex: async () => entries,
    openChat: async ({ reply, body }) => { seen.chats.push({ reply, body }); return { opened: reply.app, mode: 'chat', status: 'drafted' }; },
    email: {
      threads: async (address) => threadsFrom(mail, address, ['me@school.example']),
      consent: async () => consent,
      allowAlways: async () => { seen.always++; },
      complete: async (prompt) => { seen.prompts.push(prompt); return cloudAnswer; },
      settings: async () => ({ signName: 'Gio', account: 'me@school.example' }),
      openDraft: ({ taskDirectory }) => { seen.events.push(['openDraft']); return openDraft({ taskDirectory, home, spawnImpl: (command, args) => { seen.spawned.push([command, ...args]); return { unref() {} }; }, replyImpl: async (input) => { seen.helper.push({ ...input, body: input.body }); return helper === 'replied' ? { status: 'replied', detail: 'Reply opened.', pasted: true, findings: [] } : { status: helper }; }, clipboardImpl: async () => {} }); },
    },
  });
  return { home, asker, seen };
}

test('without a yes, an email reply is a question and nothing is read by the cloud or opened', async () => {
  const { asker, seen } = await setup();
  const result = await asker.run('reply to jamie: thursday works, sending the deck after').done;
  assert.equal(result.outcome, 'question');
  assert.equal(result.status, 'needs-yes');
  assert.match(result.lines[0], /the one email from Jamie Park you are answering, and your line/);
  assert.equal(seen.prompts.length + seen.helper.length, 0);
});

test('"this time": the cloud AI writes from the line and the email, and the reply opens in Outlook on Jamie\'s email, unsent', async () => {
  const { asker, seen, home } = await setup();
  const result = await asker.run('reply to jamie: thursday works, sending the deck after', { cloud: 'once' }).done;
  assert.equal(result.outcome, 'placed', JSON.stringify(result));
  assert.equal(result.path, 'cloud');
  assert.equal(seen.prompts.length, 1);
  assert.match(seen.prompts[0], /thursday works, sending the deck after/i);
  assert.match(seen.prompts[0], /does Thursday work for the offer call/);
  assert.equal(seen.helper.length, 1);
  assert.equal(seen.helper[0].original.from, 'jamie@acmebank.example');
  assert.equal(seen.helper[0].original.subject, 'Offer call notes');
  assert.match(seen.helper[0].body, /Thursday works for me/);
  assert.equal(seen.always, 0);
  const draft = await readFile(join(home, 'asks', result.askId, 'DRAFT.md'), 'utf8');
  assert.match(draft, /Thursday works for me/);
});

test('"always" saves the yes once; "my words" sends nothing to the cloud and signs the words as typed', async () => {
  const always = await setup();
  await always.asker.run('reply to jamie: thursday works', { cloud: 'always' }).done;
  assert.equal(always.seen.always, 1);
  const words = await setup();
  const result = await words.asker.run('reply to jamie: thursday works', { cloud: 'words' }).done;
  assert.equal(result.outcome, 'placed');
  assert.equal(result.path, 'code');
  assert.equal(words.seen.prompts.length, 0);
  assert.match(words.seen.helper[0].body, /^Thursday works\.\n\nGio/);
});

test('a saved yes needs no question; a bad cloud answer falls back to the typed words and says so', async () => {
  const { asker, seen } = await setup({ consent: true, cloudAnswer: 'not json at all' });
  const result = await asker.run('reply to jamie: thursday works').done;
  assert.equal(result.outcome, 'placed');
  assert.match(seen.helper[0].body, /^Thursday works\./);
  assert.ok(result.did.some((line) => /did not answer, so your words were used/.test(line)));
});

test('a reply goes where the person wrote last: Yuki on WhatsApp gets the words in the chat, no email, no cloud', async () => {
  const { asker, seen } = await setup();
  const result = await asker.run('reply to yuki saying sounds good').done;
  assert.equal(result.outcome, 'placed');
  assert.equal(seen.chats[0].reply.app, 'whatsapp');
  assert.equal(seen.chats[0].body, 'Sounds good');
  assert.equal(seen.prompts.length + seen.helper.length, 0);
});

test('no thread with them: a new email in Outlook, the subject from the line, no reply helper', async () => {
  const { asker, seen, home } = await setup({ consent: true, cloudAnswer: '{"subject": "Thanks for the notes", "body": "Hi Dana,\\n\\nThanks for the notes.\\n\\nBest,\\nGio"}' });
  const result = await asker.run('email dana: thanks for the notes').done;
  assert.equal(result.outcome, 'placed', JSON.stringify(result));
  assert.equal(seen.helper.length, 0);
  assert.match(seen.prompts[0], /new email/);
  assert.doesNotMatch(seen.prompts[0], /email being answered/);
  const reply = JSON.parse(await readFile(join(home, 'asks', result.askId, 'REPLY.json'), 'utf8'));
  assert.deepEqual([reply.to, reply.subject, reply.fresh, reply.original], ['dana@example.org', 'Thanks for the notes', true, undefined]);
  assert.match(seen.spawned.at(-1).join(' '), /mailto:dana%40example\.org\?subject=Thanks%20for%20the%20notes/);
  assert.equal(result.results[0].detail, '', 'a new email the user meant gives no fallback reason');
  assert.ok(result.did.some((line) => /A new email to Dana Wu: no email with them in 60 days/.test(line)));
});

test('the Cc-only newest is passed over: the reply goes on the thread sent to the user', async () => {
  const { asker, seen } = await setup({ consent: true, cloudAnswer: '{"body": "Hi Rosa,\\n\\nI am sending my assignment 2 now.\\n\\nBest,\\nGio"}' });
  const result = await asker.run('email rosa sending my assignment 2.').done;
  assert.equal(result.outcome, 'placed', JSON.stringify(result));
  assert.equal(seen.helper[0].original.subject, 'Re: Request to attend remotely (travel)');
  assert.match(seen.prompts[0], /extra time with our assignment/);
  assert.doesNotMatch(seen.prompts[0], /assign your presentation/);
  assert.equal(result.results[0].thread.how, 'not-cc');
  assert.ok(result.did.some((line) => /Answering "Request to attend remotely \(travel\)".*a newer one only copied you/.test(line)), result.did.join('\n'));
});

test('the user\'s pick from the box wins: another thread by id, or a new email', async () => {
  const picked = await setup({ consent: true, cloudAnswer: '{"body": "Hi Rosa,\\n\\nSending my assignment 2.\\n\\nGio"}' });
  const result = await picked.asker.run('email rosa sending my assignment 2.', { choices: { '@thread': 'apple-mail-30' } }).done;
  assert.equal(picked.seen.helper[0].original.subject, 'Re: Presentation date - conflict on Nov 19');
  assert.equal(result.results[0].thread.how, 'chosen');
  const fresh = await setup({ consent: true, cloudAnswer: '{"subject": "Assignment 2", "body": "Hi Rosa,\\n\\nSending my assignment 2.\\n\\nGio"}' });
  const made = await fresh.asker.run('email rosa sending my assignment 2.', { choices: { '@thread': 'new' } }).done;
  assert.equal(made.outcome, 'placed');
  assert.equal(fresh.seen.helper.length, 0);
  assert.match(fresh.seen.spawned.at(-1).join(' '), /subject=Assignment%202/);
});

test('a cloud draft that drops the line is not used: the words go as typed, and the card is told why', async () => {
  const { asker, seen } = await setup({ consent: true, cloudAnswer: '{"body": "Got it.\\n\\nBest,\\nGio"}' });
  const result = await asker.run('email rosa sending my assignment 2.').done;
  assert.equal(result.outcome, 'placed');
  assert.match(seen.helper[0].body, /^Sending my assignment 2\./);
  assert.equal(result.results[0].drafted, 'words-after-ai-dropped-line');
  assert.ok(result.did.some((line) => /left out what your line says/.test(line)));
});

test('card first: the draft is emitted before Outlook is asked to place it', async () => {
  const { asker, seen } = await setup({ consent: true });
  await asker.run('reply to jamie: thursday works, sending the deck after').done;
  const order = seen.events.map(([kind]) => kind).filter((kind) => kind === 'draft' || kind === 'openDraft');
  assert.deepEqual(order, ['draft', 'openDraft']);
  const draft = seen.events.find(([kind]) => kind === 'draft')[1];
  assert.equal(draft.to, 'Jamie Park');
  assert.equal(draft.thread.subject, 'Offer call notes');
  assert.match(draft.body, /Thursday works for me/);
  assert.equal(typeof draft.ms, 'number', 'the card delay is measured');
});

test('the box preview shows the thread an email will answer, with the others to switch to', async () => {
  const { asker } = await setup({ consent: true });
  const preview = await asker.preview('email rosa sending my assignment 2.');
  assert.equal(preview.thread.subject, 'Request to attend remotely (travel)');
  assert.equal(preview.thread.how, 'not-cc');
  assert.deepEqual(preview.thread.others.map((t) => t.subject), ['Presentation date - conflict on Nov 19']);
  assert.equal(preview.thread.target, undefined, 'no bodies cross to the box');
});

test('the freshness guard is passed only for a later email in a thread the ask weighed; anything else still stops it', async () => {
  const run = async (newer) => {
    const opens = [];
    const asker = createAsker({
      home: await mkdtemp(join(tmpdir(), 'ask-stale-')), loadIndex: async () => entries, openChat: async () => ({}),
      email: {
        threads: async (address) => threadsFrom(mail, address, ['me@school.example']), consent: async () => true, allowAlways: async () => {},
        complete: async () => '{"body": "Hi Rosa,\\n\\nSending my assignment 2.\\n\\nGio"}', settings: async () => ({ signName: 'Gio', account: 'me@school.example' }),
        openDraft: async ({ staleOk = false }) => { opens.push(staleOk); return staleOk ? { opened: 'outlook', mode: 'reply', to: 'rk@school.example' } : { opened: 'none', mode: 'stale', reason: 'Rosa Kim wrote again after the email this draft answers.', newer }; },
      },
    });
    return { result: await asker.run('email rosa sending my assignment 2.').done, opens };
  };
  const passed = await run({ direction: 'from-person', subject: 'Re: Presentation date - conflict on Nov 19', who: 'Rosa Kim' });
  assert.equal(passed.result.outcome, 'placed');
  assert.deepEqual(passed.opens, [false, true]);
  assert.ok(passed.result.did.some((line) => /wrote later in "Presentation date - conflict on Nov 19", a thread this ask weighed/.test(line)));
  const unseen = await run({ direction: 'from-person', subject: 'Re: Something new', who: 'Rosa Kim' });
  assert.notEqual(unseen.result.outcome, 'placed');
  assert.deepEqual(unseen.opens, [false]);
  const mine = await run({ direction: 'from-me', subject: 'Re: Presentation date - conflict on Nov 19', who: 'Rosa Kim' });
  assert.deepEqual(mine.opens, [false], 'the user\'s own later mail still stops it');
});

test('an Outlook failure and two names each say so plainly', async () => {
  const { asker } = await setup({ consent: true });
  const failing = await setup({ consent: true, helper: 'no-match' });
  const failed = await failing.asker.run('reply to jamie: thursday works').done;
  assert.notEqual(failed.outcome, 'placed');
  const two = await (await setup()).asker.run('reply to jamie and yuki: ok').done;
  assert.equal(two.outcome, 'question');
  assert.match(two.lines[0], /one person at a time/);
});

test('several people by email are one new email to all of them, never a reply in one person\'s thread', async () => {
  const { asker, seen, home } = await setup({ consent: true, cloudAnswer: '{"subject": "Invoice copy", "body": "Hi all,\\n\\nHere is the invoice copy.\\n\\nBest,\\nGio"}' });
  const preview = await asker.preview('email jamie, dana about the invoice copy');
  assert.equal(preview.status, 'ready', preview.line);
  assert.equal(preview.thread.how, 'many');
  assert.equal(preview.thread.id, null, 'no one person\'s thread is shown');
  assert.match(preview.line, /one email to all/);
  const result = await asker.run('email jamie, dana about the invoice copy').done;
  assert.equal(result.outcome, 'placed', JSON.stringify(result));
  assert.equal(seen.helper.length, 0, 'no Reply pressed on anyone\'s email');
  assert.match(seen.prompts[0], /goes to Jamie Park, Dana Wu together/);
  const reply = JSON.parse(await readFile(join(home, 'asks', result.askId, 'REPLY.json'), 'utf8'));
  assert.equal(reply.to, 'jamie@acmebank.example, dana@example.org');
  const url = seen.spawned[0].at(-1);
  assert.match(url, /^mailto:jamie%40acmebank\.example,dana%40example\.org\?/);
  assert.equal(result.results[0].to, 'Jamie Park, Dana Wu');
});

test('helpers: typed words are capitalized, end with a stop and are signed; a cloud answer must be JSON with a body', () => {
  assert.equal(typedBody('thursday works', 'Gio'), 'Thursday works.\n\nGio');
  assert.equal(typedBody('see you then!', ''), 'See you then!');
  assert.equal(parseReplyBody('{"body": "Hi"}'), 'Hi');
  assert.equal(parseReplyBody('{"body": ""}'), null);
  assert.equal(parseReplyBody('nope'), null);
  assert.equal(newestFrom(mail, 'jamie@acmebank.example').subject, 'Offer call notes');
  assert.equal(keepsLine('sending my assignment 2.', 'Got it.\n\nBest,\nGio'), false);
  assert.equal(keepsLine('sending my assignment 2.', 'Here is assignment 12.'), false, 'the number must be the same number');
  assert.equal(keepsLine('sending my assignment 2.', 'Hi Rosa, attached is my Assignment 2. Thank you for the extra time.'), true);
  assert.equal(keepsLine('ok', 'Sounds good.'), true);
  assert.equal(keepsLine('can i get 2 more days', 'I would like two more days.'), true, 'a number may come back as its word');
  assert.equal(keepsLine('can i get 2 more days', 'I would like three more days.'), false);
  assert.equal(typedSubject('sending my assignment 2. notes attached'), 'Sending my assignment 2');
});

// 2026-10-17: "Can we set up a $500 bar tab for our Oct 22 karaoke event?" came back as "Hi K-HOUSE Karaoke, I am asking
// if we can set up...": the model saw only "We will send it shortly." and none of the user's emails. Made-up venue.
test('the reply prompt carries the whole thread, the user\'s own emails to the person, and keeps a question a question', async () => {
  const { replyPrompt, threadFor, examplesBlock } = await import('../src/hikyaku/ask-reply.js');
  const { threadMessages } = await import('../src/hikyaku/freshness.js');
  const target = { id: 'apple-mail-9', from: 'Tune Room <hello@tuneroom.example>', subject: 'Re: Room for Oct 22', timestamp: '2026-10-08T00:23:17.000Z', body: 'We will send it shortly.' };
  const history = [
    { id: 'apple-mail-7', from: 'Tune Room <hello@tuneroom.example>', subject: 'Re: Room for Oct 22', timestamp: '2026-10-06T19:55:00.000Z', body: 'The available time would be 6:30-9pm.' },
    { id: 'apple-mail-8', fromMe: true, subject: 'Re: Room for Oct 22', timestamp: '2026-10-06T22:55:00.000Z', body: 'Ok, 630 to 9pm sounds good. We will take that slot.' },
  ];
  const thread = threadFor(target, 'hello@tuneroom.example', { history, own: 'me@school.example', ownName: 'Gio' });
  assert.deepEqual(threadMessages(thread).map((m) => m.from), ['hello@tuneroom.example', 'me@school.example', 'hello@tuneroom.example'], 'oldest first, the answered email last, the user named by address');
  const examples = [{ body: 'Hello,\n\nFollowing up on this. Could we get the deposit form?\n\nBest,\nGio' }];
  const prompt = replyPrompt({ thread, line: 'Can we set up a $500 bar tab for our Oct 22 karaoke event?', signName: 'Gio', examples });
  assert.match(prompt, /630 to 9pm sounds good/);
  assert.match(prompt, /Following up on this\. Could we get the deposit form\?/);
  assert.match(prompt, /A question stays a question/);
  assert.doesNotMatch(prompt, /Never wrap/, 'no phrase is banned: the user\'s own emails set the register');
  assert.doesNotMatch(prompt, /as complete sentences with their subject \("I am sending you…", never "Sending…"\)/, 'the old rule that made every point an "I am" sentence is gone');
  assert.ok(prompt.indexOf('630 to 9pm') < prompt.indexOf('We will send it shortly'), 'the answered email comes last');
  assert.equal(examplesBlock([]), '');
});

test('the runner hands the user\'s own emails to the reply: their side of the thread and how they write to the person', async () => {
  const sent = [{ id: 'apple-mail-50', subject: 'Re: Offer call notes', timestamp: '2026-10-10T07:00:00.000Z', to: ['jamie@acmebank.example'], body: 'Hey Jamie,\n\nCan we do the call after 3?\n\nGio' }];
  // The real runner with fakes for Outlook and the cloud AI, plus sent(): one prompt, carrying both.
  const home = await mkdtemp(join(tmpdir(), 'ask-reply-sent-'));
  await writeFile(join(home, 'settings.json'), JSON.stringify({ mailApp: 'outlook', signName: 'Gio' }));
  const prompts = [];
  const runner = createAsker({ home, loadIndex: async () => entries, openChat: async () => ({}),
    email: { threads: async (address) => threadsFrom(mail, address, ['me@school.example']), consent: async () => true, allowAlways: async () => {},
      complete: async (prompt) => { prompts.push(prompt); return '{"body": "Hey Jamie,\\n\\nThursday works.\\n\\nBest,\\nGio"}'; },
      settings: async () => ({ signName: 'Gio', account: 'me@school.example' }), sent: async () => sent,
      openDraft: async () => ({ opened: 'outlook', mode: 'reply' }) } });
  const result = await runner.run('reply to jamie: thursday works').done;
  assert.equal(result.outcome, 'placed', JSON.stringify(result));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /How the user writes to this person[\s\S]*Can we do the call after 3\?/);
  assert.match(prompts[0], /## Gio <me@school\.example> · 2026-10-10T07:00:00\.000Z[\s\S]*Can we do the call after 3\?[\s\S]*does Thursday work for the offer call/);
});

test('code picks the greeting rule: the user\'s own greeting when their emails to the person are there, else the defaults', async () => {
  const { greetingRule, replyPrompt } = await import('../src/hikyaku/ask-reply.js');
  assert.match(greetingRule([{ body: 'Hey Sam,\n\nSounds good.' }]), /the way the user greets this person/);
  assert.match(greetingRule([]), /Professor <last name>/);
  assert.match(greetingRule([{ body: '  ' }]), /Professor <last name>/, 'an empty body is not an example');
  const prompt = replyPrompt({ thread: '# T\n\n## A <a@x.example> · 2026-10-01T00:00:00Z\n\nhi\n', line: 'ok', examples: [] });
  assert.doesNotMatch(prompt, /How the user writes to this person/);
  assert.doesNotMatch(prompt, /the way the user greets this person/);
});

// ---- availability (loggie-availability I1, spec test 1.6): the calendar stays on the Mac ----
// The two prompts as 48cdf3e built them for these inputs, saved here: with times false they must not change at all.
const SAVED_48CDF3E = { reply: "Write the body of an email reply for the user. Plain text, no subject line, no quoted email.\n\nThe user's note: \"Of my availability on friday\"\n\nThe user typed a quick note of what to say. Turn it into the email they would send, written the way they write.\n\nGreet the way the user greets this person in their own emails shown below: the same greeting word and their first name only (never a last name), or no name if they used none.\n\nKeep the note's own words and sentence shape. A question stays a question (\"can i get 2 more days\" becomes \"Can I get 2 more days?\", never \"I can get...\"). Finish what is unfinished into a full sentence, adding only the small words it needs: \"sending my assignment\" becomes \"I am sending you my assignment\", \"yes sunday 2pm library\" becomes \"Yes, Sunday at 2pm at the library works.\" Fix capitals and punctuation.\n\nKeep every point and fact of the note, numbers exactly. Never answer with only an acknowledgment.\n\nThe note often answers the email's questions: read it against them (\"3 works\" after \"are we meeting at 3?\" means 3 o'clock works).\n\nThe thread is there to understand the note, not to repeat it. Add no reasons, context, facts, dates, promises, apologies or questions the note does not give, even ones the thread holds. One short thanks is fine when the email offered help.\n\nEnd with \"Best,\" and the name Gio on the next line.\n\nHow the user writes to this person (their own emails, newest first; copy the greeting and the tone, never the content):\n---\nHi Sam, thanks!\n---\n\nThe user's writing rules:\nShort sentences.\n\nThe thread being answered, oldest first; the reply answers the last email:\n# Coffee\n\n## Sam Lee <sam@example.com> \u00b7 2026-10-20T14:29:10.000Z\n\nCan you share a couple of time slots that work for you on Friday?\n\n\nAnswer with JSON only: {\"body\": \"<the reply>\"}", fresh: "Write a short new email for the user: a subject line and a plain-text body.\n\nThe user's note: \"My availability friday\"\n\nThe user typed a quick note of what to say. Turn it into the email they would send, written the way they write.\n\nGreet with \"Hi <first name>,\": the way the user greets people, and the person's first name only, never a last name and never the way the sender addressed the user. A professor or teacher (their signature or title says Professor, Lecturer or Dr., or they write about the user's class, assignment, extension or grade): \"Professor <last name>,\". A company, venue or office writing as itself (no person's name in its From line): \"Hi,\".\n\nKeep the note's own words and sentence shape. A question stays a question (\"can i get 2 more days\" becomes \"Can I get 2 more days?\", never \"I can get...\"). Finish what is unfinished into a full sentence, adding only the small words it needs: \"sending my assignment\" becomes \"I am sending you my assignment\", \"yes sunday 2pm library\" becomes \"Yes, Sunday at 2pm at the library works.\" Fix capitals and punctuation.\n\nKeep every point and fact of the note, numbers exactly. Never answer with only an acknowledgment.\n\nThe note often answers the email's questions: read it against them (\"3 works\" after \"are we meeting at 3?\" means 3 o'clock works).\n\nThe thread is there to understand the note, not to repeat it. Add no reasons, context, facts, dates, promises, apologies or questions the note does not give, even ones the thread holds. One short thanks is fine when the email offered help.\n\nEnd with a short sign-off.\n\nAnswer with JSON only: {\"subject\": \"<under 8 words>\", \"body\": \"<the email>\"}" };
const SAVED_INPUTS = {
  reply: { thread: '# Coffee\n\n## Sam Lee <sam@example.com> · 2026-10-20T14:29:10.000Z\n\nCan you share a couple of time slots that work for you on Friday?\n', line: 'Of my availability on friday', rules: 'Short sentences.', signName: 'Gio', examples: [{ body: 'Hi Sam, thanks!' }] },
  fresh: { line: 'My availability friday', rules: '', signName: '', examples: [] },
};

test('1.6 without times the prompts equal 48cdf3e\'s but for the greeting rule (loggie-reply-yes: the user\'s word, first name only); with times they add TIMES_RULE after the FINISH rules and nothing of the calendar', async () => {
  const { replyPrompt, newEmailPrompt, prepareEmailReply } = await import('../src/hikyaku/ask-reply.js');
  const { TIMES_RULE } = await import('../src/hikyaku/availability.js');
  assert.equal(replyPrompt(SAVED_INPUTS.reply), SAVED_48CDF3E.reply);
  assert.equal(newEmailPrompt(SAVED_INPUTS.fresh), SAVED_48CDF3E.fresh);
  assert.equal(replyPrompt({ ...SAVED_INPUTS.reply, times: false }), SAVED_48CDF3E.reply);
  for (const prompt of [replyPrompt({ ...SAVED_INPUTS.reply, times: true }), newEmailPrompt({ ...SAVED_INPUTS.fresh, times: true })]) {
    assert.ok(prompt.includes(TIMES_RULE));
    assert.ok(prompt.indexOf(TIMES_RULE) > prompt.indexOf('One short thanks is fine'), 'after the FINISH rules');
    // The thread's own header stamp (the email's time, 14:29:10) is the only clock in it, as at 48cdf3e.
    assert.doesNotMatch(prompt.replace(SAVED_INPUTS.reply.thread, ''), /\d:\d\d/);
  }
  // The real path: the prompt prepareEmailReply sends while F1's calendar is read holds no time, title, calendar or account.
  const events = [
    { start: '2026-10-23T15:15:00Z', end: '2026-10-23T16:30:00Z', title: 'Strategy class', calendar: 'MBA I', account: 'Exchange', attendees: [] },
    { start: '2026-10-23T20:30:00Z', end: '2026-10-23T20:55:00Z', title: 'Coffee chat', calendar: 'Work', account: 'iCloud', attendees: ['person@example.com'] },
  ];
  const availability = Promise.resolve({ read: 'read', reason: null, window: { days: ['2026-10-23'], startMinute: 540, endMinute: 1020, minutes: 30, timeZone: 'America/New_York', notice: 60, from: { days: 'typed', hours: 'settings', minutes: 'settings' }, stale: false },
    rules: { selfBlocks: true, minMinutes: 30 }, days: [{ day: '2026-10-23', ranges: [{ start: '2026-10-23T13:00:00.000Z', end: '2026-10-23T15:15:00.000Z' }] }], text: 'Fri Oct 23: 9 to 11:15am ET', ms: 1 });
  const prompts = [];
  const taskDirectory = await mkdtemp(join(tmpdir(), 'ask-reply-times-'));
  const out = await prepareEmailReply({ taskDirectory, message: null, email: 'sam@example.com', account: 'me@school.example', line: 'Of my availability on friday', typed: 'email sam of my availability on friday', cloud: 'ai', complete: async (prompt) => { prompts.push(prompt); return JSON.stringify({ subject: 'Friday', body: 'Hi Sam,\n\nHere are times that work for me:\n[your times]\n\nBest,' }); }, asked: 'typed', availability });
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes(TIMES_RULE));
  for (const word of ['11:15', '9 to', 'Strategy class', 'Coffee chat', 'MBA I', 'iCloud', 'Exchange', 'person@example.com', 'Oct 23', '2026-10-23']) assert.ok(!prompts[0].includes(word), word);
  assert.equal(out.body, 'Hi Sam,\n\nHere are times that work for me:\nFri Oct 23: 9 to 11:15am ET\n\nBest,');
  assert.equal(out.how, 'ai');
});

test('1.6 keepsLine with skip keeps "Here are times that work for me:" for "Of my availability on friday"', async () => {
  const { lineSkip } = await import('../src/hikyaku/availability.js');
  const body = 'Hi Rowena,\n\nHere are times that work for me:\n[your times]\n\nBest,';
  assert.equal(keepsLine('Of my availability on friday', body), false, 'without skip the draft would fall back to the typed words');
  assert.deepEqual(lineSkip('Of my availability on friday').sort(), ['availability', 'friday']);
  assert.equal(keepsLine('Of my availability on friday', body, { skip: lineSkip('Of my availability on friday') }), true);
  assert.equal(keepsLine('my availability friday afternoon for 15 minutes, sending the deck', 'Here are my times. The deck is attached.', { skip: lineSkip('my availability friday afternoon for 15 minutes, sending the deck') }), true, 'the cue, day, part of day and length are left out; the rest still counts');
  assert.equal(keepsLine('my availability friday, sending the deck', 'Here are my times.', { skip: lineSkip('my availability friday, sending the deck') }), false, 'a point of the line still has to be there');
});
