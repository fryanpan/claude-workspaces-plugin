/**
 * The second look at an idea the judge called lost, on invented notes. All
 * text here is made up. The repo is public.
 */
import { describe, expect, it } from 'vitest';
import { parseQuotes, quoteCarries } from './notes-lost-confirm.ts';

const NOTES = [
  '## Harborlight',
  '- [@Alice](speaker:remote:A?t=4) says Harborlight opens on Monday, because the export is done',
  '  - Riverbend waits',
].join('\n');

describe('quoteCarries', () => {
  it('accepts a quote copied from one line, speaker tag read as the name', () => {
    expect(quoteCarries('Alice says Harborlight opens on Monday', NOTES)).toBe(true);
    expect(quoteCarries('harborlight  opens on monday, because the export is done', NOTES)).toBe(
      true,
    );
  });
  it('refuses a quote the notes never wrote, one spanning two lines, and one too short to say anything', () => {
    expect(quoteCarries('Harborlight opens on Tuesday', NOTES)).toBe(false);
    expect(quoteCarries('the export is done Riverbend waits', NOTES)).toBe(false);
    expect(quoteCarries('Riverbend waits', NOTES)).toBe(false);
    expect(quoteCarries('', NOTES)).toBe(false);
  });
});

describe('parseQuotes', () => {
  it('reads one quote per idea, an empty quote as none, and refuses a reply that lost its place', () => {
    expect(
      parseQuotes(
        {
          quotes: [
            { n: 2, quote: '' },
            { n: 1, quote: 'Harborlight opens on Monday' },
          ],
        },
        2,
      ),
    ).toEqual(['Harborlight opens on Monday', '']);
    expect(parseQuotes({ quotes: [{ n: 1, quote: 'x' }] }, 2)).toBeNull();
    expect(
      parseQuotes(
        {
          quotes: [
            { n: 1, quote: 'x' },
            { n: 1, quote: 'y' },
          ],
        },
        2,
      ),
    ).toBeNull();
    expect(parseQuotes({ quotes: [{ n: 1, quote: 3 }] }, 1)).toBeNull();
  });
});
