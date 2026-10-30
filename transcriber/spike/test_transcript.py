# Transcript tests: term ranking, the hint budget, the mark rule, turn joining, redo staying in its version folder, and
# the NVIDIA engine's pure parts (two-reader agreement, number formats, lines from words, the gap check, filling,
# the echo merge). Deterministic: no model runs; nemo-speech is replaced by a fake.
#   python3 test_transcript.py   (exit 0 = pass)
import json, os, shutil, tempfile, wave
from pathlib import Path
import numpy as np
import call, transcript, nvidia_engine as ne
from fixtures import patched

def line(text, probs, t0=0.0, who='Them'):
    # a line from words and their probabilities, 0.3 s a word
    words = [{'text': ' ' + w, 'p': p} for w, p in zip(text.split(), probs)]
    return {'t': t0, 'end': round(t0 + 0.3 * len(words), 3), 'text': text.strip(), 'words': words, 'who': who}

DOC = '\f'.join(['Cornell SC Johnson College\nThe JV was Siecor, a joint venture with Siemens. The alliance grew.',
                 'Cornell SC Johnson College\nThen Tata Starbucks opened in Mumbai, and Siecor again.\nThe JV and the alliance.',
                 'Cornell SC Johnson College\nThe Alliance Life Cycle. Due: VW SAIC Written Case.\nAnd Siecor.',
                 'Cornell SC Johnson College\nMeeting the partner, Siecor and Siemens.',
                 'Cornell SC Johnson College\nQuestions for next time.'])  # five pages, footer on all, Siecor on four
DOC2 = '\f'.join(f'Cornell SC Johnson College\nSlide {i}. Partners and the alliance.' for i in range(5))  # a second deck, same footer

def test_rank_prefers_names_the_dictionary_lacks_and_drops_footers_and_english():
    ranked = transcript.rank([DOC, DOC2])
    assert ranked[0] == 'Siecor', ranked
    assert 'Tata Starbucks' in ranked and 'VW SAIC' in ranked
    assert 'Cornell SC Johnson College' not in ranked and 'Johnson' not in ranked   # on every page: a footer
    assert 'Alliance' not in ranked and 'Alliance Life Cycle' not in ranked          # English, and used in lowercase too
    assert 'Meeting' not in ranked and 'The' not in ranked                            # sentence-initial only

def test_hint_fits_the_character_budget_and_keeps_the_lead():
    event = {'title': 'Coffee chat', 'names': 'Sam Lee', 'materials': None}
    prompt, terms = transcript.hint(event)
    assert prompt == 'Meeting with Sam Lee.' and terms == []
    with tempfile.TemporaryDirectory() as d:
        (Path(d) / 'a.txt').write_text(DOC); (Path(d) / 'b.txt').write_text(DOC2)
        prompt, terms = transcript.hint({'title': 'NBA 9999 Test', 'materials': d}, limit=60)
        assert prompt.startswith('NBA 9999 Test. Siecor, ') and ':' not in prompt[-20:] and len(prompt) <= 60, prompt
        long, all_terms = transcript.hint({'title': 'NBA 9999 Test', 'materials': d})
        assert len(all_terms) > len(terms) and len(long) <= transcript.CHARS

def test_marks_only_names_numbers_dates_and_doses():
    assert transcript.markable(' Seacore', False) and not transcript.markable(' Seacore', True)
    assert transcript.markable(' 221.', True) and transcript.markable(' twenty', True) and transcript.markable(' mg', True)
    assert transcript.markable(' Friday', True) and transcript.markable(' October', True)
    assert not transcript.markable(' the', False) and not transcript.markable(' I', False) and not transcript.markable(' bedrock', False)
    l = line('We spoke about Seacore, on Friday at 9 a.m. in Breazano 221.', [0.9, 0.9, 0.9, 0.3, 0.3, 0.9, 0.9, 0.9, 0.9, 0.9, 0.3, 0.2])
    text = transcript.marked(l)
    assert text == 'We spoke about Seacore (unclear), on Friday at 9 a.m. in Breazano (unclear) 221 (unclear).', text
    assert [m['word'] for m in transcript.marks([l])] == ['Seacore', 'Breazano', '221']
    # a weak common word after a sentence end is not a name
    l2 = line('It fell apart. Within months.', [0.9, 0.9, 0.9, 0.3, 0.9])
    assert transcript.marked(l2) == 'It fell apart. Within months.'

def test_markdown_joins_turns_and_stamps_their_start():
    lines = [line('Hello there.', [0.9, 0.9], 0.0), line('Second line.', [0.9, 0.9], 3.0), line('Okay.', [0.9], 65.0, 'Me'), line('Back to me.', [0.9, 0.9, 0.9], 70.0)]
    md = transcript.markdown(lines, lambda l: l['who'])
    assert md == '[00:00] Them: Hello there. Second line.\n\n[01:05] Me: Okay.\n\n[01:10] Them: Back to me.\n', md
    # a long turn breaks after a minute at a sentence end, and at a pause, each piece stamped
    talk = [line('Point.', [0.9], t * 3.0) for t in range(19)] + [line('Still going', [0.9, 0.9], 57.0), line('and done.', [0.9, 0.9], 60.0), line('New idea.', [0.9, 0.9], 62.0)]
    assert transcript.markdown(talk, lambda l: l['who']) == '[00:00] Them: ' + 'Point. ' * 19 + 'Still going and done.\n\n[01:02] Them: New idea.\n'
    gap = [line('Before.', [0.9], 0.0), line('After a pause.', [0.9, 0.9, 0.9], 10.0)]
    assert transcript.markdown(gap, lambda l: l['who']) == '[00:00] Them: Before.\n\n[00:10] Them: After a pause.\n'
    head = transcript.header({'title': 'NBA 6530', 'me': 'Gio'}, '/x/2026-10-06-1012-nba', 2898.5, 'v2-context')
    assert head.startswith('# NBA 6530\n\nTuesday, October 6, 2026, 10:12, 48 min. Me (Gio) and Them.'), head
    # The person on the call (them.py) names the other side, not the invite's sender; an unsure call says Them.
    sent = {'title': 'Video interview', 'me': 'Gio', 'attendees': 'Kaitlyn Cartwright'}
    assert 'Me (Gio) and David Calloway.' in transcript.header({**sent, 'them_label': 'David Calloway'}, '/x/2026-10-27-1500-video', 1800, 'v1')
    assert 'Me (Gio) and Them.' in transcript.header({**sent, 'them_label': 'Them'}, '/x/2026-10-27-1500-video', 1800, 'v1')
    assert 'Me (Gio) and Kaitlyn Cartwright.' in transcript.header(sent, '/x/2026-10-27-1500-video', 1800, 'v1'), 'a group call or an old one keeps the invite'
    # A call from before recorded_at (2026-10-28): the folder name is the press (12:54), not the class block's 11:40.
    old = transcript.header({'title': 'Macro class', 'me': 'Gio', 'start': '2026-10-27T15:40:00Z'}, '/x/2026-10-27-1254-macro-class', 1800, 'v1')
    assert 'Tuesday, October 27, 2026, 12:54, 30 min.' in old, old
    pressed = transcript.header({'title': 'Talk', 'me': 'Gio', 'start': '2026-10-27T18:30:00Z', 'recorded_at': '2026-10-27T14:58:07-04:00'}, '/x/2026-10-27-1458-talk', 1800, 'v1')
    assert ', 14:58, 30 min.' in pressed, pressed
    assert 'date unknown' not in transcript.header({'title': 'X', 'start': '2026-10-27T18:30:00Z'}, '/x/no-date', 60, 'v1'), 'no date in the name: the event start'

def call_folder(d, seconds=4):
    folder = Path(d) / '2026-10-06-1012-test'; folder.mkdir()
    (folder / 'event.json').write_text(json.dumps({'title': 'Test call', 'names': 'Sam Lee', 'attendees': ''}))
    for side in ('me', 'them'):
        with wave.open(str(folder / f'{side}.wav'), 'wb') as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b'\x00\x00' * 16000 * seconds)
    (folder / 'transcript-timed.txt').write_text('[00:00] Them: old words\n')
    return folder

# ---------- the NVIDIA engine ----------

def W(text, t0=0.0, step=0.5, p=1.0):
    # words with times, step seconds apart, each 0.3 s long
    return [{'text': ' ' + w, 'start': round(t0 + i * step, 2), 'end': round(t0 + i * step + 0.3, 2), 'p': p} for i, w in enumerate(text.split())]

def test_numbers_read_the_same_in_digits_and_words():
    assert ne.digits(['twenty', 'four']) == '24' == ne.digits(['24']) and ne.digits(['one', 'hundred']) == '100'
    assert ne.digits(['ten', 'oh', 'two', 'ten', 'oh', 'five']) == ne.digits(['1002', '1005']) == '10021005'
    assert ne.digits(['twenty', 'twenty', 'six']) == '2026' and ne.digits(['two', 'hundred', 'fifty']) == '250' and ne.digits(['career']) == ''

def test_agreement_marks_names_and_numbers_the_second_reader_heard_differently():
    p = W('We spoke about Siecor in D.C. on Friday. Okay. Then Korea paid 24 dollars to Briazzano 2 to 1 at 10 a.m.')
    n = W('We spoke about seacore in DC on Friday. Then career paid twenty four dollars to Abriazano two two one at 10 a.m.')
    words, report = ne.agree([dict(w) for w in p], n, transcript.markable)
    marked = {w['text'].strip(): w['heard'] for w in words if w['p'] < 0.5}
    assert marked == {'Siecor': 'seacore', 'Korea': 'career', 'Briazzano': 'Abriazano two two one', '2': 'Abriazano two two one', '1': 'Abriazano two two one'}, marked
    # D.C./DC: the same letters, a spelling, not a disagreement; 24/twenty four: the same number; Okay.: deleted,
    # nobody heard another word; Then: a sentence start, not a name; Siecor/seacore: different letters, marked
    assert report['marked'] == 5 and report['differ'] >= 7 and all(w['p'] == 1.0 for w in words if w['text'].strip() in ('D.C.', '24', 'Okay.', 'Then', 'Friday.'))
    line = next(l for l in ne.lines_of(words) if 'Korea' in l['text'])
    assert transcript.marked(line) == 'Then Korea (unclear) paid 24 dollars to Briazzano (unclear) 2 (unclear) to 1 (unclear) at 10 a.m.', transcript.marked(line)

def test_lines_break_at_sentence_ends_pauses_and_the_word_cap():
    words = W('One two three. Four five six seven', step=0.5) + W('after a pause here.', t0=10.0) + W(' '.join(['w'] * 45), t0=20.0, step=0.4)
    lines = ne.lines_of(words)
    assert [l['text'] for l in lines][:3] == ['One two three.', 'Four five six seven', 'after a pause here.'], [l['text'] for l in lines]
    assert [len(l['words']) for l in lines][3:] == [40, 5] and lines[0]['t'] == 0.0 and lines[0]['end'] == 1.3 and lines[2]['t'] == 10.0

def noisy_wav(path, seconds, loud=lambda t: True, sr=16000):
    # noise where loud(t) says so, digital silence elsewhere: the gap check sees sound, not words
    rng = np.random.default_rng(0); x = np.zeros(sr * seconds, np.float32)
    for s in range(seconds):
        if loud(s): x[s * sr:(s + 1) * sr] = rng.normal(0, 0.1, sr)
    with wave.open(str(path), 'wb') as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((x * 32767).astype(np.int16).tobytes())

def test_forgiveness_rules_quiet_false_marks_and_keep_real_ones():
    # Cycle 3 (proposal-c.md): 16-17 of 21 marks on the Priya call were false. Each rule from a real case on that call
    # or the class, and the real doubts beside them must survive.
    marked = lambda words: {w['text'].strip(' .,'): w['heard'] for w in words if w['p'] < 0.5}
    # plural/possessive: one thing said
    words, rep = ne.agree(W('Ask the PMs about it.'), W('Ask the PM about it.'), transcript.markable)
    assert marked(words) == {} and rep['forgiven']['plural'] == 1
    # number: "4 P" against "anyways" is a lost number, nobody heard another; a name's initial ("C Core") stays marked
    words, rep = ne.agree(W('Use the three Cs and the four P always.'), W('Use the three Cs and the anyways always.'), transcript.markable)
    assert marked(words) == {} and rep['forgiven']['number'] == 2, marked(words)
    words, _ = ne.agree(W('We met the C Core team.'), W('We met the Seacore with team.'), transcript.markable)
    assert set(marked(words)) == {'C', 'Core'}, marked(words)
    # established: agreed 3+ times elsewhere and a short rival -> forgiven; a long rival phrase -> a real doubt, kept
    est = {'dell': 12, 'korea': 11, 'jb': 2}
    words, rep = ne.agree(W('I worked at Dell then.'), W('I worked at the then.'), transcript.markable, established=est)
    assert marked(words) == {} and rep['forgiven']['established'] == 1
    words, _ = ne.agree(W('The Korea signals were missed.'), W('The career sense miss signals were missed.'), transcript.markable, established=est)
    assert 'Korea' in marked(words)
    words, _ = ne.agree(W('The JB deal closed.'), W('The JV deal closed.'), transcript.markable, established=est)
    assert 'JB' in marked(words)   # agreed only twice elsewhere: not established
    # numbers are never "established": a different number heard stays a doubt
    words, _ = ne.agree(W('Room 2 to 1 please.'), W('Room two two one please.'), transcript.markable, established={'2': 20, '1': 20})
    assert {'2', '1'} <= set(marked(words)), marked(words)
    # lexicon: a typed name is not in doubt; without the list the same word is marked
    words, rep = ne.agree(W('Hey there, Gio, morning.'), W('Hey there, GO, morning.'), transcript.markable, lexicon={'gio'})
    assert marked(words) == {} and rep['forgiven']['lexicon'] == 1
    words, _ = ne.agree(W('Hey there, Gio, morning.'), W('Hey there, GO, morning.'), transcript.markable)
    assert 'Gio' in marked(words)
    # real doubts from the Priya call stay marked under every rule
    words, _ = ne.agree(W('She is an MBS student.'), W('She is an MBA student.'), transcript.markable, established=est, lexicon={'gio'})
    assert 'MBS' in marked(words)

def test_suggest_labels_a_name_and_never_writes_one():
    # Priya call: Parakeet "Jill", boosted Nemotron "Gio" -> "Jill (unclear; likely Gio)". A planted name beside a
    # word with another first sound ("Bank" vs "Breazzano") or beside no name-like word gives no label.
    p = W('Hey Jill. Good morning. In Bank of America and the rest.')
    b = W('Hey Gio. Good morning. In Breazzano America and Priya rest.')
    words, made = ne.suggest([dict(w) for w in p], b, ['Gio', 'Priya Shah', 'Priya', 'Lee', 'Breazzano'], transcript.markable, lexicon={'gio'})
    assert [m['likely'] for m in made] == ['Gio'], made
    line = next(l for l in ne.lines_of(words) if 'Jill' in l['text'])
    assert transcript.marked(line).startswith('Hey Jill (unclear; likely Gio).'), transcript.marked(line)
    assert all(w['text'].strip(' .') != 'Gio' for w in words)   # the word itself is never replaced
    # class 2026-10-07: abbreviations and long names never get a person label
    w2, made2 = ne.suggest([dict(w) for w in W('The JV deal and the Korea signals.')], W('The Gio deal and the Caballero signals.'), ['Gio', 'Caballero'], transcript.markable)
    assert made2 == [], made2
    assert ne.sound('gio') == ne.sound('jill') and ne.sound('city') == ne.sound('citi') != ne.sound('kitty')   # the length check, not the sound, stops Bank/Breazzano

def test_capital_clue_marks_an_ordinary_word_written_as_a_name():
    words, made = ne.capital_clue(W("I worked in Bank of America and in City, uh, at Dell then. I'll go to the Pentagon now."), established={'pentagon': 13, 'dell': 12})
    assert [m['word'] for m in made] == ['City,'], made
    assert ne.capital_clue(W('I worked in City then.'), lexicon={'city'})[1] == []
    assert ne.capital_clue(W('The Department of Justice and the Belt and Road plan.'))[1] == []
    # an echo on the Me track must not double a word's count (City said twice, heard on both tracks)
    twice = W('I was in City and then in City again.')
    assert ne.confirmed([(twice, twice), (twice, twice)])['city'] == 2

def test_lexicon_keys_reads_the_newest_list_word_by_word():
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        assert ne.lexicon_keys(d) == set()
        (Path(d) / 'lexicon.json').write_text(json.dumps({'entries': [{'text': 'Priya Shah', 'source': 'invite'}, {'text': 'Gio', 'source': 'me'}]}))
        assert ne.lexicon_keys(d) == {'priya', 'shah', 'gio'}

def test_gap_check_catches_a_hole_with_sound_and_passes_silence():
    with tempfile.TemporaryDirectory() as d:
        wav = Path(d) / 'them.wav'
        noisy_wav(wav, 120, loud=lambda t: not 60 <= t < 90)     # sound 0-60 and 90-120, silence 60-90
        words = [w for s in range(0, 120, 2) if not 60 <= s < 90 for w in W('a word', t0=s)]
        assert ne.gap_check(wav, words)['gaps'] == [], 'a clean track failed'
        hole = [w for w in words if not 20 <= w['start'] < 50]  # 30 s of sound, no words: the parakeet-mlx failure of 2026-10-06
        res = ne.gap_check(wav, hole)
        assert len(res['gaps']) == 1 and res['gaps'][0]['from'] == 18.8 and res['gaps'][0]['to'] == 50.0 and 29 <= res['gaps'][0]['loud_s'] <= 32, res
        assert 'GAP CHECK FAILED' in ne.gap_banner('them', res) and '[00:18] to [00:50]' in ne.gap_banner('them', res)
        quiet = [w for w in words if not 90 <= w['start'] < 100]  # 10 s of sound without words: under the threshold
        assert ne.gap_check(wav, quiet)['gaps'] == []
        assert ne.gap_check(wav, [])['gaps'][0]['loud_s'] == 90.0, 'an empty transcript of a loud track must fail'

def test_fill_takes_the_second_readers_words_where_the_first_left_a_stretch_empty():
    p = W('They are the core.', t0=0.0) + W('And they are often learned.', t0=12.0)
    n = W('They are the core.', t0=0.5) + W('They set real boundaries around what you do.', t0=4.0) + W('And they are often learned.', t0=12.5)
    words, fills = ne.fill(p, n)
    assert len(fills) == 1 and fills[0]['text'] == 'They set real boundaries around what you do.' and fills[0]['words'] == 8 and fills[0]['from'] == 1.8, fills
    assert [w['text'].strip() for w in words][3:6] == ['core.', 'They', 'set'] and all(w.get('filled') for w in words[4:12])
    # a stretch under 2 s, or one where the second reader has under 3 words, is left alone
    assert ne.fill(W('a b', t0=0.0) + W('c d', t0=1.5), W('x y z', t0=0.7))[1] == []
    assert ne.fill(W('a b', t0=0.0) + W('c d', t0=5.0), W('um', t0=2.0))[1] == []

def test_echo_merge_drops_what_the_mic_heard_from_the_speaker_and_keeps_me():
    them = ne.lines_of(W('your JV partner invites you for a game of mahjong', t0=100.0) + W('what do you do', t0=110.0))
    echo = ne.lines_of(W('your JV partner invites you for a game of mahjong', t0=100.1))[0]         # the same words at the same moment
    real = ne.lines_of(W('maybe manufacturing like building cars like Toyota', t0=105.0))[0]       # Gio's own words
    repeat = ne.lines_of(W('your JV partner invites you for a game of mahjong', t0=130.0))[0]       # the same words 30 s later: not an echo
    half = ne.lines_of(W('you for a game of mahjong and some other words here', t0=100.5))[0]         # 6 of 11 words echo: not enough
    lines, dropped = call.merge([echo, real, repeat, half], them)
    assert dropped == 1 and [l['text'] for l in lines if l['who'] == 'Me'] == [half['text'], real['text'], repeat['text']], [l['text'] for l in lines]
    # lines without word times use the old line window
    old_me = [{'t': 100.0, 'end': 104.0, 'text': 'your JV partner invites you for a game of mahjong'}]
    assert call.merge(old_me, [{'t': 103.0, 'end': 108.0, 'text': 'your JV partner invites you for a game of mahjong'}])[1] == 1

def test_redo_nvidia_writes_its_version_folder_with_marks_gaps_and_ear_check():
    with tempfile.TemporaryDirectory() as d:
        folder = call_folder(d)
        before = {p: p.stat().st_mtime_ns for p in folder.iterdir()}
        def fake_run(model, wav, out_json=None, language=None, device='metal', chunk=None, phrases=None, boost=None):
            parakeet = 'parakeet' in str(model)
            words = W('Hello Sam Lee from Citi.' if parakeet else 'Hello Sam Li from Citi.', t0=0.5) if Path(wav).name == 'them.wav' else W('Hello Sam Lee from Citi.' if parakeet else '', t0=0.6)
            if out_json: Path(out_json).write_text('{}')
            return words, {'model': Path(model).name, 'chunk_s': chunk, 'pieces': 1, 'seconds': 0.1, 'peak_gb': 0.5, 'words': len(words), 'runtime_confidence': ['1']}
        with patched(ne, run=fake_run, version=lambda: 'nemo-speech 0.0 (fake)'): call.redo(folder)
        after = {p: p.stat().st_mtime_ns for p in folder.iterdir() if p.is_file()}
        assert after == before, 'redo changed a v1 file'
        v2 = folder / 'v2-nvidia'
        assert v2.is_dir() and {'transcript.md', 'transcript.txt', 'transcript-timed.txt', 'version.json', 'ear-check.md', 'them-parakeet.json', 'them-nemotron.json'} <= {p.name for p in v2.iterdir()}
        md = (v2 / 'transcript.md').read_text()
        assert 'Hello Sam Lee (unclear) from Citi.' in md and 'NVIDIA readers' in md and 'parakeet' in md.lower(), md
        assert (v2 / 'transcript.txt').read_text() == 'Them: Hello Sam Lee from Citi.\n', 'the Me echo line must drop'
        info = json.loads((v2 / 'version.json').read_text())
        assert info['engine'] == 'nvidia' and info['gap_check'] == 'clean' and info['agreement']['them']['marked'] == 1 and info['ear_check_against'] == 'v1' and info['terms'] == []
        ear = (v2 / 'ear-check.md').read_text()
        assert 'Lee | Li' in ear and '[00:00]' in ear, ear
        with patched(ne, run=fake_run, version=lambda: 'fake'): call.redo(folder)
        assert (folder / 'v3-nvidia').is_dir() and json.loads((folder / 'v3-nvidia' / 'version.json').read_text())['ear_check_against'] == 'v2-nvidia'

def test_the_boosted_label_pass_runs_for_invitees_and_mail_people_and_never_for_the_users_own_name_alone():
    # 2026-10-27: the only boosted name was the user's own ("Gio"), and the pass re-read both sides for 336 s of a 20-minute stop.
    with tempfile.TemporaryDirectory() as d:
        folder = call_folder(d); runs = []
        def fake_run(model, wav, out_json=None, language=None, device='metal', chunk=None, phrases=None, boost=None):
            runs.append({'model': Path(model).name, 'side': Path(wav).stem, 'phrases': phrases, 'boost': boost})
            if out_json: Path(out_json).write_text('{}')
            return W('Hello Sam Lee from Citi.', t0=0.5), {'model': Path(model).name, 'pieces': 1, 'seconds': 0.1, 'peak_gb': 0.5}
        def read(entries):
            (folder / 'lexicon.json').write_text(json.dumps({'entries': entries})); runs.clear()
            with tempfile.TemporaryDirectory() as o, patched(ne, run=fake_run, version=lambda: 'fake'): _, info = call.transcribe(folder, {}, Path(o), 'v1')
            return [r for r in runs if r['boost']], info
        own = [{'text': 'Gio Caballero', 'source': 'own'}, {'text': 'Gio', 'source': 'own'}]
        boosted, info = read(own + [{'text': 'Technology Strategy', 'source': 'mail'}, {'text': 'M&T Bank', 'source': 'mail'}])
        assert boosted == [] and info['boosted_names'] == [] and info['boost'] is None, boosted   # his own name and no person in the mail: no third reading
        assert len([r for r in runs if 'nemotron' in r['model']]) == 2, runs                       # the two plain Nemotron readings still run
        boosted, info = read(own + [{'text': 'Tomas Reyes', 'source': 'mail'}, {'text': 'Technology Strategy', 'source': 'mail'}])
        assert [r['side'] for r in boosted] == ['me', 'them'] and all('Tomas Reyes' in r['phrases'] and 'Gio' in r['phrases'] for r in boosted), boosted
        assert 'Technology Strategy' not in boosted[0]['phrases'] and info['boosted_names'] == boosted[0]['phrases']
        boosted, _ = read(own + [{'text': 'Elena Ortiz', 'source': 'invitee'}])
        assert len(boosted) == 2 and 'Elena Ortiz' in boosted[0]['phrases']
        assert ne.mail_person('Tomas Reyes') and not ne.mail_person('Technology Strategy') and not ne.mail_person('M&T Bank') and not ne.mail_person('Tomas')

if __name__ == '__main__':
    import fixtures; fixtures.run(globals())
