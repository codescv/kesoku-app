import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/protocol',
      'packages/ui',
      'packages/hud',
      'apps/relay',
      'apps/client',
    ],
  },
});
