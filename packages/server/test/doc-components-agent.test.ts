/**
 * The agent half of components, without a server: a tag's name from its
 * file, a prop value that could end the attribute written as JSON instead,
 * and an existing import's name reused.
 */
import { describe, expect, it } from 'bun:test';
import type { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { nameFromPath, placeComponent } from '../src/doc-components-agent.ts';
import type { LiveDoc } from '../src/doc-store.ts';

const WHO = { author: 'agent-riverbend', authorName: 'Riverbend Bot' };

/** Place on an empty doc and hand back the markdown the edit would insert. */
async function placed(req: Parameters<typeof placeComponent>[1]): Promise<string> {
  let markdown = '';
  const res = await placeComponent({ ydoc: new Y.Doc() } as unknown as LiveDoc, req, WHO, {
    boundPath: '/r/harborlight/post.mdx',
    applyBlockEdits: (edits: prose.BlockEdit[]) => {
      markdown = (edits[0] as { markdown: string }).markdown;
      return {
        ok: true,
        applied: 1,
        suggested: 0,
        failed: 0,
        outcomes: [{ status: 'applied' }],
      } as never;
    },
    refresh: async () => {},
  });
  expect(res.ok).toBe(true);
  return markdown;
}

describe('placing a component', () => {
  it('names the tag from its file', () => {
    expect(nameFromPath('./map/index.ts')).toBe('Map');
    expect(nameFromPath('./components/pin-list.tsx')).toBe('PinList');
    expect(nameFromPath('https://esm.sh/tide-chart@1.2.3')).toBe('TideChart');
    expect(nameFromPath('./9.ts')).toBe('Component');
  });

  it('writes a plain string in quotes, and anything that could end the attribute as JSON', async () => {
    const md = await placed({
      importPath: './map/index.ts',
      props: {
        id: 'ferry',
        label: 'Saltmarsh pier',
        quote: 'Bob said "go" />',
        line: 'a\rb',
        amp: 'Alice &amp; Bob',
        zoom: 12,
      },
    });
    expect(md).toBe(
      `import Map from './map/index.ts'\n\n<Map id="ferry" label="Saltmarsh pier" quote={"Bob said \\"go\\" />"} line={"a\\rb"} amp={"Alice &amp; Bob"} zoom={12} />`,
    );
  });
});
