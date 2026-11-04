/**
 * The project machine's self-update (`infra/project-machine/release-*.ts`):
 * a release CI signed is checked against the key baked into the image before
 * anything is installed, a newer one is downloaded and booted on trial, a
 * trial that stays up becomes current, and one that does not is rolled back
 * to the release before it.
 *
 * Everything runs for real against a throwaway key pair and a local release
 * store served over HTTP: the tarball, the signature, `tar`, the link tree.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STAGED_EXIT, check } from '../../../infra/project-machine/release-cli.ts';
import { signChannel, verifyChannel } from '../../../infra/project-machine/release-manifest.ts';
import { keygen, serialOf } from '../../../infra/project-machine/release-publish.ts';
import {
  promote,
  readImage,
  readState,
  select,
} from '../../../infra/project-machine/release-store.ts';
import { Store } from './project-machine-release-channel.ts';
import { commitFor, makeKeys, publish, writeImage } from './project-machine-release-fixture.ts';

const scratch = mkdtempSync(join(tmpdir(), 'machine-release-'));
const store = new Store(scratch);
afterAll(() => {
  store.stop();
  rmSync(scratch, { recursive: true, force: true });
});
const keys = makeKeys();

/** What the server entry point of an app the test made says. */
function serverSays(app: string): string {
  const entry = join(app, 'packages', 'server', 'src', 'bin.ts');
  // audit: not-source — the entry point of a fixture release unpacked under tmp
  return readFileSync(entry, 'utf8');
}

function machine(imageSerial = 1) {
  const image = writeImage(mkdtempSync(join(scratch, 'image-')), keys, imageSerial);
  const root = mkdtempSync(join(scratch, 'releases-'));
  return {
    image,
    root,
    check: () => check(root, image, keys.publicKey, store.url),
    boot: () => select(root, readImage(image), keys.publicKey).dir,
    serverSays,
  };
}

describe('the release signature', () => {
  it('verifies a manifest signed with the key, and nothing else', () => {
    const m = publish(scratch, store, keys, 5);
    const text = readFileSync(join(store.dir, 'channel.json'), 'utf8');
    // POSITIVE CONTROL: the real key verifies the real file.
    expect(verifyChannel(text, keys.publicKey).commit).toBe(m.commit);
    expect(() => verifyChannel(text, makeKeys().publicKey)).toThrow('signature does not match');
    // One byte of the manifest changed under the same signature.
    const e = JSON.parse(text) as { manifest: string; signature: string };
    const forged = Buffer.from(e.manifest, 'base64')
      .toString('utf8')
      .replace('"serial":5', '"serial":9');
    const tampered = JSON.stringify({ ...e, manifest: Buffer.from(forged).toString('base64') });
    expect(() => verifyChannel(tampered, keys.publicKey)).toThrow('signature does not match');
  });
});

describe('a machine checking for a release', () => {
  it('refuses a release whose signature does not match, and keeps running what it ran', async () => {
    const box = machine();
    publish(scratch, store, makeKeys(), 2);
    expect(await box.check()).toBe(0);
    expect(existsSync(join(box.root, 'incoming'))).toBe(false);
    expect(box.boot()).toBe(box.image);
    // POSITIVE CONTROL: the same release signed with the baked key is taken.
    publish(scratch, store, keys, 2);
    expect(await box.check()).toBe(STAGED_EXIT);
  });

  it('refuses a tarball that is not the one the manifest signed', async () => {
    const box = machine();
    const m = publish(scratch, store, keys, 2);
    writeFileSync(join(store.dir, m.tarball), 'not the release');
    expect(await box.check()).toBe(0);
    expect(existsSync(join(box.root, 'incoming'))).toBe(false);
  });

  it('refuses a downloaded release whose signature no longer verifies at boot', async () => {
    const box = machine();
    publish(scratch, store, keys, 2);
    expect(await box.check()).toBe(STAGED_EXIT);
    // Something rewrote incoming/ between the download and the boot.
    const channel = join(box.root, 'incoming', 'channel.json');
    const m = verifyChannel(readFileSync(channel, 'utf8'), keys.publicKey);
    writeFileSync(channel, signChannel(m, makeKeys().privateKey));
    expect(box.boot()).toBe(box.image);
    expect(readState(box.root).trial).toBeNull();
  });

  it('refuses a release no newer than the image, and one that needs an image deploy', async () => {
    const box = machine(7);
    publish(scratch, store, keys, 7);
    expect(await box.check()).toBe(0);
    publish(scratch, store, keys, 8, { lock: 'lockfile v2\n' });
    expect(await box.check()).toBe(0);
    publish(scratch, store, keys, 9, { bun: '0.0.1' });
    expect(await box.check()).toBe(0);
    expect(existsSync(join(box.root, 'incoming'))).toBe(false);
  });
});

describe('a machine booting a release', () => {
  it('boots a new release on trial, makes it current once it stays up, and rolls back a bad one', async () => {
    const box = machine();
    publish(scratch, store, keys, 2);
    expect(await box.check()).toBe(STAGED_EXIT);

    // The restart: the release is unpacked, linked to the image's packages and tried.
    const two = box.boot();
    expect(two).toBe(join(box.root, commitFor(2)));
    expect(box.serverSays(two)).toContain('release 2');
    expect(readlinkSync(join(two, 'node_modules', '.bun'))).toBe(
      join(box.image, 'node_modules', '.bun'),
    );
    expect(existsSync(join(two, 'packages', 'server', 'node_modules', 'lib0', 'index.js'))).toBe(
      true,
    );
    // While a release is on trial the machine downloads nothing else.
    publish(scratch, store, keys, 3);
    expect(await box.check()).toBe(0);

    promote(box.root);
    expect(readState(box.root).current?.commit).toBe(commitFor(2));
    expect(box.boot()).toBe(two);

    // Release 3 is downloaded and tried, and the machine restarts before it is promoted.
    expect(await box.check()).toBe(STAGED_EXIT);
    expect(box.boot()).toBe(join(box.root, commitFor(3)));
    const back = box.boot();
    expect(back).toBe(two);
    const s = readState(box.root);
    expect(s.current?.commit).toBe(commitFor(2));
    expect(s.failed.map((f) => f.commit)).toEqual([commitFor(3)]);
    expect(existsSync(join(box.root, commitFor(3)))).toBe(false);
    // A release that failed here is never downloaded again.
    expect(await box.check()).toBe(0);

    // Release 4 succeeds: 2 becomes previous, and nothing older is kept.
    publish(scratch, store, keys, 4);
    expect(await box.check()).toBe(STAGED_EXIT);
    expect(box.boot()).toBe(join(box.root, commitFor(4)));
    promote(box.root);
    const after = readState(box.root);
    expect([after.current?.commit, after.previous?.commit]).toEqual([commitFor(4), commitFor(2)]);
  });

  it('boots the image when the image is newer than the current release', async () => {
    const box = machine();
    publish(scratch, store, keys, 2);
    await box.check();
    box.boot();
    promote(box.root);
    expect(box.boot()).toBe(join(box.root, commitFor(2)));
    writeFileSync(
      join(box.image, 'infra', 'project-machine', 'image-release.json'),
      JSON.stringify({ commit: commitFor(5), serial: 5 }),
    );
    expect(box.boot()).toBe(box.image);
  });

  it('boots the image and installs nothing when the image has no release key', async () => {
    const box = machine();
    publish(scratch, store, keys, 2);
    expect(await check(box.root, box.image, null, store.url)).toBe(0);
    expect(select(box.root, readImage(box.image), null).dir).toBe(box.image);
  });
});

describe('the signing pair and the serial', () => {
  it('writes a private key only its owner reads, which signs what the public key verifies', () => {
    const dir = mkdtempSync(join(scratch, 'keygen-'));
    const priv = join(dir, 'signing.pem');
    const pub = join(dir, 'signing.pub');
    keygen(priv, pub);
    expect(statSync(priv).mode & 0o777).toBe(0o600);
    const m = publish(scratch, store, { privateKey: readFileSync(priv, 'utf8'), publicKey: '' }, 4);
    const text = readFileSync(join(store.dir, 'channel.json'), 'utf8');
    expect(verifyChannel(text, readFileSync(pub, 'utf8')).commit).toBe(m.commit);
    // A second run never replaces the key a release store is signed with.
    expect(() => keygen(priv, pub)).toThrow('exists');
  });

  it("counts a commit's position on main, one more for each commit after it", () => {
    // A repository of its own: CI's checkout of this one is shallow.
    const repo = mkdtempSync(join(scratch, 'repo-'));
    const git = (...args: string[]) =>
      spawnSync(
        'git',
        ['-C', repo, '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', ...args],
        {
          encoding: 'utf8',
        },
      );
    git('init', '-q');
    for (let i = 0; i < 3; i++) git('commit', '-q', '--allow-empty', '-m', `c${i}`);
    expect(serialOf(repo, 'HEAD')).toBe(3);
    expect(serialOf(repo, 'HEAD~2')).toBe(1);
    expect(() => serialOf(repo, 'no-such-ref')).toThrow('no serial');
  });
});
