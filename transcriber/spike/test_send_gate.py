# Send gate tests (spec-entry-b.md A7, increment b#3a): nothing leaves the Mac until the user picks an AI and presses
# Send. With the frontier on "nebius", call.finish() screens the call on the Mac and records a pending send (the run
# folder's send.json and events.jsonl); it never runs byo.py. byo.py's nebius provider refuses without the approval,
# and the approval is the sha256 of the exact outbound.md the user reviewed: a changed outbound.md refuses too.
# Deterministic: no network (the HTTP POST is a trap or a fake), no keychain (a trap or a fake `security`), a fake
# privacy screen, temp folders only.
#   python3 test_send_gate.py   (exit 0 = pass)
import contextlib, hashlib, io, json, re, subprocess, tempfile, wave
from pathlib import Path
import byo, call, privacy
from fixtures import events_of, sam as entry

NAMES_A_MODEL = re.compile(r'nemotron|parakeet|titanet|nvidia|nebius|token factory|claude|super|lightning|model|llm', re.I)

def post_trap(*a, **kw): raise AssertionError('a request was about to leave the Mac')
def keychain_trap(cmd, *a, **kw): raise AssertionError(f'the keychain was asked before an approval: {cmd}')
def byo_trap(*a, **kw): raise AssertionError('byo.run ran from call.finish while the frontier is nebius')

def finish_nebius(d, screen=entry.fake_screen):
    root = Path(d)
    folder = entry.folder_in(root, transcript=False)
    with wave.open(str(folder / 'them.wav'), 'wb') as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b'\x00\x00' * 16000 * 40)
    settings = root / 'settings.json'; settings.write_text(json.dumps({'frontier': 'nebius'}))
    out, err = io.StringIO(), io.StringIO()
    with entry.patched(call, SETTINGS=settings, PROFILE=root / 'profile.md', WORKSTREAMS=root / 'workstreams.json'), \
         entry.patched(privacy, screen_folder=screen), \
         entry.patched(byo, run=byo_trap, post=post_trap), entry.patched(subprocess, run=keychain_trap), \
         contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        call.finish(folder, dict(entry.EVENT), {k: [dict(l) for l in v] for k, v in entry.TRACKS.items()}, folder, {'version': 'v1', 'model': 'test'})
    return root, folder.resolve(), out.getvalue(), err.getvalue()


def test_finish_with_frontier_nebius_never_runs_byo_and_records_a_pending_send():
    with tempfile.TemporaryDirectory() as d:
        root, folder, printed, err = finish_nebius(d)
        names = sorted(p.name for p in folder.iterdir())
        assert not any(n.startswith(('summary-', 'notes')) for n in names) and 'checks.json' not in names, names
        assert {'transcript.md', 'outbound.md', 'held.json'} <= set(names), names
        runs = list((root / 'runs').iterdir())
        assert len(runs) == 1 and re.fullmatch(r'\d{8}-\d{6}-[0-9a-f]{4}', runs[0].name), runs
        send = json.loads((runs[0] / 'send.json').read_text())
        assert send['v'] == 1 and send['run'] == runs[0].name and send['status'] == 'pending' and send['what'] == 'call-notes', send
        assert send['source_ids'] == [f'call:{folder.name}'] and send['outbound'] == [str(folder / 'outbound.md')] and send['held'] == [str(folder / 'held.json')], send
        assert send['sentences_sent'] == 7 and send['sentences_kept'] == 1 and send['workstream'] == 'Acme Bank' and send['folder'] == str(folder), send
        assert send['sha256'] == [hashlib.sha256((folder / 'outbound.md').read_bytes()).hexdigest()], send
        assert entry.HELD not in json.dumps(send), 'a held sentence is in the pending send'
        # one line tells the user how to review and approve
        lines = [l for l in printed.splitlines() if l.strip()]
        tell = [l for l in lines if 'outbound.md' in l and 'send' in l and runs[0].name in l]
        assert len(tell) == 1 and 'Nothing has left your Mac' in tell[0], printed
        # the events: one per line, the envelope, seq without gaps, no text that names a model
        events = events_of(runs[0])
        # "screen finished" is last, after send.json: the app's automatic yes starts on it and reads the send (2026-10-22)
        assert [e['type'] for e in events] == ['run.started', 'step.started', 'screen.line', 'screen.summary', 'step.finished'], events
        assert [e['seq'] for e in events] == [1, 2, 3, 4, 5] and all(e['v'] == 1 and e['run'] == runs[0].name and set(e) == {'v', 'run', 'seq', 'at', 'type', 'step', 'text', 'data'} for e in events)
        assert events[0]['data'] == {'source': 'call', 'title': 'Coffee chat with Sam Lee', 'workstream': 'Acme Bank'}
        assert events[1]['step'] == 'screen' and events[1]['text'] == 'Screening on your Mac' and events[4]['data']['ok'] is True
        # the kept sentence as a screen.line, with its plain reason; the record has no lines[], so only kept lines
        assert events[2]['data']['status'] == 'kept' and events[2]['data']['text'] == entry.HELD and events[2]['data']['reason'] == 'a health detail', events[2]
        assert events[3]['data']['counts']['held'] == 1 and events[3]['data']['source_id'] == f'call:{folder.name}' and events[3]['data']['lines'] == 1
        for e in events: assert not (e['text'] and NAMES_A_MODEL.search(e['text'])), e

def test_a_screen_that_cannot_run_prepares_nothing_and_keeps_the_transcript():
    def down(folder): raise SystemExit('privacy screen refused to run: no server; nothing written')
    with tempfile.TemporaryDirectory() as d:
        root, folder, printed, err = finish_nebius(d, screen=down)
        assert 'transcript.md' in [p.name for p in folder.iterdir()]
        assert not list(root.glob('runs/*/send.json')), 'no pending send without a screen'
        assert 'Nothing has left your Mac' in printed and 'call.py' in printed and ' prepare ' in printed, printed
        events = [e for r in root.glob('runs/*') for e in events_of(r)]
        assert events and events[-1]['type'] == 'run.failed' and events[-1]['data']['step'] == 'screen', events

def screened_folder(d):
    folder = entry.folder_in(d)
    entry.fake_screen(folder)
    return folder, hashlib.sha256((folder / 'outbound.md').read_bytes()).hexdigest()

def refused(folder, provider='nebius', go=None, **kw):
    # byo.run (or `go`, a byo.main command line) with every way out trapped: returns (exit code, stderr) and asserts
    # nothing new was written.
    before = entry.files_under(folder)
    err, code = io.StringIO(), 0
    with entry.patched(byo, post=post_trap), entry.patched(byo.subprocess, run=keychain_trap), contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
        try: go() if go else byo.run(folder, provider, screen=entry.fake_screen, **kw)
        except SystemExit as e: code = e.code if isinstance(e.code, int) else 1; err.write(str(e.code))
    assert entry.files_under(folder) == before, set(entry.files_under(folder)) ^ set(before)
    return code, err.getvalue()

def test_byo_nebius_refuses_without_the_approval():
    with tempfile.TemporaryDirectory() as d:
        folder, sha = screened_folder(d)
        code, err = refused(folder)
        assert code == 2 and 'Nothing was sent' in err, (code, err)

def test_an_old_pick_of_another_ai_reads_as_not_approved():
    # B7 D1, B8: a call folder, pending send or settings.json that still names claude (or codex, agy) is not a yes to
    # Nebius, even with an approval that matches the reviewed outbound.md: exit 2 before the keychain, the screen or the
    # network, nothing written, nothing sent.
    with tempfile.TemporaryDirectory() as d:
        folder, sha = screened_folder(d)
        for old in ('claude', 'codex', 'agy'):
            code, err = refused(folder, old, approved=sha)
            assert code == 2 and 'not approved' in err and 'Nothing was sent' in err, (old, code, err)
        # the command lines an old pending send, or explain on notes it wrote, would run
        code, err = refused(folder, go=lambda: byo.main([str(folder), '--with', 'claude', '--approved', sha]))
        assert code == 2 and 'not approved' in err, (code, err)
        (folder / 'summary-runs.json').write_text(json.dumps([{'provider': 'claude', 'output': 'summary-claude.md', 'checks': [{'text': 'x', 'backed': False, 'reasons': ['not found']}]}]))
        (folder / 'summary-claude.md').write_text('# x\n\n## A\n- x [00:10] (not sure)\n')
        code, err = refused(folder, go=lambda: byo.main(['explain', str(folder), '--with', 'claude', '--approved', sha]))
        assert code == 2 and 'not approved' in err, (code, err)
        # settings.json "frontier": "claude" and no --with
        settings = Path(d) / 'settings.json'; settings.write_text(json.dumps({'frontier': 'claude'}))
        with entry.patched(call, SETTINGS=settings):
            code, err = refused(folder, go=lambda: byo.main([str(folder), '--approved', sha]))
        assert code == 2 and 'not approved' in err, (code, err)

def test_byo_nebius_refuses_when_outbound_changed_since_the_review():
    with tempfile.TemporaryDirectory() as d:
        folder, sha = screened_folder(d)
        code, err = refused(folder, approved='0' * 64)
        assert code == 2 and 'changed' in err and 'Nothing was sent' in err, (code, err)

def test_byo_nebius_sends_the_reviewed_outbound_once_approved():
    with tempfile.TemporaryDirectory() as d:
        folder, sha = screened_folder(d)
        post, sent = entry.transport()
        code, result, printed, err, asked = entry.run_byo(folder, post, approved=sha)
        assert code == 0 and len(sent) >= 2 and len(asked) == 1, (code, err)   # filing, the notes, then the goal passes
        assert all(entry.HELD.encode() not in s['body'] for s in sent)
        assert (folder / 'summary-nebius.md').exists()

def test_byo_cli_reads_the_approval_flag():
    # The command line the gate runs: python3 byo.py <folder> --with nebius --approved <sha256>. In process, trapped.
    with tempfile.TemporaryDirectory() as d:
        folder, sha = screened_folder(d)
        seen = []
        with entry.patched(byo, run=lambda *a, **kw: seen.append((a, kw))):
            byo.main([str(folder), '--with', 'nebius', '--approved', sha])
            byo.main([str(folder), '--with', 'nebius'])
        assert seen[0][0] == (str(folder), 'nebius') and seen[0][1]['approved'] == sha, seen
        assert seen[1][0] == (str(folder), 'nebius') and seen[1][1]['approved'] is None, seen

def privacy_notes_code(folder):
    # privacy.screen_notes, code and word lists: the health line is held, the rest goes.
    return privacy.screen_notes(folder)

def test_typed_notes_are_screened_and_carry_their_own_hash_in_the_send():
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        folder = entry.folder_in(root)
        entry.fake_screen(folder)
        (folder / 'my-notes.md').write_text('Sam wants the deck by Friday\n\nMy knee surgery is next week so I cannot travel\n')
        import sendgate
        with contextlib.redirect_stdout(io.StringIO()):
            send = sendgate.prepare_call(root, folder, dict(entry.EVENT))
        out = folder / 'outbound-notes.md'
        assert send['outbound'] == [str(folder.resolve() / 'outbound.md'), str(out.resolve())], send['outbound']
        assert send['sha256'][1] == hashlib.sha256(out.read_bytes()).hexdigest() and len(send['sha256']) == 2
        assert 'deck by Friday' in out.read_text() and 'knee surgery' not in out.read_text(), out.read_text()
        assert privacy.notes_lines(out.read_text())[0] == 'Sam wants the deck by Friday'
        # empty notes leave no pair, so nothing of them can go
        (folder / 'my-notes.md').write_text('   \n')
        assert privacy_notes_code(folder) is None and not out.exists()

def test_the_screen_line_and_the_send_say_how_many_classmates_left_as_labels():
    # loggie-class-notes I3 (spec 1.8): a class's screen.summary adds the classmates clause and send.json carries
    # `classmates`, both only when counts.masked.labels > 0; every other call reads exactly as before.
    import sendgate
    for masked, clause, classmates in ((None, '', None), ({'labels': 0, 'mentions': 0}, '', None),
                                       ({'labels': 7, 'mentions': 19}, ', 7 classmates written as Student 1 to 7', 7),
                                       ({'labels': 1, 'mentions': 2}, ', 1 classmate written as Student 1', 1)):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            folder = entry.folder_in(root)
            entry.fake_screen(folder)
            held = folder / 'held.json'
            record = json.loads(held.read_text())
            if masked is not None: record['counts']['masked'] = masked; record['names'] = {}
            held.write_text(json.dumps(record))
            with contextlib.redirect_stdout(io.StringIO()):
                send = sendgate.prepare_call(root, folder, dict(entry.EVENT))
            summary = [e for e in events_of(root / 'runs' / send['run']) if e['type'] == 'screen.summary'][0]
            counts = record['counts']
            assert summary['text'] == f"{counts['sent']} sentences cleared, {counts['held']} kept on this Mac{clause}", summary['text']
            assert send.get('classmates') == classmates, send
    assert sendgate.summary_text({'sent': 585, 'held': 2, 'masked': {'labels': 7, 'mentions': 31}}) == '585 sentences cleared, 2 kept on this Mac, 7 classmates written as Student 1 to 7'

def test_an_interview_says_how_many_people_left_by_first_name_and_an_untrimmed_pair_is_screened_again():
    # loggie-interview-privacy: the screen.summary clause and send.json `trimmed`; a pair with no "trimmed" map (every
    # interview pair written before 2026-10-26) or an old trim version is not fresh, so its surnames never leave.
    import sendgate
    assert sendgate.summary_text({'sent': 723, 'held': 5, 'trimmed': {'people': 4, 'mentions': 13}}) == '723 sentences cleared, 5 kept on this Mac, 4 people by first name only'
    assert sendgate.summary_text({'sent': 9, 'held': 0, 'trimmed': {'people': 1, 'mentions': 1}}) == '9 sentences cleared, 0 kept on this Mac, 1 person by first name only'
    assert sendgate.summary_text({'sent': 9, 'held': 0, 'trimmed': {'people': 0, 'mentions': 0}}) == '9 sentences cleared, 0 kept on this Mac'
    interview = {**entry.EVENT, 'title': 'Mock interview'}
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        folder = entry.folder_in(root)
        out_md, held, _ = entry.fake_screen(folder)
        out_md, held = out_md.resolve(), held.resolve()
        assert sendgate.fresh_pair(folder, dict(entry.EVENT)) == (out_md, held), 'any other call: as before'
        assert sendgate.fresh_pair(folder, interview) is None, 'no map: screened again'
        record = json.loads(held.read_text())
        held.write_text(json.dumps({**record, 'trimmed': {}, 'trim_version': 'old'}))
        assert sendgate.fresh_pair(folder, interview) is None, 'an old trim version: screened again'
        held.write_text(json.dumps({**record, 'trimmed': {}, 'trim_version': privacy.TRIM_VERSION}))
        assert sendgate.fresh_pair(folder, interview) == (out_md, held)
        (folder.parent / 'event.json').write_text(json.dumps(interview))
        with contextlib.redirect_stdout(io.StringIO()):
            send = sendgate.prepare_call(root, folder, interview)
        assert send['outbound'] == [str(out_md)], 'a fresh trimmed pair is reused'

def test_byo_sends_the_notes_only_with_their_yes_and_refuses_changed_ones():
    with tempfile.TemporaryDirectory() as d:
        folder, sha = screened_folder(d)
        (folder / 'my-notes.md').write_text('Sam wants the deck by Friday\n')
        privacy_notes_code(folder)
        notes_sha = hashlib.sha256((folder / 'outbound-notes.md').read_bytes()).hexdigest()
        post, sent = entry.transport()
        code, result, printed, err, asked = entry.run_byo(folder, post, approved=sha, approved_notes=notes_sha)
        assert code == 0, err
        bodies = [s['body'].decode() if isinstance(s['body'], bytes) else s['body'] for s in sent]
        assert any('<my_notes>' in b and 'deck by Friday' in b for b in bodies), 'the approved notes are in the summary prompt'
        # no yes for the notes: they stay out of every request
        post2, sent2 = entry.transport()
        code, *_ = entry.run_byo(folder, post2, approved=sha)
        assert code == 0 and not any('deck by Friday' in (s['body'].decode() if isinstance(s['body'], bytes) else s['body']) for s in sent2)
        # notes changed after the yes: refused, nothing sent
        (folder / 'my-notes.md').write_text('Something else\n'); privacy_notes_code(folder)
        code, err = refused(folder, approved=sha, approved_notes=notes_sha)
        assert code == 2 and 'notes changed' in err, (code, err)

def test_byo_cli_reads_the_notes_approval_flag():
    with tempfile.TemporaryDirectory() as d:
        folder, sha = screened_folder(d)
        seen = []
        with entry.patched(byo, run=lambda *a, **kw: seen.append(kw)):
            byo.main([str(folder), '--with', 'nebius', '--approved', sha, '--approved-notes', 'f' * 64])
        assert seen[0]['approved'] == sha and seen[0]['approved_notes'] == 'f' * 64, seen

if __name__ == '__main__':
    import fixtures; fixtures.run(globals())
