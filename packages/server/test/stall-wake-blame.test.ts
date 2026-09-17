/**
 * Two ways a stall wake lied to the reader, and what it says now.
 *
 * On 2026-09-16 two peers, within an hour and on three different boards,
 * reported the same frame: a body reading "the board reported a stall with no
 * tasks on it — treat this as a bug in the wake, not as a clear board", and a
 * `task_id` that no task lookup resolved. One of those boards held 85 rows.
 *
 *  1. The ANCHOR. `stall-nudge.ts` picks the frame's opening row from seven
 *     lists, and two of them name a DOC — an unanswered question on a doc
 *     thread always does, a held review item filed on a doc thread does when
 *     no ticket holds it. Both went out in a field called `taskId`.
 *  2. The BLAME. `stalledLine` builds the body from the lists this bundle
 *     knows. A frame whose only non-empty list is one the bundle has never
 *     heard of renders nothing, and the fallback accused the server of a bug
 *     in the wake — when the reader's own plugin was the older half. Every
 *     new finding kind the server learns re-creates that for every session
 *     still on an older bundle, which is why `askedBack` produced it before
 *     `unanswered` existed.
 *
 * Both are driven through the real `StallNudger` and the real renderer. Every
 * fixture is invented; the repo is public.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type StallPayload, stalledLine } from '../../mcp/src/nudge-line.ts';
import { channelForWatchKey, openAgentMuxStream } from '../src/sse-mux.ts';
import { SseBus } from '../src/sse.ts';
import type { AskedBackRow, HeldItemRow, StalledRow } from '../src/stall-gate.ts';
import {
  STALL_EVENT,
  type StallNudgeFrame,
  StallNudger,
  type StallSnapshot,
} from '../src/stall-nudge.ts';
import type { UnansweredThreadRow } from '../src/unanswered-thread.ts';

const MIN = 60_000;
const NOW = 2_000_000;

/** One board, with nothing on it — each case adds the one finding it is
 *  about, so what anchors the frame is never in doubt. */
function board(over: Partial<StallSnapshot> = {}): StallSnapshot {
  return {
    workspaceId: 'w-riverbend',
    leadAgentId: 'agent-uploader',
    retired: false,
    stalled: [],
    unfiled: [],
    considered: 3,
    undetermined: [],
    ...over,
  };
}

/** A stamp file per run. The arming memory is keyed on the workspace id and
 *  survives on disk, so two cases over the same board sharing one file would
 *  make the second one's silence a fixture artefact rather than a finding. */
const stampDir = mkdtempSync(join(tmpdir(), 'stall-wake-blame-'));
let stampSeq = 0;
afterAll(() => rmSync(stampDir, { recursive: true, force: true }));

/** The real nudger, wired the way `server.ts` wires it, over one board. */
function runOver(snapshot: StallSnapshot): StallNudgeFrame[] {
  const sent: StallNudgeFrame[] = [];
  const nudger = new StallNudger({
    now: () => NOW,
    snapshot: () => [snapshot],
    canReach: (_ws, agentId) => agentId === 'agent-uploader',
    attachedAgents: () => ['agent-uploader'],
    send: (_ws, _agentId, frame) => {
      sent.push(frame);
      return 1;
    },
    sendToFiler: () => 1,
    report: () => {},
    stampFile: join(stampDir, `stamps-${(stampSeq += 1)}.json`),
  });
  nudger.tick();
  return sent;
}

const STALLED_ROW: StalledRow = {
  id: 't-saltmarsh',
  title: 'Rank the digest by recency',
  bucket: 'in-progress',
  quietMs: 90 * MIN,
};

const ASKED_BACK_ROW: AskedBackRow = {
  id: 't-uploader',
  title: 'Retire the second uploader',
  reviewItemId: 'ri-1',
  headline: 'Which uploader stays?',
  askedBy: 'Riverbend',
  askedAt: NOW - 120 * MIN,
  askedMs: 120 * MIN,
  revise: 'revise_review_item(taskId: "t-uploader", reviewItemId: "ri-1", …)',
};

/** A question a person asked on a doc thread. `id` IS the doc's — see
 *  `UnansweredThreadInput`. */
const UNANSWERED_ROW: UnansweredThreadRow = {
  id: 'd-notes',
  docId: 'd-notes',
  threadId: 'th-1',
  title: 'Riverbend rollout notes',
  commentId: 'c-1',
  askedBy: 'Riverbend',
  askedAt: NOW - 30 * 60 * MIN,
  latestAt: NOW - 30 * 60 * MIN,
  askedMs: 30 * 60 * MIN,
  excerpt: 'Does the second pass still read the whole index?',
  reply: 'post_reply(docId: "d-notes", threadId: "th-1", …)',
};

/** A held review item filed on a plain doc thread — no ticket holds it, so
 *  `overdueHeldItems` puts the DOC's id in `id`. */
const HELD_ON_DOC: HeldItemRow = {
  id: 'd-spec',
  docId: 'd-spec',
  threadId: 'th-2',
  commentId: 'c-2',
  title: 'Harborlight ingest spec',
  reviewItemId: 'c-2',
  headline: 'ok?',
  reason: 'The headline is not a question the reader can answer.',
  heldMs: 40 * MIN,
  heldAt: NOW - 40 * MIN,
  filedBy: 'Saltmarsh',
};

/** The same hold, filed on a ticket. The control for the one above. */
const HELD_ON_TASK: HeldItemRow = {
  ...HELD_ON_DOC,
  id: 't-uploader',
  taskId: 't-uploader',
  docId: undefined,
  title: 'Retire the second uploader',
};

describe('the frame anchors on an id the reader can open', () => {
  it('puts a doc-anchored finding in docId, and nothing in taskId', () => {
    const [frame] = runOver(board({ unanswered: [UNANSWERED_ROW] }));
    expect(frame?.event).toBe(STALL_EVENT);
    expect(frame?.docId).toBe('d-notes');
    expect(frame?.taskId).toBeUndefined();
    expect(frame?.title).toBe('Riverbend rollout notes');
  });

  it('CONTROL: a board with a stalled task still anchors on that task', () => {
    const [frame] = runOver(board({ stalled: [STALLED_ROW] }));
    expect(frame?.taskId).toBe('t-saltmarsh');
    expect(frame?.docId).toBeUndefined();
    expect(frame?.title).toBe('Rank the digest by recency');
  });

  it('reads a held item’s kind off the row: a doc-filed hold is a doc anchor', () => {
    const [frame] = runOver(board({ held: [HELD_ON_DOC] }));
    expect(frame?.docId).toBe('d-spec');
    expect(frame?.taskId).toBeUndefined();
  });

  it('CONTROL: the same hold filed on a ticket anchors on the ticket', () => {
    const [frame] = runOver(board({ held: [HELD_ON_TASK] }));
    expect(frame?.taskId).toBe('t-uploader');
    expect(frame?.docId).toBeUndefined();
  });

  it('prefers a stalled task over a doc finding, as it always did', () => {
    const [frame] = runOver(board({ stalled: [STALLED_ROW], unanswered: [UNANSWERED_ROW] }));
    expect(frame?.taskId).toBe('t-saltmarsh');
    expect(frame?.docId).toBeUndefined();
  });

  it('a held row naming NEITHER id space anchors nothing, and the next list is asked', () => {
    // `overdueHeldItems` drops such a row before the wake sees it, so this is
    // a hand-built state. It is here because the branch is: the alternative
    // to falling through is guessing a kind, which is the defect itself.
    const [frame] = runOver(
      board({
        held: [{ ...HELD_ON_DOC, id: 'x-unknown', docId: undefined }],
        askedBack: [ASKED_BACK_ROW],
      }),
    );
    expect(frame?.taskId).toBe('t-uploader');
    expect(frame?.docId).toBeUndefined();
  });

  it('an asked-back item is a TICKET anchor — the list order is unchanged', () => {
    const [frame] = runOver(board({ askedBack: [ASKED_BACK_ROW], unanswered: [UNANSWERED_ROW] }));
    expect(frame?.taskId).toBe('t-uploader');
    expect(frame?.docId).toBeUndefined();
  });
});

describe('a board with no open work never reaches the wake at all', () => {
  it('sends nothing when every list is empty — the guard returns first', () => {
    expect(runOver(board({ considered: 0 }))).toHaveLength(0);
  });

  it('sends nothing for a board whose rows were all examined and none stalled', () => {
    expect(runOver(board({ considered: 9 }))).toHaveLength(0);
  });

  it('CONTROL: the same board with one stalled row does send a frame', () => {
    expect(runOver(board({ considered: 9, stalled: [STALLED_ROW] }))).toHaveLength(1);
  });
});

describe('a frame this bundle cannot read blames the bundle, not the wake', () => {
  /** A frame from a server that has learned a finding kind this bundle has
   *  never heard of: the envelope, the denominator, and one unknown list. */
  const futureFrame = (): StallPayload =>
    ({
      event: STALL_EVENT,
      workspaceId: 'w-riverbend',
      docId: 'd-notes',
      title: 'Riverbend rollout notes',
      stalledCount: 0,
      consideredCount: 12,
      ts: NOW,
      unreviewedRelease: [{ id: 't-saltmarsh', title: 'Rank the digest by recency' }],
    }) as unknown as StallPayload;

  it('names the unreadable key and says the plugin is the older half', () => {
    const line = stalledLine(futureFrame());
    expect(line).toContain('unreviewedRelease');
    expect(line).toContain('OLDER than this server');
    expect(line).toContain('claude plugin update claude-workspaces@claude-workspaces');
  });

  it('stays loud: the board is not to be read as clear', () => {
    expect(stalledLine(futureFrame())).toContain('The board is NOT clear');
  });

  it('no longer blames the wake for a frame it simply cannot read', () => {
    expect(stalledLine(futureFrame())).not.toContain('a bug in the wake');
  });

  it('CONTROL: a frame that really does carry nothing still blames the wake', () => {
    const empty = {
      event: STALL_EVENT,
      workspaceId: 'w-riverbend',
      stalledCount: 0,
      consideredCount: 12,
      ts: NOW,
    } as StallPayload;
    const line = stalledLine(empty);
    expect(line).toContain('a bug in the wake');
    expect(line).not.toContain('OLDER than this server');
  });

  it('CONTROL: an unknown key carrying NOTHING is not version skew', () => {
    const line = stalledLine({
      event: STALL_EVENT,
      workspaceId: 'w-riverbend',
      stalledCount: 0,
      consideredCount: 12,
      ts: NOW,
      unreviewedRelease: [],
      releaseGateOff: false,
    } as unknown as StallPayload);
    expect(line).toContain('a bug in the wake');
    expect(line).not.toContain('unreviewedRelease');
  });

  it('says so as a caveat when it CAN read some of the frame', () => {
    const mixed = {
      event: STALL_EVENT,
      workspaceId: 'w-riverbend',
      taskId: 't-saltmarsh',
      title: 'Rank the digest by recency',
      stalledCount: 1,
      consideredCount: 12,
      rows: [STALLED_ROW],
      ts: NOW,
      unreviewedRelease: [{ id: 't-uploader' }],
    } as unknown as StallPayload;
    const line = stalledLine(mixed);
    expect(line).toContain('Rank the digest by recency');
    expect(line).toContain('This frame ALSO carried unreviewedRelease');
    expect(line).not.toContain('a bug in the wake');
  });

  it('CRY-WOLF CONTROL: a real frame from the real nudger says none of this', () => {
    const [frame] = runOver(
      board({
        considered: 9,
        stalled: [STALLED_ROW],
        unfiled: [{ ...STALLED_ROW, id: 't-unfiled', bucket: 'waiting-unfiled' }],
        undetermined: [{ id: 't-unread', reason: 'review-items-unreadable' }],
        held: [HELD_ON_TASK],
        askedBack: [ASKED_BACK_ROW],
        unanswered: [UNANSWERED_ROW],
        checkIn: [STALLED_ROW],
        beyondCapacity: 2,
        declaredWaits: [
          {
            id: 't-saltmarsh',
            title: 'Rank the digest by recency',
            what: 'a key from Harborlight',
            since: NOW - 60 * MIN,
            until: NOW + 60 * MIN,
            by: 'Saltmarsh',
          },
        ],
      }),
    );
    expect(frame).toBeDefined();
    const line = stalledLine(frame as unknown as StallPayload);
    expect(line).not.toContain('cannot read');
    expect(line).not.toContain('This frame ALSO carried');
    expect(line).not.toContain('a bug in the wake');
  });

  /**
   * The control above renders the nudger's own object. That is NOT what a
   * session receives: `sse-mux.ts` spreads the frame and stamps `watchKey`
   * into every multiplexed frame, and the mux is the path the plugin uses. A
   * first draft of this change omitted that key from the known set, so every
   * ordinary stall wake would have told its reader to update the plugin. So
   * this case takes the frame off a real mux stream and renders THAT.
   */
  it('CRY-WOLF CONTROL, ON THE WIRE: a frame off a real mux stream says none of this', async () => {
    const [frame] = runOver(board({ considered: 9, stalled: [STALLED_ROW] }));
    expect(frame).toBeDefined();
    const bus = new SseBus();
    const key = `ws:${frame?.workspaceId}`;
    const res = openAgentMuxStream({
      bus,
      agentId: 'agent-harborlight',
      keys: () => [key],
      channelFor: (k) => channelForWatchKey(k, (id) => id),
      // A 15s interval would hold the test process open for 15s.
      keepaliveMs: 60_000,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      bus.sendToAgent(
        channelForWatchKey(key, (id) => id),
        'agent-harborlight',
        frame as unknown as Parameters<SseBus['sendToAgent']>[2],
      );
      let buf = '';
      let delivered: Record<string, unknown> | undefined;
      // Poll the reader until the stall frame shows up rather than waiting a
      // fixed span: the keepalive comment and the frame arrive in any order.
      while (delivered === undefined) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0 && delivered === undefined) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          for (const line of raw.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const parsed = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
            if (parsed.event === STALL_EVENT) delivered = parsed;
          }
        }
      }
      expect(delivered).toBeDefined();
      // The stamping really happened — without this the case would pass on a
      // mux that had stopped tagging, proving nothing about the known set.
      expect(delivered?.watchKey).toBe(key);
      const line = stalledLine(delivered as unknown as StallPayload);
      expect(line).toContain('Rank the digest by recency');
      expect(line).not.toContain('cannot read');
      expect(line).not.toContain('This frame ALSO carried');
      expect(line).not.toContain('a bug in the wake');
    } finally {
      await reader.cancel();
    }
  });
});
