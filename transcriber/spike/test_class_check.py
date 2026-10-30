# The class check (loggie-class-notes I2, docs/class-notes/spec.md eval 2.1): scripts/class-notes/check.py on a made-up
# calls folder and a made-up truth exits 0 clean, 1 on a planted leak, a lost own place and 4 content names masked in
# one class (and with --notes on a name in a notes file), 2 on a read that fails; it writes nothing, prints no name
# without --show, and its source holds no write, no network and no screen_folder. Made-up people only
# (fixtures/class-mask-cases.json); temp folders only.
#   python3 -B test_class_check.py
import json, os, re, subprocess, sys, tempfile
from pathlib import Path
HOME = tempfile.mkdtemp(prefix='class-check-home-')
os.environ['LOGGIE_HIKYAKU_HOME'] = HOME   # lexicon.own_names reads Loggie's settings: never the real ones here
sys.path.insert(0, str(Path(__file__).parent))
import privacy

HERE = Path(__file__).parent
CHECK = HERE.parent.parent / 'scripts' / 'class-notes' / 'check.py'
CASES = json.loads((HERE / 'fixtures' / 'class-mask-cases.json').read_text())
KEY = '2026-10-21-1000-nba-6123-imagined-strategy/v2-nvidia'
OTHERS = ['Calloway', 'Jack Welch', 'Enron', 'Yelen', 'Kenny Abelard', 'Rexon']
TRUTH = {'_why': 'made up', KEY: {'students': CASES['students'], 'others': OTHERS, 'own': {'name': 'Gio', 'spoken': 2, 'header': 1}}}

def calls_in(d, event=CASES['event']):
    calls = Path(d) / 'calls'
    folder = calls / KEY
    folder.mkdir(parents=True)
    (folder.parent / 'event.json').write_text(json.dumps(event))
    (folder / 'transcript.md').write_text(CASES['transcript'] + '\n')
    return calls

def run(d, truth=TRUTH, *extra, calls=None):
    t = Path(d) / 'truth.json'
    if truth is not None: t.write_text(json.dumps(truth))
    env = {**os.environ, 'LOGGIE_HIKYAKU_HOME': HOME, 'LOGGIE_DATA_DIRECTORY': str(Path(d) / 'no-data')}
    p = subprocess.run([sys.executable, '-B', str(CHECK), '--truth', str(t), '--calls', str(calls or Path(d) / 'calls'), *extra],
                       capture_output=True, text=True, env=env)
    return p.returncode, p.stdout + p.stderr

def tree(root):
    return sorted((str(p.relative_to(root)), p.stat().st_size, p.stat().st_mtime_ns) for p in Path(root).rglob('*'))

def with_truth(**entry): return {KEY: {**TRUTH[KEY], **entry}}

def test_clean_class_exits_0_prints_counts_and_writes_nothing():
    with tempfile.TemporaryDirectory() as d:
        calls_in(d)
        (Path(d) / 'truth.json').write_text(json.dumps(TRUTH))
        before = tree(d)
        code, out = run(d, None)
        assert code == 0, out
        assert tree(d) == before, 'the check wrote or touched a file'
        line = next(l for l in out.splitlines() if l.startswith(KEY))
        m = re.search(r'classmates (\d+), mentions before (\d+), left after 0, own places kept (\d+) of (\d+), labels written (\d+), content masked 0 of 6', line)
        assert m and int(m.group(2)) > 0 and m.group(3) == m.group(4) == '3' and int(m.group(5)) == len(CASES['labels']), line
        assert 'WRONG' not in out, out
        assert not [s for s in CASES['students'] if re.search(rf'\b{re.escape(s)}\b', out)], 'a name printed without --show'

def test_show_prints_the_map_on_this_mac():
    with tempfile.TemporaryDirectory() as d:
        calls_in(d)
        code, out = run(d, TRUTH, '--show')
        assert code == 0 and 'Student 1 -> Pella Varin (invitee)' in out, out

def test_a_student_the_rules_cannot_find_is_a_leak():
    with tempfile.TemporaryDirectory() as d:
        calls_in(d)
        code, out = run(d, with_truth(students=[*CASES['students'], 'Rexon'], others=[o for o in OTHERS if o != 'Rexon']))
        assert code == 1, out
        assert any(l.startswith(f'WRONG {KEY}: ') and 'left after 1' in l and '1 mention left' in l for l in out.splitlines()), out
        code, out = run(d, with_truth(students=[*CASES['students'], 'Rexon'], others=[]), '--show')
        assert '  left: Rexon' in out, out

def test_the_own_name_masked_is_a_lost_place():
    # The own name missing from class_inputs (an event with no "me", no settings): "Yes, Gio." is addressed, so masked.
    with tempfile.TemporaryDirectory() as d:
        calls_in(d, {k: v for k, v in CASES['event'].items() if k != 'me'})
        code, out = run(d)
        assert code == 1, out
        assert any(l.startswith(f'WRONG {KEY}: ') and 'own places kept 0 of 3' in l and 'own name lost 3 places' in l for l in out.splitlines()), out

def test_four_content_names_masked_in_one_class_fail_three_pass():
    taken = ['Tobin', 'Dask', 'Odric', 'Fennic']
    with tempfile.TemporaryDirectory() as d:
        calls_in(d)
        code, out = run(d, with_truth(students=[s for s in CASES['students'] if s not in taken], others=OTHERS + taken))
        assert code == 1 and '4 content names masked (at most 3)' in out and out.startswith('WRONG'), out
        code, out = run(d, with_truth(students=[s for s in CASES['students'] if s not in taken[:3]], others=OTHERS + taken[:3]))
        assert code == 0 and 'content masked 3 of 9' in out, out

def test_notes_count_the_map_names_in_the_newest_run():
    header, turns = privacy.parse_md(CASES['transcript'])
    _, record = privacy.screen(header, turns, {'me': 'Gio', 'other': None, 'people': []}, (CASES['event'], {'gio'}, {'imagined', 'strategy'}))
    with tempfile.TemporaryDirectory() as d:
        folder = calls_in(d) / KEY
        (folder / 'held.json').write_text(json.dumps({'names': record['names']}))
        runs = [{'output': 'summary-nebius.md', 'privacy': {'held_file': 'held.json'}, 'bullets': 4, 'cited_verified': 3, 'checks': [{'bullet': 'Student 3 asked about Rexon.'}]}]
        (folder / 'summary-runs.json').write_text(json.dumps(runs))
        (folder / 'summary-nebius.md').write_text('## Discussion\n- Student 3 asked about the Rexon case [00:10]\n')
        (folder / 'summary-nebius-explain.json').write_text(json.dumps({'lines': [{'said': 'Yes, Student 3.'}]}))
        code, out = run(d, TRUTH, '--notes')
        assert code == 0 and 'notes: summary-nebius.md (map of 14), forms in notes 0, summary-runs.json 0, explain 0; cited_verified 3 of 4' in out, out
        (folder / 'summary-nebius-explain.json').write_text(json.dumps({'lines': [{'said': 'Yes, Marnie.'}]}))
        code, out = run(d, TRUTH, '--notes')
        assert code == 1 and any(l.startswith(f'WRONG {KEY} notes:') and 'explain 1' in l for l in out.splitlines()), out

def test_a_read_that_fails_exits_2():
    with tempfile.TemporaryDirectory() as d:
        calls_in(d)
        code, out = run(d, None)
        assert code == 2 and 'truth file' in out and 'nothing was judged' in out, out
        (Path(d) / 'truth.json').write_text('{ not json')
        code, out = run(d, None)
        assert code == 2 and 'truth file' in out, out
        code, out = run(d, {**TRUTH, 'no-such-call': TRUTH[KEY]})
        assert code == 2 and 'no-such-call: no such folder' in out and KEY not in out.replace('no-such-call', ''), out
    with tempfile.TemporaryDirectory() as d:
        calls = calls_in(d)
        (calls / KEY / 'transcript.md').rename(calls / KEY / 'old.md')
        code, out = run(d)
        assert code == 2 and 'no transcript.md' in out, out
    with tempfile.TemporaryDirectory() as d:
        calls = calls_in(d)
        (calls / KEY).parent.joinpath('event.json').unlink()
        code, out = run(d)
        assert code == 2 and 'no event.json' in out, out

def test_newest_version_folder_is_read():
    with tempfile.TemporaryDirectory() as d:
        calls = calls_in(d)
        call = calls / KEY.split('/')[0]
        (call / 'v10-nvidia').mkdir()
        (call / 'v10-nvidia' / 'transcript.md').write_text('# NBA 6123 Imagined Strategy\n\n[00:10] Me: Okay, Rexon (unclear) and Gio.\n')
        code, out = run(d, {KEY.split('/')[0]: {'students': ['Rexon'], 'others': [], 'own': {'name': 'Gio'}}})
        assert code == 0 and 'mentions before 1, left after 0, own places kept 1 of 1' in out, out

def test_source_scan_reads_only():
    src = CHECK.read_text()
    banned = [r'write_text', r'write_bytes', r'\bmkdir\b', r'\bunlink\b', r'\brename\b', r'\.replace\(', r'\brmtree\b', r'\bcopy', r'\bsubprocess\b', r'\burllib\b', r'\bsocket\b', r'screen_folder']
    assert not [b for b in banned if re.search(b, src)], [b for b in banned if re.search(b, src)]
    assert not re.search(r"\bopen\([^)]*['\"][rbt]*[wax+]", src), 'a file opened for writing'
    assert re.search(r'privacy\.screen\(\s*\w+(?:\[[^]]+\])?,\s*\w+(?:\[[^]]+\])?,\s*\w+,\s*mask\)', src), 'the class screen (privacy.screen with the mask, so mask_classmates) is called'
    assert re.search(r'mask = \(event, ', src) and 'privacy.class_inputs(' in src, 'the mask is the class mask'

PLAN = CHECK.with_name('plan-check.py')

def long_class(minutes=150):
    # A made-up 150-minute class: the company and the acronym are said, two classmates are spoken to.
    turns = [f'[{m:02d}:00] Me: Vantrex makes glass and point {m} is about its kiln.' for m in range(minutes)]
    turns[20] = '[20:00] Me: Yes, Marnie. What is the Batna here? The best alternative to a negotiated agreement.'
    turns[140] = '[140:00] Me: Thanks, Tobin. No class next week.'
    return '# NBA 6123 Imagined Strategy\n\nThursday, October 22, 2026. Me (Gio).\n\n' + '\n\n'.join(turns) + '\n'

def test_plan_check_builds_the_parts_and_sends_nothing():
    # 2026-10-23: the notes plan check runs the class mask, then builds byo.py's requests without sending them.
    with tempfile.TemporaryDirectory() as d:
        calls = calls_in(d)
        (calls / KEY / 'transcript.md').write_text(long_class())
        truth = {KEY: {'students': ['Marnie', 'Tobin'], 'others': ['Vantrex', 'Batna'], 'own': {'name': 'Gio'}}}
        (Path(d) / 'truth.json').write_text(json.dumps(truth))
        before = tree(d)
        env = {**os.environ, 'LOGGIE_HIKYAKU_HOME': HOME, 'LOGGIE_DATA_DIRECTORY': str(Path(d) / 'no-data')}
        p = subprocess.run([sys.executable, '-B', str(PLAN), '--truth', str(Path(d) / 'truth.json'), '--calls', str(calls), '--keep', 'Vantrex,Batna'], capture_output=True, text=True, env=env)
        out = p.stdout + p.stderr
        assert p.returncode == 0, out
        assert tree(d) == before, 'the plan check wrote or touched a file'
        line = next(l for l in out.splitlines() if ' plan: ' in l)
        assert '149 minutes, 5 parts (00:00 to 29:00, 30:00 to 59:00' in line and 'about 7 headings and 50 to 75 bullets asked, keep words said 2 of 2, in the prompts 2' in line, line
        assert 'content masked 0 of 2' in out and 'left after 0' in out, out
        p = subprocess.run([sys.executable, '-B', str(PLAN), '--truth', str(Path(d) / 'truth.json'), '--calls', str(calls), '--keep', 'Marnie'], capture_output=True, text=True, env=env)
        assert p.returncode == 1 and 'Marnie masked' in p.stdout, 'a keep word that is a classmate is masked: WRONG'
    src = PLAN.read_text()
    assert not [b for b in (r'\bsubprocess\b', r'\burllib\b', r'\bsocket\b', r'screen_folder', r'ask_nebius', r'byo\.run\(') if re.search(b, src)]

tests = [v for k, v in list(globals().items()) if k.startswith('test_')]
for t in tests: t()
print(f'test_class_check: {len(tests)} passed')
