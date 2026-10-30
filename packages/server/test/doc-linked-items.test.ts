/**
 * A doc's JSON record carries the TICKET review items that link the doc, so
 * the doc page's dock can answer them in place — and carries nothing for a
 * doc no open item links, or for a share visitor.
 *
 * Driven through the real route table: file a ticket item whose detail links
 * the doc, read the record the doc page reads at boot, and read `linkedItems`.
 * The link rule itself is `mockup-linked-items.test.ts`'s; this is the door.
 *
 * Fixtures are fictional — Harborlight's tide notes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type AccessHarness, accessHarness, mintAccessShare } from './access-share.ts';
import { signedInPerson } from './signed-in-person.ts';

interface DocRecord {
  meta?: { docId?: string };
  linkedItems?: Array<{ taskId: string; reviewItemId: string; by: string }>;
}

describe("a doc's record and the ticket items that link it", () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let access: AccessHarness;
  let ws = '';
  let taskId = '';
  let linkedDoc = '';
  let unlinkedDoc = '';

  const AGENT = { id: 'agent-riverbend', name: 'Riverbend', kind: 'agent' };
  const READER = { id: 'person:saltmarsh', name: 'Saltmarsh', kind: 'person' };
  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    expect(res.ok, `${path} ${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<Record<string, unknown>>;
  };
  const bindDoc = async (name: string) => {
    const file = join(dataDir, `${name}.md`);
    writeFileSync(file, `# ${name}\n\nThe ebb at the north pier ran past the table.\n`);
    const doc = (await post(`/workspaces/${ws}/docs`, {
      docId: name,
      type: 'markdown',
      sourceUrl: file,
      hubWorkspaceId: ws,
    })) as { docId: string };
    return doc.docId;
  };
  const record = async (docId: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/workspaces/${ws}/docs/${docId}?format=json`, {
      headers: { host: `localhost:${handle.port}`, ...headers },
    });
    return { status: res.status, body: (await res.json()) as DocRecord };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'doc-linked-items-'));
    access = await accessHarness();
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    base = `http://127.0.0.1:${handle.port}`;
    ws = (
      (await post('/workspaces', { name: 'Harborlight', author: AGENT })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    linkedDoc = await bindDoc('tide-notes');
    unlinkedDoc = await bindDoc('dock-schedule');
    taskId = (
      (await post(`/workspaces/${ws}/tasks`, {
        title: 'Pier window',
        assignee: 'Riverbend',
        author: AGENT,
      })) as { task: { id: string } }
    ).task.id;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('carries the item for a member, and nothing on an unlinked doc or for a visitor', async () => {
    const filed = (await post(`/workspaces/${ws}/tasks/${taskId}/review-items`, {
      author: AGENT,
      review: {
        shape: 'decision',
        headline: 'Round the pier window to ten or fifteen minutes?',
        detail: `The [tide notes](/workspaces/${ws}/docs/${linkedDoc}) propose ten.`,
        options: [
          { id: 'o-ten', label: 'Ten minutes' },
          { id: 'o-fifteen', label: 'Fifteen minutes' },
        ],
      },
    })) as { item: { id: string }; held?: boolean };
    if (filed.held) {
      await post(`/workspaces/${ws}/tasks/${taskId}/review-items/${filed.item.id}/release`, {
        author: READER,
      });
    }

    const member = await record(linkedDoc);
    expect(member.status).toBe(200);
    expect(member.body.linkedItems).toEqual([
      expect.objectContaining({ taskId, reviewItemId: filed.item.id, by: 'Riverbend' }),
    ]);
    // A doc no open item links carries no field at all — so no dock.
    const other = await record(unlinkedDoc);
    expect(other.status).toBe(200);
    expect(other.body).not.toHaveProperty('linkedItems');

    // A share visitor reads the same doc WITHOUT it: a ticket's items are not
    // something a share was a grant over.
    const share = await mintAccessShare(base, { ...access, shareLinks: handle.shareLinks }, ws);
    const visitor = await record(linkedDoc, {
      host: share.host,
      'cf-access-jwt-assertion': share.jwt,
    });
    // CONTROL: the visitor really was served the record, so the missing field
    // is about who asked and not about a refusal.
    expect(visitor.status).toBe(200);
    expect(visitor.body.meta).toBeDefined();
    expect(visitor.body).not.toHaveProperty('linkedItems');

    // Answered, it leaves the record on the next read. The reader answers
    // signed in on the board page: a person's answer is recorded only from
    // that person's own proven request.
    const reader = signedInPerson(handle, dataDir, `localhost:${handle.port}`, {
      email: 'saltmarsh@harborlight.example',
      name: READER.name,
    });
    await post(
      `/workspaces/${ws}/tasks/${taskId}/review-items/${filed.item.id}/answer`,
      { author: reader.user, text: 'Ten minutes', answeredWith: 'o-ten' },
      reader.headers,
    );
    expect((await record(linkedDoc)).body).not.toHaveProperty('linkedItems');
  });

  it('carries an owner-only item for the owner, answered in place, and not for a visitor', async () => {
    const filed = (await post(`/workspaces/${ws}/tasks/${taskId}/review-items`, {
      author: AGENT,
      review: {
        shape: 'decision',
        headline: 'Publish the dock schedule to the harbour office?',
        detail: `The [schedule](/workspaces/${ws}/docs/${unlinkedDoc}) is ready.`,
        options: [
          { id: 'o-yes', label: 'Publish' },
          { id: 'o-no', label: 'Hold it' },
        ],
        ownerOnly: true,
      },
    })) as { item: { id: string }; held?: boolean };
    if (filed.held) {
      await post(`/workspaces/${ws}/tasks/${taskId}/review-items/${filed.item.id}/release`, {
        author: READER,
      });
    }
    // The machine's owner, on loopback: answered on the doc page itself.
    const owner = await record(unlinkedDoc);
    expect(owner.body.linkedItems).toEqual([
      expect.objectContaining({ taskId, reviewItemId: filed.item.id }),
    ]);
    expect(owner.body.linkedItems?.[0]).not.toHaveProperty('answerAt');
    const share = await mintAccessShare(base, { ...access, shareLinks: handle.shareLinks }, ws);
    const visitor = await record(unlinkedDoc, {
      host: share.host,
      'cf-access-jwt-assertion': share.jwt,
    });
    expect(visitor.status).toBe(200);
    expect(visitor.body).not.toHaveProperty('linkedItems');
  });
});
