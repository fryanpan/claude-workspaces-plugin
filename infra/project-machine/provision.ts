/**
 * The `fly-org` half of fly-provision.yml, which makes a project's Fly app,
 * volume, bucket, backup key and push keys without the keeper
 * (docs/process/project-machine.md, "Provisioning a project").
 *
 * The workflow's `outputs` job runs in `cloudflare-prod`, the one holder of
 * a Cloudflare token that can read a tunnel's token and of the state key the
 * Access settings come from. It seals them to `fly-org` (`provision-outputs.ts`)
 * and uploads the file. The `provision` job, in `fly-org` with the org token,
 * downloads it and runs `machine:deploy` with
 *
 *   CW_PROVISION_HANDOFF  that file; `provisionPresets` opens it with
 *                         HANDOFF_PRIVATE_KEY and hands its secrets to the
 *                         deploy as presets
 *   CW_HANDOFF_OUT        where the deploy seals what it made for the Mac:
 *                         the backup identity and the bucket's credentials
 *                         (`mac-ops.ts keychainCreate`), flushed by
 *                         `flushMacHandoff` even when a later step fails
 *
 * Nothing opened or made is printed: lines name secrets and entries only.
 */
import { readFileSync } from 'node:fs';
import { type HandoffSink, openItems, recipientKey } from '../handoff/items.ts';

export const PROVISION_HANDOFF_ENV = 'CW_PROVISION_HANDOFF';

/** The secrets `cloudflare-prod` sealed for `app`, or undefined outside a provisioning run. */
export function provisionPresets(
  env: Record<string, string | undefined>,
  app: string,
  read: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): Record<string, string> | undefined {
  const file = env[PROVISION_HANDOFF_ENV]?.trim();
  if (!file) return undefined;
  const key = env.HANDOFF_PRIVATE_KEY?.trim();
  if (!key) throw new Error(`${PROVISION_HANDOFF_ENV} is set but HANDOFF_PRIVATE_KEY is not`);
  const opened = openItems(key, read(file));
  if (opened.recipient !== 'fly-org')
    throw new Error(`the provision file is sealed to ${opened.recipient}`);
  const item = opened.items.find((i) => i.kind === 'fly-secrets' && i.app === app);
  if (!item || item.kind !== 'fly-secrets')
    throw new Error(`the provision file holds nothing for ${app}`);
  console.log(
    `[deploy] from cloudflare-prod: ${Object.keys(item.secrets).join(', ') || 'nothing'}`,
  );
  return item.secrets;
}

/** Seal what this run made to the Mac; a no-op without a sink or with nothing in it. */
export function flushMacHandoff(
  sink: HandoffSink | null,
  key: () => string = () => recipientKey('mac'),
  log: (s: string) => void = (s) => console.log(s),
): void {
  if (!sink || sink.size === 0) return;
  sink.flush(key());
  for (const line of sink.describe()) log(`[deploy] sealed to the Mac: ${line}`);
  log('[deploy] the Mac stores them on its next bun run handoff:pull');
}
