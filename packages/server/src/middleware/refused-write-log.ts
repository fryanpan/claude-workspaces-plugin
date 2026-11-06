/**
 * One log line for a write a page on another origin was refused.
 *
 * The widget turns every refusal it has no remedy for into "Couldn't post",
 * and a refusal from any gate here is a `j(4xx)` that logs nothing. So a
 * person could report that sentence and the server held no trace of which gate
 * said no. A refused socket is read the same way: an upgrade is a GET, and the
 * browser hides its status from the page.
 *
 * The line carries the method, the status and the gate: the `error` word the
 * refusal itself answered with. It never carries the token, the person, the
 * path or the origin. An `error` is free text on some routes, so a value is
 * printed only if nothing in it could spell an email, a path or a token: no
 * `@`, `.`, `/` or capital. Anything else prints as `unnamed`, and the status
 * still says which family refused.
 */
import type { OriginPolicy } from './browser-origin.ts';

const GATE_WORD = /^[a-z0-9_ +-]{1,40}$/;

async function gateOf(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as { error?: unknown };
    return typeof body?.error === 'string' && GATE_WORD.test(body.error) ? body.error : 'unnamed';
  } catch {
    return 'unnamed';
  }
}

/** The line for this refusal, or null when it is not one this log is for. */
export async function refusedWriteLine(
  req: Request,
  res: Response,
  policyFor: (req: Request) => OriginPolicy,
): Promise<string | null> {
  if (res.status < 400 || res.status >= 500) return null;
  const socket = req.headers.get('upgrade')?.toLowerCase() === 'websocket';
  const write = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  if (!socket && !write) return null;
  const origin = req.headers.get('origin');
  if (origin === null || origin === policyFor(req).requestOrigin) return null;
  const verb = socket ? 'SOCKET' : req.method;
  return `[refused-write] ${verb} status=${res.status} gate=${await gateOf(res)}`;
}
