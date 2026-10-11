import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['packages/wraith/src/**/*.test.ts', 'demo/**/*.test.js'], environment: 'node' },
});
