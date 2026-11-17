/**
 * The direct messages between two people (M10's one-to-one channels).
 *
 * One append-only log per pair, `<dataDir>/direct-messages/<a>~<b>.jsonl`,
 * mode 600, with the two ids in sorted order so both people read the same
 * file. The file format and the id encoding are the private-message store's
 * (`private-messages.ts`), in a folder of its own. There is no delete verb:
 * the log is user content, and the house rule is soft delete.
 *
 * Who may read or write a pair is decided by the route
 * (`routes/direct-messages.ts`), never here.
 */
import type { DirectMessage, DirectMessagePage } from '@claude-workspaces/core/direct-messages';
import { FilePrivateMessageStore, type PrivateMessage } from './private-messages.ts';

export interface DirectMessageStore {
  append(author: { id: string; name: string }, to: string, text: string): DirectMessage;
  /** The newest `limit` messages between `a` and `b`, oldest first, or the
   *  newest before the message `before` names. */
  page(a: string, b: string, opts?: { limit?: number; before?: string }): DirectMessagePage;
}

const pairOf = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

const toDirect = (m: PrivateMessage): DirectMessage => ({
  id: m.id,
  author: m.author,
  // The pair is stored sorted, so the side that did not write it is `to`.
  to: m.author.id === m.personId ? m.agentId : m.personId,
  text: m.text,
  ts: m.ts,
});

export class FileDirectMessageStore implements DirectMessageStore {
  private readonly logs: FilePrivateMessageStore;

  constructor(dataDir: string, now: () => number = Date.now) {
    this.logs = new FilePrivateMessageStore(dataDir, now, 'direct-messages');
  }

  append(author: { id: string; name: string }, to: string, text: string): DirectMessage {
    if (author.id === to) throw new Error('direct-messages: a pair is two people');
    const [first, second] = pairOf(author.id, to);
    return toDirect(
      this.logs.append({ personId: first, agentId: second, from: 'person', author, text }),
    );
  }

  page(a: string, b: string, opts: { limit?: number; before?: string } = {}): DirectMessagePage {
    const [first, second] = pairOf(a, b);
    const page = this.logs.page(first, second, opts);
    return { messages: page.messages.map(toDirect), more: page.more };
  }
}
