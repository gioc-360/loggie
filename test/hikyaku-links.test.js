import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { analyzeLink, analyzeLinks, extractRawLinks, htmlToSafeText, linksMarkdown, registrable, taskLinks } from '../src/hikyaku/links.js';
import { catchUp } from '../src/hikyaku/workstreams.js';

test('links come out of the HTML with their visible text, and out of plain text; mail and phone links are left out', () => {
  const raw = extractRawLinks('<a href="https://example.com/a?x=1&amp;y=2">Sign <b>up</b></a> <a href="mailto:sam@example.com">mail</a> <a href=\'https://example.com/a?x=1&amp;y=2\'>dup</a>',
    'Agenda: https://docs.example.org/agenda. Also (https://example.net/x)');
  assert.deepEqual(raw, [
    { text: 'Sign up', href: 'https://example.com/a?x=1&y=2' },
    { text: '', href: 'https://docs.example.org/agenda' },
    { text: '', href: 'https://example.net/x' },
  ]);
});

test('a link whose text names one site but goes to another is flagged', () => {
  const fake = analyzeLink({ text: 'www.cornell.edu', href: 'https://cornell-edu.login.example/x' }, { trusted: ['cornell.edu'] });
  assert.equal(fake.mismatch, true); assert.match(fake.warnings[0], /pretends to be cornell\.edu, a site you trust, but goes to cornell-edu\.login\.example/);
  const other = analyzeLink({ text: 'jobs.example.com/apply', href: 'https://news.campus.example/click?id=9' }, { trusted: ['cornell.edu'] });
  assert.deepEqual([other.mismatch, other.warnings], [false, []]);
  assert.match(other.note, /shows jobs\.example\.com, but goes through news\.campus\.example first/, 'an untrusted mismatch is a gray note, never silent');
  assert.equal(analyzeLink({ text: 'cornell.edu/registrar', href: 'https://registrar.cornell.edu/forms' }).mismatch, false, 'a subdomain of the same site is fine');
  assert.equal(analyzeLink({ text: 'Register here', href: 'https://events.example.com' }).mismatch, false, 'ordinary words are not a claim about a site');
});

test('security wrappers are unwrapped, so a Safe Links address is not a false alarm', () => {
  const safe = analyzeLink({ text: 'cornell.zoom.us/j/1', href: 'https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fcornell.zoom.us%2Fj%2F1&data=abc' });
  assert.deepEqual([safe.domain, safe.wrapped, safe.mismatch, safe.warnings], ['cornell.zoom.us', 'Microsoft Safe Links', false, []]);
  assert.equal(analyzeLink({ text: '', href: 'https://www.google.com/url?q=https://example.org/page' }).domain, 'example.org');
  const proofpoint = analyzeLink({ text: 'johnson.cornell.edu', href: 'https://urldefense.com/v3/__https://johnson.cornell.edu/events/__;!!abc123$' });
  assert.deepEqual([proofpoint.domain, proofpoint.wrapped, proofpoint.mismatch], ['johnson.cornell.edu', 'Proofpoint URL Defense', false]);
  assert.equal(analyzeLink({ text: '', href: 'https://urldefense.proofpoint.com/v2/url?u=https-3A__www.example.org_page&d=x' }).domain, 'example.org');
  const tracked = analyzeLink({ text: 'studentaid.gov/account', href: 'https://abc.r.us-east-1.awstrack.me/L0/x' });
  assert.deepEqual([tracked.mismatch, tracked.warnings], [false, []], 'a mail service routing the click is noted, not warned');
  assert.match(tracked.note, /shows studentaid\.gov, but goes through abc\.r\.us-east-1\.awstrack\.me first/);
  // Phishing usually comes from the attacker's own domain, so the sender's site is never an excuse.
  const phish = analyzeLink({ text: 'cornell.edu/login', href: 'https://cornell-it.example/login' }, { trusted: ['cornell.edu'] });
  assert.equal(phish.mismatch, true);
  assert.equal(analyzeLink({ text: '15500.docx', href: 'https://files.example.org/f' }).mismatch, false, 'a file name is not a site');
});

test('shortened links, bare IP addresses and lookalike characters each get a warning', () => {
  assert.match(analyzeLink({ text: 'slides', href: 'https://bit.ly/3abc' }).warnings.join(), /shortened/);
  assert.match(analyzeLink({ text: '', href: 'http://192.168.4.20/login' }).warnings.join(), /bare IP/);
  assert.match(analyzeLink({ text: '', href: 'https://xn--crnell-0ya.edu/' }).warnings.join(), /lookalike/);
  assert.equal(registrable('dept.ox.ac.uk'), 'ox.ac.uk'); assert.equal(registrable('a.b.example.com'), 'example.com');
});

test('nothing in the link code can open a link: no network calls, no launching a browser', async () => {
  for (const file of ['../src/hikyaku/links.js']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bfetch\(|https?\.(get|request)\(|node:https?|child_process|\bspawn\(|\bexec\(/, `${file} must never reach the network`);
  }
});

test('catch-up writes each task\'s links next to it and lists them in the thread, marked as never opened', async () => {
  const workRoot = await mkdtemp(join(tmpdir(), 'hikyaku-links-'));
  const tasks = [], projects = [];
  const core = {
    listProjects: async () => projects, listTasks: async () => tasks, createBrief: async () => ({}),
    createProject: async (input) => { const project = { id: 'p1', ...input }; projects.push(project); return project; },
    createTask: async (input) => { const task = { id: `task_${tasks.length + 1}`, ...input }; tasks.push(task); return task; },
  };
  const threads = [{ id: 't1', subject: 'Workshop', latestTimestamp: '2026-10-04T12:00:00Z', messages: [{ id: 'm1', from: 'Sam <sam@example.com>', to: 'me@school.edu', timestamp: '2026-10-04T12:00:00Z',
    body: 'Please register by Friday.', rawLinks: [{ text: 'www.school.edu', href: 'https://school-edu.evil.example/r' }, { text: 'Agenda', href: 'https://docs.example.org/a' }] }] }];
  const complete = async () => JSON.stringify({ summary: 'A workshop.', promised: [], open: [], actions: [{ title: 'Register for the workshop', kind: 'apply', thread: 1, due: null, quote: 'Please register by Friday.', steps: [] }] });
  await catchUp({ workstream: { name: 'Acme', goal: 'Get it done', domains: [], words: [] }, threads, complete, core, workRoot, ownAddress: 'me@school.edu' });
  const folder = join(projects[0].directoryPath, tasks[0].id);
  const links = await taskLinks(folder);
  assert.deepEqual(links.map((link) => [link.domain, link.mismatch]), [['school-edu.evil.example', true], ['docs.example.org', false]], 'the user\'s own domain (school.edu) is trusted');
  assert.match(await readFile(join(folder, 'THREAD.md'), 'utf8'), /Links in this email \(hikyaku never opens them\):\n- www\.school\.edu -> school-edu\.evil\.example {2}\(warning: pretends to be school\.edu/);
  assert.deepEqual(linksMarkdown([]), []);
  assert.deepEqual(await taskLinks(join(workRoot, 'missing')), []);
});

test('HTML becomes inert text: scripts dropped, entities decoded', () => {
  assert.equal(htmlToSafeText('<script>steal()</script><p>Hello &amp; welcome</p>'), 'Hello & welcome');
});
