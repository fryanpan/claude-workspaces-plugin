/**
 * Whether an attachment set's files may leave this machine.
 *
 * A folder attached with `attach_folder` becomes an attachment set, and until
 * this existed a set had no privacy of its own: the only thing keeping a
 * set's files off the share hostname was that nobody had minted a link for
 * the board it sat on. A project can be marked `local-only`
 * (`mount-registry.ts`), but that needs a git checkout to key the project by,
 * and a synced folder with no repo above it has none — so `mount_folder` and
 * `set_project_privacy` refused it, and `attach_folder` accepted it with no
 * way to say "keep this here".
 *
 * **The same two words, the same meaning.** `workspace` is what every set
 * was before: its files are served to whoever the board's shares admit.
 * `local-only` means its files AND their names are served to a caller on this
 * machine alone — a loopback peer with no `cf-ray` — exactly as a local-only
 * mount is (`routes/mount-file.ts`). A share-link visitor, a collaboration
 * visitor, the owner through the tunnel and a page on the tailnet are all off
 * the box, and all are refused, because "must not leave the machine" is a
 * claim about the network, not about who is asking.
 *
 * **Its own record, not the members' meta.** A set's other config rides on
 * its member docs (`rememberWorkspaceConfig`), but members are opened lazily
 * long after the bind, and a privacy field that a lazily-opened member forgot
 * to copy would be a file served that should not have been. So the answer is
 * keyed by set id in `<dataDir>/attachment-privacy.json`, and every member's
 * question goes through its set id.
 *
 * **Fails closed.** A file that exists and cannot be read means the operator's
 * choices are unknown, and for a gate that guards what leaves the machine
 * "unknown" means every set is local-only until it is fixed — and no write,
 * because writing would replace the unreadable list with a shorter one.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isLoopbackAddress } from './middleware/host-guard.ts';
import { memberAddressed } from './middleware/workspace-scope.ts';
import type { ProjectPrivacy } from './mount-registry-file.ts';
import { matchWorkspaceRoute } from './workspace-path.ts';

/** One vocabulary with the mount table: `workspace` or `local-only`. */
export type AttachmentPrivacy = ProjectPrivacy;

export const ATTACHMENT_PRIVACY_FILE = 'attachment-privacy.json';

/** The on-disk shape: the local-only set ids. A set not listed is `workspace`. */
interface AttachmentPrivacyFile {
  localOnly: string[];
}

export type SetPrivacyResult =
  | { ok: true; privacy: AttachmentPrivacy }
  | { ok: false; error: 'privacy_store_unreadable'; detail: string };

/**
 * A caller-supplied privacy: the value, `null` when absent, or `'bad'` for
 * anything else. Absent and wrong are kept apart so an omitted field keeps
 * the set's current answer while a typo is refused — guessing `workspace`
 * from an unrecognised string is the one wrong direction.
 */
export function parseAttachmentPrivacy(raw: unknown): AttachmentPrivacy | null | 'bad' {
  if (raw === undefined) return null;
  if (raw === 'workspace' || raw === 'local-only') return raw;
  return 'bad';
}

export const ATTACHMENT_PRIVACY_ERROR = "privacy must be 'workspace' or 'local-only'";

/** What the bind answer says about the set, so no caller has to assume. */
export function privacyNote(privacy: AttachmentPrivacy): string {
  return privacy === 'local-only'
    ? 'This folder is local-only: its files and their names are served on this machine alone, never through a share link, the collaboration hostname, the owner’s tunnel or the tailnet.'
    : "This folder is shareable: anyone a share link on its board admits can open its files. Attach it again with privacy 'local-only' to keep it on this machine.";
}

export class AttachmentPrivacyStore {
  private readonly path: string;
  private readonly localOnly = new Set<string>();
  /** Set when the file on disk could not be read; see the header. */
  readonly loadError: string | null = null;

  constructor(dataDir: string) {
    this.path = join(dataDir, ATTACHMENT_PRIVACY_FILE);
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<AttachmentPrivacyFile>;
      const ids: unknown = parsed?.localOnly;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
        throw new Error('"localOnly" is not a list of set ids');
      }
      for (const id of ids as string[]) this.localOnly.add(id);
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : `unreadable ${ATTACHMENT_PRIVACY_FILE}`;
      console.error(
        `[attachment-privacy] ${this.path} is unreadable (${this.loadError}); every attachment set is served as local-only until it is fixed`,
      );
    }
  }

  /** The set's privacy. Every set is local-only while the file is unreadable. */
  privacyOf(setId: string): AttachmentPrivacy {
    if (this.loadError !== null) return 'local-only';
    return this.localOnly.has(setId) ? 'local-only' : 'workspace';
  }

  isLocalOnly(setId: string | undefined): boolean {
    return setId !== undefined && this.privacyOf(setId) === 'local-only';
  }

  /** Can `set` be called at all? False while the file is unreadable. */
  writable(): boolean {
    return this.loadError === null;
  }

  /** Record a set's privacy and persist it before answering. */
  set(setId: string, privacy: AttachmentPrivacy): SetPrivacyResult {
    if (this.loadError !== null) {
      return { ok: false, error: 'privacy_store_unreadable', detail: this.loadError };
    }
    const had = this.localOnly.has(setId);
    if (privacy === 'local-only') this.localOnly.add(setId);
    else this.localOnly.delete(setId);
    if (had !== this.localOnly.has(setId)) this.persist();
    return { ok: true, privacy };
  }

  private persist(): void {
    const file: AttachmentPrivacyFile = { localOnly: [...this.localOnly].sort() };
    const tmp = `${this.path}.tmp`;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

/**
 * Did this request come from this machine, unproxied? The rule a local-only
 * mount is served under (`routes/mount-file.ts`): a loopback peer, and no
 * `cf-ray`, because the tunnel also dials in over loopback.
 */
export function isOnBox(headers: Headers, peerAddress: string | undefined): boolean {
  if (headers.has('cf-ray')) return false;
  return isLoopbackAddress(peerAddress);
}

/** The refusal every off-box caller gets for a local-only set's files. */
export const LOCAL_ONLY_REFUSAL = {
  error: 'local_only',
  message: 'This folder is local-only: its files are served on the owner’s machine alone.',
} as const;

/** What the gate needs to turn an address into a set id. */
export interface LocalOnlyGateDeps {
  isLocalOnlySet: (setId: string) => boolean;
  /** The set a doc belongs to (its canonical id's `setId`/`workspaceId`). */
  setOfDoc: (docId: string) => string | undefined;
  /** The doc a derived review-item id was minted from, when it is one. */
  docOfReviewItem: (itemId: string) => string | undefined;
}

/** The collections whose members are docs or sets. Rows (`tasks`, `goals`,
 *  `dispatches`) are board content, never a set's files. */
const SET_BEARING = new Set(['docs', 'mockups', 'apps', 'attachments', 'review-items']);

/**
 * Does this address reach into a local-only set — its tree, its file list,
 * one of its files, a file's socket, stream or threads, or an ask derived
 * from one of its files' threads?
 *
 * Read off the one parser the workspace-scope middleware uses
 * (`memberAddressed`), so the address this refuses is the address the
 * middleware resolved, never a second reading of it. The member id is asked
 * both ways — as a set id and as a doc of a set — because `attachments/<id>`
 * names a set and `docs/<id>` names a member, and a caller chooses the
 * collection.
 */
export function addressesLocalOnlySet(pathname: string, deps: LocalOnlyGateDeps): boolean {
  const match = matchWorkspaceRoute(pathname);
  if (!match) return false;
  const member = memberAddressed(match.rest);
  if (!member || !SET_BEARING.has(member.collection)) return false;
  const docId =
    member.collection === 'review-items' ? deps.docOfReviewItem(member.memberId) : member.memberId;
  if (docId === undefined) return false;
  if (deps.isLocalOnlySet(docId)) return true;
  const setId = deps.setOfDoc(docId);
  return setId !== undefined && deps.isLocalOnlySet(setId);
}
