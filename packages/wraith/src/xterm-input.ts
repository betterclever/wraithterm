import type { Terminal } from './xterm-api.js';

interface Params {
  params: Int32Array;
  length: number;
  hasSubParams(index: number): boolean;
}
interface Attributes {
  fg: number;
  bg: number;
}
interface InputHandler {
  _parser?: { _params?: Params };
  _curAttrData: Attributes;
  _processSGR0(attributes: Attributes): void;
  charAttributes(params: Params): boolean;
  _extractColor(params: Params, position: number, attributes: Attributes): number;
}

/** Narrow optimization of xterm 6's built-in SGR action. The upstream parser
 * still dispatches every sequence, including synchronous and asynchronous
 * user handlers. Only complete semicolon RGB/palette foreground/background
 * colors avoid the generic temporary-array normalization. Common style/color
 * combinations commit once, after validation, and delegate extended resets
 * to upstream. Other forms use the original action, including colon/mixed
 * parameters and underline color.
 * Installation is per terminal; upstream prototypes are never modified. */
export function accelerateInput(terminal: Terminal): void {
  const input = (terminal as unknown as { _core?: { _inputHandler?: InputHandler } })._core
    ?._inputHandler;
  if (typeof input?._extractColor !== 'function') return;
  const parameters = input._parser?._params;
  if (!(parameters?.params instanceof Int32Array) || typeof parameters.hasSubParams !== 'function')
    return;
  const original = input._extractColor;
  input._extractColor = function (params, position, attributes) {
    const values = params.params;
    const target = values[position];
    if (target === 38 || target === 48) {
      const mode = values[position + 1];
      const advance = mode === 2 ? 4 : mode === 5 ? 2 : 0;
      if (advance && position + advance < params.length) {
        let plain = true;
        for (let i = position; i <= position + advance; i++) {
          if (params.hasSubParams(i)) {
            plain = false;
            break;
          }
        }
        if (plain) {
          const old = target === 38 ? attributes.fg : attributes.bg;
          const color =
            mode === 2
              ? (old & ~0x3ffffff) |
                0x3000000 |
                ((values[position + 2]! & 255) << 16) |
                ((values[position + 3]! & 255) << 8) |
                (values[position + 4]! & 255)
              : (old & ~0x30000ff) | 0x2000000 | (values[position + 2]! & 255);
          if (target === 38) attributes.fg = color;
          else attributes.bg = color;
          return advance;
        }
      }
    }
    return original.call(this, params, position, attributes);
  };

  if (
    typeof input.charAttributes !== 'function' ||
    typeof input._processSGR0 !== 'function' ||
    typeof input._curAttrData?.fg !== 'number' ||
    typeof input._curAttrData?.bg !== 'number'
  )
    return;
  const attributes = input.charAttributes;
  input.charAttributes = function (params) {
    const values = params.params;
    const attr = this._curAttrData;
    let fg = attr.fg,
      bg = attr.bg,
      reset = false;
    // Validate the entire supported sequence in locals before changing state.
    // Any colon or unsupported attribute replays the original action from its
    // original state, preserving extended attributes and upstream diagnostics.
    for (let i = 0; i < params.length; i++) {
      if (params.hasSubParams(i)) return attributes.call(this, params);
      const code = values[i];
      switch (code) {
        case 0:
          fg = bg = 0;
          reset = true;
          break;
        case 1:
          fg |= 0x8000000;
          break;
        case 2:
          bg |= 0x8000000;
          break;
        case 3:
          bg |= 0x4000000;
          break;
        case 7:
          fg |= 0x4000000;
          break;
        case 8:
          fg |= 0x40000000;
          break;
        case 9:
          fg |= 0x80000000;
          break;
        case 38:
        case 48: {
          const mode = values[i + 1];
          const advance = mode === 2 ? 4 : mode === 5 ? 2 : 0;
          if (!advance || i + advance >= params.length) return attributes.call(this, params);
          for (let j = i + 1; j <= i + advance; j++)
            if (params.hasSubParams(j)) return attributes.call(this, params);
          const old = code === 38 ? fg : bg;
          const color =
            mode === 2
              ? (old & ~0x3ffffff) |
                0x3000000 |
                ((values[i + 2]! & 255) << 16) |
                ((values[i + 3]! & 255) << 8) |
                (values[i + 4]! & 255)
              : (old & ~0x30000ff) | 0x2000000 | (values[i + 2]! & 255);
          if (code === 38) fg = color;
          else bg = color;
          i += advance;
          break;
        }
        default:
          return attributes.call(this, params);
      }
    }
    if (reset) {
      // Upstream owns extended-attribute reset/cloning and hyperlink retention.
      this._processSGR0(attr);
      bg |= attr.bg & 0x10000000;
    }
    attr.fg = fg;
    attr.bg = bg;
    return true;
  };
}
