# derive() files a call by attendee names and email local parts, not just the title and domains (spec-c.md B16, B14).
# A made-up kickoff: 23 invitees on one .edu domain, two surnames that are words of one workstream, and a second
# workstream that lists the same domain. Deterministic: a temp workstreams.json, no calendar, no recorder.
#   python3 test_call_derive.py   (exit 0 = pass)
import contextlib, io, json, tempfile
from pathlib import Path
import call
from fixtures import patched

WORKSTREAMS = [
    {'name': 'Strategy Lab', 'domains': ['example.edu'], 'words': ['Okafor', 'Lindqvist']},
    {'name': 'Intro Finance', 'domains': ['example.edu'], 'words': ['ledger']},
    {'name': 'Book Club', 'domains': ['books.example'], 'words': ['novel']},
]
FIRST = ['ana', 'ben', 'cleo', 'dev', 'eli', 'fay', 'gus', 'hana', 'ivo', 'jun', 'kai', 'lia', 'max', 'noa', 'omar', 'pia', 'quin', 'rae', 'sol', 'tess', 'uma']
def kickoff(**over):
    emails = [f'{n}.smith@example.edu' for n in FIRST[:21]] + ['mo.okafor@example.edu', 'lindqvist_j@example.edu']
    names = ', '.join(f'{n.title()} Smith' for n in FIRST[:6]) + ', Mo Okafor, Jonas Lindqvist'
    return {'title': 'Kickoff', 'emails': emails, 'names': names, 'attendees': names, **over}

def derived(event, workstreams=WORKSTREAMS):
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / 'workstreams.json'; path.write_text(json.dumps(workstreams))
        with patched(call, WORKSTREAMS=path, PROFILE=Path(d) / 'profile.md'):
            return call.derive(event)

def test_names_and_local_parts_file_the_kickoff():
    e = derived(kickoff())
    assert e['workstream'] == 'Strategy Lab' and 'workstream_candidates' not in e, e
    assert len(e['emails']) == 23 and e['category'] == 'team', e

def test_a_local_part_alone_files_it():
    e = derived(kickoff(names='', attendees=''))
    assert e['workstream'] == 'Strategy Lab', e

def test_a_name_alone_files_it():
    e = derived(kickoff(emails=['x@example.edu']))
    assert e['workstream'] == 'Strategy Lab', e

def test_a_shared_domain_alone_is_none_with_two_candidates():
    e = derived({'title': 'Kickoff', 'emails': ['ana@example.edu', 'ben@example.edu'], 'names': 'Ana Smith, Ben Smith'})
    assert e['workstream'] == 'none' and e['workstream_candidates'] == ['Strategy Lab', 'Intro Finance'], e

def test_a_domain_only_one_workstream_lists_files_it():
    assert derived({'title': 'Hello', 'emails': ['a@books.example']})['workstream'] == 'Book Club'

def test_a_title_word_still_files_and_beats_a_shared_domain():
    e = derived({'title': 'Ledger review', 'emails': ['ana@example.edu']})
    assert e['workstream'] == 'Intro Finance' and 'workstream_candidates' not in e, e

def test_two_workstreams_with_word_hits_tie():
    e = derived(kickoff(title='Ledger kickoff'))
    assert e['workstream'] == 'none' and e['workstream_candidates'] == ['Strategy Lab', 'Intro Finance'], e

def test_names_match_whole_words_only():
    e = derived({'title': 'Hi', 'emails': ['sleepy@elsewhere.example'], 'names': 'Sam Okaforsson'})
    assert e['workstream'] == 'none' and 'workstream_candidates' not in e, e

def test_nothing_matches():
    assert derived({'title': 'Coffee', 'emails': ['a@nowhere.example']})['workstream'] == 'none'

def test_a_workstream_named_on_the_event_is_kept():
    assert derived(kickoff(workstream='Book Club'))['workstream'] == 'Book Club'

def test_derive_caps_names_but_not_emails():
    names = ', '.join(f'Person{i} Last{i}' for i in range(12))
    e = derived({'title': 'Big', 'emails': [f'p{i}@example.edu' for i in range(12)], 'names': names, 'attendees': names})
    assert len(e['names'].split(', ')) == call.MAX_NAMED == 8 and len(e['attendees'].split(', ')) == 8 and len(e['emails']) == 12, e

def test_from_calendar_keeps_emails_and_caps_names_and_dedupes_to_the_richest():
    people = [f'p{i}@example.edu' for i in range(23)]
    names = [f'Last{i}, First{i}' for i in range(23)]
    rich = {'title': 'Kickoff', 'start': '2026-10-08T10:00:00-04:00', 'end': '2026-10-08T11:00:00-04:00', 'allDay': False, 'attendees': people, 'attendeeNames': names}
    rich['meeting'] = True   # meeting.js isMeeting, as the node step marks each event
    bare = {**rich, 'attendees': [], 'attendeeNames': []}
    class Out: returncode = 0; stdout = json.dumps([bare, rich]); stderr = ''
    with patched(call.subprocess, run=lambda *a, **kw: Out()):
        title, js = call.from_calendar('2026-10-08T10:00:00-04:00')
    event = json.loads(js)
    assert title == 'Kickoff' and event['emails'] == people, event
    assert len(event['names'].split(', ')) == 8 and event['attendees'] == event['names'] and ',' not in event['names'].split(', ')[0], event

def test_from_calendar_never_names_a_call_after_a_block():
    # 2026-10-09: a 37-hour "MBA Veterans Career Conference & Expo" on the MBA I calendar, no invitees, named a Loggie session.
    block = {'title': 'MBA Veterans Career Conference & Expo', 'start': '2026-10-08T08:00:00-04:00', 'end': '2026-10-09T21:00:00-04:00', 'allDay': False,
             'attendees': [], 'attendeeNames': [], 'meeting': False}
    class Out: returncode = 0; stdout = json.dumps([block]); stderr = ''
    with patched(call.subprocess, run=lambda *a, **kw: Out()), contextlib.redirect_stdout(io.StringIO()) as printed:
        title, js = call.from_calendar('2026-10-09T19:12:00-04:00')
    assert title == 'Untitled call, 7:12 PM' and json.loads(js)['untitled'] is True, (title, js)
    assert 'not meetings: MBA Veterans Career Conference & Expo' in printed.getvalue(), 'what was skipped is said'

def test_the_calendar_filter_is_the_apps_own_rule():
    # call.py asks meeting.js, so the terminal and the app agree on what a meeting is.
    js = ("import(process.argv[1]).then(m => console.log(JSON.stringify([m.isMeeting(m.candidateOf({title: 'Expo', start: '2026-10-08T12:00:00Z', end: '2026-10-10T01:00:00Z', attendees: []})),"
          " m.isMeeting(m.candidateOf({title: 'Chat', start: '2026-10-08T12:00:00Z', end: '2026-10-08T12:30:00Z', attendees: ['a@b.c']}))])))")
    out = call.subprocess.run(['node', '-e', js, str(call.LOGGIE / 'src' / 'hikyaku' / 'meeting.js')], capture_output=True, text=True)
    assert json.loads(out.stdout) == [False, True], out.stderr

def test_a_calendar_event_gets_its_category_and_who_it_is_with():
    e = derived({'title': 'Coffee chat with Sam Lee', 'start': '2026-10-07T15:00:00Z', 'emails': ['sam@example.com'], 'names': 'Sam Lee', 'attendees': 'Sam Lee'})
    assert {'me', 'with', 'category', 'workstream'} <= e.keys() and e['category'] == 'one-on-one' and e['with'] == 'Sam Lee', e
    assert derived({'title': 'NBA 6530 Strategic Alliances', 'emails': []})['category'] == 'class'

# --- The Oct 27 case, made-up names (test/fixtures/oct27-calendar.json, meetings-granola-proposal.md c 1B and 1D):
# Record pressed on the Day card at 14:58:07 for the Teams meeting at 15:00, while the school's Sage Hall block (MBA I,
# nobody on it) had run since 14:30. The call is titled after the meeting, and its header says the press, not 14:30.
OCT27 = json.loads((Path(__file__).parents[2] / 'test' / 'fixtures' / 'oct27-calendar.json').read_text())
from datetime import datetime as _datetime
class Pressed(_datetime):
    @classmethod
    def now(cls, tz=None): return _datetime.fromisoformat(OCT27['press'])

def test_start_writes_the_press_time_and_the_header_says_it():
    import os, time, transcript
    os.environ['TZ'] = 'America/New_York'; time.tzset()
    mt = OCT27['MT']
    # meeting.js callEvent of the pressed card's event, as meeting-watch.js startManual hands it to call.py start
    event = {'title': mt['title'], 'start': mt['start'], 'end': mt['end'], 'id': mt['id'], 'emails': mt['attendees'], 'names': 'Rivera Kim', 'attendees': 'Rivera Kim', 'location': mt['location'], 'source': 'calendar'}
    class Proc: pid = 4242; poll = staticmethod(lambda: None)
    with tempfile.TemporaryDirectory() as d:
        home = Path(d) / 'calls'
        with patched(call, HOME=home, STATE=home / 'current.json', WORKSTREAMS=Path(d) / 'none.json', PROFILE=Path(d) / 'profile.md', SETTINGS=Path(d) / 'settings.json', datetime=Pressed), \
             patched(call.subprocess, Popen=lambda *a, **kw: Proc()), patched(call.time, sleep=lambda s: None), contextlib.redirect_stdout(io.StringIO()):
            call.start(mt['title'], json.dumps(event))
        folder, = [p for p in home.iterdir() if p.is_dir()]
        saved = json.loads((folder / 'event.json').read_text())
    assert saved['title'] == mt['title'] and saved['start'] == mt['start'], saved
    assert saved['recorded_at'] == '2026-10-27T14:58:07-04:00', saved
    head = transcript.header({**saved, 'start': OCT27['SAGE']['start']}, '/x/2026-10-27-1430-let-s-talk-in-sage-hall', 1800, 'v1')
    assert head.startswith(f"# {mt['title']}\n\nTuesday, October 27, 2026, 14:58, 30 min."), head

def test_from_calendar_reads_only_his_calendar():
    # `loggie record` reads the calendar through meeting.js: a club night with people on the school's shared calendar
    # was a meeting to it; now only his events count, by the same isMine as the app.
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        (root / 'src' / 'hikyaku').mkdir(parents=True)
        (root / 'src' / 'hikyaku' / 'meeting.js').symlink_to(call.HERE.parents[1] / 'src' / 'hikyaku' / 'meeting.js')
        def calendar(events):
            (root / 'src' / 'hikyaku' / 'calendar.js').write_text(f'export const listEvents = async () => {json.dumps(events)};\n')
        def picked(events, at=OCT27['press'], settings=None):
            calendar(events)
            (root / 'settings.json').write_text(json.dumps(settings or {}))
            with patched(call, LOGGIE=root, SETTINGS=root / 'settings.json'), contextlib.redirect_stdout(io.StringIO()):
                return call.from_calendar(at)[0]
        assert picked([OCT27['SAGE'], OCT27['CLUB']], '2026-10-27T15:05:00-04:00') == 'Untitled call, 3:05 PM'
        assert picked([OCT27['SAGE'], OCT27['MT2'], OCT27['MT'], OCT27['CLUB']]) == OCT27['MT']['title']
        assert picked([OCT27['CLUB']], '2026-10-27T15:05:00-04:00', {'recordCalendars': ['cal-exchange-mba1']}) == 'Untitled call, 3:05 PM', 'people on it, and he is not one of them'

if __name__ == '__main__':
    import fixtures; fixtures.run(globals())
