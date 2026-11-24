/**
 * A board a server starts with, and the people let into it, from its deploy
 * settings rather than from somebody clicking Share.
 *
 *   CW_SEED_BOARD_NAME     the board's name
 *   CW_SEED_BOARD_MEMBERS  addresses, comma or space separated
 *
 * `machine:deploy` sets both for a project whose `machines.json` entry names a
 * `seedBoard`, the addresses from the Keychain (`infra/project-machine/settings.ts`),
 * so a test server can be signed into by a collaborator the moment it boots.
 *
 * Applied once at every boot, and only ever adds. The board is found by name
 * (the default board's rule in `board-membership.ts`: an id remembered across
 * boots would fragment) and made when none has it. Each address the board's
 * audience does not already admit is added to it, exactly as the owner's Share
 * panel adds one, and then given its member row. Nothing is removed, so an
 * address the owner removed comes back on the next boot while the setting
 * still names it: the setting is the owner's own decision, written where only
 * the owner's deploy can reach.
 */
import { isEmailLike, normalizeEmail } from '@claude-workspaces/core';
import { boardAudienceAdmits } from './share/board-audience.ts';
import type { ShareLinks } from './share/share-links.ts';

export interface SeedBoard {
  name: string;
  members: string[];
}

/** Longer than any board name a person would type; a guard, not a style rule. */
const MAX_NAME = 120;
const MAX_MEMBERS = 20;

/**
 * The setting, checked. Neither variable set is no seed. One set without the
 * other, a bad address or an over-long name is an error naming the variable,
 * never the value: the addresses are the reason the setting is a secret.
 */
export function parseSeedBoard(
  env: Record<string, string | undefined>,
): SeedBoard | { error: string } | undefined {
  const name = (env.CW_SEED_BOARD_NAME ?? '').trim();
  const raw = (env.CW_SEED_BOARD_MEMBERS ?? '').trim();
  if (name === '' && raw === '') return undefined;
  if (name === '') return { error: 'CW_SEED_BOARD_MEMBERS is set without CW_SEED_BOARD_NAME' };
  if (name.length > MAX_NAME) return { error: `CW_SEED_BOARD_NAME is over ${MAX_NAME} characters` };
  const members: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    if (part === '') continue;
    if (!isEmailLike(part))
      return { error: 'CW_SEED_BOARD_MEMBERS holds an entry that is not an address' };
    const who = normalizeEmail(part);
    if (!members.includes(who)) members.push(who);
  }
  if (members.length > MAX_MEMBERS) {
    return { error: `CW_SEED_BOARD_MEMBERS names over ${MAX_MEMBERS} addresses` };
  }
  return { name, members };
}

export interface SeedBoardDeps {
  listWorkspaces: () => ReadonlyArray<{ id: string; name: string }>;
  createWorkspace: (name: string) => { id: string };
  /** Bring a new board's doc up; `createWorkspace` emits no event. */
  ensureWorkspace: (workspaceId: string) => void;
  shareLinks: Pick<ShareLinks, 'audienceOf' | 'addToAudience' | 'isMember'>;
}

export interface SeedBoardResult {
  workspaceId: string;
  created: boolean;
  /** Addresses this boot added to the audience. */
  added: string[];
}

/** Who the audience records as adding a seeded address. */
export const SEED_ADDED_BY = 'deploy settings';

export function applySeedBoard(seed: SeedBoard, deps: SeedBoardDeps): SeedBoardResult {
  const existing = deps.listWorkspaces().find((w) => w.name === seed.name);
  const workspaceId = existing?.id ?? deps.createWorkspace(seed.name).id;
  if (!existing) deps.ensureWorkspace(workspaceId);
  const added = seed.members.filter(
    (who) => !boardAudienceAdmits(deps.shareLinks.audienceOf(workspaceId), who),
  );
  if (added.length > 0) deps.shareLinks.addToAudience(workspaceId, added, SEED_ADDED_BY);
  // Asking writes the member row an audience entry implies, so the person is
  // listed as a member before their first visit rather than at it.
  for (const who of seed.members) deps.shareLinks.isMember(workspaceId, who);
  return { workspaceId, created: !existing, added };
}
