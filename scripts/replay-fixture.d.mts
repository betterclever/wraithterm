export declare function rng(seed: number): () => number;
export declare function generateSession(options?: {
  seconds?: number;
  seed?: number;
  cols?: number;
  rows?: number;
  scale?: number;
}): import('../packages/wraith/src/recording.js').Recording;
