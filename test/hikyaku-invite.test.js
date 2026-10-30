import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inviteBody, invite, inviteDefaults, nextMeetingCandidate, parseWhen, rememberPlace, skipNextMeeting, summarySections, validateInviteFields } from '../src/hikyaku/invite.js';
import { inviteResultLine, nextMeetingCard } from '../desktop/renderer/meeting-cards.js';

const SUMMARY = `# Team call

_summary by a model; hikyaku checked it._

## Pricing
- Owners pay fees on revenue to Marriott (unclear) [03:12]
- Loyalty is half the rooms [14:44] (not sure)

## Next Steps
- Build the slide template (Gio) [38:11]
`;

test('the summary becomes notes and action items: minute stamps go, "not sure" stays as words', () => {
  const { notes, actions } = summarySections(SUMMARY);
  assert.deepEqual(actions, ['Build the slide template (Gio)']);
  assert.deepEqual(notes, [{ heading: 'Pricing', bullets: ['Owners pay fees on revenue to Marriott(?)', 'Loyalty is half the rooms (to check)'] }]);
});

test('the body puts action items first, escapes text, and signs with the user\'s name', () => {
  const { html } = inviteBody({ summary: SUMMARY.replace('Owners', 'Owners <b>&'), event: { start: '2026-10-07T21:30:00Z' }, signName: 'Gio' });
  assert.ok(html.indexOf('Action items') < html.indexOf('Pricing'));
  assert.match(html, /Wednesday, Oct 7/);
  assert.match(html, /Owners &lt;b&gt;&amp;/);
  assert.match(html, /<div>Gio<\/div>$/);
});

test('the time is the user\'s wall clock; a wrong or overlong end is refused', () => {
  const when = parseWhen('2026-10-14T17:30', '18:20');
  assert.equal(when.minutes, 50);
  assert.equal(when.end, '18:20');
  assert.equal(when.start.getHours(), 17);
  assert.throws(() => parseWhen('2026-10-14 17:30', '18:20'), /Usage/);
  assert.throws(() => parseWhen('2026-10-14T17:30', '17:35'), /15 minutes to 4 hours/);
});

test('invite opens Outlook with the call\'s people and hands the helper the end, body, room and floors; it never sends', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'loggie-invite-'));
  await writeFile(join(folder, 'event.json'), JSON.stringify({ title: 'Hilton Hackathon: readouts', start: '2026-10-07T21:30:00Z', emails: ['a@x.edu', 'b@x.edu'] }));
  await writeFile(join(folder, 'summary-nebius.md'), SUMMARY);
  await writeFile(join(folder, 'summary-runs.json'), JSON.stringify([{ provider: 'nebius', output: join(folder, 'summary-nebius.md'), checks: [] }]));
  const opened = [], ran = [];
  const result = await invite({ folder, start: '2026-10-14T17:30', end: '18:20', room: 'Breazzano', floors: '23', helper: '/bin/helper', wait: async () => {},
    spawnImpl: (command, args) => { opened.push([command, ...args]); return { unref() {} }; },
    execImpl: async (binary, args) => { ran.push([binary, ...args]); return { stdout: JSON.stringify({ status: 'ready', room_picked: 'Breazzano (Breakout) 214' }) }; } });
  assert.match(opened[0][1], /^ms-outlook:\/\/events\/new\?title=Hilton%20Hackathon%3A%20next%20meeting&start=2026-10-14T17%3A30%3A00&attendees=a%40x.edu,b%40x.edu$/);
  assert.deepEqual(ran[0].slice(0, 8), ['/bin/helper', 'fill', '--subject', 'Hilton Hackathon: next meeting', '--end', '18:20', '--body-file', join(folder, 'invite-body.html')]);
  assert.ok(ran[0].includes('--room-query') && ran[0].includes('Breazzano') && ran[0].includes('23'));
  assert.ok(!ran[0].includes('send'));
  assert.match(await readFile(join(folder, 'invite-body.html'), 'utf8'), /Build the slide template \(Gio\)/);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.attendees, ['a@x.edu', 'b@x.edu']);
});

test('no invitees means no invite', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'loggie-invite-'));
  await writeFile(join(folder, 'event.json'), JSON.stringify({ title: 'Solo', emails: [] }));
  await assert.rejects(invite({ folder, start: '2026-10-14T17:30', end: '18:20', helper: '/bin/x', spawnImpl: () => ({}), execImpl: async () => ({ stdout: '{}' }) }), /no one to invite/);
});


test('the fields arrive filled: same weekday next week, same start, 50 minutes, last building', () => {
  const now = new Date(2026, 9, 8, 20, 0);
  assert.deepEqual(inviteDefaults({ start: new Date(2026, 9, 7, 17, 30).toISOString() }, { room: 'Breazzano', floors: '23' }, { now }),
    { date: '2026-10-14', start: '17:30', end: '18:20', room: 'Breazzano', floors: '23' });
  // a call more than a week old moves on to the next week that is still ahead
  assert.equal(inviteDefaults({ start: new Date(2026, 8, 30, 9, 0).toISOString() }, {}, { now }).date, '2026-10-14');
});

test('the card is for the newest recent call with a summary, invitees and no invite yet; Not now and a filled invite end it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'loggie-calls-'));
  const call = async (name, { emails = ['a@x.edu'], summary = true } = {}) => {
    const folder = join(home, name); await mkdir(folder);
    await writeFile(join(folder, 'event.json'), JSON.stringify({ title: name, start: '2026-10-07T21:30:00Z', emails }));
    if (summary) {
      await writeFile(join(folder, 'summary-nebius.md'), SUMMARY);
      await writeFile(join(folder, 'summary-runs.json'), JSON.stringify([{ provider: 'nebius', output: join(folder, 'summary-nebius.md'), checks: [] }]));
    }
  };
  await call('2026-10-07-1733-team-call');
  await call('2026-10-08-0900-no-summary', { summary: false });
  await call('2026-10-08-1000-alone', { emails: [] });
  await call('2026-09-01-1000-old-call');
  const now = new Date(2026, 9, 8, 20, 0);
  const found = await nextMeetingCandidate({ callsHome: home, now });
  assert.equal(found.call, '2026-10-07-1733-team-call');
  assert.equal(found.people, 1);
  await skipNextMeeting({ callsHome: home, call: found.call });
  assert.equal(await nextMeetingCandidate({ callsHome: home, now }), null, 'Not now: the card does not come back, and older calls are not offered');
  await assert.rejects(skipNextMeeting({ callsHome: home, call: '../etc' }), /not a recorded call/);
});

test('the building and floors are remembered without touching other settings', async () => {
  const home = await mkdtemp(join(tmpdir(), 'loggie-settings-'));
  await writeFile(join(home, 'settings.json'), JSON.stringify({ mailApp: 'outlook' }));
  await rememberPlace(home, { room: 'Breazzano', floors: '23' });
  assert.deepEqual(JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')), { mailApp: 'outlook', invitePlace: { room: 'Breazzano', floors: '23' } });
});

test('what the card sends is checked by code', () => {
  const call = '2026-10-07-1733-team-call';
  assert.deepEqual(validateInviteFields(call, { date: '2026-10-14', start: '17:30', end: '18:20', room: ' Breazzano ', floors: '2 or 3' }),
    { call, date: '2026-10-14', start: '17:30', end: '18:20', room: 'Breazzano', floors: '23' });
  assert.throws(() => validateInviteFields('../x', {}), /not a recorded call/);
  assert.throws(() => validateInviteFields(call, { date: '', start: '17:30', end: '18:20' }), /Pick a date/);
  assert.throws(() => validateInviteFields(call, { date: '2026-10-14', start: '17:30', end: '17:35' }), /15 minutes to 4 hours/);
  assert.throws(() => validateInviteFields(call, { date: '2026-10-14', start: '17:30', end: '18:20', room: '<script>' }), /plain words/);
});

test('the panel card shows the call, its people, the filled fields, and says the user presses Send', () => {
  const card = nextMeetingCard({ call: '2026-10-07-1733-team-call', title: 'Team call', people: 4, date: '2026-10-14', start: '17:30', end: '18:20', room: 'Breazzano', floors: '23' });
  assert.equal(card.heading, 'Set up the next meeting?');
  assert.match(card.body, /4 people/);
  assert.match(card.body, /you press Send/);
  assert.deepEqual(card.fields.map((f) => [f.name, f.value]), [['date', '2026-10-14'], ['start', '17:30'], ['end', '18:20'], ['room', 'Breazzano'], ['floors', '2, 3']]);
  assert.deepEqual(card.skip.action, { method: 'skipNextMeeting', args: ['2026-10-07-1733-team-call'] });
  assert.equal(nextMeetingCard(null), null);
  const fields = { start: '17:30', end: '18:20' };
  assert.deepEqual(inviteResultLine({ status: 'ready', room: 'Breazzano (Breakout) 214', people: 4, actions: 7 }, fields),
    { ok: true, text: 'Ready in Outlook: 5:30 PM to 6:20 PM, Breazzano 214, 4 people, 7 action items. Press Send in Outlook.' });
  assert.deepEqual(inviteResultLine({ status: 'no_free_room', detail: 'No Breazzano room on floor 2 or 3 is free at this time.' }, fields),
    { ok: false, text: 'No Breazzano room on floor 2 or 3 is free at this time.' });
});
