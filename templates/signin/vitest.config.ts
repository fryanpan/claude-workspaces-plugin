import { defineConfig } from 'vitest/config';

// Inside the claude-workspaces repo the root vitest.config.ts also runs these
// files; this one is what a copied app uses.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node', hookTimeout: 120_000 },
});
