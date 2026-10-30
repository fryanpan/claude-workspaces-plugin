import { prose } from '@claude-workspaces/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  type LiveRedlineSurface,
  createLiveRedlineEditor,
} from '../src/redline/live-redline-editor.ts';

/**
 * Lists in the editable redline. A list is one markdown block, so one edited
 * bullet word-diffs the whole list, and the diff's words are found in the
 * rendered text by search. Inline code followed by a comma never matched, the
 * search stopped there, and the next insertion's first word ("and") matched in
 * an unchanged bullet above, marking every bullet between the two.
 */

const open: Array<{ surface: LiveRedlineSurface; parent: HTMLElement }> = [];
afterEach(() => {
  for (const o of open.splice(0)) {
    o.surface.destroy();
    o.parent.remove();
  }
});

function mount(baseText: string, md: string) {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(md));
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const surface = createLiveRedlineEditor({
    parent,
    ydoc,
    awareness: new Awareness(ydoc),
    baseText,
    isAdded: false,
    debounceMs: 0,
  });
  open.push({ surface, parent });
  return { parent, surface };
}

const tick = () => new Promise((r) => setTimeout(r, 25));

/** The text of every list item that carries an insertion mark. */
const markedItems = (parent: HTMLElement): string[] =>
  Array.from(parent.querySelectorAll('li'))
    .filter((li) => li.querySelector('ins.cw-ins'))
    .map((li) => {
      const copy = li.cloneNode(true) as HTMLElement;
      for (const chip of copy.querySelectorAll('.cw-del-chip')) chip.remove();
      return (copy.textContent ?? '').trim();
    });

const BULLETS = [
  'Harborlight opens the ferry office at seven, and the first boat leaves when the tide allows it to clear the bar. The harbour master posts the day on the board by the gate.',
  'Riverbend keeps the spare keys in the cabinet behind the counter. Anyone who takes one signs `keys.log`, and the log is checked at the end of the day.',
  'Saltmarsh handles the freight manifests for the afternoon crossings. The manifests go to the office before noon so the crew can plan the load.',
  'Alice reviews the [weather report](https://example.com/weather) with the skipper before each crossing. If the wind is over the limit the crossing waits, and `board.txt` says so.',
  'Bob runs the café on the upper deck and orders the stock on Mondays. The order goes in by noon so the van can bring it on the Tuesday boat.',
  'The ticket machine at the gate takes cards only. Cash goes to the office, where the clerk writes a paper ticket and logs it in the book.',
  'Lost property is held at the office for thirty days. After that it goes to the charity shop in Riverbend, and the book records where it went.',
  'The last boat of the day leaves at six in summer and at four in winter. The board by the gate shows the time, and the office closes when it leaves.',
];

const list = (items: string[]) => `${items.map((b) => `- ${b}`).join('\n')}\n`;

describe('live redline — lists', () => {
  it('a changed bullet leaves the bullet before it unmarked', async () => {
    const base = `# Ferry notes\n\n${list(BULLETS)}`;
    const items = [...BULLETS];
    items[4] = items[4].replace('the stock on Mondays', 'the stock and the milk on Mondays');
    const { parent } = mount(base, `# Ferry notes\n\n${list(items)}`);
    await tick();
    expect(Array.from(parent.querySelectorAll('ins.cw-ins')).map((e) => e.textContent)).toEqual([
      'and the milk',
    ]);
    expect(markedItems(parent)).toEqual([items[4]]);
  });

  it('a rewritten long bullet right after an unchanged one marks only the rewritten bullet', async () => {
    const base = `# Ferry notes\n\nThe office keeps these.\n\n${list(BULLETS)}\nAsk Bob if anything is unclear.\n`;
    const items = [...BULLETS];
    items[3] =
      'Alice and the skipper go over the weather report before the first crossing and again at noon. When the wind is over the limit the crossing waits, the office posts it, and the freight crew is told by the end of the day.';
    const { parent } = mount(
      base,
      `# Ferry notes\n\nThe office keeps these.\n\n${list(items)}\nAsk Bob if anything is unclear.\n`,
    );
    await tick();
    expect(markedItems(parent)).toEqual([items[3]]);
  });

  it('an added bullet is marked whole and nothing else is', async () => {
    const base = `Notes.\n\n${list(BULLETS)}`;
    const items = [...BULLETS];
    items.splice(5, 0, 'Saltmarsh and Riverbend share the van on Tuesdays.');
    const { parent, surface } = mount(base, `Notes.\n\n${list(items)}`);
    await tick();
    expect(markedItems(parent)).toEqual([items[5]]);
    expect(surface.getDeletions()).toEqual([]);
  });

  it('a removed bullet is one deletion at the bullet that follows it', async () => {
    const base = `Notes.\n\n${list(BULLETS)}`;
    const items = BULLETS.filter((_, i) => i !== 2);
    const { parent, surface } = mount(base, `Notes.\n\n${list(items)}`);
    await tick();
    expect(markedItems(parent)).toEqual([]);
    const dels = surface.getDeletions();
    expect(dels.map((d) => d.deletedMarkdown)).toEqual([`- ${BULLETS[2]}`]);
    const at = surface.handle.editor.state.doc.resolve(dels[0]?.pos ?? 0);
    expect(at.parent.textContent).toMatch(/^Alice reviews the weather report/);
  });

  it('an item inserted at the top of a numbered list leaves the renumbered items unmarked', async () => {
    const numbered = (xs: string[]) => `${xs.map((b, i) => `${i + 1}. ${b}`).join('\n')}\n`;
    const base = `Steps.\n\n${numbered(BULLETS.slice(0, 4))}`;
    const items = ['Bob unlocks the gate.', ...BULLETS.slice(0, 4)];
    const { parent } = mount(base, `Steps.\n\n${numbered(items)}`);
    await tick();
    expect(markedItems(parent)).toEqual(['Bob unlocks the gate.']);
  });

  it('inline code followed by a comma does not lose the place inside one paragraph', async () => {
    const base =
      'Sign `keys.log`, and check the [book](https://example.com/book). Then lock the door now.\n';
    const next = base.replace('the door now', 'the door and the gate now');
    const { parent } = mount(base, next);
    await tick();
    expect(Array.from(parent.querySelectorAll('ins.cw-ins')).map((e) => e.textContent)).toEqual([
      'and the gate',
    ]);
  });
});
