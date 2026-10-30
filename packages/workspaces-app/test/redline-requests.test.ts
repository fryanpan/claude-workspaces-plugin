/**
 * A markdown diff's two requests leave together, before either is answered.
 *
 * The redline waits on the file's base text and on its companion doc being
 * opened. They used to be sent one after the other, both after the redline's
 * chunk had loaded, so a fresh diff page waited on three trips in a row.
 * The fetch below never answers: whatever was sent was sent without waiting
 * on anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRedlineRequests } from '../src/redline/redline-requests.ts';

const member = {
  docId: 'rev-1:notes.md',
  workspaceId: 'rev-1',
  relPath: 'notes.md',
  diffTarget: '',
};

describe('startRedlineRequests', () => {
  let sent: string[] = [];

  beforeEach(() => {
    sent = [];
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        sent.push(String(url));
        return new Promise<Response>(() => {});
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends the base text and the companion open at once', () => {
    startRedlineRequests(member);
    expect(sent).toHaveLength(2);
    expect(sent.some((u) => u.endsWith('/docs/rev-1%3Anotes.md/diff'))).toBe(true);
    expect(sent.some((u) => u.endsWith('/attachments/rev-1/editable-file'))).toBe(true);
  });

  it('opens no companion for a view that never shows one', () => {
    localStorage.setItem('cw-view-mode:rev-1:notes.md', 'diff');
    startRedlineRequests(member);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('/diff');
  });

  it('opens no companion for a pinned review', () => {
    startRedlineRequests({ ...member, diffTarget: 'abc123' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('/diff');
  });
});
