/**
 * A `fly.toml` the keeper will let `fly` read, rewritten from an allowlist.
 *
 * `fly` reads its config as the keeper's user, and a config can name local
 * paths itself (`[[files]] local_path`, `[build] dockerfile`), which no argv
 * check sees. So the keeper parses the config, refuses any key outside the
 * list below, and writes the copy `fly` reads from the parsed values. Every
 * key on the list is either a name or a path inside the machine, never one
 * on this Mac. The list is what the deploy script's own `fly.toml` uses.
 *
 * `fly` reads a config from `--config`, and from the build folder when none
 * is named, so both are cleaned. A build folder's `fly.json` or `fly.yaml`
 * is refused rather than parsed.
 */
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readPlainFile } from './keeper-stage.ts';

/** Keys of one `[[restart]]`, `[[vm]]` or `[mounts]` table, all strings or integers. */
const TABLES: Record<string, Record<string, 'string' | 'int'>> = {
  mounts: { source: 'string', destination: 'string' },
  restart: { policy: 'string', max_retries: 'int' },
  vm: { size: 'string', memory: 'string', cpus: 'int', cpu_kind: 'string' },
};
const TOP_STRINGS = new Set(['app', 'primary_region']);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_CONFIG = 64 * 1024;
const OTHER_CONFIGS = ['fly.json', 'fly.yaml', 'fly.yml'];

const str = (v: string): string => JSON.stringify(v);

/** The config to hand `fly`, or why it is refused. */
export function cleanFlyConfig(text: string): { toml: string } | { error: string } {
  if (text.length > MAX_CONFIG) return { error: 'the fly config is too large' };
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch {
    return { error: 'the fly config is not TOML the keeper can read' };
  }
  const out: string[] = [];
  const later: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (TOP_STRINGS.has(key)) {
      if (typeof value !== 'string') return { error: `fly config ${key} must be a string` };
      out.push(`${key} = ${str(value)}`);
    } else if (key === 'env') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { error: 'fly config [env] must be a table' };
      }
      later.push('[env]');
      for (const [name, v] of Object.entries(value)) {
        if (!ENV_NAME.test(name) || typeof v !== 'string') {
          return { error: `fly config [env] ${name.slice(0, 40)} must be a name set to a string` };
        }
        later.push(`${name} = ${str(v)}`);
      }
    } else if (key in TABLES) {
      const keys = TABLES[key] as Record<string, 'string' | 'int'>;
      const many = Array.isArray(value);
      const rows = many ? (value as unknown[]) : [value];
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          return { error: `fly config ${key} must be a table` };
        }
        later.push(many ? `[[${key}]]` : `[${key}]`);
        for (const [k, v] of Object.entries(row)) {
          const kind = keys[k];
          const ok =
            kind === 'string' ? typeof v === 'string' : kind === 'int' && Number.isInteger(v);
          if (!ok)
            return { error: `fly config ${key}.${k.slice(0, 40)} is not one the keeper accepts` };
          later.push(`${k} = ${kind === 'string' ? str(v as string) : String(v)}`);
        }
      }
    } else {
      return { error: `fly config key ${key.slice(0, 40)} is not one the keeper accepts` };
    }
  }
  return { toml: `${[...out, ...later].join('\n')}\n` };
}

const isConfigFlag = (a: string | undefined): boolean => a === '--config' || a === '-c';

/**
 * Each config `fly` would read from this argv, cleaned: every `--config`
 * value, and the `fly.toml` of every build folder. `at` are the indexes of
 * the argv's local paths, already resolved. A file is read as opened and
 * refused if it is the keeper's (`readPlainFile`).
 */
export function flyConfigsOf(
  args: readonly string[],
  at: readonly number[],
  keeperUid: number,
): { error: string } | { configs: { path: string; toml: string }[] } {
  const files: string[] = [];
  for (const i of at) {
    const a = args[i] as string;
    if (a.startsWith('--config=')) files.push(a.slice('--config='.length));
    else if (isConfigFlag(args[i - 1])) files.push(a);
    else if (
      args[0] === 'deploy' &&
      !a.startsWith('-') &&
      lstatSync(a, { throwIfNoEntry: false })?.isDirectory()
    ) {
      const other = OTHER_CONFIGS.find((name) => existsSync(join(a, name)));
      if (other)
        return { error: `the build folder holds ${other}; the keeper reads only fly.toml` };
      if (lstatSync(join(a, 'fly.toml'), { throwIfNoEntry: false }))
        files.push(join(a, 'fly.toml'));
    }
  }
  const configs: { path: string; toml: string }[] = [];
  for (const path of files) {
    let text: string;
    try {
      text = readPlainFile(path, keeperUid, MAX_CONFIG).bytes.toString('utf8');
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    const clean = cleanFlyConfig(text);
    if ('error' in clean) return { error: `${clean.error} (${path.slice(-80)})` };
    configs.push({ path, toml: clean.toml });
  }
  return { configs };
}
