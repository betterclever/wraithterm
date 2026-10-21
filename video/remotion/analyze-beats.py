"""Measure local source onsets and audit the selected 60-fps edit. Requires NumPy.

Usage: python3 analyze-beats.py /path/to/supplied.mp4 --output ../claims/hype-music.json
This records measurements and a file hash; no samples or lyrics are retained.
"""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

import numpy as np

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
sample_rate, hop, window = 22050, 220, 2048
pcm = subprocess.run([
    "ffmpeg", "-v", "error", "-i", str(args.source), "-vn", "-ac", "1",
    "-ar", str(sample_rate), "-t", "75", "-f", "f32le", "-",
], capture_output=True, check=True).stdout
samples = np.frombuffer(pcm, dtype="<f4")
frames = np.lib.stride_tricks.sliding_window_view(samples, window)[::hop]
spectrum = np.abs(np.fft.rfft(frames * np.hanning(window), axis=1))
frequencies = np.fft.rfftfreq(window, 1 / sample_rate)
times = (np.arange(len(spectrum)) * hop + window / 2) / sample_rate
bass = np.sqrt((spectrum[:, (frequencies >= 30) & (frequencies < 130)] ** 2).mean(axis=1))
flux = np.maximum(np.diff(np.log1p(spectrum * 5), axis=0, prepend=0), 0).mean(axis=1)
low_flux = np.maximum(np.diff(np.log1p(bass), prepend=0), 0)
onsets = flux / (np.std(flux) + 1e-9) + .5 * low_flux / (np.std(low_flux) + 1e-9)
smoothed = np.convolve(onsets, [.1, .25, .3, .25, .1], mode="same")
best = (-1., 0., 0.)
for bpm in np.arange(128, 134, .02):
    beat = 60 / bpm
    for phase in np.arange(0, beat, .005):
        beats = np.arange(phase, 75, beat)
        beats = beats[(beats > 8) & (beats < 70)]
        score = float(np.interp(beats, times, smoothed).mean())
        best = max(best, (score, float(bpm), float(phase)))
peaks = [i for i in range(2, len(onsets) - 2)
         if onsets[i] == max(onsets[i - 2:i + 3]) and onsets[i] > 2]
cues = [0, 110, 330, 550, 769, 989, 1209, 1429]
offset = .8
matches = []
for frame in cues:
    source_time = offset + frame / 60
    peak = min(peaks, key=lambda i: abs(times[i] - source_time))
    matches.append({
        "editFrame": frame, "sourceSeconds": source_time,
        "nearestOnsetSeconds": round(float(times[peak]), 6),
        "differenceMs": round(float((source_time - times[peak]) * 1000), 3),
    })
record = {
    "sourceFile": args.source.name,
    "sourceSha256": hashlib.file_digest(args.source.open("rb"), "sha256").hexdigest(),
    "method": "Hann STFT; positive log spectral flux plus 30–130 Hz bass flux; tempo/phase grid fit on seconds 8–70",
    "sampleRate": sample_rate, "hopSamples": hop, "fftSamples": window,
    "tempoSearchBpm": [128, 134], "tempoStepBpm": .02,
    "bestTempoBpm": round(best[1], 3), "bestBeatPhaseSeconds": round(best[2], 6),
    "selectedSourceOffsetSeconds": offset, "editBpm": 131, "editFps": 60,
    "cutOnsets": matches,
    "limits": "Spectral onset agreement estimates beat phase; it does not identify musical bars, lyrics or guarantee perceptual sync. Native/Studio listening review is separate.",
}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(record, indent=2) + "\n")
print(json.dumps({"bpm": record["bestTempoBpm"], "maxCutErrorMs": max(abs(m["differenceMs"]) for m in matches)}, indent=2))
