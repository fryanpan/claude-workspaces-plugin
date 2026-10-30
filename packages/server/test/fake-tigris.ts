/**
 * A stand-in for Tigris on loopback, for the transcript store's tests: the
 * S3 calls the store makes (path-style object put, get, delete, list,
 * versions, versioning) and the IAM calls `tigris.ts` makes (access keys,
 * policies, attachments).
 *
 * It checks what the real service would refuse, so a test of a 403 is a test
 * of something: every request's SigV4 signature is recomputed from the
 * secret it was minted with, and every S3 call is judged against the
 * caller's attached policies. A bucket's admin credential may do anything to
 * its bucket. Every credential here is generated inside the test.
 */
import { createHash, randomBytes } from 'node:crypto';
import { signRequest } from '../../../infra/project-machine/sigv4.ts';

export interface FakeCredential {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

interface Version {
  versionId: string;
  body: Uint8Array | null;
  lastModified: Date;
}

interface Statement {
  Effect: string;
  Action: string[];
  Resource: string[];
}

interface Key {
  secret: string;
  /** The bucket this is the admin credential of, if any. */
  adminOf: string | null;
  policies: string[];
}

export interface FakeBucket {
  versioning: 'Enabled' | 'Suspended' | null;
  objects: Map<string, Version[]>;
}

export interface FakeTigris {
  /** The S3 endpoint. */
  url: string;
  /** The IAM endpoint. */
  iamUrl: string;
  buckets: Map<string, FakeBucket>;
  /** `<accessKeyId> <METHOD> <path>?<query> <status>`, every request. */
  log: string[];
  /** Makes a bucket, as `fly storage create` does, and returns its admin credential. */
  createBucket(name: string): FakeCredential;
  /** The latest bytes of `key`, bypassing every check. */
  latest(bucket: string, key: string): Uint8Array | null;
  /** Makes the next put of a key matching `match` land, then answer 500. */
  loseAnswerOnce(match: (key: string) => boolean): void;
  stop(): void;
}

const xml = (tag: string, v: string | number | boolean) => `<${tag}>${v}</${tag}>`;
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');

function denied(code = 'AccessDenied', status = 403): Response {
  return new Response(`<Error>${xml('Code', code)}${xml('Message', code)}</Error>`, { status });
}

function matches(pattern: string, value: string): boolean {
  return pattern.endsWith('*') ? value.startsWith(pattern.slice(0, -1)) : pattern === value;
}

export function startFakeTigris(): FakeTigris {
  const keys = new Map<string, Key>();
  const policies = new Map<string, { name: string; statements: Statement[] }>();
  const buckets = new Map<string, FakeBucket>();
  const log: string[] = [];
  let lose: ((key: string) => boolean) | null = null;
  let seq = 0;

  const newKey = (adminOf: string | null) => {
    const accessKeyId = `tid_${randomBytes(6).toString('hex')}`;
    const secret = `tsec_${randomBytes(12).toString('hex')}`;
    keys.set(accessKeyId, { secret, adminOf, policies: [] });
    return { accessKeyId, secret };
  };

  /** The caller's access key id, or a refusal when the signature does not check. */
  function verify(req: Request, body: Uint8Array): string | Response {
    const auth = req.headers.get('authorization') ?? '';
    const m = auth.match(
      /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/,
    );
    if (!m) return denied('MissingSecurityHeader');
    const [, id = '', , region = '', service = '', signed = '', signature = ''] = m;
    const key = keys.get(id);
    if (!key) return denied('InvalidAccessKeyId');
    const amz = req.headers.get('x-amz-date') ?? '';
    const now = new Date(
      `${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`,
    );
    const headers: Record<string, string> = {};
    for (const name of signed.split(';')) {
      if (name !== 'host' && name !== 'x-amz-date') headers[name] = req.headers.get(name) ?? '';
    }
    const again = signRequest({
      method: req.method,
      url: req.url,
      region,
      service,
      headers,
      body,
      accessKeyId: id,
      secretAccessKey: key.secret,
      now,
    });
    if (!again.authorization?.endsWith(`Signature=${signature}`)) {
      return denied('SignatureDoesNotMatch');
    }
    if (service === 's3') {
      const want = createHash('sha256').update(body).digest('hex');
      if (req.headers.get('x-amz-content-sha256') !== want)
        return denied('XAmzContentSHA256Mismatch');
    }
    return id;
  }

  function allowed(id: string, action: string, bucket: string, key: string | null): boolean {
    const k = keys.get(id);
    if (!k) return false;
    if (k.adminOf === bucket) return true;
    const resource = key === null ? `arn:aws:s3:::${bucket}` : `arn:aws:s3:::${bucket}/${key}`;
    return k.policies.some((arn) =>
      (policies.get(arn)?.statements ?? []).some(
        (s) =>
          s.Effect === 'Allow' &&
          s.Action.some((a) => a === action || a === 's3:*') &&
          s.Resource.some((r) => matches(r, resource)),
      ),
    );
  }

  function iam(id: string, form: URLSearchParams): Response {
    const action = form.get('Action');
    const wrap = (inner: string) =>
      new Response(
        `<${action}Response><${action}Result>${inner}</${action}Result></${action}Response>`,
      );
    if (!keys.get(id)?.adminOf) return denied('AccessDenied');
    switch (action) {
      case 'CreateAccessKey': {
        const k = newKey(null);
        return wrap(
          `<AccessKey>${xml('AccessKeyId', k.accessKeyId)}${xml('SecretAccessKey', k.secret)}</AccessKey>`,
        );
      }
      case 'CreatePolicy': {
        const name = form.get('PolicyName') ?? '';
        if ([...policies.values()].some((p) => p.name === name)) {
          return denied('EntityAlreadyExists', 409);
        }
        const doc = JSON.parse(form.get('PolicyDocument') ?? '{}') as { Statement?: Statement[] };
        const arn = `arn:aws:iam::fake:policy/${name}`;
        policies.set(arn, { name, statements: doc.Statement ?? [] });
        return wrap(`<Policy>${xml('PolicyName', name)}${xml('Arn', arn)}</Policy>`);
      }
      case 'ListPolicies': {
        const members = [...policies].map(
          ([arn, p]) => `<member>${xml('PolicyName', p.name)}${xml('Arn', arn)}</member>`,
        );
        return wrap(`<Policies>${members.join('')}</Policies>`);
      }
      case 'AttachUserPolicy': {
        const user = keys.get(form.get('UserName') ?? '');
        const arn = form.get('PolicyArn') ?? '';
        if (!user || !policies.has(arn)) return denied('NoSuchEntity', 404);
        user.policies.push(arn);
        return wrap('');
      }
      default:
        return denied('InvalidAction', 400);
    }
  }

  function latestOf(b: FakeBucket, key: string): Version | null {
    const v = b.objects.get(key)?.at(-1);
    return v && v.body !== null ? v : null;
  }

  function s3(id: string, req: Request, url: URL, body: Uint8Array): Response {
    const [, bucketName = '', ...rest] = url.pathname.split('/');
    const key = rest.length > 0 ? rest.map(decodeURIComponent).join('/') : null;
    const b = buckets.get(bucketName);
    if (!b) return denied('NoSuchBucket', 404);
    const q = url.searchParams;
    const can = (action: string) => allowed(id, action, bucketName, key);
    if (key === null || key === '') {
      if (q.has('versioning')) {
        if (req.method === 'PUT') {
          if (!can('s3:PutBucketVersioning')) return denied();
          const status = new TextDecoder().decode(body).match(/<Status>(\w+)<\/Status>/)?.[1];
          b.versioning = status === 'Enabled' ? 'Enabled' : 'Suspended';
          return new Response('');
        }
        if (!can('s3:GetBucketVersioning')) return denied();
        const inner = b.versioning ? xml('Status', b.versioning) : '';
        return new Response(`<VersioningConfiguration>${inner}</VersioningConfiguration>`);
      }
      const prefix = q.get('prefix') ?? '';
      const names = [...b.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (q.has('versions')) {
        if (!can('s3:ListBucketVersions')) return denied();
        const rows = names.flatMap((k) =>
          [...(b.objects.get(k) ?? [])].reverse().map((v, i) => {
            const tag = v.body === null ? 'DeleteMarker' : 'Version';
            return `<${tag}>${xml('Key', escape(k))}${xml('VersionId', v.versionId)}${xml('IsLatest', i === 0)}${xml('LastModified', v.lastModified.toISOString())}</${tag}>`;
          }),
        );
        return new Response(
          `<ListVersionsResult>${xml('IsTruncated', false)}${rows.join('')}</ListVersionsResult>`,
        );
      }
      if (!can('s3:ListBucket')) return denied();
      // Two per page, so a client that ignores continuation loses objects.
      const live = names.filter((k) => latestOf(b, k));
      const after = q.get('continuation-token');
      const start = after === null ? 0 : live.findIndex((k) => k > after);
      const page = start < 0 ? [] : live.slice(start, start + 2);
      const more = start >= 0 && start + 2 < live.length;
      const contents = page.map((k) => {
        const v = latestOf(b, k);
        return `<Contents>${xml('Key', escape(k))}${xml('Size', v?.body?.length ?? 0)}${xml('LastModified', v?.lastModified.toISOString() ?? '')}</Contents>`;
      });
      const next = more ? xml('NextContinuationToken', page.at(-1) ?? '') : '';
      return new Response(
        `<ListBucketResult>${xml('IsTruncated', more)}${contents.join('')}${next}</ListBucketResult>`,
      );
    }
    switch (req.method) {
      case 'PUT': {
        if (!can('s3:PutObject')) return denied();
        const versionId = b.versioning === 'Enabled' ? `v${++seq}` : 'null';
        const list = b.versioning === 'Enabled' ? (b.objects.get(key) ?? []) : [];
        list.push({ versionId, body, lastModified: new Date() });
        b.objects.set(key, list);
        if (lose?.(key)) {
          lose = null;
          return new Response('InternalError', { status: 500 });
        }
        return new Response('', { headers: { etag: '"x"' } });
      }
      case 'GET':
      case 'HEAD': {
        const versionId = q.get('versionId');
        if (!can(versionId ? 's3:GetObjectVersion' : 's3:GetObject')) return denied();
        const v = versionId
          ? (b.objects.get(key) ?? []).find((x) => x.versionId === versionId && x.body !== null)
          : latestOf(b, key);
        if (!v?.body) return denied('NoSuchKey', 404);
        return new Response(req.method === 'HEAD' ? null : new Uint8Array(v.body));
      }
      case 'DELETE': {
        if (!can('s3:DeleteObject')) return denied();
        const list = b.objects.get(key) ?? [];
        if (b.versioning === 'Enabled') {
          list.push({ versionId: `v${++seq}`, body: null, lastModified: new Date() });
          b.objects.set(key, list);
        } else {
          b.objects.delete(key);
        }
        return new Response(null, { status: 204 });
      }
      default:
        return denied('MethodNotAllowed', 405);
    }
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = new Uint8Array(await req.arrayBuffer());
      const who = verify(req, body);
      let res: Response;
      if (typeof who !== 'string') res = who;
      else if (url.pathname.startsWith('/iam')) {
        res = iam(who, new URLSearchParams(new TextDecoder().decode(body)));
      } else res = s3(who, req, url, body);
      log.push(
        `${typeof who === 'string' ? who : '-'} ${req.method} ${url.pathname}${url.search} ${res.status}`,
      );
      return res;
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    iamUrl: `${url}/iam/`,
    buckets,
    log,
    createBucket(name) {
      buckets.set(name, { versioning: null, objects: new Map() });
      const k = newKey(name);
      return { endpoint: url, accessKeyId: k.accessKeyId, secretAccessKey: k.secret };
    },
    latest(bucket, key) {
      const b = buckets.get(bucket);
      return b ? (latestOf(b, key)?.body ?? null) : null;
    },
    loseAnswerOnce(match) {
      lose = match;
    },
    stop() {
      server.stop(true);
    },
  };
}
