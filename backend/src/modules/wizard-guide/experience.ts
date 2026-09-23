/**
 * Правила корпуса опыта — «Тонкая красная линия» §6.2, §6.5, §6.7.
 *
 * Чистая часть: что можно публиковать, какой текст авторитетен, какой
 * отдавать на локали. Всё это решается БЕЗ базы, и проверяется тоже без
 * неё — а сервис рядом только ходит за строками.
 */

import { DEFAULT_LOCALE } from '../../common/locale';
import { uiKeysOf } from './ui-keys';

export const EXPERIENCE_STATUSES = ['DRAFT', 'PUBLISHED', 'REJECTED'] as const;
export type ExperienceStatus = (typeof EXPERIENCE_STATUSES)[number];

export const TEXT_SOURCES = ['ADMIN', 'MODEL'] as const;
export type TextSource = (typeof TEXT_SOURCES)[number];

export const CANDIDATE_ORIGINS = [
  'COMPLAINT',
  'UNDO',
  'ERRORS',
  'ADMIN',
] as const;
export type CandidateOrigin = (typeof CANDIDATE_ORIGINS)[number];

export const CANDIDATE_STATUSES = [
  'NEW',
  'MERGED',
  'PROMOTED',
  'REJECTED',
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export interface ExperienceText {
  locale: string;
  symptom: string;
  cause?: string | null;
  advice: string;
  source: string;
  reviewed: boolean;
}

/**
 * Можно ли публиковать ситуацию.
 *
 * Условие ровно одно и оно же — вся модерация §6.5: есть РУССКИЙ совет,
 * прочитанный человеком. Русский — рабочий язык оператора: без него
 * следующий оператор не поймёт, что здесь утверждено, даже если
 * сигнал пришёл на испанском и совет написан по-испански.
 */
export function canPublish(texts: readonly ExperienceText[]): boolean {
  return texts.some(
    (t) => t.locale === DEFAULT_LOCALE && t.reviewed && !!t.advice.trim(),
  );
}

export const PUBLISH_DENIED =
  'Публиковать нечего: нужен русский совет, прочитанный человеком. ' +
  'Русский — рабочий язык модерации, остальные языки появятся сами.';

/**
 * Авторитетный текст — тот, с которого разрешено переводить (§6.7,
 * правило 3).
 *
 * Авторитетный значит ПРОЧИТАННЫЙ человеком; если таких несколько —
 * русский. Переводить с непрочитанного перевода нельзя: испорченный
 * телефон на третьем языке уже неразличим, а с этапа 11 он ещё и
 * замораживается в базе.
 */
export function authoritativeText(
  texts: readonly ExperienceText[],
): ExperienceText | null {
  const reviewed = texts.filter((t) => t.reviewed);
  if (!reviewed.length) return null;
  return reviewed.find((t) => t.locale === DEFAULT_LOCALE) ?? reviewed[0];
}

export type ServeDecision =
  /** Готовый текст на нужной локали — отдаём как есть. */
  | { kind: 'ready'; text: ExperienceText }
  /** Текста нет — переводим с авторитетного и сохраняем (этап 11). */
  | { kind: 'translate'; from: ExperienceText }
  /** Отдавать нечего: ни текста на локали, ни авторитетного источника. */
  | { kind: 'none' };

/**
 * Что делать при отдаче на локали L (§6.7).
 *
 * `reviewed: false` отдаётся наравне с прочитанным — и это решение, а
 * не недосмотр: такой текст уже переведён с ПРОВЕРЕННОГО источника,
 * показывался людям и прошёл ту же проверку качества, что любой ответ
 * модели. Прятать его до ревью значит вернуться к переводу на лету, то
 * есть платить за то, что уже лежит. Сырого пользовательского текста
 * здесь не бывает по построению — жалобы лежат в другой таблице.
 */
export function serveDecision(
  texts: readonly ExperienceText[],
  locale: string,
): ServeDecision {
  const own = texts.find((t) => t.locale === locale);
  if (own) return { kind: 'ready', text: own };
  const from = authoritativeText(texts);
  return from ? { kind: 'translate', from } : { kind: 'none' };
}

/** Строка среза корпуса для промпта (§5.6). */
export function experienceLine(text: ExperienceText): string {
  const parts = [`${text.symptom.trim()}`];
  if (text.cause?.trim()) parts.push(`причина: ${text.cause.trim()}`);
  parts.push(`что делать: ${text.advice.trim()}`);
  return parts.join('; ');
}

/** Все ключи словаря, упомянутые в тексте совета. */
export function textUiKeys(text: ExperienceText): string[] {
  return uiKeysOf(
    [text.symptom, text.cause ?? '', text.advice].filter(Boolean).join('\n'),
  );
}
