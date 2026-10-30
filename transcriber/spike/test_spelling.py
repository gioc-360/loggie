# spelling.py tests: a spelling changes only when the user's own words prove it (heard-as in my-words.txt, an "&" said
# aloud), never a person's name, never a word the user kept as heard; the screen sends it, the check finds the quote,
# and a pair whose spellings are out of date is screened again. Deterministic: temp folders, made-up words.
#   python3 test_spelling.py   (exit 0 = pass)
import contextlib, io, json, tempfile
from pathlib import Path
import byo, privacy, sendgate, spelling, summary

EVENT = {'title': 'Coffee chat', 'me': 'Gio', 'with': 'Mara Senn', 'names': 'Mara Senn', 'category': 'one-on-one'}
SAID = """# Coffee chat

Monday, October 26, 2026, 10:30, 20 min. Me (Gio) and Mara Senn.
_parakeet. A word marked (unclear) is a name the two readers heard differently._

[00:10] Me: I applied to MNT (unclear) after a chat. MNT's (unclear) Buffalo office grows by acquisition.

[00:40] Them: Why MT (unclear)? I read about Kwalt (unclear) and Mara (unclear) too. Also AT (unclear).

[01:10] Me: Because MNT grows. And Lockie (unclear) is my app.
"""

def call_in(d, words=None, workstreams=None, kept=None):
    home = Path(d); call = home / 'calls' / '2026-10-26-1030-coffee-chat'; call.mkdir(parents=True)
    (call / 'event.json').write_text(json.dumps(EVENT)); (call / 'transcript.md').write_text(SAID)
    (home / 'workstreams.json').write_text(json.dumps(workstreams if workstreams is not None else [{'name': 'M&T Bank Outreach'}, {'name': 'Loggie'}, {'name': 'AT&T Pitch'}]))
    if words is not None: (home / 'my-words.txt').write_text(words)
    if kept is not None: (call / 'name-checks.json').write_text(json.dumps({'v': 1, 'status': 'done', 'words': {}, 'accepted': {}, 'kept': kept}))
    return call

def test_only_what_the_users_words_prove_changes():
    with tempfile.TemporaryDirectory() as d:
        call = call_in(d, words='# Words\nQualtrics: Kwalt\n')
        fixes = spelling.proven(call, EVENT, SAID)
        assert fixes == {'MNT': {'to': 'M&T', 'rule': 'ampersand', 'source': 'workspace "M&T Bank Outreach"'},
                         'MT': {'to': 'M&T', 'rule': 'ampersand', 'source': 'workspace "M&T Bank Outreach"'},
                         'Kwalt': {'to': 'Qualtrics', 'rule': 'heard-as', 'source': 'your words'}}, fixes
        # AT is "AT&T" without its &T only by a stretch: "AT&T" said aloud is "ATNT"/"ATandT"/"ATT", never "AT".
        out = spelling.apply(SAID, fixes)
        assert 'I applied to M&T after a chat. M&T\'s Buffalo office' in out and 'Why M&T?' in out and 'Because M&T grows' in out, out
        assert 'Mara (unclear)' in out and 'Lockie (unclear)' in out and 'AT (unclear)' in out, 'a name, a sound-alike and an unproven word stay as heard'
        assert spelling.apply('MNTs aMNT', fixes) == 'MNTs aMNT', 'whole words only'

def test_a_person_and_a_kept_word_are_never_respelled():
    with tempfile.TemporaryDirectory() as d:
        call = call_in(d, words='Marra: Mara\n', kept={'MT': True})
        fixes = spelling.proven(call, EVENT, SAID)
        assert 'Mara' not in fixes, 'an invitee is never respelled'
        assert 'MT' not in fixes and 'MNT' in fixes, 'kept with ✕: stays as heard'

def test_no_words_no_change():
    with tempfile.TemporaryDirectory() as d:
        call = call_in(d, workstreams=[])
        assert spelling.proven(call, EVENT, SAID) == {} and spelling.apply(SAID, {}) == SAID

def test_the_screen_sends_the_spelling_and_a_stale_pair_is_screened_again():
    with tempfile.TemporaryDirectory() as d:
        call = call_in(d)
        with contextlib.redirect_stdout(io.StringIO()): out_md, held, record = privacy.screen_folder(call)
        out = out_md.read_text()
        assert 'MNT' not in out and 'MT (unclear)' not in out and out.count('M&T') == 4, out
        assert record['spelled']['MNT']['to'] == 'M&T' and (call / 'transcript.md').read_text() == SAID, 'transcript.md keeps what was heard'
        assert sendgate.fresh_pair(call, EVENT) is not None, 'nothing changed: fresh'
        (call / 'name-checks.json').write_text(json.dumps({'kept': {'MNT': True}}))
        assert sendgate.fresh_pair(call, EVENT) is None, 'a word kept with ✕ since: screened again'
        (call / 'name-checks.json').unlink()
        rec = json.loads(held.read_text()); rec.pop('spelled'); held.write_text(json.dumps(rec))
        assert sendgate.fresh_pair(call, EVENT) is None, 'a pair from before spellings, with one to make: screened again'

def test_the_check_finds_a_quote_that_carries_the_spelling():
    with tempfile.TemporaryDirectory() as d:
        call = call_in(d)
        with contextlib.redirect_stdout(io.StringIO()): out_md, _, _ = privacy.screen_folder(call)
        import hashlib
        yes = hashlib.sha256(out_md.read_bytes()).hexdigest()
        reply = '# Coffee chat\n\n## Why M&T\n- Gio applied to M&T after a chat [00:10] <!-- I applied to M&T after a chat -->\n'
        calls = []
        def ask(p, *r): calls.append(p); return reply, {'model': 'fake', 'usage': {}, 'seconds': 0.1, 'auth': {}, 'finish_reason': 'stop'}
        with contextlib.redirect_stdout(io.StringIO()): out, run_ = byo.run(call, 'nebius', ask=ask, approved=yes)
        assert 'MNT' not in calls[0] and 'I applied to M&T after a chat' in calls[0]
        assert run_['cited_verified'] == 1 and '- Gio applied to M&T after a chat [00:10]\n' in out.read_text(), out.read_text()

if __name__ == '__main__':
    import fixtures; fixtures.run(globals())
