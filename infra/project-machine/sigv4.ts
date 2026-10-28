/**
 * AWS Signature Version 4, for the two calls Bun's S3 client cannot make:
 * Tigris's IAM API (the write-only key) and a bucket's lifecycle rule.
 * Pure: the caller supplies the clock, so the test can use AWS's published
 * example and expect its published signature.
 */
import { createHash, createHmac } from 'node:crypto';

export interface SignInput {
  method: string;
  url: string;
  region: string;
  service: string;
  headers: Record<string, string>;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: Buffer | string, s: string) => createHmac('sha256', key).update(s).digest();

/** RFC 3986 encoding, which is what SigV4's canonical query string uses. */
function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The request's headers with `x-amz-date`, `host` and `authorization` added. */
export function signRequest(input: SignInput): Record<string, string> {
  const url = new URL(input.url);
  const amzDate = input.now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v.trim();
  headers.host = url.host;
  headers['x-amz-date'] = amzDate;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const path = url.pathname
    .split('/')
    .map((seg) => uriEncode(decodeURIComponent(seg)))
    .join('/');
  const canonical = [
    input.method,
    path || '/',
    query,
    canonicalHeaders,
    signedHeaders,
    sha256(input.body),
  ].join('\n');

  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  let key = hmac(`AWS4${input.secretAccessKey}`, day);
  key = hmac(key, input.region);
  key = hmac(key, input.service);
  key = hmac(key, 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
