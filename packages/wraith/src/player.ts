/**
 * A scrubbable player for terminal recordings, built on a native Wraith
 * terminal. Seeks restore verified libghostty keyframes built in a worker
 * (see replay.ts); until they arrive, or where none verified, a seek replays
 * from the start, which is always exact.
 */
// Type-only imports of the SDK entry: Wraith.player() passes the class in, so
// this lazily loaded module never imports its importer (see index.ts).
import type { Wraith } from './index.js';
import type { Recording } from './recording.js';
import {
  ReplayCursor,
  Timeline,
  type KeyframeStats,
  type ReplayTarget,
  type SeekResult,
  type TimelineMarker,
} from './replay.js';
import type { ReplayWorkerReply, ReplayWorkerRequest } from './replay-worker.js';
import type { Disposable, WraithOptions, WraithTheme } from './types.js';

export interface PlayerControlsOptions {
  /** Show the speed button. Defaults to true. */
  speed?: boolean;
}

export interface PlayerOptions extends Omit<WraithOptions, 'cols' | 'rows' | 'fit'> {
  /** Start playing once mounted. Defaults to false. */
  autoplay?: boolean;
  /** Restart from the beginning at the end. Defaults to false. */
  loop?: boolean;
  /** Playback rate. Defaults to 1. */
  speed?: number;
  /** Seconds to show first. Defaults to 0. */
  startAt?: number;
  /** Shorten pauses longer than this many seconds; overrides the recording's limit. */
  idleTimeLimit?: number;
  /** Built-in timeline UI: true (default), false for none, or options. */
  controls?: boolean | PlayerControlsOptions;
  /** Keyboard shortcuts while the player has focus. Defaults to true. */
  keyboard?: boolean;
  /** Build seek keyframes in a worker. Defaults to true. */
  keyframes?: boolean;
  /** Minimum output bytes between keyframes. Defaults to 256 KiB. */
  keyframeInterval?: number;
  /** `fit` (default) shrinks the font so the recording's width fits the host. */
  scale?: 'fit' | 'none';
}

type Listener<T> = (value: T) => void;
class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  on(listener: Listener<T>): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  emit(value: T) {
    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch (error) {
        console.error('Wraith player listener', error);
      }
    }
  }
  clear() {
    this.listeners.clear();
  }
}

const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4, 8];
const STYLE_ID = 'wraith-player-style';
const CSS = `
.wraith-player{position:relative;display:flex;flex-direction:column;gap:0;outline:none;
  background:var(--wraith-player-bg);color:var(--wraith-player-fg);border-radius:8px;overflow:hidden;
  font:12px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.wraith-player:focus-visible{box-shadow:0 0 0 2px var(--wraith-player-accent)}
/* The stage takes its width from the host, never from the terminal, so a wide
   recording shrinks its font to fit instead of widening the page. */
.wraith-player-stage{position:relative;overflow:hidden;display:flex;justify-content:center;
  contain:inline-size;min-width:0}
.wraith-player-screen{flex:none}
.wraith-player-bar{display:flex;align-items:center;gap:10px;padding:6px 10px;
  background:color-mix(in srgb,var(--wraith-player-bg) 82%,var(--wraith-player-fg));
  user-select:none;-webkit-user-select:none}
.wraith-player-bar button{all:unset;cursor:pointer;display:grid;place-items:center;min-width:24px;height:24px;
  border-radius:4px;color:inherit;font:inherit;font-variant-numeric:tabular-nums}
.wraith-player-bar button:hover,.wraith-player-bar button:focus-visible{
  background:color-mix(in srgb,var(--wraith-player-fg) 16%,transparent)}
.wraith-player-bar svg{width:14px;height:14px;fill:currentColor}
.wraith-player-time{font-variant-numeric:tabular-nums;opacity:.85;white-space:nowrap}
.wraith-player-track{position:relative;flex:1;height:24px;cursor:pointer;touch-action:none;outline:none}
.wraith-player-rail{position:absolute;left:0;right:0;top:50%;height:4px;margin-top:-2px;border-radius:2px;
  background:color-mix(in srgb,var(--wraith-player-fg) 22%,transparent);overflow:hidden}
.wraith-player-fill{height:100%;width:0;background:var(--wraith-player-accent)}
.wraith-player-thumb{position:absolute;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;
  background:var(--wraith-player-accent);box-shadow:0 0 0 2px var(--wraith-player-bg);left:0;
  transition:transform .1s}
.wraith-player-track:hover .wraith-player-thumb,.wraith-player-track:focus-visible .wraith-player-thumb,
.wraith-player-scrubbing .wraith-player-thumb{transform:scale(1.25)}
.wraith-player-marker{position:absolute;top:50%;width:2px;height:10px;margin:-5px 0 0 -1px;border-radius:1px;
  background:var(--wraith-player-fg);opacity:.7;pointer-events:none}
.wraith-player-tip{position:absolute;bottom:26px;transform:translateX(-50%);padding:3px 6px;border-radius:4px;
  white-space:nowrap;pointer-events:none;background:var(--wraith-player-fg);color:var(--wraith-player-bg);
  font-variant-numeric:tabular-nums}
.wraith-player-tip[hidden]{display:none}
`;
const ICON_PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>';
const ICON_PAUSE =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h3v11h-3zm6 0h3v11h-3z"/></svg>';

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent?.append(node);
  return node;
}

/** Run a seek without awaiting it; failures already reach `onError`. */
const quiet = (promise: Promise<unknown>) => void promise.catch(() => {});

/** Writes in bounded chunks so long replays stay under the input backpressure limit. */
const CHUNK = 2 * 1024 * 1024;

export class WraithPlayer {
  /** The player's root element, including controls. */
  readonly element: HTMLDivElement;
  readonly terminal: Wraith;
  readonly recording: Recording;
  readonly timeline: Timeline;
  private cursor: ReplayCursor;
  private screen: HTMLDivElement;
  private stage: HTMLDivElement;
  private options: PlayerOptions;
  private position = 0;
  private index = 0;
  private isPlaying = false;
  private rate: number;
  private anchorWall = 0;
  private anchorTime = 0;
  private frame = 0;
  private target?: number;
  private applying?: Promise<void>;
  private lastResult?: SeekResult;
  private worker?: Worker;
  private stats?: KeyframeStats;
  private observer?: ResizeObserver;
  private abort = new AbortController();
  private disposed = false;
  private fitting = false;
  private times = new Emitter<number>();
  private states = new Emitter<boolean>();
  private endings = new Emitter<void>();
  private markerHits = new Emitter<TimelineMarker>();
  private keyframeDone = new Emitter<KeyframeStats>();
  private errors = new Emitter<Error>();
  private ui?: {
    play: HTMLButtonElement;
    time: HTMLSpanElement;
    duration: HTMLSpanElement;
    track: HTMLDivElement;
    fill: HTMLDivElement;
    thumb: HTMLDivElement;
    tip: HTMLDivElement;
    speed?: HTMLButtonElement;
  };
  loop: boolean;

  private constructor(
    root: HTMLDivElement,
    stage: HTMLDivElement,
    screen: HTMLDivElement,
    terminal: Wraith,
    recording: Recording,
    timeline: Timeline,
    options: PlayerOptions,
  ) {
    this.element = root;
    this.stage = stage;
    this.screen = screen;
    this.terminal = terminal;
    this.recording = recording;
    this.timeline = timeline;
    this.options = options;
    this.rate = options.speed && options.speed > 0 ? options.speed : 1;
    this.loop = options.loop ?? false;
    const chunked: ReplayTarget = {
      write: async (bytes) => {
        for (let at = 0; at < bytes.byteLength; at += CHUNK)
          await terminal.write(bytes.subarray(at, Math.min(bytes.byteLength, at + CHUNK)));
      },
      resize: (cols, rows) => terminal.resize(cols, rows),
    };
    this.cursor = new ReplayCursor(timeline, chunked);
  }

  /** @internal Use `Wraith.player()`. */
  static async create(
    WraithClass: typeof Wraith,
    host: HTMLElement,
    recording: Recording,
    options: PlayerOptions = {},
  ): Promise<WraithPlayer> {
    const timeline = Timeline.from(recording, { idleTimeLimit: options.idleTimeLimit });
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.append(style);
    }
    const theme: WraithTheme = {
      ...(recording.theme && {
        foreground: recording.theme.foreground,
        background: recording.theme.background,
      }),
      ...options.theme,
    };
    const root = element('div', 'wraith-player');
    root.tabIndex = 0;
    root.setAttribute('role', 'region');
    root.setAttribute(
      'aria-label',
      recording.title ? `Recording: ${recording.title}` : 'Recording',
    );
    const background = theme.background ?? '#0e1217';
    root.style.setProperty('--wraith-player-bg', background);
    root.style.setProperty('--wraith-player-fg', theme.foreground ?? '#dee5e8');
    root.style.setProperty('--wraith-player-accent', theme.cursor ?? '#91d6f0');
    const stage = element('div', 'wraith-player-stage', root);
    const screen = element('div', 'wraith-player-screen', stage);
    host.append(root);
    let terminal: Wraith;
    try {
      terminal = await WraithClass.mount(screen, {
        fontSize: options.fontSize,
        lineHeight: options.lineHeight,
        font: options.font,
        fallbackFonts: options.fallbackFonts,
        screenReaderMode: options.screenReaderMode,
        maxPendingBytes: options.maxPendingBytes,
        imageStorageLimit: options.imageStorageLimit,
        ligatures: options.ligatures,
        pool: options.pool,
        theme,
        cols: timeline.cols,
        rows: timeline.rows,
        scrollback: options.scrollback ?? 1000,
        fit: false,
      });
    } catch (error) {
      root.remove();
      throw error;
    }
    const player = new WraithPlayer(root, stage, screen, terminal, recording, timeline, options);
    try {
      player.mountControls();
      player.watchLayout();
      if (options.keyboard !== false) player.bindKeys();
      if (options.keyframes !== false) player.buildKeyframes();
      await player.seek(options.startAt ?? 0);
      if (options.autoplay) player.play();
    } catch (error) {
      await player.dispose();
      throw error;
    }
    return player;
  }

  /** Seconds. */
  get currentTime(): number {
    return this.position;
  }
  get duration(): number {
    return this.timeline.duration;
  }
  get playing(): boolean {
    return this.isPlaying;
  }
  get speed(): number {
    return this.rate;
  }
  set speed(value: number) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError('Speed must be positive');
    this.anchor();
    this.rate = value;
    if (this.ui?.speed) this.ui.speed.textContent = `${value}×`;
  }
  get markers(): readonly TimelineMarker[] {
    return this.timeline.markers;
  }
  /** Keyframe build statistics once the worker finishes. */
  get keyframeStats(): KeyframeStats | undefined {
    return this.stats;
  }
  /** Keyframes available to seeks now, including the start of the recording. */
  get keyframeCount(): number {
    return this.cursor.available.length;
  }
  /** How the last applied seek reached its state. */
  get lastSeek(): SeekResult | undefined {
    return this.lastResult;
  }

  play(): void {
    this.assertLive();
    if (this.isPlaying) return;
    if (this.position >= this.duration) quiet(this.seek(0));
    this.isPlaying = true;
    this.anchor();
    this.render();
    this.states.emit(true);
    this.frame = requestAnimationFrame(this.tick);
  }
  pause(): void {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.render();
    this.states.emit(false);
  }
  toggle(): void {
    if (this.isPlaying) this.pause();
    else this.play();
  }
  /**
   * Show the recording at `seconds`. Resolves once the terminal has parsed
   * that state (call `terminal.flush()` to also wait for the GPU). Rapid
   * seeks coalesce: only the latest target is applied.
   */
  seek(seconds: number): Promise<void> {
    this.assertLive();
    const time = Math.max(0, Math.min(this.duration, Number.isFinite(seconds) ? seconds : 0));
    this.position = time;
    this.anchor();
    this.render();
    return this.show(this.timeline.indexAt(time));
  }
  /** Move by whole output events while paused; negative steps go back. */
  step(frames = 1): Promise<void> {
    this.pause();
    const { display, count } = this.timeline;
    let index = this.index;
    for (let n = Math.abs(Math.trunc(frames)); n > 0; n--) {
      do index += Math.sign(frames);
      while (index > 0 && index < count && display[index] !== index);
      index = Math.max(0, Math.min(count, index));
    }
    this.position = this.timeline.timeOf(index);
    this.render();
    return this.show(index);
  }
  /** Seek to the next marker after the current time, if any. */
  nextMarker(): Promise<void> {
    const marker = this.timeline.markers.find((m) => m.time > this.position + 1e-6);
    return marker ? this.seek(marker.time) : Promise.resolve();
  }
  /** Seek to the marker before the current time (or the start). */
  previousMarker(): Promise<void> {
    const before = this.timeline.markers.filter((m) => m.time < this.position - 0.5);
    return this.seek(before.at(-1)?.time ?? 0);
  }

  onTimeUpdate(listener: Listener<number>): Disposable {
    return this.times.on(listener);
  }
  onPlayStateChange(listener: Listener<boolean>): Disposable {
    return this.states.on(listener);
  }
  onEnded(listener: Listener<void>): Disposable {
    return this.endings.on(listener);
  }
  /** Playback reached a marker. */
  onMarker(listener: Listener<TimelineMarker>): Disposable {
    return this.markerHits.on(listener);
  }
  /** The keyframe worker finished. */
  onKeyframes(listener: Listener<KeyframeStats>): Disposable {
    return this.keyframeDone.on(listener);
  }
  onError(listener: Listener<Error>): Disposable {
    return this.errors.on(listener);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.isPlaying = false;
    cancelAnimationFrame(this.frame);
    this.abort.abort();
    this.observer?.disconnect();
    this.worker?.terminate();
    this.worker = undefined;
    await this.terminal.dispose();
    this.element.remove();
    this.times.clear();
    this.states.clear();
    this.endings.clear();
    this.markerHits.clear();
    this.keyframeDone.clear();
    this.errors.clear();
  }

  private assertLive() {
    if (this.disposed) throw new Error('Wraith player has been disposed');
  }
  private anchor() {
    this.anchorWall = performance.now();
    this.anchorTime = this.position;
  }
  /** Apply the displayed state for `index`, coalescing with seeks in flight. */
  private show(index: number): Promise<void> {
    // Inside an open synchronized update a terminal still shows the last
    // complete frame; restoring that state keeps seeks frame-accurate.
    this.index = this.timeline.display[Math.max(0, Math.min(this.timeline.count, index))]!;
    this.target = this.index;
    this.applying ??= this.drain();
    return this.applying;
  }
  private async drain() {
    try {
      while (this.target !== undefined && !this.disposed) {
        const target = this.target;
        this.target = undefined;
        this.lastResult = await this.cursor.seek(target);
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!this.disposed) this.errors.emit(failure);
      throw failure;
    } finally {
      this.applying = undefined;
    }
  }
  private tick = () => {
    this.frame = 0;
    if (!this.isPlaying || this.disposed) return;
    const previous = this.position;
    let time = this.anchorTime + ((performance.now() - this.anchorWall) / 1000) * this.rate;
    const ended = time >= this.duration;
    if (ended) time = this.duration;
    this.position = time;
    for (const marker of this.timeline.markers)
      if (marker.time > previous && marker.time <= time) this.markerHits.emit(marker);
    void this.show(this.timeline.indexAt(time)).catch(() => this.pause());
    this.render();
    if (ended) {
      if (this.loop && this.duration > 0) {
        quiet(this.seek(0));
        this.frame = requestAnimationFrame(this.tick);
      } else {
        this.pause();
        this.endings.emit();
      }
      return;
    }
    this.frame = requestAnimationFrame(this.tick);
  };
  private render() {
    this.times.emit(this.position);
    const ui = this.ui;
    if (!ui) return;
    const fraction = this.duration > 0 ? this.position / this.duration : 0;
    const percent = `${(fraction * 100).toFixed(3)}%`;
    ui.fill.style.width = percent;
    ui.thumb.style.left = percent;
    const text = formatTime(this.position);
    if (ui.time.textContent !== text) ui.time.textContent = text;
    ui.track.setAttribute('aria-valuenow', this.position.toFixed(1));
    ui.track.setAttribute('aria-valuetext', `${text} of ${formatTime(this.duration)}`);
    const label = this.isPlaying ? 'Pause' : 'Play';
    if (ui.play.getAttribute('aria-label') !== label) {
      ui.play.setAttribute('aria-label', label);
      ui.play.innerHTML = this.isPlaying ? ICON_PAUSE : ICON_PLAY;
    }
  }
  private mountControls() {
    if (this.options.controls === false) return;
    const config = typeof this.options.controls === 'object' ? this.options.controls : {};
    const bar = element('div', 'wraith-player-bar', this.element);
    const play = element('button', 'wraith-player-play', bar);
    play.type = 'button';
    const time = element('span', 'wraith-player-time', bar);
    const track = element('div', 'wraith-player-track', bar);
    track.tabIndex = 0;
    track.setAttribute('role', 'slider');
    track.setAttribute('aria-label', 'Seek');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', this.duration.toFixed(1));
    const rail = element('div', 'wraith-player-rail', track);
    const fill = element('div', 'wraith-player-fill', rail);
    for (const marker of this.timeline.markers) {
      const tick = element('div', 'wraith-player-marker', track);
      tick.style.left = `${this.duration > 0 ? (marker.time / this.duration) * 100 : 0}%`;
      tick.title = marker.label;
    }
    const thumb = element('div', 'wraith-player-thumb', track);
    const tip = element('div', 'wraith-player-tip', track);
    tip.hidden = true;
    const duration = element('span', 'wraith-player-time', bar);
    duration.textContent = formatTime(this.duration);
    let speed: HTMLButtonElement | undefined;
    if (config.speed !== false) {
      speed = element('button', 'wraith-player-speed', bar);
      speed.type = 'button';
      speed.setAttribute('aria-label', 'Playback speed');
      speed.textContent = `${this.rate}×`;
      speed.addEventListener(
        'click',
        () => {
          const next = SPEEDS.find((s) => s > this.rate + 1e-9) ?? SPEEDS[0]!;
          this.speed = next;
        },
        { signal: this.abort.signal },
      );
    }
    this.ui = { play, time, duration, track, fill, thumb, tip, speed };
    const signal = this.abort.signal;
    play.addEventListener('click', () => this.toggle(), { signal });
    const timeAt = (event: PointerEvent) => {
      const rect = track.getBoundingClientRect();
      const fraction = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
      return Math.max(0, Math.min(1, fraction)) * this.duration;
    };
    const showTip = (event: PointerEvent) => {
      const at = timeAt(event);
      let marker: TimelineMarker | undefined;
      for (const m of this.timeline.markers) if (m.time <= at + 1e-6) marker = m;
      tip.textContent = marker ? `${formatTime(at)} · ${marker.label}` : formatTime(at);
      tip.style.left = `${this.duration > 0 ? (at / this.duration) * 100 : 0}%`;
      tip.hidden = false;
    };
    let scrubbing = false,
      resume = false;
    track.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        track.setPointerCapture(event.pointerId);
        track.focus({ preventScroll: true });
        scrubbing = true;
        resume = this.isPlaying;
        this.pause();
        this.element.classList.add('wraith-player-scrubbing');
        showTip(event);
        quiet(this.seek(timeAt(event)));
      },
      { signal },
    );
    track.addEventListener(
      'pointermove',
      (event) => {
        showTip(event);
        // Every move applies the exact state at that time; seeks coalesce so
        // the screen tracks the latest position.
        if (scrubbing) quiet(this.seek(timeAt(event)));
      },
      { signal },
    );
    const end = () => {
      if (!scrubbing) return;
      scrubbing = false;
      this.element.classList.remove('wraith-player-scrubbing');
      if (resume) this.play();
    };
    track.addEventListener('pointerup', end, { signal });
    track.addEventListener('pointercancel', end, { signal });
    track.addEventListener(
      'pointerleave',
      () => {
        if (!scrubbing) tip.hidden = true;
      },
      { signal },
    );
    this.render();
  }
  private bindKeys() {
    this.element.addEventListener(
      'keydown',
      (event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const tenth = this.duration / 10;
        let handled = true;
        switch (event.key) {
          case ' ':
          case 'k':
            this.toggle();
            break;
          case 'ArrowLeft':
            quiet(this.seek(this.position - (event.shiftKey ? tenth : 5)));
            break;
          case 'ArrowRight':
            quiet(this.seek(this.position + (event.shiftKey ? tenth : 5)));
            break;
          case 'Home':
            quiet(this.seek(0));
            break;
          case 'End':
            quiet(this.seek(this.duration));
            break;
          case ',':
            quiet(this.step(-1));
            break;
          case '.':
            quiet(this.step(1));
            break;
          case '<':
            this.speed = [...SPEEDS].reverse().find((s) => s < this.rate - 1e-9) ?? SPEEDS[0]!;
            break;
          case '>':
            this.speed = SPEEDS.find((s) => s > this.rate + 1e-9) ?? SPEEDS.at(-1)!;
            break;
          case '[':
            quiet(this.previousMarker());
            break;
          case ']':
            quiet(this.nextMarker());
            break;
          default:
            if (/^[0-9]$/.test(event.key)) quiet(this.seek(Number(event.key) * tenth));
            else handled = false;
        }
        if (handled) {
          // Capture phase: keep shortcuts away from the terminal's input.
          event.preventDefault();
          event.stopPropagation();
        }
      },
      { capture: true, signal: this.abort.signal },
    );
  }
  private watchLayout() {
    const layout = () => {
      if (this.disposed) return;
      const width = parseFloat(this.terminal.canvas.style.width) || 0;
      const height = parseFloat(this.terminal.canvas.style.height) || 0;
      const style = this.screen.style;
      style.width = `${width}px`;
      style.height = `${height}px`;
      const available = this.stage.clientWidth;
      const fit = this.options.scale !== 'none' && width > 0 && available > 0;
      if (fit && !this.fitting) {
        // Cell width follows font size: shrink to fit, grow back to the preferred
        // size. Wraith rasterizes at least 6 device pixels.
        const preferred = this.options.fontSize ?? 14;
        const current = this.currentFontSize ?? preferred;
        const minimum = 6 / Math.min(3, window.devicePixelRatio || 1);
        const fitted = Math.max(
          minimum,
          Math.min(preferred, Math.floor(((current * available) / width) * 4) / 4),
        );
        if (Math.abs(fitted - current) >= 0.25) {
          this.fitting = true;
          this.currentFontSize = fitted;
          void this.terminal
            .setFontSize(fitted)
            .catch((error) => this.errors.emit(error))
            .finally(() => {
              this.fitting = false;
              layout();
            });
          return;
        }
      }
      // Below the smallest font, scale the canvas down instead (selection
      // coordinates are not corrected for this transform).
      const scale = fit && width > available ? available / width : 1;
      style.transform = scale < 1 ? `scale(${scale})` : '';
      style.transformOrigin = 'top left';
      style.marginRight = scale < 1 ? `${width * scale - width}px` : '';
      style.marginBottom = scale < 1 ? `${height * scale - height}px` : '';
    };
    this.observer = new ResizeObserver(layout);
    this.observer.observe(this.element);
    this.terminal.onResize(layout);
    layout();
  }
  private currentFontSize?: number;
  private buildKeyframes() {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./replay-worker.js', import.meta.url), {
        type: 'module',
        name: 'Wraith replay keyframes',
      });
    } catch {
      return; // Seeks replay from the start without keyframes.
    }
    this.worker = worker;
    const stop = () => {
      worker.terminate();
      if (this.worker === worker) this.worker = undefined;
    };
    worker.onmessage = (event: MessageEvent<ReplayWorkerReply>) => {
      const reply = event.data;
      if (reply.type === 'keyframe') this.cursor.add(reply.keyframe);
      else if (reply.type === 'extend') this.cursor.extend(reply.index, reply.until);
      else if (reply.type === 'done') {
        this.stats = reply.stats;
        stop();
        this.keyframeDone.emit(reply.stats);
      } else {
        stop();
        console.warn('Wraith replay keyframes unavailable:', reply.error);
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      stop();
    };
    const request: ReplayWorkerRequest = {
      type: 'build',
      timeline: this.timeline.compact(),
      options: {
        history: this.options.scrollback ?? 1000,
        ...(this.options.keyframeInterval && { interval: this.options.keyframeInterval }),
      },
    };
    worker.postMessage(request);
  }
}
