#!/usr/bin/env bun
/**
 * `bun run handoff:keygen mac|fly-org [--replace]`: make a holder's handoff
 * key pair and write its public half into `recipients.json`, to commit.
 *
 *   mac      the private half goes to `<handoff folder>/key`, mode 600
 *            (`mac-store.ts`). Refused when one is there, unless --replace:
 *            a new key cannot open what was sealed to the old one.
 *   fly-org  the private half goes to the GitHub Environment `fly-org` as
 *            HANDOFF_PRIVATE_KEY, on `gh secret set`'s stdin. It is never
 *            written to a file or printed.
 *
 * The public half is printed; it is public.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECIPIENTS_FILE, type Recipient } from './items.ts';
import { HANDOFF_REPO, handoffDir, writePrivate } from './mac-store.ts';
import { type KeyPair, generateHandoffKeys } from './seal.ts';

export interface KeygenIo {
  generate: () => KeyPair;
  macKeyExists: () => boolean;
  writeMacKey: (privateKey: string) => void;
  /** `gh secret set <name> --env <env>`, the value on stdin; the exit status. */
  ghSecretSet: (name: string, env: string, value: string) => number;
  readRecipients: () => string;
  writeRecipients: (text: string) => void;
  out: (s: string) => void;
  err: (s: string) => void;
}

export const FLY_ORG_ENV = 'fly-org';
export const FLY_ORG_KEY_SECRET = 'HANDOFF_PRIVATE_KEY';

export function keygen(argv: string[], io: KeygenIo): number {
  const [who, ...flags] = argv;
  if ((who !== 'mac' && who !== 'fly-org') || flags.some((f) => f !== '--replace')) {
    io.err('usage: bun run handoff:keygen mac|fly-org [--replace]\n');
    return 2;
  }
  const holder: Recipient = who;
  if (holder === 'mac' && io.macKeyExists() && !flags.includes('--replace')) {
    io.err(
      '[handoff:keygen] this Mac already has a handoff key; --replace makes a new one, and what was sealed to the old one will not open\n',
    );
    return 1;
  }
  const pair = io.generate();
  if (holder === 'mac') {
    io.writeMacKey(pair.privateKey);
  } else if (io.ghSecretSet(FLY_ORG_KEY_SECRET, FLY_ORG_ENV, pair.privateKey) !== 0) {
    io.err(
      `[handoff:keygen] gh secret set ${FLY_ORG_KEY_SECRET} --env ${FLY_ORG_ENV} failed; recipients.json is unchanged\n`,
    );
    return 1;
  }
  const recipients = JSON.parse(io.readRecipients()) as Record<string, string>;
  recipients[holder] = pair.publicKey;
  io.writeRecipients(`${JSON.stringify(recipients, null, 2)}\n`);
  io.out(
    `${holder}: ${pair.publicKey}\nCommit infra/handoff/recipients.json: a workflow seals to the key on main.\n`,
  );
  return 0;
}

if (import.meta.main) {
  const dir = handoffDir();
  process.exit(
    keygen(process.argv.slice(2), {
      generate: generateHandoffKeys,
      macKeyExists: () => existsSync(join(dir, 'key')),
      writeMacKey: (k) => writePrivate(join(dir, 'key'), `${k}\n`),
      ghSecretSet: (name, env, value) =>
        spawnSync('gh', ['secret', 'set', name, '--env', env, '--repo', HANDOFF_REPO], {
          input: value,
          stdio: ['pipe', 'inherit', 'inherit'],
        }).status ?? 1,
      readRecipients: () => readFileSync(RECIPIENTS_FILE, 'utf8'),
      writeRecipients: (t) => writeFileSync(RECIPIENTS_FILE, t),
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    }),
  );
}
