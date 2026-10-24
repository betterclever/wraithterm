import { describe, expect, it, vi } from 'vitest';
import { XtermRenderer } from './xterm-renderer.js';

function fixture() {
  const redraw = vi.fn(),
    forward = vi.fn();
  const renderer = Object.assign(Object.create(XtermRenderer.prototype), {
    selectedStart: undefined,
    selectedEnd: undefined,
    columnSelection: false,
    fallback: { handleSelectionChanged: forward },
    invalidate: redraw,
  });
  return { renderer: renderer as XtermRenderer, redraw, forward };
}
describe('selection notifications preserve row retention', () => {
  it('forwards empty refreshes without invalidating cached rows', () => {
    const { renderer, redraw, forward } = fixture();
    renderer.handleSelectionChanged(undefined, undefined, false);
    renderer.handleSelectionChanged(undefined, undefined, false);
    expect(forward).toHaveBeenCalledTimes(2);
    expect(redraw).not.toHaveBeenCalled();
  });
  it('redraws actual endpoints, clearing and column-mode changes only', () => {
    const { renderer, redraw } = fixture();
    renderer.handleSelectionChanged([1, 2], [5, 4], false);
    renderer.handleSelectionChanged([1, 2], [5, 4], false);
    expect(redraw).toHaveBeenCalledTimes(1);
    renderer.handleSelectionChanged([1, 2], [5, 4], true);
    renderer.handleSelectionChanged([1, 2], [6, 4], true);
    renderer.handleSelectionChanged(undefined, undefined, false);
    renderer.handleSelectionChanged(undefined, undefined, false);
    expect(redraw).toHaveBeenCalledTimes(4);
  });
  it('snapshots mutable caller endpoints', () => {
    const { renderer, redraw } = fixture();
    const start: [number, number] = [1, 2],
      end: [number, number] = [5, 4];
    renderer.handleSelectionChanged(start, end, false);
    start[0] = 2;
    end[1] = 5;
    renderer.handleSelectionChanged(start, end, false);
    expect(redraw).toHaveBeenCalledTimes(2);
  });
});
