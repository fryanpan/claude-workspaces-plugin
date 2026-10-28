/**
 * Child-process fixture for project-server-boot.test.ts: build the real
 * server deps under the environment the test hands this process, then report
 * what was built, which credential NAMES are left in the environment, and
 * which Claude slot each path resolved. Run with `bun run`, never as a test:
 * `createServerDeps` edits `process.env`, which must not leak into the suite.
 *
 * The last line of stdout is the JSON report; everything before it is the
 * boot log the test reads.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSlotTrace } from '../../src/claude-key-slot.ts';
import type { ServerConfig } from '../../src/server-config.ts';
import { createServerDeps } from '../../src/server-deps.ts';
import { availableSetups } from '../../src/spoken-reply/session.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'cw-project-boot-'));
const cfg = {
  dataDir,
  repoRoot: dataDir,
  shareConfig: null,
  accessShareConfigured: false,
  publicBaseUrlOverride: null,
  recallCallbackHost: null,
  meetingBotWebhookSecret: null,
  pluginRefreshIntervalMs: 0,
  clientReleaseRootDir: null,
} as unknown as ServerConfig;

const deps = createServerDeps(cfg, { deployEnabled: false, busyDocs: () => [] });
const env = Object.keys(process.env).sort();
console.log(
  JSON.stringify({
    built: {
      voiceComplete: deps.voiceComplete !== null,
      voiceFeedbackTidy: deps.voiceFeedbackTidy !== null,
      reviewJudge: deps.reviewJudge !== null,
      answerCoverage: deps.answerCoverage !== null,
      effortEstimator: deps.effortEstimator !== null,
      titleNamer: deps.titleNamer !== null,
      coachSummarizer: deps.coachSummarizer !== null,
      transcription: deps.transcription !== null,
      meetingBot: deps.meetingBot !== null,
      calendarBot: deps.calendarBot !== null,
    },
    spokenSetups: availableSetups(deps.spokenReply),
    spokenHeld: Object.keys(deps.spokenReply.held ?? {}),
    featuresOff: deps.featuresOff,
    trace: claudeSlotTrace(),
    env,
  }),
);
