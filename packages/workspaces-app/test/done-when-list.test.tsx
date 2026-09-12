/**
 * The "Done when" list on the task panel, driven the way a reader drives it.
 *
 * The property under test is the one Bryan put on the mock: the WORDS are the
 * control. There is no pencil, so every case here acts on the words or on the
 * × beside them and asserts the whole list the component would send — a write
 * is the whole sequence, so a test that only checked one line would pass while
 * the rest of the list was being dropped.
 *
 * The chips are the other half: one chip per line, and its words are what a
 * reader reads to know where the line stands.
 *
 * Fixtures are invented; the repo is public.
 */
import { options, render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardDoneWhenLine, BoardTask } from '../src/board/board-model.ts';
import { DoneWhenList } from '../src/board/done-when-list.tsx';

// A keystroke here is asserted on the very next line, so renders flush inline.
options.debounceRendering = (cb: () => void) => cb();

const NOW = 1_760_000_000_000;

let host: HTMLElement | undefined;

afterEach(() => {
  if (host) render(null, host);
  host?.remove();
  host = undefined;
  document.body.innerHTML = '';
});

function task(doneWhen: BoardDoneWhenLine[]): BoardTask {
  return {
    id: 't-harbour',
    title: 'Collaborator can read the list',
    status: 'in-progress',
    assignee: 'Lamplighter',
    goal: 'g-lights',
    order: 1,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: 'task:t-harbour',
    createdAt: NOW,
    updatedAt: NOW,
    doneWhen,
  } as BoardTask;
}

type LinesMock = ReturnType<typeof makeLinesMock>;
const makeLinesMock = () =>
  vi.fn(async (_task: BoardTask, _lines: Array<{ id?: string; text: string }>) => true);
const makeCheckMock = () =>
  vi.fn(async (_task: BoardTask, _lineId: string, _verdict: 'met' | 'not-met') => true);

function mount(
  lines: BoardDoneWhenLine[],
  over: { onCheck?: ReturnType<typeof makeCheckMock> } = {},
) {
  const onLines = makeLinesMock();
  host = document.createElement('div');
  document.body.appendChild(host);
  render(
    <DoneWhenList
      task={task(lines)}
      handlers={{ onLines, ...(over.onCheck ? { onCheck: over.onCheck } : {}) }}
    />,
    host,
  );
  return { onLines };
}

const all = <T extends Element>(sel: string): T[] => [...(host?.querySelectorAll<T>(sel) ?? [])];
const $ = <T extends Element>(sel: string): T => {
  const el = host?.querySelector<T>(sel);
  if (!el) throw new Error(`no ${sel} in the list`);
  return el;
};

/** The words a write would send, in order. */
const sent = (onLines: LinesMock, call = 0): Array<{ id?: string; text: string }> =>
  onLines.mock.calls[call]?.[1] as Array<{ id?: string; text: string }>;

const LINES: BoardDoneWhenLine[] = [
  { id: 'd-0', text: 'the share link opens the list' },
  { id: 'd-1', text: 'the panel reads at 430px' },
];

describe('the words are the control', () => {
  it('draws the list in order, with no chip before the builder reports', () => {
    mount(LINES);
    expect(all('.dw-line')).toHaveLength(2);
    expect(all('.dw-text').map((e) => e.textContent)).toEqual([
      'the share link opens the list',
      'the panel reads at 430px',
    ]);
    expect(all('.dw-verdict-tag')).toHaveLength(0);
  });

  it('commits the words on Enter and opens a blank line after the one edited', () => {
    const { onLines } = mount(LINES);
    const words = $<HTMLElement>('.dw-text');
    words.dispatchEvent(new Event('click', { bubbles: true }));
    words.textContent = 'the share link opens the list for a signed-out reader';
    words.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    // The edit is filed. The blank line is not — it holds no words yet, and
    // the server refuses a criterion nobody could answer.
    expect(onLines).toHaveBeenCalledTimes(1);
    expect(sent(onLines)).toEqual([
      { id: 'd-0', text: 'the share link opens the list for a signed-out reader' },
      { id: 'd-1', text: 'the panel reads at 430px' },
    ]);
    // The blank one sits between the two, where the next criterion goes. The
    // edited line reads as the fixture still holds it: the words are the
    // server's to change, and this harness's task never moves.
    expect(all('.dw-text').map((e) => e.textContent)).toEqual([
      'the share link opens the list',
      '',
      'the panel reads at 430px',
    ]);
  });

  it('files the blank line only once it has words, in the place it was opened', () => {
    const { onLines } = mount(LINES);
    $<HTMLButtonElement>('.dw-add').click();
    expect(onLines).not.toHaveBeenCalled();

    const blank = all<HTMLElement>('.dw-text')[2];
    if (!blank) throw new Error('no blank line to type into');
    blank.dispatchEvent(new Event('click', { bubbles: true }));
    blank.textContent = 'the count on the board matches the panel';
    blank.dispatchEvent(new Event('blur', { bubbles: true }));

    expect(onLines).toHaveBeenCalledTimes(1);
    expect(sent(onLines)).toEqual([
      { id: 'd-0', text: 'the share link opens the list' },
      { id: 'd-1', text: 'the panel reads at 430px' },
      { text: 'the count on the board matches the panel' },
    ]);
  });

  it('forgets a blank line left empty, and writes nothing at all', () => {
    const { onLines } = mount(LINES);
    $<HTMLButtonElement>('.dw-add').click();
    expect(all('.dw-line')).toHaveLength(3);

    const blank = all<HTMLElement>('.dw-text')[2];
    blank?.dispatchEvent(new Event('blur', { bubbles: true }));

    expect(all('.dw-line')).toHaveLength(2);
    expect(onLines).not.toHaveBeenCalled();
  });

  it('puts the old words back on Escape and writes nothing', () => {
    const { onLines } = mount(LINES);
    const words = $<HTMLElement>('.dw-text');
    words.dispatchEvent(new Event('click', { bubbles: true }));
    words.textContent = 'half-typed words nobody meant';
    words.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(words.textContent).toBe('the share link opens the list');
    expect(onLines).not.toHaveBeenCalled();
  });

  it('removes a line with the × and sends the rest of the sequence', () => {
    const { onLines } = mount(LINES);
    const xs = all<HTMLButtonElement>('.dw-line-x');
    expect(xs).toHaveLength(2);
    xs[0]?.click();

    expect(sent(onLines)).toEqual([{ id: 'd-1', text: 'the panel reads at 430px' }]);
  });

  it('opens a blank line at the foot from "Add done criteria", with no write', () => {
    const { onLines } = mount(LINES);
    const add = $<HTMLButtonElement>('.dw-add');
    expect(add.textContent).toBe('Add done criteria');
    add.click();

    expect(all('.dw-line')).toHaveLength(3);
    expect(all('.dw-text').map((e) => e.textContent)).toEqual([
      'the share link opens the list',
      'the panel reads at 430px',
      '',
    ]);
    expect(onLines).not.toHaveBeenCalled();
  });

  it('drops a line whose words are emptied, because a criterion with no words cannot be checked', () => {
    const { onLines } = mount(LINES);
    const words = $<HTMLElement>('.dw-text');
    words.dispatchEvent(new Event('click', { bubbles: true }));
    words.textContent = '   ';
    words.dispatchEvent(new Event('blur', { bubbles: true }));

    expect(sent(onLines)).toEqual([{ id: 'd-1', text: 'the panel reads at 430px' }]);
  });

  it('does not write when a line is opened and left alone', () => {
    const { onLines } = mount(LINES);
    const words = $<HTMLElement>('.dw-text');
    words.dispatchEvent(new Event('click', { bubbles: true }));
    words.dispatchEvent(new Event('blur', { bubbles: true }));

    expect(onLines).not.toHaveBeenCalled();
  });
});

describe('one chip per line, and what it says', () => {
  it("names each verdict in the reader's words", () => {
    mount([
      { id: 'd-0', text: 'proved', verdict: 'met' },
      { id: 'd-1', text: 'broken', verdict: 'not-met' },
      { id: 'd-2', text: 'could not check', verdict: 'unchecked' },
      { id: 'd-3', text: 'only you can say', verdict: 'owner' },
    ]);

    expect(all('.dw-verdict-tag').map((e) => e.textContent)).toEqual([
      'Verified',
      'Not verified',
      'Unverified',
      'Your check',
    ]);
    expect($('.dw-verdict-met').textContent).toBe('Verified');
    expect($('.dw-verdict-not').textContent).toBe('Not verified');
    expect($('.dw-verdict-yours').textContent).toBe('Your check');
  });

  it("folds the builder's proof under the line that carries it", () => {
    mount([
      {
        id: 'd-0',
        text: 'proved',
        verdict: 'met',
        proof: [
          { text: 'ran the suite', url: 'https://example.test/run' },
          { text: 'read the log' },
        ],
      },
      { id: 'd-1', text: 'nothing attached' },
    ]);

    expect(all('.dw-proof')).toHaveLength(1);
    expect($('.dw-proof-head').textContent).toBe("Builder's proof");
    const rows = all<HTMLElement>('.dw-proof-row');
    expect(rows.map((r) => r.querySelector('.dw-proof-what')?.textContent)).toEqual([
      'ran the suite',
      'read the log',
    ]);
    // A proof with a url is the link; one without is the same row with no
    // affordance, because naming what was run still says more than nothing.
    expect(rows[0]?.tagName).toBe('A');
    expect(rows[0]?.getAttribute('href')).toBe('https://example.test/run');
    expect(rows[1]?.tagName).toBe('DIV');
  });
});

describe('a proof url that is not http(s)', () => {
  it('keeps the words and drops the link, so nothing unsafe becomes an href', () => {
    mount([
      {
        id: 'd-0',
        text: 'proved',
        verdict: 'met',
        proof: [{ text: 'what I ran', url: 'javascript:alert(1)' }],
      },
    ]);

    const row = $<HTMLElement>('.dw-proof-row');
    expect(row.tagName).toBe('DIV');
    expect(row.querySelector('.dw-proof-what')?.textContent).toBe('what I ran');
    expect(host?.querySelector('a.dw-proof-row')).toBeNull();
  });
});

describe("the owner's two buttons", () => {
  it('appear only on a line the builder left to them, and send the verdict', () => {
    const onCheck = makeCheckMock();
    mount(
      [
        { id: 'd-0', text: 'proved', verdict: 'met' },
        { id: 'd-1', text: 'only you can say', verdict: 'owner' },
      ],
      { onCheck },
    );

    const buttons = all<HTMLButtonElement>('.dw-actions .board-btn').filter(
      (b) => b.textContent === 'Looks right' || b.textContent === 'Not met',
    );
    expect(buttons.map((b) => b.textContent)).toEqual(['Looks right', 'Not met']);

    buttons[0]?.click();
    expect(onCheck.mock.calls[0]?.[1]).toBe('d-1');
    expect(onCheck.mock.calls[0]?.[2]).toBe('met');

    buttons[1]?.click();
    expect(onCheck.mock.calls[1]?.[2]).toBe('not-met');
  });

  it('are absent when no line is theirs', () => {
    const onCheck = makeCheckMock();
    mount([{ id: 'd-0', text: 'proved', verdict: 'met' }], { onCheck });
    expect(
      all<HTMLButtonElement>('.board-btn').filter((b) => b.textContent === 'Looks right'),
    ).toHaveLength(0);
  });
});
