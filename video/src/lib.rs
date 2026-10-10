//! "The Arrival": the Wraith launch video. 62.3 s at 1920×1080, 60 fps, cut to
//! *Architecting Tomorrow* (123 BPM). Every scene boundary sits on the track's beat grid.
//!
//! | scene     | music                 | what happens                                         |
//! | --------- | --------------------- | ---------------------------------------------------- |
//! | ColdOpen  | intro                 | one amber cursor; "every keystroke / frame / cell"   |
//! | Summon    | intro, rising         | ember cells assemble a ghostly wordmark; the headline |
//! | Arrival   | drums in              | the WRAITH wordmark slams together: "has arrived."   |
//! | Stack     | groove                | Ghostty's engine · Rust · WebAssembly · WebGPU       |
//! | Live      | groove                | the live dashboard, running in Wraith                |
//! | Break     | the break             | everything stops: "How fast?"                        |
//! | Race      | big drop              | CPU per update against xterm.js; 3.9×                |
//! | Facts     | drive                 | 20-byte cells · one row per edit · 0.6 ms redraw     |
//! | TwoWays   | drive                 | keep your xterm.js code, or go full Ghostty          |
//! | Finale    | outro                 | wraithterm.com                                       |
//!
//! Frames are pure functions of time: scenes read only constants and precomputed statics.
use fframes::{
    AudioMap, AudioTimestamp, AudioTrack, Color, Duration, FFramesContext,
    FFramesSyncedVideoFrame, Frame, Scene, Scenes, Shader, ShaderUniforms, Svgr,
    SyncVideoFrameInput, Video, include_media_dir, svgr,
};
use fframes::FontQuery;
use std::sync::{LazyLock, OnceLock};

include_media_dir!(pub struct LaunchMedia, "media");

pub const WIDTH: usize = 1920;
pub const HEIGHT: usize = 1080;
const W: f32 = WIDTH as f32;
const H: f32 = HEIGHT as f32;

// ---------------------------------------------------------------------------------------------
// The beat grid of the trimmed track (beat k at B0 + k · BEAT) and the cues built on it.

const BEAT: f32 = 0.487_62;
const B0: f32 = -0.2148;
const fn beat(k: f32) -> f32 {
    B0 + k * BEAT
}
/// The drums arrive on the first hit after the intro (measured onset, a hair after beat 32).
const DRUMS: f32 = 15.49;
const BREAK: f32 = beat(60.0);
const DROP: f32 = beat(64.0);
const END: f32 = 62.31;
/// Scene boundaries, in order: each scene runs from its cue to the next one.
const CUES: [f32; 11] = [
    0.0,
    beat(16.0),
    DRUMS,
    beat(40.0),
    beat(48.0),
    BREAK,
    DROP,
    beat(80.0),
    beat(92.0),
    beat(108.0),
    END,
];

// ---------------------------------------------------------------------------------------------
// Look: the warm ember palette of wraithterm.com.

/// Hits, numbers and big words.
const DISPLAY: &str = "Unbounded";
/// Headlines and labels: condensed, with character.
const HEAD: &str = "Bricolage Grotesque 96pt ExtraBold";
/// Everything terminal: typing, captions, code.
const MONO: &str = "Departure Mono";
/// Advance of Departure Mono, in ems.
const MONO_ADV: f32 = 0.636;
/// Counters and cell moments, drawn in dots.
const DOTS: &str = "Doto Black";
const GLITCH: &str = "Rubik Glitch";
const BG: &str = "#0c0806";
const INK: &str = "#f5ece3";
const DIM: &str = "#a6958a";
const FAINT: &str = "#6e5c50";
const AMBER: &str = "#ffb86b";
const GOLD: &str = "#ffd98a";
const CORAL: &str = "#ff7f6e";
const LILAC: &str = "#d9bbff";

// ---------------------------------------------------------------------------------------------
// Motion helpers. Every one is a pure function of seconds.

fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}
/// Progress through `[start, start + dur]`.
fn span(t: f32, start: f32, dur: f32) -> f32 {
    clamp01((t - start) / dur)
}
/// Fast, then settles: the expo ease-out from the fframes design guide.
fn expo(x: f32) -> f32 {
    if x >= 1.0 { 1.0 } else { 1.0 - 2f32.powf(-10.0 * x) }
}
/// A damped spring from 0 to 1 that overshoots a little and settles (stiffness ~180, damping ~16).
fn spring(t: f32) -> f32 {
    if t <= 0.0 {
        return 0.0;
    }
    1.0 - (-t * 9.0).exp() * (t * 17.0).cos()
}
fn hash(a: u32, b: u32) -> f32 {
    let mut h = a.wrapping_mul(0x9e37_79b9) ^ b.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2c1b_3c6d);
    h ^= h >> 12;
    (h & 0xffff) as f32 / 65535.0
}
fn rgb(r: f32, g: f32, b: f32) -> String {
    format!("rgb({},{},{})", r.clamp(0.0, 255.0) as u8, g.clamp(0.0, 255.0) as u8, b.clamp(0.0, 255.0) as u8)
}
/// Number of characters of `text` typed after `t` seconds at `cps` characters per second.
fn typed(text: &str, t: f32, cps: f32) -> String {
    let n = (t * cps).max(0.0) as usize;
    text.chars().take(n).collect()
}

/// Section energy that drives the fog, mirroring the music.
fn energy(t: f32) -> f32 {
    match t {
        t if t < CUES[1] => 0.12,
        t if t < DRUMS => 0.12 + 0.5 * span(t, CUES[1], DRUMS - CUES[1]).powi(2),
        t if t < BREAK => 0.75,
        t if t < DROP => 0.05,
        t if t < CUES[9] => 1.0,
        _ => 0.7 * (1.0 - span(t, END - 4.0, 4.0)) + 0.1,
    }
}
/// White flash on the two drops and a smaller one on every cut.
fn flash(t: f32) -> f32 {
    let mut f: f32 = 0.0;
    for &c in &CUES[1..10] {
        if t >= c {
            let big = c == DRUMS || c == DROP;
            f = f.max((-(t - c) * if big { 6.0 } else { 16.0 }).exp() * if big { 0.9 } else { 0.18 });
        }
    }
    f
}
/// Glitch strength: a short burst after every cut.
fn glitch(t: f32) -> f32 {
    let mut g: f32 = 0.0;
    for &c in CUES[1..10].iter().chain(OPEN_CUTS.iter()) {
        if t >= c {
            g = g.max(1.0 - span(t, c, 0.22));
        }
    }
    g
}
/// Camera shake: hard on the drops, a tap on every kick after the drums arrive.
fn shake(t: f32) -> (f32, f32) {
    let mut amount: f32 = 0.0;
    for c in [DRUMS, DROP] {
        if t >= c {
            amount = amount.max(26.0 * (-(t - c) * 5.0).exp());
        }
    }
    if (DRUMS..BREAK).contains(&t) || (DROP..CUES[9]).contains(&t) {
        let since = (t - B0).rem_euclid(BEAT);
        amount = amount.max(3.0 * (-since * 20.0).exp());
    }
    let f = (t * 60.0) as u32;
    ((hash(f, 1) - 0.5) * 2.0 * amount, (hash(f, 2) - 0.5) * 2.0 * amount)
}

// ---------------------------------------------------------------------------------------------
// The background: warm, domain-warped fog with scanlines and grain, on the GPU.

const FOG: &str = r#"
uniform float3 iResolution;
uniform float iTime;
uniform float uEnergy;
uniform float uFlash;

float hash(float2 p) { return fract(sin(dot(p, float2(127.1, 311.7))) * 43758.5453); }
float noise(float2 p) {
    float2 i = floor(p);
    float2 f = fract(p);
    float2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + float2(1.0, 0.0)), u.x),
               mix(hash(i + float2(0.0, 1.0)), hash(i + float2(1.0, 1.0)), u.x), u.y);
}
float fbm(float2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
        v += a * noise(p);
        p = p * 2.03 + float2(1.7, 9.2);
        a *= 0.5;
    }
    return v;
}
half4 main(float2 coord) {
    float2 p = (coord - 0.5 * iResolution.xy) / iResolution.y;
    float t = iTime * 0.08;
    float2 q = float2(fbm(p * 1.8 + float2(0.0, t)), fbm(p * 1.8 + float2(5.2, -t)));
    float2 r = float2(fbm(p * 2.2 + 4.0 * q + float2(1.7, 9.2) + t * 1.4),
                      fbm(p * 2.2 + 4.0 * q + float2(8.3, 2.8) - t));
    float f = fbm(p * 1.6 + 3.0 * r);
    float3 col = float3(0.047, 0.031, 0.024);
    col = mix(col, float3(0.36, 0.12, 0.06), smoothstep(0.42, 0.95, f) * (0.15 + 0.85 * uEnergy));
    col = mix(col, float3(0.85, 0.42, 0.16), smoothstep(0.62, 1.0, r.x * f * 1.35) * 0.45 * uEnergy);
    col = mix(col, float3(0.45, 0.30, 0.55), smoothstep(0.7, 1.0, q.y * f * 1.4) * 0.18 * uEnergy);
    col += float3(0.55, 0.22, 0.08) * exp(-2.4 * length(p)) * 0.18 * (0.2 + uEnergy);
    col *= 0.92 + 0.08 * sin(coord.y * 1.5708);
    col += (hash(coord * 0.71 + fract(iTime) * 97.0) - 0.5) * 0.035;
    col *= smoothstep(1.35, 0.25, length(p * float2(0.8, 1.0)));
    col += uFlash * float3(1.0, 0.86, 0.68);
    return half4(half3(col), 1.0);
}
"#;

// ---------------------------------------------------------------------------------------------
// The wordmark as a grid of glowing terminal cells.

struct Pixel {
    x: f32,
    y: f32,
    alpha: f32,
    seed: u32,
}
const WORDMARK: &str = include_str!("wordmark.txt");
const MARK_COLS: f32 = 104.0;
static PIXELS: LazyLock<Vec<Pixel>> = LazyLock::new(|| {
    let ramp = "_.:-=+*#%@";
    let mut pixels = Vec::new();
    for (row, line) in WORDMARK.lines().enumerate() {
        for (col, ch) in line.chars().enumerate() {
            let level = ramp.find(ch).unwrap_or(0);
            if level >= 3 {
                pixels.push(Pixel { x: col as f32, y: row as f32, alpha: level as f32 / 9.0, seed: (row * 131 + col) as u32 });
            }
        }
    }
    pixels
});

/// The wordmark centered at (cx, cy). `since` is the time since the cells began flying in.
fn wordmark<'a>(t: f32, since: f32, cx: f32, cy: f32, cell: f32, glow: f32, g: f32) -> Svgr<'a> {
    let rows = WORDMARK.lines().count() as f32;
    let (ox, oy) = (cx - MARK_COLS * cell / 2.0, cy - rows * cell / 2.0);
    let slice = (t * 14.0) as u32;
    let passes: &[(f32, &str, f32)] = if g > 0.05 {
        &[(-12.0 * g, "#ff5a3c", 0.5), (12.0 * g, "#ffd27a", 0.5), (0.0, "", 1.0)]
    } else {
        &[(0.0, "", 1.0)]
    };
    let mut layers: Vec<Svgr<'a>> = Vec::new();
    for &(dx, tint, opacity) in passes {
        let mut rects: Vec<Svgr<'a>> = Vec::with_capacity(PIXELS.len());
        for p in PIXELS.iter() {
            let delay = (p.x / MARK_COLS) * 0.35 + hash(p.seed, 7) * 0.25;
            let k = expo(span(since, delay, 0.55));
            if k <= 0.0 {
                continue;
            }
            let angle = hash(p.seed, 1) * std::f32::consts::TAU;
            let dist = 900.0 + hash(p.seed, 2) * 900.0;
            let mut x = ox + p.x * cell + angle.cos() * dist * (1.0 - k);
            let y = oy + p.y * cell + angle.sin() * dist * (1.0 - k);
            if g > 0.0 && hash(p.y as u32, slice) < 0.25 * g {
                x += (hash(p.y as u32, slice + 99) - 0.5) * 180.0 * g;
            }
            x += dx;
            let shimmer = 0.7 + 0.3 * (p.y * 0.8 - t * 6.0 + p.x * 0.05).sin();
            let fill = if tint.is_empty() {
                let k2 = shimmer * (0.7 + 0.3 * glow);
                rgb(200.0 + 55.0 * k2, 120.0 + 115.0 * k2, 60.0 + 150.0 * k2)
            } else {
                tint.to_string()
            };
            let size = cell * 0.84;
            rects.push(svgr!(<rect x={x} y={y} width={size} height={size} rx={cell * 0.16} fill={fill} opacity={p.alpha * k * opacity} />));
        }
        layers.push(rects.into_iter().collect());
    }
    let halo = 0.4 * glow * clamp01(since * 2.0);
    svgr!(
        <g>
            <ellipse cx={cx} cy={cy} rx={MARK_COLS * cell * 0.62} ry={rows * cell * 1.15} fill="url(#halo)" opacity={halo} />
            {layers}
        </g>
    )
}

/// A rounded chip with a mono label.
fn chip<'a>(x: f32, y: f32, label: &'a str, k: f32, accent: &'a str) -> Svgr<'a> {
    let width = label.chars().count() as f32 * 30.0 * MONO_ADV + 56.0;
    let s = 0.85 + 0.15 * spring(k);
    svgr!(
        <g opacity={clamp01(k * 4.0)} transform={format!("translate({x} {y}) scale({s})")}>
            <rect x="0" y="-40" width={width} height="60" rx="30" fill="#140d0a" opacity="0.94" stroke={accent} stroke-opacity="0.6" />
            <text x="28" y="0" font-family={MONO} font-size="30" fill={accent}>{label}</text>
        </g>
    )
}

// ---------------------------------------------------------------------------------------------
// Scenes. One struct, addressed by name in the CLI (`ColdOpen@2s`, `Race@50%`).

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    ColdOpen,
    Summon,
    Arrival,
    Stack,
    Live,
    Break,
    Race,
    Facts,
    TwoWays,
    Finale,
}
const KINDS: [Kind; 10] = [
    Kind::ColdOpen,
    Kind::Summon,
    Kind::Arrival,
    Kind::Stack,
    Kind::Live,
    Kind::Break,
    Kind::Race,
    Kind::Facts,
    Kind::TwoWays,
    Kind::Finale,
];

#[derive(Debug)]
pub struct Shot {
    kind: Kind,
    start: f32,
    end: f32,
}

impl Scene for Shot {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(self.end - self.start)
    }
    fn name(&self) -> &'static str {
        match self.kind {
            Kind::ColdOpen => "ColdOpen",
            Kind::Summon => "Summon",
            Kind::Arrival => "Arrival",
            Kind::Stack => "Stack",
            Kind::Live => "Live",
            Kind::Break => "Break",
            Kind::Race => "Race",
            Kind::Facts => "Facts",
            Kind::TwoWays => "TwoWays",
            Kind::Finale => "Finale",
        }
    }
    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        // `t` is seconds into the scene; `g` is seconds into the video.
        let t = frame.seconds();
        let g = self.start + t;
        match self.kind {
            Kind::ColdOpen => cold_open(&frame, ctx, t),
            Kind::Summon => summon(&mut frame.clone(), ctx, t, self.end - self.start),
            Kind::Arrival => arrival(t, g),
            Kind::Stack => stack(t),
            Kind::Live => live(&frame, ctx, t),
            Kind::Break => break_(t),
            Kind::Race => race(t),
            Kind::Facts => facts(t, g),
            Kind::TwoWays => two_ways(t),
            Kind::Finale => finale(t, g),
        }
    }
}

/// The cold open: three terminals running the same live dashboard, one after another, each
/// with its CPU cost per update from the benchmark. Cuts land on beats 5 and 10.
const OPEN_CUTS: [f32; 2] = [beat(5.0), beat(10.0)];

fn cold_open<'a>(frame: &Frame, ctx: &FFramesContext<'a, '_>, t: f32) -> Svgr<'a> {
    let segments: [(f32, &str, &str, &str, f32, &str); 3] = [
        (0.0, "xterm.js · DOM renderer", "This is a terminal on the web.", "dom.mp4", 37.7, CORAL),
        (OPEN_CUTS[0], "xterm.js · WebGL addon", "Better.", "webgl.mp4", 9.8, AMBER),
        (OPEN_CUTS[1], "Wraith", "This is… something else.", "wraith.mp4", 2.5, GOLD),
    ];
    let i = if t < OPEN_CUTS[0] { 0 } else if t < OPEN_CUTS[1] { 1 } else { 2 };
    let (at, label, caption, file, ms, color) = segments[i];
    let local = t - at;
    // The counter rolls down from the previous renderer's cost.
    let from = if i == 0 { ms } else { segments[i - 1].4 };
    let shown_ms = from + (ms - from) * expo(span(local, 0.0, 0.7));
    let input = SyncVideoFrameInput { start_from: at, looping: true, editor_fallback_image: None };
    // Sized to sit inside the letterbox with the caption below it.
    let (w, h) = (1240.0, 1240.0 * 9.0 / 16.0);
    let (x, y) = (W / 2.0 - w / 2.0, 150.0);
    let picture = match frame.get_synced_video_frame(ctx, file, &input) {
        Some(video) => {
            let image = video.into_image();
            svgr!(<image href={image.href()} x={x} y={y} width={w} height={h} preserveAspectRatio="none" />)
        }
        None => svgr!(<rect x={x} y={y} width={w} height={h} fill="#140d0a" />),
    };
    let appear = 1.0;
    let cap = expo(span(local, 0.15, 0.5));
    let dim = if i == 2 { 0.0 } else { 0.25 };
    svgr!(
        <g opacity={appear}>
            <rect x={x - 3.0} y={y - 3.0} width={w + 6.0} height={h + 6.0} rx="14" fill={color} opacity="0.35" />
            {picture}
            <rect x={x} y={y} width={w} height={h} fill="#000" opacity={dim} />
            <rect x={x + 24.0} y={y + 24.0} width={label.chars().count() as f32 * 30.0 * MONO_ADV + 44.0} height="52" rx="10" fill="#0c0806" opacity="0.88" />
            <text x={x + 46.0} y={y + 60.0} font-family={MONO} font-size="30" fill={color}>{label}</text>
            <g transform={format!("translate({} {})", x + w - 40.0, y + h - 60.0)}>
                <rect x="-470" y="-150" width="490" height="190" rx="18" fill="#0c0806" opacity="0.9" stroke={color} stroke-opacity="0.6" />
                <text x="0" y="-26" font-family={DISPLAY} font-weight="900" font-size="104" fill={color} text-anchor="end" letter-spacing="-3">{format!("{shown_ms:.1} ms")}</text>
                <text x="0" y="20" font-family={MONO} font-size="28" fill={DIM} text-anchor="end">"CPU per update"</text>
            </g>
            <g opacity={clamp01(cap * 2.0)} transform={format!("translate(0 {})", 24.0 * (1.0 - cap))}>
                <text x={W / 2.0} y="912" font-family={HEAD} font-weight="800" font-size="56" fill={INK} text-anchor="middle">{caption}</text>
            </g>
            <text x={W / 2.0} y="940" font-family={MONO} font-size="20" fill={FAINT} text-anchor="middle">"cost per update: dense 240×80 benchmark, Chrome 155, Apple M5 Max"</text>
        </g>
    )
}

/// Measured advance of each headline word plus a space, at 104 px Inter Black, memoized.
static HEADLINE_WIDTHS: OnceLock<Vec<f32>> = OnceLock::new();
const HEADLINE: [&str; 8] = ["The", "terminal", "the", "web", "has", "been", "waiting", "for…"];

fn summon<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, t: f32, length: f32) -> Svgr<'a> {
    let font = FontQuery { family: HEAD, size: 112, weight: 800, ..Default::default() };
    let widths = match HEADLINE_WIDTHS.get() {
        Some(w) => w.clone(),
        None => {
            let space = frame.text_width(ctx, font, "a b").zip(frame.text_width(ctx, font, "ab")).map(|(a, b)| (a - b) as f32);
            let measured: Option<Vec<f32>> = HEADLINE
                .iter()
                .map(|w| frame.text_width(ctx, font, w).zip(space).map(|(x, sp)| x as f32 + sp - 2.0 * (w.chars().count() as f32 - 1.0)))
                .collect();
            match measured {
                Some(m) => HEADLINE_WIDTHS.get_or_init(|| m).clone(),
                None => HEADLINE.iter().map(|w| w.chars().count() as f32 * 60.0 + 30.0).collect(),
            }
        }
    };
    let mut out: Vec<Svgr<'a>> = Vec::new();
    // Ember cells drift in and slowly assemble a ghostly wordmark; it flickers while the
    // intro builds and dims under the headline. On the drums it slams to full brightness.
    let ghost = (0.18 + 0.4 * span(t, 0.0, 4.5)) * (1.0 - 0.6 * span(t, 5.2, 0.6));
    let flicker = if hash((t * 24.0) as u32, 3) < 0.12 { 0.55 } else { 1.0 };
    let mark = wordmark(t + 7.6, (t * 0.16).min(1.2), W / 2.0, H / 2.0 - 70.0, 15.0, 0.5, 0.0);
    out.push(svgr!(<g opacity={ghost * flicker}>{mark}</g>));
    // 5.4 s on: the headline, word by word, then a hard cut to black half a beat before the drums.
    let x_cursor = |range: std::ops::Range<usize>, y: f32, start: f32| -> Vec<Svgr<'a>> {
        let size = 112.0;
        let line = &HEADLINE[range.clone()];
        let widths = &widths[range];
        let total: f32 = widths.iter().sum();
        let mut x = W / 2.0 - total / 2.0;
        let mut v = Vec::new();
        for (i, w) in line.iter().enumerate() {
            let k = span(t, start + i as f32 * 0.09, 0.5);
            v.push(svgr!(
                <text x={x} y={y + 50.0 * (1.0 - expo(k))} font-family={HEAD} font-weight="800" font-size={size} fill={INK} opacity={clamp01(k * 3.0)} letter-spacing="-2">{*w}</text>
            ));
            x += widths[i];
        }
        v
    };
    let mut headline = x_cursor(0..4, H / 2.0 - 10.0, 5.5);
    headline.extend(x_cursor(4..8, H / 2.0 + 110.0, 5.86));
    let blackout = if t >= length - BEAT * 0.5 { 1.0 } else { 0.0 };
    out.push(svgr!(<g>{headline}</g>));
    out.push(svgr!(<rect width={W} height={H} fill="#000" opacity={blackout} />));
    out.into_iter().collect()
}

fn arrival<'a>(t: f32, g: f32) -> Svgr<'a> {
    let punch = 1.0 + 0.22 * (1.0 - spring(t).min(1.15));
    let mark = wordmark(g, 10.0, W / 2.0, H / 2.0 - 70.0, 15.0, 1.0, glitch(g));
    let mark = svgr!(<g transform={format!("translate({} {}) scale({punch}) translate({} {})", W / 2.0, H / 2.0 - 70.0, -W / 2.0, -(H / 2.0 - 70.0))}>{mark}</g>);
    let ring = span(t, 0.0, 1.1);
    let tag = span(t, 0.45, 0.6);
    let kicker = span(t, 1.2, 0.5);
    svgr!(
        <g>
            <circle cx={W / 2.0} cy={H / 2.0 - 70.0} r={40.0 + 1300.0 * expo(ring)} fill="none" stroke={AMBER} stroke-width={14.0 * (1.0 - ring) + 0.5} opacity={1.0 - ring} />
            {mark}
            <text x={W / 2.0} y={H / 2.0 + 250.0 + 40.0 * (1.0 - expo(tag))} font-family={DISPLAY} font-weight="900" font-size="104" text-anchor="middle" fill="url(#spectral)" opacity={clamp01(tag * 3.0)} letter-spacing="-3">"has arrived."</text>
            <text x={W / 2.0} y={H / 2.0 + 330.0} font-family={MONO} font-size="30" text-anchor="middle" fill={DIM} opacity={kicker} letter-spacing="6">"OPEN SOURCE  ·  MIT  ·  WRAITHTERM.COM"</text>
        </g>
    )
}

fn stack<'a>(t: f32) -> Svgr<'a> {
    let items: [(&str, &str, &str); 4] = [
        ("Ghostty's engine", "libghostty-vt, compiled from Zig", AMBER),
        ("Rust", "shaping, glyph atlas, wgpu", CORAL),
        ("WebAssembly", "one module, one allocator", LILAC),
        ("WebGPU", "instanced draws in WGSL", GOLD),
    ];
    let mut out: Vec<Svgr<'a>> = Vec::new();
    for (i, (word, note, color)) in items.into_iter().enumerate() {
        let at = i as f32 * BEAT * 2.0;
        let k = span(t, at, 0.5);
        if k <= 0.0 {
            continue;
        }
        let s = 1.0 + 0.35 * (1.0 - spring(t - at).min(1.2));
        let y = 280.0 + i as f32 * 190.0;
        let x = W * 0.1;
        out.push(svgr!(
            <g opacity={clamp01(k * 4.0)} transform={format!("translate({x} {y}) scale({s})")}>
                <text x="0" y="0" font-family={DISPLAY} font-weight="900" font-size="104" fill={INK} letter-spacing="-3">{word}</text>
                <text x="8" y="56" font-family={MONO} font-size="32" fill={color}>{note}</text>
            </g>
        ));
    }
    let tail = span(t, BEAT * 7.0, 0.4);
    out.push(svgr!(
        <g opacity={tail} transform={format!("translate(0 {})", 20.0 * (1.0 - expo(tail)))}>
            <text x={W * 0.9} y="1000" font-family={MONO} font-size="34" fill={AMBER} text-anchor="end">"→ one module, in a worker"</text>
        </g>
    ));
    out.into_iter().collect()
}

fn live<'a>(frame: &Frame, ctx: &FFramesContext<'a, '_>, t: f32) -> Svgr<'a> {
    let k = expo(span(t, 0.0, 0.9));
    let drift = span(t, 0.0, 6.0);
    let w = 1250.0 + 300.0 * k + 40.0 * drift;
    let h = w * 9.0 / 16.0;
    let bar = 46.0;
    let (x, y) = (W / 2.0 - w / 2.0, 150.0 + 200.0 * (1.0 - k) - 10.0 * drift);
    let rotate = -4.0 * (1.0 - k);
    let input = SyncVideoFrameInput { start_from: 0.0, looping: true, editor_fallback_image: None };
    let picture = match frame.get_synced_video_frame(ctx, "dashboard.mp4", &input) {
        Some(video) => {
            let image = video.into_image();
            svgr!(<image href={image.href()} x={x} y={y + bar} width={w} height={h} preserveAspectRatio="none" />)
        }
        None => svgr!(<rect x={x} y={y + bar} width={w} height={h} fill="#140d0a" />),
    };
    let title = span(t, 0.1, 0.5);
    let chips = [
        (BEAT * 2.0, "a real terminal, live", 120.0, 330.0, AMBER),
        (BEAT * 4.0, "libghostty-vt in a worker", 1080.0, 1010.0, LILAC),
        (BEAT * 6.0, "full-screen updates on WebGPU", 980.0, 330.0, GOLD),
    ];
    let mut chip_layers: Vec<Svgr<'a>> = Vec::new();
    for (at, label, cx, cy, accent) in chips {
        let kk = span(t, at, 0.5);
        if kk > 0.0 {
            chip_layers.push(chip(cx, cy, label, kk, accent));
        }
    }
    svgr!(
        <g>
            <text x={W / 2.0} y="100" font-family={HEAD} font-weight="800" font-size="76" text-anchor="middle" fill={INK} opacity={title} letter-spacing="-1">"This is Wraith. Running live."</text>
            <g transform={format!("rotate({rotate} {} {})", W / 2.0, H / 2.0)}>
                <rect x={x - 3.0} y={y - 3.0} width={w + 6.0} height={h + bar + 6.0} rx="20" fill={AMBER} opacity="0.22" />
                <rect x={x} y={y} width={w} height={h + bar} rx="18" fill="#140d0a" />
                <circle cx={x + 28.0} cy={y + 23.0} r="7" fill="#ff6b5b" />
                <circle cx={x + 52.0} cy={y + 23.0} r="7" fill="#ffd166" />
                <circle cx={x + 76.0} cy={y + 23.0} r="7" fill="#b5d99c" />
                <text x={x + w / 2.0} y={y + 31.0} font-family={MONO} font-size="20" fill={DIM} text-anchor="middle">"wraith · 202×55 · libghostty-vt · WebGPU"</text>
                {picture}
            </g>
            {chip_layers}
        </g>
    )
}

/// "How fast?" cycles through faces at 30 per second, then locks onto the glitch face.
const FLICKER: [(&str, &str, f32); 9] = [
    (DISPLAY, "900", 150.0),
    ("Big Shoulders Display Thin", "900", 210.0),
    (DOTS, "900", 190.0),
    ("Syne", "800", 170.0),
    (MONO, "400", 170.0),
    ("Anton", "400", 210.0),
    (HEAD, "800", 200.0),
    ("Major Mono Display", "400", 130.0),
    (GLITCH, "400", 190.0),
];

fn break_<'a>(t: f32) -> Svgr<'a> {
    let lock = 1.15;
    let (family, weight, size, fill) = if t < lock {
        let k = (t * 30.0) as usize;
        let (f, wgt, sz) = FLICKER[k % (FLICKER.len() - 1)];
        (f, wgt, sz, [INK, AMBER, CORAL, GOLD][k % 4])
    } else {
        (GLITCH, "400", 200.0, INK)
    };
    let zoom = 1.0 + 0.05 * span(t, lock, 0.8) + if t >= lock { 0.08 * (1.0 - expo(span(t, lock, 0.25))) } else { 0.0 };
    let jx = if t < lock { (hash((t * 60.0) as u32, 5) - 0.5) * 30.0 } else { 0.0 };
    svgr!(
        <g>
            <rect width={W} height={H} fill="#000" opacity="0.55" />
            <g transform={format!("translate({} {}) scale({zoom})", W / 2.0 + jx, H / 2.0 + 60.0)}>
                <text x="0" y="0" font-family={family} font-weight={weight} font-size={size} text-anchor="middle" fill={fill}>"How fast?"</text>
            </g>
        </g>
    )
}

fn race<'a>(t: f32) -> Svgr<'a> {
    let lanes: [(&str, &str, f32, bool); 3] = [
        ("xterm.js", "DOM renderer", 37.7, false),
        ("xterm.js", "+ WebGL addon", 9.8, false),
        ("Wraith", "xterm-compatible", 2.5, true),
    ];
    let verdict_at = beat(70.0) - DROP;
    let verdict = span(t, verdict_at, 0.35);
    let dim = 1.0 - 0.82 * verdict;
    let mut out: Vec<Svgr<'a>> = Vec::new();
    let head = expo(span(t, 0.0, 0.5));
    out.push(svgr!(
        <g opacity={head * dim}>
            <text x={W * 0.1} y="210" font-family={HEAD} font-weight="800" font-size="96" fill={INK} letter-spacing="-2">"CPU per full-screen update"</text>
            <text x={W * 0.1 + 4.0} y="268" font-family={MONO} font-size="30" fill={DIM}>"240×80 cells · ~4,800 style changes · lower is better"</text>
        </g>
    ));
    for (i, (who, what, ms, ours)) in lanes.into_iter().enumerate() {
        let at = 0.35 + i as f32 * BEAT;
        let k = expo(span(t, at, 1.4));
        let y = 380.0 + i as f32 * 170.0;
        let full = 1050.0 * ms / 37.7;
        let w = (full * k).max(1.0);
        let fill = if ours { "url(#spectral)" } else { "#3a2c24" };
        let color = if ours { AMBER } else { INK };
        out.push(svgr!(
            <g opacity={span(t, at - 0.1, 0.2) * dim}>
                <text x={W * 0.1} y={y + 48.0} font-family={HEAD} font-weight="800" font-size="56" fill={INK}>{who}</text>
                <text x={W * 0.1 + 2.0} y={y + 92.0} font-family={MONO} font-size="28" fill={FAINT}>{what}</text>
                <rect x="620" y={y} width="1110" height="84" rx="12" fill="#140d0a" />
                <rect x="620" y={y} width={w} height="84" rx="12" fill={fill} />
                <text x={644.0 + w} y={y + 60.0} font-family={DISPLAY} font-weight="900" font-size="44" fill={color}>{format!("{:.1} ms", ms * k)}</text>
            </g>
        ));
    }
    // Two slams: against xterm.js DOM, then against xterm.js + WebGL.
    let second_at = beat(74.0) - DROP;
    for (k, (at, value, versus, cx)) in [(verdict_at, "15×", "less CPU than xterm.js DOM", W * 0.3), (second_at, "3.9×", "less than xterm.js + WebGL", W * 0.7)].into_iter().enumerate() {
        let v = span(t, at, 0.3);
        if v <= 0.0 {
            continue;
        }
        let big = spring(t - at);
        let fill = if k == 0 { "url(#spectral)" } else { INK };
        out.push(svgr!(
            <g opacity={clamp01(v * 3.0)} transform={format!("translate({cx} 600) scale({})", 0.7 + 0.3 * big)}>
                <text x="0" y="0" font-family={DISPLAY} font-weight="900" font-size="230" text-anchor="middle" fill={fill} letter-spacing="-8">{value}</text>
                <text x="0" y="96" font-family={HEAD} font-weight="800" font-size="48" text-anchor="middle" fill={INK}>{versus}</text>
            </g>
        ));
    }
    // Performance work is ongoing: say so right under the numbers.
    let climb_at = beat(76.0) - DROP;
    let climb = span(t, climb_at, 0.5);
    if climb > 0.0 {
        let draw = expo(span(t, climb_at + 0.15, 0.7));
        let len = 360.0;
        out.push(svgr!(
            <g opacity={clamp01(climb * 2.0)} transform={format!("translate(0 {})", 24.0 * (1.0 - expo(climb)))}>
                <text x={W / 2.0 - 120.0} y="860" font-family={HEAD} font-weight="800" font-size="60" fill={INK} text-anchor="middle">"And we're still climbing."</text>
                <polyline points="1290,872 1352,850 1404,858 1468,816 1530,826 1600,776" fill="none" stroke={AMBER} stroke-width="8" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray={len} stroke-dashoffset={len * (1.0 - draw)} />
                <polyline points="1572,772 1600,776 1594,804" fill="none" stroke={AMBER} stroke-width="8" stroke-linecap="round" stroke-linejoin="round" opacity={span(t, climb_at + 0.75, 0.15)} />
            </g>
        ));
    }
    out.push(svgr!(
        <text x={W / 2.0} y="1030" font-family={MONO} font-size="28" text-anchor="middle" fill={FAINT} opacity={head}>"Medians of interleaved runs · Chrome 155 · Apple M5 Max · GPU-completed updates"</text>
    ));
    out.into_iter().collect()
}

fn facts<'a>(t: f32, g: f32) -> Svgr<'a> {
    let slot = BEAT * 4.0;
    let i = ((t / slot) as usize).min(2);
    let local = t - i as f32 * slot;
    let k = expo(span(local, 0.0, 0.45));
    let out_k = span(local, slot - 0.22, 0.22);
    let o = clamp01(k * 3.0) * (1.0 - out_k);
    let s = 1.18 - 0.18 * spring(local).min(1.1);
    let (big, small, color) = [
        ("20 bytes", "per GPU cell", AMBER),
        ("1 row", "uploaded for a one-cell edit", GOLD),
        ("0.6 ms", "to redraw a full 240×80 screen", CORAL),
    ][i];
    let graphic: Svgr<'a> = match i {
        0 => {
            let colors = [AMBER, CORAL, LILAC, GOLD, "#f2e6da"];
            let segs: Vec<Svgr<'a>> = (0..5)
                .map(|n| {
                    let kk = span(local, 0.25 + n as f32 * 0.07, 0.3);
                    svgr!(<rect x={-500.0 + n as f32 * 200.0 + 6.0} y="150" width="188" height="44" rx="8" fill={colors[n]} opacity={kk} />)
                })
                .collect();
            segs.into_iter().collect()
        }
        1 => {
            let rows: Vec<Svgr<'a>> = (0..7)
                .map(|r| {
                    let lit = r == 3;
                    let kk = if lit { span(local, 0.35, 0.25) } else { 0.0 };
                    let fill = if lit && kk > 0.0 { GOLD } else { "#2a1e17" };
                    svgr!(<rect x="-460" y={130.0 + r as f32 * 22.0} width="920" height="16" rx="4" fill={fill} opacity={0.5 + 0.5 * kk} />)
                })
                .collect();
            rows.into_iter().collect()
        }
        _ => {
            let sweep = expo(span(local, 0.2, 0.8));
            let r = 70.0;
            let circumference = std::f32::consts::TAU * r;
            svgr!(
                <g transform="translate(0 210)">
                    <circle cx="0" cy="0" r={r} fill="none" stroke="#2a1e17" stroke-width="14" />
                    <circle cx="0" cy="0" r={r} fill="none" stroke={CORAL} stroke-width="14" stroke-linecap="round" stroke-dasharray={circumference} stroke-dashoffset={circumference * (1.0 - 0.072 * sweep)} transform="rotate(-90)" />
                    <text x="110" y="12" font-family={MONO} font-size="30" fill={DIM} opacity={sweep}>"7% of one 120 Hz frame"</text>
                </g>
            )
        }
    };
    let gl = glitch(g).max(1.0 - span(local, 0.0, 0.16));
    let jitter = (hash((g * 60.0) as u32, 11) - 0.5) * 50.0 * gl;
    svgr!(
        <g>
            <text x={W * 0.1} y="150" font-family={MONO} font-size="30" fill={FAINT} letter-spacing="4">{format!("0{} / 03", i + 1)}</text>
            <g opacity={o} transform={format!("translate({} 470) scale({s})", W / 2.0 + jitter)}>
                <text x={-10.0 * gl} y="0" font-family={DISPLAY} font-weight="900" font-size="190" text-anchor="middle" fill="#ff5a3c" opacity={0.55 * gl} letter-spacing="-9">{big}</text>
                <text x={10.0 * gl} y="0" font-family={DISPLAY} font-weight="900" font-size="190" text-anchor="middle" fill="#ffd27a" opacity={0.55 * gl} letter-spacing="-9">{big}</text>
                <text x="0" y="0" font-family={DISPLAY} font-weight="900" font-size="190" text-anchor="middle" fill={INK} letter-spacing="-9">{big}</text>
                <text x="0" y="96" font-family={MONO} font-size="48" text-anchor="middle" fill={color}>{small}</text>
                {graphic}
            </g>
        </g>
    )
}

/// One syntax-highlighted code card, typed out over time.
fn code_card<'a>(t: f32, x: f32, y: f32, title: &'a str, tag: &'a str, lines: &[&[(&'a str, &'a str)]], accent: &'a str) -> Svgr<'a> {
    let card = expo(span(t, 0.0, 0.6));
    let total: usize = lines.iter().map(|l| l.iter().map(|(s, _)| s.chars().count()).sum::<usize>() + 1).sum();
    let mut budget = (span(t, 0.5, 2.6) * total as f32) as usize;
    let mut code: Vec<Svgr<'a>> = Vec::new();
    for (row, runs) in lines.iter().enumerate() {
        let mut cx = x + 40.0;
        for &(text, color) in runs.iter() {
            let n = text.chars().count().min(budget);
            budget -= n;
            if n > 0 {
                let shown: String = text.chars().take(n).collect();
                code.push(svgr!(<text x={cx} y={y + 150.0 + row as f32 * 54.0} font-family={MONO} font-size="32" fill={color} style="white-space:pre">{shown}</text>));
            }
            cx += text.chars().count() as f32 * 32.0 * MONO_ADV;
        }
        budget = budget.saturating_sub(1);
    }
    let code: Svgr<'a> = code.into_iter().collect();
    svgr!(
        <g opacity={clamp01(card * 2.0)} transform={format!("translate(0 {})", 60.0 * (1.0 - card))}>
            <rect x={x} y={y} width="780" height="440" rx="24" fill="#120c09" stroke={accent} stroke-opacity="0.45" />
            <text x={x + 40.0} y={y + 64.0} font-family={HEAD} font-weight="800" font-size="44" fill={INK}>{title}</text>
            <text x={x + 740.0} y={y + 64.0} font-family={MONO} font-size="26" fill={accent} text-anchor="end">{tag}</text>
            {code}
        </g>
    )
}

fn two_ways<'a>(t: f32) -> Svgr<'a> {
    let head = expo(span(t, 0.0, 0.5));
    let left: [&[(&str, &str)]; 5] = [
        &[("import", LILAC), (" { Terminal }", INK)],
        &[("  from", LILAC), (" 'wraithterm/xterm'", GOLD)],
        &[],
        &[("const", LILAC), (" term = ", INK), ("new", LILAC), (" Terminal", AMBER), ("();", INK)],
        &[("term.", INK), ("open", AMBER), ("(element);", INK)],
    ];
    let right: [&[(&str, &str)]; 5] = [
        &[("import", LILAC), (" { Wraith }", INK)],
        &[("  from", LILAC), (" 'wraithterm'", GOLD)],
        &[],
        &[("const", LILAC), (" term = ", INK), ("await", LILAC)],
        &[("  Wraith.", INK), ("mount", AMBER), ("(element);", INK)],
    ];
    let a = code_card(t - 0.3, 150.0, 330.0, "Keep your xterm.js code.", "drop-in", &left, AMBER);
    let b = code_card(t - BEAT * 4.0, 990.0, 330.0, "Or go full Ghostty.", "native", &right, LILAC);
    svgr!(
        <g>
            <text x={W / 2.0} y="200" font-family={DISPLAY} font-weight="900" font-size="88" text-anchor="middle" fill={INK} opacity={head} letter-spacing="-3">"Two ways in."</text>
            {a}
            {b}
            <text x={W / 2.0} y="900" font-family={MONO} font-size="34" text-anchor="middle" fill={DIM} opacity={span(t, BEAT * 10.0, 0.5)}>"npm i wraithterm"</text>
        </g>
    )
}

fn finale<'a>(t: f32, g: f32) -> Svgr<'a> {
    let url = "wraithterm.com";
    let shown = typed(url, t - 0.3, 14.0);
    let size = 124.0;
    let width = url.chars().count() as f32 * size * MONO_ADV;
    let x = W / 2.0 - width / 2.0;
    let rise = expo(span(t, 1.6, 0.8));
    let y = H / 2.0 + 40.0 + 120.0 * rise;
    let done = shown.chars().count() == url.chars().count();
    let cursor_x = x + shown.chars().count() as f32 * size * MONO_ADV + 10.0;
    let blink = if !done || ((t / BEAT) as u32) % 2 == 0 { 1.0 } else { 0.0 };
    let mark = if t > 1.6 { wordmark(g, t - 1.6, W / 2.0, 330.0, 12.0, 0.8 + 0.2 * (g * 3.0).sin(), 0.0) } else { Svgr::empty() };
    let rest = span(t, 2.8, 0.5);
    let fade = span(t, END - CUES[9] - 1.4, 1.3);
    svgr!(
        <g>
            {mark}
            <text x={x} y={y} font-family={MONO} font-size={size} fill="url(#spectral)">{shown}</text>
            <rect x={cursor_x} y={y - size * 0.72} width={size * 0.08} height={size * 0.8} fill={AMBER} opacity={blink * (1.0 - rise)} />
            <g opacity={rest} transform={format!("translate(0 {})", 24.0 * (1.0 - expo(rest)))}>
                <rect x={W / 2.0 - 230.0} y={y + 70.0} width="460" height="76" rx="38" fill="#150f0b" stroke="#3d2e25" />
                <text x={W / 2.0} y={y + 120.0} font-family={MONO} font-size="38" text-anchor="middle" fill={GOLD}>"npm i wraithterm"</text>
                <text x={W / 2.0} y={y + 200.0} font-family={MONO} font-size="30" text-anchor="middle" fill={DIM}>"github.com/betterclever/wraithterm"</text>
            </g>
            <rect width={W} height={H} fill="#000" opacity={fade} />
        </g>
    )
}

// ---------------------------------------------------------------------------------------------

pub struct LaunchVideo<'a> {
    pub media: &'a LaunchMedia,
    fog: Shader,
    shots: Vec<Shot>,
}

impl std::fmt::Debug for LaunchVideo<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LaunchVideo").field("shots", &self.shots.len()).finish()
    }
}

impl<'a> LaunchVideo<'a> {
    pub fn new(media: &'a LaunchMedia) -> Self {
        let shots = KINDS
            .iter()
            .enumerate()
            .map(|(i, &kind)| Shot { kind, start: CUES[i], end: CUES[i + 1] })
            .collect();
        LaunchVideo { media, fog: Shader::sksl(FOG), shots }
    }
}

impl Video for LaunchVideo<'_> {
    const FPS: usize = 60;
    const WIDTH: usize = WIDTH;
    const HEIGHT: usize = HEIGHT;
    const BACKGROUND_COLOR: Color = Color::BLACK;

    fn duration(&self) -> Duration<'_> {
        Duration::Auto
    }

    fn define_scenes(&self) -> Scenes<'_> {
        Scenes::from(self.shots.iter().map(|s| s as &dyn Scene).collect::<Vec<_>>())
    }

    fn audio(&self) -> AudioMap<'_> {
        AudioMap::from([AudioTrack::new("music.wav", AudioTimestamp::Second(0.0)..AudioTimestamp::Eof)])
    }

    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        let fog = self.fog.draw(&frame, ShaderUniforms::new().float("uEnergy", energy(t)).float("uFlash", flash(t)));
        let (sx, sy) = shake(t);
        // Cinematic bars during the cold open, snapping open on the drums.
        let bars = if t < DRUMS { 1.0 } else { 1.0 - expo(span(t, DRUMS, 0.5)) };
        let bar_h = 130.0 * bars;
        let gl = glitch(t);
        let tick = (t * 30.0) as u32;
        let tears: Vec<Svgr<'a>> = (0..(gl * 10.0) as u32)
            .map(|i| {
                let y = hash(i, tick) * H;
                let h = 4.0 + hash(i, tick + 7) * 46.0;
                let c = if i % 2 == 0 { "#ff5a3c" } else { "#ffd27a" };
                svgr!(<rect x="0" y={y} width={W} height={h} fill={c} opacity={0.14 * gl} />)
            })
            .collect();
        let scenes = ctx.render_scenes(&frame);
        svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" viewBox={format!("0 0 {WIDTH} {HEIGHT}")} width={WIDTH} height={HEIGHT}>
                <defs>
                    <linearGradient id="spectral" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0" stop-color="#ffb86b" />
                        <stop offset="0.55" stop-color="#ff7f6e" />
                        <stop offset="1" stop-color="#d9bbff" />
                    </linearGradient>
                    <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5">
                        <stop offset="0" stop-color="#ff9a4a" stop-opacity="0.75" />
                        <stop offset="1" stop-color="#ff9a4a" stop-opacity="0" />
                    </radialGradient>
                    <radialGradient id="ember" cx="0.5" cy="0.5" r="0.5">
                        <stop offset="0" stop-color="#ffb86b" stop-opacity="0.9" />
                        <stop offset="1" stop-color="#ffb86b" stop-opacity="0" />
                    </radialGradient>
                </defs>
                <rect width={W} height={H} fill={BG} />
                <image href={fog.href()} x="0" y="0" width={W} height={H} />
                <g transform={format!("translate({sx} {sy})")}>{scenes}</g>
                {tears}
                <rect x="0" y="0" width={W} height={bar_h.max(0.5)} fill="#000" />
                <rect x="0" y={H - bar_h.max(0.5)} width={W} height={bar_h.max(0.5)} fill="#000" />
            </svg>
        )
    }
}
