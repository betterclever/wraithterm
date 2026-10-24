// Writes raw RGB preview frames of the raycaster for a contact sheet: node raycast-preview.mjs out.rgb w h
import { raycastPixels } from './raycast.js';
import { writeFileSync } from 'node:fs';
const [out, w, h] = [process.argv[2], +process.argv[3], +process.argv[4]];
const frames = [];
for (let i = 0; i < 12; i++) frames.push(raycastPixels(w, h, i * 0.9));
writeFileSync(out, Buffer.concat(frames.map((f) => Buffer.from(f))));
