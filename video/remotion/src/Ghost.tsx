import React, { useEffect, useMemo } from 'react';
import { BoxGeometry, MeshStandardMaterial, Object3D, InstancedMesh } from 'three';
import { useCurrentFrame } from 'remotion';
import sprite from '../../../demo/ghost-sprite.json';
import { pulseAt } from './timing';

// Website sprite cells become one instanced, extruded 3D mascot. Eye holes and
// tails come from the same source asset; there is no separately redrawn logo.
export const Ghost: React.FC = () => {
  const frame = useCurrentFrame();
  const cells = useMemo(
    () =>
      [...sprite.body, ...sprite.tails[0]].flatMap((row, y) =>
        [...row].flatMap((c, x) =>
          c === '#' ? [[(x - 7.5) * 0.26, (7.5 - y) * 0.26] as const] : [],
        ),
      ),
    [],
  );
  const mesh = useMemo(() => {
    const geo = new BoxGeometry(0.255, 0.255, 0.26);
    const material = new MeshStandardMaterial({
      color: '#443226',
      metalness: 0.65,
      roughness: 0.48,
    });
    const instance = new InstancedMesh(geo, material, cells.length);
    const dummy = new Object3D();
    cells.forEach(([x, y], i) => {
      dummy.position.set(x, y, 0);
      dummy.updateMatrix();
      instance.setMatrixAt(i, dummy.matrix);
    });
    instance.instanceMatrix.needsUpdate = true;
    return instance;
  }, [cells]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as MeshStandardMaterial).dispose();
    },
    [mesh],
  );
  return (
    <group
      position={[-2.7, 0.25 + Math.sin(frame / 80) * 0.08, -5.0]}
      rotation={[0.02, 0.14 + Math.sin(frame / 170) * 0.17, 0]}
      scale={1.1 + pulseAt(frame) * 0.008}
    >
      <primitive object={mesh} />
    </group>
  );
};
