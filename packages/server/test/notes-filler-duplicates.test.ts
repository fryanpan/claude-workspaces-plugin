/**
 * Two notes that differ only by a filler word are one note written twice.
 *
 * The done-when this file holds: the duplicate count reads normalized text,
 * so a pair differing by "just" counts 1 and an unrelated pair counts 0. And
 * the normalization drops only words that carry nothing: "not" and "only"
 * still make two notes different.
 *
 * All notes are invented. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { buildNotesQualityReport, bulletKey } from '../src/notes-quality-report.ts';

const notesOf = (a: string, b: string): string =>
  ['## Meeting notes', '### Riverbend repairs', `- ${a}`, `- ${b}`].join('\n');

const repeats = (a: string, b: string): number =>
  buildNotesQualityReport({ notes: notesOf(a, b), transcript: [] }).duplicateBulletLines;

describe('repeated bullets read normalized text', () => {
  it('counts a pair that differs only by a filler word as one duplicate', () => {
    expect(
      repeats(
        'Crews start on the high street in June',
        'Crews just start on the high street in June',
      ),
    ).toBe(1);
  });

  it('counts a pair that differs by "kind of" and case as one duplicate', () => {
    expect(repeats('The drain gates are kind of urgent', 'the drain gates are URGENT')).toBe(1);
  });

  it('counts an unrelated pair as none', () => {
    expect(
      repeats('Crews start on the high street in June', 'Alice sends the drain survey to Bob'),
    ).toBe(0);
  });

  it('keeps a word that changes the meaning', () => {
    expect(repeats('The gate is locked at night', 'The gate is not locked at night')).toBe(0);
    expect(repeats('The council reads the totals', 'The council only reads the totals')).toBe(0);
  });

  it('keys a bullet on its words alone', () => {
    expect(bulletKey('- **Crews** really start in June!')).toBe(bulletKey('crews start in june'));
  });
});
