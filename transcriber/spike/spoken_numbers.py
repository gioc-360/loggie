# Numbers as people say them (named spoken_numbers, not numbers, which would hide Python's own module), as digits, and the figures a text carries.
#   spoken_to_digits(text)  "two point seven eight billion dollars" -> "$2.78 billion"; "seventy-eight percent" -> "78%"
#   figures(text)           the set of figures in a text: money, percentages, magnitudes (million, billion), decimals and
#                           numbers of 100 or more, each normalized to (value, unit) so "$2.78B" and "2.78 billion dollars"
#                           are the same figure
#   recall(said, notes)     how many of the figures said in a call a set of notes kept, and which notes figures were never said
# Why (2026-10-09, Hilton meeting): the rival app's notes kept 14 dollar figures and Loggie's Nemotron notes kept none, though
# the figures reached the model spelled out in words. Amritha picked the rival app's notes for "the most details". Code scores that.
import re

ONES = {w: i for i, w in enumerate('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split())}
TENS = {w: 10 * i for i, w in enumerate('_ _ twenty thirty forty fifty sixty seventy eighty ninety'.split()) if w != '_'}
SCALES = {'hundred': 100, 'thousand': 1_000, 'million': 1_000_000, 'billion': 1_000_000_000, 'trillion': 1_000_000_000_000}
NUMBER_WORD = set(ONES) | set(TENS) | set(SCALES) | {'point', 'and', 'a'}
MAGNITUDE = {'thousand': 1e3, 'k': 1e3, 'million': 1e6, 'm': 1e6, 'mm': 1e6, 'billion': 1e9, 'b': 1e9, 'bn': 1e9, 'trillion': 1e12, 't': 1e12}

def _words_to_number(words):
    # A run of number words ("three hundred seventy six", "two point seven eight") to (value, scale word or None).
    # The last scale word (million, billion) is kept apart, so "two point seven eight billion" is (2.78, "billion").
    words = [w for w in words if w != 'and']
    tail = None
    if words and words[-1] in ('thousand', 'million', 'billion', 'trillion'):
        tail = words.pop()
    if 'point' in words:
        i = words.index('point')
        whole, frac = words[:i], words[i + 1:]
        if not frac or any(w not in ONES or ONES[w] > 9 for w in frac): return None
        base = _integer(whole) if whole else 0
        if base is None: return None
        return float(f"{base}.{''.join(str(ONES[w]) for w in frac)}"), tail
    value = _integer(words)
    return (value, tail) if value is not None else None

def _integer(words):
    if not words: return None
    # A year or a pair said as two numbers ("twenty twenty five", "nineteen ninety nine") is the two read side by side.
    if not any(w in SCALES or w == 'hundred' for w in words):
        groups = []
        for w in words:
            if groups and (w in TENS or (w in ONES and ONES[w] >= 10)): groups.append([w])
            elif groups: groups[-1].append(w)
            else: groups.append([w])
        if len(groups) == 2:
            a, b = _integer_plain(groups[0]), _integer_plain(groups[1])
            if a is not None and b is not None and 10 <= a <= 99 and 0 <= b <= 99:
                # Only a year reads this way. "twenty two sixty" on the Hilton call was $22.60, not 2260, and not 82:
                # anything else stays in words for the reader to judge (2026-10-09).
                return int(f'{a}{b:02d}') if 1900 <= int(f'{a}{b:02d}') <= 2099 else None
    return _integer_plain(words)

def _integer_plain(words):
    if not words: return None
    total, current = 0, 0
    for w in words:
        if w == 'a': current = max(current, 1); continue
        if w in ONES: current += ONES[w]
        elif w in TENS: current += TENS[w]
        elif w == 'hundred': current = max(current, 1) * 100
        elif w in SCALES: total += max(current, 1) * SCALES[w]; current = 0
        else: return None
    return total + current

def _fmt(value):
    if isinstance(value, int) and 1900 <= value <= 2100: return str(value)   # a year has no comma
    return f'{value:,.2f}'.rstrip('0').rstrip('.') if isinstance(value, float) and value != int(value) else f'{int(value):,}'

TOKEN = re.compile(r"[A-Za-z]+(?:-[A-Za-z]+)*|\S")

def spoken_to_digits(text):
    # Every run of number words becomes digits, with "percent" folded in as "%" and a following "dollars" as a leading
    # "$"; a scale word stays as a word ("$2.78 billion"). Lone "a", "one" and "and" outside a number are left alone,
    # and so is a single small number word ("two teams"), which reads better as a word and is not a figure.
    out, i = [], 0
    parts = re.split(r'(\s+)', text)
    words = [(k, p) for k, p in enumerate(parts) if p and not p.isspace()]
    k = 0
    result = list(parts)
    while k < len(words):
        idx, raw = words[k]
        core = re.sub(r'[^\w-]', '', raw).lower()
        sub = core.split('-') if core else []
        if not sub or not all(s in NUMBER_WORD for s in sub) or core in ('a', 'and', 'point'):
            k += 1; continue
        run, j, last_idx, trail = [], k, idx, ''
        while j < len(words):
            jdx, jraw = words[j]
            jcore = re.sub(r'[^\w-]', '', jraw).lower()
            jsub = jcore.split('-') if jcore else []
            if not jsub or not all(s in NUMBER_WORD for s in jsub): break
            run += jsub; last_idx = jdx; trail = re.sub(r'^[\w-]+', '', re.sub(r'^\W*', '', jraw))
            j += 1
            if re.search(r'[.,;:!?]$', jraw): break
        while run and run[-1] in ('and', 'a', 'point'): run.pop()
        parsed = _words_to_number(run) if run else None
        nxt = re.sub(r'[^\w]', '', words[j][1]).lower() if j < len(words) else ''
        small = parsed and parsed[1] is None and isinstance(parsed[0], int) and parsed[0] < 10 and nxt not in ('percent', 'dollars')
        if not parsed or small or len([w for w in run if w not in ('and', 'a')]) == 0:
            k = j if j > k else k + 1; continue
        value, scale = parsed
        lead = re.match(r'^\W*', words[k][1]).group(0)
        text_num = _fmt(value) + (f' {scale}' if scale else '')
        consumed_to = last_idx
        if nxt in ('percent', 'percentage') and j < len(words):
            text_num = _fmt(value) + '%' + (f' {scale}' if scale else ''); consumed_to = words[j][0]; trail = re.sub(r'^\w+', '', words[j][1]); j += 1
        elif nxt in ('dollars', 'dollar', 'bucks') and j < len(words):
            text_num = '$' + text_num; consumed_to = words[j][0]; trail = re.sub(r'^\w+', '', words[j][1]); j += 1
        result[idx] = lead + text_num + trail
        for z in range(idx + 1, consumed_to + 1): result[z] = '' if not parts[z].isspace() or z < consumed_to else ''
        # keep the whitespace after the last consumed token
        if consumed_to + 1 < len(parts) and parts[consumed_to + 1].isspace(): pass
        k = j
    joined = ''.join(result)
    return re.sub(r'[ \t]{2,}', ' ', joined)

FIGURE = re.compile(r"(\$)?\s?(\d[\d,]*(?:\.\d+)?)\s?(%|percent\b|(?:thousand|million|billion|trillion|bn|mm|[kmbt])\b)?\s?(dollars\b)?", re.I)

def figures(text):
    # (value, unit) for every figure in a text; spoken numbers are converted first. unit: "$", "%" or "" (a magnitude
    # multiplies the value, so $2.78B and 2.78 billion dollars are both (2.78e9, "$")). Years 1900-2100 without a unit and
    # numbers under 100 without a unit or a decimal are not figures.
    found = set()
    for m in FIGURE.finditer(spoken_to_digits(text)):
        dollar, num, suffix, dollars = m.groups()
        try: value = float(num.replace(',', ''))
        except ValueError: continue
        unit = '$' if (dollar or dollars) else ''
        s = (suffix or '').lower()
        if s in ('%', 'percent'): unit = '%'
        elif s: value *= MAGNITUDE.get(s, 1)
        decimal = '.' in num
        if not unit and not s and not decimal and (value < 100 or 1900 <= value <= 2100): continue
        found.add((round(value, 6), unit))
    return found

def same(a, b):
    # Two figures match when units agree, or one side has no unit (a bare "2.78 billion" said, "$2.78B" written), and the
    # values are within 1% (2.78B and "about 2.8 billion" do not; 376M and 376,000,000 do).
    (va, ua), (vb, ub) = a, b
    if ua and ub and ua != ub: return False
    return abs(va - vb) <= 0.01 * max(abs(va), abs(vb), 1e-9)

def recall(said_text, notes_text):
    said, notes = figures(said_text), figures(notes_text)
    kept = {f for f in said if any(same(f, n) for n in notes)}
    unsaid = {n for n in notes if not any(same(n, f) for f in said)}
    return {'said': len(said), 'kept': len(kept), 'recall': round(len(kept) / len(said), 3) if said else None,
            'notes_figures': len(notes), 'not_said': sorted(unsaid)}
