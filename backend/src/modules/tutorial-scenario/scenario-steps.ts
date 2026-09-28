/**
 * Валидация словаря шагов сценария (scenario-steps.types.ts, §4.10 ТЗ).
 *
 * Отличие от `assistant/actions.ts` (тоже парсит JSON от модели по
 * белому списку): там невалидный ПУНКТ списка просто выбрасывается —
 * кнопка необязательна, посетитель и так получил текстовый ответ. Здесь
 * НАОБОРОТ: один невалидный шаг роняет ВЕСЬ сценарий. Причина —
 * порядок шагов имеет смысл (`goto` → `fill` → `click` → `waitFor`), и
 * молча выбросить шаг из середины даёт сценарий, который выглядит
 * рабочим, но на самом деле пропускает действие — хуже, чем явно
 * отказаться от генерации в этом прогоне и попробовать в следующий раз.
 */

import { stableStringify } from '../../common/stable-json';
import {
  MAX_NARRATION_LENGTH,
  MAX_SCENARIO_STEPS,
  ScenarioStep,
  SCENARIO_STEP_KINDS,
  WIZARD_PAID_OPERATIONS,
} from './scenario-steps.types';

/**
 * Белый список `triggerPaidOperation.operation` — ровно то, что
 * перечисляет промпт, а не все ключи отчёта расходов. См.
 * доккомментарий `WIZARD_PAID_OPERATIONS`: до этапа F здесь стояло
 * `Object.keys(AI_OPERATION_LABEL)`, и каждая новая строка отчёта
 * расширяла словарь модели.
 */
const VALID_OPERATIONS: ReadonlySet<string> = new Set(WIZARD_PAID_OPERATIONS);

/** Непустая строка разумной длины — общая проверка для selector/route/value. */
function isNonEmptyString(v: unknown, maxLen = 500): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}

function isValidScenarioStep(value: unknown): value is ScenarioStep {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.kind !== 'string' ||
    !SCENARIO_STEP_KINDS.includes(v.kind as ScenarioStep['kind'])
  ) {
    return false;
  }
  switch (v.kind as ScenarioStep['kind']) {
    case 'goto':
      return isNonEmptyString(v.route, 200);
    case 'fill':
      return (
        isNonEmptyString(v.selector, 200) &&
        typeof v.value === 'string' &&
        v.value.length <= 2000
      );
    case 'click':
    case 'waitFor':
    case 'assertVisible':
      return isNonEmptyString(v.selector, 200);
    case 'assertText':
      return (
        isNonEmptyString(v.selector, 200) && isNonEmptyString(v.value, 2000)
      );
    case 'triggerPaidOperation': {
      if (
        typeof v.operation !== 'string' ||
        !VALID_OPERATIONS.has(v.operation)
      ) {
        return false;
      }
      if (!isNonEmptyString(v.model, 100)) return false;
      if (!isNonEmptyString(v.note, 300)) return false;
      const units = v.expectedUnits;
      if (!units || typeof units !== 'object') return false;
      const u = units as Record<string, unknown>;
      const numOrUndefined = (x: unknown) =>
        x === undefined ||
        (typeof x === 'number' && x >= 0 && Number.isFinite(x));
      // Найдено доп. аудитом (MEDIUM): раньше `expectedUnits: {}` (все
      // три поля отсутствуют — опечатка в ключе или модель просто ничего
      // не заполнила) проходила валидацию, потому что `numOrUndefined`
      // принимает `undefined`. Для известной (найденной в MODEL_RATES)
      // модели `estimateCost(model, {})` тогда возвращает
      // `unpriced: false, costMicroUsd: 0` — уверенно показанный ноль,
      // а не помеченная недостоверной оценка, хотя доверять ему нечего.
      // `costly: true` всё равно остаётся верным (считается по наличию
      // самого шага, не по цене), so будущий драйвер исполнения (§5) не
      // обходит одобрение — но сумма, на основании которой оператор
      // одобряет трату, лжёт. Требуем хотя бы одну единицу объёма.
      return (
        (u.seconds !== undefined ||
          u.characters !== undefined ||
          u.calls !== undefined) &&
        numOrUndefined(u.seconds) &&
        numOrUndefined(u.characters) &&
        numOrUndefined(u.calls)
      );
    }
    default:
      return false;
  }
}

/**
 * Уточнение к «шаг N невалиден» — только для одного случая, и он не
 * случаен.
 *
 * Этап F сузил белый список `triggerPaidOperation.operation` с сорока с
 * лишним ключей отчёта расходов до пяти операций мастера. Шаг, который
 * вчера проходил (`"reframe"`, `"audit"` — модель их не должна была
 * писать, но валидатор пропускал), сегодня роняет сценарий целиком. На
 * ночной генерации это просто следующая попытка; а оператор, правящий
 * такой сценарий в админке (`PATCH …/steps`), видел бы «шаг 3
 * невалиден» и искал бы опечатку в селекторе. Причина названа прямо,
 * вместе со списком допустимого.
 */
function invalidStepHint(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const v = value as Record<string, unknown>;
  if (
    v.kind === 'triggerPaidOperation' &&
    typeof v.operation === 'string' &&
    !VALID_OPERATIONS.has(v.operation)
  ) {
    return `: операции «${v.operation}» мастер не запускает — допустимы ${WIZARD_PAID_OPERATIONS.join(', ')}`;
  }
  return '';
}

/**
 * Проверка реплики (§3-бис.2 ТЗ `docs-tz/TZ-Tutorial-Video-Voiced.md`,
 * этап D) — ОТДЕЛЬНО от проверки самого шага, и это единственное
 * место во всём разборе, где всё-или-ничего сознательно не
 * применяется.
 *
 * Довод ровно тот, по которому шаги разбираются наоборот. Порядок
 * шагов значим, и молча выброшенный шаг даёт сценарий, который
 * выглядит рабочим, а на деле пропускает действие. Реплика же —
 * подпись к кадру: плохая реплика не должна лишать нас регрессионного
 * прогона, ради которого сценарий вообще существует. Поэтому шаг
 * остаётся, реплика отбрасывается, а причина уезжает в `failures[]`
 * генератора — и НЕ в `lastRunStatus`: то поле принадлежит
 * исполнителю, он пишет туда `ok`/`failed` каждую ночь и затёр бы
 * запись генератора ближайшим же прогоном, смешав два разных факта.
 *
 * @returns причина отказа или `null`, если реплика годна (или её нет).
 */
function narrationProblem(value: unknown, kind: string): string | null {
  if (value === undefined) return null;
  if (kind === 'triggerPaidOperation') {
    // Декларативный маркер: произносить нечего. Кадр у него при этом
    // ЕСТЬ и получает тишину — «реплики нет» и «кадра нет» это разные
    // вещи (§3-бис.2, врезка).
    return 'у triggerPaidOperation реплики не бывает';
  }
  if (typeof value !== 'string') return 'реплика не строка';
  if (/[\r\n]/.test(value)) {
    // Реплика — одна фраза, а не абзац. Многострочность ломает и
    // `.ass`-подписи этапа E, и звучит в синтезе как пауза в
    // случайном месте.
    return 'реплика в несколько строк';
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    // Пустая строка и отсутствие поля обязаны значить одно и то же,
    // иначе появляется третье состояние, о котором никто не думал.
    return 'пустая реплика';
  }
  if (trimmed.length > MAX_NARRATION_LENGTH) {
    return `реплика длиннее ${MAX_NARRATION_LENGTH} символов (${trimmed.length})`;
  }
  return null;
}

/** Отброшенная реплика: номер шага (1-based, как его видит человек) и
 *  причина. */
export interface DroppedNarration {
  stepNumber: number;
  reason: string;
}

export interface ParseScenarioResult {
  ok: boolean;
  steps: ScenarioStep[];
  /** Причина отказа — для лога генератора, не показывается пользователю нигде. */
  reason?: string;
  /**
   * Реплики, которые не прошли проверку и вырезаны из шагов. Сам шаг
   * при этом остался — см. `narrationProblem`. Пустой массив, когда
   * всё в порядке; при `ok: false` не заполняется вовсе (шагов нет,
   * говорить не о чем).
   */
  droppedNarrations: DroppedNarration[];
}

/**
 * Разбирает и строго валидирует массив шагов. В отличие от
 * `actions.ts:parseActions` — все-или-ничего (см. доккомментарий файла):
 * первый же невалидный шаг или пустой/переполненный список — весь
 * сценарий отбрасывается, `ok: false`.
 */
export function parseScenarioSteps(raw: unknown): ParseScenarioResult {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      steps: [],
      reason: 'steps не массив',
      droppedNarrations: [],
    };
  }
  if (raw.length === 0) {
    return {
      ok: false,
      steps: [],
      reason: 'пустой сценарий',
      droppedNarrations: [],
    };
  }
  if (raw.length > MAX_SCENARIO_STEPS) {
    return {
      ok: false,
      steps: [],
      reason: `слишком много шагов (${raw.length} > ${MAX_SCENARIO_STEPS})`,
      droppedNarrations: [],
    };
  }
  const steps: ScenarioStep[] = [];
  const droppedNarrations: DroppedNarration[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isValidScenarioStep(item)) {
      return {
        ok: false,
        steps: [],
        reason: `шаг ${i + 1} невалиден${invalidStepHint(item)}`,
        droppedNarrations: [],
      };
    }
    const problem = narrationProblem(
      (item as { narration?: unknown }).narration,
      item.kind,
    );
    if (problem === null) {
      steps.push(item);
      continue;
    }
    droppedNarrations.push({ stepNumber: i + 1, reason: problem });
    // Реплика ВЫРЕЗАЕТСЯ, а не остаётся лежать невалидной. Иначе она
    // доедет до базы и до карточки в админке, где выглядит как
    // сохранённый текст, — и отличить «эту реплику отбросили» от
    // «эту реплику озвучат» будет нечем.
    const { narration: _dropped, ...rest } = item as ScenarioStep & {
      narration?: unknown;
    };
    steps.push(rest as ScenarioStep);
  }
  return { ok: true, steps, droppedNarrations };
}

/**
 * Механика шага — всё, кроме реплики.
 *
 * «Тот же шаг» для генератора значит «то же действие браузера»:
 * реплика к действию не относится, она к нему подпись.
 */
export function stepMechanics(step: ScenarioStep): Omit<ScenarioStep, never> {
  const { narration: _narration, ...rest } = step as ScenarioStep & {
    narration?: string;
  };
  return rest as ScenarioStep;
}

/**
 * Свежий ответ модели поверх уже сохранённого сценария: механика
 * берётся новая, реплика — СТАРАЯ там, где механика шага не
 * изменилась.
 *
 * ## Зачем, и почему без этого этап D ломает три предыдущих
 *
 * Крон генерации идёт каждую ночь и перезаписывает `steps` свежим
 * ответом модели. До этапа D в `steps` не было свободного текста:
 * маршрут — выбор из словаря, селектор — плейсхолдер, значение —
 * короткая строка. На такой структуре модель вполне выдавала то же
 * самое, и на этом стояли ТРИ механизма сразу:
 *
 *  - кеш озвучки (ключ — хеш ТЕКСТА): совпал текст — не платим;
 *  - `contentHash` сборки: совпали входы — не пересобираем (§7.2 —
 *    «величина разовая… а не по расписанию»);
 *  - отметка о вычитке: снимается, только когда шаги ИЗМЕНИЛИСЬ.
 *
 * Этап D положил в ту же структуру свободную прозу до 220 символов на
 * шаг. Температура у вызова не зафиксирована (и фиксация не спасла бы:
 * побуквенного повторения от модели никто не обещает), поэтому
 * формулировка меняется практически каждую ночь. Все три механизма
 * разом переставали работать — молча и в худшую сторону: полный
 * пересинтез набора (до $6) и полная пересборка каждую ночь, а при
 * включённой `tutorial.requireNarrationReview` — вообще ни одного
 * озвученного ИИ-сценария никогда: генератор снимал отметку в 08:00,
 * исполнитель видел её снятой в 09:00.
 *
 * Слияние отвечает на это по существу: «реплика изменилась» значит
 * «изменился ШАГ, к которому она написана», а не «модель на этот раз
 * подобрала другие слова». Изменился шаг — берём новую реплику
 * целиком; не изменился — оставляем ту, что уже озвучена и, возможно,
 * вычитана человеком.
 *
 * Сравнение позиционное: `steps` — последовательность, и шаг 3 нового
 * ответа сопоставляется с шагом 3 старого. Вставили шаг в середину —
 * дальше всё разъедется и возьмётся новым, и это верно: сценарий стал
 * другим.
 *
 * Реплику у шага, где её раньше не было, берём новую — иначе сценарии,
 * сгенерированные до этапа D, не получили бы реплик никогда.
 */
export function mergeNarration(
  existing: unknown,
  fresh: readonly ScenarioStep[],
): ScenarioStep[] {
  if (!Array.isArray(existing)) return [...fresh];
  const old = existing as ScenarioStep[];
  return fresh.map((step, i) => {
    const before = old[i];
    if (!before || typeof before !== 'object') return step;
    if (
      stableStringify(stepMechanics(before)) !==
      stableStringify(stepMechanics(step))
    ) {
      return step;
    }
    const kept = (before as { narration?: unknown }).narration;
    // Берём прежнюю реплику, только если она ГОДНА: в базе может
    // лежать строка, сохранённая до того, как правила ужесточились.
    // Негодную молча переносить нельзя — она попадёт в синтез мимо
    // валидации.
    if (narrationProblem(kept, step.kind) !== null) return step;
    return kept === undefined
      ? step
      : ({ ...stepMechanics(step), narration: kept } as ScenarioStep);
  });
}

export function isTriggerPaidOperationStep(
  step: ScenarioStep,
): step is Extract<ScenarioStep, { kind: 'triggerPaidOperation' }> {
  return step.kind === 'triggerPaidOperation';
}
