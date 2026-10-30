#!/usr/bin/env python3
# The class check (loggie-class-notes I2, docs/class-notes/spec.md sections 3 and 4), read only: for every recorded
# class in a truth file, the screen runs again in memory, once as a class (classmates become Student N) and once
# without the mask, and the two texts are counted against the truth: how many classmate mentions would leave, whether
# the user's own name kept every place, how many content names the mask took. It is the falsifier's instrument, run
# again on every new class. Nothing is written and nothing is sent: it reads transcript.md, event.json, lexicon.json
# and (with --notes) the newest notes run, and prints counts and folder names; --show adds the names, on this Mac.
#   python3 -B scripts/class-notes/check.py --truth <file> [--calls <dir>] [--show] [--notes] [<folder> ...]
# Truth: { "<folder relative to calls>": { "students": [...], "others": [...], "own": { "name", "spoken", "header" } } },
# keys starting with "_" are notes. Exit 0 clean, 1 on any WRONG line, 2 when a read fails (nothing is judged then).
import argparse, json, os, re, sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get('LOGGIE_DATA_DIRECTORY') or Path.home() / 'Library' / 'Application Support' / 'Loggie')
os.environ.setdefault('LOGGIE_HIKYAKU_HOME', str(DATA / 'hikyaku'))   # lexicon.own_names reads the user's settings there
sys.path.insert(0, str(REPO / 'transcriber' / 'spike'))
import privacy, summary

MAX_CONTENT = 3   # content names the mask may take in one class (spec section 3)

def fail(message):
    print(f'class check: a read failed, nothing was judged: {message}')
    sys.exit(2)

def read_json(path, what):
    try: return json.loads(Path(path).read_text())
    except (OSError, ValueError) as error: fail(f'{what}: {error}')

def forms_of(names):
    # A name's forms: the whole name, and for a name of two or more words each word of 3+ letters.
    out = set()
    for n in names:
        n = ' '.join(str(n).split())
        if not n: continue
        out.add(n)
        if ' ' in n: out.update(w for w in n.split() if len(w) >= 3)
    return out

def mentions(text, forms):
    # Every whole-word occurrence of any form, minus the ones inside a longer counted one ("Varin" in "Pella Varin").
    spans = sorted({m.span() for f in forms for m in privacy.form_re(f).finditer(text)}, key=lambda s: (s[0] - s[1], s[0]))
    counted = []
    for a, b in spans:
        if not any(ka <= a and b <= kb for ka, kb in counted): counted.append((a, b))
    return counted

def said(text, form): return privacy.form_re(form).search(text) is not None

def transcript_of(folder):
    # transcript.md in the folder, else in its newest v* folder that has one.
    if (folder / 'transcript.md').is_file(): return folder / 'transcript.md'
    versions = [d for d in folder.iterdir() if d.is_dir() and re.match(r'v\d+', d.name) and (d / 'transcript.md').is_file()]
    if not versions: return None
    return max(versions, key=lambda d: (int(re.match(r'v(\d+)', d.name).group(1)), d.name)) / 'transcript.md'

def load(key, calls, notes):
    # Every read for one folder, before anything is judged.
    folder = calls / key
    if not folder.is_dir(): fail(f'{key}: no such folder in the calls folder')
    md = transcript_of(folder)
    if md is None: fail(f'{key}: no transcript.md in it or in a v* folder')
    try: text = md.read_text()
    except OSError as error: fail(f'{key}: {error}')
    header, turns = privacy.parse_md(text)
    if not turns: fail(f'{key}: {md.name} has no stamped turns')
    try: event = summary.event_of(md.parent)
    except SystemExit as error: fail(f'{key}: {error}')
    except (OSError, ValueError) as error: fail(f'{key}: event.json: {error}')
    try: own, protect = privacy.class_inputs(md.parent, event)
    except SystemExit as error: fail(f'{key}: {error}')
    run = None
    if notes:
        runs_file = md.parent / 'summary-runs.json'
        runs = read_json(runs_file, f'{key}: summary-runs.json') if runs_file.is_file() else []
        run = next((r for r in reversed(runs if isinstance(runs, list) else []) if isinstance(r, dict) and r.get('output')), None)
    return {'key': key, 'dir': md.parent, 'header': header, 'turns': turns, 'event': event, 'own': own, 'protect': protect, 'run': run}

def judge(item, truth, show):
    # One folder's counts, one line; WRONG first when it fails. Returns (failed, counts, the map).
    event = item['event']
    names = {**summary.names_for(event), 'people': privacy.people_of(event)}
    plain, _ = privacy.screen(item['header'], item['turns'], names)
    mask = (event, item['own'], item['protect'])
    masked, record = privacy.screen(item['header'], item['turns'], names, mask)
    found = record.get('names') or {}
    students = forms_of(truth.get('students') or [])
    others = list(dict.fromkeys(' '.join(str(o).split()) for o in truth.get('others') or [] if str(o).strip()))
    before, after = mentions(plain, students), mentions(masked, students)
    own_name = ((truth.get('own') or {}).get('name') or '').strip()
    own_before = len(privacy.form_re(own_name).findall(plain)) if own_name else 0
    own_after = len(privacy.form_re(own_name).findall(masked)) if own_name else 0
    content = [o for o in others if said(plain, o) and not said(masked, o)]
    known = students | forms_of(others)
    other_words = [v['name'] for v in found.values() if not ({v['name'], *v['forms']} & known)]
    wrong = []
    if after: wrong.append(f'{len(after)} mention{"s" if len(after) != 1 else ""} left')
    if own_after < own_before: wrong.append(f'own name lost {own_before - own_after} place{"s" if own_before - own_after != 1 else ""}')
    if len(content) > MAX_CONTENT: wrong.append(f'{len(content)} content names masked (at most {MAX_CONTENT})')
    line = (f"{item['key']}: classmates {len(truth.get('students') or [])}, mentions before {len(before)}, left after {len(after)}, "
            f"own places kept {own_after} of {own_before}, labels written {len(found)}, content masked {len(content)} of {len(others)}, "
            f"other words masked {len(other_words)}")
    print(('WRONG ' if wrong else '') + line + (f"; {', '.join(wrong)}" if wrong else ''))
    if show:
        for label, v in found.items(): print(f"  {label} -> {v['name']} ({v['rule']})")
        if after: print(f"  left: {', '.join(sorted({masked[a:b] for a, b in after}))}")
        if content: print(f"  content masked: {', '.join(content)}")
        if other_words: print(f"  other words masked: {', '.join(other_words)}")
    return bool(wrong), {'classmates': len(truth.get('students') or []), 'before': len(before), 'after': len(after), 'own_kept': own_after,
                         'own': own_before, 'labels': len(found), 'content': len(content), 'other': len(other_words)}, found

def judge_notes(item, truth, show):
    # The newest notes run: every form of its map (the held file it was made from) and of the truth's students, in its
    # notes file, its record in summary-runs.json and its -explain.json. A form in any of them is WRONG.
    run, folder, key = item['run'], item['dir'], item['key']
    if run is None:
        print(f'{key} notes: no notes run'); return False
    held_name = (run.get('privacy') or {}).get('held_file') or ''
    held = read_json(folder / held_name, f'{key}: {held_name}') if held_name and (folder / held_name).is_file() else {}
    names = held.get('names') if isinstance(held, dict) else None
    forms = forms_of(truth.get('students') or []) | {f for v in (names or {}).values() for f in v.get('forms', [])}
    out_file = folder / run['output']
    explain = folder / f"{Path(run['output']).stem}-explain.json"
    counts, seen = [], []
    for what, path, text in (('notes', out_file, None), ('summary-runs.json', None, json.dumps(run, ensure_ascii=False)), ('explain', explain, None)):
        if text is None:
            if not path.is_file(): counts.append((what, None)); continue
            try: text = path.read_text()
            except OSError as error: fail(f'{key}: {error}')
        spans = mentions(text, forms)
        counts.append((what, spans))
        seen += [(what, text[a:b]) for a, b in spans]
    hits = sum(len(c) for _, c in counts if c)
    parts = ', '.join(f"{what} {'none' if c is None else len(c)}" for what, c in counts)
    map_said = f'map of {len(names)}' if isinstance(names, dict) else 'no map'
    line = (f"{key} notes: {run['output']} ({map_said}), forms in {parts}; "
            f"cited_verified {run.get('cited_verified', 0)} of {run.get('bullets', 0)}")
    print(('WRONG ' if hits else '') + line + (f'; {hits} form{"s" if hits != 1 else ""} in the notes files' if hits else ''))
    if show and hits: print(f"  in the notes files: {', '.join(sorted({t for _, t in seen}))}")
    return bool(hits)

def main(argv=None):
    ap = argparse.ArgumentParser(description='Read-only class check: classmate mentions left, own places kept, content names masked.')
    ap.add_argument('--truth', required=True)
    ap.add_argument('--calls', default=str(DATA / 'hikyaku' / 'calls'))
    ap.add_argument('--show', action='store_true', help='also print Student N -> name and the leftover names (on this Mac)')
    ap.add_argument('--notes', action='store_true', help='also count map names in the newest notes run')
    ap.add_argument('folders', nargs='*')
    args = ap.parse_args(argv)
    truth_file = Path(args.truth).expanduser()
    truth = read_json(truth_file, f'truth file {truth_file}')
    if not isinstance(truth, dict): fail(f'truth file {truth_file}: not an object of folders')
    truth = {k: v for k, v in truth.items() if not k.startswith('_')}
    keys = args.folders or list(truth)
    for k in keys:
        if k not in truth: fail(f'{k}: not in the truth file')
        if not isinstance(truth[k], dict): fail(f'{k}: its truth entry is not an object')
    calls = Path(args.calls).expanduser()
    if not calls.is_dir(): fail(f'no calls folder at {calls}')
    items = [load(k, calls, args.notes) for k in keys]
    failed, total = False, {}
    for item in items:
        bad, counts, _ = judge(item, truth[item['key']], args.show)
        failed |= bad
        for k, v in counts.items(): total[k] = total.get(k, 0) + v
        if args.notes: failed |= judge_notes(item, truth[item['key']], args.show)
    print(f"{'WRONG ' if failed else ''}classes {len(items)}: classmates {total.get('classmates', 0)}, mentions before {total.get('before', 0)}, "
          f"left after {total.get('after', 0)}, own places kept {total.get('own_kept', 0)} of {total.get('own', 0)}, labels written {total.get('labels', 0)}, "
          f"content masked {total.get('content', 0)}, other words masked {total.get('other', 0)}")
    return 1 if failed else 0

if __name__ == '__main__':
    sys.exit(main())
