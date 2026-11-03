/**
 * Who may call the keeper's agent API: a process that can read the caller
 * token file.
 *
 * The keeper cannot ask the kernel who is calling. In production every
 * connection reaches it through launchd's relay, `nc -U` running as the
 * keeper's own user (`keeper-launchd.ts`), so the peer of every request is
 * that user; and Bun gives a server no peer credentials (`getpeereid`,
 * `LOCAL_PEERCRED`) on a unix socket anyway. What the kernel can still check
 * is who opens a file. So `keeper-bin.ts caller-token` mints a random token,
 * the keeper keeps only its sha256 (`config.json` in its store), and
 * `keeper-setup.ts` writes the token, mode 600, owned by Bryan, under prod's
 * root (`CALLER_TOKEN_FILE`). Every agent-API request carries it in
 * `x-cw-keeper-caller`, and a request without the matching token is refused.
 *
 * Who can read that file: Bryan's own processes (prod, his shells, agents
 * that run as him without the wall) and root. Who cannot: every other macOS
 * user, a lead user from `docs/process/mac-lead-users.md` among them, and a
 * walled lead, whose Seatbelt profile denies prod's root after every other
 * rule (`scripts/lead-sandbox-lib.ts`, `PROD_ROOT`). That is the separation a
 * peer-uid check would make, and the same-user processes it would admit are
 * the same ones this admits.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants as fsc,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type KeeperStore, hashToken } from './keeper-store.ts';
import { b64url } from './webauthn.ts';

export const CALLER_HEADER = 'x-cw-keeper-caller';
/** Overrides where callers read the token; the default is `CALLER_TOKEN_FILE`. */
export const CALLER_TOKEN_FILE_ENV = 'CW_KEEPER_CALLER_TOKEN_FILE';
/** Under prod's root, which a walled lead's profile denies. */
export const CALLER_TOKEN_FILE =
  'Library/Application Support/claude-workspaces/keeper-caller-token';
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

/** A new caller token; the store keeps its hash, and the old token stops working. */
export function mintCallerToken(store: KeeperStore): string {
  const token = b64url(new Uint8Array(randomBytes(32)));
  store.saveCallerTokenHash(hashToken(token));
  return token;
}

/** Whether `presented` is the caller token: `none` before one has been made. */
export function callerVerdict(
  store: KeeperStore,
  presented: string | null,
): 'ok' | 'none' | 'wrong' {
  const want = store.callerTokenHash();
  if (!want) return 'none';
  if (!presented) return 'wrong';
  const got = Buffer.from(hashToken(presented), 'hex');
  const expected = Buffer.from(want, 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected) ? 'ok' : 'wrong';
}

/** Where this process reads the token. */
export function callerTokenPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return env[CALLER_TOKEN_FILE_ENV]?.trim() || join(home, CALLER_TOKEN_FILE);
}

/**
 * The token in `path`, or why it may not be used. The file must be a plain
 * file this user owns that no one else may read, so a token another user
 * could have copied is never sent; a link is refused rather than followed.
 */
export function readCallerToken(
  path: string,
  uid: number = process.getuid?.() ?? -1,
): { token: string } | { problem: string } {
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      problem:
        code === 'ENOENT'
          ? `${path} does not exist; keeper-setup writes it (docs/process/keeper.md)`
          : `${path} could not be opened (${code})`,
    };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { problem: `${path} is not a plain file` };
    if (st.uid !== uid) return { problem: `${path} is owned by uid ${st.uid}, not this user` };
    if ((st.mode & 0o077) !== 0) {
      return { problem: `${path} has mode ${(st.mode & 0o777).toString(8)}; it must be 600` };
    }
    const token = readFileSync(fd, 'utf8').trim();
    return TOKEN.test(token) ? { token } : { problem: `${path} does not hold a caller token` };
  } finally {
    closeSync(fd);
  }
}

/** Write the token to `path`, mode 600, in one rename; its folder is made 700 if missing. */
export function writeCallerToken(path: string, token: string): void {
  if (!TOKEN.test(token)) throw new Error('that is not a caller token');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
}
