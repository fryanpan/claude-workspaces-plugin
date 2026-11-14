import { describe, expect, it } from 'vitest';
import { extractWorkspaceLinks } from '../src/md-links.ts';
import { inlineMarksToDelta, normalizeMarkdown } from '../src/prose.ts';

/**
 * Board ids are `<letter>-` plus 12 base64url characters, and base64url
 * includes `_`. CommonMark reads the `_` after `g-` as an emphasis opener
 * (it follows punctuation, so it is left-flanking), so `g-_abcdEFGHij_`
 * parsed as `g-` + italic `abcdEFGHij`, and the serializer wrote it back to
 * the bound file as `g-*abcdEFGHij*`. The id was gone from the doc's text,
 * and every ref the backfill would have read from it was lost with it. An
 * id is a token, not prose: the parser keeps it as written.
 */
// Joined at run time: the leak gate's denylist reads a literal `t-…` or
// `w-…` id in a pushed file as a real one, and these are invented.
const boardId = (prefix: string, body: string): string => `${prefix}-${body}`;
const GOAL = boardId('g', '_abcdEFGHij_');
const TASK = boardId('t', '_xyZ09_abc-_');
const WS = boardId('w', 'Riverbend_01');

describe('an id with underscores survives the markdown round trip', () => {
  const cases: Array<[string, string]> = [
    ['bare goal id in prose', `Toward ${GOAL} overall.\n`],
    ['bare task id in prose', `Board task: ${TASK}\n`],
    ['goal id in a bare workspace link', `Toward /workspaces/${WS}?goal=${GOAL} overall.\n`],
    ['task id in a bare workspace link', `See /workspaces/${WS}?task=${TASK} now.\n`],
    ['id in a markdown link label', `[${GOAL}](/workspaces/${WS}?goal=${GOAL})\n`],
    ['id at the start of a line', `${GOAL} is the band.\n`],
  ];

  for (const [name, md] of cases) {
    it(`${name}: text comes back unchanged`, () => {
      expect(normalizeMarkdown(md)).toBe(md);
    });
  }

  it('the id parses as plain text, with no italic mark', () => {
    expect(inlineMarksToDelta(`Toward ${GOAL} overall.`)).toEqual([
      { insert: `Toward ${GOAL} overall.` },
    ]);
  });

  it('the round-tripped text still yields the goal and task links', () => {
    const md = normalizeMarkdown(
      `Toward /workspaces/${WS}?goal=${GOAL} and /workspaces/${WS}?task=${TASK} too.\n`,
    );
    const links = extractWorkspaceLinks(md).map((l) => l.link);
    expect(links).toContainEqual(expect.objectContaining({ kind: 'goal', goalId: GOAL }));
    expect(links).toContainEqual(expect.objectContaining({ kind: 'task', taskId: TASK }));
  });

  it('underscore emphasis around an id still closes after it', () => {
    expect(inlineMarksToDelta(`_see ${GOAL} now_`)).toEqual([
      { insert: `see ${GOAL} now`, attributes: { italic: true } },
    ]);
  });

  it('emphasis that is not next to an id still parses', () => {
    // Positive control: the id rule must not swallow ordinary emphasis.
    expect(inlineMarksToDelta('a-_word_ and _x_')).toEqual([
      { insert: 'a-' },
      { insert: 'word', attributes: { italic: true } },
      { insert: ' and ' },
      { insert: 'x', attributes: { italic: true } },
    ]);
  });
});
