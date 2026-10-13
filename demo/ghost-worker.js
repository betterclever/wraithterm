import { GhostScene } from './ghost-scene.js';
let scene;
self.onmessage = ({ data }) => {
  try {
    if (!scene || scene.cols !== data.cols || scene.rows !== data.rows)
      scene = new GhostScene(data.cols, data.rows);
    const frame = scene.frame(data.time, data.input);
    self.postMessage({ id: data.id, ...frame }, [frame.bytes.buffer]);
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  }
};
