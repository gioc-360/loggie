# Summary helper tests: the citation window and the speaker label, the meaning check, the writing check, who is called
# what, the copied-example guard, the deadline words, the blind text, and that the on-Mac summarizer is gone (Gio,
# 2026-10-18). Deterministic: no model, made-up lines.
#   python3 test_summary.py   (exit 0 = pass)
import tempfile
from pathlib import Path
import summary

def L(t, text, who='Them'): return {'t': t, 'end': t + 8, 'who': who, 'text': text}

LINES = [L(28, "Session 15 is not here. And it's not on a Tuesday."), L(38, "It's on a Friday at 9 a.m. at Breazano 221. Okay?"),
         L(53, 'All right, today is a fun session.'), L(2821, 'And then Kenny Enabo will be calling in from New Zealand.')]

def test_a_quote_near_its_stamp_is_backed_and_elsewhere_is_not():
    ok = lambda at, key: summary.cite({'at': at, 'quote': key}, LINES)
    line, why = ok('00:38', 'Friday at 9 a.m.')
    assert line is LINES[1] and why is None
    assert ok('00:10', 'Friday at 9 a.m.')[0] is LINES[1]       # 28 s off: inside the window
    line, why = ok('01:20', 'Friday at 9 a.m.')   # 42 s off, but said once in the whole call: the stamp moves
    assert line is LINES[1] and why == 'stamp moved from 01:20 to 00:38: the quote is said once in the call'
    twice = LINES + [L(900, "It's on a Friday at 9 a.m. I said.")]
    assert summary.cite({'at': '01:20', 'quote': 'Friday at 9 a.m.'}, twice) == (None, 'quote not said within 30 s of the stamp')   # said twice: no move
    assert ok('47:01', 'calling in from new zealand')[0] is LINES[3]   # case and punctuation do not matter
    assert ok('00:38', 'Friday at 10 a.m.') == (None, 'quote not said within 30 s of the stamp')
    assert ok('', 'Friday at 9 a.m.') == (None, 'no stamp') and ok('x', 'Friday at 9 a.m.') == (None, 'no stamp')
    assert ok('00:38', 'Friday') == (None, 'no quote') and ok('00:38', 'Breazano 221') == (None, 'no quote')   # under three words
    assert summary.cite({'at': '30:00', 'quote': 'Friday at 9 a.m.'}, twice) == (None, 'nothing said near the stamp')
    assert ok('[00:38]', 'at Breazano 221')[0] is LINES[1]
    # a phrase that runs over a line break is backed, cited at the line where it starts
    line, why = ok('00:30', "not on a Tuesday. It's on a Friday")
    assert line is LINES[0] and why is None
    # a stitched quote is checked by its longest fragment of three words or more, and the check says so
    line, why = ok('00:38', 'Friday at 9 a.m.... at Breazano 221 okay')
    assert line is LINES[1] and why == 'quote stitched with ...; its part "at breazano 221 okay" checked'
    assert ok('00:38', 'Friday at 9 a.m.… never said here') == (None, 'quote stitched with ...; its part "never said here" checked; quote not said within 30 s of the stamp')
    assert ok('00:38', 'Friday ... 9 a.m.') == (None, 'no quote')   # no fragment long enough
    line, why = ok('05:00', 'calling in from New Zealand... the middle of the night')
    assert line is LINES[3] and why == 'quote stitched with ...; its part "calling in from new zealand" checked; stamp moved from 05:00 to 47:01: the quote is said once in the call'

def test_a_speaker_label_in_front_of_the_quote_is_not_part_of_it():
    # The 2026-10-09 Liz call: Nemotron Super wrote "Gio: ..." and "Them: ..." in front of every quote; none was backed.
    ok = lambda key: summary.cite({'at': '00:38', 'quote': key}, LINES)[0]
    assert ok("Them: It's on a Friday at 9 a.m.") is LINES[1]
    assert ok("Gio: It's on a Friday at 9 a.m.") is LINES[1]
    assert ok("Me (Gio): It's on a Friday at 9 a.m.") is LINES[1]
    assert ok("Liz Romero: It's on a Friday at 9 a.m.") is LINES[1]
    assert ok("Liz: It's on a Friday at 10 a.m.") is None, 'the label goes, the words are still checked'
    assert summary.SPEAKER.sub('', 'at 9 a.m. at Breazano 221') == 'at 9 a.m. at Breazano 221', 'no label, nothing cut'

def test_the_meaning_check_moves_a_note_to_where_its_words_are_said_and_marks_one_said_nowhere():
    # The 2026-10-09 Liz call: a true note can cite the wrong line; rare words count more, common ones barely.
    calls = ['the bank program people talk', 'the bank program schedule', 'bank program review', 'program bank notes', 'the bank people program']
    weight = summary.word_weights(calls)
    assert summary.word_weights(calls[:4]) is None, 'fewer than five transcripts: no word is rare yet, the check is off'
    assert weight('copilot') > weight('bank'), 'a word in none of the calls weighs more than one in all of them'
    lines = [L(10, 'We talked about hackathons this fall.'), L(200, 'The bank rolled out Copilot to the underwriting team.'), L(400, 'Thanks, talk soon.')]
    here, best, share = summary.meaning('The bank rolled out Copilot to underwriting', lines, 10, weight)
    assert here < summary.MEANING_CUT <= share and best is lines[1]
    here, best, share = summary.meaning('Liz moved to Lisbon to train falcons', lines, 200, weight)
    assert share < summary.MEANING_CUT

def test_style_check_names_the_rule_a_bullet_breaks():
    chk = lambda t: [r for r, _ in summary.style_check(t, 'Gio Caballero')]
    # Gio's two examples from the blind of 2026-10-06: reporting without substance, and the speaker labels
    assert summary.style_check('Them discusses how personal risk versus corporate risk affects decision making in joint ventures') == [('reports', 'main verb "discusses" reports instead of stating'), ('speaker', 'subject "Them"')]
    assert chk('Me questions if the million dollar payment constitutes a bribe') == ['speaker'] and chk('You would go to the mahjong game.') == ['speaker'] and chk('It depends on your partner.') == ['speaker']
    assert chk('The user has to submit the case.') == ['speaker'] and chk('Gio asked whether the payment is a bribe.') == ['speaker'] and chk('Gio Caballero asked.') == ['speaker']
    assert chk('The partner punishes them for the delay.') == [] and chk('Pay me later, he said.') == [] and chk('The theme is culture.') == []   # ordinary pronouns and "Theme" are not labels
    # every reporting form, as the main verb or as a passive; base forms only after a subject (a command keeps them)
    for v in ('discusses', 'explained', 'covers', 'described', 'mentions', 'talks about', 'goes over', 'touches on', 'highlights', 'emphasizes', 'notes that', 'outlined', 'explores', 'addresses', 'presents', 'points out', 'walks through', 'focuses on', 'provided examples of'):
        assert chk(f'The instructor {v} the three layers of culture.') == ['reports'], v
    assert chk('Three layers of culture were outlined.') == ['reports'] and chk("The outcomes highlight the importance of culture.") == ['reports']
    for ok in ('Review the class materials before Friday.', 'Highlight the risks in the write-up.', 'The present value is 2 million.', 'Penalties cover non-performance.', 'Submit the VW SAIC case by Thursday 9 a.m.'):
        assert chk(ok) == [], ok
    # length: 25 words a sentence, 3 sentences a bullet; labels; the "by" passive
    assert summary.style_check('word ' * 26) == [('words', '26 words in the sentence "word word word word..." (limit 25); split it into two or three shorter sentences')] and chk('word ' * 25) == []
    assert summary.style_check('One. Two. Three. Four.') == [('sentences', '4 sentences; one idea per bullet, at most 3 sentences')] and chk('One. Two. Three.') == []
    assert chk('It is on Friday at 9 a.m. at Breazano 221. Okay? Fine.') == []   # the abbreviation does not end a sentence
    assert summary.style_check('What: culture. Why: it matters.') == [('labels', 'label "What:"; write the sentence instead')]
    assert summary.style_check("The deal was killed by the partner's slowness.") == [('passive', '"was killed by" is passive; say who did it')] and chk('The partner killed the deal.') == []
    assert chk('') == [] and chk(None) == []
    good = 'The dose rises from 20 mg to 40 mg because the morning readings stayed over 140. Take two tablets at 8 a.m.'
    assert chk(good) == [] and chk('Rustom Desai says the burden of accommodation falls on the larger partner.') == []

HIKYAKU = """# NBA 6530 Strategic Alliances

_summary by Nemotron Nano 4B, local. Each bullet ends with the minute it came from._

## Dates and numbers
- [00:28] Them: Session 15 is not here. It's on a Friday at 9 a.m.
- [47:08] Them: Your assignment is due 9 a.m. on Thursday.

**What this was:** A class.

## Logistics
- Session 15 is Friday at 9 a.m. in Breazano (unclear) 221 [00:38]
  > [00:38] Them: It's on a Friday at 9 a.m. at Breazano 221. Okay?
- The exam is on Monday [00:53] (not sure)

## Due
- nothing found
"""
RIVAL = """# Culture, values, and JV negotiation strategy with Rustom Desai

Tue, 06 Oct 26

## Session Overview
- Today’s focus: “culture”
  - Culture Navigator tool

---

Chat with meeting transcript: https://notes.""" + summary.OLD_NAME + """.ai/t/abc-123
"""

def test_blind_text_strips_every_tell_from_both_tools():
    h = summary.blind_text(HIKYAKU, 'NBA 6530 Strategic Alliances')
    assert h == "# NBA 6530 Strategic Alliances\n\n## Logistics\n\n- Session 15 is Friday at 9 a.m. in Breazano 221\n- The exam is on Monday\n\n## Due\n\n- nothing found\n", h
    g = summary.blind_text(RIVAL, 'NBA 6530 Strategic Alliances')
    assert g == "# NBA 6530 Strategic Alliances\n\n## Session Overview\n\n- Today's focus: \"culture\"\n- Culture Navigator tool\n", g
    for text in (h, g):
        assert summary.OLD_NAME not in text.lower() and 'rival' not in text.lower() and 'summary by' not in text and 'not sure' not in text and 'unclear' not in text and 'Dates and numbers' not in text
        assert not any(tell in text for tell in ('[0', 'Oct 26', '---', '>', '’', '“'))
    old = summary.blind_text('# T\n\n## A\n- a fact  _not sure: quote not found in transcript_\n', 'T')   # the old local notes' mark
    assert old == '# T\n\n## A\n\n- a fact\n'

def test_blind_text_evens_out_layout():
    g = summary.blind_text('# X\n\n## A\n\n- parent:\n  - child\n    - grandchild\n', 'T')
    h = summary.blind_text('# X\n\n**What this was:** a class\n\n## A\n- one\n- two\n', 'T')
    assert g == '# T\n\n## A\n\n- parent:\n- child\n- grandchild\n', g
    assert h == '# T\n\n## A\n\n- one\n- two\n', h

def test_me_and_them_become_names_before_the_check():
    names = {'me': 'Gio', 'other': 'Priya Shah'}
    assert summary.name_labels('Me injured his knee playing basketball. Them asked about Dell.', names) == ('Gio injured his knee playing basketball. Priya Shah asked about Dell.', 2)
    assert summary.name_labels("Me and Priya Shah discuss Me's knee injury", names) == ("Gio and Priya Shah discuss Gio's knee injury", 2)
    assert summary.name_labels('He told me to call them later.', names) == ('He told me to call them later.', 0), 'ordinary pronouns stay'
    assert summary.name_labels('Me asked a question.', {'me': 'a student', 'other': None}) == ('A student asked a question.', 1)
    assert summary.name_labels('Yesterday Me asked.', {'me': 'a student'}) == ('Yesterday a student asked.', 1)
    assert summary.name_labels('Them: hello Me', {'me': None, 'other': None}) == ('Them: hello Me', 0) and summary.name_labels('', names) == ('', 0)
    # the check catches a label anywhere, not only as the first word; the named text passes in a 1:1 (the user is not flagged) and is flagged in a class
    assert [r for r, _ in summary.style_check('He told Me the deadline.')] == ['speaker'] and [r for r, _ in summary.style_check("Priya Shah asked about Me's knee.")] == ['speaker']
    assert summary.style_check('Gio injured his knee playing basketball.') == [] and [r for r, _ in summary.style_check('Gio injured his knee.', 'Gio')] == ['speaker']
    assert summary.names_for({'category': 'one-on-one', 'with': 'Priya Shah', 'me': 'Gio'}) == {'me': 'Gio', 'other': 'Priya Shah'}
    # loggie-class-notes D1: a class names the user when the event knows them; "Me" stays "a student"
    assert summary.names_for({'title': 'NBA 6530 Strategic Alliances', 'me': 'Gio'}) == {'me': 'Gio', 'other': None}
    assert summary.names_for({'title': 'NBA 6530 Strategic Alliances', 'me': 'Me'}) == {'me': 'a student', 'other': None}
    assert summary.names_for({'category': 'team', 'with': 'Sam Lee, Ana Ruiz', 'me': 'Gio'}) == {'me': 'Gio', 'other': None} and summary.one_other({'with': 'Sam Lee and Ana Ruiz'}) is None
    assert summary.names_for({'category': 'chat', 'with': 'the other person'}) == {'me': None, 'other': None} and summary.names_for({'category': 'chat', 'me': 'Me'})['me'] is None

def test_blind_text_strips_the_rival_apps_attendee_date_line_and_bold():
    g = summary.blind_text('# Priya & Gio - Coffee Chat\n\nWed, 07 Oct 26 · Priya Shah\n\n## Next Steps\n\n- **Email Gio with any follow-up questions** (Priya)\n', 'T')
    assert g == '# T\n\n## Next Steps\n\n- Email Gio with any follow-up questions (Priya)\n', g

def test_data_named_the_old_way_still_reads():
    # The rival app's name is kept once (summary.OLD_NAME) for what is already on disk: an export's link on its domain
    # is stripped from a blind file, and a call folder from before the rename still has its transcript read.
    assert summary.OLD_NAME.isalpha() and summary.OLD_NAME.islower()
    g = summary.blind_text(f'# X\n\n## A\n\n- a point, see https://notes.{summary.OLD_NAME}.ai/t/abc\n', 'T')
    assert g == '# T\n\n## A\n\n- a point, see\n', g
    with tempfile.TemporaryDirectory() as d:
        call_dir = Path(d)
        old = call_dir / f'{summary.OLD_NAME}-transcript.txt'
        old.write_text('Call\nTranscript:\nPriya: we met at Citi\n')
        assert summary.rival_transcript(call_dir) == old, 'a folder from before the rename reads its old file'
        assert summary.rival_words(summary.rival_transcript(call_dir)) == ['we', 'met', 'at', 'citi']
        new = call_dir / 'rival-transcript.txt'
        new.write_text('Transcript:\nPriya: hello\n')
        assert summary.rival_transcript(call_dir) == new, 'the new name wins when both are there'

def test_the_deadline_words_and_the_sentence_split():
    assert summary.DUE.search('your assignment is due 9 a.m. on Thursday') and not summary.DUE.search('due to their regulations') and not summary.DUE.search('my final presentation')
    assert not summary.DUE.search('culture fit is ignored during due diligence') and summary.DUE.search('The presentation is on Friday, in class.') and summary.DUE.search('The exam deadline moved, he said.')
    assert summary.WHEN.search('on March 3rd') and summary.WHEN.search('next week') and not summary.WHEN.search('we sold 24 of them last quarter')
    assert summary.sentences("It's on a Friday at 9 a.m. at Breazano 221. Okay? Dr. Lee said no.") == ["It's on a Friday at 9 a.m. at Breazano 221.", 'Okay?', 'Dr. Lee said no.']

EXAMPLES = {'report': 'The launch slips two weeks to <date> because the payment vendor failed its security review.', 'dose': 'Take two tablets at <time>.'}

def test_a_note_that_copies_a_prompt_example_is_named():
    # the 30B wrote the prompt's own due example into the Priya file (2026-10-07): code names the copied phrase
    assert summary.leaked('The launch slips two weeks to May 12 because the payment vendor failed its security review.', EXAMPLES) == 'the launch slips two'
    assert summary.leaked('Take two tablets at 8 a.m.', EXAMPLES) == 'take two tablets at' and summary.leaked('The vendor failed its security review.', EXAMPLES) == 'vendor failed its security'
    assert summary.leaked('Session 15 is on Friday at 9 a.m. at Breazano 221.', EXAMPLES) is None and summary.leaked('Send the report to the dean by Friday.', EXAMPLES) is None
    assert summary.leaked('', EXAMPLES) is None and summary.leaked('talks about why', EXAMPLES) is None, 'three or fewer words is never a copy'

def test_claim_takes_the_next_free_name_and_never_overwrites():
    with tempfile.TemporaryDirectory() as d:
        folder = Path(d)
        a = summary.claim(folder, 'summary-nebius', '.md'); a.write_text('first')
        b = summary.claim(folder, 'summary-nebius', '.md')
        assert (a.name, b.name) == ('summary-nebius.md', 'summary-nebius-2.md') and a.read_text() == 'first' and b.exists()

def test_the_on_mac_summarizer_is_gone():
    for gone in ('MODELS', 'ALIASES', 'SETTINGS', 'URL', 'choose', 'tier_for', 'budget_gb', 'memory_gb', 'server_command', 'served', 'complete', 'summarize',
                 'take_notes', 'polish', 'pieces', 'PIECE_PROMPT', 'Peak'):
        assert not hasattr(summary, gone), f'summary.{gone} still exists'
    text = Path(summary.__file__).read_text()
    assert '127.0.0.1' not in text and 'mlx_lm' not in text and 'urllib' not in text and 'HIKYAKU_MODEL_URL' not in text

if __name__ == '__main__':
    import fixtures; fixtures.run(globals())
