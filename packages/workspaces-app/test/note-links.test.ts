import { describe, expect, it } from 'vitest';
import { noteLinkHref, noteParts } from '../src/doc/note-links.ts';

/**
 * Splitting a `^[…]` note into the runs the margin, the popover and the
 * printed list all draw (src/doc/note-links.ts).
 *
 * Three questions, and the second is the one with teeth: which characters are
 * a link, which hrefs may be followed, and which characters are a backtick
 * span. An href this function admits becomes an `<a href>` in three places, so
 * a scheme slipping through here is a scheme the reader can click.
 */

const REPORT = 'https://harborlight.example.org/permits/2026.pdf';

describe('the words around a link', () => {
  it('leaves a note with no link as one plain run', () => {
    expect(noteParts('Planning Department annual report, 2025, table 4.')).toEqual([
      { text: 'Planning Department annual report, 2025, table 4.' },
    ]);
  });

  it('keeps the text on either side of a link, and the label in between', () => {
    expect(noteParts(`See ${'[table 4]'}(${REPORT}) for the figure.`)).toEqual([
      { text: 'See ' },
      { text: 'table 4', href: REPORT, external: true },
      { text: ' for the figure.' },
    ]);
  });

  it('reads several links in one note', () => {
    const parts = noteParts(`[Riverbend](${REPORT}) and [Saltmarsh](notes/saltmarsh.md#intake)`);
    expect(parts.map((p) => p.text)).toEqual(['Riverbend', ' and ', 'Saltmarsh']);
    expect(parts.map((p) => p.href)).toEqual([REPORT, undefined, 'notes/saltmarsh.md#intake']);
  });

  it('strips backticks from a label, so a code-spanned path reads as the path', () => {
    expect(noteParts('[`plan.md`](plan.md)')).toEqual([
      { text: 'plan.md', href: 'plan.md', external: false },
    ]);
  });
});

/**
 * The provenance tag a fleet note ends with is written in backticks, and stays
 * that way in the file. What comes back is the words without the syntax,
 * marked as the run the renderer draws quietly.
 */
describe('a backtick span', () => {
  const TAG = '[primary — read 2026-09-18]';

  it('comes back as a code run holding the words, not the backticks', () => {
    expect(noteParts(`Council minutes, 12 May. \`${TAG}\``)).toEqual([
      { text: 'Council minutes, 12 May. ' },
      { text: TAG, code: true },
    ]);
  });

  it('reads one that follows a link, and keeps them separate runs', () => {
    expect(noteParts(`[table 4](${REPORT}) \`${TAG}\``)).toEqual([
      { text: 'table 4', href: REPORT, external: true },
      { text: ' ' },
      { text: TAG, code: true },
    ]);
  });

  it('reads one that comes BEFORE a link (control on the same note)', () => {
    expect(noteParts(`\`${TAG}\` [table 4](${REPORT})`)).toEqual([
      { text: TAG, code: true },
      { text: ' ' },
      { text: 'table 4', href: REPORT, external: true },
    ]);
  });

  it('leaves a backtick with no closer as the character the author typed', () => {
    expect(noteParts('Riverbend intake log, `2025 season')).toEqual([
      { text: 'Riverbend intake log, `2025 season' },
    ]);
  });

  it('leaves an empty pair alone — there would be nothing to draw', () => {
    expect(noteParts('Saltmarsh survey `` and nothing else')).toEqual([
      { text: 'Saltmarsh survey `` and nothing else' },
    ]);
  });

  /**
   * A label's backticks are stripped rather than marked, and that is the older
   * behaviour this change had to leave standing: a link is already one run, so
   * a code run inside it would be a second element inside the `<a>` saying
   * nothing the label does not.
   */
  it('marks nothing inside a link label, which still strips its backticks', () => {
    expect(noteParts('[`plan.md`](plan.md)')).toEqual([
      { text: 'plan.md', href: 'plan.md', external: false },
    ]);
  });

  it('starts each note over, so one note ending mid-span cannot eat the next', () => {
    expect(noteParts('Riverbend log `2025')).toEqual([{ text: 'Riverbend log `2025' }]);
    expect(noteParts(`Council minutes \`${TAG}\``)).toEqual([
      { text: 'Council minutes ' },
      { text: TAG, code: true },
    ]);
  });
});

describe('which hrefs may be followed', () => {
  it('calls an http(s) URL external, and a relative path not', () => {
    expect(noteParts(`[a](${REPORT})`)[0]?.external).toBe(true);
    expect(noteParts('[a](../docs/plan.md#goals)')[0]?.external).toBe(false);
    expect(noteParts('[a](#intake)')[0]?.external).toBe(false);
    expect(noteParts('[a](/docs/plan.md)')[0]?.external).toBe(false);
  });

  /**
   * Each of these comes back as PLAIN TEXT carrying exactly what the author
   * wrote. Nothing is hidden — a reader who typed a bad link can still read
   * it — and nothing is clickable.
   *
   * Every needle here is free of brackets and spaces, so it is a candidate
   * the link pattern DOES hand to the scheme check. Write the same schemes
   * with their usual `alert(1)` payload and the pattern refuses them a step
   * earlier, which is a pass that proves nothing about the check under test.
   */
  it.each([
    ['javascript:alert'],
    ['JavaScript:alert'],
    ['data:text/html;base64,PHNjcmlwdD4='],
    ['vbscript:msgbox'],
    ['file:///etc/passwd'],
    ['mailto:someone@example.org'],
    ['//harborlight.example.org/permits'],
  ])('refuses %j and leaves the characters as text', (href) => {
    const parts = noteParts(`See [the source](${href}) for it.`);
    expect(parts.every((p) => p.href === undefined)).toBe(true);
    expect(parts.map((p) => p.text).join('')).toBe(`See [the source](${href}) for it.`);
  });

  it('never reads an href holding a bracket as a link at all', () => {
    const raw = 'See [the source](javascript:alert(1)) for it.';
    expect(noteParts(raw)).toEqual([{ text: raw }]);
  });

  it('admits the same shape with an http scheme (control)', () => {
    const parts = noteParts(`See [the source](${REPORT}) for it.`);
    expect(parts.filter((p) => p.href !== undefined)).toHaveLength(1);
  });

  it('leaves a link with an empty label alone — there would be nothing to click', () => {
    expect(noteParts(`[](${REPORT})`)).toEqual([{ text: `[](${REPORT})` }]);
  });

  it('leaves a link with an empty href alone', () => {
    expect(noteParts('[the source]()')).toEqual([{ text: '[the source]()' }]);
  });

  it('joins a refused link to the words around it rather than splitting them', () => {
    expect(noteParts('a [b](javascript:1) c')).toEqual([{ text: 'a [b](javascript:1) c' }]);
  });
});

/**
 * The scheme check on its own. `noteParts` refuses an href with whitespace in
 * it before this is ever asked, so the obfuscated spellings below are reachable
 * only from here — and they are worth holding, because a browser resolving a
 * URL ignores the tabs and newlines inside a scheme and runs it anyway.
 */
describe('noteLinkHref, asked directly', () => {
  // Built rather than written: a unicode escape for NUL is normalised
  // to the byte itself by the formatter, and one NUL is enough for git to
  // call this whole file binary and stop showing its diff.
  const NUL = String.fromCharCode(0);

  it.each([
    ['java\tscript:alert'],
    ['java\nscript:alert'],
    [`${NUL}javascript:alert`],
    ['  javascript:alert  '],
  ])('refuses an obfuscated scheme: %j', (href) => {
    expect(noteLinkHref(href)).toBe(null);
  });

  it('admits the relative path that spelling was hiding behind (control)', () => {
    expect(noteLinkHref('  docs/plan.md#goals  ')).toEqual({
      href: 'docs/plan.md#goals',
      external: false,
    });
  });

  it('refuses an href that is nothing but whitespace', () => {
    expect(noteLinkHref('   ')).toBe(null);
  });
});
