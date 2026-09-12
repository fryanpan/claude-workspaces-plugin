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
import type { SecretWriteResult } from '../src/secret-store.ts';
import { handleTaskSecrets } from '../src/routes/task-secrets.ts';
import type { TaskRouteRequest, TaskRoutesContext } from '../src/routes/task-routes-context.ts';

const AGENT: User = { id: 'a-riverbend', name: 'Riverbend Bot', kind: 'known', color: '#888888' };
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

/** Call the door with one stored item and one body. */
async function drive(item: TaskReviewItem, secrets: unknown): Promise<Driven> {
  const written: Array<{ service: string; value: string }> = [];
  const answered: string[] = [];
  const ctx = {
    taskStore: {
      listReviewItems: () => [item],
      answerTaskReview: (_t: string, _i: string, text: string) => {
        answered.push(text);
        return { ok: true, task: { workspaceId: 'w-harbor' }, item };
      },
    },
    taskProjection: { ensureWorkspace: () => undefined },
    j: (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    safeJson: async (req: Request) => (await req.json()) as Record<string, unknown>,
    secretWriter: async (service: string, value: string): Promise<SecretWriteResult> => {
      written.push({ service, value });
      return { ok: true };
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
  it('refuses a multi-line value, and stores neither field', async () => {
    // A newline cannot survive the store's line-based prompt, and the writer
    // refuses it — but the writer refuses it one field at a time, so a bad
    // SECOND value used to arrive with the first already stored. Two fields
    // here, the good one first, so the assertion is about ordering and not
    // only about the refusal.
    const twoFields = storedItem({
      shape: 'secret',
      headline: 'Paste the two relay values',
      secrets: [
        { label: 'Relay account name', service: SERVICE },
        { label: 'Relay signing value', service: 'saltmarsh-relay-signer' },
      ],
    });
    const denied = await drive(twoFields, [
      { service: SERVICE, value: 'not-a-real-value-1' },
      { service: 'saltmarsh-relay-signer', value: 'not-a-real\nvalue-2' },
    ]);
    expect(denied.res.status).toBe(400);
    expect(denied.body.error).toBe('unstorable-value');
    expect(denied.written).toEqual([]);
    expect(denied.answered).toEqual([]);

    // CONTROL: the same pair with a one-line second value stores both.
    const ok = await drive(twoFields, [
      { service: SERVICE, value: 'not-a-real-value-1' },
      { service: 'saltmarsh-relay-signer', value: 'not-a-real-value-2' },
    ]);
    expect(ok.res.status).toBe(200);
    expect(ok.written.map((w) => w.service)).toEqual([SERVICE, 'saltmarsh-relay-signer']);
  });

  it('refuses a value past the store\'s ceiling, and stores nothing', async () => {
    const denied = await drive(secretAsk, [
      { service: SERVICE, value: 'x'.repeat(4097) },
    ]);
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
