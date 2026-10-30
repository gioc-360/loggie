# The fixtures the spike tests share: the runner every test file ends with, the fakes several files patch in, the
# live reader's CAF and words files, and two made-up calls (Priya's coffee chat for byo.py, Sam Lee's entry call for
# call.py's cloud path). They lived in test_byo.py, test_entry_call.py and test_live.py, so importing a fixture meant
# importing a test file. Beside the fixtures/ data folder: Python takes this file first, as a folder with no __init__.py.
import contextlib, hashlib, io, json, struct, subprocess
from pathlib import Path
from types import SimpleNamespace

def run(scope):
    # The plain-script runner: every test_ function of the file, in name order, then the count. Exit 0 = pass.
    tests = [v for k, v in sorted(scope.items()) if k.startswith('test_')]
    for t in tests: t()
    print(f'{len(tests)} passed')

# ---------- fakes ----------

@contextlib.contextmanager
def patched(obj, **attrs):
    old = {k: getattr(obj, k) for k in attrs}
    for k, v in attrs.items(): setattr(obj, k, v)
    try: yield
    finally:
        for k, v in old.items(): setattr(obj, k, v)

def files_under(root): return sorted(str(p.relative_to(root)) for p in Path(root).rglob('*'))

def events_of(run_dir): return [json.loads(l) for l in (Path(run_dir) / 'events.jsonl').read_text().splitlines() if l.strip()]

# ---------- the live reader: a CAF the recorder would write, and its words files ----------

def caf_bytes(samples, rate=48000, flags=3, bits=32, channels=1, data_at=0xff0):
    # The B20 layout: file header, desc, a free chunk padding to data_at, data with size -1, a 4-byte edit count, frames.
    bpp = channels * bits // 8
    head = b'caff' + struct.pack('>HH', 1, 0) + b'desc' + struct.pack('>q', 32) + struct.pack('>d', rate) + b'lpcm' + struct.pack('>IIIII', flags, bpp, 1, channels, bits)
    free = b'free' + struct.pack('>q', data_at - len(head) - 12) + bytes(data_at - len(head) - 12)
    return head + free + b'data' + struct.pack('>q', -1) + struct.pack('>I', 0) + samples

def tone(seconds, rate=48000, amp=0.3, quiet=()):
    import numpy as np   # here, not at the top: only the audio tests need numpy
    # 440 Hz float32 LE; `quiet` is a list of (from, to) seconds left silent
    t = np.arange(int(seconds * rate)) / rate
    x = (amp * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    for a, b in quiet: x[int(a * rate):int(b * rate)] = 0
    return x

def write_caf(path, x, **kw): Path(path).write_bytes(caf_bytes(x.astype('<f4').tobytes(), **kw))

def W(text, t0=0.0, step=0.5):
    return [{'text': ' ' + w, 'start': round(t0 + i * step, 2), 'end': round(t0 + i * step + 0.3, 2), 'p': 1.0} for i, w in enumerate(text.split())]

RUN = {'seconds': 0.6, 'peak_gb': 1.4}

def put(folder, name, lines):
    d = Path(folder) / 'live'; d.mkdir(exist_ok=True)
    with open(d / name, 'a') as f:
        for l in lines: f.write(json.dumps(l) + '\n')

def speech(seconds, rate=16000, rests=()):
    # 440 Hz with a one-second rest in every three (speech has pauses: a floor from the 20th percentile needs them), plus `rests`
    x = tone(seconds, rate=rate)
    for a in range(2, int(seconds), 3): x[a * rate:(a + 1) * rate] = 0
    for a, b in rests: x[int(a * rate):int(b * rate)] = 0
    return x

# ---------- the two calls ----------
# Each is built on first use (__getattr__ below), so a test that wants only run() never imports byo or privacy.

def _priya():
    # test_byo.py's call: Priya's coffee chat, its reply, and a fake screen that holds one sentence of [15:43].
    import byo, privacy
    EVENT = {'names': 'Priya Shah', 'title': 'Priya & Gio - Coffee Chat', 'start': '2026-10-07T15:00:00Z', 'attendees': 'Priya Shah', 'me': 'Gio', 'with': 'Priya Shah', 'category': 'one-on-one'}

    TRANSCRIPT = """# Priya & Gio - Coffee Chat

Wednesday, October 7, 2026, 11:00, 24 min. Me (Gio) and Priya Shah.
_model, v2-context. A word marked (unclear) is a name Whisper was not sure of._

[04:09] Priya Shah: Hey, Giio (unclear). Good morning.

[04:49] Priya Shah: I'm Priya Shah. I'm a first-year MBA student at Cornell Johnson. Before Cornell, I worked at Citi, Morris (unclear) Dandy (unclear), and Bank of America, and most recently at CDBC Bank USA.

[06:30] Priya Shah: In Bank of America and in Citi (unclear), I work as a treasury services analyst. I have to report to Taiwan's CBC for the payment purpose every day.

[07:24] Me: I'm Gio. For my summer internship, I went to Dell. I was a software product manager. I built a platform that connected all of their costs and revenue per program.

[15:43] Me: I applied to Dell in like September 17 of last year. And but Dell (unclear) wasn't like in my radar at all.

[21:33] Me: The biggest gap, I would say, if you haven't really built anything, I would say start building now using AI, because those will become talking points.

[23:19] Me: Well, email me if you have any follow-ups, you know, I'm always happy to chat.
"""

    REPLY = """# Priya & Gio - Coffee Chat

## Priya's Background
- First-year MBA at Cornell Johnson [04:49] <!-- first-year MBA student at Cornell Johnson -->
  - Prior roles at Citi, Morris Dandy (unclear) and Bank of America, then CDBC Bank USA [04:49] <!-- Citi, Morris Dandy, and Bank of America -->
  - Day-to-day as a treasury services analyst: reports to Taiwan's CBC every day [06:30] <!-- report to Taiwan's CBC -->
- Worked at Morgan Stanley before Bank of America [04:49] <!-- and Bank of America -->
- Them explained the role to you [06:30] <!-- treasury services analyst -->

## Gio's Background
- Dell internship as a software product manager: a platform connecting costs and revenue per program [07:24] <!-- connected all of their costs and revenue -->
- Me applied to Dell on September 17 [15:43] <!-- applied to Dell in like September 17 -->
- Gio rowed for Cornell in 2019 [07:24] <!-- rowed for Cornell -->
- Gio stays marked in the summary and keeps its heard spelling [07:24] <!-- I'm Gio -->

## Next Steps
- Start building something with AI tools (Priya Shah) [21:33] <!-- start building now using AI -->
- Email Gio with any follow-up questions by Friday (Priya Shah) [23:19] <!-- email me if you have any follow-ups -->
- Send Priya the Dell framework deck (Gio) [22:00] <!-- send the deck -->
"""

    def fake(reply=REPLY):
        calls = []
        def ask(prompt):
            calls.append(prompt)
            return reply, {'model': 'fake-model', 'usage': {'prompt_tokens': 10, 'completion_tokens': 5}, 'cost_usd_reported': 0.0, 'duration_api_ms': 5, 'seconds': 0.1, 'auth': {}, 'finish_reason': 'stop'}
        return ask, calls

    def folder_in(d, event=EVENT, transcript=TRANSCRIPT):
        folder = Path(d) / 'v2-context'; folder.mkdir()
        (folder.parent / 'event.json').write_text(json.dumps(event))
        (folder / 'transcript.md').write_text(transcript)
        return folder

    HELD = 'And but Dell (unclear) wasn\'t like in my radar at all.'   # the sentence the fake screen keeps on the Mac

    def fake_screen(folder):
        # A stand-in for the privacy screen: one sentence of [15:43] is held under "health", the rest goes.
        # Writes the same pair privacy.py writes, with the same never-overwrite naming.
        folder = Path(folder)
        out_md, held = privacy.free_pair(folder)
        text = folder.joinpath('transcript.md').read_text().replace(HELD, '[health kept on this Mac]')
        out_md.write_text(text)
        record = {'screened_by': 'code', 'counts': {'sentences': 13, 'sent': 12, 'held': 1, 'layer': {'code': 1}, 'category': {'health': 1}},
                  'held': [{'i': 7, 'time': '15:43', 'speaker': 'Me', 'category': 'health', 'layer': 'code', 'rule': 'injury', 'text': HELD}]}
        held.write_text(json.dumps(record))
        return out_md, held, record

    def masked_screen(folder):
        # fake_screen for a class after loggie-class-notes: the same pair with an empty classmates map.
        out_md, held, record = fake_screen(folder)
        record = {**record, 'names': {}}
        held.write_text(json.dumps(record))
        return out_md, held, record

    def approve(folder, screen=None):
        # The send gate's yes: the screen ran on the Mac (here the fake one) and the approval names the outbound.md it wrote.
        out_md, _, _ = (screen or fake_screen)(folder)
        return hashlib.sha256(out_md.read_bytes()).hexdigest()
    return SimpleNamespace(**locals())

def _sam():
    # test_entry_call.py's call: Sam Lee's coffee chat, the Token Factory and keychain fakes, and run_byo, the send
    # gate's way of calling byo.run.
    import byo, privacy
    KEY = 'tf-test-KEY-0000'   # fake; the real key lives in the keychain and no test reads it
    MODEL = 'nvidia/nemotron-3-super-120b-a12b'
    REASONING = 'PRIVATE-REASONING-never-written'   # the reply's reasoning fields are ignored and never written
    HELD = 'I might have torn my ACL skiing last week.'   # the sentence the fake screen keeps on the Mac

    EVENT = {'title': 'Coffee chat with Sam Lee', 'start': '2026-10-05T18:00:00Z', 'emails': ['sam@example.com'], 'names': 'Sam Lee', 'attendees': '',
             'me': 'Lena', 'with': 'Sam Lee', 'category': 'one-on-one', 'workstream': 'Acme Bank', 'them_label': 'Sam Lee'}

    def words(text, t0):
        return [{'text': w, 'p': 0.99, 'start': round(t0 + i * 0.3, 2), 'end': round(t0 + i * 0.3 + 0.25, 2)} for i, w in enumerate(text.split())]

    def line(t, text): return {'t': t, 'end': t + 0.3 * len(text.split()), 'text': text, 'words': words(text, t)}

    TRACKS = {'me': [line(2.0, 'Hi Sam, thanks for making time today.'), line(20.0, "I'll send you the deck tonight after class.")],
              'them': [line(8.0, f'Happy to help. I run the analytics team at Acme. {HELD}'), line(30.0, "Apply to the analytics role when it opens in November. I'll introduce you to Dana.")]}

    TRANSCRIPT = f"""# Coffee chat with Sam Lee

Monday, October 5, 2026, 14:00, 1 min. Me (Lena) and Sam Lee.
_test transcript_

[00:02] Me: Hi Sam, thanks for making time today.

[00:08] Sam Lee: Happy to help. I run the analytics team at Acme. {HELD}

[00:20] Me: I'll send you the deck tonight after class.

[00:30] Sam Lee: Apply to the analytics role when it opens in November. I'll introduce you to Dana.
"""

    REPLY = """# Coffee chat with Sam Lee

## Sam's Work
- Runs the analytics team at Acme [00:08] <!-- I run the analytics team at Acme -->

## Next Steps
- Send Sam the deck tonight (Lena) [00:20] <!-- I'll send you the deck tonight -->
- Apply to the analytics role when it opens (Lena) [00:30] <!-- Apply to the analytics role when it opens -->
- Introduce Lena to Dana (Sam Lee) [00:30] <!-- I'll introduce you to Dana -->
- Send Sam the reading list (Lena) [00:25] <!-- I will send the reading list -->
"""

    # ---------- fakes ----------

    def keychain(key=KEY):
        # A fake `security find-generic-password ... -w`: the key on stdout, or "not found" (exit 44) when key is None.
        # Anything other than `security` reaching subprocess.run during a test is a failure.
        asked = []
        def run(cmd, *a, **kw):
            assert cmd[0] == 'security', f'only the keychain may be asked here, not {cmd[0]}'
            asked.append(cmd)
            if key is None: return subprocess.CompletedProcess(cmd, 44, '', 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n')
            return subprocess.CompletedProcess(cmd, 0, key + '\n', '')
        return run, asked

    def transport(reply=REPLY, model=MODEL, finish='stop', status=200, raw=None):
        # Token Factory's OpenAI-compatible reply (spikes/tf-first-call-*.json): content starts with "\n\n", the reasoning
        # rides along in its own fields.
        sent = []
        def post(url, headers, body):
            sent.append({'url': url, 'headers': dict(headers), 'body': body})
            if raw is not None: return status, raw
            message = {'role': 'assistant', 'content': ('\n\n' + reply) if reply else reply, 'reasoning_content': REASONING, 'reasoning': REASONING}
            return status, json.dumps({'id': 'chatcmpl-test', 'object': 'chat.completion', 'model': model, 'choices': [{'index': 0, 'finish_reason': finish, 'message': message}],
                                       'usage': {'prompt_tokens': 900, 'completion_tokens': 300, 'total_tokens': 1200, 'completion_tokens_details': {'reasoning_tokens': 120}}}).encode()
        return post, sent

    def fake_screen(folder):
        # A stand-in for privacy.py's pair: the health sentence is held, everything else goes.
        folder = Path(folder)
        out_md, held = privacy.free_pair(folder)
        out_md.write_text(folder.joinpath('transcript.md').read_text().replace(HELD, '[health kept on this Mac]'))
        record = {'screened_by': 'code', 'counts': {'sentences': 8, 'sent': 7, 'held': 1, 'layer': {'code': 1}, 'category': {'health': 1}},
                  'held': [{'i': 4, 'time': '00:08', 'speaker': 'Sam Lee', 'category': 'health', 'layer': 'code', 'rule': 'injury', 'text': HELD}]}
        held.write_text(json.dumps(record))
        return out_md, held, record

    def folder_in(root, transcript=True):
        folder = Path(root) / '2026-10-05-1400-coffee-chat-with-sam-lee'; folder.mkdir()
        (folder / 'event.json').write_text(json.dumps(EVENT))
        if transcript: (folder / 'transcript.md').write_text(TRANSCRIPT)
        return folder

    def no_key_anywhere(root, *printed):
        for p in Path(root).rglob('*'):
            if p.is_file(): assert KEY.encode() not in p.read_bytes(), f'the key landed in {p}'
        for text in printed: assert KEY not in text, 'the key was printed'

    def approve(folder):
        # What the send gate passes after the user pressed Send: the screen has run (prepare), and the approval is the
        # sha256 of the outbound.md that was reviewed.
        out_md, _ = privacy.latest_pair(folder)
        if out_md is None: out_md, _, _ = fake_screen(folder)
        return hashlib.sha256(out_md.read_bytes()).hexdigest()

    def run_byo(folder, post, key=KEY, **kw):
        # byo.run the way the send gate calls it (no ask passed, approved): the key from the fake keychain, the request
        # through the fake transport.
        if 'approved' not in kw: kw['approved'] = approve(folder)
        out, err = io.StringIO(), io.StringIO()
        fake_run, asked = keychain(key)
        code, result = 0, None
        with patched(byo, post=post), patched(byo.subprocess, run=fake_run), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try: result = byo.run(folder, 'nebius', screen=fake_screen, **kw)
            except SystemExit as e: code = e.code if isinstance(e.code, int) else 1; err.write(str(e.code))
        return code, result, out.getvalue(), err.getvalue(), asked
    return SimpleNamespace(**locals(), patched=patched, files_under=files_under)

def __getattr__(name):
    # `from fixtures import priya` builds that call once (PEP 562).
    builders = {'priya': _priya, 'sam': _sam}
    if name not in builders: raise AttributeError(name)
    globals()[name] = value = builders[name]()
    return value
