/**
 * The Tigris calls `deploy.ts` makes with the bucket's admin credential:
 * mint the machine's write-only key, and set the rule that prunes old
 * snapshots (the machine cannot delete, so the bucket must).
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

async function iam(admin: BucketCredential, params: Record<string, string>): Promise<string> {
  const body = new URLSearchParams({ ...params, Version: '2010-05-08' }).toString();
  const headers = signRequest({
    method: 'POST',
    url: TIGRIS_IAM_ENDPOINT,
    region: REGION,
    service: 'iam',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body,
    accessKeyId: admin.accessKeyId,
    secretAccessKey: admin.secretAccessKey,
    now: new Date(),
  });
  const res = await fetch(TIGRIS_IAM_ENDPOINT, { method: 'POST', headers, body });
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

export async function createAccessKey(
  admin: BucketCredential,
): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  const xml = await iam(admin, { Action: 'CreateAccessKey' });
  const accessKeyId = xmlValue(xml, 'AccessKeyId');
  const secretAccessKey = xmlValue(xml, 'SecretAccessKey');
  if (!accessKeyId || !secretAccessKey) throw new Error('CreateAccessKey answered without a key');
  return { accessKeyId, secretAccessKey };
}

export async function deleteAccessKey(admin: BucketCredential, accessKeyId: string): Promise<void> {
  await iam(admin, { Action: 'DeleteAccessKey', AccessKeyId: accessKeyId, UserName: accessKeyId });
}

/** The policy's ARN: made now, or found by name when an earlier run made it. */
export async function ensurePolicy(
  admin: BucketCredential,
  name: string,
  document: string,
): Promise<string> {
  try {
    const xml = await iam(admin, {
      Action: 'CreatePolicy',
      PolicyName: name,
      PolicyDocument: document,
    });
    const arn = xmlValue(xml, 'Arn');
    if (!arn) throw new Error('CreatePolicy answered without an Arn');
    return arn;
  } catch (err) {
    if (!(err instanceof IamError) || err.code !== 'EntityAlreadyExists') throw err;
    const list = await iam(admin, { Action: 'ListPolicies', Scope: 'Local' });
    for (const member of list.split('<member>')) {
      if (xmlValue(member, 'PolicyName') === name) {
        const arn = xmlValue(member, 'Arn');
        if (arn) return arn;
      }
    }
    throw new Error(`policy ${name} exists but ListPolicies did not return it`);
  }
}

export async function attachPolicy(
  admin: BucketCredential,
  accessKeyId: string,
  policyArn: string,
): Promise<void> {
  await iam(admin, { Action: 'AttachUserPolicy', UserName: accessKeyId, PolicyArn: policyArn });
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

export function lifecycleXml(prefix: string, days: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration><Rule><ID>expire-snapshots</ID><Filter><Prefix>${prefix}</Prefix></Filter><Status>Enabled</Status><Expiration><Days>${days}</Days></Expiration></Rule></LifecycleConfiguration>`;
}

/** Whether the bucket already expires objects under `prefix` after `days`. */
export async function hasLifecycle(
  cred: BucketCredential,
  bucket: string,
  prefix: string,
  days: number,
): Promise<boolean> {
  const res = await s3(cred, 'GET', lifecycleUrl(cred, bucket));
  const text = await res.text();
  if (res.status === 404) return false;
  if (!res.ok)
    throw new Error(`GetBucketLifecycle: HTTP ${res.status}: ${xmlValue(text, 'Code') ?? ''}`);
  return (
    text.includes(`<Prefix>${prefix}</Prefix>`) &&
    text.includes(`<Days>${days}</Days>`) &&
    text.includes('<Status>Enabled</Status>')
  );
}

export async function setLifecycle(
  cred: BucketCredential,
  bucket: string,
  prefix: string,
  days: number,
): Promise<void> {
  const body = lifecycleXml(prefix, days);
  const md5 = createHash('md5').update(body).digest('base64');
  const res = await s3(cred, 'PUT', lifecycleUrl(cred, bucket), body, {
    'content-md5': md5,
    'content-type': 'application/xml',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PutBucketLifecycle: HTTP ${res.status}: ${xmlValue(text, 'Code') ?? ''}`);
  }
}
