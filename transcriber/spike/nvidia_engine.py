# The NVIDIA speech engine behind call.transcribe() (increment 1 of proposal-b.md, 2026-10-07). Two readers, one runtime:
#   words      Parakeet TDT 0.6B v3 in NVIDIA's NeMo-Speech.cpp on Metal: every word with its start and end. Measured
#              2026-10-06 under load: the 48-min class in 2.1 min, 1.37 GB peak, no invented words on silence (no VAD).
#   doubt      Nemotron 3.5 ASR 0.6B, same runtime, reads the same audio. Where the two disagree on a name, number,
#              date or dose, Parakeet's word is marked (unclear). The runtime reports confidence 1.0 for every
#              Parakeet word ("RNNT and beam-decoded results currently report 1.0", NeMo-Speech.cpp 0.2.0
#              docs/asr/configuration.md; checked on the class: all 7,791 words had confidence 1), so a second NVIDIA
#              reader is the only word-level doubt available. Measured on the class Them track (CPU, from the 10-06
#              runs): 889 of 7,791 words differ; after sentence starts, split/joined spellings and number formats are
#              forgiven, 29 marks, among them Siecor ("C Core"), Breazzano, Okafor, Ndiaye, Korea/career, MBA/NBA.
#   gap check  audio with sound and no words for GAP_S loud seconds fails loud. parakeet-mlx dropped 14:48-15:46 silently
#              on 2026-10-06 (58 s, 40 loud seconds); on the clean class track the longest loud stretch between two
#              words was 6.9 s. 15 s is over twice the clean maximum and under half the known failure.
import bisect, difflib, json, re, subprocess, sys, time, wave
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).parent))
import tools
from nvidia_asr import NSC, Footprint, rms_frames
from transcript import stamp

MODELS = Path.home() / 'Library' / 'Application Support' / 'Loggie' / 'models' / 'nvidia'

def gguf(repo):
    # The model file as `nemo-speech pull` left it in Loggie's models folder (a Hugging Face snapshot tree).
    hits = sorted((MODELS / 'hf' / f'models--nvidia--{repo}' / 'snapshots').glob('*/*.gguf'))
    if not hits: hits = sorted((MODELS / 'nvidia' / repo).glob('*/*.gguf'))
    return hits[-1] if hits else MODELS / 'hf' / f'models--nvidia--{repo}' / 'MISSING.gguf'

PARAKEET = gguf('parakeet-tdt-0.6b-v3')
NEMOTRON = gguf('nemotron-3.5-asr-streaming-0.6b')
RUNTIME = 'NeMo-Speech.cpp'
GAP_S = 15.0        # loud seconds with no words that fail the gap check (see the header)
ECHO_S = 1.5        # a Me word is an echo when Them has the same word within this many seconds: the mic hears the speaker
                    # at once (class 2026-10-06: 4,380 Me words had a Them twin, offset median -0.08 s, p10 -0.88, p90 0.00)
ECHO_SHARE = 0.6    # a Me line is an echo when this share of its words are echoes (unchanged from the Whisper merge)

# ---------- the runtime ----------

CHUNK_S = 60.0      # Nemotron reads the audio in pieces of about a minute, cut at the quietest 30 ms frame within 10 s of the
                    # mark (nvidia_asr.cuts), fed as one directory: 86 s for the 48-min class against 253 s whole (2026-10-07).
                    # Parakeet reads the file whole, as measured for proposal-b.md. Its decoder skips short stretches of
                    # speech either way (class Them track, 2026-10-07: whole 9 stretches / 108 words, cut 14 / 210; Me
                    # track the other way round, 10 / 122 cut; Whisper and Nemotron heard them), so the skips are
                    # filled from Nemotron (fill) and anything longer trips the gap check.

def words_of_json(data, offset=0.0):
    raw = data.get('words') or [w for seg in data.get('segments', []) for w in seg.get('words', [])]
    return [{'text': ' ' + str(w.get('word', w.get('text', ''))).strip(), 'start': round(offset + float(w.get('start', 0)), 2), 'end': round(offset + float(w.get('end', 0)), 2), 'p': 1.0}
            for w in raw if str(w.get('word', w.get('text', ''))).strip()], sorted({str(w.get('confidence')) for w in raw})[:3]

def run(model, wav, out_json=None, language=None, device='metal', chunk=None, phrases=None, boost=None):
    # One nemo-speech transcribe call, one model load: the file whole, or cut into `chunk`-second pieces fed as a
    # directory (times put back on the file's clock). JSON out carries every word with start and end. Peak memory of
    # the child is sampled with `footprint` every 2 s (nvidia_asr.Footprint). The merged JSON is kept beside the transcript.
    import tempfile
    from nvidia_asr import read_wav, cuts
    if not Path(model).exists(): sys.exit(f'missing NVIDIA model {model}: run `nemo-speech pull` into {MODELS}')
    t0 = time.time()
    with tempfile.TemporaryDirectory(prefix='hk-chunks-') as tmp:
        tmp = Path(tmp); starts = [0.0]
        if chunk:
            x = read_wav(wav); points = cuts(x, window=chunk); starts = points[:-1]
            (tmp / 'in').mkdir(); (tmp / 'out').mkdir()
            for n, (a, b) in enumerate(zip(points, points[1:])):
                with wave.open(str(tmp / 'in' / f'{n:04d}.wav'), 'wb') as w:
                    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes((x[int(a * 16000):int(b * 16000)] * 32767).astype(np.int16).tobytes())
            cmd = [str(NSC), 'transcribe', str(tmp / 'in'), '--model', str(model), '--format', 'json', '--device', device, '--output-dir', str(tmp / 'out'), '--force']
        else: cmd = [str(NSC), 'transcribe', str(wav), '--model', str(model), '--format', 'json', '--device', device]
        if language: cmd += ['--language', language]
        for phrase in phrases or []: cmd += ['--speech-context', phrase]   # the meeting's written name list (lexicon.json)
        if phrases and boost: cmd += ['--speech-context-boost', str(boost)]
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        fp = Footprint(p.pid); fp.start(); so, se = p.communicate(); fp.stop = True
        if p.returncode: sys.exit(f'nemo-speech failed ({p.returncode}) on {Path(wav).name} with {Path(model).name}: {se.strip()[-1200:]}')
        if chunk:
            failed = re.search(r'\((\d+) failed\)', se)
            if failed and int(failed.group(1)): sys.exit(f'nemo-speech failed on {failed.group(1)} pieces of {Path(wav).name}: {se.strip()[-1200:]}')
            parts = []
            for n, a in enumerate(starts):
                f = tmp / 'out' / f'{n:04d}.json'
                if not f.exists(): sys.exit(f'nemo-speech wrote no JSON for piece {n} of {Path(wav).name} ({a:.0f} s): {se.strip()[-500:]}')
                parts.append((a, json.loads(f.read_text())))
            words, conf = [], set()
            for a, d in parts: ws, c = words_of_json(d, a); words += ws; conf |= set(c)
            data = {'file': str(wav), 'chunks': [{'start': a, 'duration': d.get('duration'), 'words': len(d.get('words', []))} for a, d in parts], 'text': ' '.join(d.get('text', '') for _, d in parts), 'words': [{'word': w['text'].strip(), 'start': w['start'], 'end': w['end']} for w in words]}
        else:
            try: data = json.loads(so)
            except json.JSONDecodeError: sys.exit(f'nemo-speech wrote no JSON for {Path(wav).name}: {so[:300]!r} {se.strip()[-500:]}')
            words, conf = words_of_json(data)
    if out_json: Path(out_json).write_text(json.dumps(data, ensure_ascii=False))
    return words, {'model': Path(model).name, 'chunk_s': chunk, 'pieces': len(starts), 'seconds': round(time.time() - t0, 1), 'peak_gb': round(fp.peak_kb / 1024 / 1024, 2), 'words': len(words), 'runtime_confidence': sorted(conf)}

def parakeet(wav, out_json=None): return run(PARAKEET, wav, out_json)
def nemotron(wav, out_json=None, phrases=None): return run(NEMOTRON, wav, out_json, language='en', chunk=CHUNK_S, phrases=phrases, boost=BOOST if phrases else None)   # whole-file took 295 s for 24 min on the Priya Me track (2026-10-07, load 5)

def version():
    out = subprocess.run([str(NSC), '--version'], capture_output=True, text=True)
    return (out.stdout + out.stderr).strip().splitlines()[0] if (out.stdout + out.stderr).strip() else 'unknown'

# ---------- two readers: agreement ----------

NUMS = {w: i for i, w in enumerate('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split())}
NUMS['oh'] = 0
TENS = {w: (i + 2) * 10 for i, w in enumerate('twenty thirty forty fifty sixty seventy eighty ninety'.split())}
SCALE = {'hundred': 100, 'thousand': 1000, 'million': 1000000, 'billion': 1000000000}

ORDINALS = {w: i + 1 for i, w in enumerate('first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth'.split())}

def key(text):
    # One spelling for both readers: lowercase letters and digits ("D.C." and "DC", "Ps" and "P's" are one word; the
    # apostrophe marks on the Priya call were only Nemotron's spelling); "5th" and "fifth" are one number.
    k = re.sub(r"[^a-z0-9]", '', text.lower())
    k = re.sub(r'^(\d+)(st|nd|rd|th)$', r'\1', k)
    return str(ORDINALS[k]) if k in ORDINALS else k

def digits(keys):
    # The digits a span says, number words composed ("twenty four" = 24, "one hundred" = 100, "ten oh two" = 10 0 2),
    # so Parakeet's "24" and Nemotron's "twenty four" are the same number, and "10.02, 10.05" matches "ten oh two ten oh five".
    out, cur, open_ = [], 0, False
    def flush():
        nonlocal cur, open_
        if open_: out.append(str(cur))
        cur, open_ = 0, False
    for k in keys:
        round_ = open_ and cur >= 100 and cur % 100 == 0   # "two hundred" so far: a tens or unit word adds to it
        if k in TENS:
            if round_: cur += TENS[k]
            else: flush(); cur, open_ = TENS[k], True
        elif k in NUMS:
            v = NUMS[k]
            if open_ and 0 < v < 10 and (cur in TENS.values() or round_): cur += v
            elif round_ and 10 <= v < 20: cur += v
            else: flush(); cur, open_ = v, True
        elif k in SCALE: cur = (cur or 1) * SCALE[k]; open_ = True
        else:
            flush()
            d = re.sub(r'\D', '', k)
            if d: out.append(d)
    flush()
    return ''.join(out)

def same_span(a, b):
    # Two spans say the same thing when their letters agree once spaces are gone ("C Core" vs "ccore", "a.m." vs "am"),
    # or when both carry a number and the numbers agree.
    if ''.join(a) == ''.join(b): return True
    return any(c.isdigit() for c in ''.join(a)) and digits(a) != '' and digits(a) == digits(b)

def sentence_start(prev): return prev is None or bool(re.search(r'[.!?]["\')]*\s*$', prev['text']))

BOOST = 4.0         # Nemotron's --speech-context-boost, for the label pass only (suggest()). Priya call, 2026-10-07: 1 and 3
                    # changed nothing; 4 heard "Gio" for Parakeet's "Jill" but also wrote "Priya" ~7 extra times and
                    # "Caballero"/"Breazzano" never said; 5 and 6 planted far more (Breazzano 8x). So a boosted run never
                    # writes words: it only suggests a label next to a name Parakeet already wrote. Parakeet's TDT head
                    # ignores boosting in this runtime (it needs the Flashlight LM decoder).
ESTABLISHED = 3     # agreed this many times elsewhere in the call (Priya "Dell" 12; class "JB" 2 was a real JV/JB doubt)

def unplural(keys):
    # "PMs"/"PM" and "Taiwan's C B C"/"Taiwan CBC" are one thing said: a trailing s (plural or possessive, the
    # apostrophe is already gone in key()) is not a hearing doubt. Only on words of 3+ letters, so "Ps" stays "ps".
    return ''.join(k[:-1] if len(k) > 2 and k.endswith('s') else k for k in keys)

def core_cap(text):
    w = re.sub(r'^[^A-Za-z0-9]+|[^A-Za-z0-9]+$', '', text)
    return bool(w) and w[0].isupper() and len(w) > 1

def is_number(k): return any(c.isdigit() for c in k) or k in NUMS or k in TENS or k in SCALE

def confirmed(pairs):
    # How often each word was written the same by both readers anywhere in the call (both tracks): a word the two
    # agreed on twice elsewhere is established in this call, so one disagreement on it is the second reader's slip.
    # Priya v4 (2026-10-07): "Dell" agreed 12 times, then marked three times against "the", "they'll", "Del".
    # Counted per track and the larger count kept, not the sum: the Me mic hears the speaker, so every Them word has an
    # echo on the Me track, and a sum doubled "City" (said twice) to 4 and hid it from capital_clue (Priya v6).
    seen = {}
    for words, other in pairs:
        track = {}
        a = [key(w['text']) for w in words]; b = [key(w['text']) for w in other]
        for tag, i1, i2, _, _ in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
            if tag == 'equal':
                for k in a[i1:i2]: track[k] = track.get(k, 0) + 1
        for k, n in track.items(): seen[k] = max(seen.get(k, 0), n)
    return seen

def agree(words, other, markable, established=None, lexicon=None):
    # Parakeet's words, with p = 0.0 on every name, number, date or dose (the caller's markable rule) that Nemotron
    # heard differently, and what it heard in 'heard'. Only a 'replace' is a disagreement: where the second reader
    # heard nothing (its streaming decoder drops short bursts; 99 fewer words on the class) nobody heard another word,
    # and where it heard an extra word there is nothing of Parakeet's to mark. Returns the words and a count.
    # Four forgiveness rules (cycle 3, proposal-c.md): on the Priya call 16-17 of 21 marks were false alarms, and a
    # mark that is usually wrong teaches the reader to skip marks. Each forgiven word is counted by rule in the report.
    #   plural      the spans are the same letters once a trailing s is dropped (PMs/PM, Taiwan's C B C/Taiwan CBC)
    #   number      Parakeet wrote a number or a lone letter and the second reader heard no number or letter there at
    #               all ("4 P" against "anyways"): nobody heard a different number, the streaming reader lost it. A lone
    #               letter right before a capitalized word is a name's initial ("C Core", Siecor on the class): kept.
    #   established Parakeet's word (not a number) was agreed by both readers at least ESTABLISHED times elsewhere in
    #               the call, and the second reader's rival is at most two words. A longer rival is a different phrase
    #               heard, a real doubt: class "Korea" (agreed 11 times) against "career sense miss signals" stays.
    #   lexicon     Parakeet's word is on the meeting's written name list (lexicon.json: typed by someone, never guessed)
    established = established or {}; lexicon = lexicon or set()
    a = [key(w['text']) for w in words]; b = [key(w['text']) for w in other]
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    report = {'words': len(words), 'other_words': len(other), 'differ': 0, 'marked': 0, 'forgiven': {'plural': 0, 'number': 0, 'established': 0, 'lexicon': 0}}
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal': continue
        report['differ'] += max(i2 - i1, j2 - j1)
        if tag != 'replace' or ''.join(a[i1:i2]) == ''.join(b[j1:j2]): continue
        if unplural(a[i1:i2]) == unplural(b[j1:j2]):
            report['forgiven']['plural'] += sum(markable(words[i]['text'], sentence_start(words[i - 1] if i else None)) for i in range(i1, i2)); continue
        # the numbers agree ("24" and "twenty four"): a number in this span is not in doubt, a name beside it still is
        numbers_same = digits(a[i1:i2]) != '' and digits(a[i1:i2]) == digits(b[j1:j2])
        no_rival = digits(b[j1:j2]) == '' and not any(len(k) == 1 for k in b[j1:j2])
        short_rival = len(b[j1:j2]) <= 2
        heard = ''.join(w['text'] for w in other[j1:j2]).strip()
        for i in range(i1, i2):
            if not markable(words[i]['text'], sentence_start(words[i - 1] if i else None)): continue
            if numbers_same and is_number(a[i]): continue
            initial = len(a[i]) == 1 and i + 1 < i2 and core_cap(words[i + 1]['text'])   # "C Core": a name's initial, not a lone letter
            if no_rival and (is_number(a[i]) or (len(a[i]) == 1 and not initial)): report['forgiven']['number'] += 1; continue
            if a[i] in lexicon: report['forgiven']['lexicon'] += 1; continue
            if short_rival and not is_number(a[i]) and established.get(a[i], 0) >= ESTABLISHED: report['forgiven']['established'] += 1; continue
            words[i] = {**words[i], 'p': 0.0, 'heard': heard}; report['marked'] += 1
    return words, report

DICTIONARY = None

def capital_clue(words, established=None, lexicon=None):
    # A free local sign of a name the readers were not sure of: Parakeet wrote an ordinary English word with a capital,
    # mid-sentence, standing alone ("in Bank of America and in City, I work as..." on the Priya call; it was Citi,
    # and both readers agreed on "City", so nothing else marked it). Skipped: words agreed 3+ times in the call (Dell,
    # Pentagon), the meeting's list, contractions (I'll, Don't), a word beside another capitalized word or before "of"
    # (Bank of America, Department of Justice). Priya: City x2, both real. Class (2026-10-07): Clark, God. Marks only.
    global DICTIONARY
    if DICTIONARY is None:
        try: DICTIONARY = {w.strip() for w in open('/usr/share/dict/words') if w.strip()[:1].islower()}
        except OSError: DICTIONARY = set()
    established = established or {}; lexicon = lexicon or set(); made = []
    letters = lambda t: re.sub(r'[^A-Za-z]', '', t)
    for i, w in enumerate(words):
        t = letters(w['text'])
        if w['p'] < 0.5 or len(t) < 3 or not t[0].isupper() or t[1:].isupper() or "'" in w['text']: continue
        if sentence_start(words[i - 1] if i else None) or letters(words[i - 1]['text'])[:1].isupper(): continue
        nxt = letters(words[i + 1]['text']) if i + 1 < len(words) else ''
        after = letters(words[i + 2]['text']) if i + 2 < len(words) else ''
        if nxt[:1].isupper() or nxt.lower() == 'of': continue
        if letters(words[i - 1]['text']).lower() == 'of' if i else False: continue      # Department of Justice
        if nxt.lower() == 'and' and after[:1].isupper(): continue                       # Belt and Road
        if i >= 2 and letters(words[i - 1]['text']).lower() == 'and' and letters(words[i - 2]['text'])[:1].isupper(): continue   # ...and Road
        k = key(t)
        if t.lower() not in DICTIONARY or k in lexicon or established.get(k, 0) >= ESTABLISHED: continue
        words[i] = {**w, 'p': 0.0, 'heard': w.get('heard', ''), 'clue': 'capital'}
        made.append({'t': round(w['start'], 2), 'word': w['text'].strip()})
    return words, made

PEOPLE = ('own', 'invitee')   # lexicon sources that name a person; with the mail persons (is_person), only these are boosted for labels

def sound(k):
    # A word's first sound, crudely: soft g and j alike ("Gio"/"Jill"), c/k/q alike, s and soft c alike, ph/f alike.
    k = k.lower()
    if not k: return ''
    if k[0] in 'gj': return 'j' if k[0] == 'j' or k[1:2] in ('i', 'e', 'y') else 'g'
    if k[0] in 'ckq': return 's' if k[0] == 'c' and k[1:2] in ('i', 'e', 'y') else 'k'
    if k.startswith('ph'): return 'f'
    return k[0]

def suggest(words, boosted, names, markable, lexicon=None):
    # A label, never a word: where Parakeet wrote exactly one name-like word that is not on the list, and a run of
    # Nemotron boosted with the list's people heard a listed name there that starts with the same sound, Parakeet's
    # word is marked "(unclear; likely <name>)". Priya call: "Jill" -> likely Gio (right); boost 6's "Bank" ->
    # Breazzano is stopped by the boost level and by the length check. Returns the words and the suggestions made.
    lexicon = lexicon or set(); names = {key(n): n for n in names}
    a = [key(w['text']) for w in words]; b = [key(w['text']) for w in boosted]
    made = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if tag != 'replace': continue
        hits = [b[j] for j in range(j1, j2) if b[j] in names]
        cand = [i for i in range(i1, i2) if markable(words[i]['text'], sentence_start(words[i - 1] if i else None)) and a[i] not in lexicon]
        if len(cand) != 1 or not hits: continue
        i = cand[0]
        # Never on an abbreviation: Parakeet's all-caps word is not a misheard person's name (class 2026-10-07: "JV",
        # "JP" -> "likely Gio" were wrong). Same first sound and a similar length (ratio <= 1.5): "Jill"/"Gio" 4/3 yes,
        # "Korea"/"Caballero" 5/9 and "Bank"/"Breazzano" 4/9 no.
        if re.sub(r'[^A-Za-z]', '', words[i]['text']).isupper(): continue
        match = [h for h in hits if sound(h) == sound(a[i]) and max(len(h), len(a[i])) <= 1.5 * max(1, min(len(h), len(a[i])))]
        if len(match) != 1: continue
        words[i] = {**words[i], 'p': 0.0, 'likely': names[match[0]], 'heard': words[i].get('heard') or ''.join(w['text'] for w in boosted[j1:j2]).strip()}
        made.append({'t': round(words[i]['start'], 2), 'word': words[i]['text'].strip(), 'likely': names[match[0]]})
    return words, made

def mail_person(text):
    # A name in the mail with the invitees (lexicon source "mail") that is a person: two or three capitalized words, the
    # first on the first-name list privacy.py uses ("David Calloway"; never "Technology Strategy" or "M&T Bank").
    from privacy import FIRST_NAMES
    parts = str(text).split()
    return 2 <= len(parts) <= 3 and all(re.fullmatch(r"[A-Z][a-z'\-]+", p) for p in parts) and parts[0] in FIRST_NAMES

def entries_of(folder):
    files = sorted(Path(folder).glob('lexicon*.json'), key=lambda p: p.stat().st_mtime)
    return json.loads(files[-1].read_text()).get('entries', []) if files else []

def is_person(e): return e.get('source') in PEOPLE or (e.get('source') == 'mail' and mail_person(e.get('text', '')))

def people(folder):
    # The person names on the meeting's written list (own name, invitees, the people in the mail with the invitees), full
    # names split into their words too.
    out = []
    for e in entries_of(folder):
        if is_person(e):
            for part in [e['text']] + str(e['text']).split():
                if part not in out: out.append(part)
    return out

def boost_names(folder):
    # The names the boosted label pass reads with, or none: it runs only for someone else on the call (an invitee or a mail
    # person). On 2026-10-27 the only boosted name was the user's own, and the pass re-read "Gio" for 336 s of a 20-minute stop.
    return people(folder) if any(is_person(e) and e.get('source') != 'own' for e in entries_of(folder)) else []

def lexicon_keys(folder):
    # The meeting's written name list (lexicon.py writes lexicon.json in the call folder; the newest one wins), as the
    # word keys agree() compares: "Priya Shah" gives "priya" and "lee". Missing file: an empty list, nothing forgiven.
    files = sorted(Path(folder).glob('lexicon*.json'), key=lambda p: p.stat().st_mtime)
    if not files: return set()
    entries = json.loads(files[-1].read_text()).get('entries', [])
    return {key(part) for e in entries for part in str(e.get('text', '')).split() if key(part)}

# A name written with "&" (M&T, AT&T, P&G) cannot be heard as written: speech gives "MNT", "M and T", "M N T". The
# 2026-10-09 Liz call had "MNT (unclear)" six times while "M&T" was in the call's title and its lexicon; suggest() never
# touches an all-caps word ("JV" -> "likely Gio" was wrong), so nothing fixed it and the notes said "MNT Bank". Here a
# term from the meeting's written list that holds "&" puts its own spelling back wherever one of its spoken forms
# stands, with any "(unclear)" after it, because the written list is what the user's own title and mail say.
def amp_terms(folder):
    files = sorted(Path(folder).glob('lexicon*.json'), key=lambda p: p.stat().st_mtime)
    if not files: return []
    out = []
    for e in json.loads(files[-1].read_text()).get('entries', []):
        text = str(e.get('text', '')).strip()
        if re.fullmatch(r"[A-Za-z]+(?:\s*&\s*[A-Za-z]+)+", text) and text not in out: out.append(text)
    return out

def amp_pattern(term):
    # "M&T" -> M, then "&" or "and" or (between single letters) "N", then T; never inside a longer word.
    parts = [p.strip() for p in term.split('&')]
    joins = []
    for a, b in zip(parts, parts[1:]):
        letters = len(a) == 1 and len(b) == 1
        joins.append(r'\s*(?:&|and|' + (r'[Nn]|' if letters else '') + r'n)\s*' if letters else r'\s*(?:&|and)\s*')
    body = re.escape(parts[0]) + ''.join(j + re.escape(p) for j, p in zip(joins, parts[1:]))
    return re.compile(r'(?<![\w&])' + body + r'(?![\w&])(?:\s*\(unclear\))?')

def respell_heard(text, heard):
    # The same correction on a line's text: each written form becomes the user's word.
    n = 0
    for word, forms in (heard or {}).items():
        for form in forms:
            text, k = heard_pattern(form).subn(word, text); n += k
    return text, n

def respell(text, terms):
    # The text with each "&" term's spoken forms written as the term. Returns the text and how many were changed; the
    # term already written right, with no "(unclear)" after it, is not a change.
    n = 0
    for term in terms:
        def put(m):
            nonlocal n
            if m.group(0) != term: n += 1
            return term
        text = amp_pattern(term).sub(put, text)
    return text, n

TAIL = re.compile(r'[.,!?;:"\')\]]+$')

def heard_pattern(form):
    # A form the user wrote ("E Ming"): its words in order, any case, never inside a longer word, an "'s" allowed after.
    return re.compile(r'(?<![\w&])' + r'\s+'.join(re.escape(w) for w in form.split()) + r"(?![\w&])", re.I)

def respell_words(words, terms, threshold=0.5, heard=None):
    # The same, on a line's words (transcript.marked rebuilds every transcript from them): a spoken form over one to
    # three words becomes one word with the term's spelling, its leading space and trailing punctuation kept, and
    # sure (p 1.0), since the written list says how it is spelled. Returns the words and how many were changed.
    n = 0
    rules = [(term, re.compile(amp_pattern(term).pattern.replace(r'(?:\s*\(unclear\))?', ''))) for term in terms]
    rules += [(word, heard_pattern(form)) for word, forms in (heard or {}).items() for form in forms]
    for term, rx in rules:
        i = 0
        while i < len(words):
            for j in range(min(i + 3, len(words)), i, -1):
                joined = ''.join(w['text'] for w in words[i:j])
                lead = joined[:len(joined) - len(joined.lstrip())]
                body = joined.strip(); tail = re.search(r"(?:['’]s)?[.,!?;:\"')\]]*$", body); tail = tail.group(0) if tail else ''
                body = body[:len(body) - len(tail)] if tail else body
                if not rx.fullmatch(body): continue
                if body != term or any(w.get('p', 1.0) < threshold for w in words[i:j]): n += 1
                words[i:j] = [{**words[i], 'text': lead + term + tail, 'p': 1.0, 'end': words[j - 1].get('end', words[i].get('end'))}]
                break
            i += 1
    return words, n

FILL_S = 2.0        # a stretch Parakeet left empty for this long, where Nemotron heard FILL_WORDS or more words, is
FILL_WORDS = 3      # filled with Nemotron's words (both NVIDIA; the hole is the worse error). Recorded, never silent.
LATE = 0.4          # Nemotron's streaming clock runs a little behind Parakeet's (first word 0.96 s vs 0.32 s on the class)

def fill(words, other, min_s=FILL_S, min_words=FILL_WORDS, late=LATE):
    # Parakeet's words plus Nemotron's for every stretch between two Parakeet words that is `min_s` or longer and
    # holds `min_words` Nemotron words. Returns the merged words and the list of fills for version.json.
    edges = [0.0] + [t for w in words for t in (w['start'], w['end'])] + [float('inf')]
    added, fills = [], []
    for a, b in zip(edges[::2], edges[1::2]):
        if b - a < min_s: continue
        inside = [w for w in other if a + late <= w['start'] and w['end'] <= b + late]
        if len(inside) < min_words: continue
        added += [{**w, 'filled': True} for w in inside]
        fills.append({'from': round(a, 2), 'to': round(min(b, inside[-1]['end']), 2), 'words': len(inside), 'text': ''.join(w['text'] for w in inside).strip()})
    return sorted(words + added, key=lambda w: w['start']), fills

# ---------- words into lines ----------

def lines_of(words, gap=1.0, max_words=40):
    # A line ends at sentence punctuation (after three words), at a pause longer than `gap`, or at max_words. Each line
    # keeps its words, with their times, for the echo merge and the marks. Lines are shorter than Whisper's 30 s windows.
    lines, cur = [], []
    def flush():
        if cur:
            lines.append({'t': round(cur[0]['start'], 2), 'end': round(max(w['end'] for w in cur), 2), 'text': ''.join(w['text'] for w in cur).strip(), 'words': list(cur)})
            cur.clear()
    for w in words:
        if cur and (w['start'] - cur[-1]['end'] > gap or len(cur) >= max_words): flush()
        cur.append(w)
        if len(cur) >= 3 and re.search(r'[.?!]["\')]*$', w['text']): flush()
    flush()
    return lines

# ---------- the gap check ----------

def loudness(wav, hop=0.03):
    # Which 30 ms frames are louder than the room: floor = max(0.004, 3x the 20th percentile RMS), the rule used to
    # trim line spans since 2026-10-04.
    with wave.open(str(wav)) as w:
        sr = w.getframerate(); x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    if len(x) < int(hop * sr): return np.zeros(0, bool), 0.0, 0.0
    rms = rms_frames(x, sr, hop)
    floor = float(max(0.004, np.percentile(rms, 20) * 3))
    return rms > floor, floor, len(x) / sr

def gaps(loud, words, total, threshold=GAP_S, hop=0.03):
    # Every stretch between two words (and before the first, after the last) that holds `threshold` or more loud
    # seconds: sound was there and no word came out. Silence between words is not a gap, however long.
    edges = [0.0] + [t for w in words for t in (w['start'], w['end'])] + [total]   # (0, first start), (end, next start), ..., (last end, total)
    found = []
    for a, b in zip(edges[::2], edges[1::2]):
        fa, fb = int(a / hop), int(b / hop)
        secs = float(loud[fa:fb].sum()) * hop
        if secs >= threshold: found.append({'from': round(a, 2), 'to': round(b, 2), 'loud_s': round(secs, 1)})
    return found

def gap_check(wav, words, threshold=GAP_S):
    loud, floor, total = loudness(wav)
    found = gaps(loud, sorted(words, key=lambda w: w['start']), total, threshold)
    return {'threshold_s': threshold, 'floor_rms': round(floor, 4), 'loud_s': round(float(loud.sum()) * 0.03, 1), 'gaps': found}

def gap_banner(side, result):
    # Printed at stop, loud, once per gap: this is the falsifier in proposal-b.md (speech dropped silently).
    rows = [f"!!! GAP CHECK FAILED on {side}: [{stamp(g['from'])}] to [{stamp(g['to'])}] has {g['loud_s']} s of sound and no words" for g in result['gaps']]
    return '\n'.join(['!' * 100] + rows + ['!' * 100]) if rows else f"gap check {side}: clean ({result['loud_s']} s of sound, no stretch over {result['threshold_s']} s without words)"

# ---------- echo merge ----------

def echo_index(them):
    # Every Them word's start, by spelling, sorted: the echo test looks a Me word up here.
    index = {}
    for l in them:
        for w in l.get('words') or [{'text': x, 'start': l['t']} for x in l['text'].split()]:
            k = key(w['text'])
            if k: index.setdefault(k, []).append(w.get('start', l['t']))
    for v in index.values(): v.sort()
    return index

def is_echo(line, index, window=ECHO_S, share=ECHO_SHARE, wide=6.0):
    # The mic hears the other side too. A Me word is an echo when Them said the same word within `window` seconds of
    # it; a line is an echo when `share` of its words are. Words without their own times (Whisper lines, the A/B path)
    # use the line's span widened by `wide` seconds, the old rule.
    words = line.get('words') or [{'text': x} for x in line['text'].split()]
    keys = [(key(w['text']), w.get('start'), w.get('end')) for w in words]
    keys = [k for k in keys if k[0]]
    if not keys: return False
    hits = 0
    for k, a, b in keys:
        starts = index.get(k)
        if not starts: continue
        lo, hi = (a - window, b + window) if a is not None else (line['t'] - wide, line.get('end', line['t']) + wide)
        i = bisect.bisect_left(starts, lo)
        if i < len(starts) and starts[i] <= hi: hits += 1
    return hits >= share * len(keys)

# ---------- ear check against the previous version ----------

def read_timed(path):
    out = []
    for line in Path(path).read_text().splitlines():
        m = re.match(r'\[(\d+):(\d+)\] ([^:]+): (.*)', line)
        if m: t = int(m.group(1)) * 60 + int(m.group(2)); out.append({'t': t, 'end': t + 8, 'who': m.group(3), 'text': m.group(4)})
    return out

def disagreements(lines, previous, markable):
    # Where this transcript and the previous version's differ on a name or number: aligned word by word per side
    # (Me against Me, everything else against everything else), the same forgiveness as agree().
    found = []
    for side in ('Me', 'other'):
        pick = (lambda l: l['who'] == 'Me') if side == 'Me' else (lambda l: l['who'] != 'Me')
        new = [(w, l) for l in lines if pick(l) for w in l['words']]
        old = [(x, l) for l in previous if pick(l) for x in l['text'].split()]
        if not new or not old: continue
        a = [key(w['text']) for w, _ in new]; b = [key(x) for x, _ in old]
        sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag != 'replace' or same_span(a[i1:i2], b[j1:j2]): continue
            if not any(markable(new[i][0]['text'], sentence_start(new[i - 1][0] if i else None)) for i in range(i1, i2)): continue
            line = new[i1][1]
            found.append({'t': new[i1][0]['start'], 'end': new[i2 - 1][0]['end'], 'side': 'me' if side == 'Me' else 'them', 'who': line['who'] if side == 'Me' else line.get('speaker', 'Them'),
                          'new': ' '.join(w['text'].strip() for w, _ in new[i1:i2]), 'old': ' '.join(x for x, _ in old[j1:j2]),
                          'heard': ' / '.join(sorted({w.get('heard', '') for w, _ in new[i1:i2] if w.get('heard')})), 'line': line['text']})
    return sorted(found, key=lambda d: d['t'])

def ear_check(lines, previous_timed, folder, out, markable, previous_name='previous', limit=6, pad=3.0):
    # For the user's ear: up to `limit` moments where this transcript and the previous version disagree on a name or
    # number, spread over the call, each with a clip cut from the original wav into <out>/clips. Then every (unclear)
    # mark with what the second reader heard. Returns the number of rows.
    out = Path(out); clips = out / 'clips'; clips.mkdir(parents=True, exist_ok=True)
    previous = read_timed(previous_timed) if previous_timed and Path(previous_timed).exists() else []
    found = disagreements(lines, previous, markable) if previous else []
    step = max(1, len(found) // limit) if found else 1
    picks = found[::step][:limit]
    rows = ['# Ear check', '', f'Up to {limit} moments where this transcript (Parakeet) and {previous_name} (Whisper) disagree on a name or number, '
            f'{len(found)} found. Listen and judge; no transcript here is ground truth.', '']
    for n, d in enumerate(picks, 1):
        a = max(0.0, d['t'] - pad); clip = clips / f"ear-{n}-{d['side']}-{int(d['t'] // 60):02d}m{int(d['t'] % 60):02d}s.wav"
        subprocess.run([tools.FFMPEG, '-v', 'error', '-y', '-ss', f'{a:.2f}', '-t', f'{d["end"] + pad - a:.2f}', '-i', str(Path(folder) / f"{d['side']}.wav"), str(clip)], check=True)
        rows += [f"## {n}. [{stamp(d['t'])}] {d['who']}", '', f"- Parakeet: {d['new']}", f"- {previous_name}: {d['old']}"] + ([f"- Nemotron heard: {d['heard']}"] if d['heard'] else []) \
              + [f"- line: {d['line']}", f'- ffplay -autoexit "{clip}"', '']
    marks = [(l, w) for l in lines for w in l['words'] if w['p'] < 0.5]
    rows += [f'## All {len(marks)} (unclear) marks: Parakeet | what Nemotron heard', '']
    rows += [f"- [{stamp(l['t'])}] {l['who'] if l['who'] == 'Me' else l.get('speaker', 'Them')}: {w['text'].strip()} | {w.get('heard', '')}" for l, w in marks]
    out.joinpath('ear-check.md').write_text('\n'.join(rows) + '\n')
    return len(picks)

if __name__ == '__main__':
    # Prove the gap check on real data: python3 nvidia_engine.py gapcheck <wav> <words.json or nsc.json> [--hole FROM TO]
    # (--hole cuts the words between FROM and TO seconds out first, as parakeet-mlx did on 2026-10-06)
    if sys.argv[1:2] == ['gapcheck']:
        data = json.loads(Path(sys.argv[3]).read_text())
        raw = data.get('words', data) if isinstance(data, dict) else data
        words = [{'text': ' ' + w.get('word', w.get('text', '')), 'start': float(w['start']), 'end': float(w['end'])} for w in raw]
        if '--hole' in sys.argv:
            i = sys.argv.index('--hole'); a, b = float(sys.argv[i + 1]), float(sys.argv[i + 2])
            before = len(words); words = [w for w in words if not (a <= w['start'] <= b)]
            print(f'cut {before - len(words)} words between {stamp(a)} and {stamp(b)}')
        res = gap_check(sys.argv[2], words)
        print(gap_banner(Path(sys.argv[2]).stem, res)); print(json.dumps(res))
        sys.exit(1 if res['gaps'] else 0)
    sys.exit('usage: nvidia_engine.py gapcheck <wav> <words.json> [--hole FROM TO]')
