import { describe, expect, it } from 'vitest';
import { EFFECT_DEFAULTS, packEffects } from './effects.js';

describe('packEffects', () => {
  it('packs nothing active when effects are absent or all off', () => {
    for (const value of [undefined, null, {}, { crt: false, bloom: 0, cursorTrail: false }]) {
      const packed = packEffects(value, false);
      expect(packed.active).toBe(false);
      expect(packed.params[0]).toBe(0);
      expect(packed.params[5]).toBe(0);
      expect(packed.params[8]).toBe(0);
      expect(packed.shader).toBeUndefined();
    }
    expect(packEffects({ shader: '   ' }, false).active).toBe(false);
  });
  it('applies defaults and explicit options in engine order', () => {
    const d = EFFECT_DEFAULTS;
    expect(packEffects({ crt: true, bloom: true, cursorTrail: true }, false).params).toEqual([
      1,
      d.crt.curvature,
      d.crt.scanlines,
      d.crt.vignette,
      d.crt.aberration,
      d.bloom.intensity,
      d.bloom.threshold,
      d.bloom.spread,
      1,
      d.cursorTrail.duration,
      0,
    ]);
    const packed = packEffects(
      { crt: { curvature: 0, scanlines: 1 }, bloom: 1.5, cursorTrail: { duration: 200 } },
      false,
    );
    expect(packed.params.slice(0, 3)).toEqual([1, 0, 1]);
    expect(packed.params[5]).toBe(1.5);
    expect(packed.params.slice(8, 10)).toEqual([1, 200]);
  });
  it('disables the cursor trail under reduced motion', () => {
    expect(packEffects({ cursorTrail: true }, true).active).toBe(false);
    expect(packEffects({ cursorTrail: true, crt: true }, true).params[8]).toBe(0);
  });
  it('animates custom shaders only when they read time, unless overridden', () => {
    const still = 'fn mainImage(p: vec2<f32>) -> vec4<f32> { return vec4<f32>(1.); }';
    const timed = 'fn mainImage(p: vec2<f32>) -> vec4<f32> { return vec4<f32>(sin(iTime)); }';
    const commented = `// iTime is unused here\n${still}`;
    expect(packEffects({ shader: still }, false).params[10]).toBe(0);
    expect(packEffects({ shader: commented }, false).params[10]).toBe(0);
    expect(packEffects({ shader: timed }, false).params[10]).toBe(1);
    expect(packEffects({ shader: timed }, true).params[10]).toBe(0);
    expect(packEffects({ shader: timed, animate: false }, false).params[10]).toBe(0);
    expect(packEffects({ shader: still, animate: true }, true).params[10]).toBe(1);
    expect(packEffects({ shader: timed }, false).mouse).toBe(false);
    expect(packEffects({ shader: `${still} // iMouse` }, false).mouse).toBe(false);
    expect(packEffects({ shader: still.replace('1.', 'iMouse.x') }, false).mouse).toBe(true);
  });
  it('rejects non-string shaders', () => {
    expect(() => packEffects({ shader: 42 as unknown as string }, false)).toThrow(TypeError);
  });
});
