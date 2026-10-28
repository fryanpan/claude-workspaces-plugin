/**
 * The token, written into the frame of a mock or app that loads the app
 * voice client.
 *
 * Only a page that names `/widget/app-voice.js` gets one, so a token is never
 * in a page that has no use for it, and only when the reader may be given one
 * (`gate.ts`). It goes in as a `<script type="application/json">` the client
 * reads by its attribute: data, never run. The frame's HTML is answered
 * `no-cache`, and its etag is a hash of these bytes, so a revalidation never
 * hands back an older token.
 */
import {
  APP_VOICE_CLIENT_FILE,
  APP_VOICE_SEED_ATTR,
  APP_VOICE_VERB,
  type AppVoiceSeed,
  appVoiceSeedJson,
} from '@claude-workspaces/core/app-voice';

const NAMES_CLIENT = new RegExp(`/widget/${APP_VOICE_CLIENT_FILE.replace('.', '\\.')}\\b`);
const HEAD_OPEN = /<head\b[^>]*>/i;

/** Whether the page loads the client. */
export function namesAppVoiceClient(html: string): boolean {
  return NAMES_CLIENT.test(html);
}

/** The socket's path for doc `docId` on board `workspaceId`. */
export function appVoiceSocketPath(workspaceId: string, docId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/${APP_VOICE_VERB}`;
}

/**
 * `html` with the seed in its head, when it loads the client and `mint`
 * gives one; else `html` unchanged. `mint` is called only for a page that
 * loads the client.
 */
export function withAppVoiceSeed(html: string, mint: () => AppVoiceSeed | null): string {
  if (!namesAppVoiceClient(html)) return html;
  const seed = mint();
  if (!seed) return html;
  const tag = `<script type="application/json" ${APP_VOICE_SEED_ATTR}>${appVoiceSeedJson(seed)}</script>`;
  return HEAD_OPEN.test(html) ? html.replace(HEAD_OPEN, (m) => `${m}${tag}`) : `${tag}${html}`;
}
