// A full-screen terminal dashboard for the race and the launch video: CPU meters, a braille
// network graph, a live-sorting process table, highlighted Rust with a curly diagnostic,
// scrolling logs, a frame-time histogram and a status line. Every cell is rewritten with
// explicit 24-bit colors on every update, so it is as demanding as the dense benchmark while
// looking like something people run. The eight variants form a seamless loop.

const hex = (v) => [v >>> 16, (v >>> 8) & 255, v & 255];
const mix = (a, b, k) => {
  const [ar, ag, ab] = hex(a),
    [br, bg, bb] = hex(b);
  return (
    (Math.round(ar + (br - ar) * k) << 16) |
    (Math.round(ag + (bg - ag) * k) << 8) |
    Math.round(ab + (bb - ab) * k)
  );
};
const ramp = (stops, k) => {
  const x = Math.min(0.9999, Math.max(0, k)) * (stops.length - 1);
  const i = Math.floor(x);
  return mix(stops[i], stops[i + 1], x - i);
};

const C = {
  bg: 0x0c0806,
  panel: 0x120d0a,
  raised: 0x1a130f,
  track: 0x221a15,
  line: 0x3a2c24,
  text: 0xf2e6da,
  dim: 0xa6958a,
  faint: 0x6e5c50,
  amber: 0xffb86b,
  gold: 0xffd98a,
  ember: 0xff7f6e,
  rose: 0xff8fb1,
  lilac: 0xd9bbff,
  sage: 0xb5d99c,
};
const heat = [C.sage, C.gold, C.amber, C.ember, C.rose];

// An excerpt of crates/wraith-engine/src/gpu.rs, frozen here so the scene never drifts.
const SOURCE = `    fn pack(&mut self, core: &Core) {
        let state = &*core.state;
        let cols = state.cols;
        self.pack_stamp = self.pack_stamp.wrapping_add(1);
        let (mut shift, mut searched) = (1isize, false);
        for y in 0..state.rows {
            if !state.dirty[y] {
                continue;
            }
            let version = state.versions[y];
            if version != 0 && self.packed_versions[y] == version {
                continue;
            }
            let usable = |r: usize| {
                r != y
                    && self.packed_versions[r] == version
                    && self.pack_stamps[r] != self.pack_stamp
            };
            let guess = y as isize + shift;
            let source = if version == 0 {
                None
            } else if guess >= 0 && (guess as usize) < state.rows && usable(guess as usize) {
                Some(guess as usize)
            } else if !searched {
                // One full search per pass, as in the core's snapshot reuse.
                searched = true;
                (0..state.rows).find(|&r| usable(r))
            } else {
                None
            };
            if let Some(r) = source {
                shift = r as isize - y as isize;
                self.cells.copy_within(r * cols..(r + 1) * cols, y * cols);
            } else {
                let row = &state.cells[y * cols..(y + 1) * cols];
                for (cell, gpu) in row.iter().zip(&mut self.cells[y * cols..(y + 1) * cols]) {
                    *gpu = GpuCell {
                        foreground: cell.foreground,
                        background: cell.background,
                        underline: cell.underline,
                        flags: cell.flags,
                        glyph: self.atlas.tile(cell),
                    };
                }
            }
            self.packed_versions[y] = version;
            self.pack_stamps[y] = self.pack_stamp;
            self.changed_rows[y] = true;
        }
    }
    fn present(&mut self, uniforms: Uniforms) -> Result<bool, String> {
        if let Some(error) = &*self.lost.lock().unwrap() {
            return Err(error.clone());
        }
        self.queue
            .write_buffer(&self.uniform, 0, bytemuck::bytes_of(&uniforms));
        // An acquired surface can be temporarily unavailable. Retain the need
        // to present even when only uniforms changed and no rows are dirty.
        self.pending_present = true;
        let texture = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t)
            | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.surface.configure(&self.device, &self.config);
                return Ok(false);
            }
            status => return Err(format!("WebGPU surface failure: {status:?}")),
        };
        let view = texture.texture.create_view(&Default::default());`.split('\n');
const KEYWORDS = new Set(
  'fn let mut if else for in while loop return pub struct impl match const use self Self as continue break true false None Some Ok Err'.split(
    ' ',
  ),
);

const PROCESSES = [
  ['wraith-worker', 'you'],
  ['libghostty-vt', 'you'],
  ['wgpu::queue', 'you'],
  ['chrome --gpu', 'you'],
  ['vite', 'you'],
  ['rust-analyzer', 'you'],
  ['cargo build', 'you'],
  ['zig build-lib', 'you'],
  ['postgres', 'pg'],
  ['redis-server', 'redis'],
  ['nginx: worker', 'www'],
  ['node server.js', 'app'],
  ['kworker/3:1', 'root'],
  ['sshd', 'root'],
  ['tmux: server', 'you'],
  ['fish', 'you'],
  ['nvim', 'you'],
  ['htop', 'you'],
  ['docker', 'root'],
  ['containerd', 'root'],
  ['ollama serve', 'you'],
  ['python train.py', 'ml'],
  ['grafana', 'graf'],
  ['prometheus', 'prom'],
  ['coredns', 'root'],
  ['systemd', 'root'],
  ['launchd', 'root'],
  ['WindowServer', 'root'],
  ['spotlight', 'root'],
  ['bluetoothd', 'root'],
  ['syslogd', 'root'],
  ['cron', 'root'],
  ['ssh-agent', 'you'],
  ['gpg-agent', 'you'],
];

const LOGS = [
  ['INFO', 'worker', 'rendered frame {n} in {ms} ms, {r} rows uploaded'],
  ['DEBUG', 'atlas', 'glyph cache hit rate {p}% ({g} glyphs resident)'],
  ['INFO', 'pty', 'read {b} bytes from shell, parsed in {ms} ms'],
  ['WARN', 'gpu', 'surface outdated, reconfiguring {w}x{h}'],
  ['INFO', 'snapshot', 'reused {r} moved rows, packed {p} fresh'],
  ['DEBUG', 'input', 'kitty keyboard: CSI {k} u'],
  ['INFO', 'sdk', 'batched {b} writes into one transfer'],
  ['ERROR', 'net', 'websocket closed (1006), reconnecting in {ms} ms'],
  ['INFO', 'reflow', 'resized to {w}x{h}, {r} lines rewrapped'],
  ['DEBUG', 'vt', 'OSC 8 hyperlink opened on row {r}'],
];
const LEVEL = { INFO: C.sage, DEBUG: C.lilac, WARN: C.gold, ERROR: C.ember };

/** Builds one variant of the dashboard as terminal bytes. */
export function showcase(cols, rows, variant, encoder) {
  const n = cols * rows;
  const ch = new Array(n).fill(' ');
  const fg = new Uint32Array(n).fill(C.text);
  const bg = new Uint32Array(n).fill(C.bg);
  const at = new Array(n).fill('');
  const phase = (variant / 8) * Math.PI * 2;
  const put = (x, y, text, f = C.text, b, a = '') => {
    if (y < 0 || y >= rows) return;
    let i = 0;
    for (const c of text) {
      const xx = x + i++;
      if (xx < 0 || xx >= cols) continue;
      const k = y * cols + xx;
      ch[k] = c;
      fg[k] = f;
      if (b !== undefined) bg[k] = b;
      at[k] = a;
    }
  };
  const fill = (x0, y0, w, h, b) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) bg[y * cols + x] = b;
  };
  const box = (x0, y0, w, h, title, accent) => {
    fill(x0, y0, w, h, C.panel);
    put(x0, y0, '╭' + '─'.repeat(w - 2) + '╮', C.line);
    for (let y = y0 + 1; y < y0 + h - 1; y++) {
      put(x0, y, '│', C.line);
      put(x0 + w - 1, y, '│', C.line);
    }
    put(x0, y0 + h - 1, '╰' + '─'.repeat(w - 2) + '╯', C.line);
    put(x0 + 2, y0, ` ${title} `, accent, C.panel, '1');
  };

  // Header: a warm gradient bar.
  for (let x = 0; x < cols; x++) bg[x] = ramp([0x2a1710, 0x3d2016, 0x2e1a24, 0x1d1420], x / cols);
  put(1, 0, '◇ wraith', C.amber, undefined, '1');
  put(11, 0, '· showcase · every cell, every update, on the GPU', C.dim);
  const clock = `12:0${variant}:${String(17 + variant * 5).padStart(2, '0')}`;
  put(cols - clock.length - 1, 0, clock + '▕', C.gold, undefined, '1');

  const third = Math.floor(cols / 3);
  const left = 0,
    mid = third,
    right = third * 2;
  const wl = third,
    wm = third,
    wr = cols - third * 2;

  // CPU meters.
  const cpuH = Math.floor((rows - 2) * 0.27);
  box(left, 1, wl, cpuH, 'cpu', C.amber);
  const cores = cpuH - 4;
  let total = 0;
  for (let c = 0; c < cores; c++) {
    const load =
      0.5 +
      0.32 * Math.sin(phase + c * 0.9) +
      0.16 * Math.sin(phase * 2 + c * 2.3) +
      (c % 5) * 0.01;
    total += load;
    const y = 2 + c;
    put(left + 2, y, `c${String(c).padStart(2, '0')}`, C.faint);
    const barW = wl - 14;
    const filled = load * barW;
    for (let i = 0; i < barW; i++) {
      const k = y * cols + left + 6 + i;
      bg[k] = C.track;
      if (i < Math.floor(filled)) {
        ch[k] = '█';
        fg[k] = ramp(heat, i / barW);
      } else if (i === Math.floor(filled)) {
        ch[k] = ' ▏▎▍▌▋▊▉'[Math.floor((filled - i) * 8)];
        fg[k] = ramp(heat, i / barW);
      }
    }
    put(left + wl - 7, y, `${Math.round(load * 100)}%`.padStart(4), load > 0.75 ? C.ember : C.text);
  }
  put(
    left + 2,
    2 + cores + 1,
    `avg ${Math.round((total / cores) * 100)}%  ·  load 3.${variant}1 2.87 2.40`,
    C.dim,
  );

  // Braille network graph: filled download area plus an upload line.
  const netY = 1 + cpuH,
    netH = Math.floor((rows - 2) * 0.27);
  box(left, netY, wl, netH, 'net  ↓ 812 MiB/s  ↑ 96 MiB/s', C.lilac);
  const gw = (wl - 4) * 2,
    gh = (netH - 3) * 4;
  const down = (x) =>
    gh * (0.45 + 0.28 * Math.sin(x * 0.07 + phase) + 0.14 * Math.sin(x * 0.19 - phase * 2));
  const up = (x) => gh * (0.25 + 0.12 * Math.sin(x * 0.11 - phase + 1.3));
  for (let cy = 0; cy < netH - 3; cy++)
    for (let cx = 0; cx < wl - 4; cx++) {
      let bits = 0,
        upBits = 0;
      const dots = [
        [0, 0, 0x01],
        [0, 1, 0x02],
        [0, 2, 0x04],
        [1, 0, 0x08],
        [1, 1, 0x10],
        [1, 2, 0x20],
        [0, 3, 0x40],
        [1, 3, 0x80],
      ];
      for (const [dx, dy, bit] of dots) {
        const px = cx * 2 + dx,
          py = gh - (cy * 4 + dy);
        if (py <= down(px)) bits |= bit;
        if (Math.abs(py - up(px)) < 1.2) upBits |= bit;
      }
      const k = (netY + 2 + cy) * cols + left + 2 + cx;
      if (upBits) {
        ch[k] = String.fromCharCode(0x2800 | upBits | bits);
        fg[k] = C.lilac;
      } else if (bits) {
        ch[k] = String.fromCharCode(0x2800 | bits);
        fg[k] = ramp([C.rose, C.ember, C.amber, 0x7a3f22], cy / (netH - 3));
      }
    }

  // Process table, sorted by a CPU figure that changes every update.
  const procY = netY + netH,
    procH = rows - 1 - procY;
  box(left, procY, wl, procH, 'processes', C.gold);
  put(
    left + 2,
    procY + 1,
    '  PID USER     CPU%  MEM%  COMMAND'.padEnd(wl - 4),
    C.dim,
    C.raised,
    '1;4',
  );
  const procs = PROCESSES.map(([cmd, user], i) => ({
    pid: 1000 + ((i * 7919) % 8000),
    user,
    cmd,
    cpu: Math.max(
      0,
      40 * Math.max(0, Math.sin(phase + i * 1.7)) ** 3 + (i < 4 ? 18 - i * 3 : 0) + (i % 3),
    ),
    mem: ((i * 37) % 90) / 10 + 0.4,
  })).sort((a, b) => b.cpu - a.cpu);
  for (let r = 0; r < procH - 3 && r < procs.length; r++) {
    const p = procs[r];
    const y = procY + 2 + r;
    const selected = r === 2;
    const rowBg = selected ? C.amber : r % 2 ? C.panel : 0x15100c;
    const textFg = selected ? 0x1a0d05 : C.text;
    put(left + 1, y, ' '.repeat(wl - 2), textFg, rowBg);
    put(left + 2, y, String(p.pid).padStart(5), selected ? textFg : C.faint, rowBg);
    put(left + 8, y, p.user.padEnd(8), selected ? textFg : C.lilac, rowBg);
    put(
      left + 17,
      y,
      p.cpu.toFixed(1).padStart(5),
      selected ? textFg : ramp(heat, p.cpu / 45),
      rowBg,
      selected ? '1' : '',
    );
    put(left + 23, y, p.mem.toFixed(1).padStart(5), selected ? textFg : C.dim, rowBg);
    put(left + 30, y, p.cmd.slice(0, wl - 33), textFg, rowBg, selected ? '1' : '');
  }

  // Code pane with line numbers, highlighting, a current line and a diagnostic.
  box(mid, 1, wm, rows - 2, 'crates/wraith-engine/src/gpu.rs', C.ember);
  const visible = rows - 4;
  const scroll = variant * 3;
  const current = 6 + ((variant * 5) % (visible - 12));
  for (let r = 0; r < visible; r++) {
    const lineNo = (scroll + r) % SOURCE.length;
    const line = SOURCE[lineNo];
    const y = 2 + r;
    const isCurrent = r === current;
    const rowBg = isCurrent ? 0x241a14 : C.panel;
    put(mid + 1, y, ' '.repeat(wm - 2), C.text, rowBg);
    put(
      mid + 2,
      y,
      String(439 + lineNo).padStart(4),
      isCurrent ? C.amber : C.faint,
      rowBg,
      isCurrent ? '1' : '',
    );
    let x = mid + 8;
    const limit = mid + wm - 2;
    const tokens = line.match(/\/\/.*|"[^"]*"|\b\d[\w.]*\b|[A-Za-z_][\w]*!?|\s+|./g) ?? [];
    let comment = false;
    for (const tok of tokens) {
      if (x >= limit) break;
      let f = C.text,
        a = '';
      if (tok.startsWith('//') || comment) {
        comment = true;
        f = C.faint;
        a = '3';
      } else if (tok.startsWith('"')) f = C.sage;
      else if (/^\d/.test(tok)) f = C.ember;
      else if (tok.endsWith('!')) f = C.rose;
      else if (KEYWORDS.has(tok)) {
        f = C.lilac;
        a = '1';
      } else if (/^[A-Z]/.test(tok)) f = C.gold;
      else if (/^[a-z_]\w*$/.test(tok) && line[line.indexOf(tok) + tok.length] === '(') f = C.amber;
      else if (/^[^\w\s]$/.test(tok)) f = C.dim;
      // A curly diagnostic under one identifier, with an ember underline color.
      if (tok === 'searched' && lineNo % 7 === 4) a = '4:3;58:2::255:127:110';
      put(x, y, tok.slice(0, limit - x), f, rowBg, a);
      x += tok.length;
    }
    if (isCurrent) put(Math.min(limit - 1, x), y, '▋', C.amber, rowBg);
  }

  // Logs.
  const logH = Math.floor((rows - 2) * 0.62);
  box(right, 1, wr, logH, 'logs', C.sage);
  for (let r = 0; r < logH - 2; r++) {
    const seq = variant * 3 + r;
    const [level, comp, template] = LOGS[(seq * 7) % LOGS.length];
    const msg = template
      .replace('{n}', String(18000 + seq * 3))
      .replace('{ms}', (((seq * 37) % 90) / 100 + 0.12).toFixed(2))
      .replace('{r}', String((seq * 13) % 80))
      .replace('{p}', String(90 + (seq % 10)))
      .replace('{g}', String(400 + seq * 3))
      .replace('{b}', String(1024 + seq * 211))
      .replace('{w}', '240')
      .replace('{h}', '80')
      .replace('{k}', String(97 + (seq % 26)));
    const y = 2 + r;
    const ms = String((seq * 271) % 1000).padStart(3, '0');
    put(right + 2, y, `12:04:${String(seq % 60).padStart(2, '0')}.${ms}`, C.faint);
    put(right + 16, y, ` ${level.padEnd(5)} `, 0x1a0d05, LEVEL[level], '1');
    put(right + 24, y, comp.padEnd(9), C.lilac);
    let x = right + 34;
    for (const part of msg.split(/(\d[\d.]*)/)) {
      if (!part) continue;
      put(
        x,
        y,
        part.slice(0, Math.max(0, right + wr - 2 - x)),
        /^\d/.test(part) ? C.amber : C.text,
      );
      x += part.length;
    }
  }

  // Frame-time histogram.
  const histY = 1 + logH,
    histH = rows - 2 - logH;
  box(right, histY, wr, histH, 'frame time · ms', C.rose);
  const bars = wr - 4,
    tall = histH - 4;
  for (let i = 0; i < bars; i++) {
    const v =
      (0.35 + 0.3 * Math.sin(i * 0.31 + phase) ** 2 + 0.25 * Math.sin(i * 0.07 - phase) ** 4) *
      tall;
    for (let r = 0; r < tall; r++) {
      const k = (histY + 2 + tall - 1 - r) * cols + right + 2 + i;
      const level = v - r;
      if (level >= 1) ch[k] = '█';
      else if (level > 0) ch[k] = ' ▁▂▃▄▅▆▇'[Math.floor(level * 8)];
      else continue;
      fg[k] = ramp([C.amber, C.ember, C.rose, C.lilac], r / tall);
    }
  }
  put(
    right + 2,
    histY + histH - 2,
    `p50 0.5${variant}  p95 1.4${variant}  p99 2.0${variant}`,
    C.dim,
  );

  // Status line.
  const sy = rows - 1;
  for (let x = 0; x < cols; x++) bg[sy * cols + x] = 0x1a130f;
  put(0, sy, ' NORMAL ', 0x1a0d05, C.amber, '1');
  put(8, sy, ' main ', C.text, 0x3a2418);
  put(15, sy, ' ok 0  warn 2 ', C.sage);
  const right_ = `wraith 0.2.0 · ${cols}×${rows} · utf-8 · ${variant + 1}/8 ▕`;
  put(cols - right_.length, sy, right_, C.dim);

  // Serialize with one SGR per change of style.
  let out = '\x1b[?25l';
  let sgrChanges = 0;
  for (let y = 0; y < rows; y++) {
    out += `\x1b[${y + 1};1H`;
    let last = '';
    for (let x = 0; x < cols; x++) {
      const k = y * cols + x;
      const [fr, fgc, fb] = hex(fg[k]),
        [br, bgc, bb] = hex(bg[k]);
      const style = `${at[k] ? at[k] + ';' : ''}38;2;${fr};${fgc};${fb};48;2;${br};${bgc};${bb}`;
      if (style !== last) {
        out += `\x1b[0;${style}m`;
        last = style;
        sgrChanges++;
      }
      out += ch[k];
    }
  }
  out += '\x1b[0m\x1b[H';
  return { bytes: encoder.encode(out), sgrChanges, variant };
}
