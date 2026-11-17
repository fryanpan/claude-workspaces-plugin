/**
 * `libraryIdOf`: which Library item a page counts as. A diff file's page is
 * its whole review; a folder browse's file is no item; anything else is
 * itself. All fixtures synthetic.
 */
import { describe, expect, it } from 'vitest';
import { libraryIdOf } from '../src/library-view.ts';

describe('libraryIdOf', () => {
  it('answers a diff file with its review', () => {
    expect(libraryIdOf({ docId: 'd-a', docType: 'diff', workspaceId: 'riverbend-1' })).toBe(
      'riverbend-1',
    );
  });

  it('answers a folder browse’s file with nothing', () => {
    expect(
      libraryIdOf({ docId: 'd-b', docType: 'code', workspaceId: 'saltmarsh-browse' }),
    ).toBeNull();
  });

  it('answers a plain doc, mock or whiteboard with itself', () => {
    expect(libraryIdOf({ docId: 'd-plan', docType: 'markdown', workspaceId: '' })).toBe('d-plan');
    expect(libraryIdOf({ docId: 'm-sketch' })).toBe('m-sketch');
  });
});
