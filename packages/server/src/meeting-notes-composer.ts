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
import type { NotesComposeInput, NotesComposer, NotesTick, NotesTurn } from './meeting-notes.ts';
import { refusalMessage } from './model-quota.ts';
import { MEETING_NOTES_HEADING, NOTES_AUTHOR_ID } from './notes-doc-access.ts';
import { parseNotesEdits } from './notes-edit-parse.ts';
import { DEFAULT_NOTES_INSTRUCTIONS, withoutSpeakerAttribution } from './notes-prompt-store.ts';
import { regroupDirective } from './notes-regroup.ts';
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
 * How much of the doc's body the outline may carry into one prompt.
 *
 * Headings are never dropped by the cap (`prose.readOutline`), so the model
 * can always see every topic and put a point under the right one; what this
 * bounds is the BULLETS, counted from the end of the doc. That is what keeps a
 * tick's prompt the size of the recent conversation rather than the size of
 * the meeting — the exact thing that made late ticks slow and then refused.
 * Eighty is generous against what a tick needs: a pause covers a minute or two
 * of speech and lands two or three bullets, so eighty is most of the last
 * half-hour of notes, and a point older than that belongs under a heading
 * rather than folded into a bullet the model can no longer see.
 */
export const NOTES_OUTLINE_RECENT_BLOCKS = 80;

/** The heading a meeting's section is opened under, as one markdown line. */
const HEADING_LINE = `## ${MEETING_NOTES_HEADING}`;

/**
 * Prompt building is pure and exported: what the transcript is asked to
 * become is behaviour worth pinning without a network in the test.
 *
 * `instructions` is the system prompt — the note-taking rules, which now come
 * from a store rather than from a literal here (`notes-prompt-store.ts`).
 * They default to the stored default, so every existing caller and every test
 * that built a prompt without one still gets the words it always got.
 */
export function buildNotesPrompt(
  input: NotesComposeInput,
  instructions: string = DEFAULT_NOTES_INSTRUCTIONS,
): { system: string; user: string } {
  // A SOLO MEETING IS SENT NO ATTRIBUTION RULES. Its transcript lines carry
  // no name — the session strips them until a second voice is heard — so
  // rules demanding a speaker tag on every note, and spelling "Speaker B" as
  // what such a name looks like, are asking for something the model can only
  // supply by inventing it. That is the phantom, named in the prompt before
  // the composer ever wrote it.
  const system =
    input.multiSpeaker === false ? withoutSpeakerAttribution(instructions) : instructions;

  const parts: string[] = [];
  const ctx = input.context;
  const ctxLines: string[] = [];
  if (ctx?.docTitle) ctxLines.push(`- Meeting doc: ${ctx.docTitle}`);
  if (ctx?.repoRoot) ctxLines.push(`- Repository: ${ctx.repoRoot}`);
  if (ctx?.docPaths?.length) ctxLines.push(`- Project docs: ${ctx.docPaths.join(', ')}`);
  if (ctx?.taskTitles?.length) {
    ctxLines.push('- Open board tasks (the work likely under discussion):');
    for (const title of ctx.taskTitles) ctxLines.push(`  - ${title}`);
  }
  if (ctxLines.length > 0) parts.push(`Project context:\n${ctxLines.join('\n')}`);

  if (input.taskLinks?.length) {
    parts.push(
      [
        'Board tasks captured from this speech. Where a note covers one, cite',
        'it as a markdown link — [its title](its url), or your own words as',
        'the label when the note reads better that way. Keep links already in',
        'the notes.',
        ...input.taskLinks.map((l) => `- [${l.title}](${l.url}) — ${l.status}`),
      ].join('\n'),
    );
  }

  if (input.docLinks?.length) {
    parts.push(
      [
        'Material somebody in this meeting asked to have pulled in, already',
        'found. Cite it in the note that asked for it, as a markdown link.',
        'Do not summarize what is inside it — you have not read it, and the',
        'link is the answer.',
        ...input.docLinks.map((l) => `- [${l.title}](${l.url})${l.when ? ` — ${l.when}` : ''}`),
      ].join('\n'),
    );
  }

  if (input.references?.length) {
    parts.push(
      [
        'Named in this speech, and already on the board. Where a note covers',
        'one, write its name as a markdown link — [its title](its url) — the',
        'first time that note mentions it. Do not add one to a note that is',
        'not about it, and do not link the same thing twice in one note.',
        ...input.references.map(
          (r) => `- [${r.title}](${r.url}) — ${r.kind}${r.when ? `, met ${r.when}` : ''}`,
        ),
      ].join('\n'),
    );
  }

  if (input.missed?.length) {
    parts.push(
      [
        'SAID EARLIER AND STILL IN NO NOTE. Each of these went past without',
        'producing anything. Read them again with the notes above in front of',
        'you: write the note each one should have produced, under the heading',
        'it belongs to. Leave one out only if it is genuinely packaging — a',
        'greeting, a false start, or a point the notes already carry in other',
        'words. This is their last offer; nothing asks again.',
        ...input.missed.map((t) => `- ${speakerPrefix(t)}${t.text}`),
      ].join('\n'),
    );
  }

  if (input.extraPrompt) parts.push(input.extraPrompt);
  // AFTER the material blocks and BEFORE the outline, because it is about the
  // outline: a directive naming block ids reads as an instruction about the
  // table that follows it rather than as one more piece of context.
  const regroup = regroupDirective(input.outline, {
    author: NOTES_AUTHOR_ID,
    notesHeadingId: input.notesHeadingId,
  });
  if (regroup) parts.push(regroup);
  parts.push(renderOutline(input));
  parts.push(
    `New transcript since the last update:\n${input.tick.turns
      .map((t) => `- ${speakerPrefix(t)}${t.text}${turnSuffix(t, input.tick.reason)}`)
      .join('\n')}`,
  );
  return { system, user: parts.join('\n\n') };
}

/**
 * The doc as the model addresses it: one line per block, carrying the id an
 * edit comes back with, what kind of block it is, whose it is, and its words.
 *
 * DELIBERATELY NOT MARKDOWN. Handing the model the section as prose is what
 * made it answer with prose — a whole rewritten section, indistinguishable
 * from the one it was given except where it had changed its mind. A table of
 * ids is a different question: it can only be answered by naming blocks.
 *
 * "yours" and "theirs" are read off `author`, which the doc clears the moment
 * a person edits a block (`clearAuthorshipOnPersonEdit`). So "yours" means
 * "you wrote this and nobody has touched it since", which is exactly the set
 * of blocks an edit may rewrite directly — anything else reaches them as a
 * suggestion, and the instructions say so.
 */
function renderOutline(input: NotesComposeInput): string {
  if (input.outline.length === 0) {
    return [
      'The doc is empty, and this meeting has no notes section yet.',
      `Open one with a single insert_at_end carrying "${HEADING_LINE}", then`,
      'insert_at_end the first notes under it.',
    ].join('\n');
  }
  const lines = input.outline.map((entry) => {
    const kind =
      entry.kind === 'heading'
        ? `h${entry.level ?? 2}`
        : entry.kind === 'listItem'
          ? // A GROUPED TOPIC HAS TO READ AS GROUPED. Every bullet used to
            // print as `bullet`, so a topic already gathered under lead
            // bullets was indistinguishable from a wall — which made the
            // instruction to regroup one impossible to act on and impossible
            // to stop acting on. `sub-bullet` is the whole difference.
            (entry.depth ?? 0) > 0
            ? 'sub-bullet'
            : 'bullet'
          : 'para';
    const whose = entry.author === undefined ? 'theirs' : 'yours';
    const under =
      entry.kind === 'heading' || entry.underHeadingId === undefined
        ? ''
        : ` under=${entry.underHeadingId}`;
    return `${entry.id} ${kind} ${whose}${under} | ${entry.text}`;
  });
  const head =
    input.notesHeadingId === undefined
      ? [
          'This meeting has NO notes section in the doc below.',
          `Open one with a single insert_at_end carrying "${HEADING_LINE}".`,
        ]
      : [`This meeting's notes are under heading ${input.notesHeadingId}.`];
  return [
    ...head,
    '',
    'The doc, block by block — "id kind whose | text". Only the most recent',
    'blocks are listed; every heading is. A "sub-bullet" sits under the',
    '"bullet" above it.',
    ...lines,
  ].join('\n');
}

/**
 * How an unfinished sentence is presented, and what makes it unfinished.
 *
 * Two things reach the composer as fragments now, and they are not the same
 * fact. The last sentence of a MEETING is cut off because the recording
 * stopped; a sentence carried by a ceiling tick is cut off because the
 * speaker is still saying it. A composer told the recording stopped, in the
 * middle of a meeting that is still going, is being misinformed — it was one
 * string when only the final tick could carry a fragment.
 *
 * Either way it is the engine's raw text: no punctuation, no sentence
 * casing, sometimes cut mid-word. Saying so is what stops the note-taker
 * rendering a fragment as a finished point — the instructions already ask it
 * to end a note it is unsure of with `(unconfirmed)`, and this is that case
 * named on the wire.
 */
const PARTIAL_SUFFIX = ' [unfinished — the recording stopped mid-sentence]';
const STILL_SPEAKING_SUFFIX = ' [unfinished — they are still saying it]';

/**
 * And how the REST of a sentence is presented, once its earlier words have
 * already been written.
 *
 * A ceiling tick hands over as much of a long turn as the engine has
 * committed to, and the remainder arrives on a later tick. Without this the
 * remainder reads as a new thought and the note-taker opens a second point
 * for the second half of one sentence — which is the whole reason the ticker
 * marks it.
 */
const CONTINUED_SUFFIX = ' [continues a sentence already in the notes]';

/** The markers one transcript line carries, in reading order. */
function turnSuffix(t: NotesTurn, reason: NotesTick['reason']): string {
  const continued = t.continued ? CONTINUED_SUFFIX : '';
  if (!t.partial) return continued;
  return `${continued}${reason === 'end' ? PARTIAL_SUFFIX : STILL_SPEAKING_SUFFIX}`;
}

/**
 * "Devi (B): " — the name to write and the label to tag with, in the one
 * place the composer reads them from. A turn the session never mapped a
 * label onto keeps the bare name; a turn with no voice at all keeps none.
 */
function speakerPrefix(turn: NotesTurn): string {
  if (!turn.speaker) return '';
  return turn.speakerLabel ? `${turn.speaker} (${turn.speakerLabel}): ` : `${turn.speaker}: `;
}

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
      const { system, user } = buildNotesPrompt(input, opts.instructions?.());
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
            messages: [{ role: 'user', content: user }],
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
        };
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
