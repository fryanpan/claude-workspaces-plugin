/**
 * A plan with four gaps in a real `DocStore`, a comment anchored in two of
 * its sections, and an interview wired to it through `SpokenAnswerer` the
 * way `relay.ts` wires one — for the interview tests. The plan's names are
 * the house fixture names; nothing in it is real.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import type { User } from '@claude-workspaces/core';
import type { AgentSpots } from '../src/agent-spots.ts';
import { DocStore } from '../src/doc-store.ts';
import { SpokenAnswerer, type SpokenBoard } from '../src/spoken-reply/answer.ts';
import { interviewDocs, voicePointer } from '../src/spoken-reply/interview-docs.ts';
import { InterviewLog, type InterviewRow } from '../src/spoken-reply/interview-log.ts';
import type { PlanComplete } from '../src/spoken-reply/interview-reader.ts';
import { SpokenInterview } from '../src/spoken-reply/interview.ts';
import type { MeetingEars } from '../src/spoken-reply/meeting-ears.ts';
import { SseBus } from '../src/sse.ts';
import type { VoiceContext } from '../src/voice-prompt.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

export const DOC_ID = 'd-plan';
export const WS = 'w-harbor';

/** Goals is empty, Requirements holds an open question, Design is only a
 *  placeholder and Rollout is two words; Appendix is long enough. */
export const PLAN = `# Harborlight ferry plan

Riverbend wants a second ferry crossing by spring.

## Goals

## Requirements

- Carries twelve cars.
- Who signs off the berth design?

## Design

TBD

## Rollout

Two weeks.

## Appendix

Notes from the Saltmarsh site visit cover the tides, the slipway, the parking and the ticket office in some detail.
`;

export const ON_DOC: VoiceContext = { surface: 'doc', docId: DOC_ID };

const ALICE: User = { id: 'u-alice', name: 'Alice', kind: 'known', color: '#335' };

/** The router, for anything the interview hands back. */
export const ROUTED: SpokenBoard = {
  async handle(_ws, req) {
    return { ok: true, route: 'fast-path', ack: `Routed: ${req.transcript}.` };
  },
  goalStatus: () => undefined,
  goals: () => [],
};

export interface Fixture {
  docStore: DocStore;
  answerer: SpokenAnswerer;
  interview: SpokenInterview;
  rows: InterviewRow[];
  lines: string[];
  /** Move the fake clock on. */
  tick(ms: number): void;
  /** Say something; the reply. */
  say(text: string, context?: VoiceContext): ReturnType<SpokenAnswerer['answer']>;
  /** The heading a block whose text is exactly `text` sits under, or null. */
  headingOf(text: string): string | null;
  /** The words each of the two anchored comments covers now. */
  anchoredText(): string[];
  stop(): void;
}

export async function planFixture(
  opts: {
    markdown?: string;
    onBoard?: boolean;
    /** The model a reading asks; absent, the gap list only. */
    complete?: PlanComplete;
    /** A planning meeting's ears, for the notes hold. */
    ears?: MeetingEars;
    /** Keep the meeting's quiet first minute (`MeetingWarmup`); off, a
     *  meeting's first pause may ask, as every other test here assumes. */
    warmup?: boolean;
    /** The board's presence room; the voice's cursor is its spot there. */
    spots?: AgentSpots;
  } = {},
): Promise<Fixture> {
  const docStore = new DocStore({
    dataDir: mkdtempSync(join(tmpdir(), 'cw-interview-')),
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
  });
  docStore.getOrCreate(DOC_ID, { type: 'markdown' });
  docStore.applyBlockEdits(DOC_ID, [{ op: 'insert_at_end', markdown: opts.markdown ?? PLAN }], {
    author: 'fixture',
  });
  const threads: string[] = [];
  for (const find of ['Carries twelve cars', 'Two weeks']) {
    const t = await docStore.createThreadByFind(DOC_ID, { find }, ALICE, 'Is this right?', {
      generate: false,
    });
    if (t.ok) threads.push(t.thread.id);
  }
  let clock = 1_000_000;
  const rows: InterviewRow[] = [];
  const lines: string[] = [];
  const log = new InterviewLog(undefined, (l) => lines.push(l));
  const realRecord = log.record.bind(log);
  log.record = (row) => {
    rows.push(row);
    realRecord(row);
  };
  const docs = interviewDocs(
    docStore,
    (ws) => (ws === WS && opts.onBoard !== false ? [DOC_ID] : []),
    opts.ears,
    undefined,
    opts.spots ? voicePointer(opts.spots) : undefined,
  );
  const interview = new SpokenInterview(
    {
      docs,
      log,
      now: () => clock,
      newId: () => 'iv-1',
      ...(opts.warmup ? {} : { warmupMs: 0 }),
      ...(opts.complete ? { complete: opts.complete } : {}),
    },
    WS,
  );
  const answerer = new SpokenAnswerer(ROUTED, WS, interview);
  const actor = { id: 'known-alice', name: 'Alice' };
  return {
    docStore,
    answerer,
    interview,
    rows,
    lines,
    tick: (ms) => {
      clock += ms;
    },
    say: (text, context = ON_DOC) => answerer.answer(text, actor, context),
    headingOf: (text) => {
      const blocks = docStore.readOutline(DOC_ID)?.blocks ?? [];
      const b = blocks.find((x) => x.kind !== 'heading' && x.text === text);
      const h = b && blocks.find((x) => x.id === b.underHeadingId);
      return h?.text ?? null;
    },
    anchoredText: () => {
      const live = docStore.get(DOC_ID);
      if (!live) return [];
      const plain = prose.walkProse(prose.getProseFragment(live.ydoc)).plainText;
      return threads.map((id) => {
        const a = docStore.getThread(DOC_ID, id)?.anchor;
        if (!a || a.kind !== 'text-range') return '';
        const s = prose.resolveRelativePosition(live.ydoc, Uint8Array.from(a.startRel));
        const e = prose.resolveRelativePosition(live.ydoc, Uint8Array.from(a.endRel));
        return s === null || e === null ? '' : plain.slice(s, e);
      });
    },
    stop: () => docStore.stop(),
  };
}
