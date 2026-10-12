/**
 * Мемо АМ-N записью кликами в панели редактора карты «Админки» (iframe
 * `wa.`) — ЧИСТАЯ часть без базы (заход 13, хвост Р-З11-А11; ТЗ §5-бис.17
 * п.6, п.10, §5-кватер.5; Р-Э6б-10).
 *
 * Мемо «Админки» — не клики «Сайта»: серверный эффект — только шаг `api`
 * (операция коннектора, правится в TMA), а клики — шаги `ui` БЕЗ серверного
 * эффекта (переход по ссылке, вкладка/пункт меню, поле до «Зберегти»,
 * флажок). Поэтому запись в редакторе:
 *  - клик владельца (дескриптор пикера — НЕДОВЕРЕННЫЕ данные, разбор
 *    сервера `parseDescriptor`) → шаг `ui`: ссылка/вкладка/пункт меню —
 *    `click` (переход исполняется по-настоящему), поле/список — `fill`/
 *    `select` со СЛОТОМ без значения (имя — из `name`/подписи), флажок —
 *    `check`;
 *  - кнопка с эффектом («Зберегти», «Видалити», роль `button`) — запись
 *    СТОП с причиной `server_effect`: «серверну дію додайте кроком API в
 *    Telegram» (`adminMemoUiProblem`, тот же разбор, что у черновика);
 *  - «никогда» — как у плана «Админки»: `data-assist="never"`, denylist
 *    карты, пароль/карта, чужой хост, слова и адреса стоп-листа «Админки»
 *    (`adminNeverTarget`), зона владельца;
 *  - шаги `api`/`say` черновика (из TMA) панель показывает и переставляет,
 *    но не меняет: они ходят по индексу `keep`, содержимое берёт сервер из
 *    черновика той же ревизии;
 *  - «Прогнать» — шаги `ui` черновика по снимку ЭТОЙ страницы (без нажатий,
 *    без модели): цель по разметке, иначе по видимому тексту и роли
 *    (`compileAdminMemoUi`), проверки «Админки» (`checkAdminPlan`); шаги
 *    `api`/`say` в прогоне не исполняются (как у мастера).
 * Значений полей здесь нет и не бывает.
 */
import {
  ADMIN_MEMO_LIMITS,
  type AdminMemoContent,
  type AdminMemoSlot,
  type AdminMemoSlotKind,
  type AdminMemoStep,
} from '../../assist-admin-actions/admin-memo';
import {
  adminMemoUiProblem,
  adminNeverTarget,
  checkAdminPlan,
  compileAdminMemoUi,
  type AdminMemoUiStep,
} from '../../assist-admin-voice/admin-voice-rules';
import {
  actionOf,
  optionsOf,
  slotKindOf,
  slotNameOf,
} from '../../assist-ui-core/memo-record-core';
import {
  judgeStep,
  onSiteHost,
  PD_FIELD_LABEL,
} from '../../assist-ui-core/plan-checks';
import { zoneAllowed } from '../../assist-ui-core/rules';
import { maskLabel } from '../../assist-ui-core/snapshot';
import type { UiSnapshot, VoiceControlRules } from '../../assist-ui-core/types';
import {
  descriptorFacts,
  effectiveRisk,
  parseDescriptor,
  type VoiceMapTarget,
} from '../../assist-ui-core/voice-map';

/** Почему запись остановилась (тексты — в панели, uk/ru/en). */
export type AdminRecordStopReason =
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
  | 'too_many_steps'
  /** Кнопка с серверным эффектом — только шагом `api` в TMA. */
  | 'server_effect';

/** Шаг мемо в панели (форма панели `we.`; `keep` — шаг `api`/`say` черновика). */
export interface AdminPanelStep {
  action: AdminMemoUiStep['kind'] | 'api' | 'say';
  /** У шагов «Админки» страницы нет (цель — по разметке/подписи). */
  page: string;
  target: {
    pin: { text: string };
    assistId: string | null;
    role: string | null;
  } | null;
  value: { slot: string } | { const: string } | null;
  expect: null;
  /** Индекс шага `api`/`say` в черновике (содержимое — с сервера). */
  keep?: number;
}

export type AdminRecordResult =
  | {
      kind: 'step';
      step: AdminPanelStep;
      slot: AdminMemoSlot | null;
      risk: 'auto' | 'confirm';
      exec: boolean;
      undo: null;
    }
  | { kind: 'stop'; reason: AdminRecordStopReason; step: null }
  | { kind: 'skip'; code: 'descriptor' | 'unnamed' | 'disabled' | 'row' };

export interface AdminRecordInput {
  descriptor: unknown;
  fieldName?: unknown;
  options?: unknown;
  /** Путь страницы админки (без query). */
  path: string;
  hosts: string[];
  rules: VoiceControlRules;
  /** Цель карты «Админки», которой соответствует элемент (если есть). */
  mapTarget: VoiceMapTarget | null;
  takenSlots: readonly string[];
  count: number;
  /** Пикер «Админки»: элемент в строке таблицы / карточке клиента (`pdRow`). */
  row?: unknown;
  /** Перепривязка: прежний шаг (слот — прежний). */
  prev?: AdminPanelStep | null;
}

const PROBE = 'v4cprobe';

/** Тип слота «Админки»: e-mail/телефон — текст (ПД отмечает код). */
function adminSlotKind(k: ReturnType<typeof slotKindOf>): AdminMemoSlotKind {
  return k === 'number' || k === 'date' || k === 'option' ? k : 'text';
}

/**
 * Клик владельца → шаг `ui` мемо «Админки» (или остановка записи). Значений
 * нет: поле и список становятся слотом с именем из подписи.
 */
export function recordAdminUiStep(input: AdminRecordInput): AdminRecordResult {
  const raw = input.descriptor;
  const stop = (reason: AdminRecordStopReason): AdminRecordResult => ({
    kind: 'stop',
    reason,
    step: null,
  });
  const d = parseDescriptor(raw);
  if (!d) {
    const t =
      raw && typeof raw === 'object'
        ? (raw as { inputType?: unknown }).inputType
        : null;
    return t === 'password' || t === 'file' || t === 'hidden'
      ? stop('sensitive_field')
      : { kind: 'skip', code: 'descriptor' };
  }
  if (d.neverAttr) return stop('never_attr');
  if (
    input.mapTarget &&
    (input.mapTarget.denylisted || effectiveRisk(input.mapTarget) === 'never')
  )
    return stop('denylist');
  if (d.editable || d.closedShadow) return stop('unsupported');
  if (!zoneAllowed(input.path, input.rules)) return stop('zone');
  if (
    adminNeverTarget({
      text: d.text,
      assistId: d.assistId,
      href: d.hrefPath,
      hiddenLabel: d.hiddenLabel,
    })
  )
    return stop('danger');
  const action = actionOf(d);
  const name = d.text || d.hiddenLabel || d.assistId || '';
  const value = action === 'fill' || action === 'select' ? PROBE : null;
  const j = judgeStep(action, descriptorFacts(d, input.hosts), value, {
    transcript: `${name} ${PROBE}`,
    rules: input.rules,
    hosts: input.hosts,
    pagePath: input.path,
    state: 'on',
  });
  if (j.risk === null) {
    if (j.reason === 'disabled') return { kind: 'skip', code: 'disabled' };
    return stop(
      j.reason === 'sensitive_field' ? 'sensitive_field' : 'unsupported',
    );
  }
  if (j.risk === 'never')
    return stop(
      j.reason === 'payment'
        ? 'payment'
        : j.reason === 'denied'
          ? 'denied'
          : j.reason === 'sensitive_field'
            ? 'sensitive_field'
            : 'danger',
    );
  if (j.risk === 'manual')
    return stop(j.reason === 'gesture' ? 'gesture' : 'offhost');
  // Клик «Админки» в мемо — только переход/вкладка/пункт меню (Р-Э6б-10).
  if (
    action === 'click' &&
    d.role !== 'link' &&
    d.role !== 'tab' &&
    d.role !== 'menuitem'
  )
    return stop('server_effect');
  // Аудит З13-А P2-1: переключатель (`switch`) и флажок вне формы в
  // админках обычно сохраняются сразу (AJAX без «Зберегти») — это серверный
  // эффект, как у кнопки: запись стоп, шаг — только операцией API в TMA.
  if (action === 'check' && (d.role === 'switch' || !d.inForm))
    return stop('server_effect');
  // Аудит З13-А P3-3: элемент строки таблицы / карточки клиента без
  // разметки — подпись = ПД клиента (имя, номер), в мемо её не пишем.
  if (input.row === true && !d.assistId) return { kind: 'skip', code: 'row' };
  if (!input.prev && input.count >= ADMIN_MEMO_LIMITS.steps)
    return stop('too_many_steps');
  if (!d.text && !d.assistId) return { kind: 'skip', code: 'unnamed' };

  let slot: AdminMemoSlot | null = null;
  let stepValue: AdminPanelStep['value'] = null;
  if (action === 'fill' || action === 'select') {
    const prevSlot =
      input.prev?.value && 'slot' in input.prev.value
        ? input.prev.value.slot
        : null;
    if (prevSlot) stepValue = { slot: prevSlot };
    else {
      if (input.takenSlots.length >= ADMIN_MEMO_LIMITS.slots)
        return stop('too_many_steps');
      const options = action === 'select' ? optionsOf(input.options) : [];
      const generic = slotKindOf(d, options.length > 0);
      const kind = adminSlotKind(generic);
      const fieldName =
        typeof input.fieldName === 'string' && input.fieldName.length <= 64
          ? input.fieldName
          : null;
      const slotName = slotNameOf(
        [fieldName, d.text, d.hiddenLabel, d.elId],
        generic,
        input.takenSlots,
      );
      slot = {
        name: slotName,
        kind,
        pii:
          generic === 'phone' ||
          generic === 'email' ||
          d.pd ||
          PD_FIELD_LABEL.test(`${d.text} ${d.hiddenLabel ?? ''}`),
        options: kind === 'option' ? options : [],
      };
      stepValue = { slot: slotName };
    }
  }
  // `actionOf` даёт только click/fill/select/check (не `say`).
  const kind = action as AdminMemoUiStep['kind'];
  const ui: AdminMemoUiStep = {
    action: 'ui',
    kind,
    target: {
      assistId: d.assistId,
      // Видимый текст (маска ПД) — то, что сверит бой; скрытая подпись — нет.
      text: maskLabel(d.text).slice(0, 80),
      role: d.role,
    },
    value: stepValue,
  };
  const problem = adminMemoUiProblem(ui);
  if (problem === 'click_forbidden') return stop('server_effect');
  if (problem) return { kind: 'skip', code: 'descriptor' };
  const risk = j.risk === 'auto' ? 'auto' : 'confirm';
  return {
    kind: 'step',
    step: panelUiStep(ui),
    slot,
    risk,
    // Аудит З13-А P2-1: по-настоящему при записи — только переход, вкладка,
    // пункт меню; флажок/поле владелец меняет сам (панель лишь пишет шаг).
    exec: risk === 'auto' && kind === 'click',
    undo: null,
  };
}

function panelUiStep(s: AdminMemoUiStep): AdminPanelStep {
  return {
    action: s.kind,
    page: '',
    target: s.target
      ? {
          pin: { text: s.target.text },
          assistId: s.target.assistId,
          role: s.target.role,
        }
      : null,
    value: s.value,
    expect: null,
  };
}

/** Шаги черновика АМ-N → шаги панели (`api`/`say` — по индексу `keep`). */
export function panelSteps(
  c: AdminMemoContent,
  lang: 'uk' | 'ru' | 'en',
): AdminPanelStep[] {
  return c.steps.map((s, i): AdminPanelStep => {
    if (s.action === 'ui') return panelUiStep(s);
    const text =
      s.action === 'api'
        ? s.opKey || s.op
        : (s.say[lang] ??
          s.say.uk ??
          Object.values(s.say).find((x): x is string => !!x) ??
          '');
    return {
      action: s.action,
      page: '',
      target: { pin: { text: text.slice(0, 80) }, assistId: null, role: null },
      value: null,
      expect: null,
      keep: i,
    };
  });
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Шаги и слоты из панели → сырые шаги/слоты черновика (дальше — строгий
 * `parseAdminMemo` кабинета). Шаг `keep` — ТОЛЬКО шаг `api`/`say`
 * черновика этой ревизии (иначе `keep_invalid`); шаг `ui` — из полей
 * панели (вид, цель, слот/константа). Слоты: используемые шагами `ui`
 * (из панели) и шагами `api` (из черновика); лишние — вон.
 */
export function draftFromPanel(
  prev: AdminMemoContent | null,
  stepsRaw: readonly unknown[],
  slotsRaw: readonly unknown[],
): {
  steps: unknown[];
  slots: unknown[];
  issues: Array<{ path: string; code: string }>;
} {
  const issues: Array<{ path: string; code: string }> = [];
  const steps: unknown[] = [];
  const used = new Set<string>();
  const kept = new Set<number>();
  stepsRaw.forEach((raw, i) => {
    const s = isObj(raw) ? raw : null;
    if (!s) {
      issues.push({ path: `steps[${i}]`, code: 'type' });
      return;
    }
    if (s.keep !== undefined) {
      const k = s.keep;
      const orig =
        typeof k === 'number' && Number.isInteger(k) && prev
          ? (prev.steps[k] as AdminMemoStep | undefined)
          : undefined;
      if (!orig || orig.action === 'ui' || kept.has(k as number)) {
        issues.push({ path: `steps[${i}].keep`, code: 'keep_invalid' });
        return;
      }
      kept.add(k as number);
      if (orig.action === 'api')
        for (const a of Object.values(orig.args))
          if ('slot' in a) used.add(a.slot);
      steps.push(orig);
      return;
    }
    const t = isObj(s.target) ? s.target : null;
    const pin = t && isObj(t.pin) ? t.pin : null;
    const value = isObj(s.value) ? s.value : null;
    if (value && typeof value.slot === 'string') used.add(value.slot);
    steps.push({
      action: 'ui',
      kind: s.action,
      target: t
        ? {
            assistId: typeof t.assistId === 'string' ? t.assistId : null,
            text: pin && typeof pin.text === 'string' ? pin.text : '',
            role: typeof t.role === 'string' ? t.role : null,
          }
        : null,
      value: value
        ? typeof value.slot === 'string'
          ? { slot: value.slot }
          : { const: value.const }
        : null,
    });
  });
  const slots: unknown[] = [];
  const names = new Set<string>();
  const add = (x: unknown) => {
    const n = isObj(x) && typeof x.name === 'string' ? x.name : null;
    if (!n || !used.has(n) || names.has(n)) return;
    names.add(n);
    slots.push(x);
  };
  // Слоты шагов `api` — как в черновике (их правят в TMA), затем — панели.
  for (const x of prev?.slots ?? []) add(x);
  for (const x of slotsRaw) add(x);
  return { steps, slots, issues };
}

// ── «Прогнать» ────────────────────────────────────────────────────────────

export interface AdminMemoTryView {
  steps: Array<{
    i: number;
    action: string;
    ok: boolean;
    problem: string | null;
    ref: string | null;
  }>;
  stopAt: number | null;
  problem: string | null;
  next: { i: number; page: string } | null;
  goal: null;
  done: boolean;
}

function pathOfHref(href: string | null | undefined): string {
  if (!href) return '';
  try {
    return new URL(href).pathname;
  } catch {
    return '';
  }
}

/**
 * «Прогнать» черновик АМ-N на этой странице: шаги с `from` по порядку до
 * первого сбоя или перехода (без нажатий). `api`/`say` — пропуск.
 */
export function adminMemoTry(
  c: AdminMemoContent,
  snapshot: UiSnapshot,
  ctx: { rules: VoiceControlRules; hosts: string[] },
  from: number,
): AdminMemoTryView {
  const out: AdminMemoTryView = {
    steps: [],
    stopAt: null,
    problem: null,
    next: null,
    goal: null,
    done: false,
  };
  const fail = (k: number, action: string, problem: string) => {
    out.steps.push({ i: k, action, ok: false, problem, ref: null });
    out.stopAt = k;
    out.problem = problem;
    return out;
  };
  if (!onSiteHost(snapshot.url, ctx.hosts)) return fail(from, 'ui', 'offhost');
  for (let k = Math.max(0, from); k < c.steps.length; k++) {
    const s = c.steps[k];
    if (s.action !== 'ui') {
      out.steps.push({
        i: k,
        action: s.action,
        ok: true,
        problem: null,
        ref: null,
      });
      continue;
    }
    const probe = s.value && 'slot' in s.value ? { [s.value.slot]: PROBE } : {};
    const comp = compileAdminMemoUi([s], probe, snapshot);
    const raw = comp.raw[0];
    if (comp.missingAt !== null || !raw) return fail(k, s.kind, 'no_target');
    if (raw.kind === 'scroll' || raw.kind === 'wait') {
      out.steps.push({
        i: k,
        action: s.kind,
        ok: true,
        problem: null,
        ref: null,
      });
      continue;
    }
    const checked = checkAdminPlan({
      transcript: `${s.target?.text ?? ''} ${s.target?.assistId ?? ''} ${PROBE}`,
      snapshot,
      map: [],
      steps: [raw],
      rules: ctx.rules,
      hosts: ctx.hosts,
      state: 'on',
      // Поле без «Зберегти» в отрезке — `irrev` (автосохранение), это «⚠»,
      // а не сбой: прогон проверяет цель и запреты, не нажимая.
      trusted: [
        PROBE,
        ...(s.value && 'const' in s.value ? [s.value.const] : []),
      ],
    });
    const st = checked.steps[0];
    if (!st || (st.risk !== 'auto' && st.risk !== 'confirm'))
      return fail(k, s.kind, st?.reason ?? checked.notes[0]?.code ?? 'denied');
    const ref = typeof raw.target === 'string' ? raw.target : null;
    out.steps.push({ i: k, action: s.kind, ok: true, problem: null, ref });
    // Переход по ссылке — остаток мемо на следующей странице.
    const el = ref ? snapshot.elements.find((e) => e.ref === ref) : null;
    if (el?.role === 'link' && el.href) {
      const rest = c.steps.findIndex((x, j) => j > k && x.action === 'ui');
      if (rest >= 0) {
        out.next = { i: rest, page: pathOfHref(el.href) };
        return out;
      }
    }
  }
  out.done = true;
  return out;
}
