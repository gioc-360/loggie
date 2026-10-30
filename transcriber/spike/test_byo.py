# byo.py tests: the gates fire on a fake model's reply, private calls are refused before anything is sent, outputs never
# overwrite, a dry run sends nothing, and only outbound.md (the privacy screen's file) is ever sent. Deterministic: no
# network, no model, a fake screen.
#   python3 test_byo.py   (exit 0 = pass)
import contextlib, hashlib, io, json, os, random, re, tempfile
from pathlib import Path
import byo, privacy
from fixtures import priya   # the call these tests read: Priya's coffee chat and the fake screen
EVENT, TRANSCRIPT, REPLY, HELD = priya.EVENT, priya.TRANSCRIPT, priya.REPLY, priya.HELD
fake, folder_in, fake_screen, masked_screen, approve = priya.fake, priya.folder_in, priya.fake_screen, priya.masked_screen, priya.approve

def test_read_md_keeps_marks_and_finds_the_always_unclear_spans():
    with tempfile.TemporaryDirectory() as d:
        lines = byo.read_md(folder_in(d) / 'transcript.md')
    assert [l['t'] for l in lines] == [249, 289, 390, 444, 943, 1293, 1399] and lines[3]['who'] == 'Me' and lines[0]['who'] == 'Priya Shah'
    assert 'Morris (unclear) Dandy (unclear)' in lines[1]['text'] and 'Morris Dandy, and' in lines[1]['bare']
    assert byo.unclear_spans(lines) == ['Giio', 'Morris Dandy'], byo.unclear_spans(lines)   # Citi and Dell are also said clearly: not spans
    assert byo.restore_marks('worked at Morris Dandy and Citi', ['Giio', 'Morris Dandy']) == ('worked at Morris Dandy (unclear) and Citi', 1)
    assert byo.restore_marks('Morris Dandy (unclear) stays', ['Morris Dandy']) == ('Morris Dandy (unclear) stays', 0)

def test_parse_reply_reads_headings_levels_stamps_quotes_and_owners():
    sections, stray = byo.parse_reply(REPLY)
    assert [s['heading'] for s in sections] == ["Priya's Background", "Gio's Background", 'Next Steps'] and stray == []
    b = sections[0]['bullets']
    assert (b[0]['text'], b[0]['at'], b[0]['quote'], b[0]['level']) == ('First-year MBA at Cornell Johnson', '04:49', 'first-year MBA student at Cornell Johnson', 0)
    assert b[1]['level'] == 1 and b[1]['text'].startswith('Prior roles')
    n = sections[2]['bullets']
    assert (n[0]['text'], n[0]['owner'], n[0]['at']) == ('Start building something with AI tools', 'Priya Shah', '21:33')
    s2, stray2 = byo.parse_reply('Here is the summary:\n\n## A\n- a point [00:10] <!-- q -->\nthanks!\n')
    assert stray2 == ['Here is the summary:', 'thanks!'] and s2[0]['bullets'][0]['text'] == 'a point'
    assert byo.parse_reply('## A\n- **bold step** (Gio) [00:10]')[0][0]['bullets'][0]['text'] == 'bold step (Gio)'   # not under Next Steps: no owner split

def test_unknown_names_and_drop_deadline():
    vocab = {'priya', 'lee', 'gio', 'dell', 'cornell', 'johnson', 'citi', 'bank', 'of', 'america', 'treasury', 'services', 'analyst', 'taiwan', 'tier', 'program'}
    assert byo.unknown_names('Worked at Morgan Stanley before Bank of America', vocab) == ['Morgan', 'Stanley']
    assert byo.unknown_names('Prior roles: Treasury Services Analyst at Citi', vocab) == []   # a fragment's first word is not a name
    assert byo.unknown_names("Priya's background at Dell Cloud", vocab) == ['Cloud']
    assert byo.unknown_names('Tier 1: revenue-linked impact. NPS and CSAT rank fourth', vocab) == []   # acronyms are not names
    assert byo.unknown_names('Gio Caballero rowed', vocab) == ['Caballero'] and byo.unknown_names('Send Priya the deck', vocab) == []   # a last name is caught; a command's verb is not a name
    assert byo.drop_deadline('Email Gio with any follow-up questions by Friday') == ('Email Gio with any follow-up questions', 'by Friday')
    assert byo.drop_deadline('Submit the form on Oct 12 to HR') == ('Submit the form to HR', 'on Oct 12')
    assert byo.drop_deadline('Send the deck, due Monday') == ('Send the deck', 'due Monday')
    assert byo.drop_deadline('Send the deck') == ('Send the deck', None)

def test_gates_fire_on_the_fake_reply():
    random.seed(0)
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d)
        yes = approve(folder)
        ask, calls = fake()
        with contextlib.redirect_stdout(io.StringIO()):
            out, run = byo.run(folder, 'nebius', ask=ask, screen=fake_screen, approved=yes)
        assert len(calls) == 1 and out.name == 'summary-nebius.md'
        prompt = calls[0]
        assert prompt.startswith('You are writing the summary of a recorded call') and 'TRANSCRIPT:\n[04:09] Priya Shah: Hey, Giio (unclear).' in prompt and run['prompt_file'] == 'summary-clean.txt', 'no goal, a 1:1: the clean prompt (B9)'
        assert '[07:24] Gio: I\'m Gio.' in prompt and '[07:24] Me:' not in prompt, 'the model reads the user by name, never Me'
        assert 'Gio recorded it; the other person is Priya Shah.' in prompt and 'Wednesday, October 7, 2026' in prompt and not re.search(r'\{[a-z_]+\}', prompt)
        assert HELD not in prompt and '[15:43] Gio: I applied to Dell in like September 17 of last year. [health kept on this Mac]' in prompt, 'the prompt is built from outbound.md'
        assert (folder / 'outbound.md').exists() and (folder / 'held.json').exists() and run['sent'] == 'outbound.md'
        assert run['privacy'] == {'outbound': 'outbound.md', 'held_file': 'held.json', 'screened_by': 'code', 'sentences': 13, 'held': 1, 'layer': {'code': 1}, 'category': {'health': 1}}
        text = out.read_text()
        assert text.startswith("# Priya & Gio - Coffee Chat\n\n_summary by fake-model, on Nebius Token Factory; hikyaku checked it.")
        assert 'Purpose: ' not in text and 'For your goal' not in text and text.endswith('_Nebius: 15 tokens (10 in, 5 out), 0.1 s._\n'), 'no goal: no purpose line (B9), and the cost line last'
        assert '<!--' not in text, 'the checker comments are stripped'
        # backed bullets: stamp from the backing line, no mark, nesting kept
        assert '\n- First-year MBA at Cornell Johnson [04:49]\n  - Prior roles at Citi, Morris Dandy (unclear) and Bank of America, then CDBC Bank USA [04:49]\n' in text, text
        # a resolved (unclear) is a name never said: marked
        assert '- Worked at Morgan Stanley before Bank of America [04:49] (not sure)\n' in text
        # labels become names by code; the leftover "you" is a style violation, counted, not rewritten
        assert '- Priya Shah explained the role to you [06:30]' in text and '- Gio applied to Dell on September 17 [15:43]' in text
        assert run['renamed'] == 2 and run['style']['final'] == {'reports': 1, 'speaker': 1}
        # an unbacked bullet is kept and marked; a shape copied from the prompt is dropped
        assert '- Gio rowed for Cornell in 2019 [07:24] (not sure)\n' in text
        assert 'keeps its heard spelling' not in text and run['dropped'][0]['why'].startswith("copied from the prompt's shapes")
        # Next Steps (the strict check, no goal): the offer is Priya Shah's, its invented "by Friday" is removed, the unverified step is dropped
        assert '## Next Steps\n- Start building something with AI tools (Priya Shah) [21:33]\n- Email Gio with any follow-up questions (Priya Shah) [23:19]\n' in text, text
        assert run['next_steps']['deadlines_dropped'] == [{'text': 'Email Gio with any follow-up questions by Friday', 'removed': 'by Friday', 'at': '23:19'}]
        assert [d['text'] for d in run['next_steps']['dropped']] == ['Send Priya the Dell framework deck'] and run['next_steps']['dropped'][0]['why'].startswith('next step not verified')
        assert run['bullets'] == 10 and run['cited_verified'] == 9 and run['cited_not_sure'] == 1 and run['marked_not_sure'] == 2 and run['names_unknown'] == ['Morgan', 'Stanley']
        assert run['unclear_restored'] == 0 and run['model'] == 'fake-model' and run['provider'] == 'nebius' and run['one_pass']
        assert len(run['prompt_hash']) == 12 and run['chars']['prompt'] == len(prompt) and run['seconds']['model'] >= 0 and run['usage'] == {'prompt_tokens': 10, 'completion_tokens': 5}
        raw = folder / 'summary-nebius-raw'
        assert (raw / 'prompt.txt').read_text() == prompt and (raw / 'reply.md').read_text() == REPLY and (raw / 'result.json').exists()
        runs = json.loads((folder / 'summary-runs.json').read_text())
        assert len(runs) == 1 and runs[0]['output'] == 'summary-nebius.md' and runs[0]['checks'][3]['reasons'] == ['never said: Morgan, Stanley']
        # (unclear) restored by code when the model dropped the mark
        ask2, _ = fake('## A\n- Priya worked at Morris Dandy and Citi [04:49] <!-- Citi, Morris Dandy, and Bank -->\n')
        with contextlib.redirect_stdout(io.StringIO()):
            out2, run2 = byo.run(folder, 'nebius', ask=ask2, screen=fake_screen, approved=yes)
        assert out2.name == 'summary-nebius-2.md' and '- Priya worked at Morris Dandy (unclear) and Citi [04:49]' in out2.read_text() and run2['unclear_restored'] == 1
        assert (folder / 'summary-nebius.md').read_text() == text, 'the first file is untouched'
        assert len(json.loads((folder / 'summary-runs.json').read_text())) == 2
        assert not (folder / 'outbound-2.md').exists(), 'a fresh outbound.md is reused, not screened again'

SYNC = {'names': 'Priya', 'title': 'Priya & Gio - Survey Sync', 'start': '2026-10-07T15:00:00Z', 'attendees': 'Priya', 'me': 'Gio', 'with': 'Priya', 'category': 'one-on-one'}

SYNC_TRANSCRIPT = """# Priya & Gio - Survey Sync

[38:50] Priya: The deck needs slides before the review, and the survey framework is still with Gio.

[39:14] Me: Sure, I can make a template of slides, simple ones, for the deck.

[46:45] Me: I'm gonna let Priya know about the framework once the survey is final.
"""

# Two shapes a real model returned instead of "<command> (<person>) [mm:ss] <!-- quote -->" (made-up words, same marks):
# A puts the stamp and the quote inside one parenthesis; B does that and then repeats the owner, stamp and quote.
SHAPE_A = '- Create a simple slide template for the deck ([39:14] <!-- I can make a template of slides -->)'
SHAPE_B = "- Share the survey framework with Priya ([46:45] <!-- I'm gonna let Priya know about the framework -->) (Priya) [46:45] <!-- I'm gonna let Priya know about the framework -->)"

def test_parse_reply_tolerates_the_stamp_and_quote_inside_parentheses():
    sections, stray = byo.parse_reply(f'## Next Steps\n{SHAPE_A}\n{SHAPE_B}\n')
    a, b = sections[0]['bullets']
    assert stray == [] and (a['text'], a['owner'], a['at'], a['quote']) == ('Create a simple slide template for the deck', None, '39:14', 'I can make a template of slides'), a
    assert (b['text'], b['owner'], b['at'], b['quote']) == ('Share the survey framework with Priya', 'Priya', '46:45', "I'm gonna let Priya know about the framework"), b
    # an unclosed comment is still the quote, a stray "-->" is dropped, and a parenthesis that is not a name is never the owner
    c = byo.parse_reply('## Next Steps\n- Make the slide template [39:14] <!-- I can make a template of slides\n- Send the deck --> (Gio) [39:14]\n- Email Morris Dandy (unclear) [39:14]\n')[0][0]['bullets']
    assert (c[0]['text'], c[0]['quote']) == ('Make the slide template', 'I can make a template of slides') and (c[1]['text'], c[1]['owner']) == ('Send the deck', 'Gio'), c
    assert (c[2]['text'], c[2]['owner']) == ('Email Morris Dandy (unclear)', None), c[2]
    # outside Next Steps the same shapes lose their empty parenthesis and keep the inner one
    d = byo.parse_reply('## Deck\n- A slide template keeps the deck simple ([39:14] <!-- I can make a template of slides -->)\n')[0][0]['bullets'][0]
    assert (d['text'], d['at'], d['quote']) == ('A slide template keeps the deck simple', '39:14', 'I can make a template of slides'), d

def test_tolerant_shapes_render_clean_and_are_checked_like_any_bullet():
    reply = ('# Priya & Gio - Survey Sync\n\n## Deck\n'
             '- A slide template keeps the deck simple ([39:14] <!-- I can make a template of slides -->)\n'
             '- The review is set for Thursday ([38:50] <!-- the review moved to Thursday -->)\n\n'
             f'## Next Steps\n{SHAPE_A}\n{SHAPE_B}\n'
             '- Book the room for the review ([38:50] <!-- I will book the room -->)\n')
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d, SYNC, SYNC_TRANSCRIPT)
        yes = approve(folder)
        ask, _ = fake(reply)
        with contextlib.redirect_stdout(io.StringIO()):
            out, run = byo.run(folder, 'nebius', ask=ask, screen=fake_screen, approved=yes)
        text = out.read_text()
    assert not any(mark in text for mark in ('()', '<!--', '-->')), text
    assert '## Deck\n- A slide template keeps the deck simple [39:14]\n- The review is set for Thursday [38:50] (not sure)\n' in text, text
    assert '## Next Steps\n- Create a simple slide template for the deck [39:14]\n- Share the survey framework with Priya (Priya) [46:45]\n' in text and 'Book the room' not in text.split('## Next Steps')[1], text
    assert [c['backed'] for c in run['checks']] == [True, False, True, True] and run['names_unknown'] == []
    assert [d['text'] for d in run['next_steps']['dropped']] == ['Book the room for the review'], 'an unverified step in the tolerant shape is dropped like any other (clean prompt, strict check)'

def refused(event, **kw):
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d, event)
        yes = approve(folder, kw.get('screen'))
        ask, calls = fake()
        err = io.StringIO()
        try:
            with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()): byo.run(folder, 'nebius', ask=ask, approved=yes, **{'screen': fake_screen, **kw})
        except SystemExit as e: code = e.code
        else: code = 0
        return code, err.getvalue(), calls, sorted(p.name for p in folder.iterdir())

def test_private_calls_are_refused_before_a_word_is_sent():
    for event, word in (({**EVENT, 'category': 'doctor'}, 'doctor'), ({**EVENT, 'category': 'medical'}, 'medical'), ({**EVENT, 'private': True}, 'private'),
                        ({'title': 'NBA 6530 Strategic Alliances', 'me': 'Gio'}, 'class'), ({**EVENT, 'category': 'class'}, 'class')):
        code, err, calls, files = refused(event)
        assert code == 2 and word in err and calls == [] and files == ['held.json', 'outbound.md', 'transcript.md'], (event, code, err, files)   # refused before a word is sent: no notes either
    # loggie-class-notes (D7 flipped): a class is no longer refused for being a class. A pair screened before the mask
    # (no "names" map, as fake_screen writes) is refused with its own message; a masked pair goes.
    code, err, calls, _ = refused({**EVENT, 'category': 'class'})
    assert code == 2 and err.strip() == byo.CLASS_UNMASKED and calls == [], err
    code, _, calls, _ = refused({**EVENT, 'category': 'class'}, screen=masked_screen)
    assert code == 0 and len(calls) == 1, 'a masked class goes like any call'
    assert '--allow-class' not in open(byo.__file__).read(), 'the old flag is gone'
    code, _, calls, _ = refused(EVENT)
    assert code == 0 and len(calls) == 1
    # loggie-interview-privacy: an interview is no longer refused for being one. A pair screened before the trim (no
    # "trimmed" map, as fake_screen writes) is refused with its own message; a pair the real screen trimmed goes.
    for event in ({**EVENT, 'category': 'interview'}, {**EVENT, 'title': 'Interview with Dell', 'category': 'one-on-one'}):
        code, err, calls, _ = refused(event)
        assert code == 2 and err.strip() == byo.UNTRIMMED and calls == [], (event, err)
        code, err, calls, _ = refused(event, screen=privacy.screen_folder)
        assert code == 0 and len(calls) == 1 and 'Shah' not in calls[0] and 'the other person is Priya.' in calls[0], (event, err)

def test_an_interview_leaves_by_first_name_and_no_surname_comes_back_to_disk():
    # The reply repeats the surname ("(Priya Shah)" on its Next Steps): the notes file, summary-runs.json and the
    # explanations keep only the first name, and no prompt (notes, filing, explanations) carries the surname.
    event = {**EVENT, 'title': 'Priya Shah mock interview', 'workstream': 'none'}
    with tempfile.TemporaryDirectory() as d:
        home = Path(d); call = home / 'calls' / '2026-10-26-1034-mock'; call.mkdir(parents=True)
        (call / 'event.json').write_text(json.dumps(event)); (call / 'transcript.md').write_text(TRANSCRIPT)
        yes = approve(call, privacy.screen_folder)
        ask, notes = fake(REPLY)
        file_ask, filed = fake('Because: [07:24] <!-- I built a platform that connected -->\nTitle: Mock interview with Priya Shah\nWorkstream: none\nCalendar title: fits\n')
        explain_ask, explained = fake('[]')
        with contextlib.redirect_stdout(io.StringIO()):
            out, run_ = byo.run(call, 'nebius', ask=ask, file_ask=file_ask, explain_ask=explain_ask, screen=privacy.screen_folder, approved=yes)
        assert len(notes) == 1 and len(filed) == 1 and len(explained) == 1
        for prompt in [*notes, *filed, *explained]: assert 'Shah' not in prompt, prompt[:400]
        assert '"Priya mock interview"' in notes[0] and '"Priya mock interview"' in filed[0], 'title by first name in what leaves'
        written = {f.name: f.read_text() for f in call.iterdir() if f.suffix in ('.md', '.json') and f.name not in ('transcript.md', 'held.json', 'event.json')}
        assert 'summary-runs.json' in written and out.name in written and any(n.endswith('-explain.json') for n in written), sorted(written)
        for name, text in written.items(): assert 'Shah' not in text, (name, text[:300])
        assert run_['privacy']['trimmed'] == 1 and '(Priya)' in out.read_text(), out.read_text()
        assert json.loads((call / 'event.json').read_text())['title'] == 'Priya Shah mock interview', 'event.json keeps its own title: only what leaves is trimmed'
        held = json.loads((call / 'held.json').read_text())
        assert list(held['trimmed']) == ['Priya'] and held['trimmed']['Priya']['forms'] == ['Priya Shah', 'Shah'] and held['trim_version'] == privacy.TRIM_VERSION

def test_dry_run_sends_nothing_and_writes_nothing():
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d)
        ask, calls = fake()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf): result = byo.run(folder, 'nebius', dry_run=True, ask=ask)
        printed = buf.getvalue()
        assert result == (None, None) and calls == [] and sorted(p.name for p in folder.iterdir()) == ['transcript.md']
        assert printed.startswith('DRY RUN: nothing sent. Provider nebius: POST https://api.tokenfactory.nebius.com/v1/chat/completions') and 'no tools' in printed
        assert re.search(r'Prompt \d+ chars, \d+ words', printed) and '7 turns' in printed and 'TRANSCRIPT:\n[... 7 turns' in printed and "I'm Gio" not in printed
        assert "title 'Priya & Gio - Coffee Chat', me 'Gio'" in printed and 'Would run the privacy screen first (no outbound.md yet)' in printed
        fake_screen(folder)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf): byo.run(folder, 'nebius', dry_run=True, ask=ask)
        printed = buf.getvalue()
        assert 'Would send outbound.md (screened on this Mac by code: 1 of 13 sentences held; held.json), never transcript.md.' in printed, printed
        assert calls == [] and sorted(p.name for p in folder.iterdir()) == ['held.json', 'outbound.md', 'transcript.md'] and 'transcript 7 turns' in printed

def test_only_outbound_is_sent_and_a_failed_screen_refuses():
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d)
        ask, calls = fake()
        # no outbound.md and a screen that cannot run: refused, nothing sent, nothing written
        def no_model(folder): raise SystemExit('privacy screen refused to run; nothing written')
        err = io.StringIO()
        try:
            with contextlib.redirect_stderr(err): byo.screened(folder, no_model)
        except SystemExit as e: code = e.code
        else: code = 0
        assert code == 2 and 'refused: the privacy screen did not run' in err.getvalue() and 'never sent unscreened' in err.getvalue()
        assert sorted(p.name for p in folder.iterdir()) == ['transcript.md']
        # a fresh pair is used as is; a stale one (transcript.md newer) refuses the old yes and is screened again into a new pair
        yes = approve(folder)
        with contextlib.redirect_stdout(io.StringIO()): byo.run(folder, 'nebius', ask=ask, screen=no_model, approved=yes)
        assert len(calls) == 1 and HELD not in calls[0] and 'kept on this Mac' in calls[0], 'fresh outbound.md sent without screening again'
        later = (folder / 'outbound.md').stat().st_mtime + 5
        os.utime(folder / 'transcript.md', (later, later))
        try:
            with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()): byo.run(folder, 'nebius', ask=ask, screen=fake_screen, approved=yes)
        except SystemExit as e: assert e.code == 2 and len(calls) == 1, 'a yes for the stale pair sends nothing'
        else: assert False
        out2, _, _ = byo.screened(folder, fake_screen)
        os.utime(out2, (later + 1, later + 1))   # screened after the transcript changed
        assert out2.name == 'outbound-2.md' and (folder / 'held-2.json').exists()
        with contextlib.redirect_stdout(io.StringIO()): byo.run(folder, 'nebius', ask=ask, screen=no_model, approved=hashlib.sha256(out2.read_bytes()).hexdigest())
        assert len(calls) == 2
        runs = json.loads((folder / 'summary-runs.json').read_text())
        assert [r['sent'] for r in runs] == ['outbound.md', 'outbound-2.md'] and runs[1]['privacy']['held'] == 1
        # a stale pair with a screen that fails: refused
        os.utime(folder / 'transcript.md', (later + 10, later + 10))
        try:
            with contextlib.redirect_stderr(io.StringIO()): byo.screened(folder, no_model)
        except SystemExit as e: assert e.code == 2 and len(calls) == 2
        else: assert False
        # every prompt ever sent came from an outbound file: the transcript's held words never appear
        assert all(HELD not in c for c in calls)

TEAM_EVENT = {'names': 'Anya Parimala, Ivy Cho, Tomas Park', 'title': 'Hackathon: readouts', 'start': '2026-10-07T21:30:00Z', 'me': 'Gio', 'category': 'team'}
TEAM_TRANSCRIPT = """# Hackathon: readouts

Wednesday, October 7, 2026, 17:30, 50 min. Me (Gio) and Anya Parimala, Ivy Cho, Tomas Park.

[01:00] Me: So my part was looking at the financials for Hilton using Capital IQ.

[02:00] Speaker 2: I will clean up my research notes and upload them to the folder.

[03:00] Me: I'm gonna let Anya know about the framework for Qualtrics.
"""
TEAM_GOOD = """# Hackathon: readouts

## Executive Summary
- Hilton financials pulled from Capital IQ [01:00] <!-- looking at the financials for Hilton -->

## Next Steps
- Clean up research notes and upload them (Speaker 2) [02:00] <!-- clean up my research notes -->
- Tell Anya about the Qualtrics framework (Gio) [03:00] <!-- let Anya know about the framework -->
"""

def test_a_team_meeting_gets_the_team_prompt_names_not_labels_and_one_retry():
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d, TEAM_EVENT, TEAM_TRANSCRIPT)
        replies = ['# Hackathon: readouts\n\n## Executive Summary\n- Cut short [01:00] <!-- looking at the financials --><|message_end|>', TEAM_GOOD]
        calls = []
        def ask(prompt):
            calls.append(prompt)
            return replies[len(calls) - 1], {'model': 'fake-model', 'usage': {}, 'seconds': 0.1, 'auth': {}}
        assert byo.is_team(TEAM_EVENT) and not byo.is_team(EVENT), 'several invitees is a team meeting; a 1:1 is not'
        yes = approve(folder)
        with contextlib.redirect_stdout(io.StringIO()):
            out, run = byo.run(folder, 'nebius', ask=ask, screen=fake_screen, approved=yes)
        assert len(calls) == 2, 'a cut-short team answer (control token, no Next Steps) is asked once more'
        prompt = calls[0]
        assert prompt.startswith('Request ') and prompt.split('\n\n', 1)[1].startswith('You are writing the readout of a recorded team meeting') and run['prompt_file'] == 'summary-team.txt', 'no goal, several invitees: the team prompt (B9)'
        assert "[01:00] Gio's microphone: So my part" in prompt and '[01:00] Gio:' not in prompt, 'the room mic is a mic, not the user'
        assert 'People invited: Gio (who recorded it), Anya Parimala, Ivy Cho, Tomas Park.' in prompt
        text = out.read_text()
        assert 'Purpose: ' not in text, 'no default purpose (B9)'
        assert 'Speaker 2' not in text and '- Clean up research notes and upload them (Team)' in text, 'a label owner becomes Team'
        assert '(Gio)' in text

def test_every_token_factory_answer_is_logged_with_its_cost_even_one_cut_at_the_limit():
    # 2026-10-09: the Liz call's first answer stopped at 6000 tokens and its usage was lost; Nebius billed it anyway.
    usage = {'prompt_tokens': 6771, 'completion_tokens': 1580}
    assert byo.cost_usd('nvidia/nemotron-3-super-120b-a12b', usage) == 0.003453
    assert byo.cost_usd('nvidia/unknown', usage) is None
    assert byo.usage_line('nvidia/nemotron-3-super-120b-a12b', usage, 7.0) == '\n_Nebius: 8,351 tokens (6,771 in, 1,580 out), $0.0035, 7.0 s._\n'
    with tempfile.TemporaryDirectory() as d:
        byo.USAGE_HOME = None
        assert byo.record_usage('call-notes', 'nvidia/nemotron-3-super-120b-a12b', usage, 7.0, 'stop') is None, 'no home, no line'
        byo.USAGE_HOME = d
        cut = lambda url, headers, body: (200, json.dumps({'model': 'nvidia/nemotron-3-super-120b-a12b', 'usage': {'prompt_tokens': 6771, 'completion_tokens': 6000}, 'choices': [{'finish_reason': 'length', 'message': {'content': 'x'}}]}).encode())
        try: byo.ask_nebius('p', key='k', transport=cut); assert False, 'a cut answer stops'
        except SystemExit as e: assert 'token limit' in str(e)
        rows = [json.loads(l) for l in Path(d, 'nebius-usage.jsonl').read_text().splitlines()]
        assert [(r['path'], r['in'], r['out'], r['usd'], r['finish_reason']) for r in rows] == [('call-notes', 6771, 6000, 0.007431, 'length')]
        byo.USAGE_HOME = None

def test_saved_answers_make_an_unchanged_rerun_free_and_rows_say_who_spent_it():
    # 2026-10-10: an eval re-sent the same graded calls about twelve times on Ultra, $4.81 in a day, each time behind a
    # fresh "Request <hex>." line. The same question is now paid once; hand-run rows say "dev", Loggie's say "app".
    with tempfile.TemporaryDirectory() as d:
        byo.USAGE_HOME = d
        sent = []
        def answer(url, headers, body):
            sent.append(body)
            return 200, json.dumps({'model': 'nvidia/Nemotron-3-Ultra-550b-a55b', 'usage': {'prompt_tokens': 30000, 'completion_tokens': 3000}, 'choices': [{'finish_reason': 'stop', 'message': {'content': 'notes'}}]}).encode()
        old = os.environ.pop('LOGGIE_RUN_BY', None)
        try:
            first, meta1 = byo.ask_nebius('Request 1a2b3c4d.\n\nSummarize.', key='k', transport=answer, model='nvidia/Nemotron-3-Ultra-550b-a55b')
            again, meta2 = byo.ask_nebius('Request 99ff00ee.\n\nSummarize.', key='k', transport=answer, model='nvidia/Nemotron-3-Ultra-550b-a55b')
            assert (first, again, len(sent), meta2.get('cached')) == ('notes', 'notes', 1, True)
            byo.ask_nebius('Request 1a2b3c4d.\n\nSummarize, shorter.', key='k', transport=answer, model='nvidia/Nemotron-3-Ultra-550b-a55b')
            assert len(sent) == 2, 'an edited prompt is a new question and is paid'
            os.environ['LOGGIE_RUN_BY'] = 'app'
            byo.ask_nebius('Request 5555aaaa.\n\nSummarize.', key='k', transport=answer, model='nvidia/Nemotron-3-Ultra-550b-a55b')
        finally:
            os.environ.pop('LOGGIE_RUN_BY', None)
            if old is not None: os.environ['LOGGIE_RUN_BY'] = old
            byo.USAGE_HOME = None
        rows = [json.loads(l) for l in Path(d, 'nebius-usage.jsonl').read_text().splitlines()]
        assert [(r['usd'], r.get('cached', False), r['by']) for r in rows] == [(0.039, False, 'dev'), (0, True, 'dev'), (0.039, False, 'dev'), (0, True, 'app')]

def test_goal_first_notes_take_the_workstream_goal_and_keep_the_users_part_to_one_line():
    # 2026-10-09, Jess on the Liz call: Loggie listed everything Gio said; the rival app gave his part one line and each action its purpose.
    with tempfile.TemporaryDirectory() as d:
        home = Path(d); call = home / 'calls' / '2026-10-09-1258-lena-chat'; call.mkdir(parents=True)
        (home / 'workstreams.json').write_text(json.dumps([{'name': 'Acme Bank', 'goal': 'Get an offer', 'goalText': 'Get the Acme Bank analyst offer before Nov 11'},
                                                           {'name': 'Course Assistant', 'goal': 'Just keep me posted', 'goalText': 'Help with grading'}, {'name': 'Club', 'goal': 'Get it done'}]))
        assert byo.goal_of({'workstream': 'acme bank'}, call) == 'Get the Acme Bank analyst offer before Nov 11'
        assert byo.goal_of({'workstream': 'Club'}, call) == 'Get it done', 'no words of his own yet: the label'
        assert byo.goal_of({'workstream': 'Course Assistant'}, call) is None, 'a quiet workstream keeps the old notes'
        assert byo.goal_of({'workstream': 'Nobody'}, call) is None and byo.goal_of({}, call) is None
        assert byo.goal_of({'workstream': 'Acme Bank'}, Path(d) / 'elsewhere') is None, 'not under calls/: no goal'
    assert byo.prompt_file_for({'goal': 'Get the offer'}) == byo.GOAL_PROMPT_FILE and byo.prompt_file_for({}) == byo.PROMPT_FILE
    filled = byo.build_prompt({'title': 'Lena chat', 'goal': 'Get the Acme Bank analyst offer', 'me': 'Ana', 'with': 'Lena'}, [], '/tmp/x', byo.GOAL_PROMPT_FILE.read_text())
    assert 'First work out what this call was' in filled and '"Get the Acme Bank analyst offer"' in filled and '{goal}' not in filled
    reply = '# Lena chat\n\nAna covered: internship at Acme, Army years, why analyst\n\n## How the program works\n- Monthly retreats [01:00] <!-- one week retreats every month -->\n'
    sections, stray = byo.parse_reply(reply)
    assert stray == [] and len(sections) == 1, 'the covered line is not stray'
    assert byo.covered_of(reply, 'Ana') == 'internship at Acme, Army years, why analyst'
    assert byo.covered_of(reply, 'Lena') is None, 'only the recorder covers'
    assert byo.covered_of('Ana covered: ' + 'word ' * 25 + '\n## X', 'Ana') is None, 'a long line is the story again'
    deduce = '# Lena chat\n\nThis call: a recruiting chat. For the goal, Ana needs: interview advice, fit signals.\n\nAna covered: Acme internship\n\n## Interview advice\n- Bring numbers [01:00] <!-- one week retreats every month -->\n'
    assert byo.parse_reply(deduce)[1] == [], 'the deduce line is not stray'
    assert byo.deduced_of(deduce) == 'a recruiting chat. For the goal, Ana needs: interview advice, fit signals.'
    assert 'This call: a recruiting chat.' in byo.render([], 'Lena chat', 'm', deduced=byo.deduced_of(deduce))
    template = byo.GOAL_PROMPT_FILE.read_text()
    assert 'Dell' not in template and 'M&T' not in template, 'no example from a real call can leak into the notes'

def test_a_next_steps_so_that_stands_only_on_the_goal_or_what_was_said():
    lines = [{'t': 60, 'end': 68, 'who': 'Them', 'text': 'Send me your resume and I will flag you to the hiring team.'}]
    goal = 'Get the Acme Bank analyst offer before Nov 11'
    assert byo.purpose_holds('Lena can flag Ana to the hiring team', goal, lines[0]['text'], lines, 60)
    assert byo.purpose_holds('it moves the Acme analyst offer forward', goal, lines[0]['text'], lines, 60)
    assert not byo.purpose_holds('Ana wins the summer trip to Lisbon', goal, lines[0]['text'], lines, 60)
    m = byo.SO_THAT.search('Send Lena the resume, so that Lena can flag Ana to the hiring team')
    assert m and m.group(1) == 'Lena can flag Ana to the hiring team'
    out = byo.render([], 'Lena chat', 'm', covered='internship at Acme', me='Ana', goal=goal)
    assert 'For your goal: Get the Acme Bank analyst offer before Nov 11' in out and 'Ana covered: internship at Acme' in out

def test_loose_goal_notes_tag_instead_of_dropping_join_moments_and_date_next_friday():
    # 2026-10-09: after the rival app won 4 blind gradings of 4, Gio: "loosen". A point may join up to three moments; a next
    # step with no found quote, or a purpose not traced, is tagged (not sure), never dropped or cut; "next Friday" gets its date.
    import datetime
    assert byo.absolute_dates('Ask the HR rep next Friday', datetime.date(2026, 10, 9))[0] == 'Ask the HR rep next Friday (Fri Oct 16)'
    assert byo.absolute_dates('Ask on next Friday', datetime.date(2026, 10, 5))[0] == 'Ask on next Friday (Fri Oct 16)', 'said on a Monday: the Friday of the week after'
    assert byo.absolute_dates('Send it by Monday, call tomorrow', datetime.date(2026, 10, 9))[0] == 'Send it by Monday (Mon Oct 12), call tomorrow (Sat Oct 10)'
    assert byo.absolute_dates('next Friday', None) == ('next Friday', [])
    L = lambda t, text, who='Them': {'t': t, 'end': t + 8, 'who': who, 'text': text, 'bare': text}
    lines = [L(864, 'Pull on your success story, what you built and the impact.'), L(1790, 'Two pillars are teaming for growth and operational excellence.'), L(780, 'Ask the HR rep if other EA tracks fit you.')]
    reply = """# Lena chat

## Interview prep
- Anchor the success story on the two pillars [14:24] <!-- Pull on your success story --> [29:50] <!-- teaming for growth and operational excellence -->

## Next Steps
- Ask the HR rep about other EA tracks next Friday, so that both tracks stay in the offer (Ana) [13:00] <!-- Ask the HR rep if other -->
- Bring the budget deck, so that the moon lands (Ana) [40:00] <!-- this was never said at all -->
"""
    sections, _ = byo.parse_reply(reply)
    assert [c[0] for c in sections[0]['bullets'][0]['cites']] == ['14:24', '29:50']
    event = {'title': 'Lena chat', 'start': '2026-10-09T17:00:00Z', 'me': 'Ana', 'with': 'Lena'}
    kept, checks, drops, counts = byo.check(sections, lines, event, '', goal='Get an analyst offer, both tracks')
    assert drops == [], 'loose mode drops nothing'
    joined, ask, made_up = checks
    assert joined['at'] == '14:24, 29:50' and not joined['reasons']
    assert ask['text'].endswith('next Friday (Fri Oct 16), so that both tracks stay in the offer') and not ask['reasons'], ask
    assert made_up['reasons'], 'kept, but tagged (not sure)'
    kept_strict, _, drops_strict, _ = byo.check(sections, lines, event, '')
    assert len(drops_strict) == 1, 'the old prompt still drops an unverified step'

def test_a_name_must_be_said_near_the_moment_its_note_rests_on():
    # 2026-10-09 Hilton: "2025 winner Richard" - Richard was said at 13:43 about something else; the winner talk was at 28-37 min.
    L = lambda t, text: {'t': t, 'end': t + 8, 'who': 'Me', 'text': text, 'bare': text}
    lines = [L(823, "That's Richard over there with the slides."), L(1986, 'The winner said to go talk to the mentors early.')]
    sections = [{'heading': 'Winner advice', 'bullets': [
        {'text': '2025 winner Richard: talk to mentors early', 'at': '33:06', 'quote': 'go talk to the mentors early', 'owner': None, 'level': 0, 'cites': []},
        {'text': 'Talk to mentors early, the winner said', 'at': '33:06', 'quote': 'go talk to the mentors early', 'owner': None, 'level': 0, 'cites': []}]}]
    event = {'title': 'Team meeting', 'start': '2026-10-07T21:30:00Z', 'me': 'Gio'}
    _, checks, _, counts = byo.check(sections, lines, event, '', goal='Win the hackathon')
    assert any('named but not said near this moment: Richard' in r for r in checks[0]['reasons']), checks[0]
    assert checks[1]['reasons'] == []
    _, strict, _, _ = byo.check(sections, lines, event, '')
    assert not any('near this moment' in r for c in strict for r in c['reasons']), 'the old prompt is unchanged'
    headed = [{'heading': '2025 winner Richard insights', 'bullets': [sections[0]['bullets'][1]]}]
    kept, _, _, _ = byo.check(headed, lines, event, '', goal='Win the hackathon')
    assert kept[0]['heading'] == '2025 winner Richard insights (not sure)', kept[0]['heading']
    paren = [{'heading': 'Past winner (Richard) insights', 'bullets': [{'text': 'Networking pays (Richard: mentors led to a job)', 'at': '33:06', 'quote': 'go talk to the mentors early', 'owner': None, 'level': 0, 'cites': []}]}]
    kept, checks2, _, _ = byo.check(paren, lines, event, '', goal='Win the hackathon')
    assert kept[0]['heading'].endswith('(not sure)') and any('Richard' in r for r in checks2[0]['reasons']), 'a name after a bracket is still a name'

def test_filing_names_an_untitled_call_from_a_quote_the_transcript_has_and_never_overrides_a_hand_label():
    # 2026-10-09: a 37-hour calendar block named a Loggie working session "MBA Veterans Career Conference & Expo"; Gio:
    # "hikyaku and loggie should learn how to auto categorize and not be clueless like this". Evidence first: no quote, no filing.
    streams = [{'name': 'Acme Bank', 'goal': 'Get an offer', 'goalText': 'Get the Acme Bank analyst offer'}, {'name': 'Loggie', 'goal': 'Get it done'}]
    def call_with(event):
        d = Path(tempfile.mkdtemp()); call = d / 'calls' / '2026-10-07-1100-untitled'; call.mkdir(parents=True)
        (d / 'workstreams.json').write_text(json.dumps(streams))
        (call / 'event.json').write_text(json.dumps(event)); (call / 'transcript.md').write_text(TRANSCRIPT)
        return call
    good = 'Because: [07:24] <!-- I built a platform that connected -->\nTitle: Dell internship story for Priya\nWorkstream: Acme Bank\nCalendar title: does not fit\n'
    untitled = {**EVENT, 'title': 'Untitled call, 11:00 AM', 'untitled': True, 'workstream': 'none'}
    call = call_with(untitled)
    lines = byo.read_md(call / 'transcript.md')
    ask, calls = fake(good)
    with contextlib.redirect_stdout(io.StringIO()): event, filing = byo.file_call(call, untitled, lines, lines, ask)
    assert filing['found'] and event['title'] == 'Dell internship story for Priya' and event['workstream'] == 'Acme Bank'
    assert '"none (no meeting on the calendar)"' not in calls[0] and 'none (no meeting on the calendar)' in calls[0] and 'Acme Bank: Get the Acme Bank analyst offer' in calls[0]
    on_disk = json.loads((call / 'event.json').read_text())
    assert on_disk['title'] == event['title'] and on_disk['filed']['quote'] == 'I built a platform that connected'
    assert json.loads((call / 'event.json.before-filing').read_text())['title'] == 'Untitled call, 11:00 AM', 'what it was stays readable'
    assert byo.goal_of(on_disk, call) == 'Get the Acme Bank analyst offer', 'the notes get the goal of the workstream it was filed under'
    with contextlib.redirect_stdout(io.StringIO()): again = byo.file_call(call, on_disk, lines, lines, fake('')[0])
    assert again[1]['skipped'] == 'filed already', 'a resend does not file twice'
    # A quote that is not in the transcript files nothing.
    call = call_with(untitled)
    invented = good.replace('I built a platform that connected', 'we agreed on the veterans expo booth')
    with contextlib.redirect_stdout(io.StringIO()): event, filing = byo.file_call(call, untitled, lines, lines, fake(invented)[0])
    assert not filing['found'] and event['title'] == 'Untitled call, 11:00 AM' and 'filed' not in json.loads((call / 'event.json').read_text())
    # A real calendar title that fits is kept; one that does not fit is replaced and the old one kept as "was".
    titled = {**EVENT, 'workstream': 'none'}
    call = call_with(titled)
    with contextlib.redirect_stdout(io.StringIO()): event, _ = byo.file_call(call, titled, lines, lines, fake(good.replace('does not fit', 'fits'))[0])
    assert event['title'] == EVENT['title'] and event['workstream'] == 'Acme Bank'
    call = call_with(titled)
    with contextlib.redirect_stdout(io.StringIO()): event, filing = byo.file_call(call, titled, lines, lines, fake(good)[0])
    assert event['title'] == 'Dell internship story for Priya' and filing['was'] == EVENT['title']
    # A workstream that is not on the list is none; code's own filing (by email or word) is never replaced.
    call = call_with(untitled)
    with contextlib.redirect_stdout(io.StringIO()): event, filing = byo.file_call(call, untitled, lines, lines, fake(good.replace('Workstream: Acme Bank', 'Workstream: Recruiting'))[0])
    assert event['workstream'] == 'none' and filing['answered_workstream'] == 'Recruiting'
    filed_by_code = {**untitled, 'workstream': 'Loggie'}
    call = call_with(filed_by_code)
    with contextlib.redirect_stdout(io.StringIO()): event, _ = byo.file_call(call, filed_by_code, lines, lines, fake(good)[0])
    assert event['workstream'] == 'Loggie'
    # A title renamed on the call page (title_by_hand, 2026-10-27) is kept even when the AI says the calendar's does not fit;
    # the workspace still files.
    renamed = {**EVENT, 'title': 'Video Meeting with Acme Bank', 'title_by_hand': True, 'workstream': 'none'}
    call = call_with(renamed)
    with contextlib.redirect_stdout(io.StringIO()): event, filing = byo.file_call(call, renamed, lines, lines, fake(good)[0])
    assert event['title'] == 'Video Meeting with Acme Bank' and event['workstream'] == 'Acme Bank' and not filing.get('was'), (event['title'], filing)
    assert json.loads((call / 'event.json').read_text())['title'] == 'Video Meeting with Acme Bank'
    # A title Gio gave by hand is never touched, and nothing is asked.
    hand = {**untitled, 'title': 'Loggie: what to do next', 'relabeled': {'by': 'Gio'}}
    ask, calls = fake(good)
    event, filing = byo.file_call(call_with(hand), hand, lines, lines, ask)
    assert event['title'] == 'Loggie: what to do next' and filing == {'skipped': 'named by hand'} and calls == []

def test_filing_runs_before_the_notes_so_they_take_the_goal_it_found():
    with tempfile.TemporaryDirectory() as d:
        home = Path(d); call = home / 'calls' / '2026-10-07-1100-untitled'; call.mkdir(parents=True)
        (home / 'workstreams.json').write_text(json.dumps([{'name': 'Acme Bank', 'goal': 'Get an offer', 'goalText': 'Get the Acme Bank analyst offer'}]))
        (call / 'event.json').write_text(json.dumps({**EVENT, 'title': 'Untitled call, 11:00 AM', 'untitled': True, 'workstream': 'none'}))
        (call / 'transcript.md').write_text(TRANSCRIPT)
        file_ask, filed = fake('Because: [07:24] <!-- I built a platform that connected -->\nTitle: Dell internship story\nWorkstream: Acme Bank\nCalendar title: does not fit\n')
        ask, notes = fake(REPLY)
        yes = approve(call)
        with contextlib.redirect_stdout(io.StringIO()): out, run_ = byo.run(call, 'nebius', ask=ask, file_ask=file_ask, screen=fake_screen, approved=yes)
        assert len(filed) == 1 and len(notes) == 1 and run_['filing']['workstream'] == 'Acme Bank'
        assert '"Get the Acme Bank analyst offer"' in notes[0] and run_['prompt_file'] == byo.GOAL_PROMPT_FILE.name, 'the notes ask with the goal filing found'
        assert out.read_text().startswith('# Dell internship story'), 'the notes carry the new title'
        assert HELD not in filed[0], 'filing sends outbound.md, never transcript.md'

def test_filing_takes_a_quote_without_its_wrapper_and_spells_the_workstream_as_listed():
    # The first real filing (2026-10-09, Nemotron Super): "Because: [00:17] why are we having this meeting" with no <!-- -->,
    # and "Scoping Loggy Prototype Features" from a transcript that heard Loggie as "loggy" 8 times.
    d = Path(tempfile.mkdtemp()); (d / 't.md').write_text(TRANSCRIPT); lines = byo.read_md(d / 't.md')
    streams = [{'name': 'Loggie'}, {'name': 'Acme Bank'}]
    f = byo.parse_filing('Because: [07:24] I built a platform that connected\nTitle: Scoping Loggy Prototype Features\nWorkstream: Loggie\nCalendar title: does not fit', lines, streams)
    assert f['found'] and f['quote'] == 'I built a platform that connected' and f['title'] == 'Scoping Loggie Prototype Features', f
    assert byo.parse_filing('Because: [07:24] "I built a platform that connected"\nTitle: x y\nWorkstream: none\nCalendar title: fits', lines, streams)['found'], 'quoted, no wrapper'
    assert byo.spelled('Logging bugs', 'Acme Bank') == 'Logging bugs' and byo.spelled('Loggie bugs', 'Loggie') == 'Loggie bugs', 'only the picked name, only when missing'

def test_the_prompt_is_the_goal_then_the_team_readout_then_clean():
    # B9: the rule the claude path kept (6fbb46b) on Nebius, and no default purpose: a call with no workstream goal has no goal.
    team = {'names': 'Anya Parimala, Ivy Cho, Tomas Park', 'category': 'team'}
    assert byo.prompt_file_for({**team, 'goal': 'Win the hackathon'}) == byo.GOAL_PROMPT_FILE, 'a goal wins over the team readout'
    assert byo.prompt_file_for(team) == byo.TEAM_PROMPT_FILE and byo.prompt_file_for(EVENT) == byo.PROMPT_FILE
    assert byo.prompt_file_for({'names': 'Anya Parimala, Ivy Cho', 'category': 'class'}) == byo.PROMPT_FILE, 'a class is never a team readout'
    assert not hasattr(byo, 'DEFAULT_PURPOSES') and not hasattr(byo, 'purpose_of')
    assert 'Purpose: ' not in byo.render([], 'Call', 'm') and 'For your goal: x' in byo.render([], 'Call', 'm', goal='x')

# The notes as they are written (2026-10-12): a streamed reply grows summary-live.md, and the reply ask_nebius checks is
# the same text a non-streamed one would be. A saved answer is shown at once; --fresh asks again.
class FakeStream:
    status = 200
    def __init__(self, chunks): self.lines = [f'data: {json.dumps(c)}\n'.encode() for c in chunks] + [b'data: [DONE]\n']
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def __iter__(self): return iter(self.lines)

def stream_chunks(text, model='nvidia/Nemotron-3-Ultra-550b-a55b'):
    pieces = [text[i:i + 7] for i in range(0, len(text), 7)]
    chunks = [{'id': 'r1', 'model': model, 'choices': [{'delta': {'content': p, 'reasoning_content': 'SECRET-THINKING'}, 'finish_reason': None}]} for p in pieces]
    chunks[-1]['choices'][0]['finish_reason'] = 'stop'
    return chunks + [{'id': 'r1', 'model': model, 'choices': [], 'usage': {'prompt_tokens': 10, 'completion_tokens': 5}}]

def test_a_streamed_reply_grows_the_live_file_and_answers_like_a_plain_one():
    reply = '## Plans\n- Ship the demo [01:00] "ship the demo"\n- Record the video [02:00] "record it"\n'
    with tempfile.TemporaryDirectory() as d:
        seen = []
        live = byo.live_writer(d, every_s=0)
        def watch(text, final=False): live(text, final); seen.append((Path(d) / byo.LIVE_FILE).read_text())
        old = byo.urllib.request.urlopen
        byo.urllib.request.urlopen = lambda req, timeout=None: FakeStream(stream_chunks(reply))
        old_home = byo.USAGE_HOME
        try:
            byo.USAGE_HOME = None
            text, meta = byo.ask_nebius('prompt', key='k', on_text=watch)
        finally: byo.urllib.request.urlopen = old; byo.USAGE_HOME = old_home
        assert text == reply and meta['finish_reason'] == 'stop' and meta['usage']['completion_tokens'] == 5
        assert len(seen) > 3 and seen[0] != seen[-1] and seen[-1] == reply
        assert all('SECRET-THINKING' not in s for s in seen), 'the reasoning never reaches the file'

def test_a_saved_answer_shows_at_once_and_fresh_asks_again():
    with tempfile.TemporaryDirectory() as d:
        byo_home = Path(d)
        old_home, old_open = byo.USAGE_HOME, byo.urllib.request.urlopen
        asked = []
        byo.urllib.request.urlopen = lambda req, timeout=None: asked.append(1) or FakeStream(stream_chunks('- new answer\n'))
        try:
            byo.USAGE_HOME = byo_home
            first, _ = byo.ask_nebius('prompt', key='k', on_text=lambda t, final=False: None)
            shown = []
            again, meta = byo.ask_nebius('prompt', key='k', on_text=lambda t, final=False: shown.append((t, final)))
            assert meta.get('cached') and len(asked) == 1 and shown == [(first, True)]
            byo.FRESH = True
            byo.ask_nebius('prompt', key='k', on_text=lambda t, final=False: None)
            assert len(asked) == 2, 'fresh does not answer from the saved copy'
        finally: byo.USAGE_HOME, byo.FRESH = old_home, False; byo.urllib.request.urlopen = old_open

# A next step with a minute and no quote (2026-10-12): it stands when its own words are said near that minute.
def test_a_next_step_without_a_quote_stands_on_its_words_at_its_minute():
    lines = [{'t': 300, 'end': 308, 'who': 'Me', 'text': 'I will record the demo video and write the storyboard', 'bare': 'I will record the demo video and write the storyboard'},
             {'t': 900, 'end': 908, 'who': 'Them', 'text': 'lunch was good', 'bare': 'lunch was good'}]
    secs = [{'heading': 'Next Steps', 'bullets': [{'text': 'Record the demo video', 'owner': 'Gio', 'at': '05:00', 'quote': '', 'cites': []},
                                                  {'text': 'Book the venue for Friday', 'owner': 'Gio', 'at': '15:00', 'quote': '', 'cites': []}]}]
    weight = lambda w: 1.0
    kept, checks, drops, _ = byo.check(secs, lines, {'title': 'x', 'me': 'Gio'}, '', weight=weight, goal='Ship it')
    assert [c['backed'] for c in checks] == [True, False] and not drops

# Where each point came from (2026-10-12): one request for every point, built from the screened copy; each quote found
# in the transcript is shown as its whole sentence with who and when; a context with no quote found is dropped.
def test_every_point_is_explained_from_the_screened_copy_and_only_found_quotes_are_shown():
    lines = [{'t': 300, 'end': 308, 'who': 'Them', 'text': 'Sure. Nina will do the API key flow next week. It is the main friction.', 'bare': 'Sure. Nina will do the API key flow next week. It is the main friction.'},
             {'t': 320, 'end': 328, 'who': 'Me', 'text': 'my knee surgery is on Friday', 'bare': 'my knee surgery is on Friday'},
             {'t': 340, 'end': 348, 'who': 'Me', 'text': 'We need to go one by one on each button and make sure it works.', 'bare': 'We need to go one by one on each button and make sure it works.'}]
    sent = [lines[0], {**lines[1], 'text': '[health kept on this Mac]', 'bare': '[health kept on this Mac]'}, lines[2]]
    items = [{'section': 'Next Steps', 'text': 'Build the API key flow', 'owner': 'Nina', 'at': '05:00', 'reasons': ['no quote'], 'backed': False},
             {'section': 'UI', 'text': 'Test every button', 'owner': None, 'at': '05:40', 'reasons': [], 'backed': True},
             {'section': 'Plans', 'text': 'Launch on Monday', 'owner': None, 'at': '05:10', 'reasons': ['not found'], 'backed': False}]
    asked = []
    def ask(prompt):
        asked.append(prompt)
        return json.dumps({'points': [{'n': 1, 'context': 'The call supports it: Nina took the API key flow.', 'quotes': [{'text': 'Nina will do the API key flow', 'at': '05:00'}]},
                                      {'n': 2, 'context': 'Came up while reviewing the UI.', 'quotes': [{'text': 'go one by one on each button', 'at': '05:40'}]},
                                      {'n': 3, 'context': 'Monday was agreed.', 'quotes': [{'text': 'we launch Monday for sure', 'at': '05:10'}]}]}), {}
    out, _ = byo.explain_points(items, sent, lines, ask)
    assert len(asked) == 1 and 'knee' not in asked[0] and 'kept on this Mac' in asked[0] and 'FLAGGED' in asked[0], 'one request, from the screened copy'
    assert out[0]['said'] == [{'text': 'Nina will do the API key flow next week. It is the main friction.', 'who': 'Them', 'at': '05:00'}] and out[0]['flagged'], 'from the sentence the quote is in, not the turn\'s start'
    assert out[1]['said'][0]['who'] == 'You' and out[1]['said'][0]['text'].startswith('We need to go one by one') and not out[1]['flagged']
    assert out[2]['context'] == '' and out[2]['said'] == [], 'a quote the transcript does not have takes its context with it'

# Notes written before the explanations existed are explained on the first click, from the copy the yes covered.
def test_notes_written_before_get_their_explanations_later_from_the_approved_copy():
    with tempfile.TemporaryDirectory() as d:
        home = Path(d); call = home / 'calls' / '2026-10-07-1100-priya'; call.mkdir(parents=True)
        (call / 'event.json').write_text(json.dumps(EVENT)); (call / 'transcript.md').write_text(TRANSCRIPT)
        out_md, _, _ = fake_screen(call)
        yes = hashlib.sha256(out_md.read_bytes()).hexdigest()
        (call / 'summary-nebius.md').write_text('# x\n\n## Plans\n- Ship it [00:10] (not sure)\n')
        (call / 'summary-runs.json').write_text(json.dumps([{'output': 'summary-nebius.md', 'checks': [
            {'section': 'Plans', 'text': 'Ship it', 'at': '00:10', 'backed': False, 'reasons': ['not found'], 'owner': None},
            {'section': 'Plans', 'text': 'Fine one', 'at': '00:20', 'backed': True, 'reasons': [], 'owner': None}]}]))
        asked = []
        ask = lambda p: (asked.append(p), (json.dumps({'points': [{'n': 1, 'context': 'Nothing like it was said.', 'quotes': []}]}), {}))[1]
        with contextlib.redirect_stdout(io.StringIO()): target = byo.explain_later(call, 'nebius', approved=yes, ask=ask, screen=fake_screen)
        got = json.loads(target.read_text())
        assert target.name == 'summary-nebius-explain.json' and len(asked) == 1 and [x['text'] for x in got['lines']] == ['Ship it', 'Fine one'] and HELD not in asked[0]
        try: byo.explain_later(call, 'nebius', approved='0' * 64, ask=ask, screen=fake_screen); assert False, 'a copy the yes did not cover is refused'
        except SystemExit as e: assert e.code == 2

# ---------- long calls (2026-10-23: the 10-22 class, 159 minutes, came back as 5 headings from minutes 2-37, 64, 109-131) ----------

CLASS_EVENT = {'title': 'NBA 6124 Imagined Innovation', 'start': '2026-10-22T17:25:00Z', 'me': 'Gio', 'category': 'class'}
WORDS = ['alder', 'birch', 'cedar', 'dogwood', 'elm', 'fir', 'ginkgo', 'hazel', 'ironwood', 'juniper']

def long_transcript(minutes=159):
    # One turn a minute, each its own words; the case to read and "no class next week" are said at minute 157.
    turns = [f"[{m:02d}:00] Me: Point {m} is about the {WORDS[m % 10]} plant and what it costs." for m in range(minutes)]
    if minutes > 157: turns[157] = '[157:00] Me: Please read the glass case before the next session. There is no class next week.'
    return '# NBA 6124 Imagined Innovation\n\nThursday, October 22, 2026. Me (Gio).\n\n' + '\n\n'.join(turns) + '\n'

def part_reply(prompt):
    # The fake model: a part's notes cite two of its own minutes; the merge answers with every part's notes joined.
    if 'You are joining the notes' in prompt:
        bullets = re.findall(r'^- .*$', prompt.split('PARTS:')[1], re.M)
        steps = [b for b in bullets if 'read the glass case' in b]
        return '# NBA 6124 Imagined Innovation\n\n## The plants\n' + '\n'.join(b for b in bullets if b not in steps) + '\n\n## Next Steps\n' + '\n'.join(steps) + '\n'
    stamps = [int(m) for m in re.findall(r'^\[(\d+):00\] Gio:', prompt, re.M)]
    out = f'# NBA 6124 Imagined Innovation\n\n## Plants {stamps[0]}\n'
    for m in (stamps[0], stamps[len(stamps) // 2]):
        out += f'- the {WORDS[m % 10]} plant: what it costs [{m:02d}:00] <!-- Point {m} is about the -->\n'
    if 157 in stamps: out += '\n## Next Steps\n- Read the glass case before the next session [157:00] <!-- read the glass case before the next session -->\n'
    return out

def test_the_shape_scales_with_the_call():
    assert byo.shape_for(159 * 60) == (8, '53 to 80'), byo.shape_for(159 * 60)
    assert byo.shape_for(24 * 60) == (3, '8 to 12') and byo.shape_for(400 * 60)[0] == 12, 'one heading per 20 minutes, 3 to 12'
    assert byo.shape_for(26.5 * 60, part=True) == (2, '9 to 13'), 'a part takes its share'
    template = byo.PROMPT_FILE.read_text()
    assert '3 to 7 headings' not in template and '{headings}' in template and '{cover}' in template and '{next_steps}' in template
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d)
        lines = byo.read_md(folder / 'transcript.md')
        prompt = byo.build_prompt(EVENT, lines, folder)
    assert 'About 3 headings in the order things happened' in prompt and 'Cover the whole call in order, from 04:09 to 23:19, including the last 30 minutes' in prompt
    assert byo.NEXT_STEPS in prompt and byo.CLASS_NEXT_STEPS not in prompt and 'This is part' not in prompt and not re.search(r'\{[a-z_]+\}', prompt)

def test_a_class_gets_its_own_next_steps_and_ultra():
    # A5: class Next Steps are assignments, deadlines and logistics, never an in-class exercise's steps. A4: Ultra.
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d, CLASS_EVENT, long_transcript(30))
        prompt = byo.build_prompt(CLASS_EVENT, byo.read_md(folder / 'transcript.md'), folder, classmates={})
    assert byo.CLASS_NEXT_STEPS in prompt and byo.NEXT_STEPS not in prompt and 'no class next week' in byo.CLASS_NEXT_STEPS and 'exercise done during the class' in byo.CLASS_NEXT_STEPS
    assert byo.notes_model(CLASS_EVENT) == byo.NEBIUS_TEAM_MODEL and byo.notes_model(EVENT) == byo.NEBIUS_MODEL and byo.notes_model({**EVENT, 'goal': 'x'}) == byo.NEBIUS_TEAM_MODEL

def test_a_long_call_is_split_on_turns_and_short_ones_are_not():
    with tempfile.TemporaryDirectory() as d:
        lines = byo.read_md(folder_in(d, CLASS_EVENT, long_transcript()) / 'transcript.md')
    parts = byo.chunks_of(lines)
    assert len(parts) == 6 and [l for p in parts for l in p] == lines, 'every turn once, in order'
    assert all(25 * 60 <= byo.span_of(p) <= byo.CHUNK_MOST for p in parts[:-1]) and byo.span_of(parts[-1]) <= byo.CHUNK_MOST, [byo.span_of(p) for p in parts]
    assert byo.chunks_of(lines[:45]) == [lines[:45]], 'a call of 45 minutes is one pass'
    assert len(byo.chunks_of(lines[:47])) == 2

def test_a_long_class_is_written_in_parts_merged_and_checked_like_one_reply():
    random.seed(1)
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d, CLASS_EVENT, long_transcript())
        yes = approve(folder, masked_screen)
        calls = []
        def ask(prompt):
            calls.append(prompt)
            return part_reply(prompt), {'model': 'nvidia/fake', 'usage': {'prompt_tokens': 100, 'completion_tokens': 20}, 'seconds': 0.1, 'auth': {}, 'finish_reason': 'stop'}
        with contextlib.redirect_stdout(io.StringIO()):
            out, run = byo.run(folder, 'nebius', ask=ask, screen=masked_screen, approved=yes)
        assert len(calls) == 7 and all(c.startswith('Request ') for c in calls), 'six parts and one merge, each with its own first line (Ultra)'
        assert all(f'This is part {k} of 6 of the call' in calls[k - 1] for k in range(1, 7)) and 'You are joining the notes' in calls[6]
        assert 'About 8 headings in all and at most 79 bullets' in calls[6] and 'from 00:00 to 158:00' in calls[6]
        chunks = run['chunks']
        assert [p['part'] for p in chunks['parts']] == [1, 2, 3, 4, 5, 6] and chunks['parts'][0]['from'] == '00:00' and chunks['parts'][-1]['to'] == '158:00'
        assert all(p['bullets'] >= 2 and p['seconds'] >= 0 and p['tokens']['prompt'] == 100 for p in chunks['parts']) and chunks['merge']['bullets'] == 13 and chunks['minutes'] == 158
        assert run['one_pass'] is False and run['bullets'] == 13 and run['cited_verified'] == 13, (run['bullets'], run['cited_verified'])
        text = out.read_text()
        assert '[00:00]' in text and '[145:00]' in text and '## Next Steps\n- Read the glass case before the next session [157:00]\n' in text, text
        assert '_Nebius: 840 tokens (700 in, 140 out) over 7 requests' in text
        raw = folder / 'summary-nebius-raw'
        assert (raw / 'part-6.md').exists() and (raw / 'merge-prompt.txt').read_text() == calls[6] and (raw / 'prompt.txt').read_text() == '\n\n'.join(calls[:6])
        # each part has a ceiling, since the merge keeps what the parts wrote (2026-10-23: parts wrote 21 to 39 bullets)
        assert all('bullets under them in all' in c and ' at most ' in c.split('bullets under them in all')[0][-40:] for c in calls[:6]), calls[0][:2000]
        # the merge joins by topic within a cap (2026-10-23: "keep every bullet" gave 24 headings and 164 bullets)
        assert 'Keep every bullet' not in calls[6] and 'at most 79 bullets' in calls[6] and 'Join by topic' in calls[6] and '{' not in calls[6].split('PARTS:')[0], calls[6][:1500]
        assert json.loads((folder / 'summary-runs.json').read_text())[-1]['chunks'] == chunks

# Review findings (2026-10-23): a broken part wrote partial notes as a success; a class with a goal skipped the parts;
# the merge had the parts' 16,000 tokens whatever they wrote, and a cut merge was not retried.
def long_plan(d):
    folder = folder_in(d, CLASS_EVENT, long_transcript())
    lines = byo.read_md(folder / 'transcript.md')
    return folder, lines, byo.plan_prompts(CLASS_EVENT, lines, folder, byo.PROMPT_FILE.read_text(), (), {})

def meta_of(out=20, finish='stop'):
    return {'model': 'nvidia/fake', 'usage': {'prompt_tokens': 100, 'completion_tokens': out}, 'seconds': 0.1, 'auth': {}, 'finish_reason': finish}

def test_a_part_with_no_usable_notes_is_asked_once_more_then_the_run_stops():
    with tempfile.TemporaryDirectory() as d:
        folder, lines, plan = long_plan(d)
        calls = []
        def flaky(prompt):
            calls.append(prompt)
            if 'This is part 3 of 6' in prompt and sum('This is part 3 of 6' in c for c in calls) == 1: return '<|message_end|>', meta_of()
            return part_reply(prompt), meta_of()
        with contextlib.redirect_stdout(io.StringIO()): reply, meta, record = byo.ask_in_parts(plan, CLASS_EVENT, lines, folder, flaky)
        assert len(calls) == 8 and calls[3] != calls[2] and record['parts'][2]['retried'] is True and record['parts'][2]['bullets'] == 2
        for broken in ('<|message_end|>', '## Plants\n- a point with no minute\n'):
            asked = []
            def bad(prompt):
                asked.append(prompt)
                return (broken if 'This is part 2 of 6' in prompt else part_reply(prompt)), meta_of()
            try:
                with contextlib.redirect_stdout(io.StringIO()): byo.ask_in_parts(plan, CLASS_EVENT, lines, folder, bad)
                assert False, 'a part that fails twice stops the run'
            except SystemExit as e: assert 'part 2 of 6' in str(e) and 'nothing written' in str(e), e
            assert len(asked) == 3 and not any('You are joining the notes' in a for a in asked), 'no merge after a failed part'
        yes = approve(folder, masked_screen)
        def bad(prompt): return ('<|message_end|>' if 'This is part 2 of 6' in prompt else part_reply(prompt)), meta_of()
        try:
            with contextlib.redirect_stdout(io.StringIO()): byo.run(folder, 'nebius', ask=bad, screen=masked_screen, approved=yes)
            assert False
        except SystemExit: pass
        assert not list(folder.glob('summary-nebius*')) and not (folder / 'summary-runs.json').exists(), 'no notes written'

def test_a_class_with_a_workspace_goal_takes_the_class_path():
    with tempfile.TemporaryDirectory() as d:
        call = Path(d) / 'calls' / '2026-10-22-1325-nba-6124'; call.mkdir(parents=True)
        (Path(d) / 'workstreams.json').write_text(json.dumps([{'name': 'Strategy', 'goal': 'Ace the strategy class'}]))
        (call / 'event.json').write_text(json.dumps({**CLASS_EVENT, 'workstream': 'Strategy'}))
        (call / 'transcript.md').write_text(long_transcript())
        assert byo.goal_of({**CLASS_EVENT, 'workstream': 'Strategy'}, call) is None
        yes = approve(call, masked_screen)
        calls = []
        def ask(prompt): calls.append(prompt); return part_reply(prompt), meta_of()
        with contextlib.redirect_stdout(io.StringIO()): out, run = byo.run(call, 'nebius', ask=ask, screen=masked_screen, approved=yes)
        assert len(calls) == 7 and run['prompt_file'] == 'summary-clean.txt' and run['goal'] is None and byo.CLASS_NEXT_STEPS in calls[0]
        byo.USAGE_HOME = None

def test_the_merge_budget_follows_the_parts_and_a_cut_merge_is_asked_again_larger():
    with tempfile.TemporaryDirectory() as d:
        folder, lines, plan = long_plan(d)
        budgets = []
        def merge_ask(prompt, max_tokens):
            budgets.append(max_tokens)
            return part_reply(prompt), meta_of(finish='length' if len(budgets) == 1 else 'stop')
        with contextlib.redirect_stdout(io.StringIO()):
            reply, meta, record = byo.ask_in_parts(plan, CLASS_EVENT, lines, folder, lambda p: (part_reply(p), meta_of(3000)), merge_ask=merge_ask)
        assert budgets == [byo.merge_budget([3000] * 6), min(byo.MERGE_MOST, 2 * byo.merge_budget([3000] * 6))], budgets
        assert byo.merge_budget([3000] * 6) == 23500 and byo.merge_budget([20] * 6) == byo.MERGE_LEAST and byo.merge_budget([30000] * 6) == byo.MERGE_MOST
        assert record['merge']['max_tokens'] == budgets[-1] and record['merge']['retried'] is True and meta['calls'] == 8
        cut = lambda prompt, max_tokens: (part_reply(prompt), meta_of(finish='length'))
        try:
            with contextlib.redirect_stdout(io.StringIO()): byo.ask_in_parts(plan, CLASS_EVENT, lines, folder, lambda p: (part_reply(p), meta_of(3000)), merge_ask=cut)
            assert False, 'a merge cut twice stops'
        except SystemExit as e: assert 'token limit' in str(e) and 'nothing written' in str(e)
    long_cut = lambda url, headers, body: (200, json.dumps({'model': 'nvidia/x', 'usage': {}, 'choices': [{'finish_reason': 'length', 'message': {'content': 'part of it'}}]}).encode())
    text, meta = byo.ask_nebius('p', key='k', transport=long_cut, allow_length=True)
    assert text == 'part of it' and meta['finish_reason'] == 'length', 'the merge sees a cut answer and decides'

# The class gate (2026-10-23): a class's Next Step stays only when the paragraph it cites speaks of after the class. The
# 10-22 class listed eight steps done in the room beside one real one; these are their shapes, in made-up words.
AFTER_KEPT = {
    'due': "Your memo is due Thursday at 9. Right now, take five minutes in your groups to outline it.",
    'assignment': "The individual assignment goes out tonight; in your teams, start on the second half of the session's case.",
    'exam': "The midterm is November 9, in person.",
    'submit': "Submit the slides you showed the judges, with the video.",
    'no class': "There is no class next week. Okay, take ten minutes to finish at the board.",
    'cancelled': "Thursday's session is cancelled; we make it up in December.",
    'next week': "Oh, next week I am away. See you the week after next.",
    'weekday': "The session is on a Friday at 9 a.m., not here.",
    'date': "The conference is on October 23 if you want the extra credit.",
    'weekend': "We trade the time slots on the spreadsheet over the weekend.",
    'read': "Please read chapter four before we meet again.",
    'prepare the case': "It is really important to prepare the glass case.",
    'come prepared': "We do patents then. Come prepared.",
    'email': "Email me the deck when it is done.",
    'office hours': "Come to office hours with questions on the model.",
    'sign up': "Sign up for a slot on the sheet.",
    'let us know': "If you foresee time constraints, let us know early so we can reassign.",
    'grading': "When grading, flick through a few random answers first.",
    'room': "We meet in a different room from now on, the one on the third floor.",
}
AFTER_DROPPED = {
    'minutes': "Get your papers, take about five minutes to prepare, and then we start negotiating.",
    'within minutes': "Prepare your role within five minutes and then find your counterpart.",
    'have minutes': "We have like five minutes, so ask us anything that is on your mind.",
    'break': "So let's take a five-minute break, and then we go to the next case.",
    'after the break': "After the break we read the next case together.",
    'right now': "So for pricing right now, how much are the customers paying?",
    'groups': "Go back into the groups you were in, split each group in half, and pick your roles.",
    'board': "Write your three answers on the board.",
    'second half': "The guest will talk about that in the second half of the session.",
    'day loses to now': "Next week's topic aside, right now take ten minutes in your teams.",
    'prep loses to now': "Take five minutes to prepare the case in your groups.",
    'nothing': "For an advantage to be sustainable it cannot be easily copied; from the reading, culture matters.",
    'a story': "When the guest comes in a couple of weeks he can tell you more about the patent fight.",
    'due diligence': "Due diligence on the partner took the team months.",
    'cancel in a story': "Who said cancel the agreements? Team five did.",
}

def test_a_class_next_step_stays_only_when_its_paragraph_speaks_of_after_the_class():
    for family, text in AFTER_KEPT.items():
        kept, why = byo.after_class(text)
        assert kept and why.startswith('after class: '), (family, why)
    for family, text in AFTER_DROPPED.items():
        kept, why = byo.after_class(text)
        assert not kept, (family, why)
    assert byo.after_class(AFTER_DROPPED['break']) == (False, 'about now: "five-minute"')
    assert byo.after_class(AFTER_DROPPED['nothing']) == (False, 'nothing about after this class')
    assert byo.after_class(AFTER_KEPT['due'])[1] == 'after class: "due"', 'a deadline wins over the words of now'

CLASS_STEPS_TRANSCRIPT = """# NBA 6124 Imagined Innovation

Thursday, October 22, 2026. Me (Gio).

[00:10] Me: Today we look at how the glass plant sets its price for the three big customers.

[05:00] Me: So let's take a five-minute break, and then we're gonna go to the next case.

[09:00] Me: Get into your groups, split each group in half, and take about five minutes to prepare your role.

[12:00] Me: So for pricing right now, how much are the customers paying for the glass?

[58:00] Me: For next week, please read the fiber case and submit a one-page memo by Monday.

[59:00] Me: Oh, next week I am away. See you the week after next.
"""

CLASS_STEPS_REPLY = """# NBA 6124 Imagined Innovation

## Pricing the glass
- The plant prices for three big customers [00:10] <!-- sets its price for the three big customers -->

## Next Steps
- Prepare for the next case after the break [05:00] <!-- and then we're gonna go to the next case -->
- Begin the negotiation exercise in assigned roles [09:00] <!-- take about five minutes to prepare your role -->
- Prepare for the next class session on pricing [12:00] <!-- So for pricing right now -->
- Read the fiber case and submit a one-page memo by Monday [58:00] <!-- please read the fiber case and submit -->
- No class next week; class resumes the week after next [59:00] <!-- next week I am away -->
"""

def test_the_class_gate_drops_room_steps_records_why_and_leaves_other_calls_alone():
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d, CLASS_EVENT, CLASS_STEPS_TRANSCRIPT)
        lines = byo.read_md(folder / 'transcript.md')
    sections, _ = byo.parse_reply(CLASS_STEPS_REPLY)
    kept, checks, drops, counts = byo.check(sections, lines, CLASS_EVENT, '')
    steps = [b['text'] for s in kept if s['next'] for b in s['bullets']]
    assert steps == ['Read the fiber case and submit a one-page memo by Monday', 'No class next week; class resumes the week after next'], steps
    assert counts['in_class_dropped'] == [
        {'text': 'Prepare for the next case after the break', 'at': '05:00', 'why': 'about now: "five-minute"'},
        {'text': 'Begin the negotiation exercise in assigned roles', 'at': '09:00', 'why': 'about now: "your groups"'},
        {'text': 'Prepare for the next class session on pricing', 'at': '12:00', 'why': 'about now: "right now"'}], counts['in_class_dropped']
    assert [d['why'] for d in drops] == ['next step in class: about now: "five-minute"', 'next step in class: about now: "your groups"', 'next step in class: about now: "right now"']
    assert [c['after_class'] for c in checks if c['section'] == 'Next Steps'] == ['after class: "submit"', 'after class: "next week"']
    assert 'after_class' not in checks[0], 'only a class step carries the reason'
    # the same reply on a call that is not a class: every step stays, as before
    chat = {**EVENT, 'title': 'Priya & Gio - Pricing Chat'}
    kept, checks, drops, counts = byo.check(sections, lines, chat, '')
    assert len([b for s in kept if s['next'] for b in s['bullets']]) == 5 and drops == [] and counts['in_class_dropped'] == []
    assert not any('after_class' in c for c in checks)

def test_a_part_of_a_class_and_its_merge_keep_only_after_class_steps():
    # 2026-10-23: the parts of the 10-22 class ended before the class did and wrote "after break" steps; the merge kept them.
    assert 'week after next' in byo.CLASS_NEXT_STEPS and 'five-minute break' in byo.CLASS_NEXT_STEPS, 'one kept and one dropped example'
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d, CLASS_EVENT, long_transcript())
        lines = byo.read_md(folder / 'transcript.md')
        parts = byo.chunks_of(lines)
        part = byo.build_prompt(CLASS_EVENT, parts[0], folder, classmates={}, part=(1, len(parts)))
        whole = byo.build_prompt(CLASS_EVENT, lines[:30], folder, classmates={})
        merge = byo.build_merge_prompt(CLASS_EVENT, lines, folder, ['x'] * len(parts), parts, classmates={})
        chat_part = byo.build_prompt(EVENT, parts[0], folder, part=(1, len(parts)))
        chat_merge = byo.build_merge_prompt(EVENT, lines, folder, ['x'] * len(parts), parts)
    assert byo.CLASS_NEXT_STEPS + byo.CLASS_PART_STEPS in part and byo.CLASS_PART_STEPS not in whole and byo.CLASS_NEXT_STEPS in whole
    assert byo.CLASS_MERGE_STEPS in merge and byo.CLASS_MERGE_STEPS not in chat_merge and '{class_steps}' not in chat_merge
    assert byo.CLASS_PART_STEPS not in chat_part and byo.NEXT_STEPS in chat_part, 'a call that is not a class is asked as before'

def test_a_class_run_records_the_steps_the_gate_dropped():
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d, CLASS_EVENT, CLASS_STEPS_TRANSCRIPT)
        yes = approve(folder, masked_screen)
        ask, _ = fake(CLASS_STEPS_REPLY)
        with contextlib.redirect_stdout(io.StringIO()):
            out, run = byo.run(folder, 'nebius', ask=ask, screen=masked_screen, approved=yes)
        text = out.read_text()
        record = json.loads((folder / 'summary-runs.json').read_text())[-1]
    assert '## Next Steps\n- Read the fiber case and submit a one-page memo by Monday [58:00]\n- No class next week; class resumes the week after next [59:00]\n' in text, text
    assert 'after the break' not in text and 'negotiation exercise' not in text
    assert record['next_steps']['in_class_dropped'] == run['next_steps']['in_class_dropped'] and len(run['next_steps']['in_class_dropped']) == 3
    assert [d['at'] for d in record['next_steps']['dropped']] == ['05:00', '09:00', '12:00'] and all(d['why'].startswith('next step in class: about now') for d in record['next_steps']['dropped'])
    assert record['next_steps']['kept'] == ['Read the fiber case and submit a one-page memo by Monday', 'No class next week; class resumes the week after next']

def test_dry_run_prints_the_parts_of_a_long_call():
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d, CLASS_EVENT, long_transcript())
        masked_screen(folder)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf): byo.run(folder, 'nebius', dry_run=True)
        printed = buf.getvalue()
    assert f'model {byo.NEBIUS_TEAM_MODEL}' in printed and 'Shape asked for 158 minutes: about 8 headings and 53 to 79 bullets' in printed
    assert 'Long call: 6 parts, one request each, then one merge request (summary-merge.txt): part 1 00:00 to ' in printed and 'Point 12 is' not in printed

# Codex review, round 2 (2026-10-23): the long-call path wrote partial or empty notes as a success, retries were paid
# again or answered from the saved failure, a real 46-minute call went in one pass, and the run record lost attempts.
ULTRA = 'nvidia/Nemotron-3-Ultra-550b-a55b'
def ultra_nonce(text): return f"Request {os.urandom(4).hex()}.\n\n{text}"
def asked_of(body): return json.loads(body)['messages'][0]['content']
def answered(content, finish='stop', out=20):
    return 200, json.dumps({'model': 'nvidia/x', 'usage': {'prompt_tokens': 100, 'completion_tokens': out}, 'choices': [{'finish_reason': finish, 'message': {'content': content}}]}).encode()

def only_part_one(prompt):
    # a merge that keeps part 1's bullets and silently drops parts 2 to 6
    first = prompt.split('PARTS:')[1].split('</part>')[0]
    return '# NBA 6124 Imagined Innovation\n\n## Plants\n' + '\n'.join(re.findall(r'^- .*$', first, re.M)) + '\n', meta_of()

def test_a_merge_that_drops_a_whole_part_is_asked_again_then_stops():
    with tempfile.TemporaryDirectory() as d:
        folder, lines, plan = long_plan(d)
        asked = []
        def drops(prompt, max_tokens): asked.append(prompt); return only_part_one(prompt)
        try:
            with contextlib.redirect_stdout(io.StringIO()): byo.ask_in_parts(plan, CLASS_EVENT, lines, folder, lambda p: (part_reply(p), meta_of()), merge_ask=drops)
            assert False, 'a merge without parts 2 to 6 is not the notes'
        except SystemExit as e: assert 'part' in str(e) and 'nothing written' in str(e), e
        assert len(asked) == 2 and asked[1] != asked[0], 'asked once more with a changed request'
        def recovers(prompt, max_tokens): asked.append(prompt); return only_part_one(prompt) if len(asked) == 3 else (part_reply(prompt), meta_of())
        with contextlib.redirect_stdout(io.StringIO()): reply, meta, record = byo.ask_in_parts(plan, CLASS_EVENT, lines, folder, lambda p: (part_reply(p), meta_of()), merge_ask=recovers)
        assert len(asked) == 4 and record['merge']['retried'] is True and all(f'[{m:02d}:00]' in reply for m in (0, 145)), reply

def interrupted(text):
    chunks = stream_chunks(text)
    chunks[-2]['choices'][0]['finish_reason'] = None   # the content came, the stream ended before saying it finished
    return chunks

def test_a_stream_that_ends_without_finishing_is_not_an_answer():
    old_open, old_home = byo.urllib.request.urlopen, byo.USAGE_HOME
    opened = []
    def urlopen(req, timeout=None):
        opened.append(req)
        text = part_reply(asked_of(req.data))
        return FakeStream(interrupted(text) if len(opened) == 1 else stream_chunks(text))
    try:
        byo.USAGE_HOME = None
        byo.urllib.request.urlopen = urlopen
        try: byo.ask_nebius('## X\n[01:00] Gio: a', key='k', on_text=lambda t, final=False: None, allow_length=True); assert False, 'a cut stream is no answer'
        except SystemExit as e: assert 'nothing written' in str(e), e
        opened.clear()
        with tempfile.TemporaryDirectory() as d:
            folder, lines, plan = long_plan(d)
            merge_ask = lambda p, n: byo.ask_nebius(p, key='k', model=ULTRA, max_tokens=n, on_text=lambda t, final=False: None, allow_length=True)
            with contextlib.redirect_stdout(io.StringIO()): reply, meta, record = byo.ask_in_parts(plan, CLASS_EVENT, lines, folder, lambda p: (part_reply(p), meta_of()), merge_ask=merge_ask)
        assert len(opened) == 2 and record['merge']['retried'] is True and meta['finish_reason'] == 'stop', (len(opened), record['merge'])
    finally: byo.urllib.request.urlopen, byo.USAGE_HOME = old_open, old_home

def test_a_short_class_with_no_usable_notes_is_asked_once_more_then_stops():
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d, CLASS_EVENT, long_transcript(30))
        yes = approve(folder, masked_screen)
        calls = []
        def broken(prompt): calls.append(prompt); return '<|message_end|>', meta_of()
        try:
            with contextlib.redirect_stdout(io.StringIO()): byo.run(folder, 'nebius', ask=broken, screen=masked_screen, approved=yes)
            assert False, 'empty class notes are not a success'
        except SystemExit as e: assert 'nothing written' in str(e), e
        assert len(calls) == 2 and calls[1] != calls[0] and not list(folder.glob('summary-nebius*')) and not (folder / 'summary-runs.json').exists()
        calls.clear()
        def once(prompt): calls.append(prompt); return ('<|message_end|>' if len(calls) == 1 else part_reply(prompt)), meta_of()
        with contextlib.redirect_stdout(io.StringIO()): out, run = byo.run(folder, 'nebius', ask=once, screen=masked_screen, approved=yes)
        assert len(calls) == 2 and run['bullets'] == 2 and '[00:00]' in out.read_text()

def test_an_empty_part_or_an_empty_cut_merge_takes_the_retry_it_was_promised():
    old_home = byo.USAGE_HOME
    try:
        byo.USAGE_HOME = None
        with tempfile.TemporaryDirectory() as d:
            folder, lines, plan = long_plan(d)
            sent = []
            def empty_part_3(url, headers, body):
                content = asked_of(body); sent.append(content)
                return answered('' if 'This is part 3 of 6' in content and sum('This is part 3 of 6' in c for c in sent) == 1 else part_reply(content))
            ask = lambda p: byo.ask_nebius(p, key='k', transport=empty_part_3)
            with contextlib.redirect_stdout(io.StringIO()): reply, meta, record = byo.ask_in_parts(plan, CLASS_EVENT, lines, folder, ask)
            assert len(sent) == 8 and record['parts'][2]['retried'] is True
            budgets = []
            def empty_cut(url, headers, body):
                budgets.append(json.loads(body)['max_tokens'])
                return answered('', 'length') if len(budgets) == 1 else answered(part_reply(asked_of(body)))
            merge_ask = lambda p, n: byo.ask_nebius(p, key='k', transport=empty_cut, max_tokens=n, allow_length=True)
            with contextlib.redirect_stdout(io.StringIO()): reply, meta, record = byo.ask_in_parts(plan, CLASS_EVENT, lines, folder, lambda p: (part_reply(p), meta_of()), merge_ask=merge_ask)
            assert budgets == [byo.MERGE_LEAST, 2 * byo.MERGE_LEAST] and record['merge']['retried'] is True, budgets
    finally: byo.USAGE_HOME = old_home

def test_a_retried_part_is_paid_once_and_a_rerun_answers_from_saved_copies():
    old_home = byo.USAGE_HOME
    try:
        with tempfile.TemporaryDirectory() as d:
            byo.USAGE_HOME = d
            folder, lines, _ = long_plan(d)
            sent = []
            def part_3_breaks(url, headers, body):
                content = asked_of(body); sent.append(content)
                first = 'This is part 3 of 6' in content and 'The first answer for this part' not in content
                return answered('<|message_end|>' if first else part_reply(content))
            ask = lambda p: byo.ask_nebius(p, key='k', transport=part_3_breaks, model=ULTRA)
            counts = []
            for _ in range(2):
                plan = byo.plan_prompts(CLASS_EVENT, lines, folder, byo.PROMPT_FILE.read_text(), (), {})
                for p in plan: p['prompt'] = ultra_nonce(p['prompt'])
                before = len(sent)
                with contextlib.redirect_stdout(io.StringIO()): byo.ask_in_parts(plan, CLASS_EVENT, lines, folder, ask, {}, ultra_nonce)
                counts.append(len(sent) - before)
            assert counts == [8, 0], counts
    finally: byo.USAGE_HOME = old_home

def test_goal_and_team_retries_ask_a_changed_question_not_the_saved_failure():
    old_home = byo.USAGE_HOME
    cut = '## Executive Summary\n- Cut [01:00] <!-- looking at the financials --><|message_end|>'
    try:
        for event, transcript, bad, good in (({**EVENT, 'workstream': 'Acme Bank'}, TRANSCRIPT, TRANSCRIPT, REPLY), (TEAM_EVENT, TEAM_TRANSCRIPT, cut, TEAM_GOOD)):
            with tempfile.TemporaryDirectory() as d:
                home = Path(d); call = home / 'calls' / '2026-10-09-1258-lena-chat'; call.mkdir(parents=True)
                (home / 'workstreams.json').write_text(json.dumps([{'name': 'Acme Bank', 'goal': 'Get an offer', 'goalText': 'Get the Acme Bank analyst offer'}]))
                (call / 'event.json').write_text(json.dumps(event)); (call / 'transcript.md').write_text(transcript)
                yes = approve(call)
                sent = []
                def transport(url, headers, body): sent.append(asked_of(body)); return answered(bad if len(sent) == 1 else good)
                ask = lambda p: byo.ask_nebius(p, key='k', transport=transport, model=ULTRA)
                with contextlib.redirect_stdout(io.StringIO()): out, run = byo.run(call, 'nebius', ask=ask, screen=fake_screen, approved=yes)
                assert len(sent) == 2 and byo.NONCE.sub('', sent[1]) != byo.NONCE.sub('', sent[0]), (event['title'], len(sent))
                assert run['bullets'] >= 2 and '<|' not in out.read_text()
    finally: byo.USAGE_HOME = old_home

def test_a_real_46_minute_call_goes_in_two_parts():
    # transcript.py's writer: a paragraph runs up to two minutes on, and the header holds the recording's length
    turns = [f"[{m:02d}:00] Priya Shah: Point {m} is about the {WORDS[m % 10]} plant." for m in range(44)]
    text = ('# Priya & Gio - Coffee Chat\n\nWednesday, October 7, 2026, 11:00, 46 min. Me (Gio) and Priya Shah.\n_model, v2._\n\n' + '\n\n'.join(turns)
            + '\n\n[44:00] Me: and the last two minutes run on as one paragraph to the end.\n')
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d, EVENT, text)
        lines = byo.read_md(folder / 'transcript.md')
        assert byo.span_of(lines) == 46 * 60, byo.span_of(lines)
        assert len(byo.chunks_of(lines)) == 2 and len(byo.plan_prompts(EVENT, lines, folder, byo.PROMPT_FILE.read_text())) == 2
    with tempfile.TemporaryDirectory() as d:
        short = byo.read_md(folder_in(d) / 'transcript.md')
    assert byo.span_of(short) == 24 * 60 - (4 * 60 + 9), 'the 24-minute call runs to the end of its recording'

def test_a_literal_placeholder_inside_a_part_is_never_filled_by_the_merge():
    with tempfile.TemporaryDirectory() as d:
        folder, lines, plan = long_plan(d)
        parts = [p['lines'] for p in plan]
        replies = ['## Forms\n- the form keeps its token [00:00] <!-- Put the token {title} into -->'] + ['- x [30:00] <!-- y -->'] * (len(parts) - 1)
        merge = byo.build_merge_prompt(CLASS_EVENT, lines, folder, replies, parts, {})
    assert '<!-- Put the token {title} into -->' in merge and '"NBA 6124 Imagined Innovation"' in merge, merge.split('PARTS:')[1][:300]

def test_the_run_record_counts_every_attempt_and_every_request():
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d, CLASS_EVENT, long_transcript())
        yes = approve(folder, masked_screen)
        calls = []
        def flaky(prompt):
            calls.append(prompt)
            if 'This is part 3 of 6' in prompt and sum('This is part 3 of 6' in c for c in calls) == 1: return '<|message_end|>', meta_of(13)
            return part_reply(prompt), meta_of()
        with contextlib.redirect_stdout(io.StringIO()): out, run = byo.run(folder, 'nebius', ask=flaky, screen=masked_screen, approved=yes)
        chunks = run['chunks']
        recorded = [x for p in chunks['parts'] for x in [*p.get('failed', []), p]] + [*chunks['merge'].get('failed', []), chunks['merge']]
        assert len(calls) == 8 and len(recorded) == 8, (len(calls), len(recorded))
        assert sum(x['tokens']['completion'] for x in recorded) == run['usage']['completion_tokens'] == 7 * 20 + 13
        assert chunks['parts'][2]['chars'] == len(calls[3]) and chunks['parts'][2]['failed'][0]['chars'] == len(calls[2])
        assert run['chars']['prompt'] == sum(len(c) for c in calls) == sum(x['chars'] for x in recorded)

def test_a_long_interview_never_feeds_a_surname_back_to_the_merge():
    # The rehearsal on the real mock (71 min: three parts and a merge, 2026-10-26): a part's reply that names someone by
    # full name went back out inside the merge request. The guard at the send trims every request.
    event = {'title': 'Mock interview', 'me': 'Gio', 'with': 'Priya Shah', 'names': 'Priya Shah', 'category': 'one-on-one'}
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d, event, long_transcript(80).replace('# NBA 6124 Imagined Innovation', '# Mock interview').replace('Me (Gio).', 'Me (Gio) and Priya Shah.'))
        yes = approve(folder, privacy.screen_folder)
        calls = []
        def echo(prompt, *rest):
            calls.append(prompt)
            reply = part_reply(prompt)
            if 'You are joining the notes' not in prompt: reply += '- Priya Shah asked about the plants [00:00] <!-- Point 0 is about the -->\n'
            return reply, meta_of()
        with contextlib.redirect_stdout(io.StringIO()): out, run_ = byo.run(folder, 'nebius', ask=echo, screen=privacy.screen_folder, approved=yes)
        assert len(calls) == 4 and any('You are joining the notes' in c for c in calls), len(calls)
        assert all('Shah' not in c for c in calls), [c[:200] for c in calls if 'Shah' in c]
        assert 'Shah' not in out.read_text() and 'Shah' not in (folder / 'summary-runs.json').read_text()

def test_a_call_saved_as_me_takes_the_users_name_and_an_interview_says_who_asks():
    # The mock interview (2026-10-26): event.json "me" was "Me", so the notes gave two Next Steps to "the person who
    # recorded the call", and the interviewer's offer to answer questions went to the user.
    event = {**EVENT, 'me': 'Me', 'title': 'Priya Shah mock interview', 'workstream': 'none'}
    with tempfile.TemporaryDirectory() as d:
        home = Path(d); call = home / 'calls' / '2026-10-26-1034-mock'; call.mkdir(parents=True)
        (home / 'settings.json').write_text(json.dumps({'signName': 'Gio Caballero'}))
        (call / 'event.json').write_text(json.dumps(event)); (call / 'transcript.md').write_text(TRANSCRIPT)
        yes = approve(call, privacy.screen_folder)
        ask, notes = fake(REPLY)
        with contextlib.redirect_stdout(io.StringIO()): byo.run(call, 'nebius', ask=ask, screen=privacy.screen_folder, approved=yes)
        assert 'Gio recorded it; the other person is Priya.' in notes[0] and 'the person who recorded the call' not in notes[0], notes[0][:600]
        assert 'This is an interview: Priya asks the questions as the interviewer and Gio answers.' in notes[0]
        assert 'Caballero' not in notes[0] or 'Gio Caballero' in TRANSCRIPT, 'the first word of the sign-off name'
    assert byo.with_my_name({'me': 'Ana'}) == {'me': 'Ana'}, 'a name the event has stays'
    people, _, _, _ = byo.people_sentence({**EVENT, 'title': 'Coffee chat'}, [])
    assert 'interview' not in people, 'any other call: as before'

def test_a_quote_written_under_a_point_becomes_its_citation():
    # Nemotron 3 Ultra on a short goal call (2026-10-29): the evidence as a visible line under each point, with or without
    # quotation marks, and no stamp on the point; a Next Step citing that minute borrows the quote.
    reply = '## Deadlines\n- Benchmarks due Wednesday\n  - "Get me the competitor benchmarks by Wednesday" [00:20]\n- Dry run next Thursday\n  - Run through next Thursday at four [00:37]\n- Kept point [00:40] <!-- its own words here -->\n  - a figure under it [00:41]\n## Next Steps\n- Deliver benchmarks by Wednesday (Jess) [00:20]\n'
    sections, _ = byo.parse_reply(reply)
    dl, ns = sections[0]['bullets'], sections[1]['bullets']
    assert [(b['text'], b['at'], b['quote']) for b in dl[:2]] == [('Benchmarks due Wednesday', '00:20', 'Get me the competitor benchmarks by Wednesday'), ('Dry run next Thursday', '00:37', 'Run through next Thursday at four')]
    assert [b['text'] for b in dl[2:]] == ['Kept point', 'a figure under it'], 'a point with its own citation keeps its nested bullets'
    assert (ns[0]['at'], ns[0]['quote'], ns[0]['owner']) == ('00:20', 'Get me the competitor benchmarks by Wednesday', 'Jess')

if __name__ == '__main__':
    import fixtures; fixtures.run(globals())
