/**
 * The owner's access page (`/access`): the proposals waiting for him first,
 * then each board's list. What is pinned here is what Approve sends — the
 * exact change the card showed, to the card's own door — that a change made
 * elsewhere reaches the open page, and which sections each band shows.
 *
 * All fixtures are synthetic.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type AccessData,
  type AccessProposal,
  changeSentence,
  mountAccessPage,
  parseAccessRoute,
} from '../src/settings/access-page.ts';

const BOARD = { workspaceId: 'w-riverbend', name: 'Riverbend launch' };
const OTHER = { workspaceId: 'w-saltmarsh', name: 'Saltmarsh audit' };

const PROPOSAL: AccessProposal = {
  workspaceId: BOARD.workspaceId,
  taskId: 't-1',
  taskTitle: 'Bring the Harborlight designers in',
  reviewItemId: 'r-1',
  change: {
    op: 'add-audience',
    workspaceId: BOARD.workspaceId,
    entries: ['@harborlight.example'],
  } as AccessProposal['change'],
  line: 'Lets everyone at @harborlight.example sign in to this board.',
  why: 'Their design team asked for access on the launch thread.',
  proposedBy: 'Team Lead',
  proposedAt: Date.now() - 14 * 60_000,
};

const DATA: AccessData = {
  boards: [
    {
      ...BOARD,
      audience: [{ match: 'alice@harborlight.example', addedAt: 1 }],
      people: [
        {
          email: 'alice@harborlight.example',
          role: 'member',
          addedAt: 1,
          entry: 'alice@harborlight.example',
        },
      ],
    },
    { ...OTHER, audience: [{ match: '@saltmarsh.example', addedAt: 1 }], people: [] },
  ],
  proposals: [PROPOSAL],
};

function mount(
  opts: { pathname?: string; narrow?: boolean; reads?: Array<AccessData | null> } = {},
) {
  document.body.innerHTML = '<div id="settings-root"></div>';
  const root = document.getElementById('settings-root') as HTMLElement;
  const reads = opts.reads ?? [DATA];
  let n = 0;
  const send = vi.fn(async () => ({ ok: true, status: 200, data: {} }));
  const page = mountAccessPage(root, {
    document,
    location: { pathname: opts.pathname ?? '/access', search: '?ws=w-riverbend' },
    history: { pushState: vi.fn() },
    narrow: () => opts.narrow === true,
    api: {
      read: async () => reads[Math.min(n++, reads.length - 1)] ?? null,
      readBoard: async () => null,
      send,
    },
  });
  return { page, send };
}

const shown = (sel: string) => {
  const e = document.querySelector(sel);
  return e !== null && !e.classList.contains('hidden');
};

describe('the access page', () => {
  it('shows what is waiting first, then each board, and counts the waiting in the nav', async () => {
    const { page } = mount();
    await page.render();
    const headline = document.querySelector('#acc-proposals .board-decide-headline');
    expect(headline?.textContent).toBe(PROPOSAL.line);
    expect(document.querySelector('#acc-proposals .board-decide-kicker')?.textContent).toBe(
      'Access change · Riverbend launch',
    );
    expect(
      [...document.querySelectorAll('#acc-boards .acc-board h2')].map((h) => h.textContent),
    ).toEqual(['Riverbend launch', 'Saltmarsh audit']);
    const waiting = [...document.querySelectorAll('#acc-subnav a')].find((a) =>
      a.textContent?.startsWith('Waiting for you'),
    );
    expect(waiting?.querySelector('.acc-count')?.textContent).toBe('1');
    expect(document.querySelector('#acc-boards .board-member-who')?.textContent).toBe('You');
  });

  it('approves at the card’s own door, echoing exactly the change it showed', async () => {
    const answered: AccessData = {
      ...DATA,
      proposals: [
        { ...PROPOSAL, answer: { text: 'Approved.', by: 'Bryan', ts: Date.now(), approved: true } },
      ],
    };
    const { page, send } = mount({ reads: [DATA, answered] });
    await page.render();
    (document.querySelector('[data-answer="approve"]') as HTMLButtonElement).click();
    await page.settled();
    expect(send).toHaveBeenCalledWith(
      '/workspaces/w-riverbend/tasks/t-1/review-items/r-1/access',
      'POST',
      { decision: 'approve', access: PROPOSAL.change },
    );
    expect(document.querySelectorAll('#acc-proposals .board-decide')).toHaveLength(0);
    expect(document.querySelector('#acc-answered .acc-done strong')?.textContent).toBe('Approved');
  });

  it('draws a proposal filed elsewhere when the page is told something changed', async () => {
    const quiet: AccessData = { ...DATA, proposals: [] };
    const { page } = mount({ reads: [quiet, DATA] });
    await page.render();
    expect(document.querySelector('#acc-proposals .acc-empty')?.textContent).toBe(
      'Nothing is waiting for you.',
    );
    await page.changed();
    expect(document.querySelector('#acc-proposals .board-decide-headline')?.textContent).toBe(
      PROPOSAL.line,
    );
  });

  it('shows one board on the wide band, and every section on the narrow one', async () => {
    const wide = mount({ pathname: '/access/w-saltmarsh' });
    await wide.page.render();
    expect(shown('#acc-waiting')).toBe(false);
    expect(shown('[data-sec="w-riverbend"]')).toBe(false);
    expect(shown('[data-sec="w-saltmarsh"]')).toBe(true);
    const narrow = mount({ pathname: '/access/w-saltmarsh', narrow: true });
    await narrow.page.render();
    expect(shown('#acc-waiting')).toBe(true);
    expect(shown('[data-sec="w-riverbend"]')).toBe(true);
  });

  it('says whose page it is when the read is refused', async () => {
    const { page } = mount({ reads: [null] });
    await page.render();
    expect(document.getElementById('settings-main')?.textContent).toContain(
      'Only the owner, signed in',
    );
  });
});

describe('the pieces it reads', () => {
  it('reads the section and the board it came from off the address', () => {
    expect(parseAccessRoute('/access/waiting', '?ws=w-riverbend')).toEqual({
      section: 'waiting',
      workspaceId: 'w-riverbend',
    });
    expect(parseAccessRoute('/access', '').section).toBe('all');
  });

  it('says what a domain approval does in words the owner can check', () => {
    expect(changeSentence(PROPOSAL)).toBe(
      'Adds @harborlight.example. Each person there signs in with their own address, and their comments and answers count like yours.',
    );
  });
});
