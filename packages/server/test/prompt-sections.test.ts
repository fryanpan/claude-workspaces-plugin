/**
 * A markdown prompt cut and spliced by its `###` headings — the one part of a
 * section that rewording its body cannot move.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import {
  appendToSection,
  hasSection,
  replaceSection,
  withoutSection,
} from '../src/prompt-sections.ts';

const PROMPT = [
  'You take notes for the Riverbend standup.',
  '',
  '### Notes',
  '',
  '- One point per note.',
  '',
  '### Speakers',
  '',
  '- Tag the voice.',
  '',
  '### Accuracy',
  '',
  '- Write only what was said.',
].join('\n');

describe('withoutSection', () => {
  it('takes out the heading and its body, up to the next heading', () => {
    expect(withoutSection(PROMPT, 'Speakers')).toBe(
      [
        'You take notes for the Riverbend standup.',
        '',
        '### Notes',
        '',
        '- One point per note.',
        '',
        '### Accuracy',
        '',
        '- Write only what was said.',
      ].join('\n'),
    );
  });

  it('takes a last section out to the end, and leaves no blank line behind', () => {
    const out = withoutSection(PROMPT, 'Accuracy');
    expect(out.endsWith('- Tag the voice.')).toBe(true);
    expect(out).not.toContain('Write only what was said');
  });

  it('matches the heading whatever its case or spacing', () => {
    const loose = PROMPT.replace('### Speakers', '###   SPEAKERS  ');
    expect(withoutSection(loose, 'speakers')).toBe(withoutSection(PROMPT, 'Speakers'));
  });

  it('stops at a heading of a higher level too', () => {
    const md = '### Speakers\n\n- Tag the voice.\n\n## Appendix\n\n- Kept.';
    expect(withoutSection(md, 'Speakers')).toBe('## Appendix\n\n- Kept.');
  });

  it('does not stop at a deeper heading, which is part of the section', () => {
    const md = '### Speakers\n\n#### Labels\n\n- A label.\n\n### Notes\n\n- Kept.';
    expect(withoutSection(md, 'Speakers')).toBe('### Notes\n\n- Kept.');
  });

  it('reads a heading inside a fenced example as example text, not a heading', () => {
    const md = [
      '### Output',
      '',
      '```',
      '### Speakers',
      '- not a rule',
      '```',
      '',
      '### Speakers',
      '',
      '- Tag the voice.',
    ].join('\n');
    const out = withoutSection(md, 'Speakers');
    expect(out).toContain('```\n### Speakers\n- not a rule\n```');
    expect(out).not.toContain('Tag the voice');
  });

  it('takes out every section under that heading', () => {
    const twice = `${PROMPT}\n\n### Speakers\n\n- A second copy.`;
    const out = withoutSection(twice, 'Speakers');
    expect(out).not.toContain('Tag the voice');
    expect(out).not.toContain('A second copy');
  });

  it('never matches a heading by a prefix of its words', () => {
    const md = '### Speakers and links\n\n- Kept.';
    expect(withoutSection(md, 'Speakers')).toBe(md);
  });

  it('leaves a prompt with no such section exactly as it was', () => {
    expect(withoutSection(PROMPT, 'Grouping')).toBe(PROMPT);
    expect(hasSection(PROMPT, 'Grouping')).toBe(false);
    expect(hasSection(PROMPT, 'grouping ')).toBe(false);
    expect(hasSection(PROMPT, ' notes')).toBe(true);
  });
});

describe('replaceSection', () => {
  it('puts the replacement where the section was, a blank line before the next', () => {
    const out = replaceSection(PROMPT, 'Speakers', '### Two layers\n\n- Lead notes.');
    expect(out).toBe(
      [
        'You take notes for the Riverbend standup.',
        '',
        '### Notes',
        '',
        '- One point per note.',
        '',
        '### Two layers',
        '',
        '- Lead notes.',
        '',
        '### Accuracy',
        '',
        '- Write only what was said.',
      ].join('\n'),
    );
  });

  it('says null rather than guessing when there is nothing to replace', () => {
    expect(replaceSection(PROMPT, 'Grouping', '### Two layers')).toBeNull();
  });
});

describe('appendToSection', () => {
  it('adds lines after the section’s last line, before the next heading', () => {
    const out = appendToSection(PROMPT, 'Speakers', '- Never join two voices.');
    expect(out).toContain('- Tag the voice.\n- Never join two voices.\n\n### Accuracy');
  });

  it('adds to a last section at the end', () => {
    const out = appendToSection(PROMPT, 'Accuracy', '- Mark a guess.');
    expect(out?.endsWith('- Write only what was said.\n- Mark a guess.')).toBe(true);
  });

  it('says null when there is no such section', () => {
    expect(appendToSection(PROMPT, 'Grouping', '- x')).toBeNull();
  });
});
