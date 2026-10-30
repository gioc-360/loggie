# privacy.py --thread tests: an email thread (Loggie's THREAD.md, workstreams.js:272) is screened on
# the Mac the way a call is. Footers, quoted replies, To:/Cc: lines, attachment and link lists come off first, so a
# confidentiality notice never holds its whole message; a health line is held; every sentence that carries an ask is
# sent; addresses, links and attachment names never reach OUTBOUND.md. Hand-written threads, made-up people.
# Deterministic: no network, no model.
#   python3 test_privacy_thread.py   (exit 0 = pass)
import contextlib, io, json, subprocess, sys, tempfile
from pathlib import Path
import privacy

LEGAL = ('CONFIDENTIALITY NOTICE: This email and any attachments are confidential and may be privileged. If you are not '
         'the intended recipient, please notify the sender and delete this message.')

PRICING = f"""# Re: Pricing deck for Thursday

## Lena Ortiz <lena.ortiz@northwind.example> · 2026-10-05T14:02:00.000Z
To: Gio Caballero <gio@example.edu>, Sam Park <sam.park@northwind.example>
Cc: Ana Ruiz <ana.ruiz@northwind.example>

Hi Gio,

Thanks for sending the first draft over. The competitor table reads well and the story holds together.
Could you add a slide comparing the three pricing tiers before Thursday's review?
I'm having knee surgery on Friday, so I'll be offline next week.
Sam will run the review if I can't make it.

Best,
Lena Ortiz
Senior Analyst, Northwind Partners
+1 (607) 555-0142 | lena.ortiz@northwind.example

{LEGAL}

Attachments (hikyaku has not opened them):
- pricing-draft-v2.pptx (pptx, 812 KB)

Links in this email (hikyaku never opens them):
- Shared folder -> drive.example.com

## Gio Caballero <gio@example.edu> · 2026-10-05T16:40:00.000Z
To: Lena Ortiz <lena.ortiz@northwind.example>

Will do, I'll have the tier slide in by Wednesday night. Please review the outline at https://docs.example.com/d/abc123 and leave comments by Monday.
Hope the surgery goes smoothly.

On Mon, Oct 5, 2026 at 10:02 AM Lena Ortiz <lena.ortiz@northwind.example> wrote:
> Hi Gio,
> I'm having knee surgery on Friday, so I'll be offline next week.
"""

INTERVIEW = """# Interview loop next week

## Priya Nair <priya@halcyon.example> · 2026-10-06T09:15:00.000Z
To: gio@example.edu

Hi Gio,

Thank you for applying to the product role at Halcyon Labs. The team enjoyed reading your case write-up.
Can you send me two times that work for a 30 minute call next Tuesday or Wednesday?
The first round is with our head of product and runs about half an hour.

Thanks,
Priya
Talent Partner | Halcyon Labs

You are receiving this email because you applied to a role at Halcyon Labs. To unsubscribe from recruiting updates, visit https://halcyon.example/prefs.

## gio@example.edu · 2026-10-06T11:30:00.000Z
To: Priya Nair <priya@halcyon.example>

Tuesday at 2 PM or Wednesday at 10 AM both work for me. Loop in sam.park@northwind.example if he should join.
--
Gio Caballero
MBA Candidate, Class of 2027
607-555-0199
"""

PROJECT = """# Team project check-in

## Tomas Ruiz <tomas.ruiz@example.edu> · 2026-10-04T20:05:00.000Z
To: Gio Caballero <gio@example.edu>, Mei Chen <mei.chen@example.edu>

Hey both,

The survey closed with 214 responses, which is more than we planned for.
I cleaned the file and dropped the duplicates.
Could you book a room in Sage Hall for Thursday at 4 so we can go through the clusters?
Mei is drafting the methods section this weekend.
I've been sick with the flu all week, so my part of the slides is behind.

Sent from my iPhone

## Mei Chen <mei.chen@example.edu> · 2026-10-04T21:10:00.000Z
To: Tomas Ruiz <tomas.ruiz@example.edu>, Gio Caballero <gio@example.edu>

Thursday works for me.
I'll send the methods draft by Saturday night.
The segmentation looks cleaner than last time.
We should keep the four-cluster version for the deck.

This message and any attachments are confidential and intended solely for the addressee. Any review, use or distribution by anyone else is prohibited.

Get Outlook for iOS
"""

THREADS = {'pricing': PRICING, 'interview': INTERVIEW, 'project': PROJECT}

# The planted lines, as the words that must or must not cross.
HEALTH = ["I'm having knee surgery on Friday, so I'll be offline next week.", 'Hope the surgery goes smoothly.',
          "I've been sick with the flu all week, so my part of the slides is behind."]
ASKS = ["Could you add a slide comparing the three pricing tiers before Thursday's review?",
        'Please review the outline at [link kept on this Mac] and leave comments by Monday.',
        'Can you send me two times that work for a 30 minute call next Tuesday or Wednesday?',
        'Tuesday at 2 PM or Wednesday at 10 AM both work for me.',
        'Could you book a room in Sage Hall for Thursday at 4 so we can go through the clusters?',
        "I'll send the methods draft by Saturday night."]
NEVER = ['@', 'http', 'www.', 'To:', 'Cc:', 'pricing-draft-v2.pptx', 'drive.example.com', 'Shared folder', 'Attachments', 'Links in this email',
         '555-0142', '555-0199', 'intended recipient', 'intended solely', 'unsubscribe', 'Sent from my iPhone', 'Get Outlook', 'Senior Analyst',
         'Talent Partner', 'MBA Candidate', 'wrote:', '> ']

def screen(text):
    subject, turns = privacy.parse_thread_md(text)
    return privacy.screen_thread(subject, turns, {'me': 'Gio'})

def test_parse_keeps_bodies_and_takes_off_footers_first():
    subject, turns = privacy.parse_thread_md(PRICING)
    assert subject == 'Re: Pricing deck for Thursday' and [(t['who'], t['stamp']) for t in turns] == [('Lena Ortiz', '2026-10-05T14:02:00.000Z'), ('Gio Caballero', '2026-10-05T16:40:00.000Z')]
    lena = turns[0]
    assert lena['sentences'][0] == 'Hi Gio,' and "Could you add a slide comparing the three pricing tiers before Thursday's review?" in lena['sentences']
    assert lena['sentences'][-1] == "Sam will run the review if I can't make it.", 'the sign-off, signature and notice are not sentences to screen'
    assert [r['rule'] for r in lena['removed']] == ['footer'] and 'intended recipient' in lena['removed'][0]['text'] and 'Senior Analyst' in lena['removed'][0]['text']
    assert lena['left_out'] == {'addressees': 3, 'attachments': 1, 'links': 1, 'addresses': 0, 'phones': 0}, lena['left_out']
    gio = turns[1]
    assert [r['rule'] for r in gio['removed']] == ['quoted'] and 'knee surgery' in gio['removed'][0]['text'] and not any('knee' in s for s in gio['sentences'])
    assert gio['left_out']['links'] == 1 and gio['left_out']['addressees'] == 1
    # a bare address gives no name: the address never becomes the speaker
    _, turns = privacy.parse_thread_md(INTERVIEW)
    assert [t['who'] for t in turns] == ['Priya Nair', 'unknown sender']
    assert turns[0]['sentences'][-1] == 'The first round is with our head of product and runs about half an hour.' and turns[0]['removed'][0]['text'].startswith('Thanks,')
    assert turns[1]['sentences'] == ['Tuesday at 2 PM or Wednesday at 10 AM both work for me.', 'Loop in [address kept on this Mac] if he should join.'], turns[1]['sentences']
    assert 'Gio Caballero' in turns[1]['removed'][0]['text'] and turns[1]['removed'][0]['text'].startswith('--')

def test_the_footer_would_hold_the_whole_message_but_never_reaches_the_screen():
    # The hazard (spec R3): a notice is a confidential hit, and a confidential hit holds its whole turn (TURN_WIDE).
    assert privacy.code_hit(LEGAL.split('. ')[0] + '.') == ('confidential', 'confidential')
    assert privacy.code_hit('This message and any attachments are confidential and intended solely for the addressee.')[0] == 'confidential'
    screened = []
    for name, text in THREADS.items():
        outbound, record = screen(text)
        screened += [l['text'] for l in record['lines']]
        assert record['counts']['turns_fully_held'] == 0, (name, record['counts'])
        assert not [h for h in record['held'] if h['rule'] == 'whole-turn'], (name, record['held'])
        removed = [h for h in record['held'] if h['rule'] in ('footer', 'quoted')]
        assert removed and all(h['layer'] == 'code' and h['category'] == 'confidential' and h['i'] is None for h in removed), removed
    screened = '\n'.join(screened)
    for words in ('intended recipient', 'intended solely', 'unsubscribe', 'Sent from my iPhone', 'Get Outlook', 'Senior Analyst', '555-0142', '@', 'pricing-draft'):
        assert words not in screened, f'{words!r} was screened as a sentence: the footer came off after the screen, not before'
    assert 'Hi Gio,' in screened

def test_health_lines_are_held_and_every_ask_is_sent():
    outbound = {}
    for name, text in THREADS.items():
        outbound[name], record = screen(text)
        for h in record['held']:
            if h['i'] is not None: assert h['layer'] == 'code', h
    every = '\n'.join(outbound.values())
    for line in HEALTH:
        assert line not in every, f'health line crossed: {line}'
    assert '[health kept on this Mac]' in outbound['pricing'] and '[health kept on this Mac]' in outbound['project']
    for ask in ASKS:
        assert ask in every, f'ask not sent: {ask}\n{every}'
    # the message keeps its "## who · ISO" line; the body goes out sentence by sentence, held ones marked in place
    assert '## Lena Ortiz · 2026-10-05T14:02:00.000Z\n\nHi Gio,\n\nThanks for sending the first draft over.' in outbound['pricing'], outbound['pricing']
    assert "before Thursday's review? [health kept on this Mac] Sam will run the review if I can't make it." in outbound['pricing']
    assert outbound['pricing'].startswith(f'# Re: Pricing deck for Thursday\n\n_{privacy.CODE_ONLY}. ')

def test_addresses_links_and_attachments_never_reach_outbound():
    for name, text in THREADS.items():
        out, record = screen(text)
        for words in NEVER:
            assert words not in out, f'{name}: {words!r} in OUTBOUND.md\n{out}'
        held_text = json.dumps(record)
        assert 'pricing-draft-v2.pptx' not in held_text or name == 'pricing'
    out, record = screen(PRICING)
    assert record['left_out'] == {'addressees': 4, 'attachments': 1, 'links': 2, 'addresses': 0, 'phones': 0}, record['left_out']

def test_ordinary_sentences_held_at_most_one_in_ten():
    planted = HEALTH
    ordinary = held = 0
    for text in THREADS.values():
        _, record = screen(text)
        for line in record['lines']:
            if any(line['text'] in p or p in line['text'] for p in planted): continue
            ordinary += 1
            held += line['status'] == 'kept'
    assert ordinary >= 25, ordinary
    assert held / ordinary <= 0.10, f'{held} of {ordinary} ordinary sentences held (bound 10%)'

def test_record_shape_lines_and_counts():
    out, record = screen(PRICING)
    c = record['counts']
    assert c['sentences'] == len(record['lines']) == c['sent'] + c['held'] and c['turns'] == 3 and c['removed'] == {'footer': 1, 'quoted': 1}, c
    assert record['source'] == 'thread'
    statuses = {l['status'] for l in record['lines']}
    assert statuses == {'sent', 'kept'}
    surgery = next(l for l in record['lines'] if 'knee surgery' in l['text'])
    assert surgery == {'i': surgery['i'], 'turn': 1, 'time': '2026-10-05T14:02:00.000Z', 'speaker': 'Lena Ortiz', 'status': 'kept', 'category': 'health', 'layer': 'code', 'rule': 'medical', 'text': HEALTH[0]}, surgery
    subject = record['lines'][0]
    assert subject['speaker'] == 'Subject' and subject['status'] == 'sent' and subject['text'] == 'Re: Pricing deck for Thursday'
    # a held subject line is marked in place, its words stay on the Mac
    out2, _ = screen(PRICING.replace('# Re: Pricing deck for Thursday', '# Re: my surgery and the deck'))
    assert out2.startswith('# [health kept on this Mac]\n') and 'my surgery' not in out2

def test_the_cli_and_the_function_write_a_new_pair_beside_the_thread():
    with tempfile.TemporaryDirectory() as d:
        md = Path(d) / 'THREAD.md'; md.write_text(PRICING)
        # the command Loggie runs (screen-thread.js): code only, labeled, one pair beside the thread
        run = subprocess.run([sys.executable, str(Path(privacy.__file__)), '--thread', str(md), '--me', 'Gio Caballero'], capture_output=True, text=True)
        assert run.returncode == 0 and 'held by code' in run.stdout and privacy.CODE_ONLY in (Path(d) / 'OUTBOUND.md').read_text(), run
        for f in ('OUTBOUND.md', 'HELD.json'): (Path(d) / f).unlink()
        assert sorted(p.name for p in Path(d).iterdir()) == ['THREAD.md']
        with contextlib.redirect_stdout(io.StringIO()):
            out1, held1, rec1 = privacy.screen_thread_file(md)
            out2, held2, _ = privacy.screen_thread_file(md)
        assert (out1.name, held1.name, out2.name, held2.name) == ('OUTBOUND.md', 'HELD.json', 'OUTBOUND-2.md', 'HELD-2.json')
        record = json.loads(held1.read_text())
        assert record['source'] == 'thread' and record['thread'] == 'THREAD.md' and record['outbound'] == 'OUTBOUND.md' and record['screened_by'] == 'code' and 'created' in record
        assert any(h['rule'] == 'footer' and 'intended recipient' in h['text'] for h in record['held']), 'the footer is listed, on the Mac'
        assert out1.read_text() == out2.read_text() and 'knee surgery' not in out1.read_text()
        # --out puts the pair in another folder
        other = Path(d) / 'out'
        with contextlib.redirect_stdout(io.StringIO()):
            out3, held3, _ = privacy.screen_thread_file(md, out=other)
        assert out3 == other.resolve() / 'OUTBOUND.md' and held3.exists()

EDGE = """# Offsite plan

## Ana Ruiz <ana.ruiz@example.edu> · 2026-10-07T08:00:00.000Z
To: gio@example.edu

Two things for the offsite:
- Can you confirm the headcount by Friday?
- Please send the dietary list to the caterer.

Thanks!
Ana

P.S. Could you also bring the projector cable?

## Ana Ruiz <ana.ruiz@example.edu> · 2026-10-07T09:00:00.000Z

Quick follow-up on the room. Please keep this confidential until the dean signs off. The east wing is closing.
"""

def test_ps_and_bullets_survive_and_a_real_confidential_line_still_holds_its_message():
    out, record = screen(EDGE)
    assert '- Can you confirm the headcount by Friday?\n\n- Please send the dietary list to the caterer.' in out, out
    assert 'P.S. Could you also bring the projector cable?' in out and 'Thanks!' not in out
    # the sender's own words asking for secrecy are not a footer: the whole message stays on the Mac
    assert '## Ana Ruiz · 2026-10-07T09:00:00.000Z\n\n[confidential kept on this Mac]\n' in out and 'east wing' not in out, out
    assert record['counts']['turns_fully_held'] == 1

def test_call_mode_record_gains_source_and_lines_only():
    header, turns = privacy.parse_md('# A call\n\n[00:10] Me: Morning. I had surgery last week.\n\n[00:20] Dana: Glad you are back.')
    out, record = privacy.screen(header, turns, {'me': 'Gio', 'other': 'Dana'})
    assert out == f'# A call\n\n_{privacy.CODE_ONLY}. 1 of 3 sentences kept back (code 1); see held.json._\n\n[00:10] Me: Morning. [health kept on this Mac]\n\n[00:20] Dana: Glad you are back.\n', out
    assert [l['status'] for l in record['lines']] == ['sent', 'kept', 'sent'] and record['lines'][1]['rule'] == 'medical'

if __name__ == '__main__':
    import fixtures; fixtures.run(globals())
