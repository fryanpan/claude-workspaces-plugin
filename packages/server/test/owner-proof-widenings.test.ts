/**
 * The owner narrows a collaborator, and the narrowing holds until the owner
 * widens it again from the board's own page.
 *
 * `requireOwner` passes every loopback caller, and every agent on this
 * machine is one. So the three changes that let somebody do more — a member
 * from comment or view to edit, the board from enforce back to report-only,
 * and the collab core from off to on — need the owner's own proof
 * (`share/owner-proof.ts`). Each is driven here from loopback with no proof
 * and must change nothing; the same request from the owner's browser is the
 * positive control. A narrowing from loopback still applies at once.
 *
 * Every name and address is invented. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type ShareProofServer, post, startShareProofServer } from './share-proof-harness.ts';

const COMMENTER = 'riverbend@harborlight.example';
const VIEWER = 'saltmarsh@harborlight.example';

describe('a widening needs the owner’s own proof; a narrowing does not', () => {
  let s: ShareProofServer;
  const rolePath = (email: string) => `${s.scope}/members/${encodeURIComponent(email)}/role`;
  const accessOf = (email: string) => s.handle.shareLinks.accessRoleOf(s.board, email);

  beforeAll(async () => {
    s = await startShareProofServer('Harborlight', { collabCore: true });
    s.handle.shareLinks.addToAudience(s.board, ['@harborlight.example'], 'Alice');
    expect(await s.join(COMMENTER)).toBe(302);
    expect(await s.join(VIEWER)).toBe(302);
  });

  afterAll(async () => {
    await s.stop();
  });

  it('applies a narrowing from loopback at once', async () => {
    const toComment = await s.local(rolePath(COMMENTER), post({ role: 'comment' }));
    expect(toComment.status, await toComment.clone().text()).toBe(200);
    expect(accessOf(COMMENTER)).toBe('comment');
    const toView = await s.local(rolePath(VIEWER), post({ role: 'view' }));
    expect(toView.status).toBe(200);
    expect(accessOf(VIEWER)).toBe('view');

    const enforce = await s.local(`${s.scope}/roles-mode`, post({ mode: 'enforce' }));
    expect(enforce.status).toBe(200);
    expect(s.handle.shareLinks.rolesModeOf(s.board)).toBe('enforce');
  });

  it('refuses comment or view to edit from loopback, and changes nothing', async () => {
    for (const [who, before] of [
      [COMMENTER, 'comment'],
      [VIEWER, 'view'],
    ] as const) {
      for (const role of ['edit', 'member']) {
        const r = await s.local(rolePath(who), post({ role }));
        expect(r.status).toBe(403);
        expect(((await r.json()) as { error: string }).error).toBe('owner-proof-required');
        expect(accessOf(who)).toBe(before);
      }
    }
    // View to comment is a widening too.
    expect((await s.local(rolePath(VIEWER), post({ role: 'comment' }))).status).toBe(403);
    expect(accessOf(VIEWER)).toBe('view');
  });

  it('refuses enforce to report-only from loopback, and keeps enforcing', async () => {
    const r = await s.local(`${s.scope}/roles-mode`, post({ mode: 'report-only' }));
    expect(r.status).toBe(403);
    expect(s.handle.shareLinks.rolesModeOf(s.board)).toBe('enforce');
  });

  it('refuses the collab core off to on from loopback, and leaves it off', async () => {
    expect(s.handle.collabCore.switch.boardOn(s.board)).toBe(false);
    const r = await s.local(`${s.scope}/collab-core`, post({ on: true }));
    expect(r.status).toBe(403);
    expect(s.handle.collabCore.switch.boardOn(s.board)).toBe(false);
  });

  it('applies all three from the owner’s own page (the positive control)', async () => {
    const role = await s.owner(rolePath(COMMENTER), post({ role: 'edit' }));
    expect(role.status, await role.clone().text()).toBe(200);
    expect(accessOf(COMMENTER)).toBe('edit');

    const mode = await s.owner(`${s.scope}/roles-mode`, post({ mode: 'report-only' }));
    expect(mode.status).toBe(200);
    expect(s.handle.shareLinks.rolesModeOf(s.board)).toBe('report-only');

    const core = await s.owner(`${s.scope}/collab-core`, post({ on: true }));
    expect(core.status).toBe(200);
    expect(s.handle.collabCore.switch.boardOn(s.board)).toBe(true);
  });

  it('switches the collab core off from loopback at once', async () => {
    const r = await s.local(`${s.scope}/collab-core`, post({ on: false }));
    expect(r.status).toBe(200);
    expect(s.handle.collabCore.switch.boardOn(s.board)).toBe(false);
  });
});
