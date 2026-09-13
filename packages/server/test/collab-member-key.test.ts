/**
 * The collaboration-hostname stamp and its sweep predicate, on their own.
 *
 * The route-level behaviour — a revoked, expired or switched-off share hanging
 * up a live socket — is `collab-socket-revocation.test.ts`. This file pins the
 * two properties that suite relies on without saying so: a collaboration key
 * is never mistaken for a share-link one, and the predicate asks the
 * membership question with the workspace and email the key was made from.
 */
import { describe, expect, it } from 'bun:test';
import { collabMemberKey, collabMembershipEnded } from '../src/share/collab-member-key.ts';
import { shareMemberKey } from '../src/share/share-links.ts';

describe('collabMemberKey', () => {
  it('is spelled apart from the share-link key for the same membership', () => {
    const key = collabMemberKey('board-harbor', 'reviewer@harborlight.example');
    expect(key).not.toBe(shareMemberKey('board-harbor', 'reviewer@harborlight.example'));
  });
});

describe('collabMembershipEnded', () => {
  const asked: Array<[string, string]> = [];
  const members = new Set(['board-harbor|named@harborlight.example']);
  const ended = collabMembershipEnded((workspaceId, email) => {
    asked.push([workspaceId, email]);
    return members.has(`${workspaceId}|${email}`);
  });

  it('matches a collaborator the membership no longer admits', () => {
    expect(ended(collabMemberKey('board-harbor', 'reviewer@harborlight.example'))).toBe(true);
  });

  it('leaves a collaborator the membership still admits', () => {
    expect(ended(collabMemberKey('board-harbor', 'named@harborlight.example'))).toBe(false);
  });

  it('asks with the workspace and the normalized email the key was made from', () => {
    asked.length = 0;
    ended(collabMemberKey('board-marsh', 'Guest@Saltmarsh.example'));
    expect(asked).toEqual([['board-marsh', 'guest@saltmarsh.example']]);
  });

  it('never matches a share-link key, whatever the membership says', () => {
    asked.length = 0;
    expect(ended(shareMemberKey('board-harbor', 'reviewer@harborlight.example'))).toBe(false);
    expect(asked).toEqual([]);
  });
});
