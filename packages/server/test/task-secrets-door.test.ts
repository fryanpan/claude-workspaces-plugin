/**
 * The secrets door, driven directly — for the refusals a request cannot reach.
 *
 * Its siblings in `secret-review-item.test.ts` drive a real server through a
 * real admission gate, which is the right shape for everything a caller can
 * actually send. This file exists for the one refusal that shape cannot
 * exercise: the door refuses an item that is not a secret ask, and the quality
 * gate refuses to FILE `secrets` on any other shape, so no HTTP request can
 * build the item that check is about. Removing the check left the suite green
 * for exactly that reason (security review, 2026-09-12).
 *
 * So the item is built here, past the gate, the way a peer writing the store
 * directly or a payload from a future shape would arrive — and the module is
 * called with the smallest context that reaches it. Every case pairs with a
 * control that differs in one field, so a pass is about the field and not
 * about the fixture being unusable.
 *
 * Placeholders throughout; the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import type { TaskReviewItem, User } from '@claude-workspaces/core';
import type { TaskRouteRequest, TaskRoutesContext } from '../src/routes/task-routes-context.ts';
import { handleTaskSecrets } from '../src/routes/task-secrets.ts';
import type { SecretWriteResult } from '../src/secret-store.ts';

const AGENT: User = { id: 'a-riverbend', name: 'Nightly Indexer', kind: 'known', color: '#888888' };
const TASK = 't-nightly';
const ITEM = 'r-two-values';
const SERVICE = 'saltmarsh-relay-account';

/** An item as the STORE holds it, built past the filing gate. */
function storedItem(review: Record<string, unknown>): TaskReviewItem {
  return {
    id: ITEM,
    review,
    createdAt: 1_700_000_000_000,
    createdBy: AGENT,
  } as unknown as TaskReviewItem;
}

interface Driven {
  res: Response;
  body: Record<string, unknown>;
  written: Array<{ service: string; value: string }>;
  answered: string[];
}

/**
 * Call the door with one stored item and one body.
 *
 * `writer` stands in for the machine's store. It defaults to one that always
 * lands, so a case that is not about the store reads as if there were none;
 * pass one that refuses to drive the other half of "the answer is recorded
 * only after the store confirms the write".
 */
async function drive(
  item: TaskReviewItem,
  secrets: unknown,
  writer?: (service: string, value: string) => SecretWriteResult,
): Promise<Driven> {
  const written: Array<{ service: string; value: string }> = [];
  const answered: string[] = [];
  const ctx = {
    taskStore: {
      listReviewItems: () => [item],
      answerTaskReview: (_t: string, _i: string, text: string) => {
        answered.push(text);
        return { ok: true, task: { id: 't-harbor', workspaceId: 'w-harbor' }, item };
      },
    },
    taskProjection: { refreshTask: () => undefined },
    j: (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    safeJson: async (req: Request) => (await req.json()) as Record<string, unknown>,
    secretWriter: async (service: string, value: string): Promise<SecretWriteResult> => {
      const verdict = writer?.(service, value) ?? { ok: true };
      // Only a write that LANDED is recorded here, so a case can assert what
      // reached the store as well as what the door answered.
      if (verdict.ok) written.push({ service, value });
      return verdict;
    },
  } as unknown as TaskRoutesContext;

  const rq = {
    req: new Request('http://board.invalid/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: AGENT, secrets }),
    }),
    scope: { workspaceId: 'w-harbor', rest: `tasks/${TASK}/review-items/${ITEM}/secrets` },
    authorFor: () => AGENT,
    // The owner, so every case here is about what comes AFTER the owner gate.
    requireOwner: () => null,
  } as unknown as TaskRouteRequest;

  const res = await handleTaskSecrets(ctx, rq);
  if (!res) throw new Error('the door did not claim its own path');
  return { res, body: (await res.json()) as Record<string, unknown>, written, answered };
}

const secretAsk = storedItem({
  shape: 'secret',
  headline: 'Paste the relay account name',
  secrets: [{ label: 'Relay account name', service: SERVICE }],
});

describe('the secrets door refuses by SHAPE, not only by the owner-only flag', () => {
  it('refuses an item that is not a secret ask, even carrying a secrets list', async () => {
    // The item a request cannot file: an ordinary ask, owner-only, with a
    // services list on it. Without the shape check the door would read that
    // list as its declared names and store a value under one of them — a
    // caller choosing where a value goes, which is the whole thing the
    // declared list exists to prevent.
    const smuggled = storedItem({
      shape: 'review',
      ownerOnly: true,
      headline: 'Have a look at the relay settings',
      secrets: [{ label: 'Relay account name', service: SERVICE }],
    });
    const denied = await drive(smuggled, [{ service: SERVICE, value: 'not-a-real-value-1' }]);
    expect(denied.res.status).toBe(400);
    expect(denied.body.error).toBe('not-a-secret-item');
    expect(denied.written).toEqual([]);
    expect(denied.answered).toEqual([]);

    // CONTROL: the SAME list on a secret ask goes through and is stored, so
    // the refusal above is about the shape and not about the fixture.
    const ok = await drive(secretAsk, [{ service: SERVICE, value: 'not-a-real-value-1' }]);
    expect(ok.res.status).toBe(200);
    expect(ok.written).toEqual([{ service: SERVICE, value: 'not-a-real-value-1' }]);
    expect(ok.answered).toEqual([`Secrets saved: ${SERVICE}`]);
  });
});

describe('a value the store cannot hold is refused before anything is written', () => {
  it('takes a MULTI-LINE value whole, and refuses an unstorable one first', async () => {
    // A three-line paste — an SSH key, a service-account file — used to be
    // refused here, and then not even reach the refusal: the browser input
    // stripped the breaks first, so it arrived as one joined line and was
    // stored silently wrong (UX review, 2026-09-12). The store encodes now,
    // so the door takes it and the writer receives every line.
    const twoFields = storedItem({
      shape: 'secret',
      headline: 'Paste the two relay values',
      secrets: [
        { label: 'Relay account name', service: SERVICE },
        { label: 'Relay signing value', service: 'saltmarsh-relay-signer' },
      ],
    });
    const multi = 'aaa-not-real-1\nbbb-not-real-2\nccc-not-real-3';
    const took = await drive(twoFields, [
      { service: SERVICE, value: 'not-a-real-value-1' },
      { service: 'saltmarsh-relay-signer', value: multi },
    ]);
    expect(took.res.status).toBe(200);
    expect(took.written.map((w) => w.service)).toEqual([SERVICE, 'saltmarsh-relay-signer']);
    // Whole, not joined: the writer was handed all three lines.
    expect(took.written[1]?.value).toBe(multi);
    expect(took.written[1]?.value.split('\n')).toHaveLength(3);

    // The one-at-a-time property this case used to carry is still asserted,
    // on a value that IS unstorable: the writer refuses field by field, so a
    // bad SECOND value once arrived with the first already in the store.
    // Nothing can roll a Keychain write back, so every refusable value is
    // spent before the first write.
    const denied = await drive(twoFields, [
      { service: SERVICE, value: 'not-a-real-value-1' },
      { service: 'saltmarsh-relay-signer', value: 'not-a-real\u0000value-2' },
    ]);
    expect(denied.res.status).toBe(400);
    expect(denied.body.error).toBe('unstorable-value');
    expect(denied.written).toEqual([]);
    expect(denied.answered).toEqual([]);
  });

  it("refuses a value past the store's ceiling, and stores nothing", async () => {
    const denied = await drive(secretAsk, [{ service: SERVICE, value: 'x'.repeat(4097) }]);
    expect(denied.res.status).toBe(400);
    expect(denied.body.error).toBe('unstorable-value');
    // The refusal says nothing about what was sent — no value, no length.
    expect(JSON.stringify(denied.body)).not.toContain('4097');
    expect(denied.written).toEqual([]);

    // CONTROL: one character under the ceiling is stored.
    const ok = await drive(secretAsk, [{ service: SERVICE, value: 'x'.repeat(4096) }]);
    expect(ok.res.status).toBe(200);
    expect(ok.written).toHaveLength(1);
  });
});

describe('the ask is recorded only after the store has confirmed every write', () => {
  it('records no answer when the store cannot verify what it wrote', async () => {
    // The reviewer saw one hand-over of four report "saved" with nothing in
    // the store afterwards (UX review, 2026-09-12). The suspicion was their
    // own restart, and the ordering in the door is already write-then-verify
    // -then-record — but nothing held it there, so a later edit that moved
    // the record above the loop would have left the suite green while the
    // card said saved over an empty store.
    const twoFields = storedItem({
      shape: 'secret',
      headline: 'Paste the two relay values',
      secrets: [
        { label: 'Relay account name', service: SERVICE },
        { label: 'Relay signing value', service: 'saltmarsh-relay-signer' },
      ],
    });
    const values = [
      { service: SERVICE, value: 'not-a-real-value-1' },
      { service: 'saltmarsh-relay-signer', value: 'not-a-real-value-2' },
    ];
    // The store takes the first field and then cannot read back what it
    // wrote — the shape a locked keychain or a denied consent dialog takes.
    const denied = await drive(twoFields, values, (service) =>
      service === SERVICE ? { ok: true } : { ok: false, error: 'verify-failed' },
    );
    expect(denied.res.status).toBe(502);
    expect(denied.body.error).toBe('store-failed');
    // The one thing the card must never be told: that it landed.
    expect(denied.answered).toEqual([]);
    // And the reply names the step, never a value.
    expect(JSON.stringify(denied.body)).not.toContain('not-a-real-value');

    // CONTROL: the same two fields with a store that confirms both ARE
    // recorded, so the assertion above is about the failed verify and not
    // about the fixture being unanswerable.
    const ok = await drive(twoFields, values);
    expect(ok.res.status).toBe(200);
    expect(ok.answered).toEqual([`Secrets saved: ${SERVICE}, saltmarsh-relay-signer`]);
  });
});
