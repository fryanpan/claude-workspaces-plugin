/**
 * The one block that renders a SECRET item's fields, on every surface that
 * renders one.
 *
 * It exists because the two surfaces disagreed. The Home walkthrough drew
 * this form; the task panel drew the ordinary answer furniture — candidate
 * options and the verbatim composer — over the same item, so a reader one tap
 * from the walkthrough's own Task link was offered a free-text box for a
 * value, typed one in, and had it recorded on the item, written to the store
 * on disk, echoed into the feed and read back by the agent (UX review,
 * 2026-09-12). A shape whose whole point is that no agent sees the value
 * cannot have a second renderer that forgets.
 *
 * So the gate and the form ship together, in one export. A surface passes the
 * fields and the gate and gets whichever of the two is right; it cannot
 * render the fields while forgetting the refusal, and it has nothing to
 * decide. The composer that must not appear is not reachable from here at
 * all — see `ReviewSecretBlock` for where that absence is spelled out.
 */
import type { ReviewSecretField } from '@claude-workspaces/core';
import { Fragment } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { SecretsGate } from './board-review-model.ts';

/** The eye on a secret field — open when the value is masked (tap to show),
 *  struck through when it is showing. Inline for the same reason the board's
 *  other one-off mark is: there is no sprite on this page. */
function EyeMark(props: { shown: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
      />
      <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.4" />
      {props.shown ? (
        <path d="M2.5 13.5 13.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4" />
      ) : null}
    </svg>
  );
}

/**
 * The fields of a SECRET item, and the one control that sends them.
 *
 * It sits where the options sit on a decision, and it replaces the composer
 * rather than joining it: there is no free-text box on this card, because a
 * value typed into one would travel the ordinary answer path into the item,
 * the feed and the agent's context. That absence is the feature.
 *
 * Nothing typed here is kept anywhere but the input nodes. No component
 * state, no draft store, no `keepKey` — the composer's half-typed-answer
 * survival is exactly the behaviour a value must not have. Sending clears the
 * boxes only once the write has landed, so a failed hand-over leaves the
 * reader where they were; a landed one leaves nothing behind for the length
 * of the tab's life.
 *
 * The password managers are told to stay out (`data-1p-ignore`,
 * `data-lpignore`, `autocomplete="off"`): an offer to save is an offer to put
 * the value somewhere neither this page nor the store chose.
 */
function SecretFieldsForm(props: {
  fields: readonly ReviewSecretField[];
  itemKey: string;
  onSave: (values: Array<{ service: string; value: string }>) => Promise<boolean>;
}) {
  const { fields, itemKey } = props;
  const formRef = useRef<HTMLFormElement | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Which field the reader still has to fill, by service — the one line a
   * half-filled Save answers with.
   *
   * A NAME, not a count and not a list: the reader is being sent back to one
   * box, and the box is also focused. Held as state rather than written into
   * the DOM so a repaint cannot leave a stale complaint under a filled field.
   */
  const [missing, setMissing] = useState<string | null>(null);
  /**
   * Which values are showing. Empty by default — masked is the resting state
   * — and per field, because revealing one to check a paste should not put
   * the other on screen. The set holds SERVICE NAMES; no value is ever state.
   */
  const [shown, setShown] = useState<readonly string[]>([]);
  const inputs = (form: HTMLFormElement): HTMLInputElement[] =>
    Array.from(form.querySelectorAll<HTMLInputElement>('.board-walk-cred-input'));
  const submit = async (ev: Event): Promise<void> => {
    ev.preventDefault();
    const form = formRef.current;
    if (!form || busy) return;
    // Read the nodes and send. The value lives in the input the reader typed
    // it into and nowhere else — not in state, not in a closure that outlives
    // this call — and the clear below happens only once it has landed.
    const values = fields.map((f) => ({
      service: f.service,
      value:
        (form.elements.namedItem(`secret:${f.service}`) as HTMLInputElement | null)?.value ?? '',
    }));
    // All or nothing on this side too, so the refusal a reader sees for a
    // half-filled form is immediate rather than a round trip away — and it is
    // a refusal they can SEE. Focus goes to the first field that is actually
    // empty, read off `.value`: an `input` element has no `value` ATTRIBUTE
    // unless somebody wrote one, so the `[value=""]` selector this used to
    // ask for matched nothing, focus fell back to the first field whether or
    // not it was filled, and Save read as a button that did nothing.
    const empty = values.find((v) => v.value === '');
    if (empty) {
      setMissing(empty.service);
      inputs(form)
        .find((el) => el.value === '')
        ?.focus();
      return;
    }
    setMissing(null);
    setBusy(true);
    let saved = false;
    try {
      saved = await props.onSave(values);
    } finally {
      // CLEARED ON SUCCESS ONLY. A failed save used to empty both boxes,
      // which made a refusal cost the reader everything they had typed — on a
      // phone, from a password manager they had already dismissed. The nodes
      // are where a half-finished form always lives, the card is gone from
      // the queue the moment a save lands, and a failure leaves the reader
      // exactly where they were: able to fix one character and press Save.
      if (saved) {
        for (const input of inputs(form)) input.value = '';
        setShown([]);
      }
      setBusy(false);
    }
  };
  return (
    <form class="board-walk-answer board-walk-cred-form" ref={formRef} onSubmit={submit}>
      <div class="board-walk-creds">
        {fields.map((f) => {
          const isShown = shown.includes(f.service);
          return (
            <label key={f.service} class="board-walk-cred" for={`secret:${itemKey}:${f.service}`}>
              <span class="board-walk-cred-head">
                <span class="board-walk-cred-label">{f.label}</span>
                <span class="board-walk-cred-service">{f.service}</span>
              </span>
              <span class="board-walk-cred-box">
                <input
                  id={`secret:${itemKey}:${f.service}`}
                  name={`secret:${f.service}`}
                  class="board-walk-cred-input"
                  type={isShown ? 'text' : 'password'}
                  autocomplete="off"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck={false}
                  data-1p-ignore
                  data-lpignore="true"
                  // "send", not "done": the key submits the form, and a phone
                  // keyboard that says done reads as "close this".
                  enterkeyhint="send"
                  onInput={() => {
                    if (missing === f.service) setMissing(null);
                  }}
                />
                <button
                  type="button"
                  class="board-walk-cred-eye"
                  aria-label={isShown ? `Hide ${f.label}` : `Show ${f.label}`}
                  aria-pressed={isShown}
                  onClick={() =>
                    setShown((was) =>
                      was.includes(f.service)
                        ? was.filter((s) => s !== f.service)
                        : [...was, f.service],
                    )
                  }
                >
                  <EyeMark shown={isShown} />
                </button>
              </span>
            </label>
          );
        })}
      </div>
      <div class="board-walk-cred-send-row">
        {missing !== null ? (
          // `output`, not a span with a role: it IS the live region, so a
          // reader on a screen reader is told which field is still empty
          // without the markup having to claim it.
          <output class="board-walk-cred-miss">
            {fields.find((f) => f.service === missing)?.label ?? 'One field'} is still empty.
          </output>
        ) : null}
        <button type="submit" class="board-btn board-btn-ink board-walk-cred-send" disabled={busy}>
          Save Secret
        </button>
      </div>
    </form>
  );
}

/**
 * The same fields with no way to fill them, for a reader who may not.
 *
 * A member sees WHAT is being asked for — the workspace is a shared view and
 * withholding the names would make the card unreadable — and no inputs, plus
 * the line saying whose ask this is. The server refuses them regardless; this
 * is so the refusal is not the first they hear of it.
 */
function SecretFieldsRefused(props: { fields: readonly ReviewSecretField[] }) {
  return (
    <div class="board-walk-creds">
      {props.fields.map((f) => (
        <div key={f.service} class="board-walk-cred is-refused">
          <span class="board-walk-cred-head">
            <span class="board-walk-cred-label">{f.label}</span>
            <span class="board-walk-cred-service">{f.service}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * A secret item's answering block: the form, or the refusal, decided here.
 *
 * Every surface that draws a secret item draws THIS and nothing else in the
 * place its answer furniture would go. Not the options — a secret ask has no
 * candidates — and above all not the verbatim composer, whose words are
 * recorded on the item and read back by the agent. The reader who wants to
 * say something instead still has "I have a question", which each surface
 * keeps beside this block.
 */
export function ReviewSecretBlock(props: {
  fields: readonly ReviewSecretField[];
  /** Scopes the input ids, so two cards on one page do not collide. */
  itemKey: string;
  gate: SecretsGate;
  onSave: (values: Array<{ service: string; value: string }>) => Promise<boolean>;
}) {
  if (props.gate === 'open') {
    return <SecretFieldsForm fields={props.fields} itemKey={props.itemKey} onSave={props.onSave} />;
  }
  // A Fragment, not a wrapper: the two children sit directly in whatever
  // column the surface put this block in, which is how the walkthrough has
  // always laid them out and what keeps one set of rules styling both
  // surfaces.
  return (
    <Fragment>
      <SecretFieldsRefused fields={props.fields} />
      {/* Two ways to be refused, and they are not the same sentence. A member
          may never answer this one. The board's own owner reading through a
          share hostname MAY — just not from there, because the door that
          takes the values is reachable only on the machine the board runs
          on — so they are told where rather than told no. */}
      <span class="board-walk-question-note">
        {props.gate === 'not-owner'
          ? 'Only the Owner can answer this.'
          : 'This one is answered on the machine the board runs on.'}
      </span>
    </Fragment>
  );
}
