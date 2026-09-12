/**
 * The size choice and the all-workspaces review bar: the stored choice wins
 * over the server's Hard, the total follows the bar, and the choice outlives
 * the page. Fixtures are invented.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { BootStorage } from '../src/boot-env.ts';
import { wakeLandingReviewBar } from '../src/landing-review-bar.ts';
import { SIZE_PREF_KEY, paintFillBar, readSizePref, writeSizePref } from '../src/review-sizes.ts';

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

const blocked: BootStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

/** The bar as the server renders it: on Hard, with the full total. */
function landing(sizes: Array<[string, number]>): void {
  document.body.innerHTML = `
    <div class="allbar">
      <h2 class="alltitle">Review Items for You</h2>
      <span class="sizes-label" id="sizes-label">Choose what you have time for:</span>
      <div class="gorow">
        <div class="sizes review-sizes" role="radiogroup" aria-labelledby="sizes-label">
          <button type="button" class="board-tab filled" data-size="easy" role="radio" aria-checked="false">Easy <small>&lt; 1 min</small></button>
          <button type="button" class="board-tab filled" data-size="medium" role="radio" aria-checked="false">Medium <small>&lt; 5 min</small></button>
          <button type="button" class="board-tab filled board-tab-active" data-size="hard" role="radio" aria-checked="true">Hard <small>any</small></button>
        </div>
        <span class="est">Total estimated time: <span class="est-n" id="est">99</span> min</span>
        <a class="allgo" href="/reviews">Start review ›</a>
      </div>
    </div>
    <script type="application/json" id="review-sizes">${JSON.stringify(sizes)}</script>`;
}

const tab = (size: string) => document.querySelector(`[data-size="${size}"]`) as HTMLElement;
const est = () => (document.getElementById('est') as HTMLElement).textContent;
const go = () => document.querySelector('.allgo') as HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
});

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

  it('fills every stop up to the chosen one and checks only that one', () => {
    landing([]);
    const bar = document.querySelector('.review-sizes') as HTMLElement;
    paintFillBar(bar, 'medium');
    expect(['easy', 'medium', 'hard'].map((s) => tab(s).classList.contains('filled'))).toEqual([
      true,
      true,
      false,
    ]);
    expect(['easy', 'medium', 'hard'].map((s) => tab(s).getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    expect(tab('medium').classList.contains('board-tab-active')).toBe(true);
    expect(tab('hard').classList.contains('board-tab-active')).toBe(false);
  });
});

describe('the all-workspaces review bar', () => {
  const sizes: Array<[string, number]> = [
    ['easy', 1],
    ['medium', 3],
    ['hard', 9],
    ['easy', 1],
  ];

  it('repaints the stored choice and totals only what it lets through', () => {
    landing(sizes);
    const store = memory();
    store.data.set(SIZE_PREF_KEY, 'easy');
    wakeLandingReviewBar(document, store);
    expect(tab('easy').getAttribute('aria-checked')).toBe('true');
    expect(tab('medium').classList.contains('filled')).toBe(false);
    expect(est()).toBe('2');
    expect(go().hidden).toBe(false);
  });

  it('moves the total with a tap and remembers the tap', () => {
    landing(sizes);
    const store = memory();
    wakeLandingReviewBar(document, store);
    expect(est()).toBe('14');
    tab('medium').click();
    expect(est()).toBe('5');
    expect(store.data.get(SIZE_PREF_KEY)).toBe('medium');
    // The label around the number is the server's and stays put.
    expect((document.querySelector('.est') as HTMLElement).textContent).toBe(
      'Total estimated time: 5 min',
    );
  });

  it('hides Start review when the chosen size lets nothing through', () => {
    landing([['hard', 12]]);
    const store = memory();
    wakeLandingReviewBar(document, store);
    expect(go().hidden).toBe(false);
    tab('easy').click();
    expect(est()).toBe('0');
    expect(go().hidden).toBe(true);
  });
});
