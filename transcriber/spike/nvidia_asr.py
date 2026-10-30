# Shared pieces of the NVIDIA speech runtime for nvidia_engine.py, live.py and stream.py: where NeMo-Speech.cpp lives
# (NSC), a child process's peak memory (Footprint, sampled with `footprint` every 2 s), the machine's load at the time,
# reading a 16 kHz mono wav, and the cut rule for long audio (the quietest 30 ms frame near every window, a rule, not a
# model: no VAD in the loop).
import os, re, subprocess, threading, time, wave
from pathlib import Path
import numpy as np

NSC = Path.home() / 'Library/Application Support/Loggie/models/nvidia/nemo-speech/nemo-speech-0.2.0-macos-aarch64-metal/bin/nemo-speech'

# ---------- measurement ----------

class Footprint(threading.Thread):
    # Peak "Footprint" of a process as `footprint <pid>` reports it, sampled every `every` seconds.
    def __init__(self, pid, every=2.0):
        super().__init__(daemon=True); self.pid, self.every, self.peak_kb, self.peak_rss_kb, self.samples, self.stop = pid, every, 0, 0, 0, False
    def run(self):
        while not self.stop:
            out = subprocess.run(['footprint', str(self.pid)], capture_output=True, text=True).stdout
            m = re.search(r'Footprint:\s+([\d.]+)\s+(KB|MB|GB)', out)
            if m:
                v = float(m.group(1)) * {'KB': 1, 'MB': 1024, 'GB': 1024 * 1024}[m.group(2)]
                self.peak_kb = max(self.peak_kb, v); self.samples += 1
            rss = subprocess.run(['ps', '-o', 'rss=', '-p', str(self.pid)], capture_output=True, text=True).stdout.strip()
            if rss.isdigit(): self.peak_rss_kb = max(self.peak_rss_kb, int(rss))
            time.sleep(self.every)

def machine():
    return {'uptime': subprocess.run(['uptime'], capture_output=True, text=True).stdout.strip(), 'load_avg': [round(x, 2) for x in os.getloadavg()],
            'note': 'timings are not clean: other sessions load this Mac'}

# ---------- audio ----------

def read_wav(path):
    with wave.open(str(path)) as w:
        assert w.getnchannels() == 1 and w.getframerate() == 16000, f'{path}: need 16 kHz mono (got {w.getnchannels()} ch, {w.getframerate()} Hz)'
        return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768

def rms_frames(x, sr=16000, hop=0.03):
    # RMS of every whole 30 ms frame (shared by cuts, nvidia_engine.loudness and live.py's cut rule).
    n = int(hop * sr); frames = len(x) // n
    return np.sqrt(np.add.reduceat(x[:frames * n] ** 2, np.arange(0, frames * n, n)) / n)

def cuts(x, sr=16000, window=60.0, search=10.0, hop=0.03):
    # Cut points for long audio: near every `window` seconds, the quietest 30 ms frame within +-search seconds.
    rms = rms_frames(x, sr, hop)
    points, t = [0.0], window
    while t < len(x) / sr - search:
        a, b = int((t - search) / hop), int((t + search) / hop)
        i = a + int(np.argmin(rms[a:b])); points.append(i * hop); t = i * hop + window
    points.append(len(x) / sr)
    return points
