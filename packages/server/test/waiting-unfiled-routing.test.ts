/**
 * Which rung of the unfiled-ask ladder a row belongs on.
 *
 * The two buckets share a list and a remedy and part company only here, so
 * this is where the parting is pinned: an agent-declared wait climbs, and a
 * board-declared one goes straight to the person who owns it.
 *
 * Fixtures are synthetic; the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import {
  isDue,
  onlyAPersonCanEnd,
  ownerBound,
  teamLeadCarry,
} from '../src/waiting-unfiled-routing.ts';

const MIN = 60_000;
const WINDOW = 30 * MIN;

const owned = (firstSeen = 0) => ({ id: 't-owner', bucket: 'blocked-on-owner-unfiled', firstSeen });
const asked = (firstSeen = 0) => ({ id: 't-agent', bucket: 'waiting-unfiled', firstSeen });

describe('who can end the wait', () => {
  it('is a person alone when the BOARD says a person owns the row', () => {
    expect(onlyAPersonCanEnd(owned())).toBe(true);
  });

  it('is the agent when its own words are what said it was waiting', () => {
    expect(onlyAPersonCanEnd(asked())).toBe(false);
  });
});

describe('when a row leaves the rung it is on', () => {
  it('is after a whole window, whichever bucket put it on the list', () => {
    // The 2026-09-17 change moved where a due row goes, not when it is due: a
    // finding that clears inside the window still files nothing.
    expect(isDue(owned(0), MIN, WINDOW)).toBe(false);
    expect(isDue(asked(0), MIN, WINDOW)).toBe(false);
    expect(isDue(owned(0), WINDOW + MIN, WINDOW)).toBe(true);
    expect(isDue(asked(0), WINDOW + MIN, WINDOW)).toBe(true);
  });
});

describe('the split', () => {
  const due = [owned(), asked(), { id: 't-spent', bucket: 'waiting-unfiled', firstSeen: 0 }];
  const tellsOf = (row: { id: string }) => (row.id === 't-spent' ? 3 : 0);

  it('carries only rows an agent can end, with wakes left', () => {
    expect(teamLeadCarry(due, tellsOf, 3).map((r) => r.id)).toEqual(['t-agent']);
  });

  it('sends the person-blocked row and the spent one to the owner', () => {
    expect(ownerBound(due, tellsOf, 3).map((r) => r.id)).toEqual(['t-owner', 't-spent']);
  });

  it('never puts one row in both at the same reading', () => {
    const carry = new Set(teamLeadCarry(due, tellsOf, 3).map((r) => r.id));
    for (const row of ownerBound(due, tellsOf, 3)) expect(carry.has(row.id)).toBe(false);
  });

  it('keeps a person-blocked row off Team Lead however many wakes it has left', () => {
    // The cap is not what excuses it: an owner row with zero tells spent is
    // still nobody's to hand back.
    expect(teamLeadCarry([owned()], () => 0, 99)).toHaveLength(0);
    expect(ownerBound([owned()], () => 0, 99)).toHaveLength(1);
  });
});
