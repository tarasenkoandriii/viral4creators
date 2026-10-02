/**
 * Общее у сервисов обучения — L: коды отказов (контракт Э3 §6), права
 * (§4-тер.13: чтение и кандидат — assist any, решение и проверенные
 * ответы — manager/owner), разбор тел запросов (маршруты принимают
 * интерфейсы, а не DTO-классы — проверка здесь, её же проходят вызовы из
 * тестов и из бота), проверка «в тексте нет контактов посетителя».
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { DEFAULT_MASK_LABELS } from '../../shared/assist-chat-core';
import {
  JOURNAL_MASK,
  maskForJournal,
} from '../assist-site-chat/answer-checks';
import {
  REQUIRE_ASSIST_ANY,
  REQUIRE_ASSIST_MANAGER,
  satisfiesProductRoles,
  type AccountMembership,
} from '../site-core/account/roles';
import type { LearningErrorCode } from './api-types';

const CTOR = {
  400: BadRequestException,
  403: ForbiddenException,
  404: NotFoundException,
  409: ConflictException,
} as const;

/** Отказ кабинета обучения: тело `{ error, code, message }`, как у Э1/Э2. */
export function learningError(
  status: keyof typeof CTOR,
  code: LearningErrorCode | 'FORBIDDEN',
  message: string,
): HttpException {
  return new CTOR[status]({ error: code, code, message });
}

/** Код из исключения (для тестов). */
export function learningCodeOf(e: unknown): string | undefined {
  if (!(e instanceof HttpException)) return undefined;
  const body = e.getResponse();
  return body && typeof body === 'object'
    ? ((body as { code?: unknown }).code as string | undefined)
    : undefined;
}

export function isManager(m: AccountMembership): boolean {
  return satisfiesProductRoles(m, REQUIRE_ASSIST_MANAGER);
}

/**
 * Права проверяет и гвард маршрута, и сервис: сервис зовут не только
 * маршруты (бот H, тесты), и «забытый декоратор» не должен открывать
 * публикацию оператору (§4-тер.15 п.14).
 */
export function requireAssistAny(m: AccountMembership): void {
  if (!satisfiesProductRoles(m, REQUIRE_ASSIST_ANY)) {
    throw learningError(
      403,
      'FORBIDDEN',
      'Нет доступа к обучению помощника — попросите владельца кабинета выдать права',
    );
  }
}

export function requireManager(m: AccountMembership): void {
  if (!isManager(m)) {
    throw learningError(
      403,
      'FORBIDDEN',
      'Публиковать и решать может только менеджер или владелец кабинета',
    );
  }
}

const MASK_LABELS = [
  DEFAULT_MASK_LABELS.email,
  DEFAULT_MASK_LABELS.phone,
  DEFAULT_MASK_LABELS.token,
  JOURNAL_MASK.card,
  JOURNAL_MASK.iban,
];

/**
 * В тексте контакт посетителя — открытый (телефон, e-mail, карта) или уже
 * скрытый маской. Вопрос с «[телефон скрыт]» как формулировка проверенного
 * ответа бессмыслен, а открытый — это ПДн посетителя в знаниях всех (§4-тер.7).
 */
export function hasContact(text: string): boolean {
  return (
    maskForJournal(text) !== text ||
    MASK_LABELS.some((label) => text.includes(label))
  );
}

/** Строка 1..max символов после trim, иначе null. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r\n?/g, '\n').trim();
  if (!t || Array.from(t).length > max) return null;
  return t;
}

export const GOLDEN_LIMITS = {
  question: 500,
  answer: 5000,
  variants: 10,
  variant: 500,
  copyIds: 50,
} as const;

export const GOLDEN_LANGS = ['uk', 'ru', 'en'] as const;

/** Язык: uk|ru|en, null/undefined — «не задан»; другое — undefined (ошибка). */
export function parseLang(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return undefined;
  const l = v.trim().toLowerCase();
  return (GOLDEN_LANGS as readonly string[]).includes(l) ? l : undefined;
}

/** Варианты формулировок: ≤ 10, каждая ≤ 500, без дублей и контактов. */
export function parseVariants(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > GOLDEN_LIMITS.variants) return null;
  const out: string[] = [];
  for (const x of v) {
    const t = cleanText(x, GOLDEN_LIMITS.variant);
    if (!t || hasContact(t)) return null;
    if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

/** Числа текста (цены, сроки, проценты) — нормализованные токены. */
export function numbersOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
    out.add(m[0].replace(',', '.').replace(/^0+(?=\d)/, ''));
  }
  return [...out];
}

/** Убрать маркеры источников `[S1]` из текста черновика. */
export function stripSourceMarkers(text: string): string {
  return text
    .replace(/\s*\[S\d+\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Адрес страницы без query и фрагмента (§6.6) или null. */
export function pageOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}
