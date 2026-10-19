import { BadRequestException } from '@nestjs/common';
export interface QaEnvironment {
  name: string;
  browser: string;
  device: string;
  theme: 'light' | 'dark' | 'system';
  locale: string;
  viewport: string;
}
export interface QaPlanInput {
  title: string;
  suite: string;
  description: string;
  caseIds: string[];
  environments: QaEnvironment[];
  assigneeMemberId: string | null;
  archived: boolean;
}
const invalid = (): never => {
  throw new BadRequestException({
    code: 'QA_PLAN_INVALID',
    message:
      'Проверьте план, кейсы и окружения. Не указывайте пароли или данные реальных клиентов.',
  });
};
export function planObject(v: unknown, keys: string[]) {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    return invalid();
  return v as Record<string, unknown>;
}
export function planId(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v))
    return invalid();
  return v;
}
function text(v: unknown, max: number, empty = false): string {
  if (typeof v !== 'string' || v.length > max || (!empty && !v.trim()))
    return invalid();
  return v.trim();
}
export function parsePlan(v: unknown): QaPlanInput {
  const b = planObject(v, [
    'title',
    'suite',
    'description',
    'caseIds',
    'environments',
    'assigneeMemberId',
    'archived',
  ]);
  if (
    !Array.isArray(b.caseIds) ||
    !b.caseIds.length ||
    b.caseIds.length > 100 ||
    new Set(b.caseIds).size !== b.caseIds.length ||
    !Array.isArray(b.environments) ||
    !b.environments.length ||
    b.environments.length > 12 ||
    typeof b.archived !== 'boolean'
  )
    return invalid();
  const environments = b.environments.map((value) => {
    const e = planObject(value, [
      'name',
      'browser',
      'device',
      'theme',
      'locale',
      'viewport',
    ]);
    if (
      !['light', 'dark', 'system'].includes(String(e.theme)) ||
      typeof e.locale !== 'string' ||
      !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(e.locale) ||
      typeof e.viewport !== 'string' ||
      !/^\d{2,4}x\d{2,4}$/.test(e.viewport) ||
      e.viewport.split('x').some((x) => +x < 100 || +x > 4096)
    )
      return invalid();
    return {
      name: text(e.name, 80),
      browser: text(e.browser, 80),
      device: text(e.device, 80),
      theme: e.theme as QaEnvironment['theme'],
      locale: e.locale,
      viewport: e.viewport,
    };
  });
  if (new Set(environments.map((e) => e.name)).size !== environments.length)
    return invalid();
  return {
    title: text(b.title, 200),
    suite: text(b.suite, 100, true),
    description: text(b.description, 2000, true),
    caseIds: b.caseIds.map(planId),
    environments,
    assigneeMemberId:
      b.assigneeMemberId === null ? null : planId(b.assigneeMemberId),
    archived: b.archived,
  };
}
