import { BadRequestException } from '@nestjs/common';
const invalid = () =>
  new BadRequestException({
    code: 'QA_CASE_INVALID',
    message: 'Проверьте название, шаги и параметры теста.',
  });
export function parseCaseInput(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid();
  const o = value as Record<string, unknown>;
  const allowed = [
    'title',
    'purpose',
    'preconditions',
    'steps',
    'type',
    'priority',
    'tags',
    'requirementIds',
    'archived',
  ];
  if (Object.keys(o).some((key) => !allowed.includes(key))) throw invalid();
  const text = (v: unknown, max: number, empty = false): string => {
    if (typeof v !== 'string' || v.length > max || (!empty && !v.trim()))
      throw invalid();
    return v.trim();
  };
  const strings = (v: unknown) => {
    if (!Array.isArray(v) || v.length > 20) throw invalid();
    const result = v.map((item) => text(item, 64));
    if (new Set(result).size !== result.length) throw invalid();
    return result;
  };
  if (
    typeof o.type !== 'string' ||
    !['manual', 'automated'].includes(o.type) ||
    typeof o.priority !== 'string' ||
    !['low', 'normal', 'high', 'critical'].includes(o.priority) ||
    typeof o.archived !== 'boolean'
  )
    throw invalid();
  if (!Array.isArray(o.steps) || o.steps.length < 1 || o.steps.length > 100)
    throw invalid();
  const steps = o.steps.map((step) => {
    if (!step || typeof step !== 'object' || Array.isArray(step))
      throw invalid();
    const s = step as Record<string, unknown>;
    if (Object.keys(s).some((key) => key !== 'action' && key !== 'expected'))
      throw invalid();
    return { action: text(s.action, 2000), expected: text(s.expected, 2000) };
  });
  const result = {
    title: text(o.title, 200),
    purpose: text(o.purpose, 2000, true),
    preconditions: text(o.preconditions, 4000, true),
    steps,
    type: o.type as string,
    priority: o.priority as string,
    tags: strings(o.tags),
    requirementIds: strings(o.requirementIds),
    archived: o.archived,
  };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 65536)
    throw invalid();
  return result;
}
export function parseCaseKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9-]{1,63}$/.test(value))
    throw invalid();
  return value;
}
export function parseVersion(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 2147483646
  )
    throw invalid();
  return value as number;
}
