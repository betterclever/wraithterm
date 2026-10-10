// Keep the pinned API declarations and stylesheet usable through npm aliases.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstream = resolve(root, 'node_modules/@wraith-terminal/xterm-base');
const typings = (await readFile(resolve(upstream, 'typings/xterm.d.ts'), 'utf8'))
  .replace(/declare module '@xterm\/xterm' \{/, '')
  .replace(/\}\s*$/, '')
  .replace(/^  (interface|type|class|enum|namespace) /gm, '  export $1 ');
await writeFile(resolve(root, 'packages/wraith/src/xterm-api.d.ts'), typings);
await mkdir(resolve(root, 'packages/wraith/dist'), { recursive: true });
await writeFile(resolve(root, 'packages/wraith/dist/xterm-api.d.ts'), typings);
await mkdir(resolve(root, 'packages/wraith/css'), { recursive: true });
await copyFile(resolve(upstream, 'css/xterm.css'), resolve(root, 'packages/wraith/css/xterm.css'));
await copyFile(resolve(upstream, 'LICENSE'), resolve(root, 'licenses/xterm-MIT.txt'));
