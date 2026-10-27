import { OutputAnnouncer, mirrorPatch, splitRows } from './announcer.js';
import type { Command, Reply } from './protocol.js';

export type AccessibilityConfig = Extract<Command, { type: 'a11y' }>;
interface Snapshot {
  text: string;
  rows: number;
  cursor: number;
  alternate: boolean;
}
/** How often the mirror follows changing output; announcements are throttled separately. */
const MIRROR_INTERVAL = 100;
/** Typing echo on the cursor row is left to the screen reader's own key echo. */
const ECHO_WINDOW = 1000;

/**
 * Worker-side screen-reader support. It costs nothing until enabled: `changed()`
 * returns immediately. Once enabled, output marks the screen dirty and a
 * trailing timer samples viewport text at most every 100 ms, posting only the
 * rows that changed plus throttled announcements. Engine access goes through
 * `enter`, the session's serial queue, so it never overlaps a GPU fence.
 */
export function createAccessibility(
  snapshot: () => Snapshot | undefined,
  enter: (task: () => void) => void,
  post: (reply: Reply) => void,
) {
  let config: AccessibilityConfig | undefined;
  const announcer = new OutputAnnouncer();
  let mirrored: string[] = [];
  let sampleTimer: ReturnType<typeof setTimeout> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let rebase = true;
  let alternate = false;
  let echoUntil = 0;
  function changed() {
    if (!config || sampleTimer !== undefined) return;
    sampleTimer = setTimeout(() => {
      sampleTimer = undefined;
      enter(sample);
    }, MIRROR_INTERVAL);
  }
  function sample() {
    if (!config) return;
    const view = snapshot();
    // Engine busy (benchmark, fence) or output held by synchronized updates.
    if (!view) {
      changed();
      return;
    }
    const rows = splitRows(view.text, view.rows);
    const now = performance.now();
    let announce: string | undefined;
    if (config.announce) {
      if (rebase || view.alternate !== alternate) announcer.baseline(rows);
      else announcer.sample(rows, now, now < echoUntil ? view.cursor : -1);
      announce = announcer.flush(now);
      scheduleFlush(now);
    }
    rebase = false;
    alternate = view.alternate;
    const patch = config.mirror ? mirrorPatch(mirrored, rows) : [];
    const reshaped = config.mirror && mirrored.length !== rows.length;
    if (config.mirror) mirrored = rows;
    if (patch.length || reshaped || announce !== undefined)
      post({ type: 'a11y', rows: rows.length, patch, cursor: view.cursor, announce });
  }
  function scheduleFlush(now: number) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    const at = announcer.deadline(now);
    if (at === undefined) return;
    flushTimer = setTimeout(
      () => {
        flushTimer = undefined;
        enter(() => {
          if (!config?.announce) return;
          const time = performance.now();
          const announce = announcer.flush(time);
          if (announce !== undefined)
            post({ type: 'a11y', rows: mirrored.length, patch: [], cursor: -1, announce });
          scheduleFlush(time);
        });
      },
      Math.max(0, at - now),
    );
  }
  return {
    configure(next: AccessibilityConfig) {
      const enabled = next.mirror || next.announce;
      if (!next.announce || !config?.announce) rebase = true;
      announcer.configure({
        interval: next.interval,
        maxLines: next.maxLines,
        maxCharacters: next.maxCharacters,
      });
      config = enabled ? next : undefined;
      if (!enabled) {
        clearTimeout(sampleTimer);
        clearTimeout(flushTimer);
        sampleTimer = flushTimer = undefined;
        mirrored = [];
        announcer.baseline(null);
        return;
      }
      // Publish the current screen to a new mirror right away.
      if (next.mirror && !mirrored.length) changed();
      if (next.announce) changed();
    },
    changed,
    /** The viewport moved or was reshaped without new output. */
    rebaseline() {
      if (!config) return;
      rebase = true;
      changed();
    },
    /** Keys that print into the cursor row (not Enter or control chords). */
    typed(echo: boolean) {
      if (!config) return;
      echoUntil = echo ? performance.now() + ECHO_WINDOW : 0;
    },
    dispose() {
      config = undefined;
      clearTimeout(sampleTimer);
      clearTimeout(flushTimer);
    },
  };
}
