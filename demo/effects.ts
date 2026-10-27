// The effects lab: built-in GPU post-process effects and a custom WGSL shader
// gallery over one native Wraith terminal with a tiny local echo shell.
import { Wraith, type WraithEffects } from '../packages/wraith/dist/index.js';
import amber from './effects/amber.wgsl?raw';
import ripple from './effects/ripple.wgsl?raw';
import spotlight from './effects/spotlight.wgsl?raw';
import glitch from './effects/glitch.wgsl?raw';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const broken = `// Deliberately invalid: shows how compile errors surface.
fn mainImage(fragCoord: vec2<f32>) -> vec4<f32> {
    let uv = fragCoord / iResolution.xy
    return textureSample(iChannel0, iChannel0Sampler, uv);
}
`;
export const gallery: Record<string, string> = {
  None: '',
  Amber: amber,
  Ripple: ripple,
  Spotlight: spotlight,
  Glitch: glitch,
  Broken: broken,
};
let term: Wraith;
let shader = '';
let line = '';

function settings(): WraithEffects {
  const bloom = Number(input('bloom').value);
  return {
    crt: input('crt').checked && {
      curvature: Number(input('curvature').value),
      scanlines: Number(input('scanlines').value),
      aberration: Number(input('aberration').value),
    },
    bloom,
    cursorTrail: input('trail').checked,
    shader: shader || undefined,
  };
}
async function apply() {
  const error = $('error');
  try {
    await term.setEffects(settings());
    error.className = 'shader-error ok';
    error.textContent = shader ? 'Shader compiled.' : 'No custom shader.';
  } catch (e) {
    error.className = 'shader-error';
    error.textContent = String(e instanceof Error ? e.message : e);
  }
}
function prompt() {
  void term.write('\r\n\x1b[38;5;215m❯\x1b[0m ');
}
function colors() {
  let out = '\r\n';
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 36; col++) out += `\x1b[48;5;${16 + row * 36 + col}m `;
    out += '\x1b[0m\r\n';
  }
  out +=
    '\x1b[1;38;5;214mbold amber\x1b[0m  \x1b[38;5;45mcyan\x1b[0m  \x1b[38;5;198mmagenta\x1b[0m';
  void term.write(out);
}
function banner() {
  const glow = (c: number, s: string) => `\x1b[1;38;5;${c}m${s}\x1b[0m`;
  void term.write(
    `${glow(215, 'wraith')} effects lab — GPU post-processing over libghostty-vt\r\n\r\n` +
      `  ${glow(203, '●')} CRT: curvature, scanlines, vignette, chromatic aberration\r\n` +
      `  ${glow(221, '●')} bloom: half-resolution separable Gaussian glow\r\n` +
      `  ${glow(114, '●')} cursor trail: eased head, slower tail, native cursor on arrival\r\n` +
      `  ${glow(111, '●')} custom WGSL: mainImage(fragCoord) with iTime, iMouse, iChannel0\r\n\r\n` +
      `  \x1b[38;5;245mfn\x1b[0m \x1b[38;5;222mmain\x1b[0m() { \x1b[38;5;150mprintln!\x1b[0m(\x1b[38;5;180m"hello, phosphor"\x1b[0m); }\r\n`,
  );
  colors();
  prompt();
}
function renderGallery() {
  const host = $('gallery');
  for (const [name, source] of Object.entries(gallery)) {
    const button = document.createElement('button');
    button.textContent = name;
    button.setAttribute('aria-pressed', String(name === 'None'));
    button.addEventListener('click', () => {
      for (const b of host.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-pressed', 'true');
      $<HTMLTextAreaElement>('source').value = source;
      shader = source;
      void apply();
      term.focus();
    });
    host.append(button);
  }
}
async function boot() {
  try {
    term = await Wraith.mount($('terminal'), {
      fontSize: 15,
      theme: { foreground: '#e8e0d6', background: '#0d0a08', cursor: '#ffb86b' },
      effects: { crt: true, bloom: 0.6, cursorTrail: true },
    });
    input('crt').checked = true;
    input('bloom').value = '0.6';
    input('trail').checked = true;
    Object.assign(window, { effectsLab: { term, Wraith, gallery } });
    $('status').innerHTML = '<i></i> WebGPU online';
    const grid = () => ($('grid').textContent = `${term.cols} × ${term.rows}`);
    grid();
    term.onResize(grid);
    term.onStats((s) => {
      $('passes').textContent = String(s.effectPasses);
      $('fps').innerHTML = `${s.activeFps}<small>/s</small>`;
    });
    term.onError((error) => console.warn('Wraith effects:', error.message));
    term.onData((data) => {
      for (const ch of data) {
        if (ch === '\r') {
          const command = line.trim();
          line = '';
          if (command === 'clear') void term.write('\x1b[2J\x1b[H\x1b[38;5;215m❯\x1b[0m ');
          else {
            if (command === 'colors') colors();
            else if (command) void term.write(`\r\n${command}`);
            prompt();
          }
        } else if (ch === '\x7f') {
          if (line) {
            line = line.slice(0, -1);
            void term.write('\b \b');
          }
        } else if (ch >= ' ') {
          line += ch;
          void term.write(ch);
        }
      }
    });
    banner();
    renderGallery();
    for (const id of ['crt', 'curvature', 'scanlines', 'aberration', 'bloom', 'trail'])
      input(id).addEventListener('input', () => void apply());
    $('apply').addEventListener('click', () => {
      shader = $<HTMLTextAreaElement>('source').value;
      void apply();
    });
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const note = () =>
      ($('motion').textContent = motion.matches
        ? 'Reduced motion is on: the cursor trail stays off.'
        : '');
    note();
    motion.addEventListener('change', note);
    term.focus();
  } catch (error) {
    $('status').className = 'status error';
    $('status').innerHTML = `<i></i> ${String(error instanceof Error ? error.message : error)}`;
  }
}
void boot();
