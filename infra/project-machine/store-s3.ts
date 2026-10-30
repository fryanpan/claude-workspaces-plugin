/**
 * The transcript store's S3 calls, path-style and signed with `sigv4.ts`:
 * object put, get (a version too), delete, list, version list, and the
 * bucket's versioning switch. Bun's S3 client has no version calls, and the
 * proof needs to see each refusal's status, so this is one small client for
 * every store script.
 *
 * No value passed in is ever printed. An error carries the call, the status
 * and the API's error code, never a key or a credential.
 */
import { createHash } from 'node:crypto';
import type { BucketCredential } from './deploy-plan.ts';
import { signRequest } from './sigv4.ts';

const REGION = 'auto';

export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    call: string,
  ) {
    super(`${call}: HTTP ${status}${code ? `: ${code}` : ''}`);
  }
}

export interface ListedObject {
  key: string;
  size: number;
}

export interface ObjectVersion {
  key: string;
  versionId: string;
  isLatest: boolean;
  deleteMarker: boolean;
}

export interface Bucket {
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string, versionId?: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Every live object under `prefix`, in key order, across pages. */
  list(prefix: string): Promise<ListedObject[]>;
  /** Every version and delete marker under `prefix`, newest first per key. */
  listVersions(prefix: string): Promise<ObjectVersion[]>;
  getVersioning(): Promise<'Enabled' | 'Suspended' | 'Off'>;
  enableVersioning(): Promise<void>;
}

function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const value = (xml: string, tag: string): string | undefined =>
  xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];

const unescape = (s: string): string =>
  s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

function blocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1] ?? '');
}

export function s3Bucket(
  cred: BucketCredential,
  bucket: string,
  fetchImpl: typeof fetch = fetch,
): Bucket {
  const base = `${cred.endpoint.replace(/\/$/, '')}/${bucket}`;
  const objectUrl = (key: string) => `${base}/${key.split('/').map(rfc3986).join('/')}`;

  async function call(
    name: string,
    method: string,
    url: string,
    body: Uint8Array | string = '',
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const headers = signRequest({
      method,
      url,
      region: REGION,
      service: 's3',
      headers: {
        'x-amz-content-sha256': createHash('sha256').update(body).digest('hex'),
        ...extra,
      },
      body,
      accessKeyId: cred.accessKeyId,
      secretAccessKey: cred.secretAccessKey,
      now: new Date(),
    });
    const res = await fetchImpl(url, {
      method,
      headers,
      ...(body.length > 0 ? { body: typeof body === 'string' ? body : new Uint8Array(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new S3Error(res.status, value(text, 'Code') ?? '', name);
    }
    return res;
  }

  const query = (params: Record<string, string>) =>
    `${base}?${Object.entries(params)
      .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
      .join('&')}`;

  return {
    async put(key, body) {
      await call('PutObject', 'PUT', objectUrl(key), body, {
        'content-type': 'application/octet-stream',
      });
    },
    async get(key, versionId) {
      const url = versionId ? `${objectUrl(key)}?versionId=${rfc3986(versionId)}` : objectUrl(key);
      const res = await call(versionId ? 'GetObjectVersion' : 'GetObject', 'GET', url);
      return Buffer.from(await res.arrayBuffer());
    },
    async delete(key) {
      await call('DeleteObject', 'DELETE', objectUrl(key));
    },
    async list(prefix) {
      const out: ListedObject[] = [];
      let token: string | undefined;
      for (;;) {
        const params: Record<string, string> = { 'list-type': '2', prefix };
        if (token) params['continuation-token'] = token;
        const text = await (await call('ListObjectsV2', 'GET', query(params))).text();
        for (const c of blocks(text, 'Contents')) {
          out.push({ key: unescape(value(c, 'Key') ?? ''), size: Number(value(c, 'Size') ?? 0) });
        }
        token = value(text, 'NextContinuationToken');
        if (value(text, 'IsTruncated') !== 'true' || !token) return out;
        token = unescape(token);
      }
    },
    async listVersions(prefix) {
      const out: ObjectVersion[] = [];
      let keyMarker: string | undefined;
      let versionMarker: string | undefined;
      for (;;) {
        const params: Record<string, string> = { versions: '', prefix };
        if (keyMarker) params['key-marker'] = keyMarker;
        if (versionMarker) params['version-id-marker'] = versionMarker;
        const text = await (await call('ListObjectVersions', 'GET', query(params))).text();
        for (const m of text.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)) {
          const v = m[2] ?? '';
          out.push({
            key: unescape(value(v, 'Key') ?? ''),
            versionId: value(v, 'VersionId') ?? '',
            isLatest: value(v, 'IsLatest') === 'true',
            deleteMarker: m[1] === 'DeleteMarker',
          });
        }
        if (value(text, 'IsTruncated') !== 'true') return out;
        keyMarker = unescape(value(text, 'NextKeyMarker') ?? '');
        versionMarker = value(text, 'NextVersionIdMarker');
        if (!keyMarker) return out;
      }
    },
    async getVersioning() {
      const text = await (await call('GetBucketVersioning', 'GET', `${base}?versioning=`)).text();
      const status = value(text, 'Status');
      return status === 'Enabled' || status === 'Suspended' ? status : 'Off';
    },
    async enableVersioning() {
      const body =
        '<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>';
      await call('PutBucketVersioning', 'PUT', `${base}?versioning=`, body, {
        'content-md5': createHash('md5').update(body).digest('base64'),
        'content-type': 'application/xml',
      });
    },
  };
}

/** The HTTP status a call ends with: 200 when it succeeds, else the refusal's. */
export async function statusOf(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 200;
  } catch (err) {
    if (err instanceof S3Error) return err.status;
    throw err;
  }
}
