import { randomUUID } from 'node:crypto';
import { type User, contentKind, prose } from '@claude-workspaces/core';
import type * as Y from 'yjs';
import { type Event, buildEventDoc, eventId, payloadDigest, toUtcIso } from './activity.ts';
import { type ActorKind, isOwnerActor } from './actor-identity.ts';
import type { FeedbackWs, LiveDoc } from './doc-store.ts';
import { type EventDevice, currentEventOrigin, inOpenRequest } from './event-origin.ts';
import { announcedNameOf } from './yjs-protocol.ts';

/**
 * Who edited a doc's body, for how long and by how much — the `edit_session`
 * row in `activity.jsonl`.
 *
 * Detected on the server, from the transaction that changed the doc, so no
 * client has to report it. Every edit reaches a live doc through one of two
 * doors, and the transaction's origin says which:
 *
 *  - the CONNECTION OBJECT of one of the doc's websockets: a person typing in
 *    the browser editor. The socket was stamped at its upgrade with the
 *    identity the request proved (`WsCtx.editor`), and the name its
 *    presence announces is the fallback when it proved none — the same trust
 *    `read_session` gives the author a browser names in its POST.
 *  - an `agent…` string inside a request that is still being answered, and
 *    that did not come from a browser: an agent's MCP or REST edit tool.
 *    Recorded as `source: 'mcp'`, `actor: 'agent'`, in a session of its own,
 *    so an agent's edits can never be added to a person's editing time.
 *
 * Everything else is unrecorded: the server's own housekeeping (re-anchors,
 * meta writes, undefined origins), and the meeting assistant, which stamps
 * `agent` too but writes from a socket or a timer rather than a request.
 *
 * Edits coalesce per (doc, author) into one session that closes after
 * `idleMs` without an edit, so a row is a sitting rather than a keystroke.
 * A session still open after `maxSessionMs` closes and a new one starts, so
 * a long sitting reaches the log while it is still going and a crash loses
 * at most that much.
 *
 * The row carries counts and times only. Nothing here reads what was typed.
 */

/** Quiet time that closes a session. */
export const EDIT_SESSION_IDLE_MS = 60_000;

/** Longest one session may run before it is written and a new one begins.
 *  The same cap `MAX_READ_SESSION_MS` puts on a reading session. */
export const MAX_EDIT_SESSION_MS = 20 * 60_000;

/** Who one run of edits belongs to. `key` keeps two authors on a doc apart. */
export interface EditAuthor {
  source: 'editor' | 'mcp';
  actor: ActorKind;
  actorId?: string;
  actorName?: string;
  isOwner: boolean;
  device?: EventDevice;
  key: string;
}

/** What the upgrade learned about the browser behind an editing socket. */
export interface SocketEditor {
  /** The identity the upgrade request proved, if it proved one. */
  user?: User;
  device?: EventDevice;
}

/** What one transaction changed, in counts. */
export interface EditStats {
  charsInserted: number;
  charsDeleted: number;
  /** The top-level blocks it changed, or null for a doc without blocks. */
  blocks: readonly object[] | null;
}

export interface ClosedEditSession {
  docId: string;
  sessionId: string;
  author: EditAuthor;
  startMs: number;
  endMs: number;
  editCount: number;
  charsInserted: number;
  charsDeleted: number;
  blocksTouched?: number;
}

interface OpenSession {
  docId: string;
  sessionId: string;
  author: EditAuthor;
  startMs: number;
  endMs: number;
  editCount: number;
  charsInserted: number;
  charsDeleted: number;
  blocks: Set<object> | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface EditSessionTrackerOptions {
  /** Called once per closed session. */
  emit: (session: ClosedEditSession) => void;
  idleMs?: number;
  maxSessionMs?: number;
}

export class EditSessionTracker {
  private readonly open = new Map<string, OpenSession>();
  private readonly idleMs: number;
  private readonly maxSessionMs: number;

  constructor(private readonly opts: EditSessionTrackerOptions) {
    this.idleMs = opts.idleMs ?? EDIT_SESSION_IDLE_MS;
    this.maxSessionMs = opts.maxSessionMs ?? MAX_EDIT_SESSION_MS;
  }

  /** Fold one edit into its author's open session on this doc. */
  note(docId: string, author: EditAuthor, stats: EditStats): void {
    const at = Date.now();
    const key = `${docId}\0${author.source}\0${author.key}`;
    let session = this.open.get(key);
    if (session && at - session.startMs >= this.maxSessionMs) {
      this.close(key);
      session = undefined;
    }
    if (!session) {
      session = {
        docId,
        sessionId: randomUUID(),
        author,
        startMs: at,
        endMs: at,
        editCount: 0,
        charsInserted: 0,
        charsDeleted: 0,
        blocks: stats.blocks === null ? null : new Set(),
        timer: null,
      };
      this.open.set(key, session);
    }
    session.endMs = at;
    session.editCount++;
    session.charsInserted += stats.charsInserted;
    session.charsDeleted += stats.charsDeleted;
    if (session.blocks && stats.blocks) for (const b of stats.blocks) session.blocks.add(b);
    // One timer per session, re-armed for the remainder when it fires early,
    // rather than a clearTimeout / setTimeout pair on every keystroke.
    if (!session.timer) this.arm(key, session, this.idleMs);
  }

  /** Write every open session on one doc now — it is leaving memory. */
  closeDoc(docId: string): void {
    for (const [key, session] of this.open) if (session.docId === docId) this.close(key);
  }

  /** Write every open session now — the server is stopping. */
  closeAll(): void {
    for (const key of [...this.open.keys()]) this.close(key);
  }

  /** How many sessions are open. */
  openCount(): number {
    return this.open.size;
  }

  private arm(key: string, session: OpenSession, delay: number): void {
    session.timer = setTimeout(() => {
      session.timer = null;
      const quiet = Date.now() - session.endMs;
      if (quiet >= this.idleMs) this.close(key);
      else this.arm(key, session, this.idleMs - quiet);
    }, delay);
    session.timer.unref?.();
  }

  private close(key: string): void {
    const session = this.open.get(key);
    if (!session) return;
    this.open.delete(key);
    if (session.timer) clearTimeout(session.timer);
    try {
      this.opts.emit({
        docId: session.docId,
        sessionId: session.sessionId,
        author: session.author,
        startMs: session.startMs,
        endMs: session.endMs,
        editCount: session.editCount,
        charsInserted: session.charsInserted,
        charsDeleted: session.charsDeleted,
        ...(session.blocks ? { blocksTouched: session.blocks.size } : {}),
      });
    } catch (err) {
      console.error('[edit-sessions] emit failed:', err);
    }
  }
}

/** A doc body's root type. */
type Body = Y.XmlFragment | Y.Text;

/** Any shared type, read only for the parent chain `blockOf` walks. */
type Nested = { _item: Y.Item | null };

/** The shared type a doc's body lives in: the prose fragment, or the flat
 *  `content` text of a code or diff doc. */
function bodyOf(doc: LiveDoc): Body {
  return contentKind(doc.meta.type) === 'flat'
    ? doc.ydoc.getText('content')
    : prose.getProseFragment(doc.ydoc);
}

/** The top-level block of `root` that `type` sits in, or null. */
function blockOf(type: Nested, root: Body): object | null {
  let current: Nested = type;
  for (;;) {
    const parent = current._item?.parent;
    if (!parent || typeof parent !== 'object' || !('_item' in parent)) return null;
    if (parent === root) return current;
    current = parent as Nested;
  }
}

/**
 * What a transaction changed in a doc's body, or null when it left the body
 * alone. Counts come from the transaction's own bookkeeping — the state
 * vector's advance and the delete set — so nothing decodes an update and
 * nothing reads the inserted text.
 */
export function editStatsOf(tr: Y.Transaction, root: Body, withBlocks: boolean): EditStats | null {
  // Widened for the lookup: Yjs keys these maps on its own base type, which
  // the two concrete body types do not assign to under strict variance.
  const changed: ReadonlyMap<unknown, unknown> = tr.changed;
  const changedParents: ReadonlyMap<unknown, unknown> = tr.changedParentTypes;
  if (!changed.has(root) && !changedParents.has(root)) return null;
  let charsInserted = 0;
  for (const [client, after] of tr.afterState) {
    charsInserted += after - (tr.beforeState.get(client) ?? 0);
  }
  let charsDeleted = 0;
  for (const items of tr.deleteSet.clients.values())
    for (const item of items) charsDeleted += item.len;
  if (!withBlocks) return { charsInserted, charsDeleted, blocks: null };
  const blocks: object[] = [];
  for (const type of tr.changed.keys()) {
    const block = blockOf(type, root);
    if (block) blocks.push(block);
  }
  return { charsInserted, charsDeleted, blocks };
}

const connIds = new WeakMap<FeedbackWs, number>();
let nextConnId = 1;

/** A stable per-connection key for a socket that proved nobody and named nobody. */
function connKey(ws: FeedbackWs): string {
  let id = connIds.get(ws);
  if (id === undefined) {
    id = nextConnId++;
    connIds.set(ws, id);
  }
  return `conn:${id}`;
}

/** Origins the server stamps for its own writes. Agent-shaped, not an agent. */
const HOUSEKEEPING_ORIGINS = new Set(['agent-reanchor']);

/** Who made the edit this transaction origin names, or null if nobody we record. */
export function editAuthorOf(doc: LiveDoc, origin: unknown): EditAuthor | null {
  if (typeof origin === 'object' && origin !== null) {
    const ws = origin as FeedbackWs;
    if (!doc.conns.has(ws)) return null;
    const editor = ws.data.editor;
    const device = editor?.device;
    const user = editor?.user;
    if (user) {
      return {
        source: 'editor',
        actor: 'person',
        actorId: user.id,
        actorName: user.name,
        isOwner: isOwnerActor(user),
        ...(device ? { device } : {}),
        key: `id:${user.id}`,
      };
    }
    const name = announcedNameOf(doc, ws);
    return {
      source: 'editor',
      actor: 'person',
      ...(name ? { actorName: name } : {}),
      // A name the page announced is not an account, so it is never the owner.
      isOwner: false,
      ...(device ? { device } : {}),
      key: name ? `name:${name}` : connKey(ws),
    };
  }
  if (
    typeof origin === 'string' &&
    origin.startsWith('agent') &&
    !HOUSEKEEPING_ORIGINS.has(origin)
  ) {
    // A browser request that writes with an agent origin (accepting a
    // suggestion, say) is a person's click, not an agent's edit: unrecorded
    // rather than filed under the wrong source.
    if (!inOpenRequest() || currentEventOrigin().device) return null;
    return { source: 'mcp', actor: 'agent', isOwner: false, key: 'mcp' };
  }
  return null;
}

/** Feed one transaction on a live doc to the tracker. Never throws. */
export function noteEditTransaction(
  tracker: EditSessionTracker,
  doc: LiveDoc,
  tr: Y.Transaction,
): void {
  try {
    const author = editAuthorOf(doc, tr.origin);
    if (!author) return;
    const flat = contentKind(doc.meta.type) === 'flat';
    const stats = editStatsOf(tr, bodyOf(doc), !flat);
    if (!stats) return;
    tracker.note(doc.docId, author, stats);
  } catch (err) {
    console.error('[edit-sessions] note failed:', err);
  }
}

/** The activity row for one closed session. No text, by construction: the
 *  session never held any. */
export function editSessionEvent(
  session: ClosedEditSession,
  doc: Parameters<typeof buildEventDoc>[0],
): Event {
  const { author } = session;
  const ts = toUtcIso(session.endMs);
  return {
    eventId: eventId({
      ts,
      actor: author.actor,
      docId: session.docId,
      type: 'edit_session',
      threadId: null,
      payloadDigest: payloadDigest(session.sessionId),
    }),
    ts,
    type: 'edit_session',
    actor: author.actor,
    ...(author.actorId ? { actorId: author.actorId } : {}),
    ...(author.actorName ? { actorName: author.actorName } : {}),
    isOwner: author.isOwner,
    doc: buildEventDoc(doc),
    payload: {
      sessionId: session.sessionId,
      source: author.source,
      startTs: toUtcIso(session.startMs),
      endTs: ts,
      durationMs: session.endMs - session.startMs,
      editCount: session.editCount,
      charsInserted: session.charsInserted,
      charsDeleted: session.charsDeleted,
      ...(session.blocksTouched !== undefined ? { blocksTouched: session.blocksTouched } : {}),
    },
    ...(author.device ? { device: author.device } : {}),
  };
}
