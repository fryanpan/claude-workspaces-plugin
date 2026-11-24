/**
 * A server stopped while its sign-in is still making its tables.
 *
 * `createBoardSignIn` starts Better Auth's migration at once and nothing
 * awaits it until the first sign-in request. A server suite that builds a
 * server with sign-in on and stops it inside that window used to close the
 * user list under the migration: `RangeError: Cannot use a closed database`,
 * thrown outside every test. bun counts that as "1 error", not a failed test,
 * and exits 1 — so a CI shard went red while every chunk printed "0 fail".
 */
import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoardSignIn } from '../src/auth/board-signin.ts';
import { loadCookieKey } from '../src/share/link-session.ts';

const ORIGIN = 'https://riverbend-workspaces.harborlight.test';

describe('closing a sign-in before its tables are made', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('waits for the tables, then closes, and throws nothing outside a test', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-signin-close-'));
    dirs.push(dir);
    const escaped: unknown[] = [];
    const onRejection = (reason: unknown) => escaped.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const signIn = createBoardSignIn({
        dataDir: dir,
        baseKey: loadCookieKey(dir),
        origin: ORIGIN,
        google: { clientId: 'shared-client', clientSecret: 'stub-secret' },
        mayHaveAccount: () => false,
      });
      // At once, with no request in between: what a server stopped during
      // boot does.
      await signIn.close();

      const db = new Database(join(dir, 'signin.sqlite'));
      const tables = (
        db.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
      ).map((r) => r.name);
      db.close();
      expect(tables).toEqual(expect.arrayContaining(['user', 'session', 'account']));
      expect(escaped).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
