/**
 * Промпт и разбор ответа для генерации сценария (§4.10 ТЗ) — чистые
 * функции, без сети/Nest, тем же приёмом, что `audit-response.ts`/
 * `blog-analysis-prompt.ts` и другие *-response.ts/*-prompt.ts в проекте
 * (см. их доккомментарии): сборка текста и разбор JSON тестируются без
 * мока Gemini, сервис (`tutorial-scenario-generator.service.ts`) —
 * только вызывает их и делает сетевой вызов.
 *
 * Вход — `AssistantStepItem` из уже существующей, всегда доступной в
 * рантайме бэкенда базы знаний консультанта
 * (`modules/assistant/knowledge/generated.ts`, см. §4.4/§4.10 ТЗ) — та
 * же структура (title/text/details), что уже показывается посетителям
 * лендинга и питает консультанта; не читается из
 * `landing/src/dictionaries` напрямую (в проде бэкенд не видит эти
 * файлы, §2.2/§4.9 ТЗ).
 */

import { AssistantStepItem } from '../assistant/knowledge/generated';
import { ParseScenarioResult, parseScenarioSteps } from './scenario-steps';

/** Реэкспорт словаря примитивов текстом для промпта — короткое
 * человекочитаемое описание каждого, не JSON Schema: модель уже видела
 * тысячи подобных задач, подробная схема здесь не нужна и раздувает
 * промпт зря. */
// Найдено доп. аудитом (MEDIUM): раньше `operation`/`model` были
// голыми плейсхолдерами "<операция>"/"<модель>" — ничего не мешало
// модели угадать неверное значение (например, "video-generation"
// вместо "generation"), а валидация (scenario-steps.ts) всё-или-ничего
// — одно неверное значение роняет ВЕСЬ сценарий, причём именно на
// платном шаге, ради которого нужна была прикидка стоимости (§4.11).
// Перечисляем реальные значения `AiOperation`, какие в принципе может
// запустить экран мастера генерации (`common/ai-pricing.ts`).
const STEP_VOCABULARY = `- {"kind":"goto","route":"<ключ маршрута>"} — открыть экран
- {"kind":"fill","selector":"<CSS-селектор>","value":"<текст>"} — заполнить поле
- {"kind":"click","selector":"<CSS-селектор>"} — нажать
- {"kind":"waitFor","selector":"<CSS-селектор>"} — дождаться появления элемента
- {"kind":"assertVisible","selector":"<CSS-селектор>"} — проверить, что элемент виден (для regression-теста)
- {"kind":"assertText","selector":"<CSS-селектор>","value":"<ожидаемый текст>"} — проверить текст элемента
- {"kind":"triggerPaidOperation","operation":"generation"|"voiceover"|"voiceover-preview"|"voice-clone"|"avatar-generation","model":"<точное имя модели провайдера>","expectedUnits":{"seconds":<число>|"characters":<число>|"calls":<число>},"note":"<кратко зачем>"} — ставится ПЕРЕД шагом, который реально запускает платный вызов (рендер видео — "generation", озвучка — "voiceover"/"voiceover-preview"/"voice-clone", аватар-пилот — "avatar-generation"), только когда такой шаг в сценарии есть. "operation" — строго одно из перечисленных значений, ничего другого. "expectedUnits" — ОБЯЗАТЕЛЬНО заполни хотя бы одно поле (пустой объект отклоняется целиком)`;

export function buildScenarioPrompt(
  subjectKey: string,
  locale: string,
  step: AssistantStepItem,
): string {
  const lines = [
    `Ты помогаешь автоматизировать съёмку обучающего видео по шагу мастера генерации рекламных роликов (шаг "${subjectKey}", локаль ${locale}).`,
    '',
    `Заголовок шага: ${step.title}`,
    `Описание: ${step.text}`,
  ];
  if (step.details.length > 0) {
    lines.push('Детали:');
    for (const d of step.details) lines.push(`- ${d}`);
  }
  lines.push(
    '',
    'Опиши сценарий действий headless-браузера, который пройдёт по этому шагу интерфейса и позволит записать видео — короткую последовательность из СЛЕДУЮЩИХ примитивов, и только их:',
    STEP_VOCABULARY,
    '',
    'Не придумывай реальные CSS-селекторы наугад — используй понятные семантические плейсхолдеры вида [data-testid="..."], которые оператор при необходимости поправит на настоящие перед первым исполнением. То же касается "route" в шаге goto — это тоже плейсхолдер (например "wizard.generation"), не настоящее имя маршрута из кода фронтенда; оператор сверит и поправит перед первым исполнением.',
    'Если этот шаг мастера сам по себе не запускает платную генерацию/переозвучку — НЕ добавляй triggerPaidOperation вовсе.',
    'Ответь СТРОГО JSON без пояснений вокруг: {"steps":[...]}',
  );
  return lines.join('\n');
}

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json\n?|```\n?/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseScenarioResponse(text: string): ParseScenarioResult {
  const json = extractJson(text);
  if (!json) return { ok: false, steps: [], reason: 'ответ не JSON-объект' };
  return parseScenarioSteps(json.steps);
}
