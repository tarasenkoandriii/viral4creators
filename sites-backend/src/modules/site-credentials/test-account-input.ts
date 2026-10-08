/**
 * Разбор ввода тестовой учётной записи (Э-С Ш2) — общий для экрана
 * кабинета (TMA помощника/QA) и внутреннего API генератора. Строгий: лишнее
 * поле, неизвестный продукт или срок — 400, а не «тихо проигнорировано»
 * (опечатка владельца не должна молча открыть учётку другому продукту).
 */
import { BadRequestException } from '@nestjs/common';

/**
 * Кому разрешена учётка. Э-С Ш3 (О-Э7-1): `assist-admin` — обход «Админки»
 * помощника за логином браузерным воркером (аренда `assist-admin-login`).
 */
export const TEST_ACCOUNT_PRODUCTS = [
  'tutorial',
  'qa',
  'assist-admin',
] as const;
export type TestAccountProduct = (typeof TEST_ACCOUNT_PRODUCTS)[number];

export const LOGIN_METHODS = ['password', 'session', 'sso'] as const;
export type LoginMethod = (typeof LOGIN_METHODS)[number];

/** Срок жизни учётки на выбор (дни); по умолчанию — 90 (как подтверждение хоста). */
export const LIFETIME_DAYS = [7, 30, 90] as const;
export const DEFAULT_LIFETIME_DAYS = 90;

/** Подсказки роли в интерфейсе; сама роль — свободный текст. */
export const ROLE_HINTS = ['guest', 'customer', 'manager', 'admin'] as const;

export const LIMITS = {
  label: 80,
  role: 40,
  plan: 60,
  username: 200,
  password: 1024,
  hosts: 20,
} as const;

export interface TestAccountInput {
  label?: string;
  role?: string | null;
  plan?: string | null;
  username?: string | null;
  /** Только запись: наружу не отдаётся. `''` — не менять. */
  password?: string;
  loginMethod?: LoginMethod;
  hostIds?: string[];
  products?: TestAccountProduct[];
  lifetimeDays?: number;
  status?: 'active' | 'frozen';
  /** Галочка «это тестовый аккаунт, не реальный клиент». */
  confirmedTestAccount?: boolean;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

export function badInput(message: string): BadRequestException {
  return new BadRequestException({
    error: 'TEST_ACCOUNT_INVALID',
    code: 'TEST_ACCOUNT_INVALID',
    message,
  });
}

function text(
  v: unknown,
  field: string,
  max: number,
  nullable: boolean,
): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || (typeof v === 'string' && v.trim() === '')) {
    if (nullable) return null;
    throw badInput(`«${field}» не может быть пустым`);
  }
  if (typeof v !== 'string') throw badInput(`«${field}» — строка`);
  const s = v.trim();
  if (s.length > max) throw badInput(`«${field}» — до ${max} символов`);
  // Управляющие символы в подписи — путь к подмене строк журнала и экрана.
  if (hasControlChars(s)) {
    throw badInput(`«${field}»: недопустимые символы`);
  }
  return s;
}

const ALLOWED = new Set([
  'label',
  'role',
  'plan',
  'username',
  'password',
  'loginMethod',
  'hostIds',
  'products',
  'lifetimeDays',
  'status',
  'confirmedTestAccount',
]);

/**
 * `partial` — правка (все поля необязательны); иначе создание: нужны
 * `label`, хотя бы один хост и хотя бы один продукт.
 * `allowEmptyProducts` (только с `partial`): пустой список продуктов
 * пропускается — вызывающий сам проверяет «хотя бы один» ПОСЛЕ слияния с
 * продуктами, которых он не видит (канал обучалки генератора: учётка
 * только с `assist-admin`, аудит захода 10, P3-3).
 */
export function parseTestAccountInput(
  body: unknown,
  opts: {
    partial: boolean;
    allowedKeys?: ReadonlySet<string>;
    allowEmptyProducts?: boolean;
  },
): TestAccountInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badInput('ожидается объект учётной записи');
  }
  const o = body as Record<string, unknown>;
  const allowed = opts.allowedKeys ?? ALLOWED;
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) throw badInput(`лишнее поле «${k}»`);
  }
  const out: TestAccountInput = {};
  const label = text(o.label, 'label', LIMITS.label, false);
  if (label !== undefined && label !== null) out.label = label;
  const role = text(o.role, 'role', LIMITS.role, true);
  if (role !== undefined) out.role = role;
  const plan = text(o.plan, 'plan', LIMITS.plan, true);
  if (plan !== undefined) out.plan = plan;
  const username = text(o.username, 'username', LIMITS.username, true);
  if (username !== undefined) out.username = username;
  if (o.password !== undefined) {
    if (typeof o.password !== 'string') throw badInput('«password» — строка');
    if (o.password.length > LIMITS.password) {
      throw badInput(`«password» — до ${LIMITS.password} символов`);
    }
    out.password = o.password;
  }
  if (o.loginMethod !== undefined) {
    if (!(LOGIN_METHODS as readonly unknown[]).includes(o.loginMethod)) {
      throw badInput('«loginMethod»: password | session | sso');
    }
    out.loginMethod = o.loginMethod as LoginMethod;
  }
  if (o.hostIds !== undefined) {
    if (
      !Array.isArray(o.hostIds) ||
      o.hostIds.length > LIMITS.hosts ||
      o.hostIds.some((h) => typeof h !== 'string' || !ID_RE.test(h))
    ) {
      throw badInput('«hostIds» — список id хостов сайта');
    }
    out.hostIds = [...new Set(o.hostIds as string[])];
  }
  if (o.products !== undefined) {
    if (
      !Array.isArray(o.products) ||
      o.products.some(
        (p) => !(TEST_ACCOUNT_PRODUCTS as readonly unknown[]).includes(p),
      )
    ) {
      throw badInput('«products»: tutorial | qa | assist-admin');
    }
    out.products = [...new Set(o.products as TestAccountProduct[])];
  }
  if (o.lifetimeDays !== undefined) {
    if (!(LIFETIME_DAYS as readonly unknown[]).includes(o.lifetimeDays)) {
      throw badInput(`«lifetimeDays»: ${LIFETIME_DAYS.join(' | ')}`);
    }
    out.lifetimeDays = o.lifetimeDays as number;
  }
  if (o.status !== undefined) {
    if (o.status !== 'active' && o.status !== 'frozen') {
      throw badInput('«status»: active | frozen');
    }
    out.status = o.status;
  }
  if (o.confirmedTestAccount !== undefined) {
    if (typeof o.confirmedTestAccount !== 'boolean') {
      throw badInput('«confirmedTestAccount» — да/нет');
    }
    out.confirmedTestAccount = o.confirmedTestAccount;
  }
  if (!opts.partial) {
    if (!out.label) throw badInput('нужна подпись учётки («label»)');
    if (!out.hostIds?.length) throw badInput('нужен хотя бы один хост');
    if (!out.products?.length) throw badInput('нужен хотя бы один продукт');
  } else {
    if (out.hostIds && out.hostIds.length === 0) {
      throw badInput('нужен хотя бы один хост');
    }
    if (out.products && out.products.length === 0 && !opts.allowEmptyProducts) {
      throw badInput('нужен хотя бы один продукт');
    }
  }
  return out;
}
