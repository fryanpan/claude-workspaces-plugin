/**
 * `attachment-privacy.ts` on its own: the store that says which attachment
 * sets are local-only, the on-box test, and the address matcher the server's
 * gate asks. The HTTP half — a share link actually refused — is
 * `attachment-privacy-share.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTACHMENT_PRIVACY_FILE,
  AttachmentPrivacyStore,
  type LocalOnlyGateDeps,
  addressesLocalOnlySet,
  isOnBox,
  parseAttachmentPrivacy,
  privacyNote,
} from '../src/attachment-privacy.ts';

describe('parseAttachmentPrivacy', () => {
  it('keeps absent and wrong apart', () => {
    expect(parseAttachmentPrivacy(undefined)).toBeNull();
    expect(parseAttachmentPrivacy('workspace')).toBe('workspace');
    expect(parseAttachmentPrivacy('local-only')).toBe('local-only');
    expect(parseAttachmentPrivacy('local_only')).toBe('bad');
    expect(parseAttachmentPrivacy(true)).toBe('bad');
    expect(parseAttachmentPrivacy(null)).toBe('bad');
  });
});

describe('privacyNote', () => {
  it('names the privacy it describes', () => {
    expect(privacyNote('local-only')).toContain('local-only');
    expect(privacyNote('workspace')).toContain('shareable');
  });
});

describe('AttachmentPrivacyStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'attachment-privacy-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('answers workspace for a set it has never heard of', () => {
    const store = new AttachmentPrivacyStore(dir);
    expect(store.privacyOf('set-harborlight')).toBe('workspace');
    expect(store.isLocalOnly('set-harborlight')).toBe(false);
    expect(store.isLocalOnly(undefined)).toBe(false);
  });

  it('persists a local-only set across instances, in a file only the owner reads', () => {
    expect(new AttachmentPrivacyStore(dir).set('set-harborlight', 'local-only')).toEqual({
      ok: true,
      privacy: 'local-only',
    });
    const path = join(dir, ATTACHMENT_PRIVACY_FILE);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ localOnly: ['set-harborlight'] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = new AttachmentPrivacyStore(dir);
    expect(again.privacyOf('set-harborlight')).toBe('local-only');
    expect(again.privacyOf('set-riverbend')).toBe('workspace');
  });

  it('sets a set back to workspace', () => {
    const store = new AttachmentPrivacyStore(dir);
    store.set('set-harborlight', 'local-only');
    store.set('set-harborlight', 'workspace');
    expect(new AttachmentPrivacyStore(dir).privacyOf('set-harborlight')).toBe('workspace');
  });

  it('fails closed on a file it cannot read: every set local-only, and no write', () => {
    const path = join(dir, ATTACHMENT_PRIVACY_FILE);
    writeFileSync(path, '{"localOnly": "set-harborlight"');
    const store = new AttachmentPrivacyStore(dir);
    expect(store.loadError).not.toBeNull();
    expect(store.privacyOf('set-riverbend')).toBe('local-only');
    expect(store.writable()).toBe(false);
    const res = store.set('set-riverbend', 'workspace');
    expect(res.ok).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('{"localOnly": "set-harborlight"');
  });

  it('fails closed on a well-formed file of the wrong shape', () => {
    writeFileSync(join(dir, ATTACHMENT_PRIVACY_FILE), '{"localOnly": [1]}');
    expect(new AttachmentPrivacyStore(dir).privacyOf('set-saltmarsh')).toBe('local-only');
  });
});

describe('isOnBox', () => {
  it('is a loopback peer with no cf-ray', () => {
    expect(isOnBox(new Headers(), '127.0.0.1')).toBe(true);
    expect(isOnBox(new Headers(), '::1')).toBe(true);
  });
  it('is not the tunnel, which also dials in over loopback', () => {
    expect(isOnBox(new Headers({ 'cf-ray': '8a1b2c3d4e5f-SJC' }), '127.0.0.1')).toBe(false);
  });
  it('is not a network peer, or an unknown one', () => {
    expect(isOnBox(new Headers(), '192.168.1.20')).toBe(false);
    expect(isOnBox(new Headers(), undefined)).toBe(false);
  });
});

describe('addressesLocalOnlySet', () => {
  // set-harborlight is local-only; d-note is one of its members; set-riverbend
  // and its member d-open are shareable.
  const deps: LocalOnlyGateDeps = {
    isLocalOnlySet: (id) => id === 'set-harborlight',
    setOfDoc: (id) =>
      id === 'd-note' ? 'set-harborlight' : id === 'd-open' ? 'set-riverbend' : undefined,
    docOfReviewItem: (id) => (id === 'ri-note' ? 'd-note' : undefined),
  };
  const hits = (path: string) => addressesLocalOnlySet(path, deps);

  it("refuses the set's own addresses", () => {
    expect(hits('/workspaces/b-1/attachments/set-harborlight/files')).toBe(true);
    expect(hits('/workspaces/b-1/attachments/set-harborlight/tree')).toBe(true);
    expect(hits('/workspaces/b-1/attachments/set-harborlight/context-file')).toBe(true);
  });

  it("refuses a member doc's content, socket and threads", () => {
    expect(hits('/workspaces/b-1/docs/d-note')).toBe(true);
    expect(hits('/workspaces/b-1/docs/d-note/y')).toBe(true);
    expect(hits('/workspaces/b-1/docs/d-note/threads')).toBe(true);
  });

  it('refuses an ask derived from a member doc', () => {
    expect(hits('/workspaces/b-1/review-items/ri-note')).toBe(true);
  });

  it('CONTROL: leaves a shareable set, its members and board rows alone', () => {
    expect(hits('/workspaces/b-1/attachments/set-riverbend/files')).toBe(false);
    expect(hits('/workspaces/b-1/docs/d-open')).toBe(false);
    expect(hits('/workspaces/b-1/tasks/set-harborlight')).toBe(false);
    expect(hits('/workspaces/b-1')).toBe(false);
    expect(hits('/api/share')).toBe(false);
  });
});
