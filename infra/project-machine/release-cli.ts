#!/usr/bin/env bun
/**
 * The project machine's self-update, as `entrypoint.sh` runs it (as the
 * `cwrelease` user, which holds no secret):
 *
 *   bun release-cli.ts select  --root <dir> --image <app dir> [--public-key <pem>]
 *       At boot. Prints the app directory the server runs from.
 *   bun release-cli.ts promote --root <dir>
 *       Once the server has stayed up: the trial becomes current.
 *   bun release-cli.ts check   --root <dir> --image <app dir> [--public-key <pem>]
 *       Each poll. Exits 10 when it downloaded a newer signed release, so the
 *       machine restarts into it; 0 otherwise, including on every refusal.
 *
 * The public key defaults to `release-signing-key.pub` beside this file, which
 * is to say the one baked into the image. Without it nothing is installed and
 * the image's own app runs. The channel is CW_RELEASE_CHANNEL_URL, else
 * DEFAULT_CHANNEL_URL; every byte from it is checked against that key.
 * The design is in docs/process/project-machine.md, "Releases".
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MAX_TARBALL_BYTES, verifyChannel } from './release-manifest.ts';
import {
  promote,
  readImage,
  readState,
  refusal,
  select,
  sha256Hex,
  stage,
} from './release-store.ts';

export const DEFAULT_CHANNEL_URL =
  'https://github.com/fryanpan/claude-workspaces-plugin/releases/download/server-channel';
export const STAGED_EXIT = 10;
export const BAKED_KEY = join(
  dirname(new URL(import.meta.url).pathname),
  'release-signing-key.pub',
);

const say = (line: string) => console.error(`[release] ${line}`);

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function publicKey(args: string[]): string | null {
  const path = flag(args, '--public-key') ?? BAKED_KEY;
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** GET a URL into bytes, refusing a body over `max`. Null on 404. */
async function download(url: string, max: number): Promise<Uint8Array | null> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > max) throw new Error(`${url} is ${length} bytes, over ${max}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > max) throw new Error(`${url} is over ${max} bytes`);
  return bytes;
}

/** One poll. Returns the exit code. */
export async function check(
  root: string,
  imageDir: string,
  key: string | null,
  channelUrl: string,
): Promise<number> {
  if (!key) {
    say('no release key in this image: self-update is off');
    return 0;
  }
  const state = readState(root);
  if (state.trial) return 0;
  const base = channelUrl.replace(/\/+$/, '');
  const channel = await download(`${base}/channel.json`, 64 * 1024);
  if (!channel) return 0;
  const text = new TextDecoder().decode(channel);
  let m: ReturnType<typeof verifyChannel>;
  try {
    m = verifyChannel(text, key);
  } catch (e) {
    say(`refused the published release: ${(e as Error).message}`);
    return 0;
  }
  const why = refusal(m, state, readImage(imageDir));
  if (why) {
    // The common case, every poll between releases, says nothing.
    if (!why.startsWith('serial')) say(`not installing ${m.commit}: ${why}`);
    return 0;
  }
  const tarball = await download(`${base}/${m.tarball}`, Math.min(m.size, MAX_TARBALL_BYTES));
  if (!tarball || tarball.length !== m.size || sha256Hex(tarball) !== m.sha256) {
    say(`refused ${m.commit}: its tarball does not match the signed manifest`);
    return 0;
  }
  stage(root, text, tarball, m);
  say(`downloaded release ${m.commit} (serial ${m.serial}); restarting to boot it`);
  return STAGED_EXIT;
}

async function main(args: string[]): Promise<number> {
  const [cmd] = args;
  const root = flag(args, '--root');
  if (!root) throw new Error('--root is required');
  if (cmd === 'promote') {
    for (const line of promote(root)) say(line);
    return 0;
  }
  const image = flag(args, '--image');
  if (!image) throw new Error('--image is required');
  if (cmd === 'select') {
    const s = select(root, readImage(image), publicKey(args));
    for (const line of s.log) say(line);
    console.log(s.dir);
    return 0;
  }
  if (cmd === 'check') {
    const url = process.env.CW_RELEASE_CHANNEL_URL?.trim() || DEFAULT_CHANNEL_URL;
    return check(root, image, publicKey(args), url);
  }
  throw new Error('usage: release-cli.ts select|promote|check --root <dir> [--image <dir>]');
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: Error) => {
      say(e.message);
      process.exit(1);
    },
  );
}
