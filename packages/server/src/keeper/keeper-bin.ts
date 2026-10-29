#!/usr/bin/env bun
/**
 * The keeper's process. Runs as the relay's macOS user, never as Bryan's.
 *
 *   bun packages/server/src/keeper/keeper-bin.ts                run the keeper
 *   bun packages/server/src/keeper/keeper-bin.ts import <name>  store one credential, read from stdin
 *   bun packages/server/src/keeper/keeper-bin.ts enroll         print a one-time passkey registration link
 *   bun packages/server/src/keeper/keeper-bin.ts adopt <app>    let routine calls reach a Fly app made before the keeper
 *   bun packages/server/src/keeper/keeper-bin.ts check          the start guard and the store check, nothing else
 *   bun packages/server/src/keeper/keeper-bin.ts port           print the keeper's port, choosing it at random the first time
 *   bun packages/server/src/keeper/keeper-bin.ts plist port|keeper  print one of the two LaunchDaemons
 *   bun packages/server/src/keeper/keeper-bin.ts clear-alarm    let approvals run again after a service-worker alarm
 *
 * `CW_KEEPER_DIR` names the store (mode 700, `keeper-store.ts`);
 * `CW_KEEPER_FLY_BIN` the `fly` binary, which must sit where only root or
 * the keeper's user can write; `CW_KEEPER_PORT` overrides the loopback port,
 * which is otherwise chosen once and kept in the store (`keeper-port.ts`);
 * `CW_KEEPER_SOCKET` the unix socket launchd's port job relays to
 * (`keeper-launchd.ts`). Without it the keeper listens on the port itself. Every command but `check` refuses to run when the start guard
 * (`keeper-guard.ts`) finds a path another user could change, so a keeper
 * running from Bryan's checkout, or with Homebrew's `fly`, never starts.
 * The runbook is `docs/process/keeper.md`.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fixedHostFetch } from '../outbound-fetch.ts';
import { keeperExecutors } from './keeper-exec.ts';
import { keeperStartProblems } from './keeper-guard.ts';
import { keeperJobPlist, portJobPlist } from './keeper-launchd.ts';
import { keeperPort } from './keeper-port.ts';
import { serveKeeper } from './keeper-serve.ts';
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
const flyBin = process.env.CW_KEEPER_FLY_BIN?.trim() ?? '';
const socket = process.env.CW_KEEPER_SOCKET?.trim() ?? '';
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
  else {
    const alarm = store.alarm();
    const saved = store.port();
    if (saved !== null) console.log(`port: ${saved}`);
    if (alarm) console.log(`alarm: ${alarm.reason} at ${new Date(alarm.at).toISOString()}`);
    console.log(`store: ok, ${store.passkeys().length} passkeys, ${store.apps().length} apps`);
  }
  process.exit(problems.length || 'error' in store ? 1 : 0);
}
if (problems.length) {
  for (const p of problems) console.error(`[keeper] unsafe: ${p}`);
  fail('refusing to start: another user could change what the keeper runs');
}
const store = openKeeperStore(dir);
if ('error' in store) fail(`refusing to start: ${store.error}`);
const port = keeperPort(store, process.env);

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
    `Open this within 15 minutes, on this Mac, and register your passkey. It works only on the keeper running now; if the keeper restarts, make a new one:\n  http://localhost:${port}/enroll/${b64url(new Uint8Array(randomBytes(16)))}#${token}`,
  );
} else if (command === 'port') {
  // Not console.log: on a terminal it prints a number in colour.
  process.stdout.write(`${port}\n`);
} else if (command === 'plist') {
  // `$K` is the store's parent; the socket's folder sits beside the store.
  const job = {
    user: userInfo().username,
    port,
    socketPath: socket || join(dirname(resolve(dir)), 'run', 'keeper.sock'),
  };
  if (arg === 'port') process.stdout.write(portJobPlist(job));
  else if (arg === 'keeper') {
    process.stdout.write(keeperJobPlist({ ...job, root: dirname(resolve(dir)), home: homedir() }));
  } else fail('plist needs port or keeper');
} else if (command === 'clear-alarm') {
  const alarm = store.alarm();
  store.saveAlarm(null);
  console.log(alarm ? `[keeper] cleared: ${alarm.reason}` : '[keeper] no alarm was raised');
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
    guarded: [homedir(), store.dir],
    ...(socket ? { unix: socket } : {}),
    log: (line) => console.error(`[keeper] ${new Date().toISOString()} ${line}`),
  });
  console.error(
    `[keeper] listening on ${keeper.origin}; ${store.passkeys().length} passkeys registered`,
  );
} else {
  fail(`unknown command "${command}"`);
}
