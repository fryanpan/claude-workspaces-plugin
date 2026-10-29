/**
 * The owner's notice when the master sharing switch goes off: an access card
 * on the owner's queue, answered only at the access door, and while the
 * switch is off the one way back in through the owner's own hostname.
 * Split from `sharing-switch.test.ts`, on the same server shape.
 */
import { beforeAll, describe, expect, it, spyOn } from 'bun:test';
import type { ServerHandle } from '../src/server.ts';
import {
  CF_RAY,
  MEMBER,
  OWNER_AUD,
  OWNER_HOST,
  OWN_PAGE,
  useSharingSwitchServer,
} from './sharing-switch-server.ts';
import { waitFor } from './wait-for.ts';

describe("the owner's notice", () => {
  const f = useSharingSwitchServer();
  const {
    judged,
    signJwt,
    req,
    postLocal,
    onShareHost,
    onOwnerHost,
    postOwner,
    openNotices,
    doorPath,
    approveNotice,
    turnBackOn,
    boardPath,
  } = f;
  let handle: ServerHandle;
  let closing: string;
  let other: string;
  beforeAll(() => {
    ({ handle, closing, other } = f);
  });

  type Row = {
    reviewItemId: string;
    taskId: string;
    askedBy: string;
    review: { headline: string; detail: string; options?: Array<{ id: string; label: string }> };
  };
  const HEADLINE =
    'Turns sharing back on for every board, so the people each one names can sign in again.';
  const unfiledBoard = async (): Promise<string | undefined> => {
    const r = await req('/workspaces?format=json', `localhost:${handle.port}`);
    const body = (await r.json()) as { boardWorkspaces: Array<{ id: string; name: string }> };
    return body.boardWorkspaces.find((w) => w.name === 'Unfiled')?.id;
  };
  /** Open items on the owner's catch-all board that the switch filed. */
  const notices = async (): Promise<Row[]> => {
    const ws = await unfiledBoard();
    if (!ws) return [];
    const r = await req(`/workspaces/${ws}/review-items`, `localhost:${handle.port}`);
    const rows = ((await r.json()) as { items: Row[] }).items;
    return rows.filter((row) => row.askedBy === 'Sharing switch');
  };
  const masterEnabled = async (): Promise<boolean> => {
    const r = await req('/api/share', `localhost:${handle.port}`);
    return ((await r.json()) as { sharing: { enabled: boolean } }).sharing.enabled;
  };

  it('files nothing when one board is closed', async () => {
    expect(await notices()).toHaveLength(0);
    await postLocal('/api/share/enabled', { workspaceId: other, enabled: false });
    await postOwner('/api/share/enabled', { workspaceId: other, enabled: true });
    expect(await notices()).toHaveLength(0);
  });

  it("puts the master switch going off on the owner's queue as a decision, through the quality gate", async () => {
    const off = await postLocal('/api/share/enabled', {
      enabled: false,
      reason: 'a precaution',
      actor: { id: 'agent-riverbend', name: 'Riverbend Agent' },
    });
    expect(off.status).toBe(200);
    // Read straight after the 200: the item is on the queue before the
    // route answers, so the owner's open board has it on its next event.
    const rows = await notices();
    expect(rows).toHaveLength(1);
    const [row] = rows as [Row];
    // An access card: its headline is the change, and only the access door answers it.
    expect(row.review.headline).toBe(HEADLINE);
    expect(row.review.options?.map((o) => o.label)).toEqual(['Approve', 'Reject']);
    expect(row.review.detail).toContain('The agent Riverbend Agent turned off');
    expect(row.review.detail).not.toContain('agent-riverbend');
    expect(row.review.detail).toContain('a precaution');
    expect(row.review.detail).toMatch(/(::ffff:)?127\.0\.0\.1/);
    // The gate was asked about it and passed it; it is not held.
    await waitFor(() => judged.includes(HEADLINE));
    expect(row.review.detail).toContain('Approve turns it back on; Reject leaves it off.');
  });

  it('replaces the one item when it goes off again, naming the latest flip', async () => {
    const before = (await notices())[0]?.reviewItemId;
    expect(before).toBeString();
    await postLocal('/api/share/enabled', { enabled: false, reason: 'second look' });
    const rows = await notices();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reviewItemId).not.toBe(before as string);
    expect(rows[0]?.review.detail).toContain('second look');
  });

  it('keeps the item when an agent asks to turn it back on, and withdraws it when the owner does', async () => {
    expect((await postLocal('/api/share/enabled', { enabled: true })).status).toBe(403);
    expect(await notices()).toHaveLength(1);
    await turnBackOn();
    expect(await notices()).toHaveLength(0);
  });

  it('refuses a loopback answer that claims to be the owner, on either route, and the switch stays off', async () => {
    await postLocal('/api/share/enabled', { enabled: false, reason: 'third time' });
    const [n] = (await openNotices()) as [
      { board: string; taskId: string; reviewItemId: string; access: unknown },
    ];
    const bryan = { id: 'known-bryan', name: 'Bryan', kind: 'person' };
    const general = await postLocal(
      `/workspaces/${n.board}/tasks/${n.taskId}/review-items/${n.reviewItemId}/answer`,
      { text: 'Approve', answeredWith: 'o-approve', author: bryan },
    );
    expect(general.status).toBe(400);
    expect(((await general.json()) as { error: string }).error).toBe('access-item');
    const door = await postLocal(doorPath(n), {
      decision: 'approve',
      access: n.access,
      author: bryan,
    });
    expect(door.status).toBe(403);
    expect(await masterEnabled()).toBe(false);
    expect(await openNotices()).toHaveLength(1);
  });

  it("refuses an agent's withdrawal of the card, so the owner still has it to approve", async () => {
    expect(await masterEnabled()).toBe(false);
    const [n] = (await openNotices()) as [
      { board: string; taskId: string; reviewItemId: string; access: unknown },
    ];
    const agent = { id: 'agent-riverbend', name: 'Riverbend Agent', kind: 'agent' };
    const item = `/workspaces/${n.board}/tasks/${n.taskId}/review-items/${n.reviewItemId}`;
    for (const path of [`${item}/withdraw`, `${item}/withdraw/undo`]) {
      const r = await postLocal(path, { author: agent, reason: 'tidying up' });
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: string }).error).toBe('sharing-notice');
    }
    const still = await openNotices();
    expect(still.map((x) => x.reviewItemId)).toEqual([n.reviewItemId]);
  });

  it('lets the owner, and nobody else, back in through the tunnel while it is off', async () => {
    expect(await masterEnabled()).toBe(false);
    const [n] = (await openNotices()) as [
      { board: string; taskId: string; reviewItemId: string; access: unknown },
    ];
    // Everyone else, everywhere else, is still refused.
    expect((await onShareHost(boardPath(closing), MEMBER)).status).toBe(403);
    expect((await onOwnerHost(boardPath(closing))).status).toBe(403);
    const member = await req(doorPath(n), OWNER_HOST, {
      method: 'POST',
      headers: {
        ...CF_RAY,
        ...OWN_PAGE,
        'cf-access-jwt-assertion': await signJwt(OWNER_AUD, MEMBER),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve', access: n.access }),
    });
    expect(member.status).toBe(403);
    // Not from the owner's page: the door asks same-origin.
    expect((await postOwner(doorPath(n), { decision: 'approve', access: n.access })).status).toBe(
      403,
    );
    expect(await masterEnabled()).toBe(false);
    // The owner's page shows the card's Approve.
    const page = await onOwnerHost('/sharing-off');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Turn back on');
    expect(html).toContain(doorPath(n));
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      const approved = await approveNotice(n);
      expect(approved.status, await approved.clone().text()).toBe(200);
    } finally {
      spy.mockRestore();
    }
    expect(await masterEnabled()).toBe(true);
    expect(lines.find((l) => l.includes('[sharing] master switch ON'))).toContain('by "owner ');
    expect(await openNotices()).toHaveLength(0);
    expect((await onShareHost(boardPath(closing), MEMBER)).status).toBe(200);
  });

  it('files on a live board nobody outside can reach when the catch-all board is retired', async () => {
    const unfiled = await unfiledBoard();
    expect(unfiled).toBeString();
    const retired = await req(`/workspaces/${unfiled}/retired`, `localhost:${handle.port}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retired: true, author: { id: 'known-bryan', name: 'Bryan' } }),
    });
    expect(retired.status).toBe(200);
    const created = await postLocal('/workspaces', { name: 'Saltmarsh board' });
    const live = ((await created.json()) as { workspace: { id: string } }).workspace.id;

    await postLocal('/api/share/enabled', { enabled: false, reason: 'catch-all retired' });

    const r = await req(`/workspaces/${live}/review-items`, `localhost:${handle.port}`);
    const rows = ((await r.json()) as { items: Row[] }).items.filter(
      (row) => row.askedBy === 'Sharing switch',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.review.headline).toBe(HEADLINE);
    expect(rows[0]?.review.detail).toContain('catch-all retired');
    // The shared boards got nothing: the item names an address on this machine.
    for (const board of [closing, other]) {
      const shared = await req(`/workspaces/${board}/review-items`, `localhost:${handle.port}`);
      const items = ((await shared.json()) as { items: Row[] }).items;
      expect(items.filter((row) => row.askedBy === 'Sharing switch')).toHaveLength(0);
    }
    await turnBackOn();
  });
});
