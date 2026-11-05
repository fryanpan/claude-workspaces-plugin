/**
 * The edits `comment-focus-lead-verbs-driver.ts` sends, in order, through the
 * REST routes the MCP edit tools call: every edit verb a lead has. Each one
 * names the check that says it reached the page.
 *
 * The first is the outline read on a doc whose blocks have no ids yet. It
 * changes no words, and it is the edit that lost the reader's caret: the
 * read gives every block its id in one update (4 Nov).
 */
import type { LeadVerbStep } from './comment-focus-lead-verbs-reading.ts';
import { FILLER } from './comment-focus-remote-edit-page.ts';

export const AGENT = { id: 'agent-harborlight', name: 'Harborlight notes', kind: 'agent' };
const SUGGESTER = { id: AGENT.id, name: AGENT.name, color: '#aa5500' };
/**
 * Every scoped edit confirms, as a lead refused with 409 stale-write would
 * retry. A reader's key that leaked into the doc counts as a human edit; the
 * refusal would end the run, and `leaked` is the reading that reports it.
 */
const LEAD = { author: AGENT, confirmOverwriteHumanEdits: true };

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
  /** The reader keeps typing, one key at a time, while this edit lands. */
  typeThrough?: boolean;
}

interface OutlineBlock {
  id: string;
  text?: string;
  preview?: string;
}

export function leadEdits(
  s: LeadEditServer,
  docId: string,
  aboveThread: string,
  evaluate: (expr: string) => Promise<unknown>,
): LeadEdit[] {
  const doc = `/workspaces/${s.ws}/docs/${docId}`;
  const yes = (v: unknown): true | null => (v ? true : null);
  const prose = `document.querySelector('#editor .ProseMirror').textContent`;
  const pageHas = (marker: string) => async () =>
    yes(await evaluate(`${prose}.includes(${JSON.stringify(marker)})`));
  const pageLacks = (marker: string) => async () =>
    yes(await evaluate(`!${prose}.includes(${JSON.stringify(marker)})`));
  const outline = async (): Promise<OutlineBlock[]> =>
    ((await (await fetch(`${s.base}${doc}/outline`)).json()) as { blocks?: OutlineBlock[] })
      .blocks ?? [];
  const blockId = async (startsWith: string): Promise<string> => {
    const blk = (await outline()).find((x) => (x.text ?? x.preview ?? '').startsWith(startsWith));
    if (!blk) throw new Error(`no "${startsWith}" block in the outline`);
    return blk.id;
  };
  const anchor = async (find: string): Promise<string> =>
    String((await s.post(`${doc}/agent_anchors`, { find })).anchorId);
  const blockEdit = async (edit: Record<string, unknown>) =>
    s.post(`${doc}/block_edits`, { author: SUGGESTER, edits: [edit] });
  const added = (what: string) => `${what} ${FILLER}`;
  return [
    {
      where: 'outline-first',
      run: outline,
      landed: async () =>
        yes(
          await evaluate(
            `!!document.querySelector('#editor .ProseMirror').editor.state.doc.firstChild.attrs.cwId`,
          ),
        ),
    },
    {
      where: 'far-paragraph',
      run: () =>
        s.post(`${doc}/find_and_replace`, {
          ...LEAD,
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
          ...LEAD,
          find: '| South | Winter |',
          replace: '| South | Winter, after the Saltmarsh survey |',
        }),
      landed: pageHas('after the Saltmarsh survey'),
    },
    {
      // Above the commented words: the thread on the north berth.
      where: 'after-thread',
      run: () =>
        s.post(`${doc}/threads/${encodeURIComponent(aboveThread)}/insert_blocks_after`, {
          ...LEAD,
          markdown: added('Harborlight adds a north berth note.'),
        }),
      landed: pageHas('Harborlight adds a north berth note.'),
    },
    {
      where: 'at-anchor',
      run: async () =>
        s.post(
          `${doc}/agent_anchors/${encodeURIComponent(await anchor('Pier 17: '))}/insert_blocks`,
          {
            ...LEAD,
            markdown: added('Riverbend adds a pier 17 note.'),
          },
        ),
      landed: pageHas('Riverbend adds a pier 17 note.'),
    },
    {
      where: 'under-heading',
      run: async () =>
        blockEdit({
          op: 'insert_under_heading',
          headingId: await blockId('South piers'),
          markdown: added('Saltmarsh adds a south piers note.'),
        }),
      landed: pageHas('Saltmarsh adds a south piers note.'),
    },
    {
      where: 'at-end',
      run: () => blockEdit({ op: 'insert_at_end', markdown: added('Bob adds a closing note.') }),
      landed: pageHas('Bob adds a closing note.'),
    },
    {
      where: 'replace-block',
      run: async () =>
        blockEdit({
          op: 'replace_block',
          blockId: await blockId('Pier 20:'),
          markdown: added('Pier 20: Riverbend rebuilt pier 20.'),
        }),
      landed: pageHas('Riverbend rebuilt pier 20'),
    },
    {
      where: 'delete-block',
      // The lead's own block: on a person's, a delete is filed as a suggestion.
      run: async () =>
        blockEdit({ op: 'delete_block', blockId: await blockId('Bob adds a closing note.') }),
      landed: pageLacks('Bob adds a closing note.'),
    },
    {
      where: 'suggest',
      typeThrough: true,
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
      typeThrough: true,
      run: () => s.post(`${doc}/suggestions/resolve_all`, { action: 'accept' }),
      landed: async () =>
        yes(await evaluate(`!document.querySelector('#editor [data-cw-suggest]')`)),
    },
    {
      where: 'delete-at-anchor',
      run: async () =>
        s.post(`${doc}/delete_block_at_anchor`, {
          ...LEAD,
          anchorId: await anchor('Pier 23: '),
        }),
      landed: pageLacks('Pier 23:'),
    },
    {
      where: 'delete-range',
      run: () =>
        s.post(`${doc}/delete_blocks_in_range`, {
          ...LEAD,
          startFind: 'Pier 25: ',
          endFind: 'Pier 26: ',
        }),
      landed: pageLacks('Pier 25:'),
    },
    {
      where: 'delete-section',
      run: () => s.post(`${doc}/delete_section`, { ...LEAD, heading: 'Old piers' }),
      landed: pageLacks('Pier 28:'),
    },
    {
      where: 'offscreen',
      scrollAway: true,
      run: () =>
        s.post(`${doc}/find_and_replace`, {
          ...LEAD,
          find: 'Pier 13: ',
          replace: `Pier 13: Harborlight lengthens pier 13. ${FILLER} `,
        }),
      landed: pageHas('Harborlight lengthens pier 13'),
    },
    {
      // What a lead does: read the doc's blocks, change one, write it all.
      where: 'set-content',
      run: async () => {
        const got = (await (await fetch(`${s.base}${doc}/content`)).json()) as {
          blocks: Array<{ text: string }>;
        };
        const md = got.blocks.map((b) => b.text).join('\n\n');
        return s.post(`${doc}/content`, {
          ...LEAD,
          markdown: md.replace('Pier 22: ', `Pier 22: Bob rewrote pier 22. ${FILLER} `),
        });
      },
      landed: pageHas('Bob rewrote pier 22'),
    },
  ];
}

/** Every step, in order, for the test's count. */
export const LEAD_EDIT_ORDER: ReadonlyArray<LeadVerbStep['where']> = [
  'outline-first',
  'far-paragraph',
  'table-row',
  'after-thread',
  'at-anchor',
  'under-heading',
  'at-end',
  'replace-block',
  'delete-block',
  'suggest',
  'accept-all',
  'delete-at-anchor',
  'delete-range',
  'delete-section',
  'offscreen',
  'set-content',
];
