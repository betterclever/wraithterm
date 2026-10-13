//! A product-led film: evidence, actual terminal output, adoption, then a clear CTA.
use fframes::{
    AudioMap, AudioTimestamp, AudioTrack, Color, Duration, FFramesContext, FFramesSyncedVideoFrame,
    Frame, Scene, Scenes, Shader, ShaderUniforms, Svgr, SyncVideoFrameInput, Transform, Video,
    animation::{Easing, KeyFramesAnimation},
    svgr,
};
const HEAD: &str = "Manrope ExtraLight";
const MONO: &str = "JetBrains Mono";
const INK: &str = "#f5ece3";
const AMBER: &str = "#ffb86b";
const DIM: &str = "#baaa9e";
const CUES: [usize; 9] = [0, 240, 480, 840, 1200, 1440, 1740, 2040, 2400];
const NAMES: [&str; 8] = [
    "SameOutput",
    "MeetWraith",
    "RealTerminal",
    "MeasuredAdvantage",
    "ChangedRows",
    "KeepYourCode",
    "GoGhostty",
    "TryWraith",
];

pub struct ProductVideo {
    shots: Vec<ProductShot>,
    fog: Shader,
}
impl Default for ProductVideo {
    fn default() -> Self {
        Self::new()
    }
}
impl ProductVideo {
    pub fn new() -> Self {
        let shots = (0..NAMES.len()).map(|id| ProductShot {
            id,
            enter: fframes::timeline!(at 0.0 => 0.6, animate 0.0 => 1.0, Easing::CubicBezier(0.16, 1.0, 0.3, 1.0)),
            detail: fframes::timeline!(at 0.25 => 1.0, animate 0.0 => 1.0, Easing::CubicBezier(0.16, 1.0, 0.3, 1.0)),
            change: fframes::timeline!(at 0.7 => 1.3, animate 0.0 => 1.0, Easing::CubicBezier(0.16, 1.0, 0.3, 1.0)),
        }).collect();
        Self {
            shots,
            fog: Shader::sksl(crate::FOG),
        }
    }
    pub fn shaders(&self) -> Vec<&Shader> {
        vec![&self.fog]
    }
}
impl Video for ProductVideo {
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
        AudioMap::from([AudioTrack::new(
            "product-score.wav",
            AudioTimestamp::Second(0.)..AudioTimestamp::Eof,
        )
        .gain_db(-0.8)])
    }
    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let fog = self.fog.draw(
            &frame,
            ShaderUniforms::new()
                .float("uEnergy", 0.35)
                .float("uFlash", 0.),
        );
        let scenes = ctx.render_scenes(&frame);
        svgr!(<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
            <defs>
                <linearGradient id="spectral" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#ffb86b"/><stop offset="0.55" stop-color="#ff7f6e"/><stop offset="1" stop-color="#d9bbff"/></linearGradient>
                <radialGradient id="halo"><stop offset="0" stop-color="#ff9a4a" stop-opacity="0.45"/><stop offset="1" stop-color="#ff9a4a" stop-opacity="0"/></radialGradient>
            </defs>
            <rect width="1920" height="1080" fill="#0c0806"/>
            <image href={fog.href()} x="0" y="0" width="1920" height="1080"/>
            {scenes}
        </svg>)
    }
}
#[derive(Debug)]
struct ProductShot {
    id: usize,
    enter: KeyFramesAnimation<f32>,
    detail: KeyFramesAnimation<f32>,
    change: KeyFramesAnimation<f32>,
}
impl Scene for ProductShot {
    fn name(&self) -> &'static str {
        NAMES[self.id]
    }
    fn duration(&self) -> Duration<'_> {
        Duration::Frames(CUES[self.id + 1] - CUES[self.id])
    }
    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        let a = frame.animate(&self.enter);
        let detail = frame.animate(&self.detail);
        let change = frame.animate(&self.change);
        match self.id {
            0 => {
                let left = footage(&frame, ctx, "dom.mp4", 160., 360., 760., "dom-view");
                let right = footage(&frame, ctx, "wraith.mp4", 1000., 360., 760., "wraith-view");
                svgr!(<g>
                    <text x="960" y="190" text-anchor="middle" font-family={HEAD} font-weight="800" font-size="116" letter-spacing="-4" fill={INK}>"Same output. Less CPU."</text>
                    <text x="160" y="307" font-family={MONO} font-size="32" fill={DIM}>"xterm.js · DOM"</text>
                    <text x="1000" y="307" font-family={MONO} font-size="32" fill={AMBER}>"Wraith · xterm-compatible"</text>
                    {left}{right}
                    <text x="160" y="920" font-family={HEAD} font-weight="800" font-size="108" fill="#ff7f6e">"37.7 ms"</text>
                    <text x="1000" y="920" font-family={HEAD} font-weight="800" font-size="108" fill={AMBER}>"2.5 ms"</text>
                    <text x="160" y="978" font-family={MONO} font-size="30" fill={DIM}>"CPU per dense update¹"</text>
                    <text x="1000" y="978" font-family={MONO} font-size="30" fill={DIM}>"CPU per dense update¹"</text>
                    <text x="960" y="1036" text-anchor="middle" font-family={MONO} font-size="28" fill={DIM}>"¹ Recorded benchmark · 240×80 · Chrome 155 · M5 Max · c6a77bd"</text>
                </g>)
            }
            1 => {
                let mark = crate::wordmark(
                    frame.global_index as f32 / 60.,
                    t + 0.08,
                    960.,
                    430.,
                    14.2,
                    0.8,
                    0.,
                );
                svgr!(<g>{mark}
                    <g opacity={detail} transform={Transform::translate(0, 35. * (1.-detail))}>
                        <text x="960" y="745" text-anchor="middle" font-family={HEAD} font-weight="800" font-size="82" letter-spacing="-2" fill={INK}>"Spooky fast web terminal."</text>
                        <text x="960" y="830" text-anchor="middle" font-family={MONO} font-size="36" fill={AMBER}>"Rust · Wasm · WebGPU"</text>
                    </g>
                </g>)
            }
            2 => {
                let dashboard =
                    footage(&frame, ctx, "dashboard.mp4", 320., 230., 1280., "live-view");
                svgr!(<g>
                    {headline("A real terminal. Under pressure.", 104., a)}
                    <g transform={Transform::translate(0, 45. * (1.-a))}>{dashboard}</g>
                    <text x="960" y="1010" text-anchor="middle" font-family={MONO} font-size="32" fill={DIM}>"Recorded in Wraith · Ghostty worker · WebGPU"</text>
                </g>)
            }
            3 => proof(a, detail),
            4 => changed_rows(t, a, change),
            5 => keep_code(a, change),
            6 => native(a, detail),
            _ => {
                let mark = crate::wordmark(
                    frame.global_index as f32 / 60.,
                    t + 0.3,
                    960.,
                    330.,
                    12.8,
                    0.6,
                    0.,
                );
                svgr!(<g>{mark}
                    <g opacity={a} transform={Transform::translate(0, 35.*(1.-a))}>
                        <text x="960" y="645" text-anchor="middle" font-family={HEAD} font-weight="800" font-size="104" fill="url(#spectral)" letter-spacing="-3">"Try it. Race it."</text>
                        <text x="960" y="755" text-anchor="middle" font-family={HEAD} font-weight="800" font-size="76" fill={INK}>"wraithterm.com"</text>
                        <rect x="650" y="823" width="620" height="94" rx="18" fill="#17100c" stroke="#725443"/>
                        <text x="960" y="884" text-anchor="middle" font-family={MONO} font-size="40" fill={AMBER}>"npm i wraithterm"</text>
                        <text x="960" y="992" text-anchor="middle" font-family={MONO} font-size="30" fill={DIM}>"Open source · MIT"</text>
                    </g>
                </g>)
            }
        }
    }
}
fn headline<'a>(text: &'a str, size: f32, opacity: f32) -> Svgr<'a> {
    svgr!(<text x="960" y="166" text-anchor="middle" font-family={HEAD} font-weight="800" font-size={size} letter-spacing="-3" fill={INK} opacity={opacity}>{text}</text>)
}
fn footage<'a>(
    frame: &Frame,
    ctx: &FFramesContext<'a, '_>,
    file: &'static str,
    x: f32,
    y: f32,
    w: f32,
    id: &'static str,
) -> Svgr<'a> {
    let input = SyncVideoFrameInput {
        start_from: 0.,
        looping: true,
        editor_fallback_image: None,
    };
    let Some(clip) = frame.get_synced_video_frame(ctx, file, &input) else {
        return Svgr::empty();
    };
    let h = w * 9. / 16.;
    svgr!(<g>
        <defs><clipPath id={id}><rect x={x} y={y} width={w} height={h} rx="16"/></clipPath></defs>
        <rect x={x-2.} y={y-2.} width={w+4.} height={h+4.} rx="18" fill="#130c09" stroke="#8d6145" stroke-width="2"/>
        <image href={clip.into_image().href()} x={x} y={y} width={w} height={h} clip-path={format!("url(#{id})")}/>
    </g>)
}
fn proof<'a>(a: f32, detail: f32) -> Svgr<'a> {
    let lanes = [
        ("xterm.js DOM", 37.7, "#6c4a3c"),
        ("xterm.js + WebGL", 9.8, "#ad7a5c"),
        ("Wraith / xterm", 2.5, "url(#spectral)"),
    ];
    let bars = lanes.into_iter().enumerate().map(|(i,(label,ms,color))| {
        let y = 350. + i as f32 * 190.;
        let w = (540. * ms / 37.7 * detail).max(0.5);
        svgr!(<g>
            <text x="160" y={y+45.} font-family={HEAD} font-size="44" font-weight="800" fill={INK}>{label}</text>
            <rect x="585" y={y} width="540" height="66" rx="9" fill="#21150f"/>
            <rect x="585" y={y} width={w} height="66" rx="9" fill={color}/>
            <text x="1170" y={y+48.} font-family={MONO} font-size="36" fill={if i==2{AMBER}else{INK}}>{format!("{ms:.1} ms")}</text>
        </g>)
    }).collect::<Vec<_>>();
    svgr!(<g>
        {headline("Spend less CPU on your terminal.", 96., a)}
        <text x="160" y="258" font-family={MONO} font-size="32" fill={DIM}>"CPU per update · lower is better"</text>
        {bars}
        <g opacity={detail}>
            <text x="1580" y="405" text-anchor="middle" font-family={HEAD} font-size="110" font-weight="800" fill="url(#spectral)">"15×"</text>
            <text x="1580" y="467" text-anchor="middle" font-family={MONO} font-size="28" fill={INK}>"less than DOM"</text>
            <text x="1580" y="640" text-anchor="middle" font-family={HEAD} font-size="110" font-weight="800" fill={INK}>"3.9×"</text>
            <text x="1580" y="702" text-anchor="middle" font-family={MONO} font-size="28" fill={INK}>"less than WebGL"</text>
        </g>
        <text x="160" y="910" font-family={MONO} font-size="28" fill={DIM}>"240×80 cells · ~4,800 style changes · DPR 1 · medians"</text>
        <text x="160" y="956" font-family={MONO} font-size="28" fill={DIM}>"Chrome 155 · Apple M5 Max · launch build c6a77bd"</text>
        <text x="160" y="1002" font-family={MONO} font-size="28" fill={DIM}>"GPU-completed updates · docs/benchmarks/launch"</text>
    </g>)
}
fn changed_rows<'a>(t: f32, a: f32, change: f32) -> Svgr<'a> {
    let cells = (0..12).flat_map(|row| (0..32).map(move |col| {
        let edited = row==5 && col==18;
        let x = 190.+col as f32*29.;
        let y = 355.+row as f32*36.;
        svgr!(<rect x={x} y={y} width="21" height="23" rx="3" fill={if edited && t>0.7{AMBER}else{"#685043"}} opacity={if row==5{0.55+0.45*change}else{0.5}}/>)
    })).collect::<Vec<_>>();
    svgr!(<g>
        {headline("Change one cell. Upload one row.", 100., a)}
        <rect x="160" y="315" width="1020" height="500" rx="22" fill="#130c09" stroke="#604333"/>
        <rect x="180" y="528" width="973" height="35" rx="5" fill={AMBER} opacity={0.13*change}/>
        {cells}
        <g opacity={change} transform={Transform::translate(35.*(1.-change),0)}>
            <path d="M1210 547 H1320 M1295 522 L1320 547 L1295 572" stroke={AMBER} stroke-width="6" fill="none"/>
            <rect x="1380" y="510" width="360" height="75" rx="12" fill="#332216" stroke={AMBER}/>
            <text x="1560" y="559" text-anchor="middle" font-family={MONO} font-size="32" fill={AMBER}>"GPU row"</text>
        </g>
        <text x="960" y="920" text-anchor="middle" font-family={MONO} font-size="34" fill={DIM}>"Clean rows stay on the GPU."</text>
        <text x="960" y="998" text-anchor="middle" font-family={MONO} font-size="28" fill={DIM}>"Retained GPU rows"</text>
    </g>)
}
fn keep_code<'a>(a: f32, change: f32) -> Svgr<'a> {
    svgr!(<g>
        {headline("Keep your xterm.js code.", 112., a)}
        <rect x="160" y="290" width="1600" height="545" rx="24" fill="#130c09" stroke="#76523d"/>
        <text x="210" y="370" font-family={MONO} font-size="32" fill={DIM}>"terminal.ts"</text>
        <text x="210" y="470" font-family={MONO} font-size="42" fill="#d9bbff">"import { Terminal } from"</text>
        <g opacity={1.-change}><text x="900" y="470" font-family={MONO} font-size="42" fill={DIM}>"'@xterm/xterm';"</text></g>
        <g opacity={change}>
            <rect x="890" y="426" width="526" height="60" rx="8" fill="#37261a"/>
            <text x="900" y="470" font-family={MONO} font-size="42" fill={AMBER}>"'wraithterm/xterm';"</text>
        </g>
        <g opacity={1.-change}><text x="210" y="545" font-family={MONO} font-size="34" fill={DIM}>"import '@xterm/xterm/css/xterm.css';"</text></g>
        <g opacity={change}><text x="210" y="545" font-family={MONO} font-size="34" fill={DIM}>"import 'wraithterm/css/xterm.css';"</text></g>
        <text x="210" y="655" font-family={MONO} font-size="42" fill={INK}>"const term = new Terminal();"</text>
        <text x="210" y="725" font-family={MONO} font-size="42" fill={INK}>"term.open(element);"</text>
        <text x="210" y="795" font-family={MONO} font-size="42" fill={INK}>"term.write(data);"</text>
        <text x="960" y="934" text-anchor="middle" font-family={HEAD} font-weight="800" font-size="44" fill={AMBER}>"Swap the import. Keep building."</text>
        <text x="960" y="1004" text-anchor="middle" font-family={MONO} font-size="28" fill={DIM}>"xterm.js 6.0 API · Fit / Search / Serialize addons"</text>
    </g>)
}
fn native<'a>(a: f32, detail: f32) -> Svgr<'a> {
    svgr!(<g>
        {headline("Or bring Ghostty to the web.", 108., a)}
        <rect x="160" y="294" width="1600" height="232" rx="24" fill="#130c09" stroke="#76523d"/>
        <text x="210" y="388" font-family={MONO} font-size="42" fill="#d9bbff">"import { Wraith } from 'wraithterm';"</text>
        <text x="210" y="466" font-family={MONO} font-size="42" fill={INK}>"const term = await Wraith.mount(element);"</text>
        <g opacity={detail} transform={Transform::translate(0,35.*(1.-detail))}>
            <rect x="160" y="638" width="490" height="190" rx="24" fill="#20140e" stroke="#6e4d3b"/>
            <text x="405" y="718" text-anchor="middle" font-family={HEAD} font-size="50" font-weight="800" fill={INK}>"Your app"</text>
            <text x="405" y="780" text-anchor="middle" font-family={MONO} font-size="28" fill={DIM}>"main thread"</text>
            <path d="M690 733 H790 M765 708 L790 733 L765 758" stroke={AMBER} stroke-width="5" fill="none"/>
            <rect x="830" y="638" width="930" height="190" rx="24" fill="#23170f" stroke={AMBER}/>
            <text x="1295" y="714" text-anchor="middle" font-family={HEAD} font-size="50" font-weight="800" fill={AMBER}>"Ghostty + Rust + WebGPU"</text>
            <text x="1295" y="780" text-anchor="middle" font-family={MONO} font-size="28" fill={DIM}>"one Wasm module · dedicated worker"</text>
        </g>
        <text x="960" y="968" text-anchor="middle" font-family={HEAD} font-size="48" font-weight="800" fill={INK}>"Keep your main thread for your app."</text>
    </g>)
}
