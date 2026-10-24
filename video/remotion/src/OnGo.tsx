import React, { useEffect, useLayoutEffect, useState } from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  staticFile,
  useCurrentFrame,
  useDelayRender,
  useRemotionEnvironment,
} from 'remotion';
import { Audio } from '@remotion/media';
import { ThreeCanvas } from '@remotion/three';
import { useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import { Browser, type BrowserPose } from './Browser';
import { Ghost } from './Ghost';
// Measured headed on a 120 Hz ProMotion panel; the film itself is 60 fps.
import wall from '../../claims/wall-comparison-120hz.json';
import music from '../../claims/ongo-music.json';
import doomPaced from '../../claims/doom-paced.json';
import workScene from '../../claims/work-scene.json';
import doomMax from '../../claims/doom-timedemo.json';

// "WE ON GO": a car-launch film where the car is a terminal. Source music runs from 0 s
// to beat 60; every cut sits on the 131-BPM grid or a measured vocal onset.
export const ONGO_FRAMES = music.frames;
const FPS = 60;
const beat = (k: number) => Math.round((music.beatPhaseSeconds + (k * 60) / music.bpm) * FPS);
const at = (seconds: number) => Math.round(seconds * FPS);
const ONE = at(music.cues.countOne),
  TWO = at(music.cues.countTwo),
  THREE = at(music.cues.countThree),
  GO = at(music.cues.goKickAndVocal);
// Her "uh-huh" ad-libs: cut on "uh", hit on "HUH".
const UH = music.cues.uhHuh.map(([uh, huh]) => [at(uh), at(huh)] as const);
const nativeWall = Math.round(wall.bounds.nativeSlowest);
const nativeRange = `${wall.bounds.nativeSlowest.toFixed(1)}–${Math.max(
  ...wall.runs.filter((r) => r.type === 'native').map((r) => r.meanFps),
).toFixed(1)}`;
const webglWall = [
  Math.floor(wall.bounds.webglSlowest),
  Math.ceil(wall.bounds.webglFastest),
] as const;

const amber = '#ffb066';
const cream = '#fff3e4';
const muted = '#cdb39c';
const mono: React.CSSProperties = { fontFamily: 'JetBrains', fontWeight: 400 };
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const outExpo = Easing.out(Easing.exp);
const inOut = Easing.inOut(Easing.cubic);
const ramp = (f: number, a: number, b: number, ease = inOut) =>
  interpolate(f, [a, b], [0, 1], { ...clamp, easing: ease });
const mix = (a: number, b: number, k: number) => a + (b - a) * k;
type V3 = [number, number, number];
const lerp3 = (a: V3, b: V3, k: number): V3 => [
  mix(a[0], b[0], k),
  mix(a[1], b[1], k),
  mix(a[2], b[2], k),
];

type Shot = {
  name: string;
  from: number;
  to: number;
  camera: (k: number, f: number) => { pos: V3; look: V3; fov?: number; roll?: number };
  slabs?: (k: number, f: number) => BrowserPose[];
  sweep?: (k: number) => number; // light sweep x position, -1..1
  ghost?: (k: number, f: number) => { position: V3; rotation: V3; scale: number } | null;
};

const slab = (
  file: string,
  position: V3,
  rotation: V3,
  extra: Partial<BrowserPose> = {},
): BrowserPose => ({ file, position, rotation, width: 6, bare: true, ...extra });
const orbit = (angle: number, radius: number, y: number, look: V3 = [0, 0, 0]): V3 => [
  look[0] + Math.sin(angle) * radius,
  y,
  look[2] + Math.cos(angle) * radius,
];

// One subject per act, seen from many angles; acts change on musical switches.
const HERO = (brightness = 1) =>
  slab('work-scene-native', [0, 0, 0], [0, 0, 0], { brightness, reflection: 0.3 });
// The wall act: Wraith's wall, and xterm's wall dark beside it until "let 'em know".
const NATIVE: V3 = [2.15, 0.25, 0];
const WALLS = (xterm = 0) => [
  slab('wall-webgl', [-2.15, 0.25, 0], [0, 0.12, 0], {
    width: 4.1,
    reflection: 0.2 * xterm,
    brightness: xterm,
  }),
  slab('wall-native', NATIVE, [0, -0.12, 0], { width: 4.1, reflection: 0.2 }),
];
// The DOOM act: one screen, first in text cells, then in Kitty graphics.
const DOOM = (file: string) => [
  slab(file, [2.5, 0.05, 0], [0, -0.38, 0], { width: 5.6, reflection: 0.25 }),
];
const tens = (v: number) => Math.floor(v / 10) * 10;
const doomTextFps = tens(doomMax.summary['text-160x50 native'].slowest);
const doomKittyFps = tens(doomMax.summary['kitty-640x400 native'].slowest);
const xtermDoomFps = Math.round(doomPaced.summary['text-160x50 webgl'].fastest);
const SIDE_END = orbit(0.7, 4.2, 0.2, NATIVE);

const SHOTS: Shot[] = [
  // Act 1: the hero terminal.
  {
    // "Honorable": the slab's edge catches a single line of light in the dark.
    name: 'Tag',
    from: 0,
    to: beat(0),
    camera: () => ({ pos: [-3.4, -0.9, 3.9], look: [0, -0.2, 0], fov: 30 }),
    slabs: () => [HERO(0.04)],
    sweep: (k) => mix(-1.4, -0.9, k),
  },
  {
    name: 'Reveal',
    from: beat(0),
    to: beat(4),
    camera: (k) => ({
      pos: lerp3([-3.4, -0.9, 3.9], [-2.1, -0.75, 3.2], inOut(k)),
      look: [0, -0.2, 0],
      fov: 30,
      roll: -0.04,
    }),
    slabs: (k) => [HERO(0.05 + 0.3 * k)],
    sweep: (k) => mix(-0.9, 1.3, k),
  },
  {
    // The screen comes fully on during a slow orbit.
    name: 'Orbit',
    from: beat(4),
    to: UH[0][0],
    camera: (k) => ({
      pos: orbit(mix(-1.05, 0.55, inOut(k)), 5.6, 0.35),
      look: [0, 0.1, 0],
      fov: 32,
    }),
    slabs: (k) => [HERO(mix(0.35, 1, ramp(k, 0.05, 0.45)))],
    sweep: (k) => mix(1.2, -1.2, k),
  },
  {
    name: 'Macro',
    from: UH[0][0],
    to: beat(12),
    camera: (k) => ({
      pos: [mix(-2.2, 2.2, inOut(k)), mix(0.35, 0.2, k), 2.6],
      look: [mix(-1.9, 2.6, inOut(k)), 0.1, 0],
      fov: 26,
      roll: 0.05,
    }),
    slabs: () => [HERO()],
  },
  {
    // Low tracking shot along the screen.
    name: 'Low',
    from: beat(12),
    to: UH[1][0],
    camera: (k) => ({
      pos: [mix(-4.2, -1, inOut(k)), -1.25, 3.3],
      look: [mix(-1.2, 0.8, inOut(k)), 0.25, 0],
      fov: 34,
      roll: -0.07,
    }),
    slabs: () => [HERO()],
  },
  {
    name: 'Crane',
    from: UH[1][0],
    to: beat(20),
    camera: (k) => {
      const e = outExpo(k);
      return {
        // Settle on the chart and preview column (screen right, upper half).
        pos: [mix(2.6, 1.9, e), mix(4.6, 0.55, e), mix(3.8, 3.0, e)],
        look: [mix(1.2, 1.7, e), mix(0.2, 0.45, e), 0],
        fov: 32,
      };
    },
    slabs: () => [HERO()],
  },
  {
    // Rear three-quarter swinging round to the front.
    name: 'Chase',
    from: beat(20),
    to: UH[2][0],
    camera: (k) => ({
      pos: orbit(mix(2.55, 0.6, inOut(k)), mix(5.2, 4.7, k), -0.45),
      look: [0, 0, 0],
      fov: 33,
      roll: 0.04,
    }),
    slabs: () => [HERO()],
    sweep: (k) => mix(-1, 1.2, k),
  },
  // The count: one code card.
  {
    name: 'Code',
    from: UH[2][0],
    to: ONE,
    camera: () => ({ pos: [0, 0, 8], look: [0, 0, 0] }),
    ghost: (k, f) => ({ position: [3.4, 0.2, -5], rotation: [0, 0.4 + f / 200, 0], scale: 0.9 }),
  },
  { name: 'One', from: ONE, to: TWO, camera: () => ({ pos: [0, 0, 8], look: [0, 0, 0] }) },
  { name: 'Two', from: TWO, to: THREE, camera: () => ({ pos: [0, 0, 8], look: [0, 0, 0] }) },
  { name: 'Three', from: THREE, to: GO, camera: () => ({ pos: [0, 0, 8], look: [0, 0, 0] }) },
  // Act 2: Wraith's wall of sixteen.
  {
    // Launch: start inside one tile, rip back to the whole wall.
    name: 'Go',
    from: GO,
    to: beat(36),
    camera: (k, f) => {
      const e = outExpo(Math.min(1, (f - GO) / 50));
      return {
        pos: [
          NATIVE[0] + mix(-0.5, 0.2, e) + 0.3 * k,
          NATIVE[1] + mix(0.33, -0.1, e),
          mix(0.6, 4.4, e) + 0.3 * k,
        ],
        look: [NATIVE[0] + mix(-0.5, 0, e), NATIVE[1] + mix(0.33, 0, e), 0],
        fov: mix(30, 34, e),
        roll: mix(0.12, 0, e),
      };
    },
    slabs: () => WALLS(),
  },
  {
    name: 'WallLow',
    from: beat(36),
    to: beat(38),
    camera: (k) => ({
      pos: [NATIVE[0] + mix(-1.2, -0.6, k), -1.05, 2.9],
      look: [NATIVE[0], 0.45, 0],
      fov: 36,
      roll: -0.06,
    }),
    slabs: () => WALLS(),
  },
  {
    name: 'WallSide',
    from: beat(38),
    to: beat(40),
    camera: (k) => ({ pos: orbit(mix(0.95, 0.7, k), 4.2, 0.2, NATIVE), look: NATIVE, fov: 32 }),
    slabs: () => WALLS(),
    sweep: (k) => mix(1, -1, k),
  },
  // Act 3: same set. Pull back; xterm's wall powers on beside it.
  {
    name: 'LetEmKnow',
    from: beat(40),
    to: beat(48),
    camera: (k, f) => {
      const e = outExpo(Math.min(1, (f - beat(40)) / 40));
      return {
        // Settles to a centered dolly before the screen-fixed labels appear.
        pos: lerp3(SIDE_END, [0, 0.15, mix(8.7, 8.2, inOut(k))], e),
        look: lerp3(NATIVE, [0, 0.05, 0], e),
        fov: 34,
      };
    },
    slabs: (k, f) => WALLS(ramp(f, beat(40) + 4, beat(40) + 22)),
  },
  // Act 4: DOOM, in text cells and then in Kitty graphics.
  {
    name: 'DoomText',
    from: beat(48),
    to: beat(52),
    camera: (k) => ({
      pos: orbit(mix(-0.5, -0.3, k), 6.7, 0.35, [1.1, 0, 0]),
      look: [1.1, 0, 0],
      fov: 32,
    }),
    slabs: () => DOOM('doom-text-native'),
  },
  {
    name: 'DoomKitty',
    from: beat(52),
    to: beat(56),
    camera: (k) => ({
      pos: lerp3([-0.1, 0.25, 5.6], [0.7, 0.1, 4.9], inOut(k)),
      look: [1.7, 0.1, 0],
      fov: 32,
      roll: 0.02,
    }),
    slabs: () => DOOM('doom-kitty-native'),
    sweep: (k) => mix(-1.2, 1.2, Math.min(1, k * 3)),
  },
  {
    name: 'Badge',
    from: beat(56),
    to: ONGO_FRAMES,
    camera: (k) => ({
      pos: orbit(mix(-0.35, 0.25, k), 7.2, 0.6, [0, 0.9, 0]),
      look: [0, 0.9, 0],
      fov: 30,
    }),
    ghost: (k, f) => ({
      position: [0, 1.25, 0],
      rotation: [0, Math.sin(f / 50) * 0.2, 0],
      scale: 0.36,
    }),
  },
];

const Rig: React.FC<{ pos: V3; look: V3; fov: number; roll: number }> = ({
  pos,
  look,
  fov,
  roll,
}) => {
  const { camera, invalidate, advance } = useThree();
  const { isRendering } = useRemotionEnvironment();
  useLayoutEffect(() => {
    camera.position.set(...pos);
    const forward = new Vector3(...look).sub(camera.position).normalize();
    camera.up.set(0, 1, 0).applyAxisAngle(forward, roll);
    camera.lookAt(...look);
    if ('fov' in camera) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    if (isRendering) advance(performance.now());
    else invalidate();
  });
  return null;
};

// Words rise from behind a line, sharpen and settle their tracking; staggered.
const Reveal: React.FC<{
  at: number;
  frame: number;
  children: string;
  size: number;
  weight?: number;
  color?: string;
  font?: React.CSSProperties;
  tracking?: number;
  stagger?: number;
  style?: React.CSSProperties;
}> = ({
  at: start,
  frame,
  children,
  size,
  weight = 800,
  color = cream,
  font,
  tracking = -0.035,
  stagger = 3,
  style,
}) => {
  const words = children.split(' ');
  return (
    <div
      style={{
        fontSize: size,
        fontWeight: weight,
        color,
        lineHeight: 1.02,
        whiteSpace: 'nowrap',
        ...font,
        ...style,
      }}
    >
      {words.map((w, i) => {
        const k = ramp(frame - start - i * stagger, 0, 20, outExpo);
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              overflow: 'hidden',
              verticalAlign: 'top',
              paddingBottom: '0.08em',
              marginRight: '0.24em',
            }}
          >
            <span
              style={{
                display: 'inline-block',
                transform: `translateY(${(1 - k) * 105}%)`,
                filter: `blur(${(1 - k) * 6}px)`,
                letterSpacing: `${tracking + (1 - k) * 0.12}em`,
              }}
            >
              {w}
            </span>
          </span>
        );
      })}
    </div>
  );
};

const Scrim = () => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      background: 'linear-gradient(90deg, #000d 0%, #0009 34%, transparent 58%)',
    }}
  />
);

const Fine: React.FC<{ children: React.ReactNode; opacity?: number }> = ({
  children,
  opacity = 1,
}) => (
  <div
    style={{
      position: 'absolute',
      left: 120,
      bottom: 74,
      ...mono,
      fontSize: 19,
      color: muted,
      opacity: 0.85 * opacity,
      letterSpacing: '.02em',
    }}
  >
    {children}
  </div>
);

// Car-ad spec callout: a numbered hairline and a label.
const Spec: React.FC<{ frame: number; start: number; n: string; title: string; sub?: string }> = ({
  frame,
  start,
  n,
  title,
  sub,
}) => {
  const line = ramp(frame - start, 0, 22, outExpo);
  return (
    <>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(90deg, #000c 0%, #0008 32%, transparent 60%)',
          opacity: line,
        }}
      />
      <div style={{ position: 'absolute', left: 130, top: 205 }}>
        <div style={{ ...mono, fontSize: 22, color: amber, letterSpacing: '.3em', opacity: line }}>
          {n}
        </div>
        <div
          style={{
            height: 1,
            width: 420 * line,
            background: `linear-gradient(90deg, ${amber}, transparent)`,
            margin: '14px 0 22px',
          }}
        />
        <Reveal at={start + 4} frame={frame} size={92}>
          {title}
        </Reveal>
        {sub ? (
          <Reveal
            at={start + 12}
            frame={frame}
            size={28}
            weight={400}
            color={muted}
            font={mono}
            tracking={0.08}
            stagger={2}
            style={{ marginTop: 14 }}
          >
            {sub}
          </Reveal>
        ) : null}
      </div>
    </>
  );
};

const CODE = [
  'npm i wraithterm',
  "import { Terminal } from 'wraithterm/xterm'",
  'await Wraith.mount(el)',
];
// The count: one usage line per beat.
const USAGE = [
  { label: 'INSTALL', line: 'npm i wraithterm' },
  { label: 'DROP-IN · THE XTERM.JS API', line: "import { Terminal } from 'wraithterm/xterm'" },
  { label: 'NATIVE · GHOSTTY IN A WORKER', line: 'await Wraith.mount(el)' },
];
const UsageLine: React.FC<{ n: number; transform: string }> = ({ n, transform }) => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      perspective: 1600,
    }}
  >
    <div
      style={{
        transform,
        padding: '46px 72px 54px',
        borderRadius: 26,
        background: 'linear-gradient(160deg, #1a120c, #0b0806)',
        border: '1px solid #4a3020',
        boxShadow: `0 40px 120px #000c, 0 0 80px ${amber}22, inset 0 1px 0 #ffffff14`,
      }}
    >
      <div style={{ ...mono, fontSize: 24, letterSpacing: '.3em', color: muted, marginBottom: 22 }}>
        {USAGE[n - 1]!.label}
      </div>
      <div style={{ ...mono, fontSize: 56, color: cream, whiteSpace: 'pre' }}>
        {n === 1 ? <span style={{ color: amber }}>$ </span> : null}
        {USAGE[n - 1]!.line}
      </div>
    </div>
  </div>
);
const TYPE_AT = [UH[2][1], UH[2][1] + 22, UH[2][1] + 46];

const CodeCard: React.FC<{ frame: number; lit: number; transform: string }> = ({
  frame,
  lit,
  transform,
}) => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      perspective: 1600,
    }}
  >
    <div
      style={{
        transform,
        padding: '54px 70px',
        borderRadius: 26,
        background: 'linear-gradient(160deg, #1a120c, #0b0806)',
        border: '1px solid #4a3020',
        boxShadow: '0 40px 120px #000c, inset 0 1px 0 #ffffff14',
        ...mono,
        fontSize: 50,
        lineHeight: 1.9,
      }}
    >
      {CODE.map((line, i) => {
        const typed = Math.max(0, Math.min(line.length, Math.floor((frame - TYPE_AT[i]) / 1.1)));
        const on = lit === i + 1;
        return (
          <div
            key={line}
            style={{
              display: 'flex',
              gap: 34,
              color: on ? amber : lit > i + 1 ? cream : '#b9a593',
              textShadow: on ? `0 0 24px ${amber}88` : 'none',
            }}
          >
            <span style={{ color: on ? amber : '#6d5646', width: 30 }}>{i + 1}</span>
            <span style={{ whiteSpace: 'pre' }}>
              {line.slice(0, typed)}
              {typed < line.length && frame >= TYPE_AT[i] ? (
                <span style={{ color: amber }}>▍</span>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  </div>
);

const Copy: React.FC<{ shot: Shot; frame: number }> = ({ shot, frame }) => {
  const s = shot.from;
  switch (shot.name) {
    case 'Reveal':
      return (
        <>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'radial-gradient(ellipse at 50% 46%, #000a 0%, transparent 62%)',
            }}
          />
          <div style={{ position: 'absolute', left: 0, right: 0, top: 330, textAlign: 'center' }}>
            <Reveal at={beat(0) + 2} frame={frame} size={112}>
              Meet the fastest
            </Reveal>
            <Reveal at={beat(2)} frame={frame} size={112} color={amber}>
              terminal on the web.
            </Reveal>
          </div>
        </>
      );
    case 'Orbit':
      return (
        <Spec
          frame={frame}
          start={s + 8}
          n="01"
          title="Ghostty's terminal engine."
          sub="LIBGHOSTTY-VT · THE REAL VT PARSER"
        />
      );
    case 'Macro':
      return (
        <Spec
          frame={frame}
          start={UH[0][1] - 4}
          n="02"
          title="A Rust WebGPU renderer."
          sub="ONE WASM MODULE · 20-BYTE CELLS"
        />
      );
    case 'Low':
      return (
        <Spec
          frame={frame}
          start={s + 8}
          n="03"
          title="The xterm.js 6 API."
          sub="KEEP YOUR CODE. KEEP YOUR ADDONS."
        />
      );
    case 'Crane':
      return (
        <>
          <Spec
            frame={frame}
            start={UH[1][1] - 4}
            n="04"
            title="Kitty graphics."
            sub="LIVE CHARTS AND PREVIEWS · EVERY FRAME"
          />
          <Fine opacity={ramp(frame, UH[1][1] + 10, UH[1][1] + 30)}>
            Kitty graphics build · 200×60 workspace: PNG chart + 640×360 RGBA preview every frame ·{' '}
            {Math.floor(workScene.summary['native display'].slowest)} fps on a 120 Hz display · 5
            rounds · M5 Max · Chrome 155
          </Fine>
        </>
      );
    case 'Chase':
      return (
        <Spec
          frame={frame}
          start={s + 8}
          n="05"
          title="Off the main thread."
          sub="NATIVE PROFILE · GHOSTTY IN A WORKER"
        />
      );
    case 'Code':
      return (
        <CodeCard
          frame={frame}
          lit={0}
          transform={`scale(${mix(1, 1.05, ramp(frame, s, shot.to))})`}
        />
      );
    case 'One':
    case 'Two':
    case 'Three': {
      const n = shot.name === 'One' ? 1 : shot.name === 'Two' ? 2 : 3;
      const angle = [
        'rotateY(18deg) rotateX(4deg) translateX(-160px)',
        'rotateY(-10deg) rotateX(-5deg) translateX(40px)',
        `scale(${mix(1.04, 1.14, ramp(frame, s, shot.to, Easing.in(Easing.quad)))})`,
      ][n - 1];
      return (
        <>
          <div
            style={{
              position: 'absolute',
              right: n === 1 ? 40 : undefined,
              left: n === 2 ? 40 : n === 3 ? 0 : undefined,
              width: n === 3 ? '100%' : undefined,
              textAlign: 'center',
              top: n === 3 ? -80 : 30,
              fontSize: n === 3 ? 1100 : 820,
              fontWeight: 800,
              lineHeight: 1,
              color: amber,
              opacity: 0.92,
              letterSpacing: '-.06em',
              textShadow: `0 0 60px ${amber}66`,
            }}
          >
            {n}
          </div>
          <UsageLine n={n} transform={angle} />
        </>
      );
    }
    case 'Go':
      return (
        <>
          <div style={{ position: 'absolute', left: 130, bottom: 250 }}>
            <Reveal at={GO + 10} frame={frame} size={150}>
              16 terminals.
            </Reveal>
            <Reveal at={GO + 42} frame={frame} size={150} color={amber}>
              {`${nativeWall} fps. Each.`}
            </Reveal>
          </div>
          <Fine opacity={ramp(frame, GO + 20, GO + 40)}>
            Wraith native · 16 × 160×50 truecolor half-block · {nativeRange} frames per terminal per
            second on a {wall.workload.displayHz} Hz display · 5 rotated rounds · M5 Max · Chrome
            155 · footage at 60 fps
          </Fine>
        </>
      );
    case 'WallLow':
    case 'WallSide':
      return (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 90,
            textAlign: 'center',
            ...mono,
            fontSize: 20,
            letterSpacing: '.42em',
            color: muted,
          }}
        >
          GHOSTTY ENGINE · WEBGPU · XTERM.JS API · ONE WASM MODULE
        </div>
      );
    case 'LetEmKnow': {
      const late = frame >= beat(44) + 24;
      return (
        <>
          <div style={{ position: 'absolute', left: 0, right: 0, top: 96, textAlign: 'center' }}>
            {late ? (
              <Reveal at={beat(44) + 24} frame={frame} size={82} color={amber}>
                One of these is struggling.
              </Reveal>
            ) : (
              <Reveal at={beat(40) + 18} frame={frame} size={82}>
                Same sixteen terminals.
              </Reveal>
            )}
          </div>
          <div
            style={{
              position: 'absolute',
              left: 250,
              top: 752,
              padding: '14px 26px 16px',
              borderRadius: 14,
              background: '#070504e6',
              border: '1px solid #3a281c',
              opacity: ramp(frame, beat(41), beat(41) + 16),
            }}
          >
            <div style={{ ...mono, fontSize: 22, color: muted, letterSpacing: '.12em' }}>
              xterm.js + WebGL
            </div>
            <div style={{ fontSize: 60, fontWeight: 800, color: '#b8a698' }}>
              {webglWall[0]}–{webglWall[1]} fps
            </div>
          </div>
          <div
            style={{
              position: 'absolute',
              left: 1150,
              top: 752,
              padding: '14px 26px 16px',
              borderRadius: 14,
              background: '#070504e6',
              border: '1px solid #3a281c',
              opacity: ramp(frame, beat(42), beat(42) + 16),
            }}
          >
            <div style={{ ...mono, fontSize: 22, color: amber, letterSpacing: '.12em' }}>
              WRAITH
            </div>
            <div style={{ fontSize: 60, fontWeight: 800, color: amber }}>{nativeWall} fps</div>
          </div>
          <Fine>
            16 × 160×50 truecolor tiles · {wall.workload.viewport} @2× on a{' '}
            {wall.workload.displayHz} Hz display · 5 rotated rounds · frames shown per terminal per
            second · Wraith compatible {Math.floor(wall.bounds.compatibleSlowest)}+ / native{' '}
            {nativeRange} · M5 Max · Chrome 155 · footage at 60 fps
          </Fine>
        </>
      );
    }
    case 'DoomText':
    case 'DoomKitty': {
      const kitty = shot.name === 'DoomKitty';
      return (
        <>
          <Scrim />
          <div style={{ position: 'absolute', left: 130, top: 250 }}>
            <Reveal at={s + 4} frame={frame} size={kitty ? 100 : 120}>
              {kitty ? 'Now in Kitty graphics.' : 'It runs DOOM.'}
            </Reveal>
            <Reveal
              at={s + 14}
              frame={frame}
              size={26}
              weight={400}
              color={muted}
              font={mono}
              tracking={0.08}
              stagger={2}
              style={{ marginTop: 16 }}
            >
              {kitty ? 'REAL PIXELS · 640×400 EVERY FRAME' : 'TRUECOLOR TEXT CELLS · 160×50'}
            </Reveal>
            <div style={{ marginTop: 44 }}>
              <Reveal at={s + 30} frame={frame} size={150} color={amber}>
                {`${kitty ? doomKittyFps : doomTextFps}+ fps`}
              </Reveal>
              <Reveal
                at={s + 38}
                frame={frame}
                size={24}
                weight={400}
                color={muted}
                font={mono}
                tracking={0.3}
              >
                TIMEDEMO
              </Reveal>
            </div>
          </div>
          <Fine>
            {kitty
              ? 'Kitty graphics build · 640×400 RGB per frame, base64-chunked'
              : `At DOOM's 35 Hz: Wraith 35, xterm.js + WebGL ${xtermDoomFps}`}{' '}
            · Freedoom demo1 via doomgeneric + doomterm, replayed · frames shown/s, flush waits for
            the GPU fence · 3 rounds · M5 Max · Chrome 155 · Freedoom © its contributors (BSD)
          </Fine>
        </>
      );
    }
    case 'Badge':
      return (
        <div style={{ position: 'absolute', left: 0, right: 0, top: 640, textAlign: 'center' }}>
          <Reveal at={s + 2} frame={frame} size={190} style={{ letterSpacing: '-.06em' }}>
            WRAITH
          </Reveal>
          <Reveal
            at={s + 16}
            frame={frame}
            size={40}
            weight={400}
            color={muted}
            font={mono}
            tracking={0.04}
            stagger={2}
            style={{ marginTop: 12 }}
          >
            Native terminal speed. In a tab.
          </Reveal>
          <div
            style={{
              ...mono,
              fontSize: 28,
              color: amber,
              marginTop: 26,
              letterSpacing: '.1em',
              opacity: ramp(frame, s + 34, s + 50),
            }}
          >
            wraithterm.com · npm i wraithterm
          </div>
        </div>
      );
    default:
      return null;
  }
};

export const OnGo: React.FC = () => {
  const frame = useCurrentFrame(),
    { delayRender, continueRender, cancelRender } = useDelayRender();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const handle = delayRender('Local Wraith fonts');
    Promise.all(
      [
        new FontFace('Manrope', `url(${staticFile('Manrope.ttf')})`, { weight: '800' }),
        new FontFace('JetBrains', `url(${staticFile('JetBrainsMono.ttf')})`, { weight: '400' }),
      ].map((f) => f.load()),
    )
      .then((fonts) => {
        fonts.forEach((f) => document.fonts.add(f));
        setReady(true);
        continueRender(handle);
      })
      .catch(cancelRender);
    return () => continueRender(handle);
  }, [delayRender, continueRender, cancelRender]);

  const shot = SHOTS.find((s) => frame >= s.from && frame < s.to) ?? SHOTS.at(-1)!;
  const k = (frame - shot.from) / Math.max(1, shot.to - shot.from);
  const cam = shot.camera(k, frame);
  const sweep = shot.sweep?.(k);
  const ghost = shot.ghost?.(k, frame);
  const count = ['One', 'Two', 'Three', 'Code'].includes(shot.name);
  // Letterboxed through the reveal; tightens on the count, snaps open on GO.
  const bars =
    frame < GO
      ? 138 + 40 * ramp(frame, THREE, GO, Easing.in(Easing.quad))
      : 138 * (1 - ramp(frame, GO, GO + 7, outExpo));
  const go = frame >= GO ? Math.exp(-(frame - GO) / 6) : 0;
  const accent = UH.reduce(
    (sum, [uh, huh]) =>
      sum +
      (frame >= huh ? Math.exp(-(frame - huh) / 7) : 0) +
      (frame >= uh && frame < huh ? 0.4 * Math.exp(-(frame - uh) / 6) : 0),
    0,
  );
  const shake = go * 14;
  const fadeIn = shot.name === 'Tag' ? 0 : 1;
  const exit = shot.to - frame < 6 && !count && shot.name !== 'Badge' ? (shot.to - frame) / 6 : 1;

  return (
    <AbsoluteFill className="film" style={{ background: '#050403' }}>
      <Audio src={staticFile('ongo-music.wav')} />
      <AbsoluteFill
        style={{
          transform: `translate(${(Math.sin(frame * 7.1) * shake).toFixed(1)}px, ${(Math.cos(frame * 9.3) * shake).toFixed(1)}px) scale(${1 + go * 0.04 + accent * 0.012})`,
        }}
      >
        <AbsoluteFill
          style={{ background: 'radial-gradient(ellipse at 50% 62%, #2a160b 0%, #050403 62%)' }}
        />
        <ThreeCanvas
          width={1920}
          height={1080}
          camera={{ fov: 32, position: [0, 0, 8], near: 0.05, far: 100 }}
          gl={{ antialias: true, alpha: true }}
          dpr={1}
          style={{ position: 'absolute' }}
        >
          <Rig
            pos={cam.pos}
            look={cam.look}
            fov={(cam.fov ?? 32) - 2.4 * accent}
            roll={cam.roll ?? 0}
          />
          <ambientLight intensity={0.35 * fadeIn + 0.08} />
          <directionalLight position={[-4, 6, 6]} intensity={1.6 * fadeIn} color="#ffddba" />
          <directionalLight position={[5, -1, 2]} intensity={0.8} color="#8fa7c4" />
          <directionalLight position={[0, 2, -6]} intensity={1.1} color="#ff9a52" />
          {shot.name === 'Badge' ? (
            <pointLight position={[0, 1.6, 1.6]} intensity={45} distance={3.6} color="#ffb070" />
          ) : null}
          {sweep !== undefined ? (
            <>
              <pointLight
                position={[sweep * 4, 1.4, 1.2]}
                intensity={140}
                distance={8}
                color="#ffc48a"
              />
              <spotLight
                position={[sweep * 5, 4, 3]}
                angle={0.35}
                penumbra={0.6}
                intensity={260}
                distance={14}
                color="#ffe2c2"
              />
            </>
          ) : null}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -2.15, 0]}>
            <planeGeometry args={[60, 60]} />
            <meshStandardMaterial color="#0d0907" metalness={0.6} roughness={0.55} />
          </mesh>
          {ghost ? <Ghost {...ghost} /> : null}
          {(shot.slabs?.(k, frame) ?? []).map((p, i) => (
            <Browser key={`${p.file}-${i}`} {...p} />
          ))}
        </ThreeCanvas>
        {sweep !== undefined ? (
          <div
            style={{
              position: 'absolute',
              top: 520,
              left: `${50 + sweep * 38}%`,
              width: 900,
              height: 3,
              marginLeft: -450,
              background:
                'linear-gradient(90deg, transparent, #ffd2a0, #fff, #ffd2a0, transparent)',
              filter: 'blur(2px)',
              opacity: 0.55,
              mixBlendMode: 'screen',
            }}
          />
        ) : null}
        <AbsoluteFill
          style={{ background: 'radial-gradient(ellipse at 50% 50%, transparent 45%, #000b 100%)' }}
        />
        <div style={{ position: 'absolute', inset: 0, opacity: exit }}>
          {ready ? <Copy shot={shot} frame={frame} /> : null}
        </div>
      </AbsoluteFill>
      {accent > 0.02 ? (
        <AbsoluteFill
          style={{
            background: 'radial-gradient(ellipse at 50% 55%, #ffc690 0%, transparent 65%)',
            opacity: accent * 0.28,
            mixBlendMode: 'screen',
          }}
        />
      ) : null}
      {go > 0.02 ? (
        <AbsoluteFill
          style={{
            background: 'radial-gradient(ellipse, #ffe6c8 0%, transparent 70%)',
            opacity: go * 0.5,
            mixBlendMode: 'screen',
          }}
        />
      ) : null}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          height: bars,
          background: '#000',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: bars,
          background: '#000',
        }}
      />
    </AbsoluteFill>
  );
};
