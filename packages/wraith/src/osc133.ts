/** One OSC 133 step, decoded the way libghostty-vt reports it. */
export type Osc133Step =
  | { kind: 'prompt'; prompt: 'primary' | 'right' | 'continuation' | 'secondary' }
  | { kind: 'input' }
  | { kind: 'output'; command: string }
  | { kind: 'end'; exitCode: number | undefined };

const promptKinds = { i: 'primary', r: 'right', c: 'continuation', s: 'secondary' } as const;

function percentDecode(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 37 && /^[\da-f]{2}$/i.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (c < 128) bytes.push(c);
    else for (const b of new TextEncoder().encode(value[i]!)) bytes.push(b);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
/** `cmdline=` values: bare words with backslash escapes, '…' or $'…'. */
function shellDecode(value: string): string {
  if (value.startsWith("$'")) {
    const body = value.slice(2).replace(/'$/, '');
    const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', e: '\x1b', a: '\x07' };
    return body.replace(/\\(x[\da-fA-F]{1,2}|.)/g, (_, e: string) =>
      e[0] === 'x' && e.length > 1
        ? String.fromCharCode(parseInt(e.slice(1), 16))
        : (escapes[e] ?? e),
    );
  }
  if (value.startsWith("'")) return value.slice(1).replace(/'$/, '');
  return value.replace(/\\(.)/g, '$1');
}

/**
 * Decode the data of `OSC 133 ; <data> ST`, as passed to an xterm OSC handler.
 * Returns undefined for steps that do not change a command block (L, unknown).
 */
export function parseOsc133(data: string): Osc133Step | undefined {
  const [action = '', ...fields] = data.split(';');
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (const field of fields) {
    const eq = field.indexOf('=');
    if (eq > 0) options.set(field.slice(0, eq), field.slice(eq + 1));
    else positional.push(field);
  }
  switch (action) {
    case 'A':
    case 'N':
    case 'P': {
      const k = options.get('k') as keyof typeof promptKinds | undefined;
      return { kind: 'prompt', prompt: (k && promptKinds[k]) || 'primary' };
    }
    case 'B':
    case 'I':
      return { kind: 'input' };
    case 'C': {
      // Options may contain ';' only inside cmdline values; rejoin the rest.
      const raw = data.slice(2);
      const url = /(?:^|;)cmdline_url=([^;]*)/.exec(raw);
      if (url) return { kind: 'output', command: percentDecode(url[1]!) };
      const line = /(?:^|;)cmdline=(.*)$/.exec(raw);
      return { kind: 'output', command: line ? shellDecode(line[1]!) : '' };
    }
    case 'D': {
      const code = positional[0];
      const exitCode = code !== undefined && /^-?\d+$/.test(code) ? Number(code) : undefined;
      return { kind: 'end', exitCode };
    }
    default:
      return undefined;
  }
}
