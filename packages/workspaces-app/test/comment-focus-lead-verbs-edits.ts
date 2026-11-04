/**
 * The edits `comment-focus-lead-verbs-driver.ts` sends, in order, through the
 * REST routes the MCP edit tools call. Each one names the marker that says it
 * reached the page.
 */
import type { LeadVerbStep } from './comment-focus-lead-verbs-reading.ts';
import { FILLER } from './comment-focus-remote-edit-page.ts';

export const AGENT = { id: 'agent-harborlight', name: 'Harborlight notes', kind: 'agent' };
const SUGGESTER = { id: AGENT.id, name: AGENT.name, color: '#aa5500' };

export interface LeadEditServer {
  base: string;
  ws: string;
  post: (path: string, payload: unknown) => Promise<Record<string, unknown>>;
}

export interface LeadEdit {
  where: LeadVerbStep['where'];
  run: () => Promise<unknown>;
  landed: () => Promise<true | null>;
  /** Scroll the commented words off the top of the screen first. */
  scrollAway?: boolean;
}

export function leadEdits(
  s: LeadEditServer,
  docId: string,
  evaluate: (expr: string) => Promise<unknown>,
): LeadEdit[] {
  const doc = `/workspaces/${s.ws}/docs/${docId}`;
  const pageHas = (marker: string) => async () =>
    (await evaluate(
      `document.querySelector('#editor .ProseMirror').textContent.includes(${JSON.stringify(marker)})`,
    ))
      ? true
      : null;
  return [
    {
      where: 'far-paragraph',
      run: () =>
        s.post(`${doc}/find_and_replace`, {
          author: AGENT,
          find: 'commuters at dawn',
          contextBefore: 'Pier 6: The Riverbend crossing carries ',
          replace: 'commuters, cyclists and the Harborlight post at dawn',
        }),
      landed: pageHas('cyclists and the Harborlight post'),
    },
    {
      where: 'table-row',
      run: () =>
        s.post(`${doc}/find_and_replace`, {
          author: AGENT,
          find: '| South | Winter |',
          replace: '| South | Winter, after the Saltmarsh survey |',
        }),
      landed: pageHas('after the Saltmarsh survey'),
    },
    {
      // A lead reads the outline for block ids first. That first read is the
      // edit that matters: it gives every block its id in one update.
      where: 'replace-block',
      run: async () => {
        const outline = (await (await fetch(`${s.base}${doc}/outline`)).json()) as {
          blocks?: Array<{ id: string; text?: string; preview?: string }>;
        };
        const blk = (outline.blocks ?? []).find((x) =>
          (x.text ?? x.preview ?? '').startsWith('Pier 20:'),
        );
        if (!blk) throw new Error('no Pier 20 block in the outline');
        return s.post(`${doc}/block_edits`, {
          author: SUGGESTER,
          edits: [
            {
              op: 'replace_block',
              blockId: blk.id,
              markdown: `Pier 20: Riverbend rebuilt pier 20. ${FILLER}`,
            },
          ],
        });
      },
      landed: pageHas('Riverbend rebuilt pier 20'),
    },
    {
      where: 'suggest',
      run: () =>
        s.post(`${doc}/find_and_replace`, {
          find: 'freight at noon',
          contextBefore: 'Pier 11: The Riverbend crossing carries commuters at dawn and ',
          replace: 'freight at noon and the Saltmarsh mail at dusk',
          suggest: true,
          author: SUGGESTER,
        }),
      landed: pageHas('Saltmarsh mail at dusk'),
    },
    {
      where: 'accept-all',
      run: () => s.post(`${doc}/suggestions/resolve_all`, { action: 'accept' }),
      landed: async () =>
        (await evaluate(`!document.querySelector('#editor [data-cw-suggest]')`)) ? true : null,
    },
    {
      where: 'offscreen',
      scrollAway: true,
      run: () =>
        s.post(`${doc}/find_and_replace`, {
          author: AGENT,
          find: 'Pier 13: ',
          replace: `Pier 13: Harborlight lengthens pier 13. ${FILLER} `,
        }),
      landed: pageHas('Harborlight lengthens pier 13'),
    },
    {
      // What a lead does: read the doc's blocks, change one, write it all.
      // Confirmed, as a lead refused with 409 stale-write would retry: a
      // reader's word that leaked into the doc counts as a human edit, and
      // `leaked` is the reading that reports that, not this write.
      where: 'set-content',
      run: async () => {
        const got = (await (await fetch(`${s.base}${doc}/content`)).json()) as {
          blocks: Array<{ text: string }>;
        };
        const md = got.blocks.map((b) => b.text).join('\n\n');
        return s.post(`${doc}/content`, {
          author: AGENT,
          confirmOverwriteHumanEdits: true,
          markdown: md.replace('Pier 22: ', `Pier 22: Bob rewrote pier 22. ${FILLER} `),
        });
      },
      landed: pageHas('Bob rewrote pier 22'),
    },
  ];
}
