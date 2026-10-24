import React, { useEffect, useState } from 'react';
import { AbsoluteFill, spring, staticFile, useCurrentFrame, useDelayRender } from 'remotion';
import { Audio } from '@remotion/media';
import { ThreeCanvas } from '@remotion/three';
import { Browser, type BrowserPose } from './Browser';
import { Ghost } from './Ghost';
import comparison from '../../claims/hype-comparison.json';
import native from '../../claims/hype-native.json';

// Same music, offset and 1,429 frames as the flex cut. Every cut, slam and shake
// lands on the 131-BPM grid; impacts follow the loud beats measured in the mix.
const FPS = 60;
const BEAT = (60 / 131) * FPS;
const b = (n: number) => Math.round(n * BEAT);
const TOTAL = b(52);
const HITS = [
  0, 3, 5, 8, 9, 10, 11, 13, 14, 15, 16, 19, 21, 24, 25, 26, 27, 29, 30, 31, 32, 35, 37, 40, 41, 42,
  43, 45, 46, 47, 48,
];
const SLAMS = new Set([5, 8, 10, 21, 29, 32, 40, 48]);
const FLASHES = [8, 16, 21, 29, 32, 40, 48];
const SCENES = [
  { from: 0, to: 8, name: 'Question' },
  { from: 8, to: 13, name: 'Wraith' },
  { from: 13, to: 16, name: 'Whips' },
  { from: 16, to: 21, name: 'SameBytes' },
  { from: 21, to: 24, name: 'Ratio' },
  { from: 24, to: 28, name: 'Barrage' },
  { from: 28, to: 32, name: 'Native' },
  { from: 32, to: 40, name: 'Dive' },
  { from: 40, to: 44, name: 'Install' },
  { from: 44, to: 48, name: 'Site' },
  { from: 48, to: 52, name: 'End' },
];

const group = (w: string) => comparison.groups.find((g) => g.workload === w)!;
const dense = group('complex');
const wraithMin = Math.floor(Math.min(...dense.renderers.wraith.updatesPerSecond));
const webglMax = Math.ceil(Math.max(...dense.renderers.webgl.updatesPerSecond) * 10) / 10;
const nativeTarget = Number(native.headline.replace(/\D/g, ''));

const amber = '#ffb066';
const cream = '#fff3e4';
const mono: React.CSSProperties = { fontFamily: 'JetBrains', fontWeight: 400 };
const rnd = (i: number) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const beatAt = (f: number) => {
  let k = 0;
  while (k < 52 && b(k + 1) <= f) k++;
  return k;
};
const lastHit = (f: number) => HITS.filter((h) => b(h) <= f).at(-1) ?? 0;
const snap = (t: number, stiffness = 420, damping = 15) =>
  t < 0 ? 0 : spring({ frame: t, fps: FPS, config: { damping, stiffness, mass: 0.6 } });

const p = (
  file: string,
  position: BrowserPose['position'],
  rotation: BrowserPose['rotation'],
  width = 6,
  opacity = 1,
): BrowserPose => ({ file, position, rotation, width, opacity });

function panels(scene: string, frame: number, local: number, n: number, h: number) {
  const since = (k: number) => frame - b(k),
    t = local / n,
    k = beatAt(frame);
  switch (scene) {
    // Real-time capture of xterm.js on its default DOM renderer: close on the
    // log stream, then pull back to the whole tab.
    case 'Question': {
      const back = snap(since(3), 260, 20);
      return [
        p(
          'xterm-dom',
          [0.9 - 0.9 * back, -0.35 + 0.35 * back, 1.7 - 3.6 * back + (0.08 * local) / 60 + 0.3 * h],
          [0.14 - 0.08 * back, -0.42 + 0.26 * back, -0.06 + 0.04 * back],
          6.6,
          k >= 5 ? 0.4 : 0.6,
        ),
      ].map((pose) => ({ ...pose, bare: true }));
    }
    case 'Wraith': {
      if (k < 10) return [];
      const w = snap(since(10), 300, 18);
      return [
        p('reactor', [2.3, 0, -2.6 + 0.7 * h], [0.05, -1.5 * (1 - w) - 0.35, 0.04], 5.2, 0.55),
      ];
    }
    case 'Whips': {
      const i = k - 13,
        side = i % 2 ? -1 : 1,
        w = snap(since(k), 520, 17);
      return [
        p(
          ['reactor', 'pipes', 'dense'][i],
          [0.35 * side + 2.5 * side * (1 - w), 0, -0.7 + 0.5 * h],
          [0.1 * side, side * (1.4 * (1 - w) - 0.2), -side * 0.3 * (1 - w) + 0.03 * side],
          6.4,
        ),
      ];
    }
    case 'SameBytes': {
      const a = snap(since(16), 380, 19),
        push = snap(since(19), 380, 19);
      return [
        p(
          'complex-webgl',
          [-1.9 - 5 * (1 - a), 0, -1.9 + 0.55 * push + 0.25 * h],
          [0.05, 0.3 - 0.12 * push, -0.02],
          3.5,
        ),
        p(
          'complex-wraith',
          [1.9 + 5 * (1 - a), 0, -1.9 + 0.55 * push + 0.25 * h],
          [0.05, -0.3 + 0.12 * push, 0.02],
          3.5,
        ),
      ];
    }
    case 'Ratio':
      return [
        p(
          'complex-wraith',
          [2.4 + 3 * (1 - snap(local)), 0, -2.3 + 0.5 * h],
          [-0.05, -0.45 + 0.15 * t, 0.04],
          4.4,
          0.7,
        ),
      ];
    case 'Barrage': {
      const i = k - 24,
        side = i % 2 ? -1 : 1,
        w = snap(since(k), 520, 17);
      return [
        p(
          ['complex-wraith', 'compatible', 'showcase-wraith', 'complex-wraith'][i],
          [side * (2.3 + 3 * (1 - w)), 0, -2.4 + 0.6 * h],
          [0.06, -side * 0.42, side * 0.04],
          4.6,
          0.6,
        ),
      ];
    }
    case 'Native': {
      const w = snap(since(29), 380, 18);
      return since(29) < 0
        ? []
        : [
            p(
              'dense',
              [2.1 + 4 * (1 - w), 0.05, -2.1 + 0.6 * h],
              [-0.06, -0.38 + 0.2 * t, 0.03],
              4.6,
            ),
          ];
    }
    // Accelerating dolly from deep space straight through the pipes screen.
    case 'Dive':
      return [
        p(
          'pipes',
          [0, 0, -3.4 + 6.4 * t ** 2.2 + 0.6 * h],
          [
            -0.35 * (1 - t) + 0.05,
            0.75 * (1 - t) - 0.1 + 0.12 * Math.sin(local / 25),
            -0.28 * (1 - t) + 0.08 * h,
          ],
          6.1,
        ),
      ];
    case 'Install':
      return [
        p(
          'reactor',
          [0, 0.1, -3.4 + 0.5 * h],
          [0.12, 0.3 * Math.sin(local / 40), -0.03 + 0.04 * h],
          6,
          0.3,
        ),
      ];
    case 'Site': {
      if (since(46) < 0)
        return [
          p('compatible', [-2.6, 0.3, -3.6 + 0.4 * h], [0.08, 0.5, -0.06], 4.6, 0.45),
          p('showcase-wraith', [2.6, 0.2, -3.6 + 0.4 * h], [0.08, -0.5, 0.06], 4.6, 0.45),
        ];
      const a = snap(since(46), 300, 18);
      return [
        p(
          'home',
          [2.0 + 3.2 * (1 - a), 0, -1.2 + 0.35 * h],
          [0.12 * (1 - a), 1.5 * (1 - a) - 0.38, -0.2 * (1 - a)],
          4.8,
        ),
      ];
    }
    default:
      return [];
  }
}

// Text that slams in from oversize with blur and a decaying RGB split.
const Slam: React.FC<{
  t: number;
  size: number;
  children: React.ReactNode;
  word?: boolean;
  color?: string;
  from?: number;
  style?: React.CSSProperties;
}> = ({ t, size, children, word, color = cream, from = 2.1, style }) => {
  if (t < 0) return null;
  const s = snap(t, 520, 16),
    split = 18 * Math.exp(-t / 6) + 2,
    text: React.CSSProperties = {
      fontSize: size,
      fontWeight: 800,
      letterSpacing: '-.065em',
      lineHeight: 0.92,
      whiteSpace: 'nowrap',
    };
  return (
    <div
      style={{
        position: 'relative',
        transform: `scale(${from + (1 - from) * s})`,
        filter: `blur(${Math.max(0, 10 * (1 - t / 4))}px)`,
        opacity: Math.min(1, t / 2 + 0.4),
        ...style,
      }}
    >
      {[
        ['#ff2d55', split],
        ['#2de2ff', -split],
      ].map(([c, dx]) => (
        <div
          key={c}
          style={{
            ...text,
            position: 'absolute',
            inset: 0,
            color: c as string,
            opacity: 0.55,
            transform: `translateX(${dx}px)`,
            mixBlendMode: 'screen',
          }}
        >
          {children}
        </div>
      ))}
      <div
        className={word ? 'wordmark' : undefined}
        style={{ ...text, color, position: 'relative' }}
      >
        {children}
      </div>
    </div>
  );
};

const Fine: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      position: 'absolute',
      left: 110,
      right: 110,
      bottom: 54,
      ...mono,
      fontSize: 21,
      lineHeight: 1.5,
      color: '#d4b79e',
      opacity: 0.88,
    }}
  >
    {children}
  </div>
);
const Tag: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({
  children,
  style,
}) => (
  <div style={{ ...mono, fontSize: 30, letterSpacing: '.18em', color: amber, ...style }}>
    {children}
  </div>
);
const centered: React.CSSProperties = {
  position: 'absolute',
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
};
const compareFine =
  'Wraith compatible ÷ xterm.js WebGL · GPU-completed updates/s · slowest ÷ fastest of 3 runs · 240×80 · M5 Max · Chrome 155';

const SpeedLines: React.FC<{ frame: number; strength: number }> = ({ frame, strength }) => (
  <svg
    width={1920}
    height={1080}
    style={{ position: 'absolute', inset: 0, opacity: strength, mixBlendMode: 'screen' }}
  >
    {Array.from({ length: 70 }, (_, i) => {
      const angle = rnd(i) * Math.PI * 2,
        travel = (rnd(i + 99) + frame * (0.035 + 0.03 * rnd(i + 7))) % 1,
        r0 = 260 + travel * 1100,
        r1 = r0 + 90 + 260 * travel;
      return (
        <line
          key={i}
          x1={960 + Math.cos(angle) * r0}
          y1={540 + Math.sin(angle) * r0}
          x2={960 + Math.cos(angle) * r1}
          y2={540 + Math.sin(angle) * r1}
          stroke={i % 5 ? cream : amber}
          strokeWidth={1 + 3 * rnd(i + 3)}
          opacity={0.25 + 0.6 * travel}
        />
      );
    })}
  </svg>
);

const Copy: React.FC<{ scene: string; frame: number }> = ({ scene, frame }) => {
  const since = (k: number) => frame - b(k),
    k = beatAt(frame);
  if (scene === 'Question') {
    const line = k >= 5 ? 2 : k >= 3 ? 1 : 0;
    return (
      <>
        <div style={{ position: 'absolute', left: 130, top: 300 }}>
          {line === 0 ? (
            <Slam t={since(0)} size={160} style={{ transformOrigin: 'left center' }}>
              THE FASTEST MODELS
              <br />
              EVER BUILT.
            </Slam>
          ) : line === 1 ? (
            <>
              <Slam t={since(3)} size={150} style={{ transformOrigin: 'left center' }}>
                STREAMING INTO A
              </Slam>
              <div style={{ ...mono, marginTop: 20 }}>
                <Slam
                  t={since(3) - 3}
                  size={240}
                  color={amber}
                  from={2.4}
                  style={{ transformOrigin: 'left center' }}
                >
                  <span style={{ ...mono, letterSpacing: '-.04em' }}>&lt;div&gt;.</span>
                </Slam>
              </div>
            </>
          ) : (
            <Slam
              t={since(5)}
              size={200}
              word
              from={2.8}
              style={{ transformOrigin: 'left center' }}
            >
              YOUR GPU
              <br />
              IS ASLEEP.
            </Slam>
          )}
        </div>
        <Tag
          style={{
            position: 'absolute',
            left: 134,
            top: 210,
            fontSize: 28,
            letterSpacing: '.14em',
          }}
        >
          xterm.js · DOM RENDERER
        </Tag>
        <Fine>xterm.js 6 default DOM renderer · real-time capture</Fine>
      </>
    );
  }
  if (scene === 'Wraith') {
    if (k < 10)
      return (
        <div style={{ ...centered, top: 360 }}>
          <Slam t={since(8)} size={300} word from={3.4}>
            WAKE IT UP.
          </Slam>
        </div>
      );
    const echo = Math.exp(-(frame - b(lastHit(frame))) / 6);
    return (
      <div style={{ ...centered, top: 330 }}>
        <div style={{ position: 'relative' }}>
          {k >= 11
            ? [1.18, 1.36].map((s, i) => (
                <div
                  key={s}
                  className="wordmark"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    fontSize: 420,
                    fontWeight: 800,
                    letterSpacing: '-.075em',
                    textAlign: 'center',
                    opacity: echo * (0.35 - i * 0.15),
                    transform: `scale(${1 + (s - 1) * (1 - echo)})`,
                  }}
                >
                  WRAITH
                </div>
              ))
            : null}
          <Slam t={since(10)} size={420} word from={3.2}>
            WRAITH
          </Slam>
        </div>
        {since(12) >= 0 ? (
          <Tag
            style={{
              marginTop: 30,
              fontSize: 38,
              letterSpacing: '.24em',
              opacity: Math.min(1, since(12) / 6),
              transform: `translateY(${30 * (1 - snap(since(12)))}px)`,
            }}
          >
            NATIVE TERMINAL SPEED. IN A TAB.
          </Tag>
        ) : null}
      </div>
    );
  }
  if (scene === 'Whips') {
    const i = k - 13;
    return (
      <div style={{ position: 'absolute', left: 120, bottom: 120 }}>
        <Slam key={i} t={since(k)} size={210} from={1.7} style={{ transformOrigin: 'left bottom' }}>
          {['WEBGPU.', 'EVERY CELL.', 'EVERY FRAME.'][i]}
        </Slam>
      </div>
    );
  }
  if (scene === 'SameBytes')
    return (
      <>
        <div style={{ ...centered, top: 70 }}>
          {k < 20 ? (
            <>
              <Slam t={since(16)} size={120}>
                SAME BYTES.
              </Slam>
              <Slam t={since(19)} size={120} word style={{ marginTop: 6 }}>
                SAME GRID.
              </Slam>
            </>
          ) : (
            <Slam t={since(20)} size={150} word from={1.5}>
              WHO WINS?
            </Slam>
          )}
        </div>
        <Tag
          style={{
            position: 'absolute',
            left: 300,
            top: 810,
            fontSize: 28,
            letterSpacing: '.08em',
          }}
        >
          xterm.js + WebGL
        </Tag>
        <Tag style={{ position: 'absolute', left: 1150, top: 810, fontSize: 28 }}>WRAITH</Tag>
        <Fine>
          Matched input bytes and visible text · 240×80 · edited fixture playback, not a timing race
        </Fine>
      </>
    );
  if (scene === 'Ratio') {
    const t = since(21),
      count = 1 + (dense.throughputHeadline - 1) * Math.min(1, snap(t, 120, 26)),
      fill = Math.min(1, t / 30) ** 0.6,
      bar = (label: string, value: number, color: string, scale: number) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 28, marginTop: 22 }}>
          <div style={{ ...mono, fontSize: 26, width: 300, color: '#d4b79e' }}>{label}</div>
          <div
            style={{
              height: 34,
              width: 900 * scale * fill,
              background: color,
              boxShadow: `0 0 30px ${color}`,
              borderRadius: 4,
            }}
          />
          <div style={{ ...mono, fontSize: 30, color }}>{Math.round(value * fill)}/s</div>
        </div>
      );
    return (
      <>
        <div style={{ position: 'absolute', left: 120, top: 120 }}>
          <Tag>VERSUS xterm.js + WebGL</Tag>
          <Slam
            t={t}
            size={400}
            word
            from={2.6}
            style={{ transformOrigin: 'left center', marginTop: 10 }}
          >
            {count.toFixed(1)}×
          </Slam>
          <div style={{ fontWeight: 800, fontSize: 64, letterSpacing: '-.03em', marginTop: 4 }}>
            MORE COMPLETED UPDATES/S
          </div>
          <div style={{ marginTop: 40 }}>
            {bar('xterm.js WebGL', webglMax, '#8e7a6b', webglMax / wraithMin)}
            {bar('WRAITH', wraithMin, amber, 1)}
          </div>
        </div>
        <Fine>{compareFine} · fences every 32 updates · not display FPS</Fine>
      </>
    );
  }
  if (scene === 'Barrage') {
    const i = k - 24,
      invert = i % 2 === 1,
      row = [
        [`${dense.throughputHeadline}×`, 'DENSE CELLS', 'vs xterm.js WebGL'],
        [`${group('scroll').throughputHeadline}×`, 'SCROLL + REPAINT', 'vs xterm.js WebGL'],
        [`${group('showcase').throughputHeadline}×`, 'DASHBOARD', 'vs xterm.js WebGL'],
        [`${dense.cpuHeadline}×`, 'LESS CPU / UPDATE', 'vs xterm.js DOM'],
      ][i];
    const ink = invert ? '#140b05' : cream;
    return (
      <>
        {invert ? <AbsoluteFill style={{ background: '#ffa95c', opacity: 0.94 }} /> : null}
        <div style={{ position: 'absolute', left: i % 2 ? 900 : 120, top: 190 }}>
          <Tag style={{ color: invert ? '#3a1a06' : amber }}>{row[2]}</Tag>
          <Slam
            key={i}
            t={since(k)}
            size={420}
            color={ink}
            word={!invert}
            from={1.9}
            style={{ transformOrigin: 'left center' }}
          >
            {row[0]}
          </Slam>
          <div style={{ fontWeight: 800, fontSize: 72, letterSpacing: '-.03em', color: ink }}>
            {row[1]}
          </div>
        </div>
        <div style={invert ? { filter: 'invert(1) brightness(.5)' } : undefined}>
          <Fine>
            {i === 3
              ? 'Fastest xterm DOM p50 ÷ slowest Wraith p50 · parse + draw/layout time · dense 240×80 · M5 Max · Chrome 155'
              : compareFine}
          </Fine>
        </div>
      </>
    );
  }
  if (scene === 'Native') {
    if (k === 28)
      return (
        <div style={{ ...centered, top: 330 }}>
          <Tag style={{ fontSize: 40, letterSpacing: '.4em' }}>NOW GO</Tag>
          <Slam t={since(28)} size={300} word from={0.4}>
            NATIVE.
          </Slam>
        </div>
      );
    const t = since(29),
      value = Math.round(nativeTarget * snap(t, 90, 24));
    return (
      <>
        <div style={{ position: 'absolute', left: 120, top: 220 }}>
          <Tag>THE NATIVE PATH</Tag>
          <Slam
            t={t}
            size={330}
            word
            from={2.4}
            style={{ transformOrigin: 'left center', marginTop: 16 }}
          >
            {value >= nativeTarget ? native.headline : value.toLocaleString('en-US')}
          </Slam>
          <div style={{ ...mono, fontSize: 44, marginTop: 20 }}>GPU-COMPLETED FRAMES/S</div>
        </div>
        <Fine>
          Native · dense 160×50 · 10,000 frames × 3 runs, slowest run · GPU fences · not display
          refresh · M5 Max · Chrome 155
        </Fine>
      </>
    );
  }
  if (scene === 'Dive') {
    const word = k >= 37 ? 2 : k >= 35 ? 1 : 0;
    return (
      <>
        <div style={{ ...centered, top: 380 }}>
          <Slam key={word} t={since([32, 35, 37][word])} size={300} from={0.3}>
            {['ALL', 'TERMINAL', 'CELLS.'][word]}
          </Slam>
        </div>
        <Fine>Rendered by Wraith: ANSI pipes, ordinary terminal output</Fine>
      </>
    );
  }
  if (scene === 'Install') {
    const tokens = ['npm', ' i', ' wraith', 'term'].slice(0, k - 39).join(''),
      punch = Math.exp(-since(k) / 5);
    return (
      <div style={{ ...centered, top: 390 }}>
        <div
          style={{
            ...mono,
            fontSize: 150,
            padding: '36px 80px',
            background: '#0d0906ee',
            border: `2px solid ${amber}`,
            borderRadius: 26,
            boxShadow: `0 0 ${40 + 120 * punch}px #ff9a3c${punch > 0.3 ? '99' : '55'}`,
            transform: `scale(${1 + 0.09 * punch})`,
            whiteSpace: 'pre',
          }}
        >
          <span style={{ color: amber }}>$ </span>
          {tokens}
          <span style={{ opacity: Math.floor(frame / 14) % 2 ? 0 : 1, color: amber }}>▍</span>
        </div>
      </div>
    );
  }
  if (scene === 'Site') {
    if (k < 46)
      return (
        <div style={{ position: 'absolute', left: 120, top: 210 }}>
          <Slam t={since(44)} size={170} style={{ transformOrigin: 'left center' }}>
            BUILD NATIVE
            <br />
            EXPERIENCES
          </Slam>
          {k >= 45 ? (
            <Slam
              t={since(45)}
              size={210}
              word
              style={{ marginTop: 18, transformOrigin: 'left center' }}
            >
              ON THE WEB.
            </Slam>
          ) : null}
        </div>
      );
    return (
      <>
        <div style={{ position: 'absolute', left: 120, top: 250 }}>
          <Slam t={since(46)} size={280} word from={2.6} style={{ transformOrigin: 'left center' }}>
            GPU
            <br />
            FAST.
          </Slam>
        </div>
        <Tag
          style={{
            position: 'absolute',
            left: 124,
            bottom: 90,
            fontSize: 36,
            letterSpacing: '.12em',
          }}
        >
          wraithterm.com
        </Tag>
      </>
    );
  }
  return (
    <div style={{ ...centered, top: 520 }}>
      <Slam t={since(48)} size={300} word from={3}>
        WRAITH
      </Slam>
      {k >= 49 ? (
        <Slam t={since(49)} size={76} from={1.4} style={{ marginTop: 26 }}>
          wraithterm.com
        </Slam>
      ) : null}
      {k >= 50 ? (
        <Tag
          style={{
            marginTop: 34,
            fontSize: 40,
            letterSpacing: '.06em',
            opacity: Math.min(1, since(50) / 6),
          }}
        >
          npm i wraithterm
        </Tag>
      ) : null}
    </div>
  );
};

export const Hyped: React.FC = () => {
  const frame = useCurrentFrame(),
    { delayRender, continueRender, cancelRender } = useDelayRender();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const handle = delayRender('Local Wraith fonts');
    const faces = [
      new FontFace('Manrope', `url(${staticFile('Manrope.ttf')})`, { weight: '800' }),
      new FontFace('JetBrains', `url(${staticFile('JetBrainsMono.ttf')})`, { weight: '400' }),
    ];
    Promise.all(faces.map((f) => f.load()))
      .then((fonts) => {
        fonts.forEach((f) => document.fonts.add(f));
        setReady(true);
        continueRender(handle);
      })
      .catch(cancelRender);
    return () => continueRender(handle);
  }, [delayRender, continueRender, cancelRender]);

  const k = beatAt(frame),
    scene = SCENES.find((s) => k >= s.from && k < s.to)!,
    local = frame - b(scene.from),
    length = b(scene.to) - b(scene.from);
  const hitBeat = lastHit(frame),
    h = Math.exp(-(frame - b(hitBeat)) / 5),
    amp = (SLAMS.has(hitBeat) ? 30 : 11) * h;
  const shake = `translate(${(rnd(frame) - 0.5) * 2 * amp}px, ${(rnd(frame + 0.5) - 0.5) * 2 * amp}px) rotate(${(rnd(frame + 0.25) - 0.5) * amp * 0.05}deg) scale(${1 + 0.05 * h})`;
  const flash = Math.max(
    0,
    ...FLASHES.map((n) => frame - b(n)).map((t) =>
      t >= 0 && t < 10 ? 0.6 * Math.exp(-t / 2.5) : 0,
    ),
  );
  const whip = ['Whips', 'Barrage'].includes(scene.name)
    ? Math.max(0, 6 * (1 - (frame - b(k)) / 5))
    : 0;
  const speed =
    scene.name === 'Dive'
      ? 0.3 + 0.7 * (local / length) ** 1.5
      : ['Whips', 'End', 'Wraith'].includes(scene.name)
        ? 0.6 * h
        : 0;
  const ghost =
    scene.name === 'End'
      ? {
          position: [0, 1.45 - 2.5 * (1 - snap(frame - b(48), 200, 16)), -4] as [
            number,
            number,
            number,
          ],
          rotation: [0.05, Math.sin(frame / 40) * 0.25, 0] as [number, number, number],
          scale: 0.48 + 0.04 * h,
        }
      : scene.name === 'Wraith'
        ? {
            position: [-3.4, 0.3, -4 + 0.6 * h] as [number, number, number],
            rotation: [0.05, 0.4 + Math.PI * 2 * (1 - snap(frame - b(10), 160, 20)), 0] as [
              number,
              number,
              number,
            ],
            scale: 0.95 + 0.06 * h,
          }
        : {};

  return (
    <AbsoluteFill className="film">
      <Audio src={staticFile('flex-music.wav')} />
      <AbsoluteFill style={{ transform: shake }}>
        <AbsoluteFill
          style={{
            background: `radial-gradient(ellipse at 50% 55%, rgba(150,64,18,${0.28 + 0.18 * h}), transparent 72%)`,
          }}
        />
        <AbsoluteFill
          style={{
            filter:
              [
                whip ? `blur(${whip}px)` : '',
                scene.name === 'Question' && k >= 5 ? 'grayscale(1) brightness(.55)' : '',
              ]
                .join(' ')
                .trim() || undefined,
          }}
        >
          <ThreeCanvas
            width={1920}
            height={1080}
            camera={{ fov: 32, position: [0, 0, 8], near: 0.1, far: 100 }}
            gl={{ antialias: true, alpha: true }}
            dpr={1}
            style={{ position: 'absolute' }}
          >
            <ambientLight intensity={0.65 + 0.4 * h} />
            <directionalLight position={[-4, 6, 6]} intensity={2.5} color="#ffddba" />
            <directionalLight position={[5, -1, 1]} intensity={1.4} color="#a6b8cb" />
            <pointLight position={[-5, 1, -1]} intensity={12 + 18 * h} color="#ff9a3c" />
            {scene.name === 'End' ? (
              <pointLight position={[0, 1.4, -1.2]} intensity={40 + 60 * h} color="#ffb070" />
            ) : null}
            <Ghost {...ghost} />
            {panels(scene.name, frame, local, length, h).map((pose, j) => (
              <Browser key={`${scene.name}-${pose.file}-${j}`} {...pose} />
            ))}
          </ThreeCanvas>
        </AbsoluteFill>
        {speed > 0 ? <SpeedLines frame={frame} strength={speed} /> : null}
        <AbsoluteFill
          style={{ background: 'radial-gradient(ellipse, transparent 40%, #000a 100%)' }}
        />
        {ready ? <Copy scene={scene.name} frame={frame} /> : null}
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          pointerEvents: 'none',
          opacity: 0.07,
          background: 'repeating-linear-gradient(0deg, #000 0 2px, transparent 2px 4px)',
        }}
      />
      {flash > 0.01 ? <AbsoluteFill style={{ background: '#ffe2c2', opacity: flash }} /> : null}
      <div
        style={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          height: 4,
          width: `${(frame / (TOTAL - 1)) * 100}%`,
          background: amber,
          boxShadow: `0 0 ${10 + 30 * h}px ${amber}`,
        }}
      />
    </AbsoluteFill>
  );
};
