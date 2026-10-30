import tempfile
#!/usr/bin/env python3
# Tests for lexicon.py against a synthetic Apple Mail root (its sqlite index and .emlx files, built in a temp dir), a
# synthetic calls folder and synthetic settings. Real mail is never opened: every build() here gets mail_root=<tmp>.
#   python3 test_lexicon.py
import json, sqlite3, sys, tempfile, time, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import lexicon

NOW = 1_790_000_000           # a fixed "now" so the 90-day window is deterministic
DAY = 86400
ME, SAM, CLUB = 'me@example.com', 'sam@example.com', 'club@example.com'
BOX_INBOX, BOX_SENT = 1, 2

def emlx(frm, to, subject, body):
    msg = (f'From: {frm}\r\nTo: {to}\r\nSubject: {subject}\r\nDate: Wed, 7 Oct 2026 10:00:00 +0000\r\n'
           f'Content-Type: text/plain; charset="utf-8"\r\nMIME-Version: 1.0\r\n\r\n{body}\r\n').encode()
    return f'{len(msg)}\n'.encode() + msg + b'<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n'

class FakeMail:
    # The parts of Apple Mail's layout that lexicon.Mail reads: mailboxes, addresses, subjects, messages, recipients,
    # and the .emlx file under <account>/<Mailbox>.mbox/<uuid>/Data/<reversed digits>/Messages/<ROWID>.emlx.
    def __init__(self, root):
        self.root = Path(root); (self.root / 'MailData').mkdir(parents=True)
        self.db = sqlite3.connect(self.root / 'MailData' / 'Envelope Index')
        self.db.executescript('''
            create table mailboxes (ROWID integer primary key, url text);
            create table addresses (ROWID integer primary key autoincrement, address text, comment text);
            create table subjects (ROWID integer primary key autoincrement, subject text);
            create table messages (ROWID integer primary key, message_id integer, conversation_id integer, mailbox integer,
                                   date_sent integer, sender integer, subject integer, deleted integer default 0);
            create table recipients (ROWID integer primary key autoincrement, message integer, address integer, type integer, position integer);
            insert into mailboxes values (1, 'ews://ACCT/Inbox'), (2, 'ews://ACCT/Sent%20Items'), (3, 'ews://ACCT/Deleted%20Items');''')
        self.next = 1001

    def address(self, addr, comment=''):
        row = self.db.execute('select ROWID from addresses where address=? and comment=?', (addr, comment)).fetchone()
        if row: return row[0]
        return self.db.execute('insert into addresses (address, comment) values (?, ?)', (addr, comment)).lastrowid

    def message(self, frm, to, subject, body, box=BOX_INBOX, date=NOW - 5 * DAY, thread=None, deleted=0, rowid=None, frm_name='', to_names=None):
        rowid = rowid or self.next; self.next = max(self.next, rowid) + 1
        sid = self.db.execute('insert into subjects (subject) values (?)', (subject,)).lastrowid
        self.db.execute('insert into messages (ROWID, message_id, conversation_id, mailbox, date_sent, sender, subject, deleted) values (?,?,?,?,?,?,?,?)',
                        (rowid, rowid * 7, thread or rowid, box, date, self.address(frm, frm_name), sid, deleted))
        for i, r in enumerate(to if isinstance(to, list) else [to]):
            self.db.execute('insert into recipients (message, address, type, position) values (?,?,?,?)', (rowid, self.address(r, (to_names or {}).get(r, '')), 0, i))
        self.db.commit()
        digits = '/'.join(reversed(str(rowid // 1000))) if rowid >= 1000 else ''
        folder = self.root / 'ACCT' / ('Inbox.mbox' if box == BOX_INBOX else 'Sent Items.mbox' if box == BOX_SENT else 'Deleted Items.mbox') / 'UUID' / 'Data'
        folder = (folder / digits if digits else folder) / 'Messages'; folder.mkdir(parents=True, exist_ok=True)
        (folder / f'{rowid}.emlx').write_bytes(emlx(frm, ', '.join(to) if isinstance(to, list) else to, subject, body))
        return rowid

MY_SIG = 'Best regards,\nGio Tester\nMBA Candidate, Class of 2027\nSamuel Curtis Johnson Graduate School of Management\nMobile: +1 555 123 4567\nme@example.com\n'

class Fixture:
    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory(); root = Path(self.tmp.name)
        self.mail = FakeMail(root / 'mail')
        self.calls = root / 'calls'; self.calls.mkdir()
        self.settings = root / 'settings.json'; self.settings.write_text(json.dumps({'signName': 'Gio'}))
        self.profile = root / 'profile.md'; self.profile.write_text('The user is Gio, a student.\n')
        self.words = root / 'my-words.txt'                                  # absent until a test writes it
        # three sent messages make me@example.com the user, with the From name "Gio Tester"
        for n in range(3): self.mail.message(ME, 'x@example.com', f'Note {n}', 'Nothing here.\n' + MY_SIG, box=BOX_SENT, frm_name='Gio Tester')

    def call(self, name='2026-10-07-1100-sam-gio-coffee-chat', **event):
        folder = self.calls / name; folder.mkdir()
        (folder / 'event.json').write_text(json.dumps({'title': 'Sam & Gio - Coffee Chat', 'emails': [SAM], 'names': 'Sam Lee', 'attendees': 'Sam Lee', 'me': 'Gio', **event}))
        return folder

    def build(self, folder, **kw):
        return lexicon.build(folder, mail_root=self.mail.root, calls_root=self.calls, settings_path=self.settings, profile_path=self.profile, my_words_path=self.words, now=NOW, **kw)

class Thread(unittest.TestCase):
    def setUp(self):
        self.f = Fixture(); m = self.f.mail
        m.message(SAM, ME, 'Coffee chat', 'Hi Gio,\n\nHope you are well. I am in Breazzano now, near Gates Hall.\nSee you at Sage Hall tomorrow.\n\n'
                  'Best regards,\nSam Lee\n\nGet Outlook for iOS<https://aka.ms/x>\n________________________________\nFrom: Zed <zed@example.com>\n'
                  'Sent: Monday\nTo: Sam\nSubject: Hello\n\nThe Zebra Corp deal closed.\n', thread=50)
        m.message(ME, SAM, 'Re: Coffee chat', 'Sam,\n\nSee you at Sage Hall. I will bring the Kiru demo.\n\n' + MY_SIG +
                  '\nOn Mon, Sam Lee <sam@example.com> wrote:\n> Quoted Mountain here\n', box=BOX_SENT, thread=50, frm_name='Gio Tester')
        m.message(CLUB, [SAM] + [f'p{i}@example.com' for i in range(20)], 'Welcome', 'Welcome to the Golf Club at Pebble Beach.\n')
        m.message(SAM, ME, 'Old news', 'I was at Ancient Castle.\n', date=NOW - 200 * DAY)
        m.message(SAM, ME, 'Gone', 'Meet at Ghost Tower.\n', deleted=1)
        m.message(SAM, ME, 'Binned', 'Meet at Bin Tower.\n', box=3)
        m.message('other@example.com', 'third@example.com', 'Unrelated', 'Secret Island is nice.\n')
        self.d = self.f.build(self.f.call())
        self.texts = {e['text'] for e in self.d['entries']}
        self.by = {e['text']: e for e in self.d['entries']}

    def test_own_name_first_then_invitees(self):
        self.assertEqual(self.d['entries'][0]['text'], 'Gio'); self.assertEqual(self.d['entries'][0]['source'], 'own')
        self.assertEqual(self.by['Gio Tester']['source'], 'own')          # the From name on sent mail
        self.assertEqual(self.by['Sam Lee']['source'], 'invitee'); self.assertEqual(self.by['Sam']['source'], 'invitee')
        self.assertGreater(self.by['Sam']['count'], 1)                     # counted in the thread too

    def test_mail_names_from_own_text_only(self):
        for t in ('Breazzano', 'Gates Hall', 'Sage Hall', 'Kiru'): self.assertIn(t, self.texts, t)
        self.assertEqual(self.by['Sage Hall']['count'], 2); self.assertEqual(self.by['Breazzano']['source'], 'mail')
        for t in ('Zebra Corp', 'Quoted Mountain', 'Outlook', 'Samuel Curtis Johnson Graduate School', 'Candidate', 'Zed'):
            self.assertFalse(any(t in x for x in self.texts), f'{t} leaked from quoted history or a signature')

    def test_only_the_invitees_threads(self):
        for t in ('Golf Club', 'Pebble Beach', 'Ancient Castle', 'Ghost Tower', 'Bin Tower', 'Secret Island'):
            self.assertFalse(any(t in x for x in self.texts), t)
        self.assertEqual(self.d['sources']['mail_messages'], 2)

    def test_common_words_dropped(self):
        self.assertNotIn('Hope', self.texts); self.assertNotIn('See', self.texts)
        self.assertIn(('Hope', 'common word'), {(x['text'], x['reason']) for x in self.d['dropped']})

    def test_title_and_dedupe(self):
        self.assertIn('Coffee Chat', self.texts)                            # the invite title, split at " - " and " & "
        self.assertEqual(len({t.lower() for t in self.texts}), len(self.texts))
        self.assertFalse(any(' - ' in t or '&' in t for t in self.texts))

class Cap(unittest.TestCase):
    def test_cap_12(self):
        f = Fixture(); names = [f'Name{chr(65 + i)} Surname{chr(65 + i)}' for i in range(20)]
        f.mail.message(SAM, ME, 'Team', 'I met ' + ', '.join(names) + ' at Sage Hall.\n')
        d = f.build(f.call())
        self.assertEqual(len(d['entries']), 12); self.assertEqual(d['cap'], 12)
        self.assertTrue(any(x['reason'].startswith('over cap') for x in d['dropped']))
        self.assertEqual([e['source'] for e in d['entries'][:4]], ['own', 'own', 'invitee', 'invitee'])

class PastCalls(unittest.TestCase):
    def test_written_sources_only(self):
        f = Fixture(); old = f.call('2026-09-01-0900-sam-gio-earlier')
        (old / 'lexicon.json').write_text(json.dumps({'entries': [{'text': 'Written Name', 'source': 'mail', 'count': 2},
                                                                  {'text': 'Model Name', 'source': 'model', 'count': 9},
                                                                  {'text': 'Guessed Name', 'source': 'nemotron-guess', 'count': 9}],
                                                      'built': '2026-09-01T09:30:00-04:00'}))
        stranger = f.call('2026-09-02-0900-stranger', emails=['who@example.com'], names='Who Else', attendees='Who Else')
        (stranger / 'lexicon.json').write_text(json.dumps({'entries': [{'text': 'Stranger Place', 'source': 'mail', 'count': 5}], 'built': '2026-09-02T09:30:00-04:00'}))
        d = f.build(f.call())
        by = {e['text']: e for e in d['entries']}
        self.assertEqual(by['Written Name']['source'], 'past-call')
        for t in ('Model Name', 'Guessed Name', 'Stranger Place'): self.assertNotIn(t, by)
        self.assertTrue(any(x['text'] == 'Model Name' and 'not a written source' in x['reason'] for x in d['dropped']))
        self.assertEqual(d['sources']['past_calls'], ['2026-09-01-0900-sam-gio-earlier/lexicon.json'])

class Terms(unittest.TestCase):
    def test_with_terms_needs_three_uses_in_two_threads(self):
        f = Fixture(); m = f.mail
        for n, thread in enumerate((70, 70, 71)):
            m.message(ME, f'r{n}@example.com', f'Plan {n}', f'The MBA PM club meets at Lake Source Cooling on day {n}.\n' + MY_SIG, box=BOX_SENT, thread=thread, frm_name='Gio Tester')
        for n in range(3):   # three uses, one thread
            m.message(ME, 'r8@example.com', f'Plan 8-{n}', 'We discussed the Single Thread Term again.\n' + MY_SIG, box=BOX_SENT, thread=73, frm_name='Gio Tester')
        m.message(ME, 'r9@example.com', 'Plan 9', 'Only Once Term and OOT here.\n' + MY_SIG, box=BOX_SENT, thread=72, frm_name='Gio Tester')
        off = f.build(f.call()); self.assertNotIn('terms_found', off); self.assertFalse(any(e['source'] == 'terms' for e in off['entries']))
        on = f.build(f.call('2026-10-07-1200-sam-gio-second'), with_terms=True)
        found = {t['text'] for t in on['terms_found']}
        self.assertIn('MBA PM', found); self.assertIn('Lake Source Cooling', found)
        self.assertNotIn('Only Once Term', found); self.assertNotIn('OOT', found)
        self.assertNotIn('Single Thread Term', found)                      # 3 uses, 1 thread
        self.assertEqual({e['text'] for e in on['entries'] if e['source'] == 'terms'} <= found, True)

class OwnSubjects(unittest.TestCase):
    # spec-entry-b.md A row 5: "Loggie" was heard as "Loggy" because the user's own product name was on no list. Words
    # the user capitalizes in the subjects of their own sent mail, in at least OWN_MIN threads, join as "own-terms".
    def sent(self, f, subject, thread, to='r@example.com', date=NOW - 5 * DAY):
        f.mail.message(ME, to, subject, 'Body text only.\n' + MY_SIG, box=BOX_SENT, thread=thread, date=date, frm_name='Gio Tester')

    def test_recurring_own_word_joins(self):
        f = Fixture()
        self.sent(f, 'Loggie demo', 80); self.sent(f, 'Re: Loggie onboarding', 81)
        d = f.build(f.call()); by = {e['text']: e for e in d['entries']}
        self.assertIn('Loggie', by); self.assertEqual(by['Loggie']['source'], 'own-terms'); self.assertEqual(by['Loggie']['count'], 2)
        self.assertNotIn('Loggie', [p for p in [e['text'] for e in d['entries'] if e['source'] in ('own', 'invitee')]])   # never a person
        self.assertEqual(d['sources']['own_subjects'], 5)

    def test_one_subject_or_one_thread_is_not_enough(self):
        f = Fixture()
        self.sent(f, 'Kiru launch', 82)                                    # one subject
        self.sent(f, 'Geniie notes', 83); self.sent(f, 'Re: Geniie notes', 83); self.sent(f, 'RE: RE: Geniie notes', 83)   # one thread
        texts = {e['text'] for e in f.build(f.call())['entries']}
        self.assertNotIn('Kiru', texts); self.assertNotIn('Geniie', texts)

    def test_ordinary_capitals_never_join(self):
        f = Fixture()
        for n, s in enumerate(('Monday Update: Loggie', 'Re: Monday Update', 'Re: Quick question about Hikyaku', 'Quick question',
                               'Updates Demo', 'Demo Updates', 'Meeting notes', 'Meeting Notes for Hikyaku', "Can't make Tuesday",
                               "Can't make it", 'PR review', 'PR merged', 'Fwd: Intro', 'Intro call', 'Slides demo', 'Slides v2', 'Standup moved', 'Standup notes', 'Kiru standup')):
            self.sent(f, s, 90 + n)
        d = f.build(f.call()); texts = {e['text'] for e in d['entries']}
        for t in ('Monday', 'Update', 'Updates', 'Re', 'RE', 'Quick', 'Meeting', 'Notes', "Can't", 'Can', 'Tuesday', 'PR',
                  'Fwd', 'Intro', 'Demo', 'Slides', 'Standup'):
            self.assertNotIn(t, texts, t)
        self.assertIn('Hikyaku', texts)                                    # a name mid-subject in two threads still does
        reasons = {(x['text'], x['source']): x['reason'] for x in d['dropped']}
        self.assertEqual(reasons[('Standup', 'own-terms')], 'also written lowercase in a sent subject')
        self.assertEqual(reasons[('Demo', 'own-terms')], 'common word')
        self.assertEqual(reasons[('Updates', 'own-terms')], 'common word')

    def test_only_the_users_sent_subjects(self):
        f = Fixture()
        f.mail.message(CLUB, ME, 'Zorblat kickoff', 'Hi.\n', thread=60); f.mail.message(CLUB, ME, 'Zorblat review', 'Hi.\n', thread=61)   # received only
        for n in range(2): self.sent(f, f'Plan {n}', 62 + n)               # the body says nothing; Quietword is only in bodies
        f.mail.message(ME, 'r@example.com', 'Body only', 'Quietword here.\n', box=BOX_SENT, thread=64, frm_name='Gio Tester')
        f.mail.message(ME, 'r@example.com', 'Body only again', 'Quietword again.\n', box=BOX_SENT, thread=65, frm_name='Gio Tester')
        self.sent(f, 'Ancientproj review', 66, date=NOW - 200 * DAY); self.sent(f, 'Ancientproj plan', 67, date=NOW - 200 * DAY)
        texts = {e['text'] for e in f.build(f.call())['entries']}
        for t in ('Zorblat', 'Quietword', 'Ancientproj'): self.assertNotIn(t, texts, t)

    def test_people_outrank_own_words_under_the_cap(self):
        f = Fixture()
        self.sent(f, 'Loggie demo', 80); self.sent(f, 'Loggie PR', 81)
        d = f.build(f.call())
        order = [e['source'] for e in d['entries']]
        self.assertLess(max(i for i, s in enumerate(order) if s in ('own', 'invitee')), order.index('own-terms'))
        crowd = ', '.join(f'Person{chr(65 + i)} Last{chr(65 + i)}' for i in range(6))   # 2 own + 12 invitee entries
        d = f.build(f.call('2026-10-07-1300-crowd', names=crowd, attendees=crowd))
        self.assertEqual(len(d['entries']), 12); self.assertTrue(all(e['source'] in ('own', 'invitee') for e in d['entries']))
        self.assertIn(('Loggie', 'over cap of 12'), {(x['text'], x['reason']) for x in d['dropped']})

    def test_nothing_heard_is_added(self):
        f = Fixture(); folder = f.call()
        (folder / 'transcript.md').write_text('**Gio** [00:01] Loggy Loggy Heardname Heardname works.\n')
        (folder / 'words.json').write_text(json.dumps([{'text': 'Heardname'}, {'text': 'Loggy'}]))
        old = f.call('2026-09-01-0900-sam-gio-earlier')
        (old / 'lexicon.json').write_text(json.dumps({'entries': [{'text': 'Loggy', 'source': 'heard', 'count': 9},
                                                                  {'text': 'Typedproj', 'source': 'own-terms', 'count': 2}],
                                                      'built': '2026-09-01T09:30:00-04:00'}))
        d = f.build(folder); by = {e['text']: e for e in d['entries']}
        self.assertNotIn('Loggy', by); self.assertNotIn('Heardname', by)
        self.assertEqual(by['Typedproj']['source'], 'past-call')          # own-terms is a written source; it may cross calls
        self.assertTrue(any(x['text'] == 'Loggy' and 'not a written source' in x['reason'] for x in d['dropped']))

class MyWords(unittest.TestCase):
    # spec-entry-c.md B19: my-words.txt in the hikyaku home is the user's own list of words the speech models must hear
    # right. One source, ranked after own names and invitees and before the title, at most MY_WORDS_CAP per call.
    def test_file_words_join_after_invitees(self):
        f = Fixture(); f.words.write_text('Loggie\nhikyaku\n')
        d = f.build(f.call(title='Sam & Gio - Nebius x NVIDIA'))
        order = [(e['text'], e['source']) for e in d['entries']]
        mine = [t for t, s in order if s == 'my-words']; self.assertEqual(mine, ['Loggie', 'hikyaku'])
        sources = [s for _, s in order]
        self.assertLess(max(i for i, s in enumerate(sources) if s == 'invitee'), sources.index('my-words'))
        self.assertLess(max(i for i, s in enumerate(sources) if s == 'my-words'), sources.index('title'))
        self.assertTrue(all(e['count'] == 1 for e in d['entries'] if e['source'] == 'my-words'))
        self.assertEqual(d['sources']['my_words'], 2)

    def test_cap_of_four(self):
        f = Fixture(); f.words.write_text('Alpha\nBravo\nCharlie\nDelta\nEcho\n')
        d = f.build(f.call())
        self.assertEqual([e['text'] for e in d['entries'] if e['source'] == 'my-words'], ['Alpha', 'Bravo', 'Charlie', 'Delta'])
        self.assertEqual(lexicon.MY_WORDS_CAP, 4)
        self.assertIn(('Echo', 'my-words', 'over my-words limit of 4'), {(x['text'], x['source'], x['reason']) for x in d['dropped']})
        self.assertLessEqual(len(d['entries']), lexicon.CAP)

    def test_no_file_changes_nothing(self):
        f = Fixture(); folder = f.call()
        d = f.build(folder); self.assertFalse(f.words.exists())
        self.assertFalse(any(e['source'] == 'my-words' for e in d['entries']))
        self.assertEqual(d['sources']['my_words'], 0)

    def test_comments_blanks_and_repeats_are_ignored(self):
        f = Fixture(); f.words.write_text('# product names\n\nLoggie\n   \nloggie\n# Hidden\n')
        self.assertEqual(lexicon.my_words(f.words), ['Loggie'])
        d = f.build(f.call()); texts = [e['text'] for e in d['entries']]
        self.assertEqual(texts.count('Loggie'), 1); self.assertNotIn('Hidden', texts); self.assertNotIn('#', ''.join(texts))

    def test_a_word_already_a_person_is_not_listed_twice(self):
        f = Fixture(); f.words.write_text('Sam\nLoggie\n')
        d = f.build(f.call()); by = {e['text']: e['source'] for e in d['entries']}
        self.assertEqual(by['Sam'], 'invitee'); self.assertEqual(by['Loggie'], 'my-words')

    def test_handed_on_through_a_past_call(self):
        f = Fixture()                                                      # no my-words.txt now; an earlier call carried one
        old = f.call('2026-09-01-0900-sam-gio-earlier')
        (old / 'lexicon.json').write_text(json.dumps({'entries': [{'text': 'Loggie', 'source': 'my-words', 'count': 1}], 'built': '2026-09-01T09:30:00-04:00'}))
        d = f.build(f.call()); by = {e['text']: e for e in d['entries']}
        self.assertEqual(by['Loggie']['source'], 'past-call')

class OwnTermsPlace(unittest.TestCase):
    # Live run 2026-10-08 on the Jess call: own-terms (Caballero x39, Maria x18 ...) pushed the title's Nebius and
    # NVIDIA off the list. Own-terms come last, fill leftover slots only, at most OWN_CAP, and are never a person's name.
    def sent(self, f, subject, thread, to='r@example.com', **kw):
        f.mail.message(ME, to, subject, 'Body text only.\n' + MY_SIG, box=BOX_SENT, thread=thread, frm_name='Gio Tester', **kw)

    def many(self, f, words=('Zorvane', 'Quillex', 'Brantor', 'Velmora', 'Tazzle'), threads=4):
        n = 300
        for w in words:
            for k in range(threads): self.sent(f, f'{w} plan {k}', n); n += 1

    def test_order_title_mail_past_then_own_terms(self):
        f = Fixture(); self.many(f)
        f.mail.message(SAM, ME, 'Coffee chat', 'Then Gates Hall again, Gates Hall, Gates Hall.\n', thread=50)
        old = f.call('2026-09-01-0900-sam-gio-earlier')
        (old / 'lexicon.json').write_text(json.dumps({'entries': [{'text': 'Written Name', 'source': 'mail', 'count': 9}], 'built': '2026-09-01T09:30:00-04:00'}))
        d = f.build(f.call(title='Sam & Gio - Nebius x NVIDIA'))
        order = [e['source'] for e in d['entries']]
        rank = {'own': 0, 'invitee': 1, 'my-words': 2, 'title': 3, 'mail': 4, 'past-call': 5, 'own-terms': 6}
        self.assertEqual(order, sorted(order, key=rank.get), order)          # Gates Hall x3 does not jump the title
        texts = [e['text'] for e in d['entries']]
        for t in ('Nebius', 'NVIDIA', 'Gates Hall', 'Written Name'): self.assertIn(t, texts, t)
        self.assertEqual(order.count('own-terms'), lexicon.OWN_CAP); self.assertEqual(lexicon.OWN_CAP, 3)
        self.assertEqual(sum(1 for x in d['dropped'] if x['source'] == 'own-terms' and x['reason'] == 'over own-terms limit of 3'), 2)

    def test_title_never_dropped_for_an_own_term(self):
        f = Fixture(); self.many(f)
        crowd = ', '.join(f'Person{chr(65 + i)} Last{chr(65 + i)}' for i in range(4))   # 2 own + 8 invitee + 2 title = the cap
        d = f.build(f.call('2026-10-07-1300-crowd', title='Nebius x NVIDIA', names=crowd, attendees=crowd, emails=[]))
        self.assertEqual([e['text'] for e in d['entries']][-2:], ['Nebius', 'NVIDIA'])
        self.assertFalse(any(e['source'] == 'own-terms' for e in d['entries']))
        self.assertFalse(any(x['source'] == 'title' for x in d['dropped']))

    def test_parts_of_the_users_name_never_join(self):
        f = Fixture(); f.profile.write_text('The user is Gio Proftest, a student.\n')
        self.sent(f, 'Proftest plan', 80); self.sent(f, 'Proftest notes', 81)
        d = f.build(f.call())
        self.assertNotIn('Proftest', [e['text'] for e in d['entries']])
        self.assertIn(('Proftest', "part of the user's name"), {(x['text'], x['reason']) for x in d['dropped']})

    def test_names_in_mail_headers_never_join(self):
        f = Fixture()
        f.mail.message('maria@example.com', ME, 'Hello', 'Hi.\n', frm_name='Maria Ruiz')           # a sender's display name
        self.sent(f, 'Shruti sync', 80, to='shruti@example.com', to_names={'shruti@example.com': 'Shruti Rao'})   # a recipient's
        self.sent(f, 'Shruti follow', 81); self.sent(f, 'Maria sync', 82); self.sent(f, 'Maria call notes', 83)
        self.sent(f, 'Loggie demo', 84); self.sent(f, 'Loggie PR', 85)
        d = f.build(f.call()); texts = [e['text'] for e in d['entries']]
        self.assertNotIn('Shruti', texts); self.assertNotIn('Maria', texts); self.assertIn('Loggie', texts)
        reasons = {(x['text'], x['reason']) for x in d['dropped']}
        self.assertIn(('Maria', 'a name in mail headers'), reasons); self.assertIn(('Shruti', 'a name in mail headers'), reasons)

class NeverOverwrite(unittest.TestCase):
    def test_new_file_each_time(self):
        f = Fixture(); folder = f.call(); d = f.build(folder)
        p1 = lexicon.write(folder, d); first = p1.read_text()
        d['entries'][0]['count'] = 999; p2 = lexicon.write(folder, d); p3 = lexicon.write(folder, d)
        self.assertEqual((p1.name, p2.name, p3.name), ('lexicon.json', 'lexicon-2.json', 'lexicon-3.json'))
        self.assertEqual(p1.read_text(), first)
        self.assertEqual(json.loads(p2.read_text())['entries'][0]['count'], 999)

class NoMail(unittest.TestCase):
    def test_builds_from_the_invite_alone(self):
        f = Fixture(); d = lexicon.build(f.call(), mail_root=Path(f.tmp.name) / 'nowhere', calls_root=f.calls, settings_path=f.settings, profile_path=f.profile, now=NOW)
        self.assertEqual([e['text'] for e in d['entries'][:3]], ['Gio', 'Sam Lee', 'Sam'])
        self.assertTrue(any('mail index not found' in n for n in d['sources']['notes']))

    def test_class_call_without_emails(self):
        f = Fixture(); d = f.build(f.call('2026-10-06-1012-nba-6530-strategic-alliances', title='NBA 6530 Strategic Alliances', emails=[], names='', attendees=''))
        self.assertEqual([(e['text'], e['source']) for e in d['entries']], [('Gio', 'own'), ('Gio Tester', 'own'), ('Strategic Alliances', 'title')])
        self.assertFalse(any('NBA' in e['text'] for e in d['entries']))   # the course code is not a term

class Units(unittest.TestCase):
    def test_own_text_cuts(self):
        t = lexicon.own_text('Hi,\n\nMeet at Olin Hall.\n\nThanks,\nSam Lee\nSenior Director\nSent from my iPhone\n\nOn Tue, Gio wrote:\n> Old Place\n', ['Gio Tester'])
        self.assertEqual(t, 'Hi,\n\nMeet at Olin Hall.\n\nSam Lee')
        self.assertEqual(lexicon.own_text('Fine by me.\nGio Tester\nMBA Candidate\nMobile: 555\n', ['Gio Tester']), 'Fine by me.\nGio Tester')
        self.assertEqual(lexicon.own_text('Yes.\n-----Original Message-----\nFrom: A\nHidden Valley\n'), 'Yes.')

    def test_candidate_runs(self):
        runs = lexicon.candidate_runs("Hope all is well. I'm in Breazzano now with Priya Shah. Okay thanks. Dell's team and AT&T called.")
        self.assertEqual(runs, [('Hope', False), ('Breazzano', True), ('Priya Shah', True), ('Dell', False), ('AT&T', True)])
        self.assertEqual(lexicon.candidate_runs('The MBA PM club meets at 3 PM.'), [('The', False), ('MBA PM', True)])
        self.assertEqual(lexicon.candidate_runs('Sam & Gio - Coffee Chat', label=True), [('Sam', True), ('Gio', True), ('Coffee Chat', True)])
        self.assertEqual(lexicon.is_common('Hope', False), 'common word'); self.assertEqual(lexicon.is_common('Breazzano', False), 'sentence start only')
        self.assertEqual(lexicon.is_common('Hope', True), ''); self.assertEqual(lexicon.is_common('MBA', False), '')

class AmpersandNames(unittest.TestCase):
  def test_a_name_with_an_ampersand_is_put_back_over_its_spoken_forms(self):
      # The 2026-10-09 Liz call: "M&T" in the title and lexicon, "MNT (unclear)" six times in the transcript.
      import nvidia_engine as e
      assert e.respell('the MNT (unclear) Bank process', ['M&T']) == ('the M&T Bank process', 1)
      assert e.respell('M and T bank, M N T, M & T', ['M&T']) == ('M&T bank, M&T, M&T', 3)
      assert e.respell('M&T Bank', ['M&T']) == ('M&T Bank', 0), 'already right is no change'
      assert e.respell('AMNTX, Mnt, an MT-led program, ATNT', ['M&T', 'AT&T']) == ('AMNTX, Mnt, an MT-led program, ATNT', 0)
      assert e.respell('AT and T', ['AT&T']) == ('AT&T', 1)
      W = lambda *ts: [{'text': t, 'p': p, 'start': i, 'end': i + .5} for i, (t, p) in enumerate(ts)]
      words, n = e.respell_words(W((' the', .9), (' MNT', .2), (' Bank.', .9)), ['M&T'])
      assert [w['text'] for w in words] == [' the', ' M&T', ' Bank.'] and words[1]['p'] == 1.0 and n == 1
      words, n = e.respell_words(W((' M', .9), (' and', .9), (' T,', .9), (' yes', .9)), ['M&T'])
      assert [w['text'] for w in words] == [' M&T,', ' yes'] and words[0]['end'] == 2.5 and n == 1
      assert e.respell_words(W((' M&T', .95),), ['M&T'])[1] == 0
      with tempfile.TemporaryDirectory() as d:
          Path(d, 'lexicon.json').write_text(json.dumps({'entries': [{'text': 'M&T', 'source': 'title'}, {'text': 'Liz Romero', 'source': 'title'}, {'text': 'Barnes & Noble', 'source': 'mail'}]}))
          assert e.amp_terms(d) == ['M&T', 'Barnes & Noble']

class HeardAs(unittest.TestCase):
  def test_a_word_the_user_says_was_misheard_is_put_back_only_over_the_forms_written(self):
    # 2026-10-09 Hilton meeting: "Yiming" came out "E Ming", "Emin", "Eming" even boosted; the notes then invented "Richard".
    import nvidia_engine as e
    with tempfile.TemporaryDirectory() as d:
        f = Path(d, 'my-words.txt')
        f.write_text('# mine\nLoggie\nYiming: E Ming, Emin, Eming\nNoForms:\n')
        self.assertEqual(lexicon.my_words(f), ['Loggie', 'Yiming', 'NoForms'])
        self.assertEqual(lexicon.heard_as(f), {'Yiming': ['E Ming', 'Emin', 'Eming']})
    h = {'Yiming': ['E Ming', 'Emin', 'Eming']}
    self.assertEqual(e.respell_heard('because um eming he is majoring; Emily and Eminem stay', h), ('because um Yiming he is majoring; Emily and Eminem stay', 1))
    W = lambda *ts: [{'text': t, 'p': p, 'start': i, 'end': i + .5} for i, (t, p) in enumerate(ts)]
    words, n = e.respell_words(W((' know', .9), (' E', .4), (' Ming?', .3)), [], .5, h)
    self.assertEqual(([w['text'] for w in words], n), ([' know', ' Yiming?'], 1))
    words, n = e.respell_words(W((" Emin's", .3), (' slides', .9)), [], .5, h)
    self.assertEqual([w['text'] for w in words], [" Yiming's", ' slides'])

class MyWordsBytes(unittest.TestCase):
    # A stray byte in my-words.txt (a paste from another app) never stops the notes run (cleanup audit bug 10).
    def test_a_stray_byte_is_read_not_raised(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'my-words.txt'
            p.write_bytes(b'Yiming: E Ming, Emin\nCaf\xe9 Kai\n')
            self.assertEqual(lexicon.my_words(p)[0], 'Yiming')
            self.assertEqual(lexicon.heard_as(p), {'Yiming': ['E Ming', 'Emin']})

if __name__ == '__main__':
    unittest.main(verbosity=1)
