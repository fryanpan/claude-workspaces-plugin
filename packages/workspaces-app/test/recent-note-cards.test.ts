import { afterEach, describe, expect, it } from 'vitest';
import { MountScope } from '../src/mount-scope.ts';
import {
  mountRecentNoteCards,
  noteAgeText,
  noteCardOpacity,
  noteCardText,
} from '../src/recent-note-cards.ts';

/**
 * The note-provenance card: who wrote the block the tint is on, and how long
 * ago. The clock is injected, so nothing here waits on a real one.
 */

describe('the age text', () => {
  it('steps once every fifteen seconds — never a per-second counter', () => {
    expect(noteAgeText(0)).toBe('just now');
    expect(noteAgeText(14_999)).toBe('just now');
    expect(noteAgeText(15_000)).toBe('15s ago');
    expect(noteAgeText(29_999)).toBe('15s ago');
    expect(noteAgeText(30_000)).toBe('30s ago');
    expect(noteAgeText(60_000)).toBe('1m ago');
    expect(noteAgeText(75_000)).toBe('1m 15s ago');
    expect(noteAgeText(119_000)).toBe('1m 45s ago');
  });

  it('names the agent that wrote them', () => {
    expect(noteCardText('Notes', 30_000)).toBe('Notes agent added notes 30s ago');
  });
});

describe('the fade', () => {
  it('is whole until ninety seconds and gone at two minutes', () => {
    expect(noteCardOpacity(0)).toBe(1);
    expect(noteCardOpacity(90_000)).toBe(1);
    expect(noteCardOpacity(105_000)).toBeCloseTo(0.5, 3);
    expect(noteCardOpacity(120_000)).toBe(0);
    expect(noteCardOpacity(200_000)).toBe(0);
  });
});

// --- the mount -------------------------------------------------------------

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  document.body.replaceChildren();
});

const T0 = 1_700_000_000_000;

function harness(ats: number[], opts: { visible?: boolean } = {}) {
  const prose = document.createElement('div');
  for (const at of ats) {
    const block = document.createElement('p');
    block.className = 'recent-note';
    block.setAttribute('data-at', String(at));
    prose.appendChild(block);
  }
  document.body.appendChild(prose);
  const scope = new MountScope();
  let now = T0;
  const changes: number[] = [];
  const handle = mountRecentNoteCards({
    prose,
    visible: () => opts.visible !== false,
    now: () => now,
    onChange: () => changes.push(now),
    scope,
    // No interval of its own: every test drives `tick` itself.
    tickMs: 0,
  });
  cleanups.push(() => scope.dispose());
  return {
    prose,
    handle,
    changes,
    at(t: number) {
      now = T0 + t;
      handle.tick();
    },
  };
}

const lines = (card: HTMLElement) =>
  Array.from(card.querySelectorAll('.mn-line')).map((l) => l.textContent);

describe('mountRecentNoteCards', () => {
  it('gives every freshly written block a card that names who wrote it', () => {
    const h = harness([T0]);
    const cards = h.handle.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0].el.textContent).toBe('Notes agent added notes just now');
    // Anchored to the block it is about, so the column can sit it level.
    expect(cards[0].anchor).toBe(h.prose.querySelector('.recent-note'));
  });

  it('crossfades the age rather than jumping: both texts are on screen together', () => {
    const h = harness([T0]);
    const card = h.handle.cards()[0].el;
    h.at(5_000);
    // Inside the step — nothing moved.
    expect(lines(card)).toEqual(['Notes agent added notes just now']);
    h.at(15_000);
    expect(lines(card)).toEqual([
      'Notes agent added notes just now',
      'Notes agent added notes 15s ago',
    ]);
    expect(card.querySelector('.mn-line.is-out')?.textContent).toBe(
      'Notes agent added notes just now',
    );
    // …and the spent layer is dropped once the second is up.
    h.at(16_100);
    expect(lines(card)).toEqual(['Notes agent added notes 15s ago']);
  });

  it('recedes from ninety seconds and is gone at two minutes', () => {
    const h = harness([T0]);
    h.at(90_000);
    expect(h.handle.cards()[0].el.style.opacity).toBe('1.000');
    h.at(105_000);
    expect(Number(h.handle.cards()[0].el.style.opacity)).toBeCloseTo(0.5, 2);
    h.at(120_000);
    expect(h.handle.cards()).toHaveLength(0);
    expect(h.prose.querySelector('.margin-note')).toBe(null);
  });

  it('renders no card at all where there is no balloon column (the phone)', () => {
    const h = harness([T0], { visible: false });
    expect(h.handle.cards()).toHaveLength(0);
  });

  it('tells the column to lay out again when the card set changes, and not otherwise', () => {
    const h = harness([T0]);
    expect(h.changes).toHaveLength(1);
    h.at(15_000);
    // A text step is not a set change: the column has nothing to re-place.
    expect(h.changes).toHaveLength(1);
    h.at(120_000);
    expect(h.changes).toHaveLength(2);
  });
});
