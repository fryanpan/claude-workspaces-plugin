/**
 * "Done when" — the list of outcomes a ticket has to satisfy, drawn under the
 * description with one verdict chip per line and the builder's proof folded
 * under a line that carries any.
 *
 * The shape Bryan picked from the mock (style D): the number on the left, the
 * words in the middle, ONE chip on the right, and the proof box titled
 * "Builder's proof". No byline, no line count, no second chip — *"stop adding
 * extra counts and metadata that is not essential for the use case"*.
 *
 * THE WORDS ARE THE CONTROL. Editing works exactly as a task title does on
 * the board: click the words and type. There is no pencil, because the board
 * has no pencils — *"use a consistent editing mechanism throughout the app"*.
 * Enter commits and opens a fresh empty line so a list can be typed straight
 * through; Escape puts the old words back; the × on the right removes a line.
 * "Add done criteria" is the visible way in for anyone who does not know that
 * the words are clickable.
 *
 * Every write sends the WHOLE list, because the server's write is the whole
 * list — add, edit, remove and reorder are one verb there, so they are one
 * call here. A line the caller sends with its `id` keeps its verdict and its
 * proof; editing the words of a proved line is not a retraction.
 *
 * The verdicts are NOT editable here, by anybody. A builder reports them
 * through `report_done_when`, and the only thing a person can press is the
 * pair of buttons on a line the builder marked as theirs — *"only agents
 * should have to go through this flow using tools. Not me."*
 */
import { type DoneWhenVerdict, doneWhenChipLabel } from '@claude-workspaces/core/done-when';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { BoardDoneWhenLine, BoardTask } from './board-model.ts';

/** What the panel hands this component. */
export interface DoneWhenHandlers {
  /** Write the whole list. Resolves false when the write was refused, which
   *  is what puts the reader's words back. */
  onLines?: (task: BoardTask, lines: Array<{ id?: string; text: string }>) => Promise<boolean>;
  /** The owner's word on a line the builder left to them. */
  onCheck?: (task: BoardTask, lineId: string, verdict: 'met' | 'not-met') => Promise<boolean>;
}

/** The chip's own class, so a verdict's colour is decided once. */
function chipClass(verdict: DoneWhenVerdict): string {
  if (verdict === 'met') return 'dw-verdict-tag dw-verdict-met';
  if (verdict === 'not-met') return 'dw-verdict-tag dw-verdict-not';
  if (verdict === 'owner') return 'dw-verdict-tag dw-verdict-yours';
  return 'dw-verdict-tag';
}

/**
 * One artifact the builder attached.
 *
 * A row with a SAFE `url` is a link and opens in a new tab; one without is
 * the same row without the affordance, because a proof that names what was
 * run still says more than no proof at all. `rel="noreferrer"` for the reason
 * every outbound link on this board carries it.
 */
function safeHref(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function ProofRow(props: { proof: { text: string; url?: string } }) {
  const { proof } = props;
  // The server keeps only http(s) on the way in. Re-checked here anyway: this
  // row is built from whatever the task currently holds, and a proof stored
  // before that check existed would otherwise become a live `javascript:`
  // href on click. An unsafe url leaves the words and drops the link.
  const href = safeHref(proof.url);
  if (href === undefined) {
    return (
      <div class="dw-proof-row">
        <span class="dw-proof-what">{proof.text}</span>
      </div>
    );
  }
  return (
    <a class="dw-proof-row" href={href} target="_blank" rel="noreferrer">
      <span class="dw-proof-what">{proof.text}</span>
      <span class="dw-proof-open" aria-hidden="true">
        Open
      </span>
    </a>
  );
}

/**
 * The words of one line, edited in place.
 *
 * `contentEditable` rather than an input, for the reason the board's title
 * rename uses one: the words wrap, and an input that does not would either
 * clip a sentence or force a textarea whose height nobody can agree on.
 *
 * The node is deliberately uncontrolled while editing — Preact is never told
 * what is inside it, so a repaint arriving mid-edit (the board emits them
 * constantly) cannot delete what is being typed. The stored text is written
 * in only when the reader is NOT editing.
 */
function LineWords(props: {
  line: BoardDoneWhenLine;
  editable: boolean;
  /** Commit these words. `andAnother` is Enter: keep them and open a new
   *  empty line below. */
  onCommit: (text: string, andAnother: boolean) => void;
  /** Focus this line's words on mount — the freshly added one. */
  autoFocus?: boolean;
}) {
  const { line, editable, onCommit } = props;
  const ref = useRef<HTMLSpanElement | null>(null);
  const [editing, setEditing] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || editing) return;
    if (el.textContent !== line.text) el.textContent = line.text;
  });

  useLayoutEffect(() => {
    if (!props.autoFocus) return;
    const el = ref.current;
    if (!el) return;
    setEditing(true);
    el.focus();
  }, [props.autoFocus]);

  const commit = (andAnother: boolean): void => {
    const el = ref.current;
    const text = (el?.textContent ?? '').trim();
    setEditing(false);
    // Unchanged words are not a write. The board repaints on every event, and
    // a blur that posted the same sentence back would be a round trip per
    // click on a line nobody edited.
    if (text === line.text && !andAnother) return;
    onCommit(text, andAnother);
  };

  return (
    <span
      ref={ref}
      class="dw-text"
      // The words ARE the edit control, exactly as the board row's title is,
      // so they are focusable: without this the line is reachable by pointer
      // only, and a reader on a keyboard cannot edit a criterion at all.
      tabIndex={editable ? 0 : -1}
      contentEditable={editable && editing}
      title={editable ? 'Click the words to edit this line' : undefined}
      onClick={() => {
        if (editable) setEditing(true);
      }}
      onFocus={() => {
        if (editable) setEditing(true);
      }}
      onKeyDown={(e: KeyboardEvent) => {
        if (!editable) return;
        if (e.key === 'Enter') {
          // Enter keeps the words and opens the next line, which is what
          // lets a whole list be typed without reaching for the mouse. The
          // default would insert a newline into a one-line criterion.
          e.preventDefault();
          commit(true);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          const el = ref.current;
          if (el) el.textContent = line.text;
          setEditing(false);
          el?.blur();
        }
      }}
      onBlur={() => {
        if (editing) commit(false);
      }}
    />
  );
}

/**
 * The list, its chips, its proofs and the two ways to change it.
 *
 * Renders nothing at all on a task with no lines and no way to add one — a
 * share visitor's read-only panel says nothing rather than showing an empty
 * heading that promises a section the ticket does not have.
 */
export function DoneWhenList(props: {
  task: BoardTask;
  handlers: DoneWhenHandlers;
  /** Why the last move to Done was refused, when it was, so the message can
   *  mark the line it named. */
  refusedLineId?: string;
}) {
  const { task, handlers } = props;
  const lines = task.doneWhen ?? [];
  const editable = handlers.onLines !== undefined && task.status !== 'done';
  // The line to put the caret in on the next paint: the one "Add done
  // criteria" or an Enter just created. Cleared once it has been used, so a
  // repaint does not drag the reader back into it.
  const [focusId, setFocusId] = useState<string | null>(null);

  if (lines.length === 0 && !editable) return null;

  /** Send the sequence, with one line's words replaced, removed or added. */
  const write = (next: Array<{ id?: string; text: string }>): void => {
    void handlers.onLines?.(task, next);
  };

  const asInput = (line: BoardDoneWhenLine) => ({ id: line.id, text: line.text });

  const commitLine = (line: BoardDoneWhenLine, text: string, andAnother: boolean): void => {
    const next: Array<{ id?: string; text: string }> = [];
    for (const l of lines) {
      if (l.id !== line.id) {
        next.push(asInput(l));
        continue;
      }
      // Emptying a line removes it. The × is the deliberate way out and this
      // is the accidental one — either way a criterion with no words is not a
      // criterion, and keeping it would put an unanswerable line in the gate.
      if (text !== '') next.push({ id: l.id, text });
      if (andAnother) next.push({ text: '' });
    }
    write(next);
    // The new line has no id yet, so the focus is claimed by POSITION: the
    // paint after the write re-reads the list from the server and the line
    // that follows the one just committed is the new one.
    if (andAnother) setFocusId(`after:${line.id}`);
  };

  return (
    <>
      <h3 class="board-detail-subhead dw-head">Done when</h3>
      <ol class="dw-list">
        {lines.map((line, i) => {
          const previous = lines[i - 1];
          // The fresh line has no id of its own yet, so it is claimed by
          // POSITION: it is the empty line sitting where the write put it,
          // right after the line the reader committed (or at the head, when
          // the list was empty).
          const autoFocus =
            focusId === line.id ||
            (line.text === '' &&
              (previous !== undefined ? focusId === `after:${previous.id}` : focusId === 'after:'));
          return (
            <li
              key={line.id}
              class={`dw-line${props.refusedLineId === line.id ? ' dw-line-refused' : ''}`}
            >
              <div class="dw-cell">
                <div class="dw-body">
                  <LineWords
                    line={line}
                    editable={editable}
                    autoFocus={autoFocus}
                    onCommit={(text, andAnother) => {
                      if (autoFocus) setFocusId(null);
                      commitLine(line, text, andAnother);
                    }}
                  />
                  {line.verdict !== undefined && (
                    <span class={chipClass(line.verdict)}>{doneWhenChipLabel(line.verdict)}</span>
                  )}
                  {editable && (
                    <button
                      type="button"
                      class="dw-line-x"
                      title="Remove this line"
                      aria-label={`Remove done-when line ${i + 1}`}
                      onClick={() =>
                        write(lines.filter((l) => l.id !== line.id).map((l) => asInput(l)))
                      }
                    >
                      ×
                    </button>
                  )}
                </div>
                {(line.proof ?? []).length > 0 && (
                  <div class="dw-proof">
                    <div class="dw-proof-head">Builder's proof</div>
                    {(line.proof ?? []).map((p) => (
                      <ProofRow key={`${p.text}${p.url ?? ''}`} proof={p} />
                    ))}
                  </div>
                )}
                {line.verdict === 'owner' && handlers.onCheck && (
                  <div class="dw-actions">
                    <button
                      type="button"
                      class="board-btn board-btn-primary"
                      onClick={() => void handlers.onCheck?.(task, line.id, 'met')}
                    >
                      Looks right
                    </button>
                    <button
                      type="button"
                      class="board-btn"
                      onClick={() => void handlers.onCheck?.(task, line.id, 'not-met')}
                    >
                      Not met
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {editable && (
        <div class="dw-actions dw-field-act">
          <button
            type="button"
            class="board-btn dw-add"
            onClick={() => {
              write([...lines.map((l) => asInput(l)), { text: '' }]);
              // Focus the line the write is about to create — same claim by
              // position the Enter path makes, anchored on the last line the
              // list currently holds (or on the empty list).
              setFocusId(lines.length > 0 ? `after:${lines[lines.length - 1]?.id}` : 'after:');
            }}
          >
            Add done criteria
          </button>
        </div>
      )}
    </>
  );
}
