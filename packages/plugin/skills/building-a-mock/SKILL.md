---
name: building-a-mock
description: Use when writing or revising an HTML mock or prototype for UX feedback on a claude-workspaces board, including a new round on an existing mock or a mock of a change to an existing screen.
---

# Building a mock

A mock exists so a person can act on it and comment on it. Each step leaves a proof.

**First:** call `read_project_conventions(<any path in the repo>)`. A `## Workflow: building-a-mock` section there adds steps; do them where it says.

## Steps

1. **Start from the real surface.** For a change to an existing screen, copy its served markup and its own stylesheets, then change the copy. Later rounds edit the file the mock serves from. *Check (manual):* every stylesheet in the file is the app's own, linked by its served path.
2. **Make every state reachable by acting on the page.** *Check (manual):* reach each state the task names in the rendered page by tapping or typing (a CDP click, headless). Captioned scenes fail.
3. **Serve it, and render it as the reader sees it.** `attach_mockup` on the first round only; later, a reload shows your edit. Then run:

   ```bash
   node <this skill's base directory>/check-mock-render.mjs --url <mock URL> --out <dir>
   ```

   `<mock URL>` is the path `attach_mockup` returned, on the board's local address (such as `http://127.0.0.1:8787`); a public hostname gives a sign-in page. It renders 1900x1200, 1180x820 and 430x932 in throwaway headless Chrome, and exits 1 when the widget is missing or hidden, or the page scrolls sideways at 430. Get exit 0, then look at the screenshots. Needs Node 22+ and Chrome (`--chrome <path>`).
4. **Run a UX walk in a subagent**, using the `ux-review` skill as `qa-delegate` describes (team-lead-fleet). Give it the URL, persona and states. A severe finding goes back to step 2.
5. **Hand off.** **REQUIRED SUB-SKILL:** `claude-workspaces:handing-off-for-review`. Answer on the reader's existing thread on the mock and revise your existing item ("Keep one place to work together" in `claude-workspaces:working-in-a-workspace`). Widget details: `claude-workspaces:embedding-widget`.

## Keep the reader's place when a round lands

When you save the file, an open page swaps in the new round without reloading. The frame's query, hash and scroll stay as they were. Your scripts run again from the start, so a reader on an inner screen goes back to the first one unless the mock saves and restores its state:

```html
<script>
  let tab = 'overview';
  // Before the swap: put on e.detail.state what the next round needs.
  addEventListener('cw-round-leaving', (e) => { e.detail.state = { tab }; });
  // In the new round: window.cwRoundState is that value (undefined on a first load).
  document.addEventListener('DOMContentLoaded', () => show(window.cwRoundState?.tab ?? 'overview'));
</script>
```

- The board calls each `DOMContentLoaded` and `load` listener the new round's inline scripts add, and an `onload` they set, once after the swap, because the page does not reload and the browser does not fire those events again. Scripts loaded by `src` and `type="module"` scripts run later, so this call misses them. In those scripts, read `window.cwRoundState` or listen for `cw-round-arrived`.
- `cw-round-arrived` fires on `window` after the swap. Its `e.detail.state` holds the same value.
- If more than one round added a `cw-round-leaving` listener, the listener added last sets the value that is kept.

## Done criteria this workflow adds to the task

| Criterion | Proof |
| --- | --- |
| Uses the surface's own stylesheets | The stylesheet paths |
| Every named state reachable by acting | Each state and its action |
| Render check exits 0 | Its JSON line and screenshots |
| UX walk found nothing severe | The subagent's report |
| Handed off | The review item |

## Red flags

| Thought | Reality |
| --- | --- |
| "No time for the render check" | It takes 30 seconds; a mock with no widget costs a round. |
| "A local screenshot, `observe_url` or a curl 200 proves it" | Only the served route has the widget; `observe_url` is an event stream; a 200 is the host page, not the mock. |
| "I'll do the UX pass myself" | A builder can't sign off their own work. |
