/**
 * The relay's two files, both append-only and both mode 600, in a state
 * directory only the relay's own user can write.
 *
 * - **`relay-log.jsonl`**: one line per message the relay delivered,
 *   refused, held or released, with ids, seats, organizations and the
 *   verdict, and no message body. It is the record a lead cannot edit: a
 *   lead's own report of what it sent or received is checked against this.
 * - **`relay-held.jsonl`**: the hold queue. A held message keeps its body
 *   here, because Bryan has to read it to decide; it reaches the recipient
 *   only when he releases it. Nothing is ever removed: a release is a log
 *   line, and the queue is the held lines no release line has answered.
 *
 * Both are opened with the append flag on every write, so no code path in
 * the relay can rewrite an earlier line.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type RelayVerdict = 'delivered' | 'refused' | 'held' | 'released';

export interface RelayLogEntry {
  ts: number;
  /** `<sender seat>:<outbox thread id>`, unique per message. */
  id: string;
  from: string;
  to: string;
  fromOrganization: string | null;
  toOrganization: string | null;
  verdict: RelayVerdict;
  reason?: string;
}

export interface HeldMessage {
  ts: number;
  id: string;
  from: string;
  to: string;
  reason: string;
  text: string;
}

export interface RelayStore {
  append(entry: RelayLogEntry): void;
  hold(message: HeldMessage): void;
  /** Every log line, oldest first. */
  entries(): RelayLogEntry[];
  /** Held messages not yet released, oldest first. */
  pending(): HeldMessage[];
  /** Ids that have a final verdict and must not be handled again. */
  handledIds(): Set<string>;
}

function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A torn last line from a crash mid-write; the next append starts clean.
    }
  }
  return out;
}

function appendLine(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
}

export function createRelayStore(stateDir: string): RelayStore {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const logPath = join(stateDir, 'relay-log.jsonl');
  const heldPath = join(stateDir, 'relay-held.jsonl');
  return {
    append: (entry) => appendLine(logPath, entry),
    hold: (message) => appendLine(heldPath, message),
    entries: () => readLines<RelayLogEntry>(logPath),
    pending() {
      const released = new Set(
        readLines<RelayLogEntry>(logPath)
          .filter((e) => e.verdict === 'released')
          .map((e) => e.id),
      );
      return readLines<HeldMessage>(heldPath).filter((m) => !released.has(m.id));
    },
    handledIds: () => new Set(readLines<RelayLogEntry>(logPath).map((e) => e.id)),
  };
}
