/**
 * The recap a meeting leaves behind, shaped by code after the note-taker has
 * had its last word: grouped by subject, decisions and follow-ups first, no
 * point twice, no cause the room never stated, never more than two levels.
 *
 * All fixtures are invented; the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { RECAP_ACTIONS_HEADING, shapeRecap } from '../src/notes-recap-shape.ts';

const md = (...lines: string[]): string => `${lines.join('\n')}\n`;

/** The headings of a shaped recap, in order. */
function headings(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((l) => /^#{1,6} /.test(l))
    .map((l) => l.replace(/^#+ /, ''));
}

/** The bullets under one heading, with their indentation. */
function under(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n');
  const at = lines.findIndex((l) => l.replace(/^#+ /, '') === heading && l.startsWith('#'));
  if (at < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith('#')) break;
    if (line.trim().length > 0) out.push(line);
  }
  return out;
}

describe('a recap grouped by subject', () => {
  it('moves a late point under the heading of its subject', () => {
    const shaped = shapeRecap(
      md(
        '### Ferry timetable',
        '',
        '- Winter timetable starts in December',
        '- Crew rota needs a second skipper',
        '',
        '### Slipway costs',
        '',
        '- Slipway quote from Riverbend came in high',
        '- Harborlight may share the slipway bill',
        '- Winter timetable draft goes to the crews next week',
      ),
      [],
    );
    expect(shaped).not.toBeNull();
    const out = shaped?.markdown ?? '';
    expect(under(out, 'Ferry timetable')).toContain(
      '- Winter timetable draft goes to the crews next week',
    );
    expect(under(out, 'Slipway costs')).not.toContain(
      '- Winter timetable draft goes to the crews next week',
    );
    expect(shaped?.counts.moved).toBe(1);
  });

  it('opens a new heading when the subject changes under an old one', () => {
    const shaped = shapeRecap(
      md(
        '### Ferry timetable',
        '',
        '- Winter timetable starts in December',
        '- Saturday sailings drop to two',
        '- Saltmarsh pontoon repair quote came in high',
        '- Saltmarsh pontoon repair needs a diver',
      ),
      [],
    );
    const out = shaped?.markdown ?? '';
    expect(headings(out)).toEqual(['Ferry timetable', 'Saltmarsh pontoon repair']);
    expect(under(out, 'Ferry timetable')).toHaveLength(2);
    expect(under(out, 'Saltmarsh pontoon repair')).toEqual([
      '- Saltmarsh pontoon repair quote came in high',
      '- Saltmarsh pontoon repair needs a diver',
    ]);
  });

  it('leaves a recap already grouped by subject exactly as it was', () => {
    const recap = md(
      '### Ferry timetable',
      '',
      '- Winter timetable starts in December',
      '- Saturday sailings drop to two',
      '',
      '### Slipway costs',
      '',
      '- Slipway quote from Riverbend came in high',
    );
    const shaped = shapeRecap(recap, []);
    expect(shaped?.changed).toBe(false);
    expect(shaped?.markdown).toBe(recap);
  });
});

describe('a recap that says each thing once, and only what was said', () => {
  it('merges a near-duplicate point into the fuller one', () => {
    const shaped = shapeRecap(
      md(
        '### Ferry timetable',
        '',
        '- Winter timetable starts in December',
        '- Crew rota needs a second skipper',
        '- The winter timetable starts in December for every route',
      ),
      [],
    );
    const bullets = under(shaped?.markdown ?? '', 'Ferry timetable');
    expect(bullets).toEqual([
      '- The winter timetable starts in December for every route',
      '- Crew rota needs a second skipper',
    ]);
    expect(shaped?.counts.merged).toBe(1);
  });

  it('splits two points joined by a "because" nobody said', () => {
    const shaped = shapeRecap(
      md('### Slipway costs', '', '- Slipway quote came in high because Riverbend lost its crane'),
      ['The slipway quote came in high.', 'Separately, Riverbend lost its crane last week.'],
    );
    expect(under(shaped?.markdown ?? '', 'Slipway costs')).toEqual([
      '- Slipway quote came in high',
      '- Riverbend lost its crane',
    ]);
    expect(shaped?.counts.split).toBe(1);
  });

  it('keeps a reason the speaker did give', () => {
    const shaped = shapeRecap(
      md('### Slipway costs', '', '- Slipway quote came in high because Riverbend lost its crane'),
      ['The slipway quote came in high because Riverbend lost its crane.'],
    );
    expect(under(shaped?.markdown ?? '', 'Slipway costs')).toEqual([
      '- Slipway quote came in high because Riverbend lost its crane',
    ]);
    expect(shaped?.counts.split).toBe(0);
  });
});

describe('a recap a reader can scan', () => {
  it('nests at most two levels deep', () => {
    const shaped = shapeRecap(
      md(
        '### Ferry timetable',
        '',
        '- Winter changes',
        '  - Saturday sailings drop to two',
        '    - Early sailing goes first',
        '      - Harborlight crew asked for this',
        '        - Bob raised it last month',
      ),
      [],
    );
    const bullets = under(shaped?.markdown ?? '', 'Ferry timetable');
    expect(bullets).toEqual([
      '- Winter changes',
      '  - Saturday sailings drop to two',
      '  - Early sailing goes first',
      '  - Harborlight crew asked for this',
      '  - Bob raised it last month',
    ]);
    for (const line of shaped?.markdown.split('\n') ?? []) {
      expect(line.match(/^ */)?.[0].length ?? 0).toBeLessThanOrEqual(2);
    }
  });

  it('lists decisions and follow-ups in a section at the top, decisions first', () => {
    const shaped = shapeRecap(
      md(
        '### Ferry timetable',
        '',
        '- Winter timetable starts in December',
        '- Weekend plans',
        '  - Saturday sailings drop to two',
        '    - Alice will tell the Harborlight crew by Friday',
        '',
        '### Slipway costs',
        '',
        '- Slipway quote from Riverbend came in high',
        '- **Decision:** Bob and Alice go with the Saltmarsh slipway',
      ),
      [],
    );
    const out = shaped?.markdown ?? '';
    expect(headings(out)[0]).toBe(RECAP_ACTIONS_HEADING);
    expect(under(out, RECAP_ACTIONS_HEADING)).toEqual([
      '- **Decision:** Bob and Alice go with the Saltmarsh slipway',
      '- Alice will tell the Harborlight crew by Friday',
    ]);
    expect(out).not.toContain('  - Alice will tell');
    expect(under(out, 'Slipway costs')).toEqual(['- Slipway quote from Riverbend came in high']);
  });

  it('refuses a section holding anything but headings and bullets', () => {
    expect(
      shapeRecap(md('### Running order', '', '1. Budget first', '2. Then the rota'), []),
    ).toBeNull();
    expect(shapeRecap(md('### Notes', '', 'A paragraph somebody typed.'), [])).toBeNull();
  });
});
