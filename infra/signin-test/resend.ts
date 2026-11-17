/**
 * The Resend calls a deploy needs, with the full-access key: make the sending
 * domain if it is missing, turn its records into DNS records for Terraform,
 * ask Resend to verify it, and make an app's send-only key. There is no
 * maintained Resend Terraform provider, so each call is idempotent instead:
 * the domain is found by name, the key by its name.
 *
 * The key travels in the Authorization header only. An error names the
 * method, the path and the status, and Resend's own message, never a value.
 */

export type ResendApi = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export function resendApi(key: string, fetcher: typeof fetch = fetch): ResendApi {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetcher(`https://api.resend.com${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => null)) as { message?: unknown } | null;
    if (!res.ok) {
      const why = typeof json?.message === 'string' ? `: ${json.message.slice(0, 200)}` : '';
      throw new Error(`Resend ${method} ${path} failed (${res.status})${why}`);
    }
    return json as T;
  };
}

export interface ResendRecord {
  record: string;
  name: string;
  type: string;
  value: string;
  priority?: number;
}

export interface ResendDomain {
  id: string;
  name: string;
  status: string;
  records: ResendRecord[];
}

/** The sending domain, made in `region` when Resend has none of that name. */
export async function ensureDomain(
  api: ResendApi,
  name: string,
  region = 'us-east-1',
): Promise<{ domain: ResendDomain; created: boolean }> {
  const list = await api<{ data?: { id: string; name: string }[] }>('GET', '/domains');
  const found = (list.data ?? []).find((d) => d.name === name);
  if (found)
    return { domain: await api<ResendDomain>('GET', `/domains/${found.id}`), created: false };
  return { domain: await api<ResendDomain>('POST', '/domains', { name, region }), created: true };
}

/** A DNS record for `apps/signin-test`'s `mail_records`. */
export interface MailRecord {
  key: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
}

const under = (name: string, domain: string) => name === domain || name.endsWith(`.${domain}`);

/**
 * Resend's records as fully qualified DNS records. Resend names a record
 * relative to the zone; a name already qualified is kept. Any record that
 * would land outside the sending domain throws, so the zone's own mail
 * records can never be touched.
 */
export function mailRecordsFor(domain: ResendDomain, zone: string): MailRecord[] {
  if (!under(domain.name, zone) || domain.name === zone) {
    throw new Error(`the sending domain must be a subdomain of ${zone}`);
  }
  const seen = new Map<string, number>();
  return domain.records.map((r) => {
    const raw = r.name.replace(/\.$/, '').toLowerCase();
    // A qualified name is taken as written. An unqualified one is relative to
    // the zone, or, when that falls outside the domain, to the domain.
    let name = raw;
    if (!under(raw, zone)) {
      name = `${raw}.${zone}`;
      if (!under(name, domain.name)) name = `${raw}.${domain.name}`;
    }
    if (!under(name, domain.name)) {
      throw new Error(
        `Resend asked for a ${r.type} record outside ${domain.name}; nothing was changed`,
      );
    }
    const base = `${r.record}-${r.type}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return {
      key: n === 1 ? base : `${base}-${n}`,
      type: r.type.toUpperCase(),
      name,
      content: r.value,
      ...(r.priority === undefined ? {} : { priority: r.priority }),
    };
  });
}

/** Ask Resend to check the records, then wait for `verified`. Returns the last status seen. */
export async function verifyDomain(
  api: ResendApi,
  id: string,
  opts: { sleep: (ms: number) => Promise<void>; timeoutMs: number; intervalMs?: number },
): Promise<string> {
  let status = (await api<ResendDomain>('GET', `/domains/${id}`)).status;
  if (status === 'verified') return status;
  await api('POST', `/domains/${id}/verify`);
  const interval = opts.intervalMs ?? 15_000;
  for (let waited = 0; waited < opts.timeoutMs; waited += interval) {
    await opts.sleep(interval);
    status = (await api<ResendDomain>('GET', `/domains/${id}`)).status;
    if (status === 'verified' || status === 'failed') return status;
  }
  return status;
}

/** A send-only key for one domain. Its token is in the answer to this call alone. */
export async function createSendKey(
  api: ResendApi,
  name: string,
  domainId: string,
): Promise<{ id: string; token: string }> {
  const made = await api<{ id?: unknown; token?: unknown }>('POST', '/api-keys', {
    name,
    permission: 'sending_access',
    domain_id: domainId,
  });
  if (typeof made.id !== 'string' || typeof made.token !== 'string') {
    throw new Error('Resend made a key but returned no id or token');
  }
  return { id: made.id, token: made.token };
}

/** Delete every key called `name` except `keep`, so a re-made key leaves no older one active. */
export async function deleteOtherKeys(api: ResendApi, name: string, keep: string): Promise<number> {
  const list = await api<{ data?: { id: string; name: string }[] }>('GET', '/api-keys');
  const stale = (list.data ?? []).filter((k) => k.name === name && k.id !== keep);
  for (const k of stale) await api('DELETE', `/api-keys/${k.id}`);
  return stale.length;
}
