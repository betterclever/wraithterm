import React from 'react';
import { Composition } from 'remotion';
import { Hype } from './Hype';
import { Flex } from './Flex';
import { Hyped } from './Hyped';
import { OnGo, ONGO_FRAMES } from './OnGo';
import { DURATION, FPS } from './timing';
import './style.css';

export const Root: React.FC = () => (
  <>
    <Composition
      id="WraithHype"
      component={Hype}
      fps={FPS}
      width={1920}
      height={1080}
      durationInFrames={DURATION}
    />
    <Composition
      id="WraithFlex"
      component={Flex}
      fps={FPS}
      width={1920}
      height={1080}
      durationInFrames={DURATION}
    />
    <Composition
      id="WraithHyped"
      component={Hyped}
      fps={FPS}
      width={1920}
      height={1080}
      durationInFrames={DURATION}
    />
    <Composition
      id="WraithOnGo"
      component={OnGo}
      fps={FPS}
      width={1920}
      height={1080}
      durationInFrames={ONGO_FRAMES}
    />
  </>
);
