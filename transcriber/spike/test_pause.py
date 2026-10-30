# Pause and resume (loggie-pause-attach I1, 2026-10-28): call.py pause signals the recorder SIGUSR1 and keeps paused_at
# in current.json; resume signals SIGUSR2 and adds the pause to paused_s; asking for the state it is already in sends
# nothing; a recorder that is gone is said plainly; a split's stop copies pauses.json beside timing.json.
# Deterministic: a fake os.kill, a fake clock, temp folders only.
#   python3 test_pause.py   (exit 0 = pass)
import json, signal, tempfile
from pathlib import Path
import call

def with_state(state):
    root = Path(tempfile.mkdtemp())
    call.STATE = root / 'current.json'
    call.STATE.write_text(json.dumps(state))
    return root

def test_pause_then_resume():
    with_state({'pid': 4242, 'dir': '/x', 'started': 100.0})
    sent = []
    kill = lambda pid, sig: sent.append((pid, sig))
    out = call.pause(kill=kill, now=lambda: 160.0)
    assert out == {'paused': True, 'paused_s': 0}, out
    assert json.loads(call.STATE.read_text())['paused_at'] == 160.0
    out = call.pause(resume=True, kill=kill, now=lambda: 190.5)
    assert out == {'paused': False, 'paused_s': 30.5}, out
    state = json.loads(call.STATE.read_text())
    assert state['paused_at'] is None and state['paused_s'] == 30.5 and state['pid'] == 4242
    assert sent == [(4242, signal.SIGUSR1), (4242, signal.SIGUSR2)], sent
    # a second pause adds to the first
    call.pause(kill=kill, now=lambda: 200.0)
    assert call.pause(resume=True, kill=kill, now=lambda: 210.0)['paused_s'] == 40.5

def test_same_state_sends_nothing():
    with_state({'pid': 7, 'dir': '/x', 'started': 1.0})
    sent = []
    assert call.pause(resume=True, kill=lambda *a: sent.append(a), now=lambda: 5.0) == {'paused': False, 'paused_s': 0}
    call.pause(kill=lambda *a: sent.append(a), now=lambda: 5.0)
    call.pause(kill=lambda *a: sent.append(a), now=lambda: 6.0)
    assert len(sent) == 1 and json.loads(call.STATE.read_text())['paused_at'] == 5.0

def test_gone_recorder_and_nothing_recording():
    def gone(pid, sig): raise ProcessLookupError
    with_state({'pid': 7, 'dir': '/x', 'started': 1.0})
    try: call.pause(kill=gone); raise AssertionError('no exit')
    except SystemExit as e: assert 'not running' in str(e.code)
    assert 'paused_at' not in json.loads(call.STATE.read_text())
    call.STATE.unlink()
    try: call.pause(); raise AssertionError('no exit')
    except SystemExit as e: assert e.code == 'Nothing is recording.'

def test_split_stop_copies_pauses():
    root = Path(tempfile.mkdtemp())
    a, b = root / 'a', root / 'b'
    a.mkdir(); b.mkdir()
    (a / 'pauses.json').write_text('[{"from_s": 12.0, "to_s": 40.0}]')
    (a / 'timing.json').write_text('{}')
    call.STATE = root / 'current.json'
    call.STATE.write_text(json.dumps({'pid': 9, 'dir': str(a), 'started': 1.0, 'also': str(b)}))
    wrote = []
    call.write_up = lambda f, *args, **kw: wrote.append(f.name) or 0
    import live
    live.link_split = lambda folder: True
    call.stop(started=0, kill=lambda *a: None, probe=lambda *a: (_ for _ in ()).throw(ProcessLookupError()), sleep=lambda s: None, now=lambda: 0)
    assert json.loads((b / 'pauses.json').read_text()) == [{'from_s': 12.0, 'to_s': 40.0}]
    assert wrote == ['a', 'b'], wrote

if __name__ == '__main__':
    for name, fn in list(globals().items()):
        if name.startswith('test_'): fn(); print('ok', name)
