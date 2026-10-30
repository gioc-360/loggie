# Class notes (loggie-class-notes, docs/class-notes/spec.md, eval contract 1.1 to 1.5): a class's classmates leave the
# Mac as Student N, the notes come back checked against the transcript and keep the labels on disk, and every other
# call is screened byte for byte as before. Made-up people only (fixtures/class-*.json); temp folders only.
#   python3 -B test_class_notes.py
import contextlib, hashlib, io, json, os, re, sys, tempfile, time
from pathlib import Path
HOME = tempfile.mkdtemp(prefix='class-notes-home-')
os.environ['LOGGIE_HIKYAKU_HOME'] = HOME   # lexicon.own_names reads Loggie's settings: never the real ones here
sys.path.insert(0, str(Path(__file__).parent))
import byo, privacy, sendgate, summary

HERE = Path(__file__).parent
CASES = json.loads((HERE / 'fixtures' / 'class-mask-cases.json').read_text())
UNMASK = json.loads((HERE / 'fixtures' / 'class-unmask-cases.json').read_text())
NAMES = {'me': 'Gio', 'other': None, 'people': []}

def masked_case():
    header, turns = privacy.parse_md(CASES['transcript'])
    return privacy.screen(header, turns, NAMES, (CASES['event'], set(CASES['own']), {'imagined', 'strategy'}))

def said(form, text):
    return re.search(rf"(?<![\w'’-]){re.escape(form)}(?![\w-])", text)

def test_every_rule_masks_its_case_and_no_classmate_is_left():
    out, record = masked_case()
    left = [s for s in CASES['students'] if said(s, out)]
    assert left == [], left
    rules = {v['name']: v['rule'] for v in record['names'].values()}
    assert rules == CASES['labels'], rules
    assert record['counts']['masked']['labels'] == len(CASES['labels'])

def test_the_decoys_stay():
    out, record = masked_case()
    gone = [k for k in CASES['keep'] if not said(k, out)]
    assert gone == [], gone
    assert 'Yes, Gio. And I\'ll see you, Gio.' in out and 'Me (Gio)' in out, 'the user is never masked'

def test_the_map_numbering_marks_and_lines():
    out, record = masked_case()
    names = record['names']
    assert list(names) == [f'Student {n}' for n in range(1, len(names) + 1)]
    assert names['Student 1']['name'] == 'Pella Varin' and names['Student 1']['at'][0] == 'header', 'the header comes first'
    assert names['Student 1']['forms'] == ['Pella Varin', 'Pella', 'Varin'], 'an invitee is one person: full name and each word'
    assert 'Student 1 made a good point and Student 1 backed it.' in out, 'same name, same label'
    by = {v['name']: v for v in names.values()}
    assert by['Quillan']['unclear'] is True and by['Marnie']['unclear'] is False and by['Ivelle']['likely'] == 'Ivelle'
    assert by['Marnie']['at'] == ['00:10', '08:00'], by['Marnie']['at']
    assert "Student 3's answer" in out, 'a possessive keeps its label'
    sent = [l for l in record['lines'] if l['status'] == 'sent']
    assert all(l['text'] in out for l in sent), 'every sent row, relabeled, is in what would leave (the review and Keep this line read them)'
    assert all(privacy.unmask(privacy.relabel(f, names), names).replace(' (unclear)', '') == f for v in names.values() for f in v['forms'][:1])

def test_nobody_found_is_still_a_masked_class():
    header, turns = privacy.parse_md('# NBA 6123 Quiet Class\n\n[00:10] Me: Okay, today we look at margins.')
    out, record = privacy.screen(header, turns, NAMES, ({'title': 'NBA 6123 Quiet Class', 'category': 'class'}, {'gio'}, set()))
    assert record['names'] == {} and record['counts']['masked'] == {'labels': 0, 'mentions': 0}

CONTENT = json.loads((HERE / 'fixtures' / 'class-mask-content.json').read_text())

def test_only_classmates_are_labels_companies_cases_and_words_stay():
    # A1 (2026-10-23): on the 10-22 class Corning, Google, Apple, Daimler, BATNA, ZOPA and the case Himmel and Byrne
    # were labels, so the notes lost what the class was about. Frequent, acronym, variant, ordinary, a pair after
    # "called", the invite's description, and NEVER (Goodbye) each have their case here.
    with tempfile.TemporaryDirectory() as d:
        own, protect = privacy.class_inputs(Path(d), CONTENT['event'])
    assert 'ostrava' in privacy.about_words(CONTENT['event']) and 'ostrava' not in protect, 'a capitalized word of the description protects a topic (the mask reads it, 2026-10-23 review)'
    header, turns = privacy.parse_md(CONTENT['transcript'])
    out, record = privacy.screen(header, turns, NAMES, (CONTENT['event'], own | {'gio'}, protect))
    rules = {v['name']: v['rule'] for v in record['names'].values()}
    assert rules == CONTENT['labels'], rules
    assert [s for s in CONTENT['students'] if said(s, out)] == []
    assert [k for k in CONTENT['keep'] if not said(k, out)] == []

def test_the_filters_one_by_one():
    text = CONTENT['transcript']
    assert privacy.acronym('Batna', text) and privacy.acronym('Zopa', text), 'initials said near it'
    assert not privacy.acronym('Tobin', text) and not privacy.acronym('Marnie', text)
    assert privacy.acronym('Swot', 'We drew a SWOT for the Swot (unclear) part.'), 'written in capitals somewhere'
    assert privacy.ordinary('Largely') and privacy.ordinary('Corning') and privacy.ordinary('Rain')
    assert not privacy.ordinary('Peter') and not privacy.ordinary('Isabel') and not privacy.ordinary('Dan'), 'a first name is never ordinary'
    # a word spoken to stays a classmate however often it is said; one said often, never spoken to and said like a firm
    # ("the company Vantrex") is a topic. Review r2: without that evidence six mentions are a classmate (test_r2_10).
    _, names = privacy.mask_classmates('[00:10] Them: Yes, Quillan.\n\n[00:20] Them: ' + ' '.join(['Quillan said it.'] * 8), {'category': 'class'}, {'gio'})
    assert [v['name'] for v in names.values()] == ['Quillan']
    _, names = privacy.mask_classmates('[00:10] Them: The company ' + ' '.join(['Vantrex grew.'] * 6) + ' Vantrex (unclear) grew.', {'category': 'class'}, {'gio'})
    assert names == {}, names
    _, names = privacy.mask_classmates('[00:10] Them: ' + ' '.join(['Vantrex grew.'] * 4) + ' Vantrex (unclear) grew.', {'category': 'class'}, {'gio'})
    assert [v['name'] for v in names.values()] == ['Vantrex'], 'under FREQUENT the old rules hold (privacy side)'

# Review findings (2026-10-23): each case left a classmate visible on the commit that added the A1 filters.
def labels_of(text, event=None, own=('gio',), protect=()):
    _, names = privacy.mask_classmates(text, event or {'category': 'class'}, set(own), set(protect))
    return sorted(v['name'] for v in names.values())

def test_a_dictionary_word_spoken_to_with_a_question_is_a_classmate():
    # finding 1: "Rain, could you explain?" calls someone; "Largely, yes." and "Dang, you should be here." do not.
    assert labels_of('[00:10] Them: Rain, could you explain?') == ['Rain']
    assert labels_of('[00:10] Them: Largely, yes. Dang, you should be in this class.') == []

def test_a_first_name_said_often_stays_a_classmate():
    # finding 2: the frequency rule is for companies and topics, never a recognised first name.
    assert labels_of('[00:10] Them: ' + ' '.join(['Peter said it.'] * 5) + ' Peter (unclear) said it.') == ['Peter']

def test_a_variant_spoken_to_stays_a_classmate():
    # finding 3: "Yes, Corina (unclear)." is a person even when Corning, said six times, is a company.
    text = '[00:10] Them: ' + ' '.join(['Corning grew.'] * 5) + ' Corning (unclear) grew. Yes, Corina (unclear).'
    assert labels_of(text) == ['Corina']

def test_an_invitee_or_a_classmate_spoken_to_beats_the_description():
    # finding 4: the description's words protect topics only; an invitee and a person spoken to are still classmates.
    event = {'category': 'class', 'title': 'NBA 6124 Imagined Innovation', 'attendees': 'Marnie Vale', 'description': 'Marnie will lead the discussion. Tobin opens.'}
    with tempfile.TemporaryDirectory() as d:
        own, protect = privacy.class_inputs(Path(d), event)
    assert labels_of('[00:10] Them: Marnie made a point. Yes, Tobin.', event, own | {'gio'}, protect) == ['Marnie Vale', 'Tobin']

def test_a_name_only_in_the_typed_notes_is_masked():
    # finding 5: the typed notes are searched for classmates with the transcript, so they share its labels.
    with tempfile.TemporaryDirectory() as d:
        folder = class_folder(d)
        (folder / 'my-notes.md').write_text('Yes, Zelphine. Good point on cost\n')
        with contextlib.redirect_stdout(io.StringIO()): out_md, held, record = privacy.screen_folder(folder)
        notes_md, _ = privacy.screen_notes(folder, record['names'])
        assert 'Zelphine' not in notes_md.read_text() and 'Zelphine' in [v['name'] for v in record['names'].values()]
        by = {v['name']: v for v in record['names'].values()}
        assert by['Zelphine']['at'] == ['notes'] and 'Zelphine' not in out_md.read_text()
        assert sendgate.fresh_pair(folder, CASES['event']) == (out_md, held)
        later = time.time() + 5
        os.utime(folder / 'my-notes.md', (later, later))
        assert sendgate.fresh_pair(folder, CASES['event']) is None, 'notes typed after the screen: screened again'

def test_a_title_before_a_name_needs_faculty_evidence():
    # finding 6: "Doctor Marnie (unclear)" is a classmate unless the event names Marnie as the professor.
    assert labels_of('[00:10] Them: Doctor Marnie (unclear) asked about margins.') == ['Marnie']
    assert labels_of('[00:10] Them: Doctor Marnie (unclear) asked about margins.', {'category': 'class', 'professor': 'Marnie Quell'}) == []
    assert labels_of('[00:10] Them: President Calloway (unclear) said it best.') == [], 'a public title stays a figure'
    assert labels_of('[00:10] Them: Professor Tavish (unclear) talked about it.') == [], '"Professor" names faculty'

# Review round 2 (2026-10-23): each scenario left a classmate visible, or masked content, on 081049d.
def r2_out(text, event=None, own=('gio',), protect=()):
    return privacy.mask_classmates('[00:10] Them: ' + text, event or {'category': 'class'}, set(own), set(protect))[0]

def r2_screen(body, notes='', event=None):
    header, turns = privacy.parse_md('# NBA 6123 Imagined Strategy\n\n' + body)
    out, record = privacy.screen(header, turns, NAMES, (event or {'category': 'class'}, {'gio'}, set(), notes))
    return out, privacy.relabel(notes, record['names']), record   # the typed notes go out relabeled with the map (screen_notes)

def test_r2_01_notes_never_undo_the_transcript_mask():
    # new regression: the notes searched with the transcript made "Marnie Vale" a figure and "MARNIE" an acronym
    for notes in ('Marnie Vale: cost leadership', 'MARNIE: cost leadership'):
        out, typed, _ = r2_screen('[00:10] Them: Yes, Marnie.', notes)
        assert 'Yes, Student 1.' in out, (notes, out)
        assert not re.search(r'(?i)marnie|vale', typed), (notes, typed)

def test_r2_02_a_known_name_in_capitals_is_masked():
    out = r2_out('Yes, Marnie. MARNIE made a point.', event={'category': 'class', 'names': 'Marnie Vale'})
    assert not re.search(r'(?i)marnie', out), out

def test_r2_03_a_trailing_apostrophe_possessive_is_masked():
    out = r2_out("Yes, James. James' analysis was useful. James’ conclusion was sound.")
    assert 'James' not in out and "Student 1' analysis" in out, out

def test_r2_04_accents_hyphens_and_short_names_spoken_to():
    out = r2_out('Thanks, Anne-Marie. Thanks, Renée. Thanks, Li.')
    assert not re.search(r'Anne|Marie|Renée|\bLi\b', out), out

def test_r2_05_a_full_name_never_hides_a_classmate():
    assert not re.search(r'Mary|Ann', r2_out('Thanks, Mary Ann.'))
    out = r2_out('Yes, Marnie. Marnie Vale made a point.')
    assert 'Marnie' not in out and 'Vale' not in out, out
    out = r2_out('Thanks, Anne (unclear) Marie.', event={'category': 'class', 'names': 'Anne-Marie Vale'})
    assert 'Anne' not in out and 'Marie' not in out, out

def test_r2_06_mentions_note_headings_and_nicknames():
    for notes in ('Marnie had the best answer.', '- Marnie: capacity constraint.'):
        _, typed, _ = r2_screen('[00:10] Them: Okay, today we look at margins.', notes)
        assert 'Marnie' not in typed, (notes, typed)
    out = r2_out('Elizabeth made a point. Liz agreed.', event={'category': 'class', 'names': 'Elizabeth Vale'})
    assert 'Elizabeth' not in out and 'Liz' not in out, out

def test_r2_07_thanks_for_and_an_imperative_address():
    assert 'Marnie' not in r2_out('Thanks, Marnie for explaining.')
    assert 'Marnie' not in r2_out('Marnie, explain the method.')

def test_r2_08_abbreviations_and_decimals_in_a_question():
    assert 'Rain' not in r2_out('Rain, could you compare U.S. firms?')
    assert 'Rain' not in r2_out('Rain, could you explain Exhibit 1.2?')

def test_r2_09_initials_never_veto_a_person_spoken_to():
    assert 'Bina' not in r2_out('Yes, Bina. Bring innovation near academia.')
    out = r2_out('Yes, Tobin. TOBIN wrote on the board.')
    assert not re.search(r'(?i)tobin', out), out

def test_r2_10_six_mentions_of_an_uncommon_name_stay_masked():
    out = r2_out(' '.join(['Zelphine said it.'] * 5) + ' Zelphine (unclear) said it.')
    assert 'Zelphine' not in out, out

def test_r2_11_roster_and_address_beat_dates_places_and_title_words():
    assert 'May' not in r2_out('Thanks, May.', event={'category': 'class', 'names': 'May Chen'})
    assert 'Georgia' not in r2_out('Thanks, Georgia.')
    out = r2_out('Yes, Marnie.', event={'category': 'class', 'names': 'Marnie Vale', 'title': 'Marnie Presentation'}, protect=('marnie', 'presentation'))
    assert 'Marnie' not in out, out

def test_r2_12_a_discourse_marker_before_a_question_is_no_one():
    # new regression: the question rule skipped the ordinary-word filter
    assert r2_out('However, what happens next?').endswith('However, what happens next?')
    assert r2_out('Instead, can we lower the price?').endswith('Instead, can we lower the price?')

def test_r2_13_a_polite_title_names_a_figure():
    # new regression: Mr/Mrs/Ms name a figure again; Doctor stays a classmate unless faculty (test_a_title_before_a_name_needs_faculty_evidence)
    assert 'Mr. Keynes (unclear) favored a stimulus.' in r2_out('Mr. Keynes (unclear) favored a stimulus.')
    assert 'Ms. Vale' not in r2_out('Ms. Vale, what do you think?'), 'a titled name spoken to is still a classmate'

def test_r2_14_case_names_and_frameworks_stay():
    assert 'Himmel and Byrne' in r2_out('The case was Himmel and Byrne (unclear).')
    assert 'Batna' in r2_out('We use Batna (unclear) to prepare.')

def test_r2_15_a_company_mention_of_a_classmates_name_stays():
    out = r2_out('Yes, Apple. The company Apple sells phones.')
    assert 'Yes, Student 1.' in out and 'The company Apple sells phones.' in out, out
    out = r2_out('Yes, Apple. The company Apple sells phones.', event={'category': 'class', 'names': 'Apple Vale'})
    assert 'Yes, Student 1.' in out and 'The company Apple sells phones.' in out, out

def test_r2_16_a_classmate_called_on_is_masked():
    # live run, 10-22 class at 157:09: "hear from X?", "Go X.", "Let's go X." left the name three times
    out = r2_out("Can we can we hear from Zelphine? She's dying to get in. Go Zelphine. I know you're curious. Let's go Zelphine.")
    assert 'Zelphine' not in out, out
    assert 'Rain' not in r2_out("Can we hear from Rain? Go Rain."), 'a dictionary word called on is a person too'

def test_unmask_cases_shared_with_the_app():
    for case in UNMASK['cases']:
        assert privacy.unmask(case['text'], UNMASK['names']) == case['want'], case

def class_folder(d, event=None):
    folder = Path(d) / '2026-10-21-1000-nba-6123-imagined-strategy'; folder.mkdir()
    (folder / 'event.json').write_text(json.dumps(event or CASES['event']))
    (folder / 'transcript.md').write_text(CASES['transcript'] + '\n')
    return folder

def test_a_call_that_is_not_a_class_is_screened_byte_for_byte_as_before():
    event = {**CASES['event'], 'category': 'team', 'title': 'Imagined Strategy sync'}
    header, turns = privacy.parse_md(CASES['transcript'])
    before = privacy.screen(header, turns, NAMES)
    after = privacy.screen(header, turns, NAMES, None)
    assert before == after and 'names' not in after[1] and 'Marnie' in after[0]
    with tempfile.TemporaryDirectory() as d:
        folder = class_folder(d, event)
        with contextlib.redirect_stdout(io.StringIO()): out_md, held, record = privacy.screen_folder(folder)
        assert 'names' not in json.loads(held.read_text()) and 'Marnie' in out_md.read_text(), 'team meetings keep names (Gio, 2026-10-08)'

def test_screen_folder_masks_a_class_and_an_old_pair_is_not_fresh():
    with tempfile.TemporaryDirectory() as d:
        folder = class_folder(d)
        old_md, old_held = folder / 'outbound.md', folder / 'held.json'
        old_md.write_text(CASES['transcript']); old_held.write_text(json.dumps({'counts': {}}))
        assert sendgate.fresh_pair(folder) is not None and sendgate.fresh_pair(folder, CASES['event']) is None, 'C10: a class pair with no names is screened again'
        with contextlib.redirect_stdout(io.StringIO()): out_md, held, record = privacy.screen_folder(folder)
        assert out_md.name == 'outbound-2.md' and 'Marnie' not in out_md.read_text() and 'Student 3' in out_md.read_text()
        assert json.loads(held.read_text())['names']['Student 3']['name'] == 'Marnie'
        assert sendgate.fresh_pair(folder, CASES['event']) == (out_md, held)
        # a pair screened under older mask rules is screened again (2026-10-23: Corning stayed Student 6 through a Summarize)
        stale = {**json.loads(held.read_text()), 'mask_version': '2026-10-21'}
        held.write_text(json.dumps(stale))
        assert sendgate.fresh_pair(folder, CASES['event']) is None, 'an older mask version is not fresh'
        held.write_text(json.dumps({**stale, 'mask_version': privacy.MASK_VERSION}))
        # the typed notes go out relabeled with the call's map, which held-notes.json keeps
        (folder / 'my-notes.md').write_text('Marnie had the best answer\n')
        notes_md, notes_held = privacy.screen_notes(folder, record['names'])
        assert 'Marnie' not in notes_md.read_text() and 'Student 3' in notes_md.read_text() and json.loads(notes_held.read_text())['names'] == record['names']

REPLY = ('## Discussion\n'
         '- Student 3 asked about the Rexon case [00:10] <!-- What do you think about the Rexon case -->\n'
         '- Student 4 raised the second plant [00:40] <!-- Student 4, what would you do with the second plant -->\n'
         '- Student 19 said the margins matter [03:00] <!-- the margins matter -->\n\n'
         '## Next Steps\n- Review the Rexon case before Monday [00:10] <!-- What do you think about the Rexon case -->\n')

def run_class(reply=REPLY, explain=None):
    d = tempfile.mkdtemp(prefix='class-run-')
    folder = class_folder(d)
    with contextlib.redirect_stdout(io.StringIO()): out_md, held, record = privacy.screen_folder(folder)
    prompts = []
    def ask(prompt):
        prompts.append(prompt)
        return reply, {'model': 'fake-model', 'usage': {'prompt_tokens': 10, 'completion_tokens': 5}, 'seconds': 0.1, 'auth': {}, 'finish_reason': 'stop'}
    with contextlib.redirect_stdout(io.StringIO()):
        out, run_ = byo.run(folder, 'nebius', ask=ask, screen=privacy.screen_folder, approved=hashlib.sha256(out_md.read_bytes()).hexdigest(), explain_ask=explain)
    return folder, out, run_, prompts, record

def test_the_notes_request_carries_labels_and_the_files_keep_them():
    folder, out, run_, prompts, record = run_class()
    forms = [f for v in record['names'].values() for f in v['forms']]
    assert len(prompts) == 1 and not [f for f in forms if said(f, prompts[0])], 'no classmate form in what crossed'
    assert 'Classmates are written Student 1, Student 2 and so on' in prompts[0] and 'Gio recorded it in class.' in prompts[0]
    for name in (out.name, 'summary-runs.json'):
        text = (folder / name).read_text()
        assert not [f for f in forms if said(f, text)], (name, [f for f in forms if said(f, text)])
    assert 'Student 3 asked about the Rexon case' in out.read_text()
    assert run_['privacy']['classmates'] == len(record['names'])

def test_the_check_reads_names_and_a_label_the_map_lacks_is_not_sure():
    folder, out, run_, prompts, record = run_class()
    masked_backed = run_['cited_verified']
    plain = REPLY.replace('Student 3', 'Marnie').replace('Student 4', 'Tobin')
    folder2, out2, run2, _, _ = run_class(plain)
    assert masked_backed == run2['cited_verified'], (masked_backed, run2['cited_verified'])
    nine = next(c for c in run_['checks'] if 'margins' in c['text'])
    assert not nine['backed'] or nine['reasons'], 'Student 19 is not in the map: a recording label, not sure'

def test_explain_points_carry_labels_only():
    asked = []
    def explain(prompt):
        asked.append(prompt)
        return '{"points": []}', {'model': 'fake', 'usage': {}, 'seconds': 0.1}
    folder, out, run_, prompts, record = run_class(explain=explain)
    forms = [f for v in record['names'].values() for f in v['forms']]
    assert asked and not [f for f in forms if said(f, asked[0].split('<transcript>')[0])], 'the points sent to explain carry labels'
    explained = (folder / f'{out.stem}-explain.json').read_text()
    assert not [f for f in forms if said(f, explained)]

def test_a_filed_title_naming_a_label_is_dropped():
    with tempfile.TemporaryDirectory() as d:
        folder = class_folder(d)
        lines = byo.read_md(folder / 'transcript.md')
        reply = 'Because: [00:10] "What do you think about the Rexon case"\nTitle: Student 3 and the Rexon case\nWorkstream: none\nCalendar title: fits'
        with contextlib.redirect_stdout(io.StringIO()):
            event, filing = byo.file_call(folder, CASES['event'], lines, lines, lambda p: (reply, {'model': 'fake'}), masked=True)
        assert filing.get('title_dropped') == 'names a classmate label' and event.get('title') == CASES['event']['title'], filing

def test_quotes_get_the_form_said_near_their_stamp_and_a_cut_label_goes():
    # S-B, 2026-10-21: Nemotron cut quotes after "Student", and the full invitee name is not what the room said.
    out, record = masked_case()
    with tempfile.TemporaryDirectory() as d:
        md = Path(d) / 'transcript.md'; md.write_text(CASES['transcript'] + '\n')
        lines = byo.read_md(md)
    reply = ('- Student 5 was called on [01:05] <!-- Yes, go ahead, Student -->\n'
             '- Student 1 made a point [03:30] <!-- Student 1 made a good -->\n')
    got = byo.unmask_quotes(reply, record['names'], lines)
    assert '<!-- Yes, go ahead, -->' in got or '<!-- Yes, go ahead -->' in got, got
    assert '<!-- Pella made a good -->' in got, got

def test_names_for_a_class_names_the_user():
    assert summary.names_for(CASES['event'])['me'] == 'Gio'
    assert summary.names_for({**CASES['event'], 'me': 'Me'})['me'] == 'a student'

tests = [v for k, v in list(globals().items()) if k.startswith('test_')]
for t in tests: t()
print(f'test_class_notes: {len(tests)} passed')
