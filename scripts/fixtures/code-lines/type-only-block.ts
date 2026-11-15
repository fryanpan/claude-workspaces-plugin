/**
 * A fixture for `codeLines` (scripts/coverage.test.ts). It holds six code
 * lines and three type-only declarations; the counter counts the six.
 */
export interface Body {
  docId: string;
  groups?: Array<{ title: string; paths: string[] }>;
  nested: {
    deep: { yes: boolean };
  };
}

export type Answer =
  | { ok: true; id: string; title?: string; groups?: Body['groups'] }
  | { ok: false; error: 'not-found' | 'conflict'; message: string };

type Short = Record<string, never>;

export const handler = (body: Body): Answer => {
  const id = body.docId;
  return { ok: true, id };
};

export const none: Short = {};
export const typeField = { type: 'markdown' };
