# bubble_check.py tests: each line is checked on its own; a word that sounds like one of the user's own words is marked
# (unclear), never changed; an English word, a person's name, the word itself and a word kept with ✕ are left alone.
# The pairs are the real ones from the calls to 2026-10-26. Deterministic: temp folders, the Mac's word list.
#   python3 test_bubble_check.py   (exit 0 = pass)
import json, tempfile
from pathlib import Path
import bubble_check, transcript

EVENT = {'title': 'Coffee chat', 'me': 'Gio', 'with': 'Mara Senn', 'names': 'Mara Senn', 'category': 'one-on-one'}

def call_in(d, words='', workstreams=(('Loggie Hikyaku Updates',), ('Karaoke Event Planning',), ('L2 Labs Hiring',))):
    home = Path(d); call = home / 'calls' / '2026-10-27-1000-coffee-chat'; call.mkdir(parents=True)
    (call / 'event.json').write_text(json.dumps(EVENT))
    (home / 'workstreams.json').write_text(json.dumps([{'name': w[0]} for w in workstreams]))
    (home / 'my-words.txt').write_text(words)
    return call

def line(text, t=0.0, p=1.0):
    words = [{'text': (' ' if i else '') + x, 'start': t + i, 'end': t + i + 0.5, 'p': p} for i, x in enumerate(text.split())]
    return {'t': t, 'end': t + len(words), 'text': text, 'words': words, 'who': 'Them'}

def checked(texts, words='', kept=()):
    with tempfile.TemporaryDirectory() as d:
        call = call_in(d, words)
        lines = [line(x, 10.0 * i) for i, x in enumerate(texts)]
        return bubble_check.check(lines, bubble_check.terms(call, EVENT, set(kept)), set(kept))

def test_a_misheard_own_word_is_marked_never_changed():
    lines, made = checked(['so loggy is the app.', "Loggi's view is new.", 'we pitched to Nebias today.'], words='Nebius\n')
    assert [(m['word'], m['near']) for m in made] == [('loggy', 'Loggie'), ("Loggi's", 'Loggie'), ('Nebias', 'Nebius')], made
    md = transcript.markdown(lines, lambda l: l['who'])
    assert 'so loggy (unclear) is the app.' in md and "Loggi's (unclear) view" in md and 'Nebias (unclear) today' in md, md
    assert 'Loggie' not in md and 'Nebius' not in md   # a mark, not a fix: the name check offers the spelling

def test_english_words_and_the_word_itself_stay():
    # "playing" is not Planning, "login" is not Loggie, "hitting" is not Hiring; "Hilton's" is Hilton itself
    _, made = checked(['we were playing a game.', 'the login page broke.', 'hitting the targets.', "Loggie's view and Loggie."], words='Hilton\n')
    assert made == [], made

def test_nebula_is_never_offered():
    # the 10-10 repair pass wrote "Nebula" for Nebius; here a word is only marked toward the user's own words
    _, made = checked(['the Nebius team.', 'a nebula in space.'], words='Nebius\n')
    assert made == [], made

def test_people_and_kept_words_stay():
    # Mara Senn is on the call: "Marra" is never marked toward a person; a word kept with ✕ stays as heard
    _, made = checked(['ask Marra about it.', 'so loggy is it.'], words='Mara\n', kept=['loggy'])
    assert made == [], made

def test_each_line_is_its_own_check_and_a_weak_word_is_left():
    lines, made = checked(['loggy one.', 'nothing here.', 'and loggy two.'])
    assert [m['t'] for m in made] == [0.0, 21.0], made
    weak = [line('Loggy (already weak)', p=0.0)]
    with tempfile.TemporaryDirectory() as d:
        call = call_in(d)
        _, made = bubble_check.check(weak, bubble_check.terms(call, EVENT), set())
    assert made == []

def test_no_word_list_no_marks():
    old = bubble_check.WORDS, bubble_check.DICT
    try:
        bubble_check.WORDS, bubble_check.DICT = Path('/nonexistent/words'), None
        _, made = checked(['so loggy is the app.'])
        assert made == []
    finally: bubble_check.WORDS, bubble_check.DICT = old

if __name__ == '__main__':
    import fixtures; fixtures.run(globals())
