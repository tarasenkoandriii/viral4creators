/**
 * Срез корпуса под шаг и дайджест состояния — «Тонкая красная линия»
 * §5.5–§5.6, §5.10.
 *
 * ## Почему срез, а не корпус целиком
 *
 * `knowledge/ru.md` лендингового ассистента весит 25 КБ — порядка
 * десяти тысяч токенов. Ассистент отвечает на произвольный вопрос и
 * потому обязан видеть всё; советник отвечает про ОДИН шаг, и подавать
 * ему весь корпус на каждую подсказку значило бы платить в девять раз
 * больше расчётного за контекст, которым он не пользуется.
 *
 * Потолок жёсткий и проверяется тестом: срез любого шага любого
 * сценария обязан уложиться в `HINT_CONTEXT_MAX_CHARS`.
 *
 * ## Почему в промпт не едет пользовательский текст
 *
 * Состояние описывается ФАКТАМИ («повод задан», «референса нет»), а не
 * значениями полей. Инъекция через поле «имя получателя» невозможна не
 * потому, что мы её фильтруем, а потому, что имя туда не попадает
 * вовсе. Это же свойство делает дайджест общим для всех пользователей:
 * в ключе кеша нет ничего персонального.
 */

import { createHash } from 'crypto';
import { SupportedLocale, languageNameForLocale } from '../../common/locale';
import { HINT_ACTIONS_DELIMITER, MAX_HINT_ACTIONS } from './hint-actions';

export const HINT_CONTEXT_MAX_CHARS = 4000;

/** Сколько записей опыта берём в срез. Появятся на этапе 9. */
export const HINT_EXPERIENCE_LIMIT = 5;

export interface HintStepCard {
  /** Идентификатор шага — он же часть ключа кеша. */
  stepId: string;
  /** Что делают на этом шаге, одной-двумя фразами. */
  goal: string;
}

export interface HintContextInput {
  locale: SupportedLocale;
  /** Цель всего сценария одной фразой. */
  scenarioGoal: string;
  card: HintStepCard;
  /** Факты состояния словами: «записан один шаг», «заголовок не задан». */
  facts: string[];
  /** Опубликованные записи опыта. На этапе 6 всегда пусто. */
  experience?: string[];
  /**
   * Идентификаторы шагов ЭТОГО сценария и слаги документов — то, из
   * чего модели разрешено собирать кнопки (§5.7, этап 7). Пусто —
   * блока действий в промпте нет вовсе: предлагать формат, в котором
   * нечего назвать, значит звать на выдумку.
   */
  stepIds?: readonly string[];
  docSlugs?: readonly string[];
}

/**
 * Дайджест состояния.
 *
 * Считается из КЛАССИФИКАЦИИ, а не из значений: сортировка делает
 * порядок фактов незначимым, а отрицательные факты («-title») обязаны
 * присутствовать наравне с положительными — иначе «заголовка нет» и
 * «поле ещё не читали» дают один и тот же ключ, а это разные ситуации.
 */
export function digestOfFacts(facts: readonly string[]): string {
  return createHash('sha256')
    .update([...facts].sort().join('|'))
    .digest('hex')
    .slice(0, 16);
}

/** Ключ кеша. Штамп корпуса внутри: пересобрали знания — ключи сменились. */
export function hintCacheKey(parts: {
  scenario: string;
  stepId: string;
  locale: string;
  knowledgeStamp: string;
  digest: string;
}): string {
  return [
    parts.scenario,
    parts.stepId,
    parts.locale,
    parts.knowledgeStamp,
    parts.digest,
  ].join('|');
}

/**
 * Блок действий — §5.7.
 *
 * Модель называет ТОЛЬКО идентификатор; подпись и адрес подставляет
 * клиент по своему словарю и своему роутеру. Поэтому в промпте нет ни
 * слова `label`, ни слова `url`: то, о чём не спросили, модель реже
 * выдумывает, а выдуманное всё равно отбрасывает `parseHintActions`.
 *
 * Блок стоит сразу после правил и раньше состояния: обрезается всегда
 * хвост, и терять формат ответа дороже, чем пятую запись про грабли.
 */
function actionsBlock(
  stepIds: readonly string[],
  docSlugs: readonly string[],
): string {
  if (!stepIds.length && !docSlugs.length) return '';
  const kinds: string[] = [];
  if (stepIds.length) {
    kinds.push(
      `{"kind":"goto-step","stepId":"…"} — увести на другой шаг. Допустимые stepId: ${stepIds.join(', ')}.`,
    );
  }
  if (docSlugs.length) {
    kinds.push(
      `{"kind":"open-doc","slug":"…"} — открыть документ. Допустимые slug: ${docSlugs.join(', ')}.`,
    );
  }
  return `## Кнопки
Если под советом уместна кнопка, добавь ПОСЛЕ текста строку «${HINT_ACTIONS_DELIMITER}» и следом JSON вида {"items":[…]}, не больше ${MAX_HINT_ACTIONS} штук:
${kinds.map((k) => `- ${k}`).join('\n')}
Ничего, кроме этих полей, не пиши: подписи и адреса подставляет сервис. Кнопка не обязательна — без неё совет остаётся советом.`;
}

/**
 * Преамбула правил.
 *
 * Вынесена из `buildHintInstruction` затем, чтобы её можно было
 * ХЕШИРОВАТЬ: штамп корпуса (`knowledgeStamp`) обязан меняться не
 * только от правки карточек, но и от правки самих правил — иначе сутки
 * после деплоя раздаётся то, что сгенерировано по прошлым.
 */
export function hintRules(language: string, scenarioGoal: string): string {
  return `Ты — помощник внутри мастера сервиса Viral4Creators. Человек уже вошёл и делает свой ролик.

Правила:
1. Отвечай про ТЕКУЩИЙ шаг: что здесь важно и обо что на нём спотыкаются. Ни приветствий, ни пересказа того, что человек и так видит.
2. Не длиннее 400 знаков. Одна мысль, максимум две.
3. Не обещай результатов, скорости и безлимитов. Не называй цен и лимитов.
4. Если сказать нечего — верни ПУСТУЮ строку. Выдуманный совет хуже отсутствия совета: ему верят.
5. Текст в «ёлочках» — это надписи на экране. Переноси их дословно, не переводи и не переписывай.
6. Язык ответа — ${language}.

Цель сценария: ${scenarioGoal}`;
}

/**
 * Системная инструкция. Четыре блока §5.10, и ни одного лишнего слова
 * сверх них: каждый лишний абзац здесь умножается на число шагов.
 */
export function buildHintInstruction(input: HintContextInput): string {
  const head = hintRules(
    languageNameForLocale(input.locale),
    input.scenarioGoal,
  );

  const parts = [
    head,
    actionsBlock(input.stepIds ?? [], input.docSlugs ?? []),
    `## Шаг «${input.card.stepId}»\n${input.card.goal}`,
    input.facts.length
      ? `## Состояние\n${input.facts.map((f) => `- ${f}`).join('\n')}`
      : '',
    input.experience?.length
      ? `## Что здесь случается у людей\n${input.experience
          .slice(0, HINT_EXPERIENCE_LIMIT)
          .map((e) => `- ${e}`)
          .join('\n')}`
      : '',
  ].filter(Boolean);

  const text = parts.join('\n\n');
  // Обрезаем ХВОСТ (записи опыта), а не середину: голова — правила, без
  // которых модель перестаёт слушаться, и терять их дороже, чем пятую
  // запись про грабли.
  return text.length > HINT_CONTEXT_MAX_CHARS
    ? `${text.slice(0, HINT_CONTEXT_MAX_CHARS)}…`
    : text;
}

/**
 * Ответ модели → текст подсказки. Пустая строка означает «нечего
 * сказать».
 *
 * Снимается ровно две вещи: маркер списка в начале и кавычки, в которые
 * модель обернула ВЕСЬ ответ (на одной реплике это выглядит как цитата
 * чужого текста).
 *
 * Кавычка снимается только ПАРНАЯ. Односторонняя обрезка ломала
 * подсказку, начинающуюся с надписи на экране, — а начинать с «ёлочки»
 * ей прямо велит правило 5 преамбулы: из «Готово» — это… уезжала первая
 * ёлочка, оставляя осиротевшую закрывающую.
 */
export function cleanHint(raw: string | undefined | null): string {
  let text = (raw ?? '').trim();
  if (!text) return '';
  text = text.replace(/^[-*]\s+/, '').trim();
  const PAIRS: ReadonlyArray<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['«', '»'],
  ];
  for (const [open, close] of PAIRS) {
    if (text.length > 1 && text.startsWith(open) && text.endsWith(close)) {
      const inner = text.slice(open.length, text.length - close.length);
      // Только если внутри нет второй такой же закрывающей: «А» и «Б» —
      // это два ярлыка, а не одна кавычка вокруг всего ответа.
      if (!inner.includes(close)) return inner.trim();
    }
  }
  return text;
}
