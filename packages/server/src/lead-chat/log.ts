/**
 * The lead chat's record: one append-only JSONL file per board, beside
 * `events.jsonl`.
 *
 * Every line is one message, whole, as it stood when it was written. A
 * message that changes later — a person's message the lead then answered —
 * is written again with the same id, and the later line wins on read.
 * Nothing already written is touched again and nothing is deleted (soft
 * delete is project-wide); a torn last line from a crash is skipped.
 *
 * Reads are bounded from the tail, like `agent-note-log.ts`: a board that
 * talks to its lead for a year still loads in one bounded read.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { type LeadChatMessage, parseLeadChatMessage } from '@claude-workspaces/core/lead-chat';

/** How many bytes off the tail one load reads. Four thousand characters at
 *  most per message, so this holds several hundred of the longest. */
export const LEAD_CHAT_READ_BYTES = 2 * 1024 * 1024;
/** How many messages a board keeps in memory and hands to a page. */
export const LEAD_CHAT_KEEP = 200;

/** Board ids are the server's own (`w-…`); anything else never names a file. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A message as the log keeps it. The queue row a typed message went out on,
 *  and the agent it went to, ride along, so a restart still knows which
 *  answer belongs to which question. Never handed to a page. */
export type StoredLeadChatMessage = LeadChatMessage & { queueId?: string; sentTo?: string };

export function leadChatLogPath(dataDir: string, workspaceId: string): string | null {
  if (!SAFE_ID.test(workspaceId)) return null;
  return join(dataDir, 'workspaces', `${workspaceId}.lead-chat.jsonl`);
}

/** The tail of a file, from its first whole line. */
function readTail(path: string, cap: number): string {
  const size = statSync(path).size;
  if (size <= cap) return readFileSync(path, 'utf8');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(cap);
    readSync(fd, buf, 0, cap, size - cap);
    const text = buf.toString('utf8');
    const nl = text.indexOf('\n');
    return nl === -1 ? '' : text.slice(nl + 1);
  } finally {
    closeSync(fd);
  }
}

export class LeadChatLog {
  constructor(
    private readonly dataDir: string,
    private readonly readCap: number = LEAD_CHAT_READ_BYTES,
  ) {}

  /** Every message the tail holds, the latest line per id, oldest first. */
  load(workspaceId: string): StoredLeadChatMessage[] {
    const path = leadChatLogPath(this.dataDir, workspaceId);
    if (!path || !existsSync(path)) return [];
    let text: string;
    try {
      text = readTail(path, this.readCap);
    } catch (err) {
      console.error(`[lead-chat] could not read ${workspaceId}'s log: ${String(err)}`);
      return [];
    }
    const byId = new Map<string, StoredLeadChatMessage>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = parseLeadChatMessage(raw);
      if (!parsed) continue;
      const r = raw as Record<string, unknown>;
      const m: StoredLeadChatMessage = {
        ...parsed,
        ...(typeof r.queueId === 'string' ? { queueId: r.queueId } : {}),
        ...(typeof r.sentTo === 'string' ? { sentTo: r.sentTo } : {}),
      };
      byId.delete(m.id);
      byId.set(m.id, m);
    }
    const all = [...byId.values()].sort((a, b) => a.ts - b.ts);
    return all.slice(-LEAD_CHAT_KEEP);
  }

  /** Write one message as it stands now. False when the disk refused. */
  append(workspaceId: string, m: StoredLeadChatMessage): boolean {
    const path = leadChatLogPath(this.dataDir, workspaceId);
    if (!path) return false;
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(m)}\n`);
      return true;
    } catch (err) {
      console.error(`[lead-chat] could not write ${workspaceId}'s log: ${String(err)}`);
      return false;
    }
  }
}
