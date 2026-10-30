# them.py tests (meetings-granola-proposal c 2.2, 2026-10-27): who Them was, by code at Stop, on made-up names. The case
# behind them: an invite sent by the recruiter, a call held by someone else who never said his name.
#   python3 test_them.py   (exit 0 = pass)
import contextlib, io, json, tempfile
from pathlib import Path
import call, them
import nvidia_engine as ne

ELENA = {'title': 'Video interview with Northwind', 'me': 'Gio', 'names': 'Elena Ortiz', 'emails': ['elena@northwind.example'], 'category': 'one-on-one'}
mail = lambda *names: [{'text': 'Gio', 'source': 'own', 'count': 1}, *({'text': n, 'source': 'mail', 'count': 2} for n in names)]
invited = lambda: [{'text': 'Elena Ortiz', 'source': 'invitee', 'count': 1}, {'text': 'Elena', 'source': 'invitee', 'count': 1}]
me = lambda text: {'who': 'Me', 'text': text}
they = lambda text: {'who': 'Them', 'text': text}

def test_t1_them_introduces_themselves_and_mail_completes_the_name():
    lines = [they('Hi, I\'m Priya from Acme.'), me('Great, thanks for making the time.'), they('Happy to.')]
    found = them.detect(lines, mail('Priya Nair'), {'title': 'Coffee chat', 'me': 'Gio'})
    assert found['decided'] and found['label'] == 'Priya Nair' and found['choices'] == [], found

def test_t2_only_me_says_the_name_and_beats_the_invite():
    lines = [me('So Marcus, how do you think about the first year?'), they('We start with the data platform.'), me('Thanks, Marcus.')]
    found = them.detect(lines, mail('Marcus Bell') + invited(), ELENA)
    assert found['decided'] and found['label'] == 'Marcus Bell' and found['scores'][:2] == [['Marcus Bell', 8], ['Elena Ortiz', 1]], found

def test_t3_nobody_says_a_name_falls_to_mail_then_the_invite_and_never_decides():
    lines = [me('Great to meet you.'), they('Likewise, tell me about yourself.')]
    found = them.detect(lines, mail('Tomas Reyes') + invited(), ELENA)
    assert not found['decided'] and found['choices'] == ['Tomas Reyes', 'Elena Ortiz'] and found['invite'] is None, found
    alone = them.detect(lines, invited(), ELENA)
    assert not alone['decided'] and alone['invite'] == 'Elena Ortiz' and alone['choices'] == ['Elena Ortiz'], 'the invite alone never decides'

def test_t4_the_invite_name_said_as_a_third_person_scores_nothing():
    lines = [me('Elena set this up for us. I spoke with Elena last week.'), they('Great.'), me('Thanks, Marcus.')]
    found = them.detect(lines, mail('Marcus Bell') + invited(), ELENA)
    assert found['decided'] and found['label'] == 'Marcus Bell' and dict(found['scores'])['Elena Ortiz'] == 1, found
    # Two people carry the first name said: it stays the first name, and the page offers the full ones.
    two = them.detect([me('Thanks, Marcus.'), me('So Marcus, one more?')], mail('Marcus Bell', 'Marcus Lee'), {'title': 'Chat', 'me': 'Gio'})
    assert two['decided'] and two['label'] == 'Marcus' and two['choices'] == ['Marcus Bell', 'Marcus Lee'], two

def call_folder(root, event, transcript_lines):
    folder = Path(root) / 'calls' / '2026-10-27-1500-video-interview'; folder.mkdir(parents=True)
    (folder / 'event.json').write_text(json.dumps(event))
    (folder / 'lexicon.json').write_text(json.dumps({'entries': mail('Tomas Reyes') + invited()}))
    (folder / 'transcript-timed.txt').write_text(''.join(f'[00:{i:02d}] {who}: {text}\n' for i, (who, text) in enumerate(transcript_lines)))
    (folder / 'transcript.txt').write_text(''.join(f'{who}: {text}\n' for who, text in transcript_lines))
    (folder / 'transcript.md').write_text('# Video interview with Northwind\n\nTuesday, October 27, 2026, 15:00, 30 min. Me (Gio) and Them.\n_parakeet, v1._\n\n'
                                          + '\n\n'.join(f'[00:{i:02d}] {who}: {text}' for i, (who, text) in enumerate(transcript_lines)) + '\n')
    (folder / 'summary-nebius.md').write_text("# Video interview with Northwind\n\n## Them's role\n- Them runs the data team [00:01]\n")
    return folder

def test_t5_his_click_relabels_wins_and_is_remembered_for_the_next_call():
    with tempfile.TemporaryDirectory() as d:
        said = [('Me', 'Great to meet you.'), ('Them', 'Likewise, tell me about yourself.')]
        folder = call_folder(d, ELENA, said)
        with contextlib.redirect_stdout(io.StringIO()): event = them.settle(folder, json.loads((folder / 'event.json').read_text()), them.lines_of(folder))
        on_disk = json.loads((folder / 'event.json').read_text())
        assert event['them_label'] == on_disk['them_label'] == 'Them' and on_disk['with'] == 'the other person', on_disk
        assert on_disk['them_found']['choices'] == ['Tomas Reyes', 'Elena Ortiz'] and not on_disk['them_found']['decided']
        with contextlib.redirect_stdout(io.StringIO()): them.pick(folder, 'Tomas Reyes')
        on_disk = json.loads((folder / 'event.json').read_text())
        assert on_disk['them_label'] == on_disk['with'] == 'Tomas Reyes' and on_disk['them_by_hand'] is True and on_disk['them_found']['by'] == 'hand'
        md = (folder / 'transcript.md').read_text()
        assert 'Me (Gio) and Tomas Reyes.' in md and '[00:01] Tomas Reyes: Likewise' in md and '[00:00] Me: Great' in md, md
        assert '[00:01] Tomas Reyes: Likewise' in (folder / 'transcript-timed.txt').read_text() and 'Tomas Reyes: Likewise' in (folder / 'transcript.txt').read_text()
        assert "## Tomas Reyes's role" in (folder / 'summary-nebius.md').read_text() and '- Them runs' in (folder / 'summary-nebius.md').read_text(), 'headings only'
        memory = json.loads((Path(d) / 'people-names.json').read_text())
        assert memory == {'elena@northwind.example': 'Tomas Reyes', 'Tomas': 'Tomas Reyes'}, memory
        # His click wins over any later detection on the same call.
        with contextlib.redirect_stdout(io.StringIO()): again = them.settle(folder, on_disk, [me('Thanks, Marcus.')])
        assert again['them_label'] == 'Tomas Reyes'
        # The next call with the same invitee, "Tomas" said, no mail at all: Tomas Reyes, no ask.
        lines = [me('Thanks, Tomas.'), they('Good to see you again.')]
        found = them.detect(lines, invited(), ELENA, memory)
        assert found['decided'] and found['label'] == 'Tomas Reyes' and found['scores'][0] == ['Tomas Reyes', 7], found

def test_finish_names_them_before_any_label_is_written():
    # call.py finish calls them.settle: the transcript files carry the name, event.json says who and that code found it.
    with tempfile.TemporaryDirectory() as d:
        folder = Path(d) / 'calls' / '2026-10-27-1500-video-interview'; folder.mkdir(parents=True)
        event = {**ELENA, 'start': '2026-10-27T19:00:00Z'}
        (folder / 'event.json').write_text(json.dumps(event))
        (folder / 'lexicon.json').write_text(json.dumps({'entries': mail('Marcus Bell') + invited()}))
        tracks = {'me': ne.lines_of(call_words('So Marcus, how do you think about the first year?', 1.0) + call_words('Thanks, Marcus.', 20.0)),
                  'them': ne.lines_of(call_words('We start with the data platform.', 8.0))}
        with contextlib.redirect_stdout(io.StringIO()): call.finish(folder, event, tracks, folder, {'version': 'v1'}, with_notes=False, seconds=60)
        md = (folder / 'transcript.md').read_text()
        assert 'Me (Gio) and Marcus Bell.' in md and 'Marcus Bell: We start with the data platform.' in md, md
        assert 'Marcus Bell: We start' in (folder / 'transcript-timed.txt').read_text()
        on_disk = json.loads((folder / 'event.json').read_text())
        assert on_disk['them_label'] == on_disk['with'] == 'Marcus Bell' and on_disk['them_found']['by'] == 'code' and on_disk['them_found']['decided']
        # A redo writes its own version folder and never the call's event.json.
        before = (folder / 'event.json').read_text()
        out = folder / 'v2-nvidia'; out.mkdir()
        with contextlib.redirect_stdout(io.StringIO()): call.finish(folder, {**event, 'names': ''}, tracks, out, {'version': 'v2-nvidia'}, with_notes=False, seconds=60)
        assert (folder / 'event.json').read_text() == before

def call_words(text, t0):
    return [{'text': ' ' + w, 'start': round(t0 + i * 0.5, 2), 'end': round(t0 + i * 0.5 + 0.3, 2), 'p': 1.0} for i, w in enumerate(text.split())]

if __name__ == '__main__':
    tests = [v for k, v in sorted(globals().items()) if k.startswith('test_')]
    for t in tests: t()
    print(f'{len(tests)} passed')
