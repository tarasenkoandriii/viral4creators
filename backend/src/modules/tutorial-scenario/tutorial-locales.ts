/**
 * tutorial-locales.ts — на каких языках генерировать сценарии
 * обучающих роликов (этап C ТЗ `docs-tz/TZ-Tutorial-Video-Voiced.md`).
 *
 * Пятый уровень отката §9: «локали ломаются — сузить до `['ru']`, уже
 * снятые ролики остаются, новые не создаются, без деплоя». Значит
 * настройка, а не константа и не переменная окружения.
 *
 * Разбор — терпимый, по образцу `parseMusicCatalog`
 * (`common/greeting-music.ts`): негодный элемент выбрасывается, годные
 * остаются. Строгий разбор здесь был бы вреден по той же причине, что
 * и там: опечатка в пятой локали не должна отключать четыре рабочих.
 * Это осознанно ДРУГОЕ правило, чем у `parseScenarioSteps`, где одна
 * плохая запись роняет весь сценарий, — там порядок шагов значим и
 * дыра посередине даёт «рабочий на вид» сценарий, здесь список
 * неупорядочен и дыра безобидна.
 */

import {
  ASSISTANT_STEPS,
  AssistantStepItem,
} from '../assistant/knowledge/generated';
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  SupportedLocale,
} from '../../common/locale';

export const TUTORIAL_LOCALES_SETTING_KEY = 'tutorial.scenarioLocales';

/**
 * Что действует, пока настройку не тронули.
 *
 * Только русский — ровно то, что генератор делал до этапа C с
 * константой `SUBJECT_LOCALE = 'ru'`. Деплой этапа не должен сам по
 * себе учетверить ночной расход: пять локалей — это пять генераций
 * (≈$0.21), потом пятьдесят сборок и пятьдесят синтезов (≈$6). Тот же
 * довод, по которому `postprod.tutorialVoice` выключена по умолчанию:
 * решение человека, а не побочный эффект выката.
 */
export const DEFAULT_TUTORIAL_LOCALES: readonly SupportedLocale[] = [
  DEFAULT_LOCALE,
];

/**
 * Разбирает значение настройки.
 *
 * Принимает две формы, как `parseMusicCatalog`: голый JSON-массив
 * (`["ru","en"]`) и объект (`{"locales":["ru","en"]}`). Плюс третья,
 * которой там нет, — список через запятую (`ru, en`): оператор пишет
 * её руками чаще, чем JSON, а отличить её от JSON тривиально.
 *
 * Пустой или неразбираемый ввод — умолчание (`['ru']`), а НЕ пустой
 * список: пустой список значит «не генерировать ничего», и приходить
 * к нему из-за опечатки в кавычках нельзя. Чтобы выключить генерацию
 * целиком, есть выключатель самого крона.
 *
 * Порядок сохраняется, дубли схлопываются (побеждает первый),
 * неподдерживаемые коды отбрасываются молча — их перечислит витрина
 * («прислали N, приняли M»), тот же приём, что у каталога музыки.
 */
export function parseTutorialLocales(stored: string | null): SupportedLocale[] {
  const raw = (stored ?? '').trim();
  if (raw.length === 0) return [...DEFAULT_TUTORIAL_LOCALES];

  const candidates = readLocaleCandidates(raw);
  if (candidates === null) return [...DEFAULT_TUTORIAL_LOCALES];

  const out: SupportedLocale[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    if (typeof item !== 'string') continue;
    const code = item.trim().toLowerCase();
    if (!isSupportedLocale(code) || seen.has(code)) continue;
    seen.add(code);
    // Потолка нет и не нужно: в `out` попадают только поддерживаемые
    // и только неповторяющиеся коды, поэтому длиннее
    // `SUPPORTED_LOCALES` он стать не может в принципе. Прежняя
    // страховка `if (out.length === …) break` была мёртвой строкой —
    // её удаление не меняло ни одного теста (находка аудита этапа C).
    out.push(code);
  }
  // Ни одного годного кода среди присланных — тоже умолчание, а не
  // тишина: `["fr"]` это опечатка оператора, а не команда «ничего не
  // генерировать».
  return out.length > 0 ? out : [...DEFAULT_TUTORIAL_LOCALES];
}

/**
 * Коды в том виде, в каком их прислал оператор, — ДО фильтрации.
 *
 * Экспортируется, чтобы витрина в админке считала «прислали N,
 * приняли M» ТЕМ ЖЕ разбором, каким читает список генератор. Своя
 * копия у витрины уже разошлась с этой: на вводе `{"a":1}` она
 * показывала «прислали 0, отброшено 0», то есть молчала, а
 * генератор подставлял умолчание (находка сквозного аудита A+B+C).
 *
 * `null` — «это вообще не список»: ввод есть, а кодов из него не
 * достать. Витрина показывает это как «отброшено целиком», разбор —
 * как умолчание.
 */
export function readLocaleCandidates(raw: string): unknown[] | null {
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') {
        const locales = (parsed as { locales?: unknown }).locales;
        return Array.isArray(locales) ? locales : null;
      }
      return null;
    } catch {
      return null;
    }
  }
  return raw.split(',');
}

/** Значение для записи в настройку — канонической JSON-формой, какой
 * бы ни пришёл ввод оператора. */
export function serializeTutorialLocales(
  locales: readonly SupportedLocale[],
): string {
  return JSON.stringify(locales);
}

/**
 * Карточка шага обучалки по ключу и локали, или `null`.
 *
 * Правило «ключ — это 1..10, индекс в `ASSISTANT_STEPS[locale]`»
 * жило в трёх копиях: `resolveTutorialVideoTitle` (исполнитель),
 * `narrationTextForSubject` (озвучка) и проверка локали при
 * диагностике отказа. Копии совпадали посимвольно — значит одна из
 * них рано или поздно отстала бы (находка сквозного аудита A+B+C).
 *
 * Живёт здесь, а не в `tutorial-voice.ts`: правило про КЛЮЧ и
 * ЛОКАЛЬ, а не про озвучку, и нужно оно обоим модулям.
 */
export function tutorialStepFor(
  subjectKey: string,
  locale: string,
): AssistantStepItem | null {
  const steps = ASSISTANT_STEPS[locale] ?? [];
  const index = Number(subjectKey);
  if (!Number.isInteger(index) || index < 1 || index > steps.length) {
    return null;
  }
  return steps[index - 1] ?? null;
}

/** Есть ли у локали словарь шагов вообще. Отличает «ключ не тот» от
 *  «языка нет», а это разные отказы и разные сообщения. */
export function hasTutorialSteps(locale: string): boolean {
  return (ASSISTANT_STEPS[locale]?.length ?? 0) > 0;
}
