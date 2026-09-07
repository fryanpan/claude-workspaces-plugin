/**
 * `attach_doc` must ask for the attach, not for a create.
 *
 * Attaching moved to `POST /workspaces/<ws>/docs:attach` in the canonical-
 * routes cutover, because `POST /workspaces/<ws>/docs` is where a CREATE
 * belongs and the create had nowhere else to go. This tool kept the old
 * address, so every call landed on the create handler with a body holding
 * nothing but a `docId` — and the create handler is not a no-op on that:
 *
 * - on a board with no notes home it answers 400 `sourceUrl required`, so the
 *   verb simply does not work;
 * - on a board that HAS one it derives `<notesDir>/<docId>.md` and makes a
 *   NEW empty doc there, which is a write nobody asked for wearing the name
 *   of the doc the caller meant to file.
 *
 * Either way the tool then read `workspace.docIds` off a create reply that
 * carries no `workspace` at all, so it reported `docIds: []` and looked like
 * it had filed something onto an empty board.
 *
 * Driven through the committed bundle against a recording stub, so what is
 * asserted is the request a session actually sends. All fixtures synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, type Recorded, startBundle } from './harness/mcp-bundle.ts';

const WS = 'w-1';
const DOC = 'design-notes';

/** The attach route's reply: the board, with the doc now on it. */
const ATTACHED = { ok: true, workspace: { id: WS, docIds: ['already-here', DOC] } };

let mcp: BundleHarness;

beforeAll(async () => {
  mcp = await startBundle((req: Recorded) =>
    req.path.endsWith('/docs:attach') ? ATTACHED : { error: 'sourceUrl required' },
  );
}, 60_000);
afterAll(async () => {
  await mcp?.stop();
});

describe('attach_doc files an existing doc onto a board', () => {
  it('POSITIVE CONTROL: the running bundle serves the tool at all', () => {
    expect(mcp.tool('attach_doc')).toBeDefined();
  });

  it('POSTs the attach address, never the create collection', async () => {
    const { sent } = await mcp.call('attach_doc', { workspaceId: WS, docId: DOC });
    const posts = sent.filter((r) => r.method === 'POST');
    expect(posts.map((r) => r.path)).toEqual([`/workspaces/${WS}/docs:attach`]);
    expect(posts[0]?.body).toMatchObject({ docId: DOC });
  });

  it('reports the docs the board now holds', async () => {
    // The half a path fix alone would not give back: the create reply has no
    // `workspace` key, so this read came out `[]` on every call that got as
    // far as a 200 — a caller could not tell a filed doc from a no-op.
    const res = await mcp.call('attach_doc', { workspaceId: WS, docId: DOC });
    expect(res.isError).toBe(false);
    expect((res.json as { docIds: string[] }).docIds).toEqual(['already-here', DOC]);
  });
});
