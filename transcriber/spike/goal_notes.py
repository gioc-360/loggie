# The passes that turn Ultra's goal notes into the shape of the rival app's notes Gio likes, in code, after the one notes
# call. Each pass is a fix found in blind gradings against the rival app on the Liz and Hilton calls (2026-10-09); together
# they took the score from 2 of 4 (r9) to 4 of 4 (r10d). Order matters: shape, then what came from the goal alone, then
# the steps' timing, then names in headings, then repeats, then the length budget, which ranks what is left.
# A pass that asks the model takes ask(prompt) -> (reply, meta) and hands back that meta, so the cost line counts it.
import json, re
import summary, transcript

NEXT = re.compile(r'^next\s+steps?$', re.I)
LATER, MORE = 'for later', 'more'
SPEAKER = re.compile(r'^(Speaker \d+|[A-Z][a-z]+(?: [A-Z][a-z]+)?)(?: \([^)]*\))?:\s+')
WORDS_PER_TOPIC, FLOOR, CAP, CAP_CLASS = 80, 200, 550, 750

def json_of(raw):
    # The first JSON object (or bare list, wrapped as {"items": [...]}) in a reply, or {}. Ultra single-quotes a value or
    # leaves a trailing comma now and then (2026-10-09); those two are repaired, nothing else.
    text = re.sub(r'^```(json)?\s*|```\s*$', '', str(raw).strip(), flags=re.M)
    for open_, close in (('{', '}'), ('[', ']')):
        a, z = text.find(open_), text.rfind(close)
        if a < 0 or z <= a: continue
        chunk = text[a:z + 1]
        for attempt in (chunk, re.sub(r',(\s*[}\]])', r'\1', re.sub(r'(:\s*)\'([^\'"\n]*)\'', r'\1"\2"', chunk))):
            try: found = json.loads(attempt)
            except json.JSONDecodeError: continue
            return {'items': found} if isinstance(found, list) else found if isinstance(found, dict) else {}
    return {}

def words(text, min_len=4):
    # The content words of a line, stamps and parentheses left out.
    return {w for w in (summary.norm(x) for x in re.sub(r'\[[^\]]*\]|\([^)]*\)', ' ', str(text)).split()) if len(w) >= min_len}

def is_body(sec): return not NEXT.match(sec['heading']) and sec['heading'].strip().lower() not in (LATER, MORE)

def listed(reply, key):
    found = json_of(reply)
    return [x for x in (found.get(key) or found.get('items') or []) if isinstance(x, dict) and str(x.get('n', '')).isdigit()]

def shape(sections, ask):
    # A bullet over 20 words, or one opening with a speaker, is rewritten once as a headline of about 11 words with 0 to
    # 3 details (the rival app's median: 11 words a bullet, about one detail per headline). A detail that mostly repeats its
    # headline is cut ("Exposure to various parts of the bank", Liz r10).
    long_ones = [(si, bi, b) for si, sec in enumerate(sections) if not NEXT.match(sec['heading']) for bi, b in enumerate(sec['bullets'])
                 if len(b['text'].split()) > 20 or (SPEAKER.match(b['text']) and not re.match(r'^[A-Z][^:]{1,30}:\s', SPEAKER.sub('', b['text'], 1)))]
    if not long_ones: return {'reshaped': 0}, None
    reply, meta = ask(f"""Rewrite each note below as one headline of about 11 words (never more than 15) plus at most one detail of at most 15 words. The detail must add a fact the headline does not have; no detail is fine.
Keep every number, name and fact; add nothing. Do not start with a speaker's name. A headline may open with a short label and a colon. Write in sentence case, as a note, never as a title.
Answer with JSON only: {{"notes": [{{"n": 1, "headline": "...", "details": ["..."]}}]}}
""" + '\n'.join(f'{k + 1}. {b["text"]}' for k, (_, _, b) in enumerate(long_ones)))
    fix = {int(x['n']): x for x in listed(reply, 'notes')}
    reshaped = 0
    for k, (si, bi, b) in reversed(list(enumerate(long_ones))):
        f = fix.get(k + 1)
        if not f or not str(f.get('headline') or '').strip(): continue
        head = {summary.norm(w) for w in str(f['headline']).split()}
        def adds(d):
            ws = [summary.norm(w) for w in str(d).split() if len(summary.norm(w)) > 3]
            return bool(ws) and sum(w not in head for w in ws) / len(ws) >= 0.5
        # One detail at most, the one adding the most: the rival app's median is about one per headline, and with three allowed a
        # live Liz run padded 14 points to three each ("Must handle transitions professionally with supervisor").
        fresh = lambda d: sum(summary.norm(w) not in head for w in str(d).split() if len(summary.norm(w)) > 3)
        best = sorted((d for d in (f.get('details') or []) if str(d).strip() and adds(d)), key=fresh, reverse=True)[:1]
        details = [{**b, 'text': str(d).strip(), 'level': 1} for d in best]
        sections[si]['bullets'][bi:bi + 1] = [{**b, 'text': str(f['headline']).strip()}] + details
        reshaped += 1
    return {'reshaped': reshaped}, meta

def drop_goal_only(sections, goal, lines=()):
    # A line whose words are mostly the goal's, with no moment of the call that says them, came from the goal, not the
    # call: "Deadline: Nov 11 [??:??]", and "Schedule team interviews before Nov 11 deadline [30:44]", stamped on
    # "you have a great Friday" (live Liz run, 2026-10-09). Unstamped alone is not enough: Ultra once left 14 Hilton
    # details unstamped, figures from the call.
    goal_words = words(goal, 3)
    def from_goal(b):
        ws = [w for w in (summary.norm(x) for x in re.sub(r'\[[^\]]*\]|\([^)]*\)', ' ', b['text']).split()) if len(w) >= 3]
        share = sum(w in goal_words for w in ws) / len(ws) if ws else 0
        t = summary.seconds(b.get('at')) if b.get('at') and b['at'] != '??:??' else None
        if t is None: return share >= 0.4
        if share < 0.6: return False   # stamped: only a near copy of the goal (5 of 6 words in the Liz case), not a step that shares a few
        said = set().union(*(words(l['text'], 3) for l in lines if abs(l['t'] - t) <= 60)) if lines else set(ws)
        return len(set(ws) & said) / len(set(ws)) < 0.3
    dropped = []
    for sec in sections:
        keep = []
        for b in sec['bullets']: (dropped if from_goal(b) else keep).append(b)
        sec['bullets'] = keep
    sections[:] = [s for s in sections if s['bullets'] or NEXT.match(s['heading'])]
    return {'goal_only': [b['text'] for b in dropped]}

def around(b, lines, me_label='Me'):
    # What was said from 60 s before a line's stamp to 90 s after (Ultra's stamps on steps are loose: the Dell step was
    # stamped on "Oh, okay, great."), and the other speakers' two turns elsewhere that share the most words with the
    # line: Liz's "the team interviews will want to hear it" was minutes from the Dell step's stamp (r10, 3 runs aimed
    # the story at the HR interview).
    t = summary.seconds(b.get('at'))
    # Forward-leaning, and each turn trimmed rather than the whole: the advice follows the moment it answers, and a
    # window cut at 1,200 characters ended at 13:39 and never showed Liz's "past the HR interview and on to the team
    # interviews, they'd be excited to hear" (14:42); Ultra tied the Dell story to the HR interview 3 of 3 times.
    near = [l for l in lines if t is not None and -60 <= l['t'] - t <= 90]
    ws = words(b['text'])
    scored = sorted(((len(ws & words(l['text'])), l) for l in lines if l['who'] != me_label and not any(l is n for n in near)), key=lambda x: -x[0])
    others = sorted((l for score, l in scored[:2] if score >= 2), key=lambda l: l['t'])
    said = ' '.join(f"[{transcript.stamp(l['t'])}] {l['who']}: {l['text'][:300]}" for l in near)
    also = ' '.join(f"[{transcript.stamp(l['t'])}] {l['who']}: {l['text'][:400]}" for l in others)
    return (said or '(no moment)') + (f'\n   Also said: {also}' if also else '')

def steps(sections, lines, goal, ask, me_label='Me'):
    # One call over Next Steps and "For later": is the line what was said (who, which event, figures, owner), and was the
    # speaker describing the role (once the goal is reached) or getting there? Asked "before or after the goal", Ultra kept
    # "map PI planning cycles" as a step; asked what Liz was describing, it said "the role" 3 of 3 times (2026-10-09).
    # Steps about the role move to "For later"; "For later" lines about getting there go back into the notes. The model
    # may correct a line but never drop one (it dropped "ask the HR rep", which Liz said), and a correction must keep
    # some of the line's words (it once replaced three points with "Scheduled chat and introduced self as Gio").
    items = [(si, bi) for si, sec in enumerate(sections) if NEXT.match(sec['heading']) or sec['heading'].strip().lower() == LATER
             for bi, b in enumerate(sec['bullets']) if b.get('level', 0) == 0]
    if not items: return {'asked': False}, None
    def show(k, si, bi):
        sec, b = sections[si], sections[si]['bullets'][bi]
        own = f" (Owner: {b['owner']})" if b.get('owner') else ''
        return f"{k + 1}. [{sec['heading']}] {b['text']}{own}\n   What was said around it: {around(b, lines, me_label)}"
    reply, meta = ask(f"""Goal: "{goal}".
Below are next steps and later advice from a call's notes, each with what was said around it. For each line answer:
- "verdict": "ok" when the line says what was said. "fix" when it changes who, which event, a figure or a name, or adds something not said: then give "text", the line corrected using only what was said, no longer than the line, in sentence case, not starting with a speaker's name.
- "describing": what the speaker was describing there: "role" (how to work once in the job, the role or the program: with a supervisor, colleagues, projects, other departments, the first months), "getting" (how to reach the goal: applying, interviews, preparing, what to say in them), or "other".
- For a line with an Owner: "owner", the person said to do it, or "" when no one was named.
Answer with JSON only: {{"lines": [{{"n": 1, "verdict": "ok", "describing": "getting"}}]}}
""" + '\n'.join(show(k, si, bi) for k, (si, bi) in enumerate(items)))
    verdicts = {int(x['n']): x for x in listed(reply, 'lines')}
    shared = lambda a, c: len(words(a, 1) & words(c, 1)) / max(1, len(words(a, 1)))
    out = {'asked': True, 'answered': len(verdicts), 'fixed': [], 'owners': []}
    to_later, back = set(), set()
    for k, (si, bi) in enumerate(items):
        v, sec = verdicts.get(k + 1) or {}, sections[si]
        b = sec['bullets'][bi]
        if sec['heading'].strip().lower() == LATER:
            if v.get('describing') == 'getting': back.add(id(b))
            continue
        new = str(v.get('text') or '').strip()
        if v.get('verdict') == 'fix' and new and len(new.split()) <= len(b['text'].split()) + 3 and shared(b['text'], new) >= 0.3 and summary.norm(new) != summary.norm(b['text']):
            out['fixed'].append([b['text'], new]); b['text'] = new
        if b.get('owner') and 'owner' in v and str(v.get('owner') or '').strip() != b['owner']:
            out['owners'].append([b['owner'], str(v.get('owner') or '').strip() or None]); b['owner'] = str(v.get('owner') or '').strip() or None
        if v.get('describing') == 'role': to_later.add(id(b))
    moved, returned = [], []
    for sec in sections:
        keep, carry = [], None
        for b in sec['bullets']:
            if b.get('level', 0) == 0: carry = 'later' if id(b) in to_later else 'back' if id(b) in back else None
            if carry == 'later': moved.append({**b, 'text': re.sub(r',?\s+so that .*$', '', b['text']), 'owner': None})
            elif carry == 'back': returned.append(b)
            else: keep.append(b)
        sec['bullets'] = keep
    if moved:
        later = next((s for s in sections if s['heading'].strip().lower() == LATER), None)
        if later is None:
            later = {'heading': 'For later', 'bullets': []}
            sections.insert(next((i for i, s in enumerate(sections) if NEXT.match(s['heading'])), len(sections)), later)
        later['bullets'].extend(moved)
    last = next((s for s in reversed(sections) if is_body(s)), None)
    if returned and last is not None: last['bullets'].extend(returned)   # most are facts ("billing is the biggest problem"), not steps
    out['to_later'] = [b['text'] for b in moved if b.get('level', 0) == 0]
    out['back'] = [b['text'] for b in returned if b.get('level', 0) == 0] if last is not None else []
    sections[:] = [s for s in sections if s['bullets'] or NEXT.match(s['heading'])]
    return out, meta

EVENT_NOUN = r'(?:interviews?|meetings?|deadlines?|pitch(?:es)?|presentations?|demos?|reviews?|exams?|finals?|calls?)'
EVENT_SKIP = {'the', 'a', 'an', 'and', 'or', 'through', 'before', 'after', 'by', 'on', 'at', 'for', 'to', 'of', 'in', 'my', 'his', 'her', 'their'}

def goal_events(goal):
    # The events a goal names, as written: "through the HR interview on Oct 16 and team interviews before the Nov 11
    # deadline" gives "HR interview", "team interviews", "Nov 11 deadline". Up to two words before the event noun.
    out = []
    for m in re.finditer(rf"((?:[\w&'-]+\s+){{0,2}}){EVENT_NOUN}\b", str(goal or ''), re.I):
        lead = [w for w in m.group(1).split() if w.lower() not in EVENT_SKIP]
        while lead and lead[0].lower() in EVENT_SKIP: lead = lead[1:]
        phrase = ' '.join(lead[-2:] + [m.group(0).split()[-1]])
        if phrase.lower() not in {o.lower() for o in out}: out.append(phrase)
    return out

def other_runs(lines, me_label='Me'):
    # The other speakers' consecutive turns, joined: a sentence often runs across two. A short interjection ("and so
    # that's the work I enjoy doing", 14:25) does not end it: Liz's "a very compelling story ... once" (14:24) ends "past
    # the HR interview and on to the team interviews" (14:42) across it.
    runs = []
    for l in lines:
        if l['who'] == me_label:
            if len(l['text'].split()) > 12: runs.append(None)
            continue
        if runs and runs[-1] is not None and runs[-1][-1]['who'] == l['who']: runs[-1].append(l)
        else: runs.append([l])
    return [r for r in runs if r]

def retime(sections, lines, goal, ask, me_label='Me'):
    # A step aimed at one of the goal's events, when the other speaker named a different one in what they said right
    # after it, is asked about that passage alone: which event is it for? On the Liz call the step check read "past the
    # HR interview and on to the team interviews, they'd be excited to hear" and still said the HR interview (3 of 3,
    # whole window); handed only Liz's sentence and the two events, Ultra said "team interviews" 3 of 3 (2026-10-09). Code
    # swaps the event in the step only when the answer is one of the goal's own events.
    events = goal_events(goal)
    if len(events) < 2: return {'retimed': [], 'asked': False}, None
    key = lambda e: summary.norm(re.sub(r's\b', '', e.lower()))
    def named(text):
        return [e for e in events if re.search(rf"\b{re.escape(e.rstrip('s'))}s?\b", text, re.I)]
    asks = []   # (bullet, event named, passage)
    for sec in sections:
        if not NEXT.match(sec['heading']): continue
        for b in sec['bullets']:
            t, mine = summary.seconds(b.get('at')), named(b['text'])
            if t is None or len(mine) != 1: continue
            topic = words(b['text']) - set().union(*(words(e, 2) | {w.rstrip('s') for w in words(e, 2)} for e in events))
            # The window first, then the whole call: a step stamped on Gio's own telling (07:09) is minutes from Liz's
            # "past the HR interview and on to the team interviews" (14:42). In the whole call, the run sharing the most
            # topic words wins.
            for scope in ([l for l in lines if -60 <= l['t'] - t <= 150], lines):
                best = None
                for run in other_runs(scope, me_label):
                    text = ' '.join(l['text'] for l in run)
                    # Same topic, not just the same event words: "ask the HR rep at the HR interview" shared only
                    # "interview" with Liz's Dell-story sentence and was moved to the team interviews with it.
                    score = len(topic & words(text))
                    if score and [e for e in named(text) if key(e) != key(mine[0])] and (best is None or score > best[0]): best = (score, run)
                if best:
                    asks.append((b, mine[0], ' '.join(f"[{transcript.stamp(l['t'])}] {l['who']}: {l['text']}" for l in best[1])[:1500])); break
    if not asks: return {'retimed': [], 'asked': False}, None
    # The step itself is not shown: shown "Ace HR interview with the Dell story", Ultra answered "HR interview" from the
    # step's own words with Liz's sentence right under it; shown only the sentence, "team interviews" 3 of 3.
    listing = '\n'.join(f'{k + 1}. What the speaker said, in one breath: {p}' for k, (b, _, p) in enumerate(asks))
    reply, meta = ask(f"""The listener has these events ahead: {', '.join(f'"{e}"' for e in events)}.
For each passage below, answer which of those events the speaker said the thing they describe is for, or "neither".
Answer with JSON only: {{"passages": [{{"n": 1, "event": "neither"}}]}}
{listing}""")
    found = {int(x['n']): str(x.get('event') or '').strip() for x in listed(reply, 'passages')}
    retimed = []
    for k, (b, mine, _) in enumerate(asks):
        said = next((e for e in events if key(e) == key(found.get(k + 1, ''))), None)
        if said and key(said) != key(mine):
            new = re.sub(rf"\b{re.escape(mine.rstrip('s'))}s?\b", said, b['text'], count=1, flags=re.I)
            # The day said for the old event goes with it: "for HR interview next Friday" became "for team interviews next
            # Friday (Fri Oct 16)", the HR interview's date on the team interviews (Liz, 2026-10-10, both graders).
            new = re.sub(r'\s*(?:\((?:mon|tue|wed|thu|fri|sat|sun)\w* [a-z]{3} \d{1,2}\)|\b(?:next|this|on|by)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(?:on|by)\s+[a-z]{3,9}\.? \d{1,2}\b)', '', new, flags=re.I).strip()
            retimed.append([b['text'], new]); b['text'] = new
    return {'retimed': retimed, 'asked': True}, meta

ROLES = r'(?:mentor|judge|coach|manager|supervisor|recruiter|professor|advisor|sponsor)'   # roles someone is given, not "winner": that is a reading of the call

def role_names(sections, lines):
    # A role word put before a name ("ask mentor Yiming") goes when the call never says that role within six words of
    # the name: Yiming was the 2025 winner, and "mentors" came 30 words after his name (33:06); 2 of 4 Hilton gradings
    # (2026-10-09) caught "mentor Yiming". The name stays; only the role the call did not give him goes.
    text = ' '.join(l['text'] for l in lines)
    toks = re.findall(r"[A-Za-z']+", text)
    def near(role, name):
        spots = [i for i, w in enumerate(toks) if w.rstrip("'s") == name]
        return any(re.fullmatch(rf'{role}s?', toks[j], re.I) for i in spots for j in range(max(0, i - 6), min(len(toks), i + 7)))
    fixed = []
    for sec in sections:
        for b in sec['bullets']:
            new = b['text']
            # Case-blind for the role only: with re.I on the whole pattern "Supervisor support varies" read "support" as a
            # name and lost "Supervisor" (Liz run, 2026-10-10).
            for m in reversed(list(re.finditer(rf'\b((?i:{ROLES}))\s+([A-Z][a-z]+)\b', new))):
                role, name = m.group(1).lower().rstrip('s'), m.group(2)
                if name in toks and not near(role, name): new = new[:m.start()] + name + new[m.end():]
            if new != b['text']: fixed.append([b['text'], new]); b['text'] = new
    return {'roles': fixed}

# A time a schedule is set by: both points under one label must say one, so "P0 items: find-email fix, ..." (what) does not
# replace "P0: before fall break" (when), and "Liz: ..." (a speaker, not a topic) never does.
WHEN = re.compile(r'\b(today|tonight|tomorrow|day|days|week|weeks|month|months|spring|summer|fall|autumn|winter|break|semester|monday|tuesday|wednesday|thursday|friday|saturday|sunday|deadline|before|after|until|by end|end of)\b', re.I)

def latest_labels(sections):
    # Two points with the same label said at different moments ("P0: fix by end of day" [10:46], "P0 target: before fall
    # break" [21:01]) are the meeting changing its mind: the later one stays, the earlier goes. On the Loggie scoping call
    # (2026-10-09) both versions stood side by side and graders marked the contradiction in 4 of 4; Ultra asked which
    # points the meeting later changed, with the whole transcript, answered none in 3 of 3, so code holds this. The key is
    # the label's first word ("P0"); a label is up to four words before a colon, and both points say a time (WHEN).
    groups, seen = [], {}
    for sec in sections:
        if sec['heading'].strip().lower() in (LATER, MORE): continue
        for b in sec['bullets']:
            if b.get('level', 0): continue
            m = re.match(r'^\s*([^:]{1,40}):\s', b['text'])
            t = summary.seconds(b.get('at'))
            if not m or t is None or len(m.group(1).split()) > 4 or not WHEN.search(b['text'][m.end():]): continue
            first = m.group(1).split()[0]
            # Schedule labels only: a number ("P0", "Q3", "Phase 2") or a schedule word; "Liz: retreats every month" and
            # "Liz: shadow days after you start" are a speaker's two points, both with a time.
            if not (re.search(r'\d', m.group(1)) or re.match(r'(?i)(deadline|launch|release|sprint|milestone|phase|mvp|beta|demo|due)', first)): continue
            key = summary.norm(first)
            if key: seen.setdefault(key, []).append((t, b))
    gone = set()
    for key, found in seen.items():
        if len(found) < 2: continue
        last = max(t for t, _ in found)
        gone |= {id(b) for t, b in found if t < last - 60}
    dropped = []
    for sec in sections:
        keep, skip = [], False
        for b in sec['bullets']:
            if b.get('level', 0) == 0: skip = id(b) in gone
            if skip:
                if b.get('level', 0) == 0: dropped.append(b['text'])
                continue
            keep.append(b)
        sec['bullets'] = keep
    sections[:] = [s for s in sections if s['bullets'] or NEXT.match(s['heading'])]
    return {'superseded': dropped}

PLACEHOLDER = re.compile(r'^(?:the )?(?:other(?: person| speaker)?|them|someone|speaker \d+|unknown)$', re.I)

def placeholder_owners(sections):
    # An owner that names nobody ("other person", "Other", "Them") goes, from the owner and from the line: on the one-mic
    # Loggie call (2026-10-09) graders called "Other: find-email fix, ... recent activity recall" and "(other person)"
    # assignments unsupported in 3 of 4. A step with no owner is better than one with a guessed one.
    cleared = []
    for sec in sections:
        for b in sec['bullets']:
            new = re.sub(r'\s*\((?:the )?other(?: person| speaker)?\)', '', b['text'], flags=re.I)
            new = re.sub(r'^(?:the )?other(?: person)?:\s+', '', new, flags=re.I)
            if b.get('owner') and PLACEHOLDER.match(str(b['owner']).strip()): b['owner'] = None; cleared.append(b['text'])
            if new != b['text']: cleared.append(b['text']); b['text'] = new[:1].upper() + new[1:]
    return {'owners_cleared': cleared}

def one_mic_owners(sections, lines, people=(), title=''):
    # On a one-mic call a task is written as what needs to be done, with no owner: Gio, 2026-10-10, "dont even assign x or
    # add place holders, just write what needs to be done objectively". Ultra wrote owners in every form it could
    # ("Assign to Gio as P0: ...", "Gio work stream next move features P0", "<the rival app's name> can implement wave diagram",
    # "(Gio)"); each comes off and the task stays. A name here is someone the user knows (their word list, invitees) or a
    # capitalized word that is not an English word (the rival app's name); "Window can scale" is left alone, and so is a word of the
    # call's own title ("Loggie", the app, is in the word list).
    import lexicon
    people = {p.split()[0].lower() for p in people if p}
    title = {w.lower() for w in re.findall(r'[A-Za-z]+', title)}
    is_who = lambda w: w.lower() not in title and (w.lower() in people or (w[:1].isupper() and not lexicon.dictionary_word(w)))
    cleared = []
    def objective(text):
        s = text
        s = re.sub(r'\s*\((?:[A-Z][a-z]+(?: [A-Z][a-z]+)?|team|the team|other person|them)\)\s*$', lambda m: '' if is_who(m.group(0).strip(' ()').split()[0]) or m.group(0).strip(' ()').lower() in ('team', 'the team', 'other person', 'them') else m.group(0), s)
        m = re.match(r'^assign(?:ed)?\s+to\s+([A-Z][a-z]+)(?:\s+as\s+(P\d))?\s*:?\s*', s, re.I)
        if m and is_who(m.group(1)): s = (f'{m.group(2)}: ' if m.group(2) else '') + s[m.end():]
        s = re.sub(r'[;,]?\s*\bassign(?:ed)?\s+to\s+([A-Z][a-z]+)\b', lambda m: '' if is_who(m.group(1)) else m.group(0), s, flags=re.I)   # "...; assign to Gio"
        s = re.sub(r'\bassign(?:ed)?\s+(.+?)\s+to\s+([A-Z][a-z]+)\b', lambda m: m.group(1) if is_who(m.group(2)) else m.group(0), s, flags=re.I)
        m = re.match(r'^([A-Z][a-z]+)(?::\s+|\s+(?:takes|owns|handles|leads)\s+|\s+(?:can|will|should|to)\s+)', s)
        if m and is_who(m.group(1)): s = s[m.end():]
        # A bare first word is cut only for a known person: "Screenshot board ..." lost "Screenshot" (not in the 1934 list).
        m = re.match(r'^([A-Z][a-z]+)\s+(?=[a-z])', s)
        if m and m.group(1).lower() in people and m.group(1).lower() not in title: s = s[m.end():]
        s = s.strip(' ,;:')
        return s[:1].upper() + s[1:] if s else text
    for sec in sections:
        before = len(cleared)
        for b in sec['bullets']:
            if b.get('owner'): cleared.append(f"{b['text']} ({b['owner']})"); b['owner'] = None
            new = objective(b['text'])
            if new != b['text']: cleared.append(b['text']); b['text'] = new
        if re.search(r"who'?s doing what|owners?|assignments?|who does what", sec['heading'], re.I): sec['heading'] = 'Tasks'
    return {'cleared': cleared}

def asked_of_listener(sections, lines, me=None):
    # "email me if you have any follow-ups", said by Gio, is a step for the listener toward Gio: the notes wrote "Email
    # Yentin if follow-up questions arise (Gio)" in 4 runs of the Yentin chat (2026-10-10), and graders marked it reversed
    # every time. When a step's moment holds "<verb> me" from one speaker and the step names the other person with the
    # speaker as owner, code swaps them. Two-track calls only: on one mic nobody's line is known.
    fixed = []
    verbs = r'(email|e-mail|text|message|call|ping|reach out to|send|dm|follow up with)'
    for sec in sections:
        if not NEXT.match(sec['heading']): continue
        for b in sec['bullets']:
            t = summary.seconds(b.get('at'))
            if b.get('owner') == 'Me' and me: b['owner'] = me   # a transcript label is not a name (the step check wrote "Me")
            if t is None or not b.get('owner'): continue
            said = [l for l in lines if abs(l['t'] - t) <= 20 and re.search(rf'\b{verbs}\s+me\b', l['text'], re.I)]
            if not said: continue
            speaker = me if said[0]['who'] == 'Me' and me else said[0]['who']
            if not speaker or b['owner'].split()[0].lower() != speaker.split()[0].lower(): continue
            m = re.search(rf'\b(?i:{verbs})\s+([A-Z][a-z]+(?: [A-Z][a-z]+)?)\b', b['text'])   # the verb in any case, the name capitalized
            if not m or m.group(2).lower() == speaker.split()[0].lower(): continue
            other = m.group(2).split()[0]
            new = b['text'][:m.start(2)] + speaker.split()[0] + b['text'][m.end(2):]
            fixed.append([f"{b['text']} ({b['owner']})", f'{new} ({other})']); b['text'] = new; b['owner'] = other
    # Advice is for the listener: a step owned by the person who said it, where that moment tells the other "you should /
    # start / try ..." on a two-person call, belongs to the other ("Build AI automation projects (Gio)" was Gio's advice
    # to Yentin, 2026-10-10). A "me" left in a step is the person who said it.
    labels = sorted({l['who'] for l in lines})
    if len(labels) == 2:
        name = lambda who: (me if who == 'Me' and me else who).split()[0]
        cue = re.compile(r"\b(you should|you could|you can|you need to|you have to|you want to|i'd|i would|make sure|start|try|go|apply|build|email|reach out|network|message)\b", re.I)
        for sec in sections:
            if not NEXT.match(sec['heading']): continue
            for b in sec['bullets']:
                t0 = summary.seconds(b.get('at'))
                if t0 is None or not b.get('owner'): continue
                near = [l for l in lines if abs(l['t'] - t0) <= 30]
                owner = b['owner'].split()[0].lower()
                verb = (re.findall(r'[A-Za-z]+', b['text']) or [''])[0].lower()[:4]   # the step's own verb, said in that line
                said_by_owner = [l for l in near if name(l['who']).lower() == owner and re.search(r"\byou(r)?\b", l['text'], re.I) and cue.search(l['text'])
                                 and len(verb) >= 3 and verb in l['text'].lower()
                                 and not re.search(rf"\b(i'll|i will|let me|i can|i'm going to|i am going to)\s+{verb}", l['text'], re.I)]   # "I'll introduce you to Dana" is the speaker's promise
                if not said_by_owner: continue
                other = next((name(w) for w in labels if name(w).lower() != owner), None)
                if not other: continue
                new = re.sub(r'\bme\b', b['owner'].split()[0], b['text'])
                fixed.append([f"{b['text']} ({b['owner']})", f'{new} ({other})']); b['text'] = new; b['owner'] = other
            for b in sec['bullets']:   # "Email me" owned by the listener: "me" is the other person
                if b.get('owner') and re.search(r'\bme\b', b['text']):
                    other = next((name(w) for w in labels if name(w).lower() != b['owner'].split()[0].lower()), None)
                    if other: new = re.sub(r'\bme\b', other, b['text']); fixed.append([b['text'], new]); b['text'] = new
    return {'reversed': fixed}

def goal_leaks(sections, lines, goal):
    # A phrase the goal quotes ("the 'Do it' feature") that the call never says cannot name a section or a point: the
    # hackathon notes headed a section "Make 'Do it' feature functional for Jess", from the Loggie workstream's goal, and
    # "Do it" is not in the transcript (2026-10-10). Such a heading takes its first point's label, or goes, its points
    # joining the section before; such a point goes.
    said = ' '.join(l['text'] for l in lines).lower()
    terms = [q for q in re.findall(r"""['"‘“]([^'"’”]{2,40})['"’”]""", str(goal or '')) if q.lower() not in said]
    if not terms: return {'leaks': []}
    has = lambda text: any(q.lower() in text.lower() for q in terms)
    leaks, out = [], []
    for sec in sections:
        keep = []
        for b in sec['bullets']:
            if has(b['text']) and b.get('level', 0) == 0 and not NEXT.match(sec['heading']) or has(b['text']) and NEXT.match(sec['heading']):
                leaks.append(b['text']); continue
            keep.append(b)
        sec['bullets'] = keep
        if has(sec['heading']):
            leaks.append(sec['heading'])
            m = re.match(r'^([^:]{2,40}):\s', keep[0]['text']) if keep else None
            if m: sec['heading'] = m.group(1)
            elif out and keep: out[-1]['bullets'].extend(keep); continue
            else: sec['heading'] = 'Notes'
        if sec['bullets'] or NEXT.match(sec['heading']): out.append(sec)
    sections[:] = out
    return {'leaks': leaks}

def heading_names(sections, lines, far_names):
    # A heading names only people said near its points: "Past winner insights (Richard, 2025)" named a man who opened a
    # door at 13:44 (Hilton). far_names finds the name; code takes it out with its possessive or its parenthesis. Points
    # keep their (not sure) mark instead: cutting names from points also cut "Saturday", "Qualtrics" and "Aman".
    changed = []
    for sec in sections:
        ts = [t for t in (summary.seconds(b.get('at')) for b in sec['bullets']) if t is not None]
        near = [l for l in lines if any(abs(l['t'] - t) <= 60 for t in ts)]
        for w in far_names(sec['heading'], lines, near):
            h = re.sub(rf"\s*\(\s*(?:from\s+)?{w}(?:'s|’s)?\s*,?\s*([^)]*)\)", lambda m: f' ({m.group(1)})' if m.group(1).strip() else '', sec['heading'])
            h = re.sub(rf"\b{w}(?:'s|’s)?\b,?\s*", '', h).strip()
            changed.append([sec['heading'], h]); sec['heading'] = h
    return {'headings': changed}

def point_names(sections, lines, far_names, known=((), ())):
    # A point naming someone said once or twice in the call, far from the point's moment, takes the one name the user
    # knows (their word list first, then the invitees) said near the moment, but only when the doubtful name was itself
    # said away from every known name: "Richard got a Four Seasons internship" (4 of 4 Hilton gradings caught it) has
    # "That's Richard. He opened the door" at 13:43 with no one known nearby, so it becomes Yiming, said at 33:06; "Aman"
    # was said beside "do you know Yiming?" (43:37), so it is part of his story and stays. Asked instead, Ultra answered
    # "no one" for Richard 3 of 3 times with Yiming's turn in front of it; cutting names cut "Saturday" and "Qualtrics".
    said_at = lambda w: [l['t'] for l in lines if re.search(rf'\b{re.escape(w)}\b', l['text'])]
    mentions = lambda k, t: any(re.search(rf'\b{re.escape(k)}\b', l['text']) for l in lines if abs(l['t'] - t) <= 150)
    names = [*known[0], *known[1]]
    swapped = []
    for sec in sections:
        for b in sec['bullets']:
            t = summary.seconds(b.get('at'))
            if t is None: continue
            near = [l for l in lines if abs(l['t'] - t) <= 150]
            bad = [w for w in far_names(b['text'], lines, near) if 1 <= len(said_at(w)) <= 2 and w not in names
                   and summary.norm(w) not in transcript.DATES and w.lower() not in DAYS
                   and not any(mentions(k, s) for k in names for s in said_at(w))]
            if len(bad) != 1: continue
            here = lambda group: [k for k in group if mentions(k, t) and not re.search(rf'\b{re.escape(k)}\b', b['text'])]
            nearby = here(known[0]) or here(known[1])
            if len(nearby) != 1: continue
            new = re.sub(rf'\b{re.escape(bad[0])}\b', nearby[0], b['text'])
            swapped.append([b['text'], new]); b['text'] = new
    return {'names': swapped}

DAYS = {'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'}

def cut_repeats(sections):
    # A "For later" line whose words are mostly in one point above (its headline with its details) or in an earlier
    # "For later" line goes, with its details: Liz r10b listed PI planning, influence and shadow days in both places.
    points = []
    for sec in sections:
        if not is_body(sec): continue
        for b in sec['bullets']:
            if b.get('level', 0) == 0 or not points: points.append(words(b['text']))
            else: points[-1] |= words(b['text'])
    later = next((s for s in sections if s['heading'].strip().lower() == LATER), None)
    cut = []
    if later:
        keep, skip, seen = [], False, []
        for b in later['bullets']:
            if b.get('level', 0) == 0:
                ws = words(b['text'])
                skip = bool(ws) and any(len(ws & p) / len(ws) >= 0.5 for p in points + seen)
                if skip: cut.append(b['text'])
                seen.append(ws)
            if not skip: keep.append(b)
        later['bullets'] = keep
    sections[:] = [s for s in sections if s['bullets'] or NEXT.match(s['heading'])]
    return {'repeats': cut}

def budget_of(minutes, topics, kind):
    # Words for the notes: the larger of 125 + 5 x minutes (AMI fit, Zhu et al. 2020) and 80 a topic (MeetingBank: 65-90
    # words a topic), floor 200, cap 550, or 750 for a class (complete notes help review, Kiewra et al. 1991, pp. 240-241).
    # Minutes alone gave the 27-minute Liz chat 260 words and cut the 1-on-1 script the rival app kept in 389 (r9 lost 0 of 2).
    return min(CAP_CLASS if kind == 'class' else CAP, max(FLOOR, 125 + 5 * minutes, WORDS_PER_TOPIC * topics))

def trim(sections, lines, goal, kind, ask):
    # The budget is held in code (Ultra ignored every length written in a prompt). Headlines, with their details, are
    # ranked by one small call on how much each helps the goal (position is not value: by position alone the Liz run
    # moved the bank's two pillars to More); they are kept in rank order until the budget is spent, every section keeping
    # at least its best one, and the rest move, in order, to "More". Next Steps and "For later" always stay.
    if not lines: return {'budget': None}, None
    minutes = max(1, round((max(l['t'] for l in lines) - min(l['t'] for l in lines)) / 60))
    topics = sum(1 for s in sections if is_body(s))
    budget = budget_of(minutes, topics, kind)
    cost = lambda b: len(b['text'].split())
    groups = []
    for si, sec in enumerate(sections):
        if not is_body(sec): continue
        cur = None
        for b in sec['bullets']:
            if b.get('level', 0) == 0 or cur is None: cur = [b]; groups.append((si, cur))
            else: cur.append(b)
    spent = sum(cost(b) for s in sections if not is_body(s) for b in s['bullets'])
    meta, order, off = None, [], set()
    if groups:
        reply, meta = ask(f"""Goal: "{goal}".
Order these points from a call's notes by how much each helps reach the goal, most useful first: advice and facts that change what to do or say beat background. Then list under "off_goal" the numbers of points that do not help reach the goal at all (for example someone's past work elsewhere, or an event unrelated to the goal). Answer with JSON only: {{"order": [3, 1, 2], "off_goal": [2]}}
""" + '\n'.join(f'{k + 1}. {g[0]["text"]}' for k, (_, g) in enumerate(groups)))
        found = json_of(reply)
        order = [int(x) - 1 for x in (found.get('order') or found.get('items') or []) if str(x).isdigit() and 0 < int(x) <= len(groups)]
        off = {int(x) - 1 for x in (found.get('off_goal') or []) if str(x).isdigit() and 0 < int(x) <= len(groups)}
    # Off-goal points go to More even with room to spare: a Liz run with 257 of 400 words kept "43 North: 500+ students,
    # $1M" and Liz's nonprofit background under M&T, and lost both blind gradings on them (2026-10-09). A model marking
    # more than 40% of the points off-goal is ignored rather than trusted to gut the notes.
    off = off if len(off) <= 0.4 * len(groups) else set()
    keep = set()
    for k in dict.fromkeys(order + list(range(len(groups)))):
        if k in off: continue
        c = sum(cost(b) for b in groups[k][1])
        if spent + c <= budget or not any(groups[j][0] == groups[k][0] for j in keep): keep.add(k); spent += c
    more = [b for k, (_, g) in enumerate(groups) if k not in keep for b in g]
    if more:
        gone = {id(b) for b in more}
        for s in sections:
            if is_body(s): s['bullets'] = [b for b in s['bullets'] if id(b) not in gone]
        sections[:] = [s for s in sections if s['bullets'] or NEXT.match(s['heading'])]
        sections.insert(next((i for i, s in enumerate(sections) if not is_body(s)), len(sections)), {'heading': 'More', 'bullets': more})
    return {'minutes': minutes, 'topics': topics, 'budget': budget, 'kept_words': spent, 'more_words': sum(cost(b) for b in more), 'ranked': len(order), 'off_goal': [groups[k][1][0]['text'] for k in sorted(off)]}, meta

def run_all(sections, lines, event, ask, far_names, me_label='Me', known=((), ())):
    # Every pass, in order, on sections in place. Returns what each did and the metas of the calls made, for the cost line.
    goal, metas, report = event.get('goal'), [], {}
    passes = (('shape', lambda: shape(sections, ask)),
              ('goal_only', lambda: (drop_goal_only(sections, goal, lines), None)),
              ('leaks', lambda: (goal_leaks(sections, lines, goal), None)),
              ('steps', lambda: steps(sections, lines, goal, ask, me_label)),
              ('latest', lambda: (latest_labels(sections), None)),
              ('owners', lambda: (placeholder_owners(sections), None)),
              ('one_mic', lambda: (one_mic_owners(sections, lines, [event.get('me') or '', *known[0], *known[1]], str(event.get('title') or '')), None) if event.get('one_mic') else ({'skipped': 'two tracks'}, None)),
              ('retime', lambda: retime(sections, lines, goal, ask, me_label)),
              ('headings', lambda: (heading_names(sections, lines, far_names), None)),
              ('reversed', lambda: (asked_of_listener(sections, lines, event.get('me')), None) if not event.get('one_mic') else ({'skipped': 'one mic'}, None)),
              ('names', lambda: (point_names(sections, lines, far_names, known), None)),
              ('roles', lambda: (role_names(sections, lines), None)),
              ('repeats', lambda: (cut_repeats(sections), None)),
              ('trim', lambda: trim(sections, lines, goal, summary.kind_of(event), ask)))
    for name, run in passes:
        try: report[name], meta = run()
        except SystemExit as error: report[name], meta = {'error': str(error)}, None   # a failed call leaves the notes as they are
        if meta: metas.append(meta)
    return report, metas
