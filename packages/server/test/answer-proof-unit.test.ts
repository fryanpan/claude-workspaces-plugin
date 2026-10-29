/**
 * `review-items/answer-proof.ts` on its own: which authors need a proof, and
 * which proofs count. The routes are `answer-proof.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import type { User } from '@claude-workspaces/core';
import type { IdentityRecord } from '../src/identities.ts';
import {
  type AnswerProofInputs,
  answersAsPerson,
  unprovenPersonAnswer,
} from '../src/review-items/answer-proof.ts';

const ORIGIN = 'https://workspaces.harborlight.test';
const ALICE = { id: 'user-alice', displayName: 'Alice' } as IdentityRecord;
const BOB = { id: 'user-bob', displayName: 'Bob' } as IdentityRecord;
const asAlice: User = { id: 'user-alice', name: 'Alice', kind: 'known', color: '#2e7dd7' };

const inputs = (o: {
  proven?: IdentityRecord | null;
  widget?: IdentityRecord | null;
  headers?: Record<string, string>;
}): AnswerProofInputs => ({
  req: new Request(`${ORIGIN}/x`, { method: 'POST', headers: o.headers ?? {} }),
  provenIdentityFor: () => o.proven ?? null,
  widgetIdentity: o.widget ?? null,
  requestOrigin: () => ORIGIN,
});
const SAME = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };

describe('who needs a proof', () => {
  it('a person, and the owner id whatever kind it claims', () => {
    expect(answersAsPerson(asAlice)).toBe(true);
    expect(answersAsPerson({ id: 'known-bryan', name: 'Bryan', kind: 'agent' })).toBe(true);
    expect(answersAsPerson({ id: 'known-bryan', name: 'Bryan' })).toBe(true);
    expect(answersAsPerson({ id: 'agent-riverbend', name: 'Riverbend Bot', kind: 'agent' })).toBe(
      false,
    );
  });

  it('an agent answers with no proof at all', () => {
    const agent = {
      id: 'agent-riverbend',
      name: 'Riverbend Bot',
      kind: 'agent',
    } as unknown as User;
    expect(unprovenPersonAnswer(agent, undefined)).toBe(false);
  });
});

describe('which proofs count', () => {
  it('a session naming the author, sent same-origin', () => {
    expect(unprovenPersonAnswer(asAlice, inputs({ proven: ALICE, headers: SAME }))).toBe(false);
  });

  it('not the same session without the same-origin marks, or from another origin', () => {
    expect(unprovenPersonAnswer(asAlice, inputs({ proven: ALICE }))).toBe(true);
    expect(
      unprovenPersonAnswer(
        asAlice,
        inputs({
          proven: ALICE,
          headers: { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' },
        }),
      ),
    ).toBe(true);
  });

  it('not a session naming somebody else', () => {
    expect(unprovenPersonAnswer(asAlice, inputs({ proven: BOB, headers: SAME }))).toBe(true);
  });

  it('a widget token naming the author, from its own page origin', () => {
    expect(unprovenPersonAnswer(asAlice, inputs({ widget: ALICE }))).toBe(false);
    expect(unprovenPersonAnswer(asAlice, inputs({ widget: BOB }))).toBe(true);
  });

  it('nothing wired fails closed', () => {
    expect(unprovenPersonAnswer(asAlice, undefined)).toBe(true);
  });
});
