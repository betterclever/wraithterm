import { describe, expect, it } from 'vitest';
import { cellLayoutHeader } from './ghostty-cell-layout.mjs';

// Deliberately different offsets from the pinned library. The generator must
// follow the supplied ABI, not accidentally depend on today's bit positions.
function fixture() {
  const enumeration = (prefix, names) => ({
    kind: 'enum',
    underlying: 'i32',
    size: 4,
    prefix,
    values: Object.fromEntries(names.map((name, i) => [name, i])),
  });
  const arm = () => ({
    kind: 'packed',
    width: 24,
    bits: { codepoint: { lsb: 1, width: 21, type: 'u21' } },
  });
  return {
    schema: 1,
    abi: { endian: 'little' },
    types: {
      GhosttyCell: {
        kind: 'packed',
        size: 8,
        underlying: 'u64',
        bits: {
          wide: { lsb: 0, width: 2, type: 'GhosttyCellWide' },
          style_id: { lsb: 2, width: 16, type: 'GhosttyStyleId' },
          content_tag: { lsb: 18, width: 2, type: 'GhosttyCellContentTag' },
          content: {
            lsb: 20,
            width: 24,
            kind: 'union',
            tag: 'content_tag',
            arms: {
              CODEPOINT: arm(),
              CODEPOINT_GRAPHEME: arm(),
            },
          },
        },
      },
      GhosttyStyleId: { kind: 'alias', type: 'u16', size: 2 },
      GhosttyCellContentTag: enumeration('GHOSTTY_CELL_CONTENT_', [
        'CODEPOINT',
        'CODEPOINT_GRAPHEME',
        'BG_COLOR_PALETTE',
        'BG_COLOR_RGB',
      ]),
      GhosttyCellWide: enumeration('GHOSTTY_CELL_WIDE_', [
        'NARROW',
        'WIDE',
        'SPACER_TAIL',
        'SPACER_HEAD',
      ]),
    },
  };
}

describe('libghostty ABI cell decoder', () => {
  it('derives shifted and nested offsets from the supplied manifest', () => {
    const header = cellLayoutHeader(fixture());
    expect(header).toContain('raw >> 18');
    expect(header).toContain('raw >> 21');
    expect(header).toContain('raw >> 2');
    expect(header).toContain('raw >> 0');
  });
  it.each([
    [
      'schema version',
      (m) => {
        m.schema = 2;
      },
    ],
    [
      'endianness',
      (m) => {
        m.abi.endian = 'big';
      },
    ],
    [
      'cell representation',
      (m) => {
        m.types.GhosttyCell.underlying = 'u128';
      },
    ],
    [
      'missing field',
      (m) => {
        delete m.types.GhosttyCell.bits.wide;
      },
    ],
    [
      'overlapping fields',
      (m) => {
        m.types.GhosttyCell.bits.wide.lsb = 3;
      },
    ],
    [
      'out-of-bounds field',
      (m) => {
        m.types.GhosttyCell.bits.style_id.lsb = 60;
      },
    ],
    [
      'negative offset',
      (m) => {
        m.types.GhosttyCell.bits.wide.lsb = -1;
      },
    ],
    [
      'fractional offset',
      (m) => {
        m.types.GhosttyCell.bits.wide.lsb = 0.5;
      },
    ],
    [
      'different grapheme layout',
      (m) => {
        m.types.GhosttyCell.bits.content.arms.CODEPOINT_GRAPHEME.bits.codepoint.lsb = 0;
      },
    ],
    [
      'unknown content tag',
      (m) => {
        m.types.GhosttyCellContentTag.values.BG_COLOR_RGB = 4;
      },
    ],
    [
      'different style width',
      (m) => {
        m.types.GhosttyStyleId.type = 'u32';
      },
    ],
  ])('rejects unsupported %s', (_, mutate) => {
    const manifest = fixture();
    mutate(manifest);
    expect(() => cellLayoutHeader(manifest)).toThrow();
  });
});
