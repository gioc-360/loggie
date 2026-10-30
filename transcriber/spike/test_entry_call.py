# Entry call tests (spec-entry-b.md, increment b#1): with the frontier setting on "nebius", the call summary comes from
# Nemotron on Nebius Token Factory through byo.py, and Loggie files the call from that cloud summary. There is no model
# on this Mac: an old frontier "local" prepares the same send. What is checked: a held sentence never reaches the
# request body; nothing is filed or sent before Send; every refusal (no
# key, an empty reply, a reply cut at the token limit, a reply from a model that is not NVIDIA, an HTTP error) writes no
# file; the key never lands in a file or in what is printed. Deterministic: no network (a fake transport stands in for
# Token Factory), no keychain (a fake `security`), no model server, a fake privacy screen, temp folders only.
# Since increment b#3a (the send gate, test_send_gate.py) finish() no longer sends: it prepares a pending send, and
# byo.py's nebius provider runs only with the approval (the sha256 of the reviewed outbound.md), which run_byo passes.
#   python3 test_entry_call.py   (exit 0 = pass)
import contextlib, hashlib, io, json, os, subprocess, tempfile, wave
from pathlib import Path
import sys
import byo, call, live, privacy
from fixtures import patched, files_under, sam   # the call these tests read: Sam Lee's coffee chat and its fakes
KEY, MODEL, REASONING, HELD, EVENT, TRACKS, TRANSCRIPT, REPLY = sam.KEY, sam.MODEL, sam.REASONING, sam.HELD, sam.EVENT, sam.TRACKS, sam.TRANSCRIPT, sam.REPLY
keychain, transport, fake_screen, folder_in, no_key_anywhere, run_byo = sam.keychain, sam.transport, sam.fake_screen, sam.folder_in, sam.no_key_anywhere, sam.run_byo

# ---------- the tests ----------

def test_a_held_sentence_never_reaches_the_request_body():
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d)
        post, sent = transport()
        code, (out, run), printed, err, asked = run_byo(folder, post)
        assert code == 0 and len(sent) >= 2 and len(asked) == 1, (code, err)   # filing (byo.file_call), the notes, then the explanations
        assert asked[0] == ['security', 'find-generic-password', '-s', 'nebius-token-factory', '-a', 'hikyaku', '-w']
        filing = json.loads(sent[0]['body'])
        assert filing['max_tokens'] == byo.FILE_MAX_TOKENS and filing['model'] == byo.NEBIUS_MODEL and HELD.encode() not in sent[0]['body'], 'filing sends outbound.md, short'
        req = sent[1]
        assert req['url'] == 'https://api.tokenfactory.nebius.com/v1/chat/completions'
        assert req['headers'] == {'Authorization': f'Bearer {KEY}', 'content-type': 'application/json'}
        body = json.loads(req['body'])
        assert set(body) == {'model', 'messages', 'max_tokens', 'temperature', 'chat_template_kwargs'} and body['model'] == MODEL and body['temperature'] == 0 and body['max_tokens'] == 16000
        assert body['chat_template_kwargs'] == {'enable_thinking': False}, 'thinking must stay off (spike R1)'
        assert len(body['messages']) == 1 and body['messages'][0]['role'] == 'user'
        prompt = body['messages'][0]['content']
        assert HELD not in prompt and HELD.encode() not in req['body'] and 'torn my ACL' not in req['body'].decode(), 'a held sentence reached the request'
        assert '[00:08] Sam Lee: Happy to help. I run the analytics team at Acme. [health kept on this Mac]' in prompt, 'the prompt is built from outbound.md'
        assert '[00:20] Lena: I\'ll send you the deck tonight' in prompt
        # the outputs: per provider, the reply's leading blank lines stripped, the reasoning never written
        assert out.name == 'summary-nebius.md' and (folder / 'summary-nebius-raw' / 'reply.md').read_text() == REPLY
        text = out.read_text()
        assert text.startswith('# Coffee chat with Sam Lee\n\n_summary by nvidia/nemotron-3-super-120b-a12b, on Nebius Token Factory; hikyaku checked it.'), text
        assert '- Send Sam the deck tonight (Lena) [00:20]\n' in text and '- Introduce Lena to Dana (Sam Lee) [00:30]\n' in text
        assert 'reading list' not in text, 'an unverified next step is dropped (no goal: the clean prompt and its strict check, B9)'
        for p in folder.rglob('*'):
            if p.is_file(): assert REASONING not in p.read_text(errors='ignore'), f'reasoning written to {p}'
        # the run record
        assert run['provider'] == 'nebius' and run['model'] == MODEL and run['output'] == 'summary-nebius.md' and run['sent'] == 'outbound.md'
        assert run['command'] == 'POST https://api.tokenfactory.nebius.com/v1/chat/completions' and run['isolation'] == 'outbound.md only, no tools'
        assert run['finish_reason'] == 'stop' and run['request_sha256'] == hashlib.sha256(req['body']).hexdigest()
        assert run['usage']['completion_tokens_details']['reasoning_tokens'] == 120 and run['auth'] == {'keychain_service': 'nebius-token-factory', 'keychain_account': 'hikyaku'}
        raw = json.loads((folder / 'summary-nebius-raw' / 'result.json').read_text())
        assert raw['model'] == MODEL and 'reasoning_content' not in raw['choices'][0]['message'] and 'reasoning' not in raw['choices'][0]['message']
        no_key_anywhere(d, printed, err)

def test_ask_nebius_returns_its_meta_keys_plus_finish_reason_and_request_hash():
    post, sent = transport()
    text, meta = byo.ask_nebius('hello', key=KEY, transport=post)
    assert text == REPLY and not text.startswith('\n')
    meta_keys = {'model', 'usage', 'cost_usd_reported', 'duration_api_ms', 'seconds', 'auth', 'session_id', 'result_json'}
    assert meta_keys | {'finish_reason', 'request_sha256'} == set(meta), sorted(meta)
    assert meta['finish_reason'] == 'stop' and meta['request_sha256'] == hashlib.sha256(sent[0]['body']).hexdigest() and meta['session_id'] == 'chatcmpl-test'
    assert KEY not in json.dumps(meta, default=str)

def refusal(root, post, key=KEY):
    # One refusing run against a folder whose screen already ran: nothing new may appear anywhere under root, and no
    # temp copy of the prompt may be left behind.
    folder = folder_in(root)
    fake_screen(folder)
    tmp = Path(root) / 'tmp'; tmp.mkdir()
    before = files_under(root)
    with patched(tempfile, tempdir=str(tmp)):
        code, result, printed, err, asked = run_byo(folder, post, key)
    assert files_under(root) == before, set(files_under(root)) ^ set(before)
    no_key_anywhere(root, printed, err)
    return code, err, asked

def test_refusals_write_no_files():
    with tempfile.TemporaryDirectory() as d:
        post, sent = transport()
        code, err, asked = refusal(d, post, key=None)
        assert code == 2 and sent == [] and len(asked) == 1, 'no key: refused before anything is sent'
        assert "service 'nebius-token-factory'" in err and "account 'hikyaku'" in err and 'could not be found' not in err
    cases = [('length', transport(finish='length'), 1, 'finish_reason length'),
             ('empty', transport(reply=''), 1, 'empty'),
             ('blank', transport(reply='  \n '), 1, 'empty'),
             ('not nvidia', transport(model='meta-llama/Llama-3.3-70B-Instruct'), 2, 'not an NVIDIA model'),
             ('http 401', transport(status=401, raw=json.dumps({'error': {'message': f'bad key {KEY}'}}).encode()), 1, 'HTTP 401'),
             ('not json', transport(raw=b'<html>gateway</html>'), 1, 'not answer in JSON')]
    for name, (post, sent), want, words in cases:
        with tempfile.TemporaryDirectory() as d:
            code, err, asked = refusal(d, post)
            # A refusal stops at the filing request; a failure costs the filing, and the notes request fails the same way.
            assert code == want and len(sent) == (1 if want == 2 else 2) and words in err, (name, code, err)
            assert KEY not in err, f'{name}: the key was in the error text'

def finish_in(d, frontier, post):
    # call.finish on the stop path (out is the call folder), with Loggie's settings, profile and workstreams pointed at
    # temp files, the screen faked, and every subprocess but the keychain a trap (so no filing can run).
    root = Path(d)
    folder = folder_in(root, transcript=False)
    with wave.open(str(folder / 'them.wav'), 'wb') as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b'\x00\x00' * 16000 * 40)
    settings = root / 'settings.json'
    if frontier is not None: settings.write_text(json.dumps({'frontier': frontier}))
    out, err = io.StringIO(), io.StringIO()
    fake_run, asked = keychain()
    with patched(call, SETTINGS=settings, PROFILE=root / 'profile.md', WORKSTREAMS=root / 'workstreams.json'), \
         patched(privacy, screen_folder=fake_screen), patched(byo, post=post), patched(byo.subprocess, run=fake_run), \
         contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        call.finish(folder, dict(EVENT), {k: [dict(l) for l in v] for k, v in TRACKS.items()}, folder, {'version': 'v1', 'model': 'test'})
    return folder, out.getvalue(), err.getvalue(), asked

def test_finish_with_frontier_nebius_prepares_and_sends_nothing():
    # Changed in b#3a: finish() used to send to Nebius and file; now it screens, records a pending send and stops.
    with tempfile.TemporaryDirectory() as d:
        post, sent = transport()
        folder, printed, err, asked = finish_in(d, 'nebius', post)
        assert sent == [] and asked == [], 'nothing leaves the Mac before Send'
        names = sorted(p.name for p in folder.iterdir())
        assert 'notes.md' not in names and 'checks.json' not in names and 'notes.raw.txt' not in names, names
        assert {'transcript.md', 'outbound.md', 'held.json'} <= set(names) and not any(n.startswith('summary-') for n in names), names
        assert len(list(Path(d).glob('runs/*/send.json'))) == 1 and 'loggie.js send' in printed, printed
        no_key_anywhere(d, printed, err)

def test_a_refused_summary_does_not_crash_the_call():
    # Changed in b#3a: the refusal now happens on the approved send (the gate runs byo.py), after finish() prepared it.
    with tempfile.TemporaryDirectory() as d:
        folder, printed, err, asked = finish_in(d, 'nebius', transport()[0])
        sha = json.loads(next(Path(d).glob('runs/*/send.json')).read_text())['sha256'][0]
        post, sent = transport(finish='length')
        code, result, printed2, err2, asked2 = run_byo(folder, post, approved=sha)
        names = sorted(p.name for p in folder.iterdir())
        assert code == 1 and len(sent) == 2 and 'transcript.md' in names and not any(n.startswith(('summary-', 'notes')) for n in names), names
        no_key_anywhere(d, printed, err, printed2, err2)

def test_an_old_local_frontier_prepares_the_same_send_and_writes_no_local_notes():
    with tempfile.TemporaryDirectory() as d:
        post, sent = transport()
        folder, printed, err, asked = finish_in(d, 'local', post)
        names = sorted(p.name for p in folder.iterdir())
        assert sent == [] and asked == [] and 'notes.md' not in names and 'checks.json' not in names and 'outbound.md' in names, names
        assert len(list(Path(d).glob('runs/*/send.json'))) == 1 and 'loggie.js send' in printed, printed

def test_filing_reads_the_cloud_summary():
    # The real calls.js, in a dry run (writes nothing, no Loggie core), on a folder that has a nebius summary and no notes.md.
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d)
        code, *_ = run_byo(folder, transport()[0])
        assert code == 0 and not (folder / 'notes.md').exists()
        js = ("import(process.argv[1]).then(async (c) => { const log = await c.fileCall({ folder: process.argv[2], core: null, workRoot: '/nowhere', dryRun: true,"
              " workstreams: [{ name: 'Acme Bank', domains: [], words: [] }] }); console.log(JSON.stringify(log)); })")
        res = subprocess.run(['node', '-e', js, str(call.LOGGIE / 'src' / 'hikyaku' / 'calls.js'), str(folder)], capture_output=True, text=True, timeout=60)
        assert res.returncode == 0, res.stderr
        log = json.loads(res.stdout)
        assert log['workstream'] == 'Acme Bank' and log['notesFrom'] == 'summary-nebius.md', log
        assert [s['title'] for s in log['steps']] == ['Send Sam the deck tonight', 'Apply to the analytics role when it opens'], log['steps']
        assert [bool(s['notSure']) for s in log['steps']] == [False, False], 'the unverified step was dropped by the strict check (B9)'
        assert log['steps'][0]['quote'] == "I'll send you the deck tonight" and log['others'] == 1
        # the unverified step was explained in one more request (byo.explain_unsure, 2026-10-12); no draft file is left behind
        assert sorted(p.name for p in folder.iterdir()) == ['event.json', 'held.json', 'outbound.md', 'summary-nebius-explain.json', 'summary-nebius-raw', 'summary-nebius.md', 'summary-runs.json', 'transcript.md']

# ---------- which prompt writes the notes (B9) ----------
# The rule: a workstream goal takes summary-goal.txt, else two or more invitees take summary-team.txt, else
# summary-clean.txt. Each route test proves which prompt file byo.py read and that every request went to Token Factory.

TEAM = {'title': 'Hackathon: readouts', 'start': '2026-10-05T18:00:00Z', 'names': 'Anya Parimala, Ivy Cho, Tomas Park', 'me': 'Lena', 'category': 'team', 'workstream': 'Hackathon'}

class Spy:
    # Stands in for one of byo's prompt-file paths and logs each read.
    def __init__(self, path, reads): self.path, self.name, self.reads = path, path.name, reads
    def read_text(self): self.reads.append(self.name); return self.path.read_text()

def routed(d, event, goal=None):
    # A call under <home>/calls/ (where goal_of looks for workstreams.json), sent the way the send gate sends it.
    home = Path(d); folder = home / 'calls' / '2026-10-05-1400-route'; folder.mkdir(parents=True)
    (home / 'workstreams.json').write_text(json.dumps([{'name': event['workstream'], **({'goal': 'Get it done', 'goalText': goal, 'goalConfirmed': True} if goal else {})}]))
    (folder / 'event.json').write_text(json.dumps(event)); (folder / 'transcript.md').write_text(TRANSCRIPT)
    post, sent = transport()
    reads = []
    spies = {k: Spy(getattr(byo, k), reads) for k in ('PROMPT_FILE', 'TEAM_PROMPT_FILE', 'GOAL_PROMPT_FILE')}
    with patched(byo, **spies): code, result, printed, err, asked = run_byo(folder, post)
    assert code == 0, (code, err)
    assert sent and all(r['url'] == 'https://api.tokenfactory.nebius.com/v1/chat/completions' and json.loads(r['body'])['model'].startswith('nvidia/') for r in sent), 'Token Factory only'
    assert asked == [['security', 'find-generic-password', '-s', 'nebius-token-factory', '-a', 'hikyaku', '-w']], 'the keychain is the only other thing asked'
    notes = json.loads(next(r['body'] for r in sent if json.loads(r['body'])['max_tokens'] == byo.NEBIUS_MAX_TOKENS))
    return set(reads), notes, result[1], result[0].read_text()

def first_line(path): return path.read_text().splitlines()[0]

def test_route_clean_a_goal_less_call_with_one_other_person():
    with tempfile.TemporaryDirectory() as d:
        reads, notes, run_, text = routed(d, EVENT)
    prompt = notes['messages'][0]['content']
    assert reads == {'summary-clean.txt'} and run_['prompt_file'] == 'summary-clean.txt', reads
    assert prompt.startswith(first_line(byo.PROMPT_FILE)) and notes['model'] == byo.NEBIUS_MODEL and run_['goal'] is None
    assert 'reading list' not in text and [x['text'] for x in run_['next_steps']['dropped']] == ['Send Sam the reading list'], 'the strict check drops an unverified step'

def test_route_team_a_goal_less_call_with_several_invitees():
    with tempfile.TemporaryDirectory() as d:
        reads, notes, run_, text = routed(d, TEAM)
    prompt = notes['messages'][0]['content']
    assert reads == {'summary-team.txt'} and run_['prompt_file'] == 'summary-team.txt', reads
    assert prompt.split('\n\n', 1)[1].startswith(first_line(byo.TEAM_PROMPT_FILE)) and notes['model'] == byo.NEBIUS_TEAM_MODEL
    assert 'People invited: Lena (who recorded it), Anya Parimala, Ivy Cho, Tomas Park.' in prompt and run_['goal'] is None
    assert 'reading list' not in text and [x['text'] for x in run_['next_steps']['dropped']] == ['Send Sam the reading list'], 'the strict check drops an unverified step'

def test_route_goal_a_call_whose_workstream_has_a_goal():
    with tempfile.TemporaryDirectory() as d:
        reads, notes, run_, text = routed(d, EVENT, goal='Get the Acme analyst offer')
    prompt = notes['messages'][0]['content']
    assert reads == {'summary-goal.txt'} and run_['prompt_file'] == 'summary-goal.txt', reads
    assert prompt.split('\n\n', 1)[1].startswith(first_line(byo.GOAL_PROMPT_FILE)) and '"Get the Acme analyst offer"' in prompt and notes['model'] == byo.NEBIUS_TEAM_MODEL
    assert 'For your goal: Get the Acme analyst offer' in text and run_['next_steps']['dropped'] == [], 'goal notes tag an unverified step instead of dropping it'

def test_route_a_goal_wins_over_the_team_readout():
    with tempfile.TemporaryDirectory() as d:
        reads, notes, run_, _ = routed(d, TEAM, goal='Win the hackathon')
    assert byo.is_team(TEAM) and reads == {'summary-goal.txt'} and run_['prompt_file'] == 'summary-goal.txt', reads
    assert '"Win the hackathon"' in notes['messages'][0]['content'] and first_line(byo.TEAM_PROMPT_FILE) not in notes['messages'][0]['content']

def test_provider_comes_from_with_else_the_frontier_setting():
    with tempfile.TemporaryDirectory() as d:
        settings = Path(d) / 'settings.json'
        with patched(call, SETTINGS=settings):
            assert byo.provider_of([]) == 'nebius' and call.frontier() == 'nebius'
            settings.write_text(json.dumps({'frontier': 'nebius'}))
            assert byo.provider_of(['x']) == 'nebius' and byo.provider_of(['x', '--with', 'nebius']) == 'nebius'
            settings.write_text(json.dumps({'frontier': 'local'}))
            assert byo.provider_of([]) == 'nebius' and call.frontier() == 'nebius', 'no model on this Mac: an old "local" thinks in the cloud'

def test_start_launches_the_live_reader_after_the_recorder_and_records_its_pid():
    # Popen is recorded, never run: the recorder is the first call, `call.py live <folder>` the second, in its own session,
    # its output in live/live.log; STATE carries both pids so stop can ask the reader to finish.
    with tempfile.TemporaryDirectory() as d:
        home = Path(d) / 'calls'; launched = []
        class Proc:
            def __init__(self, pid): self.pid = pid
            def poll(self): return None
        def popen(cmd, **kw): launched.append((cmd, kw)); return Proc(1000 + len(launched))
        out = io.StringIO()
        with patched(call, HOME=home, STATE=home / 'current.json', WORKSTREAMS=Path(d) / 'none.json', PROFILE=Path(d) / 'none.md'), \
                patched(call.subprocess, Popen=popen), patched(call.time, sleep=lambda s: None), contextlib.redirect_stdout(out):
            call.start('Coffee chat', json.dumps({'names': 'Sam Lee'}))
        folder = next(home.glob('*-coffee-chat'))
        assert len(launched) == 2, launched
        (rec, rec_kw), (reader, reader_kw) = launched
        assert rec == [str(call.HERE / 'recorder'), str(folder)]
        assert reader == [sys.executable, str(call.HERE / 'call.py'), 'live', str(folder)], reader
        assert reader_kw['start_new_session'] is True and Path(reader_kw['stdout'].name) == folder / 'live' / 'live.log' and reader_kw['stderr'] == call.subprocess.STDOUT
        state = json.loads((home / 'current.json').read_text())
        assert state['pid'] == 1001 and state['live_pid'] == 1002 and state['dir'] == str(folder), state

def test_the_live_command_runs_the_reader_on_a_folder_and_reads_the_recorders_pid_from_state():
    with tempfile.TemporaryDirectory() as d:
        folder = Path(d) / 'call'; folder.mkdir(); seen = {}
        state = Path(d) / 'current.json'; state.write_text(json.dumps({'pid': os.getpid(), 'dir': str(folder)}))
        def fake_run(f, recorder_alive=None, **kw): seen['folder'] = f; seen['alive'] = recorder_alive(); return 0
        with patched(call, STATE=state), patched(live, run=fake_run):
            assert call.live_command(str(folder)) == 0
        assert seen == {'folder': folder, 'alive': True}, seen
        state.write_text(json.dumps({'pid': 2 ** 22 + 12345, 'dir': str(folder)}))   # a pid nothing runs under
        with patched(call, STATE=state), patched(live, run=fake_run): call.live_command(str(folder))
        assert seen['alive'] is False
        state.unlink()   # no recording under this folder (a copy of a call, a hand run): only live/stop ends the reader
        with patched(call, STATE=state), patched(live, run=fake_run): call.live_command(str(folder))
        assert seen['alive'] is True

if __name__ == '__main__':
    import fixtures; fixtures.run(globals())
