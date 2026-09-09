/**
 * The registry's file: its shape on disk, and the two operations that move it
 * between disk and memory.
 *
 * Split out of `repo-registry.ts` when that file crossed 500 lines. The seam
 * is durability rather than meaning: everything here is about surviving a
 * crash and a bad parse, and nothing here knows what a docKey is for. The
 * class next door holds every decision.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const REPO_REGISTRY_FILE = 'repos.json';
const REGISTRY_VERSION = 1;

export interface RegisteredCheckout {
  /** Absolute path to the checkout root. */
  root: string;
  addedAt: number;
  /** Last time we saw this checkout actually exist. */
  lastSeenAt: number;
  /** Set when the lead unregistered it, or when it stopped existing. The row
   *  stays: it is how a doc bound there still names where it came from. */
  removedAt?: number;
  /** Did a person register this, or did we learn it from a bind? A registered
   *  checkout is one the lead vouched for; a learned one is a fact. */
  registered: boolean;
}

export interface RepoRecord {
  repoKey: string;
  /** Keys this repo has answered to before — a renamed remote, a moved
   *  no-remote checkout. Reads follow them; writes only ever add. */
  aliasKeys: string[];
  mainRoot: string;
  checkouts: RegisteredCheckout[];
  remoteUrl?: string;
}

export interface RepoRegistryFile {
  version: number;
  repos: RepoRecord[];
  /** `<repoKey>NUL<relPath>` → docId. */
  docKeys: Record<string, string>;
  /** An old docKey → the docKey that replaced it (a rename, or a re-key). */
  docKeyAliases: Record<string, string>;
}

function emptyFile(): RepoRegistryFile {
  return { version: REGISTRY_VERSION, repos: [], docKeys: {}, docKeyAliases: {} };
}

/**
 * Read the file, or start empty.
 *
 * A corrupt file is NOT overwritten on sight — it is kept beside the new one,
 * because the alternative is silently discarding every doc's identity on one
 * bad parse.
 */
export function readRegistryFile(path: string): RepoRegistryFile {
  if (!existsSync(path)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RepoRegistryFile>;
    return {
      version: typeof parsed.version === 'number' ? parsed.version : REGISTRY_VERSION,
      repos: Array.isArray(parsed.repos) ? parsed.repos : [],
      docKeys: parsed.docKeys && typeof parsed.docKeys === 'object' ? parsed.docKeys : {},
      docKeyAliases:
        parsed.docKeyAliases && typeof parsed.docKeyAliases === 'object'
          ? parsed.docKeyAliases
          : {},
    };
  } catch (err) {
    const kept = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, kept);
      console.error(`[repo-registry] ${path} did not parse; kept it at ${kept}:`, err);
    } catch {
      console.error(`[repo-registry] ${path} did not parse and could not be moved aside:`, err);
    }
    return emptyFile();
  }
}

/**
 * Write temp-then-rename, so a crash mid-write leaves the old file rather
 * than half of a new one. Mode 600: it is a map of the host's filesystem.
 */
export function writeRegistryFile(path: string, data: RepoRegistryFile): boolean {
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch (err) {
    console.error(`[repo-registry] could not write ${path}:`, err);
    return false;
  }
}
