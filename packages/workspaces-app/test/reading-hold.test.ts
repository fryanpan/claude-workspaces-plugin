import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MountScope } from '../src/mount-scope.ts';
import { mountReadingHold } from '../src/reading-hold.ts';

/**
 * WHICH BLOCKS THE HOLD IS STILL WATCHING after the doc has been rewritten
 * under it.
 *
 * The hold corrects from two signals: a mutation, and a resize. The resize
 * half is a `ResizeObserver` over the blocks, and its membership is state the
 * module carries across ticks — so a block the editor takes out and puts back
 * is the case where that state can go wrong silently: the correction simply
 * stops arriving for that block, with nothing to see in the DOM.
 *
 * The geometry half of the hold is measured in a real browser, where rects
 * exist (`comments-in-view.test.ts`, five arms at both widths). happy-dom lays
 * nothing out, so what is worth asking here is the part that is not geometry:
 * membership. A recording `ResizeObserver` stands in for the browser's, which
 * is the only way to ask it.
 */

interface FakeObserver {
  watching: () => Element[];
  fire: () => void;
}

let observers: FakeObserver[] = [];
let realResizeObserver: typeof ResizeObserver;

beforeEach(() => {
  observers = [];
  realResizeObserver = globalThis.ResizeObserver;
  class Recording {
    private readonly targets = new Set<Element>();
    constructor(private readonly cb: () => void) {
      observers.push({ watching: () => [...this.targets], fire: () => this.cb() });
    }
    observe(el: Element): void {
      this.targets.add(el);
    }
    unobserve(el: Element): void {
      this.targets.delete(el);
    }
    disconnect(): void {
      this.targets.clear();
    }
  }
  globalThis.ResizeObserver = Recording as unknown as typeof ResizeObserver;
  document.body.innerHTML = `
    <div id="pane">
      <div id="prose">
        <p id="a">Alpha</p>
        <p id="b">Bravo</p>
      </div>
    </div>`;
});

afterEach(() => {
  globalThis.ResizeObserver = realResizeObserver;
  document.body.innerHTML = '';
});

const pane = () => document.getElementById('pane') as HTMLElement;
const watching = () => observers[0]?.watching().map((el) => el.id) ?? [];

function mount(): MountScope {
  const scope = new MountScope();
  mountReadingHold({ scroller: pane(), scope });
  return scope;
}

describe('the hold watches the blocks a tick rewrites', () => {
  it('watches every block in the pane from the moment it mounts', () => {
    mount();
    expect(watching()).toEqual(['a', 'b']);
  });

  it('re-watches a block the editor took out and put back', async () => {
    mount();
    const prose = document.getElementById('prose') as HTMLElement;
    const b = document.getElementById('b') as HTMLElement;

    // The shape a tick leaves behind: ProseMirror lifts an element out and
    // re-inserts the same node — grouping a topic in place does exactly this.
    // Watched-but-not-observed would leave that block's growth uncorrected
    // for the rest of the meeting.
    b.remove();
    await vi.waitFor(() => expect(watching()).toEqual(['a']));
    prose.append(b);
    await vi.waitFor(() => expect(watching()).toEqual(['a', 'b']));
  });

  it('lets go of a block the tick removed for good', async () => {
    mount();
    const b = document.getElementById('b') as HTMLElement;
    b.remove();
    // A `ResizeObserver` holds its targets: a doc open all meeting would
    // otherwise accumulate every block the transcript ever replaced.
    await vi.waitFor(() => expect(watching()).toEqual(['a']));
  });

  it('watches a block the tick added', async () => {
    mount();
    const prose = document.getElementById('prose') as HTMLElement;
    const note = document.createElement('p');
    note.id = 'note';
    note.textContent = 'Note: the meeting wrote this';
    prose.append(note);
    await vi.waitFor(() => expect(watching()).toEqual(['a', 'b', 'note']));
  });

  it('stops watching anything once the surface is torn down', async () => {
    const scope = mount();
    scope.dispose();
    expect(watching()).toEqual([]);
  });

  it('gives the pane its scroll anchoring back on teardown', () => {
    // The hold opts the scroller out of the browser's own anchoring while it
    // is the one holding the line; a surface that replaces it must not find
    // the opt-out still in force.
    const scope = mount();
    expect(pane().style.overflowAnchor).toBe('none');
    scope.dispose();
    expect(pane().style.overflowAnchor).toBe('');
  });
});
