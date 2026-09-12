/**
 * The tool registry: what `tools/list` answers with, and nothing else.
 *
 * Names, descriptions and JSON Schema for the arguments of every tool, with
 * no logic in them. A change here is a wording or an argument. A change in
 * `tools/` is behaviour.
 *
 * The descriptions ARE the product surface. An agent picks a tool from this
 * text alone, so a description that omits what an argument refuses is a bug
 * in the same sense a dropped argument is.
 *
 * The `ListToolsResult` annotation is load-bearing. Without it `type:
 * 'object'` widens to `string` and the schemas stop typechecking.
 *
 * `tool-wiring.test.ts` reads this file's `name:` lines against the `case`
 * labels in `tools/`, so a tool declared here and dispatched nowhere fails a
 * gate rather than answering "unknown tool" at runtime.
 */
import { TASK_STATUSES } from '@claude-workspaces/core/task-wire';
import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * A Review Item: the declaration that turns a comment into a row on a
 * person's Home queue.
 *
 * Declaring is explicit and nothing is derived. If you did not ask for
 * something, do not pass `review`, and the comment stays out of the queue.
 *
 * A headline and a detail, and nothing else. `headline` is the row. A missing
 * or multi-line headline is refused, because the row cannot be built from it.
 * An over-long one is accepted and comes back with advice. Write it like a
 * task title, not like the first sentence of the explanation.
 */
const REVIEW_ITEM_SCHEMA = {
  type: 'object',
  description:
    "Makes this comment a review item on the reader's Home queue, once the board's quality gate passes it. Omit it for an ordinary comment. A missing or multi-line headline is refused. Put everything else in detail.",
  properties: {
    review_type: {
      type: 'string',
      enum: ['decision', 'question'],
      description:
        "Use 'decision' to offer 2-6 named options. Use 'question' to ask for an answer in the reader's own words.",
    },
    shape: {
      type: 'string',
      enum: ['decision', 'review'],
    },
    headline: {
      type: 'string',
      description:
        'Name what needs deciding, in words a reader who has not seen this work would use. One line.',
    },
    detail: {
      type: 'string',
      description:
        'Everything the reader needs and does not have: what is at stake, what to look at, and the context behind it. Write it for a reader on a phone, away from the work. Markdown and inline links are allowed.',
    },
    options: {
      type: 'array',
      description: "For 'decision' only. Pass 2 to 6 options. Options on a 'question' are refused.",
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description:
              'Stable id for this option. The answer records which id the reader picked.',
          },
          label: {
            type: 'string',
            description:
              'The button the reader taps, in their words. One to three words, 28 characters or fewer.',
          },
          detail: {
            type: 'string',
            description:
              'What this option costs or buys, in a plain sentence of 50 words or fewer.',
          },
        },
        required: ['id', 'label'],
      },
    },
  },
  required: ['headline'],
} as const;

/**
 * The same payload, hanging off a TASK instead of a comment.
 *
 * The properties come from the schema above, so one payload keeps one shape.
 * Only the description differs, because the comment version names a comment
 * and a task's question is not one.
 */
const TASK_REVIEW_ITEM_SCHEMA = {
  ...REVIEW_ITEM_SCHEMA,
  description:
    'A review item on this task, with its own headline and its own options. A task can carry several open items at once. Same payload and same refusals as a review item on a comment.',
} as const;

/**
 * The same payload again, on a task this call is CREATING. It differs only in
 * saying where a question belongs: filed with the work when both arrive
 * together, hung on the existing task with add_review_item when the question
 * came up mid-work.
 */
const NEW_TASK_REVIEW_ITEM_SCHEMA = {
  ...REVIEW_ITEM_SCHEMA,
  description:
    'A question about the work this task creates, for when you file the work and the question together. For a question that came up on a task that already exists, use add_review_item instead. The task title names the work, and headline names the ask.',
} as const;

export const TOOL_LIST: ListToolsResult = {
  tools: [
    {
      name: 'list_docs',
      description:
        'List the review docs on the server, one page at a time. A page holds the 50 most recently active docs as compact rows, plus nextCursor. Narrow it with workspaceId, kind, query or sourcePrefix. Pass `full: true` for the whole doc meta.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description: 'Only docs on this board. An unknown id returns an empty list.',
          },
          kind: {
            type: 'string',
            enum: ['markdown', 'mockup', 'code', 'diff', 'workspace'],
            description: 'Only docs of this type.',
          },
          query: {
            type: 'string',
            description:
              'Case-insensitive substring, matched against title, docId, alias, relPath and sourceUrl. A file basename finds the doc bound to that file.',
          },
          sourcePrefix: {
            type: 'string',
            description: 'Only docs whose sourceUrl or relPath starts with this path.',
          },
          limit: {
            type: 'number',
            description: 'Rows per page, 1-500. Default 50.',
          },
          cursor: {
            type: 'string',
            description: 'The nextCursor from the previous page. Omit it for the first page.',
          },
          full: {
            type: 'boolean',
            description:
              'Return the whole doc meta for each row instead of the compact row. Default false.',
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'list_threads',
      description:
        'List the comment threads on a doc. Pass status to return only the threads in that state.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          status: { type: 'string', enum: ['open', 'resolved'] },
        },
        required: ['workspaceId', 'docId'],
      },
    },
    {
      name: 'get_thread',
      description: 'Read one thread by id, with all of its comments.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          threadId: { type: 'string' },
        },
        required: ['workspaceId', 'docId', 'threadId'],
      },
    },
    {
      name: 'post_reply',
      description:
        'Reply to a thread. Pass review when the reply asks a person to decide or look. Without it the reply is an ordinary comment and stays off the queue. A comment is an ask, a decision, or a reply to a person, and where the work stands goes through post_status instead. `held: true` means the item waits for a revision. Use revise_review_item for the next round, not a new thread.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          threadId: { type: 'string' },
          text: { type: 'string' },
          review: REVIEW_ITEM_SCHEMA,
        },
        required: ['workspaceId', 'docId', 'threadId', 'text'],
      },
    },
    {
      name: 'edit_comment',
      description:
        'Replace the words of a posted comment, and keep the old words on its edit trail. Use it to repair a link, a name or a figure. To change what an item asks, use revise_review_item. Text identical to the current text is refused.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          threadId: { type: 'string' },
          commentId: {
            type: 'string',
            description:
              'Which comment on the thread. get_thread lists the comments with their ids.',
          },
          text: { type: 'string', description: 'The words the comment says now.' },
          reason: {
            type: 'string',
            description:
              'Why you changed it. One line, kept on the edit trail beside the old words.',
          },
        },
        required: ['workspaceId', 'docId', 'threadId', 'commentId', 'text'],
      },
    },
    {
      name: 'post_status',
      description:
        'Share a major milestone update to the activity stream (e.g. build, test, review, or deploy done). Only the first sentence appears in the Home activity feed, cut at 200 characters. The full update may be up to 4000 chars in the task activity feed.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board the task is on. Omit it only when the session was launched with CW_WORKSPACE_ID, which then names the board.',
          },
          text: { type: 'string' },
          taskId: {
            type: 'string',
            description:
              'The task to report on. Omit it and the note lands on your current in-progress task.',
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'create_thread',
      description:
        'Open a comment thread on a doc. Pass find to anchor the thread to a phrase, or omit find for a thread about the whole doc. Pass review when you ask a person to decide or to look. `held: true` in the result means the item waits for a revision. Use revise_review_item for the next round, not a new thread.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: {
            type: 'string',
            description: 'Doc id. A task\'s discussion lives on "task:<taskId>".',
          },
          find: {
            type: 'string',
            description:
              'Text to anchor the thread to. Omit it for a thread about the whole doc. An empty string is refused.',
          },
          contextBefore: { type: 'string' },
          contextAfter: { type: 'string' },
          occurrence: { type: 'number' },
          text: { type: 'string' },
          review: REVIEW_ITEM_SCHEMA,
        },
        required: ['workspaceId', 'docId', 'text'],
      },
    },
    {
      name: 'resolve_thread',
      description:
        'Mark a thread resolved. It retires every review item on the thread, so use withdraw_review_item to take back one of your own asks while the others stay answerable.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          threadId: { type: 'string' },
        },
        required: ['workspaceId', 'docId', 'threadId'],
      },
    },
    {
      name: 'summarize_thread',
      description:
        "Regenerate a thread's collapsed-card summary now. The server regenerates it automatically after a change, so call this only when the card must be correct before you hand someone the URL. A 503 means summaries are off. A 409 means a reply landed mid-call, so call again.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          threadId: { type: 'string' },
          force: {
            type: 'boolean',
            description:
              'Regenerate even when the stored summary is current. Each call is billed, so use it only when the stored line reads wrong.',
          },
        },
        required: ['workspaceId', 'docId', 'threadId'],
      },
    },
    {
      name: 'reopen_thread',
      description: 'Reopen a resolved thread so that it takes replies again.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          threadId: { type: 'string' },
        },
        required: ['workspaceId', 'docId', 'threadId'],
      },
    },
    {
      name: 'get_doc',
      description:
        "Read a doc's plain text and block structure. The plain text is the surface find_and_replace matches against. The result can run to hundreds of kilobytes, so call doc_status when you only need health or shape.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
        },
        required: ['workspaceId', 'docId'],
      },
    },
    {
      name: 'doc_status',
      description:
        "Read a doc's health and counts without its body. It answers whether the doc is still bound, where it is bound, whether the last sync failed (syncError), and how large get_doc would be.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
        },
        required: ['workspaceId', 'docId'],
      },
    },
    {
      name: 'attach_markdown',
      description:
        'Attach a markdown file to a board as a live doc. The server parses the file into the editor and keeps file and doc in sync both ways. The file must already exist, and path should be absolute. After the bind, edit only through these tools, because the next flush overwrites a direct file write. Returns the minted docId and the review URL.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: {
            type: 'string',
            description:
              'A readable name for the doc, not its address. The server mints the real id, returns it, and keeps this name as an alias. Reusing a name reuses that doc. The `task:`, `ws:` and `goal:` namespaces are refused.',
          },
          path: { type: 'string' },
          title: { type: 'string' },
          setId: { type: 'string' },
          subscribe: { type: 'boolean' },
          producedBy: {
            type: 'object',
            description:
              'Optional provenance for the activity stream: {agentId?, sessionId?}. Without it the server derives agentId from the owner cwd and leaves sessionId null.',
            properties: {
              agentId: { type: 'string' },
              sessionId: { type: 'string' },
            },
          },
        },
        required: ['workspaceId', 'docId', 'path'],
      },
    },
    {
      name: 'set_doc_content',
      description:
        'Replace a whole doc with new markdown. Use it for a comprehensive rewrite only. A scoped change gets a scoped tool: find_and_replace, rewrite_thread_region or edit_at_anchor. A human edit made after your last read is refused with 409 stale-write. Re-read with get_doc, re-apply your change, then retry with confirmOverwriteHumanEdits. On a task body use rewrite_task. An empty document is refused.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          markdown: { type: 'string', description: 'Full replacement markdown for the doc.' },
          confirmOverwriteHumanEdits: {
            type: 'boolean',
            description:
              "Acknowledge a 409 stale-write refusal, after you re-read the doc and re-applied your change onto its current content. It turns off the guard against overwriting a human's concurrent edits, so never pass it in advance.",
          },
        },
        required: ['workspaceId', 'docId', 'markdown'],
      },
    },
    {
      name: 'reparse_from_disk',
      description:
        'Force-pull a bound file from disk into the live doc. It overwrites un-flushed live edits, and anchors in the replaced regions can orphan. Use it when get_doc returns stale content or a syncError.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
        },
        required: ['workspaceId', 'docId'],
      },
    },
    {
      name: 'delete_doc',
      description:
        'Permanently delete a review doc, and the record the activity analyses are rebuilt from. Use archive_doc instead unless you mean to destroy it, because unarchive_doc reverses that. The source file on disk is untouched. Open threads refuse the call unless you pass force.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          force: {
            type: 'boolean',
            description: 'Delete even if open threads exist. Default false.',
          },
        },
        required: ['workspaceId', 'docId'],
      },
    },
    {
      name: 'attach_mockup',
      description:
        "Serve an HTML mockup at /workspaces/<workspaceId>/mockups/<docId> and bind it for comments. The server re-reads sourceHtmlPath on each request, so an edit appears on reload. An unreadable path fails this call instead of the reviewer's. Single-file mockups only, because relative CSS and JS siblings do not resolve. Hand meta.reviewUrl to a person.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: {
            type: 'string',
            description:
              'A readable name for the doc, not its address. The server mints the real id, returns it, and keeps this name as an alias. Reusing a name reuses that doc. The `task:`, `ws:` and `goal:` namespaces are refused.',
          },
          sourceHtmlPath: { type: 'string' },
          title: { type: 'string' },
          subscribe: { type: 'boolean' },
        },
        required: ['workspaceId', 'docId', 'sourceHtmlPath'],
      },
    },
    {
      name: 'attach_folder',
      description:
        'Attach a folder or worktree as a browsable review. The reviewer picks files from the menu under the filename in the topbar, and a markdown file opens editable. Prefer create_diff_review, which adds the changed-files diff on top of browsing.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          folderPath: { type: 'string' },
          exclude: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Path prefixes, relative to the folder, to keep out of the review. The server stores them, so refresh_attachment_set replays them.',
          },
          setId: {
            type: 'string',
            description:
              "The attachment set's own id, to reuse instead of minting one. It is the id this call returned last time. On this call `workspaceId` names the board instead.",
          },
          title: { type: 'string' },
          include: { type: 'array', items: { type: 'string' } },
          maxFiles: { type: 'number' },
          subscribe: { type: 'boolean' },
          producedBy: {
            type: 'object',
            description:
              'Optional provenance for the activity stream: {agentId?, sessionId?}. The server stores it on every doc the bind creates.',
            properties: {
              agentId: { type: 'string' },
              sessionId: { type: 'string' },
            },
          },
        },
        required: ['workspaceId', 'folderPath'],
      },
    },
    {
      name: 'create_diff_review',
      description:
        'Review a git diff the way a pull request reads: one doc per changed file, with line-anchored comments. By default it diffs base against the working tree and re-renders as you edit. Pass target to pin it to a commit, or omit base to browse the folder. Hand entryUrl to the reviewer.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          repo: { type: 'string', description: 'Absolute path to the local git repo or worktree.' },
          base: {
            type: 'string',
            description:
              'Base ref, the "before" side. Omit it to browse the folder with no diff, where files open lazily and markdown opens editable.',
          },
          target: {
            type: 'string',
            description:
              'Target ref. Omit it to review the live working tree, or pass a ref to pin the review to that commit.',
          },
          reviewId: {
            type: 'string',
            description: 'Review id. Defaults to <repo-basename>-<base7>-<target7|live>.',
          },
          title: { type: 'string' },
          exclude: {
            type: 'array',
            items: { type: 'string' },
            description: 'Path prefixes, relative to the repo root, to leave out of the review.',
          },
          groups: {
            type: 'array',
            description:
              'Split the changed files by intent, the way you would split a branch into commits. The reviewer reads the first group first. A path matches a file exactly or as a directory prefix, the first group wins, and unlisted files land in "Other". Optional `details` is a one or two sentence intro, refused over 500 characters.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                paths: { type: 'array', items: { type: 'string' } },
                details: { type: 'string' },
              },
              required: ['title', 'paths'],
            },
          },
          maxFiles: { type: 'number' },
          subscribe: { type: 'boolean' },
          producedBy: {
            type: 'object',
            description:
              'Optional provenance for the activity stream: {agentId?, sessionId?}. The server stores it on every doc the review creates.',
            properties: {
              agentId: { type: 'string' },
              sessionId: { type: 'string' },
            },
          },
        },
        required: ['workspaceId', 'repo'],
      },
    },
    {
      name: 'delete_attachment_set',
      description:
        'Retire a whole attachment set, a diff review or an attached folder, as one unit. It archives by default, and unarchive_attachment_set reverses that. Source files are untouched. Prefer archive_attachment_set, which takes a reason and needs no force. `purge: true` destroys the records instead. Open threads refuse the whole call unless you pass force.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          setId: {
            type: 'string',
            description:
              'The attachment set: reviewId from create_diff_review, or setId from attach_folder.',
          },
          force: {
            type: 'boolean',
            description: 'Proceed even if some member files have open threads. Default false.',
          },
          purge: {
            type: 'boolean',
            description:
              'Destroy the persisted state instead of archiving it. Default false. A purged doc cannot be restored.',
          },
        },
        required: ['workspaceId', 'setId'],
      },
    },
    {
      name: 'archive_attachment_set',
      description:
        'Retire a finished attachment set without deleting anything. Members drop off the board listing and stop costing a poll, and unarchive_attachment_set restores them with their threads and board links. Open threads do not block the call. Pass a reason, usually the pull request that merged.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          setId: {
            type: 'string',
            description:
              'The attachment set: reviewId from create_diff_review, or setId from attach_folder.',
          },
          reason: {
            type: 'string',
            description: 'Why this attachment set is finished, for example "merged in #301".',
          },
        },
        required: ['workspaceId', 'setId'],
      },
    },
    {
      name: 'unarchive_attachment_set',
      description:
        'Bring an archived attachment set back. Every member returns with its threads, its file bindings and its board entries. A restore-collision means a docId was re-minted while the set was away, and nothing moved.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          setId: { type: 'string' },
        },
        required: ['workspaceId', 'setId'],
      },
    },
    {
      name: 'archive_doc',
      description:
        'Retire one finished doc, a bound markdown doc or a mockup, without deleting anything. It drops off the board listing, the source file is untouched, and unarchive_doc restores it. Use archive_attachment_set for a doc that belongs to an attachment set. Task bodies and board docs are refused.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          reason: {
            type: 'string',
            description: 'Why this doc is finished, for example "draft published".',
          },
        },
        required: ['workspaceId', 'docId'],
      },
    },
    {
      name: 'unarchive_doc',
      description:
        'Bring an archived doc back with its threads, its file binding and its board entry.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
        },
        required: ['workspaceId', 'docId'],
      },
    },
    {
      name: 'list_archived_attachments',
      description:
        'List everything archived on this server, newest first, under two keys. `archived` holds whole attachment sets for unarchive_attachment_set. `docs` holds single docs for unarchive_doc. Each entry carries when, who, the reason, and the boards it returns to.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'delete_workspace',
      description:
        'Permanently delete a board with all of its tasks, docs and history. Use archive_workspace instead in almost every case, because this call cannot be undone. Open tasks refuse it unless you pass force. Attached docs survive, because attaching is a link, not ownership.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          force: {
            type: 'boolean',
            description: 'Delete even if the board has open tasks. Default false.',
          },
          purge: {
            type: 'boolean',
            description:
              'Only meaningful when the id names a review. Destroy its persisted state instead of archiving it. Default false.',
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'refresh_attachment_set',
      description:
        'Re-reconcile an attachment set against what is on disk now, without re-minting any docId, so every comment thread survives. Use it when files moved under the set. A file that was reverted, deleted or renamed away is marked stale, not removed. Pinned sets are refused.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          setId: {
            type: 'string',
            description:
              'The attachment set: reviewId from create_diff_review, or setId from attach_folder.',
          },
        },
        required: ['workspaceId', 'setId'],
      },
    },
    {
      name: 'set_attachment_groups',
      description:
        'Re-group a diff review\'s file list in place, keeping its comments. A group claims files by exact path or directory prefix, the first group wins, and unclaimed files land in "Other". Pass an empty array for the built-in heuristic. Optional `details` is refused over 500 characters.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          setId: {
            type: 'string',
            description: 'reviewId from create_diff_review.',
          },
          groups: {
            type: 'array',
            description: 'Ordered groups. An empty array falls back to the built-in heuristic.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                paths: { type: 'array', items: { type: 'string' } },
                details: { type: 'string' },
              },
              required: ['title', 'paths'],
            },
          },
        },
        required: ['workspaceId', 'setId', 'groups'],
      },
    },
    {
      name: 'find_and_replace',
      description:
        "Replace plain text in a doc with other plain text. find matches plain text, not markdown, and marks are kept; pipe-table row syntax matches table rows. Disambiguate repeats with contextBefore, contextAfter, occurrence or replaceAll. A no-match quotes the doc's actual characters. replace stays inside one block; block-level markdown is refused with block-markdown-in-replacement. With suggest, replace parses inline markdown unless parseInlineMarks is false.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          find: { type: 'string' },
          replace: { type: 'string' },
          contextBefore: { type: 'string' },
          contextAfter: { type: 'string' },
          occurrence: { type: 'number' },
          replaceAll: {
            type: 'boolean',
            description:
              'Replace every occurrence in one call, with marks carried per site. Mutually exclusive with `occurrence` and with `suggest`.',
          },
          parseInlineMarks: {
            type: 'boolean',
            description:
              'Read inline markdown in replace as marks: links, speaker tags, bold, italic, code and strikethrough. A direct edit defaults to false. A suggestion defaults to true, so pass false to offer literal characters.',
          },
          suggest: {
            type: 'boolean',
            description:
              'Propose the change instead of applying it. Returns { suggestionId } instead of ok:true. The offered text parses inline markdown unless parseInlineMarks is false.',
          },
        },
        required: ['workspaceId', 'docId', 'find', 'replace'],
      },
    },
    {
      name: 'rewrite_thread_region',
      description:
        'Rewrite the text a thread is anchored to. Use it for comment-driven edits. The anchor resolves at apply time, so a concurrent edit does not break it. It returns anchor-orphaned when the text is gone; find_and_replace is the fallback. With suggest, replacement parses inline markdown unless parseInlineMarks is false.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          threadId: { type: 'string' },
          replacement: { type: 'string' },
          parseInlineMarks: {
            type: 'boolean',
            description:
              'Read inline markdown in replacement as marks: links, speaker tags, bold, italic, code and strikethrough. A direct edit defaults to false. A suggestion defaults to true, so pass false to offer literal characters.',
          },
          suggest: {
            type: 'boolean',
            description:
              'Propose the rewrite instead of applying it. Returns { suggestionId } instead of ok:true. The offered text parses inline markdown unless parseInlineMarks is false.',
          },
        },
        required: ['workspaceId', 'docId', 'threadId', 'replacement'],
      },
    },
    {
      name: 'list_suggestions',
      description:
        'List every pending suggestion on a doc, from any author, in doc order. Use it to find a sid before you accept or reject, or to check whether your own proposal is still pending.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
        },
        required: ['workspaceId', 'docId'],
      },
    },
    {
      name: 'accept_suggestion',
      description:
        'Accept a pending suggestion by sid. It becomes real content and flushes to disk. A missing sid errors, which is also the answer when somebody else already resolved it.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          sid: { type: 'string' },
        },
        required: ['workspaceId', 'docId', 'sid'],
      },
    },
    {
      name: 'reject_suggestion',
      description:
        'Reject a pending suggestion by sid. It restores the text from before the suggestion: the proposed insert goes, and the proposed deletion stays and loses its mark. A missing sid errors.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          sid: { type: 'string' },
        },
        required: ['workspaceId', 'docId', 'sid'],
      },
    },
    {
      name: 'resolve_all_suggestions',
      description:
        "Accept or reject every pending suggestion on a doc in one call. Pass `authorId` to resolve one author's proposals and leave the rest pending. Returns the count resolved and their sids.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          action: { type: 'string', enum: ['accept', 'reject'] },
          authorId: { type: 'string' },
        },
        required: ['workspaceId', 'docId', 'action'],
      },
    },
    {
      name: 'insert_after_thread',
      description:
        "Insert text at the end of a thread's anchored range. The text stays inline, in the same paragraph or heading, so use it to add a note after a sentence. For a new paragraph or section use insert_blocks_after_thread. The result's `landed` is the doc text read back after the write.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          threadId: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['workspaceId', 'docId', 'threadId', 'text'],
      },
    },
    {
      name: 'insert_blocks_after_thread',
      description:
        "Insert new blocks after the block holding a thread's anchor. It takes markdown, so use it for a new section, paragraph, list, quote or code. insert_after_thread is the inline sibling. An anchor inside a list item nests the new blocks under that item unless you pass placement top-level.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          threadId: { type: 'string' },
          markdown: { type: 'string' },
          placement: {
            type: 'string',
            enum: ['after-block', 'top-level'],
            description:
              "Where to splice. Default 'after-block' inserts after the anchor's innermost block, which nests under a list item when the anchor sits in one. Pass 'top-level' to insert after the whole containing list or table.",
          },
        },
        required: ['workspaceId', 'docId', 'threadId', 'markdown'],
      },
    },
    {
      name: 'create_anchor',
      description:
        'Mint a private anchor at a text location and get back its id. The anchor survives concurrent edits, so you can pin several places now and rewrite each one later. Same disambiguation as find_and_replace.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          find: { type: 'string' },
          contextBefore: { type: 'string' },
          contextAfter: { type: 'string' },
          occurrence: { type: 'number' },
          label: { type: 'string' },
        },
        required: ['workspaceId', 'docId', 'find'],
      },
    },
    {
      name: 'edit_at_anchor',
      description:
        "Apply an inline edit at an anchor, replacing the anchored range or inserting after it. The text stays inside the anchor's block, so use it for prose. For a heading, paragraph, list or table use insert_blocks_at_anchor, which parses the markdown.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          anchorId: { type: 'string' },
          op: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['replace', 'insert_after'] },
              text: { type: 'string' },
            },
            required: ['kind', 'text'],
          },
        },
        required: ['workspaceId', 'docId', 'anchorId', 'op'],
      },
    },
    {
      name: 'read_doc_outline',
      description:
        "Read the doc's blocks with the id of each, the address an edit sends back. Read it before apply_block_edits: a text address moves under a doc somebody else is typing in, and a block id does not. Each entry carries the block's text, its nearest heading, and which agent wrote it. A block still marked yours is one no person has touched, and the only kind you may replace outright.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          headingsOnly: {
            type: 'boolean',
            description: 'Return only the headings, the outline you pick an insertion point from.',
          },
          recentBlocks: {
            type: 'number',
            description:
              'Cap on non-heading entries, counted from the END of the doc. Headings are never dropped, so the shape of the doc survives the cap.',
          },
        },
        required: ['workspaceId', 'docId'],
      },
    },
    {
      name: 'apply_block_edits',
      description:
        'Apply several block-addressed edits as ONE transaction. Use it for more than one change: separate calls can leave half of them applied. Address blocks by the ids read_doc_outline returned, never by quoting text. Replacing or deleting a block no longer marked yours returns it as a suggestion. Markdown in each edit is parsed either way.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          edits: {
            type: 'array',
            description: 'Up to 50 edits, applied in order inside one transaction.',
            items: {
              type: 'object',
              properties: {
                op: {
                  type: 'string',
                  enum: ['insert_under_heading', 'insert_at_end', 'replace_block', 'delete_block'],
                },
                headingId: { type: 'string', description: 'insert_under_heading only.' },
                blockId: {
                  type: 'string',
                  description:
                    'replace_block and delete_block only. Use an id from read_doc_outline.',
                },
                markdown: {
                  type: 'string',
                  description: 'The new block or blocks, for every op but delete_block.',
                },
              },
              required: ['op'],
            },
          },
        },
        required: ['workspaceId', 'docId', 'edits'],
      },
    },
    {
      name: 'insert_blocks_under_heading',
      description:
        "Append markdown blocks at the END of a heading's section. It addresses the section by heading id, not by wording, so a renamed heading still receives the text. Get headingId from read_doc_outline. Use apply_block_edits instead when you make more than one change. New blocks are marked as yours until a person types in one.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          headingId: {
            type: 'string',
            description: 'The id of the heading whose section to append to, from read_doc_outline.',
          },
          markdown: { type: 'string' },
        },
        required: ['workspaceId', 'docId', 'headingId', 'markdown'],
      },
    },
    {
      name: 'insert_blocks_at_anchor',
      description:
        'Parse markdown and insert the resulting blocks after the block holding an anchor. Use it for a new section, sub-heading or table, which edit_at_anchor cannot make. An anchor inside a list item nests the blocks under that item unless you pass placement top-level.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          anchorId: { type: 'string' },
          markdown: { type: 'string' },
          placement: {
            type: 'string',
            enum: ['after-block', 'top-level'],
            description:
              "Where to splice. Default 'after-block' inserts after the anchor's innermost block, which nests under a list item when the anchor sits in one. Pass 'top-level' to insert after the whole containing list or table.",
          },
        },
        required: ['workspaceId', 'docId', 'anchorId', 'markdown'],
      },
    },
    {
      name: 'delete_anchor',
      description: 'Remove an anchor you created. Use it to clean up between tasks.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          anchorId: { type: 'string' },
        },
        required: ['workspaceId', 'docId', 'anchorId'],
      },
    },
    {
      name: 'delete_block_at_anchor',
      description:
        "Delete the whole block an anchor points at. An empty find_and_replace only empties a block's text and leaves the empty block rendering. For an anchor inside a list item or table cell, only the innermost block goes. For a whole list or section use delete_blocks_in_range or delete_section.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          threadId: { type: 'string' },
          anchorId: { type: 'string' },
        },
        required: ['workspaceId', 'docId'],
      },
    },
    {
      name: 'delete_blocks_in_range',
      description:
        'Delete every top-level block from the one holding startFind through the one holding endFind. A partial match removes the whole containing block. Use it for trailing cruft or a span no heading bounds. For a section use delete_section, which is heading-aware.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          startFind: { type: 'string' },
          endFind: { type: 'string' },
          contextBefore: { type: 'string' },
          contextAfter: { type: 'string' },
          startOccurrence: { type: 'number' },
          endOccurrence: { type: 'number' },
        },
        required: ['workspaceId', 'docId', 'startFind', 'endFind'],
      },
    },
    {
      name: 'delete_section',
      description:
        'Delete a heading and everything under it, down to the next heading at the same level or above. Pass level or occurrence when the heading text repeats. Returns the heading that ended the run, so you can confirm what was kept.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          docId: { type: 'string' },
          heading: { type: 'string' },
          level: { type: 'number' },
          occurrence: { type: 'number' },
        },
        required: ['workspaceId', 'docId', 'heading'],
      },
    },
    {
      name: 'observe_url',
      description:
        'Return the SSE URL that streams live thread events for a doc. Use it from a long-running agent.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
        },
        required: ['docId'],
      },
    },
    {
      name: 'watch_doc',
      description:
        "Subscribe this session to a doc's comment events, delivered as channel messages. Most docId-bearing tools subscribe you already, and set_workspace_lead covers every doc on your board. Use it for a doc you have not otherwise touched, such as a peer's review you only want to observe. `persisted: false` means a restart drops the subscription.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
        },
        required: ['docId'],
      },
    },
    {
      name: 'unwatch_doc',
      description:
        'Stop pushing channel events for this doc, and forget it on the server so a respawn does not bring it back.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
        },
        required: ['docId'],
      },
    },
    {
      name: 'list_watched_docs',
      description:
        'List what this session is subscribed to, and what it is missing. coverage.unattachedBoards names the boards you follow but are not live on, with what is queued for their lead and the remedy for each. restore.status tells an empty list apart from a failed restore. An absent coverage means unknown, not all-clear.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'share_workspace',
      description:
        'Mint a share link for a board. Anyone you send it to signs in once with their email, and is a member of that board from then on. A board is the unit of sharing, and a review id is refused. Everything filed on the board travels with the share, so check what else is there. Returns a share.<domain>/s/<id> URL.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board to share, the id create_workspace returned. A review or attachment-set id is refused.',
          },
          ttlSeconds: {
            type: 'number',
            description:
              'Optional lifetime in seconds. Omit it for a link with no expiry, which is the default.',
          },
          label: { type: 'string', description: 'Human label shown in list_shares.' },
          allowDomains: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Accepted and IGNORED, so that an older caller is not refused. Anyone who opens the link and signs in becomes a member.',
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'remove_share_member',
      description:
        "End one person's access to a board they joined through a share link. Their next request is refused, and any live editing socket or event stream that membership opened is hung up. Membership is per board, so their access to another board is untouched. unshare only stops new people redeeming the link. list_shares names every member.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'The board to remove them from.' },
          email: { type: 'string', description: 'The address to remove, as list_shares shows it.' },
        },
        required: ['workspaceId', 'email'],
      },
    },
    {
      name: 'set_share_ttl',
      description:
        'Extend or shorten a live share. `ttlSeconds` is measured from now, so 3600 expires the link one hour from this call. It takes effect immediately, and an open browser is refused on its next request once the share lapses.',
      inputSchema: {
        type: 'object',
        properties: {
          shareId: { type: 'string' },
          ttlSeconds: { type: 'number' },
        },
        required: ['shareId', 'ttlSeconds'],
      },
    },
    {
      name: 'list_shares',
      description:
        'List every share of every board: the links, who redeemed each one and when, and whether each one is live, revoked or expired.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'unshare',
      description:
        'Revoke a share by id. For a share link this stops anyone NEW redeeming it, and leaves the people who already joined as members, so use remove_share_member to eject somebody. Use it for an early teardown. A link with a TTL lapses on its own, and one without never does.',
      inputSchema: {
        type: 'object',
        properties: {
          shareId: { type: 'string' },
        },
        required: ['shareId'],
      },
    },
    {
      name: 'set_sharing_enabled',
      description:
        'Master switch for all external access. Off makes every share and link answer 403, and hangs up the open connections of share visitors and share-link members. Existing shares are preserved and resume when it is on again. The local and tailnet surface is unaffected. Call it with no argument to read the current state.',
      inputSchema: {
        type: 'object',
        properties: {
          enabled: {
            type: 'boolean',
            description: 'Omit to read the current state without changing it.',
          },
        },
      },
    },
    {
      name: 'create_workspace',
      description:
        'Create a board: its goals, its tasks, and the docs and attachments filed on it, opened at /workspaces/<id>. You become its lead agent unless you pass leadAgentId. A board starts with no goals, so write them with set_goal_list.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short handle, e.g. "search-revamp".' },
          leadAgentId: {
            type: 'string',
            description:
              'The agent responsible for this board. Defaults to your own identity. Pass another only when you set a board up for someone else.',
          },
          subscribe: { type: 'boolean' },
        },
        required: ['name'],
      },
    },
    {
      name: 'rename_workspace',
      description:
        "Change a board's name. The id, the URL and the tasks do not move, so every existing link keeps working. A name another live board already holds is allowed, and the response names the collision in sameName.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'Board workspace id.' },
          name: { type: 'string', description: 'The new name. Trimmed, and may not be empty.' },
        },
        required: ['workspaceId', 'name'],
      },
    },
    {
      name: 'archive_workspace',
      description:
        'Stand a board down reversibly, when it is superseded, finished or a duplicate. It stops ranking, refuses new tasks, and tells a reader why. It destroys nothing, and unretire_workspace reverses it. Prefer it to delete_workspace, which cannot be undone. Pass a reason, which is replayed in every refusal.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'Board workspace id.' },
          reason: {
            type: 'string',
            description:
              'Why, in one line. Every agent that reaches the retired board reads it, so name the board that replaced it.',
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'unretire_workspace',
      description:
        'Bring a retired board back. It ranks again, takes new work again, and stops warning readers.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'Board workspace id.' },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'set_workspace_lead',
      description:
        'Declare yourself lead of a board. One call at session start routes everything on it to you: task, decision and thread events on every doc filed there, plus voice notes. It also drains whatever queued while the seat was empty. Delivery is gated on the server having observed you recently, so call heartbeat and check list_watched_docs. Pass leadAgentId to hand the board to somebody else.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'Board workspace id from create_workspace.' },
          leadAgentId: {
            type: 'string',
            description:
              'The agent id taking responsibility. Omit it to declare yourself, which is the only form that also attaches and subscribes you. Naming another agent hands the seat over and does nothing else.',
          },
          takeover: {
            type: 'boolean',
            description:
              'Take the seat from a live agent that holds it. It evicts them silently and reroutes every lead-addressed delivery, so coordinate first. Default false, which returns `declined: "lead-held"` naming the incumbent. You stay attached either way.',
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'attach_doc',
      description:
        "File an existing doc, diff review or folder bind onto a board, so its open comment threads reach that board's Home queue. It is a link only, so the doc keeps its own URL and nothing moves. docId also takes a review id, which attaches the whole review as one unit. Idempotent.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'Board workspace id from create_workspace.' },
          docId: { type: 'string', description: 'Doc id, or a diff-review or folder-bind id.' },
        },
        required: ['workspaceId', 'docId'],
      },
    },
    {
      name: 'create_tasks',
      description:
        'File work on a board. This is the only create verb. It always takes a list, so one task is a one-item list. Omit assignee and you own it. Omit goal and it lands unplaced in Backlog. New tasks stay in triage until task_transition releases them. A bad task returns in failures by index, not rejecting the batch. `held: true` means it waits off the queue until revise_review_item closes `heldReason`.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          tasks: {
            type: 'array',
            description:
              'The tasks, at most 100. A larger batch is refused whole, and belongs in import_tasks_markdown. `title` is the only required field. `key` labels a task so a later task in the same batch can reference it. Tasks are created in order, so a task can only depend on one above it.',
            // The row contract used to live on the single-row create verb's
            // declaration, and `tasks` merely pointed at it. Removing that
            // tool would have removed every field description with it — the
            // schema would still validate and an agent would have nothing
            // left to read about what a row owes. Moved here rather than
            // deleted. (The verb is not named here on purpose: the absence
            // test in create-tasks-tool.test.ts scans this source too, and a
            // comment is exactly the kind of mention that keeps a removal
            // from being a removal.)
            items: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description:
                    'One line naming the work, in the form `<persona> can <do x> so that <goal y>`. One persona: Agent, Bryan or Collaborator. 20 words or fewer. State an outcome rather than an observation, so a column of tasks can be ranked.',
                },
                body: {
                  type: 'string',
                  description:
                    'What the task is for, as a compact user story, plus "done when" criteria for anything you hand over or park. Markdown, and next_tasks returns it whole. On a `needs: \'decision\'` task the body must carry the question, the stakes and what each option costs, or it is refused.',
                },
                key: {
                  type: 'string',
                  description:
                    'An optional label THIS batch uses to reference the task from a later task\'s `after` or `afterEnforce`. Unique within the batch, not all digits, and must not start with "#". It means nothing outside this call.',
                },
                assignee: {
                  type: 'string',
                  description:
                    "Who owns this task: 'human', or a named person or agent. Omit it and you own it. The bare word 'agent' is refused, and that refusal means the session was launched without CW_AGENT_NAME.",
                },
                assigneeKind: {
                  type: 'string',
                  enum: ['person', 'agent'],
                  description:
                    "'person' or 'agent'. Say which whenever `assignee` is a name that is not your own, because the board does not guess and shows an undeclared owner as \"not recorded\". Not needed for yourself or for 'human'.",
                },
                needs: {
                  type: 'string',
                  enum: ['action', 'decision'],
                  description:
                    "Only meaningful when assignee is a human. 'decision' makes the task itself one decision, answered verbatim through answer_decision, and it requires a decision-shaped `body`. Use the `review` field for questions answered separately alongside the work.",
                },
                options: {
                  type: 'array',
                  description:
                    "Candidate answers for this task's one decision: [{label, detail?}]. `label` is recorded verbatim when picked, and `detail` is what picking it costs. Two or more. The reader can still write a different answer, so do not pad the list.",
                  items: { type: 'object' },
                },
                review: NEW_TASK_REVIEW_ITEM_SCHEMA,
                goal: {
                  type: 'string',
                  description:
                    'Goal id, or "chores". OMIT it to leave the task unplaced at the bottom of Backlog for the lead to place. An explicit goal, even "chores", is a placement.',
                },
                order: { type: 'number', description: 'Fractional position within the goal.' },
                after: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'What this task waits on. An existing task id, a task in THIS batch by index (`0`), or another task\'s `key` (`"#seed"`).',
                },
                afterEnforce: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Subset of `after` that hard-blocks transitions while open. Every entry must also appear in `after`, or the task is refused.',
                },
                dueAt: {
                  type: 'number',
                  description: 'Epoch ms. Optional at every level. Never invent one.',
                },
                links: {
                  type: 'array',
                  description:
                    "Refs this task mentions: {kind:'doc',docId} | {kind:'thread',docId,threadId} | {kind:'task',taskId} | {kind:'diff',workspaceId} | {kind:'url',url}. Use `url` for anything outside this server, http(s) only. A malformed ref lands in `ignoredLinks` and does not fail the task.",
                  items: { type: 'object' },
                },
                quote: {
                  type: 'string',
                  description:
                    "The person's VERBATIM words, for an ask that came from chat, kept on the task. For a thread-born ask use spin_off_task, which captures the quote itself.",
                },
                doneWhen: {
                  type: 'array',
                  description:
                    'What has to be true before this task is done, one outcome per entry: [{text}]. It is a FIELD, not prose in the body — the task will not move to done until every line is reported met, and reports it back a line at a time through report_done_when. Write each line so a reader can check it without asking you: name what is measured and where they read it. At most 50.',
                  items: { type: 'object' },
                },
              },
              required: ['title'],
            },
            maxItems: 100,
          },
          sourceDoc: {
            type: 'object',
            description:
              "The doc these tasks were derived from, which gives every task a structured origin ref back to it. `mode` says what kind of doc it is. 'plan', the default for an ordinary doc, files the tasks as DRAFTS, held in triage until a person approves the plan on the doc page. 'discussion', the default for meeting notes, files them live. A later doc edit flags still-open derived tasks as stale.",
            properties: {
              docId: { type: 'string' },
              mode: { type: 'string', enum: ['plan', 'discussion'] },
            },
            required: ['docId'],
          },
        },
        required: ['workspaceId', 'tasks'],
      },
    },
    {
      name: 'spin_off_task',
      description:
        'Turn a comment thread into a task. It captures the backlink and the latest human comment as the verbatim quote, and drafts a title and body when you do not supply them. Use create_tasks for an ask that did not come from a thread.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          threadId: { type: 'string' },
          workspaceId: { type: 'string', description: 'Board workspace the task lands in.' },
          title: {
            type: 'string',
            description:
              'Override the drafted title. Worth sending, because the draft clips a comment and names what was said rather than what will be done. Use `<persona> can <do x> so that <goal y>`, 20 words or fewer.',
          },
          body: { type: 'string', description: 'Override the drafted body.' },
          assignee: {
            type: 'string',
            description:
              "Who owns it. Omit it and you do, the same rule as a create_tasks entry's assignee.",
          },
          assigneeKind: {
            type: 'string',
            enum: ['person', 'agent'],
            description:
              "'person' or 'agent'. Say which whenever `assignee` is a name that is not your own, because the board does not guess and shows an undeclared owner as \"not recorded\". Not needed for yourself or for 'human'.",
          },
          needs: { type: 'string', enum: ['action', 'decision'] },
          goal: { type: 'string', description: 'Goal id. OMIT to route through triage.' },
          dueAt: { type: 'number' },
          links: { type: 'array', items: { type: 'object' } },
        },
        required: ['docId', 'threadId', 'workspaceId'],
      },
    },
    {
      name: 'set_review_item_criteria',
      description:
        "Set what this board's quality gate judges a review item against. The judge reads this prompt verbatim before each add_review_item and revise_review_item. Omit `criteria`, or pass an empty string, to restore the default. get_workspace shows the current text.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          reviewItemId: {
            type: 'string',
            description:
              'Instead of workspaceId: any review item id, addressing the board that judges that item.',
          },
          criteria: {
            type: 'string',
            description:
              'The criteria, as prose the judge reads. Up to 4,000 characters. Omit it to restore the default.',
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'get_workspace',
      description:
        "Read a board's goals in priority order, with per-goal task counts and the parallelism cap. The first goal is the highest band. Call it before deciding what to work on, because list_tasks returns goal ids only. Pair it with next_tasks, which carries the tasks themselves.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'find_related_work',
      description:
        'Ask what on this board already covers a request, before you write a plan or create a goal. It returns the goals and plan docs that line up, each with a score, a one-line reason and a relative link. Nothing matching gives an empty list. It costs no model call. When something comes back, file one decision review item (extend, replace or new) and wait for the answer.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          text: {
            type: 'string',
            description:
              'The request in the words it was asked in. Scoring does not depend on length, so paste the whole ask rather than a keyword.',
          },
          docId: {
            type: 'string',
            description:
              'The doc the request came out of, such as meeting notes or a thread. A goal that already links that doc is returned even when its title shares no word with the request.',
          },
          limit: { type: 'number', description: 'How many matches to return. Default 5, max 20.' },
        },
        required: ['workspaceId', 'text'],
      },
    },
    {
      name: 'next_tasks',
      description:
        "The work queue: what to pick up next, in priority order, filtered to what you can do. Take the whole ready set, not just the first task. Skip a task whose claimedBy is an active session that is not you. The todo tasks are trimmed to the board's free parallelism slots, and `capacity` names the cap, the slots in use, and the ready tasks held back.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          assignee: { type: 'string', description: 'Usually your own agent name.' },
          limit: { type: 'number' },
          includeBlocked: {
            type: 'boolean',
            description: 'Include tasks held by an enforced open dependency.',
          },
          includeArchived: {
            type: 'boolean',
            description:
              'Include soft-deleted tasks. Default false, and leave it false here, because an archived task is one somebody decided will not happen. Use list_tasks with this flag to FIND archived tasks.',
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'list_tasks',
      description:
        "List a board's tasks, filtered by goal, status, assignee or needs. Tasks come back trimmed, with no body and no transition history. Pass fields to narrow further, because the default shape runs large on a big board. Archived tasks need includeArchived: true.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          goal: { type: 'string' },
          status: {
            type: 'string',
            enum: [...TASK_STATUSES],
            description:
              'status:"triage" enumerates the tasks an agent filed that nobody has vetted. next_tasks never returns them, so this filter is the only way to find them.',
          },
          assignee: { type: 'string' },
          needs: { type: 'string', enum: ['action', 'decision'] },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Project each task to these keys, with `id` always included. Use it for board-wide sweeps, so that heavy fields such as reviews, infoRequests and options do not overflow the result.',
          },
          includeArchived: {
            type: 'boolean',
            description:
              'Include soft-deleted tasks, which are hidden by default. Each one carries `archivedAt`, `archivedBy` and `archiveReason`, so this is the read behind "what did we archive, and why". unarchive_task puts one back.',
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'task_transition',
      description:
        'The single gate for status changes (triage, todo, in-progress, done). It is the only way to clear a triage task. `taskId` also takes a GOAL id. A goal in triage holds every task under it out of next_tasks, so move the goal to `todo` to release the band. Say what you did in `note`, which is the whole of what the trail keeps. Re-sending the same status is refused.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          taskId: { type: 'string' },
          to: { type: 'string', enum: [...TASK_STATUSES] },
          note: { type: 'string' },
          usage: {
            type: 'object',
            properties: {
              inputTokens: { type: 'number' },
              outputTokens: { type: 'number' },
            },
          },
        },
        required: ['workspaceId', 'taskId', 'to'],
      },
    },
    {
      name: 'assign_task',
      description:
        "Hand a task to somebody: 'human', a person, or an agent's name. Use it as soon as you find a task is not yours to finish, because an unassigned blocker reads as work in flight. The bare word 'agent' is refused. Status is untouched.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          taskId: { type: 'string' },
          assignee: {
            type: 'string',
            description:
              "'human', a person's name, or an agent's name (yours comes from CW_AGENT_NAME). The bare word 'agent' is refused.",
          },
          assigneeKind: {
            type: 'string',
            enum: ['person', 'agent'],
            description:
              "'person' or 'agent'. Say which whenever `assignee` is a name that is not your own, because the board does not guess and shows an undeclared owner as \"not recorded\". Not needed for yourself or for 'human'.",
          },
        },
        required: ['workspaceId', 'taskId', 'assignee'],
      },
    },
    {
      name: 'block_task',
      description:
        'Name the tasks that have to close before this one starts. The task reads as Blocked from that moment, leaves next_tasks and the stall check, and comes free when the last blocker closes. It adds to whatever the task already waits on, and set_task_dependencies removes an edge. A task waiting on a PERSON is not blocked: leave it in-progress and file the ask with add_review_item.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          taskId: { type: 'string' },
          blockedBy: {
            description:
              'The task id, or ids, this task waits on. Each must be a task on the same board, and an unknown id is refused rather than recorded.',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
        },
        required: ['workspaceId', 'taskId', 'blockedBy'],
      },
    },
    {
      name: 'archive_task',
      description:
        'Take a task off the board without destroying it. This is the soft delete, and the only removal a task has. Use it for a duplicate, a task the goal moved past, or a capture that turned out not to be work. unarchive_task reverses it. Archiving is not completing: when the work happened, use done.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          taskId: { type: 'string' },
          reason: {
            type: 'string',
            description:
              'Why, in one line, for example "duplicate of the index task". Capped at 200 characters. Optional, and the task is archived either way.',
          },
        },
        required: ['workspaceId', 'taskId'],
      },
    },
    {
      name: 'unarchive_task',
      description:
        'Put an archived task back. It rejoins its band at the position, status and owner it had. Find archived tasks with list_tasks(includeArchived: true). A task that was not archived answers changed: false rather than erroring.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          taskId: { type: 'string' },
        },
        required: ['workspaceId', 'taskId'],
      },
    },
    {
      name: 'rewrite_task',
      description:
        "Rewrite a task's title, body, or both, with a reason that rides the audit trail. Body is a whole-body replace, so send the full markdown. The task's original words are preserved and quoted automatically. When the words are a person's deliberate phrasing, ask on the task instead of replacing them.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          taskId: { type: 'string' },
          title: {
            type: 'string',
            description:
              'The new one-line name. Omit it to keep the current one. Aim for `<persona> can <do x> so that <goal y>`, one persona, 20 words or fewer.',
          },
          body: {
            type: 'string',
            description:
              'The FULL new description, replacing what is there. Omit it to leave the body alone. Open with the user story, keep it readable on a phone, and state a falsifiable done-when.',
          },
          doneWhen: {
            type: 'array',
            description:
              "The WHOLE done-when list, replacing what is there: [{id?, text}]. Omit it to leave the list alone; send [] to clear it. Keep a line's `id` to keep its verdict and its proof — editing the words of a line you already proved is not a retraction. A line you leave out is removed.",
            items: { type: 'object' },
          },
          reason: {
            type: 'string',
            description:
              'Why you are rewriting, in one line, for example "title named the artifact, not the outcome". It is recorded on the audit entry and shown in the activity feed.',
          },
        },
        required: ['workspaceId', 'taskId', 'reason'],
      },
    },
    {
      name: 'report_done_when',
      description:
        "Say what you found against a task's done-when lines. Report the lines you have something to say about; the ones you leave out keep the verdict they had. `met` needs at least one proof and is refused without it, naming the line. When the last open line goes to `met` the board moves the task to done itself and records which line closed it — so there is no separate transition to make. Use `owner` for a line only a person can judge; they get two buttons on the task and you do not wait on a tool.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          taskId: { type: 'string' },
          lines: {
            type: 'array',
            description:
              "One entry per line you are reporting: {id, verdict, proof?}. `id` is the line id the task carries. `verdict` is 'met' (you checked it and it holds), 'not-met' (you checked it and it does not), 'unchecked' (you could not check it — say why in a proof) or 'owner' (only a person can judge it). `proof` is [{text, url?}]: what you ran or read, and where a reader sees it for themselves. Every entry is validated before anything is written, so a bad entry writes nothing.",
            items: { type: 'object' },
          },
        },
        required: ['workspaceId', 'taskId', 'lines'],
      },
    },
    {
      name: 'set_task_goal',
      description:
        'Place a task under a goal at an exact position. `position` is fractional, so there is always room between two tasks. Omit it for the bottom of the band. Every move is recorded, so regroup freely. When your move crosses a placement a person made, say why in a comment on the task.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          taskId: { type: 'string' },
          goal: { type: 'string', description: 'Goal id, or "chores".' },
          position: { type: 'number' },
          batchId: {
            type: 'string',
            description:
              'Echo the batchId from the `workspace.goals_changed` event this placement answers. It ties the move to the goal edit that prompted it, so the activity view reads many moves as one edit.',
          },
        },
        required: ['workspaceId', 'taskId', 'goal'],
      },
    },
    {
      name: 'set_goal_list',
      description:
        "Add or remove a goal by submitting the board's whole ordered list. An entry with no id adds a band. A new band starts in `triage`, and nothing under it is dispatched until task_transition moves the goal to `todo`. This is a full replace, so any id you leave out is removed. Removing a band that still holds tasks is refused until you name it in drop.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          goals: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  description:
                    'Omit it to create this band, and the server returns the minted id in `created`. Goal ids are generated and permanent. Include it, exactly as get_workspace reports it, to keep a band you already have. An id this board does not hold is refused as `unknown-goal-id`.',
                },
                title: { type: 'string' },
                dueAt: { type: 'number' },
              },
              required: ['title'],
            },
          },
          drop: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Goal ids you intend to remove even though they still hold tasks. It turns the refusal into the removal, so read what the refusal said each band holds first. An id that is not being removed is ignored.',
          },
        },
        required: ['workspaceId', 'goals'],
      },
    },
    {
      name: 'rename_goal',
      description:
        "Change a goal's title in place, by id. The id never moves, so no task moves. Use it rather than set_goal_list, which would make you restate every other band. `dueAt` is optional: a number sets it, null clears it, and omitting it leaves it alone.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          goal: {
            type: 'string',
            description: 'The goal id to retitle. Get it from get_workspace.',
          },
          title: { type: 'string' },
          dueAt: {
            type: ['number', 'null'],
            description: 'Epoch ms to set, null to clear, omit to leave unchanged.',
          },
        },
        required: ['workspaceId', 'goal', 'title'],
      },
    },
    {
      name: 'reorder_goals',
      description:
        "Change the priority order of a board's goals, because order is priority. Permutation only: `order` must be exactly the ids the board already holds, so nothing is created, renamed or lost. Take the ids from get_workspace and send every goal whose reorderable is true.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          order: {
            type: 'array',
            items: { type: 'string' },
            description:
              'EVERY reorderable goal id, in the new priority order, highest first. Leaving one out is an error, not a demotion. Including a non-reorderable goal, such as Backlog, is an error too.',
          },
        },
        required: ['workspaceId', 'order'],
      },
    },
    {
      name: 'add_review_item',
      description:
        "Hang a question on a task that already exists, so the ask stays attached to the work. A task carries several at once, each answered on its own, so the task title keeps naming the work. When you file work and question together, use `review` on a create_tasks entry. Every item passes the board's quality gate: `held: true` means it is OFF the reader's queue until revise_review_item closes `heldReason`.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          taskId: { type: 'string', description: 'The task the question hangs on.' },
          review: TASK_REVIEW_ITEM_SCHEMA,
        },
        required: ['workspaceId', 'taskId', 'review'],
      },
    },
    {
      name: 'answer_review_item',
      description:
        "Record a person's verbatim answer to one review item on their behalf, for when they told you in chat or voice. Pass their exact words, never a paraphrase. reviewItemId keeps several open questions on one task independently answerable. It does not transition the task, so close that with task_transition once you have acted on the returned links.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          taskId: { type: 'string' },
          reviewItemId: {
            type: 'string',
            description:
              "Which item is being answered, from list_tasks, the task's `reviews`, or any queue row. Alone, with no taskId, it addresses the item wherever it lives, a doc-thread item included. Omit it on a task that is itself a decision, and the answer lands on that decision.",
          },
          text: { type: 'string', description: "The human's verbatim answer." },
          answeredWith: {
            type: 'string',
            description:
              "The id of the option they picked, if they picked one. The answer is still `text`, so pass the option's label as the text. Omit it when they answered in their own words.",
          },
        },
        required: ['workspaceId', 'text'],
      },
    },
    {
      name: 'request_more_info',
      description:
        "Ask a question BACK at a review item instead of answering it, on the person's behalf. The item stays open and stays counted on the queue, and the agent that raised it owes the context. It is what keeps a set of options from being a closed set.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          taskId: { type: 'string' },
          reviewItemId: {
            type: 'string',
            description:
              'Which item is being asked about. Alone, with no taskId, it addresses the item wherever it lives, and on a doc-thread item the question posts as a reply on its thread. Omit it on a task that is itself a decision, the same rule as answer_review_item.',
          },
          question: { type: 'string', description: 'What they want to know, verbatim.' },
        },
        required: ['workspaceId', 'question'],
      },
    },
    {
      name: 'revise_review_item',
      description:
        "Rewrite one of your review items in place, to answer a question asked on it or to fix an item the quality gate held (`held: true`). Pass only the fields that change, and the previous words are kept as history. Address the item on a task, on a task's own decision, or on a doc thread. Half a doc address is refused. Every revision is judged again.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          taskId: {
            type: 'string',
            description:
              "Task form: the task. With reviewItemId it names one of the items filed on it. Alone it names the task's OWN decision.",
          },
          reviewItemId: {
            type: 'string',
            description:
              "Which item to revise. Alone, with no taskId, it addresses the item wherever it lives, a doc-thread item included. With taskId it names one of the items filed on that task. Omit it for the task's own decision, which carries no item id.",
          },
          docId: {
            type: 'string',
            description:
              'Doc-thread form: the doc the thread lives on. Pass it with threadId and commentId.',
          },
          threadId: {
            type: 'string',
            description: 'Doc-thread form: the thread the item was raised on.',
          },
          commentId: {
            type: 'string',
            description:
              'Doc-thread form: the comment carrying the review payload. It is the `thread.comments[].id` that create_thread or post_reply returned when you raised the item.',
          },
          headline: TASK_REVIEW_ITEM_SCHEMA.properties.headline,
          detail: TASK_REVIEW_ITEM_SCHEMA.properties.detail,
          options: TASK_REVIEW_ITEM_SCHEMA.properties.options,
          reply: {
            type: 'string',
            description:
              'A reply on the thread that asked, one or two sentences pointing at what changed. Refused when nobody has asked on this item yet. Task form only, because a doc-thread item already lives in a thread. Use post_reply there.',
          },
          revisedRange: {
            type: 'object',
            description:
              'Which span of the NEW detail changed, as character offsets, for when the diff would not show it well. Omitted, the changed span is derived.',
            properties: { start: { type: 'number' }, end: { type: 'number' } },
            required: ['start', 'end'],
          },
        },
        // No unconditional required list: which ids are required depends on
        // which of the two addresses the caller is using, and the handler
        // refuses a half-written one by name.
        required: ['workspaceId'],
      },
    },
    {
      name: 'withdraw_review_item',
      description:
        "Take back a review item. It leaves the reader's queue and reads as withdrawn, with your reason beside it. Any agent on the board can retire a stale one. Prefer revise_review_item when the question still stands and only its wording is wrong. On a shared thread use this rather than resolve_thread, which retires every item. Refused on an item somebody already answered. `undo: true` puts it back.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          reviewItemId: {
            type: 'string',
            description:
              'The item, by its id, from the queue row, the task, or add_review_item. It addresses either surface, and needs no other id.',
          },
          taskId: {
            type: 'string',
            description:
              'Optional with reviewItemId: the task you already know holds the item, which skips a lookup.',
          },
          docId: { type: 'string', description: 'Doc-thread form: the doc the thread lives on.' },
          threadId: {
            type: 'string',
            description: 'Doc-thread form: the thread the item was raised on.',
          },
          commentId: {
            type: 'string',
            description:
              'Doc-thread form: the comment carrying the review payload. It is the `thread.comments[].id` that create_thread or post_reply returned when you raised the item.',
          },
          reason: {
            type: 'string',
            description:
              'One line on why, shown with the retracted item. "Superseded by the item below" is the difference between a disappearance and a correction.',
          },
          undo: {
            type: 'boolean',
            description: 'Put a withdrawn item back in front of the reader.',
          },
        },
        // Which ids are required depends on which address the caller is
        // using — a bare reviewItemId, or the doc-thread triple — and the
        // handler refuses a half-written one by name.
        required: ['workspaceId'],
      },
    },
    {
      name: 'answer_decision',
      description:
        "Record a person's verbatim answer to a decision task on their behalf, for when they told you in chat or voice. Pass their exact words, never a paraphrase. This answers the task's own decision, and answer_review_item answers one of the items hanging on a task. Neither transitions the task, so close it with task_transition.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          taskId: { type: 'string' },
          text: { type: 'string', description: "The human's verbatim answer." },
          optionId: {
            type: 'string',
            description:
              "The id of the option they picked, if they picked one. The answer is still `text`, so pass the option's label as the text. Omit it when they answered in their own words.",
          },
          reviewItemId: {
            type: 'string',
            description:
              "Which of the task's review items is being answered. Omit it and the answer lands on the task's own decision.",
          },
        },
        required: ['workspaceId', 'taskId', 'text'],
      },
    },
    {
      name: 'set_task_dependencies',
      description:
        'Set what a task waits on after it was created. `after` lists the ids it depends on, and `afterEnforce` is the subset that hard-blocks its transitions. It replaces the whole edge set, so pass the full list. Use it as soon as you find a task waiting on an open decision. That edge is the only record that the decision blocks work.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          taskId: { type: 'string', description: 'The BLOCKED task, the one that waits.' },
          after: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Task ids this task waits on, in full. Each must exist on the same board, and a self-reference is refused.',
          },
          afterEnforce: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Subset of `after` that hard-blocks transitions while open. Every id here MUST also appear in `after`, or the call is refused rather than silently widening `after`.',
          },
        },
        required: ['workspaceId', 'taskId', 'after'],
      },
    },
    {
      name: 'set_task_schedule',
      description:
        "Set, replace or clear the rule that says WHEN a task's work starts. The task files one occurrence per firing, and the scheduler wakes its owner. Check `nextAt` in the reply, because a changed rule restarts from the arm time. This is not a due date, which is when work should finish.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          taskId: { type: 'string', description: 'The task the rule is set on.' },
          rule: {
            description:
              "The rule object, or null to clear. Five kinds. once {kind:'once', at}. every {kind:'every', everyMs}. calendar {kind:'calendar', times:[{hour, minute}], weekdays} where 0 is Sunday and no weekdays means every day. after-completion {kind:'after-completion', delayMs}, measured from the last instance closing. on-change {kind:'on-change', source:{kind:'doc', docId} or {kind:'task', taskId}, debounceMs}. An absent rule is refused rather than read as a clear.",
          },
          timezone: {
            type: 'string',
            description:
              'IANA zone the calendar math runs in, e.g. America/Los_Angeles. Absent reads as UTC.',
          },
          until: {
            type: 'number',
            description: 'Epoch ms after which the rule fires no more.',
          },
          onMissed: {
            type: 'string',
            enum: ['catch-up', 'skip'],
            description:
              "What to do about an occurrence the server missed while down. Absent is catch-up: fire it late. 'skip' waits for the next one.",
          },
        },
        required: ['workspaceId', 'taskId', 'rule'],
      },
    },
    {
      name: 'import_tasks_markdown',
      description:
        'Move a hand-maintained markdown tracker, headings plus status tables, onto a board. It defaults to a dry run that returns the mapping and creates nothing, so review that with the person, then call again with apply: true. Apply stamps the source file with a banner and a link, and a stamped file refuses re-import.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'Board workspace id from create_workspace.' },
          path: { type: 'string', description: 'Absolute path to the tracker .md file.' },
          apply: {
            type: 'boolean',
            description: 'Omit or false = dry-run (the mapping only). true = create + stamp.',
          },
        },
        required: ['workspaceId', 'path'],
      },
    },
    {
      name: 'link_refs',
      description:
        'Link a task to a doc, a thread, another task, a diff review, or a URL. The ref is stored one way and the reverse is computed, so doc and thread payloads grow task chips automatically. Target existence is not checked.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          taskId: { type: 'string' },
          ref: { type: 'object' },
        },
        required: ['workspaceId', 'taskId', 'ref'],
      },
    },
    {
      name: 'unlink_refs',
      description:
        'Remove a stored ref from a task, using the exact ref and the same shapes as link_refs. Idempotent, so `changed: false` means it was not linked. The `origin` ref a promotion recorded cannot be removed.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          taskId: { type: 'string' },
          ref: { type: 'object' },
        },
        required: ['workspaceId', 'taskId', 'ref'],
      },
    },
    {
      name: 'list_backlinks',
      description:
        "Which of THIS BOARD's tasks point at a ref. Paste a pull request or a dashboard link to find what work already cites it before filing a duplicate. It counts a promotion's origin too, so a task promoted from a thread comes back for that thread. Ask each board separately.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          ref: { type: 'object', description: 'The ref to find citers of.' },
        },
        required: ['workspaceId', 'ref'],
      },
    },
    {
      name: 'attach_agent',
      description:
        'Register this session on a board without taking the lead seat. The response briefs you: open gating decisions, the untriaged tasks to shape, and queued voice notes. It subscribes you to board events. Call heartbeat every few minutes, because after about five minutes of silence you show as away. ACT ON `sentry`: call sentry_watch_project on each slug it names and check with sentry_list_my_watches, or a raised alarm reaches nobody here.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          agentId: { type: 'string', description: "Defaults to this agent's MCP identity." },
          runtime: {
            type: 'string',
            enum: ['claude-code-local', 'managed-agent', 'webhook'],
            description: 'Defaults to claude-code-local.',
          },
          capabilities: {
            type: 'array',
            items: { type: 'string' },
            description: "e.g. ['tasks.write', 'docs.edit']",
          },
          subscribe: { type: 'boolean' },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'heartbeat',
      description:
        'Prove this attached session is alive. Call it every few minutes while attached. After about five minutes you show as away, and lead-addressed deliveries only reach sessions the server observed recently. Ordinary tool calls count too, so this matters most during a long stretch of thinking or a long-running command.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          agentId: { type: 'string', description: "Defaults to this agent's MCP identity." },
          toolCallAt: {
            type: 'number',
            description: 'Epoch ms of your last real tool call. Defaults to now.',
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'register_dispatch',
      description:
        "Tell the board a builder is working a task in a private git worktree. The stall loop then reads the worktree's file activity as the task moving. Call it when you spawn a builder. Re-registering the same task replaces the old worktree. Close it with close_dispatch when the builder reaches terminal.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          taskId: { type: 'string', description: 'The task the builder is working.' },
          worktreePath: {
            type: 'string',
            description: "Absolute path to the builder's git worktree on this machine.",
          },
          reason: {
            type: 'string',
            description:
              'Why you are running this task NOW, in one short sentence, such as "next in the goal band" or "unblocked by #863". It is recorded as the moment you decided. Leaving it out costs only the attribution.',
          },
        },
        required: ['workspaceId', 'taskId', 'worktreePath'],
      },
    },
    {
      name: 'close_dispatch',
      description:
        'Close a builder dispatch registered with register_dispatch, once the builder is done or has died. `closed: false` means no dispatch was open for that task, which is safe to ignore.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          taskId: { type: 'string', description: 'The task whose dispatch to close.' },
        },
        required: ['workspaceId', 'taskId'],
      },
    },
    {
      name: 'set_parallelism_cap',
      description:
        'Set how many builders a board may have dispatched at once. Every board starts on the default of 4. Lower it to keep this board from starving higher-priority projects. The change takes effect on the next dispatch, so nothing running is touched and register_dispatch refuses past the new number. The reply carries the cap, the slots in use, the free slots and lastChange. The floor is one.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          cap: {
            type: 'integer',
            minimum: 1,
            description:
              'The new cap: a positive integer. get_workspace shows the current one and the default.',
          },
        },
        required: ['workspaceId', 'cap'],
      },
    },
    {
      name: 'register_worktree',
      description:
        "Tell this machine that a directory is a checkout of a repo it already knows. A document's identity is its repo plus its path from the repo root. A doc opened in a registered checkout is therefore the SAME doc, with the same id and the same comments. Register a worktree when you create it. Machine-scoped: it takes no workspaceId and works only from the box.",
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Absolute path to the checkout, its root or any path inside it. Anything that is not a git checkout is refused rather than recorded.',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'list_worktrees',
      description:
        'Read the repos this machine knows and the checkouts of each: what was registered, when each was last seen, and which ones exist right now. Call it when a doc writes to a copy you did not expect, or before removing a checkout. Machine-scoped: no workspaceId.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'unregister_worktree',
      description:
        'Retire a checkout before it goes away. Any document with unsaved edits in it is written out FIRST, and the answer says how many were flushed. Nothing is destroyed. Every doc keeps its id and its comments, and a doc bound to that checkout falls back to another copy. Call it just before `git worktree remove`. Machine-scoped: no workspaceId.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the checkout being retired.',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'mount_folder',
      description:
        "Mount a subfolder of a project as the project's attachment storage. Every file under it gets ONE address that keeps working. A new version overwrites the old under the same link and keeps its comments. A move to another mounted folder of the same project follows the file. Nothing is copied. Credential-shaped names, such as dotfiles, .env*, *.pem, *.key and id_*, are never listed and never served.",
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Absolute path to the folder. It must be inside a git checkout, because the repo is what gives its files an address that survives a move. A dot-directory is refused.',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'list_mounts',
      description:
        "Read a project's mount table: which folders are mounted, how many files each holds, whether the project is local-only, and where its conventions index lives. Pass `mountId` to page through one mount's files instead. Machine-scoped: no workspaceId.",
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Absolute path anywhere inside the project. Omit to read every project this machine knows.',
          },
          mountId: {
            type: 'string',
            description:
              "One mount's id, to list its files rather than the table. Requires `path`.",
          },
          after: {
            type: 'string',
            description:
              'Page cursor: the `nextAfter` from the previous answer. Files come back sorted by their path from the repo root.',
          },
          limit: {
            type: 'number',
            description: 'Files per page, 1-1000. Defaults to 200.',
          },
        },
      },
    },
    {
      name: 'unmount_folder',
      description:
        'Stop serving a mounted folder. Nothing on disk is touched and no address is dropped. Re-mounting the same folder revives it with every file at the address it already had. Machine-scoped: no workspaceId.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path anywhere inside the project.',
          },
          mountId: {
            type: 'string',
            description: 'The mount to retire, from list_mounts or mount_folder.',
          },
        },
        required: ['path', 'mountId'],
      },
    },
    {
      name: 'set_project_privacy',
      description:
        "Set whether this project's mounted files may leave the machine. It applies to the PROJECT, over all its mounts at once. 'local-only' serves the files to callers on the box alone, not over the tunnel, the tailnet, a share or a collab visitor. 'workspace' is the default and means everyone in the workspace sees them. Machine-scoped: no workspaceId.",
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path anywhere inside the project.',
          },
          privacy: {
            type: 'string',
            enum: ['workspace', 'local-only'],
            description:
              "'local-only' for material that must not leave this machine. 'workspace' otherwise.",
          },
        },
        required: ['path', 'privacy'],
      },
    },
    {
      name: 'set_project_conventions',
      description:
        "Point the project's conventions index at a file. The index is a short note, in the project's own words, saying where plans, meeting notes and other docs go. Agents read it before writing a doc. It defaults to WORKSPACES.md at the repo root. This records WHERE the index is. Write the file itself with your ordinary editing tools.",
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path anywhere inside the project.',
          },
          conventionsPath: {
            type: 'string',
            description:
              'Path to the index from the repo root, e.g. "docs/workspaces.md". No "..", and no dot-directory.',
          },
        },
        required: ['path', 'conventionsPath'],
      },
    },
    {
      name: 'read_project_conventions',
      description:
        "Read the project's conventions index, where it lives and what it says. Call it BEFORE writing a plan, a meeting note or an attachment into a project, so the file lands where that project keeps such things. `text: null` means no index has been written yet, and the answer still names the path.",
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path anywhere inside the project.',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'request_plugin_refresh',
      description:
        "Ask this machine to fetch the newest plugin from the marketplace. Call it when a board's settings panel says sessions are running an older bundle. It requests rather than forces: nothing running is interrupted, and each session picks the new bundle up at its next restart. `changed: false` with matching versions means the cache was already current.",
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_unfiled_ask_count',
      description:
        'Read your own unfiled-ask count, the asks that appeared in your chat with no matching filed review item. Query it at session start or before standing down, and fix anything above zero by filing review items. It is not a live measurement: the number is whatever the daily audit last published. `today: null` and `latest: null` are not innocence.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          agent: {
            type: 'string',
            description: "Display name to read. Defaults to this session's own (CW_AGENT_NAME).",
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'publish_chat_audit',
      description:
        "For the daily chat audit: publish per-agent unfiled-ask counts, so each session can read its own back with get_unfiled_ask_count. Reference these counts in the audit report rather than recomputing them. Publishing again for the same agent supersedes the old row and keeps the history. The bare name 'agent' is refused.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The board this resource is on. get_workspace lists the boards you are attached to.',
          },
          day: { type: 'string', description: 'Audited day, YYYY-MM-DD. Defaults to today.' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                agent: {
                  type: 'string',
                  description: 'Display name (CW_AGENT_NAME) the count belongs to.',
                },
                unfiledAsks: {
                  type: 'number',
                  description:
                    "Asks that appeared in that agent's chat with no matching filed review item.",
                },
                totalAsks: { type: 'number' },
                sessionId: { type: 'string' },
                note: { type: 'string', description: 'Evidence pointer.' },
              },
              required: ['agent', 'unfiledAsks'],
            },
          },
        },
        required: ['workspaceId', 'entries'],
      },
    },
    {
      name: 'list_agents',
      description:
        "List the agents attached to a board with their derived state: active, 'process up, agent unresponsive' (fresh heartbeat, stale tool calls), or 'away, requests queue'. It answers who is where, and whether anyone is wedged.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
        },
        required: ['workspaceId'],
      },
    },
  ],
};
