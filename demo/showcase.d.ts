export function showcase(
  cols: number,
  rows: number,
  variant: number,
  encoder: TextEncoder,
): { bytes: Uint8Array; sgrChanges: number; variant: number };
