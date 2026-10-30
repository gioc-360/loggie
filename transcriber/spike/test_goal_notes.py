# goal_notes.py tests: each pass on a small made-up call, and through byo.run that no request the passes make carries a
# sentence the privacy screen held (a scratch run of the step check sent one to Nebius, 2026-10-09).
import re, contextlib, hashlib, io, json, tempfile
from pathlib import Path
import byo, goal_notes
from fixtures import priya
EVENT, HELD, TRANSCRIPT, fake_screen = priya.EVENT, priya.HELD, priya.TRANSCRIPT, priya.fake_screen

def b(text, at='01:00', level=0, owner=None, quote='q'):
    return {'text': text, 'at': at, 'quote': quote, 'cites': [], 'level': level, 'owner': owner}

LINES = [{'t': 60, 'end': 70, 'who': 'Them', 'text': 'The retreats run one week every month.'},
         {'t': 300, 'end': 320, 'who': 'Them', 'text': 'The team interviews will want to hear the Dell story and its impact.'},
         {'t': 800, 'end': 810, 'who': 'Me', 'text': "Oh, okay, great. That's Richard at the door."},
         {'t': 900, 'end': 920, 'who': 'Them', 'text': 'In your one-on-ones with your supervisor, bring two blockers and your next steps.'},
         {'t': 1200, 'end': 1230, 'who': 'Them', 'text': 'Yiming won last year, and Yiming said the judges want evidence.'},
         {'t': 1620, 'end': 1630, 'who': 'Them', 'text': 'Have a great Friday.'}]

def answers(**by_marker):
    # A fake model that answers each pass by the words its prompt starts with; records every prompt.
    sent = []
    def ask(p):
        sent.append(p)
        for marker, reply in by_marker.items():
            if marker.replace('_', ' ') in p: return reply, {'model': 'fake', 'usage': {'prompt_tokens': 100, 'completion_tokens': 10}, 'seconds': 0.5}
        return '{}', {'model': 'fake', 'usage': {'prompt_tokens': 1, 'completion_tokens': 1}, 'seconds': 0.1}
    return ask, sent

def acme_call(d):
    # Priya's call filed under Acme Bank, whose goal is what the goal passes read; screened and reviewed first, so the
    # yes is the sha256 of these exact outbound bytes.
    home = Path(d); call = home / 'calls' / '2026-10-07-1100-priya'; call.mkdir(parents=True)
    (home / 'workstreams.json').write_text(json.dumps([{'name': 'Acme Bank', 'goal': 'Get an offer', 'goalText': 'Get the Acme Bank analyst offer'}]))
    (call / 'event.json').write_text(json.dumps({**EVENT, 'workstream': 'Acme Bank'}))
    (call / 'transcript.md').write_text(TRANSCRIPT)
    out_md, _, _ = fake_screen(call)
    return call, out_md, hashlib.sha256(out_md.read_bytes()).hexdigest()

def test_the_budget_takes_the_larger_of_minutes_and_topics_within_floor_and_cap():
    assert goal_notes.budget_of(27, 5, 'chat') == 400, 'Liz: five topics beat 125 + 5 x 27 = 260'
    assert goal_notes.budget_of(55, 4, 'team') == 400 and goal_notes.budget_of(55, 6, 'team') == 480
    assert goal_notes.budget_of(5, 1, 'chat') == 200 and goal_notes.budget_of(120, 9, 'chat') == 550 and goal_notes.budget_of(120, 12, 'class') == 750

def test_a_line_made_of_the_goal_with_no_moment_goes_and_a_figure_from_the_call_stays():
    sections = [{'heading': 'Key numbers', 'bullets': [b('Deadline: Nov 11 for team interviews', at='??:??'), b('Retreats: 1 week every month', at=None)]},
                {'heading': 'Next Steps', 'bullets': [b('Complete team interviews before the Nov 11 deadline', at=None, owner='Ana')]}]
    out = goal_notes.drop_goal_only(sections, 'Get the Acme offer through the team interviews before the Nov 11 deadline')
    assert len(out['goal_only']) == 2 and [x['text'] for x in sections[0]['bullets']] == ['Retreats: 1 week every month']
    assert sections[1]['heading'] == 'Next Steps' and sections[1]['bullets'] == [], 'Next Steps stays as a heading even when empty'

def test_the_step_check_sees_the_setting_and_the_matching_turn_said_elsewhere():
    said = goal_notes.around(b('Prepare the Dell story for the HR interview', at='13:20'), LINES)
    assert 'Oh, okay, great' in said and 'team interviews will want to hear the Dell story' in said, said

def test_steps_about_the_role_move_later_and_later_lines_about_getting_there_come_back():
    sections = [{'heading': 'Program', 'bullets': [b('Retreats run one week every month')]},
                {'heading': 'For later', 'bullets': [b('Lead with the Dell story in team interviews', at='05:00')]},
                {'heading': 'Next Steps', 'bullets': [b('Practice the two-blockers update for interviews', at='15:00', owner='Ana'),
                                                       b('Ask the HR rep about other roles', at='05:00', owner='Mira'),
                                                       b('Send Liz a thank-you note', at='27:00', owner='Ana')]}]
    reply = json.dumps({'lines': [{'n': 1, 'describing': 'getting'},
                                  {'n': 2, 'verdict': 'ok', 'describing': 'role', 'owner': 'Ana'},
                                  {'n': 3, 'verdict': 'drop', 'describing': 'getting', 'owner': ''},
                                  {'n': 4, 'verdict': 'fix', 'text': 'Scheduled chat and introduced self', 'describing': 'other', 'owner': 'Ana'}]})
    ask, sent = answers(Below_are_next_steps=reply)
    out, meta = goal_notes.steps(sections, LINES, 'Get the Acme offer', ask)
    heads = [s['heading'] for s in sections]
    assert heads == ['Program', 'For later', 'Next Steps'], heads
    assert [x['text'] for x in sections[0]['bullets']] == ['Retreats run one week every month', 'Lead with the Dell story in team interviews'], 'back into the notes'
    assert [x['text'] for x in sections[1]['bullets']] == ['Practice the two-blockers update for interviews'] and sections[1]['bullets'][0]['owner'] is None
    nxt = sections[2]['bullets']
    assert [x['text'] for x in nxt] == ['Ask the HR rep about other roles', 'Send Liz a thank-you note'], 'the model never drops a step, and a rewrite sharing no words is refused'
    assert nxt[0]['owner'] is None and out['owners'] == [['Mira', None]], 'no one was named: the owner goes'
    assert meta['usage']['prompt_tokens'] == 100 and len(sent) == 1

def test_a_heading_loses_a_name_not_said_near_its_points_and_keeps_one_that_was():
    sections = [{'heading': "Past winner insights (Richard, 2025)", 'bullets': [b('Judges want evidence', at='20:00')]},
                {'heading': "Richard's walkthrough of the deck", 'bullets': [b('Judges want evidence', at='20:00')]},
                {'heading': "Yiming's advice", 'bullets': [b('Judges want evidence', at='20:00')]}]
    goal_notes.heading_names(sections, LINES, byo.far_names)
    assert [s['heading'] for s in sections] == ['Past winner insights (2025)', 'walkthrough of the deck', "Yiming's advice"]

def test_a_for_later_line_that_repeats_a_point_above_is_cut_with_its_details():
    sections = [{'heading': 'Culture', 'bullets': [b('Agile teams plan in sprints'), b('Talk months ahead to get on PI planning', level=1)]},
                {'heading': 'For later', 'bullets': [b('Get on PI planning months ahead'), b('the planning detail', level=1), b('Shadow underwriters once in the role')]}]
    out = goal_notes.cut_repeats(sections)
    assert out['repeats'] == ['Get on PI planning months ahead'] and [x['text'] for x in sections[1]['bullets']] == ['Shadow underwriters once in the role']

def test_the_budget_keeps_points_in_goal_order_and_moves_the_rest_to_more():
    long = ' '.join(['word'] * 70)
    sections = [{'heading': 'A', 'bullets': [b('A1 ' + long), b('A2 ' + long), b('A2 detail', level=1)]},
                {'heading': 'B', 'bullets': [b('B1 ' + long), b('B2 ' + long)]},
                {'heading': 'Next Steps', 'bullets': [b('Send the deck', owner='Ana')]}]
    lines = [{'t': 0, 'who': 'Them', 'text': 'x'}, {'t': 600, 'who': 'Them', 'text': 'y'}]   # 10 minutes, 2 topics: 200 words
    ask, sent = answers(Order_these_points='{"order": [4, 1, 2, 3]}')
    out, meta = goal_notes.trim(sections, lines, 'Get the offer', 'chat', ask)
    assert out['budget'] == 200 and [s['heading'] for s in sections] == ['A', 'B', 'More', 'Next Steps']
    assert [x['text'][:2] for x in sections[0]['bullets']] == ['A1'] and [x['text'][:2] for x in sections[1]['bullets']] == ['B2']
    assert [x['text'][:2] for x in sections[2]['bullets']] == ['A2', 'A2', 'B1'], 'what did not fit moves in order, details with their headline'

def test_through_byo_run_no_pass_sends_a_held_sentence_and_the_cost_line_counts_every_request():
    with tempfile.TemporaryDirectory() as d:
        call, out_md, yes = acme_call(d)
        notes = """# Priya & Gio - Coffee Chat

## Applying early
- Applications open in September; apply early, as with Dell on September 17 and a note that runs long enough to need the shape pass here [15:43] <!-- applied to Dell in like September 17 -->

## Next Steps
- Apply to the Acme analyst role in September (Gio) [15:50] <!-- applied to Dell in like September 17 -->
"""
        ask, sent = answers(Rewrite_each_note='{"notes": [{"n": 1, "headline": "Apply early: Dell applications opened September 17", "details": []}]}',
                            Below_are_next_steps='{"lines": [{"n": 1, "verdict": "ok", "describing": "getting"}]}',
                            Order_these_points='{"order": [1]}', Request=notes)
        byo.GOAL_PASSES = True   # off in the product since 2026-10-12; kept working for a rerun of the blind test against the rival app
        try:
            with contextlib.redirect_stdout(io.StringIO()): out, run_ = byo.run(call, 'nebius', ask=ask, screen=fake_screen, approved=yes)
        finally: byo.GOAL_PASSES = False
        assert len(sent) == 4, [p[:60] for p in sent]   # notes, shape, steps, ranking
        assert all(HELD not in p for p in sent), 'every request, the passes too, comes from outbound.md'
        assert 'kept on this Mac' in sent[2], 'the step check saw the window around 15:50, held sentence and all, as screened'
        assert run_['passes']['shape']['reshaped'] == 1 and run_['one_pass'] is False
        assert 'over 4 requests' in out.read_text(), out.read_text()[-200:]

def test_a_goal_echo_stamped_on_a_moment_that_does_not_say_it_goes_too():
    sections = [{'heading': 'Next Steps', 'bullets': [b('Schedule team interviews before the Nov 11 deadline', at='27:05', owner='Ana'),
                                                       b('Prepare the Dell story for the team interviews', at='05:00', owner='Ana')]}]
    out = goal_notes.drop_goal_only(sections, 'Get the Acme offer through team interviews before the Nov 11 deadline', LINES)
    assert out['goal_only'] == ['Schedule team interviews before the Nov 11 deadline'], out
    assert [x['text'] for x in sections[0]['bullets']] == ['Prepare the Dell story for the team interviews'], 'said at 05:00: stays'

def test_the_shape_pass_keeps_one_detail_the_one_that_adds_most():
    sections = [{'heading': 'Paths', 'bullets': [b(' '.join(['word'] * 25))]}]
    reply = json.dumps({'notes': [{'n': 1, 'headline': 'Post-EA paths: extend the project or interview elsewhere',
                                   'details': ['Extend the project as its owner', 'Power Automate guru for three teams, by bank priorities', 'Paths: extend or interview']}]})
    ask, _ = answers(Rewrite_each_note=reply)
    goal_notes.shape(sections, ask)
    assert [x['text'] for x in sections[0]['bullets']] == ['Post-EA paths: extend the project or interview elsewhere', 'Power Automate guru for three teams, by bank priorities']

def test_a_goal_takes_the_goal_prompt_even_for_a_team_meeting():
    team = {'names': 'Anya Parimala, Ivy Cho, Tomas Park', 'title': 'Hackathon: readouts', 'category': 'team'}
    assert byo.prompt_file_for({**team, 'goal': 'Win the hackathon'}) == byo.GOAL_PROMPT_FILE and byo.prompt_file_for(team) == byo.TEAM_PROMPT_FILE

def test_a_reply_that_repeats_the_transcript_is_asked_again_with_a_fresh_request_line_then_refused():
    with tempfile.TemporaryDirectory() as d:
        call, out_md, yes = acme_call(d)
        echo = out_md.read_text()
        sent = []
        def ask(p):
            sent.append(p)
            return (echo if not p.startswith('Request') or len(sent) <= 3 else '{}'), {'model': 'fake', 'usage': {'prompt_tokens': 1, 'completion_tokens': 1}, 'seconds': 0.1}
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()): byo.run(call, 'nebius', ask=ask, screen=fake_screen, approved=yes)
        except SystemExit as e: code = e.code
        else: code = 0
        firsts = [p.splitlines()[0] for p in sent]
        assert len(sent) == 3 and len(set(firsts)) == 3 and all(f.startswith('Request ') for f in firsts), firsts
        assert code == 2 and not list(call.glob('summary-nebius*.md')), 'three repeats: refused, no empty notes written'

def test_a_name_said_once_away_from_everyone_known_gives_way_to_the_known_name_said_at_the_moment():
    lines = [{'t': 600, 'who': 'Me', 'text': "That's Rafael. He opened the door."},
             {'t': 1980, 'who': 'Me', 'text': 'And also Mina won last year, and a mentor is helping her get a job.'},
             {'t': 2600, 'who': 'Me', 'text': 'Do you know Mina? She works at Orsay now, a very nice hotel.'},
             {'t': 2700, 'who': 'Me', 'text': 'We meet on Saturday and use Qualtrics for the survey.'}]
    sections = [{'heading': 'Winner', 'bullets': [b('Rafael got an Orsay job via a mentor', at='33:00'),
                                                  b('Meet mentors before Saturday; Qualtrics for the survey', at='33:00')]}]
    out = goal_notes.point_names(sections, lines, byo.far_names, known=(['Mina'], ['Ivy Cho', 'Ivy']))
    assert [x['text'] for x in sections[0]['bullets']] == ['Mina got an Orsay job via a mentor', 'Meet mentors before Saturday; Qualtrics for the survey'], out
    assert out['names'] == [['Rafael got an Orsay job via a mentor', 'Mina got an Orsay job via a mentor']], 'Orsay was said beside Mina: it stays'

def test_a_step_aimed_at_one_event_follows_the_event_the_other_speaker_tied_it_to():
    assert goal_notes.goal_events('Get the offer through the HR interview on Oct 16 and team interviews before the Nov 11 deadline') == ['HR interview', 'team interviews', 'Nov 11 deadline']
    lines = [{'t': 780, 'who': 'Them', 'text': 'Ask the HR rep about other roles; it is really like an audit.'},
             {'t': 819, 'who': 'Me', 'text': 'At Dell I killed the spreadsheets and built a platform for every program and its costs and revenue.'},
             {'t': 864, 'who': 'Them', 'text': 'That would be a very compelling story, what you did and the impact, that I am sure once'},
             {'t': 865, 'who': 'Me', 'text': 'and so that is the work I enjoy doing'},
             {'t': 882, 'who': 'Them', 'text': 'you get past the HR interview and on to the team interviews, they would be excited to hear.'}]
    sections = [{'heading': 'Next Steps', 'bullets': [b('Prepare the Dell story and its impact for the HR interview next Friday (Fri Oct 16)', at='13:39', owner='Ana'),
                                                       b('Ask the HR rep about other roles at the HR interview', at='13:00', owner='Ana')]}]
    ask, sent = answers(The_listener_has='{"passages": [{"n": 1, "event": "team interviews"}]}')
    out, _ = goal_notes.retime(sections, lines, 'Get the offer through the HR interview on Oct 16 and team interviews before the Nov 11 deadline', ask)
    assert [x['text'] for x in sections[0]['bullets']] == ['Prepare the Dell story and its impact for the team interviews', 'Ask the HR rep about other roles at the HR interview'], 'the HR date does not follow the step to the team interviews'
    assert len(sent) == 1 and 'Prepare the Dell story' not in sent[0] and 'compelling story' in sent[0] and 'team interviews, they would' in sent[0], 'one passage, the step not shown, the interjection kept inside'

def test_a_role_the_call_never_gives_a_name_comes_off_it():
    lines = [{'t': 1980, 'who': 'Me', 'text': 'Mina won last year. She is majoring in hospitality, and she said one of the mentors from the field is helping her get a job, so ask the mentors.'},
             {'t': 2100, 'who': 'Them', 'text': 'Our mentor Ivo said the judges want evidence.'}]
    sections = [{'heading': 'Next Steps', 'bullets': [b('Ask mentor Mina to validate the fit early'), b('Follow up with mentor Ivo'), b('2025 winner Mina: judges want evidence'), b('Supervisor support varies by team')]}]
    goal_notes.role_names(sections, lines + [{'t': 2200, 'who': 'Them', 'text': 'support varies by team'}])
    assert [x['text'] for x in sections[0]['bullets']] == ['Ask Mina to validate the fit early', 'Follow up with mentor Ivo', '2025 winner Mina: judges want evidence', 'Supervisor support varies by team']

def test_a_point_off_the_goal_moves_to_more_even_with_room_and_a_model_that_marks_most_is_ignored():
    sections = [{'heading': 'Program', 'bullets': [b('Retreats run one week every month'), b('43 North showcase: 500+ students, $1M prize'),
                                                   b('Supervisors who were EAs set up resources'), b('Two pillars: teaming for growth, operational excellence')]},
                {'heading': 'Next Steps', 'bullets': [b('Ask the HR rep about other roles', owner='Ana')]}]
    lines = [{'t': 0, 'who': 'Them', 'text': 'x'}, {'t': 1500, 'who': 'Them', 'text': 'y'}]
    ask, _ = answers(Order_these_points='{"order": [4, 1, 3, 2], "off_goal": [2]}')
    out, _ = goal_notes.trim(sections, lines, 'Get the offer', 'chat', ask)
    assert out['off_goal'] == ['43 North showcase: 500+ students, $1M prize'] and out['kept_words'] < out['budget']
    assert [s['heading'] for s in sections] == ['Program', 'More', 'Next Steps'] and [x['text'] for x in sections[1]['bullets']] == ['43 North showcase: 500+ students, $1M prize']
    sections = [{'heading': 'Program', 'bullets': [b('A'), b('B'), b('C')]}]
    ask, _ = answers(Order_these_points='{"order": [1, 2, 3], "off_goal": [1, 2]}')
    out, _ = goal_notes.trim(sections, lines, 'Get the offer', 'chat', ask)
    assert out['off_goal'] == [] and len(sections[0]['bullets']) == 3, 'two of three marked: ignored'

def test_the_later_of_two_schedules_under_one_label_stays():
    sections = [{'heading': 'Priorities', 'bullets': [b('P0: fix by end of day even if overwork', at='10:46'), b('P1: finish in a week', at='10:46'),
                                                      b('P0 items: find-email fix, window sizing', at='11:30'), b('P0 target: before the end of fall break', at='22:05'),
                                                      b('P1: after fall break', at='22:05'), b('Liz: retreats every month', at='05:00'), b('Liz: shadow days after you start', at='16:00')]}]
    out = goal_notes.latest_labels(sections)
    assert out['superseded'] == ['P0: fix by end of day even if overwork', 'P1: finish in a week'], out
    assert [x['text'] for x in sections[0]['bullets']] == ['P0 items: find-email fix, window sizing', 'P0 target: before the end of fall break', 'P1: after fall break', 'Liz: retreats every month', 'Liz: shadow days after you start']

def test_an_owner_that_names_nobody_goes():
    sections = [{'heading': "Who's doing what", 'bullets': [b('Other: find-email fix and the command input'), b('Build the recall button (other person)')]},
                {'heading': 'Next Steps', 'bullets': [b('Convert the board to a diagram', owner='Them'), b('Build next move', owner='Gio')]}]
    goal_notes.placeholder_owners(sections)
    assert [x['text'] for x in sections[0]['bullets']] == ['Find-email fix and the command input', 'Build the recall button']
    assert [x['owner'] for x in sections[1]['bullets']] == [None, 'Gio']

def test_on_one_mic_a_task_is_written_with_no_owner():
    lines = [{'t': t, 'who': 'Me', 'text': x} for t, x in ((140, 'Can I assign this to you? Yes, the email fix.'), (200, 'Zorvex has a wave thing.'), (960, 'Jess, can you take recall?'), (1300, 'Window should be terminal sized.'))]
    assert byo.one_mic(lines * 3) and not byo.one_mic(lines * 3 + [{'t': 2000, 'who': 'Them', 'text': 'ok'}])
    sections = [{'heading': "Who's doing what", 'bullets': [b('Gio: email fix', at='02:20'), b('Gio work stream next move features P0'), b('Window: terminal sized'),
                                                          b('Loggie suggests a thank-you note'), b('Window can scale with the screen'), b('Screenshot board, upload for a diagram')]},
                {'heading': 'Next Steps', 'bullets': [b('Assign to Gio as P0: remove the data dependency', owner='Gio'), b('Zorvex can implement wave diagram'),
                                                       b('Assign work stream + next move to Zorvex as P0'), b('Build the recall button (Jess)', owner='Jess'), b('Recruit testers (Team)'), b('Analyze best UX later; assign to Gio')]}]
    goal_notes.one_mic_owners(sections, lines, ['Gio', 'Jess', 'Loggie'], 'Loggie: what to do next')
    assert sections[0]['heading'] == 'Tasks' and [x['text'] for x in sections[0]['bullets']] == ['Email fix', 'Work stream next move features P0', 'Window: terminal sized', 'Loggie suggests a thank-you note', 'Window can scale with the screen', 'Screenshot board, upload for a diagram']
    assert [x['text'] for x in sections[1]['bullets']] == ['P0: remove the data dependency', 'Implement wave diagram', 'Work stream + next move as P0', 'Build the recall button', 'Recruit testers', 'Analyze best UX later']
    assert all(x['owner'] is None for x in sections[1]['bullets'])
    assert byo.ONE_MIC_NOTE in byo.render([], 'Call', 'm', one_mic_call=True)

def test_two_runs_at_once_never_share_a_notes_file_and_a_failed_one_leaves_none():
    import summary, threading
    with tempfile.TemporaryDirectory() as d:
        folder = Path(d); got = []
        threads = [threading.Thread(target=lambda: got.append(summary.claim(folder, 'summary-nebius', '.md').name)) for _ in range(8)]
        [t.start() for t in threads]; [t.join() for t in threads]
        assert sorted(got) == sorted(['summary-nebius.md'] + [f'summary-nebius-{n}.md' for n in range(2, 9)]), got
    # the repeat-the-transcript refusal (test above) ran byo.run to a refusal: no empty summary file was left

def test_email_me_is_a_step_for_the_listener_toward_the_speaker():
    lines = [{'t': 1399, 'who': 'Me', 'text': 'Well, email me if you have any follow-ups.'}, {'t': 1400, 'who': 'Kai Lee', 'text': 'Thank you.'}]
    sections = [{'heading': 'Next Steps', 'bullets': [b('Email Kai Lee if follow-up questions arise', at='23:19', owner='Me'), b('Start building with AI', at='21:29', owner='Kai')]}]   # 'Me': the step check writes the label
    out = goal_notes.asked_of_listener(sections, lines, 'Ana')
    assert [(x['text'], x['owner']) for x in sections[0]['bullets']] == [('Email Ana if follow-up questions arise', 'Kai'), ('Start building with AI', 'Kai')], out

def test_a_phrase_the_goal_quotes_and_the_call_never_says_names_nothing():
    lines = [{'t': 60, 'who': 'Me', 'text': 'Find the work streams from email and messages.'}]
    sections = [{'heading': 'Make "Do it" functional', 'bullets': [b('Core flow: user clicks "Do it", agent executes'), b('Work streams come from email and messages')]},
                {'heading': 'Next Steps', 'bullets': [b('Ship the "Do it" button', owner='Ana'), b('Test on the 8 GB Mac', owner='Ana')]}]
    out = goal_notes.goal_leaks(sections, lines, "Get Loggie working so the 'Do it' feature is functional")
    assert [s2['heading'] for s2 in sections] == ['Notes', 'Next Steps'] and [x['text'] for x in sections[0]['bullets']] == ['Work streams come from email and messages']
    assert [x['text'] for x in sections[1]['bullets']] == ['Test on the 8 GB Mac'] and len(out['leaks']) == 3
    assert goal_notes.goal_leaks(sections, lines, 'Win the hackathon') == {'leaks': []}

def test_advice_given_on_a_two_person_call_is_the_listeners_step():
    lines = [{'t': 1289, 'who': 'Me', 'text': "I would start building now using AI, you should automate a workflow. I'll introduce you to Dana."}, {'t': 1295, 'who': 'Kai Lee', 'text': 'Got it.'},
             {'t': 1399, 'who': 'Me', 'text': 'Email me if you have any follow-ups.'}]
    sections = [{'heading': 'Next Steps', 'bullets': [b('Build AI automation projects for talking points', at='21:29', owner='Ana'), b('Email me if follow-ups needed', at='23:19', owner='Kai Lee'),
                                                       b('Send Kai the deck', at='05:00', owner='Ana'), b('Stay available for questions from Kai', at='23:19', owner='Ana'), b('Introduce Kai to Dana', at='21:29', owner='Ana')]}]
    goal_notes.asked_of_listener(sections, lines, 'Ana')
    assert [(x['text'], x['owner']) for x in sections[0]['bullets']] == [('Build AI automation projects for talking points', 'Kai'), ('Email Ana if follow-ups needed', 'Kai Lee'), ('Send Kai the deck', 'Ana'), ('Stay available for questions from Kai', 'Ana'), ('Introduce Kai to Dana', 'Ana')], 'a promise stays with who made it'

# One appearance (2026-10-12): with the passes off, the notes are the AI's draft in its own words, its next steps stay
# next steps, and only one request leaves.
def test_the_final_notes_are_the_draft_in_its_own_words():
    with tempfile.TemporaryDirectory() as d:
        call, out_md, yes = acme_call(d)
        notes = """# Priya & Gio - Coffee Chat

## Applying early
- Apply early: Dell applications opened September 17 [15:43] <!-- applied to Dell in like September 17 -->

## Next Steps
- Apply to the Acme analyst role in September (Gio) [15:50] <!-- applied to Dell in like September 17 -->
"""
        ask, sent = answers(Request=notes)
        with contextlib.redirect_stdout(io.StringIO()): out, run_ = byo.run(call, 'nebius', ask=ask, screen=fake_screen, approved=yes)
        text = out.read_text()
        assert len(sent) == 1 and run_['passes'] is None and run_['one_pass'] is True
        assert '- Apply early: Dell applications opened September 17' in text
        assert re.search(r'## Next Steps\n- Apply to the Acme analyst role in September', text) and 'For later' not in text

if __name__ == '__main__':
    import fixtures; fixtures.run(globals())
