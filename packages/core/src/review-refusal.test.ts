/**
 * What the judge is told about the five fleet rules, and how its answer is
 * read. The prompt text is the only half testable without a live call, so
 * each rule's exceptions — the asks that must still reach the reader — are
 * asserted present by name.
 */
import { describe, expect, it } from 'vitest';
import { buildReviewJudgePrompt, parseReviewJudgeResponse } from './review-judge-prompt.ts';
import {
  DESTRUCTIVE_GIT_STEP_RULE,
  REVIEW_REFUSAL_KINDS,
  REVIEW_REFUSAL_RULES,
  namesDestructiveGitStep,
  namesHumanOnlyCommit,
  refusalSystemLines,
} from './review-refusal.ts';

const ITEM = { headline: 'Spend about $9 re-running the Harborlight eval?' };

describe('the judge is taught the five rules', () => {
  const { system, user } = buildReviewJudgePrompt('Criteria text.', ITEM);

  it('names every rule, before the criteria', () => {
    for (const kind of REVIEW_REFUSAL_KINDS) {
      const at = system.indexOf(`- "${kind}":`);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(system.indexOf('Criteria:'));
    }
    expect(system).toContain('"refuse"');
  });

  it('keeps every ask a rule does not answer on the reader’s side', () => {
    // The controls: over $50, push-only, D-class, risk surface, taste, a
    // device only the reader has, and a permission denial.
    for (const exception of [
      'the spend is over $50',
      'the repo ships push-only',
      'a breaking change on the default branch',
      'a public deploy of a breaking change',
      'an external send',
      'an irreversible delete',
      'a force-push',
      'a named risk surface',
      'a product or taste judgement only the reader can make',
      'deletes or loses data',
      'a device, account or place only the reader has',
      'NOT refused when the options offer a real trade-off',
      'refused permission',
      'When you are unsure whether a rule answers the ask, do not refuse it',
    ]) {
      expect(system).toContain(exception);
    }
  });

  it('says nothing about an appeal on a first filing', () => {
    expect(system).not.toContain('You refused an earlier version');
    expect(user).not.toContain('refuse');
  });

  it('tells a revision which rule refused it, so its reason is heard', () => {
    const appeal = buildReviewJudgePrompt('Criteria text.', { ...ITEM, priorRefusal: 'spend' });
    expect(appeal.system).toContain(
      'You refused an earlier version of this item under the "spend" rule',
    );
  });

  it('leaves the rules out for a check the agent was refused permission to run', () => {
    const refused = buildReviewJudgePrompt('Criteria text.', {
      ...ITEM,
      ownerCheck: true,
      refusedCheck: true,
    });
    expect(refused.system).not.toContain('- "self-check":');
  });
});

describe('the judge’s refusal is read strictly', () => {
  it('reads a known rule on a hold', () => {
    expect(parseReviewJudgeResponse('{"ok": false, "reason": "", "refuse": "ship"}')?.refuse).toBe(
      'ship',
    );
  });

  it('drops an unknown rule and a refusal on a pass', () => {
    expect(
      parseReviewJudgeResponse('{"ok": false, "reason": "x", "refuse": "taste"}')?.refuse,
    ).toBeUndefined();
    expect(
      parseReviewJudgeResponse('{"ok": true, "reason": "x", "refuse": "spend"}')?.refuse,
    ).toBeUndefined();
  });
});

describe('what a refused filer is told', () => {
  it('is one sentence per rule, and never routes around a denial', () => {
    for (const kind of REVIEW_REFUSAL_KINDS) {
      const rule = REVIEW_REFUSAL_RULES[kind];
      expect(rule.split(/[.!?](\s|$)/).filter((s) => s.trim() !== '').length).toBe(1);
      expect(rule).not.toMatch(/another|separate|second|work\s?around|session/i);
    }
  });
});

describe('an ask about a destructive git step is recognised', () => {
  it('names each step, in words and as the command', () => {
    for (const text of [
      'Approve a force-push of the rebased Riverbend branch?',
      'Force push the branch?',
      'Run git push --force-with-lease on the PR branch?',
      'Can I git push -f origin fix/riverbend?',
      'Rewrite the history of the Harborlight branch?',
      'A history rewrite drops the fixture from every commit.',
      'Run filter-repo over the Saltmarsh branch?',
      'Delete the stale Saltmarsh release branch?',
      'Delete the v2.3.0 tag and push it again?',
      'The tag deletion cannot be undone for clones.',
      'Run git branch -D release/saltmarsh?',
      'git push origin --delete release/saltmarsh',
      'Hard reset the shared branch to main?',
      'git reset --hard origin/main drops two commits.',
    ]) {
      expect({ text, named: namesDestructiveGitStep(text) }).toEqual({ text, named: true });
    }
  });

  it('leaves an ordinary ship ask alone', () => {
    for (const text of [
      'Open the pull request for the Riverbend export fix now?',
      'Push the fix and merge it once CI is green?',
      'Merge the Harborlight branch into main?',
      'Delete the old cache file. The branch is merged.',
      'Reset the tide counter to zero?',
    ]) {
      expect({ text, named: namesDestructiveGitStep(text) }).toEqual({ text, named: false });
    }
  });
});

describe('no rule text says consent covers a destructive git step', () => {
  const STEPS = ['a force-push', 'a history rewrite', 'a branch or tag deletion', 'a hard reset'];
  // Every text the judge or a refused filer reads: the system turn, with and
  // without an appeal, and each rule's fixed sentence.
  const texts = [
    ...refusalSystemLines(),
    ...REVIEW_REFUSAL_KINDS.flatMap((k) => refusalSystemLines(k)),
    ...Object.values(REVIEW_REFUSAL_RULES),
  ];

  it('tells the judge no consent covers any of the four steps', () => {
    const { system } = buildReviewJudgePrompt('Criteria text.', ITEM);
    expect(system).toContain(DESTRUCTIVE_GIT_STEP_RULE);
    for (const step of STEPS) expect(DESTRUCTIVE_GIT_STEP_RULE).toContain(step);
    expect(DESTRUCTIVE_GIT_STEP_RULE).toContain('is never covered by ship, push or merge consent');
  });

  it('carries the exception in the sentence a ship-refused filer acts on', () => {
    const ship = REVIEW_REFUSAL_RULES.ship;
    const never = ship.indexOf('never covers');
    expect(never).toBeGreaterThan(-1);
    for (const step of STEPS) expect(ship.indexOf(step)).toBeGreaterThan(never);
  });

  it('names a destructive step only in a clause that denies consent covers it', () => {
    let checked = 0;
    for (const text of texts) {
      for (const clause of text.split(/[.;:](?:\s|$)/)) {
        if (!namesDestructiveGitStep(clause)) continue;
        checked++;
        expect({ clause, denies: /\b(?:never|not|NOT|nor)\b/.test(clause) }).toEqual({
          clause,
          denies: true,
        });
      }
    }
    // The positive control: the clauses that name a step were found at all.
    expect(checked).toBeGreaterThan(0);
  });
});

describe('an ask on a repo where only a person commits is recognised', () => {
  it('names the repo rule, as an agent or the repo would say it', () => {
    for (const text of [
      'AGENTS.md says "Never push or commit code. The human pushes and commits code changes themselves".',
      'Agents may not commit or push on the Riverbend repo.',
      "I'm not allowed to push here, so the commit is yours.",
      'Agents are forbidden to commit on Harborlight.',
      'On this repo a person pushes every change.',
      'Pushes are human-only on the Saltmarsh repo.',
    ]) {
      expect({ text, named: namesHumanOnlyCommit(text) }).toEqual({ text, named: true });
    }
  });

  it('leaves an ordinary ship ask alone', () => {
    for (const text of [
      'Open the pull request for the Riverbend export fix now?',
      'Push the fix and merge it once CI is green?',
      'Merge the Harborlight branch into main?',
      'Commit the Saltmarsh fixture and push it?',
    ]) {
      expect({ text, named: namesHumanOnlyCommit(text) }).toEqual({ text, named: false });
    }
  });
});
