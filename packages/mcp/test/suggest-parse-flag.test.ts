/**
 * `parseInlineMarks: false` survives the trip to the server.
 *
 * A proposal's offered text parses markdown by DEFAULT (`suggest-ops.ts`), so
 * `false` is the only way a caller asks for literal characters — and the
 * handler used to forward the field only when it was `true`, which turned an
 * explicit opt-out into the default it was opting out of. Nothing downstream
 * could see the difference: the route reads an absent field as "core
 * decides", and core decides parsed.
 *
 * So the assertion is on the BODY the bundle actually sends, taken off the
 * stub the running bundle talks to, rather than on the handler's source.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, startBundle } from './harness/mcp-bundle.ts';

let mcp: BundleHarness;

beforeAll(async () => {
  mcp = await startBundle(() => ({ ok: true, suggestionId: 's-1' }));
}, 60_000);
afterAll(async () => {
  await mcp?.stop();
});

/** The body of the edit request a call made, picked out of whatever else the
 *  session sends alongside it. */
async function bodyOf(
  tool: string,
  path: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await mcp.call(tool, args);
  expect(res.isError, res.text).toBe(false);
  const sent = res.sent.filter((r) => r.method === 'POST' && r.path.endsWith(path));
  expect(sent).toHaveLength(1);
  return sent[0]?.body as Record<string, unknown>;
}

describe('find_and_replace forwards the parse flag as written', () => {
  it('POSITIVE CONTROL: the running bundle serves the tool', () => {
    expect(mcp.tool('find_and_replace')).toBeDefined();
  });

  it('sends false when the caller asked for literal characters', async () => {
    const body = await bodyOf('find_and_replace', '/find_and_replace', {
      workspaceId: 'w-1',
      docId: 'd-1',
      find: 'Somebody',
      replace: '[@Riverbend](speaker:A)',
      suggest: true,
      parseInlineMarks: false,
    });
    expect(body.parseInlineMarks).toBe(false);
    // The neighbours, so a body that lost every field is not read as a pass.
    expect(body.suggest).toBe(true);
    expect(body.replace).toBe('[@Riverbend](speaker:A)');
  });

  it('sends true when the caller asked for marks', async () => {
    const body = await bodyOf('find_and_replace', '/find_and_replace', {
      workspaceId: 'w-1',
      docId: 'd-1',
      find: 'Somebody',
      replace: '**loud**',
      parseInlineMarks: true,
    });
    expect(body.parseInlineMarks).toBe(true);
  });

  it('omits the field when the caller said nothing, so the server decides', async () => {
    const body = await bodyOf('find_and_replace', '/find_and_replace', {
      workspaceId: 'w-1',
      docId: 'd-1',
      find: 'Somebody',
      replace: 'Anybody',
      suggest: true,
    });
    expect('parseInlineMarks' in body).toBe(false);
  });
});

describe('rewrite_thread_region forwards the parse flag as written', () => {
  it('sends false when the caller asked for literal characters', async () => {
    const body = await bodyOf('rewrite_thread_region', '/rewrite_region', {
      workspaceId: 'w-1',
      docId: 'd-1',
      threadId: 'th-1',
      replacement: '[@Riverbend](speaker:A)',
      suggest: true,
      parseInlineMarks: false,
    });
    expect(body.parseInlineMarks).toBe(false);
    expect(body.replacement).toBe('[@Riverbend](speaker:A)');
  });

  it('omits the field when the caller said nothing', async () => {
    const body = await bodyOf('rewrite_thread_region', '/rewrite_region', {
      workspaceId: 'w-1',
      docId: 'd-1',
      threadId: 'th-1',
      replacement: 'Anybody',
      suggest: true,
    });
    expect('parseInlineMarks' in body).toBe(false);
  });
});
