import { Extension } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { type EditorState, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
// Same key instance Collaboration registers under — see editor.ts's import
// note; y-prosemirror's own export is a different key and never matches.
import { ySyncPluginKey } from '@tiptap/y-tiptap';

/**
 * The recent-note tint: when the notetaker's freshly composed note arrives in
 * the doc mid-meeting, the lines it wrote are tinted, and the tint fades out
 * in steps over about two minutes — loudest inside the first thirty seconds
 * (owner, 2026-09-06: "Keep things tinted for about two minutes, with more
 * visible highlight for recent items within the last 30s"; approved mock
 * `recent-notes-round1`, variant A). No label, no chip — the tint IS the
 * whole announcement.
 *
 * It replaced a 2.8s wash: during a live meeting several notes land in a
 * row, and by the time the reader looked up from one, the wash on the one
 * before it had already gone. Two minutes is long enough that everything
 * written since the reader last looked is still marked when they do.
 *
 * FOUR STEPS, NOT A SMOOTH FADE. Each line carries `data-age` 0–3, one step
 * per thirty seconds, and the stylesheet maps the step to a tint. A value
 * that changed every frame would repaint a document somebody is reading,
 * and nobody can see 92% against 88%.
 *
 * WHAT COUNTS AS THE NOTETAKER WRITING. The client cannot see who authored a
 * remote Yjs update, so the gate is the conjunction that is true for notes
 * and rarely for anything else: the transaction is REMOTE (carries the
 * y-sync meta — a local keystroke never does), a meeting is live on THIS
 * surface (`isLive`), and the "Meeting notes" section holds lines it did
 * not hold before (`newNoteLines` — a content diff, see there for why the
 * step map cannot be used). A collaborator typing into the notes section during a
 * recording gets tinted too; that is acceptable noise, where tinting every
 * remote edit anywhere would not be.
 *
 * Decorations, never content: the tint must survive nothing and sync
 * nowhere. Each decoration remembers when its line arrived; a re-band
 * transaction every thirty seconds rebuilds the set with the new steps and
 * drops what has aged out.
 */

/** How long a freshly written line stays tinted. */
export const RECENT_NOTE_MS = 120_000;
/** One step of the fade; `data-age` is the number of these elapsed. */
export const RECENT_NOTE_STEP_MS = 30_000;
/** The last `data-age` a tinted line carries. */
export const RECENT_NOTE_LAST_STEP = RECENT_NOTE_MS / RECENT_NOTE_STEP_MS - 1;

const key = new PluginKey<DecorationSet>('settleWash');
const REBAND = 'settleWashReband';

export interface SettleWashOptions {
  /** Whether a meeting is live on this surface right now. */
  isLive: () => boolean;
  /**
   * Remote content just landed in the notes section — the signal the live
   * zone's bot fallback uses to drop its settled lines.
   */
  onNotesInsert?: () => void;
  /** The clock; injected by tests. */
  now?: () => number;
}

/** Doc position where the notes section starts, or null. LAST heading named
 *  "Meeting notes", the same rule the server's section finder follows. */
export function notesSectionStart(doc: ProseNode): number | null {
  let at: number | null = null;
  doc.forEach((node, pos) => {
    if (node.type.name === 'heading' && node.textContent.trim() === 'Meeting notes') {
      at = pos;
    }
  });
  return at;
}

export interface NoteLine {
  from: number;
  to: number;
  /** The line's content, marks included — what "the same line" means. */
  key: string;
}

/** The lines the notes section is made of: every textblock (a bullet's
 *  paragraph, a heading, a paragraph) from the section heading to the end of
 *  the doc. A bullet with children is several lines, one per textblock. */
export function noteLines(doc: ProseNode): NoteLine[] {
  const start = notesSectionStart(doc);
  if (start === null) return [];
  const out: NoteLine[] = [];
  doc.nodesBetween(start, doc.content.size, (node, pos) => {
    if (node.isTextblock) {
      out.push({ from: pos, to: pos + node.nodeSize, key: JSON.stringify(node.toJSON()) });
      return false;
    }
    return true;
  });
  return out;
}

/**
 * The lines of `after`'s notes section that `before`'s did not hold — the
 * lines this write added or changed. A content diff rather than the
 * transaction's step map, because the collaboration binding applies every
 * remote update as ONE replace of the whole document (y-tiptap's
 * `_typeChanged`): the map says "everything was inserted", and tinting what
 * it says would light the entire section on every tick — which it did.
 * A line that appears twice consumes one match per copy, so a duplicated
 * line tints once, at its second copy.
 */
export function newNoteLines(before: ProseNode, after: ProseNode): NoteLine[] {
  const had = new Map<string, number>();
  for (const line of noteLines(before)) had.set(line.key, (had.get(line.key) ?? 0) + 1);
  return noteLines(after).filter((line) => {
    const n = had.get(line.key) ?? 0;
    if (n > 0) {
      had.set(line.key, n - 1);
      return false;
    }
    return true;
  });
}

/** Which fade step a line that arrived at `at` is on at `now`; null once it
 *  has aged out. */
export function recentStep(at: number, now: number): number | null {
  const age = now - at;
  if (age >= RECENT_NOTE_MS) return null;
  return Math.min(RECENT_NOTE_LAST_STEP, Math.max(0, Math.floor(age / RECENT_NOTE_STEP_MS)));
}

/**
 * Whether the set of tinted lines differs between two editor states —
 * arrived, stepped or aged out. A cheap identity check for a caller that
 * wants to react to the tint set alone rather than to every transaction.
 */
export function recentTintChanged(prev: EditorState, next: EditorState): boolean {
  return key.getState(prev) !== key.getState(next);
}

interface Spec {
  at: number;
}

function tint(from: number, to: number, at: number, now: number): Decoration | null {
  const step = recentStep(at, now);
  if (step === null) return null;
  // `data-at` is the arrival instant in the DOM. The step drives the tint;
  // the instant drives the margin card's "added 1m 15s ago", which needs a
  // finer grain than the four tint steps can carry (recent-note-cards.ts).
  return Decoration.node(
    from,
    to,
    { class: 'recent-note', 'data-age': String(step), 'data-at': String(at) },
    { at } satisfies Spec,
  );
}

/** The same lines, re-stepped for `now`; aged-out ones dropped. */
function reband(doc: ProseNode, set: DecorationSet, now: number): DecorationSet {
  const decos: Decoration[] = [];
  for (const d of set.find()) {
    const next = tint(d.from, d.to, (d.spec as Spec).at, now);
    if (next) decos.push(next);
  }
  return DecorationSet.create(doc, decos);
}

export const SettleWash = Extension.create<SettleWashOptions>({
  name: 'settleWash',

  addOptions() {
    return { isLive: () => false };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const now = () => (options.now ?? Date.now)();
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            let next = set.map(tr.mapping, tr.doc);
            const rebandAt = tr.getMeta(REBAND) as number | undefined;
            if (rebandAt !== undefined) next = reband(tr.doc, next, rebandAt);
            if (!tr.docChanged || !tr.getMeta(ySyncPluginKey) || !options.isLive()) return next;
            // Hydration is a remote transaction too — the binding applies the
            // whole existing doc over an empty one when the surface mounts.
            // Opening a doc mid-meeting must not tint its entire notes
            // section, so a write over an empty doc never tints.
            if (tr.before.textContent === '') return next;
            const at = now();
            const decos: Decoration[] = [];
            for (const line of newNoteLines(tr.before, tr.doc)) {
              const d = tint(line.from, line.to, at, at);
              if (d) decos.push(d);
            }
            return decos.length > 0 ? next.add(tr.doc, decos) : next;
          },
        },
        props: {
          decorations(state) {
            return key.getState(state);
          },
        },
        view(view) {
          let timer: ReturnType<typeof setTimeout> | null = null;
          const arm = () => {
            if (timer !== null) return;
            timer = setTimeout(() => {
              timer = null;
              view.dispatch(view.state.tr.setMeta(REBAND, now()));
            }, RECENT_NOTE_STEP_MS);
          };
          return {
            update(v, prev) {
              const was = key.getState(prev);
              const is = key.getState(v.state);
              if (was === is) return;
              const before = was?.find().length ?? 0;
              const after = is?.find().length ?? 0;
              if (after > before) options.onNotesInsert?.();
              // While anything is tinted, the next step is thirty seconds
              // out; the last re-band finds nothing left and arms nothing.
              if (after > 0) arm();
            },
            destroy() {
              if (timer !== null) clearTimeout(timer);
            },
          };
        },
      }),
    ];
  },
});
