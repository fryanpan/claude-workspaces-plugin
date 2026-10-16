/**
 * The planning voice's seams: the doc store as an interview needs it, what
 * it is built with, and what it says back. Shared by the plan interview
 * (`interview.ts`) and the learning-goals one (`interview-goals.ts`).
 */
import type { prose } from '@claude-workspaces/core';
import type { InterviewLog } from './interview-log.ts';
import type { PlanComplete } from './interview-reader.ts';

/** The route word an interview's replies carry. */
export const INTERVIEW_ROUTE = 'interview';
export type InterviewWrite = 'written' | 'gone' | 'failed';

/** The doc store as an interview needs it. */
export interface InterviewDocs {
  /** Whether `docId` is a doc on `workspaceId`. */
  onBoard(workspaceId: string, docId: string): boolean;
  outline(docId: string): readonly prose.OutlineEntry[] | null;
  /** Append `markdown` to the end of the section `headingId` heads. */
  writeUnder(docId: string, headingId: string, markdown: string): InterviewWrite;
  /** Replace block `blockId` with `markdown`. A block somebody else wrote
   *  becomes a proposal, so their words stay readable (`prose-batch.ts`). */
  replaceBlock(docId: string, blockId: string, markdown: string): InterviewWrite;
  /** Put the agent's cursor on `quote` in block `blockId` in every open view
   *  of the doc, or take it off (null). */
  focus(docId: string, at: { blockId: string; quote: string } | null): void;
  /** A question is out on `docId`: hold the meeting notes' copy of what is
   *  said next (`MeetingEars.hold`). The three are absent off a meeting. */
  hold?(docId: string): void;
  /** `written` went into the plan: the notes never get the turns it holds. */
  placed?(docId: string, written: string): void;
  /** No answer was written: the notes get what was held. */
  release?(docId: string): void;
}

export interface SpokenInterviewDeps {
  docs: InterviewDocs;
  log: InterviewLog;
  /** One model call, to choose a question by reading the plan. Absent: the
   *  gap list only. */
  complete?: PlanComplete;
  now?: () => number;
  newId?: () => string;
  /** A meeting's quiet opening (`MEETING_WARMUP_MS`); tests pass 0. */
  warmupMs?: number;
}

/** What an interview says back — the shape `SpokenAnswerer` returns. */
export interface InterviewReply {
  spoken: string;
  detail: string[];
  asking: boolean;
  route: string;
  /** The question still open when `spoken` is not it — a discussion reply
   *  (`interview-discuss.ts`) — so the page keeps showing the question. */
  question?: string;
}
