# Cloud-first C2c: the transcriber works with no language model on this Mac (there is none since 2026-10-18). A call
# prepares a pending send, screened by code and word lists only, with a header and a held.json that say so; a card
# number and an email are kept; no request is ever made, whatever an old settings.json asks for ("screenModel",
# "summaryModel", frontier "local"). Deterministic: a recording stub stands in for urllib's urlopen (no network).
#   python3 test_cloud_screen.py   (exit 0 = pass)
import contextlib, io, json, re, tempfile, urllib.error, urllib.request, wave
from pathlib import Path
import byo, call, privacy, summary, sendgate
from fixtures import sam as entry

HONEST = 'Screened on this Mac by code only: health lines are not checked'
CARD = '4111 1111 1111 1111'
EMAIL = 'sam.private@example.com'
CARD_LINE = f'My card number is {CARD} if you want to book it.'
EMAIL_LINE = f'You can reach me at {EMAIL} any time.'
ORDINARY = "Apply to the analytics role when it opens in November."

def line(t, text):
    # entry.line's words carry no spaces; the engine's words do, and lines_of joins them as they are.
    n = len(text.split())
    return {'t': t, 'end': t + 0.3 * n, 'text': text, 'words': [{**w, 'text': ' ' + w['text']} for w in entry.words(text, t)]}

TRACKS = {'me': [line(2.0, 'Hi Sam, thanks for making time today.')],
          'them': [line(8.0, f'Happy to help. {CARD_LINE} {EMAIL_LINE}'), line(30.0, f"{ORDINARY} I'll introduce you to Dana.")]}

@contextlib.contextmanager
def recording_urlopen():
    # Every urlopen the code makes lands in `seen`; each one fails like a closed port, so nothing can wait.
    seen = []
    def urlopen(req, *a, **kw):
        seen.append(getattr(req, 'full_url', req))
        raise urllib.error.URLError(ConnectionRefusedError(61, 'Connection refused'))
    with entry.patched(urllib.request, urlopen=urlopen): yield seen

def settings_file(root, **values):
    path = Path(root) / 'settings.json'
    if values: path.write_text(json.dumps(values))
    return path

def folder_with_transcript(root):
    folder = entry.folder_in(root, transcript=False)
    lines = ['# Coffee chat with Sam Lee', '', 'Monday, October 5, 2026, 14:00, 1 min. Me (Lena) and Sam Lee.', '_test transcript_', '',
             '[00:02] Me: Hi Sam, thanks for making time today.', '', f'[00:08] Sam Lee: Happy to help. {CARD_LINE} {EMAIL_LINE}', '',
             f"[00:30] Sam Lee: {ORDINARY} I'll introduce you to Dana.", '']
    (folder / 'transcript.md').write_text('\n'.join(lines))
    return folder

def test_the_screen_is_code_only_labeled_and_makes_no_request():
    for values in ({}, {'screenModel': 'off'}, {'screenModel': 'auto'}, {'screenModel': '30b'}):   # an old model setting changes nothing
        with tempfile.TemporaryDirectory() as d, recording_urlopen() as seen, entry.patched(call, SETTINGS=settings_file(d, **values)):
            out_md, held, record = privacy.screen_folder(folder_with_transcript(d))
            text = out_md.read_text()
            assert seen == [], f'a request was made: {seen}'
            assert HONEST in text and HONEST in held.read_text() and record['screened_by'] == 'code', (text, record)
            assert CARD not in text and EMAIL not in text and ORDINARY in text, text
            assert record['counts']['layer'] == {'code': record['counts']['held']} and record['counts']['held'] >= 2, record['counts']
            assert all(h['layer'] == 'code' for h in record['held'])
            assert CARD not in json.dumps(record['lines']) or all(l['status'] == 'kept' for l in record['lines'] if CARD in l['text'])

def test_the_thread_screen_is_code_only_too():
    thread = "# Re: lunch\n\n## Sam Lee · 2026-10-05T14:00:00Z\nTo: me@example.com\n\nSee you Friday. My card is " + CARD + ".\n"
    with tempfile.TemporaryDirectory() as d, recording_urlopen() as seen, entry.patched(call, SETTINGS=settings_file(d)):
        md = Path(d) / 'THREAD.md'; md.write_text(thread)
        out_md, held, record = privacy.screen_thread_file(md, me='Lena', quiet=True)
        assert seen == [] and HONEST in out_md.read_text() and CARD not in out_md.read_text() and 'See you Friday' in out_md.read_text()

def finish_with(d, **values):
    root = Path(d)
    folder = entry.folder_in(root, transcript=False)
    with wave.open(str(folder / 'them.wav'), 'wb') as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b'\x00\x00' * 16000 * 40)
    out = io.StringIO()
    with recording_urlopen() as seen, entry.patched(call, SETTINGS=settings_file(root, **values), PROFILE=root / 'profile.md', WORKSTREAMS=root / 'workstreams.json'), \
         contextlib.redirect_stdout(out):
        call.finish(folder, dict(entry.EVENT), {k: [dict(l) for l in v] for k, v in TRACKS.items()}, folder, {'version': 'v1', 'model': 'test'})
    return folder, out.getvalue(), seen

def test_a_call_prepares_a_pending_send_with_no_model_and_no_settings():
    with tempfile.TemporaryDirectory() as d:
        folder, printed, seen = finish_with(d)   # settings.json absent: frontier nebius
        assert seen == [], f'a request was made: {seen}'
        names = sorted(p.name for p in folder.iterdir())
        assert 'notes.md' not in names and 'outbound.md' in names and 'held.json' in names, names
        send = json.loads(next(Path(d).glob('runs/*/send.json')).read_text())
        assert send['status'] == 'pending' and send['sentences_kept'] >= 2, send
        outbound = (folder / 'outbound.md').read_text()
        assert HONEST in outbound and CARD not in outbound and EMAIL not in outbound and ORDINARY in outbound, outbound
        assert 'loggie.js send' in printed and 'not prepared' not in printed, printed
        events = (next(Path(d).glob('runs/*/events.jsonl'))).read_text()
        assert 'run.failed' not in events and CARD not in next(Path(d).glob('runs/*/send.json')).read_text()

def test_an_old_local_setting_prepares_the_same_send_and_asks_no_model():
    with tempfile.TemporaryDirectory() as d:
        folder, printed, seen = finish_with(d, frontier='local', summaryModel='30b', screenModel='30b')
        assert seen == [], f'a request was made: {seen}'
        names = sorted(p.name for p in folder.iterdir())
        assert 'notes.md' not in names and 'checks.json' not in names and 'outbound.md' in names, names
        assert json.loads(next(Path(d).glob('runs/*/send.json')).read_text())['status'] == 'pending' and 'loggie.js send' in printed, printed

def test_defaults_are_cloud_and_the_on_mac_model_parts_are_gone():
    with tempfile.TemporaryDirectory() as d, entry.patched(call, SETTINGS=settings_file(d)):
        assert call.frontier() == 'nebius' and byo.provider_of([]) == 'nebius'
    with tempfile.TemporaryDirectory() as d, entry.patched(call, SETTINGS=settings_file(d, frontier='local', summaryModel='30b')):
        assert call.frontier() == 'nebius' and byo.provider_of([]) == 'nebius'
    assert not hasattr(call, 'summary_setting') and not hasattr(call, 'file_on_card')
    for gone in ('MODELS', 'URL', 'choose', 'tier_for', 'server_command', 'complete', 'served', 'summarize'):
        assert not hasattr(summary, gone), f'summary.{gone} still exists'
    for gone in ('notes.py', 'guess.py', 'serve_capped.py'):
        assert not (Path(call.__file__).parent / gone).exists(), f'{gone} still exists'

def test_no_transcriber_file_reaches_a_model_on_this_mac():
    # The Python half of the JS source scan (test/hikyaku-thinker.test.js): no file the call pipeline runs names the
    # model server that used to sit on this Mac. Speech models (Parakeet, NeMo) are not language models.
    here = Path(call.__file__).parent
    pattern = re.compile(r'127\.0\.0\.1:8080|localhost:8080|mlx_lm|HIKYAKU_MODEL_URL|summaryModel|screenModel')
    offenders = [str(f.relative_to(here)) for f in sorted(here.glob('*.py')) if not f.name.startswith('test_') and pattern.search(f.read_text())]
    assert offenders == [], offenders

if __name__ == '__main__':
    import fixtures; fixtures.run(globals())
