/**
 * Запись мемо кликами в визуальном редакторе и «Прогнать» (Э6-тер (д), ТЗ
 * помощника §5-бис.17 п.6, §5-кватер.5) — ЧИСТАЯ часть без базы.
 *
 *  - клик владельца по сайту (дескриптор пикера — НЕДОВЕРЕННЫЕ данные,
 *    разбор сервера `parseDescriptor`) → шаг мемо: `click` (кнопка, ссылка —
 *    переход), `fill` (поле) и `select` (список) → СЛОТ без значения (значений
 *    в дескрипторе нет и не бывает; имя слота — из `name`/подписи/
 *    `aria-label` поля), `check` (флажок/переключатель);
 *  - риск — КОДОМ (`judgeStep` с правилами сайта — те же стоп-лист
 *    `actionKindsFor`, `data-assist="never"`, поля пароля/карты, чужой хост),
 *    цель «никогда»/запрет карты — запись ОСТАНАВЛИВАЕТСЯ с причиной; «Оформить
 *    заказ»/«Оплатить» и чужой хост — последним шагом становится подсветка
 *    «нажмите сами» (§5-кватер.5, К-10);
 *  - перепривязка шага — тот же разбор для нового элемента: цель и отпечаток
 *    `pin` — новые, слот шага — прежний;
 *  - сохранение — повторная проверка ВСЕХ шагов (ворота `memoGates`): шаг
 *    «никогда», значение вместо слота, константа в поле ПД — 422;
 *  - «Прогнать» — `memoCheckPage` по снимку страницы, шаги по порядку до
 *    первого сбоя или перехода на другую страницу (без нажатий).
 */
import {
  MEMO_LANGS,
  MEMO_LIMITS,
  memoCheckPage,
  memoGates,
  parseMemoContent,
  suggestMemoKey,
  memoTextProblem,
  type MemoComputed,
  type MemoContent,
  type MemoGateProblem,
  type MemoIssue,
  type MemoLang,
  type MemoPin,
  type MemoSlot,
  type MemoSlotKind,
  type MemoStep,
  type MemoStepKind,
} from '../../assist-ui-core/memo';
import { STANDARD_UNDO_PAIRS } from '../../assist-ui-core/decisions';
import {
  goalCountIn,
  goalLabelKey,
  MEMO_GOAL_LIMITS,
  type MemoGoalTarget,
} from '../../assist-ui-core/memo-goal';
import { normText } from '../../assist-ui-core/normalize';
import {
  judgeStep,
  onSiteHost,
  PD_FIELD_LABEL,
  raise,
} from '../../assist-ui-core/plan-checks';
import {
  pathMatches,
  PATH_MASK_RE,
  zoneAllowed,
} from '../../assist-ui-core/rules';
import { cleanText, maskLabel } from '../../assist-ui-core/snapshot';
import type {
  UiRisk,
  UiSnapshot,
  VoiceControlRules,
} from '../../assist-ui-core/types';
import {
  compensationOf,
  descriptorFacts,
  descriptorStability,
  effectiveRisk,
  parseDescriptor,
  type MapUndo,
  type VoiceMapContent,
  type VoiceMapDescriptor,
  type VoiceMapTarget,
} from '../../assist-ui-core/voice-map';

/** Почему запись остановилась (тексты — в панели, uk/ru/en). */
export type RecordStopReason =
  | 'never_attr'
  | 'denylist'
  | 'payment'
  | 'danger'
  | 'denied'
  | 'sensitive_field'
  | 'offhost'
  | 'gesture'
  | 'unsupported'
  | 'zone'
  | 'too_many_steps';

/** Шаг записан, но не может стать шагом (отказ без остановки записи). */
export type RecordSkipCode = 'descriptor' | 'unnamed' | 'disabled';

export type RecordStepResult =
  | {
      kind: 'step';
      step: MemoStep;
      /** Новый слот (поле/список) — БЕЗ значения; при перепривязке — null. */
      slot: MemoSlot | null;
      /** Класс в бою по расчёту кода: `confirm` — «после „Да“» (⚠). */
      risk: 'auto' | 'confirm';
      /**
       * Исполнить нажатие по-настоящему (переход, раскрывашка, обратимое
       * «в корзину»): только класс «сразу» и не отправка (§5-кватер.5 п.2, п.4).
       */
      exec: boolean;
      /**
       * (заход 9) «Как отменить» шага — наследуется от цели карты (или
       * стандартная пара разметки); правится в карточке цели, не в мемо.
       */
      undo: StepUndo | null;
    }
  | {
      kind: 'stop';
      reason: RecordStopReason;
      /** Подсветка «нажмите сами» последним шагом (оформление, чужой хост). */
      step: MemoStep | null;
    }
  | { kind: 'skip'; code: RecordSkipCode };

export interface RecordStepInput {
  descriptor: unknown;
  /** Атрибут `name` поля (имя слота), недоверенно. */
  fieldName?: unknown;
  /** Подписи вариантов `<select>` (для слота `option`), недоверенно. */
  options?: unknown;
  /** Текущий путь страницы (без query). */
  path: string;
  /** Маска страницы шага (шаблон голосовой карты или сам путь). */
  page: string;
  hosts: string[];
  rules: VoiceControlRules;
  /** Цель голосовой карты, которой соответствует элемент (если есть). */
  mapTarget: VoiceMapTarget | null;
  /** Строка Ш4 `site_ui_elements` элемента (если узнана). */
  uiElement: { id: string; key: string; stability: string } | null;
  /** Имена слотов, уже занятых в записи. */
  takenSlots: readonly string[];
  /** Сколько шагов уже записано (без перепривязываемого). */
  count: number;
  /** Перепривязка: шаг, которому меняют цель. */
  prev?: MemoStep | null;
}

const SLOT_NAME_RE = /^[a-z][a-z0-9_]{0,19}$/;
const PROBE = 'v4cprobe';

/** Действие шага по элементу: поле → `fill`, список → `select`, флажок → `check`. */
export function actionOf(d: VoiceMapDescriptor): MemoStepKind {
  if (d.tag === 'select' || d.role === 'combobox') return 'select';
  if (d.role === 'checkbox' || d.role === 'radio' || d.role === 'switch')
    return 'check';
  const field =
    d.tag === 'textarea' ||
    (d.tag === 'input' &&
      !['submit', 'button', 'image', 'reset', 'checkbox', 'radio'].includes(
        d.inputType ?? 'text',
      ));
  if (field || d.role === 'textbox' || d.role === 'searchbox') return 'fill';
  return 'click';
}

/** Тип слота по полю (тип, подпись) — значения поля здесь нет. */
export function slotKindOf(
  d: VoiceMapDescriptor,
  hasOptions: boolean,
): MemoSlotKind {
  if (d.tag === 'select' || d.role === 'combobox')
    return hasOptions ? 'option' : 'text';
  const t = d.inputType;
  const label = `${d.text} ${d.hiddenLabel ?? ''}`;
  if (t === 'email' || /e-?mail|пошт|почт/iu.test(label)) return 'email';
  if (t === 'tel' || /телефон|phone|mobile|\btel\b/iu.test(label))
    return 'phone';
  if (t === 'number' || t === 'range') return 'number';
  if (t === 'date' || t === 'datetime-local') return 'date';
  return 'text';
}

/** Имя слота `[a-z][a-z0-9_]{0,19}` из `name`/подписи/`aria-label`/id поля. */
export function slotNameOf(
  bases: ReadonlyArray<string | null | undefined>,
  kind: MemoSlotKind,
  taken: readonly string[],
): string {
  let base: string = kind;
  for (const b of bases) {
    if (!b) continue;
    const k = suggestMemoKey(b);
    if (k === 'memo' && !/memo/i.test(b)) continue;
    const n = k
      .replace(/-/g, '_')
      .replace(/^[^a-z]+/, '')
      .slice(0, 20)
      .replace(/_+$/, '');
    if (SLOT_NAME_RE.test(n)) {
      base = n;
      break;
    }
  }
  let name = base;
  for (let i = 2; taken.includes(name); i++) {
    const suf = `_${i}`;
    name = `${base.slice(0, 20 - suf.length).replace(/_+$/, '')}${suf}`;
  }
  return name;
}

function optionsOf(raw: unknown): MemoSlot['options'] {
  if (!Array.isArray(raw)) return [];
  const out: MemoSlot['options'] = [];
  for (const o of raw.slice(0, 40)) {
    const t = cleanText(o, 60);
    if (!t || memoTextProblem(t, 60)) continue;
    if (out.some((x) => normText(x.value) === normText(t))) continue;
    out.push({ value: t, say: {} });
    if (out.length >= MEMO_LIMITS.slotOptions) break;
  }
  return out;
}

function pinOf(
  d: VoiceMapDescriptor,
  hosts: readonly string[],
  stability: MemoPin['stability'],
): MemoPin {
  const onHost =
    !!d.hrefPath &&
    !d.offHost &&
    (!d.hrefHost || onSiteHost(`https://${d.hrefHost}/`, [...hosts]));
  return {
    role: d.role,
    assistId: d.assistId,
    // Видимый текст (маска ПД) — то, что сверит бой; скрытая подпись — нет.
    text: maskLabel(d.text).slice(0, 81),
    tag: d.tag,
    href: onHost && d.tag === 'a' ? d.hrefPath : null,
    submit: d.submit,
    inForm: d.inForm,
    pd: d.pd,
    inputType: d.inputType,
    toggle: d.toggle,
    stability,
  };
}

function targetOf(
  d: VoiceMapDescriptor,
  input: RecordStepInput,
): MemoStep['target'] {
  const st = input.uiElement?.stability;
  const stability =
    st === 'strong' || st === 'medium' || st === 'fragile'
      ? st
      : descriptorStability(d);
  return {
    uiElementId: input.uiElement?.id ?? null,
    key: input.uiElement?.key ?? null,
    mapKey: input.mapTarget?.key ?? null,
    pin: pinOf(d, input.hosts, stability),
  };
}

/**
 * Клик владельца → шаг мемо (или остановка записи). Значений нет: поле и
 * список становятся слотом с именем из подписи; риск — только код.
 */
export function recordStep(input: RecordStepInput): RecordStepResult {
  const raw = input.descriptor;
  const d = parseDescriptor(raw);
  if (!d) {
    // Пароль/файл/скрытое поле разбор отбрасывает — это «никогда», не мусор.
    const t =
      raw && typeof raw === 'object'
        ? (raw as { inputType?: unknown }).inputType
        : null;
    return t === 'password' || t === 'file' || t === 'hidden'
      ? { kind: 'stop', reason: 'sensitive_field', step: null }
      : { kind: 'skip', code: 'descriptor' };
  }
  const stop = (
    reason: RecordStopReason,
    step: MemoStep | null = null,
  ): RecordStepResult => ({ kind: 'stop', reason, step });
  if (d.neverAttr) return stop('never_attr');
  if (input.mapTarget?.denylisted) return stop('denylist');
  if (d.editable || d.closedShadow) return stop('unsupported');
  if (!zoneAllowed(input.path, input.rules)) return stop('zone');
  const action = actionOf(d);
  const facts = descriptorFacts(d, input.hosts);
  const name = d.text || d.hiddenLabel || d.assistId || '';
  const ctx = {
    transcript: `${name} ${PROBE}`,
    rules: input.rules,
    hosts: input.hosts,
    pagePath: input.path,
    state: 'on' as const,
  };
  const value = action === 'fill' || action === 'select' ? PROBE : null;
  const j = judgeStep(action, facts, value, ctx);
  // Подсветка «нажмите сами» — только где подсветка сама допустима и есть
  // видимый текст для отпечатка (оформление, оплата, чужой хост, жест).
  const manualHighlight = (): MemoStep | null => {
    if (!d.text) return null;
    const h = judgeStep('highlight', facts, null, ctx);
    if (h.risk !== 'auto') return null;
    return {
      page: input.page,
      action: 'highlight',
      target: targetOf(d, input),
      value: null,
      expect: null,
      say: null,
      risk: null,
    };
  };
  if (j.risk === null) {
    if (j.reason === 'disabled') return { kind: 'skip', code: 'disabled' };
    return stop(
      j.reason === 'sensitive_field' ? 'sensitive_field' : 'unsupported',
    );
  }
  if (j.risk === 'never') {
    const reason: RecordStopReason =
      j.reason === 'payment'
        ? 'payment'
        : j.reason === 'denied'
          ? 'denied'
          : j.reason === 'sensitive_field'
            ? 'sensitive_field'
            : 'danger';
    return stop(
      reason,
      reason === 'payment' || reason === 'danger' ? manualHighlight() : null,
    );
  }
  if (j.risk === 'manual')
    return stop(
      j.reason === 'gesture' ? 'gesture' : 'offhost',
      manualHighlight(),
    );
  // Владелец в карте сказал «никогда» — запись дальше не идёт.
  if (input.mapTarget && effectiveRisk(input.mapTarget) === 'never')
    return stop('denylist');
  if (!input.prev && input.count >= input.rules.maxSteps)
    return stop('too_many_steps');
  // Отпечаток без видимого текста не сверит подмену кнопки (ворота: текст у
  // `click`); поле без подписи и без разметки — нечего искать.
  if (!d.text && (action === 'click' || !d.assistId))
    return { kind: 'skip', code: 'unnamed' };

  const target = targetOf(d, input);
  let risk: UiRisk = j.risk;
  if (target?.pin.stability === 'fragile') risk = raise(risk, 'confirm');
  if (input.mapTarget && effectiveRisk(input.mapTarget) === 'confirm')
    risk = raise(risk, 'confirm');

  let slot: MemoSlot | null = null;
  let stepValue: MemoStep['value'] = null;
  if (action === 'fill' || action === 'select') {
    const prevSlot =
      input.prev &&
      (input.prev.action === 'fill' || input.prev.action === 'select') &&
      input.prev.value &&
      'slot' in input.prev.value
        ? input.prev.value.slot
        : null;
    if (prevSlot) stepValue = { slot: prevSlot };
    else {
      const options = action === 'select' ? optionsOf(input.options) : [];
      const kind = slotKindOf(d, options.length > 0);
      const fieldName =
        typeof input.fieldName === 'string' && input.fieldName.length <= 64
          ? input.fieldName
          : null;
      const nameOf = slotNameOf(
        [fieldName, d.text, d.hiddenLabel, d.elId],
        kind,
        input.takenSlots,
      );
      slot = {
        name: nameOf,
        kind,
        pii:
          kind === 'phone' ||
          kind === 'email' ||
          d.pd ||
          PD_FIELD_LABEL.test(`${d.text} ${d.hiddenLabel ?? ''}`),
        options: kind === 'option' ? options : [],
      };
      stepValue = { slot: nameOf };
    }
  }
  const step: MemoStep = {
    page: input.page,
    action,
    target,
    value: stepValue,
    // Переход по ссылке: ждём адрес ссылки (маска ПД уже в дескрипторе).
    expect:
      action === 'click' && target?.pin.href ? { path: target.pin.href } : null,
    say: null,
    // Мнение владельца (только ужесточить) переживает перепривязку.
    risk: input.prev && input.prev.action === action ? input.prev.risk : null,
  };
  return {
    kind: 'step',
    step,
    slot,
    risk: risk === 'auto' ? 'auto' : 'confirm',
    exec: risk === 'auto' && (action === 'click' || action === 'check'),
    undo: COMPENSABLE.has(action)
      ? undoFrom(input.mapTarget, d.assistId)
      : null,
  };
}

// ── «Как отменить» шага мемо (заход 9, ТЗ §5-кватер.5, §5-бис.15 п.6) ────

/**
 * Обратная цель шага: у мемо СВОЕЙ разметки отмены нет — шаг наследует
 * «Как отменить» цели голосовой карты, по которой найден его элемент
 * (`mapKey`), иначе стандартную пару разметки (`add-to-cart` →
 * `remove-from-cart`, В-68). По тексту кнопки — никогда. В бою то же
 * наследование уже делает план (подсказки карты `mapHintsOf` по ссылке
 * снимка); здесь — показ в панели и правка через карточку цели.
 */
export interface StepUndo {
  assistId: string;
  at: string | null;
  /** `map` — объявлено владельцем в цели карты; `standard` — пара разметки. */
  src: 'map' | 'standard';
  /** Цель карты, где правится «Как отменить» (null — цели нет). */
  key: string | null;
}

/** Компенсация бывает у нажатий; поля возвращаются своим путём (`local`). */
const COMPENSABLE: ReadonlySet<MemoStepKind> = new Set(['click', 'check']);

function undoFrom(
  t: VoiceMapTarget | null,
  assistId: string | null,
): StepUndo | null {
  if (t) {
    const u: MapUndo | null = compensationOf(t);
    if (u)
      return {
        assistId: u.assistId,
        at: u.at,
        src: t.undo ? 'map' : 'standard',
        key: t.key,
      };
  }
  const pair = assistId ? (STANDARD_UNDO_PAIRS[assistId] ?? null) : null;
  return pair
    ? { assistId: pair, at: null, src: 'standard', key: t?.key ?? null }
    : null;
}

/** «Как отменить» каждого шага мемо по черновику карты (правка мемо N). */
export function stepUndos(
  steps: readonly MemoStep[],
  map: VoiceMapContent | null,
): Array<StepUndo | null> {
  return steps.map((s) => {
    if (!s.target || !COMPENSABLE.has(s.action)) return null;
    const key = s.target.mapKey ?? null;
    const t =
      key && map
        ? (map.targets.find((x) => x.key === key && x.status === 'active') ??
          null)
        : null;
    return undoFrom(t, s.target.pin.assistId);
  });
}

// ── «Чекати це»: ожидание при записи (заход 9, ТЗ §5-кватер.5 п.2) ────────

export type RecordWaitResult =
  /** Шаг ждёт появления элемента с этим видимым текстом (`expect.appear`). */
  | { kind: 'appear'; text: string }
  /**
   * Цель мемо — «счётчик ±N» (значок корзины): исходное значение берёт бой
   * из снимка команды, здесь — только цель условия и Δ (по умолчанию +1).
   */
  | { kind: 'counter'; target: MemoGoalTarget; delta: number; now: number }
  | { kind: 'skip'; code: 'descriptor' | 'unnamed' | 'text' };

/**
 * Клик владельца после «Чекати це» → ожидание (НЕ шаг и не нажатие):
 * элемент с ровно одним целым числом в подписи («Кошик (2)», «3») —
 * счётчик (цель условия — разметка или подпись без чисел), иначе —
 * появление элемента с этой подписью. Дескриптор — недоверенный: разбор
 * сервера, маска ПД подписи, проверка текста как у шагов.
 */
export function recordWait(raw: unknown, deltaRaw?: unknown): RecordWaitResult {
  const d = parseDescriptor(raw);
  if (!d) return { kind: 'skip', code: 'descriptor' };
  const text = maskLabel(d.text).replace(/\s+/g, ' ').trim();
  if (!text) return { kind: 'skip', code: 'unnamed' };
  const n = /\d/.test(text) ? goalCountIn(text) : null;
  const label = goalLabelKey(text);
  if (n !== null && (d.assistId || label)) {
    const delta =
      typeof deltaRaw === 'number' &&
      Number.isInteger(deltaRaw) &&
      deltaRaw !== 0 &&
      Math.abs(deltaRaw) <= MEMO_GOAL_LIMITS.maxDelta
        ? deltaRaw
        : 1;
    return {
      kind: 'counter',
      target: { assistId: d.assistId, text: label },
      delta,
      now: n,
    };
  }
  const a = text.slice(0, 80);
  if (memoTextProblem(a, 80)) return { kind: 'skip', code: 'text' };
  return { kind: 'appear', text: a };
}

// ── сохранение записи → черновик мемо ─────────────────────────────────────

/** Проблемы ворот, с которыми записанное в черновик НЕ попадает (422). */
const BLOCKING: ReadonlySet<MemoGateProblem['code']> = new Set([
  'never_step',
  'no_target',
  'value_not_slot',
  'unknown_slot',
  'const_forbidden',
  'const_in_pii',
  'risk_lowering_forbidden',
]);

export interface RecordedDraft {
  content: MemoContent;
  issues: MemoIssue[];
  gates: ReturnType<typeof memoGates>;
}

/**
 * Записанные шаги + имя/цель → содержимое черновика. Шаги перепроверяются
 * ВСЕ (их прислала панель — после перестановки/удаления/перепривязки):
 * разбор `parseMemoContent`, ворота `memoGates` (риск по отпечатку, «никогда»,
 * значения только слотами); новая запись — без констант вовсе (значения
 * не записываются). Слоты без шагов — вон; ожидание адреса у нажатия, после
 * которого шаги идут на другой странице; цель по умолчанию — адрес страницы,
 * где запись закончилась.
 */
export function recordedDraft(
  raw: Record<string, unknown>,
  ctx: {
    rules: VoiceControlRules;
    host: string;
    /** Маска страницы, где запись закончилась (цель по умолчанию). */
    endPage: string | null;
    /** Новая запись (не правка существующего мемо): констант нет вовсе. */
    fresh: boolean;
  },
): RecordedDraft {
  const { content: c, issues } = parseMemoContent(raw);
  const used = new Set<string>();
  c.steps.forEach((s, i) => {
    if (s.value && 'slot' in s.value) used.add(s.value.slot);
    if (ctx.fresh && s.value && 'const' in s.value)
      issues.push({ path: `steps[${i}].value`, code: 'value_recorded' });
  });
  for (const g of c.goal.expect) if (g.kind === 'slot') used.add(g.slot);
  c.slots = c.slots.filter((s) => used.has(s.name));
  c.steps.forEach((s, i) => {
    const next = c.steps[i + 1];
    if (
      s.action === 'click' &&
      next &&
      next.page !== s.page &&
      !s.expect?.path &&
      !next.page.includes('*')
    )
      s.expect = { ...(s.expect ?? {}), path: next.page };
  });
  if (!c.goal.expect.length && ctx.endPage && PATH_MASK_RE.test(ctx.endPage))
    c.goal.expect.push({ kind: 'url', path: ctx.endPage });
  const gates = memoGates(c, { rules: ctx.rules, host: ctx.host });
  for (const p of gates.problems)
    if (BLOCKING.has(p.code)) issues.push({ path: p.path, code: p.code });
  return { content: c, issues, gates };
}

/** Имя на языке панели или первое из имеющихся. */
export function memoNameOf(c: MemoContent, lang: MemoLang): string | null {
  return (
    c.names[lang] ?? MEMO_LANGS.map((l) => c.names[l]).find(Boolean) ?? null
  );
}

// ── «Прогнать» в редакторе ────────────────────────────────────────────────

export interface MemoTryStepView {
  i: number;
  action: MemoStepKind;
  text: string;
  ok: boolean;
  /** missing | ambiguous | pin_mismatch | risk_up | never */
  problem: string | null;
  /** Ссылка снимка для подсветки (`e#`), если цель найдена одна. */
  ref: string | null;
}

export interface MemoTryView {
  path: string;
  from: number;
  steps: MemoTryStepView[];
  /** Первый шаг со сбоем (прогон остановлен на нём). */
  stopAt: number | null;
  problem: string | null;
  /** Следующий шаг — на другой странице: перейти и «Прогнать» дальше. */
  next: { i: number; page: string } | null;
  /** Цель на этой странице (если прогон дошёл до конца). */
  goal: 'ok' | 'missing' | null;
  done: boolean;
}

function refOf(pin: MemoPin, snapshot: UiSnapshot): string | null {
  const norm = normText(pin.text);
  let found = snapshot.elements.filter((e) =>
    pin.assistId
      ? e.assistId === pin.assistId
      : normText(e.text) === norm && (!pin.role || e.role === pin.role),
  );
  if (found.length > 1 && pin.role)
    found = found.filter((e) => e.role === pin.role);
  return found.length === 1 ? found[0].ref : null;
}

/**
 * Сухой прогон черновика на ЭТОЙ странице (без нажатий): шаги с `from` по
 * порядку — цель найдена, одна, отпечаток совпал, риск по живому DOM не выше
 * расчёта (`memoCheckPage`); первый сбой — стоп с причиной; шаг другой
 * страницы (или шаг после перехода) — `next`; дошли до конца — цель.
 */
export function memoTry(
  c: MemoContent,
  computed: Pick<MemoComputed, 'risk'> | null,
  snapshot: UiSnapshot,
  ctx: { rules: VoiceControlRules; hosts: string[] },
  from = 0,
): MemoTryView {
  const page = memoCheckPage(c, computed, snapshot, ctx);
  const out: MemoTryView = {
    path: page.path,
    from,
    steps: [],
    stopAt: null,
    problem: null,
    next: null,
    goal: null,
    done: false,
  };
  const start = Math.max(0, Math.min(from, c.steps.length));
  for (let i = start; i < c.steps.length; i++) {
    const s = c.steps[i];
    if (!pathMatches(page.path, s.page)) {
      out.next = { i, page: s.page };
      return out;
    }
    if (!s.target) {
      out.steps.push({
        i,
        action: s.action,
        text: s.say ?? '',
        ok: true,
        problem: null,
        ref: null,
      });
      continue;
    }
    const r = page.steps.find((x) => x.i === i);
    const v: MemoTryStepView = {
      i,
      action: s.action,
      text: s.target.pin.text,
      ok: !!r?.ok,
      problem: r ? r.problem : 'missing',
      ref: refOf(s.target.pin, snapshot),
    };
    out.steps.push(v);
    if (!v.ok) {
      out.stopAt = i;
      out.problem = v.problem;
      return out;
    }
    const nav = !!s.target.pin.href || s.target.pin.submit;
    if (nav && s.action === 'click' && i < c.steps.length - 1) {
      out.next = { i: i + 1, page: c.steps[i + 1].page };
      return out;
    }
  }
  out.done = true;
  out.goal = page.goal;
  return out;
}
