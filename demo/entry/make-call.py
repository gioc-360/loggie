# Makes the demo call with macOS `say`: two invented people, two different voices, a scripted coffee chat of about
# three and a half minutes. Output is the layout call.py expects for a recorded call: me.wav (Nadia, 16 kHz mono)
# holds only her turns, them.wav (Omar) only his, each silent while the other speaks, the same length. A headphones
# call, on purpose: no echo of the other side on the mic. Also writes event.json, truth.json (what was said, with
# times).
# Planted for the checks (see planted.json): two names a speech model is likely to miss (Saoirse Kowalczyk, Dmitri
# Vandenboogaard), one deadline with a date (October thirtieth), one next move (the teardown), and one private item
# the cloud-first screen must hold (a spoken account number).
#   python3 make-call.py [outdir]      (needs only macOS; no third-party packages)
import json, subprocess, sys, tempfile, wave
from pathlib import Path

ME, THEM = ('Nadia Feldman', 'Samantha'), ('Omar Castellano', 'Daniel')
RATE = 16000
GAP_S = 0.9        # pause between turns, the same both sides
LEAD_S = 1.0       # silence before the first word

SCRIPT = [
 ('them', "Hi Nadia, thanks for making time. Can you hear me alright?"),
 ('me',   "Yes, loud and clear. Thanks for doing this, Omar. I know Tuesdays are busy for you."),
 ('them', "No problem at all. So you said you wanted to hear about the product role at Larkspur Logistics."),
 ('me',   "Right. I read that the team grew from six to nineteen people last year, and I wanted to know what that was like from the inside."),
 ('them', "It was fast. When I joined on March fourteenth we had one product manager for the whole driver app. Now there are four of us."),
 ('me',   "And routing is the hard one, I imagine. Something like three hundred drivers across two cities?"),
 ('them', "Closer to four hundred and twenty now, across Boulder, Lisbon and a pilot in Tucson. The pilot is only forty drivers but it is the one everyone watches."),
 ('me',   "Why Tucson?"),
 ('them', "Heat. Batteries drop about eighteen percent faster in summer, so the routing model has to plan charging stops it never needed in Boulder."),
 ('me',   "That is a good problem. Did you build that model in house or bring in a vendor?"),
 ('them', "In house, mostly. We tried a vendor for about two months and dropped them in August because the latency was over nine seconds per plan. Drivers will not wait nine seconds at a loading dock."),
 ('me',   "Let me ask the question I actually came with. What does a strong first ninety days look like for someone joining your team?"),
 ('them', "Ship something small by week six. My first real win was a fix to the handoff screen; it cut missed pickups by eleven percent. And ride along with drivers early, nobody on the team has skipped that."),
 ('me',   "I would want to do that anyway. Who shapes the product direction day to day? I want to read what they have written before I apply."),
 ('them', "That is Saoirse Kowalczyk, our director of product. She reads every application herself, and she cares more about how you think about the driver experience than about a polished resume."),
 ('me',   "That helps a lot. Is there a way to show her how I think before the formal application?"),
 ('them', "There is. One thing would help me push for you. Send me a one page teardown of our driver handoff screen before the application closes on October thirtieth."),
 ('me',   "I can do that. The public app has the handoff screen, so I can work from that. Should it focus on the flow or on the numbers?"),
 ('them', "The flow, and what you would test first. Keep it to one page. If it is good I will put it in front of her myself."),
 ('me',   "Understood. And on the data side, who would I be working with for routing?"),
 ('them', "Dmitri Vandenboogaard runs the routing data team. If you meet anyone from the team, he is the one who will ask the hard questions, so read up on how the charging stops are planned."),
 ('me',   "I will. One practical thing before I forget. You mentioned a travel stipend for the Boulder visit. My account number is 4 8 2 0 1 7 3 6 5 9, so payroll can send it directly."),
 ('them', "Got it, thanks. I will pass that to the recruiting coordinator. Is there anything about the role that worries you?"),
 ('me',   "Honestly, the pace. Going from six to nineteen people in a year sounds exciting, but I want to be sure there is time to do the work well."),
 ('them', "Fair. The honest answer is that it is busy, but the team protects two quiet mornings a week for deep work, and I use mine for exactly the kind of teardown I just asked you for."),
 ('me',   "That is reassuring. Is there someone on the onboarding side you would introduce me to?"),
 ('them', "Happy to, Priya runs onboarding. I will send an intro tonight."),
 ('me',   "Thank you, Omar, this was really helpful. I will send you a note after I talk to Priya."),
 ('them', "Please do. Good luck, Nadia. Talk soon."),
 ('me',   "Bye."),
]

def speak(voice, text, tmp, n):
    f = tmp / f'{n:02d}.wav'
    subprocess.run(['say', '-v', voice, '-o', str(f), '--data-format', f'LEI16@{RATE}', text], check=True)
    with wave.open(str(f)) as w:
        assert w.getnchannels() == 1 and w.getframerate() == RATE and w.getsampwidth() == 2, f'{f}: unexpected format'
        return w.readframes(w.getnframes())

def main(out):
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    tracks = {'me': bytearray(), 'them': bytearray()}
    turns, t = [], LEAD_S
    silence = lambda s: b'\x00\x00' * int(s * RATE)
    for side in tracks: tracks[side] += silence(LEAD_S)
    with tempfile.TemporaryDirectory() as tmp:
        for n, (side, text) in enumerate(SCRIPT):
            pcm = speak(ME[1] if side == 'me' else THEM[1], text, Path(tmp), n)
            other = 'them' if side == 'me' else 'me'
            tracks[side] += pcm; tracks[other] += b'\x00' * len(pcm)
            turns.append({'who': ME[0] if side == 'me' else THEM[0], 'side': side, 'start': round(t, 2), 'end': round(t + len(pcm) / 2 / RATE, 2), 'text': text})
            t += len(pcm) / 2 / RATE + GAP_S
            for s in tracks: tracks[s] += silence(GAP_S)
    for side, pcm in tracks.items():
        with wave.open(str(out / f'{side}.wav'), 'wb') as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE); w.writeframes(bytes(pcm))
    event = {'title': 'Coffee chat - Omar Castellano', 'start': '2026-10-13T15:00:00-04:00', 'emails': ['omar.castellano@larkspur.example'],
             'names': THEM[0], 'attendees': THEM[0], 'me': ME[0].split()[0], 'with': THEM[0], 'category': 'one-on-one', 'workstream': 'Larkspur Logistics',
             'synthetic': f'made by make-call.py with macOS say ({ME[1]} as {ME[0]}, {THEM[1]} as {THEM[0]}); invented people'}
    (out / 'event.json').write_text(json.dumps(event, indent=2) + '\n')
    (out / 'truth.json').write_text(json.dumps(turns, indent=1) + '\n')
    print(f"{out}: {t:.1f} s, {len(SCRIPT)} turns, {sum(len(x.split()) for _, x in SCRIPT)} words")

if __name__ == '__main__': main(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent / 'call')
