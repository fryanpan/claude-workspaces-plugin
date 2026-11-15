/**
 * The drift notices in the board's settings panel, the second island
 * `presence-island.tsx` mounts: what is running where, for the agents' plugin
 * bundles and for the browser's own client. Split from
 * `presence-island.test.tsx`, which holds the strip of people.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  type DriftNotice,
  clientDriftNotice,
  pluginDriftNotice,
} from '../src/board/board-presence-model.ts';
import { driftData, mountDriftIsland } from '../src/board/presence-island.tsx';

/** Component re-renders from a signal write are scheduled — settle them. */
const tick = () => new Promise((r) => setTimeout(r, 0));

let dispose: Array<() => void> = [];
afterEach(() => {
  for (const d of dispose) d();
  dispose = [];
  document.body.replaceChildren();
});

function mountDrift(notices: Array<DriftNotice | null>) {
  const host = document.createElement('div');
  host.className = 'board-presence';
  document.body.appendChild(host);
  driftData.value = notices;
  dispose.push(mountDriftIsland(host));
  return { host };
}

describe('presence island — plugin drift', () => {
  const drift = () =>
    pluginDriftNotice({
      version: '0.1.26',
      behind: [{ agentId: 'agent-quill', pluginVersion: '0.1.12' }],
    });

  it('shows the notice even when nobody is present to draw a chip for', () => {
    // An away session draws no chip, and an away session is exactly the one
    // most likely to be stranded on an old bundle. Hiding the region on
    // "no chips" would hide the drift with it.
    const { host } = mountDrift([drift()]);
    expect(host.classList.contains('hidden')).toBe(false);
    const note = host.querySelector('.board-drift');
    expect(note?.textContent).toContain('older plugin than 0.1.26');
    expect(note?.textContent).toContain('agent-quill 0.1.12');
    expect(note?.textContent).toContain(
      'command claude plugin update claude-workspaces@claude-workspaces',
    );
  });

  it('renders nothing when there is no notice at all', async () => {
    // Positive control: the same island WITH a notice puts a .board-drift in,
    // so this absence means the notice is what drives it.
    const { host } = mountDrift([drift()]);
    expect(host.querySelector('.board-drift')).not.toBeNull();

    driftData.value = [null];
    await tick();
    expect(host.querySelector('.board-drift')).toBeNull();
    expect(host.classList.contains('hidden')).toBe(true);
  });

  it('renders the clear reading quietly, and the alarm loudly', async () => {
    // A coverage line is on the board permanently. If it wore the alarm's
    // styling it would teach everyone to skim past the alarm — so the class
    // has to differ, and both halves are asserted in the same pass so
    // neither is a claim about a world the other does not inhabit.
    const { host } = mountDrift([pluginDriftNotice({ version: '0.1.40', behind: [], checked: 1 })]);
    const quiet = host.querySelector('.board-drift');
    expect(quiet?.classList.contains('board-drift-quiet')).toBe(true);
    expect(quiet?.textContent).toContain('No attached session is behind 0.1.40 (1 checked)');
    expect(quiet?.textContent).toContain('a peer that never attached is absent here');

    driftData.value = [drift()];
    await tick();
    expect(host.querySelector('.board-drift')?.classList.contains('board-drift-quiet')).toBe(false);
  });

  it('a board nobody has attached to does not render as all-clear', () => {
    // The defect, in the surface: an empty `behind` list used to render as
    // nothing, and nothing reads exactly like clearance.
    const { host } = mountDrift([pluginDriftNotice({ version: '0.1.40', behind: [], checked: 0 })]);
    expect(host.classList.contains('hidden')).toBe(false);
    expect(host.querySelector('.board-drift')?.textContent).toContain(
      'no session has attached to this board',
    );
  });
});

describe('presence island — client release drift', () => {
  const now = Date.UTC(2026, 7, 16, 12, 0, 0);
  const stale = () =>
    clientDriftNotice(
      {
        releaseId: '20260813T014455123Z-000003',
        publishedAt: now - 72 * 60 * 60 * 1000,
        ageMs: 72 * 60 * 60 * 1000,
        sourceRef: 'a1b2c3d',
        consecutiveFailures: 2,
        failingSince: now - 10 * 60 * 60 * 1000,
        lastError: 'client release: markdownApp bundle is incomplete — app.js missing',
        stale: true,
      },
      now,
    );
  const pluginDrift = () =>
    pluginDriftNotice({
      version: '0.1.26',
      behind: [{ agentId: 'agent-quill', pluginVersion: '0.1.12' }],
    });

  it('shows the stale-client notice on a board with nobody present', () => {
    // Nobody being present is not a reason to hide it — it is about every
    // browser that loads this board, including the one reading it now.
    const { host } = mountDrift([stale()]);
    expect(host.classList.contains('hidden')).toBe(false);
    const note = host.querySelector('.board-drift');
    expect(note?.textContent).toContain('3d ago');
    expect(note?.textContent).toContain('app.js missing');
    expect(note?.textContent).toContain('restart');
  });

  it('shows both drifts at once — they are different problems', () => {
    // The agents being behind on the plugin and the browser being behind on
    // the client are independent failures with different fixes; one must not
    // hide the other.
    const { host } = mountDrift([pluginDrift(), stale()]);
    const notes = [...host.querySelectorAll('.board-drift')];
    expect(notes.length).toBe(2);
    expect(notes[0]?.textContent).toContain('older plugin than 0.1.26');
    expect(notes[1]?.textContent).toContain('published 3d ago');
  });

  it('a slot going quiet leaves the other notice’s node alone', async () => {
    // Notices are keyed on their SLOT — 0 is always the plugin reading and 1
    // always the client's — so a fixed plugin does not rebuild the client
    // note sitting beside it.
    const { host } = mountDrift([pluginDrift(), stale()]);
    const clientNote = host.querySelectorAll('.board-drift')[1] as HTMLElement;

    driftData.value = [null, stale()];
    await tick();
    const after = host.querySelectorAll('.board-drift');
    expect(after.length).toBe(1);
    expect(after[0]).toBe(clientNote);
  });

  it('draws nothing when neither drift is real', async () => {
    // Positive control first, so the absence below means something.
    const { host } = mountDrift([stale()]);
    expect(host.querySelector('.board-drift')).not.toBeNull();

    driftData.value = [null, null];
    await tick();
    expect(host.querySelector('.board-drift')).toBeNull();
    expect(host.classList.contains('hidden')).toBe(true);
  });
});
