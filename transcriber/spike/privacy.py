# The privacy screen (proposal-c.md, increment 5). Before a call transcript leaves the Mac for the user's frontier model
# (byo.py), a step on the Mac decides, sentence by sentence, what may cross. Why: byo.py used to send the whole transcript.md;
# on the Priya call (2026-10-07) that carried a health aside ("I might have torn my ACL", "right now I can't
# walk", "hope your ACL get well soon"). The product promise, and the hackathon's Personal AI track, is that the user's
# data stays under the user's control: nothing crosses that a listed, checkable step on the Mac did not clear.
#   python3 privacy.py <version-folder>
#   python3 privacy.py --eval fixtures/privacy-cases.json
#   python3 privacy.py --thread <THREAD.md> [--out DIR] [--me NAME]   (email threads, see below)
# Reads <version-folder>/transcript.md, writes outbound.md (the transcript with each held sentence replaced by
# "[<category> kept on this Mac]") and held.json (every held sentence, with the layer that held it). New files only:
# outbound-2.md/held-2.json when the first pair exists; nothing in a calls folder is ever overwritten.
#
# The same categories and the same deny-by-default rule as Loggie's attachment screen (src/hikyaku/sensitive.js).
#   1. Code: patterns per category (injection, identity, money, health, grades, third-party, confidential), then the
#      targeted word lists (wordlists.py). Cheap, deterministic, a named rule per hit. A hit holds the sentence.
#   2. Context, code too: a reaction after a held line and the rest of a confidential or injection turn are held.
# There is no model on this Mac (Gio, 2026-10-18: "fully remove nemotron on mac"): what code did not hold is sent, and
# outbound.md's note and held.json say so: "Screened on this Mac by code only: health lines are not checked".
#
# Why the sentence is the unit, not the turn: Gio's [04:26] turn holds the health line and then "let me start first";
# a turn-level cut would lose the handoff, a sentence-level cut keeps it. The "[mm:ss] Speaker:" prefix stays on every
# turn so the summary keeps its timeline; consecutive held sentences in a turn collapse into one marker.
#
# Edge cases decided here (and tested in fixtures/privacy-cases.json):
#   - ACL/tear/knee words are health only next to a person's possessive or an injury verb ("my ACL", "torn my",
#     "hope your ACL get well"): an ACL on an S3 bucket, tearing down a pipeline, pass the code layer.
#   - Money is personal when tied to a person: "my rent", "offered me a salary of $145k", "Marcus owes me $3,000".
#     "$700 of API usage", a company's revenue, a pricing page's "$20 a month" and a project budget carry no person and
#     pass the code layer.
#   - A person's own job history ("I worked at Citi", "I left the firm in 2023") is ordinary; a third person's job loss
#     ("Tomas got laid off"), visa, divorce, death in the family, arrest is third-party and held by code.
#   - Pregnancy, a diagnosis, medication, surgery, a therapist, "can't walk", "get well soon" hold regardless of whose.
#   - "transcript" is not a grades word in speech (this product makes transcripts); GPA with a number, a letter grade
#     "in" a class, academic probation, a test score are.
#   - A long number read aloud digit by digit (8 or more) is held as identity: it is an ID, a card or a phone number,
#     and the summary needs none of them.
#   - Marker text never leaves: a held sentence's words appear only in held.json, which stays in the calls folder.
import difflib, functools, json, re, sys, time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import summary, transcript, lexicon, wordlists   # lexicon: the mail sign-off and quoted-reply patterns, reused for threads
import spelling   # the spellings the user's own words prove, applied before the screen (loggie-auto-spelling)

CATEGORIES = ('injection', 'identity', 'money', 'health', 'grades', 'third-party', 'confidential')
LAYERS = ('code',)   # every hold is code's; Loggie's line.hold adds "user" (src/hikyaku/hold-line.js)
MARK = '[{} kept on this Mac]'
CODE_ONLY = 'Screened on this Mac by code only: health lines are not checked'
LINE = re.compile(r'^\[(\d+):(\d\d)\] ([^:\]]+): (.*)$', re.S)

# ---------- layer 1: code ----------

# A person's possessive, case-sensitive for names ("Marcus's", "Lena's") so that "the company's" and "everybody's" do
# not count as a person. Pronouns are matched in any case.
PERSON = r"(?:(?i:my|your|his|her|their)|[A-Z][a-z]+'s)"
# Pronouns and names that make an amount or a fact "about a person" (the user included: "me", "I").
PERSON_WORD = re.compile(r"(?i:\b(?:i|i'm|i've|i'd|me|my|mine|you|you're|your|he|he's|him|his|she|she's|her|hers)\b)|(?<!^)\b[A-Z][a-z]+(?:'s)?\b|^[A-Z][a-z]+ (?i:makes|made|earns|owes|got|was offered|is paid|gets paid|pays)\b")
AMOUNT = re.compile(r"\$\s?\d[\d,.]*\s?(?i:k|m|million|thousand|grand)?\b|\b\d[\d,.]*\s?(?i:k|grand|thousand dollars|hundred dollars|dollars|bucks)\b")
MONEY_WORD = re.compile(r"(?i:\b(?:salary|salaries|base|signing bonus|bonus|comp|compensation|offer(?:ed)?|paycheck|pay|paid|paying|make|makes|making|made|earn|earns|earning|owe|owes|owed|debt|loans?|student loans?|rent|mortgage|savings|net worth|credit card|credit score|bank account|checking|in the bank|an hour|per hour|hourly|a year|per year|a month|per month|stipend|tuition|401k|rsus?|equity|stock options)\b)")

def luhn_valid(digits):
    # Ported from sensitive.js: a payment card number has a check digit; random runs pass one time in ten.
    if not re.fullmatch(r'\d{13,19}', digits): return False
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1: d = d * 2 - 9 if d * 2 > 9 else d * 2
        total += d
    return total % 10 == 0

def card_numbers(text):
    out = []
    for m in re.finditer(r'(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)', text):
        digits = re.sub(r'[ -]', '', m.group())
        if re.match(r'97[89]', digits) and len(digits) == 13: continue   # ISBN-13
        if luhn_valid(digits): out.append(digits)
    return out

def personal_amount(s):
    # Money tied to a person: a person word, a money word and an amount in the same sentence ("they offered me a base
    # salary of $145,000", "Marcus owes me $3,000"). "$700 of API usage" has a person and an amount but no money word;
    # "the pro plan at $20 a month" has a money word and an amount but no person. Both pass.
    return bool(PERSON_WORD.search(s) and MONEY_WORD.search(s) and AMOUNT.search(s))

BODY = r"(?i:acl|mcl|meniscus|achilles|hamstring|ligament|tendon|rotator cuff|knee|ankle|shoulder|wrist|hip|neck|elbow|rib|collarbone|spine|back|leg|arm|foot|hand|finger|toe|head|skull)s?"
INJURY_VERB = r"(?i:torn|tore|tear|sprain(?:ed)?|broke|broken|fractur(?:e|ed)|dislocat(?:e|ed)|hurt|injur(?:e|ed|y)|twist(?:ed)?|snapped|ruptur(?:e|ed))"
ILLNESS = r"(?i:covid|the flu|a flu|sick|a cold|a fever|food poisoning|strep|pneumonia|a concussion|a migraine|migraines|bronchitis|an infection|a stomach bug|the stomach flu)"

# Each rule: id, category, pattern (a compiled regex or a function of the sentence). First hit wins; injection first,
# so whatever else a sentence holds, text that argues with the screen stays on the Mac.
def rules():
    R = lambda p: re.compile(p)
    return [
        ('steering', 'injection', R(r"(?i:ignore (?:all |any )?(?:the |your |my |these )?(?:previous |prior |above |earlier )?(?:instructions|rules|guidelines)"
                                    r"|disregard (?:the |your |all |any )?(?:previous |prior )?(?:instructions|rules)"
                                    r"|mark (?:this|it|everything|all of (?:this|it)|the transcript|these|all) (?:as )?(?:safe|not sensitive|public|ordinary)"
                                    r"|classify (?:this|it|everything) as (?:safe|not sensitive|public)"
                                    r"|[\"']?sensitive[\"']?\s*(?:[:=]|equals|is)\s*false"
                                    r"|answer (?:with )?[\"']?(?:false|not sensitive)"
                                    r"|you are (?:now )?(?:an? )?(?:ai|assistant|model|screen|language model)\b[^.?!]{0,80}\b(?:must|should|will) (?:answer|say|reply|return)"
                                    r"|this (?:transcript|call|sentence|conversation|recording|file) (?:is|was) (?:not|non)[- ]?(?:sensitive|confidential|private)"
                                    r"|(?:not|non)[- ]?sensitive\W{0,3}(?:send|share|forward|pass) it"
                                    r"|send (?:this|it|everything|all of it) to the (?:agent|cloud|model|ai)"
                                    r"|\bsystem prompt\b|\bnew instructions?\s*:)")),
        ('ssn', 'identity', R(r"\b\d{3}-\d{2}-\d{4}\b|(?i:\bssn\b|\bsocial security\b|\b(?:my|his|her|their|your) social\b)")),
        ('email', 'identity', R(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")),
        ('id-number', 'identity', R(r"(?i:\b(?:student id|net ?id|id number|passport|driver'?s? licen[cs]e|licen[cs]e number|date of birth|dob|sevis|i-?20|i-?94|alien number|account number)\b)[^.?!]{0,30}?(?:\d[ -]?){5,}")),
        ('id-words', 'identity', R(r"(?i:\bpassport number\b|\bdriver'?s licen[cs]e number\b|\bdate of birth\b|\bsevis\b|\bi-?94\b|\balien (?:registration )?number\b)")),
        ('digits-aloud', 'identity', R(r"(?:\b\d[ -]){7,}\d\b")),
        ('card', 'money', lambda s: bool(card_numbers(s))),
        ('card-words', 'money', R(r"(?i:\b(?:cvv|cvc|cvv2)\b|\bcard number\b|\bexpir(?:y|ation)\s*(?:date)?\s*(?:is\s*)?\d{1,2}/\d{2})")),
        ('bank', 'money', R(r"(?i:\biban\b|\brouting (?:number|no)\b|\baccount number\b|\bsort code\b|\bwire (?:transfer )?instructions\b|\bbank statement\b)")),
        ('tax', 'money', R(r"(?i:\bw-?2\b(?!\d)|\bw-?4\b(?!\d)|\b1099\b|\b1040\b|\b1098-?t\b|\btax (?:return|withholding|transcript)\b|\btaxable income\b)")),
        ('aid', 'money', R(r"(?i:\bfinancial aid\b|\bfafsa\b|\bpell grant\b|\bstudent aid index\b|\bexpected family contribution\b|\bloan (?:servicer|balance|disbursement)\b|\btuition (?:bill|balance)\b|\bbursar\b)")),
        ('own-money', 'money', R(PERSON + r" (?i:(?:base |annual |starting |monthly )?(?:salary|paycheck|rent|mortgage|debt|loans?|student loans?|credit cards?|credit score|savings|net worth|bank account|checking account|signing bonus|compensation|comp package|stipend|tuition|401k|rsus?|stock options)\b)")),
        ('personal-amount', 'money', personal_amount),
        ('medical', 'health', R(r"(?i:\bdiagnos(?:is|ed|e)\b|\bprescri(?:ption|bed)\b|\bmedication\b|\bmeds\b|\bchemo(?:therapy)?\b|\bsurgery\b|\bsurgeon\b|\btherapist\b|\bhospitali[sz]ed\b|\bconcussion\b|\bstitches\b|\bcrutches\b|\bwheelchair\b|\bbiopsy\b|\btumou?r\b"
                                 r"|\binsulin\b|\bantibiotics\b|\bpainkillers\b|\bantidepressants?\b|\banxiety\b|\bdepression\b|\bpanic attacks?\b|\bmigraines?\b|\basthma\b|\bdiabet(?:es|ic)\b|\bpregnan(?:t|cy)\b|\bmiscarriage\b"
                                 r"|\bget well\b|\bfeel better soon\b|\bspeedy recovery\b|\bsick leave\b|\bmedical leave\b|\bmental health\b|\bphysical therapy\b|\burgent care\b|\bemergency room\b|\bin the er\b|\bicu\b|\bhipaa\b|\bmy (?:doctor|dr)\b|\bdoctor'?s? (?:appointment|visit|note|orders)\b|\bbed ?rest\b)")),
        ('injury', 'health', R(rf"\b{INJURY_VERB}\b[^.?!]{{0,30}}?\b(?:(?i:my|his|her|your|the|a)) {BODY}\b|\b{PERSON} {BODY}\b[^.?!]{{0,30}}?\b{INJURY_VERB}\b|\b{PERSON} (?i:acl|mcl|meniscus|achilles|hamstring|ligament|rotator cuff)\b|\b(?i:a tear|a sprain|just a sprain|a fracture)\b")),
        # An injury with no possessive ("Injured ass leg.", the mock interview at 00:32, 2026-10-26): the passive verbs only,
        # never "hurt" or "broke" ("It hurt the back of the pipeline" fired in the spike).
        ('injury-bare', 'health', R(rf"(?i:\b(?:injured|sprained|fractured|dislocated)\b(?:\s+[\w']+){{0,2}}?\s+{BODY}\b)")),
        ('ill', 'health', R(rf"(?i:\b(?:i|i've|i'm|he|he's|she|she's|you|you're|you've)\b|\b[A-Z][a-z]+\b) (?i:(?:had|have|has|got|caught|am|is|was|been|still have|still has)(?: \w+){{0,2}} {ILLNESS}\b)|(?i:\b(?:feel|feeling|felt) (?:sick|ill|nauseous|dizzy|terrible|awful)\b|\bcan'?t (?:walk|stand|sleep|eat|breathe|move)\b|\bon crutches\b|\bthrew up\b|\bthrowing up\b)")),
        ('care', 'health', R(r"(?i:\b(?:went|go|going|been|was|headed|have to go|had to go|need to go|got to go) to (?:the|my|a|an) (?:doctor|dr|hospital|er|clinic|dentist|urgent care|orthopedist|physio|therapist|pharmacy)\b|\b(?:in|started|start|doing|going to|back in|my|his|her|your) (?:physical |couples |talk )?therapy\b)")),
        ('grades', 'grades', R(r"(?i:\bgpa\b\s*(?:of|is|was|:|=)?\s*\d|\bgrade point average\b|\bacademic (?:probation|standing|warning)\b|\breport card\b|\bfinal grades?\b|\bfailed (?:the|my|his|her|an?|that) (?:class|course|exam|midterm|final|test|quiz)\b"
                                r"|\b(?:got|get|getting|received|ended up with) (?:an? )?[A-D][+-]? (?:in|on|for)\b|\b(?:my|his|her|their) (?:grades?|gpa|score|test scores?|gmat|gre)\b|\b(?:gmat|gre|lsat|mcat)\b[^.?!]{0,15}?\b\d{3,4}\b)")),
        ('third-party', 'third-party', R(r"(?i:\bdivorc(?:e|ed|ing)\b|\bcustody\b|\bpassed away\b|\bfuneral\b|\bbereavement\b|\bfamily emergency\b|\bin rehab\b|\bin recovery\b|\bdeported\b|\bimmigration status\b|\bvisa (?:was |got |has been )?(?:denied|rejected|expired|revoked)\b|\bvisa (?:status|issues?|problems?|sponsorship)\b|\bgreen card\b|\bh-?1b\b|\bgoing through a (?:divorce|breakup|hard time|rough patch)\b|\brestraining order\b|\bchild support\b)"
                                        r"|" + PERSON + r" (?i:(?:visa|immigration|lawsuit|dui|bankruptcy|affair|breakup|arrest|probation|disciplinary))\b"
                                        r"|(?i:\b(?:he|she|him)\b|\b[A-Z][a-z]+\b) (?i:(?:was|got|were|is|has been|just got|is getting|is being) (?:laid off|fired|let go|terminated|arrested|suspended|evicted|sued|deported|put on (?:a )?pip|put on probation))\b")),
        ('confidential', 'confidential', R(r"(?i:\bbetween (?:us|you and me|the two of us|ourselves)\b|\bdon'?t tell (?:anyone|anybody|people|him|her|them)\b|\bkeep (?:this|it|that) (?:to yourself|between us|quiet|under wraps|confidential)\b|\boff the record\b|\bconfidential\b|\bunder nda\b|\bdon'?t (?:repeat|share|forward|mention) (?:this|that|it)\b|\bnot (?:public|announced) yet\b|\bthis (?:stays|is) (?:in this room|just between)\b|\binternal (?:use )?only\b|\bprivileged\b|\bdo not distribute\b|\bnot for distribution\b)")),
    ]

CODE_RULES = rules()

# Context rules, code too (2026-10-07: the live 30B released "Oh no, that's awful, send her my best" after a surgery
# line and an NDA's launch date, although its prompt asks for them; a model that judges sentences one by one cannot be
# trusted with continuations, so code does it):
#   - a reaction or sympathy sentence right after a held health, third-party, money or grades sentence (same turn or
#     the next one) inherits that category: "that's terrible", "I hope it's just a sprain", "send her my best";
#   - a confidential or injection hit holds its whole turn: the secret is what the turn says, before and after the
#     "between us"; a turn that argues with the screen sends nothing.
REACTION = re.compile(r"(?i:\b(?:that'?s|that is|it'?s|how|so) (?:so |really |just )?(?:terrible|awful|horrible|rough|tough|too bad|unfortunate|sad|brutal|disappointing)\b|\boh,? no\b|\boh,? wow\b|\boh,? my god\b|\boh,? shit\b|\bthat sucks\b|\bsorry to hear\b|\bi'?m (?:so |really )?sorry\b|\bsend (?:him|her|them) my (?:best|love|regards)\b|\bhang in there\b|\btake care of yourself\b|\bhope (?:you|he|she|it|they|that|your \w+) (?:get|gets|feel|feels|heal|heals|recover|recovers)\b|\bhope it'?s (?:just|only|nothing)\b|\bwhat the (?:fuck|hell)\b|\bnot worth it\b|\bget well\b|\bfeel better\b)")
TURN_WIDE = ('injection', 'confidential')
CHAINS = ('health', 'third-party', 'money', 'grades')

def context_holds(rows, held):
    # Adds the context holds to `held` (i -> record), in sentence order so a chain of reactions follows a held line.
    for r in rows:
        if r['i'] in held: continue
        prev = held.get(r['i'] - 1)
        k = r['i'] - 1   # a backchannel ("Yeah.", "Mm-hmm.", three words or fewer) does not break the chain
        while not prev and k > 0 and r['i'] - k <= 2 and len(rows[k]['text'].split()) <= 3:
            k -= 1; prev = held.get(k)
        if prev and prev['layer'] == 'code' and prev['category'] in CHAINS and REACTION.search(r['text']):
            held[r['i']] = {'category': prev['category'], 'layer': 'code', 'rule': 'reaction'}
    for cat in TURN_WIDE:
        turns = {r['turn'] for r in rows if r['i'] in held and held[r['i']]['category'] == cat}
        for r in rows:
            if r['turn'] in turns and r['i'] not in held: held[r['i']] = {'category': cat, 'layer': 'code', 'rule': 'whole-turn'}
    return held

def people_of(event):
    # The call's other names (the person found on the call, them.py's them_label, then the invite's "with" / names /
    # attendees, never the user): what the third-party word list looks for next to a health or family-crisis word, and who
    # an interview trims to a first name. The invite stays when Them is someone else: the recruiter who sent it is a person too.
    me = (event.get('me') or '').strip()
    out = []
    for text in (event.get('them_label') or '', event.get('with') or '', event.get('names') or event.get('attendees') or ''):
        for p in (x.strip() for x in re.split(r',|;|\band\b|&', text)):
            if p and p not in (me, 'the other person', 'Me', 'Them') and p not in out: out.append(p)
    return out

def invitees(event):
    # lexicon.invitee_names plus the person found on the call (them_label), full name and first name.
    out = lexicon.invitee_names(event)
    label = ' '.join(str(event.get('them_label') or '').split())
    for n in ([label, label.split()[0]] if label and label not in ('Them', 'Me') else []):
        if n.lower() not in {o.lower() for o in out}: out.append(n)
    return out

def code_hit(sentence, people=()):
    # The code layer on one sentence: (category, rule id) for the first rule that fires, or None. The older rules come
    # first; the targeted word lists (wordlists.py) come last, with the call's other names for the third-party rule.
    flat = ' '.join(sentence.split())
    for rule_id, category, test in CODE_RULES:
        hit = test(flat) if callable(test) else test.search(flat)
        if hit: return category, rule_id
    return wordlists.hit(flat, people)

# ---------- the transcript, as sentences ----------

def parse_md(text):
    # The file as paragraphs: header paragraphs (title, date, model line) are kept as they are; every stamped turn
    # becomes {'t', 'stamp', 'who', 'sentences': [...]}. The sentence split is summary.sentences (abbreviation-safe).
    header, turns = [], []
    for para in re.split(r'\n\s*\n', text.strip()):
        m = LINE.match(para.strip())
        if not m:
            if not turns: header.append(para.strip())
            continue
        t = int(m.group(1)) * 60 + int(m.group(2))
        turns.append({'t': t, 'stamp': f'{m.group(1)}:{m.group(2)}', 'who': m.group(3).strip(), 'sentences': summary.sentences(' '.join(m.group(4).split()))})
    return header, turns

def flatten(turns):
    # One row per sentence, numbered across the whole call: the index held.json and lines[] carry.
    rows = []
    for ti, turn in enumerate(turns):
        for si, s in enumerate(turn['sentences']):
            rows.append({'i': len(rows), 'turn': ti, 'k': si, 'time': turn['stamp'], 'who': turn['who'], 'text': s})
    return rows

# ---------- the screen ----------

def judge(rows, names):
    # Code over every row: the patterns and word lists, then the context rules. Returns held: i -> {'category', 'layer', 'rule'}.
    # names['trim']: a call whose people leave by first name (trims); the role and resume rules run on it too.
    held = {}
    for r in rows:
        hit = code_hit(r['text'], names.get('people', ())) or (trim_hit(r['text'], r['who']) if names.get('trim') else None)
        if hit: held[r['i']] = {'category': hit[0], 'layer': 'code', 'rule': hit[1]}
    return context_holds(rows, held)

def marked(rows, held):
    # The rows' words with each held sentence replaced, consecutive ones collapsed into one marker naming their
    # categories in order.
    pieces, run = [], []
    def flush():
        if run:
            cats = []
            for c in run:
                if c not in cats: cats.append(c)
            pieces.append(MARK.format(', '.join(cats))); run.clear()
    for r in rows:
        if r['i'] in held: run.append(held[r['i']]['category'])
        else: flush(); pieces.append(r['text'])
    flush()
    return ' '.join(pieces)

def tally(rows, turns, held):
    # held[] rows and counts, the same for a call and a thread.
    held_rows = [{'i': r['i'], 'time': r['time'], 'speaker': r['who'], **held[r['i']], 'text': r['text']} for r in rows if r['i'] in held]
    counts = {'sentences': len(rows), 'sent': len(rows) - len(held_rows), 'held': len(held_rows), 'turns': len(turns),
              'turns_fully_held': sum(1 for ti, t in enumerate(turns) if t['sentences'] and all(r['i'] in held for r in rows if r['turn'] == ti)),
              'layer': {l: sum(1 for h in held_rows if h['layer'] == l) for l in LAYERS},
              'category': {c: sum(1 for h in held_rows if h['category'] == c) for c in sorted({h['category'] for h in held_rows})}}
    return held_rows, counts

def lines_of(rows, held):
    # Every sentence with its fate (spec B4 `lines[]`, additive): what went, what stayed and why. Stays on the Mac.
    return [{'i': r['i'], 'turn': r['turn'], 'time': r['time'], 'speaker': r['who'], 'status': 'kept' if r['i'] in held else 'sent',
             **({k: held[r['i']][k] for k in ('category', 'layer', 'rule')} if r['i'] in held else {'category': None, 'layer': None, 'rule': None}), 'text': r['text']} for r in rows]

def note_of(counts, held_file, left_out=''):
    # The line under the header of outbound.md, in plain words.
    return f"_{CODE_ONLY}. {counts['held']} of {counts['sentences']} sentences kept back (code {counts['layer']['code']}); {left_out}see {held_file}._"

def screen(header, turns, names, mask=None, trim=None):
    # The code layer over every sentence. Returns (outbound text, record). `mask` = (event, own, protect) for a class
    # (loggie-class-notes): the screened text's classmates become Student N, sent rows in lines[] carry the labels (the
    # review and "Keep this line" read them), held rows keep their words (they never leave), and record['names'] is the
    # map. `trim` = (event, own, protect, notes) for a call whose people leave by first name (trim_people): the same
    # shape, the map in record['trimmed']. None for both: today's output, byte for byte.
    rows = flatten(turns)
    held = judge(rows, {**names, 'trim': bool(names.get('trim')) or trim is not None})
    # outbound: each turn with its held sentences replaced, consecutive ones collapsed into one marker
    out_turns = [f"[{turn['stamp']}] {turn['who']}: {marked([r for r in rows if r['turn'] == ti], held)}" for ti, turn in enumerate(turns)]
    held_rows, counts = tally(rows, turns, held)
    outbound = '\n\n'.join(header + [note_of(counts, 'held.json')] + out_turns) + '\n'
    record = {'screened_by': 'code', 'model_layer': CODE_ONLY, 'counts': counts, 'held': held_rows, 'lines': lines_of(rows, held)}
    if trim is not None:
        event, own, protect, *notes = trim
        extra = '\n'.join(l for l in (notes[0] if notes else '').splitlines() if l.strip())
        trimmed, found = trim_people(outbound, event, own, protect, extra)
        record['lines'] = [{**l, 'text': relabel(l['text'], found)} if l['status'] == 'sent' else l for l in record['lines']]
        record['counts']['trimmed'] = {'people': len(found), 'mentions': sum(len(form_re(f).findall(outbound)) for v in found.values() for f in v['forms'])}
        record['trimmed'] = found
        record['trim_version'] = TRIM_VERSION
        return trimmed, record
    if mask is None: return outbound, record
    # A 4th item: the user's typed notes (my-notes.md). They are searched with the transcript, so a classmate named only
    # there gets a label too and the notes share the call's map (review, 2026-10-23: "Yes, Marnie." in the notes left).
    event, own, protect, *notes = mask
    # The transcript, the notes and the two together are searched apart and their names merged, so the notes can add a
    # classmate and never take one away (review r2).
    extra = '\n'.join(l for l in (notes[0] if notes else '').splitlines() if l.strip())
    whole = outbound + ('\n\n' + extra + '\n' if extra else '')
    found = classmates_in(outbound, event, own, protect)
    if extra:
        merge_found(found, classmates_in(extra, event, own, protect, notes=True))
        merge_found(found, classmates_in(whole, event, own, protect))
    found = number_labels(whole, found)
    for v in found.values():
        if not any(form_re(f).search(outbound) for f in v['forms']): v['at'] = ['notes']
    masked = relabel(outbound, found)
    record['lines'] = [{**l, 'text': relabel(l['text'], found)} if l['status'] == 'sent' else l for l in record['lines']]
    record['counts']['masked'] = {'labels': len(found), 'mentions': sum(len(form_re(f).findall(outbound)) for v in found.values() for f in v['forms'])}
    record['names'] = found
    record['mask_version'] = MASK_VERSION
    return masked, record

def free_pair(folder, names=('outbound.md', 'held.json')):
    # outbound.md + held.json (a thread: OUTBOUND.md + HELD.json) take the first free suffix where NEITHER exists, so
    # the pair always shares a number.
    n = 1
    while any((folder / (f'{Path(x).stem}-{n}{Path(x).suffix}' if n > 1 else x)).exists() for x in names):
        n += 1
    return tuple(folder / (f'{Path(x).stem}-{n}{Path(x).suffix}' if n > 1 else x) for x in names)

def latest_pair(folder):
    # The newest outbound/held pair in a folder (highest suffix), or (None, None).
    folder = Path(folder).resolve()
    best = None
    for p in folder.glob('outbound*.md'):
        m = re.fullmatch(r'outbound(?:-(\d+))?\.md', p.name)
        if not m: continue
        n = int(m.group(1) or 1)
        if best is None or n > best[0]: best = (n, p)
    if best is None: return None, None
    held = folder / (f'held-{best[0]}.json' if best[0] > 1 else 'held.json')
    return best[1], held if held.exists() else None

def screen_folder(folder, quiet=False):
    # The command: read transcript.md, screen, write the pair. Exit 1 and nothing written when there is no transcript.
    folder = Path(folder).resolve()
    md = folder / 'transcript.md'
    if not md.exists(): sys.exit(f'no transcript.md in {folder}')
    event = summary.event_of(folder)
    names = {**summary.names_for(event), 'people': people_of(event)}
    said = md.read_text()
    # "MNT (unclear)" -> "M&T" when the user's own words prove it (spelling.py): what is screened, sent and checked
    # carries the spelling; transcript.md keeps what was heard, and held.json "spelled" says what changed and why.
    spelled = spelling.proven(folder, event, said)
    header, turns = parse_md(spelling.apply(said, spelled))
    if not turns: sys.exit(f'{md} has no stamped turns')
    t0 = time.time()
    if summary.kind_of(event) == 'class':
        course = transcript.course(event) or {}
        if course.get('professor') and not event.get('professor'): event = {**event, 'professor': course['professor']}
        notes = folder / NOTES_FILE
        mask = (event, *class_inputs(folder, event), notes.read_text(errors='replace') if notes.exists() else '')
    else: mask = None
    trim = None
    if mask is None and trims(event):
        notes = folder / NOTES_FILE
        trim = (event, *class_inputs(folder, event), notes.read_text(errors='replace') if notes.exists() else '')
    outbound, record = screen(header, turns, names, mask, trim)
    out_md, out_json = free_pair(folder)
    record = {'created': datetime.now().astimezone().isoformat(timespec='seconds'), 'source': 'call', 'transcript': md.name, 'outbound': out_md.name,
              'seconds': round(time.time() - t0, 1), **record, 'spelled': spelled}
    out_md.write_text(outbound)
    out_json.write_text(json.dumps(record, indent=1, ensure_ascii=False))
    c = record['counts']
    if not quiet:
        masked = f", {c['masked']['labels']} classmates written as Student 1 to {c['masked']['labels']}" if c.get('masked', {}).get('labels') else ''
        if c.get('trimmed', {}).get('people'): masked = f", {c['trimmed']['people']} {'person' if c['trimmed']['people'] == 1 else 'people'} by first name only"
        print(f"{out_md.name}: {c['sent']} of {c['sentences']} sentences go out, {c['held']} held by code in {record['seconds']}s{masked}; {out_json.name} lists them.")
    return out_md, out_json, record

# ---------- classmates (loggie-class-notes) ----------
# A class carries other students' names, and the screen used to refuse every class (byo.py refuse_if_private). Gio,
# 2026-10-20: "just run it but keep the names private or something". After the screen, code on the Mac turns every
# classmate the rules find into a stable label ("Student 1", the same label for the same name through the call) and
# keeps the map in held.json beside the held sentences, so what crosses carries labels and the names come back only on
# this Mac (docs/class-notes/spec.md 1.1 to 1.3). Code with named rules, never a model: the Mac has none.
# Letters with accents count, and a hyphen joins two parts (review 2026-10-23: "Thanks, Anne-Marie. Thanks, Renée." left
# whole); a two-letter name ("Thanks, Li.") is read only where someone is spoken to.
UP, LO = 'A-ZÀ-ÖØ-Þ', 'a-zß-öø-ÿ'
CAP = rf"[{UP}][{LO}]{{2,}}"
NAME = rf"{CAP}(?:['’][{LO}]+)?(?:-[{UP}][{LO}]+)?"
SHORT = rf"[{UP}][{LO}]"
UNCLEAR = r"(?: \(unclear(?:; likely [^)]*)?\))"
NEVER = set("""I Okay Ok Yeah Yes So And But The Um Uh Oh Ah Eh Er Ha Hm Mm Us No Well Right Like What Now Then If This That It We You They He She In
On At For To Of A An Is Are Was Do Does Did Can How Why When Where Who Which Let Just Also All Any Because There Here My Our
Your His Her Its Their Not Or As By With From Up Out Over Under Good Great Very Really Maybe Actually Basically Thank Thanks
Please Sorry Hi Hello Hey Me Them Room Speaker Professor Prof Student Students Mr Mrs Ms Dr President Chairman Chair Senator
Governor Secretary Everyone Everybody Guys Folks Team Class Sir Mam Ma'am Go Come Sure Correct Exactly Cool Nice Wow Mhm Hmm
Alright Anyone Anybody Somebody Someone Next Last First One Two Three Question Questions Idea Point Huh God Look See Others
Anything Everything Nothing Something Wait Listen Imagine Remember Mac Goodbye Bye Welcome Doctor Coach""".split())
# Places and peoples are what a class talks about, never a classmate: no rule but the invitee one reads them as a name.
PLACES = set("""Afghanistan Africa African America American Americans Argentina Asia Asian Australia Australian Austria Bangladesh
Bangladeshi Belgium Brazil Brazilian Britain British Canada Canadian Chile China Chinese Colombia Cuba Denmark Danish Egypt
Egyptian England English Europe European Finland France French Germany German Greece Greek India Indian Indonesia Iran Iraq
Ireland Irish Israel Italy Italian Japan Japanese Kenya Korea Korean Mexico Mexican Netherlands Dutch Nigeria Norway
Pakistan Pakistani Peru Philippines Poland Polish Portugal Russia Russian Singapore Spain Spanish Sweden Swedish Switzerland
Swiss Taiwan Thailand Turkey Ukraine Vietnam Alabama Alaska Arizona California Colorado Connecticut Florida Georgia Hawaii
Idaho Illinois Indiana Iowa Kansas Kentucky Louisiana Maine Maryland Massachusetts Michigan Minnesota Mississippi Missouri
Montana Nebraska Nevada Ohio Oklahoma Oregon Pennsylvania Tennessee Texas Utah Vermont Virginia Washington Wisconsin Wyoming
Country Countries""".split())
TITLE = {'President', 'Chairman', 'Chair', 'Professor', 'Prof', 'Dr', 'Doctor', 'Mr', 'Mrs', 'Ms', 'Senator', 'Governor', 'Secretary', 'CEO'}
# A public title names a figure the class is about ("President Calloway"), and "Professor" names faculty ("Professor
# Beth (unclear) talked about", 10-08). A doctor's or a polite title can name a classmate ("Doctor Marnie (unclear)",
# review 2026-10-23): it marks a figure only for the professor or organizer the event names.
SCHOOL_TITLE = {'Dr', 'Doctor'}   # Mr, Mrs, Ms name a figure ("Mr. Keynes (unclear) favored a stimulus", review r2)
STOPPERS = {'the', 'a', 'an', 'at', 'in', 'of', 'from', 'on', 'into', 'to', 'for', 'with', 'called', 'named'}
YES = r"(?i:yes|yeah|okay|ok|thank you|thanks|go ahead|come on|please|question|idea|point|sorry|see you|hi|hello|hey|good|great|right|correct|exactly|sure|no)"
GREET = r"(?i:yes|yeah|thank you|thanks|go ahead|please|sorry|see you|hi|hello|hey)"   # before a full name: "Thanks, Mary Ann."
ASK = (r"(?i:what|can|could|do|did|would|will|you|your|go ahead|any|how|why|tell|let|yes|please"
       r"|explain|walk|share|give|talk|start|describe|read|take|jump|continue|elaborate|expand|finish|repeat|answer|try|say|speak)")
START = r"(?:^|(?<=[,.?!] )|(?<=: ))"
# A filler before a name at the start of a sentence still addresses it: "So Jay, what do you have to say?" (10-08).
LEAD = r"(?:(?i:so|and|okay|ok|now|alright|well|uh|um),? )?"
ADDRESSED = [re.compile(rf"\b{YES},?\s+({NAME}|{SHORT}){UNCLEAR}?(?=\s*(?:[,.?!]|$))", re.M),
             re.compile(rf"{START}{LEAD}({NAME}|{SHORT}){UNCLEAR}?,\s*{ASK}\b", re.M),
             re.compile(rf"{START}{LEAD}({NAME}){UNCLEAR}?\?", re.M),
             # a name closing a sentence after a lowercase word and a comma: "People are working together, Steve." (10-06);
             # "India, Japan, China." is a list, not a person spoken to (the word before the comma is capitalized)
             re.compile(rf"(?<=[a-z]), ({NAME}|{SHORT}){UNCLEAR}?(?=[.?!](?:\s|$))", re.M),
             re.compile(rf"(?:^|(?<=[.?!] )|(?<=: ))(?i:uh|um),? ({NAME}){UNCLEAR}?\.", re.M),
             # review r2: "Thanks, Marnie for explaining." and a full name spoken to, "Thanks, Mary Ann."
             re.compile(rf"\b(?i:thanks|thank you),?\s+({NAME}){UNCLEAR}?\s+for\b", re.M),
             re.compile(rf"\b{GREET},?\s+({NAME} {NAME}){UNCLEAR}?(?=\s*(?:[,.?!]|$))", re.M),
             # a classmate called on (10-22 class at 157:09: "Can we hear from Marnie? ... Go Marnie. ... Let's go Marnie.")
             re.compile(rf"\b(?i:hear from|call on|let'?s go|go),?\s+({NAME}|{SHORT}){UNCLEAR}?(?=\s*(?:[,.?!]|$))", re.M)]
# Said about someone, not to them (review r2: typed notes "Marnie had the best answer.", "- Marnie: capacity constraint."):
# weak rules, every filter applies.
MENTIONED = [re.compile(rf"(?<![\w'’-])({NAME}){UNCLEAR}? (?:said|says|asked|asks|argued|agreed|disagreed|mentioned|suggested|answered"
                        rf"|made (?:a|the) (?:\w+ )?point|had (?:a|the) (?:\w+ )?(?:answer|point|question|idea|comment|take))\b"),
             re.compile(rf"^[ \t]*(?:[-*•][ \t]*)?({NAME}){UNCLEAR}?[ \t]*:[ \t]", re.M)]
UNCLEAR_NAME = re.compile(rf"(?<![\w'’])({NAME}){UNCLEAR}")
# Opening a question is strong evidence of a person, except for the words that open any sentence (review r2: "However,
# what happens next?" became Student 1).
DISCOURSE = set("""However Instead Therefore Otherwise Meanwhile Anyway Again Still Plus Besides Overall Hence Thus Indeed Rather Also
Though Yet Further Moreover Furthermore Nevertheless Nonetheless Second Third Lastly Finally Similarly Alternatively Conversely
Ultimately Next Today Tomorrow Yesterday Here There""".split())
# A framework the class names in any case ("We use Batna (unclear) to prepare.") is a topic for the weak rules.
FRAMEWORKS = set('batna zopa swot pestel pest vrio npv irr ebitda capm wacc okr kpi roi mece raci cagr'.split())
# Common short forms of an invitee's first name (review r2: invitee Elizabeth Vale, "Liz agreed." left). A short form
# that is an English word (Will, Bill, Pat) is left out: it would label every sentence it opens.
NICKNAMES = {k.strip(): v.split() for k, v in (l.split(':') for l in """Elizabeth:Liz Beth Betsy Eliza Lizzie|William:Liam Billy|Robert:Bobby
Robbie|Richard:Rick Ricky|Michael:Mike Mikey|Christopher:Chris Topher|Katherine:Kate Katie Kat Kathy|Catherine:Cathy Kate Katie
|Jennifer:Jen Jenny|Alexander:Alex Xander|Alexandra:Alex Sasha Lexi|Nicholas:Nico Nicky|Matthew:Matt|Daniel:Dan Danny|Joseph:Joe
Joey|Jonathan:Jon Jonny|Benjamin:Ben Benji|Samuel:Sam Sammy|Samantha:Sam Sammy|Thomas:Tom Tommy|James:Jim Jimmy Jamie
|Margaret:Maggie Meg Peggy|Rebecca:Becca Becky|Victoria:Vicky Tori|Anthony:Tony|Andrew:Andy Drew|Edward:Eddie Ted Teddy
|Patricia:Trish Patty|Steven:Steve|Stephen:Steve|Susan:Susie|Deborah:Deb Debbie|Gregory:Greg|Timothy:Tim Timmy|Zachary:Zach
|Joshua:Josh|Jacob:Jake|Abigail:Abby|Olivia:Liv Livvy|Isabella:Bella Izzy|Isabel:Izzy|Theodore:Theo Teddy|Frederick:Fred Freddie
|Charles:Charlie Chuck|Lawrence:Larry|Kenneth:Kenny|Ronald:Ronnie|Donald:Donny|Raymond:Ray|Philip:Phil|Peter:Pete|Douglas:Doug
|Jeffrey:Jeff|Nathaniel:Nate Nat|Nathan:Nate|Kimberly:Kim|Pamela:Pam|Cynthia:Cindy|Christina:Tina Chrissy|Christine:Chrissy
|Allison:Ally Allie|Natalie:Nat|Melissa:Mel Missy|Amanda:Mandy|Gabriel:Gabe|Gabriella:Gabby Ella|Vincent:Vince|Leonard:Leo Lenny
|Valerie:Val|Jessica:Jess Jessie|Elena:Lena|Eleanor:Ellie Nora|Dorothy:Dot Dottie|Florence:Flo|Francesca:Frankie|Francis:Frank
|Gerald:Gerry|Harold:Harry Hal|Jacqueline:Jackie|Madeline:Maddie|Madeleine:Maddie|Mitchell:Mitch|Rosemary:Rosie|Sebastian:Seb
|Sophia:Sophie|Sophie:Soph|Tobias:Toby|Vanessa:Nessa""".replace('\n', ' ').split('|'))}
LABEL_WORD = re.compile(r"\b[Ss]tudents? \d+\b")
# Only classmates' personal names (2026-10-23). On the 10-22 strategy class (2 h 39 min) the rules above labelled 38
# words, and 22 were not people: Corning (said 27 times), Google, Apple, Daimler, Caterpillar, BATNA and ZOPA, the case
# "Himmel and Byrne", "Goodbye", "Whereas", "Largely". The prompt says never to guess who a label is, so the notes lost
# the companies the class was about and covered 5 headings of 159 minutes. Four filters, code only:
#   - ordinary: an English word (macOS /usr/share/dict/words, lowercase entry) that is not also a first name
#     (propernames, or a capitalized entry there) is a name only when spoken to after a yes-word or closing a sentence
#     after a comma ("Yes, Rain.", "a good idea, Rain."), or joined to a classmate ("Sorrel and Brisk"); "Largely,
#     yes." and "Corning?" open a sentence, they call no one;
#   - frequent: said capitalized FREQUENT times or more and never spoken to. Measured 2026-10-23 over the five recorded
#     classes: no classmate outside the invite is said more than 3 times; Daimler 8, Corney 10, Google 20, Corning 27;
#   - acronym: written in capitals somewhere, or its letters are the first letters of words said near it ("Batna ...
#     the best uh alternative to a negotiated agreement", "the Zopa is the zone of possible agreement"); not first names;
#   - variant: a word heard (unclear) at every mention that is a near spelling of a word rejected above and said often
#     ("Cornina (unclear)", "Cornyan (unclear)" for Corning, "Deinler (unclear)" for Daimler); not first names.
# A pair after "at", "of", "called" ("called Himmel and Byrne (unclear)", "at Google and Wayne (unclear)") names a firm
# or a case, so its second word is not an unclear name; "joined" still labels it when the first word is a classmate.
FREQUENT = 6
STRONG = (0, 3, 5, 6, 7)   # the ADDRESSED patterns that speak to someone: after a yes-word, closing a sentence after a comma
# A frequent word is a topic only with topic evidence (review r2: "Zelphine said it." six times was dropped as a topic):
# said after a firm's preposition ("at Vantrex", "the company Vantrex") or named as one ("Vantrex is the company").
TOPIC_BEFORE = re.compile(r"(?i:\b(?:at|of|from|in|into|than|versus|vs|the|company|firm|brand)\s+)$")
TOPIC_AFTER = re.compile(r"(?i:['’]s\s+(?:stock|shares?|products?|business|strategy|revenue|market|customers?|ceo|board|brand|model|platform|plants?|factory)\b"
                         r"|\s+(?:is|was|are|were)\s+(?:a|an|the)\s+(?:\w+\s+)?(?:company|firm|brand|startup|case|business|framework|tool|model)\b)")
# A pair after "case was" names the case (review r2: "The case was Himmel and Byrne (unclear).").
CASE_PAIR = re.compile(rf"(?i:\bcases?(?:\s+(?:was|is|were|are|of|on|about))?)\s+{NAME}{UNCLEAR}? (?:and|&) $")
PAIR_LEAD = {'at', 'of', 'from', 'called', 'named', 'the'}
GREETED = re.compile(r"(?i:thank you|thanks|hi|hello|hey|sorry|see you|go ahead|please)\b")
QUESTION_END = re.compile(r"\?|[.!](?=[ \t]*(?:\n|$)|[ \t]+[\"'(\[]?[A-Z])|\n")
FILLER = {'a', 'an', 'the', 'uh', 'um'}
VARIANT = 0.7   # difflib ratio; Cornina/Corning 0.86, Cornyan/Corning 0.71, Deinler/Daimler 0.71

def dict_words(path=Path('/usr/share/dict/words'), names=Path('/usr/share/dict/propernames')):
    # (English words, first names). No dictionary on this machine: no word is ordinary, so the mask only grows.
    read = lambda p: p.read_text(errors='replace').split() if p.exists() else []
    words = read(path)
    return {w for w in words if w.islower()}, set(read(names)) | {w for w in words if w[:1].isupper()}
ENGLISH, FIRST_NAMES = dict_words()

def ordinary(word): return word.lower() in ENGLISH and word not in FIRST_NAMES

def acronym(word, text):
    # BATNA heard as "Batna": capitals somewhere, or the initials of a run of words said within 300 characters of it.
    if re.search(rf"\b{re.escape(word.upper())}\b", text): return True
    letters = word.lower()
    if not 4 <= len(letters) <= 6: return False
    for m in form_re(word).finditer(text):
        near = [w for w in re.findall(r"[a-z]+", text[max(0, m.start() - 300):m.end() + 300].lower()) if w != letters]
        for i in range(len(near)):
            k = 0
            for w in near[i:]:
                if k == len(letters) or (w[0] != letters[k] and w not in FILLER): break
                if w[0] == letters[k]: k += 1
            if k == len(letters) and near[i][0] == letters[0]: return True
    return False

def base(word):
    # A name without its possessive: "Rain's" -> "Rain".
    return re.sub(r"['’]s$", '', word)

def lower_words(text):
    # Every word said in lowercase in the call: "rain" here means "Rain" may be an ordinary word, not a name.
    return set(re.findall(rf"(?<![^\W\d_])[{LO}][{LO}'’]*", text))

def figures(text, lowered):
    # Two capitalized words in a row ("Jack Welch", "Kenny (unclear) Endo") name someone the class is about, not a
    # classmate: both words stay, unless the second is followed by " (unclear) and" (a pair of students).
    out = set()
    for m in re.finditer(rf"\b({CAP})(?:{UNCLEAR})? ({CAP})\b(?! \(unclear[^)]*\) and)", text):
        a, b = m.group(1), m.group(2)
        if any(w in NEVER or w.lower() in lowered for w in (a, b)): continue
        out.update((a, b))
    return out

def class_inputs(folder, event):
    # (own, protect) for mask_classmates: the user's names (the event, Loggie's settings, profile.md, and the "own"
    # entries of lexicon.json in the folder and its parent, whole and each word of 3+ letters), and the title's words.
    folder = Path(folder)
    names = list(lexicon.own_names(event))
    for f in (folder / 'lexicon.json', folder.parent / 'lexicon.json'):
        try: entries = json.loads(f.read_text()) if f.exists() else []
        except (OSError, ValueError): entries = []
        if isinstance(entries, dict): entries = entries.get('entries', [])
        for e in entries if isinstance(entries, list) else []:
            if isinstance(e, dict) and e.get('source') == 'own' and e.get('text'): names.append(e['text'])
    own = set()
    for n in names:
        own.add(n.lower())
        own.update(w.lower() for w in re.findall(r"[A-Za-z][A-Za-z'’-]{2,}", n))
    protect = {w.lower() for term in lexicon.title_terms(event) for w in re.findall(r"[A-Za-z]+", term)}
    return own, protect

def about_words(event):
    # The invite's description and the course's own materials (2026-10-23) name the companies and cases the class is
    # about: their capitalized words that are not first names, lowercased. Text files only, read as they are. They
    # protect a word that only a weak rule found; an invitee or a person spoken to is still a classmate (review).
    about = ' '.join(str(event.get(k) or '') for k in ('description', 'notes'))
    materials = Path(event['materials']) if event.get('materials') else None
    code = transcript.COURSE.search(event.get('title', ''))
    if materials is None and code: materials = transcript.COURSES / code.group(0).replace(' ', '')
    if materials is not None and materials.is_dir():
        for f in sorted(materials.iterdir()):
            if f.suffix in ('.txt', '.md'):
                try: about += ' ' + f.read_text(errors='replace')
                except OSError: pass
    return {w.lower() for w in re.findall(rf"\b{CAP}\b", about) if w not in FIRST_NAMES}

# The mask's rules change (2026-10-23: companies, cases, acronyms and plain words stopped being labelled), and a class
# screened under older rules must be screened again: a pair whose record carries another version is not fresh
# (sendgate.fresh_pair). Before, the 10-22 class kept Corning as Student 6 through a Summarize after the fix.
MASK_VERSION = '2026-10-23d'   # b: the review's six fixes (spoken to beats the filters, notes searched, titles); c: review r2; d: called on ("Go X.")

def mask_classmates(text, event, own=(), protect=()):
    # The locked signature: (masked text, names). names = { "Student N": { name, forms, unclear, likely, rule, at } }.
    names = number_labels(text, classmates_in(text, event, own, protect))
    return relabel(text, names), names

def merge_found(into, more):
    # Names another text's rules found join the map; one already there keeps its rule and gains forms. Only ever adds
    # (review r2: typed notes "Marnie Vale: cost leadership" made the transcript's "Yes, Marnie." a figure and left it).
    for name, v in more.items():
        same = next((k for k, w in into.items() if k == name or name in w['forms'] or k in v['forms']), None)
        if same is None: into[name] = {**v, 'forms': list(v['forms'])}
        else: into[same]['forms'] += [f for f in v['forms'] if f not in into[same]['forms']]
    return into

def classmates_in(text, event, own=(), protect=(), notes=False):
    # The rules over one text: { name: { 'forms': [...], 'rule': id } }, not yet numbered. `notes`: the user's typed notes,
    # where a name said about someone (MENTIONED) counts too; in a transcript "Steve said" is as often Steve Jobs.
    own = {o.lower() for o in own}
    title = {p.lower() for p in protect}
    lowered = lower_words(text)
    figure = figures(text, lowered)
    mine = lambda w: w.lower() in own
    kept = lambda w: not mine(w) and w.lower() not in title and w.lower() not in transcript.DATES
    plain = lambda w: kept(w) and w not in NEVER and w not in PLACES and w not in figure
    # A person spoken to or on the roster beats the title words, the two-capitals figure rule and the topic filters; only
    # the user's names, NEVER, and a date or a place not thanked or greeted stay (review r2: "Thanks, May." with invitee
    # May Chen, "Thanks, Georgia.", "Yes, Marnie. Marnie Vale made a point." all left; "Columbus, Ohio." calls no one).
    spoken_ok = lambda w, greeted=False: not mine(w) and w not in NEVER and (greeted or (w not in PLACES and w.lower() not in transcript.DATES))
    about = about_words(event)
    topic = lambda w: plain(w) and w.lower() not in about and w.lower() not in FRAMEWORKS   # a weak rule's word
    faculty = {w for k in ('professor', 'organizer') for w in re.findall(r"[A-Z][a-z]{2,}", str(event.get(k) or ''))}
    found = {}   # name -> {'forms': [...], 'rule': id}
    taken = lambda w: w in found or any(w in v['forms'] for v in found.values())
    def add(name, rule, forms=None):
        if not taken(name): found[name] = {'forms': forms or [name], 'rule': rule}
    present = lambda f: form_re(f).search(text)
    nicks = lambda first: [n for n in NICKNAMES.get(first, ()) if n.lower() not in ENGLISH and not mine(n)]
    for full in invitees(event):
        if ' ' not in full or mine(full.split()[0]): continue
        words = [w for w in full.split() if len(w) >= 3 and not mine(w)]
        words += [h for w in words if '-' in w for h in w.split('-') if len(h) >= 3 and not mine(h)] + nicks(full.split()[0])
        if any(present(f) for f in [full, *words]): add(full, 'invitee', [full, *words])
    for full in invitees(event):
        if ' ' not in full and not mine(full) and any(present(f) for f in [full, *nicks(full)]): add(full, 'invitee', [full, *nicks(full)])
    # Spoken to: a yes-word before, closing a sentence after a comma, or opening a question ("Rain, could you explain?").
    # The question ends at the turn's first ? or at a . or ! before a capital, so "U.S." and "1.2" do not end it (review r2).
    def asks(m):
        end = QUESTION_END.search(text, m.end())
        return bool(end) and end.group(0) == '?'
    hits = []
    for i, pattern in enumerate(ADDRESSED):
        for m in pattern.finditer(text):
            w = base(m.group(1))
            hits.append((w, i in STRONG or (i == 1 and asks(m) and w not in DISCOURSE and not (ordinary(w) and w.endswith('ly'))), bool(GREETED.match(m.group(0)))))
    called = {x for w, _, _ in hits for x in [w, *w.split()]}
    counts, rejected = {}, set()
    def said(w):
        if w not in counts: counts[w] = len(form_re(w).findall(text))
        return counts[w]
    def topical(w):
        # said often is a topic only with a topic's evidence: TOPIC_BEFORE or TOPIC_AFTER, lowercase, capitals, the description
        return (w.lower() in lowered or w.lower() in about or acronym(w, text)
                or any(TOPIC_BEFORE.search(text[max(0, m.start() - 12):m.start()]) or TOPIC_AFTER.match(text, m.end()) for m in form_re(w).finditer(text)))
    def person(w, strong=False):
        # the four filters (2026-10-23, above); a word they turn away may be the base of a variant
        if (ordinary(w) and not strong) or (said(w) >= FREQUENT and w not in called and w not in FIRST_NAMES and topical(w)) or (w not in FIRST_NAMES and acronym(w, text)):
            rejected.add(w); return False
        return True
    # A word of a two-capitals figure said FREQUENT times is a guest or a figure even when spoken to (10-08: the guest
    # "Jim (unclear) Cummins", said 30 times; 10-22: "Wendell (unclear) Weeks"); no classmate is said that often.
    guest = lambda w: w in figure and said(w) >= FREQUENT
    for w, strong, greeted in hits:
        if strong and all(spoken_ok(x, greeted) and not guest(x) for x in w.split()): add(w, 'addressed', [w, *w.split()] if ' ' in w else None)
        elif not strong and ' ' not in w and plain(w) and person(w): add(w, 'addressed')
    def figure_led(m, w):
        # after a public title, a capitalized word or a stopper the word names a figure or a firm
        before = re.search(r"([A-Za-z]+)\.?\s+$", text[max(0, m.start() - 40):m.start()])
        prev = before.group(1) if before else ''
        if prev in SCHOOL_TITLE: return w in faculty
        return bool(prev) and bool(re.fullmatch(r"[A-Z][a-z]{2,}", prev) or prev in TITLE or prev.lower() in STOPPERS)
    for m in UNCLEAR_NAME.finditer(text):
        w = base(m.group(1))
        if figure_led(m, w): continue
        lead = text[max(0, m.start() - 80):m.start()]
        pair = re.search(rf"\b([A-Za-z]+) {NAME}{UNCLEAR}? (?:and|&) $", lead)
        if (pair and pair.group(1).lower() in PAIR_LEAD) or CASE_PAIR.search(lead): continue
        if topic(w) and w.lower() not in lowered and person(w): add(w, 'unclear-name')
    for pattern in MENTIONED if notes else ():
        for m in pattern.finditer(text):
            w = base(m.group(1))
            if not figure_led(m, w) and topic(w) and w.lower() not in lowered and person(w): add(w, 'mentioned')
    often = [r for r in rejected if said(r) >= FREQUENT and r not in FIRST_NAMES]
    for name in [n for n, v in found.items() if v['rule'] != 'invitee' and n not in FIRST_NAMES and n not in called]:
        marks = [m.group('mark') for m in form_re(name).finditer(text)]
        if marks and all(marks) and any(b[0] == name[0] and difflib.SequenceMatcher(None, b.lower(), name.lower()).ratio() >= VARIANT for b in often):
            del found[name]
    for _ in range(3):
        if not found: break
        known = '|'.join(re.escape(f) for f in sorted({f for v in found.values() for f in v['forms']}, key=len, reverse=True))
        grew = False
        for pattern in (rf"({NAME}){UNCLEAR}?\s+(?:and|&)\s+(?:(?:uh|um),?\s+)?(?:{known})\b", rf"\b(?:{known}){UNCLEAR}?\s+(?:and|&)\s+(?:(?:uh|um),?\s+)?({NAME})"):
            for m in re.finditer(pattern, text):
                w = base(m.group(1))
                if topic(w) and w.lower() not in lowered and not taken(w) and person(w, strong=True):
                    add(w, 'joined'); grew = True
        if not grew: break
    # A found name followed by a capitalized word is a full name, and the second word is the same person (review r2:
    # "Marnie Vale: cost leadership" in typed notes left the surname once Marnie was a label).
    for v in [v for v in found.values() if v['rule'] != 'invitee']:
        for f in [f for f in v['forms'] if ' ' not in f]:
            for m in re.finditer(rf"(?<![\w'’-]){re.escape(f)}{UNCLEAR}? ({NAME})(?![\w'’-])", text):
                s = base(m.group(1))
                if spoken_ok(s) and s.lower() not in title and not taken(s): v['forms'] += [s, f'{f} {s}']
    return found

@functools.lru_cache(maxsize=4096)
def form_re(form):
    # One form, whole word, possessive allowed ('s, or a bare apostrophe: "James' analysis", review r2), with a following
    # "(unclear)" mark folded in. The form in capitals too, and in lowercase when no word of it is an English word
    # (review r2: "MARNIE made a point." left; "rain tomorrow" stays for a classmate called Rain).
    cases = [form, form.upper()] + ([form.lower()] if not any(w.lower() in ENGLISH for w in re.split(r"[\s-]+", form)) else [])
    alts = '|'.join(re.escape(c) for c in dict.fromkeys(cases))
    return re.compile(rf"(?<![\w'’-])(?:{alts})(?=['’]s\b|['’](?!\w)|(?![\w'’-]))(?P<mark>{UNCLEAR})?")

def number_labels(text, found):
    # Labels by the first position of any form (the header first, since it comes first), with unclear, likely and at.
    stamps = [(m.start(), m.group(1) + ':' + m.group(2)) for m in re.finditer(r'^\[(\d+):(\d\d)\]', text, re.M)]
    def at_of(pos):
        stamp = 'header'
        for start, s in stamps:
            if start <= pos: stamp = s
            else: break
        return stamp
    rows = []
    for name, v in found.items():
        hits = [m for f in v['forms'] for m in form_re(f).finditer(text)]
        if hits: rows.append((min(m.start() for m in hits), name, v, hits))
    out = {}
    for n, (_, name, v, hits) in enumerate(sorted(rows, key=lambda r: r[0]), 1):
        marks = [m.group('mark') or '' for m in hits]
        likely = next((re.search(r'likely ([^)]*)', mk).group(1) for mk in marks if 'likely' in mk), None)
        at = []
        for m in sorted(hits, key=lambda m: m.start()):
            a = at_of(m.start())
            if a not in at: at.append(a)
        out[f'Student {n}'] = {'name': name, 'forms': sorted(set(v['forms']), key=lambda f: (-len(f), f)), 'unclear': all(marks),
                               'likely': likely, 'rule': v['rule'], 'at': at}
    return out

WORD_USE = re.compile(r"(?i:\b(?:company|firm|brand|startup|stock|case)\s+)$")
TIME_PLACE_USE = re.compile(r"(?i:\b(?:in|of|since|until|during|early|late|mid|across|throughout|next|last)\s+)$")

def relabel(text, names):
    # Every form of every label, longest first, whole word, a following "(unclear)" folded into the label.
    # A form that is also an English word, a date or a place stays where it plainly names that (review r2: a classmate
    # called Apple, "The company Apple sells phones." lost the company).
    pairs = sorted(((f, label) for label, v in (names or {}).items() for f in v['forms']), key=lambda p: -len(p[0]))
    for form, label in pairs:
        word = ' ' not in form and ordinary(form)
        when = ' ' not in form and (form.lower() in transcript.DATES or form in PLACES)
        def sub(m, label=label, word=word, when=when):
            before = m.string[max(0, m.start() - 24):m.start()]
            return m.group(0) if (word and WORD_USE.search(before)) or (when and TIME_PLACE_USE.search(before)) else label
        text = form_re(form).sub(sub, text)
    return text

def relabel_record(value, names):
    # Every string inside a dict or list relabeled, keys too: summary-runs.json counts its not-sure reasons by their text
    # ("never said: Mendoza" was a key, 2026-10-26).
    if isinstance(value, str): return relabel(value, names)
    if isinstance(value, list): return [relabel_record(v, names) for v in value]
    if isinstance(value, dict): return {(relabel(k, names) if isinstance(k, str) else k): relabel_record(v, names) for k, v in value.items()}
    return value

def unmask(text, names):
    # "Student N" (any case, possessive kept) -> the map's name, "(unclear)" after it when every mention was unclear;
    # "Students 1 and 2", "Students 1, 2 and 3" -> the names joined the same way. A label the map lacks stays as is.
    names = names or {}
    def name_of(n):
        v = names.get(f'Student {n}')
        return None if not v else v['name'] + (' (unclear)' if v.get('unclear') else '')
    def many(m):
        got = [name_of(n) for n in re.findall(r'\d+', m.group(0))]
        if not all(got): return m.group(0)
        return ', '.join(got[:-1]) + ' and ' + got[-1]
    text = re.sub(r'\b[Ss]tudents \d+(?:, \d+)*,? and \d+\b', many, text)
    return re.sub(r'\b[Ss]tudent (\d+)\b', lambda m: name_of(m.group(1)) or m.group(0), text)

# ---------- people by first name (loggie-interview-privacy) ----------
# An interview used to be refused whole (byo.py PRIVATE), so the mock interview of 2026-10-26 had no notes. Gio: "names
# are ok just not full details so if its david convoy just keep it first name or something.. where the context will be
# understood by people in meeting not everyone elses". What leaves makes sense to someone who was in the meeting and
# identifies nobody to someone who was not: every person leaves by first name (code turns "Jonathan Mendoza" and a later
# "Mendoza" into "Jonathan"), and three code rules hold the sentences that pin a real person with no name at all: an
# injury, the other side's own role at an employer, and a third person's resume. The user's own names are never
# trimmed, and the map (first name -> full name and forms) stays in held.json "trimmed", beside the held sentences.
# No labels, so nothing is restored on screen: the notes read "Jonathan" there too (the full name is on the call card).
# doctor and medical calls stay refused (byo.py): there the health lines are the content, a sentence screen leaves nothing.
TRIMMED = ('interview',)
# The trim's rules change like the class mask's: a pair screened under other rules is not fresh (sendgate.fresh_pair).
TRIM_VERSION = '2026-10-26a'

def trims(event):
    # A call whose people leave by first name: the word in its category or, as a whole word, in its title.
    kind, title = str(summary.kind_of(event)).lower(), str(event.get('title', '')).lower()
    return any(k in kind or re.search(rf'\b{k}s?\b', title) for k in TRIMMED)

# The other side's own seat, said by someone who is not the user ("I run Tech Strategy at MT.", 00:48): with a first name
# it names one person at one employer. The user's own role is his story, and stays.
OWN_ROLE = re.compile(r"^(?:(?i:so|and|um|uh|well|yeah|okay|ok|now),?\s+)*(?i:i run|i lead|i head|i manage|i oversee|i'm the head of|i am the head of"
                      r"|i'm (?:the|a) (?:director|vp|vice president|head|partner|managing director|svp|evp|chief)|my title is|my role is)\b")
# A third person's resume read aloud (62:16 to 62:34 on the mock: a major, a firm and its years, a degree).
SCHOOLING = r"(?:major(?:ed)?|minor(?:ed)?|degree|studied|graduated|undergrad|alma mater|bachelor'?s|master'?s|mba|phd)"
BIO = re.compile(rf"(?i:\b(?:he|she|he's|she's)\b[^.?!]{{0,40}}?\b{SCHOOLING}\b"
                 rf"|\b(?:he|she)\s+(?:\w+\s+)?(?:worked|works|interned|spent \w+ years?)\s+(?:at|in|for)\b"
                 rf"|\b(?:he|she) did (?:his|her) (?:[\w-]+ ){{0,2}}(?:relations|studies|languages?|degree|major|undergrad|masters?|mba|phd|bachelor'?s)\b"
                 rf"|^(?:and )?worked (?:at|in|for)\b[^.?!]{{0,60}}\bfor (?:[\w-]+ ){{1,4}}years?\b)")

def trim_hit(sentence, who):
    # The two rules a trimmed call adds to the code layer: (category, rule id) or None.
    flat = ' '.join(sentence.split())
    if who != 'Me' and OWN_ROLE.search(flat): return 'third-party', 'own-role'
    if BIO.search(flat): return 'third-party', 'bio'
    return None

# A pair that names a firm, not a person: said where a firm goes ("at Goldman Sachs", "I worked at Citi, Morris Dandy"),
# or a firm named for its founders that interviews name often. Trimmed, "Morgan Stanley" would leave as "Morgan".
FIRM_BEFORE = re.compile(rf"(?:\b(?i:at|from|joined|into|than|versus|vs|the|company|firm|bank|brand)\s+|\b(?i:at|from|joined)\s+(?:[{UP}][\w&.'’-]*(?: \(unclear[^)]*\))?(?:,| and| &)?\s+){{1,4}})$")
FIRMS = {'Morgan Stanley', 'Goldman Sachs', 'Wells Fargo', 'Charles Schwab', 'Edward Jones', 'Raymond James', 'Merrill Lynch', 'Lehman Brothers',
         'Oliver Wyman', 'Marsh McLennan', 'Russell Reynolds', 'Allen Hamilton', 'Ernst Young', 'Arthur Andersen', 'Ralph Lauren', 'Calvin Klein',
         'Estee Lauder', 'Tommy Hilfiger', 'Hewlett Packard', 'Johnson Controls', 'Charles River', 'Thomson Reuters', 'Dean Witter', 'Bain Capital',
         'John Deere', 'Henry Schein', 'Dow Jones', 'Ben Jerry', 'Paul Weiss', 'Morgan Lewis', 'Baker McKenzie', 'Jones Lang', 'Cushman Wakefield'}
# Public figures a call talks about, never someone in the room (the stress run of 2026-10-26 over 30 recorded calls: Steve
# Jobs, Elon Musk, Jack Welch, Clay Christensen, Thomas Edison would have left as "Steve", "Elon", "Jack").
FAMOUS = {'Steve Jobs', 'Elon Musk', 'Jeff Bezos', 'Bill Gates', 'Warren Buffett', 'Mark Zuckerberg', 'Jack Welch', 'Clay Christensen', 'Simon Sinek',
          'Thomas Edison', 'Michael Faraday', 'Henry Ford', 'Sam Altman', 'Satya Nadella', 'Tim Cook', 'Jensen Huang', 'Sundar Pichai', 'Peter Drucker',
          'Michael Porter', 'Tony Stark', 'Steve Ballmer', 'Larry Page', 'Sergey Brin', 'Jamie Dimon', 'Indra Nooyi', 'Sheryl Sandberg', 'Reed Hastings',
          'Howard Schultz', 'Richard Branson', 'Oprah Winfrey', 'Barack Obama', 'Donald Trump', 'Joe Biden', 'Kamala Harris', 'Taylor Swift', 'Adam Smith',
          'John Maynard', 'Milton Friedman', 'Ben Bernanke', 'Jerome Powell', 'Janet Yellen', 'Alan Greenspan', 'Andy Grove', 'Steve Wozniak', 'Jack Ma',
          'Marc Andreessen', 'Peter Thiel', 'Ray Dalio', 'Charlie Munger', 'Bob Iger', 'Walt Disney', 'Mary Barra', 'Lisa Su', 'Jim Collins', 'Daniel Kahneman'}
# Words that start a place ("San Francisco", "South Carolina") and words an organization ends with ("Lodging Association").
PLACE_LEAD = set('San Santa Los Las New North South East West Saint St Fort Port Mount Lake Grand Upper Lower Central Little Great Palo Del El La Le'.split())
ORG_WORDS = set('''Association Hub Tank Group Bank Capital Partners Inc Labs Lab Club Society Council Institute University College School Center Centre
Foundation Hotel Hotels Resort Resorts Airlines Motors Systems Technologies Tech Media Studio Studios Ventures Consulting Holdings Industries Corporation
Company Co Corp Fund Funds Trust Advisors Analytics Health Healthcare Pharma Insurance Financial Securities Markets Network Networks Solutions Services
Brothers Sons Street Avenue Road Park Square Hall Building Tower Airport Station Bay Valley Beach Island Islands County City State Club'''.split())

# A pair whose first word is not in the first-name dictionary ("Ines Varga", "Yiming Zhang") is a person when it is said
# the way people are: after "met", "spoke with", "chat with", or followed by ", who", "'s" or a verb a person does.
PERSON_BEFORE = re.compile(r"\b(?i:with|met|meet|meeting|spoke to|talked to|talking to|talk to|named|called|by|thanks|thank you|hi|hello|hey|ask|asked|told|tell"
                           r"|emailed|email|texted|text|introduced me to|intro to|reached out to|and|like)\s+$")
PERSON_AFTER = re.compile(rf"^(?:{UNCLEAR})?(?:,? who\b|['’]s\b| (?i:said|says|told|tells|mentioned|asked|asks|is|was|works|worked|runs|ran|leads|led|will|would|can|reached|thinks|thought)\b)")

# A pair followed by what an organization is ("Cornell Johnson alumni", "Tech Buffalo hosted", "Bain Capital partners").
ORG_AFTER = re.compile(rf"^(?:{UNCLEAR})?\s+(?i:alumni|alumnus|alumna|alums?|school|university|college|bank|banking|group|team|club|office|program|capital"
                       r"|partners|consulting|ventures|labs?|inc|corp|company|foundation|center|centre|institute|students?|faculty|campus|hosted|announced)\b")

def people_in(text, event, own=(), protect=(), extra=''):
    # { first name: { name, forms, rule } }: the invitees (event.json) by their full names, and anyone said as
    # "First Surname" where First is a first name never said in lowercase and Surname is no place, date, title or ordinary
    # stop word. forms are every longer form and each surname alone, longest first; the first name alone is never a form.
    found = {}
    whole = text + ('\n' + extra if extra else '')
    lowered = lower_words(whole)
    own = {w.lower() for w in own}
    protect = {w.lower() for w in protect} | about_words(event)
    def add(words, rule):
        if len(words) < 2 or words[0].lower() in own: return
        rest = [w for w in words[1:] if len(w) >= 2 and w.lower() not in own]
        if not rest: return
        # A later word alone is a form only for an invitee or when it is no first name: "Paul Trick Sarah" (three people, no
        # commas, 10-23) must not turn every "Sarah" into "Paul". The longer forms still go.
        forms = {' '.join(words), *(f'{words[0]} {w}' for w in rest), *(' '.join(words[k:]) for k in range(1, len(words)) if len(words) - k > 1),
                 *(w for w in rest if rule == 'invitee' or w not in FIRST_NAMES)}
        e = found.setdefault(words[0], {'name': ' '.join(words), 'forms': [], 'rule': rule})
        if len(words) > len(e['name'].split()): e['name'] = ' '.join(words)
        e['forms'] = sorted(set(e['forms']) | {f for f in forms if f != words[0]}, key=lambda f: (-len(f), f))
    for person in people_of(event):
        if '@' in person: continue
        add(re.findall(rf"[{UP}][\w'’-]*", person), 'invitee')
    surname_ok = lambda w: (w not in NEVER and w not in PLACES and w not in TITLE and w.lower() not in lowered and w.lower() not in protect
                            and w.lower() not in own and w.lower() not in transcript.DATES and not w.isupper())
    for m in re.finditer(rf"(?<![\w'’-])({NAME}){UNCLEAR}? ({NAME}){UNCLEAR}?(?: ({NAME}){UNCLEAR}?)?(?![\w'’-])", whole):
        first, *rest = [g for g in m.groups() if g]
        if re.search(r"['’]s$", first) or first in PLACE_LEAD or first.lower() in transcript.DATES: continue
        if any(base(w) in ORG_WORDS for w in rest) or f'{first} {base(rest[0])}' in FAMOUS: continue
        if f'{first} {base(rest[0])}' in FIRMS or FIRM_BEFORE.search(whole[max(0, m.start() - 80):m.start()]) or ORG_AFTER.match(whole[m.end():m.end() + 40]): continue
        named = first in FIRST_NAMES or PERSON_BEFORE.search(whole[max(0, m.start() - 40):m.start()]) or PERSON_AFTER.match(whole[m.end():m.end() + 40])
        if not named or first in NEVER or first in PLACES or first in TITLE or first.lower() in lowered or first.lower() in own or first.lower() in protect: continue
        rest = [base(w) for w in rest]
        while rest and not surname_ok(rest[-1]): rest.pop()
        if rest and all(surname_ok(w) for w in rest): add([first, *rest], 'pair')
    # A form two people share ("Brandt" for Anthony Brandt and David Brandt) would put one's first name on the other: it is
    # nobody's. Their full forms still go.
    shared = {f for f in {f for v in found.values() for f in v['forms']} if sum(f in v['forms'] for v in found.values()) > 1}
    for v in found.values(): v['forms'] = [f for f in v['forms'] if f not in shared]
    return found

def trim_people(text, event, own=(), protect=(), extra=''):
    # The locked signature, like mask_classmates: (text with every surname form turned to its first name, the map).
    found = people_in(text, event, own, protect, extra)
    return relabel(text, found), found

def trim_event(event, trimmed):
    # The event's words a prompt carries (title, the invitees), by first name; never written back to event.json.
    if not trimmed: return event
    return {**event, **{k: relabel(str(event[k]), trimmed) for k in ('title', 'with', 'names', 'attendees') if event.get(k)}}

# ---------- the user's typed notes (loggie-meetings-tab) ----------
# my-notes.md is what the user typed on the Notes & Meetings tab, during or after the call. It feeds the cloud summary,
# so it goes through the same screen as the transcript, one line a turn, into outbound-notes.md + held-notes.json.
# Empty notes leave no pair (an old pair is removed), so nothing of them can be sent.
NOTES_FILE, NOTES_OUT, NOTES_HELD = 'my-notes.md', 'outbound-notes.md', 'held-notes.json'

def notes_pair(folder):
    # The screened notes when they are newer than my-notes.md, else None.
    folder = Path(folder).resolve()
    src, out, held = folder / NOTES_FILE, folder / NOTES_OUT, folder / NOTES_HELD
    if not src.exists() or not out.exists() or not held.exists() or out.stat().st_mtime < src.stat().st_mtime: return None
    return out, held

def screen_notes(folder, classmates=None, trimmed=None):
    # (outbound-notes.md, held-notes.json) or None when there are no notes. `classmates`: a class call's map (held.json
    # "names"): the typed notes go out relabeled with it, and held-notes.json keeps the same map. `trimmed`: a trimmed
    # call's map (held.json "trimmed"), the same way under "trimmed".
    folder = Path(folder).resolve()
    src = folder / NOTES_FILE
    text = src.read_text() if src.exists() else ''
    lines = [' '.join(l.split()) for l in text.splitlines() if l.strip()]
    if not lines:
        for name in (NOTES_OUT, NOTES_HELD): (folder / name).unlink(missing_ok=True)
        return None
    fresh = notes_pair(folder)
    if fresh:
        record = json.loads(fresh[1].read_text())
        if (classmates is None or record.get('names') == classmates) and (trimmed is None or record.get('trimmed') == trimmed): return fresh
    event = summary.event_of(folder) if (folder / 'event.json').exists() else {}
    names = {**summary.names_for(event), 'people': people_of(event)}
    who = names.get('me') or 'Me'
    turns = [{'t': 0, 'stamp': '00:00', 'who': who, 'sentences': summary.sentences(line)} for line in lines]
    outbound, record = screen(['# My notes'], turns, {**names, 'trim': trimmed is not None})
    if classmates is not None:
        outbound = relabel(outbound, classmates)
        record['lines'] = [{**l, 'text': relabel(l['text'], classmates)} if l['status'] == 'sent' else l for l in record['lines']]
        record['names'] = classmates
    if trimmed is not None:
        outbound = relabel(outbound, trimmed)
        record['lines'] = [{**l, 'text': relabel(l['text'], trimmed)} if l['status'] == 'sent' else l for l in record['lines']]
        record['trimmed'] = trimmed
    out, held = folder / NOTES_OUT, folder / NOTES_HELD
    out.write_text(outbound)
    held.write_text(json.dumps({'created': datetime.now().astimezone().isoformat(timespec='seconds'), 'source': 'notes', 'notes': NOTES_FILE, 'outbound': out.name, **record}, indent=1, ensure_ascii=False))
    return out, held

def notes_lines(outbound_text):
    # The screened notes as plain lines for a prompt: no header, no screen note, no stamp or name.
    out = []
    for para in re.split(r'\n\s*\n', outbound_text.strip()):
        m = LINE.match(para.strip())
        if m: out.append(m.group(4).strip())
    return out

# ---------- the pages tucked into the call (loggie-pause-attach) ----------
# What the user dropped on the recording card or picked from its fusen tab (pages.py reads them, capped at 6,000 words).
# The same screen as the typed notes, a paragraph a turn, into outbound-pages.md + held-pages.json. A page goes out as
# "Page N", never by its file name, which can name a person. No pages leave no pair (an old pair is removed).
PAGES_OUT, PAGES_HELD = 'outbound-pages.md', 'held-pages.json'

def pages_home(folder):
    # The call folder that holds pages/: the folder itself, or the call a version folder (v2-check, v3-nvidia) sits in.
    folder = Path(folder).resolve()
    return folder.parent if re.match(r'v\d+-', folder.name) and not (folder / 'pages').is_dir() else folder

def pages_pair(folder):
    # The screened pages when they are newer than every page, else None.
    folder = Path(folder).resolve()
    out, held, d = folder / PAGES_OUT, folder / PAGES_HELD, pages_home(folder) / 'pages'
    files = [f for f in d.iterdir() if f.is_file()] if d.is_dir() else []
    if not files or not out.exists() or not held.exists() or out.stat().st_mtime < max(f.stat().st_mtime for f in files): return None
    return out, held

def screen_pages(folder, classmates=None, trimmed=None):
    # (outbound-pages.md, held-pages.json) or None when no page has words. `classmates` and `trimmed` as screen_notes.
    import pages
    folder = Path(folder).resolve()
    found = pages.capped(pages.pages_of(pages_home(folder)))
    if not found:
        for name in (PAGES_OUT, PAGES_HELD): (folder / name).unlink(missing_ok=True)
        return None
    fresh = pages_pair(folder)
    if fresh:
        record = json.loads(fresh[1].read_text())
        if (classmates is None or record.get('names') == classmates) and (trimmed is None or record.get('trimmed') == trimmed): return fresh
    event = summary.event_of(folder) if (folder / 'event.json').exists() else {}
    names = {**summary.names_for(event), 'people': people_of(event)}
    turns = [{'t': 0, 'stamp': '00:00', 'who': f'Page {i}', 'sentences': summary.sentences(para)}
             for i, (_, text) in enumerate(found, 1) for para in (' '.join(p.split()) for p in re.split(r'\n\s*\n', text)) if para]
    outbound, record = screen(['# Pages'], turns, {**names, 'trim': trimmed is not None})
    for key, label_map in (('names', classmates), ('trimmed', trimmed)):
        if label_map is None: continue
        outbound = relabel(outbound, label_map)
        record['lines'] = [{**l, 'text': relabel(l['text'], label_map)} if l['status'] == 'sent' else l for l in record['lines']]
        record[key] = label_map
    out, held = folder / PAGES_OUT, folder / PAGES_HELD
    out.write_text(outbound)
    held.write_text(json.dumps({'created': datetime.now().astimezone().isoformat(timespec='seconds'), 'source': 'pages', 'pages': [n for n, _ in found], 'outbound': out.name, **record}, indent=1, ensure_ascii=False))
    return out, held

def pages_lines(outbound_text):
    # The screened pages for a prompt: [(Page N, paragraph)], no header, no screen note, no stamp.
    out = []
    for para in re.split(r'\n\s*\n', outbound_text.strip()):
        m = LINE.match(para.strip())
        if m: out.append((m.group(3).strip(), m.group(4).strip()))
    return out

# ---------- email threads (spec-entry-b, increment b#2) ----------
# The same screen on an email thread before next_move sends it to the cloud. Input is Loggie's THREAD.md
# (workstreams.js:272): "# subject", then per message "## From · ISO", "To: ...", the body, then attachment and link
# lists. Why a cut comes before the screen: a confidentiality notice is a confidential hit, and a confidential hit holds
# its whole turn (TURN_WIDE), so a footer left in would hold every message that carries one. Order per message:
#   1. To:/Cc: lines, the attachment list and the link list are left out (spec decision 11): counted, never written.
#   2. Quoted older replies ("On ... wrote:", Outlook's header block, "> " lines) are cut: the thread already has those
#      messages, and a quote would carry a line into a second message.
#   3. The footer is cut: from the sign-off ("Best,") when only a signature follows it, or from the first mail-client
#      line, "--" delimiter, legal notice or unsubscribe block, to the end. A P.S. after the sign-off stays.
#   4. Addresses, links and phone numbers left inside a sentence become "[address kept on this Mac]" (and link, phone),
#      so the sentence that carries the ask still goes.
# Cut blocks are listed in HELD.json as {i: null, layer: code, category: confidential, rule: footer|quoted}; they are
# never screened, never in a prompt, never in OUTBOUND.md. The rest goes through the same screen, sentence by
# sentence, with the subject as one more line. A legal notice the cut does not recognize stays a confidential hit and
# holds its message whole: an unknown footer fails closed.
#   python3 privacy.py --thread <THREAD.md> [--out DIR] [--me NAME]
SENDER = re.compile(r'^## (.+?) ·(?: (\d{4}-\d\d-\d\d[T ][\d:.]+(?:Z|[+-]\d\d:?\d\d)?))?$')
ADDRESSEE = re.compile(r'(?i)^(?:to|cc|bcc|reply-to):')
LIST_HEAD = re.compile(r'^(?:(Attachments) \(hikyaku|(Links) in this email \(hikyaku)')
EMAIL = re.compile(r'[\w.+-]+@[\w-]+(?:\.[\w-]+)+')
URL_IN = re.compile(r'(?i)\b(?:https?://|www\.)[^\s<>"\')\]]*[^\s<>"\')\].,;:!?]')
PHONE = re.compile(r'(?<![\w/])(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\w/])')
CLIENT = re.compile(r'(?i)^(?:sent from my\b|sent via\b|sent from (?:outlook|mail|yahoo mail|gmail)\b|get outlook for\b|download outlook\b)')
NOTICE = re.compile(r'(?i)^(?:confidentiality notice|confidentiality|disclaimer|legal notice|important notice|privileged (?:and|&) confidential)\s*[:.-]')
LEGAL = re.compile(r'(?i)\bintended recipient\b|\bnotify the sender\b|\b(?:received|got) this (?:e-?mail|message|communication) in error\b|\bintended (?:solely|only) for (?:the )?(?:use|addressee|person|individual|recipient)'
                   r'|\bany (?:review|use|dissemination|distribution|disclosure|copying)\b[^.]{0,60}\b(?:prohibited|forbidden)\b')
UNSUB = re.compile(r'(?i)\bunsubscribe\b|\byou (?:are|were) receiving this\b|\byou received this (?:e-?mail|message) because\b|\bmanage (?:your )?(?:e-?mail |notification )?(?:preferences|subscriptions)\b'
                   r'|\bupdate your (?:e-?mail )?preferences\b|\bview (?:this e-?mail |it )?in (?:your |a )?browser\b|\bno longer wish to receive\b')
PS = re.compile(r'(?i)^p\.?\s?s\.?\s*[:,-]?\s')
SIG_LINES, SIG_WORDS = 8, 12   # a signature after the sign-off: at most 8 lines of at most 12 words (name, title, school, phone)

def display_name(sender):
    # "Lena Ortiz <lena@x>" -> "Lena Ortiz". A bare address has no name to keep, and the address never crosses.
    name = re.sub(r'<[^>]*>', '', sender).strip().strip('"\'').strip()
    return name if name and not EMAIL.search(name) and name != 'unknown' else 'unknown sender'

def footer_start(lines):
    # Index of the first footer line, or len(lines). Hard starts: "--", a mail-client line, a notice heading, or the
    # paragraph holding a legal or unsubscribe phrase. A sign-off line starts the footer earlier when only a short
    # signature (and P.S. lines) sits between it and the hard start.
    hard = len(lines)
    for i, line in enumerate(lines):
        s = line.strip()
        if s == '--' or CLIENT.match(s) or NOTICE.match(s): hard = i; break
        if LEGAL.search(s) or UNSUB.search(s):
            while i > 0 and lines[i - 1].strip(): i -= 1
            hard = i; break
    content = [i for i, l in enumerate(lines[:hard]) if l.strip()]
    for i in content[1:]:
        if lexicon.SIGNOFF.match(lines[i].strip()):
            sig = [l.strip() for l in lines[i + 1:hard] if l.strip() and not PS.match(l.strip())]
            if len(sig) <= SIG_LINES and all(len(l.split()) <= SIG_WORDS for l in sig): return i
    return hard

def clean_body(lines):
    # One message's lines after its "## From · ISO" line -> (paragraphs of kept text, removed blocks, left_out counts).
    left = {'addressees': 0, 'attachments': 0, 'links': 0, 'addresses': 0, 'phones': 0}
    kept, i = [], 0
    while i < len(lines):
        s = lines[i].strip()
        head = LIST_HEAD.match(s)
        if ADDRESSEE.match(s) and not any(l.strip() for l in kept):
            left['addressees'] += len(EMAIL.findall(s)) or 1
        elif head:
            while i + 1 < len(lines) and lines[i + 1].startswith('- '):
                i += 1; left['attachments' if head.group(1) else 'links'] += 1
        else: kept.append(lines[i])
        i += 1
    removed = []
    text = '\n'.join(kept)
    m = lexicon.QUOTE.search(text)
    quoted = [text[m.start():].strip()] if m else []
    lines = text[:m.start()].split('\n') if m else kept
    quoted += [l for l in lines if l.lstrip().startswith('>')]
    lines = [l for l in lines if not l.lstrip().startswith('>')]
    if quoted: removed.append({'rule': 'quoted', 'text': '\n'.join(quoted).strip()})
    cut = footer_start(lines)
    tail = lines[cut:]
    ps = [l for l in tail if PS.match(l.strip())] if cut < len(lines) and lexicon.SIGNOFF.match(lines[cut].strip()) else []
    if any(l.strip() for l in tail): removed.append({'rule': 'footer', 'text': '\n'.join(l for l in tail if l not in ps).strip()})
    paras = []
    for para in re.split(r'\n\s*\n', '\n'.join(lines[:cut] + [''] + ps)):
        # a bullet or numbered line starts its own block, so a list of asks is not one long "sentence"
        for block in re.split(r'\n(?=\s*(?:[-*•]|\d+[.)])\s)', para):
            block = ' '.join(block.split())
            if not block: continue
            block, n = URL_IN.subn(MARK.format('link'), block); left['links'] += n
            block, n = EMAIL.subn(MARK.format('address'), block); left['addresses'] += n
            block, n = PHONE.subn(MARK.format('phone'), block); left['phones'] += n
            paras.append(block)
    return paras, removed, left

def parse_thread_md(text):
    # THREAD.md -> (subject, turns): one turn per message, stamp = the message ISO, who = the sender's display name,
    # sentences of the body only. Each turn also carries `paras` (paragraph of each sentence), `removed` and `left_out`.
    # Header paragraphs other than the subject (a chat's participant list names handles) are not kept.
    lines = text.replace('\r', '').split('\n')
    subject = next((l[2:].strip() for l in lines if l.startswith('# ')), '')
    turns, starts = [], [i for i, l in enumerate(lines) if SENDER.match(l.strip())]
    for k, a in enumerate(starts):
        m = SENDER.match(lines[a].strip())
        paras, removed, left = clean_body(lines[a + 1:starts[k + 1] if k + 1 < len(starts) else len(lines)])
        sentences, where = [], []
        for pi, para in enumerate(paras):
            for s in summary.sentences(para): sentences.append(s); where.append(pi)
        turns.append({'t': None, 'stamp': m.group(2) or '', 'who': display_name(m.group(1)), 'sentences': sentences, 'paras': where, 'removed': removed, 'left_out': left})
    return subject, turns

def screen_thread(subject, turns, names):
    # The call screen on a parsed thread. The subject is turn 0 ("Subject", stamped with the first message's time).
    # Returns (OUTBOUND.md text, record).
    all_turns = [{'stamp': turns[0]['stamp'] if turns else '', 'who': 'Subject', 'sentences': [subject] if subject.strip() else [], 'paras': [0]}] + turns
    rows = flatten(all_turns)
    held = judge(rows, names)
    out = [f"# {marked([r for r in rows if r['turn'] == 0], held)}".rstrip()]
    for ti, turn in enumerate(all_turns[1:], 1):
        mine = [r for r in rows if r['turn'] == ti]
        body = [marked([r for r in mine if turn['paras'][r['k']] == p], held) for p in dict.fromkeys(turn['paras'])]
        out.append('\n\n'.join([f"## {turn['who']} · {turn['stamp']}".rstrip()] + body))
    held_rows, counts = tally(rows, all_turns, held)
    cut = [{'i': None, 'time': t['stamp'], 'speaker': t['who'], 'category': 'confidential', 'layer': 'code', 'rule': b['rule'], 'text': b['text']} for t in turns for b in t['removed']]
    counts['removed'] = {rule: sum(1 for b in cut if b['rule'] == rule) for rule in ('footer', 'quoted')}
    left_out = {k: sum(t['left_out'][k] for t in turns) for k in (turns[0]['left_out'] if turns else {})}
    note = note_of(counts, 'HELD.json', 'footers, quoted replies, addresses, links and attachments left out; ')
    outbound = '\n\n'.join(out[:1] + [note] + out[1:]) + '\n'
    return outbound, {'source': 'thread', 'screened_by': 'code', 'model_layer': CODE_ONLY, 'counts': counts, 'left_out': left_out,
                      'held': held_rows + cut, 'lines': lines_of(rows, held)}

def screen_thread_file(path, out=None, me=None, quiet=False):
    # The command: read THREAD.md, screen, write OUTBOUND.md + HELD.json beside it (or in `out`), as a new pair.
    path = Path(path).resolve()
    if not path.exists(): sys.exit(f'no {path}')
    subject, turns = parse_thread_md(path.read_text())
    if not turns: sys.exit(f'{path} has no "## From · ISO" messages')
    t0 = time.time()
    outbound, record = screen_thread(subject, turns, {'me': me, 'people': sorted({t['who'] for t in turns if t['who'] != me and t['who'] != 'unknown sender'})})
    folder = Path(out).resolve() if out else path.parent
    folder.mkdir(parents=True, exist_ok=True)
    out_md, out_json = free_pair(folder, ('OUTBOUND.md', 'HELD.json'))
    record = {'created': datetime.now().astimezone().isoformat(timespec='seconds'), 'source': 'thread', 'thread': path.name, 'outbound': out_md.name,
              'seconds': round(time.time() - t0, 1), **record}
    out_md.write_text(outbound)
    out_json.write_text(json.dumps(record, indent=1, ensure_ascii=False))
    c = record['counts']
    if not quiet:
        print(f"{out_md.name}: {c['sent']} of {c['sentences']} sentences go out, {c['held']} held by code, "
              f"{c['removed']['footer']} footers and {c['removed']['quoted']} quoted replies cut, in {record['seconds']}s; {out_json.name} lists them.")
    return out_md, out_json, record

# ---------- the eval ----------

def eval_cases(path, out=print):
    # fixtures/privacy-cases.json: cases of turns of labeled sentences. Each case is screened on its own (its own
    # context, no bleed from the case before). Prints leaked sensitive sentences (bound 0), ordinary held (bound 10%)
    # and per-category rows. Returns True when both bounds hold.
    cases = json.loads(Path(path).read_text())
    names = {'me': 'Me', 'other': 'the other person'}
    results = []
    t0 = time.time()
    for case in cases:
        turns, t = [], 0
        for turn in case['turns']:
            turns.append({'t': t, 'stamp': transcript.stamp(t), 'who': turn['who'], 'sentences': [s['text'] for s in turn['sentences']]})
            t += 10
        labels = [s.get('label', 'ordinary') for turn in case['turns'] for s in turn['sentences']]
        _, record = screen([], turns, names)
        held = {h['i']: h for h in record['held']}
        for r, label in zip(flatten(turns), labels):
            h = held.get(r['i'])
            results.append({'case': case['id'], 'text': r['text'], 'label': label, 'held': bool(h), 'layer': h['layer'] if h else 'sent', 'category': h['category'] if h else 'none', 'rule': h['rule'] if h else ''})
    sensitive = [r for r in results if r['label'] != 'ordinary']
    ordinary = [r for r in results if r['label'] == 'ordinary']
    leaked = [r for r in sensitive if not r['held']]
    over = [r for r in ordinary if r['held']]
    out(f"privacy eval: {len(cases)} cases, {len(results)} sentences ({len(sensitive)} sensitive, {len(ordinary)} ordinary), code only, {round(time.time() - t0, 1)}s")
    out(f"{'category':14} {'n':>3} {'held':>5} {'leaked':>7}")
    for cat in list(CATEGORIES) + ['ordinary']:
        rows = [r for r in results if r['label'] == cat]
        if not rows: continue
        out(f"{cat:14} {len(rows):>3} {sum(r['held'] for r in rows):>5} {sum(not r['held'] for r in rows) if cat != 'ordinary' else '-':>7}")
    out(f"sensitive leaked: {len(leaked)} (bound 0)")
    for r in leaked: out(f"  LEAKED [{r['label']}] {r['case']}: {r['text']}")
    share = len(over) / len(ordinary) if ordinary else 0
    out(f"ordinary held: {len(over)} of {len(ordinary)} = {share:.0%} (bound 10%)")
    for r in over: out(f"  held [{r['layer']}:{r['category']}] {r['case']}: {r['text']}")
    ok = not leaked and share <= 0.10
    out('PASS' if ok else 'FAIL')
    return ok

if __name__ == '__main__':
    args = sys.argv[1:]
    def opt(name, default):
        return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else default
    if '--eval' in args:
        sys.exit(0 if eval_cases(opt('--eval', None) or sys.exit('usage: privacy.py --eval fixtures/privacy-cases.json')) else 1)
    if '--thread' in args:
        screen_thread_file(opt('--thread', None) or sys.exit('usage: privacy.py --thread <THREAD.md> [--out DIR] [--me NAME]'), out=opt('--out', None), me=opt('--me', None))
        sys.exit(0)
    if len(args) != 1 or args[0].startswith('--'): sys.exit('usage: privacy.py <version-folder>  |  privacy.py --eval fixtures/privacy-cases.json  |  privacy.py --thread <THREAD.md> [--out DIR] [--me NAME]')
    screen_folder(args[0])
