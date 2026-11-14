/**
 * A component file git ignores builds only after the owner grants its
 * folder. An agent's request files an access card through the board's
 * existing access-card path and changes nothing; an agent cannot approve it;
 * the owner's Approve at the access door grants the folder, and the refused
 * tag on the open page then builds. Every name and path here is a fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  componentBuildOf,
  componentBuildsMap,
  componentInputs,
} from '@claude-workspaces/core/mdx-components';
import {
  AGENT,
  type ShareProofServer,
  post,
  readJson,
  startShareProofServer,
} from './share-proof-harness.ts';
import { waitFor } from './wait-for.ts';
import { openYPage } from './y-page.ts';

const TAG = 'import Tide from \'./private/tide.tsx\'\n\n<Tide id="tide" />';
const KEY =
  componentInputs(["import Tide from './private/tide.tsx'", '<Tide id="tide" />'])[0]?.key ?? '';
const TIDE =
  'export default function mount(el: HTMLElement) { el.textContent = "Riverbend tide"; }\n';

describe('a component folder git ignores', () => {
  let s: ShareProofServer;
  let root = '';
  let folder = '';
  let taskId = '';
  const docPath = () => `${s.scope}/docs/notes`;
  const pageUrl = () => `ws://127.0.0.1:${s.handle.port}${docPath()}/y`;
  const ask = (body: Record<string, unknown>) =>
    s.local(`${docPath()}/component-grants`, post({ author: AGENT, ...body }));
  const item = async (id: string) => {
    const body = await readJson<{
      tasks: Array<{
        id: string;
        reviews?: Array<{
          id: string;
          access?: unknown;
          review: { ownerOnly?: true; headline: string };
          answer?: { text: string };
        }>;
      }>;
    }>(await s.local(`${s.scope}/tasks?format=json`));
    return body.tasks.find((t) => t.id === taskId)?.reviews?.find((r) => r.id === id);
  };

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'component-grant-card-')));
    const repo = join(root, 'saltmarsh');
    folder = join(repo, 'private');
    mkdirSync(folder, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, '.gitignore'), 'private/\n');
    writeFileSync(join(folder, 'component.json'), '{}');
    writeFileSync(join(folder, 'tide.tsx'), TIDE);
    writeFileSync(join(repo, 'notes.mdx'), `# Harborlight\n\n${TAG}\n`);
    s = await startShareProofServer('Saltmarsh tides');
    const bound = await s.local(
      `${s.scope}/docs`,
      post({ docId: 'notes', type: 'markdown', sourceUrl: join(repo, 'notes.mdx') }),
    );
    expect(bound.ok).toBe(true);
    taskId = (
      await readJson<{ task: { id: string } }>(
        await s.local(
          `${s.scope}/tasks`,
          post({
            title: 'Chart the Saltmarsh tides',
            body: 'Agent can build the tide chart so that Alice can plan the crossing.',
            author: AGENT,
          }),
        ),
      )
    ).task.id;
  });

  afterAll(async () => {
    await s.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("builds only after the owner approves the agent's card", async () => {
    const page = openYPage(pageUrl(), { host: `localhost:${s.handle.port}` });
    try {
      const builds = componentBuildsMap(page.ydoc);
      await page.synced();
      const refused = await waitFor(() => componentBuildOf(builds, KEY)?.error, {
        describe: 'the ignored source being refused',
      });
      expect(refused).toContain('ignored by git');
      expect(refused).toContain('request_component_grant');

      expect((await ask({ folder: 'private', why: 'The tide chart.' })).status).toBe(404);
      const filed = await ask({ folder: 'private', taskId, why: 'The tide chart reads it.' });
      expect(filed.status).toBe(202);
      const { reviewItemId } = (await filed.json()) as { reviewItemId: string };
      const card = await item(reviewItemId);
      expect(card?.review.ownerOnly).toBe(true);
      expect(card?.access).toEqual({ op: 'component-folder', workspaceId: s.board, folder });
      expect(card?.review.headline).toContain('git does not list');
      expect(s.handle.docStore.componentGrants.list()).toEqual([]);

      const door = `${s.scope}/tasks/${taskId}/review-items/${reviewItemId}/access`;
      const approve = post({ decision: 'approve', access: card?.access });
      expect((await s.local(door, approve)).status).toBe(403);
      expect(s.handle.docStore.componentGrants.list()).toEqual([]);

      const approved = await s.owner(door, approve);
      expect(approved.status).toBe(200);
      expect(s.handle.docStore.componentGrants.list()).toEqual([
        expect.objectContaining({ folder }),
      ]);
      const hash = await waitFor(
        () => {
          const b = componentBuildOf(builds, KEY);
          return b?.hash && b.error === undefined ? b.hash : undefined;
        },
        { describe: 'the granted source building on the open page' },
      );
      const bundle = await s.local(`${docPath()}/components/${hash}.js`);
      expect(await bundle.text()).toContain('Riverbend tide');

      // Asking again for a granted folder files nothing.
      const again = await ask({ folder: 'private', taskId, why: 'Again.' });
      expect(again.status).toBe(200);
      expect(((await again.json()) as { granted: boolean }).granted).toBe(true);
    } finally {
      page.close();
    }
  });

  it('refuses a folder outside the repository, one no component.json declares, and visitors', async () => {
    expect((await ask({ folder: tmpdir(), taskId, why: 'x' })).status).toBe(400);
    mkdirSync(join(root, 'saltmarsh', 'loose'), { recursive: true });
    const undeclared = await ask({ folder: 'loose', taskId, why: 'x' });
    expect(undeclared.status).toBe(400);
    expect(((await undeclared.json()) as { error: string }).error).toContain('component.json');
    expect((await ask({ folder: '../..', taskId, why: 'x' })).status).toBe(400);
    const visitor = await s.visitor('alice@harborlight.example', `${docPath()}/agent-components`);
    expect(visitor.status).toBe(403);
  });
});
