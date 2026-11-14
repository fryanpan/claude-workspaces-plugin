/**
 * Prints the SQL that creates Better Auth's tables for the plugins src/auth.ts
 * enables, compiled for D1 against an empty local database. Better Auth's CLI
 * cannot reach D1, so this is how a migration file is written:
 *
 *   bun scripts/auth-schema-sql.ts > migrations/000N_auth.sql
 *
 * After adding a plugin, apply the existing migrations first (pass
 * --apply-existing) so only the new tables and columns are printed.
 * test/schema.test.ts fails while the migrations and the config disagree.
 */
import { getMigrations } from 'better-auth/db/migration';
import { createAuth } from '../src/auth.ts';
import type { Env } from '../src/env.ts';
import { localDatabase } from '../test/local-d1.ts';

const db = await localDatabase({ applyMigrations: process.argv.includes('--apply-existing') });
try {
  const env = {
    DB: db.binding,
    BETTER_AUTH_URL: 'http://localhost',
    BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
  } as Env;
  const auth = createAuth(env, { mailer: { send: async () => {} } });
  const { compileMigrations } = await getMigrations(auth.options);
  process.stdout.write(`${await compileMigrations()}\n`);
} finally {
  await db.dispose();
}
