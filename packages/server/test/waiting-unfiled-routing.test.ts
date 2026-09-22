/**
 * Which rung of the unfiled-ask ladder a row belongs on.
 *
 * One bucket reaches this module — an agent saying in its closing words that
 * it waits on a person — so the only thing that moves a row down a rung is
 * the tell cap. `onlyAPersonCanEnd` and the board-declared bucket it read are
 * gone with the finding they routed (2026-09-22): a row nobody can act on is
 * not on this ladder at all.
 *
 * Fixtures are synthetic; the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { isDue, ownerBound, teamLeadCarry } from '../src/waiting-unfiled-routing.ts';

const MIN = 60_000;
const WINDOW = 30 * MIN;

const asked = (firstSeen = 0) => ({ id: 't-agent', firstSeen });

describe('when a row leaves the rung it is on', () => {
  it('is after a whole window, and not a minute of it', () => {
    // A finding that clears inside the window files nothing.
    expect(isDue(asked(0), MIN, WINDOW)).toBe(false);
    expect(isDue(asked(0), WINDOW + MIN, WINDOW)).toBe(true);
  });
});

describe('the split', () => {
  const due = [asked(), { id: 't-spent', firstSeen: 0 }];
  const tellsOf = (row: { id: string }) => (row.id === 't-spent' ? 3 : 0);

  it('carries only the rows with wakes left', () => {
    expect(teamLeadCarry(due, tellsOf, 3).map((r) => r.id)).toEqual(['t-agent']);
  });

  it('sends the spent row to the owner', () => {
    expect(ownerBound(due, tellsOf, 3).map((r) => r.id)).toEqual(['t-spent']);
  });

  it('never puts one row in both at the same reading', () => {
    const carry = new Set(teamLeadCarry(due, tellsOf, 3).map((r) => r.id));
    for (const row of ownerBound(due, tellsOf, 3)) expect(carry.has(row.id)).toBe(false);
  });

  it('keeps a row on Team Lead while it has wakes left, however many', () => {
    expect(teamLeadCarry([asked()], () => 0, 99)).toHaveLength(1);
    expect(ownerBound([asked()], () => 0, 99)).toHaveLength(0);
  });
});
