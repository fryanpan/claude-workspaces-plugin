/**
 * The two LaunchDaemons that run the keeper, written as plists.
 *
 * **The port job holds the keeper's origin.** launchd itself listens on
 * `127.0.0.1` and `::1` (the `Sockets` key) from the moment the job is
 * loaded, at boot and through every restart of the keeper, so no other
 * process can ever serve `http://localhost:<port>` while the job is loaded.
 * Each connection is handed to `/usr/bin/nc -U`, which relays it to the
 * keeper's unix socket.
 *
 * The relay exists because Bun cannot take a listening socket from launchd:
 * Bun 1.3.10 throws "Bun does not support listening on a file descriptor"
 * for `listen({ fd })`. So the keeper listens on a unix socket in a folder
 * only its own user can write (`keeper-serve.ts` refuses any other), and an
 * agent cannot put a socket of its own at that path.
 *
 * **The keeper job** runs `keeper-bin.ts` with `CW_KEEPER_SOCKET` set. A
 * restart of it (`kickstart -k`) leaves the port job's listeners in place;
 * a connection in that gap is closed by `nc`, never answered by anyone else.
 */

export const PORT_JOB = 'com.claude-workspaces.keeper-port';
export const KEEPER_JOB = 'com.claude-workspaces.keeper';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

function render(v: PlistValue, pad: string): string {
  if (typeof v === 'string') return `<string>${esc(v)}</string>`;
  if (typeof v === 'number') return `<integer>${v}</integer>`;
  if (typeof v === 'boolean') return v ? '<true/>' : '<false/>';
  const inner = `${pad}  `;
  if (Array.isArray(v)) {
    return `<array>\n${v.map((x) => `${inner}${render(x, inner)}`).join('\n')}\n${pad}</array>`;
  }
  const rows = Object.entries(v).map(([k, x]) => `${inner}<key>${esc(k)}</key>${render(x, inner)}`);
  return `<dict>\n${rows.join('\n')}\n${pad}</dict>`;
}

const plist = (root: { [key: string]: PlistValue }): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${render(root, '')}
</plist>
`;

export interface PortJob {
  label?: string;
  /** The keeper's user; `nc` runs as it, so it can reach the socket's folder. */
  user?: string;
  port: number;
  socketPath: string;
}

/** The job whose listeners hold `127.0.0.1:<port>` and `[::1]:<port>`. */
export function portJobPlist(job: PortJob): string {
  const listener = (node: string) => ({
    SockNodeName: node,
    SockServiceName: String(job.port),
    SockType: 'stream',
    SockProtocol: 'TCP',
  });
  return plist({
    Label: job.label ?? PORT_JOB,
    ...(job.user ? { UserName: job.user } : {}),
    ProgramArguments: ['/usr/bin/nc', '-U', job.socketPath],
    inetdCompatibility: { Wait: false },
    Sockets: { v4: listener('127.0.0.1'), v6: listener('::1') },
  });
}

export interface KeeperJob {
  label?: string;
  user?: string;
  /** `$K`, holding `bin/`, `app/` and `state/`. */
  root: string;
  home: string;
  port: number;
  socketPath: string;
}

/** The job that runs the keeper itself, behind the port job. */
export function keeperJobPlist(job: KeeperJob): string {
  return plist({
    Label: job.label ?? KEEPER_JOB,
    ...(job.user ? { UserName: job.user } : {}),
    WorkingDirectory: `${job.root}/app`,
    ProgramArguments: [
      `${job.root}/bin/bun`,
      `${job.root}/app/packages/server/src/keeper/keeper-bin.ts`,
    ],
    EnvironmentVariables: {
      CW_KEEPER_DIR: `${job.root}/state`,
      CW_KEEPER_FLY_BIN: `${job.root}/bin/fly`,
      CW_KEEPER_PORT: String(job.port),
      CW_KEEPER_SOCKET: job.socketPath,
      HOME: job.home,
    },
    KeepAlive: true,
    RunAtLoad: true,
    StandardErrorPath: `${job.root}/keeper.log`,
  });
}
