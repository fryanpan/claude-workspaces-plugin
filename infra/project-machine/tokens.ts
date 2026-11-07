#!/usr/bin/env bun
/**
 * `bun run machine:tokens`: the central list of long-lived Claude tokens.
 * Commands and rules are in `HELP`; the list is `token-list.ts`.
 */
import { approveOrgSignIn } from './org-signin.ts';
import { addToken, assertNewLabel, readTokenList } from './token-list.ts';
import { moveProject } from './token-move.ts';
import { renderUsage, usageReport } from './token-usage.ts';

export const HELP = `bun run machine:tokens <command>

The list holds only accounts Bryan owns, never another person's: Anthropic's
terms bar routing work through another person's account. No value is printed.

  list
      Each listed token's label, the day it was added, and when it runs out.

  add --label <name> [--stdin]
      Add a token for the Claude account signed in to this Mac's browser, with
      one approval there, or read one claude setup-token made from stdin.

  usage [--project <name>]...
      Each listed token's last reading and the projects on it, from every cw-
      app or the projects named. Through the keeper each project is one tap.

  move --project <name> --to <label>
      Move a project's lead to a listed token and restart its machine. Through
      the keeper this is two taps: one to set the token, one to confirm.
`;

export interface TokensIo {
  /** Where the approval's screen goes, already redacted. */
  show?: (text: string) => void;
  stdin?: () => Promise<string>;
  imageReady?: (commit: string) => boolean;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const expiry = (added: string): string => {
  const y = Number(added.slice(0, 4));
  return Number.isInteger(y) && y > 0 ? `${y + 1}${added.slice(4)}` : 'unknown';
};

async function add(args: string[], io: TokensIo): Promise<number> {
  const label = flag(args, 'label');
  if (!label) {
    console.error(HELP);
    return 2;
  }
  // Before the approval: a token made and then refused stays live for a year.
  assertNewLabel(label);
  const show = io.show ?? ((t: string) => process.stdout.write(t));
  const token = args.includes('--stdin')
    ? (await (io.stdin ?? (() => Bun.stdin.text()))()).trim()
    : await approveOrgSignIn(label, { show });
  const entry = addToken(label, token, new Date().toISOString().slice(0, 10));
  console.log(`[tokens] ${label} is on the list, in the Keychain entry ${entry}`);
  return 0;
}

function list(): number {
  const tokens = readTokenList();
  if (tokens.length === 0) console.log('[tokens] the list is empty');
  for (const t of tokens) {
    console.log(`${t.label}: added ${t.added}, expires about ${expiry(t.added)}`);
  }
  return 0;
}

function usage(args: string[]): number {
  const named = args.flatMap((a, i) => (a === '--project' ? [args[i + 1] ?? ''] : []));
  const labels = readTokenList().map((t) => t.label);
  for (const l of renderUsage(labels, usageReport(named), Date.now())) console.log(l);
  return 0;
}

function move(args: string[], io: TokensIo): number {
  const project = flag(args, 'project');
  const label = flag(args, 'to');
  if (!project || !label) {
    console.error(HELP);
    return 2;
  }
  const r = moveProject(project, label, io.imageReady ? { imageReady: io.imageReady } : {});
  if (r.confirmed) {
    console.log(`[tokens] ${project}'s machine took ${label}: it reports that label`);
    return 0;
  }
  console.error(
    `[tokens] ${project} holds ${label}, but its lead is not confirmed on it; read it with machine:tokens usage --project ${project}`,
  );
  return 1;
}

export async function runTokens(args: string[], io: TokensIo = {}): Promise<number> {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case 'list':
        return list();
      case 'add':
        return await add(rest, io);
      case 'usage':
        return usage(rest);
      case 'move':
        return move(rest, io);
      case 'help':
      case '--help':
        console.log(HELP);
        return 0;
      default:
        console.error(HELP);
        return 2;
    }
  } catch (err) {
    console.error(`[tokens] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await runTokens(process.argv.slice(2)));
}
