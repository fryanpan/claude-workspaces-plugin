#!/usr/bin/env bun
/**
 * Whose circle is whose in the presence deck, in headless Chromium against a
 * real server and the real bundles, at 1180x820 and 430x932.
 *
 * Alice reads the board. Bob is on the board with her, Saltmarsh is on a
 * doc, the lead points at the Library, and two more agents are listening.
 * The driver reads every circle in Alice's deck (its fill, its letters,
 * whether those letters are on top at the circle's centre, its shape), the
 * names beside the deck, the fill of each row in her list, and the fills in
 * Saltmarsh's deck on the doc.
 *
 * Spawned by `presence-faces-browser.test.ts`, which reads the JSON it
 * prints last.
 */
import type { Cdp } from '../../../scripts/headless-chrome.ts';
import { agentStream } from '../../server/test/agent-voice-stream.ts';
import {
  SIZES,
  bootBoard,
  closePerson,
  deadline,
  navigate,
  openPerson,
  shutdown,
  tap,
  until,
} from './follow-browser-kit.ts';

/** The agents beside the lead. Listening, so the board draws them. */
export const MORE_AGENTS = ['riverbend-builder', 'ci-flakes'];

export interface FaceRead {
  key: string;
  kind: 'person' | 'agent';
  fill: string;
  /** The letters as drawn, and their computed size in px. */
  letters: string;
  letterPx: number;
  /** Whether the circle itself is what sits at its own centre: false when a
   *  neighbour covers its letters. */
  onTop: boolean;
  radius: string;
  /** The circle's drawn width in px. */
  size: number;
}

export interface FacesRound {
  width: number;
  deck: FaceRead[];
  /** The "+N" mark the deck shows, or null. */
  more: string | null;
  /** The names beside the deck: their words, and whether they show. */
  names: { text: string; shown: boolean };
  /** Each row's circle fill in Alice's open list, by key. */
  rows: Record<string, string>;
  /** Each circle's fill in Saltmarsh's deck on the doc, by key. */
  docDeck: Record<string, string>;
}

const step = (what: string): void => {
  process.stderr.write(`[presence-faces-driver] ${what}\n`);
};

const READ_DECK = `(() => [...document.querySelectorAll('.board-presence-deck [data-key]')]
  .filter((c) => getComputedStyle(c).display !== 'none')
  .map((c) => {
    const face = c.querySelector('wa-avatar') ?? c;
    const s = getComputedStyle(face);
    const r = c.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      key: c.dataset.key,
      kind: c.classList.contains('board-presence-agent') ? 'agent' : 'person',
      fill: s.backgroundColor,
      letters: (face.getAttribute('initials') ?? c.innerText).trim(),
      letterPx: Number.parseFloat(s.fontSize),
      onTop: !!hit && (hit === c || c.contains(hit)),
      radius: s.borderRadius,
      size: r.width,
    };
  }))()`;

const READ_NAMES = `(() => {
  const n = document.querySelector('.board-presence-deck .board-presence-names');
  if (!n) return { text: '', shown: false };
  const r = n.getBoundingClientRect();
  return { text: n.textContent.trim(), shown: getComputedStyle(n).display !== 'none' && r.width > 0 };
})()`;

const READ_MORE = `(() => {
  const m = [...document.querySelectorAll('.board-presence-deck .board-presence-more')].find(
    (e) => getComputedStyle(e).display !== 'none',
  );
  return m ? m.textContent.trim() : null;
})()`;

const FILLS_BY_KEY = (scope: string) => `(() => Object.fromEntries(
  [...document.querySelectorAll(${JSON.stringify(`${scope} [data-key]`)})].map((c) => [
    c.dataset.key,
    getComputedStyle(c.querySelector('wa-avatar') ?? c).backgroundColor,
  ])))()`;

const DECK_CENTRE = `(() => {
  const r = document.querySelector('.board-presence-deck').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`;

async function deckOf(cdp: Cdp, atLeast: number): Promise<void> {
  await until(`a deck of ${atLeast}`, async () =>
    ((await cdp.evaluate(
      `document.querySelectorAll('.board-presence-deck [data-key]').length`,
    )) as number) >= atLeast
      ? true
      : null,
  );
}

async function main(): Promise<void> {
  deadline('presence-faces-driver', 200_000);
  const board = await bootBoard('presence-faces');
  const { base, ws, docId } = board;
  const streams = [];
  for (const agentId of MORE_AGENTS) {
    board.server.tasks.attachAgent(ws, {
      agentId,
      agentName: agentId,
      runtime: 'claude-code-local',
    });
    streams.push(await agentStream(base, ws, agentId));
  }
  await board.point({ path: 'library' });
  const rounds: FacesRound[] = [];
  try {
    for (const [width, height] of SIZES) {
      step(`people at ${width}`);
      const people: Cdp[] = [];
      for (const name of ['Alice', 'Bob', 'Saltmarsh']) {
        people.push(
          await openPerson(width, height, {
            anonId: `${name.toLowerCase()}-${width}`,
            name,
            signIn: true,
            ws,
          }),
        );
      }
      const [alice, bob, salt] = people as [Cdp, Cdp, Cdp];
      await navigate(alice, `${base}/workspaces/${ws}`);
      await navigate(bob, `${base}/workspaces/${ws}`);
      await navigate(salt, `${base}/workspaces/${ws}/docs/${docId}`);
      // Bob, Saltmarsh, the lead and both agents: five, of which the deck
      // draws three and counts two.
      await deckOf(alice, 3);
      // Bob here and Saltmarsh elsewhere: everybody has arrived, so no
      // later arrival can move a colour between the reads below.
      await until('Bob here and Saltmarsh elsewhere in Alice’s deck', async () =>
        (await alice.evaluate(
          `!!document.querySelector('.board-presence-deck .board-presence-here.board-presence-person') && !!document.querySelector('.board-presence-deck .board-presence-away.board-presence-person')`,
        ))
          ? true
          : null,
      );
      const deck = (await alice.evaluate(READ_DECK)) as FaceRead[];
      const names = (await alice.evaluate(READ_NAMES)) as FacesRound['names'];
      const more = (await alice.evaluate(READ_MORE)) as string | null;
      await deckOf(salt, 3);
      const docDeck = (await salt.evaluate(FILLS_BY_KEY('.board-presence-deck'))) as Record<
        string,
        string
      >;
      step(`Alice opens her list at ${width}`);
      await tap(alice, (await alice.evaluate(DECK_CENTRE)) as { x: number; y: number });
      const rows = await until('the list open', async () => {
        const got = (await alice.evaluate(
          FILLS_BY_KEY('.board-presence-list .board-presence-who'),
        )) as Record<string, string>;
        return Object.keys(got).length >= 5 ? got : null;
      });
      rounds.push({ width, deck, more, names, rows, docDeck });
      for (const p of people) await closePerson(p);
    }
  } finally {
    for (const s of streams) s.close();
    board.lead.close();
    await shutdown();
  }
  process.stdout.write(`${JSON.stringify({ rounds })}\n`);
  process.exit(0);
}

await main();
