/**
 * Перевод записи опыта — «Тонкая красная линия» §6.7, этап 11.
 *
 * Чистая часть: промпт и разбор. Три поля переводятся ОДНИМ вызовом и
 * возвращаются строгим JSON — не ради экономии (она копеечная), а
 * потому что симптом, причина и совет должны быть переведены
 * согласованно: раздельные вызовы дают три разных перевода одного
 * термина в одной записи.
 */

import { languageNameForLocale, SupportedLocale } from '../../common/locale';
import { sameUiKeys, uiKeysOf } from './ui-keys';

export interface TranslatableText {
  symptom: string;
  cause?: string | null;
  advice: string;
}

/**
 * Инструкция переводчику.
 *
 * Про ключи сказано прямо и с объяснением: модель, понимающая ЗАЧЕМ
 * сохранять `{{…}}`, ломает их заметно реже. Но полагаться на это
 * нельзя — перед сохранением множества ключей сверяются (§6.7), и
 * несовпадение отменяет сохранение целиком.
 */
export function buildTranslationPrompt(
  target: SupportedLocale,
  source: TranslatableText,
): string {
  const language = languageNameForLocale(target);
  const keys = uiKeysOf(
    [source.symptom, source.cause ?? '', source.advice].join('\n'),
  );
  const keyRule = keys.length
    ? `\n\nВ тексте есть подстановки вида {{раздел.ключ}} — это надписи на экране, которые сервис подставит сам на нужном языке. Перенеси их ДОСЛОВНО, символ в символ, не переводя и не меняя. Их ровно ${keys.length}: ${keys.join(', ')}.`
    : '';
  return `Переведи запись службы поддержки на ${language}.

Верни СТРОГО валидный JSON без markdown ровно такой формы:
{"symptom":"...","cause":"...","advice":"..."}

Правила:
1. Это инструкция для человека, который прямо сейчас застрял. Пиши так, как пишут в поддержке: коротко и по делу.
2. Ничего не добавляй и не выбрасывай. "cause" может быть пустой строкой, если её нет в оригинале.
3. Не переводи названия продуктов и сервисов.${keyRule}

## Оригинал
symptom: ${source.symptom}
cause: ${source.cause ?? ''}
advice: ${source.advice}`;
}

export interface TranslationResult {
  text: TranslatableText | null;
  /**
   * Почему не сохранили. Наружу не уходит — это для журнала оператора:
   * «перевод не сохранился» без причины не чинится.
   */
  reason?: 'not-json' | 'empty' | 'keys-lost';
}

/**
 * Разбор перевода со сверкой ключей.
 *
 * Сверка — не перестраховка: без неё правило «не называть кнопки
 * словами» держится на честном слове модели, а ошибка ЗАМОРАЖИВАЕТСЯ —
 * перевод сохраняется и живёт, пока его не прочитают. Один регексп
 * закрывает целый класс тихих поломок.
 */
export function parseTranslation(
  raw: string,
  source: TranslatableText,
): TranslationResult {
  let text = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { text: null, reason: 'not-json' };
  }

  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const symptom = str(parsed.symptom);
  const cause = str(parsed.cause);
  const advice = str(parsed.advice);
  if (!symptom || !advice) return { text: null, reason: 'empty' };

  // Сверяются ВСЕ поля вместе: ключ, переехавший из совета в симптом,
  // сохранил бы множество и сломал смысл — но такой перевод всё равно
  // лучше отклонить, поэтому проверяем и поле к полю.
  const wholeSource = [source.symptom, source.cause ?? '', source.advice].join(
    '\n',
  );
  const wholeTarget = [symptom, cause, advice].join('\n');
  if (
    !sameUiKeys(wholeSource, wholeTarget) ||
    !sameUiKeys(source.symptom, symptom) ||
    !sameUiKeys(source.advice, advice)
  ) {
    return { text: null, reason: 'keys-lost' };
  }

  return { text: { symptom, cause: cause || null, advice } };
}
