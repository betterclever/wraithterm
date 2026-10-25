import type { Command, Reply } from './protocol.js';
import type { WraithAccessibilityOptions, WraithTheme } from './types.js';

export const KEYBOARD_EXIT_HINT =
  'Press Escape, then Tab to move focus out of the terminal, or Escape, then Shift+Tab to move backward.';
const HOST_LABELS = ['aria-label', 'aria-labelledby', 'aria-describedby', 'aria-description'];
const VISUALLY_HIDDEN = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  padding: '0',
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: '0',
} as const;
let nextId = 0;

export interface AccessibilityHost {
  host: HTMLElement;
  element: HTMLElement;
  input: HTMLTextAreaElement;
  signal: AbortSignal;
  /** Deliver a command to the worker; false before `init` or after shutdown. */
  send(command: Command): boolean;
  /** CSS pixels of one row and of the grid width. */
  geometry(): { rowHeight: number; width: number };
  setForcedTheme(theme: Required<WraithTheme> | undefined): void;
  announced(text: string): void;
}

function hex(color: string): string | undefined {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (!match) return;
  return `#${match
    .slice(1, 4)
    .map((n) => Number(n).toString(16).padStart(2, '0'))
    .join('')}`;
}
/** System colors resolved through a probe that opts out of forced overrides. */
export function systemTheme(parent: HTMLElement): Required<WraithTheme> | undefined {
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:absolute;forced-color-adjust:none;color:CanvasText;background-color:Canvas;border-color:Highlight;border-style:solid';
  parent.append(probe);
  const style = getComputedStyle(probe);
  const theme = {
    foreground: hex(style.color),
    background: hex(style.backgroundColor),
    cursor: hex(style.borderTopColor),
  };
  probe.remove();
  return theme.foreground && theme.background && theme.cursor
    ? (theme as Required<WraithTheme>)
    : undefined;
}

/**
 * Main-thread accessibility for a native terminal: ARIA names, the row mirror
 * and live region (screen reader mode), the Escape-then-Tab keyboard exit,
 * keyboard focus ring, and forced-colors / reduced-motion preferences.
 */
export class TerminalAccessibility {
  private options: WraithAccessibilityOptions;
  private screenReader = false;
  private mirror?: HTMLDivElement;
  private rows: HTMLDivElement[] = [];
  private live?: HTMLDivElement;
  private hint?: HTMLSpanElement;
  private exitArmed = false;
  private lastTab = -Infinity;
  private labels?: MutationObserver;
  private forced?: MediaQueryList;
  private motion?: MediaQueryList;
  private sent = '';
  constructor(
    private readonly t: AccessibilityHost,
    options: WraithAccessibilityOptions = {},
  ) {
    this.options = options;
    const { element, input, signal } = t;
    element.setAttribute('role', options.role ?? 'group');
    this.syncLabels();
    if (typeof MutationObserver !== 'undefined') {
      this.labels = new MutationObserver(() => this.syncLabels());
      this.labels.observe(t.host, { attributes: true, attributeFilter: HOST_LABELS });
    }
    // Capture on the terminal element runs before the input's own handler.
    element.addEventListener('keydown', (event) => this.keydown(event), { capture: true, signal });
    for (const type of ['pointerdown', 'paste', 'compositionstart', 'blur'])
      input.addEventListener(type, () => (this.exitArmed = false), { signal });
    element.addEventListener('pointerdown', () => this.ring(false), { signal });
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Tab') this.lastTab = performance.now();
      },
      { capture: true, signal },
    );
    // A Tab press is consumed by the next focus change, so a later programmatic
    // focus() does not show the ring.
    document.addEventListener(
      'focusin',
      (event) => {
        if (event.target !== input) this.lastTab = -Infinity;
      },
      { capture: true, signal },
    );
    input.addEventListener(
      'focus',
      () => {
        this.ring(this.options.focusRing !== false && performance.now() - this.lastTab < 500);
        this.lastTab = -Infinity;
      },
      { signal },
    );
    input.addEventListener('blur', () => this.ring(false), { signal });
    input.addEventListener('focus', () => this.live?.replaceChildren(), { signal });
    document.addEventListener('visibilitychange', () => this.live?.replaceChildren(), { signal });
    if (typeof matchMedia === 'function') {
      this.forced = matchMedia('(forced-colors: active)');
      this.motion = matchMedia('(prefers-reduced-motion: reduce)');
      this.forced.addEventListener('change', () => this.applyForcedColors(), { signal });
      this.motion.addEventListener('change', () => this.configure(), { signal });
    }
    this.applyForcedColors();
  }
  get enabled() {
    return this.screenReader;
  }
  get reducedMotion() {
    return this.options.reducedMotion ?? this.motion?.matches ?? false;
  }
  /** Whether new output would be announced right now. */
  get speaking() {
    const mode = this.options.announcements ?? 'focused';
    if (!this.live || mode === false || document.hidden) return false;
    return mode === 'always' || (document.activeElement === this.t.input && document.hasFocus());
  }
  update(options: WraithAccessibilityOptions) {
    this.options = { ...this.options, ...options };
    this.t.element.setAttribute('role', this.options.role ?? 'group');
    this.syncLabels();
    this.applyForcedColors();
    this.configure();
  }
  setScreenReaderMode(enabled: boolean) {
    if (enabled === this.screenReader) return;
    this.screenReader = enabled;
    if (enabled) {
      this.mirror = document.createElement('div');
      this.mirror.className = 'wraith-a11y-screen';
      this.mirror.setAttribute('role', 'list');
      this.mirror.setAttribute('aria-label', 'Terminal screen');
      // Rows overlay the canvas so a screen reader's highlight lands on the
      // painted line. Opacity, not clipping, keeps that geometry.
      Object.assign(this.mirror.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        margin: '0',
        opacity: '0',
        pointerEvents: 'none',
        userSelect: 'none',
        overflow: 'hidden',
        fontFamily: 'monospace',
        whiteSpace: 'pre',
      });
      this.live = document.createElement('div');
      this.live.className = 'wraith-a11y-announcements';
      this.live.setAttribute('role', 'log');
      this.live.setAttribute('aria-live', 'polite');
      this.live.setAttribute('aria-relevant', 'additions');
      this.live.setAttribute('aria-atomic', 'false');
      this.live.setAttribute('aria-label', 'Terminal output');
      Object.assign(this.live.style, VISUALLY_HIDDEN);
      this.t.element.append(this.mirror, this.live);
      this.layout();
    } else {
      this.mirror?.remove();
      this.live?.remove();
      this.mirror = this.live = undefined;
      this.rows = [];
    }
    this.configure();
  }
  /** Send worker configuration only when it changes; nothing when all is off. */
  configure() {
    const announcements = this.options.announcements ?? 'focused';
    const config = {
      type: 'a11y' as const,
      mirror: this.screenReader,
      announce: this.screenReader && announcements !== false,
      interval: Math.max(100, this.options.announceInterval ?? 500),
      maxLines: Math.max(1, this.options.maxAnnouncementLines ?? 20),
      maxCharacters: Math.max(1, this.options.maxAnnouncementCharacters ?? 4000),
      reducedMotion: this.reducedMotion,
    };
    const key = JSON.stringify(config);
    if (key === this.sent) return;
    if (!this.sent && !config.mirror && !config.reducedMotion) return;
    // Before the engine starts (a preference change during font loading) the
    // command is not sent; mount calls configure() again once it is running.
    if (this.t.send(config)) this.sent = key;
  }
  /** Align mirror rows with the canvas after a resize or font change. */
  layout() {
    if (!this.mirror) return;
    const { rowHeight, width } = this.t.geometry();
    Object.assign(this.mirror.style, {
      width: `${width}px`,
      fontSize: `${Math.max(1, rowHeight * 0.75)}px`,
      lineHeight: `${rowHeight}px`,
    });
    for (const row of this.rows) row.style.height = `${rowHeight}px`;
  }
  receive(reply: Extract<Reply, { type: 'a11y' }>) {
    if (this.mirror) {
      const { rowHeight } = this.t.geometry();
      while (this.rows.length > reply.rows) this.rows.pop()!.remove();
      while (this.rows.length < reply.rows) {
        const row = document.createElement('div');
        row.setAttribute('role', 'listitem');
        row.style.height = `${rowHeight}px`;
        this.rows.push(row);
        this.mirror.append(row);
      }
      for (const [index, text] of reply.patch) {
        const row = this.rows[index];
        if (row && row.textContent !== text) row.textContent = text;
      }
    }
    if (reply.announce !== undefined) this.announce(reply.announce, false);
  }
  /** Speak text through the live region. Host messages bypass focus gating. */
  announce(text: string, host = true) {
    if (!this.live || !text) return;
    if (!host && !this.speaking) return;
    const entry = document.createElement('div');
    entry.textContent = text;
    // A new node lets identical successive output be spoken; the region keeps
    // only the latest entry, and removals are not announced.
    this.live.replaceChildren(entry);
    this.t.announced(text);
  }
  mirrorText(): string {
    return this.rows.map((row) => row.textContent ?? '').join('\n');
  }
  private keydown(event: KeyboardEvent) {
    if (event.target !== this.t.input) return;
    if (this.options.keyboardExit === false) {
      this.exitArmed = false;
      return;
    }
    if (event.isComposing) {
      this.exitArmed = false;
      return;
    }
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey;
    if (this.exitArmed && event.key === 'Tab' && plain && !event.repeat) {
      this.exitArmed = false;
      // Leave the default action to the browser's own focus navigation and keep
      // this Tab away from the application.
      event.stopImmediatePropagation();
      return;
    }
    // Shift may be pressed between Escape and Tab for backward traversal.
    if (event.key !== 'Shift') this.exitArmed = event.key === 'Escape' && plain && !event.shiftKey;
  }
  private ring(on: boolean) {
    this.t.element.classList.toggle('wraith-focus-visible', on);
    this.t.element.style.outline = on ? '2px solid Highlight' : '';
    this.t.element.style.outlineOffset = on ? '-2px' : '';
  }
  private syncLabels() {
    const { host, element, input } = this.t;
    const hostLabel = host.getAttribute('aria-label')?.trim();
    element.setAttribute('aria-label', this.options.label ?? hostLabel ?? 'Terminal');
    for (const name of HOST_LABELS) {
      const value = host.getAttribute(name)?.trim();
      if (value && this.options.inputLabel === undefined) input.setAttribute(name, value);
      else input.removeAttribute(name);
    }
    if (this.options.inputLabel !== undefined)
      input.setAttribute('aria-label', this.options.inputLabel);
    else if (!input.hasAttribute('aria-label') && !input.hasAttribute('aria-labelledby'))
      input.setAttribute('aria-label', 'Terminal input');
    if (this.options.keyboardExit !== false) {
      if (!this.hint) {
        this.hint = document.createElement('span');
        do this.hint.id = `wraith-keyboard-exit-${++nextId}`;
        while (document.getElementById(this.hint.id));
        this.hint.hidden = true;
        this.hint.textContent = KEYBOARD_EXIT_HINT;
        element.append(this.hint);
      }
      const described = input.getAttribute('aria-describedby');
      input.setAttribute(
        'aria-describedby',
        described ? `${described} ${this.hint.id}` : this.hint.id,
      );
    } else {
      this.hint?.remove();
      this.hint = undefined;
    }
  }
  private applyForcedColors() {
    const active = this.options.forcedColors !== false && (this.forced?.matches ?? false);
    this.t.setForcedTheme(active ? systemTheme(this.t.element) : undefined);
  }
  dispose() {
    this.labels?.disconnect();
  }
}
