import { defineConfig } from 'vitest/config';

// A DOM is not free: creating a happy-dom window costs ~170ms of CPU per test
// FILE, and vitest builds one per file. Measured 2026-09-10 over packages/core
// alone (76 files): 12.84s of `environment` time against 9ms under `node`.
// Most of this suite never touches a document — the MCP client, the repo
// scripts, most of core — so the DOM is opt-in by PACKAGE, and one core file
// asks for it in its own docblock (`@vitest-environment happy-dom` in
// element.test.ts, which is about anchoring to real elements). A docblock
// still wins over the project's environment, so that file is unaffected.
//
// A file that needs a DOM and does not get one fails loudly on `document is
// not defined`, so this cannot silently weaken a test.
const DOM_PACKAGES = ['workspaces-app', 'widget'];

const testFilesIn = (pkg: string) => [
  `packages/${pkg}/test/**/*.test.{ts,tsx}`,
  `packages/${pkg}/src/**/*.test.{ts,tsx}`,
];

const EXCLUDE = ['packages/server/test/**', 'node_modules/**', 'dist/**'];

export default defineConfig({
  // Preact JSX for .tsx files (mirrors jsx/jsxImportSource in tsconfig.base.json).
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    // One uncapped `vitest run` forks a worker per core (~10-19 processes);
    // two builders' gate runs on a 16GB box already hosting a dozen Claude
    // sessions froze the machine on 2026-08-31 (load 97, swap exhausted).
    // Four workers keeps a full run under a minute while leaving the box alive
    // no matter how many runs overlap. `pool` and `maxWorkers` are process-wide
    // in vitest 4 — they are not per-project options, and the pool's own
    // `poolOptions.forks.maxForks` is gone, folded into `maxWorkers`.
    pool: 'forks',
    maxWorkers: 4,
    // A test that clicks a link used to make happy-dom LOAD the target over
    // the network — `http://localhost:3000/w/…`, where nothing listens — and
    // print the refusal. With navigation off it still moves `location` (the
    // fallback that sets the URL stays on), which is all a test here reads.
    // The `fetch` half of the same refusal is in vitest.setup.ts.
    environmentOptions: {
      happyDOM: { settings: { navigation: { disableMainFrameNavigation: true } } },
    },
    setupFiles: ['./vitest.setup.ts'],
    // Two projects rather than the `environmentMatchGlobs` that vitest 4
    // removed. Each inherits everything above through `extends: true`; only
    // the file set and the environment differ.
    projects: [
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'happy-dom',
          include: DOM_PACKAGES.flatMap(testFilesIn),
          exclude: EXCLUDE,
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'packages/*/test/**/*.test.{ts,tsx}',
            'packages/*/src/**/*.test.{ts,tsx}',
            // Repo-level scripts are gates (release, leak, bundle size); they
            // need covering too, and they are not under packages/.
            'scripts/**/*.test.ts',
          ],
          exclude: [...EXCLUDE, ...DOM_PACKAGES.map((pkg) => `packages/${pkg}/**`)],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // These globs are also what makes a source file no test imports count as
      // 0% rather than vanishing from the denominator: vitest 4 removed
      // `coverage.all`, and an explicit `include` is what took its place — a
      // file matching one of these is instrumented whether a test loaded it or
      // not. A coverage number that only measures the files somebody already
      // tested is the number that cannot fall.
      //
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
