//! Ghost / Hype: actual terminal footage inside independently posed 3D browsers.
//! Video capture FPS, GPU-completed benchmark throughput and display refresh are distinct.
use fframes::{
    AudioMap, AudioTimestamp, AudioTrack, Color, Duration, FFramesContext, FFramesSyncedVideoFrame,
    Frame, Scene, Scenes, Shader, ShaderUniforms, Svgr, SyncVideoFrameInput, Video,
    animation::{Easing, KeyFramesAnimation},
    svgr,
};
const FONT: &str = "Manrope ExtraLight";
const MONO: &str = "JetBrains Mono";
const INK: &str = "#f8ecde";
const AMBER: &str = "#ffb86b";
// 52 beats at a provisional 131 BPM, rounded to integer 60-fps frames.
const CUES: [usize; 8] = [0, 110, 330, 550, 769, 989, 1209, 1429];
const NAMES: [&str; 7] = [
    "Summon",
    "TheDrop",
    "Reactor",
    "MeasuredSpeed",
    "Pipes",
    "DropIn",
    "Wraith",
];
pub struct HypeVideo {
    shots: Vec<Shot>,
    backdrop: Shader,
}
impl Default for HypeVideo {
    fn default() -> Self {
        Self::new()
    }
}
impl HypeVideo {
    pub fn new() -> Self {
        let panel = Shader::sksl(include_str!("shaders/hype-browser.sksl"));
        // Generate the GPU mask from the website asset once, never per frame.
        let sprite: serde_json::Value =
            serde_json::from_str(include_str!("../../demo/ghost-sprite.json"))
                .expect("shared website sprite");
        let rows = sprite["body"]
            .as_array()
            .expect("sprite body")
            .iter()
            .chain(sprite["tails"][0].as_array().expect("sprite tails"));
        let mask = rows
            .enumerate()
            .map(|(y, row)| {
                let bits = row
                    .as_str()
                    .expect("sprite row")
                    .chars()
                    .enumerate()
                    .fold(0_u32, |bits, (x, c)| {
                        bits | if c == '#' { 1 << x } else { 0 }
                    });
                format!("if(y=={y}.)bits={bits}.;")
            })
            .collect::<Vec<_>>()
            .join("else ");
        let ghost_source =
            include_str!("shaders/hype-ghost.sksl").replace("// @GHOST_ROWS@", &mask);
        let proof: serde_json::Value =
            serde_json::from_str(include_str!("../claims/hype-native.json"))
                .expect("recorded native proof");
        let headline = proof["headline"]
            .as_str()
            .expect("measured headline")
            .to_owned();
        let shots=(0..7).map(|id| {
   let duration=(CUES[id+1]-CUES[id]) as f32/60.;
   Shot {id,panel:panel.clone(),headline:headline.clone(),
    enter:fframes::timeline!(at 0.0 => 0.32, animate 0.0 => 1.0, Easing::CubicBezier(0.12, 0.85, 0.22, 1.0)),
    travel:fframes::timeline!(at 0.0 => duration, animate 0.0 => 1.0, Easing::CubicBezier(0.45, 0.0, 0.55, 1.0)),
    exit:fframes::timeline!(at (duration-0.18) => duration, animate 0.0 => 1.0, Easing::CubicBezier(0.6, 0.0, 0.9, 0.3))}
  }).collect();
        Self {
            shots,
            backdrop: Shader::sksl(ghost_source),
        }
    }
    pub fn shaders(&self) -> Vec<&Shader> {
        vec![&self.backdrop, &self.shots[0].panel]
    }
}
impl Video for HypeVideo {
    const FPS: usize = 60;
    const WIDTH: usize = 1920;
    const HEIGHT: usize = 1080;
    const BACKGROUND_COLOR: Color = Color::BLACK;
    fn duration(&self) -> Duration<'_> {
        Duration::Frames(1429)
    }
    fn define_scenes(&self) -> Scenes<'_> {
        Scenes::from(
            self.shots
                .iter()
                .map(|s| s as &dyn Scene)
                .collect::<Vec<_>>(),
        )
    }
    fn audio(&self) -> AudioMap<'_> {
        AudioMap::from([AudioTrack::new(
            "hype-score.wav",
            AudioTimestamp::Second(0.)..AudioTimestamp::Eof,
        )
        .gain_db(-0.7)])
    }
    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let clock = frame.global_index as f32 / 60.;
        let pulse = (-(clock * 131. / 60.).fract() * 12.).exp();
        let bg = self.backdrop.draw(
            &frame,
            ShaderUniforms::new()
                .float("uClock", clock)
                .float("uPulse", pulse),
        );
        let scene = ctx.render_scenes(&frame);
        svgr!(<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
   <defs><linearGradient id="hype-ink" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff3e2"/><stop offset="0.55" stop-color="#ffb86b"/><stop offset="1" stop-color="#df9a75"/></linearGradient></defs>
   <rect width="1920" height="1080" fill="#080503"/><image href={bg.href()} x="0" y="0" width="1920" height="1080"/>{scene}
  </svg>)
    }
}
struct Shot {
    id: usize,
    panel: Shader,
    headline: String,
    enter: KeyFramesAnimation<f32>,
    travel: KeyFramesAnimation<f32>,
    exit: KeyFramesAnimation<f32>,
}
impl std::fmt::Debug for Shot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(NAMES[self.id])
    }
}
#[derive(Clone)]
struct Pose {
    file: &'static str,
    center: [f32; 3],
    angles: [f32; 3],
    size: [f32; 2],
    opacity: f32,
}
impl Pose {
    fn new(file: &'static str, center: [f32; 3], angles: [f32; 3]) -> Self {
        Self {
            file,
            center,
            angles,
            size: [6.5, 4.05],
            opacity: 1.,
        }
    }
    fn sized(mut self, w: f32) -> Self {
        self.size = [w, w * 4.05 / 6.5];
        self
    }
    fn dim(mut self, a: f32) -> Self {
        self.opacity = a;
        self
    }
}
impl Scene for Shot {
    fn name(&self) -> &'static str {
        NAMES[self.id]
    }
    fn duration(&self) -> Duration<'_> {
        Duration::Frames(CUES[self.id + 1] - CUES[self.id])
    }
    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let a = frame.animate(&self.enter);
        let k = frame.animate(&self.travel);
        let e = frame.animate(&self.exit);
        let t = frame.seconds();
        let flip = if t < 4.0 * 60.0 / 131.0 { 0.0 } else { 1.0 };
        let clock = frame.global_index as f32 / 60.;
        let breathe = (-(clock * 131. / 60.).fract() * 14.).exp();
        match self.id {
            0 => {
                let panel = self.browser(
                    &frame,
                    ctx,
                    Pose::new(
                        "hype-reactor.mp4",
                        [1.2 - 1.2 * a, -0.35, -1.8 + 1.5 * k],
                        [0.1, 0.92 - 0.52 * k, -0.11 + 0.06 * a],
                    )
                    .dim(0.8),
                );
                svgr!(<g>{panel}<text x="160" y="220" font-family={FONT} font-size="150" font-weight="800" letter-spacing="-7" fill="url(#hype-ink)">"WRAITH"</text>
     <text x="168" y="286" font-family={MONO} font-size="32" fill={INK} opacity={a}>"THE WEB TERMINAL."</text></g>)
            }
            1 => {
                let panel = self.browser(
                    &frame,
                    ctx,
                    Pose::new(
                        "hype-home.mp4",
                        [
                            (1. - a) * 2.8 - e * 2.4 + 0.3 - 0.6 * k,
                            0.02,
                            -1.3 + 0.20 * k + 0.05 * breathe,
                        ],
                        [
                            0.12 * (1. - a),
                            -0.7 * (1. - a) - 0.52 + 0.3 * k + 0.82 * flip,
                            -0.10 * (1. - a) + 0.025 * k,
                        ],
                    ),
                );
                svgr!(<g>{panel}</g>)
            }
            2 => {
                let back = self.browser(
                    &frame,
                    ctx,
                    Pose::new(
                        "hype-pipes.mp4",
                        [-3.3 + 0.2 * k, 0.55, -4.5],
                        [0.12, 0.45, -0.14],
                    )
                    .sized(4.8)
                    .dim(0.38),
                );
                let main = self.browser(
                    &frame,
                    ctx,
                    Pose::new(
                        "hype-reactor.mp4",
                        [0.4 - 0.6 * k, -0.06, -1.7 + 0.5 * a],
                        [
                            0.09 - 0.2 * flip,
                            0.45 - 0.2 * k - 0.75 * flip,
                            0.065 - 0.1 * k,
                        ],
                    ),
                );
                svgr!(<g>{back}{main}<text x="164" y="1000" font-family={MONO} font-size="32" fill={AMBER}>"EVERYTHING YOU SEE. TERMINAL CELLS."</text></g>)
            }
            3 => {
                let main = self.browser(
                    &frame,
                    ctx,
                    Pose::new(
                        "hype-dense.mp4",
                        [1.7 + (1. - a) * 2.4, -0.1, -1.5],
                        [-0.06, -0.28 + 0.12 * k, 0.025],
                    )
                    .sized(4.6),
                );
                svgr!(<g>{main}<g opacity={a}>
     <text x="148" y="490" font-family={FONT} font-size="215" font-weight="800" letter-spacing="-12" fill="url(#hype-ink)">{self.headline.as_str()}</text>
     <text x="162" y="565" font-family={MONO} font-size="38" fill={INK}>"GPU-COMPLETED FRAMES/S¹"</text>
     <text x="162" y="625" font-family={MONO} font-size="29" fill="#b9a391">"RUST / WASM / WEBGPU"</text>
     <text x="162" y="940" font-family={MONO} font-size="28" fill="#b9a391">"¹ Native · 160×50 dense · M5 Max · Chrome 155"</text>
     <text x="162" y="985" font-family={MONO} font-size="28" fill="#b9a391">"10,000 frames/run · GPU fences · not display refresh"</text>
    </g></g>)
            }
            4 => {
                let main = self.browser(
                    &frame,
                    ctx,
                    Pose::new(
                        "hype-pipes.mp4",
                        [-0.15 + 0.35 * k, 0.05, -0.9],
                        [
                            -0.18 + 0.35 * flip,
                            0.58 - 0.25 * k - 0.82 * flip,
                            -0.065 + 0.13 * flip,
                        ],
                    ),
                );
                svgr!(<g>{main}<text x="164" y="1000" font-family={MONO} font-size="32" fill={AMBER}>"GHOSTTY ON THE WEB."</text></g>)
            }
            5 => {
                let back = self.browser(
                    &frame,
                    ctx,
                    Pose::new("hype-compatible.mp4", [2.4, 0.3, -3.8], [0.08, -0.5, 0.08])
                        .sized(5.)
                        .dim(0.4),
                );
                let main = self.browser(
                    &frame,
                    ctx,
                    Pose::new(
                        "hype-reactor.mp4",
                        [-1.0 + 0.4 * k, -0.2, -1.6],
                        [0.1, 0.22 - 0.20 * k, -0.025],
                    )
                    .sized(5.7),
                );
                svgr!(<g>{back}{main}<rect x="430" y="798" width="1060" height="130" rx="22" fill="#120b07" stroke="#7c4e2b" stroke-width="2"/>
     <text x="960" y="886" text-anchor="middle" font-family={MONO} font-size="60" fill={INK}>"npm i wraithterm"</text>
     <text x="960" y="988" text-anchor="middle" font-family={MONO} font-size="32" fill={AMBER}>"XTERM API. WEBGPU SPEED."</text></g>)
            }
            _ => {
                let back = self.browser(
                    &frame,
                    ctx,
                    Pose::new(
                        "hype-home.mp4",
                        [0., -0.1, -5.0 - 2. * k],
                        [0.1, 0.20 - 0.15 * k, 0.],
                    )
                    .sized(6.8)
                    .dim(0.20 * (1. - a)),
                );
                svgr!(<g>{back}<g opacity={a}>
     <text x="960" y="480" text-anchor="middle" font-family={FONT} font-size="230" font-weight="800" letter-spacing="-11" fill="url(#hype-ink)">"WRAITH"</text>
     <text x="960" y="602" text-anchor="middle" font-family={FONT} font-size="74" font-weight="800" letter-spacing="-2" fill={INK}>"wraithterm.com"</text>
     <text x="960" y="818" text-anchor="middle" font-family={MONO} font-size="38" fill={AMBER}>"npm i wraithterm"</text>
    </g></g>)
            }
        }
    }
}
impl Shot {
    fn browser<'a>(&'a self, frame: &Frame, ctx: &FFramesContext<'a, '_>, p: Pose) -> Svgr<'a> {
        let input = SyncVideoFrameInput {
            start_from: 0.,
            looping: true,
            editor_fallback_image: None,
        };
        let Some(clip) = frame.get_synced_video_frame(ctx, p.file, &input) else {
            return Svgr::empty();
        };
        let size = [clip.width() as f32, clip.height() as f32];
        let src = clip.into_image();
        let Some(chrome) = ctx.get_image("hype-chrome.png") else {
            return Svgr::empty();
        };
        let image = self.panel.draw(
            frame,
            ShaderUniforms::new()
                .image("uSource", &src)
                .image("uChromeSource", &chrome)
                .float2("uSourceSize", size[0], size[1])
                .float3("uCenter", p.center[0], p.center[1], p.center[2])
                .float2("uSize", p.size[0], p.size[1])
                .float3("uAngles", p.angles[0], p.angles[1], p.angles[2])
                .float("uOpacity", p.opacity)
                .float("uClock", frame.global_index as f32 / 60.)
                .float(
                    "uSmear",
                    (1. - frame.animate(&self.enter)) * 0.5
                        + (-(frame.seconds() - 4.0 * 60.0 / 131.0).abs() * 32.0).exp() * 0.55,
                ),
        );
        svgr!(<image href={image.href()} x="0" y="0" width="1920" height="1080"/>)
    }
}
