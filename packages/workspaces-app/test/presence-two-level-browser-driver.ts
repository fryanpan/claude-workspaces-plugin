#!/usr/bin/env bun
/**
 * The two-level presence strip (design F) in headless Chromium against a
 * real server and the real bundles, at 1180x820 and 430x932.
 *
 * Alice has the board open. Bob opens a doc in a second browser, and Alice's
 * strip shows him under "Elsewhere in Harborlight". Bob comes to the board,
 * and Alice's strip moves him under "Here with you". Alice taps his row, and
 * his card opens; she taps Follow on it, and a bar says she is following him.
 * Bob opens the doc again, and Alice's browser goes there with him. Alice
 * taps Stop on the bar, and the follow ends. Bob goes back to the board;
 * Alice opens his card and taps Go there, and her browser goes to the board.
 *
 * Every live step is timed from the moment the server's presence room holds
 * the change, and each must land on Alice's page within `LIVE_MS`: the poll
 * gives up at that bound and the driver fails. The times are reported.
 *
 * Spawned by `presence-two-level-browser.test.ts`, which reads the JSON it
 * prints last.
 */
import type { Cdp } from '../../../scripts/headless-chrome.ts';
import {
  ADDRESS,
  SIZES,
  bootBoard,
  closePerson,
  deadline,
  navigate,
  openPerson,
  personIdOf,
  shutdown,
  tap,
  until,
} from './follow-browser-kit.ts';

/** Every surface is live: a change made elsewhere shows within 1s. */
const LIVE_MS = 1000;

export interface Row {
  group: string;
  name: string;
  line: string;
}

export interface Round {
  width: number;
  /** Bob on the doc: where Alice's deck draws him, and her list. */
  elsewhere: { place: string; rows: Row[]; ms: number };
  /** Bob on the board: the same. */
  here: { place: string; rows: Row[]; ms: number };
  /** Bob's card, opened from his row while he was on the board. */
  card: Card;
  /** The bar on the board, right after Alice tapped Follow on the card. */
  barOnBoard: Bar;
  /** Alice followed Bob onto the doc: her address, her strip's ring, and the
   *  bar on the doc page. */
  followed: { address: string; ringOnBob: boolean; ms: number; bar: Bar; rows: Row[] };
  /** Alice tapped Stop on the bar: whether the follow is still held, and
   *  whether her page started to leave when Bob next moved. */
  stopped: {
    ringOnBob: boolean;
    stored: string | null;
    address: string;
    leftPage: boolean;
    notice: string;
    bar: boolean;
  };
  /** Alice, on the doc, opened Bob's card (he is on the board) and tapped Go
   *  there: the card she read, and the address her browser reached. */
  went: { card: Card; address: string };
  /** The deck's box on the board and on the doc, each with Bob here and the
   *  lead elsewhere. */
  deckOnBoard: Box;
  deckOnDoc: Box;
  /** The lead's circle on the board and on the doc. */
  leadOnBoard: Face;
  leadOnDoc: Face;
}

export interface Face {
  fill: string;
  initials: string;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Card {
  name: string;
  tag: string;
  where: string;
  buttons: string[];
}

export interface Bar {
  label: string;
  text: string;
  page: string;
  box: Box;
}

export interface TwoLevelRun {
  rounds: Round[];
}

const step = (what: string): void => {
  process.stderr.write(`[presence-f-driver] ${what}\n`);
};

/** Where Alice's deck draws `key`: here, elsewhere, or not at all. */
const placeOf = (key: string) => `(() => {
  const c = document.querySelector('.board-presence-deck [data-key="${key}"]');
  if (!c) return null;
  return c.classList.contains('board-presence-here') ? 'here' : 'elsewhere';
})()`;

/** Whether the deck marks `key` as followed. */
const ringOn = (key: string) =>
  `!!document.querySelector('.board-presence-deck [data-key="${key}"].board-following')`;

/** The open list, row by row, under the heading of its group. */
const READ_LIST = `(() => {
  const list = document.querySelector('.board-presence-list');
  if (!list) return null;
  const rows = [];
  let group = '';
  for (const el of list.children) {
    if (el.classList.contains('board-presence-group')) group = el.textContent;
    else if (el.classList.contains('board-presence-row')) {
      rows.push({ group, name: el.querySelector('b')?.textContent ?? '', line: el.querySelector('small')?.textContent ?? '' });
    }
  }
  return rows;
})()`;

/** The doc page's toast, while it shows. */
const TOAST = `(() => {
  const t = document.getElementById('toast');
  return t && !t.classList.contains('hidden') ? t.textContent : null;
})()`;

const boxOf = (selector: string) => `(() => {
  const d = document.querySelector(${JSON.stringify(selector)});
  if (!d) return null;
  const r = d.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})()`;
const DECK_BOX = boxOf('.board-presence-deck');

/** The lead's circle in the deck: its fill and its initials. */
const LEAD_FACE = `(() => {
  const c = document.querySelector('.board-presence-deck .board-presence-agent');
  if (!c) return null;
  return { fill: getComputedStyle(c).backgroundColor, initials: c.textContent.trim() };
})()`;

/** The open card: whose, the where-line, and its buttons' words. */
const READ_CARD = `(() => {
  const c = document.querySelector('.board-presence-card');
  if (!c) return null;
  return {
    name: c.getAttribute('aria-label') ?? '',
    tag: c.querySelector('.board-presence-card-tag')?.textContent ?? '',
    where: c.querySelector('.board-presence-card-where')?.textContent ?? '',
    buttons: [...c.querySelectorAll('.board-presence-act')].map((b) => b.textContent),
  };
})()`;

/** The Following bar, while it shows. */
const READ_BAR = `(() => {
  const b = document.querySelector('.board-follow-bar');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return {
    label: b.getAttribute('aria-label') ?? '',
    text: b.querySelector('.board-follow-text > span')?.textContent ?? '',
    page: b.querySelector('.board-follow-text small')?.textContent ?? '',
    box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
  };
})()`;

/** The centre of the first element `selector` matches, or null. */
const centreOf = (selector: string) => `(() => {
  const e = document.querySelector(${JSON.stringify(selector)});
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
})()`;

async function tapOn(cdp: Cdp, selector: string): Promise<void> {
  const at = await until(
    `${selector} on screen`,
    async () => (await cdp.evaluate(centreOf(selector))) as { x: number; y: number } | null,
  );
  await tap(cdp, at);
}

/** Open Alice's list by tapping the deck, and read it. */
async function readList(cdp: Cdp): Promise<Row[]> {
  await tapOn(cdp, '.board-presence-deck');
  const rows = await until('the list open', async () => (await cdp.evaluate(READ_LIST)) as Row[]);
  // Close it again, as a reader would, with Escape.
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await until('the list closed', async () =>
    (await cdp.evaluate(`!document.querySelector('.board-presence-list')`)) ? true : null,
  ).catch(async (e) => {
    step(
      JSON.stringify(
        await cdp.evaluate(
          `({ cls: document.querySelector('.board-presence-f')?.className, exp: document.querySelector('.board-presence-deck')?.getAttribute('aria-expanded'), active: document.activeElement?.className, at: location.pathname })`,
        ),
      ),
    );
    throw e;
  });
  return rows;
}

/** Open `key`'s card from the list, and read it. */
async function openCard(cdp: Cdp, key: string): Promise<Card> {
  await tapOn(cdp, '.board-presence-deck');
  await until('the list open', async () => (await cdp.evaluate(READ_LIST)) as Row[]);
  await tapOn(cdp, `.board-presence-row[data-key="${key}"] .board-presence-who`);
  return until('the card open', async () => (await cdp.evaluate(READ_CARD)) as Card | null).catch(
    async (e) => {
      // What the page held when no card came: the list, its row for `key`,
      // whether a card exists at all, and where focus went. A failed read
      // must not hide the timeout it is explaining.
      step(
        JSON.stringify(
          await cdp
            .evaluate(`({
            list: !!document.querySelector('.board-presence-list'),
            row: !!document.querySelector('.board-presence-row[data-key=${JSON.stringify(key)}]'),
            keys: [...document.querySelectorAll('.board-presence-row')].map((r) => r.dataset.key),
            card: document.querySelector('.board-presence-card')?.outerHTML.slice(0, 200) ?? null,
            active: document.activeElement?.className,
            at: location.pathname,
          })`)
            .catch((read: unknown) => `dump failed: ${String(read)}`),
        ),
      );
      throw e;
    },
  );
}

/** How long, from now, until `read` answers within `LIVE_MS`. */
async function timed<T>(what: string, read: () => Promise<T | null>): Promise<[T, number]> {
  const t0 = performance.now();
  const v = await until(what, read, LIVE_MS);
  return [v, Math.round(performance.now() - t0)];
}

async function main(): Promise<void> {
  deadline('presence-f-driver', 200_000);
  const board = await bootBoard('presence-f');
  const { base, ws, docId } = board;
  // The lead points at the Library, so every page draws it: a doc page draws
  // an agent only once it has pointed somewhere. Both decks then hold the
  // same two people, and their boxes can be compared.
  await board.point({ path: 'library' });
  const rounds: Round[] = [];
  try {
    for (const [width, height] of SIZES) {
      step(`people at ${width}`);
      const alice = await openPerson(width, height, {
        anonId: `alice-${width}`,
        name: 'Alice',
        signIn: true,
        ws,
      });
      const bob = await openPerson(width, height, {
        anonId: `bob-${width}`,
        name: 'Bob',
        signIn: true,
        ws,
      });
      const bobId = personIdOf(`bob-${width}`);
      const bobKey = `p-${bobId}`;
      const docPath = `/workspaces/${ws}/docs/${docId}`;
      await navigate(alice, `${base}/workspaces/${ws}`);
      await until('Alice on the board', async () =>
        board.spotOf(personIdOf(`alice-${width}`)) ? true : null,
      );

      step(`Bob opens the doc at ${width}`);
      await navigate(bob, `${base}${docPath}`);
      await until('Bob on the doc, in the room', async () =>
        board.spotOf(bobId)?.docId === docId ? true : null,
      );
      const [, elsewhereMs] = await timed('Bob elsewhere in Alice’s strip', async () =>
        (await alice.evaluate(placeOf(bobKey))) === 'elsewhere' ? true : null,
      );
      const elsewhereRows = await readList(alice);

      step(`Bob comes to the board at ${width}`);
      await navigate(bob, `${base}/workspaces/${ws}`);
      await until('Bob on the board, in the room', async () =>
        board.spotOf(bobId)?.surface === 'board' ? true : null,
      );
      const [, hereMs] = await timed('Bob here in Alice’s strip', async () =>
        (await alice.evaluate(placeOf(bobKey))) === 'here' ? true : null,
      );
      const hereRows = await readList(alice);
      // Bob here and the lead elsewhere: the same deck the doc draws below.
      const deckOnBoard = (await alice.evaluate(DECK_BOX)) as Box;
      const leadOnBoard = (await alice.evaluate(LEAD_FACE)) as Face;

      step(`Alice follows Bob from his card at ${width}`);
      const card = await openCard(alice, bobKey);
      await tapOn(alice, '.board-presence-card [data-act="follow"]');
      await until('the follow ring on Bob', async () =>
        (await alice.evaluate(ringOn(bobKey))) ? true : null,
      );
      const barOnBoard = await until(
        'the Following bar',
        async () => (await alice.evaluate(READ_BAR)) as Bar | null,
      );
      // Bob opens the doc; following, Alice's browser goes there too.
      const arrived = alice.once('Page.loadEventFired');
      await navigate(bob, `${base}${docPath}`);
      await until('Bob on the doc again, in the room', async () =>
        board.spotOf(bobId)?.docId === docId ? true : null,
      );
      const [followedAddress, followMs] = await timed('Alice taken to the doc', async () => {
        const at = (await alice.evaluate(ADDRESS).catch(() => null)) as string | null;
        return at === docPath ? at : null;
      });
      await arrived;
      await until('Alice’s doc strip shows Bob', async () =>
        (await alice.evaluate(placeOf(bobKey))) === 'here' ? true : null,
      );
      const ringOnBob = (await alice.evaluate(ringOn(bobKey))) === true;
      const barOnDoc = await until(
        'the Following bar on the doc',
        async () => (await alice.evaluate(READ_BAR)) as Bar | null,
      );
      const deckOnDoc = (await alice.evaluate(DECK_BOX)) as Box;
      const leadOnDoc = (await alice.evaluate(LEAD_FACE)) as Face;
      const docRows = await readList(alice);

      step(`Alice taps Stop on the bar at ${width}`);
      await tapOn(alice, '.board-follow-bar button');
      await until('the follow ring gone', async () =>
        (await alice.evaluate(ringOn(bobKey))) ? null : true,
      );
      const stoppedNotice = await until(
        'the doc page says the follow stopped',
        async () => (await alice.evaluate(TOAST)) as string | null,
      );
      const barAfterStop = (await alice.evaluate(READ_BAR)) !== null;
      const stored = (await alice.evaluate(`sessionStorage.getItem('cw-follow:${ws}')`)) as
        | string
        | null;
      // Bob moves again: a page still following would leave the doc.
      // Counted only until Go there below, which is meant to load a page.
      let watching = true;
      let leftPage = false;
      alice.on('Page.frameStartedLoading', () => {
        if (watching) leftPage = true;
      });
      await navigate(bob, `${base}/workspaces/${ws}`);
      await until('Bob on the board, in the room', async () =>
        board.spotOf(bobId)?.surface === 'board' ? true : null,
      );
      // Alice's page has heard Bob leave (her strip says he is elsewhere),
      // so a follow still held would already have moved her.
      await until('Alice’s strip hears Bob leave', async () =>
        (await alice.evaluate(placeOf(bobKey))) === 'elsewhere' ? true : null,
      );
      const stoppedAddress = (await alice.evaluate(ADDRESS)) as string;
      const stoppedRing = (await alice.evaluate(ringOn(bobKey))) === true;
      watching = false;
      const leftWhileStopped = leftPage;

      step(`Alice goes to Bob from his card at ${width}`);
      const goCard = await openCard(alice, bobKey);
      const boardPath = `/workspaces/${ws}`;
      await tapOn(alice, '.board-presence-card [data-act="go"]');
      const wentAddress = await until('Alice taken to the board', async () => {
        const at = (await alice.evaluate(ADDRESS).catch(() => null)) as string | null;
        return at?.startsWith(boardPath) && !at.includes('/docs/') ? at : null;
      });

      rounds.push({
        width,
        elsewhere: { place: 'elsewhere', rows: elsewhereRows, ms: elsewhereMs },
        here: { place: 'here', rows: hereRows, ms: hereMs },
        card,
        barOnBoard,
        followed: {
          address: followedAddress,
          ringOnBob,
          ms: followMs,
          bar: barOnDoc,
          rows: docRows,
        },
        stopped: {
          ringOnBob: stoppedRing,
          stored,
          address: stoppedAddress,
          leftPage: leftWhileStopped,
          notice: stoppedNotice,
          bar: barAfterStop,
        },
        went: { card: goCard, address: wentAddress },
        deckOnBoard,
        deckOnDoc,
        leadOnBoard,
        leadOnDoc,
      });
      await closePerson(alice);
      await closePerson(bob);
    }
  } finally {
    board.lead.close();
    await shutdown();
  }
  const run: TwoLevelRun = { rounds };
  process.stdout.write(`${JSON.stringify(run)}\n`);
  process.exit(0);
}

await main();
