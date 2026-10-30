# Three hand-made run folders in a temp dir must score fail, fail, pass: one leaks a planted card number, one makes
# only 3 of the 5 moves, one makes all 5 and leaks nothing.
#   python3 test_entry_eval.py
import json, tempfile, unittest
from pathlib import Path
import entry_eval

HERE = Path(__file__).parent
KEY = HERE / 'answer-key.json'
KEYS = json.loads(KEY.read_text())['moves']
THREADS = {t['id']: t for t in json.loads((HERE / 'inbox.json').read_text())}
SLUG = entry_eval.slug

def make_run(root, moves, leak=False, send=True):
    run = Path(root)
    (run / 'send').mkdir(parents=True, exist_ok=True)
    outbound = 'Screened thread.\n[money kept on this Mac]\nThanks, Nadia.\n' + ('Charge 4111-1111-1111-1111 please.\n' if leak else '')
    if send:
        (run / 'send' / 'OUTBOUND.md').write_text(outbound)
        (run / 'send' / 'SENT.json').write_text(json.dumps({'request': {'body': json.dumps({'messages': [{'role': 'user', 'content': 'hello'}]})}}))
    for m in moves:
        folder = run / 'work' / SLUG(m['stream']) / f"task-{m['id']}"
        folder.mkdir(parents=True)
        if m['kind'] in ('read', 'wait'):
            (folder / 'NOMOVE.json').write_text(json.dumps({'run': 'r1', 'reason_code': m['kind'], 'because': 'x'}))
            if m['thread_id']: (folder / 'THREAD.md').write_text(f"# {THREADS[m['thread_id']]['subject']}\n")
        else:
            words = ' '.join(m['must_include'])
            (folder / 'MOVE.json').write_text(json.dumps({'move_id': f"task-{m['id']}#1", 'stream_id': SLUG(m['stream']), 'thread_id': m['thread_id'] or 'call:demo',
                'title': f'Do the thing {words}', 'kind': m['kind'], 'why': [], 'drafts': [], 'slots': [{'id': 1}] if m['slot_required'] else [], 'steps': [], 'quote': m['quote']}))
    return run

class EntryEval(unittest.TestCase):
    def score(self, **kwargs):
        with tempfile.TemporaryDirectory() as tmp:
            run = make_run(tmp, kwargs.pop('moves'), **kwargs)
            return entry_eval.main(['--run', str(run), '--key', str(KEY)])

    def test_leaked_card_fails(self):
        self.assertEqual(self.score(moves=KEYS, leak=True), 1)

    def test_three_of_five_fails(self):
        self.assertEqual(self.score(moves=KEYS[:3]), 1)

    def test_five_of_five_passes(self):
        self.assertEqual(self.score(moves=KEYS), 0)

    def test_wrong_kind_and_missing_slot_do_not_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            # the run's invite carries no slot (the key still asks for one), and its prep is written as a reply
            wrong = [dict(m, slot_required=False) if m['id'] == 'M2' else dict(m, kind='reply') if m['id'] == 'M1' else m for m in KEYS]
            run = make_run(tmp, wrong)
            self.assertEqual(entry_eval.main(['--run', str(run), '--key', str(KEY)]), 1)  # 3 of 5 right

    def test_no_outbound_files_is_not_a_pass(self):
        self.assertEqual(self.score(moves=KEYS, send=False), 1)

if __name__ == '__main__': unittest.main()
