/**
 * The central list of long-lived Claude tokens: a new project's deploy takes
 * one with no sign-in, one step moves a project to another listed token, and
 * an agent reads each token's usage with no token printed.
 *
 * `fly`, `security`, `script` and `claude` on PATH are stand-ins answering
 * from files in a temp folder, and each records its calls. `claude` here is
 * the browser approval: a test that means none asserts the count stayed 0.
 * The entrypoint runs under the stand-ins of `project-machine-harness.ts`.
 * Nothing reaches Fly, the Keychain or Anthropic.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  LEAD_TOKEN_ORG_SECRET,
  LEAD_TOKEN_SECRET,
  requiredSecrets,
} from '../../../infra/project-machine/deploy-plan.ts';
import {
  addToken,
  imageHasTokenList,
  readTokenList,
  tokenMarker,
  tokenSlot,
} from '../../../infra/project-machine/token-list.ts';
import { moveProject, waitForLabelCommand } from '../../../infra/project-machine/token-move.ts';
import { HELP, runTokens } from '../../../infra/project-machine/tokens.ts';
import { classifyFly } from '../src/keeper/keeper-policy.ts';
import { BASH, readRecords } from './project-machine-harness.ts';
import {
  APPROVED,
  BOARD,
  FIRST,
  ORGS,
  type Org,
  SECOND,
  SHARED,
  appDir,
  appEnv,
  approvalCount,
  bootMachine,
  deploy,
  expectNoTokenShown,
  flySecrets,
  imported,
  kc,
  keychain,
  leadStarted,
  listed,
  output,
  tmp,
  useTokenStandIns,
} from './project-machine-token-harness.ts';
import { waitFor } from './wait-for.ts';

useTokenStandIns();

describe('a new project takes a token from the list', () => {
  it('sets the first listed token with no browser approval, and prints no value', async () => {
    listed(1, 'first-account', FIRST);
    listed(2, 'second-account', SECOND);
    await deploy('harborlight');
    expect(approvalCount()).toBe(0);
    const env = appEnv('harborlight');
    expect(env[LEAD_TOKEN_SECRET]).toBe(FIRST);
    expect(env[LEAD_TOKEN_ORG_SECRET]).toBe(tokenMarker('harborlight', 'first-account', FIRST));
    expect(output.join('\n')).toContain('first-account');
    expectNoTokenShown(FIRST, SECOND);
  });

  it('takes the label --claude-token names', async () => {
    listed(1, 'first-account', FIRST);
    listed(2, 'second-account', SECOND);
    await deploy('riverbend', { claudeToken: 'second-account' });
    expect(appEnv('riverbend')[LEAD_TOKEN_SECRET]).toBe(SECOND);
    expect(approvalCount()).toBe(0);
  });

  it('--refresh-lead must name a listed token, so a moved project keeps its own', async () => {
    listed(1, 'first-account', FIRST);
    listed(2, 'second-account', SECOND);
    await expect(deploy('riverbend', { refreshLead: true })).rejects.toThrow('--claude-token');
    expect(imported('riverbend')).toEqual([]);
    await deploy('riverbend', { refreshLead: true, claudeToken: 'second-account' });
    expect(appEnv('riverbend')[LEAD_TOKEN_SECRET]).toBe(SECOND);
    expect(approvalCount()).toBe(0);
  });

  it('refuses an image older than this code before anything changes', async () => {
    listed(1, 'first-account', FIRST);
    await expect(deploy('riverbend', { imageLabel: '0'.repeat(40) })).rejects.toThrow(
      'cannot start a lead on a listed token',
    );
    expect(imported('riverbend')).toEqual([]);
  });

  it('refuses a label that is not listed before anything changes', async () => {
    listed(1, 'first-account', FIRST);
    await expect(deploy('riverbend', { claudeToken: 'no-such-account' })).rejects.toThrow(
      'no-such-account',
    );
    expect(imported('riverbend')).toEqual([]);
    expect(approvalCount()).toBe(0);
  });

  it('leaves a project that already has a token alone', async () => {
    listed(1, 'first-account', FIRST);
    flySecrets('riverbend', [
      ...requiredSecrets('quick'),
      LEAD_TOKEN_SECRET,
      LEAD_TOKEN_ORG_SECRET,
      'CW_LEAD_BOARD',
    ]);
    await deploy('riverbend');
    expect(imported('riverbend').some((l) => l.startsWith(`${LEAD_TOKEN_SECRET}=`))).toBe(false);
  });

  it('asks for the browser approval only when the list is empty', async () => {
    await deploy('harborlight');
    expect(approvalCount()).toBe(1);
    expect(appEnv('harborlight')[LEAD_TOKEN_SECRET]).toBe(APPROVED);
    expect(appEnv('harborlight')[LEAD_TOKEN_ORG_SECRET]).toBe('harborlight');
  });

  it('a dry run names the label and sets nothing', async () => {
    listed(1, 'first-account', FIRST);
    await deploy('harborlight', {}, true);
    expect(imported('harborlight')).toEqual([]);
    expect(output.join('\n')).toContain('first-account');
    expectNoTokenShown(FIRST);
  });
});

describe.skipIf(BASH === null)('the machine checks the marker', () => {
  const secretsFor = (org: Org, token: string, marker: string | undefined) => ({
    [LEAD_TOKEN_SECRET]: token,
    CW_LEAD_BOARD: BOARD[org],
    ...(marker !== undefined ? { [LEAD_TOKEN_ORG_SECRET]: marker } : {}),
  });

  it('two projects on one listed token each start a lead', async () => {
    for (const org of ORGS) {
      const m = bootMachine(org, secretsFor(org, FIRST, tokenMarker(org, 'first-account', FIRST)));
      await leadStarted(m);
      const { recs } = readRecords(m.log);
      const lead = recs.find((r) => r.argv.startsWith('claude'));
      expect(lead?.uid).toBe('lead');
      expect(lead?.env.get(LEAD_TOKEN_SECRET)).toBe(FIRST);
      expect(lead?.env.get('CW_LEAD_TOKEN_LABEL')).toBe('first-account');
      // Only the root supervisor reads the marker: it binds the token, so the
      // server's user does not hold it.
      const holding = recs.filter((r) => r.env.has(LEAD_TOKEN_ORG_SECRET));
      expect(holding.map((r) => r.uid)).toEqual([]);
      expect(readFileSync(join(m.volume, 'lead', 'token-label'), 'utf8').trim()).toBe(
        'first-account',
      );
      const settings = JSON.parse(
        readFileSync(join(m.homes, 'lead', '.claude', 'settings.json'), 'utf8'),
      );
      expect(settings.statusLine.command).toContain('lead-usage.ts');
    }
  }, 60_000);

  const refused: Array<[string, () => Record<string, string>]> = [
    [
      'a stale token under a marker made for another token',
      () => secretsFor('riverbend', SHARED, tokenMarker('riverbend', 'first-account', FIRST)),
    ],
    [
      'a marker copied from another project',
      () => secretsFor('riverbend', FIRST, tokenMarker('harborlight', 'first-account', FIRST)),
    ],
    ['a token with no marker', () => secretsFor('riverbend', SHARED, undefined)],
    [
      'a label changed in the marker',
      () =>
        secretsFor(
          'riverbend',
          FIRST,
          tokenMarker('riverbend', 'first-account', FIRST).replace('first', 'other'),
        ),
    ],
    ['a marker of the wrong shape', () => secretsFor('riverbend', FIRST, 'listed:x')],
  ];
  it.each(refused)(
    'starts no lead on %s',
    async (_name, secrets) => {
      const values = secrets();
      const m = bootMachine('riverbend', values);
      await waitFor(() => m.out.join('').includes('no lead agent runs'), {
        timeout: 20_000,
        describe: 'the entrypoint to refuse the lead',
      });
      await waitFor(() => readRecords(m.log).recs.some((r) => r.argv.startsWith('cloudflared')), {
        timeout: 20_000,
        describe: 'the tunnel to start',
      });
      expect(readRecords(m.log).recs.filter((r) => r.argv.startsWith('claude'))).toEqual([]);
      // The log carries no digest and no token.
      const log = m.out.join('');
      expect(log).not.toContain(values[LEAD_TOKEN_ORG_SECRET] ?? '\0');
      expect(log).not.toContain(values[LEAD_TOKEN_SECRET] as string);
    },
    30_000,
  );
});

describe('one step moves a project to another listed token', () => {
  beforeEach(() => {
    listed(1, 'first-account', FIRST);
    listed(2, 'second-account', SECOND);
    flySecrets('riverbend', [...requiredSecrets('quick'), 'CW_LEAD_BOARD', LEAD_TOKEN_SECRET]);
    writeFileSync(join(appDir('riverbend'), 'ssh-out'), 'cw-token-label=second-account\n');
  });
  const ready = () => true;

  it('imports the token and its marker in one call that restarts the machine', async () => {
    const r = moveProject('riverbend', 'second-account', { imageReady: ready });
    expect(r.confirmed).toBe(true);
    const env = appEnv('riverbend');
    expect(env[LEAD_TOKEN_SECRET]).toBe(SECOND);
    expect(env[LEAD_TOKEN_ORG_SECRET]).toBe(tokenMarker('riverbend', 'second-account', SECOND));
    const imports = readFileSync(join(appDir('riverbend'), 'imports'), 'utf8')
      .trim()
      .split('\n');
    expect(imports).toEqual(['secrets import --app cw-riverbend']);
    expectNoTokenShown(FIRST, SECOND);
  });

  it('the keeper holds that exact import, unchanged', () => {
    const v = classifyFly(['secrets', 'import', '--app', 'cw-riverbend'], ['cw-riverbend']);
    expect(v).toMatchObject({ kind: 'held', hold: 'token.move' });
  });

  it.skipIf(BASH === null)(
    'the machine booted from what the move set runs its lead on the new token',
    async () => {
      moveProject('riverbend', 'second-account', { imageReady: ready });
      const m = bootMachine('riverbend', {
        ...appEnv('riverbend'),
        CW_LEAD_BOARD: BOARD.riverbend,
      });
      await leadStarted(m);
      const lead = readRecords(m.log).recs.find((r) => r.argv.startsWith('claude'));
      expect(lead?.env.get(LEAD_TOKEN_SECRET)).toBe(SECOND);
      expect(lead?.env.get('CW_LEAD_TOKEN_LABEL')).toBe('second-account');
    },
    30_000,
  );

  it('confirms by waiting on the machine, in one shell, as the lead', () => {
    const root = mkdtempSync(join(tmp, 'wait-'));
    writeFileSync(join(root, 'token-label'), 'second-account\n');
    const stub = mkdtempSync(join(tmp, 'stub-'));
    writeFileSync(join(stub, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n');
    chmodSync(join(stub, 'timeout'), 0o755);
    writeFileSync(
      join(stub, 'setpriv'),
      `#!/bin/sh\necho "$*" > "${root}/setpriv"\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`,
    );
    chmodSync(join(stub, 'setpriv'), 0o755);
    const r = spawnSync(
      'sh',
      ['-c', waitForLabelCommand('second-account', root, `${stub}:/usr/bin:/bin`)],
      {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin' },
      },
    );
    expect(r.stdout.trim()).toBe('cw-token-label=second-account');
    expect(readFileSync(join(root, 'setpriv'), 'utf8')).toContain('--reuid=lead');
  });

  it('says so when the machine does not confirm', () => {
    writeFileSync(join(appDir('riverbend'), 'ssh-fails'), '');
    expect(moveProject('riverbend', 'second-account', { imageReady: ready }).confirmed).toBe(false);
    rmSync(join(appDir('riverbend'), 'ssh-fails'));
    writeFileSync(join(appDir('riverbend'), 'ssh-out'), 'cw-token-label=first-account\n');
    expect(moveProject('riverbend', 'second-account', { imageReady: ready }).confirmed).toBe(false);
  });

  it('refuses before any change: an unlisted label, no lead, no project, an old image', () => {
    expect(() => moveProject('riverbend', 'no-such', { imageReady: ready })).toThrow('no-such');
    expect(() => moveProject('Not A Project', 'second-account', { imageReady: ready })).toThrow();
    flySecrets('harborlight', requiredSecrets('quick'));
    expect(() => moveProject('harborlight', 'second-account', { imageReady: ready })).toThrow(
      'no lead',
    );
    expect(() => moveProject('riverbend', 'second-account', { imageReady: () => false })).toThrow(
      'machine:deploy',
    );
    expect(imported('riverbend')).toEqual([]);
    expect(imported('harborlight')).toEqual([]);
  });

  it('reads an image’s readiness from the commit it was built from', () => {
    const repo = mkdtempSync(join(tmp, 'repo-'));
    const git = (...a: string[]) =>
      spawnSync('git', ['-C', repo, '-c', 'user.name=Alice', '-c', 'user.email=alice', ...a], {
        encoding: 'utf8',
      }).stdout.trim();
    git('init', '-q');
    mkdirSync(join(repo, 'infra', 'project-machine'), { recursive: true });
    writeFileSync(join(repo, 'README'), 'x');
    git('add', '.');
    git('commit', '-qm', 'before');
    const before = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'infra', 'project-machine', 'token-list.ts'), '');
    git('add', '.');
    git('commit', '-qm', 'after');
    const after = git('rev-parse', 'HEAD');
    expect(imageHasTokenList(after, repo)).toBe(true);
    expect(imageHasTokenList(before, repo)).toBe(false);
    expect(imageHasTokenList('', repo)).toBe(false);
    expect(imageHasTokenList('0'.repeat(40), repo)).toBe(false);
  });
});

describe('the list', () => {
  it('stores a label and a token in the next free slot, and reads them back', () => {
    addToken('first-account', FIRST, '2026-11-07');
    addToken('second-account', SECOND, '2026-11-08');
    expect(existsSync(join(kc, tokenSlot(1)))).toBe(true);
    expect(existsSync(join(kc, tokenSlot(2)))).toBe(true);
    expect(readTokenList().map((t) => [t.label, t.token])).toEqual([
      ['first-account', FIRST],
      ['second-account', SECOND],
    ]);
  });

  it('skips a slot that was emptied', () => {
    listed(3, 'third-account', SECOND);
    expect(readTokenList().map((t) => t.label)).toEqual(['third-account']);
  });

  it('refuses a repeated label, a repeated token, the Mac’s own sign-in and a non-token', () => {
    addToken('first-account', FIRST, '2026-11-07');
    expect(() => addToken('first-account', SECOND, '2026-11-07')).toThrow('first-account');
    expect(() => addToken('other', FIRST, '2026-11-07')).toThrow('already');
    expect(() => addToken('other', SHARED, '2026-11-07')).toThrow('claude-lead-oauth-token');
    expect(() => addToken('other', 'sk-ant-api03-short', '2026-11-07')).toThrow('setup-token');
    expect(() => addToken('other', `${SECOND}\nCW_LEAD_BOARD=x`, '2026-11-07')).toThrow();
    expect(() => addToken('Has Spaces', SECOND, '2026-11-07')).toThrow('label');
    expect(() => addToken('alice@harborlight', SECOND, '2026-11-07')).toThrow('label');
    expect(readTokenList()).toHaveLength(1);
  });

  it('names a damaged entry and shows none of its value', () => {
    keychain(tokenSlot(1), `{"label":"x","token":"${SECOND}\\nA=b"}`);
    let message = '';
    try {
      readTokenList();
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain(tokenSlot(1));
    expect(message).not.toContain(SECOND.slice(0, 20));
  });
});

describe('machine:tokens', () => {
  it('the help says the list is the owner’s own accounts only, and why', async () => {
    expect(HELP).toContain('accounts Bryan owns');
    expect(HELP).toContain('another person');
    expect(await runTokens(['help'])).toBe(0);
    expect(output.join('\n')).toContain('accounts Bryan owns');
    expect(await runTokens(['nonsense'])).toBe(2);
  });

  it('add takes the token from one approval, shows none of it, and list shows the label', async () => {
    expect(
      await runTokens(['add', '--label', 'first-account'], { show: (t) => output.push(t) }),
    ).toBe(0);
    expect(approvalCount()).toBe(1);
    expect(readTokenList()[0]?.token).toBe(APPROVED);
    output.length = 0;
    expect(await runTokens(['list'])).toBe(0);
    expect(output.join('\n')).toContain('first-account');
    expect(output.join('\n')).toMatch(/expires about 20\d\d-\d\d-\d\d/);
    expectNoTokenShown(APPROVED);
  });

  it('add refuses a repeated label before it spends an approval', async () => {
    listed(1, 'first-account', FIRST);
    expect(await runTokens(['add', '--label', 'first-account'])).toBe(1);
    expect(approvalCount()).toBe(0);
  });

  it('add --stdin takes a token made elsewhere and asks for no approval', async () => {
    const code = await runTokens(['add', '--label', 'first-account', '--stdin'], {
      stdin: async () => `${FIRST}\n`,
    });
    expect(code).toBe(0);
    expect(approvalCount()).toBe(0);
    expect(readTokenList()[0]?.token).toBe(FIRST);
    expectNoTokenShown(FIRST);
  });

  it('move reports a failed confirmation with a non-zero exit', async () => {
    listed(1, 'first-account', FIRST);
    flySecrets('riverbend', [...requiredSecrets('quick'), 'CW_LEAD_BOARD']);
    writeFileSync(join(appDir('riverbend'), 'ssh-fails'), '');
    const code = await runTokens(['move', '--project', 'riverbend', '--to', 'first-account'], {
      imageReady: () => true,
    });
    expect(code).toBe(1);
    expect(output.join('\n')).toContain('not confirmed');
  });
});
