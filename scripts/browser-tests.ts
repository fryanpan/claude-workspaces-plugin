/**
 * Whether the automated suites may launch a real browser, and the one place
 * that answers it.
 *
 * WHY THIS IS A GATE AND NOT A GUARD. Every real-browser case used to ask
 * `resolveChromeBin(undefined)` whether a binary existed, and on a Mac with
 * Chrome in `/Applications` the answer is always yes. So `bun run verify` on
 * this machine launched sixteen headless Chromes inside a forty-second
 * window — each one a Dock icon and a stolen focus while somebody was
 * working. Telling the builder who happened to be running to skip those
 * members fixed it for that builder; the next one inherited nothing. The
 * lever has to be the suite's own configuration, which is this file.
 *
 * SO THE DEFAULT IS OFF, AND CI OPTS IN. `CW_BROWSER_TESTS=1` is set on the
 * three ci.yml steps that already set `CW_CHROME_ARGS` — the same three that
 * launch a browser — so coverage there is unchanged and no gate moved. On a
 * developer machine the variable is unset, the browser cases skip, and
 * `bun run verify` says how many members did not run rather than printing a
 * green that quietly covers less than CI's.
 *
 * ONE VARIABLE, NO EXCEPTIONS. `--only check:client-boot` does not turn it
 * on, and neither does running a single browser test file directly. A rule
 * with exemptions is a rule somebody reasons their way around at 2am; this
 * one is answerable by reading one environment variable.
 *
 * THIS IS NOT ABOUT `bun run ui:shot`. A screenshot somebody asked for is
 * two launches they are watching, not sixteen the suite started behind them.
 * `resolveChromeBin` is untouched and ui-shot keeps working with the gate
 * off — deliberately, because that is the tool the mockup work runs on.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; it reads one environment variable and the filesystem.
 */
import { resolveChromeBin } from './ui-shot-lib.ts';

/** Set this to `1` to let the suites launch a browser. ci.yml does. */
export const BROWSER_TESTS_ENV = 'CW_BROWSER_TESTS';

/** The spellings of yes. Anything else, including unset, is no. */
const TRUTHY = new Set(['1', 'true', 'on', 'yes']);

/**
 * Has somebody opted this run in? Unset is NO — that is the whole point, and
 * it is why the value is read as an allowlist rather than as "not falsy".
 */
export function browserTestsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return TRUTHY.has((env[BROWSER_TESTS_ENV] ?? '').trim().toLowerCase());
}

/** Printed at most once per process, so a skip cannot read like a pass. */
let warned = false;

/**
 * The browser a suite may launch, or `null` to skip its cases.
 *
 * `null` for either of two reasons, and they are not the same thing: nobody
 * opted this run in, or there is no browser installed. The first is the
 * common one here and says so on stderr; the second is what the old guard
 * was for, and still throws nothing, because a throw at module load takes
 * the whole file down instead of skipping its cases.
 */
export function chromeForSuite(
  env: Record<string, string | undefined> = process.env,
  opts: { log?: (msg: string) => void; resolve?: () => string } = {},
): string | null {
  const log = opts.log ?? ((m: string) => console.error(m));
  const resolve = opts.resolve ?? (() => resolveChromeBin(undefined));
  if (!browserTestsEnabled(env)) {
    if (!warned) {
      warned = true;
      log(
        `[browser-tests] skipping real-browser cases: ${BROWSER_TESTS_ENV} is not set. ` +
          `Set ${BROWSER_TESTS_ENV}=1 to run them locally; CI sets it.`,
      );
    }
    return null;
  }
  try {
    return resolve();
  } catch {
    return null;
  }
}

/** Test seam: forget that the notice was printed. */
export function resetBrowserTestsNotice(): void {
  warned = false;
}
