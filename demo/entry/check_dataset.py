# Checks the made-up data set in this folder: counts and shapes, the planted items, the example-only addresses and the
# names that must never appear. Prints a plain list of problems and exits 1, or prints "ok" and exits 0.
#   python3 check_dataset.py
import array, json, os, re, wave
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).parent
# The real names that must never appear live outside the repo, so the check does not publish them itself: one name a line
# in the user's hikyaku folder (or CHECK_DATASET_NAMES). Missing file: the names check is skipped, and says so loudly.
NAMES_FILE = Path(os.environ.get('CHECK_DATASET_NAMES', Path.home() / 'Library' / 'Application Support' / 'Loggie' / 'hikyaku' / 'private-names.txt'))
DENY = [line.strip() for line in NAMES_FILE.read_text().splitlines() if line.strip() and not line.startswith('#')] if NAMES_FILE.exists() else None
EMAIL = re.compile(r'[\w.+-]+@[\w-]+(?:\.[\w-]+)+')
THREAD_KEYS = {'id', 'historyId', 'subject', 'snippet', 'latestTimestamp', 'participants', 'messages'}
MESSAGE_KEYS = {'id', 'threadId', 'messageId', 'from', 'to', 'cc', 'subject', 'timestamp', 'body', 'snippet', 'labels', 'attachments', 'rawLinks'}
TURN_KEYS = {'who', 'side', 'start', 'end', 'text'}
MOVE_KEYS = {'id', 'source', 'stream', 'thread_id', 'kind', 'quote', 'must_include', 'must_not_include', 'slot_required'}
KINDS = {'reply', 'invite', 'prep', 'read', 'wait'}
problems = []
bad = lambda text: problems.append(text)

def load(name):
    try: return json.loads((HERE / name).read_text())
    except Exception as error:
        bad(f'{name}: cannot be read ({error})')
        return None

def strings(value):
    if isinstance(value, str): yield value
    elif isinstance(value, dict):
        for item in value.values(): yield from strings(item)
    elif isinstance(value, list):
        for item in value: yield from strings(item)

def example_domain(domain):
    domain = domain.lower().rstrip('.')
    return domain in ('example.com', 'example.org', 'example.net') or domain.endswith('.example') or domain.endswith('.example.com')

# --- the call
truth = load('call/truth.json')
if truth is not None:
    if not truth or any(set(t) != TURN_KEYS for t in truth): bad('call/truth.json: every turn needs exactly who, side, start, end, text')
    else:
        rate, tracks = 16000, {}
        for side in ('me', 'them'):
            try:
                with wave.open(str(HERE / 'call' / f'{side}.wav')) as w:
                    if (w.getnchannels(), w.getframerate(), w.getsampwidth()) != (1, rate, 2): bad(f'call/{side}.wav: must be 16 kHz mono 16-bit')
                    tracks[side] = array.array('h', w.readframes(w.getnframes()))
            except Exception as error: bad(f'call/{side}.wav: cannot be read ({error})')
        if len(tracks) == 2:
            if len(tracks['me']) != len(tracks['them']): bad('call: me.wav and them.wav are not the same length')
            seconds = len(tracks['me']) / rate
            if not 180 <= seconds <= 240: bad(f'call: {seconds:.1f} s long, wanted 180 to 240')
            for turn in truth:
                other = tracks['them' if turn['side'] == 'me' else 'me']
                a, b = int(turn['start'] * rate), int(turn['end'] * rate)
                if any(other[a:b]): bad(f"call: the other side is not silent while {turn['who']} speaks at {turn['start']} s")
                if not any(tracks[turn['side']][a:b]): bad(f"call: {turn['who']} is silent in their own turn at {turn['start']} s")
        if {t['who'] for t in truth} != {'Nadia Feldman', 'Omar Castellano'}: bad('call/truth.json: the speakers must be Nadia Feldman and Omar Castellano')
call_text = '\n'.join(t['text'] for t in truth) if truth else ''

# --- the inbox
inbox = load('inbox.json') or []
if len(inbox) != 20: bad(f'inbox.json: {len(inbox)} threads, wanted 20')
for thread in inbox:
    if set(thread) != THREAD_KEYS: bad(f"inbox.json: thread {thread.get('id')} has the wrong keys")
    if not thread.get('messages'): bad(f"inbox.json: thread {thread.get('id')} has no messages")
    for m in thread.get('messages', []):
        if set(m) != MESSAGE_KEYS: bad(f"inbox.json: message {m.get('id')} has the wrong keys")
        if m.get('threadId') != thread.get('id'): bad(f"inbox.json: message {m.get('id')} names another thread")
        if not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', str(m.get('timestamp'))): bad(f"inbox.json: message {m.get('id')} timestamp is not ISO")
    last = (thread.get('messages') or [{}])[-1]
    if thread.get('latestTimestamp') != last.get('timestamp'): bad(f"inbox.json: thread {thread.get('id')} latestTimestamp is not its last message")
ids = [t.get('id') for t in inbox]
if len(set(ids)) != len(ids): bad('inbox.json: thread ids repeat')
message_ids = [m.get('id') for t in inbox for m in t.get('messages', [])]
if len(set(message_ids)) != len(message_ids): bad('inbox.json: message ids repeat')

streams = load('workstreams.json') or []
if len(streams) != 5: bad(f'workstreams.json: {len(streams)} workstreams, wanted 5')
for s in streams:
    if s.get('cloud') != 'nebius': bad(f"workstreams.json: {s.get('name')} is not cloud nebius")
def stream_of(thread):
    people = ' '.join(f"{m['from']} {m['to']} {m['cc']}" for m in thread['messages']).lower()
    text = (thread['subject'] + '\n' + '\n'.join(m['body'] for m in thread['messages'])).lower()
    for s in streams:
        if any(f'@{d}' in people or f'.{d}' in people for d in s['domains']) or any(w.lower() in text for w in s['words']): return s['name']
    return None
by_stream = {}
for thread in inbox: by_stream.setdefault(stream_of(thread), []).append(thread['id'])
for s in streams:
    if len(by_stream.get(s['name'], [])) != 2: bad(f"inbox.json: {s['name']} has {len(by_stream.get(s['name'], []))} threads, wanted 2")
others = [i for i in by_stream.get(None, [])]
kinds = {'fyi': [i for i in others if i.startswith('th-fyi-')], 'marketing': [i for i in others if i.startswith('th-mkt-')], 'chore': [i for i in others if i.startswith('th-chore-')]}
for name, want in (('fyi', 4), ('marketing', 3), ('chore', 3)):
    if len(kinds[name]) != want: bad(f'inbox.json: {len(kinds[name])} {name} threads, wanted {want}')
for thread in inbox:
    if thread['id'] in kinds['marketing'] and not any('unsubscribe' in m['body'].lower() and m['rawLinks'] for m in thread['messages']): bad(f"inbox.json: marketing thread {thread['id']} has no unsubscribe line and link")
    if thread['id'] in kinds['chore'] and len(thread['messages']) != 1: bad(f"inbox.json: chore thread {thread['id']} is not one message")

# --- settings, calendar, profile
settings = load('settings.json') or {}
want = {'frontier': 'nebius', 'thinker': 'cloud', 'signName': 'Nadia'}
for key, value in want.items():
    if settings.get(key) != value: bad(f'settings.json: {key} must be {value!r}')
if settings.get('cloudYes') != {'discover': True, 'triage': True, 'style': True}: bad('settings.json: cloudYes must say yes to discover, triage and style')
today = None
try:
    today = date.fromisoformat(settings.get('today'))
    if today.weekday() > 4 or not (date(2026, 10, 1) <= today <= date(2026, 12, 31)): bad('settings.json: today must be a weekday in Oct to Dec 2026')
except Exception: bad('settings.json: today must be YYYY-MM-DD')
events = load('calendar.json') or []
for e in events:
    if not {'id', 'title', 'start', 'end', 'allDay', 'calendar', 'account', 'writable', 'attendees'} <= set(e): bad(f"calendar.json: event {e.get('id')} is missing keys")
if today:
    free = 0
    for offset in range(7):
        day = today + timedelta(days=offset)
        if day.weekday() > 4: continue
        busy = sorted((datetime.fromisoformat(e['start']), datetime.fromisoformat(e['end'])) for e in events if e['start'][:10] == day.isoformat())
        cursor = datetime.fromisoformat(f'{day}T09:00:00-04:00'); close = datetime.fromisoformat(f'{day}T17:00:00-04:00')
        for a, b in busy:
            if a - cursor >= timedelta(minutes=30): free += 1
            cursor = max(cursor, b)
        if close - cursor >= timedelta(minutes=30): free += 1
    if free != 1: bad(f'calendar.json: {free} free windows in the week from today, wanted exactly 1')
profile = (HERE / 'profile.md').read_text() if (HERE / 'profile.md').exists() else ''
if not profile.startswith('The user is Nadia Feldman'): bad('profile.md: must start "The user is Nadia Feldman"')

# --- planted items
sources = {'inbox': {t['id']: '\n'.join(strings(t)) for t in inbox}, 'call': {'call/truth.json': call_text}}
everything = '\n'.join(list(sources['inbox'].values()) + [call_text])
planted = load('planted.json') or {}
for item in planted.get('private', []):
    n = everything.count(item['text'])
    if n != 1: bad(f"planted.json: private item {item['id']} appears {n} times in the sources, wanted 1")
    where = sources.get(item['source'], {}).get(item['source_id'])
    if where is None or item['text'] not in where: bad(f"planted.json: private item {item['id']} is not in {item['source']} {item['source_id']}")
if len(planted.get('private', [])) < 4: bad('planted.json: needs at least a card, an account number, a phone number and an address')
cats = {i['category'] for i in planted.get('private', [])}
if not {'money', 'phone', 'address'} <= cats: bad('planted.json: private items must cover money, phone and address')
if any(i['category'] == 'health' for i in planted.get('private', [])): bad('planted.json: no health item (health is not checked on the cloud-first version)')
if len(planted.get('names', [])) != 2: bad('planted.json: needs exactly 2 names')
for item in planted.get('names', []):
    if call_text.count(item['text']) != 1: bad(f"planted.json: name {item['text']} must be spoken once on the call")
dl = planted.get('deadline') or {}
if call_text.count(dl.get('text', '\0')) != 1: bad('planted.json: the deadline text must be spoken once on the call')
try:
    if today and date.fromisoformat(dl['date']) <= today: bad('planted.json: the deadline date is not after today')
except Exception: bad('planted.json: deadline needs a date YYYY-MM-DD')

# --- answer key
moves = (load('answer-key.json') or {}).get('moves', [])
if len(moves) != 5: bad(f'answer-key.json: {len(moves)} moves, wanted 5')
if {m.get('kind') for m in moves} != KINDS or len(moves) != len({m.get('kind') for m in moves}): bad('answer-key.json: the five moves must be reply, invite, prep, read and wait once each')
if sum(m.get('source') == 'call' for m in moves) != 1 or sum(m.get('source') == 'inbox' for m in moves) != 4: bad('answer-key.json: one move from the call and four from the inbox')
stream_names = {s['name'] for s in streams}
for m in moves:
    if set(m) != MOVE_KEYS: bad(f"answer-key.json: move {m.get('id')} has the wrong keys"); continue
    if m['stream'] not in stream_names: bad(f"answer-key.json: move {m['id']} names a stream that is not in workstreams.json")
    haystack = call_text if m['source'] == 'call' else sources['inbox'].get(m['thread_id'], '')
    if m['source'] == 'inbox' and m['thread_id'] not in sources['inbox']: bad(f"answer-key.json: move {m['id']} names a thread that is not in the inbox")
    elif m['source'] == 'inbox' and m['thread_id'] not in by_stream.get(m['stream'], []): bad(f"answer-key.json: move {m['id']} thread is not in its stream")
    n = haystack.count(m['quote'])
    if n != 1: bad(f"answer-key.json: move {m['id']} quote appears {n} times in its {m['source']}, wanted 1")
    if m['slot_required'] != (m['kind'] == 'invite'): bad(f"answer-key.json: move {m['id']} slot_required must be true only for the invite")

# --- addresses and names, in every text file here (this file holds the deny list, so it is skipped)
for path in sorted(HERE.rglob('*')):
    if not path.is_file() or path.suffix in ('.wav', '.pyc') or path.name == 'check_dataset.py' or '__pycache__' in path.parts: continue
    text = path.read_text(errors='replace')
    for address in sorted(set(EMAIL.findall(text))):
        if not example_domain(address.split('@')[1]): bad(f'{path.relative_to(HERE)}: address outside the example domains: {address}')
    for name in DENY or []:
        if name.lower() in text.lower(): bad(f'{path.relative_to(HERE)}: contains a real name from the deny list')

if DENY is None: print(f'WARNING: names check skipped, no list at {NAMES_FILE}')
if problems:
    print('\n'.join(f'- {p}' for p in problems)); print(f'{len(problems)} problem(s)'); raise SystemExit(1)
print('ok: 20 threads, 5 workstreams, call of %.0f s, %d planted private items, 5 moves' % (len(tracks['me']) / 16000, len(planted['private'])))
