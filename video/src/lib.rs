//! The Wraith launch video: 57 seconds at 1920×1080, 60 fps, cut to the synthesized
//! soundtrack in `soundtrack/synth.rs` (120 BPM, one bar = 2 s).
//!
//! | time   | scene                                   |
//! | ------ | --------------------------------------- |
//! | 0–4    | boot: a terminal types the install line |
//! | 4–8    | the drop: the WRAITH wordmark assembles |
//! | 8–14   | the stack, one word per beat            |
//! | 14–22  | footage: the live site hero             |
//! | 22–32  | CPU per update versus xterm.js          |
//! | 32–40  | footage: the in-browser race            |
//! | 40–46  | rapid-fire facts                        |
//! | 46–50  | the drop-in API                         |
//! | 50–57  | end card                                |
//!
//! Every frame is a pure function of time: `render_frame` reads only precomputed data.
use fframes::{
    AudioMap, AudioTimestamp, AudioTrack, Color, Duration, FFramesContext,
    FFramesSyncedVideoFrame, Frame, Shader, ShaderUniforms, Svgr, SyncVideoFrameInput, Video,
    include_media_dir, svgr,
};

include_media_dir!(pub struct LaunchMedia, "media");

pub const WIDTH: usize = 1920;
pub const HEIGHT: usize = 1080;
const W: f32 = WIDTH as f32;
const H: f32 = HEIGHT as f32;
const LENGTH: f32 = 57.0;

const SANS: &str = "Inter";
const MONO: &str = "JetBrains Mono";
const INK: &str = "#e6eef5";
const DIM: &str = "#7d8d9c";
const FAINT: &str = "#4a5866";
const ICE: &str = "#9fe8ff";
const MINT: &str = "#8ff0c4";
const GHOST: &str = "#c6b5ff";
const HOT: &str = "#ff8fb1";

/// Hits in the soundtrack: big ones flash the screen and shake the camera.
const IMPACTS: [f32; 3] = [4.0, 32.0, 50.0];
/// Stutters lead into these cuts; the picture glitches with them.
const CUTS: [f32; 5] = [8.0, 14.0, 22.0, 32.0, 40.0];

// ---------------------------------------------------------------------------------------------
// Time helpers

fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}
/// Progress of `[start, start + dur]` at time `t`, clamped.
fn span(t: f32, start: f32, dur: f32) -> f32 {
    clamp01((t - start) / dur)
}
fn ease_out(x: f32) -> f32 {
    1.0 - (1.0 - x).powi(3)
}
fn ease_in_out(x: f32) -> f32 {
    if x < 0.5 { 4.0 * x * x * x } else { 1.0 - (-2.0 * x + 2.0).powi(3) / 2.0 }
}
/// Ease out with overshoot.
fn back(x: f32) -> f32 {
    let c = 1.9;
    1.0 + (c + 1.0) * (x - 1.0).powi(3) + c * (x - 1.0).powi(2)
}
/// Visible between `a` and `b`, with fades of `f` seconds.
fn window(t: f32, a: f32, b: f32, f: f32) -> f32 {
    clamp01((t - a) / f).min(clamp01((b - t) / f))
}
fn hash(a: u32, b: u32) -> f32 {
    let mut h = a.wrapping_mul(0x9e37_79b9) ^ b.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2c1b_3c6d);
    h ^= h >> 12;
    (h & 0xffff) as f32 / 65535.0
}
/// Glitch strength: spikes into each cut and right after each impact.
fn glitch(t: f32) -> f32 {
    let mut g: f32 = 0.0;
    for c in CUTS {
        g = g.max(span(t, c - 0.45, 0.45).powi(2) * if t < c { 1.0 } else { 0.0 });
        g = g.max((1.0 - span(t, c, 0.18)) * if t >= c { 0.8 } else { 0.0 });
    }
    for c in IMPACTS {
        g = g.max((1.0 - span(t, c, 0.35)) * if t >= c { 1.0 } else { 0.0 });
    }
    g
}
fn flash(t: f32) -> f32 {
    let mut f: f32 = 0.0;
    for c in IMPACTS {
        if t >= c {
            f = f.max((-(t - c) * 7.0).exp() * 0.85);
        }
    }
    for c in CUTS {
        if t >= c {
            f = f.max((-(t - c) * 14.0).exp() * 0.25);
        }
    }
    f
}
/// Section energy, mirroring the soundtrack.
fn energy(t: f32) -> f32 {
    match t {
        t if t < 4.0 => 0.15 + 0.1 * t / 4.0,
        t if t < 22.0 => 0.6 + 0.15 * (t - 4.0) / 18.0,
        t if t < 32.0 => 0.75 + 0.25 * ((t - 22.0) / 10.0).powi(2),
        t if t < 46.0 => 1.0,
        t if t < 50.0 => 0.35,
        _ => 0.6 * (-(t - 50.0) / 3.0).exp() + 0.15,
    }
}
/// Camera shake after impacts and kicks.
fn shake(t: f32) -> (f32, f32) {
    let mut amount: f32 = 0.0;
    for c in IMPACTS {
        if t >= c {
            amount = amount.max(22.0 * (-(t - c) * 6.0).exp());
        }
    }
    if (4.0..46.0).contains(&t) {
        let since = (t - 4.0) % 2.0;
        amount = amount.max(4.0 * (-since * 18.0).exp());
    }
    let f = (t * 60.0) as u32;
    ((hash(f, 1) - 0.5) * 2.0 * amount, (hash(f, 2) - 0.5) * 2.0 * amount)
}
fn rgb(r: f32, g: f32, b: f32) -> String {
    format!("rgb({},{},{})", r.clamp(0.0, 255.0) as u8, g.clamp(0.0, 255.0) as u8, b.clamp(0.0, 255.0) as u8)
}

// ---------------------------------------------------------------------------------------------
// The background: domain-warped fog with scanlines and grain, drawn on the GPU.

const FOG: &str = r#"
uniform float3 iResolution;
uniform float iTime;
uniform float uEnergy;
uniform float uFlash;
uniform float2 uFocus;

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
    float t = iTime * 0.09;
    float2 q = float2(fbm(p * 2.0 + float2(0.0, t)), fbm(p * 2.0 + float2(5.2, -t)));
    float2 r = float2(fbm(p * 2.4 + 4.0 * q + float2(1.7, 9.2) + t * 1.5),
                      fbm(p * 2.4 + 4.0 * q + float2(8.3, 2.8) - t));
    float f = fbm(p * 1.8 + 3.0 * r);
    float3 col = float3(0.008, 0.014, 0.022);
    col = mix(col, float3(0.04, 0.30, 0.38), smoothstep(0.4, 0.95, f) * (0.25 + 0.75 * uEnergy));
    col = mix(col, float3(0.50, 0.40, 0.95), smoothstep(0.55, 1.0, r.x * f * 1.3) * 0.32 * uEnergy);
    float2 focus = (uFocus - 0.5) * float2(iResolution.x / iResolution.y, 1.0);
    col += float3(0.22, 0.70, 0.88) * exp(-2.6 * length(p - focus)) * 0.22 * (0.3 + uEnergy);
    col *= 0.9 + 0.1 * sin(coord.y * 1.5708);
    col += (hash(coord * 0.73 + fract(iTime) * 113.0) - 0.5) * 0.04;
    col *= smoothstep(1.3, 0.2, length(p * float2(0.85, 1.0)));
    col += uFlash * float3(0.75, 0.93, 1.0);
    return half4(half3(col), 1.0);
}
"#;

// ---------------------------------------------------------------------------------------------

/// One pixel of the wordmark grid.
struct Pixel {
    x: f32,
    y: f32,
    alpha: f32,
    row: u32,
    seed: u32,
}

const WORDMARK: &str = include_str!("wordmark.txt");
const GRID_COLS: f32 = 104.0;
const RAIN: &[char] = &[
    '0', '1', 'λ', 'ψ', 'Ω', 'Σ', 'π', '∂', '≈', '{', '}', '<', '>', '/', '=', '+', '*', '#', '$', '%', '░', '▒', '▓',
    '│', '┼', '◇',
];

pub struct LaunchVideo<'a> {
    pub media: &'a LaunchMedia,
    fog: Shader,
    pixels: Vec<Pixel>,
}

impl std::fmt::Debug for LaunchVideo<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LaunchVideo").field("pixels", &self.pixels.len()).finish()
    }
}

impl<'a> LaunchVideo<'a> {
    pub fn new(media: &'a LaunchMedia) -> Self {
        let ramp = "_.:-=+*#%@";
        let mut pixels = Vec::new();
        for (row, line) in WORDMARK.lines().enumerate() {
            for (col, ch) in line.chars().enumerate() {
                let level = ramp.find(ch).unwrap_or(0);
                if level >= 3 {
                    pixels.push(Pixel {
                        x: col as f32,
                        y: row as f32,
                        alpha: level as f32 / 9.0,
                        row: row as u32,
                        seed: (row * 131 + col) as u32,
                    });
                }
            }
        }
        LaunchVideo { media, fog: Shader::sksl(FOG), pixels }
    }

    /// The pixel wordmark centered at (cx, cy). `assemble` is the time since it began flying
    /// in (None for already assembled), `g` the glitch strength.
    fn wordmark(&self, t: f32, cx: f32, cy: f32, cell: f32, assemble: Option<f32>, g: f32, glow: f32) -> Svgr<'a> {
        let rows = WORDMARK.lines().count() as f32;
        let (ox, oy) = (cx - GRID_COLS * cell / 2.0, cy - rows * cell / 2.0);
        let slice = (t * 14.0) as u32;
        let mut layers: Vec<Svgr<'a>> = Vec::new();
        // Chromatic ghosts only while glitching.
        let passes: &[(f32, &str, f32)] = if g > 0.05 {
            &[(-10.0 * g, "#ff4d8d", 0.55), (10.0 * g, "#38e8ff", 0.55), (0.0, "", 1.0)]
        } else {
            &[(0.0, "", 1.0)]
        };
        for &(dx, tint, opacity) in passes {
            let mut rects: Vec<Svgr<'a>> = Vec::with_capacity(self.pixels.len());
            for p in &self.pixels {
                let (mut x, mut y, mut o) = (ox + p.x * cell, oy + p.y * cell, p.alpha);
                if let Some(since) = assemble {
                    let delay = p.x / GRID_COLS * 0.55 + hash(p.seed, 7) * 0.35;
                    let k = ease_out(span(since, delay, 0.7));
                    let (fx, fy) = ((hash(p.seed, 1) - 0.5) * 2600.0, (hash(p.seed, 2) - 0.5) * 1500.0);
                    x += fx * (1.0 - k);
                    y += fy * (1.0 - k);
                    o *= k;
                }
                if g > 0.0 && hash(p.row, slice) < 0.22 * g {
                    x += (hash(p.row, slice + 99) - 0.5) * 160.0 * g;
                }
                x += dx;
                let shimmer = 0.72 + 0.28 * (p.y * 0.9 - t * 7.0 + p.x * 0.04).sin();
                let fill = if tint.is_empty() {
                    let k = shimmer * (0.75 + 0.25 * glow);
                    rgb(120.0 + 110.0 * k, 190.0 + 60.0 * k, 215.0 + 40.0 * k)
                } else {
                    tint.to_string()
                };
                let size = cell * 0.86;
                rects.push(svgr!(<rect x={x} y={y} width={size} height={size} rx={cell * 0.14} fill={fill} opacity={o * opacity} />));
            }
            layers.push(rects.into_iter().collect());
        }
        let halo_opacity = 0.35 * glow;
        svgr!(
            <g>
                <ellipse cx={cx} cy={cy} rx={GRID_COLS * cell * 0.6} ry={rows * cell * 1.1} fill="url(#halo)" opacity={halo_opacity} />
                {layers}
            </g>
        )
    }

    /// Falling glyph columns, faint, behind the content.
    fn rain(&self, t: f32, strength: f32) -> Svgr<'a> {
        if strength <= 0.01 {
            return Svgr::empty();
        }
        let mut glyphs: Vec<Svgr<'a>> = Vec::new();
        let size = 22.0;
        for c in 0..44u32 {
            let speed = 140.0 + hash(c, 3) * 360.0;
            let x = 20.0 + c as f32 * (W - 40.0) / 43.0 + (hash(c, 4) - 0.5) * 18.0;
            let head = (t * speed + hash(c, 5) * 1800.0) % (H + 500.0) - 100.0;
            for k in 0..12u32 {
                let y = head - k as f32 * size * 1.15;
                if !(30.0..H - 12.0).contains(&y) {
                    continue;
                }
                let tick = (t * if k == 0 { 18.0 } else { 3.0 }) as u32;
                let ch = RAIN[(hash(c * 64 + k, tick) * RAIN.len() as f32) as usize % RAIN.len()];
                let fade = if k == 0 { 1.0 } else { 0.55 * (1.0 - k as f32 / 12.0) };
                let fill = if k == 0 { "#e9fbff" } else { MINT };
                glyphs.push(svgr!(<text x={x} y={y} font-family={MONO} font-size={size} fill={fill} opacity={fade * strength}>{ch.to_string()}</text>));
            }
        }
        glyphs.into_iter().collect()
    }

    /// A browser window around synced site footage.
    fn browser(&self, frame: &Frame, ctx: &FFramesContext<'a, '_>, file: &'static str, start: f32, x: f32, y: f32, w: f32, url: &'static str) -> Svgr<'a> {
        let h = w * 9.0 / 16.0;
        let bar = 44.0;
        let input = SyncVideoFrameInput { start_from: start, looping: false, editor_fallback_image: None };
        let picture = match frame.get_synced_video_frame(ctx, file, &input) {
            Some(video) => {
                let image = video.into_image();
                svgr!(<image href={image.href()} x={x} y={y + bar} width={w} height={h} preserveAspectRatio="none" />)
            }
            None => svgr!(<rect x={x} y={y + bar} width={w} height={h} fill="#05080c" />),
        };
        svgr!(
            <g>
                <rect x={x - 2.0} y={y - 2.0} width={w + 4.0} height={h + bar + 4.0} rx="18" fill="#9fe8ff" opacity="0.18" />
                <rect x={x} y={y} width={w} height={h + bar} rx="16" fill="#0b1118" />
                <circle cx={x + 26.0} cy={y + 22.0} r="7" fill="#ff6b81" />
                <circle cx={x + 50.0} cy={y + 22.0} r="7" fill="#ffd166" />
                <circle cx={x + 74.0} cy={y + 22.0} r="7" fill="#8ff0c4" />
                <rect x={x + w / 2.0 - 220.0} y={y + 9.0} width="440" height="26" rx="13" fill="#141c26" />
                <text x={x + w / 2.0} y={y + 28.0} font-family={MONO} font-size="16" fill={DIM} text-anchor="middle">{url}</text>
                {picture}
            </g>
        )
    }

    fn boot(&self, t: f32) -> Svgr<'a> {
        let x = 520.0;
        let command = "npm i wraithterm";
        let typed = ((t - 0.4) / 1.3 * command.len() as f32).clamp(0.0, command.len() as f32) as usize;
        let cursor_on = (t * 2.0) as u32 % 2 == 0;
        let lines: [(f32, &str, &str, &str); 3] = [
            (2.1, "libghostty-vt", "linked", MINT),
            (2.45, "rust renderer", "ready", MINT),
            (2.8, "webgpu", "online", ICE),
        ];
        let mut out: Vec<Svgr<'a>> = Vec::new();
        out.push(svgr!(
            <text x={x} y="420" font-family={MONO} font-size="44" fill={INK}>
                <tspan fill={MINT}>"❯ "</tspan>{command[..typed].to_string()}<tspan fill={ICE} opacity={if cursor_on || typed < command.len() { 1.0 } else { 0.0 }}>"▋"</tspan>
            </text>
        ));
        for (i, (at, name, state, color)) in lines.into_iter().enumerate() {
            let k = span(t, at, 0.15);
            let y = 500.0 + i as f32 * 58.0;
            out.push(svgr!(
                <g opacity={k}>
                    <text x={x} y={y} font-family={MONO} font-size="34" fill={DIM}>{format!("▸ {name:<16}")}</text>
                    <text x={x + 520.0} y={y} font-family={MONO} font-size="34" fill={color}>{state}</text>
                </g>
            ));
        }
        let summon = span(t, 3.2, 0.2);
        out.push(svgr!(
            <text x={x} y="720" font-family={MONO} font-size="34" fill={GHOST} opacity={summon}>"▸ summoning…"</text>
        ));
        out.into_iter().collect()
    }

    fn logo(&self, t: f32) -> Svgr<'a> {
        let since = t - 4.0;
        let tag = ease_out(span(since, 1.4, 0.6));
        let kicker = span(since, 2.2, 0.5);
        let g = glitch(t);
        let mark = self.wordmark(t, W / 2.0, 430.0, 15.0, Some(since), g, 1.0);
        svgr!(
            <g>
                {mark}
                <text x={W / 2.0} y={720.0 + 30.0 * (1.0 - tag)} font-family={SANS} font-weight="900" font-size="78" text-anchor="middle" fill="url(#spectral)" opacity={tag} letter-spacing="-2">"the terminal that haunts the GPU"</text>
                <text x={W / 2.0} y="800" font-family={MONO} font-size="26" text-anchor="middle" fill={DIM} opacity={kicker} letter-spacing="6">"OPEN SOURCE  ·  MIT  ·  WRAITHTERM.COM"</text>
            </g>
        )
    }

    fn stack(&self, t: f32) -> Svgr<'a> {
        let items: [(&str, &str, &str); 4] = [
            ("Ghostty's engine", "libghostty-vt · Zig", ICE),
            ("Rust", "shaping · atlas · wgpu", HOT),
            ("WebAssembly", "one module · one allocator", GHOST),
            ("WebGPU", "instanced draws · WGSL", MINT),
        ];
        let mut out: Vec<Svgr<'a>> = Vec::new();
        let collapse = ease_in_out(span(t, 12.4, 0.5));
        for (i, (word, note, color)) in items.into_iter().enumerate() {
            let at = 8.0 + i as f32;
            let k = span(t, at, 0.35);
            let s = 1.0 + 0.6 * (1.0 - back(k).min(1.15));
            let y = 290.0 + i as f32 * 150.0;
            let x = 300.0 + 40.0 * collapse * i as f32;
            let o = k * (1.0 - collapse);
            out.push(svgr!(
                <g opacity={o} transform={format!("translate({x} {y}) scale({s})")}>
                    <text x="0" y="0" font-family={SANS} font-weight="900" font-size="112" fill={INK} letter-spacing="-4">{word}</text>
                    <text x="6" y="44" font-family={MONO} font-size="26" fill={color}>{note}</text>
                </g>
            ));
        }
        let one = ease_out(span(t, 12.6, 0.5));
        out.push(svgr!(
            <g opacity={one}>
                <text x={W / 2.0} y={560.0 + 20.0 * (1.0 - one)} font-family={SANS} font-weight="900" font-size="120" text-anchor="middle" fill="url(#spectral)" letter-spacing="-4">"one Wasm module."</text>
                <text x={W / 2.0} y="650" font-family={MONO} font-size="30" text-anchor="middle" fill={DIM}>"in a worker, off your main thread"</text>
            </g>
        ));
        out.into_iter().collect()
    }

    fn hero(&self, frame: &Frame, ctx: &FFramesContext<'a, '_>, t: f32) -> Svgr<'a> {
        let k = ease_out(span(t, 14.0, 1.2));
        let drift = span(t, 14.0, 8.0);
        let w = 1200.0 + 420.0 * k + 60.0 * drift;
        let (x, y) = (W / 2.0 - w / 2.0, 130.0 + 260.0 * (1.0 - k) - 20.0 * drift);
        let site = self.browser(frame, ctx, "hero.mp4", 14.0, x, y, w, "wraithterm.com");
        let chips: [(f32, &str, f32, f32); 3] = [
            (15.4, "↖ this whole background is terminal output", 170.0, 90.0),
            (17.2, "drawn by Wraith on WebGPU, every frame", 1080.0, 1010.0),
            (19.0, "the cursor ripples the plasma, live", 1180.0, 90.0),
        ];
        let mut out: Vec<Svgr<'a>> = vec![site];
        for (at, label, cx, cy) in chips {
            let c = back(span(t, at, 0.35));
            let o = span(t, at, 0.2) * window(t, 14.0, 21.8, 0.2);
            let width = label.chars().count() as f32 * 15.6 + 48.0;
            out.push(svgr!(
                <g opacity={o} transform={format!("translate({cx} {cy}) scale({})", 0.6 + 0.4 * c)}>
                    <rect x="0" y="-34" width={width} height="54" rx="27" fill="#04080c" opacity="0.92" stroke="#9fe8ff" stroke-opacity="0.5" />
                    <text x="24" y="1" font-family={MONO} font-size="26" fill={ICE}>{label}</text>
                </g>
            ));
        }
        out.into_iter().collect()
    }

    fn numbers(&self, t: f32) -> Svgr<'a> {
        let rows: [(&str, &str, f32, bool); 4] = [
            ("xterm.js", "DOM renderer", 37.7, false),
            ("xterm.js", "+ WebGL addon", 9.8, false),
            ("Wraith", "native · libghostty", 3.1, true),
            ("Wraith", "xterm-compatible", 2.5, true),
        ];
        let head = ease_out(span(t, 22.1, 0.5));
        let verdict = span(t, 27.6, 0.4);
        let dim = 1.0 - 0.8 * verdict;
        let mut out: Vec<Svgr<'a>> = Vec::new();
        out.push(svgr!(
            <g opacity={head * dim}>
                <text x="200" y="200" font-family={SANS} font-weight="900" font-size="76" fill={INK} letter-spacing="-2">"CPU per full-screen update"</text>
                <text x="204" y="252" font-family={MONO} font-size="26" fill={DIM}>"240×80 cells · ~4,800 style changes per update · lower is better"</text>
            </g>
        ));
        for (i, (who, what, ms, ours)) in rows.into_iter().enumerate() {
            let at = 22.6 + i as f32 * 0.9;
            let k = ease_out(span(t, at, 0.8));
            let y = 360.0 + i as f32 * 128.0;
            let full = 1020.0 * ms / 37.7;
            let w = (full * k).max(1.0);
            let fill = if ours { "url(#spectral)" } else { "#2a3440" };
            let color = if ours { ICE } else { INK };
            out.push(svgr!(
                <g opacity={span(t, at - 0.1, 0.2) * dim}>
                    <text x="200" y={y + 40.0} font-family={SANS} font-weight="700" font-size="40" fill={INK}>{who}</text>
                    <text x="202" y={y + 76.0} font-family={MONO} font-size="22" fill={FAINT}>{what}</text>
                    <rect x="600" y={y} width="1020" height="64" rx="10" fill="#0a1017" />
                    <rect x="600" y={y} width={w} height="64" rx="10" fill={fill} />
                    <text x={620.0 + w} y={y + 46.0} font-family={MONO} font-weight="700" font-size="40" fill={color}>{format!("{:.1} ms", ms * k)}</text>
                </g>
            ));
        }
        let big = back(span(t, 27.6, 0.45));
        out.push(svgr!(
            <g opacity={verdict} transform={format!("translate({} 560) scale({})", W / 2.0, 0.7 + 0.3 * big)}>
                <text x="0" y="0" font-family={SANS} font-weight="900" font-size="300" text-anchor="middle" fill="url(#spectral)" letter-spacing="-12">"3.9×"</text>
                <text x="0" y="110" font-family={SANS} font-weight="700" font-size="56" text-anchor="middle" fill={INK}>"less CPU than xterm.js + WebGL"</text>
            </g>
        ));
        out.push(svgr!(
            <text x={W / 2.0} y="1010" font-family={MONO} font-size="20" text-anchor="middle" fill={FAINT} opacity={head}>"Medians of interleaved runs · Chrome 155 · Apple M5 Max · GPU-completed updates, not display FPS"</text>
        ));
        out.into_iter().collect()
    }

    fn race(&self, frame: &Frame, ctx: &FFramesContext<'a, '_>, t: f32) -> Svgr<'a> {
        let k = ease_out(span(t, 32.0, 0.8));
        let w = 1500.0 + 40.0 * span(t, 32.0, 8.0);
        let (x, y) = (W / 2.0 - w / 2.0, 150.0 + 60.0 * (1.0 - k));
        let site = self.browser(frame, ctx, "race.mp4", 32.0, x, y, w, "wraithterm.com/#race");
        let title = span(t, 32.2, 0.4);
        let result = back(span(t, 37.4, 0.4));
        let ro = span(t, 37.4, 0.2);
        svgr!(
            <g>
                <text x={W / 2.0} y="100" font-family={SANS} font-weight="900" font-size="64" text-anchor="middle" fill={INK} opacity={title} letter-spacing="-2">"Race it. In your browser."</text>
                {site}
                <g opacity={ro} transform={format!("translate({} 640) scale({})", W / 2.0, 0.6 + 0.4 * result)}>
                    <rect x="-560" y="-90" width="1120" height="190" rx="24" fill="#04080c" opacity="0.94" stroke="#9fe8ff" stroke-opacity="0.6" />
                    <text x="-500" y="-20" font-family={MONO} font-size="30" fill={DIM}>"xterm.js + WebGL"</text>
                    <text x="500" y="-20" font-family={MONO} font-weight="700" font-size="44" fill={INK} text-anchor="end">"4.66 ms"</text>
                    <text x="-500" y="60" font-family={MONO} font-size="30" fill={ICE}>"Wraith"</text>
                    <text x="500" y="60" font-family={MONO} font-weight="700" font-size="44" fill={MINT} text-anchor="end">"1.41 ms"</text>
                </g>
            </g>
        )
    }

    fn facts(&self, t: f32) -> Svgr<'a> {
        let facts: [(&str, &str, &str); 6] = [
            ("20 bytes", "per GPU cell", ICE),
            ("1 row", "uploaded for a one-cell edit", MINT),
            ("0.6 ms", "to redraw a full 240×80 screen", GHOST),
            ("xterm.js 6.0", "the same API, drop-in", ICE),
            ("Ghostty", "terminal semantics, in a worker", HOT),
            ("MIT", "open source. today.", MINT),
        ];
        let i = ((t - 40.0).max(0.0) as usize).min(5);
        let local = t - 40.0 - i as f32;
        let (big, small, color) = facts[i];
        let k = back(span(local, 0.0, 0.3));
        let out_k = span(local, 0.85, 0.15);
        let s = 1.35 - 0.35 * k + 0.1 * out_k;
        let o = span(local, 0.0, 0.08) * (1.0 - out_k);
        let g = (1.0 - span(local, 0.0, 0.18)) * 1.0;
        let jitter = if g > 0.0 { (hash((t * 60.0) as u32, 11) - 0.5) * 60.0 * g } else { 0.0 };
        let counter = format!("{:02} / 06", i + 1);
        svgr!(
            <g>
                <text x="140" y="140" font-family={MONO} font-size="26" fill={FAINT} letter-spacing="4">{counter}</text>
                <g opacity={o} transform={format!("translate({} 560) scale({s})", W / 2.0 + jitter)}>
                    <text x={-8.0 * g} y="0" font-family={SANS} font-weight="900" font-size="210" text-anchor="middle" fill="#ff4d8d" opacity={0.6 * g} letter-spacing="-8">{big}</text>
                    <text x={8.0 * g} y="0" font-family={SANS} font-weight="900" font-size="210" text-anchor="middle" fill="#38e8ff" opacity={0.6 * g} letter-spacing="-8">{big}</text>
                    <text x="0" y="0" font-family={SANS} font-weight="900" font-size="210" text-anchor="middle" fill={INK} letter-spacing="-8">{big}</text>
                    <text x="0" y="96" font-family={MONO} font-size="40" text-anchor="middle" fill={color}>{small}</text>
                </g>
            </g>
        )
    }

    fn code(&self, t: f32) -> Svgr<'a> {
        // (text, color) runs per line.
        let lines: [&[(&str, &str)]; 5] = [
            &[("import", GHOST), (" { Terminal } ", INK), ("from", GHOST), (" 'wraithterm/xterm'", MINT), (";", INK)],
            &[],
            &[("const", GHOST), (" term = ", INK), ("new", GHOST), (" Terminal", ICE), ("();", INK)],
            &[("term.", INK), ("open", ICE), ("(element);", INK)],
            &[("term.", INK), ("write", ICE), ("(", INK), ("'hello from the other side'", MINT), (");", INK)],
        ];
        let total: usize = lines.iter().map(|l| l.iter().map(|(s, _)| s.chars().count()).sum::<usize>() + 1).sum();
        let typed = (span(t, 46.4, 2.6) * total as f32) as usize;
        let card = ease_out(span(t, 46.0, 0.6));
        let mut budget = typed;
        let mut out: Vec<Svgr<'a>> = Vec::new();
        let (x0, y0) = (420.0, 430.0);
        for (row, runs) in lines.iter().enumerate() {
            let mut x = x0;
            for &(text, color) in runs.iter() {
                let n = text.chars().count().min(budget);
                budget -= n;
                if n > 0 {
                    let shown: String = text.chars().take(n).collect();
                    out.push(svgr!(<text x={x} y={y0 + row as f32 * 64.0} font-family={MONO} font-size="38" fill={color} style="white-space:pre">{shown}</text>));
                }
                x += text.chars().count() as f32 * 22.8;
            }
            budget = budget.saturating_sub(1);
        }
        let caption = span(t, 46.2, 0.5);
        let code: Svgr<'a> = out.into_iter().collect();
        svgr!(
            <g>
                <text x={W / 2.0} y="250" font-family={SANS} font-weight="900" font-size="72" text-anchor="middle" fill={INK} opacity={caption} letter-spacing="-2">"Keep your xterm.js code."</text>
                <text x={W / 2.0} y="310" font-family={MONO} font-size="28" text-anchor="middle" fill={DIM} opacity={caption}>"swap one import. get a new engine underneath."</text>
                <g opacity={card} transform={format!("translate(0 {})", 30.0 * (1.0 - card))}>
                    <rect x="360" y="360" width="1200" height="380" rx="22" fill="#05090d" stroke="#1d2a36" />
                    <text x="390" y="395" font-family={MONO} font-size="20" fill={FAINT}>"your-app.ts"</text>
                    {code}
                </g>
            </g>
        )
    }

    fn end(&self, t: f32) -> Svgr<'a> {
        let since = t - 50.0;
        let pulse = 0.6 + 0.4 * (-since * 1.5).exp() + 0.1 * (t * 3.0).sin();
        let mark = self.wordmark(t, W / 2.0, 330.0, 13.0, Some(since + 0.6), glitch(t), pulse);
        let url = back(span(since, 0.5, 0.5));
        let rest = span(since, 1.1, 0.5);
        svgr!(
            <g>
                {mark}
                <g transform={format!("translate({} 640) scale({})", W / 2.0, 0.7 + 0.3 * url)} opacity={span(since, 0.5, 0.2)}>
                    <text x="0" y="0" font-family={SANS} font-weight="900" font-size="120" text-anchor="middle" fill="url(#spectral)" letter-spacing="-4">"wraithterm.com"</text>
                </g>
                <g opacity={rest}>
                    <rect x={W / 2.0 - 200.0} y="700" width="400" height="66" rx="33" fill="#0b1219" stroke="#2a3846" />
                    <text x={W / 2.0} y="745" font-family={MONO} font-size="32" text-anchor="middle" fill={MINT}>"npm i wraithterm"</text>
                    <text x={W / 2.0} y="830" font-family={MONO} font-size="28" text-anchor="middle" fill={DIM}>"github.com/betterclever/wraithterm"</text>
                </g>
            </g>
        )
    }
}

impl Video for LaunchVideo<'_> {
    const FPS: usize = 60;
    const WIDTH: usize = WIDTH;
    const HEIGHT: usize = HEIGHT;
    const BACKGROUND_COLOR: Color = Color::BLACK;

    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(LENGTH)
    }

    fn audio(&self) -> AudioMap<'_> {
        AudioMap::from([AudioTrack::new("soundtrack.wav", AudioTimestamp::Second(0.0)..AudioTimestamp::Eof)])
    }

    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        let focus = match t {
            t if t < 4.0 => (0.4, 0.45),
            t if t < 8.0 => (0.5, 0.4),
            t if t < 14.0 => (0.3, 0.5),
            t if (22.0..32.0).contains(&t) => (0.6, 0.5),
            t if (40.0..46.0).contains(&t) => (0.5, 0.52),
            _ => (0.5, 0.35),
        };
        let fog = self.fog.draw(
            &frame,
            ShaderUniforms::new()
                .float("uEnergy", energy(t))
                .float("uFlash", flash(t))
                .float2("uFocus", focus.0, focus.1),
        );
        let scene = match t {
            t if t < 4.0 => self.boot(t),
            t if t < 8.0 => self.logo(t),
            t if t < 14.0 => self.stack(t),
            t if t < 22.0 => self.hero(&frame, ctx, t),
            t if t < 32.0 => self.numbers(t),
            t if t < 40.0 => self.race(&frame, ctx, t),
            t if t < 46.0 => self.facts(t),
            t if t < 50.0 => self.code(t),
            _ => self.end(t),
        };
        let rain = match t {
            t if t < 4.0 => self.rain(t, 0.25 * span(t, 0.0, 3.0)),
            t if t < 8.0 => self.rain(t, 0.7),
            t if (40.0..46.0).contains(&t) => self.rain(t, 0.35),
            t if t >= 50.0 => self.rain(t, 0.6 * (1.0 - span(t, 54.0, 2.5))),
            t => self.rain(t, 0.18),
        };
        let (sx, sy) = shake(t);
        // Horizontal tear lines while glitching.
        let g = glitch(t);
        let tick = (t * 30.0) as u32;
        let tears: Vec<Svgr<'a>> = (0..(g * 9.0) as u32)
            .map(|i| {
                let y = hash(i, tick) * H;
                let h = 4.0 + hash(i, tick + 7) * 40.0;
                let c = if i % 2 == 0 { "#38e8ff" } else { "#ff4d8d" };
                svgr!(<rect x="0" y={y} width={W} height={h} fill={c} opacity={0.12 * g} />)
            })
            .collect();
        let blackout = span(t, 55.4, 1.5);
        let intro_in = 1.0 - span(t, 0.0, 0.6);
        svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" viewBox={format!("0 0 {WIDTH} {HEIGHT}")} width={WIDTH} height={HEIGHT}>
                <defs>
                    <linearGradient id="spectral" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0" stop-color="#9fe8ff" />
                        <stop offset="0.55" stop-color="#c6b5ff" />
                        <stop offset="1" stop-color="#ff8fb1" />
                    </linearGradient>
                    <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5">
                        <stop offset="0" stop-color="#5fd4f5" stop-opacity="0.8" />
                        <stop offset="1" stop-color="#5fd4f5" stop-opacity="0" />
                    </radialGradient>
                </defs>
                <image href={fog.href()} x="0" y="0" width={W} height={H} />
                {rain}
                <g transform={format!("translate({sx} {sy})")}>{scene}</g>
                {tears}
                <rect width={W} height={H} fill="#000" opacity={blackout.max(intro_in)} />
            </svg>
        )
    }
}
