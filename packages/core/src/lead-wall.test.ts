/**
 * What a walled lead may write under `~/.claude`, as the wall and the server
 * both read it, and the transcript folder names of its projects.
 */
import { describe, expect, it } from 'vitest';
import {
  isOwnSlug,
  isSlug,
  leadWritesUnderClaude,
  projectSlugs,
  transcriptSlug,
} from './lead-wall.ts';

const own = transcriptSlug('/home/dev/harborlight');

describe('leadWritesUnderClaude', () => {
  const slugs = new Set([own]);
  it.each([
    ['history.jsonl', true],
    ['todos/todo.json', true],
    [`projects/${own}/memory/MEMORY.md`, true],
    [`projects/${own}--claude-worktrees-wt/session.jsonl`, true],
    ['', false],
    ['projects', false],
    [`projects/${transcriptSlug('/home/dev/riverbend')}/memory/MEMORY.md`, false],
    ['plans/plan.md', false],
    ['plugins/x/run.sh', false],
    ['claude-workspaces/server.json', false],
    ['CLAUDE.md', false],
    ['settings.json', false],
    ['.settings.json.0123.tmp', false],
  ])('%s → %s', (rel, writable) => {
    expect(leadWritesUnderClaude(rel, slugs)).toBe(writable);
  });
});

describe('transcript folder names', () => {
  it('names a project by both spellings, once each', () => {
    const realpath = (p: string) => p.replace('/home/dev', '/data/dev');
    expect(projectSlugs(['/home/dev/harborlight', '/data/dev/harborlight'], realpath)).toEqual([
      own,
      transcriptSlug('/data/dev/harborlight'),
    ]);
  });

  it('takes a worktree launched inside a project as the project', () => {
    expect(isOwnSlug(`${own}--claude-worktrees-wt`, new Set([own]))).toBe(true);
    expect(isOwnSlug(`${own}-x`, new Set([own]))).toBe(false);
  });

  it('accepts only what transcriptSlug makes', () => {
    expect(isSlug(own)).toBe(true);
    for (const bad of ['', '../x', 'a/b', 'a.b', 7, null]) expect(isSlug(bad)).toBe(false);
  });
});
