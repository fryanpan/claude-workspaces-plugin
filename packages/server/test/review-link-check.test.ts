import { describe, expect, it } from 'bun:test';
import { type LinkTargets, linkFaults, linkHoldReason } from '../src/review-items/link-check.ts';

/** All fixtures are synthetic — invented board, task and document ids. */

const KNOWN: LinkTargets = {
  boardExists: (id) => id === 'w-board',
  taskExists: (id) => id === 't-live',
  docExists: (id) => id === 'd-live',
};

describe('a link on a card has to go somewhere', () => {
  it('passes a board, a task and a document that all exist', () => {
    const detail = [
      'See the [board](/workspaces/w-board), the [ticket](/workspaces/w-board?task=t-live)',
      'and the [mock](/workspaces/w-board/mockups/d-live) or the [doc](/workspaces/w-board/docs/d-live).',
    ].join(' ');
    expect(linkFaults(detail, KNOWN)).toEqual([]);
    expect(linkHoldReason(detail, KNOWN)).toBeUndefined();
  });

  it('passes an item with no links at all — most items have none', () => {
    expect(linkHoldReason('Nothing to open here.', KNOWN)).toBeUndefined();
    expect(linkHoldReason(undefined, KNOWN)).toBeUndefined();
  });

  it('catches a route the addressability cutover retired, even with a good id', () => {
    // The measured case: the document is fine, the address is not, so a check
    // that only asked "does this id exist" would pass a dead link.
    const why = linkHoldReason('the [mock](/mockup/d-live)', KNOWN);
    expect(why).toContain('/mockup/d-live');
    expect(why).toContain('retired');
    expect(why).toContain('/workspaces/<board>/mockups/<id>');
  });

  it('catches the other retired route', () => {
    expect(linkHoldReason('the [doc](/review/d-live)', KNOWN)).toContain('retired');
  });

  it('catches a board nobody has', () => {
    expect(linkHoldReason('[here](/workspaces/w-gone/docs/d-live)', KNOWN)).toContain(
      'no board has that id',
    );
  });

  it('catches a task that has gone', () => {
    expect(linkHoldReason('[row](/workspaces/w-board?task=t-gone)', KNOWN)).toContain(
      'no task on that board has that id',
    );
  });

  it('catches a document that has gone', () => {
    expect(linkHoldReason('[doc](/workspaces/w-board/docs/d-gone)', KNOWN)).toContain(
      'no document has that id',
    );
  });

  it('catches a bare URL, which is where trailing punctuation lands in the address', () => {
    const why = linkHoldReason('Check https://example.invalid/status, then reply.', KNOWN);
    expect(why).toContain('bare URL');
    // The comma is captured with it, because the comma IS the fault.
    expect(why).toContain('https://example.invalid/status,');
  });

  it('does not call an inline external link bare — the control', () => {
    expect(
      linkHoldReason('the [run](https://example.invalid/run/1) failed', KNOWN),
    ).toBeUndefined();
  });

  it('leaves an external link alone rather than pretending to resolve it', () => {
    expect(linkHoldReason('[spec](https://example.invalid/spec)', KNOWN)).toBeUndefined();
  });

  it('names ONE fault, the first, however many there are', () => {
    const detail = '[a](/mockup/d-live) and [b](/workspaces/w-gone) and https://example.invalid/c';
    expect(linkFaults(detail, KNOWN)).toHaveLength(3);
    expect(linkHoldReason(detail, KNOWN)).toContain('/mockup/d-live');
  });
});
