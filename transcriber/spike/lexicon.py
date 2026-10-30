#!/usr/bin/env python3
# The per-call name list ("lexicon") that increment 3 of proposal-c.md boosts into Nemotron 3.5 ASR before it listens.
#   build(call_folder) -> dict                the list, from code (live.py builds it once when a call starts)
#   write(call_folder, data) -> path          <call-folder>/lexicon.json (never overwritten: lexicon-2.json, lexicon-3.json ...)
#
# Why this shape. The local NVIDIA models hear without context: Gio came out "Jill" and "Geo" on the Priya call
# (2026-10-07). Word boosting fixes that only when the list is short and every word on it was TYPED by a person:
# measured 2026-10-06, a 40-term course list planted student names, score 3 planted "Intel" 644 times, and only a short
# list at score 1.0 helped (8 of 12 names, 0 insertions). So every entry here comes from something somebody wrote
# (the invite, the mail thread with the invitees, the user's own settings), never from a model's guess, and the list
# is capped at CAP entries. The engine (nvidia_engine.py, Jaw's file) decides the score; this file only decides the words.
#
# Sources, in rank order, each entry tagged:
#   own       the user's name: event.json "me", Loggie's settings.json signName, profile.md ("The user is X"), and the
#             display name the user put on their own sent mail (Apple Mail's From header: typed once, at account setup).
#             Neither settings.json nor profile.md holds a full name today (checked 2026-10-07), the From name does.
#   invitee   event.json names/attendees: the full name and the first name (what people say on a call).
#   own-terms words the user capitalized in the SUBJECTS of their own sent mail, last DAYS days, in at least OWN_MIN
#             threads: product and project names ("Loggie" came out "Loggy" on the Jess call, 2026-10-07, because it
#             was on no list; spec-entry-b.md A row 5). Subjects only, read from Mail's index, no body opened. Single
#             words; acronyms stay in the terms experiment. A word is ordinary, and dropped, when it is in STOP or
#             OWN_STOP, when it or its plain stem ("Updates" -> update) is in /usr/share/dict/words in lowercase (this
#             also drops a subject's first word when it is grammar: "Quick question"), or when the user also wrote it
#             in lowercase in a sent subject ("Loggie demo" makes "Demo" ordinary). Not a person: nvidia_engine.PEOPLE
#             is own and invitee only, so a product name is never offered as "(unclear; likely Loggie)". Never a
#             person: a part of the user's own name, or a word of any display name in Mail's address index (the
#             From/To/Cc names it already holds), is dropped ("Caballero", "Maria" on the 2026-10-08 live run).
#             Last in rank, leftover slots only, at most OWN_CAP: that run let them push the title's Nebius and NVIDIA
#             off the list.
#   title     capitalized words of the invite title, minus course codes (a course term list is on the kill list) and
#             the user's and invitees' names. This is the only source a class call has besides "own": its event.json
#             carries no emails (call.py drops names when the invite has more than MAX_NAMED people).
#   mail      proper nouns in the mail with the invitees, last DAYS days, read-only from Apple Mail's own index and
#             .emlx files. Only the text the people wrote themselves: quoted history, signature blocks and mail-client
#             boilerplate are cut first. Messages a third party sent to a crowd that happens to include the invitee
#             (a club mailing with 64 recipients on Priya's address) are skipped: MAX_RECIPIENTS.
#   past-call the lexicon.json files of earlier calls with the same invitee address, written sources only (an allowlist
#             of source tags; anything a model made never crosses from one call to the next).
#   terms     EXPERIMENT behind --with-terms, off by default: acronyms and capitalized multi-word terms the user typed
#             at least TERM_MIN times across at least TERM_THREADS threads of their own sent mail. Reported in full
#             under "terms_found" so the output can be judged; dropped from the product if it is not clean.
#
# Rank: own, invitees, title (in title order), mail, past-call (each by how often, then how recently, they were written),
# then own-terms and terms last (they are general to the user, not to this call, so they never push a call's word over
# the cap). Common English words
# are dropped: a word that is in /usr/share/dict/words in lowercase and was never written capitalized mid-sentence is
# not a name ("Hope you're well" vs "I'm in Breazzano now"). Deduplicated case-insensitively. Nothing heard on a call
# (a transcript, a model's word) is ever read here.
#
# Privacy: mail is opened read-only (sqlite mode=ro, files only read); no message body is read beyond the invitees'
# threads, and the user's own sent mail only with --with-terms; no mail body is ever printed or written, only the extracted
# entries. The subjects of the user's sent mail are read for own-terms (subjects only); their bodies only with
# --with-terms. Nothing in a call folder is overwritten.
import email, email.policy, html, json, os, re, sqlite3, sys, time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse

SUPPORT = Path(os.environ.get('LOGGIE_HIKYAKU_HOME') or Path.home() / 'Library' / 'Application Support' / 'Loggie' / 'hikyaku')
CALLS = SUPPORT / 'calls'
SETTINGS = SUPPORT / 'settings.json'   # Loggie's; read, never written here
PROFILE = SUPPORT / 'profile.md'
MAIL = Path.home() / 'Library' / 'Mail' / 'V10'
DICT = Path('/usr/share/dict/words')

CAP = 12            # the measured ceiling: 12 names at score 1.0 helped, 40 terms planted names (2026-10-06)
DAYS = 90           # how far back the mail with the invitees is read
MAX_RECIPIENTS = 8  # same idea as call.py MAX_NAMED: a message to more people than this is a mailing, not a conversation
TERM_MIN = 3        # --with-terms: typed at least this often ...
TERM_THREADS = 2    # ... across at least this many threads
OWN_MIN = 2         # own-terms: in the subjects of at least this many of the user's sent threads (a Re: chain is one)
OWN_CAP = 3         # own-terms: at most this many per call, and only in slots the call's own words left free
MY_WORDS_CAP = 4    # my-words: at most this many per call, inside CAP
WRITTEN = {'own', 'invitee', 'my-words', 'title', 'mail', 'past-call', 'terms', 'own-terms'}   # the only source tags a past call may hand on

COURSE = re.compile(r'\b[A-Z]{2,4}\s?\d{4}\b')   # same as call.py: a course code marks a class
SENT_BOXES = {'Sent Items', 'Sent Mail', 'Sent', 'Sent Messages'}
SKIP_BOXES = {'Drafts', 'Junk Email', 'Junk', 'Spam', 'Trash', 'Deleted Items', 'Deleted Messages', 'Outbox'}
# Words that start lines in mail and are capitalized for that reason only, plus calendar words. Not names, whatever
# the dictionary says ("okay", "cornell" are not in /usr/share/dict/words; "Okay" still is not a name).
STOP = {'hi', 'hello', 'hey', 'dear', 'thanks', 'thank', 'best', 'regards', 'cheers', 'sincerely', 'ok', 'okay', 'yes',
        'no', 'sure', 'sorry', 'great', 'awesome', 'perfect', 'sounds', 'please', 'also', 'again', 'kind', 'warm',
        'all', 'looking', 'forward', 'see', 'talk', 'take', 'care', 'welcome', 'congrats', 'congratulations',
        're', 'fw', 'fwd', 'i', 'mr', 'ms', 'mrs', 'dr', 'prof', 'et', 'al',
        'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march',
        'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
        'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept',
        'oct', 'nov', 'dec', 'today', 'tomorrow', 'tonight', 'zoom', 'teams', 'link', 'subject', 'from', 'to', 'cc',
        'accepted', 'declined', 'tentative', 'invitation', 'canceled', 'cancelled', 'updated', 'reminder', 'meeting', 'call'}
# Sentence openers that are capitalized for grammar alone. One of these at a sentence start stands by itself and never
# joins the run after it ("The MBA PM club" -> The | MBA PM). Any other first word may ("Gio Caballero", "Capital IQ"):
# "gio", "capital" and "dell" are all in /usr/share/dict/words, so the dictionary alone cannot tell them from "The".
FIRST = {'the', 'a', 'an', 'this', 'that', 'these', 'those', 'our', 'your', 'my', 'his', 'her', 'their', 'its', 'we', 'you',
         'they', 'he', 'she', 'it', 'if', 'when', 'as', 'at', 'in', 'on', 'for', 'to', 'with', 'and', 'but', 'or', 'so',
         'here', 'there', 'let', 'could', 'would', 'should', 'can', 'will', 'do', 'does', 'did', 'is', 'are', 'was', 'were',
         'have', 'has', 'had', 'how', 'what', 'which', 'who', 'where', 'why', 'hope', 'just', 'not', 'happy', 'glad', 'good',
         'nice', 'meet', 'join', 'send', 'check', 'find', 'get', 'give', 'make', 'come', 'go', 'look', 'read', 'run', 'try',
         'use', 'want', 'need', 'know', 'think', 'feel', 'ask', 'tell', 'say', 'note', 'attached', 'following', 'per',
         'regarding', 'from', 'by', 'of', 'after', 'before', 'during', 'once', 'then', 'now', 'still', 'otherwise', 'however',
         'unfortunately', 'fortunately', 'hopefully', 'thankfully', 'maybe', 'perhaps', 'absolutely', 'definitely', 'really',
         'quick', 'one', 'two', 'first', 'second', 'last', 'next', 'more', 'most', 'some', 'any', 'each', 'every', 'both',
         'either', 'neither', 'no', 'yes', 'well', 'anyway', 'also', 'thanks', 'thank', 'sorry', 'excited', 'looking', 'wanted',
         'wondering', 'wish', 'had', 'got', 'been', 'being', 'am', 'me', 'us', 'him', 'them', 'who', 'whom', 'done', 'ready',
         'sure', 'right', 'sounds', 'seems', 'feel', 'free', 'open', 'happy', 'pleased', 'apologies', 'apologize', 'confirmed',
         'confirming', 'attaching', 'sharing', 'sending', 'following', 'per', 'since', 'because', 'while', 'though', 'although'}
SIGNOFF = re.compile(r'^\s*(best( regards| wishes)?|(kind|warm|many) (regards|thanks)|regards|thanks( again| so much)?|thank you'
                     r'( (so much|again))?|cheers|sincerely|talk soon|all the best|take care|warmly|respectfully|much appreciated)'
                     r'\s*[,!.]?\s*$', re.I)
BOILER = re.compile(r'^\s*(get outlook for|sent from my|sent via|download outlook|this email (and any|was sent)|confidentiality notice)', re.I)
# Where quoted history starts: Outlook's rule, the "On ... wrote:" line (may wrap), the Outlook header block (English
# and localized: Priya's client writes 寄件者), the "Original Message" bar. Everything from the first match on is cut.
QUOTE = re.compile(r'^(_{8,}\s*$|-{2,}\s*Original Message\s*-{2,}|On\b[^\n]{0,200}(\n[^\n]{0,120})?wrote:\s*$'
                   r'|From:[^\n]+\n(Sent|Date):|(寄件者|差出人|发件人|De|Von|Da)\s*[:：])', re.M)
TOKEN = re.compile(r"[A-Za-z][A-Za-z'’\-&.]*")
CLOCK = re.compile(r'\b\d{1,2}(:\d{2})?\s?[AaPp]\.?[Mm]\.?\b')   # "3 PM" is a time; "PM" alone is a job (Gio's)
ACRONYM = re.compile(r"^[A-Z][A-Z&]{1,5}s?$")
PREFIX = re.compile(r'^((re|fw|fwd|aw|回覆|回复|返信)\s*[:：]\s*)+', re.I)   # reply and forward marks on a subject
# Everyday subject words newer than the 1934 dictionary in /usr/share/dict/words ("demo", "email" are not in it).
OWN_STOP = {'demo', 'demos', 'intro', 'intros', 'email', 'emails', 'fyi', 'followup', 'onboarding', 'webinar', 'online', 'app'}

# ---------- the written sources ----------

def settings(path=SETTINGS):
    try: return json.loads(path.read_text()) if path.exists() else {}
    except json.JSONDecodeError as error: sys.exit(f'{path} is not JSON: {error}')

def own_names(event, settings_path=SETTINGS, profile_path=PROFILE, mail_name=''):
    # The user's name as the user wrote it: event.json "me" first (call.py derived it from profile.md), then Loggie's
    # signName, then profile.md, then the From name on sent mail. Order matters only for the first entry.
    names = [event.get('me', '')]
    names.append(settings(settings_path).get('signName', ''))
    m = re.search(r'The user is ([A-Z][\w\-]+(?: [A-Z][\w\-]+)*)', profile_path.read_text() if profile_path.exists() else '')
    if m: names.append(m.group(1))
    if mail_name: names.append(mail_name)
    out = []
    for n in names:
        n = n.strip().rstrip(',.')
        if n and n.lower() != 'me' and n.lower() not in {o.lower() for o in out}: out.append(n)
    return out

def my_words(path=SUPPORT / 'my-words.txt'):
    # The user's own list, one word or phrase per line, in the order written (order is rank). A line starting with #
    # is a comment; blank lines and repeats (any case) are skipped.
    # A line may also say how the word was misheard: "Yiming: E Ming, Emin, Eming" (heard_as reads that part).
    out = []
    for line in (Path(path).read_text(encoding='utf-8', errors='replace').splitlines() if Path(path).exists() else []):
        w = re.sub(r'\s+', ' ', line.split(':', 1)[0]).strip()
        if w and not w.startswith('#') and w.lower() not in {o.lower() for o in out}: out.append(w)
    return out

def heard_as(path=SUPPORT / 'my-words.txt'):
    # The user's corrections: {"Yiming": ["E Ming", "Emin", "Eming"]} from "Yiming: E Ming, Emin, Eming". The speech
    # models did not hear "Yiming" even with it boosted (Hilton meeting, 2026-10-09), so the transcript puts the word
    # back wherever exactly one of these forms stands. Only forms the user wrote; no guessing by sound.
    out = {}
    for line in (Path(path).read_text(encoding='utf-8', errors='replace').splitlines() if Path(path).exists() else []):
        if line.strip().startswith('#') or ':' not in line: continue
        word, forms = (x.strip() for x in line.split(':', 1))
        forms = [f.strip() for f in forms.split(',') if f.strip() and f.strip().lower() != word.lower()]
        if word and forms: out[word] = forms
    return out

def invitee_names(event):
    # Full names and first names, in invite order. A single-word entry is both.
    out = []
    for full in [n.strip() for n in (event.get('names') or event.get('attendees') or '').split(',') if n.strip()]:
        first = full.split()[0]
        for n in ([full, first] if first.lower() != full.lower() else [full]):
            if n.lower() not in {o.lower() for o in out}: out.append(n)
    return out

def title_terms(event):
    # The invite title is a label, not prose: its capitals are not grammar, so every run counts (label=True).
    return [term for term, _ in candidate_runs(COURSE.sub(' ', event.get('title', '')), label=True)]

# ---------- Apple Mail, read-only ----------

class Mail:
    # Apple Mail's own index (sqlite, opened mode=ro) says which messages exist and where; the .emlx files hold them.
    # A message's file sits under <account>/<Mailbox>.mbox/<uuid>/Data/<ROWID without its last 3 digits, reversed, one
    # digit per folder>/Messages/<ROWID>.emlx (294424 -> Data/4/9/2/Messages/294424.emlx; verified 2026-10-07).
    def __init__(self, root=MAIL):
        self.root = Path(root); self.index = self.root / 'MailData' / 'Envelope Index'
        self.ok = self.index.exists()
        self.db = sqlite3.connect(f'file:{self.index}?mode=ro', uri=True) if self.ok else None
        self.unreadable = 0

    def boxes(self):
        if not hasattr(self, '_boxes'):
            self._boxes = {}
            for rowid, url in self.db.execute('select ROWID, url from mailboxes'):
                u = urlparse(url); parts = [unquote(p) for p in u.path.strip('/').split('/') if p]
                self._boxes[rowid] = (u.netloc, parts)
        return self._boxes

    def box_name(self, mailbox): return (self.boxes().get(mailbox, ('', ['']))[1] or [''])[-1]

    def sent_boxes(self): return [b for b, (acct, parts) in self.boxes().items() if parts and parts[-1] in SENT_BOXES]

    def user(self):
        # The user's own addresses and display name: whoever sent from a Sent mailbox at least 3 times.
        boxes = self.sent_boxes()
        if not boxes: return set(), ''
        q = f"select a.address, a.comment, count(*) n from messages m join addresses a on a.ROWID=m.sender where m.mailbox in ({','.join('?' * len(boxes))}) and m.deleted=0 group by a.ROWID order by n desc"
        rows = [(addr.lower(), comment, n) for addr, comment, n in self.db.execute(q, boxes) if n >= 3]
        addresses = {addr for addr, _, _ in rows}
        name = next((c for _, c, _ in rows if re.fullmatch(r'[A-Z][\w\-]+( [A-Z][\w\-]+)+', c)), '')   # "Gio Caballero", not "Caballero, Gio Albert" or "user01"
        return addresses, name

    def display_words(self):
        # Every word of every display name in Mail's address index (senders and recipients alike): the people the user
        # mails with, by name. Index only; no message is opened.
        out = set()
        for (comment,) in self.db.execute("select comment from addresses where comment is not null and comment != ''"):
            out |= {clean(t).lower() for t in re.findall(r"[A-Za-z][A-Za-z'’]*", comment) if len(clean(t)) > 1}
        return out

    def address_ids(self, emails):
        if not emails: return []
        q = f"select ROWID from addresses where lower(address) in ({','.join('?' * len(emails))})"
        return [r[0] for r in self.db.execute(q, [e.lower() for e in emails])]

    def _rows(self, where, params, since):
        q = ('select m.ROWID, m.message_id, m.conversation_id, m.mailbox, m.date_sent, lower(a.address), s.subject, '
             '(select count(*) from recipients r where r.message=m.ROWID) from messages m '
             'join addresses a on a.ROWID=m.sender left join subjects s on s.ROWID=m.subject '
             f'where m.deleted=0 and m.date_sent>=? and ({where}) order by m.date_sent')
        seen, out = set(), []
        for rowid, mid, conv, box, date, sender, subject, nrcpt in self.db.execute(q, [since, *params]):
            if self.box_name(box) in SKIP_BOXES: continue
            key = mid or (sender, date, subject)   # Mail keeps the same message under Inbox and All Mail
            if key in seen: continue
            seen.add(key); out.append({'rowid': rowid, 'thread': conv, 'mailbox': box, 'date': date, 'sender': sender, 'subject': subject or '', 'recipients': nrcpt})
        return out

    def with_people(self, emails, since, user_addresses):
        # From an invitee, or to an invitee from the user, or to an invitee from a third party in a small conversation.
        ids = self.address_ids(emails)
        if not ids: return []
        marks = ','.join('?' * len(ids))
        rows = self._rows(f'm.sender in ({marks}) or m.ROWID in (select message from recipients where address in ({marks}))', ids + ids, since)
        return [r for r in rows if r['sender'] in {e.lower() for e in emails} or r['sender'] in user_addresses or r['recipients'] <= MAX_RECIPIENTS]

    def sent(self, since):
        boxes = self.sent_boxes()
        if not boxes: return []
        return self._rows(f"m.mailbox in ({','.join('?' * len(boxes))})", boxes, since)

    def path(self, row):
        acct, parts = self.boxes().get(row['mailbox'], ('', []))
        if not acct: return None
        folder = self.root / acct
        for p in parts: folder = folder / f'{p}.mbox'
        digits = '/'.join(reversed(str(row['rowid'] // 1000))) if row['rowid'] >= 1000 else ''
        for name in (f"{row['rowid']}.emlx", f"{row['rowid']}.partial.emlx"):
            hits = list(folder.glob(f'*/Data/{digits}/Messages/{name}' if digits else f'*/Data/Messages/{name}'))
            if hits: return hits[0]
        return None

    def text(self, row):
        # The message's text, plain part preferred, HTML stripped to lines when that is all there is. Never printed.
        p = self.path(row)
        if not p: self.unreadable += 1; return ''
        try: return read_emlx(p)
        except Exception as error:
            self.unreadable += 1; print(f'lexicon: cannot read message {row["rowid"]}: {type(error).__name__}: {error}', file=sys.stderr); return ''

def read_emlx(path):
    raw = Path(path).read_bytes()
    nl = raw.index(b'\n'); n = int(raw[:nl].split()[0])   # first line: byte count of the RFC 822 message; a plist follows it
    msg = email.message_from_bytes(raw[nl + 1:nl + 1 + n], policy=email.policy.default)
    body = msg.get_body(preferencelist=('plain', 'html'))
    if body is None: return ''
    text = body.get_content()
    if body.get_content_type() == 'text/html': text = html_text(text)
    return text

def html_text(s):
    s = re.sub(r'(?is)<(script|style).*?</\1>', ' ', s)
    s = re.sub(r'(?i)<br\s*/?>|</(p|div|tr|li|h\d)>', '\n', s)
    s = re.sub(r'<[^>]+>', ' ', s)
    return html.unescape(s)

# ---------- the people's own words ----------

def own_text(text, user_names=()):
    # What the person typed in this message: cut quoted history, then the signature (the sign-off line keeps the one
    # name line after it, since someone typed that name; the title, school and phone lines below it are boilerplate),
    # mail-client ads, lines that are links, addresses or phone numbers, and quoted lines.
    m = QUOTE.search(text)
    if m: text = text[:m.start()]
    lines, out, sig = text.splitlines(), [], 0
    for line in lines:
        s = line.strip()
        if sig: break
        if s == '--' or BOILER.match(s): break
        if s.startswith('>'): continue
        if '@' in s or 'http' in s.lower() or re.search(r'(?i)\b(mobile|phone|tel|cell)\b\s*[:.]', s) or re.search(r'\+?\d[\d\s().-]{7,}\d', s): continue
        if SIGNOFF.match(s): sig = 1; continue
        if any(s.lower() == n.lower() for n in user_names): out.append(s); break   # the user's own signature block starts with their name
        out.append(s)
    if sig:
        rest = [l.strip() for l in lines[len(out) + 1:] if l.strip()]
        if rest and re.fullmatch(r"([A-Z][\w'’\-]+ ?){1,4}", rest[0]) and '@' not in rest[0]: out.append(rest[0])
    return '\n'.join(out)

def words(path=DICT):
    if not hasattr(words, '_set'):
        words._set = {w.strip() for w in path.read_text(errors='ignore').splitlines() if w.strip() and w.strip()[0].islower()} if path.exists() else set()
    return words._set

def clean(tok):
    tok = tok.strip(".'’-&")
    tok = re.sub(r"[’']s$", '', tok)
    return tok

def candidate_runs(text, label=False):
    # Every run of capitalized words (and acronyms) in the text, as (term, mid) where mid says the run started after
    # the first word of its sentence. Sentence starts are capitalized for grammar, not because the word is a name;
    # in a label (a subject, a title) every capital is deliberate, so label=True marks every run as mid. Dashes,
    # ampersands, bars and slashes between words end a run ("Priya & Gio - Coffee Chat" is three terms, not one).
    # A sentence's first word, when it is a grammar opener (FIRST: "The MBA PM club"), stands alone and never joins a run.
    runs = []
    for line in CLOCK.sub(' ', text).splitlines():
        for sentence in re.split(r'(?<=[.!?:;,])\s+|\s+[-–—&|/+]+\s+', line.strip()):
            toks = [clean(t) for t in TOKEN.findall(sentence)]
            toks = [t for t in toks if t]
            run, start = [], 0
            for i, t in enumerate(toks + ['']):
                is_cap = bool(t) and t[0].isupper() and t.lower() not in STOP and len(t) > 1 and not re.match(r"^I['’]", t)
                if is_cap and i == 0 and not label and t.lower() in FIRST:
                    runs.append((t, False)); continue
                if is_cap:
                    if not run: start = i
                    run.append(t)
                elif run:
                    runs.append((' '.join(run), label or start > 0)); run = []
    return runs

def is_common(term, mid):
    # Dropped when every word is an everyday lowercase dictionary word and the term was never written mid-sentence.
    # An acronym is never common. A single word only ever seen at a sentence start is not a name either ("Okay").
    parts = term.split()
    if any(ACRONYM.match(p) for p in parts): return ''
    if mid: return ''
    if all(p.lower() in words() for p in parts): return 'common word' if len(parts) == 1 else 'common words'
    if len(parts) == 1: return 'sentence start only'
    return ''

def count_terms(texts):
    # texts: [(text, date, thread, label)] -> {key: {'text','count','mid','last','threads'}}; label text (a subject)
    # counts once per thread, so a Re: Re: chain does not inflate it.
    found, labeled = {}, set()
    for text, date, thread, label in texts:
        if label:
            if thread in labeled: continue
            labeled.add(thread)
        for term, mid in candidate_runs(text, label=label):
            key = term.lower()
            f = found.setdefault(key, {'text': term, 'count': 0, 'mid': False, 'last': 0, 'threads': set()})
            f['count'] += 1; f['mid'] = f['mid'] or mid; f['last'] = max(f['last'], date); f['threads'].add(thread)
    return found

def dictionary_word(w):
    # In /usr/share/dict/words in lowercase, as is or by its plain stem: the 1934 list has "update" but not "updates".
    w, d = w.lower(), words()
    if w in d: return True
    for end, add in (('ies', 'y'), ('es', ''), ('s', ''), ('ed', ''), ('ed', 'e'), ('ing', ''), ('ing', 'e')):
        if w.endswith(end) and len(w) - len(end) >= 3 and w[:-len(end)] + add in d: return True
    return False

def own_subject_words(rows, min_threads=OWN_MIN, user_parts=(), people=()):
    # rows: [(subject, thread, date)] of the user's own sent mail -> (found, dropped). found: [{'text','count','last'}]
    # with count = the number of threads whose subject has the word. Only words that recur in min_threads threads are
    # judged; a recurring ordinary word or a name is reported in dropped so the output can be checked. user_parts: the
    # words of the user's own names; people: the words of the display names in the mail index (both lowercase).
    found, lower = {}, set()
    for subject, thread, date in rows:
        for t in re.findall(r"[A-Za-z][A-Za-z'’]*", COURSE.sub(' ', CLOCK.sub(' ', PREFIX.sub('', subject or '')))):
            t = clean(t)
            if not t: continue
            if t[0].islower(): lower.add(t.lower()); continue
            f = found.setdefault(t.lower(), {'text': t, 'threads': set(), 'last': 0})
            f['threads'].add(thread); f['last'] = max(f['last'], date or 0)
    out, dropped = [], []
    for key, f in found.items():
        if len(f['threads']) < min_threads: continue
        t = f['text']
        if len(t) < 2 or t.isupper() or "'" in t or '’' in t: why = ''   # acronyms (terms experiment), "I", "Can't": silently not words
        elif key in user_parts: why = "part of the user's name"
        elif key in people: why = 'a name in mail headers'
        elif key in STOP or key in FIRST or key in OWN_STOP or dictionary_word(t): why = 'common word'
        elif key in lower: why = 'also written lowercase in a sent subject'
        else:
            out.append({'text': t, 'count': len(f['threads']), 'last': f['last']}); continue
        if why: dropped.append({'text': t, 'source': 'own-terms', 'reason': why})
    out.sort(key=lambda x: (-x['count'], -x['last'], x['text'].lower()))
    return out, dropped

def mentions(name, texts):
    return sum(len(re.findall(r'(?<![\w])' + re.escape(name) + r'(?![\w])', t[0], re.I)) for t in texts)

# ---------- past calls ----------

def past_calls(emails, calls_root, current):
    # Lexicons of earlier calls with any of the same invitee addresses. Written sources only: a source tag outside the
    # WRITTEN allowlist (a model's guess, an unknown tag) never crosses into this call. Returns (entries, dropped, folders).
    entries, dropped, folders = [], [], []
    wanted = {e.lower() for e in emails}
    if not wanted or not Path(calls_root).exists(): return entries, dropped, folders
    for folder in sorted(Path(calls_root).iterdir()):
        if folder.resolve() == Path(current).resolve() or not (folder / 'event.json').exists(): continue
        try: ev = json.loads((folder / 'event.json').read_text())
        except Exception: continue
        if not wanted & {e.lower() for e in ev.get('emails', [])}: continue
        for lex in sorted(folder.glob('lexicon*.json')):
            try: data = json.loads(lex.read_text())
            except Exception: continue
            folders.append(f'{folder.name}/{lex.name}')
            built = data.get('built', '')
            try: when = datetime.fromisoformat(built).timestamp()
            except Exception: when = lex.stat().st_mtime
            for e in data.get('entries', []):
                if e.get('source') in WRITTEN: entries.append({'text': e['text'], 'count': int(e.get('count', 1)), 'last': when, 'from': folder.name})
                else: dropped.append({'text': e.get('text', ''), 'source': 'past-call', 'reason': f"not a written source ({e.get('source', '?')}) in {folder.name}"})
    return entries, dropped, folders

# ---------- build ----------

def build(call_folder, with_terms=False, mail_root=MAIL, calls_root=CALLS, settings_path=SETTINGS, profile_path=PROFILE, my_words_path=SUPPORT / 'my-words.txt', now=None, cap=CAP):
    folder = Path(call_folder)
    if not (folder / 'event.json').exists(): sys.exit(f'not a call folder (no event.json): {folder}')
    event = json.loads((folder / 'event.json').read_text())
    now = now or time.time()
    since = int(now - DAYS * 86400)
    emails = [e for e in event.get('emails', []) if '@' in e]
    mail = Mail(mail_root)
    note = []
    user_addresses, mail_name = (mail.user() if mail.ok else (set(), ''))
    if not mail.ok: note.append(f'mail index not found at {mail.index}; built from the invite only'); print('lexicon: ' + note[-1], file=sys.stderr)

    entries, dropped, seen = [], [], set()
    def add(text, source, count, last=0):
        key = re.sub(r'\s+', ' ', text.strip()).lower()
        if not key: return
        if key in seen:
            for e in entries:
                if e['text'].lower() == key: e['count'] += count
            return
        seen.add(key); entries.append({'text': text.strip(), 'source': source, 'count': count, '_last': last})

    # 3. mail with the invitees (read before 1 and 2 so names can be counted in it; ranked after them)
    texts, messages = [], []
    if emails and mail.ok:
        messages = mail.with_people(emails, since, user_addresses)
        for row in messages:
            body = own_text(mail.text(row), own_names(event, settings_path, profile_path, mail_name))
            subject = PREFIX.sub('', row['subject'])
            texts.append((body, row['date'], row['thread'], False)); texts.append((subject, row['date'], row['thread'], True))
    elif not emails: note.append('no invitee emails in event.json: no mail read; falls back to own name, title words and past calls')

    # 1. own name, 2. invitees, my-words, then the title, in that order and before anything else
    mine = own_names(event, settings_path, profile_path, mail_name)
    for n in mine: add(n, 'own', 1 + mentions(n, texts))
    for n in invitee_names(event): add(n, 'invitee', 1 + mentions(n, texts))
    words = my_words(my_words_path)
    for n in words[:MY_WORDS_CAP]: add(n, 'my-words', 1)
    for n in words[MY_WORDS_CAP:]: dropped.append({'text': n, 'source': 'my-words', 'reason': f'over my-words limit of {MY_WORDS_CAP}'})
    for term in title_terms(event): add(term, 'title', 1)
    by_use = lambda x: (-x[1], -x[2], x[0].lower())

    # 3. mail terms
    pool = []
    for key, f in count_terms(texts).items():
        if key in seen: continue
        why = is_common(f['text'], f['mid'])
        if why: dropped.append({'text': f['text'], 'source': 'mail', 'reason': why})
        else: pool.append((f['text'], f['count'], f['last']))
    for text, count, last in sorted(pool, key=by_use): add(text, 'mail', count, last)

    # 5. past calls with the same people
    past, past_dropped, past_folders = past_calls(emails, calls_root, folder)
    dropped += past_dropped
    for text, count, last in sorted([(p['text'], p['count'], p['last']) for p in past], key=by_use): add(text, 'past-call', count, last)

    # own-terms: the user's recurring capitalized words from their own sent subjects (index only, no body read), last,
    # into the slots left free, at most OWN_CAP
    own_sent = mail.sent(since) if mail.ok else []
    user_parts = {clean(t).lower() for n in mine for t in n.split() if clean(t)}
    own_words, own_dropped = own_subject_words([(r['subject'], r['thread'], r['date']) for r in own_sent],
                                               user_parts=user_parts, people=mail.display_words() if mail.ok else set())
    dropped += own_dropped
    room, taken = max(0, min(OWN_CAP, cap - len(entries))), 0
    for w in own_words:
        if w['text'].lower() in seen: continue
        if taken < room: add(w['text'], 'own-terms', w['count'], w['last']); taken += 1
        else: dropped.append({'text': w['text'], 'source': 'own-terms', 'reason': f'over own-terms limit of {OWN_CAP}' if taken == OWN_CAP else f'over cap of {cap}'})

    # 4. the user's own recurring terms, experiment
    terms_found = []
    if with_terms and mail.ok:
        sent = own_sent
        stexts = [(own_text(mail.text(r), own_names(event, settings_path, profile_path, mail_name)), r['date'], r['thread'], False) for r in sent]
        for key, f in count_terms(stexts).items():
            parts = f['text'].split()
            if not (len(parts) >= 2 or ACRONYM.match(f['text'])): continue   # acronyms and multi-word terms only
            if f['count'] < TERM_MIN or len(f['threads']) < TERM_THREADS: continue
            if is_common(f['text'], f['mid']): continue
            terms_found.append({'text': f['text'], 'count': f['count'], 'threads': len(f['threads'])})
        terms_found.sort(key=lambda t: (-t['count'], -t['threads'], t['text'].lower()))
        for t in terms_found:
            if t['text'].lower() not in seen: add(t['text'], 'terms', t['count'])
        note.append(f'--with-terms read {len(sent)} sent messages')

    # the cap
    kept, over = entries[:cap], entries[cap:]
    for e in over: dropped.append({'text': e['text'], 'source': e['source'], 'reason': f'over cap of {cap}'})
    for e in kept: e.pop('_last', None)
    out = {'entries': kept, 'dropped': dropped, 'cap': cap, 'built': datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds'),
           'call': folder.name, 'sources': {'invitee_emails': emails, 'mail_messages': len(messages), 'mail_unreadable': mail.unreadable,
                                             'own_subjects': len(own_sent), 'my_words': len(words), 'mail_since': datetime.fromtimestamp(since).date().isoformat(), 'past_calls': past_folders, 'notes': note}}
    if with_terms: out['terms_found'] = terms_found
    return out

def write(folder, data):
    # New file every time: lexicon.json, then lexicon-2.json, lexicon-3.json ... Nothing in a call folder is overwritten.
    folder = Path(folder); n = 1
    while True:
        p = folder / ('lexicon.json' if n == 1 else f'lexicon-{n}.json')
        if not p.exists(): break
        n += 1
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
    return p
