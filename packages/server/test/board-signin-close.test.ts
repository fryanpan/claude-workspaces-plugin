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
import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SIGNIN_COOKIE_PREFIX, createBoardSignIn } from '../src/auth/board-signin.ts';
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

  it('logs a migration that fails with no request waiting, and a request still gets the failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-signin-close-'));
    dirs.push(dir);
    // A view where Better Auth makes its `user` table, so the migration's
    // CREATE TABLE fails every time, on every platform.
    const seed = new Database(join(dir, 'signin.sqlite'));
    seed.exec('CREATE VIEW user AS SELECT 1 AS id');
    seed.close();
    const escaped: unknown[] = [];
    const onRejection = (reason: unknown) => escaped.push(reason);
    process.on('unhandledRejection', onRejection);
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const signIn = createBoardSignIn({
        dataDir: dir,
        baseKey: loadCookieKey(dir),
        origin: ORIGIN,
        google: { clientId: 'shared-client', clientSecret: 'stub-secret' },
        mayHaveAccount: () => false,
      });
      await signIn.close();
      // An unhandled rejection is reported on a later turn of the loop.
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(escaped).toEqual([]);
      expect(logged.mock.calls.map((c) => String(c[0]))).toContain(
        '[signin] Better Auth migration failed:',
      );
      const cookie = { cookie: `${SIGNIN_COOKIE_PREFIX}.session_token=x` };
      const req = new Request(`${ORIGIN}/workspaces`, { headers: cookie });
      await expect(signIn.personOf(req)).rejects.toThrow('already exists');
    } finally {
      logged.mockRestore();
      process.off('unhandledRejection', onRejection);
    }
  });
});
