/**
 * The pure halves of the owner-only asks and the approver record, driven
 * directly. The HTTP halves are `require-owner-for.test.ts`,
 * `review-approver.test.ts` and `share-access-door.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { approvalLine, approverOf, provenEmailFor } from '../src/review-items/approver.ts';
import {
  ACCESS_APPROVE,
  ACCESS_REJECT,
  accessReviewPayload,
  ownerOnlyForStep,
  readOwnerSteps,
} from '../src/review-items/owner-steps.ts';
import { hasOwnerProof } from '../src/share/owner-proof.ts';

const REVIEW = { shape: 'decision', headline: 'Push the branch?', step: 'push' };

describe('owner steps', () => {
  it('files a reserved step owner-only and leaves every other item alone', () => {
    expect(ownerOnlyForStep(REVIEW, ['push'])).toEqual({ ...REVIEW, ownerOnly: true });
    expect(ownerOnlyForStep(REVIEW, ['jira'])).toBe(REVIEW);
    expect(ownerOnlyForStep({ ...REVIEW, step: undefined }, ['push'])).toEqual({
      ...REVIEW,
      step: undefined,
    });
  });

  it('reads a list of step names, null as none, and refuses anything else whole', () => {
    expect(readOwnerSteps(['push', 'deploy-prod'])).toEqual(['push', 'deploy-prod']);
    expect(readOwnerSteps(null)).toEqual([]);
    expect(readOwnerSteps(['Push'])).toBeUndefined();
    expect(readOwnerSteps('push')).toBeUndefined();
  });

  it("builds an access item's words from the change, owner-only, approve or reject", () => {
    const payload = accessReviewPayload(
      { op: 'add-audience', workspaceId: 'w-riverbend', entries: ['@saltmarsh.example'] },
      'They review the release notes.',
    ) as { headline: string; ownerOnly: true; options: Array<{ id: string }> };
    expect(payload.headline).toBe('Lets everyone at @saltmarsh.example sign in to this board.');
    expect(payload.ownerOnly).toBe(true);
    expect(payload.options.map((o) => o.id)).toEqual([ACCESS_APPROVE, ACCESS_REJECT]);
  });
});

describe('the approver record', () => {
  const PERSON = { id: 'user-abc', name: 'Alice', kind: 'person' };
  const AGENT = { id: 'agent-riverbend', name: 'Riverbend Bot', kind: 'agent' };

  it("records a person's proven address and no approver for an agent", () => {
    expect(approverOf(PERSON, 'alice@harborlight.example')).toEqual({
      id: 'user-abc',
      email: 'alice@harborlight.example',
    });
    expect(approverOf(AGENT, 'alice@harborlight.example')).toBeUndefined();
    expect(approvalLine('Alice', approverOf(PERSON, undefined), Date.UTC(2026, 9, 29))).toBe(
      'Approved by Alice on the board, 2026-10-29.',
    );
  });

  it('takes the address only from a proof naming the author', () => {
    const proof = () => ({ id: 'user-abc', email: 'alice@harborlight.example' });
    expect(provenEmailFor(proof, 'user-abc')).toBe('alice@harborlight.example');
    expect(provenEmailFor(proof, 'user-other')).toBeUndefined();
    expect(provenEmailFor(undefined, 'user-abc')).toBeUndefined();
  });

  it('needs a proven owner AND the board page itself for owner proof', () => {
    const req = (headers: Record<string, string>) => new Request('http://x/', { headers });
    const origin = () => 'https://workspaces.harborlight.test';
    const page = { origin: origin(), 'sec-fetch-site': 'same-origin' };
    expect(hasOwnerProof(req(page), () => null, origin)).toBe(false);
    expect(hasOwnerProof(req(page), undefined, origin)).toBe(false);
    expect(hasOwnerProof(req({ 'sec-fetch-site': 'same-origin' }), () => null, origin)).toBe(false);
  });
});
