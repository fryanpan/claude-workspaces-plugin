/**
 * Share LINKS: `https://share.<domain>/s/<id>`, and the workspace membership
 * redeeming one creates.
 *
 * The design Bryan chose on 2026-09-03 (option A on the share-links options
 * doc). ONE Cloudflare Access application covers the whole share hostname,
 * with an "everyone" policy and a one-time PIN login, so Cloudflare proves an
 * email address and nothing more. This module owns the other half of the
 * question — may THIS email open THIS workspace — which is the half the
 * security model has always kept on our side of the line.
 *
 * The split from `shares.ts` is deliberate rather than tidiness. A `Share` is
 * a Cloudflare Access APPLICATION: it carries a hostname, an audience, an app
 * id, a policy id and an allow list, and minting one needs an API token on the
 * box. A `ShareLinkRecord` is a row in a file. They answer the same product
 * question through completely different machinery, and putting the new one
 * inside the old type would mean every field on it being optional and every
 * reader asking which kind it holds. `shares.ts` stays for the records already
 * minted (see the retired-once-drained notes there and in auth-share.ts).
 *
 * Three rules the rest of the server depends on:
 *
 *  1. **A link is not a credential for the workspace, it is an invitation to
 *     become a member.** Redeeming writes the verified email down against the
 *     workspace, once; from then on every request is judged on the MEMBERSHIP,
 *     never on the link. So revoking a link cannot eject the people who
 *     already came through it — `removeMember` is that, and it is a separate,
 *     deliberate act.
 *  2. **A link that is not live records nothing.** Revoked, expired and
 *     never-existed are one answer to a caller (`state`), because three
 *     answers would let anyone with the route enumerate which ids are real.
 *  3. **Expiry is optional and defaults to none.** Bryan, 2026-09-03: links
 *     are long-living. `expiresAt: null` is a link with no expiry, which is a
 *     different thing from a link whose expiry has passed, and the two must
 *     not collapse into a falsy check.
 *
 * Nothing here talks to Cloudflare, and nothing here needs an API token.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { normalizeEmail } from '@claude-workspaces/core';

import {
  type BoardAudience,
  addAudienceEntries,
  boardAudienceAdmits,
  removeFromAudience,
  seedAudiences,
  storedAudiences,
} from './board-audience.ts';
import { type BoardRole, DEFAULT_BOARD_ROLE, normalizeBoardRole } from './board-role.ts';
import { audienceAdmits, parseShareAudience, storedAudience } from './share-audience.ts';
import type { ShareLanding } from './share-landing.ts';

const SECRET_MODE = 0o600;
const REGISTRY_FILENAME = 'share-links.json';

/** One person coming through a link, the first time they came. */
export interface ShareLinkRedemption {
  /** The address Cloudflare Access verified, normalized. */
  email: string;
  at: number;
}

/**
 * A share link. The id is the whole of the URL's secret, so it is 128 bits of
 * randomness — but note what it buys the holder: the chance to sign in and be
 * recorded, not access to the workspace. Access still requires an email
 * Cloudflare verified.
 */
export interface ShareLinkRecord {
  linkId: string;
  workspaceId: string;
  /** The agent or person who minted it, for `list_shares`. */
  createdBy: string;
  createdAt: number;
  /** `null` = no expiry. Long-living is the default (Bryan, 2026-09-03). */
  expiresAt: number | null;
  /** Set by `revoke`; stops new redemptions without touching membership. */
  revokedAt: number | null;
  label?: string;
  /**
   * The role everyone who redeems THIS link arrives with. Absent = `member`,
   * which is the default and the one a link minted before roles existed gets.
   *
   * On the link rather than only on the person because that is the shape the
   * invitation has: the operator decides what they are handing out at the
   * moment they hand it out, and the redeemer's own request cannot name a
   * role. Changing it afterwards is `setMemberRole` on the person, which is
   * the record the gate actually reads.
   */
  role?: BoardRole;
  /** Where redeeming it lands (`share-landing.ts`). Absent = the board. */
  landing?: ShareLanding;
  /**
   * Who may redeem it AND stay in (`share-audience.ts`). Absent = whoever
   * signs in, which is every link minted before audiences existed.
   */
  allowDomains?: string[];
  redemptions: ShareLinkRedemption[];
}

/** An email written down against a workspace. This is what grants access. */
export interface ShareLinkMember {
  workspaceId: string;
  email: string;
  addedAt: number;
  /** Which link they came through — provenance, never authorization. */
  viaLinkId: string;
  /**
   * What this person may do here. Absent on every row written before roles
   * existed, and absent reads as `member` — the migration is the read, so no
   * pass over the registry is needed and a row nobody has touched is judged
   * exactly as a row that says `member`.
   */
  role?: BoardRole;
}

/**
 * What a link is, to a caller.
 *
 * `unknown` covers a malformed id and one that never existed, and the redeem
 * route renders it exactly as it renders `revoked` and `expired`. The
 * distinction exists for the operator's own listing, not for the visitor.
 */
export type ShareLinkState = 'live' | 'revoked' | 'expired' | 'unknown';

/** A link as the API serves it: the record plus the state it is in. */
export type ListedShareLink = ShareLinkRecord & { state: ShareLinkState };

/**
 * The URL a person opens to redeem a link. The one builder: the mint returns
 * it and `list_shares` lists it, so the two cannot name different addresses.
 */
export function shareLinkUrl(host: string, linkId: string): string {
  return `https://${host}/s/${linkId}`;
}

export interface CreateShareLinkReq {
  workspaceId: string;
  createdBy: string;
  /** Seconds from now. Omitted = no expiry, which is the default. */
  ttlSeconds?: number;
  label?: string;
  /** What redeemers arrive as. Omitted = `member`. */
  role?: BoardRole;
  landing?: ShareLanding;
  /** Already parsed by `parseShareAudience`. Omitted = no audience. */
  allowDomains?: string[];
}

interface Persisted {
  links: ShareLinkRecord[];
  members: ShareLinkMember[];
  /** Absent on a registry written before audiences existed: `load` seeds
   *  them from the members (`board-audience.ts`). */
  audiences?: BoardAudience[];
}

export class ShareLinks {
  private readonly dataDir: string;
  private links: ShareLinkRecord[] = [];
  /** Set when this load gave the registry its first audiences, so the
   *  older Cloudflare shares can be seeded in the same boot. */
  private migratedThisBoot = false;
  private members: ShareLinkMember[] = [];
  private audiences: BoardAudience[] = [];

  constructor(opts: { dataDir: string }) {
    this.dataDir = opts.dataDir;
    if (!existsSync(opts.dataDir)) mkdirSync(opts.dataDir, { recursive: true });
    this.load();
  }

  /**
   * Mint a link. No Cloudflare call, no hostname, no audience — the hostname
   * is one the operator configured once and the audience belongs to the ONE
   * Access application in front of it.
   */
  create(req: CreateShareLinkReq): ShareLinkRecord {
    if (!req.workspaceId) throw new Error('workspaceId is required');
    if (req.ttlSeconds !== undefined && (!Number.isFinite(req.ttlSeconds) || req.ttlSeconds <= 0)) {
      throw new Error('ttlSeconds must be a positive, finite number of seconds');
    }
    const now = Date.now();
    const record: ShareLinkRecord = {
      linkId: randomHex(16),
      workspaceId: req.workspaceId,
      createdBy: req.createdBy,
      createdAt: now,
      expiresAt: req.ttlSeconds === undefined ? null : now + req.ttlSeconds * 1000,
      revokedAt: null,
      ...(req.label ? { label: req.label } : {}),
      // Absent for a `member` link, so a link minted with the default is
      // byte-identical to every link minted before roles existed.
      ...(req.role === 'owner' ? { role: req.role } : {}),
      ...(req.landing ? { landing: req.landing } : {}),
      ...(req.allowDomains ? { allowDomains: req.allowDomains.slice() } : {}),
      redemptions: [],
    };
    this.links.push(record);
    this.save();
    return record;
  }

  get(linkId: string): ShareLinkRecord | null {
    if (!linkId) return null;
    return this.links.find((l) => l.linkId === linkId) ?? null;
  }

  /**
   * Is this link redeemable right now?
   *
   * `expiresAt === null` is a link with no expiry and stays live forever; a
   * numeric one is compared, so a link that lapsed a second ago is `expired`
   * and not `live`. Revocation is checked first because it is the deliberate
   * act and should be what an operator sees in a listing.
   */
  state(linkId: string, now: number = Date.now()): ShareLinkState {
    const link = this.get(linkId);
    if (!link) return 'unknown';
    if (link.revokedAt !== null) return 'revoked';
    if (link.expiresAt !== null && link.expiresAt <= now) return 'expired';
    return 'live';
  }

  /**
   * Stop new redemptions. Existing members are untouched, on purpose: they
   * were admitted deliberately and ejecting them is `removeMember`.
   *
   * Soft, and it has to be: the record is what `list_shares` shows and what
   * says who came through this link and when. Destroying it would destroy
   * that history to achieve something the flag already achieves.
   */
  revoke(linkId: string, now: number = Date.now()): boolean {
    const link = this.get(linkId);
    if (!link || link.revokedAt !== null) return false;
    link.revokedAt = now;
    this.save();
    return true;
  }

  /**
   * Redeem a link as a verified email.
   *
   * Idempotent by construction: a second visit from the same address finds
   * the membership already written and changes nothing, so a reviewer who
   * bookmarks the link does not grow the file one row per visit. `added` says
   * which happened, so a caller can log the first arrival without inventing
   * a second lookup that could disagree with this one.
   *
   * A link that is not live records NOTHING — no member, no redemption — and
   * says only that it did not work.
   */
  redeem(
    linkId: string,
    email: string,
    now: number = Date.now(),
  ):
    | { ok: true; workspaceId: string; added: boolean }
    | { ok: false; state: ShareLinkState | 'outside-audience' } {
    const state = this.state(linkId, now);
    if (state !== 'live') return { ok: false, state };
    const link = this.get(linkId);
    // Unreachable while `state` said live; re-checked because a null here
    // would otherwise be a member row against an empty workspace.
    if (!link) return { ok: false, state: 'unknown' };
    const who = normalizeEmail(email);
    // A token with no email claim is nobody, and nobody cannot be made a
    // member. Answering `unknown` rather than a distinct reason keeps the
    // visitor's page identical whatever went wrong.
    if (who === '') return { ok: false, state: 'unknown' };
    // Refused before anything is written: no member row, no redemption.
    // The board's audience as well as the link's: a link only ever invites
    // someone the board already names.
    if (
      !audienceAdmits(link.allowDomains, who) ||
      !boardAudienceAdmits(this.audienceOf(link.workspaceId), who)
    ) {
      return { ok: false, state: 'outside-audience' };
    }
    const added = this.addMember(link.workspaceId, who, linkId, now, link.role);
    if (added) {
      link.redemptions.push({ email: who, at: now });
      this.save();
    }
    return { ok: true, workspaceId: link.workspaceId, added };
  }

  /**
   * Is this email a member of this workspace?
   *
   * The ONLY question the per-request gate asks. The membership row grants
   * access, and the link it came through is read for one thing only: its
   * audience, which must still admit the row. A revoked link's members still
   * answer true here, and that is the intended behaviour, not a gap.
   */
  isMember(workspaceId: string, email: string | null | undefined): boolean {
    const who = email ? normalizeEmail(email) : '';
    if (who === '' || !workspaceId) return false;
    return this.admittedRow(workspaceId, who) !== null;
  }

  /**
   * The member row, if the audience of the link it came through still admits
   * it. Asked on every request, so a narrowed audience ends access on the
   * next one. A row whose link is gone has no audience to consult.
   */
  private admittedRow(workspaceId: string, who: string): ShareLinkMember | null {
    const row = this.members.find((m) => m.workspaceId === workspaceId && m.email === who);
    return row && this.admitted(row) ? row : null;
  }

  /** Lists show who is in, so a row the gate refuses is not listed. Both
   *  audiences: the link's, and the board's. */
  private admitted(row: ShareLinkMember): boolean {
    return (
      audienceAdmits(this.get(row.viaLinkId)?.allowDomains, row.email) &&
      boardAudienceAdmits(this.audienceOf(row.workspaceId), row.email)
    );
  }

  /** The board's audience, or undefined when it has none, which admits nobody. */
  audienceOf(workspaceId: string): BoardAudience | undefined {
    return this.audiences.find((a) => a.workspaceId === workspaceId);
  }

  /** Every board's audience. */
  allAudiences(): BoardAudience[] {
    return this.audiences.slice();
  }

  /**
   * Seed the audiences from the older Cloudflare shares' allow lists. Those
   * shares admit on the collaboration hostname, which now also checks the
   * board's audience, so without this the upgrade would shut out the people
   * they let in.
   *
   * A board with no audience record at all is seeded on any boot: a
   * deployment that never had a share-link registry runs no migration, and
   * its older shares are the only list there is. On the boot that ran the
   * migration, the allow lists are also merged into the audiences it just
   * built. Every other boot leaves an existing audience alone, emptied or
   * not, so the owner's removals since stay removed.
   */
  seedFromOlderShares(
    shares: ReadonlyArray<{ workspaceId: string; allowDomains?: readonly string[] }>,
  ): void {
    const merge = this.migratedThisBoot;
    this.migratedThisBoot = false;
    const untouched = new Set(
      shares.map((s) => s.workspaceId).filter((ws) => this.audienceOf(ws) === undefined),
    );
    const now = Date.now();
    for (const share of shares) {
      if (!merge && !untouched.has(share.workspaceId)) continue;
      const parsed = parseShareAudience(share.allowDomains ?? []);
      const entries = parsed.ok ? (parsed.audience ?? []) : [];
      if (entries.length === 0) continue;
      const current = this.audienceOf(share.workspaceId) ?? {
        workspaceId: share.workspaceId,
        entries: [],
      };
      const list = current.entries.slice();
      for (const match of entries) {
        if (!list.some((e) => e.match === match)) list.push({ match, addedAt: now });
      }
      this.putAudience({ workspaceId: share.workspaceId, entries: list });
    }
  }

  /** Let these entries in. Already parsed by `parseShareAudience`. */
  addToAudience(
    workspaceId: string,
    matches: readonly string[],
    by: string,
    now = Date.now(),
  ): BoardAudience {
    const next = addAudienceEntries(
      this.audienceOf(workspaceId) ?? { workspaceId, entries: [] },
      matches,
      by,
      now,
    );
    this.putAudience(next);
    return next;
  }

  /**
   * Take an address or an `@domain` out of the audience, and with it the
   * member rows it no longer admits. Answers the addresses that lost access,
   * so the caller can hang up what they have open.
   */
  removeFromAudience(workspaceId: string, match: string): string[] {
    const current = this.audienceOf(workspaceId);
    if (!current) return [];
    this.putAudience(removeFromAudience(current, match));
    return this.members
      .filter((m) => m.workspaceId === workspaceId && !this.admitted(m))
      .map((m) => m.email);
  }

  private putAudience(next: BoardAudience): void {
    this.audiences = [...this.audiences.filter((a) => a.workspaceId !== next.workspaceId), next];
    this.save();
  }

  /** Every member of a workspace, in the order they arrived. */
  membersOf(workspaceId: string): ShareLinkMember[] {
    return this.members.filter((m) => m.workspaceId === workspaceId && this.admitted(m));
  }

  /**
   * What this email may do on this workspace, or `null` when they are not a
   * member of it at all.
   *
   * Null rather than `member`, because "not in" and "in, as a regular user"
   * are different answers and the gate above this one already distinguishes
   * them. Collapsing them here would make `roleOf(...) !== 'owner'` read as a
   * membership test that admits strangers.
   */
  roleOf(workspaceId: string, email: string | null | undefined): BoardRole | null {
    const who = email ? normalizeEmail(email) : '';
    if (who === '' || !workspaceId) return null;
    const row = this.admittedRow(workspaceId, who);
    if (!row) return null;
    return row.role ?? DEFAULT_BOARD_ROLE;
  }

  /**
   * Promote or demote a member. Answers false when they are not one — there is
   * no membership to write a role onto, and inventing one here would make this
   * a second, quieter way to admit somebody.
   */
  setMemberRole(workspaceId: string, email: string, role: BoardRole): boolean {
    const who = normalizeEmail(email);
    if (who === '' || !workspaceId) return false;
    const row = this.admittedRow(workspaceId, who);
    if (!row) return false;
    if ((row.role ?? DEFAULT_BOARD_ROLE) === role) return true;
    // Rebuilt rather than mutated, so a demotion REMOVES the key instead of
    // writing `undefined` into it: `member` is the absent state (see
    // `BoardRole`), and a row carrying `"role": undefined` serializes as a
    // second spelling of it.
    const next: ShareLinkMember = {
      workspaceId: row.workspaceId,
      email: row.email,
      addedAt: row.addedAt,
      viaLinkId: row.viaLinkId,
      ...(role === 'owner' ? { role: 'owner' as const } : {}),
    };
    this.members = this.members.map((m) => (m === row ? next : m));
    this.save();
    return true;
  }

  /**
   * Every membership this server holds, across every workspace — what
   * `list_shares` reports so an operator can see who is in before deciding
   * whom to remove.
   *
   * Its own method rather than the caller walking links and calling
   * `membersOf`: a workspace with two links would then list each member
   * twice, and a member whose link was deleted would not list at all.
   */
  allMembers(): ShareLinkMember[] {
    return this.members.filter((m) => this.admitted(m));
  }

  /**
   * Take a member's access away. Effective on the next request, because the
   * gate asks this store on every request rather than at the link.
   *
   * A hard removal rather than a flag, and it is not the soft-delete rule
   * being broken: the row is not user content, it is a grant. Removing a
   * grant is what revocation IS, and a tombstone that still had to be read
   * as "not a member" would be a second way to answer the one question the
   * gate asks. The redemption history on the link survives, so who was ever
   * admitted is still on the record.
   */
  removeMember(workspaceId: string, email: string): boolean {
    const who = normalizeEmail(email);
    if (who === '' || !workspaceId) return false;
    const before = this.members.length;
    this.members = this.members.filter((m) => !(m.workspaceId === workspaceId && m.email === who));
    if (this.members.length === before) return false;
    // And out of the audience, so the link they came through cannot let them
    // straight back in: their exact entry goes, a domain records them.
    const audience = this.audienceOf(workspaceId);
    if (audience) {
      this.audiences = this.audiences.map((a) => (a === audience ? removeFromAudience(a, who) : a));
    }
    this.save();
    return true;
  }

  /** Told after every write, so an open members list can re-read. */
  onSaved: (() => void) | null = null;
  list(): ShareLinkRecord[] {
    return this.links.slice();
  }

  /** `list()` with the one thing a record cannot say about itself. */
  listForApi(now: number = Date.now()): ListedShareLink[] {
    return this.links.map((l) => ({ ...l, state: this.state(l.linkId, now) }));
  }

  /** Every link minted for a workspace, live or not. */
  forWorkspace(workspaceId: string): ShareLinkRecord[] {
    return this.links.filter((l) => l.workspaceId === workspaceId);
  }

  private addMember(
    workspaceId: string,
    email: string,
    viaLinkId: string,
    at: number,
    role?: BoardRole,
  ): boolean {
    if (this.isMember(workspaceId, email)) return false;
    // A row the audience of its own link no longer admits is replaced, so the
    // person arrives as this link says, exactly as a first redemption would.
    this.members = this.members.filter(
      (m) => !(m.workspaceId === workspaceId && m.email === email),
    );
    // `member` is written as ABSENT, not as the string: the field's whole
    // contract is that a row which does not name a role is a regular user, and
    // two spellings of the default are two things a later reader can disagree
    // about.
    this.members.push({
      workspaceId,
      email,
      addedAt: at,
      viaLinkId,
      ...(role === 'owner' ? { role } : {}),
    });
    return true;
  }

  /**
   * Read the registry. A corrupt or unreadable file starts CLEAN rather than
   * crashing the server, which matches `Shares.load` — but note the direction
   * it fails in is different and better: an unreadable share registry loses
   * grants people had, while an unreadable one here loses grants AND is the
   * only thing that grants, so every visitor is refused rather than admitted.
   */
  private load(): void {
    const path = join(this.dataDir, REGISTRY_FILENAME);
    if (!existsSync(path)) return;
    // Tighten a file that already exists. New writes are mode 600, but a
    // registry written before that was true — or by a hand-edit, or restored
    // from a backup — keeps whatever mode it had, and nothing else would ever
    // narrow it. Same reasoning as the key files: this is the one place the
    // server has a reason to look at the file at all. Best effort; a mode we
    // cannot change is not a reason to refuse to boot.
    try {
      if ((statSync(path).mode & 0o777) !== SECRET_MODE) chmodSync(path, SECRET_MODE);
    } catch {
      // Read-only mount, or somebody else's file. The read below decides.
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Persisted>;
      const links = Array.isArray(parsed?.links) ? parsed.links : [];
      const members = Array.isArray(parsed?.members) ? parsed.members : [];
      this.links = links
        .filter(
          (l): l is ShareLinkRecord =>
            typeof l?.linkId === 'string' &&
            l.linkId !== '' &&
            typeof l?.workspaceId === 'string' &&
            l.workspaceId !== '',
        )
        .map((l) => {
          // A hand-edited audience that does not parse admits nobody.
          const { allowDomains: raw, ...rest } = l;
          const audience = storedAudience(raw);
          return audience ? { ...rest, allowDomains: audience } : rest;
        });
      // Normalized on the way IN as well as on the way out: a row hand-edited
      // with a capitalised address must not become a member nothing matches.
      this.members = members
        .filter(
          (m): m is ShareLinkMember =>
            typeof m?.workspaceId === 'string' &&
            m.workspaceId !== '' &&
            typeof m?.email === 'string',
        )
        .map((m) => {
          // The role is read through the same normalizer a route uses, so a
          // hand-edited `"Owner"` is dropped to the default rather than
          // becoming a role nothing else recognises. Dropping can only narrow.
          const role = normalizeBoardRole(m.role);
          // Spread MINUS the role, then add it back only when it survived the
          // normalizer: `{...m}` would otherwise carry a hand-edited `"Owner"`
          // straight through the very check that exists to drop it.
          const { role: _raw, ...rest } = m;
          const row: ShareLinkMember = {
            ...rest,
            email: normalizeEmail(m.email),
            ...(role === 'owner' ? { role } : {}),
          };
          return row;
        })
        .filter((m) => m.email !== '');
      if (Array.isArray(parsed?.audiences)) {
        this.audiences = storedAudiences(parsed.audiences);
      } else {
        this.migrateToAudiences();
      }
    } catch {
      this.links = [];
      this.members = [];
      this.audiences = [];
    }
  }

  /**
   * The one-time upgrade of a registry written before audiences existed.
   * Every board is given an audience of the people already in, by exact
   * address, plus what any live link's own audience named — so nobody loses
   * access. An invited Owner becomes an ordinary member: the seat that
   * changes who is in is Bryan's alone now (29 Oct).
   */
  private migrateToAudiences(): void {
    this.migratedThisBoot = true;
    const now = Date.now();
    const admitted = this.members.filter((m) =>
      audienceAdmits(this.get(m.viaLinkId)?.allowDomains, m.email),
    );
    this.audiences = seedAudiences(
      admitted,
      this.links.map((l) => ({
        workspaceId: l.workspaceId,
        live: this.state(l.linkId, now) === 'live',
        ...(l.allowDomains ? { allowDomains: l.allowDomains } : {}),
      })),
      now,
    );
    this.members = this.members.map(({ role: _role, ...rest }) => rest);
    // And the links: a live link minted as an Owner's would otherwise make
    // its next redeemer an Owner again.
    this.links = this.links.map(({ role: _role, ...rest }) => rest);
    this.save();
  }

  /**
   * Write the registry, mode 600, through a temporary file and a rename.
   *
   * Both halves matter and neither is about confidentiality of workspace
   * content. A `linkId` is a bearer value — whoever reads one can walk up to
   * an everyone-policy sign-in and become a member — and the member list is a
   * roster of email addresses, so this file is handled like the sibling key
   * files beside it rather than like data. The rename is what keeps a crash
   * mid-write from leaving a half-written registry, which this module reads
   * as corrupt and then fails closed on: every member would lose access at
   * once, and the redemption history would be gone with them.
   */
  private save(): void {
    const path = join(this.dataDir, REGISTRY_FILENAME);
    const state: Persisted = {
      links: this.links,
      members: this.members,
      audiences: this.audiences,
    };
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: SECRET_MODE });
    chmodSync(tmp, SECRET_MODE); // an existing tmp keeps its old mode otherwise
    renameSync(tmp, path);
    this.onSaved?.();
  }
}

/**
 * The key a live connection carries so that ejecting a member can find it.
 *
 * A websocket and an SSE stream are authorized ONCE, at open, and then never
 * again — so without something on the socket naming who opened it, removing a
 * member left their `/y/<doc>` reading and writing until the connection
 * happened to drop. The retired per-share mode had a `shareId` for this; a
 * share-link visitor has no share, only a membership, so the membership is
 * what gets stamped.
 *
 * Workspace AND email, because membership is per workspace: someone ejected
 * from one board may still hold another, and closing both would be a bug in
 * the other direction. The separator is a NUL, which neither part can contain.
 */
export function shareMemberKey(workspaceId: string, email: string): string {
  return `${workspaceId}\u0000${normalizeEmail(email)}`;
}

/** `bytes` random bytes, hex-encoded — so 2*bytes characters. */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}
