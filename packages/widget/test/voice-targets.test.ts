import { afterEach, describe, expect, it } from 'vitest';
import { collectTargets } from '../src/voice/voice-targets.ts';

/**
 * The page described in words for the server to pick from. happy-dom lays
 * nothing out, so every element measures zero; the tests pass their own
 * `shown` rather than the default, which reads layout.
 */

const all = () => true;

function page(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

const byId = (id: string) => document.getElementById(id) as HTMLElement;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the page’s catalog', () => {
  it('keeps an element’s number when something is inserted before it', () => {
    const root = page('<main><button id="done">Done</button><p id="note">Ship it</p></main>');
    const ids = new Map<Element, number>();
    const first = collectTargets(root, all, ids);
    const doneAt = first.targets.find((t) => t.text === 'Done')?.i;
    const noteAt = first.targets.find((t) => t.text === 'Ship it')?.i;
    expect(doneAt).toBeTypeOf('number');
    expect(noteAt).toBeTypeOf('number');

    const blocked = document.createElement('button');
    blocked.textContent = 'Blocked';
    byId('done').before(blocked);
    const second = collectTargets(root, all, ids);
    expect(second.targets.find((t) => t.text === 'Done')?.i).toBe(doneAt);
    expect(second.targets.find((t) => t.text === 'Ship it')?.i).toBe(noteAt);
    const newAt = second.targets.find((t) => t.text === 'Blocked')?.i;
    expect(newAt, 'the newcomer takes the next number, not a used one').toBe(2);
    expect(second.elements.get(doneAt as number)).toBe(byId('done'));
    expect(second.elements.get(newAt as number)).toBe(blocked);
  });

  it('CONTROL: without the recording’s numbering, the numbers follow position', () => {
    const root = page('<main><button id="done">Done</button><p>Ship it</p></main>');
    const doneAt = collectTargets(root, all).targets.find((t) => t.text === 'Done')?.i;
    const blocked = document.createElement('button');
    blocked.textContent = 'Blocked';
    byId('done').before(blocked);
    expect(collectTargets(root, all).targets.find((t) => t.text === 'Done')?.i).not.toBe(doneAt);
  });

  it('links each target to the nearest enclosing target', () => {
    const root = page(
      '<section id="tasks" aria-label="Tasks"><div><div><li id="t1"><span class="chip">Blocked</span></li></div></div></section>',
    );
    const { targets, elements } = collectTargets(root, all);
    const at = (el: HTMLElement) => [...elements].find(([, e]) => e === el)?.[0];
    const section = at(byId('tasks'));
    const li = at(byId('t1'));
    const chip = targets.find((t) => t.hint === '.chip');
    expect(targets.find((t) => t.i === section)?.parent).toBeUndefined();
    expect(targets.find((t) => t.i === li)?.parent, 'across the wrappers between them').toBe(
      section,
    );
    expect(chip?.parent).toBe(li);
  });

  it('collapses a wrapper with nothing of its own into its child', () => {
    const root = page('<div><div><div><span>Hello</span></div></div></div>');
    const { targets } = collectTargets(root, all);
    expect(targets).toEqual([{ i: 0, tag: 'span', text: 'Hello' }]);
  });

  it('CONTROL: a wrapper that names itself is kept', () => {
    const root = page('<div class="goal"><span>Hello</span></div>');
    const { targets } = collectTargets(root, all);
    expect(targets.map((t) => t.tag)).toEqual(['div', 'span']);
    expect(targets[0]).toMatchObject({ hint: '.goal', text: 'Hello' });
  });

  it('leaves out the widget’s own chrome', () => {
    const root = page(
      '<button>Page button</button>' +
        '<div data-feedback-widget><button>Widget button</button></div>' +
        '<claude-feedback-widget><button>Also widget</button></claude-feedback-widget>',
    );
    const texts = collectTargets(root, all).targets.map((t) => t.text);
    expect(texts).toEqual(['Page button']);
  });

  it('leaves out what is not shown, and everything inside it', () => {
    const root = page(
      '<nav id="hidden"><button>Inside hidden</button></nav><button id="seen">Seen</button>',
    );
    const shown = (el: HTMLElement) => el.id !== 'hidden';
    expect(collectTargets(root, shown).targets.map((t) => t.text)).toEqual(['Seen']);
  });

  it('describes an element by its words, its label and its own vocabulary', () => {
    const root = page(
      '<button id="save" class="primary sc-bdf123 a__b cfw-pin" aria-label="Save the draft">  Save\n  now </button>' +
        '<input placeholder="Search tasks">',
    );
    const { targets } = collectTargets(root, all);
    expect(targets[0]).toEqual({
      i: 0,
      tag: 'button',
      text: 'Save now',
      label: 'Save the draft',
      // Generated class names say nothing a person would.
      hint: '#save .primary',
    });
    expect(targets[1]).toEqual({ i: 1, tag: 'input', text: '', label: 'Search tasks' });
  });

  it('keeps a space between the words of neighbouring cells', () => {
    const root = page(
      '<section><h3>Saltmarsh budget</h3><dl><dt>Design</dt><dd>$12,000</dd></dl></section>',
    );
    const { targets } = collectTargets(root, () => true);
    expect(targets.find((x) => x.tag === 'section')?.text).toBe('Saltmarsh budget Design $12,000');
  });

  it('leaves out a generated class name of the shape its own docs give (`css-1x9f2`)', () => {
    const root = page('<button class="primary css-1x9f2">Save</button>');
    expect(collectTargets(root, all).targets[0]?.hint).toBe('.primary');
  });

  it('skips scripts and styles', () => {
    const root = page('<script>var x = 1</script><style>p{}</style><p>Words</p>');
    expect(collectTargets(root, all).targets.map((t) => t.tag)).toEqual(['p']);
  });
});
