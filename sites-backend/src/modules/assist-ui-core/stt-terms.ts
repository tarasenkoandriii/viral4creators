/**
 * Подсказки распознаванию Soniox — `context.terms` (Э6-бис-хвост (3), ТЗ
 * помощника §5-бис.7: «имена мемо и целей карты распознаются как
 * написаны»). Чистая часть без базы: список терминов из групп по
 * приоритету; источники читает модуль СВОЕГО режима («Сайт» —
 * `assist-site-voice/public/stt-terms.ts` из опубликованных мемо и карты
 * под `assist_public`; «Админка» — `assist-admin-voice/admin-stt-terms.ts`
 * из своих мемо). Режимы друг другу термины не передают: группы
 * собираются раздельно, общий здесь только отбор.
 *
 * Потолки. Документация Soniox (async API, объект `context`) ограничивает
 * контекст целиком (≈ 8 000 токенов, ≈ 10 000 символов) и рекомендует
 * короткие термины; точного предела на число `terms` в коде и
 * комментариях репозитория нет — берём консервативно: ≤ 100 терминов,
 * ≤ 50 символов каждый, ≤ 3 000 символов всего (запас к пределу контекста
 * в 3 раза). Длинный термин ОТБРАСЫВАЕТСЯ, а не режется: обрубок слова
 * подсказал бы распознаванию то, чего никто не скажет.
 *
 * Без ПД: каждый термин проходит ту же проверку текста, что имя и фраза
 * мемо (`memoTextProblem`: маска e-mail/телефона/ключей/длинных цифр,
 * ссылки, разметка, роли, инъекция) — не прошёл, не уходит провайдеру.
 * Дубли — по нормализованной форме фразы (`phraseNorm`): «Кошик» и
 * «кошик!» — один термин (первый по приоритету).
 */
import { memoTextProblem, phraseNorm } from './memo';

export const STT_TERMS_LIMITS = {
  maxTerms: 100,
  maxChars: 50,
  maxTotalChars: 3_000,
} as const;

/**
 * Термины для `context.terms`: группы — по убыванию приоритета (сначала
 * явные термины владельца, затем имена, затем фразы). Пусто — `[]`
 * (тело запроса тогда без `context`).
 */
export function buildSttTerms(
  groups: ReadonlyArray<ReadonlyArray<string | null | undefined>>,
  limits: {
    maxTerms: number;
    maxChars: number;
    maxTotalChars: number;
  } = STT_TERMS_LIMITS,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const group of groups)
    for (const raw of group) {
      if (out.length >= limits.maxTerms) return out;
      if (typeof raw !== 'string') continue;
      const t = raw.replace(/\s+/g, ' ').trim();
      if (!t || t.length > limits.maxChars) continue;
      if (memoTextProblem(t, limits.maxChars) !== null) continue;
      const norm = phraseNorm(t);
      if (!norm || seen.has(norm)) continue;
      if (total + t.length > limits.maxTotalChars) continue;
      seen.add(norm);
      out.push(t);
      total += t.length;
    }
  return out;
}
