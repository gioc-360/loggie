# Spellings the user's own words prove, applied on the Mac before the screen (loggie-auto-spelling, 2026-10-26). The
# speech readers heard "M&T" as "MNT (unclear)" and "MT (unclear)" all through the mock interview; the notes kept "MNT",
# and the name check that could fix it only suggests, after the notes are written. Gio: "i want it to be automatic
# without hardcoding". Nothing here is a list of fixes: every spelling comes from the user's own words (workspace names,
# my-words.txt, the call's lexicon.json from mail, the title and the invite), and a word changes only when a rule proves
# it, on a word the readers marked (unclear):
#   heard-as   my-words.txt says so ("M&T: MNT"), as the user taught it with a ✓ on a suggestion
#   ampersand  an "&" said aloud: "M&T" heard as "MNT", "MandT" or "MT"
# A word sounding like one of the user's words (name-check.js soundex) stays a suggestion: soundex matches Robert and
# Rupert. A person's name is never respelled, and a word the user kept with ✕ (name-checks.json "kept") stays as heard.
#   fixes = proven(folder, event, text)  ->  { heard: { to, rule, source } }
#   apply(text, fixes)                   ->  text with every "<heard> (unclear)" written as its spelling
import json, re
from pathlib import Path

UNCLEAR = re.compile(r"(?<![\w&'’-])([A-Za-z][\w&'’-]*?)(['’]s)? \(unclear(?:; likely [^)]*)?\)")
norm = lambda text: re.sub(r'[^a-z0-9]+', '', str(text).lower())
PAGE_TERMS = 80   # a page's most useful terms (transcript.rank order) among the user's own words

def read_json(path, default):
    try: return json.loads(Path(path).read_text())
    except (OSError, ValueError): return default

def home_of(folder):
    # The hikyaku folder: the parent of the calls folder the call sits in, or None (a call outside one has no words).
    return next((p.parent for p in [Path(folder).resolve(), *Path(folder).resolve().parents] if p.name == 'calls'), None)

def my_words(path):
    # my-words.txt: "Canonical: heard, heard" per line, # comments (lexicon.py my_words, name-check.js parseMyWords).
    out = []
    for line in (Path(path).read_text(errors='replace').splitlines() if Path(path).exists() else []):
        line = line.strip()
        if not line or line.startswith('#'): continue
        canonical, _, heard = line.partition(':')
        out.append((canonical.strip(), [h.strip() for h in heard.split(',') if h.strip()]))
    return out

def own_words(folder, event):
    # [(text, source label)]: the words the user wrote, each with where it came from.
    folder, home = Path(folder), home_of(folder)
    out = []
    if home is not None:
        for w in read_json(home / 'workstreams.json', []):
            if isinstance(w, dict) and str(w.get('name') or '').strip(): out.append((str(w['name']).strip(), f'workspace "{str(w["name"]).strip()}"'))
        for canonical, _ in my_words(home / 'my-words.txt'): out.append((canonical, 'your words'))
    for f in (folder / 'lexicon.json', folder.parent / 'lexicon.json'):
        data = read_json(f, {})
        for e in (data.get('entries', []) if isinstance(data, dict) else []):
            if isinstance(e, dict) and e.get('text'): out.append((str(e['text']), {'mail': 'your mail', 'title': 'the invite', 'invitee': 'the invite', 'own': 'your name'}.get(e.get('source'), 'your words')))
    if event.get('title'): out.append((str(event['title']), 'the invite'))
    # The pages tucked into the call (loggie-pause-attach): the terms they would teach a reader (transcript.rank), by name.
    import pages, privacy, transcript
    for name, text in pages.pages_of(privacy.pages_home(folder)):
        if text: out += [(term, f'your page "{name}"') for term in transcript.rank([text])[:PAGE_TERMS]]
    return out

def people_words(event):
    # The words of every name on the call (invitees, the user): never respelled.
    names = ' '.join(str(event.get(k) or '') for k in ('names', 'with', 'attendees', 'me'))
    return {norm(w) for w in re.findall(r"[A-Za-z][\w'’-]+", names)}

def proven(folder, event, text):
    folder, home = Path(folder), home_of(folder)
    heard_words = {m.group(1) for m in UNCLEAR.finditer(text)}
    if not heard_words: return {}
    kept = set((read_json(folder / 'name-checks.json', {}) or {}).get('kept') or {})
    people = people_words(event)
    taught = {norm(h): (canonical, 'your words') for canonical, hs in (my_words(home / 'my-words.txt') if home is not None else []) for h in hs}
    spoken = {}
    for words, source in own_words(folder, event):
        for part in re.findall(r"[A-Za-z0-9][\w'’-]*&[\w&'’-]*[A-Za-z0-9]", words):
            for said in (part.replace('&', 'n'), part.replace('&', 'and'), part.replace('&', '')):
                spoken.setdefault(norm(said), (part, source))
    fixes = {}
    for heard in sorted(heard_words):
        key = norm(heard)
        if heard in kept or key in people or not key: continue
        if key in taught and norm(taught[key][0]) != key: fixes[heard] = {'to': taught[key][0], 'rule': 'heard-as', 'source': taught[key][1]}
        elif key in spoken and spoken[key][0] != heard: fixes[heard] = {'to': spoken[key][0], 'rule': 'ampersand', 'source': spoken[key][1]}
    return fixes

def apply(text, fixes):
    # Every mention of a proven word, marked (unclear) or not ("MNT" was heard plain 3 times besides 21 marked): the same
    # word in the same call. Whole word, case as heard, the mark folded into the spelling.
    if not fixes: return text
    words = '|'.join(re.escape(h) for h in sorted(fixes, key=len, reverse=True))
    rx = re.compile(rf"(?<![\w&'’-])({words})(['’]s)?(?: \(unclear(?:; likely [^)]*)?\))?(?![\w&'’-])")
    return rx.sub(lambda m: fixes[m.group(1)]['to'] + (m.group(2) or ''), text)

def apply_record(value, fixes):
    # Every string of a line record (byo read_md: text, bare, spoken).
    if not fixes: return value
    if isinstance(value, str): return apply(value, fixes)
    if isinstance(value, dict): return {k: apply_record(v, fixes) for k, v in value.items()}
    if isinstance(value, list): return [apply_record(v, fixes) for v in value]
    return value
