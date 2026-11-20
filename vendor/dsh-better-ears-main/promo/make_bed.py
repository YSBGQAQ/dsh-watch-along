"""Synthesize a soft 120 BPM lo-fi bed (A minor: Am F C G) for the promo.

No samples, no external deps beyond numpy. 78 s, 44.1 kHz mono.
"""
import sys
import wave

import numpy as np

SR = 44100
BPM = 120.0
BEAT = 60.0 / BPM
BAR = 4 * BEAT
DUR = float(sys.argv[1]) if len(sys.argv) > 1 else 78.0
N = int(SR * DUR)

out = np.zeros(N, dtype=np.float64)


def add(sig, t):
    i = int(round(t * SR))
    if i >= N:
        return
    j = min(N, i + len(sig))
    out[i:j] += sig[: j - i]


def env(n, attack, decay, sustain=0.0, release=0.0):
    e = np.ones(n)
    a = max(1, int(attack * SR))
    d = max(1, int(decay * SR))
    e[:a] = np.linspace(0, 1, a)
    if d < n:
        e[a:d] = np.linspace(1, sustain, d - a) if d > a else sustain
        e[d:] = sustain
    if release > 0:
        r = min(n, int(release * SR))
        e[-r:] *= np.linspace(1, 0, r)
    return e


def pad_note(freq, dur, amp):
    n = int(dur * SR)
    t = np.arange(n) / SR
    vib = 1 + 0.0015 * np.sin(2 * np.pi * 0.7 * t + freq)
    sig = np.zeros(n)
    for mul, g in ((1, 1.0), (2, 0.18), (3, 0.06)):
        sig += g * np.sin(2 * np.pi * freq * mul * vib * t)
    sig *= env(n, 0.35, dur * 0.6, 0.72, 0.55)
    return amp * sig / 1.24


def bass_note(freq, dur, amp):
    n = int(dur * SR)
    t = np.arange(n) / SR
    sig = np.sin(2 * np.pi * freq * t) + 0.28 * np.sin(2 * np.pi * freq * 2 * t)
    sig *= np.exp(-t * 2.1) * env(n, 0.006, 0.05, 1.0)
    return amp * sig


def kick(amp=0.95):
    n = int(0.22 * SR)
    t = np.arange(n) / SR
    f = 108 * np.exp(-t * 26) + 44
    sig = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 15)
    return amp * sig


def snare(amp=0.22):
    n = int(0.16 * SR)
    t = np.arange(n) / SR
    rng = np.random.default_rng(7)
    noise = rng.standard_normal(n) * np.exp(-t * 30)
    body = np.sin(2 * np.pi * 196 * t) * np.exp(-t * 18) * 0.4
    sig = (noise + body) * env(n, 0.002, 0.02, 1.0)
    # soften the noise band
    sig = np.convolve(sig, np.ones(6) / 6, mode="same")
    return amp * sig


def hat(amp=0.05):
    n = int(0.05 * SR)
    t = np.arange(n) / SR
    rng = np.random.default_rng(11)
    noise = rng.standard_normal(n) * np.exp(-t * 90)
    noise = np.diff(np.concatenate([[0], noise]))
    return amp * noise


def bell(freq, amp=0.06):
    n = int(2.6 * SR)
    t = np.arange(n) / SR
    sig = np.sin(2 * np.pi * freq * t) * np.exp(-t * 1.8)
    sig += 0.35 * np.sin(2 * np.pi * freq * 2.01 * t) * np.exp(-t * 2.6)
    sig *= env(n, 0.004, 0.02, 1.0)
    return amp * sig


PROG = [
    (110.00, [220.00, 261.63, 329.63]),   # Am
    (87.31, [174.61, 220.00, 261.63]),    # F
    (130.81, [261.63, 329.63, 392.00]),   # C
    (98.00, [196.00, 246.94, 293.66]),    # G
]

bar_t = 0.0
idx = 0
while bar_t < DUR:
    root, notes = PROG[idx % len(PROG)]
    for f in notes:
        add(pad_note(f, BAR + 0.35, 0.16), bar_t)
        add(pad_note(f * 1.003, BAR + 0.35, 0.10), bar_t)
    add(bass_note(root, 1.1, 0.34), bar_t)
    add(bass_note(root, 0.9, 0.20), bar_t + 2 * BEAT)
    for b in range(4):
        t = bar_t + b * BEAT
        if b in (0, 2):
            add(kick(), t)
        if b in (1, 3):
            add(snare(), t)
        add(hat(), t + BEAT / 2)
    if idx % 2 == 0:
        add(bell(notes[0] * 2, 0.05), bar_t + 0.02)
        add(bell(notes[2] * 2, 0.035), bar_t + 1.5 * BEAT)
    bar_t += BAR
    idx += 1

# fade in / out
fi = int(0.9 * SR)
out[:fi] *= np.linspace(0, 1, fi)
fo = int(4.5 * SR)
out[-fo:] *= np.linspace(1, 0, fo) ** 1.5

peak = np.max(np.abs(out))
out = out / peak * 0.62
pcm = np.clip(out * 32767, -32768, 32767).astype("<i2")

path = sys.argv[2] if len(sys.argv) > 2 else "audio/bed.wav"
with wave.open(path, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print(path, f"{DUR:.1f}s", "peak", round(float(np.max(np.abs(out))), 3))
