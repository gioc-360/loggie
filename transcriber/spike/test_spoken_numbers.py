# Spoken numbers to digits, and the figures a set of notes kept from a call. Run: python3 test_spoken_numbers.py
import spoken_numbers as n

def test_spoken_numbers_become_digits_from_the_hilton_meeting():
    # Lines as Loggie's transcript wrote them on 2026-10-07; the notes model dropped every one of these figures.
    cases = {
        'franchise and licensing fees two point seven eight billion dollars up almost seven percent': 'franchise and licensing fees $2.78 billion up almost 7%',
        'Base management fees three hundred seventy six million are a percentage': 'Base management fees 376 million are a percentage',
        'Hilton has about one point three five million of them. Seventy-eight percent are franchised.': 'Hilton has about 1.35 million of them. 78% are franchised.',
        'eight hundred seventy three managed hotels': '873 managed hotels',
        'we had twenty twenty five revenue of twelve billion': 'we had 2025 revenue of 12 billion',
        'wages twenty two point six': 'wages 22.6',
        'wages twenty two sixty, purchases seventeen ten': 'wages twenty two sixty, purchases seventeen ten',   # $22.60 and $17.10: not years, left as words
    }
    for said, written in cases.items(): assert n.spoken_to_digits(said) == written, (said, n.spoken_to_digits(said))

def test_small_words_and_plain_speech_are_left_alone():
    for said in ['two teams and one idea', 'it is one point', 'a lot of people', 'and then one more']: assert n.spoken_to_digits(said) == said

def test_figures_match_across_ways_of_writing_them():
    notes = n.figures('Fees at $2.78B, up ~7%. Base fees: $376M. 1.35 million rooms, 78% franchised.')
    said = n.figures('fees two point seven eight billion dollars up almost seven percent. base three hundred seventy six million. one point three five million rooms, seventy eight percent')
    assert all(any(n.same(s, m) for m in notes) for s in said), (said, notes)
    assert (2025.0, '') not in n.figures('in 2025 they'), 'a year alone is not a figure'
    assert n.figures('two teams') == set() and n.figures('42 people') == set(), 'small counts are not figures'

def test_recall_counts_kept_figures_and_names_ones_never_said():
    r = n.recall('fees two point seven eight billion dollars and seventy eight percent franchised', 'Fees $2.78B; 78% franchised; margin 14%')
    assert (r['said'], r['kept'], r['recall']) == (2, 2, 1.0) and r['not_said'] == [(14.0, '%')]
    assert n.recall('nothing here', 'none')['recall'] is None

if __name__ == '__main__':
    import fixtures; fixtures.run(globals())
