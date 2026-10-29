/**
 * The frames that tell an open page one of its REST-fed lists is stale.
 *
 * Six lists were read once, or every 30s, and so showed a change made in
 * another tab or by an agent late or never: a board's Library, its members,
 * a review's file list and tree (the doc page's sidebar), the voice page's
 * agents, the prompts settings and the access page. Each now hears one frame on a stream the
 * page already holds, or on the one new stream it opens, and re-reads the
 * list through the same route and gate that served it the first time.
 *
 * A frame names the list and nothing else — no doc, member, title or prompt —
 * so it can reach any page on the channel without saying more than that page
 * may read. Every frame is transient (no replay buffer, no `id:`), because a
 * page that reconnects re-reads its list anyway, and is kept off agent
 * streams: an agent cannot act on "your sidebar is stale", and each frame
 * that reaches one costs a turn. The MCP child also drops them by name
 * (`packages/mcp/src/bookkeeping-events.ts`) for a set channel's stream,
 * which does not carry the agent's id.
 *
 * Bursts coalesce per channel and frame: a diff refresh that writes fifty
 * listing rows sends one frame per open sidebar, not fifty. A bind or refresh
 * that re-scanned a set nudges its sidebar even when no member doc moved,
 * because the "all files" list is a disk scan rather than a listing row.
 */
import type { DocMeta } from '@claude-workspaces/core';
import type { DocIndexEntry } from './doc-index.ts';

/** On `ws~<boardId>`: the board's Library list changed. */
export const LIBRARY_CHANGED = 'library.changed';
/** On `ws~<boardId>`: someone was given access, removed, or changed level. */
export const MEMBERS_CHANGED = 'members.changed';
/** On `ws~<setId>`: a review's file list, tree or badges changed. */
export const ATTACHMENTS_CHANGED = 'attachments.changed';
/** The `/voice` page's channel and frame: an agent or a board it lists changed. */
export const VOICE_CHANNEL = 'voice~';
export const VOICE_CHANGED = 'voice.changed';
/** The prompts settings page's channel and frame. */
export const PROMPTS_CHANNEL = 'prompts~';
export const PROMPTS_CHANGED = 'prompts.changed';
/** The `/access` page's channel and frame: an audience, a member or an
 *  access proposal changed on some board. */
export const ACCESS_CHANNEL = 'access~';
export const ACCESS_CHANGED = 'access.changed';

/** How long a burst gathers before its one frame goes out. */
export const NUDGE_COALESCE_MS = 150;

/** Board events that change who the voice page lists, or under which name. */
const VOICE_EVENTS = new Set([
  'agent.attached',
  'agent.detached',
  'workspace.renamed',
  'workspace.retired_changed',
  'workspace.lead_changed',
]);

export interface PageNudger {
  /** Send `event` on `channel` once the current burst settles. */
  nudge(channel: string, event: string): void;
  dispose(): void;
}

export function createPageNudger(opts: {
  send: (channel: string, frame: { event: string }) => void;
  coalesceMs?: number;
}): PageNudger {
  const coalesceMs = opts.coalesceMs ?? NUDGE_COALESCE_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    nudge(channel, event) {
      const key = `${channel}\u0000${event}`;
      if (timers.has(key)) return;
      const timer = setTimeout(() => {
        timers.delete(key);
        opts.send(channel, { event });
      }, coalesceMs);
      (timer as { unref?: () => void }).unref?.();
      timers.set(key, timer);
    },
    dispose() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}

/** What a listing draws from one row: a change anywhere else is not news. */
function listedFace(entry: DocIndexEntry | undefined): string {
  if (!entry) return '';
  const m = entry.meta;
  return JSON.stringify([
    m.title,
    m.type,
    m.sourceUrl,
    m.setId,
    m.workspaceId,
    m.relPath,
    m.stale,
    m.workspaceGroups,
    m.diffStatus,
    m.diffAdditions,
    m.diffDeletions,
    entry.threads.open,
    entry.threads.total,
  ]);
}

/** Whether a listing row moved in a way some page draws. */
export function listingChanged(
  prev: DocIndexEntry | undefined,
  next: DocIndexEntry | undefined,
): boolean {
  return listedFace(prev) !== listedFace(next);
}

/** The review sets a row belongs to, before and after. */
export function setsOf(
  ...metas: Array<Pick<DocMeta, 'setId' | 'workspaceId'> | undefined>
): string[] {
  const out = new Set<string>();
  for (const m of metas) {
    if (m?.workspaceId) out.add(m.workspaceId);
    if (m?.setId) out.add(m.setId);
  }
  return [...out];
}

/** The boards whose member list differs between two readings. */
export function boardsWithChangedMembers(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  for (const [ws, face] of after) if (before.get(ws) !== face) out.push(ws);
  for (const ws of before.keys()) if (!after.has(ws)) out.push(ws);
  return out;
}

/** Each board's members as one comparable string. */
export function memberFaces(
  members: ReadonlyArray<{ workspaceId: string; email: string; role?: string }>,
): Map<string, string> {
  const rows = new Map<string, string[]>();
  for (const m of members) {
    const list = rows.get(m.workspaceId) ?? [];
    list.push(`${m.email}:${m.role ?? 'member'}`);
    rows.set(m.workspaceId, list);
  }
  return new Map([...rows].map(([ws, list]) => [ws, list.sort().join(',')]));
}

export interface PageNudgeDeps {
  nudger: PageNudger;
  /** Hook slots on the stores, chained so an earlier tenant keeps working. */
  docStore: {
    onIndexChanged?: (
      docId: string,
      prev: DocIndexEntry | undefined,
      next: DocIndexEntry | undefined,
    ) => void;
    onSetRescanned?: (setId: string) => void;
  };
  taskStore: { onBoardDocsChanged: ((workspaceId: string) => void) | null };
  /** The boards whose Library lists this doc. */
  boardsHolding: (docId: string) => readonly string[];
  shareLinks: {
    onSaved: (() => void) | null;
    allMembers: () => ReadonlyArray<{ workspaceId: string; email: string; role?: string }>;
  };
  sse: {
    tap: (fn: (channel: string, event: string) => void) => () => void;
    onAgentStreams: ((channel: string, agentId: string) => void) | null;
  };
}

/** Wire every hook above; returns what tells the prompts and access pages,
 *  and an undo. */
export function wirePageNudges(deps: PageNudgeDeps): {
  promptsChanged: () => void;
  accessChanged: () => void;
  dispose: () => void;
} {
  const { nudger, docStore, taskStore, boardsHolding, shareLinks, sse } = deps;
  const board = (ws: string) => `ws~${ws}`;

  const onIndex = docStore.onIndexChanged;
  docStore.onIndexChanged = (docId, prev, next) => {
    onIndex?.(docId, prev, next);
    if (!listingChanged(prev, next)) return;
    for (const set of setsOf(prev?.meta, next?.meta)) nudger.nudge(board(set), ATTACHMENTS_CHANGED);
    for (const ws of boardsHolding(docId)) nudger.nudge(board(ws), LIBRARY_CHANGED);
  };

  const onRescan = docStore.onSetRescanned;
  docStore.onSetRescanned = (setId) => {
    onRescan?.(setId);
    nudger.nudge(board(setId), ATTACHMENTS_CHANGED);
  };

  const onDocs = taskStore.onBoardDocsChanged;
  taskStore.onBoardDocsChanged = (ws) => {
    onDocs?.(ws);
    nudger.nudge(board(ws), LIBRARY_CHANGED);
  };

  let faces = memberFaces(shareLinks.allMembers());
  const onSaved = shareLinks.onSaved;
  shareLinks.onSaved = () => {
    onSaved?.();
    // Every save: an audience entry is written here too, and the access page
    // lists entries nobody has signed in under yet.
    nudger.nudge(ACCESS_CHANNEL, ACCESS_CHANGED);
    const next = memberFaces(shareLinks.allMembers());
    for (const ws of boardsWithChangedMembers(faces, next)) {
      nudger.nudge(board(ws), MEMBERS_CHANGED);
    }
    faces = next;
  };

  const untap = sse.tap((channel, event) => {
    if (channel.startsWith('ws~') && VOICE_EVENTS.has(event)) {
      nudger.nudge(VOICE_CHANNEL, VOICE_CHANGED);
    }
    // A withdrawn proposal leaves the access page's queue.
    if (channel.startsWith('ws~') && event === 'review_item.withdrawn') {
      nudger.nudge(ACCESS_CHANNEL, ACCESS_CHANGED);
    }
  });
  const onAgentStreams = sse.onAgentStreams;
  sse.onAgentStreams = (channel, agentId) => {
    onAgentStreams?.(channel, agentId);
    if (channel.startsWith('ws~')) nudger.nudge(VOICE_CHANNEL, VOICE_CHANGED);
  };

  return {
    promptsChanged: () => nudger.nudge(PROMPTS_CHANNEL, PROMPTS_CHANGED),
    accessChanged: () => nudger.nudge(ACCESS_CHANNEL, ACCESS_CHANGED),
    dispose: () => {
      untap();
      nudger.dispose();
    },
  };
}
