#!/usr/bin/env bun
/**
 * The keeper's process. Runs as the relay's macOS user, never as Bryan's.
 *
 *   bun packages/server/src/keeper/keeper-bin.ts                run the keeper
 *   bun packages/server/src/keeper/keeper-bin.ts import <name>  store one credential, read from stdin
 *   bun packages/server/src/keeper/keeper-bin.ts enroll         print a one-time passkey registration link
 *   bun packages/server/src/keeper/keeper-bin.ts adopt <app>    let routine calls reach a Fly app made before the keeper
 *   bun packages/server/src/keeper/keeper-bin.ts check          the start guard and the store check, nothing else
 *
 * `CW_KEEPER_DIR` names the store (mode 700, `keeper-store.ts`);
 * `CW_KEEPER_FLY_BIN` the `fly` binary, which must sit where only root or
 * the keeper's user can write; `CW_KEEPER_PORT` the loopback port (default
 * 8797). Every command but `check` refuses to run when the start guard
 * (`keeper-guard.ts`) finds a path another user could change, so a keeper
 * running from Bryan's checkout, or with Homebrew's `fly`, never starts.
 * The runbook is `docs/process/keeper.md`.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixedHostFetch } from '../outbound-fetch.ts';
import { keeperExecutors } from './keeper-exec.ts';
import { keeperStartProblems } from './keeper-guard.ts';
import { DEFAULT_KEEPER_PORT, serveKeeper } from './keeper-serve.ts';
import {
  CREDENTIAL_NAMES,
  type CredentialName,
  hashToken,
  openKeeperStore,
} from './keeper-store.ts';
import { b64url } from './webauthn.ts';

function fail(line: string): never {
  console.error(`[keeper] ${line}`);
  process.exit(1);
}

const ENROLL_MS = 15 * 60_000;
const [command, arg] = process.argv.slice(2);
const dir = process.env.CW_KEEPER_DIR?.trim() || fail('CW_KEEPER_DIR is not set');
const port = Number(process.env.CW_KEEPER_PORT) || DEFAULT_KEEPER_PORT;
const flyBin = process.env.CW_KEEPER_FLY_BIN?.trim() ?? '';
const uid = process.getuid?.() ?? -1;

// The install root is four folders above this file. Everything the keeper
// imports is under packages/server/src; bun also reads the configs beside it.
const root = resolve(import.meta.dir, '../../../..');
const configs = [
  'bunfig.toml',
  'package.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'packages/server/package.json',
  'packages/server/tsconfig.json',
]
  .map((f) => join(root, f))
  .filter((f) => existsSync(f));
const problems = keeperStartProblems({
  sourceDirs: [join(root, 'packages/server/src')],
  files: [...configs, process.execPath, ...(flyBin ? [flyBin] : [])],
  keeperUid: uid,
});
if (command === 'check') {
  for (const p of problems) console.log(`unsafe: ${p}`);
  const store = openKeeperStore(dir);
  if ('error' in store) console.log(`store: ${store.error}`);
  else console.log(`store: ok, ${store.passkeys().length} passkeys, ${store.apps().length} apps`);
  process.exit(problems.length || 'error' in store ? 1 : 0);
}
if (problems.length) {
  for (const p of problems) console.error(`[keeper] unsafe: ${p}`);
  fail('refusing to start: another user could change what the keeper runs');
}
const store = openKeeperStore(dir);
if ('error' in store) fail(`refusing to start: ${store.error}`);

if (command === 'import') {
  if (!CREDENTIAL_NAMES.includes(arg as CredentialName)) {
    fail(`import needs one of: ${CREDENTIAL_NAMES.join(', ')}`);
  }
  const value = (await Bun.stdin.text()).trim();
  if (!value || value.length > 4096 || /\s/.test(value))
    fail('stdin must hold one value and nothing else');
  store.setCredential(arg as CredentialName, value);
  console.log(`[keeper] stored ${arg}`);
} else if (command === 'enroll') {
  const token = b64url(new Uint8Array(randomBytes(32)));
  const createdAt = Date.now();
  store.saveEnroll({ tokenHash: hashToken(token), expiresAt: createdAt + ENROLL_MS, createdAt });
  console.log(
    `Open this within 15 minutes, on this Mac, and register your passkey. It works only on the keeper running now; if the keeper restarts, make a new one:\n  http://localhost:${port}/enroll#${token}`,
  );
} else if (command === 'adopt') {
  if (!arg) fail('adopt needs an app name');
  store.addApp(arg);
  console.log(`[keeper] ${arg} may now be started, stopped and restarted without a passkey`);
} else if (command === undefined) {
  if (!flyBin) fail('CW_KEEPER_FLY_BIN is not set');
  const exec = keeperExecutors({ store, flyBin, home: homedir(), fetch: fixedHostFetch });
  const keeper = serveKeeper({
    store,
    exec,
    port,
    log: (line) => console.error(`[keeper] ${new Date().toISOString()} ${line}`),
  });
  console.error(
    `[keeper] listening on ${keeper.origin}; ${store.passkeys().length} passkeys registered`,
  );
} else {
  fail(`unknown command "${command}"`);
}
