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
if (process.argv.includes('--flex')) {
  for (const name of ['complex-webgl', 'complex-wraith', 'showcase-webgl', 'showcase-wraith'])
    await copyFile(resolve(video, `footage/hype-${name}.mp4`), resolve(output, `${name}.mp4`));
  await copyFile(resolve(video, 'footage/hype-flex-score.wav'), resolve(output, 'flex-music.wav'));
  await copyFile(resolve(video, 'footage/dom.mp4'), resolve(output, 'xterm-dom.mp4'));
}
if (process.argv.includes('--ongo'))
  for (const name of [
    'wall-webgl',
    'wall-native',
    'doomish-native',
    'doomish-webgl',
    'doom-text-native',
    'doom-kitty-native',
    'work-scene-native',
  ])
    await copyFile(resolve(video, `footage/${name}.mp4`), resolve(output, `${name}.mp4`));
console.log('Prepared local footage, stereo mix and fonts. No media is committed.');
