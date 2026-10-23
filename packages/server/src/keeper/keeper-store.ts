/**
 * The keeper's store: a directory only the keeper's macOS user can open,
 * holding four JSON files, each mode 600.
 *
 * - `credentials.json`: the Cloudflare API token and account id, and the
 *   Fly org token and org slug. The only copy on the Mac once the cutover in
 *   `docs/process/keeper.md` is done.
 * - `passkeys.json`: the public half of each passkey Bryan registered.
 * - `apps.json`: the Fly apps this keeper created (or Bryan adopted). Only
 *   these may be started, stopped or restarted without a passkey.
 * - `enroll.json`: the hash of the one-time enrollment link, while one is open.
 *
 * **It refuses rather than repairs.** The directory must be owned by the
 * running user and carry no group or world bit, and so must every file in
 * it; anything else refuses the open, because a loose mode here means some
 * other user may already have read a credential. Writes go to a temporary
 * file created 600 and are renamed into place, so a crash never leaves a
 * half-written file and no file is ever briefly readable.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { StoredPasskey } from './webauthn.ts';

export interface KeeperCredentials {
  cloudflare?: { apiToken?: string; accountId?: string };
  fly?: { orgToken?: string; orgSlug?: string };
}

/** The names `keeper-bin.ts import` accepts, one value each, on stdin. */
export const CREDENTIAL_NAMES = [
  'cloudflare-api-token',
  'cloudflare-account-id',
  'fly-org-token',
  'fly-org-slug',
] as const;
export type CredentialName = (typeof CREDENTIAL_NAMES)[number];

export interface EnrollRecord {
  /**
   * sha256 of the link's token, hex, while the link is unspent. The token
   * itself is never stored. Empty once a page has asked for options.
   */
  tokenHash: string;
  expiresAt: number;
  /** When `keeper enroll` made the link. A keeper started later refuses it. */
  createdAt: number;
  /** The one challenge handed to the page that spent the link. */
  challenge?: string;
  /** sha256 of the session that page was given, to finish with. */
  sessionHash?: string;
}

export interface KeeperStore {
  readonly dir: string;
  credentials(): KeeperCredentials;
  setCredential(name: CredentialName, value: string): void;
  passkeys(): StoredPasskey[];
  savePasskeys(list: StoredPasskey[]): void;
  apps(): string[];
  addApp(app: string): void;
  enroll(): EnrollRecord | null;
  saveEnroll(record: EnrollRecord | null): void;
}

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export type Uid = () => number;
const currentUid: Uid = () => (typeof process.getuid === 'function' ? process.getuid() : -1);

/** Why `path` may not hold the keeper's secrets, or null when it may. */
export function storeModeProblem(path: string, uid: number): string | null {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return `${path} does not exist`;
  }
  if (st.uid !== uid) return `${path} is owned by uid ${st.uid}, not the keeper's (${uid})`;
  if ((st.mode & 0o077) !== 0) {
    return `${path} has mode ${(st.mode & 0o777).toString(8)}; only its owner may open it`;
  }
  return null;
}

export const APP_NAME = /^[a-z][a-z0-9-]{1,62}$/;
const FILES = ['credentials.json', 'passkeys.json', 'apps.json', 'enroll.json'];

/** Open the store at `dir`, or say why it is refused. */
export function openKeeperStore(
  dir: string,
  uid: Uid = currentUid,
): KeeperStore | { error: string } {
  const me = uid();
  const dirProblem = storeModeProblem(dir, me);
  if (dirProblem) return { error: dirProblem };
  if (!statSync(dir).isDirectory()) return { error: `${dir} is not a directory` };
  for (const name of FILES) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const problem = storeModeProblem(path, me);
    if (problem) return { error: problem };
  }

  const read = <T>(name: string, fallback: T): T => {
    const path = join(dir, name);
    if (!existsSync(path)) return fallback;
    const problem = storeModeProblem(path, me);
    if (problem) throw new Error(problem);
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  };
  const write = (name: string, value: unknown): void => {
    const path = join(dir, name);
    const tmp = `${path}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  };

  return {
    dir,
    credentials: () => read<KeeperCredentials>('credentials.json', {}),
    setCredential(name, value) {
      const creds = read<KeeperCredentials>('credentials.json', {});
      if (name === 'cloudflare-api-token')
        creds.cloudflare = { ...creds.cloudflare, apiToken: value };
      if (name === 'cloudflare-account-id')
        creds.cloudflare = { ...creds.cloudflare, accountId: value };
      if (name === 'fly-org-token') creds.fly = { ...creds.fly, orgToken: value };
      if (name === 'fly-org-slug') creds.fly = { ...creds.fly, orgSlug: value };
      write('credentials.json', creds);
    },
    passkeys: () => read<StoredPasskey[]>('passkeys.json', []),
    savePasskeys: (list) => write('passkeys.json', list),
    apps: () => read<{ apps: string[] }>('apps.json', { apps: [] }).apps,
    addApp(app) {
      if (!APP_NAME.test(app)) throw new Error(`"${app}" is not a Fly app name`);
      const apps = read<{ apps: string[] }>('apps.json', { apps: [] }).apps;
      if (!apps.includes(app)) write('apps.json', { apps: [...apps, app].sort() });
    },
    enroll: () => read<EnrollRecord | null>('enroll.json', null),
    saveEnroll: (record) => write('enroll.json', record),
  };
}
