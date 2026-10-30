# Shared helpers for the call summary (byo.py and goal_notes.py) and the privacy screen: who is called what, the
# writing check, the citation check, the date and deadline words, the meaning check, the blind text. The summary itself
# is written by byo.py, in the cloud, after the user's Send; nothing here calls a model. This file used to be the
# summarizer that ran Nemotron on this Mac; that path was removed (Gio, 2026-10-18: "fully remove nemotron on mac").
# Why each rule exists is kept with the rule: most came from real calls the local summaries got wrong.
import json, math, re, sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import transcript

WINDOW = 30.0    # a quote counts when it is said within this many seconds of the stamp
MIN_KEY = 3      # words; Nano cited "Get him" as a task on the 2026-10-06 class, two words match almost anywhere
SENTENCE_WORDS, BULLET_SENTENCES = 25, 3   # STE 6.3 caps a sentence at 25 words; STE 6.6 caps a paragraph at six sentences, a bullet gets three

def kind_of(event): return event.get('category') or ('class' if re.search(r'\b[A-Z]{2,4}\s?\d{4}\b', event.get('title', '')) else 'chat')

def one_other(event):
    # The one other person of a 1:1, from the invite, or None when the invite names several or nobody.
    other = event.get('with') or event.get('names') or event.get('attendees') or ''
    parts = [p.strip() for p in re.split(r',|;|\band\b|&', other) if p.strip()]
    return parts[0] if len(parts) == 1 and parts[0] != 'the other person' else None

def names_for(event):
    # What code writes for the recorder's labels before the writing check (2026-10-07: "Me injured his knee" reached the
    # file; a label is never a name). A class: "Me" is a student. Any other call: "Me" is the user by name, "Them" the one
    # other person by invite name; with no user name or several others, nothing is substituted and the check flags the label.
    me = event.get('me') or ''
    # A class: the user by name when the event knows it (loggie-class-notes D1: the room's "Gio?" reaches the notes as
    # Gio), else "a student"; classmates are labels, so there is no one other person.
    if kind_of(event) == 'class': return {'me': me if me and me != 'Me' else 'a student', 'other': None}
    return {'me': me if me and me != 'Me' else None, 'other': one_other(event)}

def name_labels(text, names):
    # "Me" -> the user's name (a class: "a student"), "Them" -> the one other person, by code, before the writing check.
    # Returns the text and how many labels were replaced. Lowercase "me" and "them" are ordinary pronouns and stay.
    n = 0
    def swap(word, name):
        nonlocal n
        def rep(m):
            nonlocal n; n += 1
            start = m.start() == 0 or m.string[:m.start()].rstrip().endswith(('.', '?', '!', ':'))
            return name[0].upper() + name[1:] if start else name
        return re.sub(rf"\b{word}\b", rep, text)
    if names.get('me'): text = swap('Me', names['me'])
    if names.get('other'): text = swap('Them', names['other'])
    return text, n

def leaked(text, examples, n=4):
    # The example phrase a note copies, or None: any run of 4 words shared with one of the prompt's examples (a dict),
    # after the placeholders are taken out and stop-word-only runs are ignored. The guard is code because the prompt
    # alone did not hold (the 30B's "Send the signed lease to Ana by March 3" on the Priya call, 2026-10-07).
    words = norm(text).split()
    grams = {' '.join(words[i:i + n]) for i in range(len(words) - n + 1)}
    for ex in examples.values():
        ew = norm(re.sub(r'<[^>]*>', ' ', ex)).split()
        for i in range(len(ew) - n + 1):
            g = ' '.join(ew[i:i + n])
            if g in grams and set(ew[i:i + n]) - STOP: return g
    return None

# ---------- the writing standard, checked by code ----------

# Verbs that report that something was said instead of saying it. Inflected forms only: "Review the materials" and
# "Cover the deposit" are commands in the due list, "discusses" never is. Checked in the first words of each sentence,
# where the main verb of a short sentence sits, and as a passive anywhere ("three layers were outlined").
REPORTING = (r"discusses|discussed|explains|explained|covers|covered|describes|described|mentions|mentioned|highlights|highlighted|emphasizes|emphasized|emphasises|emphasised"
             r"|outlines|outlined|explores|explored|addresses|addressed|presents|presented|stresses|stressed|summarizes|summarized|recaps|recapped|elaborates|elaborated"
             r"|talks about|talked about|goes over|went over|touches on|touched on|notes that|noted that|points out|pointed out|walks through|walked through|focuses on|focused on"
             r"|provides examples|provided examples|gives examples|gave examples")
BASE = r"discuss|explain|describe|mention|highlight|emphasize|emphasise|outline|explore|summarize|recap|elaborate"   # after a plural subject ("outcomes highlight the importance of"); first-word base forms are commands
REPORTS = re.compile(rf"^(?:\S+\s+){{0,6}}?({REPORTING})\b|^(?:\S+\s+){{1,6}}?({BASE})\b", re.I)
PASSIVE_REPORT = re.compile(rf"\b(?:is|are|was|were|be|been|being)\s+({REPORTING})\b", re.I)
PASSIVE_BY = re.compile(r"\b(?:is|are|was|were|been|being)\s+(\w+(?:ed|en))\s+by\b", re.I)   # only the "by" passive: high precision, STE 3.5
LABELS = re.compile(r"\b(What|Why|How|Who|When|Where|Impact|Result|Context|Action)\s*:", re.I)
VOICE = re.compile(r"\b(?:you|your|yours|yourself|yourselves|the user)\b", re.I)
LABEL_WORDS = re.compile(r"\b(?:Them|Me)\b")   # the recorder's labels, capitalized; "them" and "me" in running text are ordinary pronouns

def style_check(text, me=None):
    # The rules a bullet can break, each with a short reason: (rule, reason) pairs, empty when the bullet passes.
    out = []
    parts = sentences(text or '')
    if not parts: return out
    for s in parts:
        n = len(s.split())
        if n > SENTENCE_WORDS: out.append(('words', f'{n} words in the sentence "{" ".join(s.split()[:4])}..." (limit {SENTENCE_WORDS}); split it into two or three shorter sentences'))
    if len(parts) > BULLET_SENTENCES: out.append(('sentences', f'{len(parts)} sentences; one idea per bullet, at most {BULLET_SENTENCES} sentences'))
    seen = set()
    for s in parts:
        m = REPORTS.search(s) or PASSIVE_REPORT.search(s)
        verb = next((g for g in m.groups() if g), '').lower() if m else ''
        if verb and verb not in seen: seen.add(verb); out.append(('reports', f'main verb "{verb}" reports instead of stating'))
    for m in LABEL_WORDS.finditer(text): out.append(('speaker', f'subject "{m.group(0)}"')); break
    m = VOICE.search(text)
    if m: out.append(('speaker', f'"{m.group(0)}" is not objective'))
    names = [n for n in {str(me or '').strip(), str(me or '').split()[0] if me else ''} if n and n != 'Me']
    for s in parts:
        if any(re.match(rf'{re.escape(n)}\b', s) for n in names): out.append(('speaker', f'the user ({names[0]}) as a subject')); break
    m = LABELS.search(text)
    if m: out.append(('labels', f'label "{m.group(0).strip()}"; write the sentence instead'))
    m = PASSIVE_BY.search(text)
    if m: out.append(('passive', f'"{m.group(0)}" is passive; say who did it'))
    return out

# ---------- the citation check ----------

def norm(s): return re.sub(r'[^a-z0-9 ]', '', re.sub(r'\s+', ' ', str(s).lower())).strip()

def seconds(at):
    m = re.fullmatch(r'\s*\[?(\d+):(\d\d)(?::(\d\d))?\]?\s*', str(at or ''))
    if not m: return None
    return (int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))) if m.group(3) else int(m.group(1)) * 60 + int(m.group(2))

# The speaker label a model puts in front of a quote ("Gio: Uh so I'm competing...", "Them: So two pillars..."): the
# transcript's lines carry the words only, so a labelled quote was never found. On the 2026-10-09 Liz call (Nemotron
# Super) every one of 14 quotes had it: 0 of 14 bullets backed, and the one next step dropped. With it cut, 14 of 14.
SPEAKER = re.compile(r"^\s*(?:me|them|you|[A-Z][\w'.-]*(?: [A-Z][\w'.-]*)?(?: \([^)]*\))?)\s*:\s+")

def cite(bullet, lines, window=WINDOW):
    # The line that backs a bullet, or why none does. The key phrase may run over a line break: the lines near the
    # stamp are also searched joined, and the line where the phrase starts is the citation. A quote stitched with
    # "..." (the 9B's habit: 14 of its 16 unbacked quotes on the 2026-10-06 class, stamps right) is checked by its
    # longest fragment of three words or more, and the check says so.
    at, quote = seconds(bullet.get('at')), SPEAKER.sub('', str(bullet.get('quote', '')), count=1)
    if at is None: return None, 'no stamp'
    parts = [norm(x) for x in re.split(r'\.\.\.|…', quote)]
    key, note = norm(quote), None
    if len(parts) > 1:   # a stitched quote is never verbatim as a whole: only a fragment can back it
        parts = sorted((x for x in parts if len(x.split()) >= MIN_KEY), key=len, reverse=True)
        if not parts: return None, 'no quote'
        key, note = parts[0], f'quote stitched with ...; its part "{parts[0]}" checked'
    if len(key.split()) < MIN_KEY: return None, 'no quote'
    line, why = find(key, at, lines, window)
    return line, (f'{note}; {why}' if note and why else note or why)

def find(key, at, lines, window):
    near = [l for l in lines if abs(l['t'] - at) <= window]
    for l in near:
        if key in norm(l['text']): return l, None
    texts = [norm(l['text']) for l in near]
    pos = ' '.join(texts).find(key)
    if pos >= 0:
        start = 0
        for l, t in zip(near, texts):
            if pos < start + len(t) + 1: return l, None
            start += len(t) + 1
    # Nano's quotes were verbatim and its stamps minutes off ("John and Clark spoke about Corning Vitro" stamped 05:04,
    # said at 07:05; 13 of its 17 unbacked bullets on the 2026-10-06 class). A quote said exactly once in the whole call
    # is its own stamp: the bullet is backed and the stamp is moved, and the run records the move.
    hits = [l for l in lines if key in norm(l['text'])]
    if len(hits) == 1: return hits[0], f"stamp moved from {transcript.stamp(at)} to {transcript.stamp(hits[0]['t'])}: the quote is said once in the call"
    return None, 'nothing said near the stamp' if not near else f'quote not said within {int(window)} s of the stamp'

ABBREV = re.compile(r"\b(?:[ap]\.m|mr|mrs|ms|dr|st|vs|e\.g|i\.e|no)\.$", re.I)

def sentences(text):
    # Split at . ? ! followed by a space, except after an abbreviation: "9 a.m. at Breazano 221" is one sentence (2026-10-06).
    out = []
    for s in re.split(r'(?<=[.?!])\s+', text.strip()):
        if not s: continue
        if out and ABBREV.search(out[-1]): out[-1] += ' ' + s
        else: out.append(s)
    return out

# ---------- dates and deadline words ----------

DAYS = r"monday|tuesday|wednesday|thursday|friday|saturday|sunday"
MONTHS = r"january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec"
WHEN = re.compile(rf"\b(?:{DAYS})\b|\b(?:{MONTHS})\.? \d{{1,2}}(?:st|nd|rd|th)?\b|\b\d{{1,2}}(?::\d\d)? ?(?:a\.?m\.?|p\.?m\.?)(?![a-z])|\b\d{{1,2}} o'clock\b"
                  rf"|\b(?:next|this|last) (?:week|month|year|{DAYS})\b|\btomorrow\b|\bthe \d{{1,2}}(?:st|nd|rd|th)\b|\b\d{{1,2}}/\d{{1,2}}(?:/\d{{2,4}})?\b", re.I)
DUE_STRONG = re.compile(r"\bdue\b(?! to\b| diligence\b)|\bdeadline\b", re.I)   # "due diligence" and "due to" are not deadlines (class, 2026-10-06)
DUE_WEAK = re.compile(r"\b(?:exam|midterm|assignment|homework|submit|submission|quiz|presentation|office hours)\b", re.I)

class Deadline:
    # A deadline word alone is not a deadline: "I can simulate in my final presentation" reached the Priya call's dates
    # list on "presentation" (2026-10-07). "due" and "deadline" stand alone; the nouns (exam, assignment, presentation...)
    # count only in a sentence that also has a date, time or weekday, or "due"/"deadline".
    @staticmethod
    def search(text): return DUE_STRONG.search(text) or (DUE_WEAK.search(text) and WHEN.search(text)) or None

DUE = Deadline

def content(text): return set(norm(text).split()) - STOP

# ---------- the meaning check ----------
# A quote can be said near its stamp and still not back its note: on the 2026-10-09 Liz call the Dell note (said at
# 07:09) cited the hackathon line at 04:42. The note's own words are looked for too, rare words counting more (a word
# in fewer of the user's call transcripts weighs more: "Copilot" over "program"). Set from that call, where Gio graded
# all 14 notes true, against 697 notes from his other calls that did not happen in it: a 90 s window and a 0.25 share
# flag 1 of the 14 and pass about 4% of the others, most of which are true there too (his Dell story is in every chat).
MEANING_W = 90.0
MEANING_CUT = 0.25
MEANING_MIN_CALLS = 5   # with fewer transcripts no word is rare yet; the check says it is off rather than guess

def word_weights(transcripts):
    # The weight of each word, from the user's call transcripts, or None when there are too few to tell rare from common.
    docs = [content(t) for t in transcripts]
    if len(docs) < MEANING_MIN_CALLS: return None
    seen = {}
    for d in docs:
        for w in d: seen[w] = seen.get(w, 0) + 1
    n = len(docs)
    return lambda w: math.log((n + 1) / (1 + seen.get(w, 0)))

def meaning(text, lines, t, weight, window=MEANING_W):
    # The share of the note's word weight said within `window` s of second t, and the best line anywhere with its share.
    words = content(text); total = sum(weight(w) for w in words)
    if not total: return 0.0, None, 0.0
    near = lambda at: content(' '.join(l['text'] for l in lines if abs(l['t'] - at) <= window))
    share = lambda at: sum(weight(w) for w in words & near(at)) / total
    here = share(t) if t is not None else 0.0
    best, best_share = None, 0.0
    for l in lines:
        s = share(l['t'])
        if s > best_share: best, best_share = l, s
    return here, best, best_share

STOP = set('a an the and or but of to in on at for with by from as is are was were be been it its this that these those he she they we you i me my our your his her their them not no so if then than do did does have has had will would can could'.split())

# ---------- blind text, run files and the event ----------

# The rival notes app's name, kept here and nowhere else, for data already on disk: its exports carry a link on its
# domain (blind_text strips it), and older call folders hold its transcript as <name>-transcript.txt (rival_transcript).
OLD_NAME = 'granola'

def rival_transcript(call):
    # <call>/rival-transcript.txt; a call folder from before 2026-10-20 holds it under the old name (OLD_NAME).
    new = Path(call) / 'rival-transcript.txt'
    return new if new.exists() else Path(call) / f'{OLD_NAME}-transcript.txt'

def rival_words(path):
    # The rival app's export: a header (title, date, participants), then "Transcript:" and "Speaker: text" lines.
    text = Path(path).read_text()
    text = text.split('Transcript:', 1)[1] if 'Transcript:' in text else text
    return [w for line in text.splitlines() for w in re.findall(r"[a-z0-9']+", re.sub(r'^[^:]{1,40}:\s*', '', line).lower().replace('’', "'"))]

def blind_text(text, title):
    # Everything that says which tool wrote a summary: hikyaku's stamps, marks, model header, cited lines and the
    # code-made "Dates and numbers" list (the same for every hikyaku model, and the rival app has none); the rival app's title
    # (it names the host from the calendar), date line, closing rule and transcript link; curly quotes from either.
    t = text.replace('’', "'").replace('‘', "'").replace('“', '"').replace('”', '"')
    t = re.sub(r'(?ms)^## Dates and numbers\n.*?(?=^## |^\*\*What this was)', '', t)
    t = re.sub(r'(?m)^\s*>.*\n?', '', t)
    t = re.sub(r'(?m)^_summary by .*_\s*\n?', '', t)
    t = re.sub(r'\s*\[\d+:\d\d(?::\d\d)?\]', '', t)
    t = re.sub(r'\s*\((?:not sure|unclear)\)', '', t)
    t = re.sub(r'\s*_not sure:[^_]*_', '', t)
    t = re.sub(r'(?m)^Chat with meeting transcript:.*\n?', '', t)
    t = re.sub(rf'\S*{OLD_NAME}\.ai\S*', '', t)
    t = re.sub(r'(?m)^---\s*\n', '', t)
    # The rival app's date line may carry the attendee after a dot ("Wed, 07 Oct 26 · Priya Shah", 2026-10-07); its next steps are bold
    t = re.sub(r'(?m)^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),? \d{1,2} \w{3} \d{2,4}.*\n', '', t)
    t = re.sub(r'(?m)^# .*\n', '', t)
    # Layout tells, found on the first class blind (2026-10-06): only the rival app nested bullets, only hikyaku opened with
    # "What this was". Flatten nesting, drop that line, and give every file the same spacing.
    t = re.sub(r'(?m)^\*\*What this was:\*\*.*\n?', '', t)
    t = t.replace('**', '')
    t = re.sub(r'(?m)^[ \t]+([-*] )', r'- ', t)
    t = re.sub(r'(?m)^\* ', '- ', t)
    t = re.sub(r'\n\s*\n', '\n', t)
    t = re.sub(r'(?m)^(## .*)$', r'\n\1\n', t)
    t = re.sub(r'\n{3,}', '\n\n', t).strip()
    return f'# {title}\n\n{t}\n'

def claim(folder, name, ext):
    # The first free name (summary-nebius.md, -2, ...), taken at once: it is created empty here, so a second run started
    # meanwhile gets the next one, and nothing in a calls folder is ever overwritten. Two notes runs on one call
    # (2026-10-10) both picked summary-nebius-14.md ten seconds before writing it; one overwrote the other and the second
    # crashed copying its raw folder. The caller removes the empty file if it ends without writing.
    n = 1
    while True:
        p = folder / (f'{name}{ext}' if n == 1 else f'{name}-{n}{ext}')
        try:
            with open(p, 'x'): return p
        except FileExistsError: n += 1

def event_of(folder):
    for f in (folder / 'event.json', folder.parent / 'event.json'):
        if f.exists(): return json.loads(f.read_text())
    sys.exit(f'no event.json in {folder} or its parent')
