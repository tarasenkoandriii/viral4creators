/**
 * Ворота публикации версии из переобхода (§4-тер.2, Р-32) — K2. Чистая
 * функция: «свежий факт побеждает, поломка — нет». Регрессия по фактам
 * публикацию не держит; держат только признаки поломки сайта или атаки:
 *
 *  - доля ранее опубликованных страниц, ставших gone/4xx/5xx/пустыми, > 30%;
 *  - доля изменившихся страниц с ОДИНАКОВЫМ текстом > 50% (при ≥ 10
 *    изменившихся) — заглушка «проверка браузера»/«обслуживание»;
 *  - смена преобладающего языка базы > 40 п.п.;
 *  - карантин инъекций > 10% фрагментов версии — «похоже на взлом»
 *    (меньше — фрагменты в карантин, версия публикуется + тревога);
 *  - инвариантный eval — любой провал (если запускался).
 *
 * Пороги — KNOWLEDGE_DEFAULTS.gates. Минимумы ниже — свои, НЕ из ТЗ:
 * на сайте из трёх страниц одна удалённая — это 33%, и без минимума
 * владелец получал бы «удержано» за обычную правку сайта.
 */
import { KNOWLEDGE_DEFAULTS } from '../../config/assist-defaults';
import type { GateCheck, GateReport } from './types';

/** Удержание по «сломанным» страницам — не меньше стольких страниц. */
export const GONE_OR_ERROR_MIN_PAGES =
  KNOWLEDGE_DEFAULTS.gates.goneOrErrorMinPages;
/** «Всплеск» карантина — не меньше стольких фрагментов. */
export const QUARANTINE_HOLD_MIN = KNOWLEDGE_DEFAULTS.gates.quarantineHoldMin;

export type InvariantEvalGate =
  | { ran: true; failed: number; total: number; failures: string[] }
  | { ran: false; note: string };

export interface GateInput {
  /** У сайта нет опубликованной версии (первая) — ворота аномалий не применяются. */
  coldStart: boolean;
  /** Страниц с фрагментами в опубликованной версии (родителе). */
  previouslyPublishedPages: number;
  /** Из них сейчас gone / 4xx / 5xx / пустые / таймаут. */
  brokenPages: number;
  /** Страниц с изменённым текстом в этой версии. */
  changedPages: number;
  /** Самая большая группа изменённых страниц с одним и тем же текстом. */
  largestIdenticalGroup: number;
  /** Фрагментов по языкам: родитель и новая версия. */
  parentLangs: Record<string, number>;
  newLangs: Record<string, number>;
  /** Новых фрагментов, ушедших в карантин. */
  newQuarantined: number;
  /** Фрагментов в новой версии всего (с карантином). */
  totalChunks: number;
  invariantEval: InvariantEvalGate | null;
}

type Thresholds = (typeof KNOWLEDGE_DEFAULTS)['gates'];

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function shareOf(langs: Record<string, number>, lang: string): number {
  const total = Object.values(langs).reduce((s, n) => s + n, 0);
  return total > 0 ? (langs[lang] ?? 0) / total : 0;
}

function dominant(langs: Record<string, number>): string | null {
  let best: string | null = null;
  for (const [l, n] of Object.entries(langs)) {
    if (best === null || n > langs[best]) best = l;
  }
  return best;
}

export function evaluateGates(
  input: GateInput,
  t: Thresholds = KNOWLEDGE_DEFAULTS.gates,
): GateReport {
  const checks: GateCheck[] = [];
  const quarantineShare =
    input.totalChunks > 0 ? input.newQuarantined / input.totalChunks : 0;

  if (input.coldStart) {
    // Не с чем сравнивать (§4-тер.2): карантин работает пофрагментно,
    // версия публикуется.
    checks.push({
      check: 'quarantine_share',
      value: round(quarantineShare),
      threshold: t.quarantineHoldShare,
      held: false,
      note: 'первая версия — ворота аномалий не применяются',
    });
    return { checks, held: false, coldStart: true };
  }

  const goneShare =
    input.previouslyPublishedPages > 0
      ? input.brokenPages / input.previouslyPublishedPages
      : 0;
  checks.push({
    check: 'gone_or_error_share',
    value: round(goneShare),
    threshold: t.goneOrErrorShare,
    held:
      goneShare > t.goneOrErrorShare &&
      input.brokenPages >= GONE_OR_ERROR_MIN_PAGES,
  });

  const identical =
    input.changedPages > 0 && input.largestIdenticalGroup >= 2
      ? input.largestIdenticalGroup / input.changedPages
      : 0;
  checks.push({
    check: 'identical_changed_share',
    value: round(identical),
    threshold: t.identicalChangedShare,
    held:
      input.changedPages >= t.identicalChangedMin &&
      identical > t.identicalChangedShare,
  });

  const parentLang = dominant(input.parentLangs);
  const newTotal = Object.values(input.newLangs).reduce((s, n) => s + n, 0);
  const shift =
    parentLang !== null && newTotal > 0
      ? (shareOf(input.parentLangs, parentLang) -
          shareOf(input.newLangs, parentLang)) *
        100
      : 0;
  checks.push({
    check: 'lang_shift',
    value: round(shift),
    threshold: t.langShiftPoints,
    held: shift > t.langShiftPoints,
    ...(parentLang ? { note: `преобладал ${parentLang}` } : {}),
  });

  checks.push({
    check: 'quarantine_share',
    value: round(quarantineShare),
    threshold: t.quarantineHoldShare,
    held:
      quarantineShare > t.quarantineHoldShare &&
      input.newQuarantined >= QUARANTINE_HOLD_MIN,
  });

  if (input.invariantEval) {
    const ev = input.invariantEval;
    checks.push(
      ev.ran
        ? {
            check: 'invariant_eval',
            value: ev.failed,
            threshold: 0,
            held: ev.failed > 0,
            ...(ev.failures.length
              ? { note: ev.failures.slice(0, 5).join('; ') }
              : {}),
          }
        : {
            check: 'invariant_eval',
            value: 0,
            threshold: 0,
            held: false,
            note: ev.note,
          },
    );
  }

  return { checks, held: checks.some((c) => c.held), coldStart: false };
}

/** Текст причины удержания для владельца (бот, экран версий). */
export function heldReasonText(report: GateReport): string | null {
  const parts: string[] = [];
  for (const c of report.checks.filter((x) => x.held)) {
    const pct = `${Math.round(c.value * 100)}%`;
    switch (c.check) {
      case 'gone_or_error_share':
        parts.push(
          `${pct} страниц сайта не открылись или пропали — похоже на сбой сайта`,
        );
        break;
      case 'identical_changed_share':
        parts.push(
          `${pct} изменившихся страниц показывают одинаковый текст — похоже на заглушку или проверку браузера`,
        );
        break;
      case 'lang_shift':
        parts.push(
          `язык базы сменился на ${Math.round(c.value)} п.п. — похоже на сломанную локализацию`,
        );
        break;
      case 'quarantine_share':
        parts.push(
          `${pct} фрагментов с признаками инъекции — похоже на взлом сайта`,
        );
        break;
      case 'invariant_eval':
        parts.push(`проверка устойчивости не пройдена (${c.value} из 10)`);
        break;
    }
  }
  return parts.length ? parts.join('; ') : null;
}
