/**
 * Private messages: the conversation between a person and their own agent,
 * kept apart from every room.
 *
 * One append-only log per pair. A private message is never written into a
 * room's doc, so nothing that syncs or saves a room can carry it; whoever
 * may read a pair is decided by the app's routes, never here. There is no
 * delete verb: the log is user content.
 *
 * `MemoryPrivateMessageStore` is the core's own backend, for tests and small
 * apps. Workspaces keeps its pairs in files (`FilePrivateMessageStore`,
 * `packages/server/src/private-messages.ts`), behind this same interface.
 */

export interface PrivateMessage {
  id: string;
  personId: string;
  agentId: string;
  /** Which side wrote it. */
  from: 'person' | 'agent';
  author: { id: string; name: string };
  text: string;
  ts: number;
}

export type NewPrivateMessage = Omit<PrivateMessage, 'id' | 'ts'>;

export interface PrivateMessagePage {
  /** Oldest first. */
  messages: PrivateMessage[];
  /** Whether older messages exist before the first one returned. */
  more: boolean;
}

export interface PrivateMessageStore {
  append(message: NewPrivateMessage): PrivateMessage;
  /** The newest `limit` messages of a pair (default 50, at most 200), or the
   *  newest before the message `before` names. */
  page(
    personId: string,
    agentId: string,
    opts?: { limit?: number; before?: string },
  ): PrivateMessagePage;
}

export const PRIVATE_PAGE_DEFAULT = 50;
export const PRIVATE_PAGE_MAX = 200;

/** One page of a pair's log, oldest first: shared by every backend. */
export function pageOf(
  all: readonly PrivateMessage[],
  opts: { limit?: number; before?: string } = {},
): PrivateMessagePage {
  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? PRIVATE_PAGE_DEFAULT)),
    PRIVATE_PAGE_MAX,
  );
  let end = all.length;
  if (opts.before !== undefined) {
    const at = all.findIndex((m) => m.id === opts.before);
    end = at === -1 ? 0 : at;
  }
  const start = Math.max(0, end - limit);
  return { messages: all.slice(start, end), more: start > 0 };
}

/** Logs kept in a map, one per pair. */
export class MemoryPrivateMessageStore implements PrivateMessageStore {
  private readonly logs = new Map<string, PrivateMessage[]>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => `pm-${crypto.randomUUID()}`,
  ) {}

  append(message: NewPrivateMessage): PrivateMessage {
    const record: PrivateMessage = {
      id: this.newId(),
      personId: message.personId,
      agentId: message.agentId,
      from: message.from,
      author: { id: message.author.id, name: message.author.name },
      text: message.text,
      ts: this.now(),
    };
    const key = pairKey(message.personId, message.agentId);
    const log = this.logs.get(key) ?? [];
    log.push(record);
    this.logs.set(key, log);
    return { ...record, author: { ...record.author } };
  }

  page(
    personId: string,
    agentId: string,
    opts?: { limit?: number; before?: string },
  ): PrivateMessagePage {
    return pageOf(this.logs.get(pairKey(personId, agentId)) ?? [], opts);
  }

  /** How many pairs have a log. */
  pairCount(): number {
    return this.logs.size;
  }
}

/** A pair's key: the two ids, each JSON-quoted, so no two pairs share one. */
export function pairKey(personId: string, agentId: string): string {
  return `${JSON.stringify(personId)}~${JSON.stringify(agentId)}`;
}
