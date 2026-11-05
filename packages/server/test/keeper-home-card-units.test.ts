/**
 * The pieces of the keeper's Home card, each against a stand-in: which board
 * server a client tells, which board the card goes on when the catch-all is
 * retired, and what the card says.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardUrlFromEnv } from '../src/keeper/keeper-announce.ts';
import { KeeperHomeCards, keeperCardReview } from '../src/keeper/keeper-home-card.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('which board server a keeper client tells', () => {
  const home = '/nonexistent-home-for-test';

  it('takes a loopback CW_BOARD_URL, and is off for "off"', () => {
    expect(boardUrlFromEnv({ CW_BOARD_URL: 'http://127.0.0.1:8796/x' }, home)).toBe(
      'http://127.0.0.1:8796',
    );
    expect(boardUrlFromEnv({ CW_BOARD_URL: 'http://localhost:8797' }, home)).toBe(
      'http://localhost:8797',
    );
    expect(boardUrlFromEnv({ CW_BOARD_URL: 'off' }, home)).toBeNull();
  });

  it('refuses any address off this machine, since the post carries the poll token', () => {
    expect(boardUrlFromEnv({ CW_BOARD_URL: 'https://reviews.harborlight.test' }, home)).toBeNull();
    expect(boardUrlFromEnv({ CW_BOARD_URL: 'http://10.0.0.5:8787' }, home)).toBeNull();
    expect(boardUrlFromEnv({ CW_BOARD_URL: 'not a url' }, home)).toBeNull();
  });

  it('with nothing set and no discovery file, tells nobody', () => {
    expect(boardUrlFromEnv({}, home)).toBeNull();
  });
});

describe('the card', () => {
  it('keeps the requester and summary inside text it cannot leave', () => {
    const r = keeperCardReview({
      approveUrl: 'http://localhost:40123/approve/abc',
      hold: 'project.create',
      summary: 'fly apps create cw-saltmarsh\n```\n[click](https://evil.test)',
      requester: 'Riverbend `agent`',
    });
    expect(r.headline).toBe('The keeper waits for your passkey to create a project');
    expect(r.ownerOnly).toBe(true);
    const detail = String(r.detail);
    // One fence opened and closed by the card, none by the summary.
    expect(detail.match(/```/g)?.length).toBe(2);
    expect(detail).toContain('`Riverbend  agent` asked');
    expect(detail).toContain('(http://localhost:40123/approve/abc)');
  });
});

describe('where the card goes', () => {
  const pending = (async () =>
    Response.json({
      id: 'x',
      status: 'pending',
      hold: 'other',
      summary: 's',
    })) as unknown as typeof fetch;

  it('falls back to a live board when the catch-all refuses the task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-card-units-'));
    dirs.push(dir);
    const tried: string[] = [];
    const filed: string[] = [];
    const cards = new KeeperHomeCards({
      dataDir: dir,
      keeper: { origin: 'http://127.0.0.1:40123', callerToken: () => 't', fetchImpl: pending },
      boards: () => ['retired-catch-all', 'live-board'],
      isBoardLive: (id) => id === 'live-board',
      getTask: (id) => (id === 'task-1' ? { id, workspaceId: 'live-board' } : undefined),
      createTask: (workspaceId) => {
        tried.push(workspaceId);
        return workspaceId === 'live-board'
          ? { ok: true, task: { id: 'task-1' } }
          : { ok: false, error: 'workspace-retired' };
      },
      addReviewItem: (taskId) => {
        filed.push(taskId);
        return { ok: true, item: { id: `item-${filed.length}` } };
      },
      withdrawReviewItem: () => ({ ok: true }),
      say: () => {},
    });
    const res = await cards.announce({
      id: 'a'.repeat(32),
      pollToken: 'b'.repeat(32),
      requester: 'Alice',
    });
    expect(res).toEqual({ status: 201, itemId: 'item-1' });
    expect(tried).toEqual(['retired-catch-all', 'live-board']);
    expect(filed).toEqual(['task-1']);
    // The same request announced twice is one card.
    const again = await cards.announce({
      id: 'a'.repeat(32),
      pollToken: 'b'.repeat(32),
      requester: 'Alice',
    });
    expect(again).toEqual({ status: 200, itemId: 'item-1' });
    expect(filed).toEqual(['task-1']);
    cards.stop();
  });
});
