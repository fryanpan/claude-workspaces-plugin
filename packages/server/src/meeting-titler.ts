/**
 * When a meeting's title changes from "Meeting" to its topic, and when it
 * may not.
 *
 * Two moments a meeting is named, both from its notes (`meeting-namer.ts`):
 *
 * - **Early**, the first time a notes write leaves the doc holding about
 *   three bullets. A meeting has said what it is about by then, and the
 *   people in it see the heading change while they talk.
 * - **At the stop**, once more, because the whole meeting is a better
 *   account of its topic than its first three points.
 *
 * **It writes only while nobody has named the doc.** The rule is
 * `titleSource`: `default` or `auto` may be replaced, `given` and `person`
 * never are. A rename during the model call wins, because `setAutoTitle`
 * reads the source and writes the title in one synchronous step after the
 * call returns — see there.
 *
 * And the one-time retitle of the clock titles this server used to mint,
 * `retitleClockTitles`, which every boot runs (`retitleClockTitlesAtBoot`).
 */

import type { DocMeta, DocTitleSource } from '@claude-workspaces/core';
import { defaultMeetingTitle, titleIsUnnamed } from '@claude-workspaces/core';
import { CLOCK_TITLE } from './huddle.ts';
import { type MeetingNamer, countNoteBullets, hasNotes } from './meeting-namer.ts';

/** The slice of `DocStore` naming needs. */
export interface MeetingTitleStore {
  get(docId: string): { docId: string; meta: DocMeta } | undefined;
  readMarkdownBody(docId: string): string | null;
  setAutoTitle(
    docId: string,
    title: string,
    source: 'auto' | 'default',
    opts?: { replacing?: string },
  ): { ok: true; changed: boolean } | { ok: false; error: 'not-found' | 'named' | 'empty-title' };
  list(): DocMeta[];
}

/** The bullet count at which a meeting is first named. */
export const EARLY_NAMING_BULLETS = 3;

export type NamingOutcome = 'renamed' | 'unchanged' | 'named' | 'no-notes' | 'failed';

export interface MeetingTitler {
  /** A new recording on this doc: it may be named early again. */
  onSessionStart(docId: string): void;
  /** A notes write landed. Names the doc once per meeting, at the bar. */
  onNotesLanded(docId: string): void;
  /** The meeting stopped. Resolves once the at-stop naming has run. */
  onMeetingEnd(docId: string): Promise<NamingOutcome>;
}

export function createMeetingTitler(deps: {
  namer: MeetingNamer;
  store: () => MeetingTitleStore;
  onError?: (message: string) => void;
}): MeetingTitler {
  /** Docs already named early this meeting. */
  const early = new Set<string>();
  /** One naming at a time per doc, so an early call still out cannot land
   *  after the at-stop one and put the thinner title back. */
  const chains = new Map<string, Promise<NamingOutcome>>();

  const nameOnce = async (docId: string): Promise<NamingOutcome> => {
    const store = deps.store();
    const doc = store.get(docId);
    if (!doc || !titleIsUnnamed(doc.meta.titleSource)) return 'named';
    const notes = store.readMarkdownBody(docId);
    if (!notes || !hasNotes(notes)) return 'no-notes';
    const title = await deps.namer({ notes }).catch(() => null);
    if (!title) return 'failed';
    const wrote = store.setAutoTitle(docId, title, 'auto');
    if (!wrote.ok) return wrote.error === 'named' ? 'named' : 'failed';
    return wrote.changed ? 'renamed' : 'unchanged';
  };

  const run = (docId: string): Promise<NamingOutcome> => {
    const prev = chains.get(docId) ?? Promise.resolve<NamingOutcome>('unchanged');
    const next = prev
      .catch(() => 'failed' as const)
      .then(() => nameOnce(docId))
      .catch((err) => {
        deps.onError?.(
          `[meeting-title] naming failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return 'failed' as const;
      });
    chains.set(docId, next);
    void next.finally(() => {
      if (chains.get(docId) === next) chains.delete(docId);
    });
    return next;
  };

  return {
    onSessionStart(docId) {
      early.delete(docId);
    },
    onNotesLanded(docId) {
      if (early.has(docId)) return;
      const store = deps.store();
      const doc = store.get(docId);
      if (!doc || !titleIsUnnamed(doc.meta.titleSource)) return;
      const notes = store.readMarkdownBody(docId);
      if (!notes || countNoteBullets(notes) < EARLY_NAMING_BULLETS) return;
      early.add(docId);
      void run(docId);
    },
    onMeetingEnd(docId) {
      return run(docId);
    },
  };
}

/** Is this doc a meeting — a huddle, or a calendar meeting's doc? */
function isMeetingDoc(meta: DocMeta): boolean {
  return meta.huddle === true || (meta.alias?.startsWith('meeting-') ?? false);
}

/**
 * Rename every meeting still called by the clock it started at.
 *
 * A doc qualifies only while its title is EXACTLY a minted clock title and it
 * carries no `titleSource` — so a title a person changed, even to something
 * clock-shaped after this shipped, is left alone, and a second run finds
 * nothing to do. A doc with notes takes its topic; one without takes the
 * default. A doc with notes and no usable topic (no namer on this server, or
 * a failed call) is SKIPPED rather than defaulted, so a later run can still
 * name it.
 *
 * Returns counts only: the operator reading the result needs to know it
 * worked, not what anybody's meetings were called.
 */
export async function retitleClockTitles(
  store: MeetingTitleStore,
  namer: MeetingNamer | null,
): Promise<{ renamed: number; skipped: number }> {
  let renamed = 0;
  let skipped = 0;
  for (const meta of store.list()) {
    const old = meta.title;
    if (!isMeetingDoc(meta) || meta.titleSource !== undefined) continue;
    if (old === undefined || !CLOCK_TITLE.test(old)) continue;
    // A turn of the event loop per candidate: each one hydrates a doc, and at
    // boot this runs beside the first requests. The guard below still holds
    // across the gap — the write names the title it read.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const notes = store.readMarkdownBody(meta.docId);
    let title: string;
    let source: Extract<DocTitleSource, 'auto' | 'default'>;
    if (notes && hasNotes(notes)) {
      const named = namer ? await namer({ notes }).catch(() => null) : null;
      if (!named) {
        skipped++;
        continue;
      }
      title = named;
      source = 'auto';
    } else {
      const plan = meta.huddleKind === 'plan' || old.startsWith('Plan ');
      title = defaultMeetingTitle(plan ? 'plan' : undefined);
      source = 'default';
    }
    const wrote = store.setAutoTitle(meta.docId, title, source, { replacing: old });
    if (wrote.ok && wrote.changed) renamed++;
    else skipped++;
  }
  return { renamed, skipped };
}

/**
 * The retitle as a boot pass: what `server.ts` starts once the port is bound.
 *
 * A pass, not a route, because the one place it has to run is a deployed
 * server nobody can POST to. It is safe on every boot because it is
 * idempotent — a renamed doc carries a `titleSource` and is never a
 * candidate again — so the first boot after the deploy renames and every
 * boot after it logs 0. One line, the count only: the log is read by people
 * who need to know it ran, not what anybody's meetings were called.
 */
export async function retitleClockTitlesAtBoot(
  store: MeetingTitleStore,
  namer: MeetingNamer | null,
  log: (line: string) => void = console.log,
): Promise<void> {
  try {
    const { renamed } = await retitleClockTitles(store, namer);
    log(`[meeting-title] renamed ${renamed} old titles`);
  } catch (err) {
    log(
      `[meeting-title] rename of old titles failed (${err instanceof Error ? err.name : 'error'})`,
    );
  }
}
