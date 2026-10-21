import React from 'react';
import { Composition } from 'remotion';
import { Hype } from './Hype';
import { DURATION, FPS } from './timing';
import './style.css';

export const Root: React.FC = () => (
  <Composition
    id="WraithHype"
    component={Hype}
    fps={FPS}
    width={1920}
    height={1080}
    durationInFrames={DURATION}
  />
);
