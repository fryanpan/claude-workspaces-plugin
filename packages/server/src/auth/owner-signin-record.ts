/**
 * The lock-out guard's evidence (plan 3.5): has the owner signed in to this
 * machine through Better Auth at least once?
 *
 * `CW_SIGNIN=better-auth` drops the Access stamp. If the owner has never
 * proved the new sign-in works here, that switch can leave nobody able to
 * open the board from outside. So the door runs `better-auth` as `both`
 * until this record exists (`middleware/signin-door.ts`), and the machine
 * reports it on a loopback-only route (`GET /api/signin/owner`) for a
 * script to read before it removes Access.
 *
 * One small file in the data dir, mode 600: the address and when. Written
 * the first time only; a later sign-in changes nothing.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OWNER_SIGNIN_FILE = 'signin-owner.json';

export interface OwnerSignIn {
  email: string;
  /** ISO time of the first recorded sign-in. */
  at: string;
}

export interface OwnerSignInRecord {
  read(): OwnerSignIn | null;
  /** Record the owner's sign-in, unless one is already recorded. */
  record(email: string): void;
}

export function createOwnerSignInRecord(
  dataDir: string,
  now: () => Date = () => new Date(),
): OwnerSignInRecord {
  const path = join(dataDir, OWNER_SIGNIN_FILE);
  let cached: OwnerSignIn | null | undefined;

  const read = (): OwnerSignIn | null => {
    if (cached) return cached;
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<OwnerSignIn>;
      if (typeof parsed.email === 'string' && typeof parsed.at === 'string') {
        cached = { email: parsed.email, at: parsed.at };
        return cached;
      }
    } catch {
      // A torn or hand-edited file is no evidence: the guard stays shut.
    }
    return null;
  };

  const record = (email: string): void => {
    if (read()) return;
    const entry: OwnerSignIn = { email, at: now().toISOString() };
    writeFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    cached = entry;
  };

  return { read, record };
}
