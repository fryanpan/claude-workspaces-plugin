/**
 * The owner changes what a member may do from Board Settings, per person and
 * per `@domain` row, and the member's open page follows without a reload;
 * then a view-only member's comment says the server's reason rather than
 * offering a retry that would meet the same refusal.
 *
 * Real browser, real server, real bundles, a genuine Access token on every
 * request. The owner's change goes through the select on the page, never a
 * direct call to the route. The driver is `board-role-browser-driver.ts`.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { BoardRoleReading } from './board-role-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

/** A bundle build, one launch, two tabs and six page loads. */
const SUITE_MS = 200_000;
const SPAWN_MS = 180_000;
const CASE_MS = 60_000;

let r: BoardRoleReading;

describe.skipIf(CHROME === null)('Board Settings sets each member’s level', () => {
  beforeAll(() => {
    const run = spawnSync('bun', [join(import.meta.dirname, 'board-role-browser-driver.ts')], {
      encoding: 'utf8',
      timeout: SPAWN_MS,
    });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as BoardRoleReading;
  }, SUITE_MS);

  it(
    'offers view, comment and edit per member, and per domain without Owner',
    () => {
      expect(r.personOptions).toEqual(['Owner', 'Can edit', 'Can comment', 'Can view']);
      expect(r.domainOptions).toEqual(['Can edit', 'Can comment', 'Can view']);
    },
    CASE_MS,
  );

  it(
    'a member’s level picked on their row reaches their open page',
    () => {
      expect(r.person).toEqual({
        before: 'All changes saved',
        after: 'View only',
        server: 'view',
        toast: 'bob@harborlight.example can now only view',
      });
    },
    CASE_MS,
  );

  it(
    'a level picked on a domain row reaches the open page of someone it let in',
    () => {
      expect(r.domain).toEqual({
        before: 'All changes saved',
        after: 'Comment only',
        server: 'comment',
        toast: 'Everyone at @harborlight.example can now only comment',
      });
    },
    CASE_MS,
  );

  it(
    'a view-only member’s comment shows the server’s reason, with no retry, and keeps the draft',
    () => {
      expect(r.refused).toEqual({
        note: 'Not sent. You can view this board. Ask its owner for more access.',
        retry: false,
        kept: 'Harborlight question from Bob',
        onServer: false,
      });
    },
    CASE_MS,
  );

  it(
    'a comment-only member’s comment lands (the control)',
    () => {
      expect(r.allowed).toEqual({ note: '', onServer: true });
    },
    CASE_MS,
  );
});
