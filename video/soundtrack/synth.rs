//! The Wraith launch soundtrack, synthesized from scratch: no samples, no dependencies.
//!
//! 120 BPM (one bar = 2 s), D harmonic minor, Dm – B♭ – Gm – A. Every section boundary
//! lands on a bar so the video's cuts and the music's hits line up:
//!
//!   0–4   intro: drone, wind, music box, reverse swell
//!   4–22  the drop: half-time drums, sub, pads, arpeggio
//!   22–32 build: choir enters, filters open, riser
//!   32–46 full: lead motif over everything
//!   46–50 breakdown: pads and bells only
//!   50–57 final hit and a long tail
//!
//! Build and run: `rustc -O --edition 2021 soundtrack/synth.rs -o .cache/synth && .cache/synth media/soundtrack.wav`
use std::f32::consts::{PI, TAU};
use std::io::Write;

const SR: f32 = 48_000.0;
const LENGTH: f32 = 57.0;
const BEAT: f32 = 0.5;
const BAR: f32 = 2.0;

// ---------------------------------------------------------------------------------------------
// Building blocks

struct Rng(u32);
impl Rng {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0 as f32 / u32::MAX as f32 * 2.0 - 1.0
    }
}

fn hz(midi: f32) -> f32 {
    440.0 * 2f32.powf((midi - 69.0) / 12.0)
}

/// Band-limited sawtooth step (polyBLEP).
fn saw(phase: f32, inc: f32) -> f32 {
    let mut v = 2.0 * phase - 1.0;
    if phase < inc {
        let t = phase / inc;
        v -= t + t - t * t - 1.0;
    } else if phase > 1.0 - inc {
        let t = (phase - 1.0) / inc;
        v -= t * t + t + t + 1.0;
    }
    v
}

/// Topology-preserving state-variable filter.
#[derive(Clone, Copy, Default)]
struct Svf {
    ic1: f32,
    ic2: f32,
}
impl Svf {
    /// Returns (low, band, high).
    fn run(&mut self, x: f32, cutoff: f32, q: f32) -> (f32, f32, f32) {
        let g = (PI * cutoff.clamp(10.0, SR * 0.45) / SR).tan();
        let k = 1.0 / q;
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;
        let v3 = x - self.ic2;
        let v1 = a1 * self.ic1 + a2 * v3;
        let v2 = self.ic2 + a2 * self.ic1 + a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        (v2, v1, x - k * v1 - v2)
    }
}

/// Stereo buses that instruments write into.
struct Mix {
    music: [Vec<f32>; 2],
    drums: [Vec<f32>; 2],
    reverb: [Vec<f32>; 2],
    delay: [Vec<f32>; 2],
    kicks: Vec<f32>,
}
impl Mix {
    fn new() -> Self {
        let n = (LENGTH * SR) as usize;
        let z = || [vec![0.0; n], vec![0.0; n]];
        Mix { music: z(), drums: z(), reverb: z(), delay: z(), kicks: vec![] }
    }
    fn len(&self) -> usize {
        self.music[0].len()
    }
}

#[derive(Clone, Copy)]
enum Bus {
    Music,
    Drums,
}

/// Writes one stereo sample with equal-power pan and effect sends.
fn put(mix: &mut Mix, bus: Bus, i: usize, v: f32, pan: f32, rev: f32, dly: f32) {
    if i >= mix.len() {
        return;
    }
    let a = (pan.clamp(-1.0, 1.0) + 1.0) * PI / 4.0;
    let (l, r) = (v * a.cos(), v * a.sin());
    let target = match bus {
        Bus::Music => &mut mix.music,
        Bus::Drums => &mut mix.drums,
    };
    target[0][i] += l;
    target[1][i] += r;
    mix.reverb[0][i] += l * rev;
    mix.reverb[1][i] += r * rev;
    mix.delay[0][i] += l * dly;
    mix.delay[1][i] += r * dly;
}

fn idx(t: f32) -> usize {
    (t.max(0.0) * SR) as usize
}

/// Attack / release envelope for a note held for `hold` seconds.
fn ar(t: f32, attack: f32, hold: f32, release: f32) -> f32 {
    if t < 0.0 {
        0.0
    } else if t < attack {
        (t / attack).powf(1.5)
    } else if t < hold {
        1.0
    } else {
        (-(t - hold) / release * 4.0).exp()
    }
}

/// Section energy: how open the filters are and how loud the layers sit.
fn energy(t: f32) -> f32 {
    match t {
        t if t < 4.0 => 0.15 + 0.1 * t / 4.0,
        t if t < 22.0 => 0.6 + 0.15 * (t - 4.0) / 18.0,
        t if t < 32.0 => 0.75 + 0.25 * ((t - 22.0) / 10.0).powi(2),
        t if t < 46.0 => 1.0,
        t if t < 50.0 => 0.3,
        _ => 0.2 * (-(t - 50.0) / 3.0).exp(),
    }
}

// Dm, B♭, Gm, A (harmonic minor's major V for the leading tone).
const CHORDS: [[f32; 4]; 4] = [
    [50.0, 53.0, 57.0, 62.0],
    [46.0, 50.0, 53.0, 58.0],
    [43.0, 46.0, 50.0, 55.0],
    [45.0, 49.0, 52.0, 57.0],
];
const ROOTS: [f32; 4] = [38.0, 34.0, 31.0, 33.0];
fn chord(t: f32) -> usize {
    ((t / BAR) as usize) % 4
}

// ---------------------------------------------------------------------------------------------
// Instruments

/// Detuned supersaw chord with a slow tape wobble.
fn pad(mix: &mut Mix, start: f32, dur: f32, notes: &[f32], gain: f32, rng: &mut Rng) {
    for (n, &note) in notes.iter().enumerate() {
        for v in 0..5 {
            let detune = (v as f32 - 2.0) * 0.09 + rng.next() * 0.02;
            let f = hz(note + detune);
            let pan = (v as f32 - 2.0) / 2.0 * 0.8 * if n % 2 == 0 { 1.0 } else { -1.0 };
            let mut phase = (rng.next() + 1.0) * 0.5;
            let mut filter = Svf::default();
            let end = start + dur + 2.5;
            for i in idx(start)..idx(end) {
                let t = i as f32 / SR;
                let local = t - start;
                let wobble = 1.0 + 0.0025 * (TAU * 0.31 * t + v as f32).sin();
                let inc = f * wobble / SR;
                phase = (phase + inc) % 1.0;
                let e = energy(t);
                let cutoff = 350.0 + 2600.0 * e * e + 300.0 * (TAU * 0.13 * t).sin();
                let (lp, _, _) = filter.run(saw(phase, inc), cutoff, 0.9);
                let env = ar(local, 0.9, dur, 1.6);
                put(mix, Bus::Music, i, lp * env * gain * 0.075, pan, 0.55, 0.0);
            }
        }
    }
}

/// Formant-filtered saws: a distant, wordless choir moving between "ooh" and "aah".
fn choir(mix: &mut Mix, start: f32, dur: f32, notes: &[f32], gain: f32, rng: &mut Rng) {
    for &note in notes {
        for v in 0..3 {
            let f = hz(note + (v as f32 - 1.0) * 0.12);
            let mut phase = (rng.next() + 1.0) * 0.5;
            let (mut f1, mut f2, mut f3) = (Svf::default(), Svf::default(), Svf::default());
            let pan = (v as f32 - 1.0) * 0.7;
            for i in idx(start)..idx(start + dur + 3.0) {
                let t = i as f32 / SR;
                let local = t - start;
                let vib = 1.0 + 0.006 * (TAU * 5.1 * t + v as f32 * 2.0).sin() * (local / 1.5).min(1.0);
                let inc = f * vib / SR;
                phase = (phase + inc) % 1.0;
                let x = saw(phase, inc);
                let open = 0.5 + 0.5 * (TAU * 0.11 * t).sin();
                let (_, a, _) = f1.run(x, 320.0 + 400.0 * open, 6.0);
                let (_, b, _) = f2.run(x, 880.0 + 220.0 * open, 8.0);
                let (_, c, _) = f3.run(x, 2650.0, 10.0);
                let y = a + 0.6 * b + 0.15 * c;
                let env = ar(local, 1.4, dur, 2.0);
                put(mix, Bus::Music, i, y * env * gain * 0.1, pan, 0.8, 0.1);
            }
        }
    }
}

/// FM music box / bell with a long inharmonic shimmer.
fn bell(mix: &mut Mix, start: f32, note: f32, gain: f32, pan: f32) {
    let f = hz(note);
    for i in idx(start)..idx(start + 4.5) {
        let t = i as f32 / SR - start;
        let index = 2.2 * (-t * 3.0).exp() + 0.2;
        let m = (TAU * f * 3.5 * t).sin() * index;
        let y = (TAU * f * t + m).sin() * (-t * 1.3).exp() + 0.25 * (TAU * f * 2.76 * t).sin() * (-t * 3.5).exp();
        let attack = (t / 0.003).min(1.0);
        put(mix, Bus::Music, i, y * attack * gain * 0.24, pan, 0.75, 0.45);
    }
}

/// Plucked saw arpeggio voice.
fn pluck(mix: &mut Mix, start: f32, note: f32, gain: f32, pan: f32) {
    let f = hz(note);
    let mut filter = Svf::default();
    let mut phase = 0.0;
    let open = energy(start);
    for i in idx(start)..idx(start + 0.9) {
        let t = i as f32 / SR - start;
        let inc = f / SR;
        phase = (phase + inc) % 1.0;
        let cutoff = 300.0 + (900.0 + 3200.0 * open) * (-t * 14.0).exp();
        let (lp, _, _) = filter.run(saw(phase, inc) + 0.4 * saw((phase * 2.0) % 1.0, inc * 2.0), cutoff, 2.5);
        let env = (-t * 6.0).exp() * (t / 0.002).min(1.0);
        put(mix, Bus::Music, i, lp * env * gain * 0.14, pan, 0.25, 0.5);
    }
}

/// Sub bass: sine plus a little filtered saw for definition.
fn bass(mix: &mut Mix, start: f32, dur: f32, note: f32, gain: f32) {
    let f = hz(note);
    let mut filter = Svf::default();
    let mut phase = 0.0;
    for i in idx(start)..idx(start + dur + 0.3) {
        let t = i as f32 / SR - start;
        let inc = f / SR;
        phase = (phase + inc) % 1.0;
        let (lp, _, _) = filter.run(saw(phase, inc), 220.0, 0.8);
        let y = (TAU * phase).sin() * 0.9 + lp * 0.35;
        let env = ar(t, 0.02, dur, 0.15);
        put(mix, Bus::Music, i, y * env * gain * 0.2, 0.0, 0.0, 0.0);
    }
}

fn kick(mix: &mut Mix, start: f32, gain: f32) {
    mix.kicks.push(start);
    let mut phase = 0.0;
    for i in idx(start)..idx(start + 0.7) {
        let t = i as f32 / SR - start;
        let f = 42.0 + 120.0 * (-t * 28.0).exp();
        phase += f / SR;
        let body = (TAU * phase).sin() * (-t * 5.5).exp();
        let click = (TAU * 1800.0 * t).sin() * (-t * 180.0).exp() * 0.3;
        put(mix, Bus::Drums, i, ((body + click) * 1.6).tanh() * gain * 0.7, 0.0, 0.04, 0.0);
    }
}

fn snare(mix: &mut Mix, start: f32, gain: f32, rng: &mut Rng) {
    let mut filter = Svf::default();
    for i in idx(start)..idx(start + 0.5) {
        let t = i as f32 / SR - start;
        let (_, bp, _) = filter.run(rng.next(), 1900.0, 0.7);
        let tone = (TAU * 185.0 * t).sin() * (-t * 22.0).exp();
        let y = bp * (-t * 11.0).exp() * 1.3 + tone * 0.5;
        put(mix, Bus::Drums, i, y * gain * 0.42, 0.05, 0.7, 0.0);
    }
}

fn hat(mix: &mut Mix, start: f32, gain: f32, pan: f32, rng: &mut Rng) {
    let mut filter = Svf::default();
    for i in idx(start)..idx(start + 0.12) {
        let t = i as f32 / SR - start;
        let (_, _, hp) = filter.run(rng.next(), 8500.0, 0.8);
        put(mix, Bus::Drums, i, hp * (-t * 55.0).exp() * gain * 0.17, pan, 0.15, 0.0);
    }
}

/// Sub drop, noise burst and a reverb bloom.
fn impact(mix: &mut Mix, start: f32, gain: f32, rng: &mut Rng) {
    let mut phase = 0.0;
    let mut filter = Svf::default();
    for i in idx(start)..idx(start + 4.0) {
        let t = i as f32 / SR - start;
        phase += (30.0 + 50.0 * (-t * 2.0).exp()) / SR;
        let sub = (TAU * phase).sin() * (-t * 0.9).exp();
        let (lp, _, _) = filter.run(rng.next(), 6000.0 * (-t * 3.0).exp() + 200.0, 0.7);
        let noise = lp * (-t * 2.2).exp();
        put(mix, Bus::Drums, i, (sub * 0.55 + noise * 0.8) * gain, rng.next() * 0.2, 0.6, 0.0);
    }
}

/// Filtered noise and a rising saw, ending on `end`.
fn riser(mix: &mut Mix, end: f32, dur: f32, gain: f32, rng: &mut Rng) {
    let (mut fl, mut fr) = (Svf::default(), Svf::default());
    let mut phase = 0.0;
    for i in idx(end - dur)..idx(end) {
        let p = (i as f32 / SR - (end - dur)) / dur;
        let cutoff = 300.0 * 20f32.powf(p);
        let (_, l, _) = fl.run(rng.next(), cutoff, 3.0);
        let (_, r, _) = fr.run(rng.next(), cutoff * 1.07, 3.0);
        phase += hz(50.0 + 24.0 * p * p) / SR;
        let tone = saw(phase % 1.0, 0.01) * 0.25;
        let env = p.powf(2.2) * gain;
        put(mix, Bus::Music, i, (l + tone) * env * 0.6, -0.5, 0.4, 0.0);
        put(mix, Bus::Music, i, (r + tone) * env * 0.6, 0.5, 0.4, 0.0);
    }
}

/// A reversed swell: a bell-ish tone whose envelope rises into `end`.
fn swell(mix: &mut Mix, end: f32, dur: f32, notes: &[f32], gain: f32) {
    for (n, &note) in notes.iter().enumerate() {
        let f = hz(note);
        for i in idx(end - dur)..idx(end) {
            let t = i as f32 / SR;
            let p = (t - (end - dur)) / dur;
            let y = (TAU * f * t).sin() + 0.3 * (TAU * f * 2.0 * t + (TAU * f * 0.5 * t).sin()).sin();
            put(mix, Bus::Music, i, y * p.powi(3) * gain * 0.08, if n % 2 == 0 { -0.6 } else { 0.6 }, 0.9, 0.0);
        }
    }
}

/// Glitch stutter: a 32nd-note gated burst of the current chord, for the video's cuts.
fn stutter(mix: &mut Mix, start: f32, gain: f32, rng: &mut Rng) {
    let notes = CHORDS[chord(start)];
    for k in 0..8 {
        let s = start + k as f32 * BEAT / 8.0;
        let f = hz(notes[k % 4] + 12.0 + if k % 3 == 0 { 12.0 } else { 0.0 });
        let mut filter = Svf::default();
        for i in idx(s)..idx(s + BEAT / 10.0) {
            let t = i as f32 / SR - s;
            let x = (((f * t) % 1.0) * 2.0 - 1.0) * 0.6 + rng.next() * 0.3;
            let (_, bp, _) = filter.run(x, 1500.0 + 300.0 * k as f32, 1.5);
            put(mix, Bus::Drums, i, bp * gain * 0.25 * (1.0 - k as f32 / 10.0), if k % 2 == 0 { -0.7 } else { 0.7 }, 0.2, 0.3);
        }
    }
}

/// Constant haunted wind: two slowly sweeping noise bands drifting across the stereo field.
fn wind(mix: &mut Mix, rng: &mut Rng) {
    let (mut a, mut b) = (Svf::default(), Svf::default());
    for i in 0..mix.len() {
        let t = i as f32 / SR;
        let (_, x, _) = a.run(rng.next(), 500.0 + 350.0 * (TAU * 0.07 * t).sin(), 4.0);
        let (_, y, _) = b.run(rng.next(), 900.0 + 500.0 * (TAU * 0.05 * t + 1.0).sin(), 5.0);
        let level = 0.05 + 0.05 * (1.0 - energy(t)) + 0.03 * (TAU * 0.2 * t).sin().max(0.0);
        put(mix, Bus::Music, i, x * level, (TAU * 0.04 * t).sin() * 0.9, 0.3, 0.0);
        put(mix, Bus::Music, i, y * level * 0.7, -(TAU * 0.03 * t).sin() * 0.9, 0.3, 0.0);
    }
}

/// Root-and-fifth drone under everything, its filter breathing with the section energy.
fn drone(mix: &mut Mix, rng: &mut Rng) {
    for (note, pan) in [(26.0, -0.3), (33.0, 0.3), (38.0, 0.0)] {
        for v in 0..3 {
            let f = hz(note + (v as f32 - 1.0) * 0.07);
            let mut phase = (rng.next() + 1.0) * 0.5;
            let mut filter = Svf::default();
            for i in 0..mix.len() {
                let t = i as f32 / SR;
                let inc = f / SR;
                phase = (phase + inc) % 1.0;
                let e = energy(t);
                let (lp, _, _) = filter.run(saw(phase, inc), 140.0 + 500.0 * e + 80.0 * (TAU * 0.09 * t).sin(), 1.4);
                let fade = (t / 2.5).min(1.0) * ((LENGTH - t) / 3.0).clamp(0.0, 1.0);
                let duck = if (46.0..50.0).contains(&t) { 0.8 } else { 1.0 };
                put(mix, Bus::Music, i, lp * fade * duck * 0.022, pan + (v as f32 - 1.0) * 0.3, 0.3, 0.0);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Effects

/// Freeverb: eight damped combs and four allpasses per channel, tuned for a huge hall.
fn reverb(input: &[Vec<f32>; 2]) -> [Vec<f32>; 2] {
    const COMBS: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
    const ALLPASSES: [usize; 4] = [556, 441, 341, 225];
    let scale = SR / 44_100.0;
    let predelay = (0.035 * SR) as usize;
    let n = input[0].len();
    let mut out = [vec![0.0; n], vec![0.0; n]];
    for ch in 0..2 {
        let spread = if ch == 1 { 23 } else { 0 };
        let mut combs: Vec<(Vec<f32>, usize, f32)> =
            COMBS.iter().map(|&d| (vec![0.0; ((d + spread) as f32 * scale * 1.35) as usize], 0, 0.0)).collect();
        let mut alls: Vec<(Vec<f32>, usize)> =
            ALLPASSES.iter().map(|&d| (vec![0.0; ((d + spread) as f32 * scale) as usize], 0)).collect();
        let (feedback, damp) = (0.9, 0.3);
        for i in 0..n {
            let x = if i >= predelay { input[ch][i - predelay] * 0.015 } else { 0.0 };
            let mut y = 0.0;
            for (buf, pos, store) in combs.iter_mut() {
                let o = buf[*pos];
                *store = o * (1.0 - damp) + *store * damp;
                buf[*pos] = x + *store * feedback;
                *pos = (*pos + 1) % buf.len();
                y += o;
            }
            for (buf, pos) in alls.iter_mut() {
                let b = buf[*pos];
                buf[*pos] = y + b * 0.5;
                y = b - y;
                *pos = (*pos + 1) % buf.len();
            }
            out[ch][i] = y;
        }
    }
    out
}

/// Ping-pong delay of a dotted eighth with darkening repeats: the first echo lands left,
/// the next right, and so on.
fn delay(input: &[Vec<f32>; 2]) -> [Vec<f32>; 2] {
    let d = (BEAT * 0.75 * SR) as usize;
    let n = input[0].len();
    let mut line = [vec![0.0; n], vec![0.0; n]];
    let mut out = [vec![0.0; n], vec![0.0; n]];
    let (mut fl, mut fr) = (Svf::default(), Svf::default());
    for i in 0..n {
        let (dl, dr) = if i >= d { (line[0][i - d], line[1][i - d]) } else { (0.0, 0.0) };
        let (l, _, _) = fl.run(dr, 3000.0, 0.7);
        let (r, _, _) = fr.run(dl, 3000.0, 0.7);
        line[0][i] = (input[0][i] + input[1][i]) * 0.5 + l * 0.5;
        line[1][i] = r * 0.5;
        out[0][i] = dl;
        out[1][i] = dr;
    }
    out
}

// ---------------------------------------------------------------------------------------------
// The arrangement

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| "soundtrack.wav".into());
    let mut mix = Mix::new();
    let mut rng = Rng(0x5eed_1234);

    drone(&mut mix, &mut rng);
    wind(&mut mix, &mut rng);

    // Intro music box: a falling minor phrase in the dark.
    for (k, (beat, note)) in [(0.5, 74.0), (1.5, 77.0), (2.5, 81.0), (3.25, 76.0), (4.0, 74.0), (5.0, 73.0), (6.0, 74.0)]
        .into_iter()
        .enumerate()
    {
        bell(&mut mix, beat * BEAT, note, 0.5, if k % 2 == 0 { -0.4 } else { 0.4 });
    }
    swell(&mut mix, 4.0, 2.0, &[62.0, 69.0, 74.0], 1.0);
    riser(&mut mix, 4.0, 2.0, 0.6, &mut rng);

    // Hits on the big cuts.
    impact(&mut mix, 4.0, 1.0, &mut rng);
    impact(&mut mix, 32.0, 1.0, &mut rng);
    impact(&mut mix, 50.0, 1.15, &mut rng);
    for t in [8.0, 14.0, 22.0, 40.0] {
        stutter(&mut mix, t - BEAT, 1.0, &mut rng);
    }
    riser(&mut mix, 32.0, 6.0, 0.9, &mut rng);
    swell(&mut mix, 32.0, 4.0, &[57.0, 61.0, 64.0, 69.0], 1.2);
    riser(&mut mix, 50.0, 4.0, 0.5, &mut rng);

    // Pads, bass and arpeggio for every bar from the drop until the final hit.
    let mut bar_start = 4.0;
    while bar_start < 50.0 {
        let c = chord(bar_start);
        let breakdown = (46.0..50.0).contains(&bar_start);
        pad(&mut mix, bar_start, BAR, &CHORDS[c], if breakdown { 1.2 } else { 1.0 }, &mut rng);
        if !breakdown {
            // Long bass with a pulse on the and-of-two.
            bass(&mut mix, bar_start, 1.2, ROOTS[c], 1.0);
            bass(&mut mix, bar_start + 1.25, 0.6, ROOTS[c], 0.8);
            // 16th-note arpeggio walking up and down the chord, an octave above.
            let pattern = [0, 2, 3, 1, 2, 3, 0, 3];
            for s in 0..16 {
                let t = bar_start + s as f32 * BEAT / 4.0;
                let note = CHORDS[c][pattern[s % 8]] + 12.0 + if s % 8 == 7 { 12.0 } else { 0.0 };
                let accent = if s % 4 == 0 { 1.0 } else { 0.6 };
                pluck(&mut mix, t, note, accent * (0.5 + 0.5 * energy(t)), if s % 2 == 0 { -0.35 } else { 0.35 });
            }
        }
        if (22.0..46.0).contains(&bar_start) {
            let top = [CHORDS[c][2] + 12.0, CHORDS[c][3] + 12.0];
            choir(&mut mix, bar_start, BAR, &top, 0.6 + 0.4 * energy(bar_start), &mut rng);
        }
        bar_start += BAR;
    }
    // The breakdown and the outro: bells answer the opening phrase over the last chord.
    for (k, (t, note)) in [(46.0, 81.0), (46.75, 77.0), (47.5, 76.0), (48.25, 74.0), (49.0, 73.0), (50.0, 74.0), (51.5, 81.0), (53.0, 86.0)]
        .into_iter()
        .enumerate()
    {
        bell(&mut mix, t, note, 0.9, if k % 2 == 0 { 0.5 } else { -0.5 });
    }
    pad(&mut mix, 50.0, 3.5, &[50.0, 57.0, 62.0, 65.0], 1.3, &mut rng);
    choir(&mut mix, 50.0, 3.0, &[69.0, 74.0], 1.0, &mut rng);

    // Half-time drums: kick on one, snare on three, ghost kicks and offbeat hats.
    let mut t = 4.0;
    while t < 46.0 - 0.01 {
        let bar_pos = ((t - 4.0) / BAR).round() as usize;
        kick(&mut mix, t, 1.0);
        if bar_pos % 2 == 1 {
            kick(&mut mix, t + 1.375, 0.6);
        }
        if t >= 8.0 {
            kick(&mut mix, t + 0.75, 0.45);
        }
        if t >= 14.0 {
            snare(&mut mix, t + 1.0, 1.0, &mut rng);
        }
        if t >= 8.0 {
            for h in 0..8 {
                let open = h % 2 == 1;
                hat(&mut mix, t + h as f32 * BEAT / 2.0, if open { 1.0 } else { 0.45 }, if h % 4 < 2 { -0.3 } else { 0.3 }, &mut rng);
            }
        }
        if (30.0..32.0).contains(&t) {
            // Snare roll into the second drop.
            for r in 0..16 {
                snare(&mut mix, t + r as f32 * BEAT / 4.0, 0.25 + 0.75 * r as f32 / 16.0, &mut rng);
            }
        }
        t += BAR;
    }

    // Lead motif from 32 s: a slow, sighing line with delayed vibrato and portamento.
    let motif: [(f32, f32, f32); 12] = [
        (0.0, 69.0, 0.75), (0.75, 74.0, 0.75), (1.5, 77.0, 1.0), (2.5, 76.0, 0.5), (3.0, 74.0, 0.5), (3.5, 73.0, 1.0),
        (4.5, 74.0, 1.0), (5.5, 70.0, 0.5), (6.0, 69.0, 0.75), (6.75, 67.0, 0.75), (7.5, 69.0, 0.5), (8.0, 69.0, 0.0),
    ];
    for rep in 0..2 {
        let base = 32.0 + rep as f32 * 8.0;
        for w in 0..11 {
            let (b0, n0, d0) = motif[w];
            let n1 = motif[w + 1].1;
            let start = base + b0;
            let dur = d0 * 0.95;
            let mut phase = 0.0;
            let mut filter = Svf::default();
            for i in idx(start)..idx(start + dur + 0.6) {
                let t = i as f32 / SR - start;
                let glide = if t > dur - 0.08 { ((t - (dur - 0.08)) / 0.08).min(1.0) } else { 0.0 };
                let note = n0 + (n1 - n0) * glide * glide;
                let vib = 1.0 + 0.008 * (TAU * 5.5 * t).sin() * ((t - 0.2) / 0.4).clamp(0.0, 1.0);
                let inc = hz(note + if rep == 1 { 12.0 } else { 0.0 }) * vib / SR;
                phase = (phase + inc) % 1.0;
                let pulse = if phase < 0.35 + 0.1 * (TAU * 0.5 * t).sin() { 1.0 } else { -1.0 };
                let (lp, _, _) = filter.run(saw(phase, inc) * 0.7 + pulse * 0.3, 1600.0 + 900.0 * (-t * 3.0).exp(), 1.6);
                let env = ar(t, 0.04, dur, 0.25);
                put(&mut mix, Bus::Music, i, lp * env * 0.15, 0.1, 0.5, 0.35);
            }
        }
    }

    // Effects and the master bus.
    let wet = reverb(&mix.reverb);
    let echo = delay(&mix.delay);
    let n = mix.len();
    let mut kicks = mix.kicks.clone();
    kicks.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut out = [vec![0.0f32; n], vec![0.0f32; n]];
    let mut k = 0;
    let mut hp = [Svf::default(), Svf::default()];
    for i in 0..n {
        let t = i as f32 / SR;
        while k + 1 < kicks.len() && kicks[k + 1] <= t {
            k += 1;
        }
        // Sidechain: the music breathes around every kick.
        let since = if kicks.is_empty() || kicks[k] > t { 10.0 } else { t - kicks[k] };
        let duck = 1.0 - 0.55 * (-since / 0.16).exp();
        for ch in 0..2 {
            let music = mix.music[ch][i] + echo[ch][i] * 0.6;
            let x = mix.drums[ch][i] + (music + wet[ch][i] * 1.1) * duck;
            let (_, _, high) = hp[ch].run(x, 28.0, 0.7);
            out[ch][i] = high;
        }
    }
    // Gentle soft clip: scale the raw peak to 1.15 so only the loudest hits saturate, then
    // normalize to -1 dBFS with a short fade at both ends.
    let raw = out.iter().flat_map(|c| c.iter()).fold(0.0f32, |m, v| m.max(v.abs()));
    let drive = 1.15 / raw.max(1e-6);
    for ch in 0..2 {
        for v in out[ch].iter_mut() {
            *v = (*v * drive).tanh();
        }
    }
    let peak = out.iter().flat_map(|c| c.iter()).fold(0.0f32, |m, v| m.max(v.abs()));
    let gain = 0.89 / peak.max(1e-6);
    let mut bytes = Vec::with_capacity(n * 4 + 44);
    for i in 0..n {
        let t = i as f32 / SR;
        let fade = (t / 0.01).min(1.0) * ((LENGTH - t) / 0.5).clamp(0.0, 1.0);
        for ch in 0..2 {
            let s = (out[ch][i] * gain * fade).clamp(-1.0, 1.0);
            bytes.extend_from_slice(&((s * 32767.0) as i16).to_le_bytes());
        }
    }
    let mut file = std::fs::File::create(&path).expect("create wav");
    let data = bytes.len() as u32;
    let header = [
        b"RIFF".to_vec(),
        (36 + data).to_le_bytes().to_vec(),
        b"WAVEfmt ".to_vec(),
        16u32.to_le_bytes().to_vec(),
        1u16.to_le_bytes().to_vec(),
        2u16.to_le_bytes().to_vec(),
        (SR as u32).to_le_bytes().to_vec(),
        (SR as u32 * 4).to_le_bytes().to_vec(),
        4u16.to_le_bytes().to_vec(),
        16u16.to_le_bytes().to_vec(),
        b"data".to_vec(),
        data.to_le_bytes().to_vec(),
    ]
    .concat();
    file.write_all(&header).unwrap();
    file.write_all(&bytes).unwrap();
    eprintln!("wrote {path}: {LENGTH} s, peak before normalize {peak:.2}");
}
