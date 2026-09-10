/**
 * The real notes composer: one Haiku call per pause in, a short list of
 * block-addressed edits out.
 *
 * SAME CONSENT SEAM AS THE SUMMARIZER. What leaves the machine here is the
 * meeting transcript itself — the most sensitive content this server holds —
 * so the key is the same DEDICATED entry thread summaries use
 * (`claude-workspaces-summary-api-key` / CW_SUMMARY_API_KEY), and a generic
 * `ANTHROPIC_API_KEY` in the environment is deliberately not honoured.
 * Outbound Haiku use from this server was approved 2026-08-10; adding the
 * dedicated key is the operator's act of consent. No key → `null` → meetings
 * record transcripts and compose nothing, which the caller logs as the
 * configured-off state, not an error.
 *
 * CI has no keychain and holds no repository secret, so it authenticates the
 * other way this seam allows: it proves its identity to GitHub, trades that
 * for an access token good for one run, and hands it over in
 * `CW_SUMMARY_ACCESS_TOKEN`. That is still an act of consent — somebody
 * configured a federation rule naming this repository — and it is a better
 * one, because nothing long-lived is left lying in the repository to leak.
 * `resolveCredentialFrom` picks between the two and `authHeader` sends
 * exactly one header.
 *
 * FAILURE THROWS, UNLIKE THE SUMMARIZER'S NULL. A summary that fails leaves
 * a deterministic card line standing; failed notes have no fallback text —
 * what they have is the session's carry (`beginNotesSession`), which needs a
 * rejection to know the tick's words must ride the next one. So a refused
 * call, a cut reply, an empty reply: all throw, and none of them ever log
 * the key.
 */

import type { prose } from '@claude-workspaces/core';
import { readRenamedEnv } from '@claude-workspaces/core/env-names';
import type { NotesComposeInput, NotesComposer } from './meeting-notes.ts';
import { refusalMessage } from './model-quota.ts';
import { parseNotesEdits } from './notes-edit-parse.ts';
import { buildNotesPrompt } from './notes-prompt-build.ts';
import { readKeychainPassword } from './share/keychain.ts';
import { authHeader, resolveCredentialFrom } from './summarize.ts';

export const NOTES_MODEL = 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';
/**
 * A reply that hits this is refused rather than truncated — a cut edit list
 * would end mid-JSON and parse to nothing, and the next tick retries with the
 * same words carried, so nothing said is lost.
 *
 * THE CEILING STOPPED BEING THE BINDING CONSTRAINT WHEN THE REPLY STOPPED
 * BEING THE WHOLE NOTES. `bun run notes:eval` measured about a tenth of ticks
 * refused here, all of them late in the longer meetings, because a whole-notes
 * reply grew with the MEETING rather than with the tick. An edit list grows
 * with what was just said: a handful of bullets, whatever hour of the meeting
 * it is. The number is left where it was measured so the eval keeps reporting
 * any refusal rather than hiding one behind a bigger ceiling.
 */
const MAX_TOKENS = 2_000;
const TIMEOUT_MS = 30_000;

/**
 * A reply read as edits: fences stripped, malformed entries discarded with a
 * reason, and nothing thrown.
 *
 * THROWS ONLY WHEN THE REPLY COULD NOT BE READ. An edit list that came back
 * with two good entries and one nonsense one is two good edits; a reply the
 * parser could make nothing of — bad JSON, or entries it all discarded — is a
 * tick the session must hear as a FAILURE so the words carry into the next
 * tick rather than being counted as covered. The dropped reasons ride the
 * message, because a model reply nobody can read is worth one log line naming
 * what arrived.
 *
 * A WELL-FORMED EMPTY LIST IS NOT A FAILURE. `parseNotesEdits` separates the
 * two: nothing parsed AND nothing dropped means the model answered `[]`, and
 * a tick of greetings that changes nothing is the documented right answer
 * (see `NotesComposer.compose`). Throwing on it re-sent the same turns every
 * tick through an uncapped carry-forward and logged a compose failure for
 * each one, so a stretch of small talk grew the prompt without bound.
 */
export function readNotesEdits(raw: string): readonly prose.BlockEdit[] {
  const { edits, dropped } = parseNotesEdits(raw);
  if (edits.length === 0 && dropped.length > 0) {
    throw new Error(`notes compose returned no usable edits: ${dropped.join('; ')}`);
  }
  if (dropped.length > 0) {
    console.error(
      `[meeting-notes] dropped ${dropped.length} malformed edit(s): ${dropped.join('; ')}`,
    );
  }
  return edits;
}

export interface HaikuNotesComposerOpts {
  /**
   * Tests, and `--api-key`: an explicit key (or `null` for the explicit
   * no-key state) without Keychain. Given, it wins over an access token in
   * the environment — a credential somebody named in the same breath is not
   * something an ambient one gets to override.
   */
  apiKey?: string | null;
  /** Tests: the HTTP seam. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * A model other than Haiku. `scripts/notes-eval.ts --variant sonnet|opus`
   * is the only caller: the server always composes on `NOTES_MODEL`, and the
   * question the variant asks is what the same prompt costs and keeps on a
   * bigger model.
   */
  model?: string;
  /** Raised with `model`: a thinking model spends part of the ceiling before
   *  it writes an edit, and a truncated edit list is refused. */
  maxTokens?: number;
  /** `output_config.effort` for a thinking model. Absent, nothing is sent. */
  effort?: string;
  /**
   * The note-taking instructions for this tick — `createNotesPromptStore`'s
   * `read` in the server, which re-reads the operator's file every call.
   * Absent, the built-in default: a composer constructed without a data dir
   * still composes, it just cannot be retuned without a deploy.
   */
  instructions?: () => string;
}

/** Printed once per process, because the transcript leaving the machine must
 *  never be the silent case. */
let announcedOn = false;

/**
 * Construct the real composer, or `null` when the operator has not opted in
 * (no dedicated key) or has opted out (`CW_MEETING_NOTES=0`).
 */
export function createHaikuNotesComposer(opts: HaikuNotesComposerOpts = {}): NotesComposer | null {
  if (readRenamedEnv(process.env, 'CW_MEETING_NOTES') === '0') return null;
  // A key from the Keychain, or a short-lived access token the environment
  // was handed — CI mints one from its OIDC identity so no long-lived secret
  // has to sit in the repository. Either way one header, chosen here once.
  const cred = resolveCredentialFrom(opts.apiKey, readKeychainPassword, process.env);
  if (!cred) return null;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const model = opts.model ?? NOTES_MODEL;
  const maxTokens = opts.maxTokens ?? MAX_TOKENS;

  return {
    name: 'haiku',
    async compose(input: NotesComposeInput): Promise<readonly prose.BlockEdit[]> {
      if (!announcedOn) {
        announcedOn = true;
        console.log(
          '[meeting-notes] live notes ON: meeting transcript text is sent to ' +
            'api.anthropic.com. Turn off with CW_MEETING_NOTES=0.',
        );
      }
      const { system, stable, volatile, user } = buildNotesPrompt(input, opts.instructions?.());
      // Sizes and the model name, so a slow tick can be read back against
      // what it actually asked for. Reported BEFORE the call: a tick that
      // times out is exactly the one whose prompt size matters, and a report
      // after the await would never reach the log. There is no first-token
      // number to give — this is a single non-streaming request.
      input.measure?.({ promptChars: system.length + user.length, model });
      const ctl = new AbortController();
      const timeout = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        const res = await fetchImpl(API_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...authHeader(cred),
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system,
            // TWO BLOCKS, AND THE BREAKPOINT BETWEEN THEM. The head is the
            // instructions' company: project context and the doc as it
            // stands, which read the same from tick to tick and grow at the
            // end. The tail is this tick. One breakpoint, at the join.
            //
            // THE MARKER IS NOT A GUARANTEE. Every model has a minimum
            // cacheable prefix — 4096 tokens on Haiku 4.5, this composer's
            // model — and a marker on anything shorter is IGNORED IN SILENCE:
            // no entry, no error, and a reply that looks exactly like a hit.
            // The first ticks of a meeting are below it, because the doc has
            // barely any notes in it yet, and there is nothing to do about
            // that but say so: `NotesTokenUsage` records what was actually
            // read from cache, so the share is measured rather than assumed.
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
                  { type: 'text', text: volatile },
                ],
              },
            ],
            ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
          }),
          signal: ctl.signal,
        });
        // The status is safe to surface; the key never is. A refusal's BODY
        // is read only to tell "the account is out of quota" from every other
        // 400 — see `model-quota.ts` — and never re-emitted, because a body
        // can echo the request that carried the credential.
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(refusalMessage('notes compose', res.status, body));
        }
        const body = (await res.json()) as {
          content?: Array<{ text?: string }>;
          stop_reason?: string | null;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        };
        // WHAT IT COST, FROM THE ONLY PLACE THAT KNOWS. Reported before the
        // reply is parsed, so a tick whose edit list is unreadable still
        // prices itself — the money was spent either way, and a failure
        // silently missing from the bill is how a cost report drifts.
        const u = body.usage;
        if (u) {
          input.measure?.({
            usage: {
              inputTokens: u.input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
              cacheReadTokens: u.cache_read_input_tokens ?? 0,
              cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
            },
          });
        }
        if (body.stop_reason === 'max_tokens') {
          throw new Error('notes compose hit max_tokens; refusing a truncated edit list');
        }
        const text = body.content?.map((b) => b.text ?? '').join('') ?? '';
        if (!text.trim()) throw new Error('notes compose returned an empty reply');
        input.measure?.({ replyChars: text.length });
        return readNotesEdits(text);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
