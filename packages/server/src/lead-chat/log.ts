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
 * talks to its lead for a year still loads in one bounded read. The server
 * holds the latest `LEAD_CHAT_KEEP`; a page scrolling back past them reads
 * the file again (`history`), up to `LEAD_CHAT_HISTORY_BYTES` off the tail.
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
import { open, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type LeadChatMessage,
  compareLeadChatEntries,
  parseLeadChatMessage,
} from '@claude-workspaces/core/lead-chat';

/** How many bytes off the tail one load reads. Four thousand characters at
 *  most per message, so this holds several hundred of the longest. */
export const LEAD_CHAT_READ_BYTES = 2 * 1024 * 1024;
/** How many messages a board keeps in memory. */
export const LEAD_CHAT_KEEP = 200;
/** How many bytes off the tail a read back through the history may take.
 *  Eight thousand of the longest messages, and many times that of the usual
 *  ones; a message older than this is still on disk but no page reaches it. */
export const LEAD_CHAT_HISTORY_BYTES = 32 * 1024 * 1024;

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

/** A tail read from its first whole line; the whole file when it fit. */
function fromFirstLine(buf: Buffer, whole: boolean): string {
  const text = buf.toString('utf8');
  if (whole) return text;
  const nl = text.indexOf('\n');
  return nl === -1 ? '' : text.slice(nl + 1);
}

/** The tail of a file, from its first whole line. */
function readTail(path: string, cap: number): { text: string; whole: boolean } {
  const size = statSync(path).size;
  if (size <= cap) return { text: readFileSync(path, 'utf8'), whole: true };
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(cap);
    readSync(fd, buf, 0, cap, size - cap);
    return { text: fromFirstLine(buf, false), whole: false };
  } finally {
    closeSync(fd);
  }
}

/** `readTail` off the event loop, for the rare read back through history.
 *  Returns the stat it read against, so a cache keyed on it matches the bytes. */
async function readTailAsync(
  path: string,
  cap: number,
): Promise<{ text: string; whole: boolean; size: number; mtimeMs: number; bytes: number }> {
  const fh = await open(path, 'r');
  try {
    const st = await fh.stat();
    const len = Math.min(st.size, cap);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, st.size - len);
    const whole = st.size <= cap;
    return {
      text: fromFirstLine(buf, whole),
      whole,
      size: st.size,
      mtimeMs: st.mtimeMs,
      bytes: len,
    };
  } finally {
    await fh.close();
  }
}

/**
 * How long a board's parsed history stays in memory after its last page back.
 * A reader scrolling back asks for page after page within seconds; each used to
 * re-read and re-parse up to 32 MB (110–135 ms of synchronous parsing at the
 * cap, measured on 165k messages). Two minutes covers a scroll; the parsed
 * list is tens of MB at the cap, so it is not kept beyond one.
 */
export const LEAD_CHAT_HISTORY_IDLE_MS = 2 * 60 * 1000;
/** How many boards' parsed histories are held at once. */
const HISTORY_CACHE_BOARDS = 4;

interface CachedHistory {
  size: number;
  mtimeMs: number;
  cap: number;
  messages: StoredLeadChatMessage[];
  timer: ReturnType<typeof setTimeout>;
}

/** Every message in `text`, the latest line per id, in chat order. */
function parseLines(text: string): StoredLeadChatMessage[] {
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
    byId.set(m.id, m);
  }
  return [...byId.values()].sort(compareLeadChatEntries);
}

/** What a load holds, and whether it is the board's whole conversation. */
export interface LeadChatLoad {
  messages: StoredLeadChatMessage[];
  /** True when nothing older than `messages[0]` is in the log. */
  complete: boolean;
}

export class LeadChatLog {
  private readonly historyCache = new Map<string, CachedHistory>();
  /** Bytes the history reads have taken off disk since construction. */
  historyBytesRead = 0;

  constructor(
    private readonly dataDir: string,
    private readonly readCap: number = LEAD_CHAT_READ_BYTES,
  ) {}

  /** The latest `LEAD_CHAT_KEEP` messages the tail holds, the latest line
   *  per id, oldest first. */
  load(workspaceId: string): StoredLeadChatMessage[] {
    return this.loadBoard(workspaceId).messages;
  }

  /** `load`, and whether it holds everything the log does. */
  loadBoard(workspaceId: string): LeadChatLoad {
    const path = leadChatLogPath(this.dataDir, workspaceId);
    if (!path || !existsSync(path)) return { messages: [], complete: true };
    let read: { text: string; whole: boolean };
    try {
      read = readTail(path, this.readCap);
    } catch (err) {
      console.error(`[lead-chat] could not read ${workspaceId}'s log: ${String(err)}`);
      return { messages: [], complete: false };
    }
    const all = parseLines(read.text);
    return {
      messages: all.slice(-LEAD_CHAT_KEEP),
      complete: read.whole && all.length <= LEAD_CHAT_KEEP,
    };
  }

  /** Every message within `LEAD_CHAT_HISTORY_BYTES` of the tail, oldest
   *  first, for a page back past what the server holds; null when the disk
   *  refused, which a page is told as an error rather than as the start. */
  async history(
    workspaceId: string,
    cap: number = LEAD_CHAT_HISTORY_BYTES,
  ): Promise<readonly StoredLeadChatMessage[] | null> {
    const path = leadChatLogPath(this.dataDir, workspaceId);
    if (!path || !existsSync(path)) return [];
    try {
      // Parsed once per version of the file: the log is append-only, so an
      // unchanged size and mtime is an unchanged history.
      const st = await stat(path);
      const hit = this.historyCache.get(workspaceId);
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.cap === cap) {
        this.keep(workspaceId, hit);
        return hit.messages;
      }
      const read = await readTailAsync(path, cap);
      this.historyBytesRead += read.bytes;
      const messages = parseLines(read.text);
      this.keep(workspaceId, { size: read.size, mtimeMs: read.mtimeMs, cap, messages });
      return messages;
    } catch (err) {
      console.error(`[lead-chat] could not read ${workspaceId}'s history: ${String(err)}`);
      return null;
    }
  }

  /** Hold a board's parsed history for another idle window. */
  private keep(workspaceId: string, entry: Omit<CachedHistory, 'timer'>): void {
    const old = this.historyCache.get(workspaceId);
    if (old) clearTimeout(old.timer);
    // Deleted and set again so the Map's order is least recently used first.
    this.historyCache.delete(workspaceId);
    const timer = setTimeout(
      () => this.historyCache.delete(workspaceId),
      LEAD_CHAT_HISTORY_IDLE_MS,
    );
    (timer as unknown as { unref?: () => void }).unref?.();
    this.historyCache.set(workspaceId, {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      cap: entry.cap,
      messages: entry.messages,
      timer,
    });
    for (const [id, e] of this.historyCache) {
      if (this.historyCache.size <= HISTORY_CACHE_BOARDS) break;
      clearTimeout(e.timer);
      this.historyCache.delete(id);
    }
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
