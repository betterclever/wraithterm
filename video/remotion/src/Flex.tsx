import React, { useEffect, useState } from 'react';
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useDelayRender,
} from 'remotion';
import { Audio } from '@remotion/media';
import { ThreeCanvas } from '@remotion/three';
import { Browser, type BrowserPose } from './Browser';
import { Ghost } from './Ghost';
import edit from '../flex-edit.json';
import comparison from '../../claims/hype-comparison.json';
import native from '../../claims/hype-native.json';

const dense = comparison.groups.find((g) => g.workload === 'complex')!;
const total = edit.cues.at(-1)!;
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const ease = (frame: number, delay = 0, damping = 22) =>
  spring({ frame: frame - delay, fps: edit.fps, config: { damping, stiffness: 270 } });
const mono: React.CSSProperties = { fontFamily: 'JetBrains', fontWeight: 400 };
const amber = '#ffc18b';

function panels(id: number, f: number, n: number): BrowserPose[] {
  const a = ease(f),
    k = f / n,
    whip = ease(f, 0, 17),
    end = ease(f, n - 9, 20);
  const p = (
    file: string,
    position: BrowserPose['position'],
    rotation: BrowserPose['rotation'],
    width = 6,
    opacity = 1,
  ): BrowserPose => ({ file, position, rotation, width, opacity });
  switch (id) {
    case 0:
      return [p('complex-webgl', [0, -0.3, -5], [0.1, 0.3, -0.09], 7, 0.14)];
    // Thin rim sweeps diagonally into view, then match-cuts onto the face.
    case 1:
      return [
        p(
          'reactor',
          [1.2 - 1.4 * a, 0, 2.0 - 3 * a],
          [0.6 - 0.4 * a, 1.5 - 0.35 * k, -0.55 + 0.34 * a],
          7,
        ),
      ];
    case 2:
      return [
        p(
          'reactor',
          [-0.1, 0.05, -0.5 + 0.35 * k],
          [0.08 - 0.12 * k, -0.52 + 0.8 * a, 0.06 - 0.12 * k],
          6.4,
        ),
      ];
    case 3:
      return [
        p('complex-webgl', [-1.85, 0, -1.8], [0.05, 0.27, -0.025], 3.5),
        p('complex-wraith', [1.85, 0, -1.8], [0.05, -0.27, 0.025], 3.5),
      ];
    case 4:
      return [
        p('complex-webgl', [2.1 + 2 * (1 - a), 0.05, -2.1], [-0.08, -0.4 + 0.13 * k, 0.07], 4.1),
      ];
    case 5:
      return [
        p('complex-webgl', [-2.5, 0.3, -4.5], [0.12, 0.55, -0.15], 4.4, 0.32),
        p(
          'complex-wraith',
          [0.55, 0.0, -1.0 + 0.12 * k],
          [-0.08 + 0.13 * k, -0.5 + 0.75 * whip, 0.035],
          5.5,
        ),
      ];
    case 6:
      return [p('complex-wraith', [2.5, 0.15, -2.9], [0.1, -0.4, 0.05], 4.4, 0.65)];
    case 7:
      return [
        p('showcase-webgl', [-2.5, 0.3, -4.0], [0.08, 0.5, -0.06], 4.5, 0.45),
        p('showcase-wraith', [1.35, 0.15, -2.3], [-0.1, -0.3 + 0.45 * a, 0.04], 4.6),
      ];
    case 8:
      return [p('dense', [2.05 + 1.6 * (1 - a), 0.1, -1.9], [-0.08, -0.3, 0.03], 4.4)];
    // Dolly close to a tilted screen; the next shot opens on its opposing face.
    case 9:
      return [
        p(
          'pipes',
          [0.15, -0.05, 2.8 - 3.3 * a + 1.3 * end],
          [-0.42 + 0.48 * a, 0.8 - 1.08 * a, -0.28 + 0.35 * a],
          6.1,
        ),
      ];
    case 10:
      return [
        p(
          'pipes',
          [-0.1, 0.05, -0.8 + 1.4 * end],
          [0.15 - 0.28 * k, -0.48 + 0.98 * k, 0.12 - 0.23 * k],
          6.3,
        ),
      ];
    case 11:
      return [
        p('compatible', [2.3, 0.4, -3.8], [0.08, -0.48, 0.09], 4.5, 0.45),
        p('reactor', [-0.6, 0.1, -1.8], [0.12, 0.5 - 0.65 * a, -0.04], 5.5),
      ];
    case 12:
      return [
        p(
          'home',
          [2.2 * (1 - a) - 3 * end, 0, -1.3],
          [0.3 * (1 - a), 1.3 * (1 - whip) - 0.12, -0.18 * (1 - a)],
          6.2,
        ),
      ];
    default:
      return [];
  }
}

const Small: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({
  children,
  style,
}) => <div style={{ ...mono, fontSize: 28, color: amber, ...style }}>{children}</div>;
const foot: React.CSSProperties = {
  position: 'absolute',
  left: 126,
  bottom: 82,
  ...mono,
  fontSize: 24,
  lineHeight: 1.55,
  color: '#c9ac94',
};
const compareFoot = (
  <>
    Compatible · dense 240×80 · DPR 1 · M5 Max · Chrome 155
    <br />3 serial runs · warmed cores · edited fixture playback
  </>
);

const Copy: React.FC<{ id: number; f: number }> = ({ id, f }) => {
  const a = ease(f),
    impact = 1.07 - 0.07 * a;
  const heading: React.CSSProperties = {
    fontSize: 156,
    lineHeight: 0.98,
    letterSpacing: '-.065em',
    fontWeight: 800,
  };
  if (id === 0)
    return (
      <div style={{ position: 'absolute', left: 150, top: 250, width: 1620 }}>
        <div style={{ ...heading, fontSize: 130 }}>WHY IS YOUR</div>
        <div className="wordmark" style={{ fontSize: 158, marginTop: 12 }}>
          WEB TERMINAL
        </div>
        <div style={{ ...heading, fontSize: 130, marginTop: 12 }}>
          STILL SLOW<span style={{ color: amber }}>?</span>
        </div>
      </div>
    );
  if (id === 1 || id === 2)
    return (
      <div style={{ position: 'absolute', left: 136, top: id === 1 ? 110 : 114 }}>
        <Small style={{ fontSize: 27, letterSpacing: '.20em', marginBottom: 22 }}>MEET</Small>
        <div
          className="wordmark"
          style={{ fontSize: 174, transform: `scale(${impact})`, transformOrigin: 'left center' }}
        >
          WRAITH
        </div>
      </div>
    );
  if (id === 3)
    return (
      <>
        <div
          style={{
            position: 'absolute',
            top: 106,
            width: '100%',
            textAlign: 'center',
            ...heading,
            fontSize: 78,
          }}
        >
          SAME BYTES. SAME GRID.
        </div>
        <Small style={{ position: 'absolute', left: 290, top: 800 }}>xterm.js + WebGL</Small>
        <Small style={{ position: 'absolute', left: 1115, top: 800 }}>WRAITH COMPAT</Small>
        <div style={foot}>{compareFoot}</div>
      </>
    );
  if (id === 4)
    return (
      <>
        <div style={{ position: 'absolute', left: 136, top: 245 }}>
          <Small>VERSUS xterm.js + WebGL</Small>
          <div
            className="wordmark"
            style={{
              fontSize: 233,
              marginTop: 28,
              transform: `scale(${impact})`,
              transformOrigin: 'left center',
            }}
          >
            {dense.throughputHeadline}×
          </div>
          <div style={{ ...mono, fontSize: 34, marginTop: 32 }}>GPU-COMPLETED UPDATES/S</div>
          <Small style={{ color: '#c9ac94', fontSize: 25, marginTop: 22 }}>
            slowest Wraith ÷ fastest xterm
          </Small>
        </div>
        <div style={foot}>
          {compareFoot}
          <br />
          GPU fences every 32 updates · not display FPS
        </div>
      </>
    );
  if (id === 5)
    return (
      <>
        <div style={{ position: 'absolute', left: 130, top: 115, ...heading, fontSize: 90 }}>
          SAME API. MORE HEADROOM.
        </div>
        <div style={{ position: 'absolute', left: 134, top: 790, ...mono, fontSize: 35 }}>
          <span style={{ color: amber }}>
            {Math.floor(Math.min(...dense.renderers.wraith.updatesPerSecond))}
          </span>{' '}
          vs{' '}
          <span style={{ color: '#d6c4b5' }}>
            {(Math.ceil(Math.max(...dense.renderers.webgl.updatesPerSecond) * 10) / 10).toFixed(1)}
          </span>{' '}
          completed updates/s
        </div>
        <div style={foot}>
          {compareFoot}
          <br />
          Bounds across 3 runs · Wraith / xterm WebGL
        </div>
      </>
    );
  if (id === 6)
    return (
      <>
        <div style={{ position: 'absolute', left: 136, top: 245 }}>
          <Small>VERSUS xterm.js DOM</Small>
          <div
            className="wordmark"
            style={{
              fontSize: 235,
              marginTop: 28,
              transform: `scale(${impact})`,
              transformOrigin: 'left center',
            }}
          >
            {dense.cpuHeadline}×
          </div>
          <div style={{ ...mono, fontSize: 43, marginTop: 28 }}>LESS CPU TIME / UPDATE</div>
          <Small style={{ fontSize: 28, marginTop: 28, color: '#c9ac94' }}>
            {Math.min(...dense.renderers.dom.cpuP50Ms).toFixed(1)} ms →{' '}
            {Math.max(...dense.renderers.wraith.cpuP50Ms).toFixed(1)} ms
          </Small>
        </div>
        <div style={foot}>
          {compareFoot}
          <br />
          Fastest DOM p50 ÷ slowest Wraith p50 · parse + draw/layout
        </div>
      </>
    );
  if (id === 7)
    return (
      <>
        <div style={{ position: 'absolute', left: 136, top: 156, ...heading, fontSize: 78 }}>
          MORE THAN ONE TEST.
        </div>
        <div style={{ position: 'absolute', left: 138, top: 350 }}>
          {comparison.groups.map((g) => (
            <div
              key={g.workload}
              style={{ display: 'flex', alignItems: 'center', gap: 34, marginBottom: 30 }}
            >
              <div className="wordmark" style={{ fontSize: 80, width: 205 }}>
                {g.throughputHeadline}×
              </div>
              <Small style={{ fontSize: 33 }}>
                {
                  { complex: 'DENSE', showcase: 'DASHBOARD', scroll: 'SCROLL + REPAINT' }[
                    g.workload
                  ]
                }
              </Small>
            </div>
          ))}
        </div>
        <div style={foot}>
          Compatible / xterm WebGL · GPU-completed updates/s
          <br />
          240×80 · DPR 1 · M5 Max · Chrome 155 · conservative run bounds
        </div>
      </>
    );
  if (id === 8)
    return (
      <>
        <div style={{ position: 'absolute', left: 134, top: 270 }}>
          <Small>THE NATIVE PATH</Small>
          <div className="wordmark" style={{ fontSize: 215, marginTop: 35 }}>
            {native.headline}
          </div>
          <div style={{ ...mono, fontSize: 34, marginTop: 35 }}>GPU-COMPLETED FRAMES/S</div>
        </div>
        <div style={foot}>
          Native · 160×50 dense · M5 Max · Chrome 155
          <br />
          10,000 frames/run · GPU fences · not display refresh
        </div>
      </>
    );
  if (id === 9 || id === 10)
    return (
      <Small style={{ position: 'absolute', left: 136, bottom: 95, fontSize: 34 }}>
        ALL TERMINAL CELLS.
      </Small>
    );
  if (id === 11)
    return (
      <div style={{ position: 'absolute', bottom: 98, width: '100%', textAlign: 'center' }}>
        <div
          style={{
            ...mono,
            fontSize: 56,
            display: 'inline-block',
            padding: '25px 64px',
            background: '#100c09f5',
            border: '1px solid #87532b',
            borderRadius: 18,
          }}
        >
          npm i wraithterm
        </div>
        <Small style={{ marginTop: 24, fontSize: 28 }}>XTERM API. WEBGPU SPEED.</Small>
      </div>
    );
  if (id === 12)
    return (
      <Small style={{ position: 'absolute', left: 136, bottom: 95, fontSize: 35 }}>
        YOUR NEXT TERMINAL STARTS HERE.
      </Small>
    );
  return (
    <div
      style={{
        position: 'absolute',
        top: 315,
        width: '100%',
        textAlign: 'center',
        transform: `scale(${impact})`,
      }}
    >
      <div className="wordmark" style={{ fontSize: 238 }}>
        WRAITH
      </div>
      <div style={{ fontWeight: 800, fontSize: 70, marginTop: 42, letterSpacing: '-.04em' }}>
        wraithterm.com
      </div>
      <Small style={{ fontSize: 35, marginTop: 126 }}>npm i wraithterm</Small>
    </div>
  );
};

export const Flex: React.FC = () => {
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
  const id = edit.cues.findIndex((start, i) => frame >= start && frame < edit.cues[i + 1]);
  const local = frame - edit.cues[id],
    length = edit.cues[id + 1] - edit.cues[id];
  const pulse = Math.exp(-((frame / ((60 / 131) * 60)) % 1) * 13);
  const reveal = [1, 3, 7, 12].includes(id) ? interpolate(local, [0, 11], [0, 1], clamp) : 1;
  return (
    <AbsoluteFill className="film">
      <Audio src={staticFile('flex-music.wav')} />
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at 28% 48%, rgba(115,53,22,${0.24 + 0.03 * pulse}), transparent 70%)`,
        }}
      />
      <AbsoluteFill
        style={{ clipPath: `polygon(0 0, ${reveal * 120}% 0, ${reveal * 120 - 20}% 100%, 0 100%)` }}
      >
        <ThreeCanvas
          width={1920}
          height={1080}
          camera={{ fov: 32, position: [0, 0, 8], near: 0.1, far: 100 }}
          gl={{ antialias: true, alpha: true }}
          dpr={1}
          style={{ position: 'absolute' }}
        >
          <ambientLight intensity={0.65} />
          <directionalLight position={[-4, 6, 6]} intensity={2.5} color="#ffddba" />
          <directionalLight position={[5, -1, 1]} intensity={1.4} color="#a6b8cb" />
          <pointLight position={[-5, 1, -1]} intensity={12} color="#e49545" />
          <Ghost />
          {edit.shots.map((name, i) => (
            <Sequence
              key={name}
              from={edit.cues[i]}
              durationInFrames={edit.cues[i + 1] - edit.cues[i]}
              layout="none"
              name={name}
            >
              {i === id
                ? panels(id, local, length).map((p, j) => <Browser key={`${id}-${j}`} {...p} />)
                : null}
            </Sequence>
          ))}
        </ThreeCanvas>
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          pointerEvents: 'none',
          background: 'radial-gradient(ellipse, transparent 42%, #0007 100%)',
        }}
      />
      {ready ? <Copy id={id} f={local} /> : null}
      {/* A thin amber sweep on the actual reveal edge, never a full-frame flash. */}
      {[1, 3, 7, 12].includes(id) && local < 11 ? (
        <div
          style={{
            position: 'absolute',
            top: -200,
            left: `${reveal * 120 - 10}%`,
            height: 1500,
            width: 3,
            background: amber,
            opacity: (1 - reveal) * 0.5,
            transform: 'rotate(20deg)',
            filter: 'blur(2px)',
          }}
        />
      ) : null}
      <div
        style={{
          position: 'absolute',
          left: 112,
          right: 112,
          bottom: 47,
          height: 1,
          background: '#91613e33',
        }}
      >
        <div
          style={{ height: 1, width: `${(frame / (total - 1)) * 100}%`, background: '#e5ac7e' }}
        />
      </div>
    </AbsoluteFill>
  );
};
