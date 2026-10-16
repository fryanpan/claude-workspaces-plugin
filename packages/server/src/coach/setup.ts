/**
 * Workflow A's first step: "Set up my coach" makes the learning-goals doc
 * and the coach's memory doc, once each, on a board of the coach's own.
 *
 * The doc is an ordinary markdown doc bound to `<dataDir>/coach/
 * learning-goals.md`, so it has comments, history and the voice interview
 * like any other. Its board is named "Coach" and is created here, unshared,
 * so the doc sits on no board anybody else works in.
 *
 * The memory doc, `<dataDir>/coach/memory.md`, is the coach session's own:
 * what it has learned about when to speak and when not to, which it reads
 * when it starts and writes as it learns, so a restart keeps it. A board set
 * up before the memory doc existed gets one at boot (`wiring.ts`).
 *
 * Idempotent: a second setup returns the docs the first made while they
 * still exist. An existing file is never overwritten.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newDocId } from '../doc-ids.ts';
import { goalsDocTemplate } from './goals-doc.ts';
import { COACH_DIRNAME, type CoachStore } from './store.ts';
import type { CoachDocRef } from './types.ts';

export const COACH_BOARD_NAME = 'Coach';
export const GOALS_DOC_TITLE = 'Learning goals';
export const MEMORY_DOC_TITLE = 'Coach memory';

export interface CoachSetupDeps {
  dataDir: string;
  createBoard: (name: string) => string;
  /** Bind `path` as a markdown doc on the board: the doc's own id, or
   *  null when it failed. */
  createDoc: (
    docId: string,
    path: string,
    title: string,
    workspaceId: string,
  ) => Promise<string | null>;
  docExists: (docId: string) => boolean;
}

export const goalsDocPath = (dataDir: string) => join(dataDir, COACH_DIRNAME, 'learning-goals.md');
export const memoryDocPath = (dataDir: string) => join(dataDir, COACH_DIRNAME, 'memory.md');

/** What the memory doc starts as: the headings the coaching skill writes under. */
export const MEMORY_TEMPLATE = `# Coach memory

The coach writes here what it learns about when to speak up and when to stay quiet. Edit it freely: the coach reads it when it starts.

## How readily

## When a moment helped

## When to stay quiet

## This week's nudges
`;

const writeOnce = (dataDir: string, path: string, text: string) => {
  if (existsSync(path)) return;
  mkdirSync(join(dataDir, COACH_DIRNAME), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
};

/**
 * One making of each doc at a time, per store: a second "Set up my coach",
 * or setup racing the boot's memory-doc check, waits for the first and gets
 * its answer instead of making a second board or doc.
 */
const making = new WeakMap<CoachStore, Map<string, Promise<CoachDocRef | null>>>();

function once(
  store: CoachStore,
  key: string,
  make: () => Promise<CoachDocRef | null>,
): Promise<CoachDocRef | null> {
  let held = making.get(store);
  if (!held) {
    held = new Map();
    making.set(store, held);
  }
  const running = held.get(key);
  if (running) return running;
  const started = make().finally(() => held?.delete(key));
  held.set(key, started);
  return started;
}

export function ensureGoalsDoc(
  store: CoachStore,
  deps: CoachSetupDeps,
  now: number,
): Promise<CoachDocRef | null> {
  return once(store, 'goals', () => makeGoalsDoc(store, deps, now));
}

async function makeGoalsDoc(
  store: CoachStore,
  deps: CoachSetupDeps,
  now: number,
): Promise<CoachDocRef | null> {
  const held = store.goalsDoc;
  if (held && deps.docExists(held.docId)) {
    await ensureMemoryDoc(store, deps, now);
    return held;
  }
  const path = goalsDocPath(deps.dataDir);
  writeOnce(deps.dataDir, path, goalsDocTemplate());
  const workspaceId = held?.workspaceId ?? deps.createBoard(COACH_BOARD_NAME);
  const docId = await deps.createDoc(newDocId(), path, GOALS_DOC_TITLE, workspaceId);
  if (!docId) return null;
  const doc = { workspaceId, docId, createdAt: now };
  store.setGoalsDoc(doc);
  await ensureMemoryDoc(store, deps, now);
  return doc;
}

/** The memory doc, on the goals doc's board. Null before setup, or when it
 *  could not be made; the coach still runs without it. */
export function ensureMemoryDoc(
  store: CoachStore,
  deps: CoachSetupDeps,
  now: number,
): Promise<CoachDocRef | null> {
  return once(store, 'memory', () => makeMemoryDoc(store, deps, now));
}

async function makeMemoryDoc(
  store: CoachStore,
  deps: CoachSetupDeps,
  now: number,
): Promise<CoachDocRef | null> {
  const goals = store.goalsDoc;
  if (!goals) return null;
  const held = store.memoryDoc;
  if (held && deps.docExists(held.docId)) return held;
  const path = memoryDocPath(deps.dataDir);
  writeOnce(deps.dataDir, path, MEMORY_TEMPLATE);
  const docId = await deps.createDoc(newDocId(), path, MEMORY_DOC_TITLE, goals.workspaceId);
  if (!docId) return null;
  const doc = { workspaceId: goals.workspaceId, docId, createdAt: now };
  store.setMemoryDoc(doc);
  return doc;
}
