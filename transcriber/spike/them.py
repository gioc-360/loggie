#!/usr/bin/env python3
# Who "Them" was on a call, by code at Stop (meetings-granola-proposal.md c, 2.2, 2026-10-27). The invite names who sent
# it, not who was on it: the M&T interview of 2026-10-27 was sent by the recruiter and held by David, who never said his
# name; Gio said it to him twice, and his mail spelled it. So the call itself is read first, then the mail tied to the
# invite, then the invite, which never decides alone.
#   python3 them.py <call-folder>                 what it would decide, printed; writes nothing
#   python3 them.py pick <call-folder> "<name>"   the click on the call page: his name wins, relabels, remembered
#   python3 them.py again <call-folder>           after the title picked another meeting: a new lexicon for its invite, then decide
#   settle(folder, event, lines) -> event         call.py finish, before any label is written
#
# Scores (code only, no model; names stay on this Mac):
#   +4  Them introduces themselves in a Them line: "I'm X", "this is X", "my name is X", "X here", "X from <Firm>"
#   +3  Me says X to Them, each hit, at most 3: "Thanks, X.", "So X, how ...", "..., X, thank you", "you, X."; a name said
#       about someone ("Kaitlyn set this up", "I spoke with Jess") is never in those spots and scores 0; Them's lines say nothing
#   +2  a person in the call's mail list: a lexicon "mail" entry of two or three capitalized words
#   +1  the invite's other person
#   +4  a name he picked before (people-names.json) whose first name is said; by the invite's address alone it is +4 when it
#       is that invitee (a weekly 1:1) and +2 when it is someone else (a recruiter's invites go to many interviewers)
# A first name said completes to a full name when exactly one mail, invite or remembered person carries it. Decided when
# the top leads by 2 and is more than the invite; else "Them" stays and the call page offers up to three choices.
import json, os, re, sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import privacy, summary, transcript

MEMORY = 'people-names.json'
NAME = privacy.NAME
GREET = r"\b(?i:hi|hey|hello|thanks|thank you|so|okay|ok)"
INTRO = [re.compile(rf"\b(?i:i'm|i’m|i am|this is|my name is|my name's)\s+({NAME})(?: ({NAME}))?\b"),
         re.compile(rf"(?:^|(?<=[.?!,] ))({NAME}) here\b"),
         re.compile(rf"(?:^|(?<=[.?!] )|\b(?i:hi|hello|hey),?\s+)({NAME}) from [A-Z]")]
SAID_TO = [re.compile(rf"{GREET},?\s+({NAME})(?=\s*[,.?!]|\s*$)"),
           re.compile(rf"(?<=[a-z]), ({NAME})(?=\s*[,.?!]|\s*$)"),
           re.compile(rf"(?:^|(?<=[.?!] ))({NAME}), [^.?!]*\?")]
ABOUT = re.compile(r"\b(?i:with|to|from|by|about|than)\s*,?\s*$")
LISTED = re.compile(r"^,?\s*(?:and|or)\b|^\s*(?:and|or)\b")   # "OpEx, Capex, and revenue" is a list, not a person spoken to
FULL = re.compile(rf"{NAME}(?: {NAME}){{1,2}}")
NOT_PEOPLE = ('own', 'own-terms', 'title', 'terms')
CAP = 3

def hikyaku_home(folder):
    folder = Path(folder)
    if folder.parent.name == 'calls': return folder.parent.parent
    return Path(os.environ.get('LOGGIE_HIKYAKU_HOME') or Path.home() / 'Library' / 'Application Support' / 'Loggie' / 'hikyaku')

def read_json(path, default):
    try: return json.loads(Path(path).read_text())
    except (OSError, ValueError): return default

def entries_of(folder):
    # The newest lexicon (lexicon.json, lexicon-2.json ...), as nvidia_engine reads it.
    files = sorted(Path(folder).glob('lexicon*.json'), key=lambda p: p.stat().st_mtime)
    return read_json(files[-1], {}).get('entries', []) if files else []

def invite_people(event):
    me = (event.get('me') or '').strip().lower()
    names = [n.strip() for n in (event.get('names') or event.get('attendees') or '').split(',') if n.strip()]
    return [n for n in names if n.lower() != me and n.split()[0].lower() != me]

def runs(event):
    # Exactly one other person: a class or a group call has many voices on the Them side, and a name said is not Them.
    # Nobody on the invite no longer counts (Gio, 2026-10-28): a group Zoom with no invitees would be named after one "I'm
    # Sarah from Gilead". The room's mic alone (a split recording) is never Them.
    people = event.get('emails') or invite_people(event)
    return summary.kind_of(event) != 'class' and transcript.sides_of(event) != ('me',) and len(people) == 1

def detect(lines, entries=(), event=None, remembered=None):
    # lines: [{'who': 'Me' | 'Them', 'text'}]. Returns {decided, label, choices, invite, scores}.
    event, remembered = event or {}, remembered or {}
    own = {w.lower() for e in entries if e.get('source') == 'own' for w in str(e.get('text', '')).split()}
    own |= {w.lower() for w in str(event.get('me') or '').split()}
    other_words = {w.lower() for e in entries if e.get('source') in NOT_PEOPLE for w in str(e.get('text', '')).split()}
    known = {w for e in entries if e.get('source') not in NOT_PEOPLE for w in str(e.get('text', '')).split()}
    def is_name(word, loose=False):
        # On the first-name list or the lexicon. `loose`, right after a greeting ("Thanks, Marcus."): also a capitalized word
        # no dictionary has, since Marcus, Priya and Elena are on no list; elsewhere that let "OpEx, Capex," in (2026-10-27).
        if "'" in word or '’' in word: return False   # "Linda's"
        if word in privacy.NEVER or word in privacy.PLACES or word.lower() in transcript.DATES or word.lower() in own or word.lower() in other_words: return False
        return word in known or word in privacy.FIRST_NAMES or (loose and word.lower() not in privacy.ENGLISH)
    said, intro, surname = {}, set(), {}
    for line in lines:
        text = ' '.join(str(line.get('text', '')).split())
        if line.get('who') == 'Me':
            hits = {}
            for i, pattern in enumerate(SAID_TO):
                for m in pattern.finditer(text):
                    before, after = text[:m.start(1)], text[m.end(1):]
                    if i == 1 and (not re.search(r'(?:^|\s)[a-z]+, $', before) or LISTED.match(after)): continue
                    if is_name(m.group(1), loose=i == 0) and not ABOUT.search(before): hits[m.start(1)] = m.group(1)
            for x in hits.values(): said[x] = said.get(x, 0) + 1
        else:
            for pattern in INTRO:
                for m in pattern.finditer(text):
                    if not is_name(m.group(1)): continue
                    intro.add(m.group(1))
                    last = m.group(2) if m.lastindex and m.lastindex > 1 else None
                    if last and last not in privacy.NEVER and last.lower() not in own and last not in privacy.ORG_WORDS: surname[m.group(1)] = last
    call = {x: (4 if x in intro else 0) + 3 * min(said.get(x, 0), CAP) for x in set(said) | intro}
    people = {}   # full name -> {'score', 'from': set}
    def add(full, points, source):
        p = people.setdefault(full, {'score': 0, 'from': set()})
        p['score'] += points; p['from'].add(source)
    for e in entries:
        text = str(e.get('text', '')).strip()
        first = text.split()[0] if text else ''
        person = (first in privacy.FIRST_NAMES or first.lower() not in privacy.ENGLISH) and first not in privacy.NEVER and first not in privacy.PLACES and first.lower() not in own
        if e.get('source') == 'mail' and FULL.fullmatch(text) and person and not set(text.split()[1:]) & (privacy.ORG_WORDS | privacy.PLACES) and text not in privacy.FIRMS and text not in privacy.FAMOUS:
            add(text, 2, 'mail')
    invite = invite_people(event)
    for full in invite: add(full, 1, 'invite')
    firsts = {full.split()[0]: full for full in invite}
    addresses, memory = {e.lower() for e in event.get('emails') or []}, {}
    for key, full in remembered.items():
        first = full.split()[0]
        if key in call or first in call: points = 4 if key in call or key.lower() in addresses else 0
        else: points = (4 if firsts.get(first) == full else 2) if key.lower() in addresses else 0
        if points: memory[full] = max(points, memory.get(full, 0))
    for full, points in memory.items(): add(full, points, 'memory')
    for x, points in call.items():
        mine = [full for full, p in people.items() if 'memory' in p['from'] and full.split()[0] == x]
        carriers = mine or [full for full in people if full.split()[0] == x or full == x]
        if len(carriers) == 1: add(carriers[0], points, 'call')
        else: people[f'{x} {surname[x]}' if x in surname and not carriers else x] = {'score': points, 'from': {'call'}, 'carriers': carriers}
    ranked = sorted(people.items(), key=lambda kv: (-kv[1]['score'], kv[0]))
    scores = [[name, p['score']] for name, p in ranked]
    if not ranked: return {'decided': False, 'label': None, 'choices': [], 'invite': None, 'scores': []}
    (top, best), runner = ranked[0], ranked[1][1]['score'] if len(ranked) > 1 else 0
    alone = best['from'] == {'invite'}
    def offered(name, p): return p.get('carriers') or [name]
    choices = []
    for name, p in ranked:
        for c in offered(name, p):
            if c not in choices: choices.append(c)
    if best['score'] - runner >= 2 and not alone:
        # Two people carry the first name said: it stays a first name, and the page offers the full ones.
        return {'decided': True, 'label': top, 'choices': best.get('carriers', [])[:CAP], 'invite': None, 'scores': scores}
    return {'decided': False, 'label': None, 'choices': choices[:CAP], 'invite': top if alone else None, 'scores': scores}

def lines_of(folder):
    # The call's lines from transcript-timed.txt, "[mm:ss] Who: text"; any label but Me or Room is the Them side.
    out = []
    for raw in (Path(folder) / 'transcript-timed.txt').read_text(errors='replace').splitlines() if (Path(folder) / 'transcript-timed.txt').exists() else []:
        m = re.match(r'\[[\d:]+\]\s*([^:]{1,80}):\s?(.*)$', raw)
        if m: out.append({'who': m.group(1).strip() if m.group(1).strip() in ('Me', 'Room') else 'Them', 'text': m.group(2)})
    return out

def write_event(folder, changes, drop=()):
    path = Path(folder) / 'event.json'
    on_disk = {**read_json(path, {}), **changes}
    for key in drop: on_disk.pop(key, None)
    temp = path.with_name(f'event.json.{os.getpid()}.tmp')
    temp.write_text(json.dumps(on_disk, indent=2, ensure_ascii=False))
    temp.replace(path)
    return on_disk

def settle(folder, event, lines, home=None, write=True):
    # call.py finish: decide, write event.json, return the event the labels are written from. His pick always stands; a
    # failure here costs the name, never the call. `write` False: a redo or the check pass, whose call folder is never written.
    # A label the event came with (call.py start's caller set it) is a person's word too; only code's own is decided again.
    if event.get('them_by_hand') or (event.get('them_label') and not event.get('them_found')) or not runs(event): return event
    lines = [l for l in lines if l.get('who') != 'Room']   # a room line is never a clue to who Them was (2026-10-28)
    try:
        found = detect(lines, entries_of(folder), event, read_json(Path(home or hikyaku_home(folder)) / MEMORY, {}))
        at = datetime.now().astimezone().isoformat(timespec='seconds')
        record = {'by': 'code', 'decided': found['decided'], 'choices': found['choices'], 'invite': found['invite'], 'scores': found['scores'][:5], 'at': at}
        label = found['label'] if found['decided'] else 'Them'
        changes = {'them_label': label, 'with': label if found['decided'] else 'the other person', 'them_found': record}
        if write: write_event(folder, changes)
        print(f"them: {label}" + (f" (unsure; choices {', '.join(found['choices'])})" if not found['decided'] and found['choices'] else '')
              + (f", scores {found['scores'][:3]}" if found['scores'] else ''))
        return {**event, **changes}
    except Exception as error:
        print(f'them: not named ({type(error).__name__}: {error}); keeping "Them"')
        return event

def relabel(folder, old, new):
    # The Them label in the call folder's transcript files and the notes' headings, from what it was to the new name.
    folder, olds = Path(folder), [o for o in dict.fromkeys([old, 'Them']) if o and o != new]
    if not olds: return
    labels = '|'.join(re.escape(o) for o in olds)
    turn = re.compile(rf'(?m)^(\[[\d:]+\] |)(?:{labels}): ')
    header = re.compile(rf"(?m)^(.* min\. Me \(.*\) and |.* min\. )(?:{labels})(\.|: the Mac's sound\. .*)$")   # the Mac-sound side of a split too
    for name in ('transcript.md', 'transcript-timed.txt', 'transcript.txt'):
        path = folder / name
        if not path.exists(): continue
        text = turn.sub(lambda m: f'{m.group(1)}{new}: ', path.read_text())
        path.write_text(header.sub(lambda m: f'{m.group(1)}{new}{m.group(2)}', text) if name == 'transcript.md' else text)
    for path in [*folder.glob('summary-*.md'), folder / 'notes.md']:
        if not path.exists(): continue
        text = re.sub(r'(?m)^(#.*)$', lambda m: re.sub(rf'\b(?:{labels})\b', lambda _: new, m.group(1)), path.read_text())
        path.write_text(text)

def remember(home, event, name):
    path = Path(home) / MEMORY
    memory = read_json(path, {})
    for address in event.get('emails') or []: memory[address.lower()] = name
    memory[name.split()[0]] = name
    path.write_text(json.dumps(memory, indent=2, ensure_ascii=False) + '\n')

def pick(folder, name, home=None):
    # The click: his name over any detection, now and later (them_by_hand), the files relabeled, and remembered.
    folder, name = Path(folder), ' '.join(str(name).split())
    if not name or len(name) > 80 or name in ('Me', 'Them'): sys.exit('A name is 1 to 80 characters.')
    event = read_json(folder / 'event.json', None)
    if event is None: sys.exit(f'no event.json in {folder}')
    relabel(folder, event.get('them_label') or 'Them', name)
    found = {**(event.get('them_found') or {}), 'by': 'hand', 'at': datetime.now().astimezone().isoformat(timespec='seconds')}
    event = write_event(folder, {'them_label': name, 'with': name, 'them_by_hand': True, 'them_found': found})
    remember(home or hikyaku_home(folder), event, name)
    print(f'them: {name} (by hand)')
    return event

def again(folder, home=None):
    # The title picked another meeting (call-notes.js renameCall): its invite's mail read for a new lexicon (lexicon.py, a
    # new file beside the old), then the same decision, and the files relabeled from the old label.
    import lexicon
    folder = Path(folder)
    event = read_json(folder / 'event.json', {})
    if event.get('them_by_hand') or not runs(event): return event
    if event.get('emails'): lexicon.write(folder, lexicon.build(folder))
    old = event.get('them_label') or 'Them'
    event = settle(folder, event, lines_of(folder), home)
    relabel(folder, old, event.get('them_label') or 'Them')
    return event

if __name__ == '__main__':
    a = sys.argv[1:]
    if a[:1] == ['pick'] and len(a) == 3: pick(Path(a[1]).resolve(), a[2])
    elif a[:1] == ['again'] and len(a) == 2: again(Path(a[1]).resolve())
    elif len(a) == 1:
        folder = Path(a[0]).resolve()
        event = read_json(folder / 'event.json', {})
        print(json.dumps({'runs': runs(event), **detect(lines_of(folder), entries_of(folder), event, read_json(hikyaku_home(folder) / MEMORY, {}))}, indent=1, ensure_ascii=False))
    else: sys.exit('usage: them.py <call-folder> | pick <call-folder> "<name>" | again <call-folder>')
