import { APIError } from 'better-auth/api';
import type { Context, Hono } from 'hono';
import type { AppEnv } from './app.ts';
import { REGISTER_USERS } from './auth.ts';

/**
 * Two routes for registering people without public sign-up:
 *
 * - POST /api/agent-keys: an admin (by session) mints an API key that carries
 *   only the `users:create` permission, for an agent to act on their behalf.
 * - POST /api/users: an admin (by session) or an admin's agent (by that key in
 *   `x-api-key`) registers a plain user. Anyone else is refused.
 *
 * Keys never grant a session (the API-key plugin's session mode stays off),
 * so a key reaches nothing but this route.
 */
export function mountAdminRoutes(app: Hono<AppEnv>): void {
  app.post('/api/agent-keys', async (c) => {
    const admin = await sessionAdmin(c);
    if (!admin) return c.json({ code: 'FORBIDDEN' }, 403);
    const body = await readJson(c);
    const name = typeof body?.name === 'string' ? body.name.slice(0, 64) : 'agent';
    const created = await c.var.auth.api.createApiKey({
      body: { userId: admin.id, name, permissions: REGISTER_USERS },
    });
    // The plaintext key is shown once; only its hash is stored.
    return c.json({ id: created.id, key: created.key }, 201);
  });

  app.post('/api/users', async (c) => {
    const actor = (await sessionAdmin(c)) ?? (await agentOfAdmin(c));
    if (!actor) return c.json({ code: 'FORBIDDEN' }, 403);
    const input = parseNewUser(await readJson(c));
    if (!input) return c.json({ code: 'INVALID_BODY' }, 400);
    // Called without request headers, Better Auth trusts the caller; the
    // checks above are the gate. No role is ever passed: plain users only.
    try {
      const { user } = await c.var.auth.api.createUser({ body: input });
      return c.json({ user: { id: user.id, email: user.email, name: user.name } }, 201);
    } catch (error) {
      // e.g. the address is taken: answer Better Auth's own status and code.
      if (error instanceof APIError)
        return Response.json(error.body ?? {}, { status: error.statusCode });
      throw error;
    }
  });
}

type Ctx = Context<AppEnv>;

async function sessionAdmin(c: Ctx): Promise<{ id: string } | null> {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user.role === 'admin' ? { id: session.user.id } : null;
}

/** The key must carry `users:create` AND belong to someone who is still an admin. */
async function agentOfAdmin(c: Ctx): Promise<{ id: string } | null> {
  const key = c.req.header('x-api-key');
  if (!key) return null;
  const verdict = await c.var.auth.api.verifyApiKey({
    body: { key, permissions: REGISTER_USERS },
  });
  if (!verdict.valid || !verdict.key) return null;
  // Read the owner's role now, not when the key was minted.
  const { internalAdapter } = await c.var.auth.$context;
  const owner = (await internalAdapter.findUserById(verdict.key.referenceId)) as {
    id: string;
    role?: string | null;
  } | null;
  return owner?.role === 'admin' ? { id: owner.id } : null;
}

async function readJson(c: Ctx): Promise<Record<string, unknown> | null> {
  const body: unknown = await c.req.json().catch(() => null);
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
}

interface NewUser {
  email: string;
  name: string;
  password?: string;
}

function parseNewUser(body: Record<string, unknown> | null): NewUser | null {
  const { email, name, password } = body ?? {};
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) {
    return null;
  }
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) return null;
  if (password !== undefined) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) return null;
    return { email, name, password };
  }
  return { email, name };
}
