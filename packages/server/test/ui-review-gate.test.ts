/**
 * The UI gate (`ui-review-gate.ts`): which rows in flight an agent filed have
 * a builder who has touched a screen, with nobody's answer on them.
 *
 * The suite is built around the defect that rewrote the module. The gate used
 * to answer "is this UI work" from a word list run over the ticket's prose,
 * and the `prose says UI, the diff does not` block below is the shape of all
 * six recorded false positives: a skill name carrying the word "layout", a
 * sentence naming the board control the filer had used, a research note about
 * respondent panels. Each one asserts the OLD behaviour is gone — the row is
 * silent — and the block after it asserts the gate has not simply been turned
 * off.
 *
 * Fixtures are invented; the prose shapes are the recorded ones.
 */
import { describe, expect, it } from 'bun:test';
import {
  type UiGateTask,
  collectUngatedUiRows,
  isUiFile,
  uiFileIn,
  uiKeywordIn,
  ungatedUiRows,
} from '../src/ui-review-gate.ts';

/** A builder that has restyled the board: the diff every positive rests on. */
const UI_DIFF = ['packages/server/src/tasks.ts', 'packages/workspaces-app/src/board.css'];
/** A builder working on the server's idle clock. Nothing here is a screen. */
const SERVER_DIFF = [
  'docs/architecture/overview.md',
  'packages/server/src/ready-nudge.ts',
  'packages/server/test/ready-nudge-routes.test.ts',
];

const UI_WORK = { files: UI_DIFF, from: 'dispatch' } as const;
const SERVER_WORK = { files: SERVER_DIFF, from: 'dispatch' } as const;

const breach = {
  id: 't-1',
  title: 'Agent can move the Plan button onto the ticket',
  filedByAgent: true,
  dispatched: true,
  answeredReviewItem: false,
  changedWork: UI_WORK,
};

describe('reading a changed file as a screen', () => {
  it('takes an extension that exists only to be seen', () => {
    expect(isUiFile('packages/workspaces-app/src/board.css')).toBe(true);
    expect(isUiFile('packages/workspaces-app/index.html')).toBe(true);
    expect(isUiFile('packages/workspaces-app/src/board/board-island.tsx')).toBe(true);
    expect(isUiFile('packages/workspaces-app/public/icon.svg')).toBe(true);
  });

  it('takes a plain source file that sits in a client surface', () => {
    expect(isUiFile('packages/widget/src/widget-dock.ts')).toBe(true);
    expect(isUiFile('packages/workspaces-app/src/board/board-cards.ts')).toBe(true);
    expect(isUiFile('src/components/header.ts')).toBe(true);
  });

  it('leaves the server, the docs and the tooling alone', () => {
    expect(isUiFile('packages/server/src/ready-nudge.ts')).toBe(false);
    expect(isUiFile('packages/server/src/routes/task-status-links.ts')).toBe(false);
    expect(isUiFile('docs/architecture/overview.md')).toBe(false);
    expect(isUiFile('scripts/verify.ts')).toBe(false);
  });

  it('leaves a test, even one inside a client package', () => {
    expect(isUiFile('packages/workspaces-app/test/board-task-detail.test.ts')).toBe(false);
    expect(isUiFile('packages/workspaces-app/test/css-harness.ts')).toBe(false);
    expect(isUiFile('packages/widget/test/fixtures/page.html')).toBe(false);
  });

  it('names the first file that made a change a UI change', () => {
    expect(uiFileIn(UI_DIFF)).toBe('packages/workspaces-app/src/board.css');
    expect(uiFileIn(SERVER_DIFF)).toBeUndefined();
    expect(uiFileIn([])).toBeUndefined();
  });
});

describe('reading a row’s prose as UI work', () => {
  it('names the word that made it one', () => {
    expect(uiKeywordIn('Move the Plan button onto the ticket')).toBe('button');
    expect(uiKeywordIn('the CSS banner')).toBe('css');
  });

  it('folds case and takes a plural or a gerund as the same word', () => {
    expect(uiKeywordIn('Two BUTTONS on one screen')).toBe('button');
    expect(uiKeywordIn('a floating panel')).toBe('float');
    expect(uiKeywordIn('Redo the page LAYOUTS')).toBe('page');
  });

  it('matches whole words only, so server prose is not UI work', () => {
    expect(uiKeywordIn('Rebuild the quicksort routine')).toBeUndefined();
    expect(uiKeywordIn('Retry the webhook on a 500')).toBeUndefined();
    // `ui` inside a word is not the word.
    expect(uiKeywordIn('Rebuild the guidance corpus')).toBeUndefined();
  });
});

describe('which rows are a breach', () => {
  it('flags an agent-filed row whose builder touched a screen', () => {
    expect(ungatedUiRows([breach])).toEqual([
      {
        id: 't-1',
        title: breach.title,
        file: 'packages/workspaces-app/src/board.css',
        from: 'dispatch',
        keyword: 'button',
      },
    ]);
  });

  it('flags a row that changes a screen without saying so', () => {
    // The miss the word list could never catch: nothing in these words is
    // about a screen, and the builder is editing the board's stylesheet.
    const row = ungatedUiRows([
      { ...breach, title: 'Agent can see why a task is blocked', body: 'Show the reason.' },
    ]);
    expect(row).toEqual([
      {
        id: 't-1',
        title: 'Agent can see why a task is blocked',
        file: 'packages/workspaces-app/src/board.css',
        from: 'dispatch',
      },
    ]);
    expect(row[0]?.keyword).toBeUndefined();
  });

  it('reads the body for the keyword as well as the title', () => {
    expect(
      ungatedUiRows([{ ...breach, title: 'Agent can finish the flow', body: 'Redraw the panel.' }]),
    ).toEqual([
      {
        id: 't-1',
        title: 'Agent can finish the flow',
        file: 'packages/workspaces-app/src/board.css',
        from: 'dispatch',
        keyword: 'panel',
      },
    ]);
  });

  it('clears a row on any one of the reads failing', () => {
    expect(ungatedUiRows([{ ...breach, filedByAgent: false }])).toEqual([]);
    expect(ungatedUiRows([{ ...breach, dispatched: false }])).toEqual([]);
    expect(ungatedUiRows([{ ...breach, answeredReviewItem: true }])).toEqual([]);
    expect(ungatedUiRows([{ ...breach, changedWork: SERVER_WORK }])).toEqual([]);
  });
});

describe('prose says UI, the diff does not — the six recorded false positives', () => {
  const silent = (title: string, body: string) =>
    ungatedUiRows([{ ...breach, title, body, changedWork: SERVER_WORK }]);

  it('does not flag a row whose only UI word is inside a skill name', () => {
    const title = 'Agent files a project’s docs in the project’s own folders';
    const body =
      'The `project-docs-layout` skill explains the whole setup, and no other skill ' +
      'references it. The remaining work is two skill paragraphs and a conventions index.';
    // The word list still reads it as UI work — that is the whole defect.
    expect(uiKeywordIn(`${title}\n${body}`)).toBe('layout');
    expect(silent(title, body)).toEqual([]);
  });

  it('does not flag a row that merely says which board control filed it', () => {
    const title = 'Agent can be told when a task becomes ready';
    const body =
      'Steps 1–3 are held as backlog, because the board’s New task button sends no goal ' +
      'and the store defaults to chores; step 4 releases it. The fix is the idle clock.';
    expect(uiKeywordIn(`${title}\n${body}`)).toBe('button');
    expect(silent(title, body)).toEqual([]);
  });

  it('does not flag a research note about respondent panels', () => {
    const title = 'Researcher can size a study before fielding it';
    const body = 'Recruiting from three respondent panels; each panel returns ~200 completes.';
    expect(uiKeywordIn(`${title}\n${body}`)).toBe('panel');
    expect(silent(title, body)).toEqual([]);
  });
});

describe('a row with no diff to read', () => {
  it('says nothing, however loudly its words read as UI work', () => {
    const noDispatch = { ...breach, changedWork: undefined };
    expect(uiKeywordIn(noDispatch.title)).toBe('button');
    expect(ungatedUiRows([noDispatch])).toEqual([]);
  });

  it('says nothing about a readable worktree that has changed nothing yet', () => {
    expect(ungatedUiRows([{ ...breach, changedWork: { files: [], from: 'dispatch' } }])).toEqual(
      [],
    );
  });
});

function task(parts: Partial<UiGateTask> = {}): UiGateTask {
  return {
    id: 't-1',
    title: 'Agent can move the Plan button onto the ticket',
    status: 'in-progress',
    createdBy: 'UX Bot',
    transitions: [{ to: 'in-progress', by: { name: 'UX Bot', kind: 'agent' } }],
    ...parts,
  };
}

const agentsOnly = {
  isAgentName: (name: string) => name === 'UX Bot',
  changedWork: () => UI_WORK,
  answeredReviewItem: () => false,
};

const found = {
  id: 't-1',
  title: task().title,
  file: 'packages/workspaces-app/src/board.css',
  from: 'dispatch' as const,
  keyword: 'button',
};

describe('collecting a board', () => {
  it('takes a row whose filer the roster places as an agent', () => {
    expect(collectUngatedUiRows([task()], agentsOnly)).toEqual([found]);
  });

  it('leaves a row a person filed, even one an agent then moved', () => {
    expect(collectUngatedUiRows([task({ createdBy: 'Jordan' })], agentsOnly)).toEqual([]);
  });

  it('falls back to the first transition when nothing recorded a filer', () => {
    const row = task({ createdBy: undefined });
    expect(collectUngatedUiRows([row], { ...agentsOnly, isAgentName: () => false })).toHaveLength(
      1,
    );
  });

  it('leaves a row that is not in flight, and a goal band', () => {
    expect(collectUngatedUiRows([task({ status: 'todo' })], agentsOnly)).toEqual([]);
    expect(collectUngatedUiRows([task({ kind: 'goal' })], agentsOnly)).toEqual([]);
  });

  it('leaves an in-progress row nothing ever moved there', () => {
    expect(collectUngatedUiRows([task({ transitions: [] })], agentsOnly)).toEqual([]);
  });

  it('leaves a row somebody answered an item on', () => {
    expect(
      collectUngatedUiRows([task()], { ...agentsOnly, answeredReviewItem: () => true }),
    ).toEqual([]);
  });

  it('leaves a row whose builder has no worktree the board can read', () => {
    expect(collectUngatedUiRows([task()], { ...agentsOnly, changedWork: () => undefined })).toEqual(
      [],
    );
  });

  it('asks git nothing about a row the cheap reads already cleared', () => {
    // The read spawns a git process per worktree. A board of rows a person
    // filed, or rows nobody started, must not pay for one.
    const asked: string[] = [];
    const counting = {
      ...agentsOnly,
      changedWork: (id: string) => {
        asked.push(id);
        return UI_WORK;
      },
    };
    collectUngatedUiRows(
      [
        task({ id: 't-person', createdBy: 'Jordan' }),
        task({ id: 't-todo', status: 'todo' }),
        task({ id: 't-unmoved', transitions: [] }),
        task({ id: 't-real' }),
      ],
      counting,
    );
    expect(asked).toEqual(['t-real']);
  });

  it('asks whether an item was answered only of a row the diff convicted', () => {
    const asked: string[] = [];
    collectUngatedUiRows([task({ id: 't-server' }), task({ id: 't-ui' })], {
      ...agentsOnly,
      changedWork: (id) => (id === 't-ui' ? UI_WORK : SERVER_WORK),
      answeredReviewItem: (id) => {
        asked.push(id);
        return false;
      },
    });
    expect(asked).toEqual(['t-ui']);
  });
});
