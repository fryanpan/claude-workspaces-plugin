#!/usr/bin/env bun
/**
 * Repair the documents whose notes read with blank lines between them.
 *
 *   bun scripts/repair-note-list-gaps.ts --data-dir <dir>             # dry run
 *   bun scripts/repair-note-list-gaps.ts --data-dir <dir> --doc <id> --apply
 *
 * The survey is corpus-wide; the repair is not. `--apply` needs at least one
 * `--doc`, because a gap site is a strong signal rather than a proof — an
 * empty paragraph a person typed into and cleared reads exactly like the
 * browser's — and repairing one restructures a document. So the dry run is
 * the plan, and a person reads it and names the documents.
 *
 * `--force` proceeds while a server is live. Only pass it knowing which
 * server that is and that it does not hold this corpus — one that does
 * rewrites every document it has open from memory, throwing the repair away
 * with no error anywhere.
 *
 * The repair is `packages/server/src/note-list-gap-repair.ts`; this file is
 * the only thing that names a real data directory, which is what keeps a test
 * run and a stray import from rewriting a corpus. Read that module's header
 * for what the move does to block ids, authorship and comment anchors, and
 * for how to revert one document.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { pidIsAlive, readDiscovery } from '../packages/core/src/discovery-file.ts';
import { repairDataDir } from '../packages/server/src/note-list-gap-repair.ts';

interface Args {
  dataDir: string;
  apply: boolean;
  force: boolean;
  docs: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dataDir: '', apply: false, force: false, docs: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--data-dir') args.dataDir = argv[++i] ?? '';
    else if (flag === '--doc') args.docs.push(argv[++i] ?? '');
    else if (flag === '--apply') args.apply = true;
    else if (flag === '--force') args.force = true;
    else if (flag === '--dry-run') args.apply = false;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.dataDir) throw new Error('--data-dir is required');
  // A gap site is a strong signal, not a proof — an empty paragraph a person
  // cleared reads exactly like the browser's — and repairing one RESTRUCTURES
  // a document. So the survey is corpus-wide and the repair is not: somebody
  // reads the dry run and names the documents.
  if (args.apply && args.docs.length === 0) {
    throw new Error('--apply needs at least one --doc: run the dry survey first and name them');
  }
  if (!existsSync(args.dataDir)) throw new Error(`no such data dir: ${args.dataDir}`);
  return args;
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}

// A server holding a document rewrites it from memory on its next flush, so a
// repair written under one is thrown away with no error anywhere. The
// discovery slot cannot say WHICH corpus that server holds, which is why
// --force is an override rather than this being a hard rule.
if (args.apply && !args.force) {
  const entry = readDiscovery(homedir());
  if (entry && pidIsAlive(entry.pid)) {
    console.error(
      `A server is live on port ${entry.port} (pid ${entry.pid}). It rewrites every\n` +
        'document it holds from memory, which would throw this repair away. Stop it,\n' +
        'or pass --force if that server does not hold this corpus.',
    );
    process.exit(2);
  }
}

const result = repairDataDir(args.dataDir, { apply: args.apply, docIds: args.docs });

console.log(
  args.apply
    ? `\n${result.docsRepaired} doc(s) repaired, ${result.sitesRepaired} site(s), ` +
        `${result.itemsMoved} item(s) moved, ${result.anchorsRebuilt} anchor(s) rebuilt, ` +
        `${result.anchorsUnverified} left alone.`
    : `\n${result.docsWithSites} doc(s) carry ${result.sitesFound} site(s). ` +
        'Name the ones to repair with --doc, then re-run with --apply.',
);
