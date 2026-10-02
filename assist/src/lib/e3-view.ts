/**
 * Чистая логика экранов Э3 (T): права, вкладки, какие кнопки у передачи,
 * периоды статистики, форматирование чисел, слова атрибуции, опросы.
 * Без React — проверяется `scripts/e3-view.test.ts`.
 *
 * Права (контракт Э3 §3 «Права», §5-тер.13): диалоги и передача — любой с
 * доступом к помощнику (оператор — только передачи, без `trace`);
 * очередь обучения — чтение и кандидат любому, решение и проверенные
 * ответы — manager; цели/статистика/экспорт/интеграции — manager
 * (оператору — ни денег, ни «Конверсий», О-12); секреты и текст в
 * экспорте — владелец; участники — владелец.
 */

import type { AccountMember } from '../kit';
import type { ConversationViewKind, HandoffView } from './handoff-types';
import type {
  GoalAttribution,
  GoalDetector,
  GoalPickerStatusView,
  GoalTemplate,
  MetricView,
} from './stats-types';

// ── Права ────────────────────────────────────────────────────────────

/** Есть доступ к помощнику вообще (оператор или менеджер). */
export function hasAssist(me: AccountMember): boolean {
  return me.role === 'owner' || me.productRoles.assist !== 'none';
}

/** manager помощника или владелец кабинета. */
export function isAssistManager(me: AccountMember): boolean {
  if (me.role === 'owner') return true;
  return me.role !== 'operator' && me.productRoles.assist === 'manager';
}

export const isOwner = (me: AccountMember) => me.role === 'owner';

/** Статистика, цели, экспорт, интеграции, настройки передачи. */
export const canSeeStats = isAssistManager;
/** Публикация проверенных ответов и решения по очереди (оператор — 403, §4-тер.15 п.14). */
export const canResolveLearning = isAssistManager;
/** Секреты интеграций и текст реплик в экспорте. */
export const canManageSecrets = isOwner;
/** Смена ролей и удаление участников (кит). */
export const canManageMembers = isOwner;

/** Вкладки ленты: оператору — только передачи (`all` для него — 403). */
export function dialogViews(me: AccountMember): ConversationViewKind[] {
  return isAssistManager(me) ? ['handoff', 'mine', 'all'] : ['handoff', 'mine'];
}

// ── Вкладки ──────────────────────────────────────────────────────────

export const STATS_TABS = ['overview', 'conversions', 'topics'] as const;
export type StatsTab = (typeof STATS_TABS)[number];
export const isStatsTab = (v: unknown): v is StatsTab =>
  typeof v === 'string' && (STATS_TABS as readonly string[]).includes(v);

export const LEARNING_TABS = ['queue', 'golden', 'quality'] as const;
export type LearningTab = (typeof LEARNING_TABS)[number];
export const isLearningTab = (v: unknown): v is LearningTab =>
  typeof v === 'string' && (LEARNING_TABS as readonly string[]).includes(v);

/** Оператору — только очередь (кандидаты); проверенные ответы и качество — manager. */
export function learningTabs(me: AccountMember): LearningTab[] {
  return canResolveLearning(me) ? [...LEARNING_TABS] : ['queue'];
}

// ── Передача: какие действия у этой передачи ────────────────────────

export interface HandoffActions {
  take: boolean;
  reply: boolean;
  draft: boolean;
  close: boolean;
}

/**
 * Взять — только ждущую; писать и черновик — взявшему; закрыть — взявшему
 * или менеджеру. Закрытая/пропущенная/отменённая — ничего.
 */
export function handoffActions(
  h: Pick<HandoffView, 'state' | 'assignedToMe'> | null,
  me: AccountMember
): HandoffActions {
  const none = { take: false, reply: false, draft: false, close: false };
  if (!h || !hasAssist(me)) return none;
  if (h.state === 'waiting') {
    return { ...none, take: true, close: isAssistManager(me) };
  }
  if (h.state === 'active') {
    const mine = h.assignedToMe;
    return {
      take: false,
      reply: mine,
      draft: mine,
      close: mine || isAssistManager(me),
    };
  }
  return none;
}

/** Опрос открытого диалога: пока передача ждёт или идёт (3 с, как виджет). */
export const DIALOG_POLL_MS = 3000;
export function shouldPollDialog(
  h: Pick<HandoffView, 'state'> | null
): boolean {
  return !!h && (h.state === 'waiting' || h.state === 'active');
}

/** «Проверить цель» и выбор цели на сайте — опрос 3 с (контракт §4 T). */
export const GOAL_POLL_MS = 3000;

// ── Период статистики ────────────────────────────────────────────────

export const PERIOD_PRESETS = [7, 30, 90] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

/** YYYY-MM-DD в поясе сайта (по умолчанию Europe/Kyiv). */
export function dayIn(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** Последние N дней включая сегодня: from = сегодня − (N − 1). */
export function periodOf(
  days: number,
  now: Date,
  timezone = 'Europe/Kyiv'
): { from: string; to: string } {
  const to = dayIn(now, timezone);
  const d = new Date(`${to}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return { from: d.toISOString().slice(0, 10), to };
}

// ── Числа ────────────────────────────────────────────────────────────

/** Доля → «42 %» (одна цифра после запятой до 10 %). */
export function pct(share: number | null): string {
  if (share === null || !Number.isFinite(share)) return '—';
  const p = share * 100;
  return `${p < 10 && p > 0 ? p.toFixed(1) : Math.round(p)} %`;
}

/** Микродоллары → «$0.0123» / «$12.34». */
export function usd(micro: number): string {
  const v = micro / 1_000_000;
  return v > 0 && v < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

/** Δ к прошлому периоду: «+12 %», «−3 %», «шум» — отдельно (MetricView.noise). */
export function delta(
  m: MetricView
): { text: string; tone: 'up' | 'down' | 'flat' } | null {
  if (m.deltaPct === null || !Number.isFinite(m.deltaPct)) return null;
  const r = Math.round(m.deltaPct);
  if (r === 0) return { text: '0 %', tone: 'flat' };
  return {
    text: `${r > 0 ? '+' : '−'}${Math.abs(r)} %`,
    tone: r > 0 ? 'up' : 'down',
  };
}

/**
 * Ключ словаря для атрибуции (§5-тер.2): direct — «помощник довёл»,
 * assisted — «с участием помощника (не обязательно благодаря)»,
 * unassisted — «без помощника». Слов «благодаря» без оговорки и
 * «окупаемость» в Э3 нет (проверяет тест словарей).
 */
export function attributionKey(a: GoalAttribution): GoalAttribution {
  return a;
}

// ── Мелочи ───────────────────────────────────────────────────────────

/** Короткий id для подписи (без раскрытия всего идентификатора). */
export function shortId(id: string): string {
  return id.length > 8 ? `…${id.slice(-6)}` : id;
}

/** Секрет — показать один раз; маска для «уже выдан». */
export function maskSecret(s: string): string {
  return s.length <= 8 ? '••••' : `${s.slice(0, 4)}••••${s.slice(-2)}`;
}

// ── Цели ─────────────────────────────────────────────────────────────

/** Детекторы по шаблону — разумное начало (владелец правит дальше). */
export function templateDetectors(tpl: GoalTemplate): GoalDetector[] {
  switch (tpl) {
    case 'lead':
      return [{ kind: 'builtin', config: { event: 'lead' } }];
    case 'call':
      return [{ kind: 'click', config: { auto: 'tel' } }];
    case 'messenger':
      return [{ kind: 'click', config: { auto: 'messenger' } }];
    case 'purchase':
      return [{ kind: 's2s', config: {} }];
    default:
      return [{ kind: 'js', config: {} }];
  }
}

/**
 * Выбор цели на сайте (§5-тер.1 WYSIWYG, TMA-часть §5-тер.16 п.6): опрос
 * статуса — пока ссылка выдана и ответ не окончательный.
 */
export function pickerShouldPoll(
  tokenId: string | null,
  status: GoalPickerStatusView | null
): boolean {
  return (
    !!tokenId && status?.status !== 'picked' && status?.status !== 'expired'
  );
}

/**
 * «Считать целью?» → детектор. Только `picked` с результатом; поле ввода
 * (input/textarea/select) целью не бывает (§5-тер.8) — даже если сервер
 * его вернул, в цель оно не уходит.
 */
export function pickedDetector(
  s: GoalPickerStatusView | null
): GoalDetector | null {
  const r = s?.status === 'picked' ? s.result : null;
  if (!r) return null;
  const tag = (r.descriptor.tag ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return null;
  const config = { descriptor: r.descriptor, pathMask: r.path || null };
  return r.kind === 'form_submit'
    ? { kind: 'form_submit', config }
    : { kind: 'click', config };
}
