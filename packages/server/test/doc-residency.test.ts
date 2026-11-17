/**
 * The eviction windows on their own, with small limits so a cap of three is
 * a cap of three rather than five hundred docs of setup. The store-level
 * behaviour — a socket stamping the person clock, the holds still winning —
 * is in `doc-eviction.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { type ResidencyLimits, pastWindow, windowHolds } from '../src/doc-residency.ts';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const NOW = 100 * DAY;
const limits: ResidencyLimits = { personKeepMs: 7 * DAY, shortKeepMs: 30 * MIN, personKeepCap: 3 };

describe('pastWindow', () => {
  it('lets a doc only an agent reached go after the short window, not two days', () => {
    const entries = [
      { docId: 'riverbend-agent', lastReachedAt: NOW - 31 * MIN },
      { docId: 'saltmarsh-agent', lastReachedAt: NOW - 29 * MIN },
    ];
    expect(pastWindow(entries, NOW, limits)).toEqual(['riverbend-agent']);
  });

  it('keeps a doc a person opened for a week, and lets it go after', () => {
    const entries = [
      { docId: 'six-days', lastReachedAt: NOW - 6 * DAY, lastPersonAt: NOW - 6 * DAY },
      { docId: 'eight-days', lastReachedAt: NOW - 8 * DAY, lastPersonAt: NOW - 8 * DAY },
    ];
    expect(pastWindow(entries, NOW, limits)).toEqual(['eight-days']);
  });

  it('gives the week to the most recent person visits only, cap-many', () => {
    const entries = [1, 2, 3, 4, 5].map((d) => ({
      docId: `harborlight-${d}`,
      lastReachedAt: NOW - d * DAY,
      lastPersonAt: NOW - d * DAY,
    }));
    // Days 1-3 hold the week; 4 and 5 are past the short window and the cap.
    expect(pastWindow(entries, NOW, limits)).toEqual(['harborlight-4', 'harborlight-5']);
  });

  it('never evicts a doc reached inside the short window to satisfy the cap', () => {
    const entries = [1, 2, 3].map((d) => ({
      docId: `kept-${d}`,
      lastReachedAt: NOW - d * DAY,
      lastPersonAt: NOW - d * MIN,
    }));
    // Past the cap by person rank, but an agent read it five minutes ago.
    entries.push({
      docId: 'over-cap-fresh',
      lastReachedAt: NOW - 5 * MIN,
      lastPersonAt: NOW - DAY,
    });
    expect(pastWindow(entries, NOW, limits)).toEqual([]);
  });
});

describe('windowHolds', () => {
  it('names the window holding each doc, and leaves out the ones past both', () => {
    const entries = [
      { docId: 'riverbend-fresh', lastReachedAt: NOW - 5 * MIN },
      { docId: 'harborlight-person', lastReachedAt: NOW - 2 * DAY, lastPersonAt: NOW - 2 * DAY },
      { docId: 'saltmarsh-idle', lastReachedAt: NOW - 31 * MIN },
      // Both windows hold it; the short one is named, since it alone would.
      { docId: 'alice-both', lastReachedAt: NOW - MIN, lastPersonAt: NOW - MIN },
    ];
    expect(Object.fromEntries(windowHolds(entries, NOW, limits))).toEqual({
      'riverbend-fresh': 'short-window',
      'harborlight-person': 'person-window',
      'alice-both': 'short-window',
    });
    // The two answers are complements of each other.
    expect(pastWindow(entries, NOW, limits)).toEqual(['saltmarsh-idle']);
  });
});
