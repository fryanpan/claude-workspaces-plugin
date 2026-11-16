/**
 * Direct messages between the people on a board (M10): Alice writes to Bob
 * from her open board, and Bob's already-open board hears it on his own
 * stream; nobody else does.
 *
 * Real server behind the share-proof harness: Alice and Bob are board
 * members who prove themselves with Access tokens on the share host, and the
 * owner proves themselves on the owner's host. Saltmarsh is signed in to the
 * share application but is not on this board.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { emailIdentityId } from '@claude-workspaces/core';
import type { DirectChannels } from '@claude-workspaces/core/direct-messages';
import { type Frame, listenFrames } from './doc-activity-stall-harness.ts';
import {
  type ShareProofServer,
  post,
  readJson,
  startShareProofServer,
} from './share-proof-harness.ts';
import { waitFor } from './wait-for.ts';

const ALICE = 'alice@harborlight.example';
const BOB = 'bob@riverbend.example';
const SALTMARSH = 'saltmarsh@harborlight.example';
const aliceId = emailIdentityId(ALICE);
const bobId = emailIdentityId(BOB);
const SSE = { headers: { accept: 'text/event-stream' } };

describe('direct messages between the people on a board', () => {
  let s: ShareProofServer;
  let alicePage: ReturnType<typeof listenFrames>;
  let bobPage: ReturnType<typeof listenFrames>;
  let boardPage: ReturnType<typeof listenFrames>;
  const streams: Array<ReturnType<typeof listenFrames>> = [];
  const dm = () => `${s.scope}/me/dm`;
  const stream = async (res: Response) => {
    expect(res.status).toBe(200);
    const l = listenFrames(res);
    streams.push(l);
    return l;
  };
  const saw = (frames: Frame[], text: string) =>
    frames.some(
      (f) =>
        f.event === 'direct.message' &&
        (f.data?.message as { text?: string } | undefined)?.text === text,
    );

  beforeAll(async () => {
    s = await startShareProofServer('Harborlight messages');
    s.handle.shareLinks.addToAudience(s.board, [ALICE, BOB], 'Saltmarsh');
    expect(await s.join(ALICE)).toBe(302);
    expect(await s.join(BOB)).toBe(302);
    s.handle.identities.upsertByEmail(ALICE, { displayName: 'Alice' });
    s.handle.identities.upsertByEmail(BOB, { displayName: 'Bob' });
    alicePage = await stream(await s.visitor(ALICE, `${s.scope}/me/events:stream`, SSE));
    bobPage = await stream(await s.visitor(BOB, `${s.scope}/me/events:stream`, SSE));
    boardPage = await stream(await s.local(`${s.scope}/events:stream`, SSE));
  });

  afterAll(async () => {
    for (const l of streams) await l.stop();
    await s.stop();
  });

  it('lists the board’s other people by the names the server holds', async () => {
    const list = await readJson<DirectChannels>(await s.visitor(ALICE, dm()));
    expect(list.me).toEqual({ id: aliceId, name: 'Alice' });
    expect(list.people.map((p) => p.name)).toContain('Bob');
    expect(list.people.some((p) => p.id === aliceId)).toBe(false);
    expect(list.lead).toBeNull();
  });

  it("a message Alice sends reaches Bob's already-open board within 1s, and only Bob", async () => {
    const res = await s.visitor(ALICE, dm(), post({ to: bobId, text: 'Bob, the tide table?' }));
    const sent = await readJson<{ message: { author: { id: string; name: string } } }>(res);
    // The author is the proof's, whatever a body might claim.
    expect(sent.message.author).toEqual({ id: aliceId, name: 'Alice' });

    await waitFor(() => saw(bobPage.frames, 'Bob, the tide table?'), {
      timeout: 1000,
      describe: "Alice's message on Bob's open board",
    });
    // Alice's other tabs hear her own send too.
    await waitFor(() => saw(alicePage.frames, 'Bob, the tide table?'), {
      describe: "Alice's own stream",
    });
    // A sentinel on the board's stream, sent after: once it arrives, the
    // direct message is not coming there.
    await s.local(`${s.scope}/load-reports`, post({}));
    expect(saw(boardPage.frames, 'Bob, the tide table?')).toBe(false);

    const read = await readJson<{ messages: Array<{ text: string; to: string }> }>(
      await s.visitor(BOB, `${dm()}?with=${encodeURIComponent(aliceId)}`),
    );
    expect(read.messages.map((m) => [m.text, m.to])).toEqual([['Bob, the tide table?', bobId]]);
  });

  it('refuses anyone the board does not admit, on either side', async () => {
    const outsider = await s.visitor(SALTMARSH, dm());
    expect(outsider.status).toBe(403);
    const toOutsider = await s.visitor(
      ALICE,
      dm(),
      post({ to: emailIdentityId(SALTMARSH), text: 'hello' }),
    );
    expect(toOutsider.status).toBe(404);
    const toSelf = await s.visitor(ALICE, dm(), post({ to: aliceId, text: 'note to self' }));
    expect(toSelf.status).toBe(404);
    const readOutsider = await s.visitor(
      ALICE,
      `${dm()}?with=${encodeURIComponent(emailIdentityId(SALTMARSH))}`,
    );
    expect(readOutsider.status).toBe(404);
  });

  it('refuses a caller that proves no person, and an empty or oversized text', async () => {
    // The list is "no channels", so a page open on loopback logs no error.
    const list = await s.local(dm());
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ me: null, people: [], lead: null });
    expect((await s.local(`${dm()}?with=${encodeURIComponent(bobId)}`)).status).toBe(401);
    expect((await s.local(dm(), post({ to: bobId, text: 'hello' }))).status).toBe(401);
    const bearer = await s.visitor(ALICE, dm(), {
      headers: { authorization: 'Bearer not-a-person' },
    });
    expect(bearer.status).toBe(403);
    const empty = await s.visitor(ALICE, dm(), post({ to: bobId, text: '   ' }));
    expect(empty.status).toBe(400);
    const long = await s.visitor(ALICE, dm(), post({ to: bobId, text: 'x'.repeat(8001) }));
    expect(long.status).toBe(400);
  });
});
