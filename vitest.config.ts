import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Preact JSX for .tsx files (mirrors jsx/jsxImportSource in tsconfig.base.json).
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    // One uncapped `vitest run` forks a worker per core (~10-19 processes);
    // two builders' gate runs on a 16GB box already hosting a dozen Claude
    // sessions froze the machine on 2026-08-31 (load 97, swap exhausted).
    // Four forks keeps a full run under a minute while leaving the box alive
    // no matter how many runs overlap.
    pool: 'forks',
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
    maxWorkers: 4,
    // A DOM is not free: creating a happy-dom window costs ~170ms of CPU per
    // test FILE, and vitest builds one per file. Measured 2026-09-10 over
    // packages/core alone (76 files): 12.84s of `environment` time against
    // 9ms under `node`. Most of this suite never touches a document — the
    // MCP client, the repo scripts, most of core — so the DOM is opt-in by
    // path, and one core file asks for it in its own docblock
    // (`@vitest-environment happy-dom` in element.test.ts, which is about
    // anchoring to real elements).
    //
    // A file that needs a DOM and does not get one fails loudly on
    // `document is not defined`, so this cannot silently weaken a test.
    environment: 'node',
    environmentMatchGlobs: [
      ['packages/workspaces-app/**', 'happy-dom'],
      ['packages/widget/**', 'happy-dom'],
    ],
    // A test that clicks a link used to make happy-dom LOAD the target over
    // the network — `http://localhost:3000/w/…`, where nothing listens — and
    // print the refusal. With navigation off it still moves `location` (the
    // fallback that sets the URL stays on), which is all a test here reads.
    // The `fetch` half of the same refusal is in vitest.setup.ts.
    environmentOptions: {
      happyDOM: { settings: { navigation: { disableMainFrameNavigation: true } } },
    },
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'packages/*/test/**/*.test.{ts,tsx}',
      'packages/*/src/**/*.test.{ts,tsx}',
      // Repo-level scripts are gates (release, leak, bundle size); they need
      // covering too, and they are not under packages/.
      'scripts/**/*.test.ts',
    ],
    exclude: ['packages/server/test/**', 'node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // `all`, so a source file no test imports counts as 0% rather than
      // vanishing from the denominator. A coverage number that only measures
      // the files somebody already tested is the number that cannot fall.
      all: true,
      // `packages/server/src` is deliberately absent: vitest never runs the
      // server suite (see `exclude` above), so instrumenting its sources here
      // would report the whole package as untested. `bun test --coverage`
      // measures it instead, and `scripts/coverage.ts` joins the two.
      include: [
        'packages/core/src/**/*.ts',
        'packages/workspaces-app/src/**/*.{ts,tsx}',
        'packages/mcp/src/**/*.ts',
        'packages/widget/src/**/*.ts',
      ],
      exclude: [
        'packages/*/src/**/*.test.{ts,tsx}',
        'packages/*/src/bin.ts',
        'packages/*/src/**/*.d.ts',
      ],
    },
  },
});
