# wordlists.py tests: the targeted lists in the privacy screen's code layer (cloud-first C1). Made-up sentences only.
# Business money words pass; identifiers and secrets are held; a health word is held when a person is the subject and
# passes when it is figurative; a call name or he/she/they with a health or family-crisis word is third-party.
#   python3 test_wordlists.py   (exit 0 = pass)
import privacy, wordlists

PEOPLE = ['Dana', 'Priya Nair']

def hit(s, people=PEOPLE): return wordlists.hit(s, people)

def test_business_money_words_pass():
    for s in ['Our pricing is $20 a month and the budget is tight.', 'Send the invoice and the rate card by Friday.', 'The fee is five percent of revenue.',
              'Salary bands are public at most banks.', 'The cost of the pilot came to $40,000.', 'We need to raise the price next quarter.']:
        assert hit(s) is None and privacy.code_hit(s, PEOPLE) is None, s

def test_identifiers_and_secrets_are_held_as_money():
    assert hit('The account number is 12345678901.')[0] == 'money'
    assert hit('Wire it to routing 021000021 please.')[0] == 'money'
    assert hit('Her IBAN is GB82 WEST 1234 5698 7654 32.')[0] == 'money'
    assert hit('The card is 4539 1488 0343 6467.') == ('money', 'wl-card') and hit('The card is 1234 5678 9012 3456.') is None   # Luhn: the second is not a card
    assert hit('My SSN shape is 078-05-1120.')[0] == 'money'
    assert hit('The tax ID is 12-3456789.')[0] == 'money'
    assert hit('my password is x') == ('money', 'wl-password') and hit('The PIN is 4821.')[0] == 'money' and hit('The passcode was blue42.')[0] == 'money'
    assert hit('The password reset email went out.') is None and hit('Please pin the issue to the board.') is None

def test_health_is_held_when_a_person_is_the_subject():
    assert hit("I hurt my knee and can't stand for long.") == ('health', 'wl-injury')
    assert hit('I had surgery in March.')[0] == 'health' and hit("I've been dealing with anxiety.")[0] == 'health'
    assert hit('I was diagnosed with ADHD last year.')[0] == 'health' and hit('My back pain is back.')[0] == 'health'
    assert hit('I have a doctor\'s appointment on Tuesday.')[0] == 'health' and hit('I am pregnant.')[0] == 'health'

def test_figurative_and_business_uses_pass():
    for s in ['Our pipeline is healthy.', "That's a real pain point.", "I'm sick of the weekly status call.", 'The deal doctor of the team reviews every contract.',
              'The therapy market is crowded.', 'They sell to hospital systems.', 'It is a pain in the neck to set up.', 'We back-end the data in a week.',
              'The Great Depression changed banking.', 'She works on cancer drugs at a biotech.']:
        assert hit(s) is None, s

def test_third_party_needs_a_person_and_a_health_or_crisis_word():
    assert hit('Dana is in the hospital this week.') == ('third-party', 'wl-third-party')
    assert hit('She was diagnosed with cancer in June.')[0] == 'third-party' and hit('Priya got a concussion on the weekend.')[0] == 'third-party'
    assert hit('His father passed away and he is out.')[0] == 'third-party' and hit('My mom is sick again.')[0] == 'third-party'
    assert hit('Dana is on the board of the hospital foundation.') is None and hit('Dana owns the pricing page.') is None
    assert hit('Dana is in the hospital this week.', people=[]) is None   # no call name, no pronoun: nothing says it is a person

def test_wired_into_the_code_layer_with_names():
    assert privacy.code_hit('Dana is in the hospital this week.', ['Dana']) == ('third-party', 'wl-third-party')
    assert privacy.code_hit('I had surgery in March.') is not None
    held = privacy.judge(privacy.flatten([{'t': 0, 'stamp': '00:00', 'who': 'Me', 'sentences': ['Dana is in the hospital this week.', 'Pricing is $20 a month.']}]),
                         {'me': 'Gio', 'other': 'Dana', 'people': ['Dana']})
    assert held[0]['layer'] == 'code' and held[0]['category'] == 'third-party' and held[0]['rule'] == 'wl-third-party' and 1 not in held

def test_sympathy_after_a_backchannel_is_held_with_the_health_line():
    rows = privacy.flatten([{'t': 0, 'stamp': '00:00', 'who': 'Me', 'sentences': ['I had knee surgery in March.', 'Yeah.', 'Mm-hmm.', "That's so awful.", 'Pricing is $20 a month.']}])
    held = {r['i']: {'category': 'health', 'layer': 'code', 'rule': 'wl-treatment'} for r in rows[:1]}
    privacy.context_holds(rows, held)
    assert 3 in held and held[3]['rule'] == 'reaction' and 4 not in held

def test_add_the_verb_is_not_ADD_the_condition():
    assert hit('I think we should add a column to the report.') is None and hit('He was diagnosed with ADD as a kid.')[0] == 'third-party'

if __name__ == '__main__':
    import fixtures; fixtures.run(globals())
