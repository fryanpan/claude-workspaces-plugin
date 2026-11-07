/**
 * What each entry of the lead chat looks like, driven through the real
 * panel: a tool call is one terminal-style line that opens to its input and
 * output; tool calls and board events are hidden but for the one the lead is
 * on now, until the header's Show tool use toggle shows them all, and the choice
 * is kept; an answer to something said aloud is a bubble whose words open on
 * a tap; a person's message says where it got to.
 */
import type { LeadChatMessage } from '@claude-workspaces/core/lead-chat';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModeStorage } from '../src/lead-chat/lead-chat-mode.ts';
import { drawMessage, messageState } from '../src/lead-chat/lead-chat-rows.ts';
import {
  type LeadChatView,
  type LeadChatViewModel,
  createLeadChatView,
} from '../src/lead-chat/lead-chat-view.ts';

const LEAD = { agentId: 'harborlight-lead', name: 'Harborlight Lead' };
const BRYAN = { id: 'known-bryan', name: 'Bryan' };
const SESSION = { id: LEAD.agentId, name: LEAD.name };

const msg = (m: Partial<LeadChatMessage> & { id: string }): LeadChatMessage => ({
  role: 'agent',
  author: SESSION,
  text: m.id,
  ts: Number(m.id.replace(/\D/g, '')) || 1,
  ...m,
});

const CONVO: LeadChatMessage[] = [
  msg({
    id: 'p1',
    role: 'person',
    author: BRYAN,
    text: 'Is Saltmarsh fixed?',
    via: 'voice',
    state: 'answered',
  }),
  msg({ id: 'a2', text: 'Yes, the install is fixed.', replyTo: 'p1' }),
  msg({
    id: 'c3',
    role: 'person',
    author: { id: 'lead-channel', name: 'Riverbend' },
    text: 'replied on Deploy plan',
    via: 'channel',
  }),
  msg({
    id: 't4',
    text: 'Bash: git status',
    via: 'terminal',
    tool: { name: 'Bash', input: 'git status', output: 'nothing to commit' },
  }),
  msg({
    id: 'k5',
    role: 'person',
    author: { id: 'lead-terminal', name: 'Terminal' },
    text: 'ship it',
    via: 'terminal',
  }),
];

function memory(): ModeStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

let view: LeadChatView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = '';
});

/** Storage with the Show tool use toggle already on. */
function showingTools(): ReturnType<typeof memory> {
  const m = memory();
  m.map.set('cw.lead-chat.tools', 'show');
  return m;
}

function open(messages: LeadChatMessage[], storage: ModeStorage | null = null) {
  const host = document.createElement('span');
  document.body.append(host);
  view = createLeadChatView({ document, buttonHost: host, placement: 'float', storage });
  const model: LeadChatViewModel = {
    lead: LEAD,
    messages,
    canTalk: true,
    loaded: true,
    meId: BRYAN.id,
    open: true,
    barOut: false,
    listening: false,
    heard: '',
    notice: '',
  };
  view.render(model);
  const root = view.root;
  const q = <T extends Element = HTMLElement>(s: string) => root.querySelector<T & HTMLElement>(s);
  return { root, q, model, v: view };
}

describe('the lead chat’s entries', () => {
  it('draws a tool call as one line that opens to its input and output', () => {
    const { q } = open(CONVO, showingTools());
    const head = q('.lc-tool .lc-row-head');
    expect(head?.textContent).toContain('Bash');
    expect(head?.textContent).toContain('git status');
    expect(q('.lc-tool .lc-row-body')).toBeNull();
    head?.click();
    const body = q('.lc-tool .lc-row-body');
    expect([...(body?.querySelectorAll('pre') ?? [])].map((p) => p.textContent)).toEqual([
      'git status',
      'nothing to commit',
    ]);
    expect(q('.lc-tool .lc-row-head')?.getAttribute('aria-expanded')).toBe('true');
    q('.lc-tool .lc-row-head')?.click();
    expect(q('.lc-tool .lc-row-body')).toBeNull();
  });

  it('shows every tool call and board event behind one toggle with no count, and keeps the choice', () => {
    const storage = memory();
    const first = open(CONVO, storage);
    // Off by default: the convo ends on a typed prompt, so nothing working shows.
    expect(first.q('.lc-chan')).toBeNull();
    expect(first.q('.lc-tool')).toBeNull();
    const toggle = first.q('.lc-tools-toggle');
    expect(toggle?.hidden).toBe(false);
    expect(toggle?.textContent).toBe('Show tool use');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    toggle?.click();
    expect(first.q('.lc-chan .lc-row-kind')?.textContent).toBe('Board event');
    expect(first.q('.lc-chan .lc-row-head')?.textContent).toContain('Riverbend:');
    expect(first.q('.lc-tool')).not.toBeNull();
    expect(first.q('.lc-tools-toggle')?.getAttribute('aria-pressed')).toBe('true');
    expect(first.q('.lc-tools-toggle')?.textContent).toBe('Show tool use');
    // Ordinary messages show either way.
    expect(first.root.querySelector('.lc-msg[data-message-id="k5"]')).not.toBeNull();
    view?.destroy();
    document.body.innerHTML = '';
    // The next page reads the same choice.
    const again = open(CONVO, storage);
    expect(again.q('.lc-tool')).not.toBeNull();
    expect(again.q('.lc-chan')).not.toBeNull();
  });

  it('draws the answer to a spoken question as a bubble whose words open on a tap', () => {
    const { q } = open(CONVO);
    const bubble = q('.lc-voice');
    expect(bubble?.textContent).toContain('Show words');
    expect(bubble?.textContent).not.toContain('the install is fixed');
    q<HTMLButtonElement>('.lc-voice-btn')?.click();
    expect(q('.lc-voice .lc-voice-text')?.textContent).toContain('Yes, the install is fixed.');
    expect(q('.lc-voice-btn')?.textContent).toContain('Hide words');
  });

  it('draws a written answer to a spoken question as words, with its link, since nobody heard it', () => {
    const p1 = CONVO[0] as LeadChatMessage;
    const { q } = open([
      p1,
      msg({
        id: 'a2',
        text: 'It is [the Saltmarsh summary](/workspaces/w-x/docs/d-saltmarsh).',
        replyTo: 'p1',
        written: true,
      }),
    ]);
    expect(q('.lc-voice')).toBeNull();
    expect(q('.lc-msg[data-message-id="a2"] .lc-md a')?.textContent).toBe('the Saltmarsh summary');
  });

  it('names a prompt typed in the lead’s terminal as such', () => {
    const { root } = open(CONVO);
    const row = root.querySelector('.lc-msg[data-message-id="k5"] .lc-msg-who');
    expect(row?.textContent).toBe('In the terminal');
  });

  it('draws no toggle while there is no tool use or board event', () => {
    const { q } = open(CONVO.filter((m) => m.via !== 'channel' && !m.tool));
    expect(q('.lc-tools-toggle')?.hidden).toBe(true);
  });
});

describe('where a person’s message got to', () => {
  const asked = msg({
    id: 'p10',
    role: 'person',
    author: BRYAN,
    via: 'chat',
    state: 'received',
    receivedAt: 10,
  });
  it('reads Received until the lead’s session shows anything after it, then Working', () => {
    expect(messageState(asked, [asked])?.text).toBe('Received');
    const tool = msg({ id: 't11', via: 'terminal', tool: { name: 'Read', input: 'a.md' } });
    expect(messageState(asked, [asked, tool])?.text).toBe('Working');
  });

  it('reads Sent, Done and Answered, and nothing for a mirrored prompt', () => {
    expect(messageState({ ...asked, state: 'sent' }, [])?.text).toBe('Sent');
    expect(messageState({ ...asked, state: 'done' }, [])?.text).toBe('Done');
    expect(messageState({ ...asked, state: 'answered' }, [])?.text).toBe('Answered');
    expect(messageState({ ...asked, via: 'terminal' }, [])).toBeNull();
  });

  it('shows the line under the message in the panel', () => {
    const { root } = open([{ ...asked, state: 'sent' }]);
    const line = root.querySelector('.lc-state');
    expect(line?.textContent).toBe('Sent');
    expect((line as HTMLElement | null)?.dataset.s).toBe('sent');
  });
});

describe('the one working row shown while the toggle is off', () => {
  const asked = msg({
    id: 'p20',
    role: 'person',
    author: BRYAN,
    text: 'Where is the Harborlight plan?',
    via: 'chat',
    state: 'received',
  });
  const tool = (id: string, name: string, input: string): LeadChatMessage =>
    msg({ id, via: 'terminal', text: `${name}: ${input}`, tool: { name, input } });
  const shown = (root: ShadowRoot) =>
    [...root.querySelectorAll<HTMLElement>('.lc-row')].map((r) => r.dataset.messageId);

  it('shows the newest call while the turn runs, moves to each new one, and goes when the reply lands', () => {
    const t1 = tool('t21', 'Grep', '{"pattern":"Harborlight"}');
    const { root, model, v } = open([asked, t1]);
    expect(shown(root)).toEqual(['t21']);
    expect(root.querySelector('.lc-tool .lc-row-head')?.textContent).toContain('Harborlight');

    // A new call arrives on the open page: it replaces the one shown.
    const t2 = tool('t22', 'Read', 'docs/plans/harborlight.md');
    v.render({ ...model, messages: [asked, t1, t2] });
    expect(shown(root)).toEqual(['t22']);
    expect(root.querySelector('.lc-tool .lc-row-head')?.textContent).toContain('harborlight.md');
    expect(root.querySelector('.lc-tools-toggle')?.textContent).toBe('Show tool use');

    // A board event the session takes mid-turn is the newest working row too.
    const c3 = msg({
      id: 'c23',
      role: 'person',
      author: { id: 'lead-channel', name: 'Riverbend' },
      text: 'commented on the plan',
      via: 'channel',
    });
    v.render({ ...model, messages: [asked, t1, t2, c3] });
    expect(shown(root)).toEqual(['c23']);

    // The lead's reply lands: every working row is hidden, the reply shows.
    const reply = msg({ id: 'a24', text: 'It is in docs/plans.', replyTo: 'p20' });
    v.render({ ...model, messages: [asked, t1, t2, c3, reply] });
    expect(shown(root)).toEqual([]);
    expect(root.querySelector('.lc-msg[data-message-id="a24"]')?.textContent).toContain(
      'It is in docs/plans.',
    );
    expect(root.querySelector('.lc-msg[data-message-id="p20"]')).not.toBeNull();
    expect(root.querySelector('.lc-tools-toggle')?.textContent).toBe('Show tool use');
  });

  it('keeps the same toggle and words as the hidden rows change', () => {
    const t1 = tool('t31', 'Bash', 'git status');
    const { q, model, v } = open([asked, t1]);
    const toggle = q('.lc-tools-toggle');
    // Nothing hidden yet: the live row shows, and so does the toggle.
    expect(toggle?.hidden).toBe(false);
    expect(toggle?.textContent).toBe('Show tool use');
    v.render({ ...model, messages: [asked, t1, msg({ id: 'a32', text: 'Clean.' })] });
    expect(q('.lc-tools-toggle')).toBe(toggle);
    expect(toggle?.textContent).toBe('Show tool use');
  });
});

describe('a tool call’s line', () => {
  const line = (name: string, input: string) => {
    const { q } = open(
      [msg({ id: 't40', via: 'terminal', tool: { name, input, output: 'done' } })],
      showingTools(),
    );
    const out = {
      name: q('.lc-tool .lc-row-kind')?.textContent,
      arg: q('.lc-tool .lc-row-sum')?.textContent,
    };
    view?.destroy();
    view = null;
    document.body.innerHTML = '';
    return out;
  };

  it('reads like the terminal: a short name and one main argument, never JSON', () => {
    expect(line('Bash', 'git status --short\necho done')).toEqual({
      name: 'Bash',
      arg: 'git status --short',
    });
    expect(line('Read', 'packages/core/src/lead-chat.ts')).toEqual({
      name: 'Read',
      arg: 'lead-chat.ts',
    });
    expect(
      line('Edit', '{"file_path":"/repo/docs/plan.md","old_string":"a","new_string":"b"}'),
    ).toEqual({ name: 'Edit', arg: 'plan.md' });
    expect(line('Write', '{"file_path":"/repo/notes/riverbend.md","content":"x"}')).toEqual({
      name: 'Write',
      arg: 'riverbend.md',
    });
    expect(line('Grep', '{"pattern":"tide","path":"/repo/src"}')).toEqual({
      name: 'Grep',
      arg: 'tide',
    });
    expect(line('Glob', '{"pattern":"**/*.ts"}')).toEqual({ name: 'Glob', arg: '**/*.ts' });
    expect(
      line(
        'mcp__plugin_claude-workspaces_claude-workspaces__find_and_replace',
        '{"docId":"saltmarsh-plan","find":"old","replace":"new"}',
      ),
    ).toEqual({ name: 'find_and_replace', arg: 'saltmarsh-plan' });
    expect(line('Agent', '{"description":"Survey the tests","prompt":"long brief"}')).toEqual({
      name: 'Agent',
      arg: 'Survey the tests',
    });
  });

  it('still names the file of an input the hook capped mid-value', () => {
    const capped = `{"file_path":"/repo/src/board.ts","content":"${'x'.repeat(40)}`;
    expect(line('Write', capped)).toEqual({ name: 'Write', arg: 'board.ts' });
  });

  it('keeps the whole input and the output behind the tap', () => {
    const input = '{"file_path":"/repo/docs/plan.md","old_string":"a","new_string":"b"}';
    const { q } = open(
      [msg({ id: 't41', via: 'terminal', tool: { name: 'Edit', input, output: 'ok' } })],
      showingTools(),
    );
    q('.lc-tool .lc-row-head')?.click();
    expect(
      [...(q('.lc-tool .lc-row-body')?.querySelectorAll('pre') ?? [])].map((p) => p.textContent),
    ).toEqual([input, 'ok']);
  });
});

describe('a message with files', () => {
  const ctx = {
    doc: document,
    workspaceId: 'w-harbor',
    meId: BRYAN.id,
    lead: LEAD,
    open: new Set<string>(),
    showWorking: false,
    liveWorking: null,
    markdown: (m: LeadChatMessage) => m.text,
    messages: [],
  };

  it('shows a photo as a thumbnail and a file as a link, and no empty bubble', () => {
    const row = drawMessage(
      ctx,
      msg({
        id: 'p1',
        role: 'person',
        author: BRYAN,
        text: '',
        state: 'sent',
        attachments: [
          { id: 'lf-aaaaaaaa', name: 'berth.png', type: 'image/png', size: 12, image: true },
          { id: 'lf-bbbbbbbb', name: 'tide<b>.csv', type: 'application/octet-stream', size: 2048 },
        ],
      }),
    ) as HTMLElement;
    const img = row.querySelector('.lc-thumbs img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/workspaces/w-harbor/lead-chat/files/lf-aaaaaaaa');
    expect(img.alt).toBe('berth.png');
    const file = row.querySelector('.lc-sent-file') as HTMLAnchorElement;
    expect(file.textContent).toBe('tide<b>.csv2 KB');
    expect(file.querySelector('b b')).toBeNull();
    expect((row.querySelector('.lc-msg-text') as HTMLElement).hidden).toBe(true);
  });
});
