/**
 * The Tigris calls `deploy.ts` makes with the bucket's admin credential:
 * mint the machine's write-only key, and make the bucket a snapshot bucket
 * (the key may overwrite a snapshot whose name it knows, and a snapshot
 * bucket keeps the version it replaced). Nothing prunes old snapshots yet:
 * a snapshot bucket cannot expire objects, and the machine cannot delete.
 *
 * No value read here is ever printed. Errors carry the API's error code and
 * message, which name the request, never a key.
 */
import { createHash } from 'node:crypto';
import type { BucketCredential } from './deploy-plan.ts';
import { signRequest } from './sigv4.ts';

export const TIGRIS_IAM_ENDPOINT = 'https://iam.storage.dev/';
const REGION = 'auto';

function xmlValue(xml: string, tag: string): string | undefined {
  return xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];
}

async function iam(
  admin: BucketCredential,
  params: Record<string, string>,
  iamUrl: string,
): Promise<string> {
  const body = new URLSearchParams({ ...params, Version: '2010-05-08' }).toString();
  const headers = signRequest({
    method: 'POST',
    url: iamUrl,
    region: REGION,
    service: 'iam',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body,
    accessKeyId: admin.accessKeyId,
    secretAccessKey: admin.secretAccessKey,
    now: new Date(),
  });
  const res = await fetch(iamUrl, { method: 'POST', headers, body });
  const text = await res.text();
  if (!res.ok) {
    const code = xmlValue(text, 'Code') ?? `HTTP ${res.status}`;
    throw new IamError(code, `${params.Action}: ${code}: ${xmlValue(text, 'Message') ?? ''}`);
  }
  return text;
}

export class IamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/*
 * Each call takes the IAM endpoint last, defaulting to Tigris's, so a test
 * can point it at a stand-in on loopback.
 */

export async function createAccessKey(
  admin: BucketCredential,
  iamUrl = TIGRIS_IAM_ENDPOINT,
): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  const xml = await iam(admin, { Action: 'CreateAccessKey' }, iamUrl);
  const accessKeyId = xmlValue(xml, 'AccessKeyId');
  const secretAccessKey = xmlValue(xml, 'SecretAccessKey');
  if (!accessKeyId || !secretAccessKey) throw new Error('CreateAccessKey answered without a key');
  return { accessKeyId, secretAccessKey };
}

export async function deleteAccessKey(
  admin: BucketCredential,
  accessKeyId: string,
  iamUrl = TIGRIS_IAM_ENDPOINT,
): Promise<void> {
  await iam(
    admin,
    { Action: 'DeleteAccessKey', AccessKeyId: accessKeyId, UserName: accessKeyId },
    iamUrl,
  );
}

/** The policy's ARN: made now, or found by name when an earlier run made it. */
export async function ensurePolicy(
  admin: BucketCredential,
  name: string,
  document: string,
  iamUrl = TIGRIS_IAM_ENDPOINT,
): Promise<string> {
  try {
    const xml = await iam(
      admin,
      { Action: 'CreatePolicy', PolicyName: name, PolicyDocument: document },
      iamUrl,
    );
    const arn = xmlValue(xml, 'Arn');
    if (!arn) throw new Error('CreatePolicy answered without an Arn');
    return arn;
  } catch (err) {
    if (!(err instanceof IamError) || err.code !== 'EntityAlreadyExists') throw err;
    const list = await iam(admin, { Action: 'ListPolicies', Scope: 'Local' }, iamUrl);
    for (const member of list.split('<member>')) {
      if (xmlValue(member, 'PolicyName') === name) {
        const arn = xmlValue(member, 'Arn');
        if (!arn) continue;
        // A policy of this name may have been made by hand, or by an older
        // run with a wider grant: attaching it would hand the new key that.
        const held = await policyDocument(admin, arn, iamUrl);
        if (!samePolicy(held, document)) {
          throw new Error(
            `policy ${name} exists with a different document; not attaching it (delete or rename it, then run again)`,
          );
        }
        return arn;
      }
    }
    throw new Error(`policy ${name} exists but ListPolicies did not return it`);
  }
}

const XML_ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
};

/** The default version's document of the policy at `arn`, as JSON text. */
async function policyDocument(
  admin: BucketCredential,
  arn: string,
  iamUrl: string,
): Promise<string> {
  const policy = await iam(admin, { Action: 'GetPolicy', PolicyArn: arn }, iamUrl);
  const versionId = xmlValue(policy, 'DefaultVersionId');
  if (!versionId) throw new Error(`GetPolicy answered without a DefaultVersionId for ${arn}`);
  const version = await iam(
    admin,
    { Action: 'GetPolicyVersion', PolicyArn: arn, VersionId: versionId },
    iamUrl,
  );
  const raw = xmlValue(version, 'Document');
  if (raw === undefined) throw new Error(`GetPolicyVersion answered without a Document for ${arn}`);
  const text = raw.replace(/&(quot|apos|lt|gt|amp);/g, (e) => XML_ENTITIES[e] ?? e);
  // IAM answers the document URL-encoded; accept it plain as well.
  return text.trimStart().startsWith('{') ? text : decodeURIComponent(text);
}

/** A statement field IAM may answer as one string or a list, as a sorted list. */
const asList = (v: unknown): unknown =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? [...v].map(String).sort() : v;

function canonicalPolicy(text: string): string {
  const doc = JSON.parse(text) as { Version?: unknown; Statement?: unknown };
  const statements = Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
  return JSON.stringify({
    Version: doc.Version,
    Statement: statements
      .map((s) => {
        const o = (s ?? {}) as Record<string, unknown>;
        return Object.fromEntries(
          Object.keys(o)
            .sort()
            .map((k) => [k, k === 'Effect' || k === 'Sid' ? o[k] : asList(o[k])]),
        );
      })
      .map((s) => JSON.stringify(s))
      .sort(),
  });
}

/** Whether two policy documents grant the same, ignoring order and spacing. */
export function samePolicy(a: string, b: string): boolean {
  try {
    return canonicalPolicy(a) === canonicalPolicy(b);
  } catch {
    return false;
  }
}

export async function attachPolicy(
  admin: BucketCredential,
  accessKeyId: string,
  policyArn: string,
  iamUrl = TIGRIS_IAM_ENDPOINT,
): Promise<void> {
  await iam(
    admin,
    { Action: 'AttachUserPolicy', UserName: accessKeyId, PolicyArn: policyArn },
    iamUrl,
  );
}

async function s3(
  cred: BucketCredential,
  method: string,
  url: string,
  body = '',
  extra: Record<string, string> = {},
): Promise<Response> {
  const headers = signRequest({
    method,
    url,
    region: REGION,
    service: 's3',
    headers: { 'x-amz-content-sha256': createHash('sha256').update(body).digest('hex'), ...extra },
    body,
    accessKeyId: cred.accessKeyId,
    secretAccessKey: cred.secretAccessKey,
    now: new Date(),
  });
  return fetch(url, { method, headers, ...(body ? { body } : {}) });
}

function lifecycleUrl(cred: BucketCredential, bucket: string): string {
  return `${cred.endpoint.replace(/\/$/, '')}/${bucket}?lifecycle=`;
}

/**
 * Whether the bucket holds any lifecycle rule. Tigris refuses to make a
 * bucket a snapshot bucket while one exists, and a snapshot bucket cannot
 * expire anything, so the deploy removes the rule an older run set.
 */
export async function hasLifecycle(cred: BucketCredential, bucket: string): Promise<boolean> {
  const res = await s3(cred, 'GET', lifecycleUrl(cred, bucket));
  const text = await res.text();
  if (res.status === 404) return false;
  if (!res.ok)
    throw new Error(`GetBucketLifecycle: HTTP ${res.status}: ${xmlValue(text, 'Code') ?? ''}`);
  return text.includes('<Rule>');
}

export async function deleteLifecycle(cred: BucketCredential, bucket: string): Promise<void> {
  const res = await s3(cred, 'DELETE', lifecycleUrl(cred, bucket));
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`DeleteBucketLifecycle: HTTP ${res.status}: ${xmlValue(text, 'Code') ?? ''}`);
  }
}

/**
 * Tigris's own bucket settings: `GET /<bucket>?metadata` reads them and
 * `PATCH /<bucket>` with a JSON body changes them, signed as S3 calls. These
 * are the requests Tigris's SDK makes for `getBucketInfo` and
 * `enableSnapshot` (`@tigrisdata/storage`, `bucket/info.ts` and
 * `bucket/set/type.ts`), where a bucket's `type` is 0 for Regular and 1 for
 * Snapshot.
 */
const SNAPSHOT_TYPE = 1;

function bucketUrl(cred: BucketCredential, bucket: string, query = ''): string {
  return `${cred.endpoint.replace(/\/$/, '')}/${bucket}${query}`;
}

/**
 * Whether the bucket keeps what an overwrite replaced (security review L5).
 * Tigris does not implement PutBucketVersioning (it answers 501); a snapshot
 * bucket keeps every version instead, and any past moment can be read back
 * with `X-Tigris-Snapshot-Version: <unix ns>` and copied over the current
 * object. Only a DeleteObject naming a version removes one, and the
 * machine's key may only put.
 */
export async function hasSnapshots(cred: BucketCredential, bucket: string): Promise<boolean> {
  const res = await s3(cred, 'GET', bucketUrl(cred, bucket, '?metadata='));
  const text = await res.text();
  if (!res.ok) throw new Error(`GetBucketInfo: HTTP ${res.status}: ${errorCode(text)}`);
  let info: unknown;
  try {
    info = JSON.parse(text);
  } catch {
    throw new Error('GetBucketInfo: the answer was not JSON');
  }
  return (info as { type?: unknown } | null)?.type === SNAPSHOT_TYPE;
}

export async function enableSnapshots(cred: BucketCredential, bucket: string): Promise<void> {
  const body = JSON.stringify({ type: SNAPSHOT_TYPE });
  const res = await s3(cred, 'PATCH', bucketUrl(cred, bucket), body, {
    'content-type': 'application/json',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`UpdateBucket (snapshots): HTTP ${res.status}: ${errorCode(text)}`);
  // The SDK treats a 200 whose body says `status: error` as a refusal too.
  let answer: { status?: unknown; message?: unknown } | null = null;
  try {
    answer = JSON.parse(text);
  } catch {
    return;
  }
  if (answer?.status === 'error')
    throw new Error(`UpdateBucket (snapshots): ${String(answer.message ?? 'refused')}`);
}

/** The error's code from an XML or JSON answer, never its whole body. */
function errorCode(text: string): string {
  const xml = xmlValue(text, 'Code');
  if (xml) return xml;
  try {
    const j = JSON.parse(text) as { code?: unknown; error?: { code?: unknown } } | null;
    return String(j?.code ?? j?.error?.code ?? '');
  } catch {
    return '';
  }
}
