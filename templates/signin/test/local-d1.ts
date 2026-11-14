import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { D1Database } from '@cloudflare/workers-types';
import { getPlatformProxy } from 'wrangler';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface LocalDatabase {
  binding: D1Database;
  dispose: () => Promise<void>;
}

/**
 * A fresh, in-memory D1 run by workerd through wrangler's platform proxy: the
 * same SQLite engine `wrangler dev --local` uses. Nothing is persisted and no
 * remote binding is ever contacted.
 */
export async function localDatabase(opts: { applyMigrations: boolean }): Promise<LocalDatabase> {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: join(ROOT, 'wrangler.jsonc'),
    persist: false,
    remoteBindings: false,
    envFiles: [],
  });
  const binding = proxy.env.DB;
  if (opts.applyMigrations) {
    for (const statements of migrationStatements()) {
      await binding.batch(statements.map((sql) => binding.prepare(sql)));
    }
  }
  return { binding, dispose: () => proxy.dispose() };
}

/** Each migration file in order, split into statements, as wrangler applies them. */
function migrationStatements(): string[][] {
  const dir = join(ROOT, 'migrations');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) =>
      readFileSync(join(dir, name), 'utf8')
        .replace(/^\s*--.*$/gm, '')
        .split(';')
        .map((sql) => sql.trim())
        .filter((sql) => sql.length > 0),
    );
}
