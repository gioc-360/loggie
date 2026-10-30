#!/usr/bin/env python3
# The notes plan check (2026-10-23, after the 10-22 strategy class: 22 of its 38 labels were not people, and its notes
# covered 5 headings of 159 minutes), read only: for each class in a truth file, the screen runs in memory with the mask
# (check.py's judge: classmate mentions left, content names masked), then byo.py builds the notes request(s) it would
# send, never sending them: the parts of a long call, each part's prompt, and the merge prompt with placeholder part
# notes. Judged: every --keep word that the class says stays unmasked and reaches a prompt, the parts cover every turn
# in order with no gap, and the merge asks for the heading count byo.shape_for gives the call's length.
#   python3 -B scripts/class-notes/plan-check.py --truth <file> [--calls <dir>] [--keep Word,Word] [--show] [<folder> ...]
# Exit 0 clean, 1 on any WRONG line, 2 when a read fails. Writes nothing in the calls folder and sends nothing: the
# screened text goes to a temporary folder for byo.read_md and is gone when the check ends.
import argparse, importlib.util, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('class_check', HERE / 'check.py')
check = importlib.util.module_from_spec(spec); spec.loader.exec_module(check)   # check.py sets the paths and the hikyaku home
import byo, privacy, summary, transcript

def plan_of(item, masked, names):
    # The request(s) byo.run would build for this class, from the masked text as byo.py reads outbound.md.
    with tempfile.TemporaryDirectory() as d:
        md = Path(d) / 'outbound.md'; md.write_text(masked)
        sent = byo.read_md(md)
    event = {**item['event'], 'goal': byo.goal_of(item['event'], item['dir'])}
    plan = byo.plan_prompts(event, sent, item['dir'], byo.prompt_text(event), (), names)
    merge = byo.build_merge_prompt(event, sent, item['dir'], ['(the notes of this part)'] * len(plan), [p['lines'] for p in plan], names) if len(plan) > 1 else None
    return event, sent, plan, merge

def judge_plan(item, masked, record, keep, show):
    event, sent, plan, merge = plan_of(item, masked, record.get('names') or {})
    forms = {f for v in (record.get('names') or {}).values() for f in v['forms']}
    try: spoken = (item['dir'] / 'transcript.md').read_text()
    except OSError as error: check.fail(f"{item['key']}: {error}")
    said = [w for w in keep if check.said(spoken, w)]
    asked = '\n'.join(p['prompt'] for p in plan)
    missing = [w for w in said if not check.said(asked, w)]
    wrong = [f'{w} masked' for w in said if w in forms] + [f'{w} not in the prompt' for w in missing]
    flat = [l for p in plan for l in p['lines']]
    if flat != sent: wrong.append('the parts do not hold every turn once, in order')
    minutes = round(byo.span_of(sent) / 60)
    headings, bullets = byo.shape_for(byo.span_of(sent))
    final = merge if merge is not None else plan[0]['prompt']
    if f'About {headings} headings' not in final: wrong.append(f'the {"merge" if merge else "notes"} prompt does not ask for about {headings} headings')
    if f"from {transcript.stamp(sent[0]['t'])} to {transcript.stamp(sent[-1]['t'])}" not in final: wrong.append('the prompt does not ask to cover the whole call')
    longest = max(byo.span_of(p['lines']) for p in plan) / 60
    line = (f"{item['key']} plan: {minutes} minutes, {len(plan)} part{'s' if len(plan) != 1 else ''} "
            f"({', '.join(p['from'] + ' to ' + p['to'] for p in plan)}; longest {longest:.1f} min), model {byo.notes_model(event)}, "
            f"about {headings} headings and {bullets} bullets asked, keep words said {len(said)} of {len(keep)}, in the prompts {len(said) - len(missing)}")
    print(('WRONG ' if wrong else '') + line + (f"; {', '.join(wrong)}" if wrong else ''))
    if show:
        for p in plan: print(f"  part {p['part']}: {p['from']} to {p['to']}, {p['turns']} turns, {len(p['prompt'])} chars")
    return bool(wrong)

def main(argv=None):
    ap = argparse.ArgumentParser(description='Read-only notes plan check: the mask, then the requests byo.py would build.')
    ap.add_argument('--truth', required=True)
    ap.add_argument('--calls', default=str(check.DATA / 'hikyaku' / 'calls'))
    ap.add_argument('--keep', default='', help='comma-separated words that must stay unmasked and reach the prompt')
    ap.add_argument('--show', action='store_true')
    ap.add_argument('folders', nargs='*')
    args = ap.parse_args(argv)
    truth = check.read_json(Path(args.truth).expanduser(), f'truth file {args.truth}')
    if not isinstance(truth, dict): check.fail(f'truth file {args.truth}: not an object of folders')
    truth = {k: v for k, v in truth.items() if not k.startswith('_')}
    keys = args.folders or list(truth)
    for k in keys:
        if k not in truth: check.fail(f'{k}: not in the truth file')
    calls = Path(args.calls).expanduser()
    if not calls.is_dir(): check.fail(f'no calls folder at {calls}')
    items = [check.load(k, calls, False) for k in keys]
    keep = [w.strip() for w in args.keep.split(',') if w.strip()]
    failed = False
    for item in items:
        bad, _, _ = check.judge(item, truth[item['key']], args.show)
        event = item['event']
        names = {**summary.names_for(event), 'people': privacy.people_of(event)}
        masked, record = privacy.screen(item['header'], item['turns'], names, (event, item['own'], item['protect']))
        failed |= bad | judge_plan(item, masked, record, keep, args.show)
    return 1 if failed else 0

if __name__ == '__main__':
    sys.exit(main())
