export const COLS: number;
export const ROWS: number;
export interface Scene {
  options: { chart: boolean; preview: boolean };
  /** Kitty payload bytes produced since the last call. */
  takeImageBytes(): number;
  setup(): string;
  /** One frame of the workspace at time `t` seconds. */
  frame(t: number): Promise<string>;
  /** Delete one image's placements. */
  erase(id: number): string;
}
export function createScene(previewUrl: string): Promise<Scene>;
