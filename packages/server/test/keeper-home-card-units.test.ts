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
import { waitFor } from './wait-for.ts';

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

describe('a poll the keeper never answers', () => {
  const ID = 'c'.repeat(32);
  const TOKEN = 'd'.repeat(32);

  /** Cards over a stand-in keeper; `answer` decides each poll's reply. */
  function cardsOver(
    answer: (nth: number, signal: AbortSignal | null | undefined) => Promise<Response>,
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-cards-hung-'));
    dirs.push(dir);
    const withdrawn: string[] = [];
    const said: string[] = [];
    let nth = 0;
    const cards = new KeeperHomeCards({
      dataDir: dir,
      keeper: {
        origin: 'http://127.0.0.1:40123',
        callerToken: () => 'caller',
        pollMs: 10,
        askMs: 30,
        fetchImpl: ((_url: string, init?: RequestInit) => {
          nth += 1;
          return answer(nth, init?.signal);
        }) as typeof fetch,
      },
      boards: () => ['board-harborlight'],
      isBoardLive: () => true,
      getTask: () => undefined,
      createTask: () => ({ ok: true, task: { id: 't-card' } }),
      addReviewItem: () => ({ ok: true, item: { id: 'r-card' } }),
      withdrawReviewItem: (_t, itemId, o) => {
        withdrawn.push(`${itemId}: ${o.reason}`);
        return { ok: true };
      },
      say: (l) => said.push(l),
    });
    return { cards, withdrawn, said };
  }
  const pending = () => Response.json({ status: 'pending', hold: 'token.move', summary: 'x' });
  /** Never answers until its signal aborts, as a wedged relay would. */
  const hang = (signal: AbortSignal | null | undefined) =>
    new Promise<Response>((_, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });

  it('does not stop the sweep, so the card still clears once the keeper answers', async () => {
    const { cards, withdrawn, said } = cardsOver((nth, signal) => {
      if (nth === 1) return Promise.resolve(pending());
      if (nth === 2) return hang(signal);
      return Promise.resolve(Response.json({ status: 'done' }));
    });
    try {
      expect((await cards.announce({ id: ID, pollToken: TOKEN, requester: 'Alice' })).status).toBe(
        201,
      );
      await waitFor(() => withdrawn.length === 1, { describe: 'the card withdrawn' });
      expect(withdrawn).toEqual(['r-card: The request is done.']);
      expect(cards.openCards()).toEqual({});
      expect(said.filter((l) => l.includes('did not answer'))).toHaveLength(1);
    } finally {
      cards.stop();
    }
  });

  it('keeps the card and logs once while the keeper stays silent', async () => {
    const { cards, withdrawn, said } = cardsOver((nth) =>
      Promise.resolve(nth === 1 ? pending() : new Response('no', { status: 500 })),
    );
    try {
      await cards.announce({ id: ID, pollToken: TOKEN, requester: 'Alice' });
      await cards.sweep();
      await cards.sweep();
      expect(withdrawn).toEqual([]);
      expect(Object.keys(cards.openCards())).toEqual([ID]);
      expect(said.filter((l) => l.includes('did not answer'))).toHaveLength(1);
    } finally {
      cards.stop();
    }
  });
});
