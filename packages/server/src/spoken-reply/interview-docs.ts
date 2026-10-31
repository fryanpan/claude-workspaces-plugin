/**
 * The doc store and the board, narrowed to what an interview may do: check a
 * doc is on the board, read its outline, append under one heading, put the
 * agent's cursor on the words it is asking about, replace one block (a
 * revised goal, `interview-goals.ts`), and, in a planning
 * meeting, hold the notes' copy of an answer (`meeting-ears.ts`).
 *
 * The write is `applyBlockEdits` with `insert_under_heading` — the verb
 * `insert_blocks_under_heading` reaches over HTTP — under an author id of its
 * own, so a later agent edit that names one of these blocks is handled by the
 * same ownership rules as any other agent's block.
 */
import type { prose } from '@claude-workspaces/core';
import { AGENT_FOCUS_FIELD, type AgentFocus } from '@claude-workspaces/core/spoken-reply';
import type { Awareness } from 'y-protocols/awareness';
import type { AgentSpots } from '../agent-spots.ts';
import type { BlockEditsAuthor, BlockEditsResult, DocOutline } from '../doc-outline-ops.ts';
import type { InterviewDocs, InterviewWrite } from './interview-types.ts';
import type { MeetingEars } from './meeting-ears.ts';

export const INTERVIEW_AUTHOR: BlockEditsAuthor = {
  author: 'voice-interview',
  authorName: 'Interview',
  authorColor: '#2e7dd7',
};

/**
 * The planning voice's id in the workspace's presence room. Its cursor is
 * where it points, so it is that agent's spot there too (`agent-spots.ts`).
 */
export const PLANNING_VOICE_ID = INTERVIEW_AUTHOR.author;

/** Where the voice's cursor went, for its boards' presence rooms; null when
 *  it came off the doc. */
export type VoicePointed = (docId: string, at: { blockId: string; quote: string } | null) => void;

/**
 * The voice's cursor as its spot: on the doc while it asks, gone when it
 * stops. `held`, because the voice holds no event stream of its own — its
 * spot is present exactly while its cursor is.
 */
export function voicePointer(spots: Pick<AgentSpots, 'point'>): VoicePointed {
  return (docId, at) =>
    spots.point(
      docId,
      PLANNING_VOICE_ID,
      at ? { surface: 'doc', docId, ...at, name: 'Claude' } : null,
      { held: true },
    );
}

export interface InterviewDocStore {
  readOutline(docId: string): DocOutline | null;
  /** The live doc, when it is in memory; its presence is what pages read. */
  get(docId: string): { awareness: Awareness } | undefined;
  applyBlockEdits(docId: string, edits: prose.BlockEdit[], who: BlockEditsAuthor): BlockEditsResult;
}

export function interviewDocs(
  docStore: InterviewDocStore,
  /** The board's doc ids — `taskStore.getWorkspace(ws)?.docIds`. */
  boardDocIds: (workspaceId: string) => readonly string[] | undefined,
  /** Where a planning meeting's notes are held while a question is out. */
  ears?: MeetingEars,
  /** An answer was written under `headingId`: the section now talked about
   *  (`plan-minutes.ts`). */
  wrote?: (docId: string, headingId: string) => void,
  /** The cursor moved: the voice's spot in the presence room. */
  pointed?: VoicePointed,
): InterviewDocs {
  // A page scrolls once per `seq` and keeps the last one it scrolled for
  // across a server restart, so the count starts at the clock: a restarted
  // server's first question never repeats a number a page already holds.
  let seq = Date.now();
  const write = (docId: string, edit: prose.BlockEdit): InterviewWrite => {
    const res = docStore.applyBlockEdits(docId, [edit], INTERVIEW_AUTHOR);
    if (!res.ok) return res.error === 'not-found' ? 'gone' : 'failed';
    const outcome = res.outcomes[0];
    if (outcome?.status === 'applied' || outcome?.status === 'suggested') return 'written';
    return outcome?.error === 'unknown-block' || outcome?.error === 'not-a-heading'
      ? 'gone'
      : 'failed';
  };
  return {
    ...(ears
      ? {
          hold: (docId: string) => ears.hold(docId),
          placed: (docId: string, written: string) => ears.placed(docId, written),
          release: (docId: string) => ears.release(docId),
        }
      : {}),
    onBoard: (workspaceId, docId) => boardDocIds(workspaceId)?.includes(docId) === true,
    outline: (docId) => docStore.readOutline(docId)?.blocks ?? null,
    writeUnder: (docId, headingId, markdown): InterviewWrite => {
      const res = write(docId, { op: 'insert_under_heading', headingId, markdown });
      if (res === 'written') wrote?.(docId, headingId);
      return res;
    },
    replaceBlock: (docId, blockId, markdown) =>
      write(docId, { op: 'replace_block', blockId, markdown }),
    focus: (docId, at) => {
      pointed?.(docId, at ? { blockId: at.blockId, quote: at.quote } : null);
      const live = docStore.get(docId);
      if (!live) return;
      const state: AgentFocus | null = at
        ? {
            ...at,
            name: 'Claude',
            color: INTERVIEW_AUTHOR.authorColor ?? '#2e7dd7',
            seq: ++seq,
          }
        : null;
      live.awareness.setLocalStateField(AGENT_FOCUS_FIELD, state);
    },
  };
}
