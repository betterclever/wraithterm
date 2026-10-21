import React, { useEffect, useState } from 'react';
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  useDelayRender,
} from 'remotion';
import { Audio } from '@remotion/media';
import { ThreeCanvas } from '@remotion/three';
import { Browser, type BrowserPose } from './Browser';
import { Ghost } from './Ghost';
import { BEAT, CUES, DURATION, SHOTS, pulseAt } from './timing';
import proof from '../../claims/hype-native.json';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const useFonts = () => {
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const handle = delayRender('Load local Wraith typefaces');
    const faces = [
      new FontFace('Manrope', `url(${staticFile('Manrope.ttf')})`, { weight: '800' }),
      new FontFace('JetBrains', `url(${staticFile('JetBrainsMono.ttf')})`, { weight: '400' }),
    ];
    Promise.all(faces.map((font) => font.load()))
      .then((fonts) => {
        fonts.forEach((font) => document.fonts.add(font));
        setReady(true);
        continueRender(handle);
      })
      .catch(cancelRender);
    return () => continueRender(handle);
  }, [delayRender, continueRender, cancelRender]);
  return ready;
};

function poses(
  id: number,
  local: number,
  a: number,
  k: number,
  exit: number,
  pulse: number,
): BrowserPose[] {
  const slam = spring({
    frame: local - Math.round(4 * BEAT),
    fps: 60,
    config: { damping: 17, stiffness: 235 },
  });
  switch (id) {
    case 0:
      return [
        {
          file: 'reactor',
          position: [1.2 - 1.2 * a, -0.45, -2 + 0.7 * k],
          rotation: [0.12, 0.95 - 0.4 * k, -0.08],
          width: 6.3,
        },
      ];
    case 1:
      return [
        {
          file: 'home',
          position: [(1 - a) * 3.2 - exit * 2.4, 0.08, -1.1 + 0.08 * pulse],
          rotation: [0.1 * (1 - a), -0.5 + 0.2 * k + 0.86 * slam, -0.035 + 0.055 * slam],
          width: 6.1,
        },
      ];
    case 2:
      return [
        {
          file: 'pipes',
          position: [-2.6, 0.6, -4.3],
          rotation: [0.14, 0.45, -0.12],
          width: 4.9,
          opacity: 0.5,
        },
        {
          file: 'reactor',
          position: [0.1 - 0.3 * k, 0.1, -1.1 + 0.08 * pulse],
          rotation: [0.07 - 0.15 * slam, 0.4 - 0.2 * k - 0.7 * slam, 0.05 - 0.1 * k],
          width: 5.9,
        },
      ];
    case 3:
      return [
        {
          file: 'dense',
          position: [2.05 + 2 * (1 - a), 0.1, -1.7],
          rotation: [-0.08, -0.3 + 0.1 * k, 0.03],
          width: 4.45,
        },
      ];
    case 4:
      return [
        {
          file: 'pipes',
          position: [-0.1 + 0.3 * k, 0.12, -0.9 + 0.08 * pulse],
          rotation: [-0.16 + 0.3 * slam, 0.5 - 0.2 * k - 0.76 * slam, -0.06 + 0.12 * slam],
          width: 6.1,
        },
      ];
    case 5:
      return [
        {
          file: 'compatible',
          position: [2.25, 0.4, -3.6],
          rotation: [0.09, -0.5, 0.1],
          width: 5,
          opacity: 0.5,
        },
        {
          file: 'reactor',
          position: [-0.65 + 0.3 * k, 0.15, -1.0],
          rotation: [0.1, 0.22 - 0.22 * k, -0.02],
          width: 5.7,
        },
      ];
    default:
      return [
        {
          file: 'home',
          position: [0, -0.1, -6 - 2 * k],
          rotation: [0.1, 0.2 - 0.15 * k, 0],
          width: 6.8,
          opacity: 0.18 * (1 - a),
        },
      ];
  }
}

const Copy: React.FC<{ id: number; entrance: number; local: number }> = ({
  id,
  entrance,
  local,
}) => {
  const impact = spring({ frame: local, fps: 60, config: { damping: 18, stiffness: 260 } });
  const title =
    id === 3 || id === 6
      ? {
          opacity: 1,
          transform: `scale(${1.06 - 0.06 * impact})`,
          transformOrigin: id === 3 ? 'left center' : 'center center',
        }
      : { opacity: entrance, transform: `translateY(${(1 - entrance) * 28}px)` };
  if (id === 0)
    return (
      <div style={{ position: 'absolute', left: 142, top: 110, ...title }}>
        <div className="wordmark" style={{ fontSize: 168 }}>
          WRAITH
        </div>
        <div className="mono" style={{ fontSize: 30, marginTop: 28, letterSpacing: '.12em' }}>
          THE WEB TERMINAL.
        </div>
      </div>
    );
  if (id === 2)
    return (
      <div
        className="mono"
        style={{ position: 'absolute', bottom: 99, left: 145, fontSize: 28, color: '#ffc38d' }}
      >
        EVERYTHING YOU SEE. TERMINAL CELLS.
      </div>
    );
  if (id === 3)
    return (
      <>
        <div style={{ position: 'absolute', left: 136, top: 310, ...title }}>
          <div className="wordmark" style={{ fontSize: 223, letterSpacing: '-.09em' }}>
            {proof.headline}
          </div>
          <div className="mono" style={{ fontSize: 35, marginTop: 35 }}>
            GPU-COMPLETED FRAMES/S¹
          </div>
          <div className="mono" style={{ fontSize: 28, marginTop: 26, color: '#bc9b82' }}>
            RUST / WASM / WEBGPU
          </div>
        </div>
        <div
          className="mono"
          style={{
            position: 'absolute',
            left: 145,
            bottom: 99,
            fontSize: 26,
            lineHeight: 1.7,
            color: '#bc9b82',
          }}
        >
          ¹ Native · 160×50 dense · M5 Max · Chrome 155
          <br />
          10,000 frames/run · GPU fences · not display refresh
        </div>
      </>
    );
  if (id === 4)
    return (
      <div
        className="mono"
        style={{ position: 'absolute', bottom: 99, left: 145, fontSize: 28, color: '#ffc38d' }}
      >
        GHOSTTY ON THE WEB.
      </div>
    );
  if (id === 5)
    return (
      <div
        style={{ position: 'absolute', bottom: 98, width: '100%', textAlign: 'center', ...title }}
      >
        <div
          className="mono"
          style={{
            fontSize: 56,
            background: '#100c09f5',
            border: '1px solid #87532b',
            borderRadius: 18,
            padding: '27px 70px',
            display: 'inline-block',
            boxShadow: '0 18px 60px #0008',
          }}
        >
          npm i wraithterm
        </div>
        <div className="mono" style={{ fontSize: 29, color: '#ffc38d', marginTop: 30 }}>
          XTERM API. WEBGPU SPEED.
        </div>
      </div>
    );
  if (id === 6)
    return (
      <div style={{ position: 'absolute', width: '100%', top: 300, textAlign: 'center', ...title }}>
        <div className="wordmark" style={{ fontSize: 245 }}>
          WRAITH
        </div>
        <div style={{ fontSize: 72, marginTop: 45, letterSpacing: '-.04em' }}>wraithterm.com</div>
        <div className="mono" style={{ fontSize: 37, marginTop: 136, color: '#ffc38d' }}>
          npm i wraithterm
        </div>
      </div>
    );
  return null;
};

export const Hype: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const fontsReady = useFonts();
  const id = Math.min(
    6,
    CUES.findIndex((cue, i) => frame >= cue && frame < CUES[i + 1]),
  );
  const local = frame - CUES[id];
  const length = CUES[id + 1] - CUES[id];
  const entrance = spring({
    frame: local,
    fps,
    config: { damping: 22, stiffness: 195 },
    durationInFrames: 22,
  });
  const progress = local / length;
  const exit = interpolate(local, [length - 10, length], [0, 1], clamp);
  const pulse = pulseAt(frame);
  const panels = poses(id, local, entrance, progress, exit, pulse);
  const grade = id === 6 ? 0.7 : 0.9;
  return (
    <AbsoluteFill className="film">
      <Audio src={staticFile('music.wav')} />
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at 26% 46%, rgba(102,49,20,${0.24 + pulse * 0.025}), transparent 70%)`,
        }}
      />
      <ThreeCanvas
        width={width}
        height={height}
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
        <Sequence from={CUES[id]} durationInFrames={length} layout="none" name={SHOTS[id]} key={id}>
          {panels.map((panel, i) => (
            <Browser key={`${id}-${i}`} {...panel} />
          ))}
        </Sequence>
      </ThreeCanvas>
      <AbsoluteFill
        style={{
          pointerEvents: 'none',
          background: `radial-gradient(ellipse, transparent 40%, rgba(0,0,0,${grade * 0.5}) 100%)`,
        }}
      />
      {fontsReady ? <Copy id={id} entrance={id === 0 ? 1 : entrance} local={local} /> : null}
      <div className="progress">
        <div style={{ width: `${(100 * frame) / (DURATION - 1)}%` }} />
      </div>
    </AbsoluteFill>
  );
};
