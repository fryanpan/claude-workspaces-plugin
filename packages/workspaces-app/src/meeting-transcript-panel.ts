/**
 * WHAT THE MEETING HEARD, one fold below the start panel.
 *
 * The notes are the reviewed record and the doc carries them. This is the
 * other one — the words themselves — which until now lived only in the
 * `-raw-transcript.md` beside the server's data dir, and that is nowhere for
 * anyone not on that machine. A bot meeting made it plain: the call went past
 * and left nothing on screen a person could open.
 *
 * ITS OWN MODULE rather than another builder inside `meeting-chooser.ts`,
 * because the chooser is the panel where every BILLED CHOICE for the next
 * recording is made and this is a report on the last one. They share a
 * popover and nothing else.
 *
 * FETCHED AT THE FIRST OPEN, never at mount. The meeting whose words somebody
 * wants is usually the one that has just ended, and a bot meeting's end moves
 * nothing else on this surface — so a value loaded when the doc opened would
 * be the wrong meeting's exactly when it matters. A failed read is retried on
 * the next open; a successful one is not re-asked.
 */

/** The reader the fold calls. Null means the doc has never held a meeting. */
export type TranscriptReader = () => Promise<{ lines: string[] } | null>;

/**
 * The `<details>` element, ready to append. It wires its own `toggle`
 * listener and dies with the popover it is put into — the panel is rebuilt
 * from scratch on every render, so there is nothing to unsubscribe.
 */
export function mountTranscriptFold(read: TranscriptReader): HTMLElement {
  const wrap = document.createElement('details');
  wrap.className = 'meeting-pop-transcript';
  const summary = document.createElement('summary');
  summary.textContent = 'Transcript';
  const body = document.createElement('div');
  body.className = 'meeting-pop-transcript-body';
  body.textContent = 'Loading…';
  wrap.append(summary, body);
  let asked = false;
  wrap.addEventListener('toggle', () => {
    if (!wrap.open || asked) return;
    asked = true;
    void read()
      .then((found) => {
        body.replaceChildren();
        if (!found || found.lines.length === 0) {
          body.textContent = 'No transcript yet.';
          return;
        }
        for (const line of found.lines) {
          const row = document.createElement('div');
          row.className = 'meeting-pop-transcript-line';
          row.textContent = line;
          body.append(row);
        }
      })
      .catch(() => {
        // A record that will not load costs the fold its words, never the
        // panel: the Start button below it still starts a meeting. Asked
        // again on the next open, because the failure may have been the
        // network rather than the record.
        body.textContent = 'The transcript could not be loaded.';
        asked = false;
      });
  });
  return wrap;
}
