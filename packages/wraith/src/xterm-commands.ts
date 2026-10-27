import type { IDecoration, IDisposable, IMarker, ITerminalAddon, Terminal } from './xterm-api.js';
import {
  DEFAULT_COMMAND_COLORS,
  promptKeyDirection,
  type CommandBlock,
  type CommandBlockOptions,
  type CommandColors,
} from './command-types.js';
import { parseOsc133 } from './osc133.js';

interface Mark {
  marker: IMarker;
  x: number;
}
interface Block {
  id: number;
  prompt?: Mark;
  input?: Mark;
  output?: Mark;
  end?: Mark;
  command: string;
  exitCode?: number;
  state: 'prompt' | 'input' | 'running' | 'done';
  startedAt?: number;
  finishedAt?: number;
  trimmed: boolean;
  gutter?: IDecoration;
}
const MAX_BLOCKS = 1000;

/**
 * OSC 133 command blocks for the xterm-compatible `Terminal`, with the same
 * `commands()` / `onCommand()` / `jumpToPrompt()` / `copyCommandOutput()` API as
 * `Wraith.mount()`. Marks are xterm markers, so they follow scrollback and
 * reflow; a block whose rows are trimmed reports `truncated`.
 *
 * ```ts
 * const blocks = new CommandBlocksAddon();
 * term.loadAddon(blocks);
 * blocks.onCommand((block) => console.log(block.command, block.exitCode));
 * ```
 */
export class CommandBlocksAddon implements ITerminalAddon {
  private term?: Terminal;
  private blocks: Block[] = [];
  private next = 0;
  private listeners = new Set<(block: CommandBlock) => void>();
  private disposables: IDisposable[] = [];
  private abort = new AbortController();
  private colors: CommandColors;
  private options: CommandBlockOptions;
  constructor(options: CommandBlockOptions = {}) {
    this.options = options;
    this.colors = { ...DEFAULT_COMMAND_COLORS, ...options.colors };
  }
  activate(term: Terminal): void {
    this.term = term;
    this.disposables.push(
      term.parser.registerOscHandler(133, (data) => {
        this.step(data);
        // Leave the sequence to any other handler as well.
        return false;
      }),
    );
    if (this.options.keyBindings !== false && typeof document !== 'undefined')
      document.addEventListener(
        'keydown',
        (event) => {
          if (event.target !== term.textarea || !this.blocks.length) return;
          if (term.buffer.active.type !== 'normal') return;
          const direction = promptKeyDirection(event);
          if (!direction) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          this.jumpToPrompt(direction);
        },
        { capture: true, signal: this.abort.signal },
      );
  }
  /** Markers disposed on purpose; any other disposal means rows were trimmed. */
  private dropped = new WeakSet<IMarker>();
  private mark(block: Block): Mark | undefined {
    const term = this.term!;
    const marker = term.registerMarker(0);
    if (!marker) return undefined;
    marker.onDispose(() => {
      if (!this.dropped.has(marker)) block.trimmed = true;
    });
    return { marker, x: term.buffer.active.cursorX };
  }
  private drop(mark: Mark | undefined) {
    if (!mark) return;
    this.dropped.add(mark.marker);
    mark.marker.dispose();
  }
  private push(state: Block['state']): Block {
    this.next++;
    if (this.blocks.length >= MAX_BLOCKS) this.release(this.blocks.shift()!);
    const block: Block = { id: this.next, command: '', state, trimmed: false };
    this.blocks.push(block);
    return block;
  }
  private release(block: Block) {
    for (const mark of [block.prompt, block.input, block.output, block.end]) this.drop(mark);
    block.gutter?.dispose();
  }
  private finish(block: Block, exitCode: number | undefined, end: boolean) {
    block.state = 'done';
    block.exitCode = exitCode;
    if (end) block.end = this.mark(block);
    block.finishedAt = Date.now();
    this.decorate(block);
    const view = this.view(block);
    for (const listener of this.listeners) {
      try {
        listener(view);
      } catch (error) {
        console.error('Wraith command listener', error);
      }
    }
  }
  private step(data: string) {
    const term = this.term!;
    if (term.buffer.active.type !== 'normal') return;
    const step = parseOsc133(data);
    if (!step) return;
    const last = this.blocks[this.blocks.length - 1];
    const pending = last?.state === 'prompt' || last?.state === 'input';
    switch (step.kind) {
      case 'prompt': {
        if (step.prompt !== 'primary') return;
        if (pending) {
          // A redrawn or abandoned prompt replaces the pending one.
          this.drop(last!.prompt);
          this.drop(last!.input);
          last!.input = undefined;
          last!.prompt = this.mark(last!);
          last!.state = 'prompt';
          return;
        }
        if (last?.state === 'running') this.finish(last, undefined, false);
        const block = this.push('prompt');
        block.prompt = this.mark(block);
        return;
      }
      case 'input': {
        const block = pending ? last! : this.push('input');
        this.drop(block.input);
        block.input = this.mark(block);
        block.state = 'input';
        return;
      }
      case 'output': {
        // A repeated output start belongs to the running command.
        if (last?.state === 'running') {
          last.command ||= step.command;
          return;
        }
        const block = pending ? last! : this.push('input');
        block.output = this.mark(block);
        block.command = step.command;
        block.state = 'running';
        block.startedAt = Date.now();
        this.decorate(block);
        return;
      }
      case 'end':
        if (last?.state === 'running') this.finish(last, step.exitCode, true);
        return;
    }
  }
  private first(block: Block): Mark | undefined {
    for (const mark of [block.prompt, block.input, block.output])
      if (mark && !mark.marker.isDisposed) return mark;
    return undefined;
  }
  /** Exclusive end: the end mark, the next block's first mark, or the cursor. */
  private endOf(block: Block): { line: number; x: number } | undefined {
    if (block.end)
      return block.end.marker.isDisposed
        ? undefined
        : { line: block.end.marker.line, x: block.end.x };
    const index = this.blocks.indexOf(block);
    const next = this.blocks[index + 1];
    if (next) {
      const mark = this.first(next);
      return mark && { line: mark.marker.line, x: mark.x };
    }
    const buffer = this.term!.buffer.active;
    return { line: buffer.baseY + buffer.cursorY, x: buffer.cursorX };
  }
  private decorate(block: Block) {
    const term = this.term!;
    block.gutter?.dispose();
    block.gutter = undefined;
    if (this.options.gutter === false || typeof document === 'undefined') return;
    const start = this.first(block);
    if (!start) return;
    const end = this.endOf(block);
    const last = end ? (end.x === 0 ? end.line - 1 : end.line) : start.marker.line;
    const color =
      block.state === 'running'
        ? this.colors.running
        : block.exitCode === undefined
          ? this.colors.unknown
          : block.exitCode === 0
            ? this.colors.success
            : this.colors.failure;
    const decoration = term.registerDecoration({
      marker: start.marker,
      height: block.state === 'running' ? 1 : Math.max(1, last - start.marker.line + 1),
    });
    decoration?.onRender((element) => {
      element.classList.add('wraith-command-gutter');
      element.style.width = '3px';
      element.style.background = color;
      element.style.pointerEvents = 'none';
    });
    block.gutter = decoration;
  }
  private text(block: Block, input: boolean): string {
    const buffer = this.term!.buffer.active;
    const start = input ? block.input : block.output;
    if (!start || start.marker.isDisposed) {
      if (input || !block.trimmed) return '';
    }
    const from =
      start && !start.marker.isDisposed
        ? { line: start.marker.line, x: start.x }
        : { line: 0, x: 0 };
    const to = input
      ? block.output && !block.output.marker.isDisposed
        ? { line: block.output.marker.line, x: block.output.x }
        : undefined
      : this.endOf(block);
    if (!to) return '';
    let out = '';
    for (let y = from.line; y <= to.line; y++) {
      const line = buffer.getLine(y);
      if (!line) break;
      const begin = y === from.line ? from.x : 0;
      const finish = y === to.line ? to.x : undefined;
      if (y === to.line && to.x === 0) break;
      if (y > from.line && !line.isWrapped) out = out.trimEnd() + '\n';
      out += line.translateToString(finish === undefined, begin, finish);
    }
    return out.replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
  }
  private view(block: Block): CommandBlock {
    const row = (mark: Mark | undefined) =>
      mark && !mark.marker.isDisposed ? mark.marker.line : -1;
    const command = block.command || this.text(block, true).trim();
    return Object.freeze({
      id: block.id,
      command,
      state: block.state === 'done' ? 'done' : 'running',
      exitCode: block.exitCode,
      startedAt: block.startedAt,
      finishedAt: block.finishedAt,
      durationMs:
        block.startedAt !== undefined && block.finishedAt !== undefined
          ? block.finishedAt - block.startedAt
          : undefined,
      rows: Object.freeze({
        prompt: row(block.prompt),
        input: row(block.input),
        output: row(block.output),
        end: row(block.end),
      }),
      truncated: block.trimmed,
      output: async () => this.text(block, false),
    } satisfies CommandBlock);
  }
  /** Commands seen so far, oldest first. */
  async commands(): Promise<CommandBlock[]> {
    return this.blocks
      .filter((b) => b.state === 'running' || b.state === 'done')
      .map((b) => this.view(b));
  }
  onCommand(listener: (block: CommandBlock) => void): IDisposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  /** Scroll the previous (-1) or next (1) prompt to the top of the viewport. */
  jumpToPrompt(direction: -1 | 1): boolean {
    const term = this.term;
    if (!term || term.buffer.active.type !== 'normal') return false;
    const top = term.buffer.active.viewportY;
    const lines = this.blocks
      .map((b) => this.first(b)?.marker.line)
      .filter((line): line is number => line !== undefined && line >= 0);
    const target =
      direction < 0
        ? Math.max(-1, ...lines.filter((l) => l < top))
        : Math.min(Infinity, ...lines.filter((l) => l > top));
    const bottom = term.buffer.active.baseY;
    if (direction < 0 && target >= 0) term.scrollToLine(target);
    else if (direction > 0 && target !== Infinity) term.scrollToLine(Math.min(target, bottom));
    else if (direction > 0 && top < bottom) term.scrollToBottom();
    else return false;
    return term.buffer.active.viewportY !== top;
  }
  async copyCommandOutput(id: number): Promise<string> {
    const block = this.blocks.find((b) => b.id === id);
    if (!block) throw new RangeError(`No command block ${id}`);
    const text = this.text(block, false);
    await navigator.clipboard.writeText(text);
    return text;
  }
  dispose(): void {
    this.abort.abort();
    for (const d of this.disposables) d.dispose();
    for (const block of this.blocks) this.release(block);
    this.blocks = [];
    this.listeners.clear();
  }
}
