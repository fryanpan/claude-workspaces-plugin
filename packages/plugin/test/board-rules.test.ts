/**
 * The board rules the SessionStart hook cuts out of the working-in-a-workspace
 * skill. The pure half: which regions come out, and what a broken marker does.
 * The wired half — the real skill, through the hooks.json command, under the
 * size cap — is in hook-launch.test.ts.
 *
 * Fixtures are synthetic.
 */
import { describe, expect, it } from 'vitest';
import {
  CLOSE_MARKER,
  OPEN_MARKER,
  boardRulesText,
  extractRegions,
} from '../hooks/lib/board-rules.ts';

const region = (body: string) => `${OPEN_MARKER}\n${body}\n${CLOSE_MARKER}`;

describe('extractRegions', () => {
  it('returns each marked region in file order, and nothing outside them', () => {
    const skill = [
      '# Skill',
      'Unmarked prose about Harborlight.',
      region('#### First rule\n- Do the first thing.'),
      'More unmarked prose.',
      region('#### Second rule\n- Do the second thing.'),
    ].join('\n\n');
    const regions = extractRegions(skill);
    expect(regions).toEqual([
      '#### First rule\n- Do the first thing.',
      '#### Second rule\n- Do the second thing.',
    ]);
    expect(regions.join('\n')).not.toContain('Harborlight');
  });

  it('returns no regions for a skill with no markers', () => {
    expect(extractRegions('# Skill\n\nNo markers here.')).toEqual([]);
    expect(boardRulesText('# Skill\n\nNo markers here.')).toBeUndefined();
  });

  it('refuses an open marker with no close, rather than send the rest of the file', () => {
    expect(() => extractRegions(`${OPEN_MARKER}\nrule\n\n## Next section`)).toThrow(/no close/);
  });

  it('refuses a close marker with no open', () => {
    expect(() => extractRegions(`rule\n${CLOSE_MARKER}`)).toThrow(/no open/);
    expect(() => extractRegions(`${region('a')}\nb\n${CLOSE_MARKER}`)).toThrow(/no open/);
  });

  it('refuses an open marker inside a region', () => {
    expect(() =>
      extractRegions(`${OPEN_MARKER}\na\n${OPEN_MARKER}\nb\n${CLOSE_MARKER}\n${CLOSE_MARKER}`),
    ).toThrow(/inside a region/);
  });
});

describe('boardRulesText', () => {
  it('names the skill the rules come from, then the regions', () => {
    const text = boardRulesText(region('#### A rule')) as string;
    expect(text).toContain('claude-workspaces:working-in-a-workspace');
    expect(text.endsWith('#### A rule')).toBe(true);
    expect(text).not.toContain(OPEN_MARKER);
    expect(text).not.toContain(CLOSE_MARKER);
  });
});
