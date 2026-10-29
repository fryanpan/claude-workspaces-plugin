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

  it('says a link makes Owners, and says nothing of entries when there are none', () => {
    expect(accessChangeLine(LINK)).toBe(
      'Lets everyone at @harborlight.example sign in, and mints a share link "Launch review" that makes everyone who opens it an Owner.',
    );
    expect(
      accessChangeLine({ op: 'share-link', workspaceId: 'w-riverbend', entries: [], link: {} }),
    ).toBe('Mints a share link.');
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
