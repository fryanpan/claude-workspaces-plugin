/**
 * The pure half of board links: an item's one spelling, and which doc a
 * relative link names. The HTTP half is `board-link-routes.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import {
  linkCandidateOf,
  resolveRelativeLink,
  reviewItemPath,
  taskReviewItemKey,
  threadReviewItemKey,
} from '../src/board-links.ts';

describe('review item links', () => {
  it('keys a minted item by task and item, and a ticket decision by its task', () => {
    expect(taskReviewItemKey('t-1', 'r-2')).toBe('task-review:t-1:r-2');
    expect(taskReviewItemKey('t-1', 'r-legacy')).toBe('decision:t-1');
  });

  it('keys a thread ask as a task thread on a task doc, a doc thread elsewhere', () => {
    expect(threadReviewItemKey('task:t-1', 'th-1')).toBe('task-thread:task:t-1:th-1');
    expect(threadReviewItemKey('harbor-plan', 'th-1')).toBe('doc-thread:harbor-plan:th-1');
  });

  it('opens Home on the item, with the key escaped', () => {
    expect(reviewItemPath('w-a', 'task-review:t-1:r-2')).toBe(
      '/workspaces/w-a/home?item=task-review%3At-1%3Ar-2',
    );
  });
});

describe('resolveRelativeLink', () => {
  const docs = [
    { docId: 'plan', paths: ['/repo/docs/notes/plan.md', 'docs/notes/plan.md'] },
    { docId: 'index', paths: ['/repo/docs/notes/index.md', 'docs/notes/index.md'] },
    { docId: 'same-1', paths: ['/repo/docs/notes/same.md'] },
    { docId: 'same-2', paths: ['/repo/docs/other/same.md'] },
    { docId: 'other-plan', paths: ['/repo/archive/plan.md'] },
  ];

  it('resolves against the file of the doc the link was written on first', () => {
    expect(resolveRelativeLink('./plan.md', docs, ['/repo/docs/notes/index.md'])).toEqual({
      kind: 'one',
      docId: 'plan',
    });
    expect(resolveRelativeLink('../other/same.md', docs, ['/repo/docs/notes/index.md'])).toEqual({
      kind: 'one',
      docId: 'same-2',
    });
  });

  it('falls back to the path’s tail, cut at a slash', () => {
    expect(resolveRelativeLink('../../docs/notes/plan.md#top', docs)).toEqual({
      kind: 'one',
      docId: 'plan',
    });
    // `an.md` is the tail of no file, though `plan.md` ends with those letters.
    expect(resolveRelativeLink('an.md', docs)).toEqual({ kind: 'none' });
  });

  it('reports a tail several docs share as many, not a guess', () => {
    const got = resolveRelativeLink('plan.md', docs);
    expect(got.kind).toBe('many');
    expect(resolveRelativeLink('same.md', docs).kind).toBe('many');
  });

  it('matches nothing for an empty, oversized, control-character or dot-only path', () => {
    expect(resolveRelativeLink('', docs)).toEqual({ kind: 'none' });
    expect(resolveRelativeLink(`${'a/'.repeat(600)}plan.md`, docs)).toEqual({ kind: 'none' });
    expect(resolveRelativeLink('plan.md%00', docs)).toEqual({ kind: 'none' });
    expect(resolveRelativeLink('../..', docs)).toEqual({ kind: 'none' });
    expect(resolveRelativeLink('%E0%A4%A', docs)).toEqual({ kind: 'none' });
  });

  it('ignores a from path that is not absolute', () => {
    expect(resolveRelativeLink('./plan.md', docs, ['docs/archive/x.md']).kind).toBe('many');
  });
});

describe('linkCandidateOf', () => {
  it('collects the bound file, the folder path and the home-repo path, never a URL', () => {
    expect(
      linkCandidateOf({
        docId: 'd',
        sourceUrl: '/repo/docs/plan.md',
        relPath: 'docs/plan.md',
        workspaceRoot: '/mnt',
        docHome: { repoRoot: '/home/repo', relPath: 'docs/plan.md' },
      }).paths,
    ).toEqual([
      '/repo/docs/plan.md',
      'docs/plan.md',
      '/mnt/docs/plan.md',
      '/home/repo/docs/plan.md',
    ]);
    expect(linkCandidateOf({ docId: 'm', sourceUrl: 'http://localhost:5173/' }).paths).toEqual([]);
  });
});
