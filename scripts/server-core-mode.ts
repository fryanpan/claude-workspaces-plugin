/**
 * Core mode for the server suite: `bun run test:server --core` runs every
 * test with every test board on the collab core (M8 cutover trial).
 *
 * It sets `CW_COLLAB_CORE_DEFAULT=on` for the test processes, which starts
 * every board and the server-wide setting on (`collab-core-switch.ts`), so a
 * test that never names the core still syncs through it. No test changes.
 * ci.yml's `server-core` job runs it; `collab-core-mode.test.ts` is the
 * control that fails if the variable stopped reaching the test servers.
 *
 * Three files are left out, each for the same kind of reason: they test the
 * SWITCH, so each starts from a board on the current code or from the
 * default being off, which core mode by definition removes. They still run,
 * unchanged, in the ordinary `server` job. A file belongs here only for that
 * reason; a test that fails in core mode for any other reason is a core bug
 * to fix, not a row to add. A switch test that can say so itself passes
 * `collabCoreDefault: false` instead and stays in the run
 * (`collab-core-strip-signal.test.ts`, `owner-proof-widenings.test.ts`).
 */

export const CORE_MODE_ENV = { CW_COLLAB_CORE_DEFAULT: 'on' } as const;

/** File → why core mode cannot run it. */
export const CORE_MODE_SKIPS: Readonly<Record<string, string>> = {
  'packages/server/test/collab-core-board.test.ts':
    'compares the core with the current code on one server: it needs one board on each path',
  'packages/server/test/collab-core-move-board.test.ts':
    'moves a board from the current code onto the core and back: the board has to start off',
  'packages/server/test/collab-core-runtime-route.test.ts':
    'asserts the server-wide setting starts off and that an owner request turns it on',
};

/**
 * The files core mode runs: `files` without the skipped ones. Throws when a
 * skip names a file the suite no longer has, so this list cannot outlive the
 * tests it excuses.
 */
export function coreModeFiles(files: readonly string[], allFiles: readonly string[]): string[] {
  const missing = Object.keys(CORE_MODE_SKIPS).filter((f) => !allFiles.includes(f));
  if (missing.length > 0) {
    throw new Error(
      `CORE_MODE_SKIPS names ${missing.join(', ')}, which the suite no longer has; remove the row`,
    );
  }
  return files.filter((f) => !(f in CORE_MODE_SKIPS));
}
