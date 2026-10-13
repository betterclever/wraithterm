// Encode completed studio sequences. Never silently use an incomplete render.
import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
for (const [shot, count] of [
  ['mark', 240],
  ['ribbon', 240],
  ['stack', 216],
]) {
  const dir = resolve(root, '.cache/phantom/studio', shot);
  for (let i = 1; i <= count; i++) {
    const path = resolve(dir, `frame-${String(i).padStart(4, '0')}.png`);
    if (statSync(path).size === 0) throw new Error(`Empty frame: ${path}`);
  }
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-v',
      'error',
      '-y',
      '-framerate',
      '60',
      '-i',
      resolve(dir, 'frame-%04d.png'),
      '-frames:v',
      String(count),
      '-c:v',
      'libx264',
      '-crf',
      '15',
      '-preset',
      'slow',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      resolve(root, 'footage', `phantom-${shot}.mp4`),
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error(`Encoding ${shot} failed`);
  console.log(`${shot}: ${count} frames encoded at 60 fps.`);
}
