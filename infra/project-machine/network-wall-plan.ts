/**
 * The network wall check's pure half: the throwaway apps, the probes, how a
 * probe's answer is read, and the verdict. `network-wall.ts` runs it.
 * Tested in `packages/server/test/project-machine-network-wall.test.ts`.
 *
 * Three apps, each with one machine running `WALL_PY serve`:
 *
 *   cw-walltest-harborlight       on the network cw-walltest-harborlight
 *   cw-walltest-riverbend         on the network cw-walltest-riverbend
 *   cw-walltest-harborlight-peer  on Harborlight's network
 *
 * Harborlight and Riverbend are two projects as `machine:deploy` makes them:
 * an app on a private network named after itself. The peer is a second app
 * on Harborlight's network, so a probe from it shows one app reaching another
 * over the same private network. That is the positive control: without it a
 * probe that cannot connect to anything would read as a wall holding.
 */

export const WALL_PORT = 8797;

export type WallKey = 'harborlight' | 'riverbend' | 'peer';

export interface WallApp {
  key: WallKey;
  app: string;
  network: string;
}

export const WALL_APPS: readonly WallApp[] = [
  { key: 'harborlight', app: 'cw-walltest-harborlight', network: 'cw-walltest-harborlight' },
  { key: 'riverbend', app: 'cw-walltest-riverbend', network: 'cw-walltest-riverbend' },
  { key: 'peer', app: 'cw-walltest-harborlight-peer', network: 'cw-walltest-harborlight' },
];

export const appOf = (key: WallKey): WallApp => {
  const a = WALL_APPS.find((x) => x.key === key);
  if (!a) throw new Error(`no wall app ${key}`);
  return a;
};

/** Where the probe file sits on each machine. */
export const PROBE_PATH = '/wall.py';
export const WALL_IMAGE = 'python:3.12-alpine';

/**
 * Runs on each machine. `serve` answers every connection with a banner, so
 * `connected` means the probe reached this check's own listener and not
 * something else on the port. `probe` prints one `result=<word>` line.
 */
export const WALL_PY = `import errno, socket, sys

def serve(port):
    s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("::", port))
    s.listen(16)
    while True:
        c, _ = s.accept()
        try:
            c.sendall(b"wall-ok\\n")
        finally:
            c.close()

def probe(host, port):
    try:
        infos = socket.getaddrinfo(host, port, socket.AF_INET6, socket.SOCK_STREAM)
    except socket.gaierror:
        print("result=unresolved")
        return
    s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    s.settimeout(5)
    try:
        s.connect(infos[0][4])
        data = s.recv(16)
        print("result=connected" if data.startswith(b"wall-ok") else "result=other-listener")
    except socket.timeout:
        print("result=timeout")
    except ConnectionRefusedError:
        print("result=refused")
    except OSError as e:
        print("result=" + errno.errorcode.get(e.errno, "oserror"))
    finally:
        s.close()

if sys.argv[1] == "serve":
    serve(int(sys.argv[2]))
else:
    probe(sys.argv[2], int(sys.argv[3]))
`;

/** `fly` arguments for each step. */
export const flyArgs = {
  listApps: (): string[] => ['apps', 'list', '--json'],
  createApp: (a: WallApp, org: string): string[] => [
    'apps',
    'create',
    a.app,
    '--org',
    org,
    '--network',
    a.network,
  ],
  runMachine: (a: WallApp, region: string, probeFile: string): string[] => [
    'machine',
    'run',
    WALL_IMAGE,
    'python3',
    PROBE_PATH,
    'serve',
    String(WALL_PORT),
    '--app',
    a.app,
    '--region',
    region,
    '--vm-size',
    'shared-cpu-1x',
    '--vm-memory',
    '256',
    '--restart',
    'no',
    '--file-local',
    `${PROBE_PATH}=${probeFile}`,
  ],
  listMachines: (a: WallApp): string[] => ['machine', 'list', '--app', a.app, '--json'],
  probe: (from: WallApp, machineId: string, host: string): string[] => [
    'machine',
    'exec',
    machineId,
    `python3 ${PROBE_PATH} probe ${host} ${WALL_PORT}`,
    '--app',
    from.app,
  ],
  destroyApp: (a: WallApp): string[] => ['apps', 'destroy', a.app, '--yes'],
};

/** A probe's answer: `connected`, a refusal word, or why there is none. */
export type Outcome = string;

/** The answers that mean the probe did not get through. */
const REFUSALS = new Set([
  'unresolved',
  'timeout',
  'refused',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EACCES',
  'EPERM',
]);

/**
 * The probe's `result=` word, or `probe-error` when `fly machine exec`
 * failed or printed no result, or `not-run` on a dry run. Neither of the
 * last two is a refusal, so a probe that never ran cannot pass a wall row.
 */
export function readOutcome(status: number, stdout: string): Outcome {
  const m = stdout.match(/result=([A-Za-z-]+)/);
  if (m?.[1] === 'dry-run') return 'not-run';
  if (status !== 0 || !m?.[1]) return 'probe-error';
  return m[1];
}

export type Via = '.internal' | '6PN';

export interface Probe {
  /** A control must connect; a wall row must be refused. */
  kind: 'control' | 'wall';
  from: WallKey;
  to: WallKey;
  via: Via;
  /** Why the row is there, for the table. */
  why: string;
}

/** Controls first: the wall rows are read only once every control has connected. */
export const PROBES: readonly Probe[] = [
  {
    kind: 'control',
    from: 'harborlight',
    to: 'harborlight',
    via: '.internal',
    why: "Harborlight's probe and listener run",
  },
  {
    kind: 'control',
    from: 'riverbend',
    to: 'riverbend',
    via: '.internal',
    why: "Riverbend's probe and listener run",
  },
  {
    kind: 'control',
    from: 'peer',
    to: 'harborlight',
    via: '.internal',
    why: 'another app on the same network reaches it by name',
  },
  {
    kind: 'control',
    from: 'peer',
    to: 'harborlight',
    via: '6PN',
    why: 'another app on the same network reaches it by address',
  },
  { kind: 'wall', from: 'harborlight', to: 'riverbend', via: '.internal', why: 'across networks' },
  { kind: 'wall', from: 'harborlight', to: 'riverbend', via: '6PN', why: 'across networks' },
  { kind: 'wall', from: 'riverbend', to: 'harborlight', via: '.internal', why: 'across networks' },
  { kind: 'wall', from: 'riverbend', to: 'harborlight', via: '6PN', why: 'across networks' },
];

export interface Row extends Probe {
  outcome: Outcome;
  ok: boolean;
}

export function judgeRow(p: Probe, outcome: Outcome): Row {
  const ok = p.kind === 'control' ? outcome === 'connected' : REFUSALS.has(outcome);
  return { ...p, outcome, ok };
}

export interface Verdict {
  ok: boolean;
  /** Why it failed, one line each. Empty when it passed. */
  reasons: string[];
}

/**
 * Passes only when every control connected, every wall row was refused, and
 * every app this run made was destroyed. A wall row read after a failed
 * control is not trusted, so it never rescues the run.
 */
export function verdict(
  rows: readonly Row[],
  expected: number,
  leftOver: readonly string[],
): Verdict {
  const reasons: string[] = [];
  for (const r of rows.filter((x) => !x.ok)) {
    reasons.push(
      r.kind === 'control'
        ? `control ${r.from} -> ${r.to} over ${r.via} answered ${r.outcome}, so no wall row can be trusted`
        : `${r.from} reached ${r.to} over ${r.via}: ${r.outcome}`,
    );
  }
  if (rows.length < expected) reasons.push(`only ${rows.length} of ${expected} probes ran`);
  for (const app of leftOver)
    reasons.push(`${app} was not destroyed: run fly apps destroy ${app} --yes`);
  return { ok: reasons.length === 0, reasons };
}

/** The pass/fail table, one probe per line. */
export function table(rows: readonly Row[]): string {
  const head = ['check', 'from', 'to', 'via', 'answer', 'result', 'why'];
  const body = rows.map((r) => [
    r.kind,
    r.from,
    r.to,
    r.via,
    r.outcome,
    r.outcome === 'not-run' ? 'not run' : r.ok ? 'PASS' : 'FAIL',
    r.why,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => (b[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(head), ...body.map(line)].join('\n');
}
