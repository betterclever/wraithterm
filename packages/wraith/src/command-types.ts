/** Where a command block is in its life cycle. */
export type CommandState = 'running' | 'done';
/**
 * Buffer rows of a block's marks: 0 is the oldest retained scrollback row, so
 * rows shift when scrollback is trimmed. -1 means the mark was not sent or its
 * row has been trimmed.
 */
export interface CommandRows {
  /** OSC 133;A, where the prompt starts. */
  prompt: number;
  /** OSC 133;B, where the typed command starts. */
  input: number;
  /** OSC 133;C, where output starts. */
  output: number;
  /** OSC 133;D, where the command ended. */
  end: number;
}
/** One shell command and its output, from OSC 133 semantic prompt marks. */
export interface CommandBlock {
  /** Unique within a terminal, increasing in order of prompts. */
  readonly id: number;
  /**
   * The command line. Taken from `OSC 133;C;cmdline_url=…` (or `cmdline=`)
   * when the shell sends it; otherwise the text typed between B and C.
   */
  readonly command: string;
  readonly state: CommandState;
  /** From OSC 133;D;<code>. Undefined while running or when not reported. */
  readonly exitCode: number | undefined;
  /** Epoch milliseconds when the terminal parsed OSC 133;C. */
  readonly startedAt: number | undefined;
  /** Epoch milliseconds when the terminal parsed OSC 133;D (or the next prompt). */
  readonly finishedAt: number | undefined;
  readonly durationMs: number | undefined;
  readonly rows: CommandRows;
  /** Some of this block's rows have left the scrollback. */
  readonly truncated: boolean;
  /**
   * Output text, read lazily from the terminal buffer. Soft-wrapped lines are
   * joined and trailing spaces trimmed. Trimmed rows are missing; `truncated`
   * on the resolved value says whether any are.
   */
  output(): Promise<string>;
}
/** Options for command blocks. All default to true. */
export interface CommandBlockOptions {
  /** Draw a gutter mark per block, colored by exit status. */
  gutter?: boolean;
  /** Show a copy-output button when the pointer is over a finished block. */
  copyButton?: boolean;
  /** Cmd+Up/Down (macOS) or Ctrl+Shift+Up/Down jump between prompts. */
  keyBindings?: boolean;
  colors?: Partial<CommandColors>;
}
export interface CommandColors {
  success: string;
  failure: string;
  running: string;
  /** Finished without a reported exit code. */
  unknown: string;
}
export const DEFAULT_COMMAND_COLORS: CommandColors = {
  success: '#3fb950',
  failure: '#f85149',
  running: '#d29922',
  unknown: '#6e7681',
};

/** Whether `event` is a jump-to-prompt key, and in which direction. */
export function promptKeyDirection(event: KeyboardEvent): -1 | 1 | 0 {
  if (event.type !== 'keydown' || event.altKey) return 0;
  const mac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');
  const chord = mac
    ? event.metaKey && !event.ctrlKey && !event.shiftKey
    : event.ctrlKey && event.shiftKey && !event.metaKey;
  if (!chord) return 0;
  return event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
}

const zsh = String.raw`# Wraith command blocks (OSC 133). Add to ~/.zshrc.
if [[ -o interactive && -z $WRAITH_SHELL_INTEGRATION ]]; then
  WRAITH_SHELL_INTEGRATION=1
  _wraith_ran=
  _wraith_precmd() {
    local code=$?
    [[ -n $_wraith_ran ]] && printf '\e]133;D;%s\a' "$code"
    _wraith_ran=
    printf '\e]133;A\a'
  }
  _wraith_preexec() {
    _wraith_ran=1
    local LC_ALL=C cmd=$1 out= i c
    for (( i = 1; i <= $#cmd; i++ )); do
      c=$cmd[i]
      case $c in
        [A-Za-z0-9._~/-]) out+=$c ;;
        *) out+=$(printf '%%%02X' "'$c") ;;
      esac
    done
    printf '\e]133;C;cmdline_url=%s\a' "$out"
  }
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd _wraith_precmd
  add-zsh-hook preexec _wraith_preexec
  PS1=$PS1'%{'$'\e]133;B\a''%}'
fi`;

const bash = String.raw`# Wraith command blocks (OSC 133). Add to ~/.bashrc (bash 4.4+).
if [[ $- == *i* && -z $WRAITH_SHELL_INTEGRATION ]]; then
  WRAITH_SHELL_INTEGRATION=1
  _wraith_ran=
  _wraith_prompt() {
    local code=$?
    [[ -n $_wraith_ran ]] && printf '\e]133;D;%s\a' "$code"
    _wraith_ran=
    printf '\e]133;A\a'
  }
  # PS0 runs command substitutions in a subshell; this only prints the mark.
  _wraith_preexec() {
    local cmd out= i c LC_ALL=C
    cmd=$(HISTTIMEFORMAT= history 1 | sed 's/^ *[0-9]* *//')
    for (( i = 0; i < ${'$'}{#cmd}; i++ )); do
      c=${'$'}{cmd:i:1}
      case $c in
        [A-Za-z0-9._~/-]) out+=$c ;;
        *) printf -v c '%%%02X' "'$c"; out+=$c ;;
      esac
    done
    printf '\e]133;C;cmdline_url=%s\a' "$out"
  }
  PROMPT_COMMAND="_wraith_prompt${'$'}{PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  # The array subscript sets _wraith_ran in this shell and expands to nothing.
  PS0='${'$'}{_wraith_x[${'$'}{_wraith_ran:=1}]}$(_wraith_preexec)'"$PS0"
  PS1="$PS1"'\[\e]133;B\a\]'
fi`;

const fish = String.raw`# Wraith command blocks (OSC 133). Add to ~/.config/fish/config.fish.
# fish 4.0 and later emit OSC 133 themselves; this covers fish 3.x.
if status is-interactive; and not set -q WRAITH_SHELL_INTEGRATION
    and test (string split -f1 . $version) -lt 4
  set -g WRAITH_SHELL_INTEGRATION 1
  function __wraith_prompt --on-event fish_prompt
    if set -q __wraith_ran
      printf '\e]133;D;%s\a' $__wraith_status
      set -e __wraith_ran
    end
    printf '\e]133;A\a'
  end
  function __wraith_preexec --on-event fish_preexec
    set -g __wraith_ran 1
    printf '\e]133;C;cmdline_url=%s\a' (string escape --style=url -- $argv[1])
  end
  function __wraith_postexec --on-event fish_postexec
    set -g __wraith_status $status
  end
  functions -c fish_prompt __wraith_original_prompt
  function fish_prompt
    __wraith_original_prompt
    printf '\e]133;B\a'
  end
end`;

/**
 * Shell integration snippets that emit OSC 133 prompt, command, output and
 * exit-status marks. Paste one into the shell's startup file, or write it to
 * the PTY when a session starts.
 */
export const SHELL_INTEGRATION: Readonly<{ bash: string; zsh: string; fish: string }> =
  Object.freeze({ bash, zsh, fish });
