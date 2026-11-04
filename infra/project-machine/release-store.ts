/**
 * The releases a project machine holds on its volume, and which one it boots.
 *
 *   <root>/state.json           current, previous, trial, failed
 *   <root>/incoming/            one downloaded release, not yet installed:
 *       channel.json            its signed manifest
 *       cw-server-<sha>.tar.gz
 *   <root>/<commit>/            an installed release: the app the server runs
 *
 * The cycle, driven by `release-cli.ts` from `entrypoint.sh`:
 *
 *   check    (every poll) a newer signed release is downloaded into incoming/
 *            and the machine restarts.
 *   select   (every boot) a release in incoming/ is verified again, unpacked
 *            and put on trial; the server runs from the trial if there is one,
 *            else from `current` when it is newer than the image, else from
 *            the image. A trial still set at boot is a release that did not
 *            stay up: it is marked failed and `current` boots instead.
 *   promote  (once the server has answered for a while) the trial becomes
 *            `current`, and the old `current` becomes `previous`.
 *
 * A release runs against the image's installed packages: its own
 * `node_modules` holds only the link tree, and `node_modules/.bun` is a link
 * to the image's store. So a release whose bun.lock or Bun version differs
 * from the image's is refused; it needs an image deploy.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type ReleaseManifest, tarballName, verifyChannel } from './release-manifest.ts';

export interface ReleaseRef {
  commit: string;
  serial: number;
}

export interface FailedRelease extends ReleaseRef {
  reason: string;
  at: string;
}

export interface ReleaseState {
  current: ReleaseRef | null;
  previous: ReleaseRef | null;
  trial: ReleaseRef | null;
  failed: FailedRelease[];
}

/** What the image itself carries: its own serial and what a release must match. */
export interface ImageFacts {
  dir: string;
  /** From `infra/project-machine/image-release.json`, which machine:deploy writes; 0 without one. */
  serial: number;
  bun: string;
  lockSha256: string;
}

/** The file machine:deploy writes into the image's build context. */
export const IMAGE_RELEASE_FILE = join('infra', 'project-machine', 'image-release.json');
const KEEP_FAILED = 20;

export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

export function readImage(dir: string, bun: string = Bun.version): ImageFacts {
  let serial = 0;
  try {
    const raw = JSON.parse(readFileSync(join(dir, IMAGE_RELEASE_FILE), 'utf8')) as {
      serial?: unknown;
    };
    if (Number.isSafeInteger(raw.serial)) serial = raw.serial as number;
  } catch {
    // No file: an image from before releases, or a test. Any release is newer.
  }
  return { dir, serial, bun, lockSha256: sha256Hex(readFileSync(join(dir, 'bun.lock'))) };
}

const empty = (): ReleaseState => ({ current: null, previous: null, trial: null, failed: [] });

export function readState(root: string): ReleaseState {
  try {
    const s = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as Partial<ReleaseState>;
    return {
      current: s.current ?? null,
      previous: s.previous ?? null,
      trial: s.trial ?? null,
      failed: Array.isArray(s.failed) ? s.failed : [],
    };
  } catch {
    return empty();
  }
}

export function writeState(root: string, state: ReleaseState): void {
  const tmp = join(root, `.state.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, join(root, 'state.json'));
}

const ref = (m: ReleaseManifest): ReleaseRef => ({ commit: m.commit, serial: m.serial });

/** Why a verified release may not be installed here, or null when it may. */
export function refusal(m: ReleaseManifest, state: ReleaseState, image: ImageFacts): string | null {
  const floor = Math.max(image.serial, state.current?.serial ?? 0, state.trial?.serial ?? 0);
  if (m.serial <= floor) return `serial ${m.serial} is not newer than ${floor}`;
  if (state.failed.some((f) => f.commit === m.commit)) return 'it failed on this machine before';
  if (m.bun !== image.bun)
    return `it was built with Bun ${m.bun} and this image runs ${image.bun}: it needs an image deploy`;
  if (m.lockSha256 !== image.lockSha256)
    return 'its bun.lock differs from the image: it needs an image deploy';
  return null;
}

const incomingDir = (root: string) => join(root, 'incoming');

/** Puts a downloaded release in incoming/, replacing any there. Call only after `refusal` is null. */
export function stage(
  root: string,
  channelText: string,
  tarball: Uint8Array,
  m: ReleaseManifest,
): void {
  const dir = incomingDir(root);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  writeFileSync(join(dir, m.tarball), tarball, { mode: 0o644 });
  // The manifest last: it is what marks incoming/ as complete.
  writeFileSync(join(dir, 'channel.json'), channelText, { mode: 0o644 });
}

function fail(state: ReleaseState, r: ReleaseRef, reason: string): void {
  state.failed = [...state.failed, { ...r, reason, at: new Date().toISOString() }].slice(
    -KEEP_FAILED,
  );
}

/** Every symlink under `dir` (not followed) that does not resolve. */
function danglingLinks(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      if (!existsSync(p)) out.push(p);
    } else if (st.isDirectory()) {
      danglingLinks(p, out);
    }
  }
  return out;
}

/** The link trees a release carries: the root's and each workspace package's. */
function nodeModulesDirs(app: string): string[] {
  const dirs = [join(app, 'node_modules')];
  for (const group of ['packages', 'demos']) {
    const g = join(app, group);
    if (!existsSync(g)) continue;
    for (const name of readdirSync(g)) dirs.push(join(g, name, 'node_modules'));
  }
  return dirs.filter((d) => existsSync(d));
}

/** Unpacks a verified tarball into `<root>/<commit>`, linked to the image's packages. */
function unpack(root: string, m: ReleaseManifest, tarball: string, image: ImageFacts): void {
  const tmp = join(root, `.unpack-${m.commit}`);
  const dest = join(root, m.commit);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(tmp, { mode: 0o755 });
  try {
    const tar = spawnSync('tar', ['-xzf', tarball, '-C', tmp, '--no-same-owner'], {
      encoding: 'utf8',
    });
    if (tar.status !== 0) throw new Error(`tar failed: ${(tar.stderr ?? '').trim().slice(0, 200)}`);
    if (!existsSync(join(tmp, 'packages', 'server', 'src', 'bin.ts')))
      throw new Error('it has no packages/server/src/bin.ts');
    const store = join(tmp, 'node_modules', '.bun');
    if (existsSync(store) || isLink(store)) throw new Error('it carries its own node_modules/.bun');
    mkdirSync(join(tmp, 'node_modules'), { recursive: true });
    symlinkSync(join(image.dir, 'node_modules', '.bun'), store);
    const dangling = nodeModulesDirs(tmp).flatMap((d) => danglingLinks(d));
    if (dangling.length > 0) {
      const first = dangling[0]?.slice(tmp.length + 1);
      throw new Error(
        `${dangling.length} package links do not resolve against the image (${first})`,
      );
    }
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Installs the release in incoming/, if any, as the trial. It is verified
 * again here rather than trusted from the download: a half-written file, a
 * changed key or a newer image all show up as a refusal.
 */
function installIncoming(
  root: string,
  image: ImageFacts,
  publicKey: string,
  state: ReleaseState,
  log: string[],
): void {
  const dir = incomingDir(root);
  const channel = join(dir, 'channel.json');
  if (!existsSync(channel)) return;
  let m: ReleaseManifest | null = null;
  try {
    m = verifyChannel(readFileSync(channel, 'utf8'), publicKey);
    const why = refusal(m, state, image);
    if (why) throw new Error(why);
    const tarball = join(dir, tarballName(m.commit));
    const bytes = readFileSync(tarball);
    if (bytes.length !== m.size || sha256Hex(bytes) !== m.sha256)
      throw new Error('the tarball does not match its manifest');
    unpack(root, m, tarball, image);
    state.trial = ref(m);
    log.push(`release ${m.commit} (serial ${m.serial}) installed; booting it on trial`);
  } catch (e) {
    const reason = (e as Error).message;
    if (m) fail(state, ref(m), reason);
    log.push(`refused the downloaded release${m ? ` ${m.commit}` : ''}: ${reason}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface Selection {
  /** The app directory the server runs from. */
  dir: string;
  log: string[];
}

/** The boot decision. Writes the state it decided on. */
export function select(root: string, image: ImageFacts, publicKey: string | null): Selection {
  mkdirSync(root, { recursive: true });
  const state = readState(root);
  const log: string[] = [];
  if (state.trial) {
    const t = state.trial;
    fail(state, t, 'it did not stay up after its first boot');
    rmSync(join(root, t.commit), { recursive: true, force: true });
    state.trial = null;
    log.push(`release ${t.commit} did not stay up; rolling back`);
  }
  if (publicKey) installIncoming(root, image, publicKey, state, log);
  writeState(root, state);
  const pick =
    state.trial ?? (state.current && state.current.serial > image.serial ? state.current : null);
  const dir = pick ? join(root, pick.commit) : null;
  if (dir && existsSync(join(dir, 'packages', 'server', 'src', 'bin.ts'))) {
    log.push(`booting release ${pick?.commit}${state.trial ? ' (trial)' : ''}`);
    return { dir, log };
  }
  log.push(`booting the image's own app (serial ${image.serial})`);
  return { dir: image.dir, log };
}

/** Makes the trial current. Releases neither current nor previous are removed. */
export function promote(root: string): string[] {
  const state = readState(root);
  if (!state.trial) return [];
  const t = state.trial;
  state.previous = state.current;
  state.current = t;
  state.trial = null;
  writeState(root, state);
  const keep = new Set([state.current?.commit, state.previous?.commit, 'incoming', 'state.json']);
  for (const name of readdirSync(root)) {
    if (keep.has(name) || name.startsWith('.state.')) continue;
    rmSync(join(root, name), { recursive: true, force: true });
  }
  return [`release ${t.commit} (serial ${t.serial}) stayed up; it is now current`];
}
