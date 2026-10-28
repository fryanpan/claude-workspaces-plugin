/**
 * The Cloudflare API client the deploy scripts share. The token is sent in
 * the Authorization header and nowhere else; an error names the method, the
 * path without its query, the status and Cloudflare's own error codes.
 */
const API = 'https://api.cloudflare.com/client/v4';

interface Envelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
  result_info?: { total_pages?: number };
}

/** The `result` of a Cloudflare answer, or an error naming why there is none. */
export function unwrap<T>(
  method: string,
  path: string,
  status: number,
  json: Envelope<T> | null,
  statusText = '',
): T {
  if (status < 200 || status > 299 || !json?.success) {
    const why = json?.errors?.map((e) => `${e.code} ${e.message}`).join('; ') || statusText;
    throw new Error(`${method} ${path.split('?')[0]} failed (${status}): ${why}`);
  }
  return json.result;
}

export interface CloudflareApi {
  <T>(method: string, path: string, body?: unknown): Promise<T>;
  /** Every page of a GET list. */
  all<T>(path: string): Promise<T[]>;
}

/**
 * `token` is null when the calls go through the keeper (`base` its
 * `/v1/cloudflare`, `fetchImpl` its client), which adds the token itself.
 */
export function cloudflareApi(
  token: string | null,
  opts: { base?: string; fetchImpl?: typeof fetch } = {},
): CloudflareApi {
  const base = opts.base ?? API;
  const doFetch = opts.fetchImpl ?? fetch;
  const send = async <T>(method: string, path: string, body?: unknown) => {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    return { result: unwrap(method, path, res.status, json, res.statusText), json };
  };
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> =>
    (await send<T>(method, path, body)).result;
  api.all = async <T>(path: string): Promise<T[]> => {
    const out: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const { result, json } = await send<T[]>('GET', `${path}${sep}page=${page}&per_page=50`);
      out.push(...result);
      if (page >= (json?.result_info?.total_pages ?? 1)) return out;
    }
    throw new Error(`GET ${path.split('?')[0]} has more than 100 pages`);
  };
  return api;
}
