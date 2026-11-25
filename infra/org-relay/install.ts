/**
 * `bun run relay:install` (`install-cli.ts`) — install the org relay for the
 * seats in `infra/org-relay/seats.json`, so nobody builds its config by hand.
 *
 * In order:
 *  1. For each seat, finds its board (the one whose lead is the seat's agent),
 *     finds or files its "Relay outbox" and "Relay inbox" tasks, and mints the
 *     relay's `at2` on that board (`routes/board-tokens.ts`): on the Mac at its
 *     loopback, on a project machine at the machine's loopback over
 *     `fly ssh console`. A token whose record is still live is kept; minting
 *     replaces it, and the old record is revoked once the check below passes.
 *  2. Writes the relay config (`relay-config.ts`) at mode 600. An Access
 *     service token is read from the Keychain (`tokenServices`).
 *  2b. On a project server with no Access in front, puts a token minted for
 *     Team Lead into the Mac's home-remotes file (`install-home.ts`), so Home
 *     can pull the board's feed and ack its escalations, and restarts the
 *     Mac's server, which reads that file at start.
 *  3. Writes the relay's LaunchAgent and (re)starts it.
 *  4. Sets CW_LEAD_INBOX_DOC and CW_RELAY_AGENT_ID as Fly secrets on each
 *     project app whose lead is a seat. Setting them restarts that machine,
 *     so an app whose values are unchanged is skipped.
 *  5. Checks the relay logged "running: N seats" and that every seat's
 *     server answered the relay's own read of its outbox.
 *
 * No token value is put in an argument, printed or logged.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { HOME_REMOTE_TOKENS_FILE } from '../../packages/server/src/home-remote-tokens.ts';
import {
  applySavedBearers,
  bearerExpiresAt,
} from '../../packages/server/src/org-relay/relay-bearers.ts';
import { readOutbox } from '../../packages/server/src/org-relay/relay-client.ts';
import {
  type RelayConfig,
  loadRelayConfig,
} from '../../packages/server/src/org-relay/relay-config.ts';
import type { TfOutputs } from '../cloudflare/outputs.ts';
import { tokenServices } from '../cloudflare/service-tokens.ts';
import {
  type ApiIo,
  type BoardCall,
  type RunResult,
  type TokenRecord,
  boardCall,
  fileTask,
  leadBoard,
  mintToken,
  revokeToken,
  taskTitled,
  tokenRecords,
} from './install-api.ts';
import { homeFeedAnswers, planHomeFeedTokens } from './install-home.ts';
import {
  MAC_SERVER,
  RELAY_LABEL,
  type ResolvedSeat,
  type ServerSecrets,
  inboxTitle,
  outboxTitle,
  parseSeatList,
  redacted,
  relayConfigText,
  relayPlist,
  serverPlans,
  tokenIdOf,
} from './install-plan.ts';

export interface InstallOptions {
  dryRun: boolean;
  remint: boolean;
  /** Seat id → board id, for a seat whose board the lookup cannot find. */
  boards: Map<string, string>;
  /** The file `CW_HOME_REMOTES_FILE` names on the Mac (`install-home.ts`). */
  homeRemotes?: string;
  /** Restart the Mac's server when that file changes; off with --no-server-restart. */
  restartServer?: boolean;
}

export interface InstallIo extends ApiIo {
  home: string;
  uid: number;
  seatsText: string;
  projects: string[];
  outputs: () => TfOutputs;
  launchctl: (args: string[]) => RunResult;
  keychain: (service: string) => string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
  /** How long to wait for the relay's "running" line. */
  startWaitMs?: number;
  /** How long to keep asking each server for its outbox. */
  answerWaitMs?: number;
}

export interface RelayPaths {
  dir: string;
  config: string;
  stateDir: string;
  log: string;
  installed: string;
  /** The Mac server's renewed home-feed tokens (`home-remote-tokens.ts`). */
  homeRenewed: string;
  plist: string;
  bun: string;
  repo: string;
}

export function relayPaths(home: string): RelayPaths {
  const support = join(home, 'Library', 'Application Support', 'claude-workspaces');
  const dir = join(support, 'relay');
  return {
    dir,
    config: join(dir, 'relay-config.json'),
    stateDir: join(dir, 'state'),
    log: join(dir, 'relay.log'),
    installed: join(dir, 'installed.json'),
    homeRenewed: join(support, 'data', HOME_REMOTE_TOKENS_FILE),
    plist: join(home, 'Library', 'LaunchAgents', `${RELAY_LABEL}.plist`),
    bun: join(support, 'bin', 'bun'),
    repo: join(support, 'repo'),
  };
}

/** The Mac's server's LaunchAgent, restarted when Home's file changes. */
const SERVER_LABEL = 'com.fryanpan.claude-workspaces';

/** A token the dry run has not minted: valid to the config parser, never sent. */
const UNMINTED = 'at2.unminted.relay.board.0.x';
const UNREAD_ID = 'unread.access';
const UNREAD_SECRET = 'unreadunreadunread';
const UNFILED = (kind: string) => `task:unfiled-${kind}`;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function writePrivate(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

const readOr = (path: string, fallback: string) =>
  existsSync(path) ? readFileSync(path, 'utf8') : fallback;

/** The config on disk now: its raw bearer values, and the values the relay
 *  actually holds once its renewals (`bearers.json`) are applied. */
function existingConfig(paths: RelayPaths): {
  raw: (server: string, board: string) => string | undefined;
  held: (server: string, board: string) => string | undefined;
} {
  let raw: Record<string, { bearers?: Record<string, string> }> = {};
  let loaded: RelayConfig | null = null;
  if (existsSync(paths.config)) {
    try {
      raw =
        (JSON.parse(readFileSync(paths.config, 'utf8')) as { servers?: typeof raw }).servers ?? {};
    } catch {
      raw = {};
    }
    const parsed = loadRelayConfig(paths.config);
    if (!('error' in parsed)) {
      applySavedBearers(parsed, paths.stateDir);
      loaded = parsed;
    }
  }
  return {
    raw: (server, board) => raw[server]?.bearers?.[board],
    held: (server, board) => loaded?.servers.get(server)?.bearers.get(board),
  };
}

export async function runInstall(opts: InstallOptions, io: InstallIo): Promise<number> {
  const say = (line: string) => io.out(`[relay:install] ${line}`);
  const would = opts.dryRun ? 'would ' : '';
  const list = parseSeatList(io.seatsText, io.projects);
  const servers = serverPlans(list, io.outputs());
  const paths = relayPaths(io.home);
  const existing = existingConfig(paths);
  const secrets = new Map<string, ServerSecrets>();
  const seats: ResolvedSeat[] = [];
  const revokes: Array<{ call: BoardCall; id: string; where: string }> = [];
  const calls = new Map<string, BoardCall>();
  const recordsOf = new Map<string, TokenRecord[]>();

  // 1. Boards, tasks and tokens, one server at a time.
  for (const server of servers) {
    const call = boardCall(server, io);
    calls.set(server.id, call);
    const records = await tokenRecords(call);
    recordsOf.set(server.id, records);
    const bearers = new Map<string, string>();
    for (const seat of list.seats.filter((s) => s.server === server.id)) {
      const named = opts.boards.get(seat.id);
      const found = named ? { board: named } : await leadBoard(call, seat.agentId);
      if ('error' in found) {
        throw new Error(
          `seat ${seat.id} on ${server.id}: ${found.error}; pass --board ${seat.id}=<board id>`,
        );
      }
      const board = found.board;
      const docFor = async (kind: string, title: string, body: string) => {
        const id = await taskTitled(call, board, title);
        if (id) return `task:${id}`;
        say(`${would}file the task "${title}" on ${server.id} board ${board}`);
        if (opts.dryRun) return UNFILED(kind);
        return `task:${await fileTask(call, board, { title, body, assignee: seat.agentId, author: list.relayAgentId })}`;
      };
      const outboxDoc = await docFor(
        'outbox',
        outboxTitle(seat.id),
        `${seat.id} posts here to reach another seat; the org relay reads it.`,
      );
      const inboxDoc = await docFor(
        'inbox',
        inboxTitle(seat.id),
        `The org relay delivers messages for ${seat.id} here.`,
      );
      seats.push({ ...seat, board, outboxDoc, inboxDoc });
      if (bearers.has(board)) continue;
      const held = existing.held(server.id, board);
      const heldId = held ? tokenIdOf(held) : null;
      const record = records.find((r) => r.id === heldId);
      const live =
        record !== undefined &&
        record.revokedAt === undefined &&
        (bearerExpiresAt(held as string) ?? 0) > io.now() &&
        record.agentId === list.relayAgentId &&
        record.boardId === board;
      const kept = existing.raw(server.id, board);
      const keep = live && !opts.remint && kept !== undefined;
      // Every other live relay record on this board is one an earlier run
      // left behind: a remint, a run that died after its mint, a seat that
      // moved. Each is revoked once the relay is answering on the new config.
      const where = `${server.id} board ${board}`;
      for (const r of records) {
        const relayOnBoard = r.agentId === list.relayAgentId && r.boardId === board;
        if (relayOnBoard && r.revokedAt === undefined && !(keep && r.id === record?.id)) {
          revokes.push({ call, id: r.id, where });
        }
      }
      if (keep) {
        say(`keeps the relay's token on ${where} (record ${record?.id})`);
        bearers.set(board, kept);
        continue;
      }
      say(
        `${would}mint the relay's token on ${where} for ${list.relayAgentId}` +
          (live ? `; it replaces record ${record?.id}, revoked once the relay answers` : ''),
      );
      bearers.set(board, opts.dryRun ? UNMINTED : await mintToken(call, list.relayAgentId, board));
    }
    const sec: ServerSecrets = { bearers };
    if (server.accessToken) {
      const svc = tokenServices(server.accessToken);
      // The dry run names the Keychain entries and reads neither.
      sec.serviceToken = opts.dryRun
        ? { clientId: UNREAD_ID, clientSecret: UNREAD_SECRET }
        : { clientId: io.keychain(svc.clientId), clientSecret: io.keychain(svc.secret) };
      say(
        `${would}read ${server.id}'s service token from the Keychain (${svc.clientId}, ${svc.secret})`,
      );
    }
    secrets.set(server.id, sec);
  }

  // Home's board tokens for Team Lead, on each server with no Access in front.
  const home = await planHomeFeedTokens({
    servers,
    seats,
    calls,
    records: recordsOf,
    teamLead: list.seats.find((s) => s.server === MAC_SERVER)?.agentId ?? '',
    path: opts.homeRemotes,
    renewedPath: paths.homeRenewed,
    remint: opts.remint,
    dryRun: opts.dryRun,
    now: io.now(),
    say,
  });
  revokes.push(...home.revokes);
  const restartServer = opts.restartServer !== false;
  const serverRestart = `launchctl kickstart -k gui/${io.uid}/${SERVER_LABEL}`;

  // 2. The config.
  const configText = relayConfigText(servers, secrets, seats);
  const plistText = relayPlist({
    bun: paths.bun,
    repo: paths.repo,
    configPath: paths.config,
    stateDir: paths.stateDir,
    logPath: paths.log,
  });
  let installed: { secrets?: Record<string, string> } = {};
  try {
    installed = JSON.parse(readOr(paths.installed, '{}'));
  } catch {
    say(`${paths.installed} is unreadable; every lead's settings are set again`);
  }
  const secretPlan = servers
    .filter((s) => s.app)
    .map((s) => {
      const leads = seats.filter((x) => x.server === s.id);
      if (leads.length !== 1)
        throw new Error(`${s.id} has ${leads.length} seats; one lead seat per project`);
      const lead = leads[0] as ResolvedSeat;
      const input = `CW_LEAD_INBOX_DOC=${lead.inboxDoc}\nCW_RELAY_AGENT_ID=${list.relayAgentId}\n`;
      return {
        app: s.app as string,
        input,
        same: installed.secrets?.[s.app as string] === sha(input),
      };
    });

  if (opts.dryRun) {
    say(`would write ${paths.config} (mode 600):`);
    io.out(redacted(configText));
    say(`would write ${paths.plist} and (re)start ${RELAY_LABEL}`);
    for (const p of secretPlan) {
      say(
        p.same
          ? `${p.app}: CW_LEAD_INBOX_DOC and CW_RELAY_AGENT_ID already set`
          : `would set on ${p.app}: ${p.input.trim().replace('\n', ', ')} (restarts the machine)`,
      );
    }
    if (home.text !== null) {
      say(`would write boardTokens into ${opts.homeRemotes}`);
      say(
        restartServer
          ? `would restart the Mac's server (${serverRestart}), which reads it at start`
          : `then run: ${serverRestart}`,
      );
    }
    for (const r of revokes) say(`would revoke record ${r.id} on ${r.where}`);
    return 0;
  }

  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const configChanged = readOr(paths.config, '') !== configText;
  if (configChanged) writePrivate(paths.config, configText);
  chmodSync(paths.config, 0o600);
  say(configChanged ? `wrote ${paths.config}` : `${paths.config} is unchanged`);
  if (home.text !== null && opts.homeRemotes) {
    writePrivate(opts.homeRemotes, home.text);
    say(`wrote boardTokens into ${opts.homeRemotes}`);
    if (restartServer) {
      const r = io.launchctl(['kickstart', '-k', `gui/${io.uid}/${SERVER_LABEL}`]);
      if (r.status !== 0) throw new Error(`restarting the Mac's server failed: ${r.stderr.trim()}`);
      say(`restarted the Mac's server, which reads that file at start`);
    } else {
      say(`the Mac's server reads that file at start: run ${serverRestart}`);
    }
  }

  // 3. The LaunchAgent. Its log's length now, so the check reads only what
  // the relay writes after this start.
  const logFrom = existsSync(paths.log) ? statSync(paths.log).size : 0;
  mkdirSync(join(io.home, 'Library', 'LaunchAgents'), { recursive: true });
  const plistChanged = readOr(paths.plist, '') !== plistText;
  if (plistChanged) writeFileSync(paths.plist, plistText, { mode: 0o644 });
  const domain = `gui/${io.uid}`;
  const loaded = io.launchctl(['print', `${domain}/${RELAY_LABEL}`]).status === 0;
  // Nothing the relay reads changed and it is running: leave it be, and
  // judge it by the last start it logged.
  const restarted = configChanged || plistChanged || !loaded;
  if (!restarted) {
    say(`${RELAY_LABEL} is loaded and nothing it reads changed; not restarted`);
  } else if (plistChanged || !loaded) {
    if (loaded) io.launchctl(['bootout', `${domain}/${RELAY_LABEL}`]);
    const r = io.launchctl(['bootstrap', domain, paths.plist]);
    if (r.status !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr.trim()}`);
    say(`loaded ${RELAY_LABEL}`);
  } else {
    const r = io.launchctl(['kickstart', '-k', `${domain}/${RELAY_LABEL}`]);
    if (r.status !== 0) throw new Error(`launchctl kickstart failed: ${r.stderr.trim()}`);
    say(`restarted ${RELAY_LABEL}`);
  }
  // 4. The lead's two settings on each project app.
  const done: Record<string, string> = { ...installed.secrets };
  for (const p of secretPlan) {
    if (p.same) {
      say(`${p.app}: CW_LEAD_INBOX_DOC and CW_RELAY_AGENT_ID already set`);
      continue;
    }
    const r = await io.fly(['secrets', 'import', '--app', p.app], p.input);
    if (r.status !== 0)
      throw new Error(`fly secrets import --app ${p.app} failed: ${r.stderr.trim()}`);
    done[p.app] = sha(p.input);
    writePrivate(paths.installed, `${JSON.stringify({ secrets: done }, null, 2)}\n`);
    say(`set CW_LEAD_INBOX_DOC and CW_RELAY_AGENT_ID on ${p.app}; the machine restarts`);
  }

  // 5. The check.
  const want = `running: ${seats.length} seats`;
  const deadline = io.now() + (io.startWaitMs ?? 30_000);
  const lastStart = (log: string) => log.match(/running: \d+ seats/g)?.pop();
  let started = false;
  while (!started && io.now() < deadline) {
    const log = readOr(paths.log, '');
    started = restarted ? log.slice(logFrom).includes(want) : lastStart(log) === want;
    if (!started) await io.sleep(250);
  }
  say(
    started ? `the relay logged "${want}"` : `the relay never logged "${want}"; read ${paths.log}`,
  );
  const config = loadRelayConfig(paths.config);
  if ('error' in config) throw new Error(`the written config is refused: ${config.error}`);
  applySavedBearers(config, paths.stateDir);
  // A machine whose secrets were just set is restarting: ask until it answers.
  const answerBy = io.now() + (io.answerWaitMs ?? 180_000);
  const untilAnswered = async (ask: () => Promise<boolean>) => {
    for (;;) {
      if (await ask()) return true;
      if (io.now() >= answerBy) return false;
      await io.sleep(2_000);
    }
  };
  let failed = 0;
  for (const seat of config.seats.values()) {
    const server = config.servers.get(seat.server);
    const ok =
      server !== undefined &&
      (await untilAnswered(
        async () => (await readOutbox(io.fetch, server, seat.board, seat.outboxDoc)) !== null,
      ));
    say(`${seat.id}: ${seat.server} ${ok ? 'answered' : 'did not answer'} the relay's outbox read`);
    if (!ok) failed++;
  }
  for (const check of home.checks) {
    const ok = await untilAnswered(() => homeFeedAnswers(io.fetch, check));
    say(`board ${check.board}: its home feed ${ok ? 'answered' : 'did not answer'} Home's token`);
    if (!ok) failed++;
  }
  const passed = started && failed === 0;
  for (const r of revokes) {
    if (!passed) {
      say(
        `left record ${r.id} on ${r.where} live, because the check failed; run again to revoke it`,
      );
      continue;
    }
    await revokeToken(r.call, r.id);
    say(`revoked record ${r.id} on ${r.where}`);
  }
  return passed ? 0 : 1;
}
