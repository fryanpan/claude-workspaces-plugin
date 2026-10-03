/**
 * The learning-goals doc as the coach reads it: an empty template has no
 * name and no goals, a filled one has both, and a goal is usable only once
 * it says when to act differently.
 */
import { describe, expect, it } from 'bun:test';
import {
  actionableGoals,
  goalSection,
  goalTitle,
  goalsDocTemplate,
  nameFrom,
  readGoalsDoc,
} from '../src/coach/goals-doc.ts';
import { findPlanGaps } from '../src/spoken-reply/interview-gaps.ts';
import { GOALS_DOC } from './coach-fixtures.ts';

/** The outline the interview reads, built from markdown headings and lines. */
function outline(md: string) {
  return md
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      const h = l.match(/^(#+)\s+(.*)$/);
      return h
        ? {
            id: `b${i}`,
            kind: 'heading' as const,
            nodeName: 'heading',
            level: h[1]?.length,
            text: h[2] ?? '',
          }
        : { id: `b${i}`, kind: 'block' as const, nodeName: 'paragraph', text: l };
    });
}

describe('the template', () => {
  it('reads as no name and no goals yet', () => {
    expect(readGoalsDoc(goalsDocTemplate())).toEqual({ goals: [] });
  });

  it('is asked by the interview in its own order, the coach’s name first', () => {
    const gaps = findPlanGaps(outline(goalsDocTemplate()) as never);
    expect(gaps.map((g) => g.heading)).toEqual([
      'Your coach’s name',
      'What I want to do better',
      'What’s behind it',
      'Act differently when',
      'How',
    ]);
  });

  it('adds a goal as four empty parts under the next number', () => {
    expect(goalSection(3)).toBe(
      '## Goal 3\n\n### What I want to do better\n\n### What’s behind it\n\n### Act differently when\n\n### How\n',
    );
  });
});

describe('a filled doc', () => {
  it('names the coach and lists each goal with its four parts', () => {
    const r = readGoalsDoc(GOALS_DOC);
    expect(r.name).toBe('Saltmarsh');
    expect(r.goals).toHaveLength(3);
    expect(goalTitle(r.goals[0] as never)).toBe(
      'Do the hard, important work before the easy polish.',
    );
    expect(r.goals[1]?.when).toBe(
      'I read a message from someone waiting on me and move on without replying.',
    );
  });

  it('uses only a goal that says what and when', () => {
    const half = `${GOALS_DOC}\n## Goal 4\n\n### What I want to do better\n\n- Ship smaller pull requests\n`;
    const r = readGoalsDoc(half);
    expect(r.goals).toHaveLength(4);
    expect(r.goals[3]?.what).toBe('Ship smaller pull requests');
    expect(actionableGoals(r)).toHaveLength(3);
  });

  it('takes the name out of what he said', () => {
    expect(nameFrom('Let’s call it Saltmarsh.')).toBe('Saltmarsh');
    expect(nameFrom('Riverbend')).toBe('Riverbend');
    expect(nameFrom('I think it should be "Harborlight"!')).toBe('Harborlight');
    expect(nameFrom('')).toBeUndefined();
  });
});
