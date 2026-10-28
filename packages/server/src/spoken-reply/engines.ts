/**
 * The real engines behind the spoken reply, built from whichever keys this
 * machine holds. Called by `server-deps.ts` only — the seam rule every billed
 * engine here follows — so a server a test spins up builds none.
 *
 *  - setup 1 needs the Soniox key, which both listens and speaks;
 *  - setup 2 needs the Soniox key, the ElevenLabs secret card, AND
 *    `CW_ELEVENLABS_TRAINING_OFF=1` — see `ELEVENLABS_TRAINING_OFF_VAR`;
 *  - setup 3 needs the Gemini secret card;
 *  - setup 4 needs the ElevenLabs card, its agent id and LLM secret cards, a
 *    callback hostname ElevenLabs can reach (`CW_RECALL_CALLBACK_HOST`), and
 *    the same training flag as setup 2 — it sends ElevenLabs the same board
 *    text, and the speaker's audio as well.
 *
 * A missing key drops its setup from the switch; the log line says which,
 * never what the key is. Setup 4 stays in the switch either way: chosen
 * while unconfigured, it shows one line naming what is missing.
 */
import { normalizeRecallCallbackHost } from '../recall.ts';
import { type KeychainRunner, readKeychainPassword } from '../share/keychain.ts';
import { resolveSonioxKey } from '../transcribe-soniox.ts';
import type { TranscriptionEngine } from '../transcribe.ts';
import { createElevenLabsAgent } from './elevenlabs-agent.ts';
import { createGeminiLive } from './gemini-live.ts';
import {
  ELEVENLABS_AGENT_ID_ENV_VAR,
  ELEVENLABS_AGENT_ID_SECRET,
  ELEVENLABS_AGENT_LLM_ENV_VAR,
  ELEVENLABS_AGENT_LLM_SECRET,
  ELEVENLABS_ENV_VAR,
  ELEVENLABS_SECRET,
  GEMINI_ENV_VAR,
  GEMINI_SECRET,
  readCardSecret,
  validAgentId,
  validAgentLlmSecret,
} from './keys.ts';
import { type SpokenEngines, availableSetups } from './session.ts';
import { createElevenLabsVoice, createSonioxVoice } from './tts.ts';

/**
 * Whether ElevenLabs may be sent real board text. Every request already
 * carries `enable_logging=false`, but whether that stops training on this
 * account is Bryan's to confirm, so setup 2 stays off until the server is
 * launched with this set to `1`. Off by default: unset, or any other value.
 */
export const ELEVENLABS_TRAINING_OFF_VAR = 'CW_ELEVENLABS_TRAINING_OFF';

export function elevenLabsTrainingOff(env: Record<string, string | undefined>): boolean {
  return env[ELEVENLABS_TRAINING_OFF_VAR]?.trim() === '1';
}

/** What the page shows when setup 2 is chosen while held. */
export const ELEVENLABS_HELD_LINE =
  'Setup 2 waits on turning off ElevenLabs training — see the ElevenLabs training card on this task.';

/**
 * What setup 4 still lacks, as one line for the page — or null when nothing
 * is missing. Names cards and variables, never a value.
 */
export function agentMissingLine(have: {
  elevenLabsKey: boolean;
  agentId: boolean;
  llmSecret: boolean;
  callbackHost: boolean;
  trainingOff: boolean;
}): string | null {
  const missing = [
    have.elevenLabsKey ? '' : `the ${ELEVENLABS_SECRET} card`,
    have.agentId ? '' : `the ${ELEVENLABS_AGENT_ID_SECRET} card`,
    have.llmSecret ? '' : `the ${ELEVENLABS_AGENT_LLM_SECRET} card`,
    have.callbackHost ? '' : 'CW_RECALL_CALLBACK_HOST',
    have.trainingOff ? '' : `${ELEVENLABS_TRAINING_OFF_VAR}=1`,
  ].filter((s) => s);
  if (missing.length === 0) return null;
  const list =
    missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
  return `Setup 4 is not set up on this server yet: it needs ${list}.`;
}

export interface SpokenKeySources {
  env: Record<string, string | undefined>;
  /** Keychain reads; a test passes one that answers nothing. */
  readSoniox: (service: string) => string | null;
  readCard?: KeychainRunner;
  /** Features this server's profile turned off (`project-profile.ts`). An
   *  off feature's key is never read, so its setups never appear. */
  off?: { transcription?: boolean; voice?: boolean; gemini?: boolean };
}

export function createSpokenEngines(
  listener: TranscriptionEngine | null,
  log: (line: string) => void = (l) => console.log(l),
  keys: SpokenKeySources = { env: process.env, readSoniox: readKeychainPassword },
): SpokenEngines {
  const { env } = keys;
  // Soniox is a transcription vendor: setup 1 listens and speaks through it.
  const soniox =
    keys.off?.transcription === true ? null : resolveSonioxKey(undefined, env, keys.readSoniox);
  const voiceOff = keys.off?.voice === true;
  const eleven = voiceOff
    ? null
    : readCardSecret(ELEVENLABS_SECRET, ELEVENLABS_ENV_VAR, env, keys.readCard);
  const gemini =
    keys.off?.gemini === true
      ? null
      : readCardSecret(GEMINI_SECRET, GEMINI_ENV_VAR, env, keys.readCard);
  const cleared = elevenLabsTrainingOff(env);
  const agentId = voiceOff
    ? null
    : readCardSecret(ELEVENLABS_AGENT_ID_SECRET, ELEVENLABS_AGENT_ID_ENV_VAR, env, keys.readCard);
  const llmSecret = voiceOff
    ? null
    : readCardSecret(ELEVENLABS_AGENT_LLM_SECRET, ELEVENLABS_AGENT_LLM_ENV_VAR, env, keys.readCard);
  // Setup 4 is ElevenLabs too: with voice off it is not offered at all,
  // rather than listed as waiting on cards this org will never hold.
  const agentMissing = voiceOff
    ? null
    : agentMissingLine({
        elevenLabsKey: eleven !== null,
        agentId: validAgentId(agentId),
        llmSecret: validAgentLlmSecret(llmSecret),
        callbackHost: normalizeRecallCallbackHost(env.CW_RECALL_CALLBACK_HOST) !== null,
        trainingOff: cleared,
      });
  const agent =
    !agentMissing && eleven && validAgentId(agentId) && validAgentLlmSecret(llmSecret)
      ? { live: createElevenLabsAgent({ apiKey: eleven, agentId }), llmSecret }
      : null;
  const held = {
    ...(eleven && !cleared ? { '2': ELEVENLABS_HELD_LINE } : {}),
    ...(agentMissing ? { '4': agentMissing } : {}),
  };
  const engines: SpokenEngines = {
    listener,
    voices: {
      1: soniox ? createSonioxVoice({ apiKey: soniox }) : null,
      2: eleven && cleared ? createElevenLabsVoice({ apiKey: eleven }) : null,
    },
    gemini: gemini ? createGeminiLive({ apiKey: gemini }) : null,
    meetingVoice: soniox ? createSonioxVoice({ apiKey: soniox, audio: 'mp3' }) : null,
    agent,
    ...(Object.keys(held).length > 0 ? { held } : {}),
  };
  const on = availableSetups(engines);
  log(
    `[spoken-reply] setups available: ${on.length > 0 ? on.join(', ') : 'none'}` +
      (listener ? '' : ' (no Soniox listener)') +
      (voiceOff ? " (voice off in this server's profile)" : eleven ? '' : ' (no ElevenLabs card)') +
      (eleven && !cleared ? ` (setup 2 held until ${ELEVENLABS_TRAINING_OFF_VAR}=1)` : '') +
      (keys.off?.gemini === true
        ? " (Gemini off in this server's profile)"
        : gemini
          ? ''
          : ' (no Gemini card)') +
      (agent || voiceOff ? '' : ' (setup 4 not configured)'),
  );
  return engines;
}
