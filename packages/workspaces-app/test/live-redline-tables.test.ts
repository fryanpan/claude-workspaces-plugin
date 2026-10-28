import { prose } from '@claude-workspaces/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  type LiveRedlineSurface,
  createLiveRedlineEditor,
} from '../src/redline/live-redline-editor.ts';

/**
 * Pipe tables in the editable redline. The live doc is serialized by the
 * prose serializer, which pads every cell to its column width and rewrites
 * the delimiter row; a base file written by hand does neither. Diffed
 * against the raw base, every table read as deleted and re-added, so a diff
 * whose only change was one appended row painted every table green.
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

const marked = (parent: HTMLElement): string[] =>
  Array.from(parent.querySelectorAll('ins.cw-ins')).map((e) => (e.textContent ?? '').trim());

// Unpadded cells and an alignment row, the way a person writes a runbook.
const BASE = [
  '# Runbook',
  '',
  'Hosts we deploy to.',
  '',
  '| Host | Port |',
  '|---|---|',
  '| Harborlight | 80 |',
  '| Riverbend | 81 |',
  '',
  'Owners.',
  '',
  '| Team | Lead |',
  '| :--- | ---: |',
  '| Saltmarsh | Alice |',
  '| Riverbend | Bob |',
  '',
  '| Step | Command |',
  '|------|---------|',
  '| build | `bun run build` |',
  '',
  'Last checked by Bob.',
  '',
].join('\n');

describe('live redline — pipe tables', () => {
  it('an appended row marks only that row, even when it widens its column', async () => {
    const next = BASE.replace(
      '| Riverbend | 81 |\n',
      '| Riverbend | 81 |\n| Saltmarsh-north | 82 |\n',
    );
    const { parent, surface } = mount(BASE, next);
    await tick();
    expect(marked(parent)).toEqual(['Saltmarsh-north', '82']);
    expect(surface.getDeletions()).toEqual([]);
  });

  it('an edited cell marks only the new value', async () => {
    const next = BASE.replace('| Riverbend | 81 |', '| Riverbend | 8081 |');
    const { parent, surface } = mount(BASE, next);
    await tick();
    expect(marked(parent)).toEqual(['8081']);
    expect(surface.getDeletions().map((d) => d.deletedMarkdown.trim())).toEqual(['81']);
  });

  it('a removed row is one deletion at the row that follows it, with nothing marked', async () => {
    const next = BASE.replace('| Saltmarsh | Alice |\n', '');
    const { parent, surface } = mount(BASE, next);
    await tick();
    expect(marked(parent)).toEqual([]);
    const dels = surface.getDeletions();
    expect(dels.map((d) => d.deletedMarkdown.replace(/\s+/g, ' '))).toEqual([
      '| Saltmarsh | Alice |',
    ]);
    const at = surface.handle.editor.state.doc.resolve(dels[0]?.pos ?? 0);
    expect(at.parent.textContent).toBe('Riverbend');
  });

  it('a doc whose last block is a table still gets markup', async () => {
    // The editor appends an empty paragraph after a closing table that the
    // Yjs fragment never holds; the two block counts then disagree.
    const base = 'Ports.\n\n| Host | Port |\n|---|---|\n| Harborlight | 80 |\n';
    const next = base.replace('| 80 |', '| 80 |\n| Riverbend | 81 |');
    const { parent } = mount(base, next);
    await tick();
    expect(marked(parent)).toEqual(['Riverbend', '81']);
  });

  it('a paragraph added elsewhere leaves every table unmarked', async () => {
    const next = BASE.replace('Owners.\n', 'Owners.\n\nAsk before you page anyone.\n');
    const { parent, surface } = mount(BASE, next);
    await tick();
    expect(marked(parent)).toEqual(['Ask before you page anyone.']);
    expect(surface.getDeletions()).toEqual([]);
  });
});
