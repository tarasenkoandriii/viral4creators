/**
 * Мемо «Админки» АМ-N — ЧИСТАЯ часть (Э8, ТЗ §5-бис.17 п.10, приёмка п.17;
 * Р-61, Р-62, Р-68, Р-69). Модель мемо — та же, что у «Сайта»
 * (assist-ui-core/memo.ts: имена и фразы на языках, нормализация фраз,
 * валидация текстов, ключ, слоты, разбор дат), но шаги — НЕ клики:
 *  - `api` — вызов операции коннектора по id строки операции; параметры —
 *    только из слотов (сказанного сотрудником) или констант владельца,
 *    проверка — схемой OpenAPI; write/danger — отдельное предложение и «Да»
 *    на КАЖДЫЙ шаг (§5.4: одно подтверждение — одно изменение);
 *  - `say` — реплика сотруднику.
 * Клики в мемо «Админки» до голосового управления «Админкой» (Э6-бис (б))
 * не сохраняются вовсе (422), а серверные клики «Сохранить/Удалить» — НИКОГДА
 * (§5-бис.15 п.3 п.3): серверный эффект — только шаг `api`.
 *
 * Вызов: по номеру «АМ-5» (Р-68 — в «Админке» да) или фразой владельца
 * (индекс фраз `assist_admin_phrases`); слоты — детерминированно из того,
 * что сотрудник написал после номера/фразы. Модель мемо не выбирает и не
 * заполняет (дёшево и без инъекций; lite-выбор — хвост I-Э8).
 */
import {
  MEMO_LANGS,
  MEMO_LIMITS,
  type MemoLang,
  type MemoSlotOption,
  memoTextProblem,
  parseSaidDate,
  phraseNorm,
} from '../assist-ui-core/memo';
import { normText, sameWord, tokens } from '../assist-ui-core/normalize';
import {
  ParamValidationError,
  validateArgs,
} from '../assist-admin-mode/connector-exec';
import type {
  OperationKind,
  OperationParam,
} from '../assist-admin-mode/openapi-import';

export const ADMIN_MEMO_LIMITS = {
  /** Шагов «Админки» — 10 (§5-бис.2, §5-бис.17 п.3). */
  steps: 10,
  slots: 5,
  sayChars: 160,
  goalChars: 160,
  constChars: 60,
  /** Р-69: мемо «Админки» — Pro 50, остальные тарифы 0. */
  perSitePro: 50,
} as const;

export const ADMIN_MEMO_SLOT_KINDS = [
  'text',
  'number',
  'date',
  'option',
] as const;
export type AdminMemoSlotKind = (typeof ADMIN_MEMO_SLOT_KINDS)[number];

export interface AdminMemoSlot {
  name: string;
  kind: AdminMemoSlotKind;
  /** Ставит КОД: слот попадает в параметр с ПД (телефон, e-mail, имя…). */
  pii: boolean;
  options: MemoSlotOption[];
}

export type AdminMemoArg =
  { slot: string } | { const: string | number | boolean };

export type AdminMemoStep =
  | {
      action: 'api';
      /** id строки операции (assist_admin_operations). */
      op: string;
      /** `<коннектор>.<operationId>` на момент правки — для людей. */
      opKey: string;
      args: Record<string, AdminMemoArg>;
    }
  | { action: 'say'; say: Partial<Record<MemoLang, string>> };

export interface AdminMemoContent {
  schema: 1;
  names: Partial<Record<MemoLang, string>>;
  triggers: Partial<Record<MemoLang, string[]>>;
  /** Цель для людей; проверка кодом — все шаги `api` исполнены (`ok`). */
  goal: { text: Partial<Record<MemoLang, string>> };
  slots: AdminMemoSlot[];
  steps: AdminMemoStep[];
}

export function emptyAdminMemo(): AdminMemoContent {
  return {
    schema: 1,
    names: {},
    triggers: {},
    goal: { text: {} },
    slots: [],
    steps: [],
  };
}

export interface AdminMemoIssue {
  path: string;
  code: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const SLOT_NAME_RE = /^[a-z][a-z0-9_]{0,19}$/;
const OP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Клик-действия плана — в мемо «Админки» не сохраняются (§5-бис.17 п.10). */
const CLICK_ACTIONS = new Set([
  'click',
  'fill',
  'select',
  'check',
  'navigate',
  'scroll',
  'highlight',
  'wait',
]);

function cleanText(
  v: unknown,
  path: string,
  max: number,
  issues: AdminMemoIssue[],
): string | null {
  if (typeof v !== 'string') {
    issues.push({ path, code: 'type' });
    return null;
  }
  const t = v.replace(/\s+/g, ' ').trim();
  const p = memoTextProblem(t, max);
  if (p) {
    issues.push({ path, code: p });
    return null;
  }
  return t;
}

function langTexts(
  raw: unknown,
  path: string,
  max: number,
  issues: AdminMemoIssue[],
): Partial<Record<MemoLang, string>> {
  const out: Partial<Record<MemoLang, string>> = {};
  if (raw === undefined || raw === null) return out;
  if (!isObj(raw)) {
    issues.push({ path, code: 'type' });
    return out;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (!(MEMO_LANGS as readonly string[]).includes(k)) {
      issues.push({ path: `${path}.${k}`, code: 'lang' });
      continue;
    }
    if (v === '' || v === null) continue;
    const t = cleanText(v, `${path}.${k}`, max, issues);
    if (t) out[k as MemoLang] = t;
  }
  return out;
}

/**
 * Разбор черновика мемо «Админки». Строгий: неизвестные поля отбрасываются,
 * ошибки — с путём. Шаг-клик — `click_forbidden` (сервис отвечает 422:
 * «шаг-клик „Сохранить“ в мемо не сохраняется», приёмка Э8 п.7).
 */
export function parseAdminMemo(raw: unknown): {
  content: AdminMemoContent;
  issues: AdminMemoIssue[];
} {
  const issues: AdminMemoIssue[] = [];
  const c = emptyAdminMemo();
  if (!isObj(raw)) {
    issues.push({ path: '', code: 'type' });
    return { content: c, issues };
  }
  c.names = langTexts(raw.names, 'names', MEMO_LIMITS.nameChars, issues);
  if (isObj(raw.triggers)) {
    for (const [k, v] of Object.entries(raw.triggers)) {
      if (!(MEMO_LANGS as readonly string[]).includes(k) || !Array.isArray(v)) {
        issues.push({ path: `triggers.${k}`, code: 'type' });
        continue;
      }
      if (v.length > MEMO_LIMITS.triggersPerLang) {
        issues.push({ path: `triggers.${k}`, code: 'too_many' });
      }
      const list: string[] = [];
      v.slice(0, MEMO_LIMITS.triggersPerLang).forEach((x, i) => {
        const t = cleanText(
          x,
          `triggers.${k}[${i}]`,
          MEMO_LIMITS.triggerChars,
          issues,
        );
        if (t && !list.some((o) => phraseNorm(o) === phraseNorm(t)))
          list.push(t);
      });
      if (list.length) c.triggers[k as MemoLang] = list;
    }
  }
  c.goal = {
    text: langTexts(
      isObj(raw.goal) ? raw.goal.text : undefined,
      'goal.text',
      ADMIN_MEMO_LIMITS.goalChars,
      issues,
    ),
  };
  if (Array.isArray(raw.slots)) {
    if (raw.slots.length > ADMIN_MEMO_LIMITS.slots) {
      issues.push({ path: 'slots', code: 'too_many' });
    }
    raw.slots.slice(0, ADMIN_MEMO_LIMITS.slots).forEach((s, i) => {
      const p = `slots[${i}]`;
      if (
        !isObj(s) ||
        typeof s.name !== 'string' ||
        !SLOT_NAME_RE.test(s.name)
      ) {
        issues.push({ path: `${p}.name`, code: 'invalid' });
        return;
      }
      if (c.slots.some((x) => x.name === s.name)) {
        issues.push({ path: `${p}.name`, code: 'duplicate' });
        return;
      }
      const kind = (ADMIN_MEMO_SLOT_KINDS as readonly unknown[]).includes(
        s.kind,
      )
        ? (s.kind as AdminMemoSlotKind)
        : null;
      if (!kind) {
        issues.push({ path: `${p}.kind`, code: 'invalid' });
        return;
      }
      const options: MemoSlotOption[] = [];
      if (kind === 'option') {
        const raws = Array.isArray(s.options) ? s.options : [];
        raws.slice(0, MEMO_LIMITS.slotOptions).forEach((o, j) => {
          if (!isObj(o)) return;
          const value = cleanText(
            o.value,
            `${p}.options[${j}].value`,
            MEMO_LIMITS.constChars,
            issues,
          );
          if (!value) return;
          const say: Partial<Record<MemoLang, string[]>> = {};
          if (isObj(o.say)) {
            for (const [l, forms] of Object.entries(o.say)) {
              if (
                !(MEMO_LANGS as readonly string[]).includes(l) ||
                !Array.isArray(forms)
              )
                continue;
              const list = forms
                .slice(0, 10)
                .map((f, k) =>
                  cleanText(
                    f,
                    `${p}.options[${j}].say.${l}[${k}]`,
                    MEMO_LIMITS.triggerChars,
                    issues,
                  ),
                )
                .filter((f): f is string => !!f);
              if (list.length) say[l as MemoLang] = list;
            }
          }
          options.push({ value, say });
        });
        if (!options.length)
          issues.push({ path: `${p}.options`, code: 'empty' });
      }
      c.slots.push({ name: s.name, kind, pii: false, options });
    });
  }
  if (Array.isArray(raw.steps)) {
    if (raw.steps.length > ADMIN_MEMO_LIMITS.steps) {
      issues.push({ path: 'steps', code: 'too_many' });
    }
    raw.steps.slice(0, ADMIN_MEMO_LIMITS.steps).forEach((st, i) => {
      const p = `steps[${i}]`;
      if (!isObj(st)) {
        issues.push({ path: p, code: 'type' });
        return;
      }
      if (typeof st.action === 'string' && CLICK_ACTIONS.has(st.action)) {
        issues.push({ path: `${p}.action`, code: 'click_forbidden' });
        return;
      }
      if (st.action === 'say') {
        const say = langTexts(
          st.say,
          `${p}.say`,
          ADMIN_MEMO_LIMITS.sayChars,
          issues,
        );
        if (!Object.keys(say).length)
          issues.push({ path: `${p}.say`, code: 'empty' });
        else c.steps.push({ action: 'say', say });
        return;
      }
      if (st.action !== 'api') {
        issues.push({ path: `${p}.action`, code: 'invalid' });
        return;
      }
      if (typeof st.op !== 'string' || !OP_ID_RE.test(st.op)) {
        issues.push({ path: `${p}.op`, code: 'invalid' });
        return;
      }
      const args: Record<string, AdminMemoArg> = {};
      if (st.args !== undefined && !isObj(st.args)) {
        issues.push({ path: `${p}.args`, code: 'type' });
      }
      for (const [name, a] of Object.entries(isObj(st.args) ? st.args : {})) {
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || !isObj(a)) {
          issues.push({ path: `${p}.args.${name}`, code: 'invalid' });
          continue;
        }
        if (typeof a.slot === 'string') {
          args[name] = { slot: a.slot };
        } else if (
          typeof a.const === 'string' ||
          typeof a.const === 'number' ||
          typeof a.const === 'boolean'
        ) {
          if (typeof a.const === 'string') {
            const t = cleanText(
              a.const,
              `${p}.args.${name}.const`,
              ADMIN_MEMO_LIMITS.constChars,
              issues,
            );
            if (t === null) continue;
            args[name] = { const: t };
          } else {
            args[name] = { const: a.const };
          }
        } else {
          issues.push({ path: `${p}.args.${name}`, code: 'invalid' });
        }
      }
      c.steps.push({
        action: 'api',
        op: st.op,
        opKey: typeof st.opKey === 'string' ? st.opKey.slice(0, 200) : '',
        args,
      });
    });
  }
  return { content: c, issues };
}

/** Операция каталога для ворот и исполнения (по id строки). */
export interface MemoCatalogOp {
  rowId: string;
  key: string;
  kind: OperationKind;
  enabled: boolean;
  unsupported: boolean;
  params: OperationParam[];
  roles: string[];
}

export interface AdminMemoGateReport {
  result: 'pass' | 'fail';
  problems: AdminMemoIssue[];
  warnings: AdminMemoIssue[];
  /** Классы шагов `api` (вычисляет код) — для карточки «2 × Так». */
  kinds: Array<OperationKind | 'say'>;
}

const PII_PARAM =
  /phone|tel|email|e_?mail|mail|name|address|addr|passport|card|iban|телефон|почт|адрес|ім'я|имя/i;

/** Значение-образец слота для проверки схемой (тип совместим?). */
function sampleFor(kind: AdminMemoSlotKind, p: OperationParam): unknown {
  if (kind === 'number') return p.type === 'string' ? '1' : 1;
  if (kind === 'date') return '2026-01-01';
  if (kind === 'option') return p.enum?.[0] ?? (p.type === 'string' ? 'x' : 1);
  return p.enum?.[0] ?? 'x';
}

/**
 * Ворота мемо «Админки» (держат публикацию — `held`): имя, цель, шаги 1..10
 * с хотя бы одним `api`; операция есть в каталоге сайта и вызываема;
 * параметры — только известные, обязательные — все; слот существует и
 * совместим по типу; массив (массовая операция) мемо не заполняет;
 * константа проходит схему; не использованный слот — предупреждение.
 * Включённость операции и права — предупреждение здесь и ПРОВЕРКА при
 * каждом вызове (мемо не расширяет права, §5-бис.17 п.10).
 */
export function adminMemoGates(
  c: AdminMemoContent,
  catalog: ReadonlyMap<string, MemoCatalogOp>,
): AdminMemoGateReport {
  const problems: AdminMemoIssue[] = [];
  const warnings: AdminMemoIssue[] = [];
  const kinds: Array<OperationKind | 'say'> = [];
  if (!Object.keys(c.names).length)
    problems.push({ path: 'names', code: 'empty' });
  if (!Object.keys(c.goal.text).length)
    problems.push({ path: 'goal.text', code: 'empty' });
  if (!c.steps.length) problems.push({ path: 'steps', code: 'empty' });
  if (c.steps.length > ADMIN_MEMO_LIMITS.steps)
    problems.push({ path: 'steps', code: 'too_many' });
  if (!c.steps.some((s) => s.action === 'api'))
    problems.push({ path: 'steps', code: 'no_api' });
  const usedSlots = new Set<string>();
  c.steps.forEach((s, i) => {
    const p = `steps[${i}]`;
    if (s.action === 'say') {
      kinds.push('say');
      return;
    }
    const op = catalog.get(s.op);
    if (!op) {
      problems.push({ path: `${p}.op`, code: 'operation_missing' });
      kinds.push('read');
      return;
    }
    kinds.push(op.kind);
    if (op.unsupported)
      problems.push({ path: `${p}.op`, code: 'operation_unsupported' });
    if (!op.enabled)
      warnings.push({ path: `${p}.op`, code: 'operation_disabled' });
    const byName = new Map(op.params.map((x) => [x.name, x]));
    for (const name of Object.keys(s.args)) {
      if (!byName.has(name))
        problems.push({ path: `${p}.args.${name}`, code: 'param_unknown' });
    }
    for (const prm of op.params) {
      const a = s.args[prm.name];
      if (!a) {
        if (prm.required)
          problems.push({
            path: `${p}.args.${prm.name}`,
            code: 'param_required',
          });
        continue;
      }
      if (prm.type === 'array') {
        problems.push({ path: `${p}.args.${prm.name}`, code: 'array_param' });
        continue;
      }
      const one = { ...prm, required: true };
      if ('slot' in a) {
        const slot = c.slots.find((x) => x.name === a.slot);
        if (!slot) {
          problems.push({
            path: `${p}.args.${prm.name}`,
            code: 'slot_missing',
          });
          continue;
        }
        usedSlots.add(slot.name);
        if (slot.kind === 'option') {
          for (const o of slot.options) {
            try {
              validateArgs([one], { [prm.name]: o.value });
            } catch {
              problems.push({
                path: `${p}.args.${prm.name}`,
                code: 'option_type',
              });
              break;
            }
          }
        } else {
          try {
            validateArgs([{ ...one, enum: undefined }], {
              [prm.name]: sampleFor(slot.kind, prm),
            });
          } catch {
            problems.push({ path: `${p}.args.${prm.name}`, code: 'slot_type' });
          }
          if (prm.enum) {
            warnings.push({
              path: `${p}.args.${prm.name}`,
              code: 'enum_from_text',
            });
          }
        }
      } else {
        try {
          validateArgs([one], { [prm.name]: a.const });
        } catch (e) {
          problems.push({
            path: `${p}.args.${prm.name}`,
            code:
              e instanceof ParamValidationError
                ? 'const_invalid'
                : 'const_invalid',
          });
        }
        if (typeof a.const === 'string' && PII_PARAM.test(prm.name)) {
          problems.push({ path: `${p}.args.${prm.name}`, code: 'const_pii' });
        }
      }
    }
  });
  for (const s of c.slots) {
    if (!usedSlots.has(s.name))
      warnings.push({ path: `slots.${s.name}`, code: 'slot_unused' });
  }
  return {
    result: problems.length ? 'fail' : 'pass',
    problems,
    warnings,
    kinds,
  };
}

/** Флаг ПД слотов ставит КОД: слот попал в параметр с ПД по имени. */
export function markPii(
  c: AdminMemoContent,
  catalog: ReadonlyMap<string, MemoCatalogOp>,
): AdminMemoContent {
  const pii = new Set<string>();
  for (const s of c.steps) {
    if (s.action !== 'api') continue;
    for (const [name, a] of Object.entries(s.args)) {
      if ('slot' in a && PII_PARAM.test(name)) pii.add(a.slot);
    }
    void catalog;
  }
  return {
    ...c,
    slots: c.slots.map((s) => ({ ...s, pii: s.pii || pii.has(s.name) })),
  };
}

/** Фразы мемо для индекса: имена и триггеры по языкам (нормализованные). */
export function adminMemoPhrases(
  c: Pick<AdminMemoContent, 'names' | 'triggers'>,
): Array<{ lang: MemoLang; norm: string; kind: 'memo-name' | 'memo-trigger' }> {
  const out: Array<{
    lang: MemoLang;
    norm: string;
    kind: 'memo-name' | 'memo-trigger';
  }> = [];
  for (const l of MEMO_LANGS) {
    const seen = new Set<string>();
    const n = c.names[l];
    if (n) {
      const norm = phraseNorm(n);
      if (norm) {
        seen.add(norm);
        out.push({ lang: l, norm, kind: 'memo-name' });
      }
    }
    for (const t of c.triggers[l] ?? []) {
      const norm = phraseNorm(t);
      if (norm && !seen.has(norm)) {
        seen.add(norm);
        out.push({ lang: l, norm, kind: 'memo-trigger' });
      }
    }
  }
  return out;
}

/**
 * Номер мемо в команде: «АМ-5», «ам 5», «AM5» (кириллица и латиница), Р-68 —
 * в «Админке» вызов по номеру разрешён. Возвращает номер и остаток текста
 * (из него — слоты).
 */
export function memoNumberIn(
  text: string,
): { number: number; rest: string } | null {
  // «АМ-5», «ам-5», «AM 5»: строчные без дефиса — НЕ номер (аудит Э8:
  // «I am 5 minutes late» запускало мемо АМ-5 вместо обычного ответа).
  const m =
    /(?<![\p{L}\p{N}])(?:[аАaA][мМmM]\s*[-–—]\s*|[АA][МM]\s*)(\d{1,4})(?!\d)/u.exec(
      text,
    );
  if (!m) return null;
  const number = Number(m[1]);
  if (!Number.isInteger(number) || number < 1) return null;
  const rest = `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`
    .replace(/\s+/g, ' ')
    .trim();
  return { number, rest };
}

/**
 * Фраза мемо в начале команды: самый длинный префикс исходного текста (по
 * словам), чья нормализованная форма есть в индексе. Остаток — слоты.
 */
export function phrasePrefix(
  text: string,
  has: (norm: string) => boolean,
): { norm: string; rest: string } | null {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, 20);
  for (let k = words.length; k >= 1; k--) {
    const norm = phraseNorm(words.slice(0, k).join(' '));
    if (norm && has(norm)) {
      return { norm, rest: words.slice(k).join(' ') };
    }
  }
  return null;
}

function optionIn(slot: AdminMemoSlot, text: string): string | null {
  const said = tokens(text);
  const words = normText(text).split(/[^\p{L}\p{N}]+/u);
  const hits = slot.options.filter((o) => {
    const forms = [o.value, ...MEMO_LANGS.flatMap((l) => o.say[l] ?? [])];
    return forms.some((f) => {
      const ft = tokens(f);
      if (!ft.length) return words.includes(normText(f));
      return ft.every((x) => said.some((y) => sameWord(x, y)));
    });
  });
  return hits.length === 1 ? hits[0].value : null;
}

/**
 * Слоты из текста сотрудника (детерминированно, без модели): явные
 * `имя=значение` / `имя: значение`; `option` — объявленные формы; `date` —
 * словарь дат; `number` — числа по порядку; ОДИН оставшийся `text` — остаток
 * текста. Значение всегда из того, что написал сотрудник.
 */
export function fillAdminSlots(
  slots: readonly AdminMemoSlot[],
  rest: string,
  now: Date,
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  let left = ` ${rest} `;
  for (const s of slots) {
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}_])${s.name}\\s*[=:]\\s*("([^"]{1,200})"|([^,;\\s]{1,200}))`,
      'iu',
    );
    const m = re.exec(left);
    if (m) {
      values[s.name] = (m[2] ?? m[3] ?? '').trim();
      left = left.replace(m[0], ' ');
    }
  }
  for (const s of slots) {
    if (values[s.name] !== undefined) continue;
    if (s.kind === 'option') {
      const v = optionIn(s, left);
      if (v) values[s.name] = v;
    } else if (s.kind === 'date') {
      const v = parseSaidDate(left, now);
      if (v) values[s.name] = v;
    }
  }
  for (const s of slots) {
    if (values[s.name] !== undefined || s.kind !== 'number') continue;
    const m = /(?<![\p{L}\p{N}])\d{1,12}(?:[.,]\d{1,4})?(?![\p{L}\p{N}])/u.exec(
      left,
    );
    if (m) {
      values[s.name] = m[0].replace(',', '.');
      left = `${left.slice(0, m.index)} ${left.slice(m.index + m[0].length)}`;
    }
  }
  const text = slots.filter(
    (s) => values[s.name] === undefined && s.kind === 'text',
  );
  if (text.length === 1) {
    const v = left
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[,;:\-–—]+|[,;:\-–—]+$/g, '')
      .trim();
    if (v) values[text[0].name] = v.slice(0, 200);
  }
  return {
    values,
    missing: slots
      .filter((s) => values[s.name] === undefined)
      .map((s) => s.name),
  };
}

/** Аргументы шага `api`: слоты и константы → объект для `validateArgs`. */
export function stepArgs(
  step: Extract<AdminMemoStep, { action: 'api' }>,
  slotValues: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, a] of Object.entries(step.args)) {
    out[name] = 'slot' in a ? slotValues[a.slot] : a.const;
  }
  return out;
}

/** Имя мемо на языке (или первое имеющееся). */
export function adminMemoName(c: AdminMemoContent, lang: MemoLang): string {
  return c.names[lang] ?? c.names.uk ?? c.names.ru ?? c.names.en ?? '';
}
