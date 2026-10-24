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
import wall from '../../claims/wall-comparison.json';
import comparison from '../../claims/hype-comparison.json';
import music from '../../claims/ongo-music.json';

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
const dense = comparison.groups.find((g) => g.workload === 'complex')!;
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

const SHOTS: Shot[] = [
  {
    // "Honorable": the slab's edge catches a single line of light in the dark.
    name: 'Tag',
    from: 0,
    to: beat(0),
    camera: () => ({ pos: [-3.4, -0.9, 3.9], look: [0, -0.2, 0], fov: 30 }),
    slabs: () => [slab('pipes', [0, 0, 0], [0, 0.35, 0], { brightness: 0.04, reflection: 0.25 })],
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
    slabs: (k) => [
      slab('pipes', [0, 0, 0], [0, 0.35, 0], { brightness: 0.05 + 0.3 * k, reflection: 0.3 }),
    ],
    sweep: (k) => mix(-0.9, 1.3, k),
  },
  {
    // The screen boots during a slow orbit.
    name: 'Orbit',
    from: beat(4),
    to: beat(8),
    camera: (k) => ({
      pos: orbit(mix(-1.05, 0.55, inOut(k)), 5.6, 0.35),
      look: [0, 0.1, 0],
      fov: 32,
    }),
    slabs: (k) => [
      slab('reactor', [0, 0, 0], [0, 0, 0], { brightness: ramp(k, 0.05, 0.45), reflection: 0.3 }),
    ],
    sweep: (k) => mix(1.2, -1.2, k),
  },
  {
    name: 'Macro',
    from: beat(8),
    to: beat(12),
    camera: (k) => ({
      pos: [mix(-1.9, 1.5, inOut(k)), mix(0.45, 0.15, k), 1.35],
      look: [mix(-1.4, 1.9, inOut(k)), 0.1, 0],
      fov: 26,
      roll: 0.05,
    }),
    slabs: () => [slab('dense', [0, 0, 0], [0, -0.12, 0], { width: 6.4 })],
  },
  {
    // Tracking along a row of screens, low and tilted.
    name: 'Convoy',
    from: beat(12),
    to: beat(16),
    camera: (k) => ({
      pos: [mix(-6.5, 3.5, inOut(k)), -0.55, 4.3],
      look: [mix(-4.2, 6, inOut(k)), 0, 0],
      fov: 34,
      roll: -0.09,
    }),
    slabs: () =>
      ['showcase-wraith', 'compatible', 'reactor', 'home'].map((file, i) =>
        slab(file, [-6 + i * 4.6, 0, 0], [0, -0.38, 0], { width: 4, reflection: 0.22 }),
      ),
  },
  {
    // Crane down from overhead onto the retro FPS.
    name: 'Crane',
    from: beat(16),
    to: beat(20),
    camera: (k) => {
      const e = outExpo(k);
      return {
        pos: [mix(0.6, -0.4, e), mix(6.5, 0.2, e), mix(1.2, 4.6, e)],
        look: [0, 0, 0],
        fov: 32,
      };
    },
    slabs: () => [slab('doomish-native', [0, 0, 0], [0, 0.1, 0], { width: 6.2, reflection: 0.28 })],
  },
  {
    // Rear three-quarter swinging round to the front.
    name: 'Chase',
    from: beat(20),
    to: beat(24),
    camera: (k) => ({
      pos: orbit(mix(2.55, 0.6, inOut(k)), mix(5.2, 4.7, k), -0.45),
      look: [0, 0, 0],
      fov: 33,
      roll: 0.04,
    }),
    slabs: () => [slab('pipes', [0, 0, 0], [0, 0, 0], { reflection: 0.3 })],
    sweep: (k) => mix(-1, 1.2, k),
  },
  {
    name: 'Code',
    from: beat(24),
    to: ONE,
    camera: () => ({ pos: [0, 0, 8], look: [0, 0, 0] }),
    ghost: (k, f) => ({ position: [3.4, 0.2, -5], rotation: [0, 0.4 + f / 200, 0], scale: 0.9 }),
  },
  { name: 'One', from: ONE, to: TWO, camera: () => ({ pos: [0, 0, 8], look: [0, 0, 0] }) },
  { name: 'Two', from: TWO, to: THREE, camera: () => ({ pos: [0, 0, 8], look: [0, 0, 0] }) },
  { name: 'Three', from: THREE, to: GO, camera: () => ({ pos: [0, 0, 8], look: [0, 0, 0] }) },
  {
    // Launch: start inside one tile, rip back to reveal all sixteen.
    name: 'Go',
    from: GO,
    to: beat(36),
    camera: (k, f) => {
      const e = outExpo(Math.min(1, (f - GO) / 50));
      return {
        pos: [mix(-1.15, 0.5, e) + 0.6 * k, mix(0.55, -0.15, e), mix(0.55, 7.2, e) + 0.5 * k],
        look: [mix(-1.15, 0, e) + 0.2 * k, mix(0.55, 0, e), 0],
        fov: mix(30, 36, e),
        roll: mix(0.12, 0, e),
      };
    },
    slabs: () => [slab('wall-native', [0, 0, 0], [0, 0, 0], { width: 6.4, reflection: 0.25 })],
  },
  // Four hero angles, one per "we on go".
  {
    name: 'HeroLow',
    from: beat(36),
    to: beat(38),
    camera: (k) => ({
      pos: [mix(-1.8, -1.2, k), -1.15, 3.6],
      look: [0, 0.2, 0],
      fov: 34,
      roll: -0.06,
    }),
    slabs: () => [slab('doomish-native', [0, 0, 0], [0, 0.25, 0], { reflection: 0.3 })],
  },
  {
    name: 'HeroSide',
    from: beat(38),
    to: beat(40),
    camera: (k) => ({ pos: orbit(mix(1.15, 0.85, k), 5, 0.1), look: [0, 0, 0], fov: 30 }),
    slabs: () => [slab('pipes', [0, 0, 0], [0, 0, 0], { reflection: 0.3 })],
    sweep: (k) => mix(1, -1, k),
  },
  {
    // Split: the same sixteen terminals in xterm.js + WebGL and in Wraith.
    name: 'LetEmKnow',
    from: beat(40),
    to: beat(48),
    camera: (k) => ({
      // Centered dolly only: the labels are screen-fixed under each wall.
      pos: [0, 0.15, mix(8.7, 8.2, inOut(k))],
      look: [0, 0.05, 0],
      fov: 34,
    }),
    slabs: () => [
      slab('wall-webgl', [-2.15, 0.25, 0], [0, 0.12, 0], { width: 4.1, reflection: 0.2 }),
      slab('wall-native', [2.15, 0.25, 0], [0, -0.12, 0], { width: 4.1, reflection: 0.2 }),
    ],
  },
  {
    name: 'Receipt',
    from: beat(48),
    to: beat(52),
    camera: (k) => ({
      pos: orbit(mix(-0.5, -0.2, k), 6.2, 0.2, [1.3, 0, 0]),
      look: [1.3, 0, 0],
      fov: 32,
    }),
    slabs: () => [slab('dense', [1.3, 0, 0], [0, -0.3, 0], { width: 5.6, reflection: 0.25 })],
  },
  {
    name: 'Install',
    from: beat(52),
    to: beat(56),
    camera: (k) => ({
      pos: orbit(mix(0.3, 0.1, k), 6.4, 0.3, [1.2, 0, 0]),
      look: [1.2, 0, 0],
      fov: 32,
    }),
    slabs: () => [slab('home', [2.6, 0, 0], [0, -0.42, 0], { width: 5, reflection: 0.25 })],
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
  'new Terminal().open(el)',
];
const TYPE_AT = [beat(24) + 4, beat(25) + 6, beat(26) + 14];

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
        <div style={{ position: 'absolute', left: 0, right: 0, top: 640, textAlign: 'center' }}>
          <Reveal
            at={beat(2)}
            frame={frame}
            size={34}
            weight={400}
            font={mono}
            tracking={0.6}
            color={cream}
          >
            WRAITH
          </Reveal>
        </div>
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
          start={s + 8}
          n="02"
          title="A Rust WebGPU renderer."
          sub="ONE WASM MODULE · 20-BYTE CELLS"
        />
      );
    case 'Convoy':
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
        <Spec
          frame={frame}
          start={s + 14}
          n="04"
          title="Every cell, every frame."
          sub="ON THE GPU"
        />
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
        'rotateY(22deg) rotateX(4deg) scale(1.02) translateX(-170px)',
        'rotateY(-18deg) rotateX(-6deg) scale(1.0) translateX(60px)',
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
          <CodeCard frame={frame + 400} lit={n} transform={angle} />
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
            <Reveal at={beat(32) + 2} frame={frame} size={150} color={amber}>
              60 fps. Each.
            </Reveal>
          </div>
          <Fine opacity={ramp(frame, GO + 20, GO + 40)}>
            Wraith native · 16 × 160×50 truecolor half-block · {wall.workload.measureMs / 1000} s
            after warm-up · display-paced · M5 Max · Chrome 155
          </Fine>
        </>
      );
    case 'HeroLow':
    case 'HeroSide':
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
            <div style={{ fontSize: 60, fontWeight: 800, color: amber }}>60 fps</div>
          </div>
          <Fine>
            16 × 160×50 truecolor tiles · 1920×1080 @2× · 3 rotated rounds · frames shown per
            terminal per second · Wraith compatible {Math.floor(wall.bounds.compatibleSlowest)}+ /
            native {Math.floor(wall.bounds.nativeSlowest)}+ · M5 Max · Chrome 155
          </Fine>
        </>
      );
    }
    case 'Receipt':
      return (
        <>
          <div style={{ position: 'absolute', left: 130, top: 300 }}>
            <Reveal at={s + 6} frame={frame} size={210} color={amber}>
              {`${dense.cpuHeadline}×`}
            </Reveal>
            <Reveal at={s + 14} frame={frame} size={58}>
              less CPU per update.
            </Reveal>
          </div>
          <Fine>
            vs xterm.js DOM · fastest DOM p50 ÷ slowest Wraith p50 · dense 240×80 · M5 Max · Chrome
            155
          </Fine>
        </>
      );
    case 'Install':
      return (
        <div style={{ position: 'absolute', left: 130, top: 330 }}>
          <Reveal at={s + 4} frame={frame} size={92}>
            Same API.
          </Reveal>
          <Reveal at={s + 12} frame={frame} size={92} color={amber}>
            One import.
          </Reveal>
          <div
            style={{
              ...mono,
              fontSize: 40,
              color: cream,
              marginTop: 40,
              opacity: ramp(frame, s + 24, s + 40),
            }}
          >
            <span style={{ color: amber }}>$</span> npm i wraithterm
          </div>
        </div>
      );
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
  const shake = go * 14;
  const fadeIn = shot.name === 'Tag' ? 0 : 1;
  const exit = shot.to - frame < 6 && !count && shot.name !== 'Badge' ? (shot.to - frame) / 6 : 1;

  return (
    <AbsoluteFill className="film" style={{ background: '#050403' }}>
      <Audio src={staticFile('ongo-music.wav')} />
      <AbsoluteFill
        style={{
          transform: `translate(${(Math.sin(frame * 7.1) * shake).toFixed(1)}px, ${(Math.cos(frame * 9.3) * shake).toFixed(1)}px) scale(${1 + go * 0.04})`,
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
          <Rig pos={cam.pos} look={cam.look} fov={cam.fov ?? 32} roll={cam.roll ?? 0} />
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
            <Browser key={`${shot.name}-${p.file}-${i}`} {...p} />
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
