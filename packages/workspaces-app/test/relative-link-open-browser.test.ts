/**
 * A relative link in a doc opens the doc it names on a plain click and on a
 * tap, through the board's open route, in a real browser against a real
 * server: `[Riverbend data](part-1/2-riverbend-data.mdx)` on an editable doc
 * at 1180x820 with a mouse and at 430x932 with touch.
 *
 * Before the fix a plain click and a tap did nothing for one of the two
 * links (Tiptap drew `notes/…` as `href=""`) and went to a page that is not
 * a doc for the other (the raw path resolved against the doc page's own
 * address). Cmd/Ctrl-click still opens a new tab, Alt-click still puts the
 * caret in the link's words so they can be edited, and a link whose file no
 * doc on the board is bound to lands on the board's not-found page, as a
 * board link to a missing doc does.
 *
 * `relative-link-open-browser-driver.ts` drives the browser; these cases
 * assert on the JSON it prints.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type {
  Gesture,
  LinkName,
  RelativeLinkCase,
  RelativeLinkRun,
} from './relative-link-open-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'relative-link-open-browser-driver.ts');
/** One doc bundle build, two launches, seven gestures. */
const SUITE_MS = 240_000;
const SPAWN_MS = 230_000;
const CASE_MS = 60_000;

let run: RelativeLinkRun | null = null;
const result = (): RelativeLinkRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};
const find = (width: number, link: LinkName, gesture: Gesture): RelativeLinkCase => {
  const c = result().cases.find(
    (x) => x.width === width && x.link === link && x.gesture === gesture,
  );
  if (!c) throw new Error(`no case ${width} ${link} ${gesture}`);
  return c;
};

describe.skipIf(CHROME === null)('a relative link in a doc, in headless Chrome', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as RelativeLinkRun;
  }, SUITE_MS);

  it(
    'a plain click at 1180 and a tap at 430 open the doc the path names',
    () => {
      const r = result();
      for (const [width, gesture] of [
        [1180, 'click'],
        [430, 'touch'],
      ] as const) {
        for (const [link, path, heading] of [
          ['riverbend', r.riverbendPath, 'Riverbend data'],
          ['saltmarsh', r.saltmarshPath, 'Saltmarsh tides'],
        ] as const) {
          const c = find(width, link, gesture);
          const at = `${width} ${link} ${gesture}: ${JSON.stringify(c)}`;
          expect(c.pagePath, at).toBe(path);
          expect(c.heading, at).toBe(heading);
          expect(c.notFound, at).toBe(false);
        }
      }
    },
    CASE_MS,
  );

  it(
    'Cmd- or Ctrl-click opens the doc in a new tab and leaves this one on the guide',
    () => {
      const r = result();
      const c = find(1180, 'riverbend', 'new-tab-click');
      expect(c.opened, JSON.stringify(c)).toEqual([r.riverbendPath]);
      expect(c.pagePath).toBe(r.guidePath);
    },
    CASE_MS,
  );

  it(
    'Alt-click puts the caret in the link, and typing edits its words',
    () => {
      const r = result();
      const c = find(1180, 'riverbend', 'alt-click-type');
      expect(c.pagePath, JSON.stringify(c)).toBe(r.guidePath);
      expect(c.linkText, JSON.stringify(c)).toContain('Z');
      expect(c.opened).toEqual([]);
    },
    CASE_MS,
  );

  it(
    'a link no doc on the board is bound to lands on the not-found page',
    () => {
      const c = find(1180, 'missing', 'click');
      expect(c.pagePath, JSON.stringify(c)).toMatch(
        /\/open\?path=part-9%2Fappendix\.md&from=guide$/,
      );
      expect(c.notFound, JSON.stringify(c)).toBe(true);
    },
    CASE_MS,
  );
});
