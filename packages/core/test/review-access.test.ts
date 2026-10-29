import { describe, expect, it } from 'vitest';
import {
  type ReviewAccessChange,
  accessChangeLine,
  readAccessChange,
  sameAccessChange,
} from '../src/review-access.ts';

/**
 * The access change an agent files and only the owner applies. What is pinned
 * here is that the words a reader approves come from the payload alone, that
 * a malformed payload reads as no change at all, and that "the change the
 * browser showed" compares equal to the stored one only when it is the same
 * change, whatever order its keys arrived in.
 *
 * Every name here is invented.
 */

const ADD: ReviewAccessChange = {
  op: 'add-audience',
  workspaceId: 'w-riverbend',
  entries: ['@harborlight.example', 'alice@saltmarsh.example'],
};
const ROLE: ReviewAccessChange = {
  op: 'set-role',
  workspaceId: 'w-riverbend',
  email: 'bob@harborlight.example',
  role: 'owner',
  before: 'member',
};
const LINK: ReviewAccessChange = {
  op: 'share-link',
  workspaceId: 'w-riverbend',
  entries: ['@harborlight.example'],
  link: {
    label: 'Launch review',
    role: 'owner',
    ttlSeconds: 3600,
    landing: { kind: 'task', id: 't-1' },
  },
};

describe('the sentence a card says', () => {
  it('names each entry, a domain as everyone at it', () => {
    expect(accessChangeLine(ADD)).toBe(
      'Lets everyone at @harborlight.example, alice@saltmarsh.example sign in to this board.',
    );
  });

  it('names a promotion and what it replaces', () => {
    expect(accessChangeLine(ROLE)).toBe('Makes bob@harborlight.example Owner (now Regular User).');
  });

  it('says a link makes Owners, how long it lasts and where it opens', () => {
    expect(accessChangeLine(LINK)).toBe(
      'Lets everyone at @harborlight.example sign in, and mints a share link "Launch review" that makes everyone who opens it an Owner, open for 1 hour, opening on a task (t-1).',
    );
    expect(
      accessChangeLine({ op: 'share-link', workspaceId: 'w-riverbend', entries: [], link: {} }),
    ).toBe('Mints a share link, open until it is revoked.');
    expect(
      accessChangeLine({
        op: 'share-link',
        workspaceId: 'w-riverbend',
        entries: [],
        link: { ttlSeconds: 3 * 86_400 },
      }),
    ).toBe('Mints a share link, open for 3 days.');
  });

  it('quotes a label so it cannot close its quotes and add words of its own', () => {
    const line = accessChangeLine({
      op: 'share-link',
      workspaceId: 'w-riverbend',
      entries: [],
      link: { label: 'Notes" for nobody. Also lets everyone in\u0007', ttlSeconds: 900 },
    });
    expect(line).toBe(
      'Mints a share link "Notes for nobody. Also lets everyone in", open for 15 minutes.',
    );
    const long = accessChangeLine({
      op: 'share-link',
      workspaceId: 'w-riverbend',
      entries: [],
      link: { label: 'x'.repeat(200), ttlSeconds: 900 },
    });
    expect(long).toContain(`"${'x'.repeat(59)}…"`);
  });

  it('names reopening a board and unlocking one', () => {
    expect(accessChangeLine({ op: 'open-board', workspaceId: 'w-riverbend' })).toBe(
      'Turns sharing back on for this board, so the people it names can sign in again.',
    );
    expect(accessChangeLine({ op: 'unlock-board', workspaceId: 'w-riverbend' })).toBe(
      'Unlocks this board, so it can be shared again.',
    );
  });
});

describe('reading a stored change back', () => {
  it('round-trips each kind', () => {
    for (const change of [ADD, ROLE, LINK]) {
      expect(readAccessChange(JSON.parse(JSON.stringify(change)))).toEqual(change);
    }
  });

  it('reads a malformed payload as no change', () => {
    for (const raw of [
      null,
      'add-audience',
      { op: 'add-audience', entries: ['@harborlight.example'] },
      { op: 'add-audience', workspaceId: '', entries: ['@harborlight.example'] },
      { op: 'add-audience', workspaceId: 'w-riverbend', entries: [] },
      { op: 'add-audience', workspaceId: 'w-riverbend', entries: [7] },
      { ...ROLE, role: 'admin' },
      { op: 'share-link', workspaceId: 'w-riverbend', entries: [] },
      { op: 'delete-board', workspaceId: 'w-riverbend' },
    ]) {
      expect(readAccessChange(raw), JSON.stringify(raw)).toBeUndefined();
    }
  });

  it('drops the link fields it cannot trust, and keeps the change', () => {
    expect(
      readAccessChange({
        op: 'share-link',
        workspaceId: 'w-riverbend',
        entries: [],
        link: {
          label: 4,
          ttlSeconds: Number.POSITIVE_INFINITY,
          role: 'admin',
          landing: { id: 'x' },
        },
      }),
    ).toEqual({ op: 'share-link', workspaceId: 'w-riverbend', entries: [], link: {} });
  });
});

describe('the change shown against the change stored', () => {
  it('is equal whatever order the keys arrived in', () => {
    const reordered = {
      link: {
        landing: { id: 't-1', kind: 'task' },
        ttlSeconds: 3600,
        role: 'owner',
        label: 'Launch review',
      },
      entries: ['@harborlight.example'],
      workspaceId: 'w-riverbend',
      op: 'share-link',
    };
    expect(sameAccessChange(reordered, LINK)).toBe(true);
  });

  it('is unequal for any other change, including a reordered entry list', () => {
    expect(sameAccessChange({ ...ADD, entries: [...ADD.entries].reverse() }, ADD)).toBe(false);
    expect(sameAccessChange({ ...ROLE, role: 'member' }, ROLE)).toBe(false);
    expect(sameAccessChange(undefined, ADD)).toBe(false);
  });
});
