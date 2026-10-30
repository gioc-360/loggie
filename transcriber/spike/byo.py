# "Summarize with your AI" (2026-10-07). hikyaku keeps the words on the Mac; the summary is written by Nemotron on
# Nebius Token Factory, the only AI the notes go to (B8, NVIDIA end to end), and hikyaku's code gates check what comes
# back. Why: the local NVIDIA summaries (30B/9B/4B) lost both real blind tests to the rival notes app, which runs frontier models.
#   python3 byo.py <version-folder> [--with nebius] [--approved <sha256>] [--dry-run]     sends outbound.md (privacy.py), never transcript.md
#   (no --with: settings.json "frontier", nebius when absent; any other name, such as an old pick on disk, is refused)
#   --approved: the sha256 of the outbound.md the user reviewed and sent from Loggie's send gate (sendgate.py). byo.py
#   refuses without it (exit 2, nothing written); with it, it sends only that exact outbound.md.
# One pass over the WHOLE call (no 10-minute pieces: a frontier model reads 24 minutes at once; the pieces existed for
# the small models that once ran on the Mac), up to 45 minutes; a longer call goes in parts of about 25 to 30 minutes and
# one merge (chunks_of, 2026-10-23: one pass over a 159-minute class dropped its middle and end).
# The prompt is a file (prompts/summary-clean.txt) so the owner can read it; its shape is the
# one Gio picked blind (the rival app's, now called clean): headings by person or topic, nested dense bullets, a final Next Steps with the
# owner in parentheses. The model's reply is Markdown; every bullet ends with [mm:ss] and an HTML comment holding 4 to 8
# verbatim words, which code checks against the transcript and then strips. Marks and drops follow summary.py's
# semantics: a bullet whose words are not found near its stamp is kept and marked (not sure) (the same mark the old local
# summaries used, so one vocabulary and blind_text already strips it); a Next Step that is not verified is dropped (an
# invented next step is the worst error this product can make); a Next Step whose deadline is not in its cited
# paragraph loses the deadline, not the step; a bullet that copies the prompt's own shape lines is dropped.
# Provider nebius (the hackathon entry, spec-entry-b.md B5, 2026-10-08): Nemotron Super on Nebius Token Factory, one
# OpenAI-compatible POST with outbound.md's turns in the prompt and no tools. The key is read from the keychain at
# request time and held in memory only: never in a file, a log, a child's environment or an error message. A reply cut
# at the token limit, an empty reply, or a reply from a model that is not NVIDIA's writes nothing.
# Nothing leaves the Mac until the user picks an AI and presses Send (spec-entry-b.md A7, increment b#3a): nebius runs
# only with the approval Loggie's send gate passes, and the approval names the reviewed outbound.md by its hash, so a
# screen that ran again after the review is a refusal, not a send. A provider other than nebius (an old call folder,
# pending send or settings.json that names another AI) reads as not approved: exit 2, nothing sent (B7 D1, B8).
import atexit, hashlib, json, math, os, re, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.request
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import goal_notes, lexicon, privacy, spelling, spoken_numbers, summary, transcript

# The privacy screen (privacy.py, 2026-10-07): what crosses is outbound.md, never transcript.md. The screen, code
# patterns and word lists on this Mac (no model), replaces each private sentence with "[<category> kept on this Mac]"
# and lists the held sentences in held.json. Why: the Priya call's health aside ("I might have torn my ACL") went out
# whole before this. If outbound.md is missing or older than transcript.md the screen runs first; if the screen cannot
# run, byo.py refuses to send. The citation gates still check the model's quotes against transcript.md:
# a marker's words are not in it, so a bullet that cites a marker is marked (not sure), never verified.

PROMPTS = HERE / 'prompts'
PROMPT_FILE = PROMPTS / 'summary-clean.txt'
# A team meeting (2026-10-08, Gio, after Gemini's readout of the Hilton call beat Loggie's: "we cant be showing speaker
# 1 2 3 4 when we have the teams names"): several invitees get prompts/summary-team.txt instead: an executive summary,
# topic headings instead of people, Next Steps for every person, and the speakers named from the words, limited to the
# invite's names (the unknown-name gate still checks every name). The recorder's own track is labeled as a microphone,
# not as the user, because in a room it hears everyone sitting there.
TEAM_PROMPT_FILE = PROMPTS / 'summary-team.txt'
def is_team(event): return summary.kind_of(event) != 'class' and summary.one_other(event) is None and len(invited(event)) >= 2
def invited(event):
    raw = event.get('names') or event.get('attendees') or event.get('with') or ''
    return [p.strip() for p in re.split(r',|;|\band\b|&', raw) if p.strip()]
# Goal-first notes (2026-10-09, after Jess compared the Liz call with the rival app: "Loggie list out everything Gio present
# (useless because Gio knows everything he said)"): when the call's workstream has a goal, prompts/summary-goal.txt
# takes it as an input. Points are kept and ordered by how much they serve it (Barsalou 1983, p. 225; Zhong et al.
# 2021, QMSum, p. 5905), the user's own part is one "covered:" line of topics (Clark and Haviland 1977, p. 3; Grice 1975,
# p. 45), and each next step says which part of the goal it serves (Purver et al. 2007, p. 19; Gollwitzer 1999, p. 494).
GOAL_PROMPT_FILE = PROMPTS / 'summary-goal.txt'
QUIET_GOAL = 'Just keep me posted'

def goal_of(event, folder):
    # The goal of the call's workstream, from hikyaku's workstreams.json beside the calls folder: the user's own words
    # (goalText, confirmed or drafted), else the label they picked. None for no workstream, no goal, or a quiet one.
    # A class takes the class path whatever its workspace's goal (review, 2026-10-23): one goal-prompt request skipped the
    # scaled shape, the parts and the class Next Steps.
    if summary.kind_of(event) == 'class': return None
    name = str(event.get('workstream') or '').strip().lower()
    calls = next((p for p in [Path(folder).resolve(), *Path(folder).resolve().parents] if p.name == 'calls'), None)
    if not name or calls is None: return None
    try: streams = json.loads((calls.parent / 'workstreams.json').read_text())
    except (OSError, json.JSONDecodeError): return None
    item = next((w for w in streams if isinstance(w, dict) and str(w.get('name', '')).strip().lower() == name), None)
    if not item or item.get('goal') == QUIET_GOAL: return None
    goal = str(item.get('goalText') or item.get('goal') or '').strip()
    return goal or None

# Filing (2026-10-09, after a calendar block named a Loggie working session "MBA Veterans Career Conference & Expo"; Gio:
# "hikyaku and loggie should learn how to auto categorize and not be clueless like this"): before the notes, one short
# request names the call and picks its workstream from what was said, so the notes use the right goal. Evidence first
# (Brandt et al., session.md S1-S4): the model quotes the words, then names; code finds the quote in transcript.md, and a
# quote that is not there files nothing. A real calendar title stays unless the model says it does not fit; a title the
# user gave by hand (event.json "relabeled") is never touched.
FILE_PROMPT_FILE = PROMPTS / 'file-call.txt'
FILE_MAX_TOKENS = 400   # four lines
# The quote with or without its comment wrapper: Nemotron Super dropped the <!-- --> on the first real call (2026-10-09).
FILE_CITE = re.compile(r'\[(\d+:\d\d)\]\s*(?:<!--\s*(.*?)\s*-->|["\u201c]?(.+?)["\u201d]?\s*$)')
FILE_LINE = {k: re.compile(rf'^\**\s*{k}:\**\s*(.*?)\s*$', re.I | re.M) for k in ('Because', 'Title', 'Workstream', 'Calendar title')}

# Which prompt writes the notes (B9, 2026-10-20, Gio approved): the rule the claude path kept until B8 removed it
# (6fbb46b: "the claude path keeps its prompts"), now on Nebius. A workstream goal (goal_of) takes summary-goal.txt;
# else a team meeting (is_team: two or more invitees) takes summary-team.txt; else summary-clean.txt. The goal wins
# over the team readout (prompt_file_for). From 2026-10-10 to B9 every Nebius call took the goal prompt with a default
# purpose by call kind instead (6fbb46b; the older prompts on Super had lost to the rival app 9 of 10 on five goal-less calls).
# Without a goal the notes get the strict checks the old path ran (check with goal None): a next step not found in the
# call is dropped, a deadline or a "so that" the cited words do not say comes off the step.

def streams_of(folder):
    calls = next((p for p in [Path(folder).resolve(), *Path(folder).resolve().parents] if p.name == 'calls'), None)
    try: streams = json.loads((calls.parent / 'workstreams.json').read_text()) if calls else []
    except (OSError, json.JSONDecodeError): return []
    return [w for w in streams if isinstance(w, dict) and str(w.get('name', '')).strip()]

def has_title(event):
    # A title that came from a real meeting: not an untitled call, not a mic-started "Zoom call" (meeting.js callEvent).
    return not event.get('untitled') and event.get('source') != 'mic'

def build_file_prompt(event, sent_lines, streams, template=None):
    names = summary.names_for(event)
    listed = '\n'.join(f"- {w['name']}: {w.get('goalText') or w.get('goal') or 'no goal set'}" for w in streams) or '- (none yet)'
    calendar = f'"{event.get("title")}"' if has_title(event) else 'none (no meeting on the calendar)'
    filled = template if template is not None else FILE_PROMPT_FILE.read_text()
    for k, v in {'me': names.get('me') or 'the user', 'calendar': calendar, 'streams': listed, 'transcript': shown(sent_lines, names)}.items():
        filled = filled.replace('{' + k + '}', v)
    return filled

def parse_filing(reply, lines, streams):
    # The four lines, checked. Returns the filing: the quote and whether transcript.md says it, a title, a workstream that
    # is on the list (anything else is none), and whether the calendar title fits.
    got = {k: (m.group(1) if (m := rx.search(reply)) else '') for k, rx in FILE_LINE.items()}
    cite = FILE_CITE.search(got['Because'])
    at, quote = (cite.group(1), (cite.group(2) or cite.group(3) or '').strip()) if cite else (None, '')
    hit, why = cite_any({'at': at, 'quote': quote}, lines) if at else (None, 'no stamp')
    title = re.sub(r'^["\'*]+|["\'*.]+$', '', got['Title']).strip()
    if not 1 <= len(title.split()) <= 10: title = ''
    names = {w['name'].strip().lower(): w['name'] for w in streams}
    stream = names.get(got['Workstream'].strip().strip('"*').lower())
    if stream: title = spelled(title, stream)
    return {'quote': quote, 'at': at, 'found': hit is not None, 'why': why, 'title': title, 'workstream': stream,
            'answered_workstream': got['Workstream'], 'calendar_fits': not re.search(r'\bnot\b', got['Calendar title'], re.I)}

def spelled(title, name):
    # The workstream's name as the user spells it: the transcript's mishearing ("loggy", 8 times on 2026-10-09) reached
    # the title as "Loggy". A title word close to a word of the name (same first three letters, ratio 0.7) takes its spelling.
    import difflib
    for word in name.split():
        if len(word) < 4 or re.search(rf'\b{re.escape(word)}\b', title, re.I): continue
        title = re.sub(r"[A-Za-z][\w'&-]*", lambda m: word if m.group(0)[:3].lower() == word[:3].lower() and difflib.SequenceMatcher(None, m.group(0).lower(), word.lower()).ratio() >= 0.7 else m.group(0), title)
    return title

def file_call(folder, event, lines, sent_lines, ask, masked=False, trimmed=None):
    # Ask once, check, write event.json. Returns (event, filing). Nothing changes when the quote is not in the transcript.
    # `masked`: a class whose turns carry Student N; a title naming a label is dropped (the label is not the call's name).
    # `trimmed`: a trimmed call's map; the prompt's calendar title goes by first name (event.json keeps its own).
    if event.get('relabeled'): return event, {'skipped': 'named by hand'}
    if event.get('filed'): return event, {'skipped': 'filed already', **event['filed']}
    streams = streams_of(folder)
    try: reply, meta = ask(build_file_prompt(privacy.trim_event(event, trimmed), sent_lines, streams))
    except SystemExit as error:
        if error.code == 2: raise   # a refusal (not an NVIDIA model) stops the send; anything else costs the filing, not the notes
        print(f'filing: not filed, the request failed ({error.code}); the notes go on with the call as it was named')
        return event, {'error': str(error.code)}
    filing = {**parse_filing(reply, lines, streams), 'model': meta.get('model'), 'at_time': datetime.now().astimezone().isoformat(timespec='seconds')}
    if masked and privacy.LABEL_WORD.search(filing['title'] or ''): filing['title'], filing['title_dropped'] = '', 'names a classmate label'
    if not filing['found']:
        print(f"filing: not filed, the quote {filing['quote']!r} is not in the transcript near [{filing['at']}] ({filing['why']})")
        return event, filing
    new = dict(event)
    # A title he typed or picked on the call page (call-notes.js renameCall, 2026-10-27) stays; the workspace still files.
    if filing['title'] and not event.get('title_by_hand') and (not has_title(event) or not filing['calendar_fits']):
        new['title'] = filing['title']; filing['was'] = event.get('title')
    if filing['workstream'] and str(event.get('workstream') or 'none') == 'none':
        new['workstream'] = filing['workstream']; new.pop('workstream_candidates', None)
    new['filed'] = {k: filing.get(k) for k in ('title', 'workstream', 'quote', 'at', 'was', 'calendar_fits', 'model', 'at_time')}
    path = next(f for f in (folder / 'event.json', folder.parent / 'event.json') if f.exists())
    before = path.with_name('event.json.before-filing')
    if not before.exists(): before.write_text(path.read_text())
    on_disk = {**json.loads(path.read_text()), **{k: new[k] for k in ('title', 'workstream', 'filed') if k in new}}
    if 'workstream_candidates' not in new: on_disk.pop('workstream_candidates', None)
    path.write_text(json.dumps(on_disk, indent=2))
    print(f"filing: \"{new['title']}\"" + (f" (was \"{filing['was']}\")" if filing.get('was') else ' (calendar title kept)' if has_title(event) else '')
          + f", workstream {new.get('workstream') or 'none'}, because [{filing['at']}] \"{filing['quote']}\"")
    return new, filing

# A goal wins over the team readout: with the goal prompt and goal_notes.py the Hilton team meeting beat the rival app in 4 of 4
# blind gradings (r10d, 2026-10-09); the team prompt it replaces there came out in 8 sections and over the rival app's length.
def prompt_file_for(event): return GOAL_PROMPT_FILE if event.get('goal') else TEAM_PROMPT_FILE if is_team(event) else PROMPT_FILE
def output_of(provider): return f'summary-{provider}'   # summary-nebius
TIMEOUT = 900   # s; the probe took 2 s for 4 tokens, a 24-minute call should take under two minutes
# Calls whose words never leave the Mac by default: health data (proposal-b, risk tier). A class goes out like any call
# once its classmates are labels (privacy.mask_classmates, loggie-class-notes); a class pair screened before that has no
# "names" map and is refused (CLASS_UNMASKED). An interview goes out with its people by first name and the sentences that
# pin a real person held (privacy.trims, loggie-interview-privacy, 2026-10-26); a pair screened before that is refused.
PRIVATE = ('doctor', 'medical')
CLASS_UNMASKED = "refused: this class was screened before classmates' names were masked; press Summarize again to screen it again. Nothing was sent."
UNTRIMMED = "refused: this call was screened before people's surnames were trimmed; press Summarize again to screen it again. Nothing was sent."

def unmask_quotes(reply, names, lines):
    # The check finds each bullet's quote in transcript.md near its stamp. In a class's reply the quotes carry labels,
    # and Nemotron keeps quotes to a few words, so it cuts one after "Student" (S-B, 2026-10-21: "Yes, go ahead,
    # Student"). Each label in a quote becomes the form said within 30 s of the stamp ("Pella", not "Pella Varin"), a
    # label cut at the end goes, and the rest of the reply is unmasked as usual.
    def form_near(n, at):
        entry = names.get(f'Student {n}')
        if not entry: return f'Student {n}'
        t = int(at.split(':')[0]) * 60 + int(at.split(':')[1]) if at else None
        near = ' '.join(l['text'] for l in lines if t is None or abs(l['t'] - t) <= 30)
        return next((f for f in entry['forms'] if re.search(rf"(?<![\w'’-]){re.escape(f)}(?![\w-])", near)), entry['name'])
    def quote(m):
        at, q = m.group(1), m.group(2)
        q = re.sub(r'[\s,]*\b[Ss]tudents?\s*$', '', q)
        q = re.sub(r'\b[Ss]tudent (\d+)\b', lambda x: form_near(x.group(1), at), q)
        return f'[{at}] <!-- {q} -->'
    return CITES.sub(quote, reply)

def classmates_of(event, held):
    # A class's map (held.json "names"), {} when nobody was found; None for any other call. A class pair with no map
    # was screened before the mask: refused, never sent.
    if summary.kind_of(event) != 'class': return None
    names = held.get('names')
    if not isinstance(names, dict): refuse(CLASS_UNMASKED)
    return names

def with_my_name(event):
    # A call saved as "Me" (every call since the fresh start of 2026-10-14 had no profile.md) takes the user's name from
    # Loggie's settings beside the calls folder, so the prompt names who recorded it: the mock interview's notes gave two
    # Next Steps to "the person who recorded the call" and called the user "the interviewee" (2026-10-26).
    if str(event.get('me') or '').strip() not in ('', 'Me') or USAGE_HOME is None: return event
    own = lexicon.own_names(event, settings_path=USAGE_HOME / 'settings.json', profile_path=USAGE_HOME / 'profile.md')
    return {**event, 'me': own[0].split()[0]} if own else event

def trimmed_of(event, held):
    # A trimmed pair's map (held.json "trimmed"), {} when it found nobody; None for a call that is not trimmed. A call that
    # trims (privacy.trims) with no map, or a map made under other rules, is refused: its surnames would leave.
    trimmed = held.get('trimmed')
    if summary.kind_of(event) != 'class' and privacy.trims(event) and (not isinstance(trimmed, dict) or held.get('trim_version') != privacy.TRIM_VERSION): refuse(UNTRIMMED)
    return trimmed if isinstance(trimmed, dict) else None

def spelled_lines(lines, spelled):
    # transcript.md's lines with the pair's proven spellings (held.json "spelled", spelling.py), so a quote copied from
    # outbound.md ("M&T") is found where the transcript heard "MNT (unclear)".
    if not spelled: return lines
    out = []
    for l in lines:
        l = spelling.apply_record(l, spelled)
        out.append({**l, 'bare': re.sub(r' \(unclear\)', '', l['text'])} if 'bare' in l else l)
    return out

def trimmed_lines(lines, trimmed):
    # transcript.md's lines by first name, for a trimmed call: the notes' quotes are checked against them (the quotes came
    # back from outbound.md, which has no surname), and what the check writes back carries no surname either.
    return lines if trimmed is None else [privacy.relabel_record(l, trimmed) for l in lines]

# The one provider (B8): Nemotron on Nebius Token Factory. Its `ask(prompt)` returns (reply_text, meta) where meta
# carries model, usage, cost_usd_reported, duration_api_ms, auth. Any other name is refused (known_provider).
PROVIDERS = ('nebius',)
# outbound.sent's provider_id (for logs and the README, never display text).
PROVIDER_IDS = {'nebius': 'nebius-token-factory'}

def tell(type_, step, text, data):
    # The event contract (spec section 2): when the send gate runs byo.py it names its run folder in HIKYAKU_RUN, and
    # outbound.sent, outbound.returned and check.result are appended there (sendgate.emit, one seq with Loggie's).
    # Without HIKYAKU_RUN (byo.py by hand) nothing is written.
    run_dir = os.environ.get('HIKYAKU_RUN')
    if not run_dir: return
    import sendgate
    sendgate.emit(run_dir, type_, step, text, data)

def tokens_of(usage):
    # Token Factory's usage (prompt_tokens, completion_tokens, completion_tokens_details) as the contract's
    # {prompt, completion, reasoning}.
    usage = usage or {}
    return {'prompt': usage.get('prompt_tokens'), 'completion': usage.get('completion_tokens'),
            'reasoning': (usage.get('completion_tokens_details') or {}).get('reasoning_tokens')}
NEBIUS_BASE = 'https://api.tokenfactory.nebius.com/v1'
NEBIUS_MODEL = 'nvidia/nemotron-3-super-120b-a12b'   # signature-b.md; Lightning spent its whole budget reasoning (spikes/)
# Token Factory's list price in US dollars per million tokens (input, output), from Nebius's own catalog
# (https://tokenfactory.nebius.com/model-catalog.md, read 2026-10-09). Loggie's usage.js holds the same table; a test
# keeps the two equal. A model not listed is logged with its tokens and no cost.
NEBIUS_PRICES = {'nvidia/nemotron-3-super-120b-a12b': (0.30, 0.90), 'nvidia/Nemotron-3-Ultra-550b-a55b': (1.00, 3.00), 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B': (0.06, 0.24), 'nvidia/Nemotron-3_5-Lightning': (0.06, 0.24)}
USAGE_FILE = 'nebius-usage.jsonl'
USAGE_HOME = None   # hikyaku's folder, set by run() when the call sits in <home>/calls/; None writes no ledger line

def cost_usd(model, usage):
    price = NEBIUS_PRICES.get(model)
    t = tokens_of(usage)
    if not price or t['prompt'] is None or t['completion'] is None: return None
    return round(t['prompt'] * price[0] / 1e6 + t['completion'] * price[1] / 1e6, 6)

def run_by():
    # "app" when Loggie started this run (its main process sets LOGGIE_RUN_BY=app), else "dev": a run by hand, an eval.
    # Loggie's meter and daily limit count only the app's rows (usage.js runBy).
    return 'app' if os.environ.get('LOGGIE_RUN_BY') == 'app' else 'dev'

def record_usage(path, model, usage, seconds, finish_reason, cached=False):
    # One line per Token Factory answer, kept or not: a reply cut at the token limit was billed too. Same file and fields
    # as Loggie's usage.js, so the panel's daily total counts call notes beside ranking and next moves. A saved answer
    # (cached) cost nothing and says so.
    if USAGE_HOME is None: return None
    t = tokens_of(usage)
    row = {'at': datetime.now().astimezone().isoformat(timespec='seconds'), 'path': path, 'model': model, 'in': t['prompt'], 'out': t['completion'],
           'usd': 0 if cached else cost_usd(model, usage), 'seconds': seconds, 'finish_reason': finish_reason, 'by': run_by(), **({'cached': True} if cached else {})}
    with open(Path(USAGE_HOME) / USAGE_FILE, 'a') as f: f.write(json.dumps(row) + '\n')
    return row

def usage_line(model, usage, seconds, calls=1):
    # The summary's last line: what this call cost on Token Factory, every request it took counted.
    t = tokens_of(usage)
    if t['prompt'] is None or t['completion'] is None: return ''
    usd = cost_usd(model, usage)
    return f"\n_Nebius: {t['prompt'] + t['completion']:,} tokens ({t['prompt']:,} in, {t['completion']:,} out)" + (f" over {calls} requests" if calls > 1 else '') + (f", ${usd:.4f}" if usd is not None else '') + (f", {seconds} s" if seconds is not None else '') + "._\n"

# A team meeting goes to Nemotron 3 Ultra (2026-10-08, Gio: "use the big brain"). Measured on the Hilton call, same prompt,
# thinking off: Super 9.4 s, 4 next steps, owners mostly the recorder; Ultra 5.8 s, 7 next steps with five different owners,
# the past winner's advice as its own topic. Thinking on ran out of budget on both (16k Super, 32k Ultra) with no answer.
NEBIUS_TEAM_MODEL = 'nvidia/Nemotron-3-Ultra-550b-a55b'
NEBIUS_MAX_TOKENS = 16000  # 6000 cut off the notes of a real 32-minute call (2026-10-09, 26,842 chars in); thinking is off, so all of it is writing
KEYCHAIN = ('nebius-token-factory', 'hikyaku')   # service, account

# ---------- the transcript, whole ----------

LINE = re.compile(r'^\[(\d+):(\d\d)\] ([^:\]]+): (.*)$', re.S)

def read_md(path):
    # transcript.md: one paragraph per turn, "[mm:ss] Who: text"; the header paragraphs before the first stamp are skipped.
    # Each line keeps its (unclear) marks in 'text' and has a 'bare' copy without them, so a quote is found either way.
    # The last turn ends where the recording does, from the header's "46 min." (transcript.header), never 8 s after it
    # starts: a paragraph runs up to two minutes, and a real 46-minute call read as 44:08 went in one pass, not two
    # (Codex review, 2026-10-23). The header is rounded to the minute, so a later last turn keeps its own end.
    out, recorded = [], 0
    for para in re.split(r'\n\s*\n', Path(path).read_text()):
        m = LINE.match(para.strip())
        if not m:
            h = re.search(r'^[^#\n][^\n]*, (\d+) min\. ', para.strip()) if not out else None
            if h: recorded = int(h.group(1)) * 60
            continue
        t = int(m.group(1)) * 60 + int(m.group(2)); spoken = ' '.join(m.group(4).split())
        # Numbers as digits ("two point seven eight billion dollars" -> "$2.78 billion"), in what the notes model reads and
        # in what its quotes are checked against alike; 'spoken' keeps the words as heard. On the Hilton meeting the model
        # kept 0 of 14 dollar figures that reached it as words (2026-10-09).
        text = spoken_numbers.spoken_to_digits(spoken)
        out.append({'t': t, 'end': t + 8, 'who': m.group(3).strip(), 'text': text, 'bare': re.sub(r' \(unclear\)', '', text), 'spoken': spoken})
    if out: out[-1]['end'] = max(out[-1]['end'], recorded)
    return out

def unclear_spans(lines):
    # The words the transcript is unsure of everywhere they appear ("Giio", "Morris Dandy", "NTU"), as spans of adjacent
    # marked words. A word that is also said clearly somewhere ("Dell", "Citi") is not one: the model may write it plain.
    spans, clear = [], set()
    for l in lines:
        words = l['text'].split(); run = []
        for i, w in enumerate(words):
            core = transcript.core(w)
            if w == '(unclear)': continue
            if i + 1 < len(words) and words[i + 1].startswith('(unclear)'): run.append(core)
            else:
                if run: spans.append(' '.join(run)); run = []
                if core: clear.add(core.lower())
        if run: spans.append(' '.join(run))
    seen, out = set(), []
    for s in spans:
        if s.lower() in seen or any(w.lower() in clear for w in s.split()): continue
        seen.add(s.lower()); out.append(s)
    return out

def restore_marks(text, spans):
    # A span the transcript marked (unclear) everywhere keeps its mark in a bullet, by code, whatever the model did.
    n = 0
    for s in spans:
        text, k = re.subn(rf"\b{re.escape(s)}\b(?! \(unclear\))", f"{s} (unclear)", text); n += k
    return text, n

def vocabulary(lines, event):
    # Every word said on the call or written in the invite, lowercased without punctuation: what a name in a bullet is
    # checked against. Possessives drop their 's.
    words = set()
    for l in lines: words |= set(summary.norm(l['bare']).split())
    for k in ('title', 'names', 'attendees', 'with', 'me'): words |= set(summary.norm(str(event.get(k) or '')).split())
    return words

TITLE_WORD = re.compile(r"^[A-Z][a-z][a-zA-Z'’.-]*$")

def far_names(text, lines, near_lines):
    # Names in a note that the call says, but not near the note's moment, wherever they stand in the note (unknown_names
    # skips a fragment's first word, so "(Richard: ..." escaped it; Hilton 2026-10-09). A name here is a word the
    # transcript writes capitalized mid-sentence ("That's Richard."), which leaves out "Networking" at a sentence start.
    mid = lambda ls: {w for l in ls for w in re.findall(r"(?<![.!?]\s)(?<!^)(?<=\s)([A-Z][a-z]{2,})", l['text'])}
    said_as_name, near = mid(lines), {summary.norm(w) for l in near_lines for w in l['text'].split()}
    out = []
    for w in re.findall(r"[A-Z][a-z]{2,}", text):
        if w in said_as_name and summary.norm(w) not in near and w not in out: out.append(w)
    return out

def unknown_names(text, vocab):
    # Title-case words that look like names and were never said. A word that starts a fragment is never checked (a
    # command's verb, "Prior roles:"), so an invented first name escapes at a fragment's start, but its last name does
    # not, and inside a fragment a title-case word next to another one is checked wherever it stands. Acronyms (ALL CAPS)
    # are not names.
    # Returns the unknown words, in order, once each. Catches a resolved (unclear) too: "Morgan Stanley" for "Morris Dandy".
    # Weekdays and months are capitalized English, not names: the due gate judges those.
    tokens = re.findall(r"[A-Za-z0-9'’.&-]+|[^\sA-Za-z0-9]", text)
    known = lambda w: w in transcript.DATES or any(v in vocab for v in (w, w + 's', w[:-1] if w.endswith('s') else w, w[:-2] if w.endswith('es') else w))
    out, start = [], True
    for i, tok in enumerate(tokens):
        word = tok.rstrip(".'’").replace('’', "'")
        word = re.sub(r"'s$", '', word)
        if re.fullmatch(r"[^\sA-Za-z0-9]", tok): start = tok in '.:;!?()' or start; continue
        if TITLE_WORD.match(word) and not start:
            low = summary.norm(word)
            if low and not known(low) and word not in out: out.append(word)
        start = tok.endswith(('.', ':', ';', '!', '?'))
    return out

# ---------- the prompt ----------

def prompt_text(event=None): return (prompt_file_for(event) if event is not None else PROMPT_FILE).read_text()

def prompt_hash(text=None): return hashlib.sha256((text if text is not None else prompt_text()).encode()).hexdigest()[:12]

def shapes(template):
    # The prompt's shape lines, the ones with <placeholders>: what leaked() guards against (summary.py: the 30B copied a
    # shape's words into a real file, 2026-10-07).
    return {i: l for i, l in enumerate(template.splitlines()) if re.search(r'<[^>]+>', l) and not l.startswith('<!--')}

def when_of(event, folder):
    start = event.get('start')
    try: when = datetime.fromisoformat(start.replace('Z', '+00:00')).astimezone() if start else datetime.strptime(Path(folder).name[:15], '%Y-%m-%d-%H%M')
    except ValueError: when = None
    return when.strftime('%A, %B %-d, %Y') if when else 'date unknown'

def shown(lines, names, me_label=None):
    # What the model reads: the turns as they are, the recorder's "Me" written as the user's name (the model never sees
    # "Me" as a name to copy), or for a team meeting as the user's microphone. The check runs on the original lines.
    me = me_label or names.get('me') or 'Me'
    return '\n\n'.join(f"[{transcript.stamp(l['t'])}] {me if l['who'] == 'Me' else l['who']}: {l['text']}" for l in lines)

ONE_MIC_NOTE = 'One microphone heard everyone, so who said what is not known; tasks are written without owners.'

def one_mic(lines):
    # Every turn under one label (in a room, the recorder's mic hears everyone and labels it all "Me"): nothing in the
    # recording says who spoke. Gio, 2026-10-10: "if theres no context in the one mic meeting to determine who said what,
    # then loggie hikyaku should have a way to handle that. we cant force something thats not doable" (the Loggie scoping
    # call: owners guessed, the rival app's name made a person, the rival app won 4 of 4).
    return len(lines) >= 10 and len({l['who'] for l in lines}) == 1

CLASS_PEOPLE = ('{me} recorded it in class. Classmates are written Student 1, Student 2 and so on: keep those labels exactly as written, '
                'and never guess who a label is. The professor is written the professor.')

# The shape scales with the call (2026-10-23). The 2 h 39 min strategy class of 10-22 came back as 5 headings and 16
# bullets from minutes 2-37, 64 and 109-131, against the rival app's 8 sections and ~85 bullets over all 159 minutes:
# the prompt asked for "3 to 7 headings" whatever the length. About one heading per 20 minutes (3 to 12), one bullet per
# 2 to 3 minutes, and every part of the call in order, the last 30 minutes too.
def shape_for(seconds, part=False):
    # (headings, bullets) for a stretch of `seconds`; a part of a long call takes its share, at least one heading.
    minutes = max(1.0, seconds / 60)
    headings = max(1, min(12, math.ceil(minutes / 15))) if part else max(3, min(12, round(minutes / 20)))
    low = max(3, round(minutes / 3))
    return headings, f'{low} to {max(low, round(minutes / 2))}'

def span_of(lines): return lines[-1].get('end', lines[-1]['t']) - lines[0]['t'] if lines else 0   # s, first turn to the last one's end

NEXT_STEPS = ('Next Steps: only what a person said they will do or was asked to do, with that person\'s name in parentheses. A date or deadline appears only '
              'when the cited paragraph says it. An offer ("email me if you have questions") is the other person\'s optional step, never the speaker\'s.')
# A class's Next Steps (2026-10-23): the 10-22 notes listed the in-class exercise's instructions ("Form eight teams for
# ten-minute strategy development") and missed "no class next week" (the professor is in Peru).
CLASS_NEXT_STEPS = ('Next Steps, for a class: only what the students must do or know after this class: assignments, readings, cases to prepare, '
                    'deadlines, exams, and logistics such as a class that will not meet, a new room or a new time ("no class next week"), each '
                    'written for the students. A date or deadline appears only when the cited paragraph says it. Never the steps of an exercise done during the '
                    'class (forming teams, taking roles, minutes to discuss, what to write on the board): that exercise is part of the notes above, not a next step. '
                    # 2026-10-23: the 10-22 notes still listed eight such steps; two of its moments, in other words, show the line.
                    'Nor a break, the next case or guest of the same session, or a question the class discussed. Code drops a step whose paragraph is not about after '
                    'the class. Kept: "Oh, next week I am away. See you the week after next." is "No class next week; class resumes the week after next". '
                    'Dropped: "Let\'s take a five-minute break, and then we go to the next case." is no next step: the next case is taught after the break, in this class.')
# A long class is written in parts (2026-10-23): parts 1 to 5 of the 10-22 class ended before the class did, and wrote
# "Prepare for next case discussion after break" and "Prepare for second half of session". A part is told the class goes on.
CLASS_PART_STEPS = (' This part ends before the class does: the rest of the session, a break and the next case are never a Next Step. Write Next Steps only for '
                    'what these minutes say about after the class ends, and leave the Next Steps heading out when they say none.')
CLASS_MERGE_STEPS = (' This is a class: keep only the steps about after the class ends (assignments, readings, cases to prepare, deadlines, exams, a class that will '
                     'not meet). Drop a part\'s step about a break, the next case, an exercise in the room or the rest of the session: each part wrote its steps before the class ended.')

def people_sentence(event, lines, classmates=None):
    # (people, me, other, mic): who the prompt says is on the call, the same for a whole call, a part and the merge.
    names = summary.names_for(event)
    me, other = names.get('me') or 'the person who recorded the call', names.get('other') or 'the other person'
    people = f'{me} recorded it; the other person is {other}.' if names.get('other') else f'{me} recorded it.'
    if classmates is not None: people = CLASS_PEOPLE.format(me=me)
    elif privacy.trims(event):
        # An interview: who asks and who answers (the mock of 2026-10-26 gave the interviewer's "any questions for me?" to
        # the user as a Next Step). In a mock the other person may speak as someone else, by another name.
        people += (f' This is an interview: {other} asks the questions as the interviewer and {me} answers. In a mock interview {other} may play'
                   f' the interviewer under another name; what that interviewer says or offers is {other}\'s, never {me}\'s.')
    mic = None
    if is_team(event):   # any prompt: in a room the recorder's mic hears everyone, so it is labelled a mic, not the user (the goal prompt took team meetings on 2026-10-10)
        mic = f"{names.get('me') or 'The recorder'}'s microphone"
        people = ', '.join([f"{names.get('me')} (who recorded it)"] * bool(names.get('me')) + invited(event))
    if one_mic(lines) and not mic:
        people += (f' One microphone heard everyone in the room, so every turn is labelled with one name whoever spoke: never say'
                   f' who said something, leave out the "{me} covered" line, and write each task as what needs to be done, with no owner and no name of who will do it.')
    return people, me, other, mic

def build_prompt(event, lines, folder, template=None, notes=(), classmates=None, part=None, pages=()):
    # `classmates`: a masked class's map (loggie-class-notes); the people sentence then says how labels are written.
    # `part`: (k, n) when these lines are part k of n of a long call (chunks_of); the shape is then the part's.
    template = template if template is not None else prompt_text()
    names = summary.names_for(event)
    people, me, other, mic = people_sentence(event, lines, classmates)
    filled = template
    # The recorder's own typed notes (loggie-meetings-tab), screened like the transcript: a hint of what mattered to them,
    # never a source of facts on its own. No notes, no block.
    notes_block = ('\n<my_notes>\n' + f"{me}'s own notes, typed during or after the call. Use them to see what mattered to {me}; facts still come from the transcript.\n"
                   + '\n'.join(f'- {line}' for line in notes) + '\n</my_notes>\n') if notes else ''
    # The pages tucked into the call (loggie-pause-attach), screened and approved like the notes, in the same slot so a
    # call with no page sends the prompt it sent before. No pages, no block.
    if pages:
        notes_block += ('\n<pages>\n' + f"Pages {me} tucked into the call: slides, an agenda or a reading it ran on. Use them for the right spelling of names, terms and numbers and to see what the call was about; what was said comes from the transcript only.\n"
                        + '\n'.join(f'{who}: {text}' for who, text in pages) + '\n</pages>\n')
    a, b = (transcript.stamp(lines[0]['t']), transcript.stamp(lines[-1]['t'])) if lines else ('00:00', '00:00')
    headings, bullets = shape_for(span_of(lines), part=part is not None)
    # A part gets a ceiling, a whole call a range: the merge does not drop bullets (2026-10-23: six parts asked for about
    # 9 to 13 wrote 21 to 39 each, and the merge kept 147 of them against about 80 asked), so each part keeps its share.
    bullets = f"at most {bullets.split(' to ')[-1]}" if part else f'about {bullets}'
    if part:
        said_part = (f' This is part {part[0]} of {part[1]} of the call, {a} to {b}: write the notes for these minutes only. The other parts are'
                     ' written separately and joined after, so say nothing about what comes before or after them.')
        cover = f'Cover all of these minutes in order, from {a} to {b}, the last minutes of the part as much as the first.'
    else:
        said_part = ''
        cover = f'Cover the whole call in order, from {a} to {b}, including the last 30 minutes: a point from the end counts as much as one from the start.'
    next_steps = CLASS_NEXT_STEPS + (CLASS_PART_STEPS if part else '') if summary.kind_of(event) == 'class' else NEXT_STEPS
    for k, v in {'goal': event.get('goal') or '', 'mic': mic or me, 'title': event.get('title', 'Call'), 'date': when_of(event, folder), 'people': people, 'me': me, 'other': other,
                 'part': said_part, 'headings': headings, 'bullets': bullets, 'cover': cover, 'next_steps': next_steps, 'transcript': shown(lines, names, mic), 'notes': notes_block}.items():
        filled = filled.replace('{' + k + '}', str(v))
    return filled

# Long calls in parts (2026-10-23). The 10-22 class went in one request of 30,442 tokens and came back with 996 of
# 16,000 output tokens used: the middle and the end were dropped. A call over CHUNK_OVER is split on turn boundaries into
# parts of at most CHUNK_MOST, each part's notes are written with the same rules and its real [mm:ss], then one merge
# request joins them (prompts/summary-merge.txt): repeats out, time order, the whole call's shape. The checks then run
# on the merged notes exactly as on a one-pass reply. Only the clean prompt is split: the goal and team prompts group
# by importance across the whole call, and their blind-tested shapes are kept.
MERGE_PROMPT_FILE = PROMPTS / 'summary-merge.txt'
CHUNK_OVER = 45 * 60    # s
CHUNK_MOST = 30 * 60    # s: 159 minutes -> 6 parts of about 26.5

def chunks_of(lines):
    # The turns in parts: one part for a call up to CHUNK_OVER, else ceil(span / CHUNK_MOST) parts of equal length, each
    # starting at the first turn at or past its share of the time.
    span = span_of(lines)
    if not lines or span <= CHUNK_OVER: return [lines]
    n = math.ceil(span / CHUNK_MOST)
    starts = [0] + [next((i for i, l in enumerate(lines) if l['t'] - lines[0]['t'] >= k * span / n), len(lines)) for k in range(1, n)]
    starts = sorted(set(s for s in starts if s < len(lines)))
    return [lines[s:e] for s, e in zip(starts, starts[1:] + [len(lines)])]

def build_merge_prompt(event, lines, folder, replies, parts, classmates=None, template=None):
    # The merge request: every part's notes as written (labels and quotes as they came back), the whole call's shape.
    # It joins headings by topic and keeps at most the shape's bullets (2026-10-23: told to keep every bullet, the 10-22
    # class came back as 24 headings and 164 bullets, Corning across five headings, against about 8 and 80 asked).
    template = template if template is not None else MERGE_PROMPT_FILE.read_text()
    people, _, _, _ = people_sentence(event, lines, classmates)
    headings, bullets = shape_for(span_of(lines))
    text = '\n\n'.join(f"<part {k} of {len(parts)}, {transcript.stamp(p[0]['t'])} to {transcript.stamp(p[-1]['t'])}>\n{r.strip()}\n</part>"
                       for k, (r, p) in enumerate(zip(replies, parts), 1))
    values = {'parts_text': text, 'parts': len(parts), 'title': event.get('title', 'Call'), 'date': when_of(event, folder), 'minutes': round(span_of(lines) / 60),
              'people': people, 'headings': headings, 'bullets': bullets, 'bullets_max': bullets.split(' to ')[-1],
              'class_steps': CLASS_MERGE_STEPS if summary.kind_of(event) == 'class' else '',
              'span': f"{transcript.stamp(lines[0]['t'])} to {transcript.stamp(lines[-1]['t'])}"}
    # One pass over the template: a part's quote "Put the token {title} into" stays as said (Codex review, 2026-10-23: the
    # parts went in first and their {title} became the call's title, so a verified quote failed its check).
    return re.sub(r'\{(\w+)\}', lambda m: str(values[m.group(1)]) if m.group(1) in values else m.group(0), template)

def notes_model(event):
    # Nemotron 3 Ultra for team meetings, goal notes and classes (A4, 2026-10-23: the 10-22 class on Super), else Super.
    return NEBIUS_TEAM_MODEL if is_team(event) or event.get('goal') or summary.kind_of(event) == 'class' else NEBIUS_MODEL

def plan_prompts(event, sent_lines, folder, template, notes=(), classmates=None, pages=()):
    # What the notes request(s) would carry, built and never sent: [{part, from, to, turns, prompt}], one entry for a
    # one-pass call. A dry run prints it; run() sends it.
    parts = chunks_of(sent_lines) if prompt_file_for(event) == PROMPT_FILE else [sent_lines]
    one = len(parts) == 1
    return [{'part': k, 'from': transcript.stamp(p[0]['t']) if p else '00:00', 'to': transcript.stamp(p[-1]['t']) if p else '00:00', 'turns': len(p), 'lines': p,
             'prompt': build_prompt(event, p, folder, template, notes, classmates, part=None if one else (k, len(parts)), pages=pages)} for k, p in enumerate(parts, 1)]

# The merge's output budget (review, 2026-10-23: every part and the merge had the same 16,000 tokens): what the parts
# wrote, with room, between MERGE_LEAST and MERGE_MOST; a merge cut at its limit is asked once more at twice the budget.
MERGE_LEAST, MERGE_MOST = 4000, 32000   # 32k: the most Ultra was given on 2026-10-08
def merge_budget(part_tokens):
    return max(MERGE_LEAST, min(MERGE_MOST, round(sum(t or NEBIUS_MAX_TOKENS for t in part_tokens) * 1.25) + 1000))

def usable(reply):
    # A part's notes are usable when they hold no control token and at least one bullet with its [mm:ss].
    return not BROKEN.search(reply) and any(b['at'] for s in parse_reply(reply)[0] for b in s['bullets'])

def ask_in_parts(plan, event, lines, folder, ask, classmates=None, nonce=lambda text: text, live=None, raw_dir=None, merge_ask=None):
    # One request per part, in order, then the merge. Returns (the merged reply, meta with every request's tokens and
    # seconds summed, the record for summary-runs.json "chunks"). A part with no usable notes is asked once more, and a
    # second failure stops the run with nothing written (review, 2026-10-23: a part answering only "<|message_end|>" was
    # logged and the notes were written without its minutes). `merge_ask(prompt, max_tokens)` may answer finish_reason
    # "length"; without it the merge goes through `ask`.
    replies, parts, metas = [], [], []
    tally = lambda meta, t0, prompt, reply: {'chars': len(prompt), 'reply_chars': len(reply), 'headings': len(parse_reply(reply)[0]),
                                            'bullets': sum(len(s['bullets']) for s in parse_reply(reply)[0]), 'seconds': round(time.time() - t0, 1),
                                            'model': meta.get('model'), 'finish_reason': meta.get('finish_reason'), 'tokens': tokens_of(meta.get('usage'))}
    def attempt(fn, *args):
        # An empty reply or a cut stream is a failed attempt here, asked again below, never the end of the run.
        try: return fn(*args)
        except Unanswered as error: print(str(error.code).split(';')[0]); return '', error.meta
    for p in plan:
        print(f"part {p['part']} of {len(plan)}, {p['from']} to {p['to']} ({p['turns']} turns)...")
        t0, prompt, failed = time.time(), p['prompt'], []
        reply, meta = attempt(ask, prompt)
        if not usable(reply):
            # A changed request, not only a new first line: a saved answer is keyed without that line and would come back.
            # The old first line comes off before the new one goes on: left in, its random hex kept the retry's saved
            # answer from ever matching, and every rerun paid for the retry again (Codex review, 2026-10-23).
            print(f"part {p['part']} came back with no usable notes; asking once more...")
            metas.append(meta); failed.append(tally(meta, t0, prompt, reply))
            prompt = nonce(f"{NONCE.sub('', p['prompt'])}\n\nThe first answer for this part held no notes; write them now.")
            reply, meta = attempt(ask, prompt)
            if not usable(reply): sys.exit(f"part {p['part']} of {len(plan)} ({p['from']} to {p['to']}) came back with no usable notes twice; nothing written")
        replies.append(reply); metas.append(meta)
        parts.append({'part': p['part'], 'from': p['from'], 'to': p['to'], 'turns': p['turns'], **tally(meta, t0, prompt, reply), 'retried': bool(failed), 'failed': failed})
        if raw_dir is not None: (raw_dir / f"part-{p['part']}.md").write_text(reply)
        if live is not None: live.before += reply.strip() + '\n\n'
    if live is not None: live.before = ''
    merge = nonce(build_merge_prompt(event, lines, folder, replies, [p['lines'] for p in plan], classmates))
    if raw_dir is not None: (raw_dir / 'merge-prompt.txt').write_text(merge)
    merge_ask = merge_ask or (lambda prompt, max_tokens: ask(prompt))
    budget = merge_budget([x['tokens']['completion'] for x in parts])
    print(f'joining the {len(plan)} parts (up to {budget:,} tokens)...')
    t0, asked, failed = time.time(), merge, []
    reply, meta = attempt(merge_ask, asked, budget)
    if meta.get('finish_reason') == 'length':
        metas.append(meta); failed.append(tally(meta, t0, asked, reply))
        if budget >= MERGE_MOST: sys.exit(f'the merge stopped at the token limit ({budget:,}); nothing written')
        budget = min(MERGE_MOST, 2 * budget)
        print(f'the merge stopped at its token limit; asking once more with {budget:,} tokens...')
        asked = nonce(NONCE.sub('', merge))
        reply, meta = attempt(merge_ask, asked, budget)
        if meta.get('finish_reason') == 'length': sys.exit(f'the merge stopped at the token limit twice ({budget:,}); nothing written')
    # Every part that wrote notes keeps at least one bullet in the merge (Codex review, 2026-10-23: a merge that answered
    # with part 1 only was saved as the call's notes, and the citation checks cannot see minutes that are not there).
    # An unusable merge or one that left a part out is asked once more with a changed request, then the run stops.
    missing = left_out(reply, replies)
    if not usable(reply) or missing:
        metas.append(meta); failed.append(tally(meta, t0, asked, reply))
        why = f"left out part {', '.join(map(str, missing))}" if usable(reply) else 'held no notes'
        print(f'the merge {why}; asking once more...')
        asked = nonce(f"{NONCE.sub('', merge)}\n\nThe first answer {why}. Join every part now: keep at least one bullet from each part, with its [mm:ss].")
        reply, meta = attempt(merge_ask, asked, budget)
        missing = left_out(reply, replies)
        if meta.get('finish_reason') == 'length' or not usable(reply) or missing:
            sys.exit('the merge of the parts ' + (f"left out part {', '.join(map(str, missing))} twice" if usable(reply) and missing else 'came back with no usable notes twice') + '; nothing written')
    merged = {**tally(meta, t0, asked, reply), 'max_tokens': budget, 'retried': bool(failed), 'failed': failed}
    record = {'minutes': round(span_of(lines) / 60), 'parts': parts, 'merge': merged,
              'chars': sum(x['chars'] for p in [*parts, merged] for x in [*p['failed'], p])}   # every request sent, failed ones too
    every = metas + [meta]
    usage = {k: sum((m.get('usage') or {}).get(k) or 0 for m in every) for k in ('prompt_tokens', 'completion_tokens')}
    return reply, {**meta, 'usage': usage, 'seconds': round(sum(m.get('seconds') or 0 for m in every), 1), 'calls': len(every)}, record

def left_out(merged, replies):
    # The parts (1-based) whose notes wrote stamped bullets outside Next Steps and none of whose stamps is in the merge.
    secs = lambda at: int(at.split(':')[0]) * 60 + int(at.split(':')[1])
    stamps = lambda text, notes_only: {secs(b['at']) for s in parse_reply(text)[0] if not (notes_only and NEXT.match(s['heading'])) for b in s['bullets'] if b['at']}
    kept = stamps(merged, False)
    return [k for k, r in enumerate(replies, 1) if stamps(r, True) and not stamps(r, True) & kept]

# ---------- the gates ----------

BULLET = re.compile(r'^(\s*)[-*]\s+(.*?)\s*$')
STAMP = re.compile(r'\s*\[(\d+:\d\d)\]')
COMMENT = re.compile(r'\s*<!--\s*(.*?)\s*-->\s*')
OWNER = re.compile(r'\s*\(([^()]{1,60})\)\s*$')
# The goal prompt's one line for the user's own part: "Gio covered: Dell PM internship, Army background, why M&T".
COVERED = re.compile(r"^\**\s*([A-Z][\w .'-]{0,40}?) covered:\**\s*(.+?)\s*$")
COVERED_MAX = 20   # words: topics only; a longer line is the user's story again and is dropped
# The goal prompt's first line: what the model deduced the call was and what the user needs from it, shown so the
# reasoning behind the sections is visible (Gio, 2026-10-09: "nebius is smart it has to deduce what the chat is shaping up to be").
DEDUCED = re.compile(r'^\**\s*This call:\**\s*(.+?)\s*$')
CITES = re.compile(r'\[(\d+:\d\d)\]\s*<!--\s*(.*?)\s*-->')
SO_THAT = re.compile(r',?\s+so that\s+(.+)$', re.I)
NEXT = re.compile(r'^next steps?$', re.I)
BROKEN = re.compile(r'<\|[a-z_]+\|>')
LABEL = re.compile(r"\bSpeaker \d+\b|\b\w+'s microphone\b|\bStudents? \d+\b"   # a class label the map lacks is a recording label too
                   r"|(?-i:\bRoom\b)(?!\s+\d)", re.I)   # the mic alone of a split recording (2026-10-28); "Room 223" is a place
CUT = '\x00'   # where a stamp or a comment was taken out of a bullet, until the text is tidied

def marks_out(body):
    # The stamp, the quote and the text of a bullet, tolerant of where the model put them. Nemotron Super (2026-10-08)
    # wrote "<step> ([mm:ss] <!-- quote -->)" and repeated the owner, stamp and quote after it; the strict parse left "()",
    # the comment and a second stamp in the visible text. Every stamp and every comment is taken out (the first of each
    # is the citation), an unclosed "<!--" runs to the end of the line and a stray "-->" goes, then a parenthesis that held
    # only those goes with it, and so does an unmatched parenthesis next to one. A well-formed bullet comes out as before.
    stamps, quotes = [], []
    def take(found, m): found.append(m.group(1)); return CUT
    body = COMMENT.sub(lambda m: take(quotes, m), body)
    body = re.sub(r'\s*<!--\s*(.*?)\s*$', lambda m: take(quotes, m), body)
    body = re.sub(r'\s*-->\s*', CUT, body)
    body = STAMP.sub(lambda m: take(stamps, m), body)
    body = re.sub(rf'\s*\(\s*(?:{CUT}\s*)+\)', CUT, body)
    chars, opened, unmatched = list(body), [], []
    for i, ch in enumerate(body):
        if ch == '(': opened.append(i)
        elif ch == ')':
            if opened: opened.pop()
            else: unmatched.append(i)
    for i in unmatched + opened:
        if body[:i].rstrip().endswith(CUT) or body[i + 1:].lstrip().startswith(CUT): chars[i] = CUT
    body = re.sub(rf'\s*(?:{CUT}\s*)+(?=[,.;:!?)]|$)', '', ''.join(chars))
    body = re.sub(rf'\s*(?:{CUT}\s*)+', ' ', body)
    return (stamps[0] if stamps else None), next((q for q in quotes if q), ''), body

def is_name(text):
    # An owner is one or more capitalized words ("Priya", "Priya Shah", "Gio and Priya"), never an (unclear) mark, a
    # deadline or a clause.
    words = [w for w in re.split(r'\s*(?:,|&|\band\b)\s*|\s+', text.strip()) if w]
    return bool(words) and text.strip().lower() != 'unclear' and all(w[0].isupper() and all(c.isalpha() or c in "'’.-" for c in w) for w in words)

def parse_reply(raw):
    # The model's Markdown into sections of bullets. A bullet: text, stamp, quote (the comment), level (0 top, 1 nested),
    # and under Next Steps its owner (the trailing parentheses, when they hold a name). Lines that are neither heading nor
    # bullet are counted as stray and dropped; the title line is not stray.
    sections, stray = [], []
    text = re.sub(r'^```(markdown|md)?\s*|```\s*$', '', raw.strip(), flags=re.M)
    for line in text.splitlines():
        if not line.strip(): continue
        if line.startswith('# ') and not sections: continue
        if line.startswith('## '):
            sections.append({'heading': line[3:].strip(), 'bullets': []}); continue
        m = BULLET.match(line)
        if not m and not sections and (COVERED.match(line.strip()) or DEDUCED.match(line.strip())): continue   # covered_of and deduced_of read them
        if not m or not sections: stray.append(line.strip()); continue
        cites = CITES.findall(m.group(2))   # every [mm:ss] <!-- quote --> pair; the goal prompt allows up to three
        at, quote, body = marks_out(m.group(2))
        body = re.sub(r'\*\*', '', body).strip().rstrip(',;')
        owner = None
        if NEXT.match(sections[-1]['heading']):
            o = OWNER.search(body)
            if o and is_name(o.group(1)): owner = o.group(1).strip(); body = body[:o.start()].strip()
        sections[-1]['bullets'].append({'text': body, 'at': at, 'quote': quote, 'cites': cites[:3], 'level': 1 if len(m.group(1)) >= 2 else 0, 'owner': owner})
    return quotes_as_citations(sections), stray

# Nemotron 3 Ultra on a short goal call (2026-10-29, the demo's case team call, 4 runs of 4) wrote its evidence as a
# visible quote under each point ('- Gio takes market sizing' then '  - "I'll take the market sizing" [00:06]') and no
# stamp or comment on the point itself, so every line came back (not sure). A nested bullet that is only a quote and
# a stamp is the point's citation: it becomes the parent's stamp and quote and is not kept as a bullet of its own. A
# bullet with a stamp and no quote (a Next Step citing a point's minute) borrows the quote cited at that same minute.
QUOTE_ONLY = re.compile(r'^["“](.+?)["”][.,]?$')

def quotes_as_citations(sections):
    for section in sections:
        kept = []
        for b in section['bullets']:
            q = QUOTE_ONLY.match(b['text'])
            parent = kept[-1] if kept else None
            # with or without quotation marks (a later run wrote the same lines bare), as long as the point itself
            # carries no citation: a point that has its own stamp and quote keeps its nested figures as bullets
            if b['level'] == 1 and b['at'] and parent and parent['level'] == 0 and not parent['quote'] and not parent['at']:
                parent['quote'] = (q.group(1) if q else b['text']).strip()
                parent['at'] = b['at']
                if not parent['cites']: parent['cites'] = [(b['at'], parent['quote'])]
                continue
            kept.append(b)
        section['bullets'] = kept
    by_minute = {}
    for section in sections:
        for b in section['bullets']:
            if b['at'] and b['quote']: by_minute.setdefault(b['at'], b['quote'])
    for section in sections:
        for b in section['bullets']:
            if b['at'] and not b['quote'] and b['at'] in by_minute: b['quote'] = by_minute[b['at']]
    return sections

def covered_of(raw, me):
    # The "<me> covered:" line's topics, or None. Kept only when it names the recorder and stays a short list of topics.
    for line in re.sub(r'^```(markdown|md)?\s*|```\s*$', '', str(raw).strip(), flags=re.M).splitlines():
        if line.startswith('## '): break
        m = COVERED.match(line.strip())
        if m and m.group(1).strip().lower() == str(me or '').strip().lower():
            topics = m.group(2).strip().rstrip('.')
            return topics if 0 < len(topics.split()) <= COVERED_MAX else None
    return None

DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
RELATIVE = re.compile(r'\b(next|this|on|by)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(tomorrow)\b', re.I)

def call_day(event):
    # The call's date, from the event's start (local), or None.
    try: return datetime.fromisoformat(str(event.get('start')).replace('Z', '+00:00')).astimezone().date()
    except (TypeError, ValueError): return None

def absolute_dates(text, day):
    # "next Friday" said on Friday Oct 9 is Fri Oct 16: the first such weekday after the call, a week on when that is
    # still the call's own week ("next"); "this", "on", "by" a weekday is the first one on or after the call day;
    # "tomorrow" the day after. The date is added in parentheses after the words, which stay as said.
    if day is None: return text, []
    added = []
    def put(m):
        if m.group(3): when = day + timedelta(days=1)
        else:
            want = DAYS.index(m.group(2).lower()); ahead = (want - day.weekday()) % 7
            if m.group(1).lower() == 'next':
                ahead = ahead or 7
                if day.weekday() + ahead <= 6: ahead += 7
            when = day + timedelta(days=ahead)
        label = when.strftime('%a %b ') + str(when.day)
        added.append({'said': m.group(0), 'date': when.isoformat()})
        return f"{m.group(0)} ({label})"
    return RELATIVE.sub(put, text), added

def deduced_of(raw):
    # The "This call: ..." line, or None; at most 60 words, else it is not one line of reasoning.
    for line in re.sub(r'^```(markdown|md)?\s*|```\s*$', '', str(raw).strip(), flags=re.M).splitlines():
        if line.startswith('## '): break
        m = DEDUCED.match(line.strip())
        if m and len(m.group(1).split()) <= 60: return m.group(1).strip()
    return None

def purpose_holds(purpose, goal, line_text, lines, t):
    # A next step's "so that" stands only on words from the goal or from what was said near its cited line: at least
    # half of its content words. Otherwise the clause is taken off the step, never rewritten.
    words = summary.content(purpose)
    if not words: return False
    source = summary.content(' '.join([goal or '', line_text] + [l['text'] for l in lines if abs(l['t'] - t) <= summary.MEANING_W]))
    return len(words & source) / len(words) >= 0.5

def cite_any(bullet, lines):
    # summary.cite on the marked text, then on the bare text: a quote with or without the (unclear) marks is found.
    line, why = summary.cite(bullet, lines)
    if line is not None: return line, why
    bare = [{**l, 'text': l['bare']} for l in lines]
    line2, why2 = summary.cite(bullet, bare)
    if line2 is None and any('spoken' in l for l in lines):   # a quote copied with the numbers still in words
        line2, why2 = summary.cite(bullet, [{**l, 'text': l.get('spoken', l['text'])} for l in lines])
    if line2 is None: return None, why2
    return next(l for l in lines if l['t'] == line2['t'] and l['who'] == line2['who']), why2

def drop_deadline(text):
    # The deadline words a Next Step claims, taken out when the cited paragraph does not say them: "by Friday", "on
    # Oct 12", "at 3 pm", "due Monday". Returns the text and what was removed (None when nothing was).
    found = summary.WHEN.search(text) or summary.DUE_STRONG.search(text)
    if not found: return text, None
    rx = re.compile(rf"\s*(?:,\s*)?(?:\b(?:by|on|before|until|due|at|this|next)\s+)?(?:{summary.WHEN.pattern}|{summary.DUE_STRONG.pattern})(?:\s+(?:{summary.WHEN.pattern}))*", re.I)
    m = rx.search(text)
    if not m: return text, None
    new = re.sub(r'\s+([,.;])', r'\1', re.sub(r'\s{2,}', ' ', text[:m.start()] + ' ' + text[m.end():])).strip(' ,;')
    return (new or text), m.group().strip(' ,') if new != text else None

# A class's Next Steps are about after the class (2026-10-23). The 10-22 strategy class's notes kept eight steps done or
# said in the room beside the one real one ("next week, I'm in Peru. See you the week after next", 158:53): "Prepare for
# next case discussion after break" on "let's take a five-minute break, and then we're gonna go to the next case", "Begin
# negotiation exercise" on "get your groups ... take about five minutes to prepare". The prompt forbade them and the
# model wrote them anyway; each part of a long class wrote its own. So code reads the paragraph a class step cites, not
# the step, which is the model's paraphrase ("Prepare for next class session" cited "So for pricing right now"): the
# step stays only when that paragraph speaks of after this class. Assignments, deadlines and a class not meeting win
# over the words of now (a real step lost is worse than a room step kept); a future day or outside work loses to them.
_N = r"(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|a few|a couple(?: of)?)"
_DAY = rf"(?:{summary.DAYS})s?"
AFTER_DUE = re.compile(r"\b(?:assignments?|homework|problem sets?|deadlines?|exams?|midterms?|finals? (?:exam|paper|project)s?|quiz(?:zes)?|submit|submission|turn (?:it )?in|hand (?:it )?in)\b"
                       r"|\bdue\b(?! to\b| diligence\b)"
                       r"|\bno (?:class|session|lecture)\b|\b(?:class|session|lecture)(?:es|s)? (?:is |are |will be |has been )?(?:cancel(?:l)?ed|off)\b"
                       r"|\bcancel(?:l)?(?:ed|ing) (?:the |our |next )?(?:class|session|lecture)\b|\b(?:won't|will not|don't|do not) (?:meet|have class)\b", re.I)
AFTER_DAY = re.compile(rf"\bnext (?:week|class|session|time|lecture|month|{_DAY})\b|\bweek after next\b|\b{_DAY}\b|\btomorrow\b|\b(?:this|the|over the) weekend\b"
                       rf"|\b(?:{summary.MONTHS})\.? \d{{1,2}}(?:st|nd|rd|th)?\b", re.I)
AFTER_WORK = re.compile(r"\b(?:to|please|should|will|'ll|must|need to|have to|going to|gonna) (?:re-?)?read\b|\breadings? (?:for|before)\b|\bcome prepared\b"
                        r"|\bprep(?:are)?(?: for)? (?:the |this |that |next |your |our )?(?:[\w-]+ ){0,2}?(?:case|reading|chapter|presentation|discussion)s?\b"
                        r"|\be-?mail (?:me|us)\b|\bsend (?:you |out )?(?:an? )?e-?mail\b|\b(?:i'll|we'll|i will|we will) e-?mail\b|\boffice hours?\b|\bsign(?:-| )?up\b|\blet (?:me|us) know\b|\bgrad(?:e|es|ing)\b"
                        r"|\b(?:new|different|another) (?:room|building|location)\b|\bmoved to\b|\bon zoom\b", re.I)
NOW = re.compile(rf"\bwithin (?:the next )?{_N} minutes?\b|\b(?:take|have|got|give you|spend|for|in) (?:about |like |around |another |the next |only )?{_N}(?: more)? minutes?\b|\b{_N}[- ]minute\b"
                 r"|\b(?:after|before) the break\b|\btake a (?:short |quick )?break\b|\bright now\b|\btoday in class\b|\bin class today\b|\bduring class\b"
                 r"|\bin (?:your |our |the )?(?:teams|groups|pairs)\b|\b(?:your|the|these|those|small|breakout) (?:teams|groups)\b|\bbreak into\b|\bsplit (?:into|that|the|your)\b"
                 r"|\b(?:at|on|to) the (?:white)?board\b|\b(?:first|second) half of (?:the |this |today's )?(?:session|class)\b|\bthe rest of (?:the |this |today's )?(?:session|class)\b", re.I)

def after_class(text):
    # (kept, why) for a class Next Step, from the words of the paragraph it cites.
    for rx, kept in ((AFTER_DUE, True), (NOW, False), (AFTER_DAY, True), (AFTER_WORK, True)):
        m = rx.search(text)
        if m: return kept, f'{"after class" if kept else "about now"}: "{m.group()}"'
    return False, 'nothing about after this class'

def check(sections, lines, event, template, weight=None, goal=None):
    # Every gate on every bullet, in this order: shape leak (drop), Me/Them -> names, (unclear) marks restored, citation,
    # names never said, the writing check, and for Next Steps the due gate. Returns the kept sections, the drops and counts.
    names = summary.names_for(event)
    spans, vocab, examples = unclear_spans(lines), vocabulary(lines, event), shapes(template)
    checks, drops, counts = [], [], {'renamed': 0, 'unclear_restored': 0, 'stamps_moved': 0, 'deadlines_dropped': [], 'in_class_dropped': [], 'purposes_dropped': [], 'style': {}, 'style_items': [], 'names_unknown': []}
    kept, is_class = [], summary.kind_of(event) == 'class'
    for sec in sections:
        is_next = bool(NEXT.match(sec['heading']))
        out = {'heading': sec['heading'], 'bullets': [], 'next': is_next}
        heading, k = summary.name_labels(sec['heading'], names); out['heading'] = heading; counts['renamed'] += k
        for b in sec['bullets']:
            text = b['text']
            if not text: continue
            phrase = summary.leaked(text, examples)
            if phrase: drops.append({'section': heading, 'text': text, 'at': b['at'] or '??:??', 'why': f'copied from the prompt\'s shapes ("{phrase}")'}); continue
            text, k = summary.name_labels(text, names); counts['renamed'] += k
            text, k = restore_marks(text, spans); counts['unclear_restored'] += k
            owner = b['owner']
            if owner: owner, k = summary.name_labels(owner, names); counts['renamed'] += k
            # A recording label is never a person (Gio, 2026-10-08: "we cant be showing speaker 1 2 3 4 when we have the
            # teams names"): an owner that is a label becomes Team, and a bullet that names a label is marked.
            if owner and LABEL.search(owner): owner = 'Team'; counts['label_owners'] = counts.get('label_owners', 0) + 1
            line, why = cite_any({'at': b['at'], 'quote': b['quote']}, lines)
            # Loose mode, the goal prompt (Gio, 2026-10-09, after the rival app won 4 blind gradings of 4: "loosen"): a point may
            # join up to three moments; it stands when any of its quotes is found, and every found moment is shown.
            loose = goal is not None
            found = []
            if loose and len(b.get('cites') or []) > 1:
                for stamp, quote in b['cites']:
                    hit, _ = cite_any({'at': stamp, 'quote': quote}, lines)
                    if hit is not None and hit not in found: found.append(hit)
                if found and line is None: line, why = found[0], None
            # A next step the AI gave a minute but no quote (Ultra often does, 2026-10-12): it stands when its own words are
            # said within MEANING_W of that minute, by the same weighted-word check every other note gets. Goal notes only.
            if is_next and line is None and loose and weight is not None:
                given = ' '.join([str(b.get('at') or ''), *[str(c[0]) for c in b.get('cites') or []]])
                for m, sec in re.findall(r'(\d{1,3}):(\d{2})', given):
                    t = int(m) * 60 + int(sec)
                    if summary.meaning(text, lines, t, weight)[0] >= summary.MEANING_CUT:
                        line, why = min(lines, key=lambda l: abs(l['t'] - t)), None
                        break
            reasons = [] if line is not None else [why or 'not found']
            if line is not None and why and 'stamp moved' in why: counts['stamps_moved'] += 1
            # The meaning check (summary.meaning): the note's own words, not only its quote. A note whose words are said
            # elsewhere moves its stamp there; one whose words are said nowhere is marked. A next step still needs its quote.
            if weight is not None and (line is not None or not is_next):
                here, best, best_share = summary.meaning(text, lines, line['t'] if line is not None else None, weight)
                counts.setdefault('meaning', {'checked': 0, 'moved': 0, 'not_said': 0})['checked'] += 1
                if line is not None and here >= summary.MEANING_CUT: pass
                elif best is not None and best_share >= summary.MEANING_CUT:
                    was = transcript.stamp(line['t']) if line is not None else (b['at'] or '??:??')
                    why = f"stamp moved from {was} to {transcript.stamp(best['t'])}: the note's words are said there ({best_share:.2f})"
                    line, reasons = best, []
                    counts['stamps_moved'] += 1; counts['meaning']['moved'] += 1
                else:
                    reasons.append(f"the note's words are not said near its quote ({here:.2f}) or anywhere in the call ({best_share:.2f})")
                    counts['meaning']['not_said'] += 1
            if is_next and line is None and not loose:
                # the due gate, first half: an unverified step is dropped, never marked (an invented next step is the worst error)
                drops.append({'section': heading, 'text': text, 'at': b['at'] or '??:??', 'why': 'next step not verified: ' + reasons[0]}); continue
            after = None
            if is_next and is_class:
                # the class gate: the cited paragraph, or the step's quote and words when none was found (loose notes)
                stays, after = after_class(line['text'] if line is not None else f"{b['quote']} {text}")
                if not stays:
                    at = transcript.stamp(line['t']) if line is not None else (b['at'] or '??:??')
                    drops.append({'section': heading, 'text': text, 'at': at, 'why': f'next step in class: {after}'})
                    counts['in_class_dropped'].append({'text': text, 'at': at, 'why': after}); continue
            if is_next and not owner and re.search(r'\(\s*Speaker \d+\s*\)\s*$', text):
                text = re.sub(r'\s*\(\s*Speaker \d+\s*\)\s*$', '', text); owner = 'Team'; counts['label_owners'] = counts.get('label_owners', 0) + 1
            if LABEL.search(text): reasons.append('names a recording label, not a person')
            unknown = unknown_names(text + (f' {owner}' if owner else ''), vocab)
            if unknown: reasons.append('never said: ' + ', '.join(unknown)); counts['names_unknown'] += [u for u in unknown if u not in counts['names_unknown']]
            # A name said somewhere in the call is not enough: it must be said near the moment the note rests on. On the
            # Hilton meeting "2025 winner Richard" passed because "Richard" was said once, at 13:43, in an unrelated
            # line; the winner (Yiming, heard as "E Ming") was discussed at 28-37 min (2026-10-09). Goal notes only.
            if loose and line is not None:
                moments = found or [line]
                near = vocabulary([l for l in lines if any(abs(l['t'] - m['t']) <= summary.MEANING_W for m in moments)], event)
                near_lines = [l for l in lines if any(abs(l['t'] - m['t']) <= summary.MEANING_W for m in moments)]
                far = [w for w in dict.fromkeys(unknown_names(text, near) + far_names(text, lines, near_lines)) if w not in unknown]
                if far: reasons.append('named but not said near this moment: ' + ', '.join(far)); counts.setdefault('names_far', []).extend(far)
            style = summary.style_check(text)
            for rule, reason in style:
                counts['style'][rule] = counts['style'].get(rule, 0) + 1; counts['style_items'].append({'section': heading, 'text': text, 'rule': rule, 'reason': reason})
            at = transcript.stamp(line['t']) if line is not None else (b['at'] or '??:??')
            if len(found) > 1: at = ', '.join(transcript.stamp(l['t']) for l in sorted(found, key=lambda l: l['t']))
            record = {'section': heading, 'text': text, 'at': at, 'quote': b['quote'], 'backed': line is not None, 'why': why, 'reasons': reasons, 'owner': owner,
                      'style': [r for r, _ in style], 'line': f"[{transcript.stamp(line['t'])}] {line['who']}: {line['text']}" if line is not None else None,
                      **({'after_class': after} if after else {})}
            if is_next:
                # the purpose gate: a "so that" not traced to the goal or to what was said comes off the step
                p = SO_THAT.search(text)
                if p and loose and (line is None or not purpose_holds(p.group(1), goal, line['text'], lines, line['t'])):
                    reasons.append(f"its purpose ({p.group(1)}) is not in the goal or near what was said"); counts['purposes_dropped'].append({'text': text, 'tagged': p.group(0).strip(), 'at': at})
                elif p and not loose and not purpose_holds(p.group(1), goal, line['text'], lines, line['t']):
                    counts['purposes_dropped'].append({'text': text, 'removed': p.group(0).strip(), 'at': at}); text = text[:p.start()].rstrip(' ,'); record['text'] = text; record['purpose_dropped'] = p.group(0).strip()
                # the due gate, second half: a deadline the cited paragraph does not say is removed from the step, the step stays
                if loose:
                    # a day said the way people say it ("next Friday") gets its date from the call's date, by code
                    text, dated = absolute_dates(text, call_day(event)); record['text'] = text
                    if dated: counts.setdefault('dates_added', []).append(dated)
                elif (summary.WHEN.search(text) or summary.DUE_STRONG.search(text)) and not (summary.WHEN.search(line['text']) or summary.DUE.search(line['text'])):
                    new, gone = drop_deadline(text)
                    if gone: counts['deadlines_dropped'].append({'text': text, 'removed': gone, 'at': at}); text = new; record['text'] = new; record['deadline_dropped'] = gone
            out['bullets'].append({**b, 'text': text, 'at': at, 'owner': owner, 'backed': line is not None, 'reasons': reasons})
            checks.append(record)
        # A heading can name someone too ("2025 winner Richard", Hilton 2026-10-09): in goal notes it must be said near at
        # least one of its section's points, or the heading is marked like a point.
        if goal is not None and out['bullets']:
            moments = [l for c in checks if c['section'] == heading and c['line'] for l in lines if f"[{transcript.stamp(l['t'])}] {l['who']}: {l['text']}" == c['line']]
            near = vocabulary([l for l in lines if any(abs(l['t'] - m['t']) <= summary.MEANING_W for m in moments)], event) if moments else vocab
            near_lines = [l for l in lines if any(abs(l['t'] - m['t']) <= summary.MEANING_W for m in moments)] if moments else lines
            # far_names only: unknown_names read every Title Case heading word ("Hilton Financial Model") as a name, and
            # marked every heading of a 2026-10-09 Hilton run.
            far = list(dict.fromkeys(far_names(heading, lines, near_lines)))
            if far: out['heading'] = f"{heading} (not sure)"; counts.setdefault('names_far', []).extend(far)
        if out['bullets']: kept.append(out)
    return kept, checks, drops, counts

def render(sections, title, label, via='on Nebius Token Factory', covered=None, me=None, goal=None, deduced=None, one_mic_call=False):
    out = [f'# {title}', '', f'_summary by {label}, {via}; hikyaku checked it. Each bullet ends with the minute it came from; (not sure) marks one whose words were not found near that minute._', '']
    if goal: out += [f'For your goal: {goal}', '']
    if one_mic_call: out += [ONE_MIC_NOTE, '']
    if deduced: out += [f'This call: {deduced}', '']
    if covered: out += [f'{me or "You"} covered: {covered}', '']
    for sec in sections:
        out.append(f"## {sec['heading']}")
        for b in sec['bullets']:
            tag = f" ({b['owner']})" if sec['next'] and b['owner'] else ''
            out.append(f"{'  ' if b['level'] else ''}- {b['text']}{tag} [{b['at']}]" + ('' if b['backed'] and not b['reasons'] else ' (not sure)'))
        out.append('')
    return '\n'.join(out)

# ---------- the providers ----------

def nebius_key():
    # The Token Factory key, from the keychain, at request time. A missing key is a refusal that names where the key
    # belongs, never a value (and never security's own message, which can echo what was asked).
    service, account = KEYCHAIN
    try: proc = subprocess.run(['security', 'find-generic-password', '-s', service, '-a', account, '-w'], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired): proc = None
    key = proc.stdout.strip() if proc is not None and proc.returncode == 0 else ''
    if not key: refuse(f'refused: no Token Factory key in the keychain (service {service!r}, account {account!r}); add it there, then run again. Nothing was sent.')
    return key

def post(url, headers, body, on_text=None):
    # One HTTP POST: (status, reply bytes). An HTTP error is a status, not an exception; a dead network is an exit 1
    # that names the error's type only. With on_text the request streams (summary-live.md below) and the reply bytes are
    # put back in the non-streamed shape. Every request leaves through here, so a test that replaces post catches all.
    try:
        with urllib.request.urlopen(urllib.request.Request(url, body, headers, method='POST'), timeout=TIMEOUT) as r:
            return (r.status, read_stream(r, on_text)) if on_text else (r.status, r.read())
    except urllib.error.HTTPError as error: return error.code, error.read()
    except (urllib.error.URLError, OSError) as error: sys.exit(f'Token Factory not reachable ({type(error).__name__}); nothing written')
post.streams = True   # a replaced post (a test's trap or fake) answers plainly

# Paid once (same rule as Loggie's nebius.js): an answer that finished is saved under the hash of what was asked, and the
# same request again is answered from it for $0. The first "Request <hex>." line (the anti-cache line below) is not part
# of the key, so re-running the notes on a call nothing changed costs nothing; an edited prompt or a new transcript is
# a new key and is paid. Saved under <home>/nebius-answers/, the same folder Loggie uses.
ANSWERS_DIR = 'nebius-answers'
NONCE = re.compile(r'^Request [0-9a-f]+\.\n\n')
def answer_key(body):
    messages = [{'role': m.get('role'), 'content': NONCE.sub('', m['content']) if isinstance(m.get('content'), str) else m.get('content')} for m in body.get('messages', [])]
    asked = {'model': body.get('model'), 'messages': messages, 'max_tokens': body.get('max_tokens'), 'temperature': body.get('temperature'), 'chat_template_kwargs': body.get('chat_template_kwargs')}
    return hashlib.sha256(json.dumps(asked, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def answers_home():
    return Path(USAGE_HOME) / ANSWERS_DIR if USAGE_HOME is not None else None

# The notes are what the AI wrote (2026-10-12, Gio, comparing the streamed draft with the final on the Nebius x NVIDIA
# call: "the draft is so much cleaner ... and didnt get nebius wrong ... it regressed"). The goal passes (goal_notes.py)
# rewrote that call's 21 points with transcript quotes under them (bringing back the misheard "Nibius"), moved all 5
# next steps to "For later" (their role-or-getting question is for recruiting calls), and added a "More" section. Off:
# the final is the draft, and code only checks it (each point's minute, the not-sure marks, the prompt-shape drop).
# They took blind gradings against the rival app from 2 of 4 to 4 of 4 on 2026-10-09; turning them on again needs that
# test rerun (the blind eval folder in ~/Loggie/workspace) and a guard that keeps the draft's words.
GOAL_PASSES = False

# Summarize again (Loggie's button, 2026-10-12): --fresh asks again instead of answering from a saved answer. The user
# pressed it because they want a new write-up; it is paid like any first request.
FRESH = False

# The notes as they are written (2026-10-12, Gio: the notes should appear a couple of lines at a time, as the rival app writes them). Token Factory
# streams the reply; each piece is added to <call>/summary-live.md, which Loggie's page shows while the run is going.
# It is the model's draft, before the checks: the checked notes replace it, and the file is removed when the run ends.
LIVE_FILE = 'summary-live.md'
def live_writer(folder, every_s=0.15, now=time.time):
    path = Path(folder) / LIVE_FILE
    last = [0.0]
    def write(text, final=False):
        if not final and now() - last[0] < every_s: return
        last[0] = now()
        text = write.before + text   # a long call's earlier parts stay on the page while the next one is written
        if final and text and not text.endswith('\n'): text += '\n'   # the page shows whole lines; the last one is whole now
        tmp = path.with_suffix('.tmp')
        tmp.write_text(text); tmp.replace(path)
    write.path, write.before = path, ''
    return write

def read_stream(r, on_text):
    # The streamed reply, line by line ("data: {...}"): the content goes to on_text(text so far) and into one reply in
    # the non-streamed shape. The reasoning deltas are never kept.
    parts, last, finish = [], {}, None
    for raw in r:
        line = raw.decode('utf-8', 'replace').strip()
        if not line.startswith('data:'): continue
        data = line[5:].strip()
        if data == '[DONE]': break
        try: chunk = json.loads(data)
        except json.JSONDecodeError: continue
        last = {**last, **{k: chunk[k] for k in ('id', 'model', 'usage') if chunk.get(k)}}
        for choice in chunk.get('choices') or []:
            piece = (choice.get('delta') or {}).get('content')
            if piece: parts.append(piece); on_text(''.join(parts))
            finish = choice.get('finish_reason') or finish
    on_text(''.join(parts), final=True)
    return json.dumps({'id': last.get('id'), 'model': last.get('model'), 'usage': last.get('usage') or {},
                       'choices': [{'message': {'role': 'assistant', 'content': ''.join(parts)}, 'finish_reason': finish}]}).encode()

class Unanswered(SystemExit):
    # A request that came back with no answer to use (an empty reply, a stream cut off); `meta` keeps what it cost.
    def __init__(self, message, meta): super().__init__(message); self.meta = meta

def ask_nebius(prompt, key=None, transport=None, model=NEBIUS_MODEL, max_tokens=NEBIUS_MAX_TOKENS, what='call-notes', on_text=None, allow_length=False):
    # One call to Token Factory (spec-entry-b.md B5). Returns the reply text and meta (model, usage, cost_usd_reported,
    # duration_api_ms, seconds, auth, session_id, result_json), plus finish_reason and request_sha256 (the exact bytes sent). `transport(url, headers, body) -> (status, bytes)` is the
    # HTTP POST; tests pass a fake. The reply's reasoning fields are dropped before anything is kept.
    key = key or nebius_key()
    scrub = lambda text: str(text).replace(key, '[key]')
    # Thinking off: with it on, Nemotron spends the budget reasoning and returns nothing (spike R1, 2026-10-07; the Hilton
    # readouts summary stopped at 6000 tokens). Same switch as Loggie's nebius.js.
    asked = {'model': model, 'messages': [{'role': 'user', 'content': prompt}], 'max_tokens': max_tokens, 'temperature': 0,
             'chat_template_kwargs': {'enable_thinking': False}}
    body = json.dumps(asked).encode()
    saved_file = answers_home() / f'{answer_key(asked)}.json' if answers_home() is not None else None
    if saved_file is not None and saved_file.exists() and not FRESH:
        saved = json.loads(saved_file.read_text())
        if on_text: on_text(saved['content'], final=True)
        record_usage(what, saved['model'], saved.get('usage', {}), 0, saved.get('finish_reason'), cached=True)
        return saved['content'], {'model': saved['model'], 'usage': saved.get('usage', {}), 'cost_usd_reported': 0.0, 'duration_api_ms': None, 'seconds': 0,
                                  'auth': {'keychain_service': KEYCHAIN[0], 'keychain_account': KEYCHAIN[1]}, 'session_id': saved.get('session_id'),
                                  'finish_reason': saved.get('finish_reason'), 'request_sha256': hashlib.sha256(body).hexdigest(), 'cached': True}
    t0 = time.time()
    headers = {'Authorization': f'Bearer {key}', 'content-type': 'application/json'}
    streamed = bool(on_text and transport is None and getattr(post, 'streams', False))
    if streamed:
        streamed = json.dumps({**asked, 'stream': True, 'stream_options': {'include_usage': True}}).encode()
        status, raw = post(f'{NEBIUS_BASE}/chat/completions', headers, streamed, on_text=on_text)
    else: status, raw = (transport or post)(f'{NEBIUS_BASE}/chat/completions', headers, body)
    seconds = round(time.time() - t0, 1)
    text = raw.decode('utf-8', 'replace') if isinstance(raw, bytes) else str(raw)
    if status != 200: sys.exit(f'Token Factory answered HTTP {status}: {scrub(text[:400])}; nothing written')
    try: result = json.loads(text)
    except json.JSONDecodeError: sys.exit(f'Token Factory did not answer in JSON: {scrub(text[:400])}; nothing written')
    choice = (result.get('choices') or [{}])[0]
    message = {k: v for k, v in (choice.get('message') or {}).items() if k not in ('reasoning_content', 'reasoning')}
    result = {**result, 'choices': [{**choice, 'message': message}]}
    replied = str(result.get('model') or '')
    record_usage(what, replied, result.get('usage', {}), seconds, choice.get('finish_reason'))
    if not replied.startswith('nvidia/'): refuse(f'refused: the reply came from {scrub(replied)!r}, not an NVIDIA model; nothing written')
    # allow_length: the merge of a long call's parts sees a cut answer and asks again with more room (ask_in_parts).
    if choice.get('finish_reason') == 'length' and not allow_length: sys.exit(f'Token Factory stopped at the token limit (finish_reason length, max_tokens {max_tokens}); nothing written')
    content = str(message.get('content') or '').lstrip()
    meta = {'model': replied, 'usage': result.get('usage', {}), 'cost_usd_reported': None, 'duration_api_ms': None, 'seconds': seconds,
            'auth': {'keychain_service': KEYCHAIN[0], 'keychain_account': KEYCHAIN[1]}, 'session_id': result.get('id'), 'result_json': result,
            'finish_reason': choice.get('finish_reason'), 'request_sha256': hashlib.sha256(body).hexdigest()}
    # A stream that ends without a finish_reason was cut off on the way (Codex review, 2026-10-23: one stamped bullet,
    # then the end, passed as a whole merge), and an empty reply is no answer; both are Unanswered, which a long call's
    # parts and merge ask again and anything else stops on. An empty merge cut at its limit goes back to be asked larger.
    if streamed and choice.get('finish_reason') is None: raise Unanswered("Token Factory's stream ended before the answer finished (no finish_reason); nothing written", meta)
    if not content.strip() and not (allow_length and choice.get('finish_reason') == 'length'):
        raise Unanswered(f"Token Factory returned an empty reply (finish_reason {choice.get('finish_reason')}); nothing written", meta)
    if saved_file is not None and choice.get('finish_reason') == 'stop':
        saved_file.parent.mkdir(parents=True, exist_ok=True)
        saved_file.write_text(json.dumps({'at': datetime.now().astimezone().isoformat(timespec='seconds'), 'model': replied, 'content': content,
                                          'usage': result.get('usage', {}), 'finish_reason': 'stop', 'session_id': result.get('id')}) + '\n')
    return content, meta

# ---------- where each point came from ----------
# Click a point to see where it came from (2026-10-12, Gio, after the rival app's "Transcript summary" popover: "we need to be
# better"). After the notes are written, one request asks the AI, for every point, how it came up in the call (a short
# context) and for the words that show it; for a point the checks could not confirm, whether the call supports it. It
# reads the screened outbound copy the yes covered, never transcript.md. Code then checks every quote against the
# transcript and shows the whole sentence it sits in, with who said it and when; a context with no quote found is
# dropped, so nothing shown is unbacked. The AI only explains: it never rewrites a point or clears its mark (a second
# pass that rewrote the draft is what made the notes regress, 2026-10-12).
EXPLAIN_FILE = '{stem}-explain.json'

def explain_prompt(items, sent_lines, me='the user'):
    points = []
    for k, c in enumerate(items):
        flagged = not c['backed'] or c['reasons']
        # No minute and no checker reason go in: given them, Ultra judged where a point was said rather than whether it
        # was ("Tabily is not said near 18:17", 7 of 9 flagged points on 2026-10-12). The quotes bring their minutes back.
        points.append(f"{k + 1}. [{c['section']}] {c['text']}{' (' + c['owner'] + ')' if c.get('owner') else ''}" + (' FLAGGED' if flagged else ''))
    said = '\n'.join(f"[{transcript.stamp(l['t'])}] {l['who']}: {l['text']}" for l in sent_lines)
    # Measured on the Nebius x NVIDIA call (2026-10-12): asked only for "how it came up", Ultra restated each point ("The
    # speaker notes X") and never said whether a flagged one holds. The context must add what the point does not say.
    return (f"Below are a call's transcript and the points of its notes. \"Me\" in the transcript is {me}; \"Them\" is the other side "
            "of the call (use a name only when the transcript says who it is). A FLAGGED point is one an automatic checker could not "
            "confirm. For each point give:\n"
            "- \"context\": one or two sentences, under 45 words, that add what the point does not say: what was being discussed "
            "when it came up, what prompted it, and the reason or detail a speaker gave. Never restate the point, and never open with "
            "\"The speaker notes\", \"emphasizes\" or \"mentions\". Write it like: \"This came up while reviewing the current UI; "
            f"{me} wanted it working before polish, because judges will run the app themselves.\"\n"
            "- \"holds\", for a FLAGGED point only: \"yes\" when the transcript says it, \"partly\" when part of it is said, \"no\" when it is "
            "not said anywhere in the transcript; and \"instead\": for partly or no, one short sentence on what "
            "was actually said about it (the words and facts, never the minutes).\n"
            "- \"quotes\": the one or two transcript passages that most directly say the point (where the decision, number or name is "
            "said, not filler), each 8 to 25 words copied exactly, with \"at\": the minute of its line.\n"
            "If nothing in the transcript speaks to a point, give \"context\": \"\", \"holds\": \"no\" and \"quotes\": [].\n"
            'Answer with JSON only: {"points": [{"n": 1, "context": "...", "holds": "partly", "instead": "...", "quotes": [{"text": "...", "at": "mm:ss"}]}]}\n\n'
            f"<transcript>\n{said}\n</transcript>\n\nPoints:\n" + '\n'.join(points))

def excerpt(line, quote, most=45):
    # The sentence(s) of the transcript line that hold the quote, so a reader sees what was said, not a fragment: from the
    # sentence the quote starts in, whole sentences up to `most` words. "(unclear)" marks come off; "Me" reads "You".
    text = line.get('bare') or line['text']
    sentences = [x for x in re.split(r'(?<=[.!?])\s+', text) if x.strip()]
    key = summary.norm(quote).split()[:3]
    start = next((i for i, x in enumerate(sentences) if key and ' '.join(key) in summary.norm(x)), None)
    if start is None: start = next((i for i, x in enumerate(sentences) if key and key[0] in summary.norm(x).split()), 0)
    out = []
    for x in sentences[start:]:
        if out and len(' '.join(out + [x]).split()) > most: break
        out.append(x)
    shown = ' '.join(out) or text
    if len(shown.split()) > most: shown = ' '.join(shown.split()[:most]) + '…'
    who = 'You' if re.fullmatch(r'me', line['who'].strip(), re.I) else line['who']
    return {'text': shown, 'who': who, 'at': transcript.stamp(line['t'])}

def explain_points(items, sent_lines, lines, ask, me='the user'):
    # One request for every point. Returns [{text, section, flagged, context, said: [{text, who, at}]}]: only quotes found
    # in the transcript are kept, each shown as its whole sentence; a context with none of its quotes found is dropped.
    import goal_notes
    reply, meta = ask(f"Request {os.urandom(4).hex()}.\n\n{explain_prompt(items, sent_lines, me)}")
    answers = {int(x['n']): x for x in goal_notes.listed(reply, 'points')}
    out = []
    for k, c in enumerate(items):
        a = answers.get(k + 1) or {}
        said, seen = [], set()
        for q in (a.get('quotes') or [])[:2]:
            if not isinstance(q, dict) or not str(q.get('text') or '').strip(): continue
            line = cite_any({'at': str(q.get('at') or c.get('at') or ''), 'quote': str(q['text'])}, lines)[0]
            if line is None or line['t'] in seen: continue
            seen.add(line['t']); said.append(excerpt(line, str(q['text'])))
        flagged = bool(not c['backed'] or c['reasons'])
        context = str(a.get('context') or '').strip() if said else ''
        holds = str(a.get('holds') or '').strip().lower() if flagged and said else ''
        holds = holds if holds in ('yes', 'partly', 'no') else ''
        instead = str(a.get('instead') or '').strip() if holds in ('partly', 'no') else ''
        out.append({'text': c['text'], 'section': c['section'], 'flagged': flagged, 'holds': holds, 'instead': instead, 'context': context, 'said': said})
    return out, meta

def explain_later(folder, provider='nebius', approved=None, ask=None, screen=None):
    # The same explanations for notes written before they existed, or whose request failed (Loggie asks on the first
    # click on a point, 2026-10-12). They come from the outbound copy the user's yes covered for those
    # notes: with --approved, a copy screened again since (a transcript edit) is a refusal, and the page says to
    # summarize again. Nothing in the notes changes; <stem>-explain.json is written beside them.
    known_provider(provider)
    folder = Path(folder).resolve()
    global USAGE_HOME
    USAGE_HOME = next((p.parent for p in [folder, *folder.parents] if p.name == 'calls'), None)
    runs = json.loads((folder / 'summary-runs.json').read_text()) if (folder / 'summary-runs.json').exists() else []
    run_ = next((r for r in reversed(runs) if r.get('output') and (folder / r['output']).exists() and (folder / r['output']).read_text().strip()), None)
    if run_ is None: sys.exit('no notes to explain in this call')
    points = run_.get('checks') or []
    target = folder / EXPLAIN_FILE.format(stem=Path(run_['output']).stem)
    if not points: target.write_text(json.dumps({'output': run_['output'], 'lines': []}) + '\n'); return target
    approval(folder, provider, approved, False)
    if ask is None:
        key = nebius_key()
        ask = lambda p: ask_nebius(p, key, model=NEBIUS_TEAM_MODEL, what='call-explain')
    out_md, _, held = screened(folder, screen)
    # A class: the points carry labels (summary-runs.json); the map is the pair's the notes came from, else the newest.
    held_named = folder / ((run_.get('privacy') or {}).get('held_file') or '')
    map_of = json.loads(held_named.read_text()) if held_named.is_file() else held
    classmates = map_of.get('names') if summary.kind_of(summary.event_of(folder)) == 'class' else None
    trimmed = map_of.get('trimmed') if isinstance(map_of.get('trimmed'), dict) else None
    t1 = time.time()
    explained, _ = explain_points(points, read_md(out_md), trimmed_lines(spelled_lines(read_md(folder / 'transcript.md'), map_of.get('spelled')), trimmed), ask, me=summary.names_for(summary.event_of(folder)).get('me') or 'the user')
    if isinstance(classmates, dict): explained = privacy.relabel_record(explained, classmates)
    if trimmed is not None: explained = privacy.relabel_record(explained, trimmed)
    target.write_text(json.dumps({'output': run_['output'], 'seconds': round(time.time() - t1, 1), 'later': True, 'lines': explained}, indent=1, ensure_ascii=False))
    print(f"{target.name}: {sum(1 for x in explained if x['context'])} of {len(explained)} points explained")
    return target

# ---------- the command ----------

def refuse_if_private(event):
    kind = str(summary.kind_of(event)).lower()
    title = str(event.get('title', '')).lower()
    hit = next((p for p in PRIVATE if p in kind or re.search(rf'\b{p}\b', title)), None)
    if event.get('private'): refuse('refused: event.json marks this call private; its words stay on the Mac')
    if hit: refuse(f'refused: a {hit} call carries health or employment data (category {kind!r}); its words stay on the Mac')

def refuse(msg):
    # Exit 2, the message on stderr: the words did not leave the Mac and the caller can tell a refusal from a crash (1).
    print(msg, file=sys.stderr); raise SystemExit(2)

def outbound_state(folder):
    # The newest outbound.md/held.json pair and whether it is current: 'fresh' (newer than transcript.md, with its
    # held.json), 'stale' (older than transcript.md, or its held.json is gone) or 'missing'.
    out_md, held = privacy.latest_pair(folder)
    if out_md is None: return None, None, 'missing'
    if held is None or out_md.stat().st_mtime < (folder / 'transcript.md').stat().st_mtime: return out_md, held, 'stale'
    return out_md, held, 'fresh'

def screened(folder, screen=None):
    # outbound.md to send, screening first when the pair is missing or stale. `screen(folder)` runs privacy.py's
    # screen and returns (outbound, held_json, record); tests pass a fake. A screen that fails (SystemExit: no local
    # model) is a refusal: exit 2, nothing sent.
    out_md, held, state = outbound_state(folder)
    if state != 'fresh':
        try: out_md, held, _ = (screen or privacy.screen_folder)(folder)
        except SystemExit as error: refuse(f'refused: the privacy screen did not run ({error}); transcript.md is never sent unscreened')
    record = json.loads(held.read_text())
    return out_md, held, record

def approved_notes_of(folder, approved_notes):
    # The screened notes' lines when the user's yes covered them (their sha256 matches), else none: notes are never sent
    # without the yes. A hash given for notes that changed refuses, like a changed outbound.md.
    if not approved_notes: return []
    pair = privacy.notes_pair(folder)
    if not pair or hashlib.sha256(pair[0].read_bytes()).hexdigest() != approved_notes:
        refuse('refused: your notes changed since you reviewed them. Review again and press Send. Nothing was sent.')
    return privacy.notes_lines(pair[0].read_text())

def unscreened_pages(folder):
    import pages as page_files
    return bool(page_files.capped(page_files.pages_of(privacy.pages_home(folder))))

def approved_pages_of(folder, approved_pages):
    # The screened pages when the yes covered them (their sha256 matches), else none, as approved_notes_of.
    if not approved_pages: return []
    pair = privacy.pages_pair(folder)
    if not pair or hashlib.sha256(pair[0].read_bytes()).hexdigest() != approved_pages:
        refuse('refused: the pages tucked into this call changed since you reviewed them. Review again and press Send. Nothing was sent.')
    return privacy.pages_lines(pair[0].read_text())

def known_provider(provider):
    # Fail closed (B7 D1, B8): nebius is the only AI the notes go to. Any other name, an old pick in a call folder, a
    # pending send or settings.json "frontier", reads as not approved: exit 2 before the key, the screen or a byte is read.
    if provider not in PROVIDERS:
        refuse(f'refused: {provider!r} is not approved; the notes go only to Nemotron on Nebius. Pick it and press Send in Loggie. Nothing was sent.')

def approval(folder, provider, approved, dry_run):
    # The send gate's check, before the key, the screen or a byte of the prompt: a send needs the user's yes, and a yes
    # is for the exact outbound.md that was reviewed (fresh, so byo.py will not screen again, and the same bytes).
    known_provider(provider)
    if dry_run: return
    if not approved:
        refuse('refused: nothing goes to the cloud until you pick an AI and press Send. Review outbound.md, then send it from Loggie '
               '(loggie send <run> --with nebius). Nothing was sent.')
    if approved:
        out_md, _, state = outbound_state(folder)
        if state != 'fresh' or hashlib.sha256(out_md.read_bytes()).hexdigest() != approved:
            refuse('refused: what would leave your Mac changed since you reviewed it (outbound.md is new or was screened again). '
                   'Review it again and press Send. Nothing was sent.')

def run(folder, provider='nebius', dry_run=False, ask=None, template=None, screen=None, approved=None, file_ask=None, approved_notes=None, explain_ask=None, approved_pages=None):
    # The whole feature: read, refuse or build, screen, send once, check, write new files, record the run. `ask` is the
    # model call (prompt) -> (text, meta) and `screen` the privacy screen; tests pass fakes, nothing else does.
    # `approved` is the sha256 of the reviewed outbound.md (the send gate); byo.py refuses without it.
    # `file_ask` names and files the call first (file_call); production builds it from the provider, tests that pass
    # their own `ask` file nothing unless they pass one too.
    known_provider(provider)
    folder = Path(folder).resolve()
    global USAGE_HOME
    USAGE_HOME = next((p.parent for p in [folder, *folder.parents] if p.name == 'calls'), None)
    md = folder / 'transcript.md'
    if not md.exists(): sys.exit(f'no transcript.md in {folder}')
    event = with_my_name(summary.event_of(folder))
    event = {**event, 'goal': goal_of(event, folder)}   # the goal prompt only when the call's workstream has a goal (prompt_file_for)
    refuse_if_private(event)
    approval(folder, provider, approved, dry_run)
    notes = [] if dry_run else approved_notes_of(folder, approved_notes)
    pages = [] if dry_run else approved_pages_of(folder, approved_pages)
    # A page with words and no yes for it (loggie-pages-anytime: tucked in after the send was screened) is refused out
    # loud, never left out without a word: the notes would read as if the page had been seen.
    if not dry_run and not approved_pages and unscreened_pages(folder):
        refuse('refused: a page was tucked into this call after it was screened. Press Summarize again to screen it with the call. Nothing was sent.')
    lines = read_md(md)
    if not lines: sys.exit(f'{md} has no stamped turns')
    template_given = template is not None
    template = template if template_given else prompt_text(event)
    title = event.get('title', 'Call')
    if dry_run:
        # A dry run writes nothing, so it does not run the screen either: it says what it would send and, when the
        # pair is fresh, how much of it is held.
        out_md, held, state = outbound_state(folder)
        sent_lines = read_md(out_md) if state == 'fresh' else lines
        classmates = json.loads(held.read_text()).get('names') if state == 'fresh' and summary.kind_of(event) == 'class' else None
        trimmed = json.loads(held.read_text()).get('trimmed') if state == 'fresh' else None
        trimmed = trimmed if isinstance(trimmed, dict) else None
        plan = plan_prompts(privacy.trim_event(event, trimmed), sent_lines, folder, template, (), classmates if isinstance(classmates, dict) else None)
        prompt = plan[0]['prompt']
        # The prompt without its turns (the goal prompt keeps them inside <transcript>, not after "TRANSCRIPT:"), so a dry run
        # never prints what was said.
        head = prompt.split('TRANSCRIPT:', 1)[0] if 'TRANSCRIPT:' in prompt else '\n'.join(l for l in prompt.splitlines() if not re.match(r'^\[\d+:\d\d\]', l)) + '\n'
        print(f"DRY RUN: nothing sent. Provider nebius: POST {NEBIUS_BASE}/chat/completions, model {notes_model(event)}, max_tokens {NEBIUS_MAX_TOKENS}, key from the keychain (service {KEYCHAIN[0]!r}, account {KEYCHAIN[1]!r}), no tools.")
        headings, bullets = shape_for(span_of(sent_lines))
        print(f"Shape asked for {round(span_of(sent_lines) / 60)} minutes: about {headings} headings and {bullets} bullets, every part of the call in order.")
        if len(plan) > 1:
            print(f"Long call: {len(plan)} parts, one request each, then one merge request ({MERGE_PROMPT_FILE.name}): "
                  + ', '.join(f"part {p['part']} {p['from']} to {p['to']} ({p['turns']} turns, {len(p['prompt'])} chars)" for p in plan) + '. The prompt below is part 1.')
        if state == 'fresh':
            c = json.loads(held.read_text())['counts']
            people = (c.get('trimmed') or {}).get('people') or 0
            print(f"Would send {out_md.name} (screened on this Mac by code: {c['held']} of {c['sentences']} sentences held"
                  + (f", {people} {'person' if people == 1 else 'people'} by first name only" if people else '') + f"; {held.name}), never transcript.md.")
        else: print(f"Would run the privacy screen first ({'no outbound.md yet' if state == 'missing' else out_md.name + ' is older than transcript.md'}) and send the new outbound.md, never transcript.md; a screen that cannot run means no send.")
        print(f"Prompt {len(prompt)} chars, {len(prompt.split())} words (about {len(prompt) // 4} tokens): template {prompt_file_for(event).name} {prompt_hash(template)} {len(head)} chars + transcript {len(sent_lines)} turns {len(prompt) - len(head)} chars from {out_md if state == 'fresh' else 'the outbound.md the screen would write'}.")
        print(f"Event: title {title!r}, me {event.get('me')!r}, with {event.get('with') or event.get('names')!r}, category {summary.kind_of(event)!r}.")
        filing = 'no: ' + ('named by hand' if event.get('relabeled') else 'filed already') if event.get('relabeled') or event.get('filed') else f'yes, one {FILE_MAX_TOKENS}-token request to {NEBIUS_MODEL} first, with your workstream names and goals'
        print(f"Filing (title and workstream from what was said): {filing}.")
        print('--- prompt as it would be sent, transcript collapsed ---')
        part_lines = plan[0]['lines']
        print(head + f'TRANSCRIPT:\n[... {len(part_lines)} turns, {len(prompt) - len(head)} chars, {transcript.stamp(part_lines[0]["t"])} to {transcript.stamp(part_lines[-1]["t"])} ...]')
        return None, None
    pass_ask, live, merge_ask = None, None, None
    if ask is None:
        key = nebius_key()   # before the screen: a missing key refuses with nothing written
        # Goal notes run on Nemotron 3 Ultra too (2026-10-09: with the goal prompt it beat the rival app in 4 of 4 blind gradings
        # on the Liz and Hilton calls, where Super lost 10 of 10). About 1 to 1.5 cents a call. Chosen at send time, after
        # filing may have given the call its workstream and goal.
        live = live_writer(folder)
        ask = lambda p: ask_nebius(p, key, model=notes_model(event), on_text=live)
        file_ask = lambda p: ask_nebius(p, key, max_tokens=FILE_MAX_TOKENS, what='call-filing')
        pass_ask = lambda p: ask_nebius(p, key, model=notes_model(event))
        explain_ask = lambda p: ask_nebius(p, key, model=NEBIUS_TEAM_MODEL, what='call-explain')
        merge_ask = lambda p, n: ask_nebius(p, key, model=notes_model(event), max_tokens=n, on_text=live, allow_length=True)
    out_md, held_file, held = screened(folder, screen)
    classmates = classmates_of(event, held)
    trimmed = trimmed_of(event, held)
    if trimmed:
        # The last guard, at the send: whatever a request carries (a part's reply fed back to the merge, a retry, the
        # explanations), every surname form goes by its first name before it leaves.
        guard = lambda send: None if send is None else (lambda prompt, *rest: send(privacy.relabel(prompt, trimmed), *rest))
        ask, merge_ask, pass_ask, explain_ask, file_ask = map(guard, (ask, merge_ask, pass_ask, explain_ask, file_ask))
    sent_lines = read_md(out_md)
    if not sent_lines: sys.exit(f'{out_md} has no stamped turns')
    # A trimmed call: transcript.md's lines by first name from here on (the quotes are checked against them, and what the
    # check, the run record and the explanations write back holds no surname); prompts get the event by first name too.
    lines = trimmed_lines(spelled_lines(lines, held.get('spelled')), trimmed)
    filing = None
    if file_ask is not None:
        event, filing = file_call(folder, event, lines, sent_lines, file_ask, masked=classmates is not None, trimmed=trimmed)
        event = {**event, 'goal': goal_of(event, folder)}
        refuse_if_private(event)   # a name from the words can say what the calendar did not
        classmates = classmates_of(event, held)   # a title with a course code makes a class
        if trimmed is None:
            trimmed = trimmed_of(event, held)   # a title naming an interview trims: refused when its pair did not
        title = event.get('title', 'Call')
        if not template_given: template = prompt_text(event)
    sent_event = privacy.trim_event(event, trimmed)   # what the prompts say of the call: title and people by first name
    plan = plan_prompts(sent_event, sent_lines, folder, template, notes, classmates, pages)
    ultra = notes_model(event) == NEBIUS_TEAM_MODEL
    # Nebius's prompt cache breaks Nemotron 3 Ultra: on 2026-10-08 the same Hilton prompt answered well with no cache
    # hit and, resent with 8704 cached tokens, stopped early with "<|message_end|>" and no Next Steps, every time.
    # A first line that differs per request means no cached prefix.
    nonce = lambda text: f"Request {os.urandom(4).hex()}.\n\n{text}" if ultra else text
    for p in plan: p['prompt'] = nonce(p['prompt'])
    prompt = plan[0]['prompt'] if len(plan) == 1 else '\n\n'.join(p['prompt'] for p in plan)   # what crossed, made from the call
    out = summary.claim(folder, output_of(provider), '.md')
    # A run that ends without writing (a refusal, a failed request, a crash) leaves no empty notes file behind.
    atexit.register(lambda: out.exists() and out.stat().st_size == 0 and out.unlink())
    raw_dir = Path(tempfile.mkdtemp(prefix='byo-raw-'))   # a run that dies leaves nothing in the calls folder
    (raw_dir / 'prompt.txt').write_text(prompt)
    # The draft file exists from here until the checked notes are written, empty until the first line: the page shows the
    # notes being written while it exists (a provider that does not stream shows its placeholder bars there).
    (folder / LIVE_FILE).write_text('')
    atexit.register(lambda: (folder / LIVE_FILE).unlink(missing_ok=True))
    print(f"{provider}: {out_md.name}, {len(sent_lines)} turns, {len(prompt)} chars, {held['counts']['held']} of {held['counts']['sentences']} sentences kept on this Mac; sending...")
    # outbound.sent, right before the prompt leaves: what goes, how much, and where its copy is kept (the raw folder).
    # sha256, chars and bytes are of the prompt text, the part of the request made from the call.
    folder_name = folder.parent.name if folder.name.startswith('v') and folder.name[1:2].isdigit() else folder.name
    tell('outbound.sent', 'ask', 'Sending what you reviewed', {'what': 'call-notes', 'source_ids': [f'call:{folder_name}'], 'sentences_sent': held['counts']['sent'],
         'sentences_kept': held['counts']['held'], 'chars': len(prompt), 'bytes': len(prompt.encode()), 'sha256': hashlib.sha256(prompt.encode()).hexdigest(),
         'receipt': str(folder / f'{out.stem}-raw' / 'prompt.txt'), 'destination': 'cloud', 'provider_id': PROVIDER_IDS[provider]})
    t_all = time.time()
    chunks = None
    try:
        if len(plan) > 1: reply, meta, chunks = ask_in_parts(plan, sent_event, sent_lines, folder, ask, classmates, nonce, live, raw_dir, merge_ask)
        else: reply, meta = ask(prompt)
        # Every retry below changes the question, not only its first line: the saved answer is keyed without that line,
        # so a resent prompt came back as the same saved failure for $0 (Codex review, 2026-10-23).
        again = lambda said: nonce(f"{NONCE.sub('', prompt)}\n\n{said}")
        # A class in one pass gets the parts' guard (Codex review, 2026-10-23: a 30-minute class answering only
        # "<|message_end|>" was saved as zero bullets and a successful run): asked once more, then nothing written.
        if chunks is None and summary.kind_of(event) == 'class' and not usable(reply):
            print('the class notes came back with no usable notes; asking once more...')
            reply, meta = ask(again('The first answer held no notes; write them now.'))
            if not usable(reply): sys.exit('the class notes came back with no usable notes twice; nothing written')
        # Nemotron 3 Ultra sometimes stops early and leaks a control token ("<|message_end|>", 2026-10-08, 1 of 4 runs on
        # the Hilton call, no Next Steps at all). A team readout without Next Steps, or with a control token, is asked once
        # more; the second answer stands, checked like any other, unless it holds no usable notes either.
        if chunks is None and is_team(event) and (BROKEN.search(reply) or not re.search(r'^##\s+Next Steps?\s*$', reply, re.M | re.I)):
            print('the answer came back cut short; asking once more...')
            reply, meta = ask(again('The first answer stopped early, before its Next Steps; write the whole readout now.'))
            if not usable(reply): sys.exit('the team readout came back cut short twice; nothing written')
        # Ultra sometimes answers with the transcript repeated instead of notes (3 of about 12 Liz runs, 2026-10-09): no
        # section, or many lines that are not notes, is asked once more.
        # Each retry gets a fresh "Request" line: resent unchanged, the prompt hits Nebius's cache, which is what breaks
        # Ultra (above); on 2026-10-09 an unchanged retry repeated the transcript again and the notes came out empty. After
        # two retries the run refuses rather than writing empty notes.
        for attempt in (1, 2):
            if not (chunks is None and event.get('goal') and (not parse_reply(reply)[0] or len(parse_reply(reply)[1]) > 20)): break
            print(f'the answer was the transcript again; asking again ({attempt} of 2)...')
            reply, meta = ask(again(('The first answer' if attempt == 1 else 'The first two answers') + ' repeated the transcript instead of writing notes; write the notes now, in the shape asked for above.'))
        if event.get('goal') and not parse_reply(reply)[0]:
            refuse('refused: Nebius answered with the transcript instead of notes three times; nothing was written. Send again later.')
    except BaseException:
        shutil.rmtree(raw_dir, ignore_errors=True)   # a refused reply leaves no copy of the prompt behind either
        (folder / LIVE_FILE).unlink(missing_ok=True)
        if out.exists() and out.stat().st_size == 0: out.unlink()
        tell('outbound.returned', 'ask', 'No answer came back', {'what': 'call-notes', 'ok': False, 'seconds': round(time.time() - t_all, 1), 'finish_reason': None, 'tokens': None})
        raise
    seconds_model = round(time.time() - t_all, 1)
    tell('outbound.returned', 'ask', 'The answer came back', {'what': 'call-notes', 'ok': True, 'seconds': seconds_model, 'finish_reason': meta.get('finish_reason'), 'tokens': tokens_of(meta.get('usage'))})
    (raw_dir / 'reply.md').write_text(reply)
    (raw_dir / 'result.json').write_text(json.dumps(meta.get('result_json', meta), indent=1, default=str))
    t0 = time.time()
    # A masked class: the reply carries Student N; the names go back in on this Mac before the check (its quotes cite
    # transcript.md, where the names are), and the labels go back in before anything is written or explained.
    # reply.md and prompt.txt keep the labels: they are the receipt of what crossed.
    named = privacy.unmask(unmask_quotes(reply, classmates, lines), classmates) if classmates is not None else reply
    sections, stray = parse_reply(named)
    passes = None
    if GOAL_PASSES and event.get('goal') and classmates is None and trimmed is None:   # the passes send the sections and invitee names: never a class's or a trimmed call's
        # The goal passes (goal_notes.py: shape, goal-only lines, step timing, heading names, repeats, length budget) took
        # blind gradings against the rival app from 2 of 4 to 4 of 4 (r10d, 2026-10-09). They read sent_lines, the screened copy,
        # never lines: the timing check they replace quoted the full transcript into its call, and a scratch run of the
        # step check sent a held health sentence to Nebius (Liz call, 30:52).
        known = (lexicon.my_words(), lexicon.invitee_names(event))   # names the user taught, then the invitees
        event = {**event, 'one_mic': one_mic(sent_lines)}
        passes, pass_metas = goal_notes.run_all(sections, sent_lines, event, lambda p: (pass_ask or ask)(f"Request {os.urandom(4).hex()}.\n\n{p}"), far_names, known=known)
        print(f"goal passes: {json.dumps(passes, ensure_ascii=False)[:600]}")
        if pass_metas:   # the cost line counts every call the notes took, not the first one only
            meta = {**meta, 'usage': {**(meta.get('usage') or {}), **{k: sum((m.get('usage') or {}).get(k) or 0 for m in [meta, *pass_metas]) for k in ('prompt_tokens', 'completion_tokens')}},
                    'seconds': round(sum(m.get('seconds') or 0 for m in [meta, *pass_metas]), 1), 'calls': 1 + len(pass_metas)}
    # Word weights for the meaning check, from every transcript of the user's calls (summary.word_weights).
    calls_dir = next((p for p in [folder, *folder.parents] if p.name == 'calls'), None)
    weight = summary.word_weights([p.read_text() for p in sorted(calls_dir.glob('*/transcript.md')) + sorted(calls_dir.glob('*/*/transcript.md'))]) if calls_dir else None
    kept, checks, drops, counts = check(sections, lines, event, template, weight=weight, goal=event.get('goal'))
    me = summary.names_for(event).get('me')
    covered = covered_of(named, me) if event.get('goal') and not one_mic(sent_lines) else None   # on one mic, what "I" said is not known to be the recorder's
    deduced = deduced_of(named) if event.get('goal') else None
    counts['meaning'] = counts.get('meaning') or ('off: fewer than %d call transcripts' % summary.MEANING_MIN_CALLS if weight is None else {'checked': 0, 'moved': 0, 'not_said': 0})
    label = meta.get('model', provider)
    text = render(kept, title, label, covered=covered, me=me, goal=event.get('goal'), deduced=deduced, one_mic_call=one_mic(sent_lines))
    text = text.rstrip('\n') + '\n' + usage_line(meta.get('model'), meta.get('usage'), meta.get('seconds'), meta.get('calls') or 1)
    if classmates is not None: text = privacy.relabel(text, classmates)   # the file keeps labels; names come back at display
    if trimmed is not None: text = privacy.relabel(text, trimmed)   # the title line too: six later readers send the notes file on
    seconds_check = round(time.time() - t0, 3)
    out.write_text(text)
    (folder / LIVE_FILE).unlink(missing_ok=True)   # the checked notes replace the draft
    shutil.copytree(raw_dir, folder / f'{out.stem}-raw'); shutil.rmtree(raw_dir)
    backed = sum(c['backed'] for c in checks)
    why = {}
    for c in checks:
        for r in c['reasons']: why[r.split('; ')[-1]] = why.get(r.split('; ')[-1], 0) + 1
    next_steps = [c for c in checks if NEXT.match(c['section'])]
    tell('check.result', 'check', f'{backed} of {len(checks)} notes found in your call', {'bullets': len(checks), 'verified': backed, 'not_sure': len(checks) - backed,
         'dropped': len(drops), 'next_steps_kept': len(next_steps), 'deadlines_dropped': len(counts['deadlines_dropped']), 'in_class_dropped': len(counts['in_class_dropped'])})
    run_ = {'created': datetime.now().astimezone().isoformat(timespec='seconds'), 'provider': provider, 'model': meta.get('model'), 'label': label, 'auth': meta.get('auth') or {},
            'command': f'POST {NEBIUS_BASE}/chat/completions', 'isolation': 'outbound.md only, no tools',
            'finish_reason': meta.get('finish_reason'), 'request_sha256': meta.get('request_sha256'), 'prompt_file': prompt_file_for(event).name, 'prompt_hash': prompt_hash(template),
            'one_pass': passes is None and chunks is None, 'passes': passes, 'chunks': chunks, 'filing': filing, 'lines': len(lines), 'sent': out_md.name,
            'privacy': {'outbound': out_md.name, 'held_file': held_file.name, 'screened_by': held.get('screened_by'), 'sentences': held['counts']['sentences'], 'held': held['counts']['held'], 'layer': held['counts']['layer'], 'category': held['counts']['category']},
            'seconds': {'model': seconds_model, 'check': seconds_check, 'total': round(time.time() - t_all, 1)}, 'duration_api_ms': meta.get('duration_api_ms'),
            'chars': {'transcript': sum(len(l['text']) for l in lines), 'prompt': chunks['chars'] if chunks else len(prompt), 'reply': len(reply), 'output': len(text)}, 'usage': meta.get('usage', {}), 'cost_usd_reported': meta.get('cost_usd_reported'),
            'sections': [s['heading'] for s in kept], 'bullets': len(checks), 'cited_verified': backed, 'cited_not_sure': len(checks) - backed, 'marked_not_sure': sum(1 for c in checks if c['reasons']),
            'stamps_moved': counts['stamps_moved'], 'meaning': counts.get('meaning'), 'goal': event.get('goal'), 'deduced': deduced, 'covered': covered, 'purposes_dropped': counts['purposes_dropped'], 'not_sure_reasons': why, 'names_unknown': counts['names_unknown'], 'renamed': counts['renamed'], 'unclear_restored': counts['unclear_restored'],
            'style': {'final': counts['style'], 'items': counts['style_items']}, 'stray_lines': stray,
            'next_steps': {'kept': [f"{c['text']} ({c['owner']})" if c['owner'] else c['text'] for c in next_steps], 'dropped': [d for d in drops if d['why'].startswith('next step')], 'deadlines_dropped': counts['deadlines_dropped'], 'in_class_dropped': counts['in_class_dropped']},
            'dropped': drops, 'output': out.name, 'raw': f'{out.stem}-raw', 'checks': checks}
    if classmates is not None:
        run_ = privacy.relabel_record(run_, classmates)
        run_['privacy']['classmates'] = len(classmates)
        checks = run_['checks']
    if trimmed is not None:
        run_ = privacy.relabel_record(run_, trimmed)
        run_['privacy']['trimmed'] = len(trimmed)
        checks = run_['checks']
    runs_file = folder / 'summary-runs.json'
    runs = json.loads(runs_file.read_text()) if runs_file.exists() else []
    runs.append(run_); runs_file.write_text(json.dumps(runs, indent=1, ensure_ascii=False, default=str))
    # The notes are on the page now; the points not confirmed get their explanations a few seconds later. A failed
    # request never takes the notes back: the page then shows each point's reason only.
    if checks and explain_ask is not None:
        t1 = time.time()
        try: explained, _ = explain_points(checks, sent_lines, lines, explain_ask, me=summary.names_for(event).get('me') or 'the user')
        except SystemExit as error: explained = {'error': str(error)}
        if classmates is not None: explained = privacy.relabel_record(explained, classmates)   # its "said" quotes come from transcript.md
        if trimmed is not None: explained = privacy.relabel_record(explained, trimmed)
        (folder / EXPLAIN_FILE.format(stem=out.stem)).write_text(json.dumps({'output': out.name, 'seconds': round(time.time() - t1, 1),
            **({'lines': explained} if isinstance(explained, list) else explained)}, indent=1, ensure_ascii=False))
    print(f"{out.name}: {len(checks)} bullets in {len(kept)} sections, {backed} backed by the transcript, {len(checks) - backed} not found near their stamp, "
          f"{len(counts['names_unknown'])} name(s) never said {counts['names_unknown'] or ''}, {len(drops)} dropped, {len(counts['deadlines_dropped'])} deadline(s) removed, {len(counts['in_class_dropped'])} in-class step(s) dropped, "
          f"style {sum(counts['style'].values())} violation(s) {counts['style'] or ''}, {counts['renamed']} label(s) renamed, {counts['unclear_restored']} (unclear) restored, "
          f"model {seconds_model}s, check {seconds_check}s, {meta.get('model')}")
    return out, run_

def provider_of(args):
    # --with wins; else settings.json "frontier" (spec-entry-b.md section 6), nebius when absent.
    if '--with' in args: return args[args.index('--with') + 1]
    import call
    return call.frontier()

def main(args):
    provider = provider_of(args)
    approved = args[args.index('--approved') + 1] if '--approved' in args and args.index('--approved') + 1 < len(args) else None
    if args and args[0] == 'explain':
        if len(args) < 2: sys.exit('usage: byo.py explain <call-folder> [--with nebius] [--approved <sha256>]')
        explain_later(args[1], provider, approved=approved); return
    approved_notes = args[args.index('--approved-notes') + 1] if '--approved-notes' in args and args.index('--approved-notes') + 1 < len(args) else None
    approved_pages = args[args.index('--approved-pages') + 1] if '--approved-pages' in args and args.index('--approved-pages') + 1 < len(args) else None
    folders = [a for i, a in enumerate(args) if not a.startswith('--') and (i == 0 or args[i - 1] not in ('--with', '--approved', '--approved-notes', '--approved-pages'))]
    if len(folders) != 1: sys.exit(f'usage: byo.py <version-folder> [--with {"|".join(PROVIDERS)}] [--approved <sha256>] [--approved-notes <sha256>] [--approved-pages <sha256>] [--dry-run] [--fresh]')
    global FRESH
    FRESH = '--fresh' in args
    run(folders[0], provider, dry_run='--dry-run' in args, approved=approved, approved_notes=approved_notes, approved_pages=approved_pages)

if __name__ == '__main__':
    main(sys.argv[1:])
