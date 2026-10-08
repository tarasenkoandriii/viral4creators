/**
 * Находки недели, выводы и тексты владельцу «Админки» (заход 10: №57, Р-З10-13)
 * — ЧИСТЫЙ модуль.
 *
 *  - находки считает КОД по свёрткам и разметке «Админки» (§5-тер.5 Р-45 —
 *    тот же принцип, свой набор): модель только формулирует, и каждое число
 *    её текста обязано быть числом находки (иначе — сухая строка кодом);
 *  - тексты владельцу — на языке ПОЛУЧАТЕЛЯ (uk/ru/en, Р-З9-7): рамка
 *    отчёта и сухие строки — кодом на каждый язык, текст модели — тот язык,
 *    что она вернула для этого получателя;
 *  - ≤ 4 096 символов (предел сообщения Telegram); рейтинга сотрудников и
 *    имён в отчёте нет (агрегаты, В-42).
 */
import { maskSensitiveEcho } from '../../shared/assist-chat-core';
import type { NotifyLang } from '../assist-knowledge-core/notify';
import { ADMIN_TASK_TYPES, type AdminTaskType } from './admin-label-schema';

export const ADMIN_REPORT_LANGS: readonly NotifyLang[] = ['uk', 'ru', 'en'];
const TG_MAX = 4096;

/** Числа недели (свёртка `*` за 7 дней). */
export interface AdminWeekTotals {
  conversations: number;
  questions: number;
  refused: number;
  thumbsDown: number;
  labeled: number;
  answerYes: number;
  answerPartial: number;
  toolErrors: number;
  proposed: number;
  confirmed: number;
  actionsFailed: number;
  minutesSaved: number;
}

export const EMPTY_WEEK: AdminWeekTotals = {
  conversations: 0,
  questions: 0,
  refused: 0,
  thumbsDown: 0,
  labeled: 0,
  answerYes: 0,
  answerPartial: 0,
  toolErrors: 0,
  proposed: 0,
  confirmed: 0,
  actionsFailed: 0,
  minutesSaved: 0,
};

export function sumWeek(
  rows: Array<Partial<AdminWeekTotals>>,
): AdminWeekTotals {
  const out = { ...EMPTY_WEEK };
  for (const r of rows) {
    for (const k of Object.keys(out) as Array<keyof AdminWeekTotals>) {
      const v = r[k];
      if (typeof v === 'number' && Number.isFinite(v)) out[k] += v;
    }
  }
  return out;
}

export type AdminFindingKind =
  | 'refusals'
  | 'not_found'
  | 'tool_errors'
  | 'actions_failed'
  | 'learning_queue';

export interface AdminFinding {
  id: string;
  kind: AdminFindingKind;
  /** База (вопросов, размеченных, исполнений). */
  n: number;
  /** Сколько «плохих». */
  value: number;
  /** Доля в процентах, целое; null — у находки нет доли. */
  pct: number | null;
  taskType?: AdminTaskType;
}

/** Пороги находок (умолчания; уточнить на пилотах). */
export const FINDING_RULES = {
  refusals: { minQuestions: 10, minShare: 0.2 },
  notFound: { minLabeled: 5, minShare: 0.3 },
  toolErrors: { min: 5 },
  actionsFailed: { minFailed: 3, minShare: 0.2 },
  learningQueue: { min: 5 },
} as const;

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

/** Находки недели — код, без модели (§5-тер.5 Р-45). */
export function weekFindings(p: {
  totals: AdminWeekTotals;
  labels: Array<{ taskType: string; answerFound: string; status: string }>;
  learningNew: number;
}): AdminFinding[] {
  const t = p.totals;
  const out: AdminFinding[] = [];
  if (
    t.questions >= FINDING_RULES.refusals.minQuestions &&
    t.refused / t.questions >= FINDING_RULES.refusals.minShare
  ) {
    out.push({
      id: 'refusals',
      kind: 'refusals',
      n: t.questions,
      value: t.refused,
      pct: pct(t.refused, t.questions),
    });
  }
  for (const type of ADMIN_TASK_TYPES) {
    const ls = p.labels.filter(
      (l) => l.taskType === type && l.status !== 'failed',
    );
    const no = ls.filter((l) => l.answerFound === 'no').length;
    if (
      ls.length >= FINDING_RULES.notFound.minLabeled &&
      no / ls.length >= FINDING_RULES.notFound.minShare
    ) {
      out.push({
        id: `not_found:${type}`,
        kind: 'not_found',
        n: ls.length,
        value: no,
        pct: pct(no, ls.length),
        taskType: type,
      });
    }
  }
  if (t.toolErrors >= FINDING_RULES.toolErrors.min) {
    out.push({
      id: 'tool_errors',
      kind: 'tool_errors',
      n: t.questions,
      value: t.toolErrors,
      pct: null,
    });
  }
  if (
    t.actionsFailed >= FINDING_RULES.actionsFailed.minFailed &&
    t.confirmed > 0 &&
    t.actionsFailed / t.confirmed >= FINDING_RULES.actionsFailed.minShare
  ) {
    out.push({
      id: 'actions_failed',
      kind: 'actions_failed',
      n: t.confirmed,
      value: t.actionsFailed,
      pct: pct(t.actionsFailed, t.confirmed),
    });
  }
  if (p.learningNew >= FINDING_RULES.learningQueue.min) {
    out.push({
      id: 'learning_queue',
      kind: 'learning_queue',
      n: p.learningNew,
      value: p.learningNew,
      pct: null,
    });
  }
  return out.slice(0, 8);
}

const TASK_NAMES: Record<NotifyLang, Record<AdminTaskType, string>> = {
  uk: {
    lookup: 'пошук інформації',
    order_status: 'статус замовлення/запису',
    how_to: 'як зробити в системі',
    data_change: 'зміна даних',
    report: 'звіти й цифри',
    policy: 'правила компанії',
    troubleshooting: 'помилки й проблеми',
    other: 'інше',
  },
  ru: {
    lookup: 'поиск информации',
    order_status: 'статус заказа/записи',
    how_to: 'как сделать в системе',
    data_change: 'изменение данных',
    report: 'отчёты и цифры',
    policy: 'правила компании',
    troubleshooting: 'ошибки и проблемы',
    other: 'другое',
  },
  en: {
    lookup: 'finding information',
    order_status: 'order/record status',
    how_to: 'how-to in the system',
    data_change: 'data changes',
    report: 'reports and numbers',
    policy: 'company rules',
    troubleshooting: 'errors and problems',
    other: 'other',
  },
};

export function taskName(lang: NotifyLang, t: string): string {
  return TASK_NAMES[lang][t as AdminTaskType] ?? t;
}

/** Сухая строка находки кодом (без модели) — на языке получателя. */
export function dryFindingLine(f: AdminFinding, lang: NotifyLang): string {
  const L = {
    uk: {
      refusals: `«Не знаю» у ${f.pct}% відповідей (${f.value} з ${f.n}) — додайте знання в «Навчання (співробітники)».`,
      not_found: `Задачі «${taskName('uk', f.taskType ?? 'other')}»: відповідь не знайдено в ${f.pct}% (${f.value} з ${f.n}).`,
      tool_errors: `Помилок інструментів (API) за тиждень: ${f.value} — перевірте конектори й параметри.`,
      actions_failed: `Збоїв дій після «Так»: ${f.value} з ${f.n} (${f.pct}%) — перегляньте журнал дій.`,
      learning_queue: `У черзі навчання ${f.value} нових питань співробітників.`,
    },
    ru: {
      refusals: `«Не знаю» у ${f.pct}% ответов (${f.value} из ${f.n}) — добавьте знания в «Обучение (сотрудники)».`,
      not_found: `Задачи «${taskName('ru', f.taskType ?? 'other')}»: ответ не найден в ${f.pct}% (${f.value} из ${f.n}).`,
      tool_errors: `Ошибок инструментов (API) за неделю: ${f.value} — проверьте коннекторы и параметры.`,
      actions_failed: `Сбоев действий после «Да»: ${f.value} из ${f.n} (${f.pct}%) — посмотрите журнал действий.`,
      learning_queue: `В очереди обучения ${f.value} новых вопросов сотрудников.`,
    },
    en: {
      refusals: `"I don't know" in ${f.pct}% of answers (${f.value} of ${f.n}) — add knowledge in "Staff learning".`,
      not_found: `"${taskName('en', f.taskType ?? 'other')}" tasks: no answer found in ${f.pct}% (${f.value} of ${f.n}).`,
      tool_errors: `Tool (API) errors this week: ${f.value} — check connectors and parameters.`,
      actions_failed: `Actions failed after "Yes": ${f.value} of ${f.n} (${f.pct}%) — see the action log.`,
      learning_queue: `${f.value} new staff questions are waiting in the learning queue.`,
    },
  } as const;
  return L[lang][f.kind];
}

// ── Выводы моделью: схема, разбор, проверка чисел ───────────────────────

export interface AdminInsightItem {
  findingIds: string[];
  uk: { title: string; action: string };
  ru: { title: string; action: string };
  en: { title: string; action: string };
}

export function buildInsightPrompt(findings: AdminFinding[]): {
  system: string;
  user: string;
} {
  const system = [
    'You write 1-5 short weekly insights for the owner of a company about the internal back-office assistant used by employees.',
    'Input: <findings> JSON computed by code. Use ONLY these findings; every number you write must be one of the numbers of the findings you reference (n, value, pct).',
    'Never judge or rank employees. No names, no contacts.',
    'Return ONLY JSON: {"items":[{"findingIds":[ids],"uk":{"title":"…","action":"…"},"ru":{"title":"…","action":"…"},"en":{"title":"…","action":"…"}}]}',
    'title ≤ 100 chars, action ≤ 200 chars; uk = Ukrainian, ru = Russian, en = English.',
  ].join('\n');
  const user = `<findings>${JSON.stringify(
    findings.map((f) => ({
      id: f.id,
      kind: f.kind,
      n: f.n,
      value: f.value,
      pct: f.pct,
      taskType: f.taskType ?? null,
    })),
  )}</findings>`;
  return { system, user };
}

/** Числа текста (целые и десятичные; разделитель «,» или «.»). */
export function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((x) =>
    String(Number(x.replace(',', '.'))),
  );
}

function strField(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t || Array.from(t).length > max) return null;
  // Контакт в тексте модели — выбрасываем (данные «Админки» — ПД клиентов).
  if (maskSensitiveEcho(t) !== t) return null;
  return t;
}

/**
 * Разбор выводов модели: id — только из находок, языки — все три, длины —
 * в пределах, числа — только числа упомянутых находок. Негодный пункт
 * выбрасывается; ни одного годного — null (сухие строки кодом).
 */
export function parseInsightItems(
  raw: string,
  findings: AdminFinding[],
): AdminInsightItem[] | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const items =
    v &&
    typeof v === 'object' &&
    Array.isArray((v as { items?: unknown }).items)
      ? ((v as { items: unknown[] }).items as unknown[])
      : null;
  if (!items) return null;
  const byId = new Map(findings.map((f) => [f.id, f]));
  const out: AdminInsightItem[] = [];
  for (const it of items.slice(0, 5)) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const ids = Array.isArray(o.findingIds)
      ? o.findingIds.filter((x): x is string => typeof x === 'string')
      : [];
    if (!ids.length || ids.some((id) => !byId.has(id))) continue;
    const allowed = new Set<string>();
    for (const id of ids) {
      const f = byId.get(id)!;
      for (const n of [f.n, f.value, f.pct]) {
        if (n !== null) allowed.add(String(n));
      }
    }
    const langs: Partial<AdminInsightItem> = {};
    let good = true;
    for (const lang of ADMIN_REPORT_LANGS) {
      const l = o[lang] as Record<string, unknown> | undefined;
      const title = strField(l?.title, 100);
      const action = strField(l?.action, 200);
      if (
        !title ||
        !action ||
        numbersIn(`${title} ${action}`).some((n) => !allowed.has(n))
      ) {
        good = false;
        break;
      }
      langs[lang] = { title, action };
    }
    if (!good) continue;
    out.push({
      findingIds: ids,
      ...(langs as Omit<AdminInsightItem, 'findingIds'>),
    });
  }
  return out.length ? out : null;
}

/** Хранимые выводы → пункты (мусор в базе — пусто). */
export function readInsightItems(v: unknown): AdminInsightItem[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is AdminInsightItem =>
      !!x &&
      typeof x === 'object' &&
      Array.isArray((x as AdminInsightItem).findingIds) &&
      ADMIN_REPORT_LANGS.every(
        (l) =>
          typeof (x as AdminInsightItem)[l]?.title === 'string' &&
          typeof (x as AdminInsightItem)[l]?.action === 'string',
      ),
  );
}

/** Хранимые находки → находки (мусор — пусто). */
export function readFindings(v: unknown): AdminFinding[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is AdminFinding =>
      !!x &&
      typeof x === 'object' &&
      typeof (x as AdminFinding).id === 'string' &&
      typeof (x as AdminFinding).kind === 'string' &&
      typeof (x as AdminFinding).n === 'number' &&
      typeof (x as AdminFinding).value === 'number',
  );
}

// ── Тексты владельцу ─────────────────────────────────────────────────────

function delta(cur: number, prev: number | null): string {
  if (prev === null) return '';
  const d = cur - prev;
  return d === 0 ? ' (=)' : ` (${d > 0 ? '+' : ''}${d})`;
}

function hours(min: number): string {
  return (Math.round((min / 60) * 10) / 10).toString();
}

/** Отчёт недели «Админки» на языке получателя (≤ 4 096 символов). */
export function weeklyReportText(p: {
  lang: NotifyLang;
  siteName: string;
  weekStart: string;
  totals: AdminWeekTotals;
  prev: AdminWeekTotals | null;
  findings: AdminFinding[];
  items: AdminInsightItem[] | null;
}): { text: string; button: string } {
  const t = p.totals;
  const prev = p.prev;
  const found = t.labeled ? pct(t.answerYes, t.labeled) : null;
  const refusedPct = pct(t.refused, t.questions);
  const H = {
    uk: {
      head: `Тиждень «Адмінки» з ${p.weekStart} · ${p.siteName}`,
      conv: `Діалогів співробітників: ${t.conversations}${delta(t.conversations, prev?.conversations ?? null)}`,
      q: `Питань: ${t.questions}${delta(t.questions, prev?.questions ?? null)} · «не знаю»: ${refusedPct}%`,
      found:
        found === null
          ? null
          : `Відповідь знайдено: ${found}% розмічених діалогів`,
      act: `Дії: запропоновано ${t.proposed}, «Так» ${t.confirmed}, збоїв ${t.actionsFailed}`,
      saved:
        t.minutesSaved > 0
          ? `≈ ${hours(t.minutesSaved)} год заощаджено (за вашими хвилинами на тип задачі)`
          : null,
      fh: 'Що варто зробити:',
      none: 'Особливих сигналів за тиждень немає.',
      button: 'Відкрити статистику',
    },
    ru: {
      head: `Неделя «Админки» с ${p.weekStart} · ${p.siteName}`,
      conv: `Диалогов сотрудников: ${t.conversations}${delta(t.conversations, prev?.conversations ?? null)}`,
      q: `Вопросов: ${t.questions}${delta(t.questions, prev?.questions ?? null)} · «не знаю»: ${refusedPct}%`,
      found:
        found === null ? null : `Ответ найден: ${found}% размеченных диалогов`,
      act: `Действия: предложено ${t.proposed}, «Да» ${t.confirmed}, сбоев ${t.actionsFailed}`,
      saved:
        t.minutesSaved > 0
          ? `≈ ${hours(t.minutesSaved)} ч сэкономлено (по вашим минутам на тип задачи)`
          : null,
      fh: 'Что стоит сделать:',
      none: 'Особых сигналов за неделю нет.',
      button: 'Открыть статистику',
    },
    en: {
      head: `Back-office assistant week from ${p.weekStart} · ${p.siteName}`,
      conv: `Staff conversations: ${t.conversations}${delta(t.conversations, prev?.conversations ?? null)}`,
      q: `Questions: ${t.questions}${delta(t.questions, prev?.questions ?? null)} · "I don't know": ${refusedPct}%`,
      found:
        found === null
          ? null
          : `Answer found: ${found}% of labelled conversations`,
      act: `Actions: proposed ${t.proposed}, "Yes" ${t.confirmed}, failed ${t.actionsFailed}`,
      saved:
        t.minutesSaved > 0
          ? `≈ ${hours(t.minutesSaved)} h saved (by your minutes per task type)`
          : null,
      fh: 'Worth doing:',
      none: 'No notable signals this week.',
      button: 'Open statistics',
    },
  }[p.lang];
  const lines = [H.head, '', H.conv, H.q];
  if (H.found) lines.push(H.found);
  lines.push(H.act);
  if (H.saved) lines.push(H.saved);
  lines.push('');
  const covered = new Set<string>();
  const bullets: string[] = [];
  for (const it of p.items ?? []) {
    bullets.push(`• ${it[p.lang].title} — ${it[p.lang].action}`);
    for (const id of it.findingIds) covered.add(id);
  }
  for (const f of p.findings) {
    if (!covered.has(f.id)) bullets.push(`• ${dryFindingLine(f, p.lang)}`);
  }
  if (bullets.length) lines.push(H.fh, ...bullets);
  else lines.push(H.none);
  let text = lines.join('\n');
  if (text.length > TG_MAX) text = `${text.slice(0, TG_MAX - 1)}…`;
  return { text, button: H.button };
}

/** Р-З10-13: push владельцу — тревога компенсаций «Админки». */
export function compensationAlertText(
  lang: NotifyLang,
  p: { siteName: string; attempts: number; ok: number },
): { text: string; button: string } {
  const rate = pct(p.ok, p.attempts);
  return {
    uk: {
      text: `«Адмінка» · ${p.siteName}: відкат дій (компенсації) спрацьовує погано — успішно ${p.ok} з ${p.attempts} за добу (${rate}%). Схоже, розмітка скасування в адмінці застаріла: перевірте операції скасування в «Адмінці → Дії».`,
      button: 'Відкрити статистику',
    },
    ru: {
      text: `«Админка» · ${p.siteName}: откат действий (компенсации) срабатывает плохо — успешно ${p.ok} из ${p.attempts} за сутки (${rate}%). Похоже, разметка отмены в админке устарела: проверьте операции отмены в «Админке → Действия».`,
      button: 'Открыть статистику',
    },
    en: {
      text: `Back-office assistant · ${p.siteName}: undo of actions (compensations) works poorly — ${p.ok} of ${p.attempts} succeeded in 24 h (${rate}%). The undo markup of your admin may be outdated: check the undo operations in Back office → Actions.`,
      button: 'Open statistics',
    },
  }[lang];
}

/** Понедельник UTC недели `now` (YYYY-MM-DD). */
export function weekStartOf(now: Date): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export function addDaysIso(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
