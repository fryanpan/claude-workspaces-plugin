/**
 * The pure half of `bun run relay:install` (`install.ts`): the checked-in
 * seat list, the servers it implies, the relay config written from them, the
 * launchd plist, and the redaction the dry run prints with.
 *
 * The seat list (`seats.json`) names seats by role, never by board or doc
 * id: those are found on each server at install time, so nothing in the
 * public repo names a board.
 *
 *   {"relayAgentId": "agent-relay", "macOrganization": "<org id>",
 *    "seats": [
 *      {"id": "team-lead", "server": "mac", "agentId": "agent-team-lead",
 *       "crossOrganization": true},
 *      {"id": "<project>-lead", "project": "<project in machines.json>",
 *       "agentName": "<optional, default <project>-lead>",
 *       "accessToken": "<Cloudflare service token name, where Access is in front>",
 *       "crossOrganization": true, "restartFrom": ["team-lead"]}]}
 *
 * A seat's board is the one board on its server whose lead is the seat's
 * agent; `--board <seat>=<board id>` names it when there is not exactly one.
 */
import { agentIdForName } from '../../packages/core/src/identity.ts';
import { parseRelayConfig } from '../../packages/server/src/org-relay/relay-config.ts';
import type { TfOutputs } from '../cloudflare/outputs.ts';
import { signInHost } from '../project-machine/settings.ts';

export const MAC_SERVER = 'mac';
export const MAC_BASE_URL = 'http://127.0.0.1:8787';
export const RELAY_LABEL = 'com.fryanpan.claude-workspaces-relay';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROJECT = /^[a-z][a-z0-9-]{1,30}$/;
const TOKEN_NAME = /^[A-Za-z0-9 ._-]{1,128}$/;

export interface SeatSpec {
  id: string;
  /** `mac`, or the project whose machine the seat is on. */
  server: string;
  project?: string;
  agentId: string;
  accessToken?: string;
  crossOrganization: boolean;
  untrusted: boolean;
  restartFrom: string[];
}

export interface SeatList {
  relayAgentId: string;
  macOrganization: string;
  seats: SeatSpec[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const bool = (seat: string, raw: Record<string, unknown>, name: string): boolean => {
  const v = raw[name];
  if (v !== undefined && typeof v !== 'boolean')
    throw new Error(`seat ${seat}: ${name} is true or false`);
  return v === true;
};

/** The seat list, checked against the projects machines.json names. */
export function parseSeatList(text: string, projects: readonly string[]): SeatList {
  const raw = JSON.parse(text) as unknown;
  if (!isObject(raw) || !Array.isArray(raw.seats))
    throw new Error('seats.json has no "seats" list');
  const relayAgentId = raw.relayAgentId;
  if (typeof relayAgentId !== 'string' || !ID.test(relayAgentId)) {
    throw new Error('seats.json relayAgentId is not an agent id');
  }
  const macOrganization = raw.macOrganization;
  if (typeof macOrganization !== 'string' || !ID.test(macOrganization)) {
    throw new Error('seats.json macOrganization is not a plain id');
  }
  const seats: SeatSpec[] = raw.seats.map((s, i): SeatSpec => {
    if (!isObject(s) || typeof s.id !== 'string' || !ID.test(s.id)) {
      throw new Error(`seats.json entry ${i} has no valid id`);
    }
    const id = s.id;
    const onMac = s.server === MAC_SERVER;
    const project = s.project;
    if (onMac === (project !== undefined)) {
      throw new Error(`seat ${id}: name "server": "mac" or a "project", not both`);
    }
    if (
      !onMac &&
      (typeof project !== 'string' || !PROJECT.test(project) || !projects.includes(project))
    ) {
      throw new Error(`seat ${id}: project is not one machines.json lists`);
    }
    let agentId: string;
    if (onMac) {
      if (typeof s.agentId !== 'string' || !ID.test(s.agentId)) {
        throw new Error(`seat ${id}: a Mac seat names its agentId`);
      }
      agentId = s.agentId;
    } else {
      const name = s.agentName ?? `${project}-lead`;
      if (typeof name !== 'string') throw new Error(`seat ${id}: agentName is a name`);
      agentId = agentIdForName(name);
    }
    if (
      s.accessToken !== undefined &&
      (typeof s.accessToken !== 'string' || !TOKEN_NAME.test(s.accessToken))
    ) {
      throw new Error(`seat ${id}: accessToken is a service token name`);
    }
    const restartFrom = s.restartFrom ?? [];
    if (!Array.isArray(restartFrom) || !restartFrom.every((r) => typeof r === 'string')) {
      throw new Error(`seat ${id}: restartFrom is a list of seat ids`);
    }
    return {
      id,
      server: onMac ? MAC_SERVER : (project as string),
      ...(onMac ? {} : { project: project as string }),
      agentId,
      ...(typeof s.accessToken === 'string' ? { accessToken: s.accessToken } : {}),
      crossOrganization: bool(id, s, 'crossOrganization'),
      untrusted: bool(id, s, 'untrusted'),
      restartFrom: [...(restartFrom as string[])],
    };
  });
  const ids = new Set<string>();
  for (const s of seats) {
    if (ids.has(s.id)) throw new Error(`seats.json lists seat ${s.id} twice`);
    ids.add(s.id);
  }
  for (const s of seats) {
    for (const r of s.restartFrom) {
      if (!ids.has(r) || r === s.id)
        throw new Error(`seat ${s.id}: restartFrom "${r}" is not another seat`);
    }
  }
  return { relayAgentId, macOrganization, seats };
}

export interface ServerPlan {
  id: string;
  organization: string;
  baseUrl: string;
  /** Fly app, for a project machine. */
  app?: string;
  /** False for a server with no Access in front: the `at2` is the proof. */
  accessInFront: boolean;
  /** The Cloudflare service token's name, where Access is in front. */
  accessToken?: string;
}

/** The servers the seats sit on: the Mac, and each project's machine,
 *  addressed at its own router host from the Terraform outputs. */
export function serverPlans(list: SeatList, outputs: TfOutputs): ServerPlan[] {
  const out = new Map<string, ServerPlan>();
  for (const s of list.seats) {
    if (out.has(s.server)) continue;
    if (s.server === MAC_SERVER) {
      out.set(MAC_SERVER, {
        id: MAC_SERVER,
        organization: list.macOrganization,
        baseUrl: MAC_BASE_URL,
        accessInFront: false,
      });
      continue;
    }
    const project = s.project as string;
    const host = signInHost(outputs, project);
    if ('error' in host) throw new Error(host.error);
    const accessInFront = outputs.access[project] !== undefined;
    const token = list.seats.find((x) => x.server === project && x.accessToken)?.accessToken;
    if (accessInFront && !token) {
      throw new Error(`${project} has Access in front: its seat names the relay's accessToken`);
    }
    out.set(project, {
      id: project,
      organization: project,
      baseUrl: `https://${host.host}`,
      app: `cw-${project}`,
      accessInFront,
      ...(accessInFront && token ? { accessToken: token } : {}),
    });
  }
  return [...out.values()];
}

/** The tasks whose threads are a seat's outbox and inbox, by title. */
export const outboxTitle = (seat: string) => `Relay outbox: ${seat}`;
export const inboxTitle = (seat: string) => `Relay inbox: ${seat}`;

export interface ResolvedSeat extends SeatSpec {
  board: string;
  outboxDoc: string;
  inboxDoc: string;
}

export interface ServerSecrets {
  /** Board id → the relay's `at2` there. */
  bearers: Map<string, string>;
  serviceToken?: { clientId: string; clientSecret: string };
}

/** The relay config as `relay-config.ts` reads it, checked by that parser. */
export function relayConfigText(
  servers: readonly ServerPlan[],
  secrets: ReadonlyMap<string, ServerSecrets>,
  seats: readonly ResolvedSeat[],
): string {
  const json = {
    servers: Object.fromEntries(
      servers.map((s) => {
        const sec = secrets.get(s.id);
        return [
          s.id,
          {
            organization: s.organization,
            baseUrl: s.baseUrl,
            ...(sec?.serviceToken ? { serviceToken: sec.serviceToken } : {}),
            ...(s.id !== MAC_SERVER && !s.accessInFront ? { accessInFront: false } : {}),
            bearers: Object.fromEntries(sec?.bearers ?? []),
          },
        ];
      }),
    ),
    seats: Object.fromEntries(
      seats.map((s) => [
        s.id,
        {
          server: s.server,
          board: s.board,
          agentId: s.agentId,
          outboxDoc: s.outboxDoc,
          inboxDoc: s.inboxDoc,
          crossOrganization: s.crossOrganization,
          untrusted: s.untrusted,
          ...(s.restartFrom.length ? { restartFrom: s.restartFrom } : {}),
        },
      ]),
    ),
  };
  const text = `${JSON.stringify(json, null, 2)}\n`;
  const parsed = parseRelayConfig(text);
  if ('error' in parsed) throw new Error(`the config would be refused: ${parsed.error}`);
  return text;
}

/** The config with every credential replaced, for the dry run. */
export function redacted(configText: string): string {
  return configText
    .replace(/"(at2\.[A-Za-z0-9_-]+)\.[^"]*"/g, '"$1.<redacted>"')
    .replace(/("client(?:Id|Secret)": )"[^"]*"/g, '$1"<redacted>"');
}

const xml = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export interface PlistInput {
  bun: string;
  repo: string;
  configPath: string;
  stateDir: string;
  logPath: string;
}

/** The relay's LaunchAgent: `relay-bin.ts` from prod's checkout, restarted
 *  when it exits, its stderr (the "running" line) in `logPath`. */
export function relayPlist(p: PlistInput): string {
  const kv = (k: string, v: string) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${RELAY_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(p.bun)}</string>
    <string>${xml(`${p.repo}/packages/server/src/org-relay/relay-bin.ts`)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(p.repo)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${kv('CW_RELAY_CONFIG', p.configPath)}
${kv('CW_RELAY_STATE_DIR', p.stateDir)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(p.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(p.logPath)}</string>
</dict>
</plist>
`;
}

/** The token record id an `at2` carries, or null. */
export function tokenIdOf(token: string): string | null {
  const f = token.split('.');
  return f[0] === 'at2' && f.length >= 5 && f[1] ? f[1] : null;
}
