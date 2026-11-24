#!/usr/bin/env bun
/**
 * Store one sign-in secret in the Mac's Keychain without it passing through
 * argv, shell history or the terminal.
 *
 *   bun run secret:set <entry> [--replace]
 *   printf %s "$VALUE" | bun run secret:set <entry>
 *
 * The value is typed at a prompt that does not echo, or read from stdin
 * when stdin is not a terminal. It is stored the way every Keychain entry
 * here is (`mac-ops.ts`): base64 on `security -i`'s stdin, never as an
 * argument. Only the sign-in entries `machine:deploy` reads
 * (`settings.ts`) and the seed board's collaborator addresses are accepted,
 * and an existing entry is replaced only with `--replace`. The one line
 * printed is `stored <entry>`.
 */
import { secretValueFitsStore } from '../../packages/core/src/secret-line.ts';
import { keychainCreate, keychainHas, keychainReplace } from './mac-ops.ts';
import {
  GOOGLE_CLIENT_ID_ENTRY,
  GOOGLE_CLIENT_SECRET_ENTRY,
  PASSWORD_ENTRIES,
  SEED_MEMBERS_ENTRY,
} from './settings.ts';

export const SETTABLE_ENTRIES: readonly string[] = [
  GOOGLE_CLIENT_ID_ENTRY,
  GOOGLE_CLIENT_SECRET_ENTRY,
  ...Object.values(PASSWORD_ENTRIES),
  SEED_MEMBERS_ENTRY,
];

/** Read a line from the terminal with echo off. */
function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (ch === '\u0003' || ch === '\u0004') {
          finish();
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPiped(): Promise<string> {
  const text = await new Response(Bun.stdin.stream()).text();
  // One trailing newline is the shell's, not the value's.
  return text.replace(/\r?\n$/, '');
}

export async function main(argv: string[]): Promise<number> {
  const replace = argv.includes('--replace');
  const rest = argv.filter((a) => a !== '--replace');
  const entry = rest[0];
  if (rest.length !== 1 || entry === undefined) {
    process.stderr.write('usage: bun run secret:set <entry> [--replace]\n');
    return 2;
  }
  if (!SETTABLE_ENTRIES.includes(entry)) {
    process.stderr.write(`refused: ${entry} is not one of ${SETTABLE_ENTRIES.join(', ')}\n`);
    return 2;
  }
  if (!replace && keychainHas(entry)) {
    process.stderr.write(`refused: the Keychain already has ${entry}; pass --replace\n`);
    return 1;
  }
  const value = process.stdin.isTTY ? await readHidden(`${entry}: `) : await readPiped();
  if (value.trim() === '') {
    process.stderr.write('refused: the value is empty\n');
    return 1;
  }
  if (!secretValueFitsStore(entry, value)) {
    process.stderr.write('refused: the value is too long for the Keychain line\n');
    return 1;
  }
  if (replace) keychainReplace(entry, value);
  else keychainCreate(entry, value);
  process.stdout.write(`stored ${entry}\n`);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      // A message only: an error from here never carries the value.
      process.stderr.write(`secret:set failed: ${e instanceof Error ? e.message : 'unknown'}\n`);
      process.exit(1);
    },
  );
}
