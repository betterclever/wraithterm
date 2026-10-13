//! A 40.067 s, 1080p60 product film. Windows move on independent 3D planes.
use fframes::{
    AudioMap, AudioTimestamp, AudioTrack, Color, Duration, FFramesContext, FFramesSyncedVideoFrame,
    Frame, Scene, Scenes, Shader, ShaderUniforms, Svgr, SyncVideoFrameInput, Video,
    animation::{Easing, KeyFramesAnimation},
    svgr,
};
const FONT: &str = "Manrope ExtraLight";
const MONO: &str = "JetBrains Mono";
const INK: &str = "#f5ece3";
const AMBER: &str = "#ffb86b";
pub const SOURCE_CUES: [usize; 16] = [
    0, 36, 72, 150, 240, 324, 420, 480, 570, 705, 789, 870, 948, 1056, 1128, 1202,
];
const NAMES: [&str; 15] = [
    "Forge",
    "Wraith",
    "Cells",
    "Constellation",
    "Monitor",
    "RetainedRows",
    "Pipes",
    "Seam",
    "Flow",
    "Signals",
    "Frequency",
    "Install",
    "Unfold",
    "Hardware",
    "Signature",
];
pub struct VelocityVideo {
    shots: Vec<Shot>,
}
impl VelocityVideo {
    pub fn new() -> Self {
        let metal = Shader::sksl(include_str!("shaders/velocity-metal.sksl"));
        let panel = Shader::sksl(include_str!("shaders/velocity-panel.sksl"));
        let shots=(0..15).map(|i|{
            let frames=(SOURCE_CUES[i+1]-SOURCE_CUES[i])*2;
            let end=frames as f32/60.0;
            Shot{index:i,frames,metal:metal.clone(),panel:panel.clone(),
                enter:fframes::timeline!(at 0.0 => 0.9, animate 0.0 => 1.0,Easing::CubicBezier(0.16,1.0,0.3,1.0)),
                travel:fframes::timeline!(at 0.0 => end, animate 0.0 => 1.0,Easing::CubicBezier(0.35,0.0,0.65,1.0))}
        }).collect();
        Self { shots }
    }
    pub fn shaders(&self) -> Vec<&Shader> {
        vec![&self.shots[0].metal, &self.shots[0].panel]
    }
}
impl Default for VelocityVideo {
    fn default() -> Self {
        Self::new()
    }
}
impl Video for VelocityVideo {
    const FPS: usize = 60;
    const WIDTH: usize = 1920;
    const HEIGHT: usize = 1080;
    const BACKGROUND_COLOR: Color = Color::BLACK;
    fn duration(&self) -> Duration<'_> {
        Duration::Frames(2404)
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
            "velocity-score.wav",
            AudioTimestamp::Second(0.0)..AudioTimestamp::Eof,
        )])
    }
    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let scenes = ctx.render_scenes(&frame);
        svgr!(<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="#020202" />{scenes}</svg>)
    }
}
struct Shot {
    index: usize,
    frames: usize,
    metal: Shader,
    panel: Shader,
    enter: KeyFramesAnimation<f32>,
    travel: KeyFramesAnimation<f32>,
}
impl std::fmt::Debug for Shot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct(NAMES[self.index])
            .field("frames", &self.frames)
            .finish()
    }
}
impl Scene for Shot {
    fn name(&self) -> &'static str {
        NAMES[self.index]
    }
    fn duration(&self) -> Duration<'_> {
        Duration::Frames(self.frames)
    }
    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        let a = frame.animate(&self.enter);
        let k = frame.animate(&self.travel);
        match self.index {
            0 => self.object(
                &frame,
                0.0,
                [-0.7 + k * 0.4, 0.15, 1.5 + k * 0.8],
                [0.0, 0.0],
            ),
            1 => {
                let object = self.object(&frame, 0.0, [0.45 - k * 0.2, 0.2, 7.2], [0.0, -0.1]);
                svgr!(<g>{object}<text x="960" y="850" font-family={FONT} font-weight="800" font-size="100" letter-spacing="-3" fill={INK} text-anchor="middle">"WRAITH"</text></g>)
            }
            2 => self.window(
                &frame,
                ctx,
                Pose::new(
                    "velocity-plasma.mp4",
                    [0.2 - k * 0.5, 0.0, 2.2],
                    [5.6, 3.2],
                    [0.08, 0.35 - k * 0.15, -0.05],
                )
                .crop([0.15, 0.2, 0.65, 0.65]),
            ),
            3 => {
                let mut poses = Vec::new();
                for i in 0..5 {
                    let j = i as f32;
                    let x = (j - 2.0) * 1.12 + 0.3 * (t * 0.4 + j).sin();
                    let y = (j * 1.7).sin() * 0.75;
                    let z = -2.8 + (j * 1.3).cos() * 0.8 + a * 0.8 + k * 0.55;
                    let file = if i % 2 == 0 {
                        "velocity-dashboard.mp4"
                    } else {
                        "velocity-plasma.mp4"
                    };
                    poses.push(Pose::new(
                        file,
                        [x, y, z],
                        [1.65 + k * 0.25, 1.0 + k * 0.15],
                        [-0.12, 0.18 * (j - 2.0), 0.055 * (j - 2.0)],
                    ));
                }
                poses.sort_by(|left, right| left.center[2].total_cmp(&right.center[2]));
                let layers = poses
                    .into_iter()
                    .map(|pose| self.window(&frame, ctx, pose))
                    .collect::<Vec<_>>();
                svgr!(<g>{layers}</g>)
            }
            4 => {
                let back = self.window(
                    &frame,
                    ctx,
                    Pose::new(
                        "velocity-plasma.mp4",
                        [-2.2 + a * 0.6, 0.25, -1.5],
                        [4.8, 2.7],
                        [0.02, 0.4, -0.04],
                    )
                    .opacity(0.65),
                );
                let main = self.window(
                    &frame,
                    ctx,
                    Pose::new(
                        "velocity-dashboard.mp4",
                        [0.6 - k * 0.2, -0.05, 0.6],
                        [4.8, 2.7],
                        [0.04, -0.18, -0.015],
                    ),
                );
                svgr!(<g>{back}{main}</g>)
            }
            5 => {
                let mut rows = Vec::new();
                for i in (0..7).rev() {
                    let j = i as f32;
                    rows.push(
                        self.window(
                            &frame,
                            ctx,
                            Pose::new(
                                "velocity-dashboard.mp4",
                                [
                                    0.18 * j - 0.5 + (1.0 - a) * j * 0.25,
                                    0.9 - j * 0.3,
                                    -0.12 * j,
                                ],
                                [4.3, 0.31],
                                [0.025, 0.24 - k * 0.16, -0.025],
                            )
                            .crop([0.01, 0.03 + j * 0.115, 0.98, 0.11]),
                        ),
                    );
                }
                svgr!(<g>{rows}</g>)
            }
            6 => self.window(
                &frame,
                ctx,
                Pose::new(
                    "velocity-pipes.mp4",
                    [-0.1 + k * 0.2, 0.0, 0.8 + k * 0.3],
                    [4.8, 2.7],
                    [-0.07, 0.18 - k * 0.16, 0.0],
                ),
            ),
            7 => self.object(&frame, 1.0, [-0.9 + k * 0.45, 0.48, 1.9], [0.15, -0.1]),
            8 => {
                let ring = self.object(
                    &frame,
                    1.0,
                    [-0.45 + k * 0.7, 0.4 - k * 0.1, 3.6],
                    [0.0, 0.0],
                );
                let lights=(0..3).map(|i|{let phase=t*0.75+i as f32*2.1;let x=960.0+610.0*phase.cos();let y=540.0+300.0*phase.sin();
                    svgr!(<g><circle cx={x} cy={y} r="16" fill={AMBER} opacity="0.05" /><circle cx={x} cy={y} r="4" fill="#ffe2bd" /></g>)}).collect::<Vec<_>>();
                svgr!(<g>{ring}{lights}</g>)
            }
            9 => {
                let far = self.window(
                    &frame,
                    ctx,
                    Pose::new(
                        "velocity-dashboard.mp4",
                        [-2.7 + k * 0.4, 1.7, -1.4],
                        [3.5, 2.0],
                        [0.1, 0.3, -0.05],
                    )
                    .opacity(0.5),
                );
                let middle = self.window(
                    &frame,
                    ctx,
                    Pose::new(
                        "velocity-pipes.mp4",
                        [1.7, -0.6, 0.2],
                        [4.0, 2.3],
                        [0.04, -0.2, 0.025],
                    ),
                );
                let near = self.window(
                    &frame,
                    ctx,
                    Pose::new(
                        "velocity-dashboard.mp4",
                        [-1.6 + a * 0.3, -0.8, 1.6],
                        [2.9, 1.65],
                        [0.03, 0.28, -0.04],
                    )
                    .crop([0.0, 0.0, 0.48, 0.7]),
                );
                svgr!(<g>{far}{middle}{near}</g>)
            }
            10 => self.window(
                &frame,
                ctx,
                Pose::new(
                    "velocity-dashboard.mp4",
                    [0.1 - k * 0.3, 0.1, 2.0],
                    [5.2, 2.95],
                    [0.0, 0.2 - k * 0.12, -0.04],
                )
                .crop([0.0, 0.0, 0.33, 0.5]),
            ),
            11 => {
                let background = self.object(&frame, 1.0, [0.2 + k * 0.15, 0.45, 2.7], [0.0, 0.35]);
                let typed = "npm i wraithterm"
                    .chars()
                    .take((t * 20.0) as usize)
                    .collect::<String>();
                let x = 525.0 + typed.len() as f32 * 52.8;
                svgr!(<g>{background}<rect x="420" y="416" width="1080" height="224" rx="22" fill="#070504" fill-opacity="0.95" stroke="#5f3a22" />
                    <text x="466" y="554" font-family={MONO} font-size="64" fill={AMBER}>"$"</text><text x="525" y="554" font-family={MONO} font-size="88" fill={INK}>{typed}</text>
                    <rect x={x} y="486" width="4" height="85" fill={AMBER} opacity={if(t*2.0)as usize%2==0{1.0}else{0.35}} /></g>)
            }
            12 => {
                let back = self.window(
                    &frame,
                    ctx,
                    Pose::new(
                        "velocity-pipes.mp4",
                        [1.55 * (1.0 - a), 0.65 * (1.0 - a), -1.0],
                        [4.7, 2.7],
                        [0.0, -0.2 * (1.0 - a), 0.04],
                    ),
                );
                let main = self.window(
                    &frame,
                    ctx,
                    Pose::new(
                        "velocity-dashboard.mp4",
                        [-1.2 * (1.0 - a), -0.15, 0.8 + k * 0.35],
                        [5.35, 3.05],
                        [0.04 * (1.0 - a), 0.34 * (1.0 - a), -0.035 * (1.0 - a)],
                    ),
                );
                svgr!(<g>{back}{main}</g>)
            }
            13 => self.object(&frame, 2.0, [0.7 - k * 0.45, 0.38, 5.8], [-0.15, 0.0]),
            _ => {
                let ambient = self.object(&frame, 0.0, [0.3, 0.1, 6.5], [-0.49, 0.0]);
                svgr!(<g>{ambient}<g opacity={frame.animate(fframes::timeline!(at 0.0 => 0.35, animate 0.0 => 1.0,Easing::EaseOut))}>
                    <text x="1160" y="576" font-family={FONT} font-weight="800" font-size="168" letter-spacing="-6" fill={INK} text-anchor="middle">"WRAITH"</text>
                    <text x="1160" y="665" font-family={MONO} font-size="38" fill={AMBER} text-anchor="middle">"wraithterm.com"</text></g></g>)
            }
        }
    }
}
struct Pose {
    file: &'static str,
    center: [f32; 3],
    size: [f32; 2],
    angles: [f32; 3],
    crop: [f32; 4],
    opacity: f32,
}
impl Pose {
    fn new(file: &'static str, center: [f32; 3], size: [f32; 2], angles: [f32; 3]) -> Self {
        Self {
            file,
            center,
            size,
            angles,
            crop: [0.0, 0.0, 1.0, 1.0],
            opacity: 1.0,
        }
    }
    fn crop(mut self, crop: [f32; 4]) -> Self {
        self.crop = crop;
        self
    }
    fn opacity(mut self, opacity: f32) -> Self {
        self.opacity = opacity;
        self
    }
}
impl Shot {
    fn object<'a>(
        &'a self,
        frame: &Frame,
        kind: f32,
        camera: [f32; 3],
        offset: [f32; 2],
    ) -> Svgr<'a> {
        let image = self.metal.draw(
            frame,
            ShaderUniforms::new()
                .float("uClock", frame.global_index as f32 / 60.0)
                .float("uKind", kind)
                .float3("uCamera", camera[0], camera[1], camera[2])
                .float2("uOffset", offset[0], offset[1]),
        );
        svgr!(<image href={image.href()} x="0" y="0" width="1920" height="1080" />)
    }
    fn window<'a>(&'a self, frame: &Frame, ctx: &FFramesContext<'a, '_>, pose: Pose) -> Svgr<'a> {
        let input = SyncVideoFrameInput {
            start_from: 0.0,
            looping: true,
            editor_fallback_image: None,
        };
        let Some(clip) = frame.get_synced_video_frame(ctx, pose.file, &input) else {
            return Svgr::empty();
        };
        let size = [clip.width() as f32, clip.height() as f32];
        let source = clip.into_image();
        let image = self.panel.draw(
            frame,
            ShaderUniforms::new()
                .image("uSource", &source)
                .float2("uSourceSize", size[0], size[1])
                .float3("uCenter", pose.center[0], pose.center[1], pose.center[2])
                .float2("uSize", pose.size[0], pose.size[1])
                .float3("uAngles", pose.angles[0], pose.angles[1], pose.angles[2])
                .float4(
                    "uCrop",
                    pose.crop[0],
                    pose.crop[1],
                    pose.crop[2],
                    pose.crop[3],
                )
                .float("uOpacity", pose.opacity),
        );
        svgr!(<image href={image.href()} x="0" y="0" width="1920" height="1080" />)
    }
}
