//! Phantom: real terminal footage, physical studio plates, and connected camera moves.
//! Captured terminal frames are footage, not a claim about display refresh or benchmark FPS.
use fframes::{
    AudioMap, AudioTimestamp, AudioTrack, Color, Duration, FFramesContext, FFramesSyncedVideoFrame,
    FontQuery, Frame, Scene, Scenes, Shader, ShaderUniforms, Svgr, SyncVideoFrameInput, Transform,
    Video,
    animation::{Easing, KeyFramesAnimation},
    svgr,
};
const MONO: &str = "JetBrains Mono";
const CUES: [usize; 15] = [
    0, 240, 360, 510, 660, 810, 960, 1080, 1200, 1440, 1620, 1770, 1980, 2190, 2400,
];
const NAMES: [&str; 14] = [
    "MachinedCells",
    "IntoTheGrid",
    "CellField",
    "Dashboard",
    "Peel",
    "Orbit",
    "Pipes",
    "Signal",
    "Current",
    "Retained",
    "Install",
    "Converge",
    "Layers",
    "Wraith",
];
const DASH: &str = "velocity-dashboard.mp4";
const PIPES: &str = "velocity-pipes.mp4";
const PLASMA: &str = "velocity-plasma.mp4";
pub struct PhantomVideo {
    shots: Vec<Shot>,
}
impl Default for PhantomVideo {
    fn default() -> Self {
        Self::new()
    }
}
impl PhantomVideo {
    pub fn new() -> Self {
        let panel = Shader::sksl(include_str!("shaders/phantom-panel.sksl"));
        let shots = (0..NAMES.len())
            .map(|id| {
                let duration = (CUES[id + 1] - CUES[id]) as f32 / 60.;
                Shot {
                    id,
                    panel: panel.clone(),
                    enter: fframes::timeline!(at 0.0 => 1.05, animate 0.0 => 1.0, Easing::CubicBezier(0.16, 1.0, 0.3, 1.0)),
                    travel: fframes::timeline!(at 0.0 => duration, animate 0.0 => 1.0, Easing::CubicBezier(0.45, 0.0, 0.55, 1.0)),
                    exit: fframes::timeline!(at (duration - 0.65) => duration, animate 0.0 => 1.0, Easing::CubicBezier(0.65, 0.0, 0.9, 0.5)),
                }
            })
            .collect();
        Self { shots }
    }
    pub fn shaders(&self) -> Vec<&Shader> {
        vec![&self.shots[0].panel]
    }
}
impl Video for PhantomVideo {
    const FPS: usize = 60;
    const WIDTH: usize = 1920;
    const HEIGHT: usize = 1080;
    const BACKGROUND_COLOR: Color = Color::BLACK;
    fn duration(&self) -> Duration<'_> {
        Duration::Frames(2400)
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
        // Reserve headroom for the AAC encoder's measured intersample overshoot.
        AudioMap::from([AudioTrack::new(
            "phantom-score.wav",
            AudioTimestamp::Second(0.)..AudioTimestamp::Eof,
        )
        .gain_db(-0.8)])
    }
    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let scene = ctx.render_scenes(&frame);
        svgr!(<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
   <defs><radialGradient id="halo"><stop offset="0" stop-color="#663626" stop-opacity="0.25"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
   <linearGradient id="phantom-ink" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#fff0da"/><stop offset="0.5" stop-color="#ffb86b"/><stop offset="1" stop-color="#d9bbff"/></linearGradient></defs>
   <rect width="1920" height="1080" fill="#020101"/>{scene}</svg>)
    }
}
struct Shot {
    id: usize,
    panel: Shader,
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
    size: [f32; 2],
    angles: [f32; 3],
    crop: [f32; 4],
    opacity: f32,
    chrome: f32,
}
impl Pose {
    fn new(file: &'static str, center: [f32; 3], size: [f32; 2], angles: [f32; 3]) -> Self {
        Self {
            file,
            center,
            size,
            angles,
            crop: [0., 0., 1., 1.],
            opacity: 1.,
            chrome: 1.,
        }
    }
    fn crop(mut self, v: [f32; 4]) -> Self {
        self.crop = v;
        self.chrome = 0.;
        self
    }
    fn opacity(mut self, v: f32) -> Self {
        self.opacity = v;
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
    fn render_frame<'a>(&'a self, mut frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        let a = frame.animate(&self.enter);
        let k = frame.animate(&self.travel);
        let e = frame.animate(&self.exit);
        let atmosphere = svgr!(<ellipse cx={960.+(t*0.3).sin()*160.} cy="620" rx="950" ry="550" fill="url(#halo)"/>);
        let contents = match self.id {
            0 => self.plate(&frame, ctx, "phantom-mark.mp4"),
            1 => {
                let window = self.window(
                    &frame,
                    ctx,
                    Pose::new(
                        PLASMA,
                        [-0.25 + 0.25 * k, 0.05, 3.25 - 2.1 * a + e * 0.5],
                        [5.4, 3.05],
                        [0.16 * (1. - a), -0.5 + 0.4 * a, -0.07 + 0.06 * a],
                    ),
                );
                svgr!(<g>{window}</g>)
            }
            2 => {
                // Independent cells arc past the lens, then align into three terminals.
                let mut poses = Vec::new();
                for i in 0..9 {
                    let j = i as f32;
                    let col = (i % 3) as f32 - 1.;
                    let row = (i / 3) as f32 - 1.;
                    poses.push(Pose::new(
                        if i % 3 == 0 {
                            PIPES
                        } else if i % 3 == 1 {
                            DASH
                        } else {
                            PLASMA
                        },
                        [
                            col * (2.8 - 0.3 * k) + (1. - a) * (j - 4.) * 0.4,
                            row * 1.75 + (1. - a) * (j * 1.5).sin(),
                            -1.5 + (j * 0.8).sin() * 0.7 + e * 2.5,
                        ],
                        [2.55, 1.46],
                        [0.09 * row, -0.15 * col * (1. - k), 0.055 * col * (1. - k)],
                    ));
                }
                self.windows(&frame, ctx, poses)
            }
            3 => {
                let back = self.window(
                    &frame,
                    ctx,
                    Pose::new(PLASMA, [-3.1, 0.6, -2.], [5.4, 3.06], [0.06, 0.35, -0.04])
                        .opacity(0.4),
                );
                let main = self.window(
                    &frame,
                    ctx,
                    Pose::new(
                        DASH,
                        [0.65 - 0.55 * a, -0.04, 0.4 - 0.55 * k],
                        [5.0, 2.84],
                        [0.12 - 0.10 * a, -0.36 + 0.31 * a, -0.045 + 0.035 * a],
                    ),
                );
                svgr!(<g>{back}{main}</g>)
            }
            4 => {
                let mut poses = Vec::new();
                for i in 0..3 {
                    let j = i as f32;
                    let spread = a * (0.85 + e * 0.7);
                    poses.push(
                        Pose::new(
                            DASH,
                            [
                                (j - 1.) * (1.8 + spread * 0.38),
                                0.10 * (j - 1.) * spread,
                                (j - 1.) * 0.5 * spread + 0.95,
                            ],
                            [1.8, 3.06],
                            [0.035 * (j - 1.), -0.07 + (j - 1.) * 0.2 * spread, 0.],
                        )
                        .crop([j / 3., 0., 1. / 3., 1.]),
                    );
                }
                self.windows(&frame, ctx, poses)
            }
            5 => {
                let back = self.window(
                    &frame,
                    ctx,
                    Pose::new(
                        DASH,
                        [-2.6 - k * 0.8, 0.2, -1.2],
                        [4.8, 2.74],
                        [0.05, 0.42, -0.025],
                    )
                    .opacity(0.65),
                );
                let main = self.window(
                    &frame,
                    ctx,
                    Pose::new(
                        PIPES,
                        [1.4 - 1.25 * a, 0.0, -0.25 + 0.55 * a + 0.1 * k],
                        [5.0, 2.84],
                        [-0.12 + 0.09 * a, 0.58 - 0.48 * a, 0.045 - 0.035 * a],
                    ),
                );
                svgr!(<g>{back}{main}</g>)
            }
            6 => self.window(
                &frame,
                ctx,
                Pose::new(
                    PIPES,
                    [0.15 - 0.2 * k, 0., 0.4 + 1.7 * e],
                    [5.0, 2.84],
                    [-0.03, 0.1 - 0.12 * k, 0.01],
                ),
            ),
            7 => {
                let rows = (0..8)
                    .map(|i| {
                        let j = i as f32;
                        self.window(
                            &frame,
                            ctx,
                            Pose::new(
                                DASH,
                                [
                                    (0.5 - j / 7.) * (1. - a) * 4.,
                                    1.2 - j * 0.36,
                                    -0.2 - j * 0.09 + k * 0.8,
                                ],
                                [5.8, 0.28],
                                [0., 0.3 - 0.3 * k, -0.04],
                            )
                            .crop([
                                0.02,
                                0.05 + j * 0.105,
                                0.96,
                                0.085,
                            ]),
                        )
                    })
                    .collect::<Vec<_>>();
                svgr!(<g>{rows}</g>)
            }
            8 => self.plate(&frame, ctx, "phantom-ribbon.mp4"),
            9 => {
                let mut poses = Vec::new();
                for i in 0..6 {
                    let j = i as f32;
                    let peel = (1. - a) * (j - 2.5) * 0.55;
                    poses.push(
                        Pose::new(
                            DASH,
                            [peel + (j - 2.5) * 0.13, 1.1 - j * 0.44, 0.2 - j * 0.12],
                            [5.2, 0.38],
                            [0., 0.22 * (1. - k), -0.025],
                        )
                        .crop([0., j / 6., 1., 1. / 6.]),
                    );
                }
                self.windows(&frame, ctx, poses)
            }
            10 => {
                let cmd = "npm i wraithterm";
                let typed = &cmd[..((t * 23.).max(0.) as usize).min(cmd.len())];
                let advance = frame
                    .text_width(
                        ctx,
                        FontQuery {
                            family: MONO,
                            size: 66,
                            weight: 400,
                            ..Default::default()
                        },
                        typed,
                    )
                    .unwrap_or(0) as f32;
                svgr!(<g transform={frame.animate(fframes::timeline!(at 0.0 => 0.9,animate Transform::translate(0,80) => Transform::translate(0,0),Easing::CubicBezier(0.16,1.0,0.3,1.0)))}>
     <rect x="280" y="385" width="1360" height="290" rx="24" fill="#0d0907" stroke="#514238" stroke-width="1.5"/>
     <circle cx="320" cy="418" r="5" fill="#ffb86b"/><circle cx="343" cy="418" r="5" fill="#ffd98a"/><circle cx="366" cy="418" r="5" fill="#d9bbff"/>
     <text x="370" y="560" font-family={MONO} font-size="66" fill="#ffb86b">"❯"</text>
     <text x="450" y="560" font-family={MONO} font-size="66" fill="#f5ece3">{typed}</text>
     <rect x={460.+advance} y="505" width="30" height="64" fill="#ffb86b" opacity={if (t*2.) as usize%2==0{1.}else{0.25}}/>
    </g>)
            }
            11 => {
                let mut poses = Vec::new();
                for i in (0..5).rev() {
                    let j = i as f32;
                    let spread = 1. - a;
                    poses.push(
                        Pose::new(
                            if i == 0 {
                                DASH
                            } else if i % 2 == 0 {
                                PIPES
                            } else {
                                PLASMA
                            },
                            [
                                (j - 2.) * 1.4 * spread,
                                (j - 2.) * 0.65 * spread,
                                -j * 0.7 * spread,
                            ],
                            [5.0, 2.84],
                            [
                                j * 0.07 * spread,
                                (j - 2.) * 0.28 * spread,
                                (j - 2.) * 0.06 * spread,
                            ],
                        )
                        .opacity(if i == 0 {
                            1.
                        } else {
                            (1. - a * 0.96).max(0.0)
                        }),
                    );
                }
                self.windows(&frame, ctx, poses)
            }
            12 => self.plate(&frame, ctx, "phantom-stack.mp4"),
            _ => {
                let mark = crate::wordmark(t + 40., t + 1., 960., 450., 14.2, 0.8, 0.);
                svgr!(<g>{mark}<text x="960" y="710" font-family={MONO} font-size="46" letter-spacing="-1" text-anchor="middle" fill="url(#phantom-ink)" opacity={frame.animate(fframes::timeline!(at 0.1 => 0.55,animate 0.0 => 1.0,Easing::EaseOut))}>"wraithterm.com"</text></g>)
            }
        };
        svgr!(<g>{atmosphere}{contents}</g>)
    }
}
impl Shot {
    fn plate<'a>(
        &'a self,
        frame: &Frame,
        ctx: &FFramesContext<'a, '_>,
        file: &'static str,
    ) -> Svgr<'a> {
        let input = SyncVideoFrameInput {
            start_from: 0.,
            looping: false,
            editor_fallback_image: None,
        };
        let Some(clip) = frame.get_synced_video_frame(ctx, file, &input) else {
            return Svgr::empty();
        };
        svgr!(<image href={clip.into_image().href()} width="1920" height="1080" x="0" y="0"/>)
    }
    fn windows<'a>(
        &'a self,
        frame: &Frame,
        ctx: &FFramesContext<'a, '_>,
        mut poses: Vec<Pose>,
    ) -> Svgr<'a> {
        poses.sort_by(|a, b| a.center[2].total_cmp(&b.center[2]));
        let layers = poses
            .into_iter()
            .map(|p| self.window(frame, ctx, p))
            .collect::<Vec<_>>();
        svgr!(<g>{layers}</g>)
    }
    fn window<'a>(&'a self, frame: &Frame, ctx: &FFramesContext<'a, '_>, p: Pose) -> Svgr<'a> {
        let input = SyncVideoFrameInput {
            start_from: 0.,
            looping: true,
            editor_fallback_image: None,
        };
        let Some(clip) = frame.get_synced_video_frame(ctx, p.file, &input) else {
            return Svgr::empty();
        };
        let size = [clip.width() as f32, clip.height() as f32];
        let source = clip.into_image();
        let image = self.panel.draw(
            frame,
            ShaderUniforms::new()
                .image("uSource", &source)
                .float2("uSourceSize", size[0], size[1])
                .float3("uCenter", p.center[0], p.center[1], p.center[2])
                .float2("uSize", p.size[0], p.size[1])
                .float3("uAngles", p.angles[0], p.angles[1], p.angles[2])
                .float4("uCrop", p.crop[0], p.crop[1], p.crop[2], p.crop[3])
                .float("uOpacity", p.opacity)
                .float("uChrome", p.chrome)
                .float("uClock", frame.seconds()),
        );
        svgr!(<image href={image.href()} x="0" y="0" width="1920" height="1080"/>)
    }
}
