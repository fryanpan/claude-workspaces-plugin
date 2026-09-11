/**
 * The process half shared by the two note hooks: stdin, the discovery file,
 * the one-time shape marker, stderr. Everything decided is in
 * `./agent-notes.ts`; this file only wires the process to it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type NoteKind, blockDecision, runHook } from './agent-notes.ts';

/** The server publishes its live port here at boot; the MCP child reads
 *  the same file (newest name first). Spelled here because the installed
 *  plugin cannot import `@claude-workspaces/core`. */
const DISCOVERY_DIRS = ['claude-workspaces', 'live-feedback'];

function discoveryPort(): number | undefined {
  for (const dir of DISCOVERY_DIRS) {
    const path = join(homedir(), '.claude', dir, 'server.json');
    if (!existsSync(path)) continue;
    const j = JSON.parse(readFileSync(path, 'utf8')) as { port?: unknown };
    if (typeof j.port === 'number') return j.port;
  }
  return undefined;
}

/** A marker per hook so the live payload's key names are logged once per
 *  machine, not once per turn. Best effort: an unwritable marker means the
 *  line repeats, which is noise, not harm. */
function shapeSeen(kind: NoteKind): boolean {
  try {
    const dir = join(homedir(), '.claude', DISCOVERY_DIRS[0]);
    const marker = join(dir, `hook-shape-${kind}.seen`);
    if (existsSync(marker)) return true;
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, `${new Date().toISOString()}\n`);
    return false;
  } catch {
    return true;
  }
}

/**
 * Run the hook, and relay a nudge if one came back.
 *
 * A Stop hook reaches its own agent exactly one way: `decision: "block"` on
 * stdout, whose `reason` lands in the model's context and keeps the turn
 * open. That is what "told within the turn" means here. Everything else still
 * exits 0 silently — a hook that prints on an ordinary turn would put a line
 * in front of the owner on every single stop.
 *
 * Exit code stays 0 either way: the block is carried by the JSON, and a
 * non-zero exit from a Stop hook means something else entirely.
 */
export async function hookMain(kind: NoteKind): Promise<never> {
  try {
    const nudge = await runHook(kind, await Bun.stdin.text(), {
      env: process.env,
      discoveryPort,
      shapeSeen,
      log: (line) => process.stderr.write(`${line}\n`),
    });
    const decision = blockDecision(nudge);
    if (decision !== undefined) process.stdout.write(`${decision}\n`);
  } catch {
    // fail open
  }
  process.exit(0);
}
