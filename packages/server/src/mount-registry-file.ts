/**
 * The mount registry's file: its shape on disk, and the two operations that
 * move it between disk and memory.
 *
 * The same seam `repo-registry-file.ts` draws, for the same reason —
 * everything here is about surviving a crash and a bad parse, and nothing
 * here knows what a mount is for.
 *
 * **Why a second file rather than fields on `repos.json`.** `repos.json` is
 * written on the bind path: every bind and every re-key rewrites it, and
 * `repo-registry.ts` is already within thirty lines of the 500-line bar. A
 * mount table changes when a lead mounts a folder and when a file moves —
 * two rates that have nothing to do with each other, and folding them would
 * put a mount scan's writes into every bind's fsync. The two are joined by
 * `repoKey`, resolved through `RepoRegistry.repoInfo` so a repo that re-keys
 * carries its mounts with it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const MOUNT_REGISTRY_FILE = 'mounts.json';
const REGISTRY_VERSION = 1;

/**
 * Whether a project's mounted files may leave this machine.
 *
 * `workspace` is the default and means what the board rule already says:
 * everything in a workspace is available to everyone in it, so a signed-in
 * member reaches the bytes over the tunnel or the tailnet like any other
 * board content. `local-only` is the exception a project declares for
 * material that must not leave the box, and it is enforced as a socket-level
 * refusal rather than a redaction — see `routes/mounts.ts`.
 *
 * Set on the PROJECT, over all its mounts at once. Per-mount privacy was
 * considered and refused: the thing a person knows is "this project is
 * sensitive", and a per-folder switch is a place for one folder to be
 * forgotten.
 */
export type ProjectPrivacy = 'workspace' | 'local-only';

/** The default conventions index, relative to the repo root. */
export const DEFAULT_CONVENTIONS_PATH = 'WORKSPACES.md';

export interface MountRecord {
  /** `m-…`, minted once and never reused. */
  mountId: string;
  /** POSIX, relative to the REPO ROOT — the same spelling in every checkout,
   *  which is what makes a mount registered from a worktree work in the main
   *  one. The empty string is the repo root itself. */
  relPath: string;
  addedAt: number;
  /** Set when the lead unmounted it. The row STAYS: retention is the
   *  project's, and a row that vanished would take its files' addresses with
   *  it. Nothing on disk is touched either way. */
  removedAt?: number;
}

export interface ProjectRecord {
  repoKey: string;
  privacy: ProjectPrivacy;
  /** Repo-relative path of the conventions index. */
  conventionsPath: string;
  mounts: MountRecord[];
}

/** What the registry remembers about one mounted file. */
export interface FileEntry {
  /** The address. `f-…`, minted once, never reused, never repointed. */
  fileId: string;
  /** The mount the file was last seen in. */
  mountId: string;
  size: number;
  mtimeMs: number;
  /** `sampleHash` when last seen — what a move is recognised by. */
  hash?: string;
}

export interface MountRegistryFile {
  version: number;
  projects: ProjectRecord[];
  /** `<repoKey>NUL<relPathFromRepoRoot>` → what is known about that file. */
  fileKeys: Record<string, FileEntry>;
  /** An old file key → the key that replaced it, after a detected move. */
  fileKeyAliases: Record<string, string>;
}

function emptyFile(): MountRegistryFile {
  return { version: REGISTRY_VERSION, projects: [], fileKeys: {}, fileKeyAliases: {} };
}

/**
 * Read the file, or start empty.
 *
 * A corrupt file is kept beside the new one rather than overwritten, the same
 * rule the repo registry states: one bad parse must not silently discard
 * every mounted file's address.
 */
export function readMountRegistryFile(path: string): MountRegistryFile {
  if (!existsSync(path)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MountRegistryFile>;
    return {
      version: typeof parsed.version === 'number' ? parsed.version : REGISTRY_VERSION,
      projects: Array.isArray(parsed.projects) ? parsed.projects.map(normalizeProject) : [],
      fileKeys: parsed.fileKeys && typeof parsed.fileKeys === 'object' ? parsed.fileKeys : {},
      fileKeyAliases:
        parsed.fileKeyAliases && typeof parsed.fileKeyAliases === 'object'
          ? parsed.fileKeyAliases
          : {},
    };
  } catch (err) {
    const kept = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, kept);
      console.error(`[mount-registry] ${path} did not parse; kept it at ${kept}:`, err);
    } catch {
      console.error(`[mount-registry] ${path} did not parse and could not be moved aside:`, err);
    }
    return emptyFile();
  }
}

/**
 * Fill in what a hand-edited or older row left out.
 *
 * Privacy in particular: an unreadable or absent value becomes `workspace`
 * rather than throwing, because a project row that fails to load would take
 * every mount with it — but a value that is present and merely unrecognised
 * becomes `local-only`, since the only reason to write something there is to
 * restrict, and guessing "open" from a typo is the one wrong direction.
 */
function normalizeProject(raw: Partial<ProjectRecord>): ProjectRecord {
  const privacy: ProjectPrivacy =
    raw.privacy === undefined || raw.privacy === 'workspace'
      ? 'workspace'
      : raw.privacy === 'local-only'
        ? 'local-only'
        : 'local-only';
  return {
    repoKey: typeof raw.repoKey === 'string' ? raw.repoKey : '',
    privacy,
    conventionsPath:
      typeof raw.conventionsPath === 'string' && raw.conventionsPath !== ''
        ? raw.conventionsPath
        : DEFAULT_CONVENTIONS_PATH,
    mounts: Array.isArray(raw.mounts) ? raw.mounts : [],
  };
}

/**
 * Write temp-then-rename, so a crash mid-write leaves the old file rather
 * than half of a new one. Mode 600: it is a map of the host's filesystem.
 */
export function writeMountRegistryFile(path: string, data: MountRegistryFile): boolean {
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch (err) {
    console.error(`[mount-registry] could not write ${path}:`, err);
    return false;
  }
}
