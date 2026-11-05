/**
 * The lead chat voice's ties to the page: the server's voice routes, the
 * page's error reporting and its audio context. Kept apart from
 * `lead-chat-voice.ts`, which decides when to listen and what to send.
 */
import type { SpokenSetup } from '@claude-workspaces/core/spoken-reply';

function voiceBase(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/voice`;
}

export async function defaultSetups(workspaceId: string): Promise<SpokenSetup[]> {
  try {
    const res = await fetch(`${voiceBase(workspaceId)}/timings`, { credentials: 'same-origin' });
    const body = res.ok ? ((await res.json()) as { setups?: SpokenSetup[] }) : null;
    return Array.isArray(body?.setups) ? body.setups : [];
  } catch {
    return [];
  }
}

export function socketUrl(workspaceId: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${voiceBase(workspaceId)}/converse`;
}

/** Raise a voice failure where the page's error reporting sees it, without
 *  throwing into the caller. `reportError` fires the window's `error` event,
 *  which Sentry's handler (or the shell's early buffer) files. */
export function reportToPage(err: Error): void {
  const w = window as unknown as { reportError?: (e: unknown) => void };
  if (typeof w.reportError === 'function') w.reportError(err);
  else
    setTimeout(() => {
      throw err;
    }, 0);
}

export function audioContext(): AudioContext | undefined {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Ctor ? new Ctor() : undefined;
}
