// Accessibility lab: screen reader mode, announcements, keyboard exit and readText().
import { Wraith } from '../packages/wraith/dist/index.js';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const prompt = '\x1b[38;2;255;184;107mwraith\x1b[0m \x1b[38;2;255;217;138m❯\x1b[0m ';
const help = [
  'help       list commands',
  'ls         a short listing',
  'progress   a redrawn progress bar (announced once it settles)',
  'burst      10 MB of output (announcements pause, then summarize)',
  'clear      clear the screen',
];
const files = ['README.md', 'package.json', 'src/', 'docs/', 'wasm/'];

async function main() {
  const host = $('terminal');
  const term = await Wraith.mount(host, {
    screenReaderMode: true,
    accessibility: { announcements: 'focused' },
  });
  Object.assign(window, { wraith: term, Wraith });
  $('status').innerHTML = `<i></i> ${term.cols} × ${term.rows} · screen reader mode on`;
  $('grid').textContent = `${term.cols} × ${term.rows}`;
  term.onResize(({ cols, rows }) => ($('grid').textContent = `${cols} × ${rows}`));
  const announced = $('announced');
  term.onAnnounce((text) => {
    const item = document.createElement('li');
    item.textContent = text.length > 160 ? `${text.slice(0, 160)}…` : text;
    announced.prepend(item);
    while (announced.childElementCount > 12) announced.lastElementChild!.remove();
  });
  let line = '';
  let busy = false;
  const run = async (command: string) => {
    const name = command.trim();
    if (!name) return;
    if (name === 'help') await term.write(help.join('\r\n') + '\r\n');
    else if (name === 'ls') await term.write(files.join('\r\n') + '\r\n');
    else if (name === 'clear') await term.write('\x1b[2J\x1b[H');
    else if (name === 'progress') {
      for (let p = 0; p <= 100; p += 5) {
        await term.write(`\r\x1b[2KBuilding ${'█'.repeat(p / 5).padEnd(20, '░')} ${p}%`);
        await new Promise((r) => setTimeout(r, 40));
      }
      await term.write('\r\n\x1b[32mBuild finished\x1b[0m\r\n');
    } else if (name === 'burst') await burst();
    else await term.write(`${name}: command not found\r\n`);
  };
  const burst = async () => {
    const row = 'x'.repeat(79) + '\r\n';
    const chunk = row.repeat(Math.floor(65536 / row.length));
    for (let sent = 0; sent < 10 * 1024 * 1024; sent += chunk.length) await term.write(chunk);
    await term.write('burst complete: 10 MB\r\n');
  };
  term.onData(async (data) => {
    if (busy) return;
    for (const ch of data) {
      if (ch === '\r') {
        busy = true;
        await term.write('\r\n');
        await run(line);
        line = '';
        await term.write(prompt);
        busy = false;
      } else if (ch === '\x7f') {
        if (line) {
          line = line.slice(0, -1);
          await term.write('\b \b');
        }
      } else if (ch >= ' ') {
        line += ch;
        await term.write(ch);
      }
    }
  });
  await term.write(
    'Wraith accessibility lab. Type \x1b[1mhelp\x1b[0m and press Enter.\r\n' +
      'Escape, then Tab leaves the terminal.\r\n' +
      prompt,
  );
  $<HTMLInputElement>('screen-reader').addEventListener('change', (event) => {
    term.setScreenReaderMode((event.target as HTMLInputElement).checked);
  });
  $<HTMLSelectElement>('announce').addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value;
    term.setAccessibility({
      announcements: value === 'off' ? false : (value as 'focused' | 'always'),
    });
  });
  $('pause').addEventListener('click', () => {
    if (term.paused) term.resume();
    else term.pause();
    $('pause').setAttribute('aria-pressed', String(term.paused));
    $('pause').textContent = term.paused ? 'Resume painting' : 'Pause painting';
  });
  $('burst').addEventListener('click', async () => {
    busy = true;
    await term.write('\r\n');
    await burst();
    await term.write(prompt);
    busy = false;
  });
  const reader = $<HTMLTextAreaElement>('reader');
  $('read-screen').addEventListener('click', async () => {
    reader.value = await term.readText();
  });
  $('read-all').addEventListener('click', async () => {
    reader.value = await term.readText({ scope: 'all' });
  });
}
main().catch((error) => {
  $('status').textContent = String(error?.message ?? error);
});
