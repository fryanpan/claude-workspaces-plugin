import { getMigrations } from 'better-auth/db/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth } from '../src/auth.ts';
import type { Env } from '../src/env.ts';
import { type LocalDatabase, localDatabase } from './local-d1.ts';

let db: LocalDatabase;
beforeAll(async () => {
  db = await localDatabase({ applyMigrations: true });
}, 60_000);
afterAll(() => db.dispose());

describe('the Wrangler migrations', () => {
  it('create every table and column the Better Auth config needs', async () => {
    const env = {
      DB: db.binding,
      BETTER_AUTH_URL: 'http://localhost',
      BETTER_AUTH_SECRET: crypto.randomUUID(),
    } as Env;
    const auth = createAuth(env, { mailer: { send: async () => {} } });
    const { toBeCreated, toBeAdded } = await getMigrations(auth.options);
    expect(toBeCreated.map((t) => t.table)).toEqual([]);
    expect(toBeAdded.map((t) => `${t.table}: ${Object.keys(t.fields).join(', ')}`)).toEqual([]);
  });

  it('let one Google account belong to one person only', async () => {
    const now = new Date().toISOString();
    const insertUser = (id: string) =>
      db.binding
        .prepare(
          'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?1, ?1, ?2, 1, ?3, ?3)',
        )
        .bind(id, `${id}@example.com`, now)
        .run();
    await insertUser('alice');
    await insertUser('bob');
    const link = (id: string, userId: string) =>
      db.binding
        .prepare(
          "INSERT OR IGNORE INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?1, 'g-1', 'google', ?2, ?3, ?3)",
        )
        .bind(id, userId, now)
        .run();
    expect((await link('a1', 'alice')).meta.changes).toBe(1);
    expect((await link('a2', 'bob')).meta.changes).toBe(0);
  });
});
