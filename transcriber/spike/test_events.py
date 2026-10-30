# Event contract tests, Python half (spec-entry-b.md section 2, increment b#6). sendgate.emit refuses a text that names
# a model; screen.line comes from the screen record's lines[] (one per sentence, kept with its plain reason, sent with
# none); byo.py, run by the send gate with HIKYAKU_RUN set, appends outbound.sent before the prompt leaves,
# outbound.returned after, and check.result, on the same seq as the events already there. Loggie's
# test/hikyaku-entry-events.test.js checks the same contract on the Node side.
# Deterministic: no network (a fake ask), no model server (a fake screen), no keychain, temp folders only.
#   python3 test_events.py   (exit 0 = pass)
import contextlib, io, json, os, re, tempfile
from pathlib import Path
import byo, sendgate
from fixtures import events_of, priya as fx

ENVELOPE = {'v', 'run', 'seq', 'at', 'type', 'step', 'text', 'data'}
RUN = '20261008-120000-abcd'


def test_emit_refuses_a_text_that_names_a_model():
    with tempfile.TemporaryDirectory() as d:
        run_dir = Path(d) / RUN
        for text in ('Sending to Nemotron', 'The model answered', 'Asking Claude'):
            try: sendgate.emit(run_dir, 'step.started', 'ask', text, {})
            except ValueError: pass
            else: assert False, f'written: {text}'
        assert not (run_dir / 'events.jsonl').exists(), 'a refused event writes nothing'

def test_meeting_heard_is_written_with_its_fixed_text_and_refused_if_it_names_a_model():
    data = {'call': '2026-10-08-0921-sync', 'heard_s': 3120.0, 'read_s': 3100.0, 'behind_s': 20.0, 'pieces': 104}
    with tempfile.TemporaryDirectory() as d:
        run_dir = Path(d) / RUN
        sendgate.emit(run_dir, 'run.started', None, None, {'source': 'call', 'title': 'Sync', 'workstream': None})
        event = sendgate.emit(run_dir, 'meeting.heard', None, 'Loggie is listening', data)
        assert set(event) == ENVELOPE and event['seq'] == 2 and event['step'] is None and event['data'] == data
        try: sendgate.emit(run_dir, 'meeting.heard', None, 'Parakeet is listening', data)
        except ValueError: pass
        else: assert False, 'written'
        assert len(events_of(run_dir)) == 2

def test_screen_lines_one_per_sentence_with_the_plain_reason():
    record = {'counts': {'sentences': 4, 'sent': 2, 'held': 2}, 'lines': [
        {'i': 0, 'turn': 0, 'time': '00:01', 'speaker': 'Me', 'status': 'sent', 'category': None, 'layer': None, 'rule': None, 'text': 'Thanks for the time today.'},
        {'i': 1, 'turn': 0, 'time': '00:01', 'speaker': 'Me', 'status': 'kept', 'category': 'money', 'layer': 'model', 'rule': 'model', 'text': 'My rent went up again.'},
        {'i': 2, 'turn': 1, 'time': '00:09', 'speaker': 'Ana', 'status': 'kept', 'category': 'unchecked', 'layer': 'unchecked', 'rule': 'timeout', 'text': 'Let us talk Monday.'},
        {'i': 3, 'turn': 1, 'time': '00:09', 'speaker': 'Ana', 'status': 'sent', 'category': None, 'layer': None, 'rule': None, 'text': 'Send me the outline.'}]}
    with tempfile.TemporaryDirectory() as d:
        run_dir = Path(d) / RUN
        assert sendgate.screen_lines(run_dir, 'call', 'call:demo', record) == 4
        events = events_of(run_dir)
        assert [e['seq'] for e in events] == [1, 2, 3, 4] and all(set(e) == ENVELOPE and e['type'] == 'screen.line' for e in events)
        data = [e['data'] for e in events]
        assert [x['status'] for x in data] == ['sent', 'kept', 'kept', 'sent']
        assert data[1]['reason'] == 'personal money' and data[2]['reason'] == 'the check could not finish, so it stayed'
        assert all(x['category'] is None and x['reason'] is None for x in data if x['status'] == 'sent')
        assert events[0]['text'] is None and events[1]['text'] == 'Kept on this Mac: personal money'

def test_byo_appends_sent_returned_and_check_to_the_send_gate_run():
    with tempfile.TemporaryDirectory() as d:
        folder = fx.folder_in(d)
        yes = fx.approve(folder)
        run_dir = Path(d) / 'runs' / RUN
        sendgate.emit(run_dir, 'ai.picked', 'ask', 'You pressed Send', {'run': RUN, 'provider': 'nebius', 'remember': False, 'stream_id': None})
        ask, calls = fx.fake()
        os.environ['HIKYAKU_RUN'] = str(run_dir)
        try:
            with contextlib.redirect_stdout(io.StringIO()): byo.run(folder, 'nebius', ask=ask, screen=fx.fake_screen, approved=yes)
        finally: del os.environ['HIKYAKU_RUN']
        events = events_of(run_dir)
        assert [e['type'] for e in events] == ['ai.picked', 'outbound.sent', 'outbound.returned', 'check.result'], events
        assert [e['seq'] for e in events] == [1, 2, 3, 4] and all(set(e) == ENVELOPE and e['run'] == RUN for e in events)
        sent, back, check = (e['data'] for e in events[1:])
        assert sent['what'] == 'call-notes' and sent['source_ids'] == [f'call:{folder.parent.name}'] and sent['sentences_kept'] == 1 and sent['destination'] == 'cloud'
        assert sent['chars'] == len(calls[0]) and sent['provider_id'] == 'nebius-token-factory' and fx.HELD not in json.dumps(events)
        assert Path(sent['receipt']).read_text() == calls[0], 'the receipt is the copy of the exact prompt sent'
        assert back['ok'] is True and back['tokens']['prompt'] == 10
        assert set(check) >= {'bullets', 'verified', 'not_sure', 'dropped', 'next_steps_kept', 'deadlines_dropped'} and check['bullets'] == check['verified'] + check['not_sure']
        for e in events: assert not (e['text'] and sendgate.NAMES_A_MODEL.search(e['text'])), e
        # byo.py by hand (no HIKYAKU_RUN) writes no events
        ask2, _ = fx.fake()
        with contextlib.redirect_stdout(io.StringIO()): byo.run(folder, 'nebius', ask=ask2, screen=fx.fake_screen, approved=yes)
        assert len(events_of(run_dir)) == 4

def test_a_failed_ask_says_no_answer_came_back():
    with tempfile.TemporaryDirectory() as d:
        folder = fx.folder_in(d)
        yes = fx.approve(folder)
        run_dir = Path(d) / 'runs' / RUN
        def down(prompt): raise SystemExit('the cloud AI could not be reached; nothing written')
        os.environ['HIKYAKU_RUN'] = str(run_dir)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                try: byo.run(folder, 'nebius', ask=down, screen=fx.fake_screen, approved=yes)
                except SystemExit: pass
                else: assert False
        finally: del os.environ['HIKYAKU_RUN']
        events = events_of(run_dir)
        assert [e['type'] for e in events] == ['outbound.sent', 'outbound.returned'] and events[1]['data']['ok'] is False, events

if __name__ == '__main__':
    import fixtures; fixtures.run(globals())
