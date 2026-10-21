import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = import.meta.dirname;
const video = resolve(root, '..');
const output = resolve(root, 'public');
await mkdir(output, { recursive: true });
for (const name of ['home', 'reactor', 'pipes', 'dense', 'compatible']) {
  await copyFile(resolve(video, `footage/hype-${name}.mp4`), resolve(output, `${name}.mp4`));
}
for (const [from, to] of [
  ['footage/hype-score.wav', 'music.wav'],
  ['footage/hype-chrome.png', 'chrome.png'],
  ['media/Manrope-800.ttf', 'Manrope.ttf'],
  ['media/JetBrainsMono-Regular.ttf', 'JetBrainsMono.ttf'],
])
  await copyFile(resolve(video, from), resolve(output, to));
console.log('Prepared local footage, stereo mix and fonts. No media is committed.');
