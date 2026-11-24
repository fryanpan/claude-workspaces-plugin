/**
 * Where the server finds the Google Maps browser key a `<StreetMap>` on
 * Google draws with (`routes/doc-map-key.ts`), read once at boot.
 *
 * Two sources, in order:
 *  1. `CW_GOOGLE_MAPS_KEY`, the key itself, for a staging run or a machine
 *     whose launch config sets it.
 *  2. A file holding only the key. `infra/gcp-maps` writes it with
 *     Terraform, mode 600, at `GOOGLE_MAPS_KEY_FILE` under the home
 *     directory: prod's own boot-disk root,
 *     so the key reaches prod with no edit to its launchd plist.
 *     `CW_GOOGLE_MAPS_KEY_FILE` names another path.
 *
 * Neither present means no key, and every map draws on OpenStreetMap. A
 * missing file is the normal case on most machines and says nothing. A file
 * that is there but unusable (a link, not a plain file, owned by another
 * user, or not shaped like a key) is skipped with a one-line warning that
 * names the path and never the contents.
 *
 * The key is a browser key, public by design (infra/gcp-maps/README.md); it
 * is still never logged.
 */
import { closeSync, constants as fsc, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const GOOGLE_MAPS_KEY_ENV = 'CW_GOOGLE_MAPS_KEY';
export const GOOGLE_MAPS_KEY_FILE_ENV = 'CW_GOOGLE_MAPS_KEY_FILE';
/** Relative to the home directory. `infra/gcp-maps`'s `key_file` default. */
export const GOOGLE_MAPS_KEY_FILE = 'Library/Application Support/claude-workspaces/google-maps-key';

/** Letters, digits, `-` and `_`, as Google's API keys are written. */
const KEY_SHAPE = /^[A-Za-z0-9_-]{20,200}$/;

export interface GoogleMapsKeySources {
  env?: Record<string, string | undefined>;
  home?: string;
  uid?: number;
  warn?: (line: string) => void;
}

/** The path the key file is read from. */
export function googleMapsKeyPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return env[GOOGLE_MAPS_KEY_FILE_ENV]?.trim() || join(home, GOOGLE_MAPS_KEY_FILE);
}

/** The key, from the environment or else the key file; undefined for none. */
export function resolveGoogleMapsKey(sources: GoogleMapsKeySources = {}): string | undefined {
  const env = sources.env ?? process.env;
  const fromEnv = env[GOOGLE_MAPS_KEY_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const path = googleMapsKeyPath(env, sources.home ?? homedir());
  const got = readKeyFile(path, sources.uid ?? process.getuid?.() ?? -1);
  if ('key' in got) return got.key;
  if (got.problem)
    (sources.warn ?? console.warn)(`[maps] ${got.problem}; maps draw on OpenStreetMap`);
  return undefined;
}

/** The key in `path`, or why not; `problem` is empty for a file not there. */
function readKeyFile(path: string, uid: number): { key: string } | { problem: string } {
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { problem: '' };
    return { problem: `${path} could not be opened (${code})` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { problem: `${path} is not a plain file` };
    if (uid >= 0 && st.uid !== uid) {
      return { problem: `${path} is owned by uid ${st.uid}, not this user` };
    }
    const key = readFileSync(fd, 'utf8').trim();
    return KEY_SHAPE.test(key) ? { key } : { problem: `${path} does not hold a Maps key` };
  } finally {
    closeSync(fd);
  }
}
