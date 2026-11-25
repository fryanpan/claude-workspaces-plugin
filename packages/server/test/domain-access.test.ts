/**
 * A board's `@domain` entry carries a level (`board-audience.ts`), so the
 * owner can say what everyone at a domain may do from one control in Board
 * Settings rather than one row at a time.
 *
 * The store on its own: the entry keeps the level across a reload, everyone
 * the entry already let in moves with it, somebody it lets in later arrives
 * at it, and an Owner or a person with their own exact entry is not moved.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShareLinks } from '../src/share/share-links.ts';

const BOARD = 'w-harbor';
const DOMAIN = '@riverbend.example';
const EARLY = 'alice@riverbend.example';
const LATE = 'bob@riverbend.example';
const OWN_ENTRY = 'saltmarsh@riverbend.example';

describe('a domain entry’s level', () => {
  let dataDir: string;
  let links: ShareLinks;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'domain-access-'));
    links = new ShareLinks({ dataDir });
    links.addToAudience(BOARD, [DOMAIN, OWN_ENTRY], 'Alice');
    // Signed in once each, which writes their rows from the audience.
    expect(links.isMember(BOARD, EARLY)).toBe(true);
    expect(links.isMember(BOARD, OWN_ENTRY)).toBe(true);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('is edit until the owner sets one', () => {
    expect(links.audienceAccessOf(BOARD, DOMAIN)).toBe('edit');
    expect(links.accessRoleOf(BOARD, EARLY)).toBe('edit');
  });

  it('moves everyone the domain let in, and answers who moved', () => {
    expect(links.setAudienceAccess(BOARD, DOMAIN, 'view')).toEqual([EARLY]);
    expect(links.audienceAccessOf(BOARD, DOMAIN)).toBe('view');
    expect(links.accessRoleOf(BOARD, EARLY)).toBe('view');
    // Their own exact entry admits them, so the domain's level is not theirs.
    expect(links.accessRoleOf(BOARD, OWN_ENTRY)).toBe('edit');
  });

  it('is the level somebody it lets in later arrives at', () => {
    links.setAudienceAccess(BOARD, DOMAIN, 'comment');
    expect(links.isMember(BOARD, LATE)).toBe(true);
    expect(links.accessRoleOf(BOARD, LATE)).toBe('comment');
  });

  it('back to edit clears the stored level', () => {
    links.setAudienceAccess(BOARD, DOMAIN, 'view');
    expect(links.setAudienceAccess(BOARD, DOMAIN, 'edit', { mayWiden: true })).toEqual([EARLY]);
    expect(links.accessRoleOf(BOARD, EARLY)).toBe('edit');
    expect(links.audienceOf(BOARD)?.entries.find((e) => e.match === DOMAIN)?.access).toBe(
      undefined,
    );
  });

  it('leaves an Owner the domain let in an Owner', () => {
    links.setMemberRole(BOARD, EARLY, 'owner');
    expect(links.setAudienceAccess(BOARD, DOMAIN, 'view')).toEqual([]);
    expect(links.accessRoleOf(BOARD, EARLY)).toBe('owner');
  });

  it('survives a reload', () => {
    links.setAudienceAccess(BOARD, DOMAIN, 'view');
    const again = new ShareLinks({ dataDir });
    expect(again.audienceAccessOf(BOARD, DOMAIN)).toBe('view');
    expect(again.accessRoleOf(BOARD, EARLY)).toBe('view');
  });

  it('answers null for an entry the board does not hold', () => {
    expect(links.setAudienceAccess(BOARD, '@saltmarsh.example', 'view')).toBe(null);
    expect(links.setAudienceAccess(BOARD, 'nobody@riverbend.example', 'view')).toBe(null);
    expect(links.audienceAccessOf(BOARD, '@saltmarsh.example')).toBe(null);
  });

  it('never raises a member it moves unless the caller may widen', () => {
    // Set on her own to view, below the domain's edit.
    links.setMemberRole(BOARD, EARLY, 'member', 'view');
    // Comment is below the domain's edit, so it reads as a narrowing...
    expect(links.setAudienceAccess(BOARD, DOMAIN, 'comment')).toEqual([]);
    // ...but it would raise her, so without the right to widen she stays.
    expect(links.accessRoleOf(BOARD, EARLY)).toBe('view');
    // Re-posting the level a domain already holds raises nobody either.
    expect(links.setAudienceAccess(BOARD, DOMAIN, 'comment')).toEqual([]);
    expect(links.accessRoleOf(BOARD, EARLY)).toBe('view');
    // The owner's own page may.
    expect(links.setAudienceAccess(BOARD, DOMAIN, 'edit', { mayWiden: true })).toEqual([EARLY]);
    expect(links.accessRoleOf(BOARD, EARLY)).toBe('edit');
  });

  it('sets the level an exact address arrives at before they first sign in', () => {
    links.addToAudience(BOARD, [LATE], 'Alice');
    expect(links.audienceAccessOf(BOARD, LATE)).toBe('edit');
    expect(links.setAudienceAccess(BOARD, LATE, 'view')).toEqual([]);
    expect(links.audienceAccessOf(BOARD, LATE)).toBe('view');
    // Their own entry admits them, at the level it carries.
    expect(links.isMember(BOARD, LATE)).toBe(true);
    expect(links.accessRoleOf(BOARD, LATE)).toBe('view');
    expect(new ShareLinks({ dataDir }).audienceAccessOf(BOARD, LATE)).toBe('view');
  });
});
