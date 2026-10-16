#!/usr/bin/env python3
"""
Procedural Audio Synthesizer for Vartalap Launch Video
Generates music bed and synchronized sound effects in pure Python.
Sample Rate: 48,000 Hz, 16-bit Stereo PCM WAV.
"""
import math
import struct
import wave
import random

SAMPLE_RATE = 48000
DURATION = 24.0  # seconds
NUM_SAMPLES = int(SAMPLE_RATE * DURATION)

left_channel = [0.0] * NUM_SAMPLES
right_channel = [0.0] * NUM_SAMPLES

def midi_to_freq(m):
    return 440.0 * (2.0 ** ((m - 69.0) / 12.0))

# ─────────────────────────────────────────────────────────────
# 1. MUSIC BED SYNTHESIS
# ─────────────────────────────────────────────────────────────

# Chord progression (MIDI notes): 120 BPM -> 2 sec per bar
# 0-4s: Dm9 (D3, F3, A3, C4, E4)
# 4-8s: Bbmaj7 (Bb2, D3, F3, A3, D4)
# 8-12s: Fmaj9 (F2, C3, E3, A3, C4)
# 12-16s: Am7 (A2, E3, G3, C4, E4)
# 16-20s: Gm9 (G2, D3, F3, Bb3, D4)
# 20-24s: Dm(add9) resolve (D2, A2, F3, C4, E4)
progression = [
    (0.0, 4.0, [50, 53, 57, 60, 64], 38),   # Dm9, bass D2
    (4.0, 8.0, [46, 50, 53, 57, 62], 34),   # Bbmaj7, bass Bb1
    (8.0, 12.0, [41, 48, 52, 57, 60], 29),  # Fmaj9, bass F1
    (12.0, 16.0, [45, 52, 55, 60, 64], 33), # Am7, bass A1
    (16.0, 20.0, [43, 50, 53, 58, 62], 31), # Gm9, bass G1
    (20.0, 24.0, [38, 45, 53, 60, 64], 26), # Dm resolve, bass D1
]

# Generate warm synth pads (chords)
for start_t, end_t, chord_notes, bass_note in progression:
    start_idx = int(start_t * SAMPLE_RATE)
    end_idx = int(end_t * SAMPLE_RATE)
    chord_len = end_idx - start_idx

    # Pad chords
    for note in chord_notes:
        freq = midi_to_freq(note)
        detune = 0.998
        pan = (note % 5) / 5.0  # stereo spread
        l_gain = 1.0 - 0.5 * pan
        r_gain = 0.5 + 0.5 * pan

        for i in range(chord_len):
            idx = start_idx + i
            if idx >= NUM_SAMPLES:
                break
            t = i / SAMPLE_RATE

            # Envelope: smooth attack, gentle release
            attack = 0.5
            release = 0.8
            if t < attack:
                env = 0.5 * (1.0 - math.cos(math.pi * t / attack))
            elif t > (end_t - start_t) - release:
                rel_t = (end_t - start_t) - t
                env = max(0.0, rel_t / release)
            else:
                env = 1.0

            # Warm sine + gentle 2nd harmonic
            sig = (
                0.7 * math.sin(2.0 * math.pi * freq * t) +
                0.3 * math.sin(2.0 * math.pi * freq * detune * t) +
                0.15 * math.sin(4.0 * math.pi * freq * t)
            ) * env * 0.045

            left_channel[idx] += sig * l_gain
            right_channel[idx] += sig * r_gain

    # Deep Sub-Bass
    bass_freq = midi_to_freq(bass_note)
    for i in range(chord_len):
        idx = start_idx + i
        if idx >= NUM_SAMPLES:
            break
        t = i / SAMPLE_RATE
        env = min(1.0, t / 0.15) * min(1.0, ((end_t - start_t) - t) / 0.3)
        # Clean sub sine with subtle saturation
        sub = math.sin(2.0 * math.pi * bass_freq * t) * env * 0.11
        sub_dist = math.tanh(sub * 1.5) * 0.8
        left_channel[idx] += sub_dist
        right_channel[idx] += sub_dist

# Arpeggio pulse (16th notes: 120 BPM = 0.125s per note)
step_duration = 0.125
total_steps = int(21.0 / step_duration)  # stops before outro
arp_patterns = [
    [0, 2, 4, 1, 3, 2, 4, 3],
    [0, 1, 3, 4, 2, 3, 1, 2],
    [0, 3, 2, 4, 1, 2, 4, 1],
]

for step in range(total_steps):
    step_t = step * step_duration
    # find current chord
    chord = [62, 65, 69, 72, 76]
    for st, et, ch, _ in progression:
        if st <= step_t < et:
            chord = [n + 12 for n in ch] # octave up
            break

    pat = arp_patterns[(step // 16) % len(arp_patterns)]
    note_idx = pat[step % len(pat)]
    note = chord[note_idx % len(chord)]
    freq = midi_to_freq(note)

    start_idx = int(step_t * SAMPLE_RATE)
    note_samples = int(0.25 * SAMPLE_RATE) # ringing tail
    pan = 0.3 if step % 2 == 0 else 0.7

    for i in range(note_samples):
        idx = start_idx + i
        if idx >= NUM_SAMPLES:
            break
        t = i / SAMPLE_RATE
        decay = math.exp(-t * 14.0)
        # FM pluck
        mod = math.sin(2.0 * math.pi * freq * 2.0 * t) * 0.5 * decay
        sig = math.sin(2.0 * math.pi * freq * t + mod) * decay * 0.035

        left_channel[idx] += sig * (1.0 - pan)
        right_channel[idx] += sig * pan

# Rhythmic percussion (Kick, Clap, Hi-hat) starting from t=4.5s to 21.0s
tempo_sec = 0.5 # beat interval (120 BPM)
num_beats = int((21.0 - 4.5) / tempo_sec)

for b in range(num_beats):
    beat_t = 4.5 + b * tempo_sec
    start_idx = int(beat_t * SAMPLE_RATE)

    # Kick on beats 1 and 3 of bar (every 2 beats)
    if b % 2 == 0:
        kick_samples = int(0.22 * SAMPLE_RATE)
        for i in range(kick_samples):
            idx = start_idx + i
            if idx >= NUM_SAMPLES:
                break
            t = i / SAMPLE_RATE
            # Pitch drop from 140Hz to 45Hz
            pitch = 45.0 + 95.0 * math.exp(-t * 28.0)
            env = math.exp(-t * 18.0)
            sig = math.sin(2.0 * math.pi * pitch * t) * env * 0.16
            left_channel[idx] += sig
            right_channel[idx] += sig

    # Soft clap/rim on beats 2 and 4 (alternate beats)
    if b % 2 == 1:
        clap_samples = int(0.12 * SAMPLE_RATE)
        for i in range(clap_samples):
            idx = start_idx + i
            if idx >= NUM_SAMPLES:
                break
            t = i / SAMPLE_RATE
            noise = (random.random() * 2.0 - 1.0)
            env = math.exp(-t * 32.0)
            sig = noise * env * 0.035
            left_channel[idx] += sig * 0.9
            right_channel[idx] += sig * 0.9

    # Crisp Hi-hat on 8th notes
    for sub in [0.0, 0.25]:
        hat_idx = int((beat_t + sub) * SAMPLE_RATE)
        hat_samples = int(0.04 * SAMPLE_RATE)
        for i in range(hat_samples):
            idx = hat_idx + i
            if idx >= NUM_SAMPLES:
                break
            t = i / SAMPLE_RATE
            noise = (random.random() * 2.0 - 1.0)
            env = math.exp(-t * 90.0)
            sig = noise * env * 0.018
            left_channel[idx] += sig * 0.6
            right_channel[idx] += sig * 0.8

# ─────────────────────────────────────────────────────────────
# 2. SYNCHRONIZED SOFT SOUND EFFECTS (HIT THE CUTS)
# ─────────────────────────────────────────────────────────────

def add_whoosh(time_sec, duration=0.45, intensity=0.06):
    start_idx = int(time_sec * SAMPLE_RATE)
    samples = int(duration * SAMPLE_RATE)
    for i in range(samples):
        idx = start_idx + i
        if idx >= NUM_SAMPLES:
            break
        t = i / samples
        env = math.sin(math.pi * t) ** 2
        # Filtered sweeping noise
        freq = 300.0 + 1800.0 * t
        osc = math.sin(2.0 * math.pi * freq * (i / SAMPLE_RATE))
        noise = (random.random() * 2.0 - 1.0) * 0.4
        sig = (osc + noise) * env * intensity
        left_channel[idx] += sig * (1.0 - t * 0.5)
        right_channel[idx] += sig * (0.5 + t * 0.5)

def add_pop(time_sec, freq=520.0, intensity=0.07):
    start_idx = int(time_sec * SAMPLE_RATE)
    samples = int(0.12 * SAMPLE_RATE)
    for i in range(samples):
        idx = start_idx + i
        if idx >= NUM_SAMPLES:
            break
        t = i / SAMPLE_RATE
        f = freq * math.exp(-t * 25.0)
        env = math.exp(-t * 35.0)
        sig = math.sin(2.0 * math.pi * f * t) * env * intensity
        left_channel[idx] += sig
        right_channel[idx] += sig

def add_chime(time_sec, notes=[79, 83, 86], intensity=0.04):
    start_idx = int(time_sec * SAMPLE_RATE)
    samples = int(1.4 * SAMPLE_RATE)
    for n_idx, note in enumerate(notes):
        freq = midi_to_freq(note)
        delay = int(n_idx * 0.06 * SAMPLE_RATE)
        for i in range(samples - delay):
            idx = start_idx + delay + i
            if idx >= NUM_SAMPLES:
                break
            t = i / SAMPLE_RATE
            env = math.exp(-t * 4.5)
            sig = (math.sin(2.0 * math.pi * freq * t) + 0.3 * math.sin(4.0 * math.pi * freq * t)) * env * intensity
            left_channel[idx] += sig * (0.4 + 0.2 * n_idx)
            right_channel[idx] += sig * (0.8 - 0.2 * n_idx)

def add_click(time_sec, intensity=0.05):
    start_idx = int(time_sec * SAMPLE_RATE)
    samples = int(0.04 * SAMPLE_RATE)
    for i in range(samples):
        idx = start_idx + i
        if idx >= NUM_SAMPLES:
            break
        t = i / SAMPLE_RATE
        sig = math.sin(2.0 * math.pi * 1800.0 * t) * math.exp(-t * 90.0) * intensity
        left_channel[idx] += sig
        right_channel[idx] += sig

# Add Foley SFX hitting the visual cuts:
add_whoosh(0.1, duration=0.6, intensity=0.04)     # Opening motion
add_whoosh(4.5, duration=0.4, intensity=0.05)     # Cut to Beat 2 (Optimistic Send)
add_pop(6.5, freq=580.0, intensity=0.07)          # Message 1 sent
add_whoosh(9.0, duration=0.4, intensity=0.05)     # Cut to Beat 3 (Monotonic Seq)
add_pop(11.2, freq=640.0, intensity=0.07)         # Message 2 burst corner fusion
add_whoosh(13.5, duration=0.4, intensity=0.05)    # Cut to Beat 4 (Watermark)
add_chime(15.0, notes=[81, 84, 88], intensity=0.045) # "Seen" watermark appears
add_whoosh(17.5, duration=0.4, intensity=0.05)    # Cut to Beat 5 (Theme Switch)
add_click(18.8, intensity=0.06)                   # Dark mode toggle click
add_whoosh(21.0, duration=0.8, intensity=0.08)    # Outro transition
add_chime(21.4, notes=[74, 78, 81, 86], intensity=0.05) # Logo drawing chime

# ─────────────────────────────────────────────────────────────
# 3. WRITE RAW PCM 16-BIT WAV
# ─────────────────────────────────────────────────────────────

raw_wav_path = "launch-video/public/soundtrack-raw.wav"
with wave.open(raw_wav_path, "wb") as wav_file:
    wav_file.setnchannels(2)
    wav_file.setsampwidth(2)
    wav_file.setframerate(SAMPLE_RATE)

    # Soft master limiting
    frames = bytearray()
    for i in range(NUM_SAMPLES):
        l = max(-0.95, min(0.95, left_channel[i]))
        r = max(-0.95, min(0.95, right_channel[i]))
        l_int = int(l * 32767.0)
        r_int = int(r * 32767.0)
        frames.extend(struct.pack("<hh", l_int, r_int))

    wav_file.writeframes(frames)

print(f"Generated procedural soundtrack: {raw_wav_path}")
