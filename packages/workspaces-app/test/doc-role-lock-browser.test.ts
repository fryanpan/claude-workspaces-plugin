/**
 * A `view` or `comment` member's doc page takes no typing and says why, and
 * words typed while the server was refusing them are never sent later.
 *
 * Reported by QA on a shared board: under view and comment the editor stayed
 * editable and said "All changes saved" while the server dropped every
 * keystroke; the words survived a reload in this browser's copy of the doc,
 * and synced the moment the owner raised the role. Real browser, real server,
 * real doc bundle, a genuine Access token on every request, and the owner's
 * own role route for each change.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { RoleLockReading } from './doc-role-lock-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

/** A doc bundle build, one launch and six page loads. */
const SUITE_MS = 200_000;
const SPAWN_MS = 180_000;
const CASE_MS = 60_000;

let r: RoleLockReading;

describe.skipIf(CHROME === null)('a member’s doc page follows their access level', () => {
  beforeAll(() => {
    const run = spawnSync('bun', [join(import.meta.dirname, 'doc-role-lock-browser-driver.ts')], {
      encoding: 'utf8',
      timeout: SPAWN_MS,
    });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as RoleLockReading;
  }, SUITE_MS);

  it(
    'an editor’s typing reaches the server (the control)',
    () => {
      expect(r.edit).toEqual({
        editable: 'true',
        label: 'All changes saved',
        crumb: 'Editing:',
        typedOnPage: true,
        typedOnServer: true,
      });
    },
    CASE_MS,
  );

  it(
    'a view member’s editor takes no typing and says View only',
    () => {
      expect(r.view).toEqual({
        editable: 'false',
        label: 'View only',
        crumb: 'Reading:',
        typedOnPage: false,
        typedOnServer: false,
      });
    },
    CASE_MS,
  );

  it(
    'the View only label stays on screen at 430px, where the save state is hidden',
    () => {
      expect(r.viewLabelAt430).toBe(true);
    },
    CASE_MS,
  );

  it(
    'a comment member’s editor takes no typing and says Comment only',
    () => {
      expect(r.comment).toEqual({
        editable: 'false',
        label: 'Comment only',
        crumb: 'Reading:',
        typedOnPage: false,
        typedOnServer: false,
      });
    },
    CASE_MS,
  );

  it(
    'words typed as the role is cut are dropped from the page and never sent',
    () => {
      expect(r.cut.asViewer).toEqual({
        editable: 'false',
        label: 'View only',
        crumb: 'Reading:',
        typedOnPage: false,
        typedOnServer: false,
      });
    },
    CASE_MS,
  );

  it(
    'raising the role back unlocks the editor without sending the refused words',
    () => {
      expect(r.cut.raised).toEqual({
        editable: 'true',
        label: 'All changes saved',
        crumb: 'Editing:',
        typedOnPage: false,
        typedOnServer: false,
      });
      expect(r.cut.typesAfterRaise).toBe(true);
    },
    CASE_MS,
  );

  it(
    'a reload from this browser’s copy does not bring them back',
    () => {
      expect(r.cut.reloaded.typedOnPage).toBe(false);
      expect(r.cut.reloaded.typedOnServer).toBe(false);
    },
    CASE_MS,
  );
});
