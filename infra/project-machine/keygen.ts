#!/usr/bin/env bun
/**
 * Make a project's backup key pair.
 *
 *   bun infra/project-machine/keygen.ts --identity-file <new file>
 *
 * Writes the identity (the private half) to a new mode-600 file and prints
 * the recipient (the public half). The recipient goes on the machine as
 * BACKUP_RECIPIENT. The identity never goes on the machine or in the bucket:
 * keep it in the password manager, because without it no snapshot restores.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateSnapshotKeys } from './snapshot.ts';

const args = process.argv.slice(2);
const i = args.indexOf('--identity-file');
const path = i >= 0 ? args[i + 1] : undefined;
if (!path) {
  console.error('[keygen] --identity-file <new file> is required');
  process.exit(2);
}
const keys = generateSnapshotKeys();
// `wx`: never overwrite an identity that may already guard snapshots.
writeFileSync(resolve(path), `${keys.identity}\n`, { flag: 'wx', mode: 0o600 });
console.log(`identity written to ${resolve(path)}`);
console.log(`BACKUP_RECIPIENT=${keys.recipient}`);
