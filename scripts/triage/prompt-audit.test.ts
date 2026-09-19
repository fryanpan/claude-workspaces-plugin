import { describe, expect, it } from 'vitest';
import { BANNED, bannedTokensIn, describeFindings, readTriagePrompt } from './prompt-audit.ts';

describe('doc-triage prompt', () => {
  it('names no verb that destroys a doc, a board or an attachment set', () => {
    const findings = bannedTokensIn(readTriagePrompt());
    expect(describeFindings(findings)).toBe('');
  });

  it('tells owners the two reversible verbs, with both arguments', () => {
    const prompt = readTriagePrompt();
    // The point of the rewrite is not only what is absent: an owner who is
    // told nothing cannot act, and a verb without its board id answers 404.
    expect(prompt).toContain('archive_doc(workspaceId:');
    expect(prompt).toContain('archive_attachment_set(workspaceId:');
    expect(prompt).toContain('setId:');
    expect(prompt).toContain('docId:');
  });

  it('names the addresses that answer today, not the removed ones', () => {
    const prompt = readTriagePrompt();
    expect(prompt).toContain('/workspaces/<b>/docs?limit=200');
    // `/api/docs` and `/api/docs?limit=500` both answer 410 gone since the
    // board cutover — a prompt naming them makes the agent improvise daily.
    expect(prompt).not.toContain('/api/docs');
  });
});

describe('the scan itself', () => {
  // A check that never fires is indistinguishable from a clean file, so each
  // banned token gets a positive control built here rather than read off disk.
  for (const { token, pattern } of BANNED) {
    it(`flags ${token}`, () => {
      const probe = `line one\ncall ${token === 'force' ? 'force' : token} here\nline three`;
      const findings = bannedTokensIn(probe);
      expect(findings.map((f) => f.token)).toContain(token);
      expect(findings.find((f) => f.token === token)?.line).toBe(2);
      // And the pattern is the one that fired, not a neighbour's.
      expect(pattern.test('call ' + (token === 'force' ? 'force' : token))).toBe(true);
    });
  }

  it('does not fire on a word that merely contains a banned one', () => {
    // "enforces" carries "force"; "undelete_documents" is not `delete_doc`'s
    // token boundary case but the prose around the real prompt uses both
    // "enforces" and "soft deletes", and neither may trip the gate.
    expect(bannedTokensIn('nothing but this rule enforces that')).toEqual([]);
    expect(bannedTokensIn('this project soft deletes; it reinforces the rule')).toEqual([]);
  });

  it('reports every offending line, not just the first', () => {
    const probe = ['delete_doc here', 'fine', 'archive_workspace there'].join('\n');
    expect(bannedTokensIn(probe).map((f) => f.line)).toEqual([1, 3]);
  });
});
