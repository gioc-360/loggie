# Spike: the word-for-word transcript is the product; hikyaku reads it, the notes only index it. Nobody corrects it by
# hand. Since 2026-10-07 the words come from NVIDIA models only (nvidia_engine.py: Parakeet reads, Nemotron seconds,
# a gap check fails loud); this file keeps the parts both engines share:
#   honest marks  what stays uncertain is marked, but only on names, numbers, dates and doses (markable, marked, marks)
#   transcript.md the header, one paragraph per turn (markdown), version folders (new_version)
#   context in    the hint from the invite and course materials (hint, rank) and the course record privacy.py reads
#                 (course): Parakeet TDT ignores boosting, so the default path does not use the hint yet.
import collections, json, re, subprocess, sys, wave
from pathlib import Path

COURSES = Path.home() / 'Library' / 'Application Support' / 'Loggie' / 'hikyaku' / 'courses'
COURSE = re.compile(r'\b[A-Z]{2,4}\s?\d{4}\b')

CHARS = 760      # the hint's budget: names measured at 3.3 to 3.6 chars per token on 2026-10-06 (647 chars = 178 tokens)
THRESHOLD = 0.5  # a word is weak when its least likely token had under even odds

# ---------- context in ----------

DICT = Path('/usr/share/dict/words')
ENGLISH = set(DICT.read_text().lower().split()) if DICT.exists() else set()
NOISE = set('''january february march april may june july august september october november december monday tuesday wednesday
thursday friday saturday sunday exhibit exhibits figure table source sources page pages copyright professor case cases session
sessions chapter university inc ltd corp co llc harvard business school publishing final draft due class notes reading readings
appendix part section week preview question questions answer total note'''.split())
CONNECT = {'and', 'of', 'de', 'the', '&', 'von', 'van', 'du', 'for'}
WORD = re.compile(r"[A-Za-z][A-Za-z'&.-]*")
PHRASE = re.compile(r"\b[A-Z][A-Za-z'.-]+(?:\s+(?:(?:and|of|de|the|&|von|van|du|for)\s+)?[A-Z][A-Za-z'.-]+){1,3}")

def pages_of(text):
    # pdftotext puts a form feed between pages. A term is counted by the pages it is on, not by its occurrences: a
    # slide footer ("Cornell SC Johnson College") or a case watermark would otherwise outrank every real name
    # (measured 2026-10-06: "Johnson" 1222 hits, "Siecor" 36).
    return [p for p in text.split('\f') if p.strip()]

def known(w):
    # /usr/share/dict/words is uninflected: "negotiations", "structuring" and "states" are not in it. Try the stems.
    w = w.lower(); forms = {w}
    if w.endswith('s'): forms.add(w[:-1])
    if w.endswith('es'): forms.add(w[:-2])
    if w.endswith('ies'): forms.add(w[:-3] + 'y')
    if w.endswith('ing'): forms |= {w[:-3], w[:-3] + 'e'}
    if w.endswith('ed'): forms |= {w[:-2], w[:-1]}
    return any(f in ENGLISH for f in forms if len(f) >= 3)

def candidates(doc):
    # Per document: on how many pages each capitalized word (not sentence-initial), lowercase word, title-case phrase
    # and acronym appears. A term on more than half of a document's pages is boilerplate and counts once; one that is
    # boilerplate in two documents (a slide footer, a case watermark) is dropped by rank().
    cap, low, multi, acro, footer, raw = (collections.Counter() for _ in range(6))
    pages = pages_of(doc)
    for page in pages:
        pc, pl, pm, pa = set(), set(), set(), set()
        for line in page.splitlines():
            for m in WORD.finditer(line):
                w = m.group(0).strip("'.&-")
                if not w: continue
                if re.fullmatch(r"[A-Z]{2,6}s?", w): pa.add(w if len(w) == 2 else w.rstrip('s')); continue
                if w[0].isupper() and w[1:].islower() and len(w) >= 3:
                    before = line[:m.start()].rstrip()
                    if before and before[-1] not in '.!?:"(': pc.add(w)
                elif w.islower(): pl.add(w)
            for m in PHRASE.finditer(line):
                # the whole run and each adjacent pair: "VW SAIC Written Case" also yields "VW SAIC" (syllabus, 2026-10-06)
                ws = m.group(0).split(); pm.add(' '.join(ws))
                for i in range(len(ws) - 1):
                    if ws[i].lower() in CONNECT: continue
                    j = i + 2 if ws[i + 1].lower() in CONNECT and i + 2 < len(ws) else i + 1
                    pm.add(' '.join(ws[i:j + 1]))
        for counter, found in ((cap, pc), (low, pl), (multi, pm), (acro, pa)): counter.update(found)
    raw.update(cap); raw.update(acro)
    if len(pages) >= 4:
        for counter in (cap, multi, acro):
            for t, n in counter.items():
                # a real footer or watermark is on (nearly) every page; a case's subject is on most but not all
                if n > 0.8 * len(pages): counter[t] = 1; footer[t] = 1
    return cap, low, multi, acro, footer, raw

def rank(docs):
    # What Whisper would mishear, most useful first: multiword names (highest), then single names and jargon that
    # English does not have, then acronyms. A capitalized word is a name only when the materials never use it in
    # lowercase; a word English has (India, Model, Growth) is left out, Whisper knows those, and so is a phrase of them.
    cap, low, multi, acro, footer, raw = (collections.Counter() for _ in range(6))
    for doc in docs:
        for total, part in zip((cap, low, multi, acro, footer, raw), candidates(doc)): total.update(part)
    proper = lambda w: cap[w] > low[w.lower()] and w.lower() not in NOISE and footer[w] < 2
    # an acronym is all caps that the materials never write in lowercase (SAIC, MFN); an all-caps heading (ALLIANCE)
    # has a lowercase twin. The dictionary is no help here: it has an obscure "saic" (found 2026-10-06).
    acronym = lambda w, least=2: re.fullmatch(r"[A-Z]{%d,6}" % least, w) and not low[w.lower()] and not cap[w.title()] and w.lower() not in NOISE and footer[w] < 2
    scored = {}
    for phrase, n in multi.items():
        ws = [w for w in phrase.split() if w.lower() not in CONNECT]
        if len(ws) < 2 or footer[phrase] >= 2 or not all(proper(w) or acronym(w) for w in ws): continue
        if any(not known(w) for w in ws): scored[phrase] = n * 3.0
    # a single word is left to its phrases when they cover most of its pages (Belt -> Belt and Road), measured on the
    # raw page counts: a case's subject collapses to 1 above and a weak phrase would otherwise swallow it
    inside = collections.Counter()
    for phrase in scored:
        for w in phrase.split(): inside[w] += multi[phrase]
    for w, n in cap.items():
        if proper(w) and not known(w) and inside[w] < 0.8 * raw[w]: scored[w] = n * 2.0
    for w, n in acro.items():
        # two letters alone (US, IN, OF) are mostly all-caps headings; Whisper spells JV and AI fine without help
        if acronym(w, 3) and inside[w] < 0.8 * raw[w]: scored[w] = n * 1.0
    return [t for t, _ in sorted(scored.items(), key=lambda x: (-x[1], x[0]))]

def materials_dir(event):
    # Where a class's materials live: event.json may name a folder ("materials"); otherwise the course's folder under
    # hikyaku/courses, named by the code without the space (NBA6530). The user drops PDFs or text there once per course.
    if event.get('materials'):
        d = Path(event['materials'])
        if not d.is_dir(): sys.exit(f'materials folder in the event does not exist: {d}')
        return d
    m = COURSE.search(event.get('title', ''))
    if not m: return None
    d = COURSES / m.group(0).replace(' ', '')
    if not d.is_dir(): print(f'no materials for {m.group(0)}: put its PDFs or text in {d}; the hint has the title only'); return None
    return d

def materials(folder):
    # Text of every .txt/.md in the folder; a .pdf is converted once with pdftotext into a .txt beside it.
    docs = []
    for f in sorted(folder.iterdir()):
        if f.suffix == '.pdf' and not f.with_suffix('.txt').exists():
            subprocess.run(['pdftotext', '-layout', str(f), str(f.with_suffix('.txt'))], check=True)
        if f.suffix in ('.txt', '.md'): docs.append(f.read_text(errors='replace'))
    # Nothing readable is said, never an exit (loggie-pause-attach debt): a stop that reads materials goes on without them.
    if not docs: print(f'no readable materials in {folder}; the hint has the title only', file=sys.stderr)
    return docs

def mail_terms(event):
    # Seam: names and terms from the mail threads with the attendees, once the mail reader exists. They rank above the
    # course terms because they are about these people. Returns [] until then.
    return []

def course(event):
    # Loggie's courses.json (hikyaku folder: match, name, professor, email, syllabus) names the professor; the course
    # pack prints his name on every page, which rank() rightly treats as a watermark, so he comes from here instead.
    f = COURSES.parent / 'courses.json'
    if not f.exists(): return None
    title = event.get('title', '')
    return next((c for c in json.loads(f.read_text()) if c.get('match') and c['match'] in title), None)

def hint(event, limit=CHARS):
    # The hint: who the meeting is with (names are where transcripts fail), then the terms in rank order
    # until the character budget is spent. Returns the prompt and the terms it carries.
    names = event.get('names') or event.get('attendees') or ''
    c = course(event)
    # The user's own name goes in too: Whisper heard "Gio" as "Jill" on the Priya call (2026-10-07).
    me = event.get('me', '')
    lead = f"Meeting with {names}{f' and {me}' if me and me not in names else ''}." if names else f"{event.get('title', 'Meeting')}" + (f", class with {c['professor']}." if c and c.get('professor') else '.')
    terms = list(mail_terms(event))
    folder = materials_dir(event)
    if folder: terms += [t for t in rank(materials(folder)) if t not in terms]
    # A plain list after the lead, no "Topics:" label: a colon in the prompt made Whisper invent speaker labels inside
    # lines ("J.B.:" 9 times, "Bari:" 5 times on one clip, 2026-10-06); the same terms as a plain list invented none.
    kept, used = [], len(lead) + 2
    for t in terms:
        if used + len(t) + 2 > limit: break
        kept.append(t); used += len(t) + 2
    return (lead + (' ' + ', '.join(kept) + '.' if kept else '')), kept

# ---------- honest marks ----------

NUMBER = re.compile(r"\d|^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|"
                    r"seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|"
                    r"billion|half|quarter|percent|dozen)$", re.I)
UNIT = re.compile(r"^(?:mg|mcg|µg|ug|ml|g|kg|lb|lbs|oz|cc|iu|units?|tablets?|pills?|capsules?|doses?|mmol|hrs?|am|pm|a\.m|p\.m)$", re.I)
DATES = set('''january february march april may june july august september october november december jan feb mar apr jun jul aug
sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday today tomorrow yesterday tonight week weekend
month year'''.split())
PRONOUN_I = {'I', "I'm", "I'll", "I'd", "I've"}

def core(word): return word.strip().strip("\"'([{").rstrip("\"')]},.;:!?")

def markable(word, sentence_start):
    # Only names, numbers, dates and doses are marked: a wrong "the" costs nothing, a wrong dose or name costs a lot.
    w = core(word)
    if not w: return False
    if NUMBER.search(w) or UNIT.match(w) or w.lower() in DATES: return True
    return w[0].isupper() and not sentence_start and w not in PRONOUN_I

def marked(line, threshold=THRESHOLD, mark=' (unclear)'):
    # The line's text rebuilt from its words, the mark after a weak name/number before its trailing punctuation.
    out, start = '', True
    for w in line['words']:
        text = w['text']
        if w['p'] < threshold and (markable(text, start) or w.get('clue') == 'near'):   # near: bubble_check.py
            c = core(text); i = text.rfind(c) + len(c)
            m = f"{mark[:-1]}; likely {w['likely']})" if w.get('likely') else mark   # a boosted reader's label (nvidia_engine.suggest)
            text = text[:i] + m + text[i:]
        out += text
        start = bool(re.search(r'[.!?]["\')]*\s*$', text))
    return out.strip()

def marks(lines, threshold=THRESHOLD):
    found = []
    for l in lines:
        start = True
        for w in l['words']:
            if w['p'] < threshold and (markable(w['text'], start) or w.get('clue') == 'near'): found.append({'t': l['t'], 'word': core(w['text']), 'p': round(w['p'], 3), 'who': l.get('who', '')})
            start = bool(re.search(r'[.!?]["\')]*\s*$', w['text']))
    return found

# ---------- transcript.md ----------

SIDES = ('me', 'them')

def sides_of(event):
    # The tracks a call reads (split recording, 2026-10-28): event.json "sides" ["me"] for the room's mic, ["them"] for the
    # Mac's sound, absent for both, as every call before. One recording can be two meetings; each folder reads its own.
    sides = (event or {}).get('sides') or list(SIDES)
    bad = [s for s in sides if s not in SIDES]
    if bad: raise ValueError(f'event.json "sides" names {bad}; a side is "me" or "them"')
    return tuple(s for s in SIDES if s in sides)

def label_of(sides, side):
    # The line label of a side's track. The mic alone heard everyone in the room, the professor too, so it is "Room",
    # never "Me" (2026-10-28: 709 class lines all read "Me", and the notes model read the professor as Gio).
    if side == 'them': return 'Them'
    return 'Room' if tuple(sides) == ('me',) else 'Me'

def stamp(t): return f'{int(t // 60):02d}:{int(t % 60):02d}'

def duration(wav):
    with wave.open(str(wav)) as w: return w.getnframes() / w.getframerate()

NVIDIA_RULE = 'A word marked (unclear) is a name, number, date or dose the two NVIDIA readers (Parakeet, Nemotron) heard differently.'

def header(event, folder, seconds, version, model='', rule=NVIDIA_RULE, note=''):
    from datetime import datetime
    # The press, not the event's start (2026-10-27); a call from before recorded_at has the press in its folder name
    # (call.py start), so that comes before the event's start (2026-10-28: 7 of 36 old calls said a block's start).
    def at(text, form=None):
        try: return datetime.strptime(text, form) if form else datetime.fromisoformat(text.replace('Z', '+00:00')).astimezone()
        except (ValueError, AttributeError, TypeError): return None
    when = at(event.get('recorded_at')) or at(Path(folder).name[:15], '%Y-%m-%d-%H%M') or at(event.get('start'))
    day = when.strftime('%A, %B %-d, %Y, %-H:%M') if when else 'date unknown'
    # The person found on the call (them.py) before the invite's names, which name who sent it (2026-10-27).
    who = f"Me ({event.get('me', 'Me')}) and {event.get('them_label') or event.get('attendees') or 'Them'}"
    sides = sides_of(event)   # one side of a split recording says which, and what it cannot hold (2026-10-28)
    if sides == ('me',): who = 'Recorded in the room; the mic heard everyone'
    elif sides == ('them',): who = f"{event.get('them_label') or 'Them'}: the Mac's sound. Your own voice is not on this side"
    return (f"# {event.get('title', 'Call')}\n\n{day}, {int(round(seconds / 60))} min. {who}.\n"
            f"_{getattr(model, 'name', model)}, {version}. {rule}{(' ' + note) if note else ''}_\n")

def markdown(lines, who, threshold=THRESHOLD, every=60.0, pause=4.0):
    # One paragraph per turn: consecutive lines from the same speaker joined, stamped where the turn starts. A turn
    # also breaks at a pause, or after a minute at the next sentence end: in a lecture every Zoom voice is "Them", so
    # turns alone gave a 14-minute paragraph (NBA 6530, 12:50 to 26:27, 2026-10-06), unreadable and unciteable.
    turns, last = [], None
    for l in lines:
        speaker = who(l)
        same = turns and turns[-1][0] == speaker
        # With the hint carried, Whisper often ends lines mid-sentence (v6: 39:59 to 43:37 had no line end on a period),
        # so after two minutes the paragraph breaks at the next line regardless.
        ran = l['t'] - turns[-1][1] if same else 0
        long = ran >= 2 * every or (ran >= every and re.search(r'[.?!]["\')]*$', last['text'].strip()))
        if same and not long and l['t'] - last.get('end', last['t']) < pause: turns[-1][2].append(marked(l, threshold))
        else: turns.append((speaker, l['t'], [marked(l, threshold)]))
        last = l
    return '\n\n'.join(f"[{stamp(t)}] {speaker}: {' '.join(texts)}" for speaker, t, texts in turns) + '\n'

def new_version(folder, suffix='nvidia'):
    # Every redo writes into its own subfolder (v3-nvidia; the live check's v2-check); v1 is the call folder itself
    # and is never touched.
    folder = Path(folder)
    n = 2 + len([d for d in folder.iterdir() if d.is_dir() and re.match(r'v\d+-', d.name)])
    out = folder / f'v{n}-{suffix}'
    if out.exists(): sys.exit(f'{out} already exists')
    out.mkdir()
    return out
