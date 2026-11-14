import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    name: 'hud',
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
  },
});
