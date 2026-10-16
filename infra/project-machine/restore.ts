#!/usr/bin/env bun
/**
 * Restore a downloaded snapshot onto an empty data dir.
 *
 *   bun infra/project-machine/restore.ts --snapshot <file> --identity-file <file> --data-dir <dir>
 *
 * The identity is read from a file (mode 600) rather than taken as an
 * argument, so it never appears in `ps`. `--data-dir` must be missing or
 * empty; a data dir holding anything is refused and left untouched. Stop the
 * board server before restoring onto its data dir.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { RestoreRefused, restoreSnapshot } from './snapshot.ts';

function flag(args: string[], name: string): string {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : undefined;
  if (!v) {
    console.error(`[restore] --${name} is required`);
    process.exit(2);
  }
  return v;
}

const args = process.argv.slice(2);
const snapshot = resolve(flag(args, 'snapshot'));
const identityFile = resolve(flag(args, 'identity-file'));
const dataDir = resolve(flag(args, 'data-dir'));

if ((statSync(identityFile).mode & 0o077) !== 0) {
  console.error(`[restore] ${identityFile} is readable by other users; chmod 600 it first`);
  process.exit(2);
}

try {
  restoreSnapshot(snapshot, readFileSync(identityFile, 'utf8'), dataDir);
  console.log(`[restore] restored ${snapshot} onto ${dataDir}`);
} catch (err) {
  console.error(
    `[restore] ${err instanceof RestoreRefused ? 'REFUSED' : 'FAILED'}: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
  process.exit(err instanceof RestoreRefused ? 3 : 1);
}
