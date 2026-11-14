/**
 * The private conversation between a person and their own lead agent.
 *
 * One append-only log per pair, `<dataDir>/private-messages/<person>~<agent>.jsonl`,
 * mode 600. There is no delete verb: the log is user content, and the house
 * rule is soft delete. Callers hold the `PrivateMessageStore` interface rather
 * than the file class, so a later store can replace this one without touching
 * them.
 *
 * The interface and its paging live in the collab core
 * (`@claude-workspaces/core/collab`), beside the core's in-memory store;
 * this file is the Workspaces backend, and its on-disk format is unchanged.
 *
 * Who may read or write a pair is decided by the routes
 * (`routes/private-messages.ts`), never here. This module only keeps a pair's
 * file inside its folder: each id is percent-encoded, `.` and `~` included, so
 * no id can climb out with `..` and no two pairs can join to one name.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type NewPrivateMessage,
  type PrivateMessage,
  type PrivateMessagePage,
  type PrivateMessageStore,
  pageOf,
} from '@claude-workspaces/core/collab';
import { cryptoId } from './task-fields.ts';

export type {
  NewPrivateMessage,
  PrivateMessage,
  PrivateMessagePage,
  PrivateMessageStore,
} from '@claude-workspaces/core/collab';

const MAX_ID = 200;

/** An id as one safe file-name part: no `/`, no `.`, no `~`. */
function part(id: string): string {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID) {
    throw new Error('private-messages: an id must be 1-200 characters');
  }
  return encodeURIComponent(id).replace(
    /[.~!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export class FilePrivateMessageStore implements PrivateMessageStore {
  private readonly dir: string;

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = join(dataDir, 'private-messages');
  }

  append(message: NewPrivateMessage): PrivateMessage {
    const path = this.pathOf(message.personId, message.agentId);
    const record: PrivateMessage = {
      id: cryptoId('pm'),
      personId: message.personId,
      agentId: message.agentId,
      from: message.from,
      author: { id: message.author.id, name: message.author.name },
      text: message.text,
      ts: this.now(),
    };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const fresh = !existsSync(path);
    appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    if (fresh) chmodSync(path, 0o600);
    return record;
  }

  page(
    personId: string,
    agentId: string,
    opts: { limit?: number; before?: string } = {},
  ): PrivateMessagePage {
    return pageOf(this.read(this.pathOf(personId, agentId)), opts);
  }

  private pathOf(personId: string, agentId: string): string {
    return join(this.dir, `${part(personId)}~${part(agentId)}.jsonl`);
  }

  private read(path: string): PrivateMessage[] {
    if (!existsSync(path)) return [];
    const out: PrivateMessage[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line) as PrivateMessage;
        if (typeof m?.id === 'string' && typeof m.text === 'string') out.push(m);
      } catch {
        // A torn last line from a crash mid-append: skip it, keep the rest.
      }
    }
    return out;
  }
}
