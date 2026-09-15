/**
 * The size choice: off unless a browser turns choose-difficulty on, and when
 * on, the stored choice wins over Hard and outlives the page. Fixtures are
 * invented.
 */
import type { ReviewSize } from '@claude-workspaces/core';
import { describe, expect, it, vi } from 'vitest';
import type { BootStorage } from '../src/boot-env.ts';
import {
  CHOOSE_DIFFICULTY_FLAG_KEY,
  SIZE_PREF_KEY,
  type SizePrefRemote,
  chooseDifficultyOn,
  createSizeChoice,
  readSizePref,
  writeSizePref,
} from '../src/review-sizes.ts';

function memory(): BootStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

/** The account's stored choice, answered when the test says so. */
function account(stored: ReviewSize | null = null) {
  let answer: (size: ReviewSize | null) => void = () => {};
  const loaded = new Promise<ReviewSize | null>((resolve) => {
    answer = resolve;
  });
  const saved: ReviewSize[] = [];
  const remote: SizePrefRemote = {
    load: () => loaded,
    save: async (size) => {
      saved.push(size);
    },
  };
  return { remote, saved, answer: () => answer(stored) };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

const blocked: BootStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('the stored size choice', () => {
  it('starts on Hard, keeps what was chosen, and survives blocked storage', () => {
    const store = memory();
    expect(readSizePref(store)).toBe('hard');
    writeSizePref(store, 'medium');
    expect(readSizePref(store)).toBe('medium');
    store.data.set(SIZE_PREF_KEY, 'enormous');
    expect(readSizePref(store)).toBe('hard');
    expect(readSizePref(blocked)).toBe('hard');
    expect(() => writeSizePref(blocked, 'easy')).not.toThrow();
  });

  it('is behind a flag that is off unless this browser turned it on', () => {
    const store = memory();
    expect(chooseDifficultyOn(store)).toBe(false);
    store.data.set(CHOOSE_DIFFICULTY_FLAG_KEY, 'true');
    expect(chooseDifficultyOn(store)).toBe(false);
    store.data.set(CHOOSE_DIFFICULTY_FLAG_KEY, 'on');
    expect(chooseDifficultyOn(store)).toBe(true);
    expect(chooseDifficultyOn(blocked)).toBe(false);
  });
});

describe('the choice follows the signed-in person', () => {
  it('paints the cache first, then takes the account’s choice when it answers', async () => {
    const store = memory();
    store.data.set(SIZE_PREF_KEY, 'hard');
    const acct = account('easy');
    const onChange = vi.fn();
    const choice = createSizeChoice(store, acct.remote, onChange);
    expect(choice.level()).toBe('hard');
    acct.answer();
    await settle();
    expect(onChange).toHaveBeenCalledWith('easy');
    expect(choice.level()).toBe('easy');
    // The cache now holds the account's choice for the next paint.
    expect(store.data.get(SIZE_PREF_KEY)).toBe('easy');
  });

  it('saves a pick to the account, and a pick made before the account answers wins', async () => {
    const store = memory();
    const acct = account('easy');
    const onChange = vi.fn();
    const choice = createSizeChoice(store, acct.remote, onChange);
    choice.pick('medium');
    expect(acct.saved).toEqual(['medium']);
    acct.answer();
    await settle();
    expect(onChange).not.toHaveBeenCalled();
    expect(choice.level()).toBe('medium');
    expect(store.data.get(SIZE_PREF_KEY)).toBe('medium');
  });
});
