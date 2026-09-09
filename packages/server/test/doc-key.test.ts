import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveWorkspaceId } from '../src/bind-meta.ts';
import {
  docKeyForPath,
  makeDocKey,
  normalizeRemoteUrl,
  parseDocKey,
  readOriginUrl,
  repoIdentityAt,
} from '../src/doc-key.ts';
import { gitCommonDir } from '../src/doc-origin-repo.ts';

/**
 * Identity is repo + path, so the assertion that carries the feature is that
 * two DIFFERENT checkouts of one repo produce the SAME key for the same file.
 *
 * Every such assertion is paired with a control on the same fixture proving
 * the two checkouts really are distinct places — `deriveWorkspaceId`, the
 * absolute-path hash this replaces, must still tell them apart. Without that
 * pair a "both sides agree" test passes just as happily against a function
 * that returns a constant, which is the exact regression that must not ship.
 *
 * Real repos and real worktrees via the git CLI; the readers under test are
 * pure filesystem reads and would otherwise be asserted against a mock of the
 * layout rather than the layout. All fixtures are synthetic.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

describe('normalizeRemoteUrl', () => {
  it('collapses every spelling of one repo to one identity', () => {
    const want = 'github.com/example/widgets';
    expect(normalizeRemoteUrl('https://github.com/example/widgets.git')).toBe(want);
    expect(normalizeRemoteUrl('https://user@github.com/example/widgets')).toBe(want);
    expect(normalizeRemoteUrl('git@github.com:example/widgets.git')).toBe(want);
    expect(normalizeRemoteUrl('ssh://git@github.com/example/widgets/')).toBe(want);
    // The host is case-insensitive by the DNS rules, so it folds; the path
    // does not, so it is left exactly as written.
    expect(normalizeRemoteUrl('  https://GitHub.com/example/widgets.git  ')).toBe(want);
  });

  it('keeps two repository paths that differ only in case apart', () => {
    // `host/Team/Widget` and `host/team/widget` are two repositories on a
    // case-sensitive server. Folding the path would put two projects'
    // documents on one key, which is worse than the re-key that a
    // case-insensitive host would occasionally cause.
    expect(normalizeRemoteUrl('git@github.com:Team/Widget.git')).toBe('github.com/Team/Widget');
    expect(normalizeRemoteUrl('git@github.com:Team/Widget.git')).not.toBe(
      normalizeRemoteUrl('git@github.com:team/widget.git') as string,
    );
    // CONTROL for the same pair: the HOST still folds, so this is a decision
    // about paths and not a normaliser that stopped normalising.
    expect(normalizeRemoteUrl('git@GitHub.COM:Team/Widget.git')).toBe(
      normalizeRemoteUrl('git@github.com:Team/Widget.git') as string,
    );
  });

  it('keeps different repos apart', () => {
    // The control for the case above: a normaliser that returned a constant
    // would pass every assertion there and fail here.
    expect(normalizeRemoteUrl('git@github.com:example/widgets.git')).not.toBe(
      normalizeRemoteUrl('git@github.com:example/gadgets.git'),
    );
    expect(normalizeRemoteUrl('git@gitlab.com:example/widgets.git')).not.toBe(
      normalizeRemoteUrl('git@github.com:example/widgets.git'),
    );
  });

  it('refuses a remote that names nothing', () => {
    expect(normalizeRemoteUrl('')).toBeNull();
    expect(normalizeRemoteUrl('   ')).toBeNull();
    expect(normalizeRemoteUrl('https://')).toBeNull();
    expect(normalizeRemoteUrl('.git')).toBeNull();
  });

  it('keeps a local path remote as its own identity', () => {
    expect(normalizeRemoteUrl('/srv/git/widgets.git')).toBe('/srv/git/widgets');
  });
});

describe('makeDocKey / parseDocKey', () => {
  it('round-trips a relPath containing spaces and colons', () => {
    const rel = 'docs/design notes/a: b.md';
    const key = makeDocKey('git:github.com/example/widgets', rel);
    expect(parseDocKey(key)).toEqual({
      repoKey: 'git:github.com/example/widgets',
      relPath: rel,
    });
  });

  it('rejects a string that is not a key', () => {
    expect(parseDocKey('git:github.com/example/widgets')).toBeNull();
    expect(parseDocKey('')).toBeNull();
  });
});

describe('repo + path identity across checkouts', () => {
  let tmp: string;
  let main: string;
  let wt: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cw-dockey-')));
    main = join(tmp, 'repo');
    mkdirSync(main);
    git(main, 'init', '-b', 'main');
    mkdirSync(join(main, 'docs'));
    writeFileSync(join(main, 'docs', 'plan.md'), '# plan\n');
    git(main, 'add', '.');
    git(main, 'commit', '-m', 'init');
    wt = join(tmp, 'wt-feature');
    git(main, 'worktree', 'add', wt, '-b', 'feature');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('CONTROL: the two checkouts are genuinely different places', () => {
    // What the old identity did, and why a worktree copy forked. Every
    // "same key" assertion below is only meaningful beside this one.
    expect(main).not.toBe(wt);
    expect(deriveWorkspaceId(main)).not.toBe(deriveWorkspaceId(wt));
  });

  it('gives one repoKey to every checkout, with no remote configured', () => {
    const a = repoIdentityAt(join(main, 'docs/plan.md'));
    const b = repoIdentityAt(join(wt, 'docs/plan.md'));
    expect(a?.repoKey).toBeDefined();
    expect(a?.repoKey.startsWith('dir:')).toBe(true);
    expect(b?.repoKey).toBe(a?.repoKey as string);
    expect(b?.mainRoot).toBe(main);
  });

  it('gives one repoKey to every checkout, keyed on the remote when there is one', () => {
    git(main, 'remote', 'add', 'origin', 'git@github.com:example/widgets.git');
    const a = repoIdentityAt(join(main, 'docs/plan.md'));
    const b = repoIdentityAt(join(wt, 'docs/plan.md'));
    expect(a?.repoKey).toBe('git:github.com/example/widgets');
    expect(b?.repoKey).toBe('git:github.com/example/widgets');
  });

  it('gives one docKey to the same file reached through either checkout', () => {
    git(main, 'remote', 'add', 'origin', 'https://github.com/example/widgets.git');
    const a = docKeyForPath(join(main, 'docs/plan.md'));
    const b = docKeyForPath(join(wt, 'docs/plan.md'));
    expect(a?.relPath).toBe('docs/plan.md');
    expect(b?.relPath).toBe('docs/plan.md');
    expect(b?.docKey).toBe(a?.docKey as string);
    // …while still recording WHICH checkout the caller was standing in.
    expect(a?.checkoutRoot).toBe(main);
    expect(b?.checkoutRoot).toBe(wt);
  });

  it('gives DIFFERENT docKeys to different files in the same repo', () => {
    writeFileSync(join(main, 'docs', 'other.md'), '# other\n');
    const a = docKeyForPath(join(main, 'docs/plan.md'));
    const b = docKeyForPath(join(main, 'docs/other.md'));
    expect(a?.docKey).not.toBe(b?.docKey as string);
  });

  it('re-keys when the remote URL changes, so the registry has something to alias', () => {
    git(main, 'remote', 'add', 'origin', 'git@github.com:example/widgets.git');
    const before = docKeyForPath(join(main, 'docs/plan.md'))?.docKey;
    git(main, 'remote', 'set-url', 'origin', 'git@github.com:example/gadgets.git');
    const after = docKeyForPath(join(main, 'docs/plan.md'))?.docKey;
    expect(before).toBeDefined();
    expect(after).not.toBe(before as string);
  });

  it('has no key for a path outside any repo, or inside .git', () => {
    expect(docKeyForPath(join(tmp, 'loose.md'))).toBeNull();
    expect(docKeyForPath(join(main, '.git/config'))).toBeNull();
  });

  it('derives a key for a file that does not exist yet', () => {
    const k = docKeyForPath(join(main, 'docs/not-written-yet.md'));
    expect(k?.relPath).toBe('docs/not-written-yet.md');
  });

  it('readOriginUrl reads the url git actually wrote, and nothing else', () => {
    const common = gitCommonDir(main) as string;
    expect(readOriginUrl(common)).toBeNull();
    git(main, 'remote', 'add', 'upstream', 'git@github.com:example/upstream.git');
    // A remote that is not `origin` must not become the repo's identity.
    expect(readOriginUrl(common)).toBeNull();
    git(main, 'remote', 'add', 'origin', 'git@github.com:example/widgets.git');
    expect(readOriginUrl(common)).toBe('git@github.com:example/widgets.git');
  });
});

/**
 * A remote that is a path on this machine, not a URL.
 *
 * `../remote.git` is what `git clone ../remote.git` writes, and normalising
 * it as a URL yields `../remote` — a key with no repo in it. Two unrelated
 * projects that each sit beside a sibling of that name would then share a
 * repoKey and their same-relative-path files would resolve to one document.
 */
describe('a local origin is keyed by where it resolves to', () => {
  let tmp: string;

  function repoWithLocalOrigin(dir: string, origin: string): string {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-b', 'main');
    git(dir, 'remote', 'add', 'origin', origin);
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'plan.md'), '# plan\n');
    return dir;
  }

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cw-localorigin-')));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('CONTROL: the two spellings are identical, so only resolution can separate them', () => {
    // The bug this replaces, stated as an assertion: read as a URL, the two
    // origins below are the same string. A key derived from that string alone
    // cannot tell the repos apart, so the test after this one is meaningful.
    expect(normalizeRemoteUrl('../remote.git')).toBe(normalizeRemoteUrl('../remote.git'));
  });

  it('keeps two repos in different parents with the same relative origin apart', () => {
    const one = repoWithLocalOrigin(join(tmp, 'alpha', 'project'), '../remote.git');
    const two = repoWithLocalOrigin(join(tmp, 'beta', 'project'), '../remote.git');
    const a = repoIdentityAt(join(one, 'docs/plan.md'));
    const b = repoIdentityAt(join(two, 'docs/plan.md'));
    expect(a?.repoKey.startsWith('file:')).toBe(true);
    expect(b?.repoKey.startsWith('file:')).toBe(true);
    expect(b?.repoKey).not.toBe(a?.repoKey as string);
    // …and therefore neither do their same-relative-path files.
    expect(docKeyForPath(join(two, 'docs/plan.md'))?.docKey).not.toBe(
      docKeyForPath(join(one, 'docs/plan.md'))?.docKey as string,
    );
  });

  it('still gives two clones of ONE local remote the same key', () => {
    // The half the fix must not break: resolving is what makes the same
    // remote match, spelled relatively from one clone and absolutely from
    // the other.
    const shared = join(tmp, 'shared', 'remote.git');
    mkdirSync(shared, { recursive: true });
    const one = repoWithLocalOrigin(join(tmp, 'shared', 'checkout-a'), '../remote.git');
    const two = repoWithLocalOrigin(join(tmp, 'elsewhere', 'checkout-b'), shared);
    expect(repoIdentityAt(join(two, 'docs/plan.md'))?.repoKey).toBe(
      repoIdentityAt(join(one, 'docs/plan.md'))?.repoKey as string,
    );
  });

  it('a URL remote is still keyed as a remote', () => {
    // The control on the branch above: the local path is a NEW case, not a
    // replacement for the one that was already right.
    const dir = repoWithLocalOrigin(join(tmp, 'urly'), 'git@github.com:example/widgets.git');
    expect(repoIdentityAt(join(dir, 'docs/plan.md'))?.repoKey).toBe(
      'git:github.com/example/widgets',
    );
  });
});
