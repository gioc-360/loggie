# The send gate, Python half (spec-entry-b.md A7, increment b#3a): nothing leaves the Mac until the user picks an AI
# and presses Send. With the frontier on "nebius", call.py finish() no longer sends the call; it PREPARES the send:
# the call is screened on the Mac (privacy.py), and a pending send is recorded in a run folder,
#   <hikyaku home>/runs/<run id>/send.json      what would leave, as files and counts; status "pending"
#   <hikyaku home>/runs/<run id>/events.jsonl   the event contract (spec section 2), one JSON object per line
# Loggie's send gate (src/hikyaku/send-gate.js) reads the same two files: it shows "What would leave your Mac" (the plain
# outbound.md), offers the AIs that are really connected (ai.options), and only on Send (ai.picked) runs
#   python3 byo.py <version folder> --with <provider> --approved <sha256 of the outbound.md the user reviewed>
# The approval is the hash of what was reviewed, so a screen that ran again after the review cannot slip a different
# outbound.md through. send.json never holds a held sentence or the key; held.json stays where it is, on the Mac.
#   python3 call.py prepare <version folder>     the same step by hand (a screen that failed, or a redo)
import hashlib, json, os, re, sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import privacy, spelling, summary

V = 1
# The event contract's text rule and kept-line reasons (spec section 2), the same as Loggie's src/hikyaku/events.js.
NAMES_A_MODEL = re.compile(r'nemotron|parakeet|titanet|nvidia|nebius|token factory|claude|super|lightning|model|llm', re.I)
KEPT_REASONS = {'health': 'a health detail', 'money': 'personal money', 'identity': 'an ID number', 'grades': 'grades or scores',
                'third-party': "someone else's private matter", 'confidential': 'asked to keep it quiet', 'injection': 'text that tried to steer the screen',
                'unchecked': 'the check could not finish, so it stayed', 'unsure': 'the check was unsure, so it stayed'}
USER_REASON = 'you chose to keep it'   # a line the user kept with line.hold (layer "user")

def runs_root(home): return Path(home) / 'runs'

def new_run_id(now=None):
    # YYYYMMDD-HHMMSS-<4 hex> (spec section 2): sorts by time, two runs in one second still differ.
    now = now or datetime.now()
    return f"{now.strftime('%Y%m%d-%H%M%S')}-{os.urandom(2).hex()}"

def emit(run_dir, type_, step=None, text=None, data=None):
    # One event, appended. seq counts the lines already there, so Python and Node append to one numbering. `text` is
    # plain words and never names a model or a provider (the test in test_send_gate.py and the Loggie gate test).
    if text is not None and NAMES_A_MODEL.search(text): raise ValueError(f'event not written: its text names a model or a provider: {text!r}')
    run_dir = Path(run_dir); run_dir.mkdir(parents=True, exist_ok=True)
    file = run_dir / 'events.jsonl'
    seq = sum(1 for l in file.read_text().splitlines() if l.strip()) + 1 if file.exists() else 1
    event = {'v': V, 'run': run_dir.name, 'seq': seq, 'at': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
             'type': type_, 'step': step, 'text': text, 'data': data or {}}
    with file.open('a') as f: f.write(json.dumps(event, ensure_ascii=False) + '\n')
    return event

def kept_reason(row): return USER_REASON if row.get('layer') == 'user' else KEPT_REASONS.get(row.get('category'), 'the screen kept it')

def screen_lines(run_dir, source, source_id, record):
    # One screen.line per sentence from the record's lines[] (privacy.lines_of); a record without lines[] gives its
    # kept sentences only (held[] rows with an index), so a kept line is never missing. Returns how many were written.
    rows = record.get('lines')
    if not isinstance(rows, list): rows = [{**h, 'status': 'kept'} for h in record.get('held', []) if isinstance(h.get('i'), int)]
    for r in rows:
        kept = r.get('status') == 'kept'
        line = {'source': source, 'source_id': source_id, 'i': r['i'], 'turn': r.get('turn'), 'time': r.get('time'), 'speaker': r.get('speaker'), 'text': r.get('text'),
                'status': 'kept' if kept else 'sent', 'category': (r.get('category') or 'unsure') if kept else None, 'layer': r.get('layer') if kept else None,
                'rule': r.get('rule') if kept else None, 'reason': kept_reason(r) if kept else None}
        emit(run_dir, 'screen.line', 'screen', f"Kept on this Mac: {line['reason']}" if kept else None, line)
    return len(rows)

def classmates_of(counts):
    # How many classmates a class's screen wrote as Student N (privacy.screen counts.masked.labels), else 0.
    masked = counts.get('masked') if isinstance(counts, dict) else None
    labels = masked.get('labels') if isinstance(masked, dict) else 0
    return labels if isinstance(labels, int) and labels > 0 else 0

def trimmed_of(counts):
    # How many people a trimmed call's screen wrote by first name only (privacy.screen counts.trimmed.people), else 0.
    trimmed = counts.get('trimmed') if isinstance(counts, dict) else None
    people = trimmed.get('people') if isinstance(trimmed, dict) else 0
    return people if isinstance(people, int) and people > 0 else 0

def summary_text(counts):
    # The screen.summary line; a class adds how many classmates left as labels, a trimmed call how many people left by
    # first name (the same words as events.js summaryText).
    text = f"{counts['sent']} sentences cleared, {counts['held']} kept on this Mac"
    people = trimmed_of(counts)
    if people: return f"{text}, {people} {'person' if people == 1 else 'people'} by first name only"
    n = classmates_of(counts)
    if n == 1: return f'{text}, 1 classmate written as Student 1'
    return f'{text}, {n} classmates written as Student 1 to {n}' if n else text

def sha256_of(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def fresh_pair(folder, event=None):
    # The newest outbound.md/held.json pair when it is newer than transcript.md, else None (byo.outbound_state's rule).
    # A class pair with no "names" map was screened before classmates were masked (loggie-class-notes): not fresh, so
    # it is screened again before anyone reviews it.
    out_md, held = privacy.latest_pair(folder)
    if out_md is None or held is None or out_md.stat().st_mtime < (Path(folder) / 'transcript.md').stat().st_mtime: return None
    # The spellings the user's words prove now (a new workspace, a ✓ or ✕ on a word since) differ from the pair's: screened
    # again, so what leaves carries them (loggie-auto-spelling). A pair from before has none recorded.
    if event is not None:
        said = (Path(folder) / 'transcript.md').read_text()
        if json.loads(Path(held).read_text()).get('spelled', {}) != spelling.proven(folder, event, said): return None
    if event is not None and summary.kind_of(event) == 'class':
        record = json.loads(Path(held).read_text())
        # A class screened under older mask rules (privacy.MASK_VERSION) is screened again, so a rule fix reaches it.
        if 'names' not in record or record.get('mask_version') != privacy.MASK_VERSION: return None
        # Notes typed after the screen may name a classmate the map lacks: screened again, notes and transcript together.
        notes = Path(folder) / privacy.NOTES_FILE
        if notes.exists() and notes.stat().st_mtime > Path(held).stat().st_mtime: return None
    # A call whose people leave by first name (privacy.trims): a pair with no "trimmed" map, or one made under other trim
    # rules, is screened again; the interview pairs written before 2026-10-26 have none and would send full names.
    if event is not None and summary.kind_of(event) != 'class' and privacy.trims(event):
        record = json.loads(Path(held).read_text())
        if 'trimmed' not in record or record.get('trim_version') != privacy.TRIM_VERSION: return None
        notes = Path(folder) / privacy.NOTES_FILE
        if notes.exists() and notes.stat().st_mtime > Path(held).stat().st_mtime: return None
    return out_md, held

def prepare_call(home, folder, event):
    # Screen the call on the Mac (or reuse a pair that is still fresh) and record the pending send. Returns the send
    # record. A screen needs no model (code only is valid); one that cannot run at all raises SystemExit after a run.failed event: nothing pending.
    folder = Path(folder).resolve()
    run_dir = runs_root(home) / new_run_id()
    title, workstream = event.get('title', 'Call'), event.get('workstream') or None
    emit(run_dir, 'run.started', None, None, {'source': 'call', 'title': title, 'workstream': workstream})
    emit(run_dir, 'step.started', 'screen', 'Screening on your Mac', {'step': 'screen', 'index': 1, 'of': 3})
    t0 = datetime.now()
    pair = fresh_pair(folder, event)
    try:
        if pair: out_md, held = pair
        else: out_md, held, _ = privacy.screen_folder(folder)
        # The user's typed notes (my-notes.md) are screened the same way and go as a second outbound file with its own
        # hash, so the yes covers them too (send-gate.js approveSend checks every hash). A class's notes are relabeled
        # with the call's map.
        screened = json.loads(Path(held).read_text())
        notes = privacy.screen_notes(folder, screened.get('names'), screened.get('trimmed'))
        # The pages tucked into the call (loggie-pause-attach): a third outbound file, its own hash, the same yes.
        pages = privacy.screen_pages(folder, screened.get('names'), screened.get('trimmed'))
    except SystemExit as error:
        reason = error.code if isinstance(error.code, str) else 'the screen on this Mac did not run'
        emit(run_dir, 'step.finished', 'screen', None, {'step': 'screen', 'ok': False, 'seconds': round((datetime.now() - t0).total_seconds(), 1)})
        emit(run_dir, 'run.failed', 'screen', 'Nothing was sent', {'step': 'screen', 'reason': reason, 'fix': 'Start the AI on this Mac, then screen the call again.'})
        raise
    record = json.loads(Path(held).read_text())
    counts = record['counts']
    seconds = round((datetime.now() - t0).total_seconds(), 1)
    source_id = f'call:{call_name(folder)}'
    lines = screen_lines(run_dir, 'call', source_id, record)
    emit(run_dir, 'screen.summary', 'screen', summary_text(counts),
         {'source': 'call', 'source_id': source_id, 'counts': counts, 'outbound_file': str(out_md), 'held_file': str(held), 'seconds': record.get('seconds', seconds), 'lines': lines})
    send = {'v': V, 'run': run_dir.name, 'what': 'call-notes', 'status': 'pending', 'created': datetime.now().astimezone().isoformat(timespec='seconds'),
            'source_ids': [source_id], 'folder': str(folder), 'outbound': [str(out_md)], 'held': [str(held)], 'sha256': [sha256_of(out_md)],
            'workstream': workstream, 'title': title, 'sentences_sent': counts['sent'], 'sentences_kept': counts['held']}
    if classmates_of(counts): send['classmates'] = classmates_of(counts)
    if trimmed_of(counts): send['trimmed'] = trimmed_of(counts)
    if notes:
        send['outbound'].append(str(notes[0])); send['held'].append(str(notes[1])); send['sha256'].append(sha256_of(notes[0]))
        send['notes_sent'] = json.loads(Path(notes[1]).read_text())['counts']['sent']
    if pages:
        send['outbound'].append(str(pages[0])); send['held'].append(str(pages[1])); send['sha256'].append(sha256_of(pages[0]))
        send['pages_sent'] = json.loads(Path(pages[1]).read_text())['counts']['sent']
    # Summarize again (Loggie sets LOGGIE_FRESH=1): the send asks the AI again rather than reusing a saved answer.
    if os.environ.get('LOGGIE_FRESH') == '1': send['fresh'] = True
    (run_dir / 'send.json').write_text(json.dumps(send, indent=1, ensure_ascii=False) + '\n')
    # "Screen finished" goes out last: the app's automatic yes starts on it and reads send.json (on a 2 h 39 class the
    # event came 0.8 s before the file, and the yes found no send; 2026-10-22).
    emit(run_dir, 'step.finished', 'screen', None, {'step': 'screen', 'ok': True, 'seconds': seconds})
    return send

def call_name(folder):
    # The call's folder name: the version folder's parent when the transcript sits in vN-*/, else the folder itself.
    folder = Path(folder)
    return folder.parent.name if folder.name.startswith('v') and folder.name[1:2].isdigit() else folder.name
