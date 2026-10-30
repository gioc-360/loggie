# Every line gets its own check, at the end of the call (loggie-bubble-check, 2026-10-27). The readers mark only
# names and numbers they heard differently, so a misheard word of the user's own that both readers agreed on, or wrote
# in lowercase, never reached the name check: "loggy" for Loggie 152 times over the calls to 10-26, "Nebias" for Nebius.
# Gio: "every bubble gets a check". A check reads one line and touches only that line's words. It is code, not a model:
# a class may not send a word with its neighbours off the Mac, and the Mac runs no text model.
#   A word is marked (unclear) when it sounds like one of the user's own words (workspace names, my-words.txt, the
#   call's lexicon from mail and the invite) and is not that word: same first sound, length within 1.5x, letters 70%
#   alike, and not an English word ("start" is not Strat, "logged" not Loggie, "login" not Loggie, all from the calls).
#   Never a person's name, never a word the user kept with ✕.
# A mark is never a fix: the name check (name-check.js soundex step) offers the spelling and one tap teaches my-words, so
# the next call is respelled before this check runs. The 10-10 repair pass that wrote "Nebula" was silent; this is not.
#   lines, made = check(lines, terms(folder, event, kept))
import difflib, re
from pathlib import Path
import nvidia_engine as ne
import spelling

WORDS = Path('/usr/share/dict/words')
ALIKE = 0.7          # letters alike (difflib ratio): "loggy"/Loggie 0.73, "nebias"/Nebius 0.83
MIN_LETTERS = 4
ENDINGS = ('s', 'es', 'ed', 'd', 'ing', 'ions', 'ion', 'ers', 'er', 'est', 'ly')
DICT = None

def dictionary():
    # The Mac's word list, lowercase. Missing, nothing is checked (every word would look unusual): the caller says so.
    global DICT
    if DICT is None: DICT = {w.strip().lower() for w in WORDS.read_text(errors='replace').splitlines() if w.strip()} if WORDS.exists() else set()
    return DICT

def letters(text):
    # "Loggy's," -> "loggy": the possessive and contractions dropped, then everything but letters and digits.
    return re.sub(r'[^a-z0-9]', '', re.sub(r"['’](s|ve|ll|re|d|m|t)\b", '', str(text).lower()))

def english(k):
    # In the word list, or a word of it with an ending ("planning", "negotiations", "updates").
    words = dictionary()
    if k in words: return True
    for end in ENDINGS:
        r = k[:-len(end)]
        if k.endswith(end) and (r in words or r + 'e' in words or (len(r) > 2 and r[-1] == r[-2] and r[:-1] in words)): return True
    return False

def terms(folder, event, kept=()):
    # {letters: written form}: each word of the user's own words that is not English and not a person's name.
    people = spelling.people_words(event) | {spelling.norm(w) for w in str(event.get('me') or '').split()}
    out = {}
    for text, source in spelling.own_words(folder, event):
        if source == 'your name': continue
        for part in re.split(r'[\s/-]+', text):
            part = part.strip(' ,.:;()"\'')
            k = letters(part)
            if len(k) >= MIN_LETTERS and k not in people and not english(k) and part not in kept: out.setdefault(k, part)
    return out

def near(k, term):
    if k == term or english(k) or ne.sound(k) != ne.sound(term): return False
    if max(len(k), len(term)) > 1.5 * min(len(k), len(term)): return False
    return difflib.SequenceMatcher(a=k, b=term).ratio() >= ALIKE

def check(lines, words_of, kept=()):
    # lines: call.merge's lines, each with its words. Marks a word p 0.0 with clue 'near' and the word it may be; returns
    # the lines and [{t, word, near}]. A word already weak, or the user's word itself (any ending), is left as it is.
    made = []
    if not words_of or not dictionary(): return lines, made
    for line in lines:
        for i, w in enumerate(line.get('words') or []):
            k = letters(w['text'])
            if len(k) < MIN_LETTERS or w.get('p', 1.0) < 0.5 or w['text'].strip(' ,.?!;:') in kept: continue
            if any(t in k for t in words_of): continue          # "Hilton's", "Hilton.com": the word itself
            hit = [t for t in words_of if near(k, t)]
            if len(hit) != 1: continue
            line['words'][i] = {**w, 'p': 0.0, 'heard': w.get('heard', ''), 'clue': 'near', 'near': words_of[hit[0]]}
            made.append({'t': round(w['start'], 2), 'word': w['text'].strip(), 'near': words_of[hit[0]]})
    return lines, made
