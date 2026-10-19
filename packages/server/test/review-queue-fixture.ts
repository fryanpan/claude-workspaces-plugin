/**
 * A data dir shaped like the one `GET /api/review-queue` is slow on: several
 * boards with ranked review items, and a repo registry holding thousands of
 * doc keys.
 *
 * The ranks are what make the queue ask the coach's privacy check about each
 * item, and that check asks the registry about every doc on the item's board.
 * On this fixture with 6,000 keys the route took 2.2s a call before the
 * registry learned to look a doc up rather than scan for it.
 *
 * `seedReviewQueueFixture` writes everything with one server and stops it, so
 * a test boots a second server over a cold data dir, as prod does. Fixtures
 * are invented; the repo is public.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewPayload, User } from '@claude-workspaces/core';
import { ATTACHMENT_PRIVACY_FILE } from '../src/attachment-privacy.ts';
import { makeDocKey } from '../src/doc-key.ts';
import { REPO_REGISTRY_FILE } from '../src/repo-registry-file.ts';
import { createServer } from '../src/server.ts';
import { taskBodyDocId } from '../src/task-projection.ts';

export const FIXTURE_AGENT: User = {
  id: 'agent-harborlight',
  name: 'Harborlight Agent',
  kind: 'agent' as unknown as User['kind'],
  color: '#000',
};
export const FIXTURE_PERSON: User = {
  id: 'known-riverbend',
  name: 'Riverbend',
  kind: 'known' as unknown as User['kind'],
  color: '#000',
};

export const BOARD_NAMES = ['Harborlight', 'Riverbend', 'Saltmarsh'] as const;
/** The board whose files stay on this machine, so the lead's ranks on it
 *  must not count. */
export const LOCAL_ONLY_BOARD = 'Saltmarsh';

export interface FixtureShape {
  tasksPerBoard: number;
  docsPerBoard: number;
  /** Doc keys in the repo registry beyond the boards' own docs. */
  extraDocKeys: number;
}

export const SMALL_FIXTURE: FixtureShape = { tasksPerBoard: 12, docsPerBoard: 3, extraDocKeys: 0 };

export interface SeededFixture {
  boards: Record<(typeof BOARD_NAMES)[number], string>;
  /** One task per board with a decision on it, for the live cases. */
  itemTask: Record<(typeof BOARD_NAMES)[number], string>;
  /** One board doc per board, carrying an open agent ask. */
  boardDoc: Record<(typeof BOARD_NAMES)[number], string>;
}

const decision = (headline: string): ReviewPayload => ({
  shape: 'decision',
  headline,
  detail: 'The harbour gauge is closer; the buoy is steadier.',
  options: [
    { id: 'gauge', label: 'Harbour gauge' },
    { id: 'buoy', label: 'Offshore buoy' },
  ],
});

/**
 * Seed `dataDir`. Every third task carries an agent's question (every sixth
 * with a person's reply and the agent's answer to it), every fourth
 * is archived, every sixth has a decision filed on it, and each board doc
 * has one open ask. Then the lead's ranks and goal tags are written over
 * every second item, the Saltmarsh board is made local-only,
 * and the registry gets a key for each board doc, one re-keyed doc, and
 * `extraDocKeys` more.
 */
export async function seedReviewQueueFixture(
  dataDir: string,
  shape: FixtureShape,
): Promise<SeededFixture> {
  const h = createServer({ port: 0, dataDir, spawnerAgentId: null });
  const t = h.tasks;
  const boards = {} as SeededFixture['boards'];
  const itemTask = {} as SeededFixture['itemTask'];
  const boardDoc = {} as SeededFixture['boardDoc'];
  const docKeys: Record<string, string> = {};
  const docKeyAliases: Record<string, string> = {};
  for (const name of BOARD_NAMES) {
    const ws = t.createWorkspace(`${name} board`).id;
    boards[name] = ws;
    const goal = t.addGoal(ws, { title: `${name} tides` }, { actor: FIXTURE_AGENT });
    if (!goal.ok) throw new Error('goal not added');
    for (let i = 0; i < shape.tasksPerBoard; i++) {
      const made = t.createTask(ws, {
        title: `${name} chart ${i}`,
        body: `Agent can chart ${name} shoal ${i} so that sailors plan.`,
        ...(i % 2 === 0 ? { goal: goal.goal.id } : {}),
      });
      if (!made.ok) throw new Error('task not created');
      const id = made.task.id;
      if (i % 3 === 0) {
        const th = await h.docStore.createThreadByFind(
          taskBodyDocId(id),
          { find: `${name} shoal ${i}` },
          FIXTURE_AGENT,
          `Riverbend, which ${name} chart for shoal ${i}?`,
        );
        if (!th.ok) throw new Error(`thread: ${th.error}`);
        // A person's word on the board makes Riverbend somebody an agent
        // can ask; the agent's answer leaves the thread waiting on them.
        if (i % 6 === 0) {
          const doc = taskBodyDocId(id);
          await h.docStore.postComment(doc, th.thread.id, FIXTURE_PERSON, 'Which tide?');
          await h.docStore.postComment(doc, th.thread.id, FIXTURE_AGENT, `Spring tide ${i}.`);
        }
      }
      if (i % 6 === 1) {
        const item = t.addReviewItem(id, decision(`Which ${name} gauge for chart ${i}?`), {
          actor: FIXTURE_AGENT,
        });
        if (!item.ok) throw new Error('review item not added');
        itemTask[name] ??= id;
      }
      if (i % 4 === 3) t.archiveTask(id, { actor: FIXTURE_AGENT });
    }
    for (let d = 0; d < shape.docsPerBoard; d++) {
      const docId = `${name.toLowerCase()}-notes-${d}`;
      h.docStore.getOrCreate(docId, { type: 'markdown', title: `${name} notes ${d}` });
      h.docStore.setDocContent(docId, `# Notes\n\n${name} plan ${d}\n`);
      t.attachDoc(ws, docId);
      boardDoc[name] ??= docId;
      const th = await h.docStore.createThreadByFind(
        docId,
        { find: `${name} plan ${d}` },
        FIXTURE_AGENT,
        `Riverbend, ready to publish ${name} plan ${d}?`,
      );
      if (!th.ok) throw new Error(`thread: ${th.error}`);
      docKeys[makeDocKey(`${name.toLowerCase()}-repo`, `docs/notes-${d}.md`)] = docId;
    }
  }
  // One doc re-keyed: it holds its old spelling and its new one, and the
  // current key is the one that is not aliased away.
  const moved = boardDoc.Harborlight;
  const oldKey = makeDocKey('harborlight-old', 'docs/notes-0.md');
  docKeys[oldKey] = moved;
  docKeyAliases[oldKey] = makeDocKey('harborlight-repo', 'docs/notes-0.md');
  for (let i = 0; i < shape.extraDocKeys; i++) {
    docKeys[makeDocKey('riverbend-archive', `notes/${i}.md`)] = `riverbend-archive-${i}`;
  }

  const res = await fetch(`http://127.0.0.1:${h.port}/api/review-queue`);
  const queue = (await res.json()) as {
    items: Array<{ key: string; project: string; ask?: string }>;
  };
  await h.stop();

  const ranks: Record<string, unknown> = {};
  const tags: Record<string, unknown> = {};
  const at = Date.now();
  // Chosen by what the items say, not where they stood, so every seed ranks
  // the same asks; ranked in reverse, so a rank that counts moves its item.
  const label = (i: { project: string; ask?: string }) => `${i.project}|${i.ask ?? ''}`;
  const ranked = [...queue.items]
    .sort((a, b) => label(a).localeCompare(label(b)))
    .filter((_, i) => i % 2 === 0);
  ranked.forEach((item, i) => {
    ranks[item.key] = { rank: ranked.length - i, at, by: FIXTURE_AGENT.id };
    tags[item.key] = { goal: i % 3 === 0 ? 'urgent' : 'not-this-week', at, by: FIXTURE_AGENT.id };
  });
  writeFileSync(
    join(dataDir, 'review-ranks.json'),
    JSON.stringify({ ranks, tags, personMoves: {} }),
  );
  writeFileSync(
    join(dataDir, REPO_REGISTRY_FILE),
    JSON.stringify({ version: 1, repos: [], docKeys, docKeyAliases }),
  );
  writeFileSync(
    join(dataDir, ATTACHMENT_PRIVACY_FILE),
    JSON.stringify({ localOnly: [boards[LOCAL_ONLY_BOARD]] }),
  );
  return { boards, itemTask, boardDoc };
}

/** One queue item as a line that names no generated id, so two seeds of the
 *  same shape read the same. */
export function describeItem(item: {
  project: string;
  kind: string;
  ask?: string;
  size: string;
  leadRank?: number;
  goalTag?: string;
}): string {
  const rank = item.leadRank === undefined ? '' : ` rank=${item.leadRank}`;
  const tag = item.goalTag === undefined ? '' : ` tag=${item.goalTag}`;
  return `${item.project} | ${item.kind} | ${item.ask ?? ''} | ${item.size}${rank}${tag}`;
}
