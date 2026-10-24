import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { Video } from '@remotion/media';
import { staticFile, useRemotionEnvironment, useDelayRender } from 'remotion';
import { CanvasTexture, ExtrudeGeometry, LinearFilter, Shape, SRGBColorSpace } from 'three';

export type BrowserPose = {
  file: string;
  position: [number, number, number];
  rotation: [number, number, number];
  width?: number;
  opacity?: number;
  // Omit the wraithterm.com chrome, e.g. around another product's footage.
  bare?: boolean;
  // Screen power, 0 (off) to 1; lets a screen boot on camera.
  brightness?: number;
  // Opacity of a mirrored floor reflection drawn from the same texture.
  reflection?: number;
};

const makeShape = (w: number, h: number, r: number) => {
  const s = new Shape();
  const x = -w / 2,
    y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
};

export const Browser: React.FC<BrowserPose> = ({
  file,
  position,
  rotation,
  width = 6.5,
  opacity = 1,
  bare = false,
  brightness = 1,
  reflection = 0,
}) => {
  const height = (width * 1230) / 1920;
  const [surface] = useState(() => {
    const canvas = new OffscreenCanvas(1920, 1230);
    const context = canvas.getContext('2d');
    if (!context) throw Error('2D video texture context is unavailable');
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    return { canvas, context, texture };
  });
  const { invalidate, advance } = useThree();
  const { isRendering } = useRemotionEnvironment();
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  const [chrome, setChrome] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    const handle = delayRender('Load local browser chrome');
    const image = new Image();
    image.onload = () => {
      setChrome(image);
      continueRender(handle);
    };
    image.onerror = () => cancelRender(Error('Cannot load browser chrome'));
    image.src = staticFile('chrome.png');
    return () => {
      image.onload = null;
      image.onerror = null;
      continueRender(handle);
    };
  }, [delayRender, continueRender, cancelRender]);
  useEffect(() => () => surface.texture.dispose(), [surface]);
  const [fade] = useState(() => {
    const canvas = new OffscreenCanvas(4, 256);
    const c = canvas.getContext('2d')!;
    const g = c.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#000');
    g.addColorStop(0.55, '#000');
    g.addColorStop(1, '#fff');
    c.fillStyle = g;
    c.fillRect(0, 0, 4, 256);
    return new CanvasTexture(canvas);
  });
  useEffect(() => () => fade.dispose(), [fade]);
  const geometry = useMemo(
    () =>
      new ExtrudeGeometry(makeShape(width, height, 0.085), {
        depth: 0.095,
        bevelEnabled: true,
        bevelSegments: 3,
        steps: 1,
        bevelSize: 0.018,
        bevelThickness: 0.018,
        curveSegments: 12,
      }),
    [width, height],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  const onFrame = useCallback(
    (source: CanvasImageSource) => {
      const c = surface.context;
      c.fillStyle = '#08090b';
      c.fillRect(0, 0, 1920, 1230);
      if (chrome && !bare) c.drawImage(chrome, 0, 0, 1920, 150);
      const image = source as {
        displayWidth?: number;
        displayHeight?: number;
        width?: number;
        height?: number;
      };
      const sw = image.displayWidth ?? image.width ?? 1920;
      const sh = image.displayHeight ?? image.height ?? 1080;
      const scale = Math.min(1900 / sw, 1070 / sh);
      c.drawImage(
        source,
        (1920 - sw * scale) / 2,
        150 + (1080 - sh * scale) / 2,
        sw * scale,
        sh * scale,
      );
      // This is outside the R3F pass. Advance synchronously after every extracted
      // video frame so concurrent Remotion screenshots never capture stale pixels.
      surface.texture.needsUpdate = true;
      if (isRendering) advance(performance.now());
      else invalidate();
    },
    [surface, chrome, bare, advance, invalidate, isRendering],
  );
  return (
    <group position={position} rotation={rotation}>
      {chrome ? (
        <Video
          src={staticFile(`${file}.mp4`)}
          loop
          muted
          headless
          onVideoFrame={onFrame}
          disallowFallbackToOffthreadVideo
        />
      ) : null}
      <mesh geometry={geometry} position={[0, 0, -0.07]}>
        <meshStandardMaterial
          color="#8b664c"
          metalness={0.8}
          roughness={0.3}
          transparent={opacity < 1}
          opacity={opacity}
        />
      </mesh>
      <mesh position={[0, 0, 0.045]}>
        <planeGeometry args={[width - 0.035, height - 0.035]} />
        <meshBasicMaterial
          map={surface.texture}
          color={[brightness, brightness, brightness]}
          toneMapped={false}
          transparent={opacity < 1}
          opacity={opacity}
        />
      </mesh>
      {reflection > 0 ? (
        <mesh position={[0, -height - 0.12, 0.045]} scale={[1, -1, 1]}>
          <planeGeometry args={[width - 0.035, height - 0.035]} />
          <meshBasicMaterial
            map={surface.texture}
            alphaMap={fade}
            color={[brightness, brightness, brightness]}
            toneMapped={false}
            transparent
            opacity={reflection * opacity}
            depthWrite={false}
          />
        </mesh>
      ) : null}
      <mesh position={[0, 0, -0.073]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[width - 0.1, height - 0.1]} />
        <meshStandardMaterial
          color="#20140e"
          metalness={0.75}
          roughness={0.3}
          transparent={opacity < 1}
          opacity={opacity}
        />
      </mesh>
    </group>
  );
};
