import type { Terminal } from './xterm-api.js';
import { KEYBOARD_EXIT_HINT } from './accessibility.js';

let nextId = 0;
/**
 * xterm.js keeps its own accessibility tree and live region under
 * `screenReaderMode`. While that option is on, add the Escape-then-Tab
 * keyboard exit (WCAG 2.1.2) that xterm.js lacks, and describe it on the
 * textarea. With the option off, xterm.js behavior is unchanged.
 */
export function installKeyboardExit(terminal: Terminal): { dispose(): void } {
  const element = terminal.element,
    textarea = terminal.textarea;
  if (!element || !textarea) return { dispose() {} };
  const controller = new AbortController();
  const signal = controller.signal;
  let armed = false;
  const hint = document.createElement('span');
  do hint.id = `wraith-xterm-exit-${++nextId}`;
  while (document.getElementById(hint.id));
  hint.hidden = true;
  hint.textContent = KEYBOARD_EXIT_HINT;
  let described = false;
  const sync = () => {
    const on = !!terminal.options.screenReaderMode;
    if (on === described) return;
    described = on;
    const ids = (textarea.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter((id) => id && id !== hint.id);
    if (on) {
      element.append(hint);
      ids.push(hint.id);
    } else hint.remove();
    if (ids.length) textarea.setAttribute('aria-describedby', ids.join(' '));
    else textarea.removeAttribute('aria-describedby');
  };
  sync();
  // Options can change at any time; re-check whenever focus enters.
  textarea.addEventListener('focus', sync, { signal });
  element.addEventListener(
    'keydown',
    (event) => {
      sync();
      if (event.target !== textarea || !terminal.options.screenReaderMode || event.isComposing) {
        armed = false;
        return;
      }
      const plain = !event.altKey && !event.ctrlKey && !event.metaKey;
      if (armed && event.key === 'Tab' && plain && !event.repeat) {
        armed = false;
        // Browser focus navigation runs; xterm.js never sees this Tab.
        event.stopImmediatePropagation();
        return;
      }
      if (event.key !== 'Shift') armed = event.key === 'Escape' && plain && !event.shiftKey;
    },
    { capture: true, signal },
  );
  for (const type of ['pointerdown', 'paste', 'compositionstart', 'blur'])
    textarea.addEventListener(type, () => (armed = false), { signal });
  return {
    dispose() {
      controller.abort();
      hint.remove();
    },
  };
}
