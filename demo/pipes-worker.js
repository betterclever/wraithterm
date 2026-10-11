import { createPipesScene, rasterizePipes, encodePipeFrame } from './pipes-scene.js';

let scene, options;
function frame(time) {
  const start = performance.now();
  const image = rasterizePipes(scene, time, options);
  const rasterMs = performance.now() - start;
  const encoded = encodePipeFrame(image, options);
  return {
    ...encoded,
    time,
    rasterMs,
    generationMs: performance.now() - start,
    fragments: image.fragments,
  };
}
self.onmessage = async ({ data }) => {
  try {
    if (data.kind === 'init') {
      options = data.options;
      scene = createPipesScene(options);
      self.postMessage({ kind: 'scene', stats: scene.stats });
      if (data.mode === 'replay') {
        // A bounded bank; the player ping-pongs through it. No growing write queue.
        for (let i = 0; i < 48; i++) {
          const result = frame(i / 24);
          self.postMessage({ kind: 'frame', index: i, total: 48, ...result }, [
            result.bytes.buffer,
          ]);
          if (i % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        self.postMessage({ kind: 'ready' });
      } else self.postMessage({ kind: 'ready' });
    } else if (data.kind === 'frame') {
      if (!scene) throw new Error('Scene not initialized');
      const result = frame(data.time);
      self.postMessage({ kind: 'frame', ...result }, [result.bytes.buffer]);
    }
  } catch (error) {
    self.postMessage({ kind: 'error', message: String(error) });
  }
};
