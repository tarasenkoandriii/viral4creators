/**
 * Перевод заголовка и описания ролика на остальные локали продукта
 * (этап 137, ТЗ TZ-Multilingual-YouTube.md §1.1).
 *
 * ## Зачем это вообще работает без нового согласия Google
 *
 * Первая редакция ТЗ считала, что локализации ставятся через
 * `videos.update`, а тот требует скоупа `youtube.force-ssl` — то есть
 * верификации приложения и переподключения канала. Проверка
 * документации перед кодом показала другое: `videos.insert` принимает
 * `part=localizations` и работает с уже имеющимся `youtube.upload`.
 * Значит локализованные заголовки и описания ставятся В МОМЕНТ
 * ЗАГРУЗКИ, одним запросом, и вместе с ними отпадают обе тихие ловушки
 * обновления: «запрос без свойства стирает свойство» и «categoryId
 * обязателен при обновлении snippet». Стирать нечего — ролика ещё нет.
 *
 * ## Почему отдельный чистый модуль
 *
 * Тот же приём, что у `analysis-translation.ts`: промпт и разбор ответа
 * — чистые функции с собственными тестами, а сервис вокруг них только
 * ходит в сеть. Ошибка разбора чужого JSON — самое вероятное место
 * поломки, и проверять его через сетевой вызов было бы дорого и мутно.
 *
 * ## Правила, которые здесь закреплены
 *
 * - Переводим ТОЛЬКО заголовок и описание. Теги не переводятся —
 *   решение этапа 136: у ролика один общий список тегов, локализовать
 *   его нечем.
 * - Язык оригинала в локализации не попадает: он уже лежит в самом
 *   `snippet`, и дубль только добавил бы места для расхождения.
 * - Потолки площадки те же, что у оригинала: заголовок 100 символов,
 *   описание 5000. Режем здесь, а не надеемся на модель.
 * - Пустой или неразобранный ответ — пустая карта, а не исключение:
 *   локализация не обязана ронять публикацию (приёмка этапа).
 */

import {
  SUPPORTED_LOCALES,
  SupportedLocale,
  languageNameForLocale,
} from '../../common/locale';

export const TITLE_MAX = 100;
export const DESCRIPTION_MAX = 5000;

export interface LocalizedText {
  title: string;
  description: string;
}

/** Локали, на которые переводим: все продуктовые, кроме языка оригинала. */
export function targetLocales(source: SupportedLocale): SupportedLocale[] {
  return SUPPORTED_LOCALES.filter((l) => l !== source);
}

export function buildPublicationTranslationPrompt(
  input: { title: string; description: string },
  source: SupportedLocale,
): string {
  const targets = targetLocales(source);
  const payload = {
    title: input.title.slice(0, TITLE_MAX),
    description: input.description.slice(0, DESCRIPTION_MAX),
  };
  return [
    `Translate the YouTube video title and description below from ${languageNameForLocale(source)} into each of these languages: ` +
      targets.map((l) => `${l} (${languageNameForLocale(l)})`).join(', ') +
      '.',
    '',
    'Rules:',
    `- The title must stay under ${TITLE_MAX} characters in every language. Shorten the wording rather than exceed it.`,
    '- Keep it natural for a viewer of that language, not word-for-word.',
    '- Keep product names, brand names and URLs exactly as they are.',
    '- Keep hashtags and emoji if the original has them.',
    '- Do not add anything that is not in the original.',
    '',
    'Answer with JSON only, in this exact shape:',
    `{${targets.map((l) => `"${l}":{"title":"…","description":"…"}`).join(',')}}`,
    '',
    'Source:',
    JSON.stringify(payload),
  ].join('\n');
}

/**
 * Разбор ответа модели. Берёт только знакомые локали и только
 * непустые строки: половина ответа лучше, чем ничего, а мусор в
 * `localizations` YouTube отвергнет целиком.
 */
export function parsePublicationTranslations(
  raw: string,
  source: SupportedLocale,
): Partial<Record<SupportedLocale, LocalizedText>> {
  const parsed = parseJsonObject(raw);
  if (!parsed) return {};

  const out: Partial<Record<SupportedLocale, LocalizedText>> = {};
  for (const locale of targetLocales(source)) {
    const value = parsed[locale];
    if (!value || typeof value !== 'object') continue;
    const { title, description } = value as Record<string, unknown>;
    const t = typeof title === 'string' ? title.trim().slice(0, TITLE_MAX) : '';
    // Заголовок обязателен: YouTube не принимает локализацию без него,
    // а описание пустым быть может — как и у оригинала.
    if (!t) continue;
    const d =
      typeof description === 'string'
        ? description.trim().slice(0, DESCRIPTION_MAX)
        : '';
    out[locale] = { title: t, description: d };
  }
  return out;
}

/**
 * Модель почти всегда отвечает голым JSON, но иногда оборачивает его в
 * ```json-забор. Тот же случай уже разбирался в продукте (см.
 * `analysis-response.ts`), поэтому правило то же: берём от первой `{`
 * до последней `}`.
 */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = (raw ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
