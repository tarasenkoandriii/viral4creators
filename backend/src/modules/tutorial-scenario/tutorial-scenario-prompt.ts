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
import {
  DroppedPaidOperation,
  isTriggerPaidOperationStep,
  ParseScenarioResult,
  parseScenarioSteps,
} from './scenario-steps';
import {
  MAX_NARRATION_LENGTH,
  WIZARD_PAID_OPERATIONS,
  WizardPaidOperation,
} from './scenario-steps.types';
import { MODEL_RATES } from '../../common/ai-pricing';
import { VideoProviderKey } from '../generation/default-video-provider';
import { ROUTE_DESCRIPTIONS } from '../tutorial-runner/route-templates';
import { knownQaHook, qaSelector, QA_HOOKS } from './qa-hooks';
import { languageNameForLocale } from '../../common/locale';

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
// запустить экран мастера генерации.
//
// Этап F (ТЗ docs-tz/TZ-Tutorial-Video-Voiced.md): перечень больше не
// пишется здесь руками, а берётся из `WIZARD_PAID_OPERATIONS` — того
// же списка, по которому отказывает валидатор. До этапа промпт называл
// пять значений, а валидатор принимал все ключи отчёта расходов; две
// стороны одного контракта расходились в восемь раз, и разошлись бы
// дальше с первой же новой строкой отчёта.
//
// Пояснение к каждому значению — `Record` по тому же типу: забыть
// пояснение к новой операции не даст компилятор, а не память.
const PAID_OPERATION_HINT: Record<WizardPaidOperation, string> = {
  generation: 'рендер видео',
  voiceover: 'озвучка ролика',
  'voiceover-preview': 'проба голоса',
  'voice-clone': 'клонирование голоса',
  'avatar-generation': 'аватар-пилот',
};
/**
 * Что модели предлагается объявить — не весь белый список, а только
 * ДОСТИЖИМОЕ: операции, ради которых в каталоге хуков есть кнопка
 * (находка повторного аудита этапа F).
 *
 * Список и достижимость разошлись не по недосмотру этапа F, а позже:
 * этап I свёл клики к каталогу `QA_HOOKS`, и платный клик остался
 * ровно один. Промпт при этом продолжал называть пять операций —
 * четыре из них модель могла объявить, но нажать соответствующую
 * кнопку было нечем, и сценарий уходил в `costly` впустую (см.
 * `dropDanglingPaidOperations`).
 *
 * Выводится из каталога, а не переписано руками короче: руками
 * написанный список разошёлся бы снова при первой же новой платной
 * кнопке. `WIZARD_PAID_OPERATIONS` при этом остаётся тем, что
 * ПРИНИМАЕТ валидатор, — надмножеством: сценарии, сохранённые до
 * этапа I, должны разбираться по-прежнему.
 */
const REACHABLE_PAID_OPERATIONS: readonly WizardPaidOperation[] =
  WIZARD_PAID_OPERATIONS.filter((op) =>
    Object.values(QA_HOOKS).some((hook) => hook.clickCost === op),
  );
const PAID_OPERATION_VALUES = REACHABLE_PAID_OPERATIONS.map(
  (op) => `"${op}"`,
).join('|');
const PAID_OPERATION_HINTS = REACHABLE_PAID_OPERATIONS.map(
  (op) => `${PAID_OPERATION_HINT[op]} — "${op}"`,
).join(', ');

/**
 * Закрытый список имён моделей для `triggerPaidOperation.model` —
 * находка сквозного аудита 29.09.2026.
 *
 * Промпт до неё писал `"model":<ОДНО имя из списка ниже, буква в букву>`, а
 * валидатор принимал любую непустую строку. Ключи прайса при этом
 * узкие (`veo-3.1-generate-preview`, `grok-imagine-video-1.5:720p`), и
 * угадать их модель не могла — значит прикидка ВСЕГДА выходила нулём с
 * подписью «занижена», а оператор одобрял трату вслепую.
 *
 * Это третий раз, когда одно и то же лечится одинаково: выдуманные
 * маршруты (`wizard.step-N`, этап 106) и выдуманные селекторы (этап I)
 * закрывались ровно так же — закрытым списком настоящих значений в
 * промпт и отказом валидатора на всём остальном. Имена моделей были
 * последним местом, где список так и не завели.
 *
 * Берётся из прайса, а не переписывается руками: ставки меняются, и
 * руками написанный список разошёлся бы с ними молча — то есть вернул
 * бы ровно тот ноль, ради которого всё это и заводится.
 *
 * Отбор — по ПРОВАЙДЕРАМ, которые мастер вообще умеет выбрать
 * (`VIDEO_PROVIDER_KEYS` в `generation/default-video-provider.ts`), а не
 * по «есть ставка за секунду»: по секундам считаются ещё и говорящий
 * аватар, и клон голоса — модели, которых кнопка «Сгенерировать
 * рекламный ролик» не запускает никогда. Пустить их в список значило бы
 * заменить нулевую прикидку на уверенно НЕВЕРНУЮ, а это хуже: у нуля
 * хотя бы есть подпись «занижена».
 *
 * ## Промпт просит модели ОДНОГО провайдера — того, что стоит по
 * умолчанию
 *
 * Правка 29.09.2026, по замечанию владельца: провайдер по умолчанию —
 * **Grok**, а не Veo (`default-video-provider.ts`, `FALLBACK_KEY =
 * 'grok'`; у Grok дешевле и больше слотов под референсы). Первая
 * редакция этого списка давала модели все восемь имён сразу, и это
 * заводило НОВУЮ ошибку вместо исправленной: сценарий, объявивший
 * `veo-3.1-generate-preview`, получал прикидку $3.20 за восьмисекундный
 * ролик, а продукт отрендерил бы его Grok'ом 480p за $0.64 — впятеро
 * меньше. Оператор одобряет не ту сумму; для гейта одобрения это ровно
 * такая же поломка, как ноль, просто в другую сторону.
 *
 * Поэтому промпт печатает модели ТОГО провайдера, который реально
 * предзаполнен в мастере, а валидатор по-прежнему принимает любую
 * оцениваемую модель мастера. Асимметрия намеренная: промпт ведёт
 * новые сценарии к верной прикидке, а валидатор не обязан ломать
 * сценарии, сохранённые до смены умолчания, — при смене провайдера они
 * перегенерируются ближайшей ночью сами.
 */
const WIZARD_VIDEO_PROVIDERS: Record<VideoProviderKey, string> = {
  veo: 'VEO',
  grok: 'GROK',
};

function pricedModelsOf(providers: readonly string[]): string[] {
  return Object.entries(MODEL_RATES)
    .filter(
      ([, rate]) =>
        providers.includes(rate.provider) && rate.perSecond !== undefined,
    )
    .map(([name]) => name)
    .sort();
}

/** Все оцениваемые движки мастера — то, что ПРИНИМАЕТ валидатор. */
export const PRICED_VIDEO_MODELS: readonly string[] = pricedModelsOf(
  Object.values(WIZARD_VIDEO_PROVIDERS),
);

/** Модели одного провайдера — то, что промпт ПРЕДЛАГАЕТ модели. */
export function pricedModelsForProvider(
  provider: VideoProviderKey,
): readonly string[] {
  return pricedModelsOf([WIZARD_VIDEO_PROVIDERS[provider]]);
}

const STEP_VOCABULARY = `- {"kind":"goto","route":"<ключ маршрута>","narration":"<реплика диктора>"} — открыть экран
- {"kind":"fill","selector":"<CSS-селектор>","value":"<текст>","narration":"<реплика диктора>"} — заполнить поле
- {"kind":"click","selector":"<CSS-селектор>","narration":"<реплика диктора>"} — нажать
- {"kind":"waitFor","selector":"<CSS-селектор>","narration":"<реплика диктора>"} — дождаться появления элемента
- {"kind":"assertVisible","selector":"<CSS-селектор>","narration":"<реплика диктора>"} — проверить, что элемент виден (для regression-теста)
- {"kind":"assertText","selector":"<CSS-селектор>","value":"<ожидаемый текст>","narration":"<реплика диктора>"} — проверить текст элемента
- {"kind":"triggerPaidOperation","operation":${PAID_OPERATION_VALUES},"model":<ОДНО имя из списка ниже, буква в букву>,"expectedUnits":{"seconds":<число>|"characters":<число>|"calls":<число>},"note":"<кратко зачем>"} — ставится ПЕРЕД шагом, который реально запускает платный вызов (${PAID_OPERATION_HINTS}), только когда такой шаг в сценарии есть. "operation" — строго одно из перечисленных значений, ничего другого. "expectedUnits" — для рендера ролика ОБЯЗАТЕЛЬНО "seconds" (по нему считается цена; "calls"/"characters" дадут нулевую прикидку и сценарий будет отклонён)`;

/** Список допустимых "route" для goto текстом в промпт — найдено этим
 * этапом: раньше промпт называл "route" плейсхолдером и приводил В
 * ПРИМЕРЕ несуществующее имя ("wizard.generation"), из-за чего модель
 * почти всегда придумывала маршруты вида "wizard.step-N", которых нет
 * ни в одном сценарии — 9 из 9 сгенерированных сценариев падали на
 * самом первом шаге при реальном прогоне на проде. Единственный
 * источник этого списка — `ROUTE_DESCRIPTIONS`
 * (`tutorial-runner/route-templates.ts`), та же таблица, что резолвит
 * "route" в настоящий путь при исполнении — расхождения между тем, что
 * модели РАЗРЕШЕНО написать, и тем, что раннер способен резолвить,
 * структурно невозможны. */
const ROUTE_VOCABULARY = Object.entries(ROUTE_DESCRIPTIONS)
  .map(([key, desc]) => `- "${key}" — ${desc}`)
  .join('\n');

/**
 * Закрытый список селекторов для промпта — этап I ТЗ
 * docs-tz/TZ-Tutorial-Video-Voiced.md, тем же приёмом, что
 * `ROUTE_VOCABULARY` выше. Сгруппирован по маршрутам: модели проще не
 * путать кнопку экрана товара с кнопкой мастера, когда рядом написано,
 * где она живёт. Селектор выписан целиком, в той форме, в какой его
 * нужно скопировать, — чтобы не было соблазна «доработать» кавычки.
 */
const QA_VOCABULARY = (() => {
  const byRoute = new Map<string, string[]>();
  for (const [key, hook] of Object.entries(QA_HOOKS)) {
    const lines = byRoute.get(hook.route) ?? [];
    const cost =
      hook.clickCost === 'forbidden'
        ? ' [НЕ НАЖИМАТЬ: платный вызов вне списка операций — только waitFor/assertVisible]'
        : hook.clickCost
          ? ` [перед click обязателен triggerPaidOperation с operation "${hook.clickCost}"]`
          : '';
    // Позиция степпера есть в DOM всегда, но её кнопка ВЫКЛЮЧЕНА,
    // пока шаг не пройден (находка боевого прогона 29.09.2026). Без
    // этой пометки модель писала «открыть экран → нажать нужный шаг»,
    // и такой клик ждал включения кнопки тридцать секунд и падал.
    const visited = hook.clickOnlyWhenVisited
      ? ' [НЕ НАЖИМАТЬ для перехода: кнопка выключена, пока шаг не пройден; ' +
        'click только чтобы ВЕРНУТЬСЯ на уже пройденный шаг. Ждать и ' +
        'проверять можно всегда]'
      : '';
    lines.push(`  - ${qaSelector(key)} — ${hook.description}${cost}${visited}`);
    byRoute.set(hook.route, lines);
  }
  return [...byRoute.entries()]
    .map(([route, lines]) => `- экран "${route}":\n${lines.join('\n')}`)
    .join('\n');
})();

export function buildScenarioPrompt(
  subjectKey: string,
  locale: string,
  step: AssistantStepItem,
  /** Провайдер видео, предзаполненный в мастере. Модель должна
   *  объявлять ЕГО движок, иначе прикидка разойдётся с настоящей
   *  тратой в разы — см. `pricedModelsForProvider`. Умолчание тут
   *  повторяет `FALLBACK_KEY` продукта, чтобы вызывающий, не читавший
   *  настройку, получал верное поведение, а не тихо неверное. */
  videoProvider: VideoProviderKey = 'grok',
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
    // До этапа I здесь стояло приглашение писать «семантические
    // плейсхолдеры [data-qa="..."], которые оператор поправит» — а
    // настоящих хуков во фронтенде не было ни одного из нужных. Каждый
    // сгенерированный сценарий падал на первом click, ни один ролик не
    // собирался. Теперь — закрытый список, и валидатор ниже отвергает
    // всё, что не из него (`qa-hooks.ts`).
    '"selector" — НЕ плейсхолдер и НЕ произвольный CSS. Используй ТОЛЬКО селекторы из списка ниже, копируя их буква в букву вместе с квадратными скобками и кавычками; никаких классов, id, текста кнопок, потомков через пробел и :nth-child. Сценарий с любым другим селектором будет отклонён целиком. Если для задуманного действия подходящего селектора в списке нет — не делай этого действия, обойдись assertVisible по ближайшей карточке:',
    QA_VOCABULARY,
    'Пометки в квадратных скобках после описания — жёсткие правила: кнопку с пометкой «НЕ НАЖИМАТЬ» нельзя использовать в click (сценарий будет отклонён), а перед click по кнопке с пометкой про triggerPaidOperation этот шаг должен стоять ПРЯМО перед click.',
    '"route" в шаге goto — НЕ плейсхолдер, это настоящее имя экрана. Выбери РОВНО ОДНО значение из списка ниже, скопировав его буква в букву (без точек, без "wizard.", без придуманных суффиксов вроде "step-3") — других маршрутов в продукте не существует:',
    ROUTE_VOCABULARY,
    'Мастер создания ролика ("generate") и экран товара ("item") — однастраничные: если шаг обучалки описывает происходящее ВНУТРИ них (выбор референса, разбор, промпт, формат, рендер — всё это "generate"; фото/аналоги/голос/цена товара — всё это "item"), goto делается ОДИН раз в начале сценария на этот экран, а дальнейшее продвижение по шагам мастера описывается click/fill/waitFor, не повторными goto на разные маршруты.',
    'Если этот шаг мастера сам по себе не запускает платную генерацию/переозвучку — НЕ добавляй triggerPaidOperation вовсе.',
    // Третий закрытый список в этом промпте, по той же причине, что
    // маршруты и селекторы: угаданное имя модели даёт нулевую прикидку,
    // и оператор одобряет трату вслепую (сквозной аудит 29.09.2026).
    `"model" в triggerPaidOperation — тоже НЕ плейсхолдер. В мастере предзаполнен движок «${videoProvider}», и объявлять надо ЕГО модель: иначе прикидка стоимости разойдётся с настоящей тратой в разы. Выбери РОВНО ОДНО имя из списка ниже, буква в букву:\n${pricedModelsForProvider(
      videoProvider,
    )
      .map((m) => `- ${m}`)
      .join('\n')}`,
    // Язык — отдельной инструкцией, ЯВНЫМ названием и с примером
    // (этап C). До него в промпте стоял только ISO-код в первой
    // строке, справкой: `assertText` уезжал по-русски в сценарий
    // любой локали, и отказ был тихим — интерфейс на испанском,
    // ожидаемый текст на русском, падение на пятом шаге с виду
    // непонятной причиной. Название языка, а не код: модель читает
    // `uk` как United Kingdom (та же находка, что у
    // `languageNameForLocale`).
    `Интерфейс продукта будет открыт НА ЯЗЫКЕ: ${languageNameForLocale(locale)} (код локали ${locale}). Поэтому весь текст, который сценарий СРАВНИВАЕТ с экраном или ВВОДИТ в поля, пиши на этом языке: поле "value" у assertText — ожидаемая надпись интерфейса именно на нём, поле "value" у fill — то, что осмысленно ввести пользователю этого языка. Не переводи и не транслитерируй CSS-селекторы, имена маршрутов, ключи операций и названия моделей — они одинаковы во всех локалях.`,
    // ── Реплики (§3-бис.3 ТЗ docs-tz/TZ-Tutorial-Video-Voiced.md,
    //    этап D) ──────────────────────────────────────────────────
    //
    // Три абзаца, в том же стиле «перечисляем настоящие значения, а
    // не плейсхолдеры», которым этот промпт уже дважды поплатился:
    // выдуманные маршруты `wizard.step-N` роняли 9 из 9 сценариев,
    // угаданные имена операций роняли платный шаг.
    //
    // Потолок длины берётся из `MAX_NARRATION_LENGTH`, а не пишется
    // числом: инструкция модели и отказ валидатора обязаны говорить
    // одно и то же, иначе модель послушно пишет 240 символов, а
    // разбор молча выкидывает реплику.
    `К каждому шагу, КРОМЕ triggerPaidOperation, добавь поле "narration" — одну фразу от первого лица множественного числа («открываем», «заполняем»), которую диктор произнесёт, пока на экране результат ЭТОГО шага. Не описывай интерфейс («видим кнопку внизу») — говори, что делаем и зачем. У triggerPaidOperation реплики быть не должно: это служебный маркер, произносить нечего.`,
    `Длина реплики — до ${MAX_NARRATION_LENGTH} символов, одной строкой, без переводов строк. Язык реплики — тот же, что у описания шага выше (${languageNameForLocale(locale)}).`,
    'Не повторяй дословно описание шага обучалки — его человек уже читал на лендинге. Не нумеруй («шаг 1»): порядок виден и так. Не обещай того, чего на кадре не будет.',
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
  if (!json) {
    return {
      ok: false,
      steps: [],
      reason: 'ответ не JSON-объект',
      droppedNarrations: [],
      droppedPaidOperations: [],
    };
  }
  return validateScenarioSteps(json.steps);
}

/**
 * Полная проверка списка шагов — ОДНА на все источники: ответ модели и
 * ручная правка оператора в админке.
 *
 * ## Почему одна
 *
 * До сквозного аудита 29.09.2026 источников было два с разными
 * правилами: `parseScenarioResponse` вёл ответ модели через
 * `rejectUnknownSelectors` + `dropDanglingPaidOperations`, а
 * `TutorialScenarioAdminService.replaceSteps` звал `parseScenarioSteps`
 * напрямую. Обоснование стояло прямо в доккомментарии
 * `rejectUnknownSelectors`: «человек, который правит руками, видит
 * экран сам».
 *
 * Про экран это верно, а про деньги — нет. Ручная правка исполняется
 * тем же ночным кроном КАЖДУЮ ночь, и оператор, сохранивший
 * `click [data-qa="relevance-check"]`, видел экран один раз, а платный
 * разбор Gemini уходил бы каждую ночь. Хуже: такая строка получала
 * `costly: false` (стоимость считается по `triggerPaidOperation`-шагам,
 * которых в ней нет), то есть кнопки одобрения у неё не появлялось
 * вовсе — гейт не просто обходился, он был неприменим.
 *
 * Правило поэтому одно: что нельзя написать модели, нельзя сохранить и
 * руками. Селектор вне каталога отвергается тоже — ночью он всё равно
 * уронит сценарий, только позже и за деньги сборки.
 */
export function validateScenarioSteps(rawSteps: unknown): ParseScenarioResult {
  const parsed = parseScenarioSteps(rawSteps);
  if (!parsed.ok) return parsed;
  return dropDanglingPaidOperations(
    rejectUnpricedModels(rejectUnknownSelectors(parsed)),
  );
}

/**
 * Отказ шагу `triggerPaidOperation`, чью модель нельзя оценить в
 * деньгах (сквозной аудит 29.09.2026).
 *
 * Отказ целиком, а не вырезание: вырезать значило бы сделать платный
 * сценарий бесплатным на вид и пустить его мимо гейта одобрения — то
 * есть ровно та поломка, от которой гейт и стоит. Пусть лучше
 * сценарий пересоберётся следующей ночью с именем из списка.
 *
 * Проверяется имя И единицы: ставка видеомодели задана в секундах, и
 * `expectedUnits: {calls: 1}` при верном имени даёт тихий ноль без
 * всякой пометки. Оба случая называются оператору поимённо — он по
 * сообщению видит, промахнулась модель или отстал прайс.
 */
function rejectUnpricedModels(
  parsed: ParseScenarioResult,
): ParseScenarioResult {
  for (let i = 0; i < parsed.steps.length; i++) {
    const step = parsed.steps[i];
    if (!isTriggerPaidOperationStep(step)) continue;
    const refuse = (why: string): ParseScenarioResult => ({
      ok: false,
      steps: [],
      reason: `шаг ${i + 1} (triggerPaidOperation): ${why}`,
      droppedNarrations: [],
      droppedPaidOperations: [],
    });
    if (!PRICED_VIDEO_MODELS.includes(step.model)) {
      return refuse(
        `модели «${step.model}» нет среди оцениваемых (common/ai-pricing.ts) — ` +
          'прикидка вышла бы нулём, и оператор одобрял бы трату вслепую',
      );
    }
    if (!step.expectedUnits.seconds) {
      return refuse(
        `у модели «${step.model}» ставка задана за секунду, а expectedUnits.seconds не заполнен — ` +
          'прикидка вышла бы нулём без всякой пометки',
      );
    }
  }
  return parsed;
}

/**
 * Вырезает `triggerPaidOperation`, за которым не следует платный клик
 * (находка повторного аудита этапа F).
 *
 * ## Что ломалось
 *
 * Правило платных кнопок работало в ОДНУ сторону: клик по платному
 * хуку требовал объявления перед собой. Объявление без клика не
 * проверял никто — а стоило оно дорого. `estimateScenarioCost`
 * считает `costly` по одним только `triggerPaidOperation`-шагам, и
 * ночной прогон берёт сценарии по `OR: [{costly:false},{approved:true}]`.
 * То есть сценарий, объявивший платный вызов и никуда не нажавший,
 * получал `costly: true`, выпадал из выборки и ролика не получал
 * ВОВСЕ — до ручного одобрения траты, которой в нём не случится.
 * Строки в журнале при этом нет: сценарий просто не попадает в
 * `findMany`.
 *
 * Попасть туда было легко. В `WIZARD_PAID_OPERATIONS` пять операций, а
 * платный клик после этапа I есть ровно у одного хука
 * (`video-generate` → `generation`). Четыре значения из пяти нажать
 * нечем в принципе, и промпт при этом честно предлагал модели все
 * пять.
 *
 * ## Почему вырезать, а не отказывать
 *
 * Отказ выбросил бы сценарий целиком — вместе с десятком исправных
 * шагов и ради шага, который при исполнении и так no-op
 * (`scenario-runner.ts`). Это то же решение, что у негодной реплики:
 * вырезать плохую часть, сохранить ролик, сказать оператору. «Ролик
 * получается ВСЕГДА» (§3 ТЗ) — про это.
 *
 * Номер шага — ИСХОДНЫЙ, до вырезания: оператор читает его рядом с
 * ответом модели, а не с уже почищенным списком.
 */
function dropDanglingPaidOperations(
  parsed: ParseScenarioResult,
): ParseScenarioResult {
  if (!parsed.ok) return parsed;
  const dropped: DroppedPaidOperation[] = [];
  const steps = parsed.steps.filter((step, i) => {
    if (!isTriggerPaidOperationStep(step)) return true;
    const next = parsed.steps[i + 1];
    const key = next && 'selector' in next ? knownQaHook(next.selector) : null;
    const paidBy = key === null ? undefined : QA_HOOKS[key].clickCost;
    if (next && next.kind === 'click' && paidBy === step.operation) {
      return true;
    }
    dropped.push({
      stepNumber: i + 1,
      operation: step.operation,
      reason:
        `объявлен платный вызов "${step.operation}", но следом за ним ` +
        'нет нажатия кнопки, которая его запускает — сценарий считался ' +
        'бы платным и ждал бы одобрения оператора впустую',
    });
    return false;
  });
  return { ...parsed, steps, droppedPaidOperations: dropped };
}

/**
 * Отказ сценарию с селектором не из каталога (этап I). Целиком, а не
 * вырезанием шага: без клика следующий шаг ждёт экран, которого не
 * будет, — то есть сценарий всё равно упадёт, только ночью и за деньги
 * сборки. Названы номер шага и сам селектор — по ним оператор видит,
 * придумала модель кнопку или каталог отстал от продукта.
 *
 * Зовётся из `validateScenarioSteps` — то есть и для ответа модели, и
 * для ручной правки оператора. Разделения больше нет, см. её
 * доккомментарий: прежнее «человек видит экран сам» верно про экран и
 * неверно про деньги.
 */
function rejectUnknownSelectors(
  parsed: ParseScenarioResult,
): ParseScenarioResult {
  for (let i = 0; i < parsed.steps.length; i++) {
    const step = parsed.steps[i];
    if (!('selector' in step)) continue;
    const key = knownQaHook(step.selector);
    const refuse = (why: string): ParseScenarioResult => ({
      ok: false,
      steps: [],
      reason: `шаг ${i + 1} (${step.kind}): ${why}`,
      droppedNarrations: [],
      droppedPaidOperations: [],
    });
    if (key === null) {
      return refuse(
        `селектор «${step.selector}» не из каталога хуков data-qa (tutorial-scenario/qa-hooks.ts)`,
      );
    }
    // Платные кнопки (аудит этапа I): клик мимо гейта одобрения
    // тратил бы деньги каждую ночь без ведома оператора.
    const cost = QA_HOOKS[key].clickCost;
    if (step.kind !== 'click' || !cost) continue;
    if (cost === 'forbidden') {
      return refuse(
        `«${key}» запускает платный вызов, которого нет среди операций triggerPaidOperation, — нажимать его сценарию нельзя`,
      );
    }
    const before = parsed.steps[i - 1];
    if (
      !before ||
      before.kind !== 'triggerPaidOperation' ||
      before.operation !== cost
    ) {
      return refuse(
        `перед нажатием «${key}» нужен triggerPaidOperation с operation "${cost}" — без него сценарий не попадёт под одобрение оператора`,
      );
    }
  }
  return parsed;
}
