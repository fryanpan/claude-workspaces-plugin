import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  getProseFragment,
  parseMarkdownBlocks,
  serializeFragmentToMarkdown,
} from '../../core/src/prose.ts';
import { mountSpeakerReassign } from '../src/speaker-reassign-menu.ts';

const VOICES = [
  { label: 'A', name: 'Speaker A', lastSaid: 'Move the gate.' },
  { label: 'B', name: 'Devi', lastSaid: 'Not before Friday.' },
];

let teardown: Array<() => void> = [];

afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  teardown = [];
  document.body.innerHTML = '';
});

function mount(
  markdown: string,
  voices = VOICES,
  over: {
    canWrite?: () => boolean;
    renameSpeaker?: (label: string, name: string) => Promise<boolean>;
    promptName?: (current: string) => string | null;
  } = {},
) {
  const ydoc = new Y.Doc();
  getProseFragment(ydoc).push(parseMarkdownBlocks(markdown));
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new Editor({
    element: host,
    extensions: [
      StarterKit.configure({
        undoRedo: false,
        link: { openOnClick: false, autolink: true, protocols: ['speaker'] },
      }),
      Collaboration.configure({ document: ydoc, field: 'prose' }),
    ],
  });
  const loadVoices = vi.fn(() => Promise.resolve(voices));
  const handle = mountSpeakerReassign({ editor, loadVoices, ...over });
  teardown.push(() => {
    handle.destroy();
    editor.destroy();
    host.remove();
  });
  return { editor, ydoc, loadVoices };
}

const menu = (): HTMLElement | null => document.querySelector('.speaker-menu');
const rows = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('.speaker-menu-voice'),
];
const tagEl = (editor: Editor): HTMLAnchorElement =>
  editor.view.dom.querySelector('a[href^="speaker:"]') as HTMLAnchorElement;
const markdownOf = (ydoc: Y.Doc): string => serializeFragmentToMarkdown(getProseFragment(ydoc));

/** A click the way a person makes one, through the editor's own DOM. */
async function clickTag(editor: Editor): Promise<void> {
  tagEl(editor).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(menu()).not.toBeNull());
}

describe('the reassign menu', () => {
  it('opens on a speaker tag and offers every voice with what it last said', async () => {
    const { editor } = mount('- [@Devi](speaker:B) wants the gate moved.\n');
    await clickTag(editor);
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining('Speaker A'),
      expect.stringContaining('Devi'),
    ]);
    expect(rows()[0]?.textContent).toContain('Move the gate.');
  });

  it('marks the voice the tag already claims, so the menu says where you are', async () => {
    const { editor } = mount('- [@Devi](speaker:B) wants the gate moved.\n');
    await clickTag(editor);
    expect(rows()[1]?.getAttribute('aria-checked')).toBe('true');
    expect(rows()[0]?.getAttribute('aria-checked')).toBe('false');
  });

  it('reassigns the one mention that was clicked', async () => {
    const { editor, ydoc } = mount(
      '- [@Devi](speaker:B) wants the gate moved.\n- [@Devi](speaker:B) will file it.\n',
    );
    await clickTag(editor);
    rows()[0]?.click();
    const md = markdownOf(ydoc);
    expect(md).toContain('- [@Speaker A](speaker:A) wants the gate moved.');
    expect(md).toContain('- [@Devi](speaker:B) will file it.');
    expect(menu()).toBeNull();
  });

  it('offers "nobody" and takes the claim off without taking the words', async () => {
    const { editor, ydoc } = mount('- [@Devi](speaker:B) wants the gate moved.\n');
    await clickTag(editor);
    const nobody = document.querySelector<HTMLButtonElement>('.speaker-menu-nobody');
    expect(nobody?.textContent).toContain('Nobody');
    nobody?.click();
    expect(markdownOf(ydoc)).toContain('Devi wants the gate moved.');
    expect(markdownOf(ydoc)).not.toContain('speaker:B');
  });

  it('does not open on an ordinary link', async () => {
    const { editor, loadVoices } = mount('- Filed as [the ticket](/w/w-1/t/t-1).\n');
    editor.view.dom
      .querySelector('a')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(menu()).toBeNull();
    // Not merely closed — never asked, so an ordinary link costs no request.
    expect(loadVoices).not.toHaveBeenCalled();
  });

  it('closes on Escape without changing anything', async () => {
    const { editor, ydoc } = mount('- [@Devi](speaker:B) asked.\n');
    const before = markdownOf(ydoc);
    await clickTag(editor);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu()).toBeNull();
    expect(markdownOf(ydoc)).toBe(before);
  });

  it('says so when the capture had no voices, and still offers nobody', async () => {
    // A solo capture labels nothing, so there is no one to reassign TO —
    // but "this is not a quote" is still a correction worth having.
    const { editor } = mount('- [@Devi](speaker:B) asked.\n', []);
    await clickTag(editor);
    expect(menu()?.textContent).toContain('No other voices');
    expect(document.querySelector('.speaker-menu-nobody')).not.toBeNull();
  });

  it('stays shut for a reader with no write access', async () => {
    // A transaction dispatched from the menu consults nothing on its own, so
    // without this a signed-out reader could retag somebody else's notes by
    // tapping a name. Raised by review before merge, not in the field.
    const { editor, ydoc, loadVoices } = mount('- [@Devi](speaker:B) asked.\n', VOICES, {
      canWrite: () => false,
    });
    const before = markdownOf(ydoc);
    tagEl(editor).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(menu()).toBeNull();
    expect(loadVoices).not.toHaveBeenCalled();
    expect(markdownOf(ydoc)).toBe(before);
  });

  it('opens in VIEW mode, because view mode is not a permission', async () => {
    // The default on a phone, one tap from editing, and the moment someone
    // is most likely to be reading notes and spot a wrong name. Gating this
    // on `isEditable` would have made the gesture unreachable exactly there.
    const { editor, ydoc } = mount('- [@Devi](speaker:B) asked.\n');
    editor.setEditable(false);
    await clickTag(editor);
    expect(rows().length).toBe(2);
    rows()[0]?.click();
    expect(markdownOf(ydoc)).toContain('[@Speaker A](speaker:A)');
  });

  it('says so when the voices cannot be loaded, rather than offering an empty menu', async () => {
    const ydoc = new Y.Doc();
    getProseFragment(ydoc).push(parseMarkdownBlocks('- [@Devi](speaker:B) asked.\n'));
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [
        StarterKit.configure({
          undoRedo: false,
          link: { openOnClick: false, autolink: true, protocols: ['speaker'] },
        }),
        Collaboration.configure({ document: ydoc, field: 'prose' }),
      ],
    });
    const handle = mountSpeakerReassign({
      editor,
      loadVoices: () => Promise.reject(new Error('offline')),
    });
    teardown.push(() => {
      handle.destroy();
      editor.destroy();
      host.remove();
    });
    await clickTag(editor);
    expect(menu()?.textContent).toContain("Couldn't load");
  });
});

/**
 * Naming the VOICE from the notes (speaker-rename ticket, AC2/AC3).
 *
 * The rows above this one answer "who said this"; Rename answers "what is
 * this person called", for every mention of that label. It is the surface
 * that matters after the capture has stopped, when the live transcript zone
 * and the strip's own row are both gone and a tag in the notes is the only
 * pill left on the page.
 */
describe('renaming the voice from the notes', () => {
  const rename = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>('.speaker-menu-rename');

  it('offers Rename for the voice the tag claims, and hands the answer to the channel', async () => {
    const asked: string[] = [];
    const renameSpeaker = vi.fn(() => Promise.resolve(true));
    const { editor } = mount('- [@Devi](speaker:B) wants the gate moved.\n', VOICES, {
      renameSpeaker,
      promptName: (current) => {
        asked.push(current);
        return '  Devi Raman  ';
      },
    });
    await clickTag(editor);
    // Named for the voice, from the ROSTER — not from whatever spelling the
    // composer happened to write into this one tag.
    expect(rename()?.textContent).toBe('Rename Devi');
    rename()?.click();
    expect(asked).toEqual(['Devi']);
    await vi.waitFor(() => expect(menu()).toBeNull());
    expect(renameSpeaker).toHaveBeenCalledWith('B', 'Devi Raman');
  });

  it('rewrites nothing in the document itself — the rename is the meeting’s', async () => {
    const { editor, ydoc } = mount('- [@Devi](speaker:B) wants the gate moved.\n', VOICES, {
      renameSpeaker: () => Promise.resolve(true),
      promptName: () => 'Devi Raman',
    });
    const before = markdownOf(ydoc);
    await clickTag(editor);
    rename()?.click();
    await vi.waitFor(() => expect(menu()).toBeNull());
    // The server rewrites every mention of the label through the notes sink;
    // a second rewrite from here would fight it.
    expect(markdownOf(ydoc)).toBe(before);
  });

  it('a name the server refused says so, and the menu stays open to try again', async () => {
    const { editor } = mount('- [@Devi](speaker:B) wants the gate moved.\n', VOICES, {
      renameSpeaker: () => Promise.resolve(false),
      promptName: () => 'Devi Raman',
    });
    await clickTag(editor);
    rename()?.click();
    await vi.waitFor(() =>
      expect(document.querySelector('.speaker-menu-empty')?.textContent).toContain("wasn't saved"),
    );
    expect(menu()).not.toBeNull();
    expect(rename()?.disabled).toBe(false);
  });

  it('a cancelled or unchanged answer asks for nothing', async () => {
    const renameSpeaker = vi.fn(() => Promise.resolve(true));
    let answer: string | null = null;
    const { editor } = mount('- [@Devi](speaker:B) wants the gate moved.\n', VOICES, {
      renameSpeaker,
      promptName: () => answer,
    });
    await clickTag(editor);
    expect(rename(), 'no Rename row to cancel').not.toBeNull();
    rename()?.click();
    answer = 'Devi';
    rename()?.click();
    expect(renameSpeaker).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it('a doc with no meeting behind it offers no Rename at all', async () => {
    const { editor } = mount('- [@Devi](speaker:B) wants the gate moved.\n');
    await clickTag(editor);
    expect(rename()).toBeNull();
    // Positive control: the menu did render, it just has nowhere to keep a name.
    expect(document.querySelector('.speaker-menu-nobody')).not.toBeNull();
  });
});
