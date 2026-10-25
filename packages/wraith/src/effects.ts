/** CRT tube simulation. Each strength is 0..1. */
export interface WraithCrtOptions {
  /** Barrel distortion. Default 0.5. */
  curvature?: number;
  /** Scanline darkening. Default 0.5. */
  scanlines?: number;
  /** Edge darkening. Default 0.5. */
  vignette?: number;
  /** Red/blue fringe toward the edges. Default 0.35. */
  aberration?: number;
}
export interface WraithBloomOptions {
  /** Glow added back to the image, 0..4. Default 0.6. */
  intensity?: number;
  /** Luminance above which pixels glow, 0..1. Default 0.45. */
  threshold?: number;
  /** Blur spread multiplier, 0.25..4. Default 1. */
  spread?: number;
}
export interface WraithCursorTrailOptions {
  /** Trail duration in milliseconds, 16..1000. Default 120. */
  duration?: number;
}
/**
 * GPU post-process effects for the native renderer. All are off by default;
 * with none enabled the renderer draws exactly as without this option.
 */
export interface WraithEffects {
  crt?: boolean | WraithCrtOptions;
  /** `true`, an intensity, or options. */
  bloom?: boolean | number | WraithBloomOptions;
  /** Smooth cursor movement with a short trail. Disabled while the user
   * prefers reduced motion. */
  cursorTrail?: boolean | WraithCursorTrailOptions;
  /**
   * WGSL source defining `fn mainImage(fragCoord: vec2<f32>) -> vec4<f32>`.
   * `fragCoord` is in physical pixels from the top-left. Available:
   * `iResolution`, `iTime`, `iTimeDelta`, `iFrame`, `iMouse`, `iCurrentCursor`,
   * `iPreviousCursor`, `iCurrentCursorColor`, `iTimeCursorChange`, and the
   * terminal image as `iChannel0` with `iChannel0Sampler`.
   */
  shader?: string;
  /**
   * Redraw the custom shader every display frame. Defaults to true when the
   * shader reads `iTime`, `iTimeDelta` or `iFrame` and the user does not
   * prefer reduced motion.
   */
  animate?: boolean;
}

export const EFFECT_DEFAULTS = {
  crt: { curvature: 0.5, scanlines: 0.5, vignette: 0.5, aberration: 0.35 },
  bloom: { intensity: 0.6, threshold: 0.45, spread: 1 },
  cursorTrail: { duration: 120 },
} as const;

export interface PackedEffects {
  /** Engine parameters; see `effect_state::Settings::parse` in the engine. */
  params: number[];
  shader?: string;
  /** The shader reads `iMouse`, so pointer positions are forwarded. */
  mouse: boolean;
  /** Any effect is enabled. */
  active: boolean;
}

const number = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
function option<T extends object>(value: boolean | T | undefined): T | undefined {
  if (value === undefined || value === false) return undefined;
  return value === true ? ({} as T) : value;
}
/** Strip comments so identifiers inside them do not enable animation. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

export function packEffects(
  effects: WraithEffects | null | undefined,
  reducedMotion: boolean,
): PackedEffects {
  const e = effects ?? {};
  if (e.shader !== undefined && typeof e.shader !== 'string')
    throw new TypeError('effects.shader must be WGSL source text');
  const crt = option(e.crt);
  const bloom =
    typeof e.bloom === 'number'
      ? e.bloom > 0
        ? { intensity: e.bloom }
        : undefined
      : option<WraithBloomOptions>(e.bloom);
  const trail = reducedMotion ? undefined : option(e.cursorTrail);
  const shader = e.shader?.trim() ? e.shader : undefined;
  const source = shader ? code(shader) : '';
  const timed = /\b(iTime|iTimeDelta|iFrame)\b/.test(source);
  const animate = !!shader && (e.animate ?? (timed && !reducedMotion));
  const d = EFFECT_DEFAULTS;
  const intensity = bloom ? number(bloom.intensity, d.bloom.intensity) : 0;
  const params = [
    crt ? 1 : 0,
    number(crt?.curvature, d.crt.curvature),
    number(crt?.scanlines, d.crt.scanlines),
    number(crt?.vignette, d.crt.vignette),
    number(crt?.aberration, d.crt.aberration),
    Math.max(0, intensity),
    number(bloom?.threshold, d.bloom.threshold),
    number(bloom?.spread, d.bloom.spread),
    trail ? 1 : 0,
    number(trail?.duration, d.cursorTrail.duration),
    animate ? 1 : 0,
  ];
  return {
    params,
    shader,
    mouse: /\biMouse\b/.test(source),
    active: !!crt || intensity > 0 || !!trail || !!shader,
  };
}

/**
 * Owns the effects configuration for one terminal: re-applies it when the
 * reduced-motion preference changes and forwards pointer positions only
 * while a custom shader reads `iMouse`.
 */
export class EffectsController {
  private current: WraithEffects | null = null;
  /** The last accepted request, kept so reduced motion can be re-evaluated. */
  private requested: WraithEffects | null = null;
  private disposed = false;
  private applied?: string;
  private motion?: MediaQueryList;
  private motionListener?: () => void;
  private pointer?: AbortController;
  private mouse = [0, 0, 0, 0];
  private mouseFrame = 0;
  private queue = Promise.resolve();
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly dpr: () => number,
    private readonly apply: (packed: PackedEffects) => Promise<void>,
    private readonly sendMouse: (mouse: number[]) => void,
    private readonly report: (error: Error) => void,
  ) {}
  get effects(): WraithEffects | null {
    return this.current;
  }
  set(effects: WraithEffects | null | undefined): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Terminal disposed'));
    const next = effects ? { ...effects } : null;
    const run = this.queue.then(() => this.configure(next));
    this.queue = run.catch(() => {});
    return run;
  }
  private reducedMotion(): boolean {
    return !!this.motion?.matches;
  }
  private async configure(effects: WraithEffects | null) {
    if (this.disposed) throw new Error('Terminal disposed');
    if (effects && !this.motion && typeof matchMedia === 'function') {
      this.motion = matchMedia('(prefers-reduced-motion: reduce)');
      this.motionListener = () => {
        // Re-apply the request, not just what is active: a trail-only request
        // is inactive under reduced motion and returns when it is lifted.
        if (!this.requested || this.disposed) return;
        void this.set(this.requested).catch((error) => this.report(error));
      };
      this.motion.addEventListener('change', this.motionListener);
    }
    const packed = packEffects(effects, this.reducedMotion());
    const key = JSON.stringify([packed.params, packed.shader]);
    if (key !== this.applied) {
      // Rejects with compiler messages; the previous effects stay in place.
      await this.apply(packed);
      this.applied = key;
    }
    this.requested = effects;
    this.current = packed.active ? effects : null;
    this.trackPointer(packed.active && packed.mouse);
  }
  private trackPointer(enabled: boolean) {
    if (!enabled) {
      this.pointer?.abort();
      this.pointer = undefined;
      return;
    }
    if (this.pointer) return;
    this.pointer = new AbortController();
    const signal = this.pointer.signal;
    // iMouse: xy follows the pointer (hover included, unlike Shadertoy), zw is
    // the press position, negated after release. Physical px, top-left origin.
    const update = (event: PointerEvent, phase: 'down' | 'move' | 'up') => {
      const rect = this.canvas.getBoundingClientRect();
      const scale = this.dpr();
      const x = (event.clientX - rect.left) * scale,
        y = (event.clientY - rect.top) * scale;
      if (phase === 'down') this.mouse = [x, y, x, y];
      else if (phase === 'up')
        this.mouse = [x, y, -Math.abs(this.mouse[2]!), -Math.abs(this.mouse[3]!)];
      else this.mouse = [x, y, this.mouse[2]!, this.mouse[3]!];
      if (this.mouseFrame) return;
      this.mouseFrame = requestAnimationFrame(() => {
        this.mouseFrame = 0;
        this.sendMouse(this.mouse);
      });
    };
    const target = this.canvas.parentElement ?? this.canvas;
    target.addEventListener('pointerdown', (e) => update(e as PointerEvent, 'down'), { signal });
    target.addEventListener('pointermove', (e) => update(e as PointerEvent, 'move'), { signal });
    target.addEventListener('pointerup', (e) => update(e as PointerEvent, 'up'), { signal });
  }
  dispose() {
    this.disposed = true;
    this.requested = null;
    this.pointer?.abort();
    this.pointer = undefined;
    if (this.mouseFrame) cancelAnimationFrame(this.mouseFrame);
    this.motion?.removeEventListener('change', this.motionListener!);
    this.motion = undefined;
  }
}
