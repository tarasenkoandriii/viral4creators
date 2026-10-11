import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
export const findingStatuses = [
  'needs_confirmation',
  'confirmed',
  'not_reproduced',
  'accepted_risk',
  'fixed_verified',
] as const;
export type FindingStatus = (typeof findingStatuses)[number];
export interface FindingPayload {
  title: string;
  category: 'layout' | 'logic' | 'accessibility';
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  status: FindingStatus;
  url: string;
  context: string;
  steps: string;
  expected: string;
  actual: string;
  impact: string;
  evidence: string[];
  deployedSha: string | null;
  observedAt: string;
  verification: {
    steps: string;
    result: string;
    checkedAt: string;
    deployedSha: string | null;
  } | null;
}
const invalid = () =>
  new BadRequestException({
    code: 'QA_FINDING_INVALID',
    message: 'Проверьте поля замечания, доказательства и повторную проверку.',
  });
function obj(v: unknown, keys: string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    throw invalid();
  return v as Record<string, unknown>;
}
function str(v: unknown, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw invalid();
  return v.trim();
}
function choice<T extends string>(v: unknown, choices: readonly T[]): T {
  if (typeof v !== 'string' || !choices.includes(v as T)) throw invalid();
  return v as T;
}
function sha(v: unknown): string | null {
  if (v === null) return null;
  const s = str(v, 40);
  if (!/^[a-f0-9]{40}$/i.test(s)) throw invalid();
  return s.toLowerCase();
}
function date(v: unknown): string {
  const s = str(v, 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(s) ||
    !Number.isFinite(Date.parse(s)) ||
    Date.parse(s) > Date.now() + 300000
  )
    throw invalid();
  return new Date(s).toISOString();
}
export function parseFinding(v: unknown): FindingPayload {
  const o = obj(v, [
    'title',
    'category',
    'severity',
    'status',
    'url',
    'context',
    'steps',
    'expected',
    'actual',
    'impact',
    'evidence',
    'deployedSha',
    'observedAt',
    'verification',
  ]);
  let url: URL;
  try {
    url = new URL(str(o.url, 500));
  } catch {
    throw invalid();
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw invalid();
  if (!Array.isArray(o.evidence) || o.evidence.length > 10) throw invalid();
  const evidence = o.evidence.map((e) => str(e, 500));
  const status = choice(o.status, findingStatuses);
  let verification: FindingPayload['verification'] = null;
  if (o.verification !== null) {
    const check = obj(o.verification, [
      'steps',
      'result',
      'checkedAt',
      'deployedSha',
    ]);
    verification = {
      steps: str(check.steps, 600),
      result: str(check.result, 600),
      checkedAt: date(check.checkedAt),
      deployedSha: sha(check.deployedSha),
    };
  }
  if (
    (status === 'confirmed' || status === 'fixed_verified') &&
    !evidence.length
  )
    throw invalid();
  if (status === 'fixed_verified' && !verification) throw invalid();
  const payload: FindingPayload = {
    title: str(o.title, 200),
    category: choice(o.category, ['layout', 'logic', 'accessibility']),
    severity: choice(o.severity, ['P0', 'P1', 'P2', 'P3']),
    status,
    url: url.href,
    context: str(o.context, 300),
    steps: str(o.steps, 1000),
    expected: str(o.expected, 1000),
    actual: str(o.actual, 1000),
    impact: str(o.impact, 600),
    evidence,
    deployedSha: sha(o.deployedSha),
    observedAt: date(o.observedAt),
    verification,
  };
  if (
    verification &&
    Date.parse(verification.checkedAt) < Date.parse(payload.observedAt)
  )
    throw invalid();
  return payload;
}
/** Current observation identity; prior versions stay immutable on edits. */
export function findingFingerprint(p: FindingPayload): string {
  const normalize = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256')
    .update(
      JSON.stringify([
        p.url,
        p.category,
        ...[p.context, p.steps, p.actual].map(normalize),
      ]),
    )
    .digest('hex');
}
