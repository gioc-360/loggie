# The packaged app (cloud-first C7): the transcriber runs from inside Loggie.app on a Mac with no developer tools.
# What is checked: ffmpeg comes from HIKYAKU_FFMPEG when the app sets it (one place, tools.py, used by every call to it);
# and a call with named invitees keeps "Them" and writes no speakers.json. Deterministic: no recorder, no model, no
# ffmpeg run, temp folders only.
#   python3 test_runtime_paths.py   (exit 0 = pass)
import contextlib, importlib, io, os, re, tempfile, wave
from pathlib import Path
import call, tools
from fixtures import patched

HERE = Path(__file__).parent

def test_ffmpeg_is_the_apps_when_the_app_sets_it_and_plain_ffmpeg_otherwise():
    old = os.environ.pop('HIKYAKU_FFMPEG', None)
    try:
        assert importlib.reload(tools).FFMPEG == 'ffmpeg'
        os.environ['HIKYAKU_FFMPEG'] = '/Applications/Loggie.app/Contents/Resources/bin/ffmpeg'
        assert importlib.reload(tools).FFMPEG == '/Applications/Loggie.app/Contents/Resources/bin/ffmpeg'
    finally:
        os.environ.pop('HIKYAKU_FFMPEG', None)
        if old is not None: os.environ['HIKYAKU_FFMPEG'] = old
        importlib.reload(tools)

def test_loggie_is_the_apps_when_set_and_the_repo_it_sits_in_otherwise():
    # Cleanup audit bug 11: unset, it used to fall back to ~/Loggie-cloud, a folder that no longer exists.
    old = os.environ.pop('LOGGIE_DIR', None)
    try:
        assert (importlib.reload(call).LOGGIE / 'bin' / 'loggie.js').exists()
        os.environ['LOGGIE_DIR'] = '/Applications/Loggie.app/Contents/Resources/app'
        assert str(importlib.reload(call).LOGGIE) == '/Applications/Loggie.app/Contents/Resources/app'
    finally:
        os.environ.pop('LOGGIE_DIR', None)
        if old is not None: os.environ['LOGGIE_DIR'] = old
        importlib.reload(call)

def test_no_call_to_ffmpeg_names_it_bare():
    for name in ('call.py', 'nvidia_engine.py', 'transcript.py'):
        text = (HERE / name).read_text()
        assert not re.search(r"\[\s*'ffmpeg'", text), f"{name} starts a bare ffmpeg; use tools.FFMPEG"
    for name in ('call.py', 'nvidia_engine.py'):
        assert 'tools.FFMPEG' in (HERE / name).read_text(), f'{name} does not use tools.FFMPEG'

def test_a_call_with_named_invitees_keeps_them():
    with tempfile.TemporaryDirectory() as d:
        root = Path(d); folder = root / '2026-10-05-1400-coffee-chat'; folder.mkdir()
        with wave.open(str(folder / 'them.wav'), 'wb') as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b'\x00\x00' * 16000)
        event = {'title': 'Coffee chat', 'start': '2026-10-05T18:00:00Z', 'emails': ['sam@example.com'], 'names': 'Sam Lee', 'attendees': 'Sam Lee', 'me': 'Lena', 'with': 'Sam Lee', 'category': 'one-on-one'}
        line = lambda t, text: {'t': t, 'end': t + 2, 'text': text, 'words': [{'text': w, 'p': 0.99, 'start': t, 'end': t + 0.2} for w in text.split()]}
        tracks = {'me': [line(2.0, 'Hi Sam, thanks for making time.')], 'them': [line(8.0, 'Happy to help with that.')]}
        (root / 'spike').mkdir()
        out = io.StringIO()
        with patched(call, HERE=root / 'spike', PROFILE=root / 'profile.md', WORKSTREAMS=root / 'workstreams.json', SETTINGS=root / 'settings.json'), contextlib.redirect_stdout(out):
            lines = call.finish(folder, event, tracks, folder, {'version': 'v1', 'model': 'test'}, with_notes=False)
        assert [l.get('speaker', 'Them') for l in lines if l['who'] == 'Them'] == ['Them']
        assert not (folder / 'speakers.json').exists(), out.getvalue()

if __name__ == '__main__':
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith('test_') and callable(f)]
    for name, fn in tests: fn(); print('ok', name)
    print(f'{len(tests)} passed')
