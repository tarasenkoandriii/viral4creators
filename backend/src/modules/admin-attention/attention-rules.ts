/**
 * Правила дашборда внимания — чистые функции «данные источника →
 * карточки» (`GET /api/admin/attention`, doc/TUTORIAL-DEMO-QUALITY-SPEC.md,
 * раздел «Дашборд внимания»).
 *
 * Здесь нет ни Prisma, ни Nest: сервис достаёт данные, правила решают,
 * что из них — проблема, насколько она срочная, кто её решает и куда
 * идти. Так правила проверяются тестами без базы, а мутации в них
 * ловятся этими тестами.
 *
 * ## Чего в карточках нет
 *
 * Персональных данных: ни id пользователей, ни имён, ни заголовков и
 * адресов, которые ввёл заказчик (заголовок черновика обучалки, адрес
 * его сайта), ни `triggeredBy` ручного запуска крона. Тексты ошибок
 * кронов и снимков проходят `scrubText`: адреса почты, ссылки, длинные
 * числа (Telegram id) и токены вырезаются, длина обрезается.
 *
 * ## Вторая копия статусов не хранится
 *
 * Карточка — проекция текущего состояния исходного объекта: причина
 * устранена — карточки нет. `id` карточки стабилен (тип + объект),
 * поэтому повторный тик крона обновляет ту же карточку, а не добавляет
 * новую.
 */

import { isSiteTutorialDemoFamilyKey } from '../tutorial-help/site-tutorial-demo';

export type AttentionSeverity = 'blocker' | 'decision' | 'info';
export type AttentionOwner = 'operator' | 'owner' | 'system';

export type AttentionKind =
  | 'cron-failed'
  | 'cron-silent'
  | 'cron-stuck'
  | 'cron-missed'
  | 'cron-recovered'
  | 'cron-only-skips'
  | 'assembly-stuck'
  | 'ui-snapshot-error'
  | 'ui-snapshot-changed'
  | 'tutorial-review'
  | 'tempo-approval'
  | 'publication-review'
  | 'shared-video-review'
  | 'portfolio-review'
  | 'auction-review'
  | 'blog-review'
  | 'client-draft-expiring'
  | 'client-draft-review'
  | 'demo-theme-gap'
  | 'demo-missing'
  | 'demo-stale'
  | 'demo-quality-fail'
  | 'demo-quality-warn'
  | 'demo-quality-error';

export interface AttentionItem {
  /** Стабильный ключ «тип:объект» — дедупликация и React key. */
  id: string;
  severity: AttentionSeverity;
  kind: AttentionKind;
  title: string;
  reason: string;
  /** Когда проблема появилась (насколько это известно источнику). */
  since: string;
  ageMs: number;
  owner: AttentionOwner;
  /** Путь админки, где проблема решается. */
  href: string;
  count?: number;
}

export type AttentionSourceKey =
  | 'cron'
  | 'demo'
  | 'ui-snapshots'
  | 'tutorial-review'
  | 'tempo'
  | 'moderation'
  | 'client-drafts'
  | 'assembly'
  | 'quality';

export type AttentionSourceStatus = 'ok' | 'error' | 'not_configured';

export interface AttentionSource {
  key: AttentionSourceKey;
  label: string;
  status: AttentionSourceStatus;
  /** Только при `error`: короткая причина без подробностей запроса. */
  error?: string;
}

export interface AttentionCounts {
  blocker: number;
  decision: number;
  info: number;
  total: number;
}

export interface AttentionView {
  generatedAt: string;
  items: AttentionItem[];
  counts: AttentionCounts;
  /** Состояние каждого источника: недоступный — «не удалось
   * проверить», а не зелёный ноль. */
  sources: AttentionSource[];
  /** Карточек больше потолка — показаны самые срочные. */
  truncated: boolean;
}

export const SOURCE_LABELS: Record<AttentionSourceKey, string> = {
  cron: 'Запуски по расписанию',
  demo: 'Сводка демо',
  'ui-snapshots': 'Снимки интерфейса',
  'tutorial-review': 'Ролики на одобрении',
  tempo: 'Версии темпа',
  moderation: 'Модерация',
  'client-drafts': 'Обучалки по сайтам',
  assembly: 'Сборки роликов',
  quality: 'Проверка качества демо',
};

/** Потолок карточек в ответе — страховка: карточки агрегированы. */
export const ATTENTION_ITEMS_CAP = 200;

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** Окно сводки кронов. */
export const CRON_WINDOW_MS = DAY_MS;
/** Демо-крон без настоящего успеха дольше этого — «только пропускает». */
export const ONLY_SKIPS_AFTER_MS = DAY_MS;
/** Снимок с ошибкой — блокер, только если удачного не было столько
 * (крон снимков — раз в 15 минут: одна осечка не тревога). */
export const SNAPSHOT_ERROR_BLOCKER_AFTER_MS = HOUR_MS;
/** Сборка в работе дольше этого — зависла. */
export const ASSEMBLY_STUCK_AFTER_MS = 2 * HOUR_MS;
/** Ролик без известной сборки старше этого — устарел. */
export const STALE_AFTER_MS = 30 * DAY_MS;
/** Сколько объектов называть поимённо в причине агрегированной карточки. */
export const REASON_LIST_LIMIT = 5;

const SEVERITY_RANK: Record<AttentionSeverity, number> = {
  blocker: 0,
  decision: 1,
  info: 2,
};

const TEXT_LIMIT = 200;

/**
 * Вычищает из свободного текста (ошибки кронов и снимков) то, что может
 * оказаться персональными данными или секретом, и обрезает длину.
 */
export function scrubText(
  text: string | null | undefined,
  limit = TEXT_LIMIT,
): string | null {
  if (!text) return null;
  const cleaned = text
    .replace(/\b(bearer|token|key|secret|password|pwd)([=:\s]+)\S+/gi, '$1$2…')
    .replace(/https?:\/\/\S+/gi, '[ссылка]')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[почта]')
    .replace(/\+\d[\d\s()-]{8,}\d/g, '[номер]')
    .replace(/\b\d{9,}\b/g, '[номер]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}

function iso(date: Date): string {
  return date.toISOString();
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Карточка с возрастом от `since` до `now` (не меньше нуля). */
export function makeItem(
  fields: Omit<AttentionItem, 'since' | 'ageMs'>,
  since: Date,
  now: Date,
): AttentionItem {
  const item: AttentionItem = {
    ...fields,
    since: iso(since),
    ageMs: Math.max(0, now.getTime() - since.getTime()),
  };
  if (item.count === undefined) delete item.count;
  return item;
}

/** Блокеры, потом решения, потом к сведению; внутри — старшие первыми. */
export function compareItems(a: AttentionItem, b: AttentionItem): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    b.ageMs - a.ageMs ||
    a.id.localeCompare(b.id)
  );
}

export function countItems(items: AttentionItem[]): AttentionCounts {
  const counts: AttentionCounts = {
    blocker: 0,
    decision: 0,
    info: 0,
    total: 0,
  };
  for (const item of items) {
    counts[item.severity] += 1;
    counts.total += 1;
  }
  return counts;
}

/**
 * Итоговый ответ: дедупликация по `id` (побеждает более срочная, затем
 * более старая), сортировка, потолок, счётчики по ВСЕМ карточкам.
 */
export function buildView(
  items: AttentionItem[],
  sources: AttentionSource[],
  now: Date,
  cap = ATTENTION_ITEMS_CAP,
): AttentionView {
  const byId = new Map<string, AttentionItem>();
  for (const item of items) {
    const prev = byId.get(item.id);
    if (!prev || compareItems(item, prev) < 0) byId.set(item.id, item);
  }
  const sorted = [...byId.values()].sort(compareItems);
  return {
    generatedAt: iso(now),
    items: sorted.slice(0, cap),
    counts: countItems(sorted),
    sources,
    truncated: sorted.length > cap,
  };
}

/** «шаг 3 · ru», «тема «birthday» · en». */
export function pairLabel(subjectKey: string, locale: string): string {
  const subject = /^\d+$/.test(subjectKey)
    ? `шаг ${subjectKey}`
    : `тема «${subjectKey}»`;
  return `${subject} · ${locale}`;
}

function listWithTail(parts: string[], limit = REASON_LIST_LIMIT): string {
  const shown = parts.slice(0, limit).join('; ');
  const rest = parts.length - Math.min(parts.length, limit);
  return rest > 0 ? `${shown} и ещё ${rest}` : shown;
}

function formatDateTime(date: Date): string {
  // Единый формат без зависимостей от локали процесса: UTC явно.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)} ${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())} UTC`;
}

function maxDate(...dates: (Date | null)[]): Date | null {
  let best: Date | null = null;
  for (const d of dates) {
    if (d && (!best || d.getTime() > best.getTime())) best = d;
  }
  return best;
}

function minDate(...dates: (Date | null)[]): Date | null {
  let best: Date | null = null;
  for (const d of dates) {
    if (d && (!best || d.getTime() < best.getTime())) best = d;
  }
  return best;
}

function query(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const s = qs.toString();
  return s ? `?${s}` : '';
}

// ── Кроны ─────────────────────────────────────────────────────────────

/** Нужное из `CronJobSummary` (`admin-cron.service.ts`). */
export interface CronJobInput {
  jobKey: string;
  expected: number | null;
  scheduledRunsInWindow: number;
  missed: number | null;
  expectedSinceJob: Date | string;
  byStatus: { RUNNING: number; SUCCESS: number; FAILED: number };
  lastSuccessAt: Date | string | null;
  lastFailureAt: Date | string | null;
  stuckRunning: number;
  recentFailures: Array<{
    startedAt: Date | string;
    summary: string | null;
    errorMessage: string | null;
  }>;
}

export interface CronStuckRow {
  jobKey: string;
  startedAt: Date | string;
}

export function cronItems(
  jobs: CronJobInput[],
  stuckRows: CronStuckRow[],
  lockMs: number,
  now: Date,
): AttentionItem[] {
  const out: AttentionItem[] = [];
  const lockMin = Math.round(lockMs / 60_000);
  for (const job of jobs) {
    const key = job.jobKey;
    const lastSuccess = toDate(job.lastSuccessAt);
    const lastFailure = toDate(job.lastFailureAt);

    if (job.stuckRunning > 0) {
      const oldest = minDate(
        ...stuckRows
          .filter((r) => r.jobKey === key)
          .map((r) => toDate(r.startedAt)),
      );
      out.push(
        makeItem(
          {
            id: `cron-stuck:${key}`,
            severity: 'blocker',
            kind: 'cron-stuck',
            title: `Крон «${key}» завис`,
            reason: `Прогон начат и не записал итог дольше замка (${lockMin} мин) — вероятно, функцию оборвал таймаут.`,
            owner: 'owner',
            href: '/cron',
            count: job.stuckRunning,
          },
          oldest ?? new Date(now.getTime() - lockMs),
          now,
        ),
      );
    }

    if (job.byStatus.FAILED > 0 && lastFailure) {
      const failingNow =
        !lastSuccess || lastFailure.getTime() > lastSuccess.getTime();
      const latest = job.recentFailures[0];
      const text = scrubText(latest?.errorMessage ?? latest?.summary);
      if (failingNow) {
        // Начало полосы сбоев — самый ранний сбой после последнего
        // успеха среди тех, что отдала сводка.
        const streakStart = minDate(
          ...job.recentFailures
            .map((f) => toDate(f.startedAt))
            .filter(
              (d): d is Date =>
                !!d && (!lastSuccess || d.getTime() > lastSuccess.getTime()),
            ),
        );
        out.push(
          makeItem(
            {
              id: `cron-failed:${key}`,
              severity: 'blocker',
              kind: 'cron-failed',
              title: `Крон «${key}» падает`,
              reason: [
                lastSuccess
                  ? `Последний успех — ${formatDateTime(lastSuccess)}.`
                  : 'Успешных прогонов в журнале нет.',
                text ? `Ошибка: ${text}` : null,
              ]
                .filter(Boolean)
                .join(' '),
              owner: 'owner',
              href: '/cron',
              count: job.byStatus.FAILED,
            },
            streakStart ?? lastFailure,
            now,
          ),
        );
      } else {
        out.push(
          makeItem(
            {
              id: `cron-recovered:${key}`,
              severity: 'info',
              kind: 'cron-recovered',
              title: `Крон «${key}»: были сбои`,
              reason: `За сутки сбоев: ${job.byStatus.FAILED}; после последнего — успешный прогон ${formatDateTime(
                lastSuccess as Date,
              )}.${text ? ` Ошибка: ${text}` : ''}`,
              owner: 'system',
              href: '/cron',
              count: job.byStatus.FAILED,
            },
            lastFailure,
            now,
          ),
        );
      }
    }

    if (job.expected != null && job.expected > 0 && (job.missed ?? 0) > 0) {
      if (job.scheduledRunsInWindow === 0) {
        out.push(
          makeItem(
            {
              id: `cron-silent:${key}`,
              severity: 'blocker',
              kind: 'cron-silent',
              title: `Крон «${key}» не запускается`,
              reason: `По расписанию ожидалось запусков: ${job.expected}; не было ни одного. Проверьте расписание и деплой.`,
              owner: 'owner',
              href: '/cron',
              count: job.expected,
            },
            maxDate(lastSuccess, lastFailure) ??
              toDate(job.expectedSinceJob) ??
              now,
            now,
          ),
        );
      } else {
        out.push(
          makeItem(
            {
              id: `cron-missed:${key}`,
              severity: 'info',
              kind: 'cron-missed',
              title: `Крон «${key}» пропускал запуски`,
              reason: `Пропущено ${job.missed} из ${job.expected} запусков по расписанию за сутки.`,
              owner: 'system',
              href: '/cron',
              count: job.missed ?? undefined,
            },
            toDate(job.expectedSinceJob) ?? now,
            now,
          ),
        );
      }
    }
  }
  return out;
}

// ── Сводка демо (`DemoStatusView`) ────────────────────────────────────

export interface DemoCronInput {
  jobKey: string;
  lastSuccess: { startedAt: string } | null;
  lastSkip: { startedAt: string; summary: string | null } | null;
}

/** Демо-крон, который сутки только пропускает работу. */
export function onlySkipItems(
  crons: DemoCronInput[],
  now: Date,
): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const c of crons) {
    if (!c.lastSkip) continue;
    const skipAt = toDate(c.lastSkip.startedAt);
    const successAt = toDate(c.lastSuccess?.startedAt);
    if (!skipAt) continue;
    if (successAt && successAt.getTime() >= skipAt.getTime()) continue;
    if (successAt && now.getTime() - successAt.getTime() <= ONLY_SKIPS_AFTER_MS)
      continue;
    const why = scrubText(c.lastSkip.summary);
    out.push(
      makeItem(
        {
          id: `cron-only-skips:${c.jobKey}`,
          severity: 'info',
          kind: 'cron-only-skips',
          title: `Крон «${c.jobKey}» только пропускает`,
          reason: `${
            successAt
              ? `Последний настоящий успех — ${formatDateTime(successAt)}.`
              : 'Настоящих успехов в журнале нет.'
          }${why ? ` Последний пропуск: ${why}` : ''}`,
          owner: 'owner',
          href: '/cron',
        },
        successAt ?? skipAt,
        now,
      ),
    );
  }
  return out;
}

export interface DemoSnapshotInput {
  routeKey: string;
  locale: string;
  theme: string;
  lastAt: string;
  lastOkAt: string | null;
  error: string | null;
}

export function snapshotErrorItems(
  snapshots: DemoSnapshotInput[],
  now: Date,
): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const s of snapshots) {
    if (!s.error) continue;
    const okAt = toDate(s.lastOkAt);
    const lastAt = toDate(s.lastAt) ?? now;
    const longBroken =
      !okAt || now.getTime() - okAt.getTime() > SNAPSHOT_ERROR_BLOCKER_AFTER_MS;
    const combo = `${s.routeKey} · ${s.locale} · ${s.theme}`;
    out.push(
      makeItem(
        {
          id: `ui-snapshot-error:${s.routeKey}:${s.locale}:${s.theme}`,
          severity: longBroken ? 'blocker' : 'info',
          kind: 'ui-snapshot-error',
          title: `Снимок интерфейса не снимается: ${combo}`,
          reason: `${scrubText(s.error) ?? 'ошибка без текста'}. ${
            okAt
              ? `Последний удачный — ${formatDateTime(okAt)}.`
              : 'Удачных снимков за период нет.'
          }`,
          owner: 'owner',
          href: `/ui-snapshots${query({ route: s.routeKey })}`,
        },
        okAt ?? lastAt,
        now,
      ),
    );
  }
  return out;
}

export interface SnapshotChangedGroup {
  routeKey: string;
  locale: string;
  theme: string;
  count: number;
  firstAt: Date | string;
}

export function snapshotChangedItems(
  groups: SnapshotChangedGroup[],
  now: Date,
): AttentionItem[] {
  return groups
    .filter((g) => g.count > 0)
    .map((g) =>
      makeItem(
        {
          id: `ui-snapshot-changed:${g.routeKey}:${g.locale}:${g.theme}`,
          severity: 'decision',
          kind: 'ui-snapshot-changed',
          title: `Интерфейс изменился: ${g.routeKey} · ${g.locale} · ${g.theme}`,
          reason: `Снимок отличался от предыдущего ${g.count} раз(а) за сутки. Проверьте, ожидаемо ли изменение и не устарели ли ролики обучалки.`,
          owner: 'operator',
          href: `/ui-snapshots${query({ route: g.routeKey })}`,
          count: g.count,
        },
        toDate(g.firstAt) ?? now,
        now,
      ),
    );
}

export interface DemoCellInput {
  subjectKey: string;
  locale: string;
  family: 'step' | 'greeting' | 'other';
  approved: {
    approvedRowCreatedAt: string;
    capturedAt: string | null;
    captureBuild: string | null;
  } | null;
  approvedThemes: (string | null)[];
}

export const KNOWN_THEMES = ['light', 'dark'] as const;
const THEME_LABEL: Record<string, string> = {
  light: 'светлой',
  dark: 'тёмной',
};

/** Сборка, которую не считаем версией: локальная/неизвестная. */
export function isRealBuild(build: string | null | undefined): build is string {
  return !!build && build !== 'dev';
}

/**
 * Матрица роликов: пробел темы (есть одобренный в одной теме, нет в
 * другой), нет ни одного (только для обязательных локалей), устаревшие.
 * Каждая группа — ОДНА карточка со счётчиком: сотня карточек «нет
 * ролика» никому не поможет.
 */
export function demoMatrixItems(
  cells: DemoCellInput[],
  opts: { requiredLocales: string[]; currentBuild: string | null },
  now: Date,
): AttentionItem[] {
  const out: AttentionItem[] = [];
  // Демо обучающего лендинга (`site-tutorial-demo-*`) — не обучалка
  // продукта: ни пробелом темы, ни «нет ролика», ни «устарел» оно здесь
  // не считается. Сводка демо и так отдаёт его отдельным списком; фильтр
  // — на случай, если ячейка семейства однажды окажется в общей матрице.
  const own = cells.filter((c) => !isSiteTutorialDemoFamilyKey(c.subjectKey));
  const catalog = own.filter((c) => c.family !== 'other');

  const gaps: { label: string; since: Date }[] = [];
  for (const c of catalog) {
    const themes = new Set(c.approvedThemes.filter((t): t is string => !!t));
    const present = KNOWN_THEMES.filter((t) => themes.has(t));
    const missing = KNOWN_THEMES.filter((t) => !themes.has(t));
    if (present.length === 0 || missing.length === 0) continue;
    gaps.push({
      label: `${pairLabel(c.subjectKey, c.locale)}: нет ${missing
        .map((t) => THEME_LABEL[t])
        .join(', ')}`,
      since: toDate(c.approved?.approvedRowCreatedAt) ?? now,
    });
  }
  if (gaps.length > 0) {
    out.push(
      makeItem(
        {
          id: 'demo-theme-gap',
          severity: 'decision',
          kind: 'demo-theme-gap',
          title: 'Пробел темы у одобренных роликов',
          reason: `Ролик одобрен в одной теме, в другой — нет: ${listWithTail(
            gaps.map((g) => g.label),
          )}.`,
          owner: 'operator',
          href: '/assistant?tab=data-status',
          count: gaps.length,
        },
        minDate(...gaps.map((g) => g.since)) ?? now,
        now,
      ),
    );
  }

  const required = new Set(opts.requiredLocales);
  const missingPairs = catalog.filter(
    (c) => !c.approved && required.has(c.locale),
  );
  if (missingPairs.length > 0) {
    out.push(
      makeItem(
        {
          id: 'demo-missing',
          severity: 'info',
          kind: 'demo-missing',
          title: 'Нет одобренного ролика',
          reason: `Ни одного одобренного ролика ни в одной теме (обязательные языки: ${[
            ...required,
          ].join(', ')}): ${listWithTail(
            missingPairs.map((c) => pairLabel(c.subjectKey, c.locale)),
          )}.`,
          owner: 'operator',
          href: '/assistant?tab=data-status',
          count: missingPairs.length,
        },
        now,
        now,
      ),
    );
  }

  const current = isRealBuild(opts.currentBuild) ? opts.currentBuild : null;
  const stale: { label: string; since: Date }[] = [];
  for (const c of own) {
    if (!c.approved) continue;
    const captured =
      toDate(c.approved.capturedAt) ??
      toDate(c.approved.approvedRowCreatedAt) ??
      now;
    const build = c.approved.captureBuild;
    if (current && isRealBuild(build)) {
      if (build !== current) {
        stale.push({
          label: `${pairLabel(c.subjectKey, c.locale)} (сборка ${build})`,
          since: captured,
        });
      }
      continue;
    }
    if (now.getTime() - captured.getTime() > STALE_AFTER_MS) {
      stale.push({
        label: `${pairLabel(c.subjectKey, c.locale)} (снят ${formatDateTime(
          captured,
        )})`,
        since: captured,
      });
    }
  }
  if (stale.length > 0) {
    out.push(
      makeItem(
        {
          id: 'demo-stale',
          severity: 'info',
          kind: 'demo-stale',
          title: 'Одобренные ролики, возможно, устарели',
          reason: `${
            current
              ? `Сняты не на текущей сборке фронтенда (${current}, по последней съёмке) или без отметки сборки старше 30 дн.`
              : 'Текущая сборка фронтенда неизвестна — по возрасту: сняты больше 30 дн. назад.'
          } ${listWithTail(stale.map((s) => s.label))}.`,
          owner: 'operator',
          href: '/assistant?tab=data-status',
          count: stale.length,
        },
        minDate(...stale.map((s) => s.since)) ?? now,
        now,
      ),
    );
  }
  return out;
}

// ── Ролики и версии на одобрении ──────────────────────────────────────

export interface PendingReviewGroup {
  subjectKey: string;
  locale: string;
  count: number;
  oldestAt: Date | string;
}

export function tutorialReviewItems(
  groups: PendingReviewGroup[],
  now: Date,
): AttentionItem[] {
  const live = groups.filter((g) => g.count > 0);
  if (live.length === 0) return [];
  const total = live.reduce((n, g) => n + g.count, 0);
  const sorted = [...live].sort(
    (a, b) =>
      (toDate(a.oldestAt)?.getTime() ?? 0) -
      (toDate(b.oldestAt)?.getTime() ?? 0),
  );
  const single = live.length === 1 ? live[0] : null;
  return [
    makeItem(
      {
        id: 'tutorial-review',
        severity: 'decision',
        kind: 'tutorial-review',
        title: 'Ролики обучалки ждут одобрения',
        reason: `Собраны, но не одобрены — посетители их не видят: ${listWithTail(
          sorted.map(
            (g) => `${pairLabel(g.subjectKey, g.locale)} (${g.count})`,
          ),
        )}.`,
        owner: 'operator',
        href: `/assistant${query({
          tab: 'videos',
          reviewed: 'false',
          subjectKey: single?.subjectKey,
          locale: single?.locale,
        })}`,
        count: total,
      },
      minDate(...live.map((g) => toDate(g.oldestAt))) ?? now,
      now,
    ),
  ];
}

export interface TempoPendingRow {
  assetId: string;
  subjectKey: string;
  locale: string;
  tempoFactor: number | null;
  readyAt: Date | string;
}

/** Одна карточка на ролик: версий у него может быть несколько. */
export function tempoApprovalItems(
  rows: TempoPendingRow[],
  now: Date,
): AttentionItem[] {
  const byAsset = new Map<string, TempoPendingRow[]>();
  for (const r of rows) {
    const list = byAsset.get(r.assetId);
    if (list) list.push(r);
    else byAsset.set(r.assetId, [r]);
  }
  const out: AttentionItem[] = [];
  for (const [assetId, list] of byAsset) {
    const first = list[0];
    const factors = [
      ...new Set(
        list
          .map((r) => r.tempoFactor)
          .filter((f): f is number => typeof f === 'number')
          .map(
            (f) => `×${String(Math.round(f * 100) / 100).replace('.', ',')}`,
          ),
      ),
    ];
    out.push(
      makeItem(
        {
          id: `tempo-approval:${assetId}`,
          severity: 'decision',
          kind: 'tempo-approval',
          title: `Версия темпа ждёт одобрения: ${pairLabel(
            first.subjectKey,
            first.locale,
          )}`,
          reason: `Собрана и проверена${
            factors.length ? ` (${factors.join(', ')})` : ''
          }; на публичном демо появится только после одобрения оператором.`,
          owner: 'operator',
          href: `/assistant${query({
            tab: 'videos',
            subjectKey: first.subjectKey,
            locale: first.locale,
            tempo: assetId,
          })}`,
          count: list.length,
        },
        minDate(...list.map((r) => toDate(r.readyAt))) ?? now,
        now,
      ),
    );
  }
  return out;
}

// ── Модерация ─────────────────────────────────────────────────────────

export type ModerationQueueKey =
  | 'publication-review'
  | 'shared-video-review'
  | 'portfolio-review'
  | 'auction-review'
  | 'blog-review';

export interface ModerationQueue {
  kind: ModerationQueueKey;
  count: number;
  oldestAt: Date | string | null;
}

const MODERATION: Record<
  ModerationQueueKey,
  { title: string; reason: string; href: string; severity: AttentionSeverity }
> = {
  'publication-review': {
    title: 'Публикации ждут модерации',
    reason: 'Заявки на выгрузку в YouTube/TikTok ждут одобрения или отказа.',
    href: '/publications',
    severity: 'decision',
  },
  'shared-video-review': {
    title: 'Публичные страницы видео ждут модерации',
    reason: 'Страница не видна посетителям, пока её не одобрят.',
    href: '/shared-videos',
    severity: 'decision',
  },
  'portfolio-review': {
    title: 'Портфолио ждёт модерации',
    reason: 'Работы исполнителей не видны на витрине до одобрения.',
    href: '/portfolio-items',
    severity: 'decision',
  },
  'auction-review': {
    title: 'Аукционные лоты ждут модерации',
    reason:
      'Лот не выходит на витрину до решения оператора; у блиц-лотов это съедает окно торгов.',
    href: '/auctions',
    severity: 'decision',
  },
  'blog-review': {
    title: 'Черновики блога ждут оператора',
    reason:
      'Черновики (в том числе созданные кроном) ждут одобрения или отказа.',
    href: '/blog',
    severity: 'info',
  },
};

export function moderationItems(
  queues: ModerationQueue[],
  now: Date,
): AttentionItem[] {
  return queues
    .filter((q) => q.count > 0)
    .map((q) => {
      const meta = MODERATION[q.kind];
      return makeItem(
        {
          id: q.kind,
          severity: meta.severity,
          kind: q.kind,
          title: meta.title,
          reason: meta.reason,
          owner: 'operator',
          href: meta.href,
          count: q.count,
        },
        toDate(q.oldestAt) ?? now,
        now,
      );
    });
}

// ── Черновики обучалки по сайту заказчика ────────────────────────────

export interface ClientDraftRow {
  id: string;
  updatedAt: Date | string;
  framesPurgedAt: Date | string | null;
}

export function clientDraftItems(
  drafts: ClientDraftRow[],
  opts: { retentionDays: number; warnDays: number },
  now: Date,
): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const d of drafts) {
    const updated = toDate(d.updatedAt) ?? now;
    const purgeAt = new Date(updated.getTime() + opts.retentionDays * DAY_MS);
    const left = purgeAt.getTime() - now.getTime();
    const purged = toDate(d.framesPurgedAt);
    const expiring = !purged && left <= opts.warnDays * DAY_MS;
    const daysLeft = Math.max(0, Math.ceil(left / DAY_MS));
    out.push(
      makeItem(
        {
          id: `client-draft:${d.id}`,
          severity: 'decision',
          kind: expiring ? 'client-draft-expiring' : 'client-draft-review',
          title: expiring
            ? 'Черновик обучалки клиента скоро сотрётся'
            : 'Обучалка по сайту клиента ждёт одобрения',
          reason: purged
            ? 'Кадры уже стёрты по сроку хранения — ролик соберётся из предпросмотра. Одобрите или отклоните.'
            : `Кадры сотрутся ${formatDateTime(purgeAt)} (через ${daysLeft} дн.), если не принять решение. Одобрение запускает платную сборку.`,
          owner: 'operator',
          href: `/site-tutorial-drafts${query({ open: d.id })}`,
        },
        updated,
        now,
      ),
    );
  }
  return out;
}

// ── Зависшие сборки ───────────────────────────────────────────────────

export interface StuckAssemblyInput {
  assets: number;
  assetsOldestAt: Date | string | null;
  versions: number;
  versionsOldestAt: Date | string | null;
}

export function assemblyStuckItems(
  input: StuckAssemblyInput,
  now: Date,
): AttentionItem[] {
  const total = input.assets + input.versions;
  if (total === 0) return [];
  const parts: string[] = [];
  if (input.assets > 0) parts.push(`роликов: ${input.assets}`);
  if (input.versions > 0) parts.push(`версий темпа: ${input.versions}`);
  return [
    makeItem(
      {
        id: 'assembly-stuck',
        severity: 'blocker',
        kind: 'assembly-stuck',
        title: 'Сборка роликов зависла',
        reason: `В работе дольше ${Math.round(
          ASSEMBLY_STUCK_AFTER_MS / HOUR_MS,
        )} ч — ${parts.join(', ')}. Проверьте крон «tutorial-assembly-poll» и задачи ffmpeg.`,
        owner: 'owner',
        href: '/assistant?tab=videos',
        count: total,
      },
      minDate(toDate(input.assetsOldestAt), toDate(input.versionsOldestAt)) ??
        now,
      now,
    ),
  ];
}

// ── Проверка качества демо (Gemini) ───────────────────────────────────

/** Последняя проверка ролика (`TutorialDemoQualityCheck`). */
export interface QualityCheckRow {
  assetId: string;
  status: string;
  verdict: string | null;
  checkedAt: Date | string | null;
  updatedAt: Date | string;
  subjectKey: string;
  locale: string;
  theme: string | null;
  /** Краткое содержание отчёта (`report.summary`); проходит `scrubText`. */
  summary: string | null;
  issueCount: number;
}

/** Поимённых карточек на вердикт — страховка: роликов десятки. */
export const QUALITY_CARDS_CAP = 50;

/**
 * Карточки качества демо: по одной на ролик, чья ПОСЛЕДНЯЯ проверка
 * завершена с `fail` (решение оператора) или `warn` (к сведению), и одна
 * агрегированная на проверки, исчерпавшие повторы. Проверка в очереди
 * карточки не даёт; новая проверка того же ролика заменяет прежнюю.
 * Фаза наблюдения: карточка ведёт к ролику, одобрение не меняет.
 */
export function qualityItems(
  rows: QualityCheckRow[],
  now: Date,
): AttentionItem[] {
  const out: AttentionItem[] = [];
  const byVerdict = { fail: 0, warn: 0 };
  const errors: QualityCheckRow[] = [];
  for (const r of rows) {
    if (r.status === 'error') {
      errors.push(r);
      continue;
    }
    if (r.status !== 'complete') continue;
    if (r.verdict !== 'fail' && r.verdict !== 'warn') continue;
    if (byVerdict[r.verdict] >= QUALITY_CARDS_CAP) continue;
    byVerdict[r.verdict] += 1;
    const fail = r.verdict === 'fail';
    const theme =
      r.theme === 'light' || r.theme === 'dark' ? ` · ${r.theme}` : '';
    const summary = scrubText(r.summary, 160);
    out.push(
      makeItem(
        {
          id: `demo-quality-${r.verdict}:${r.assetId}`,
          severity: fail ? 'decision' : 'info',
          kind: fail ? 'demo-quality-fail' : 'demo-quality-warn',
          title: `${fail ? 'Демо не прошло проверку качества' : 'Демо: замечания проверки качества'}: ${pairLabel(
            r.subjectKey,
            r.locale,
          )}${theme}`,
          reason: `${
            fail
              ? 'ИИ-проверка нашла блокирующий дефект'
              : 'ИИ-проверка просит взгляда оператора'
          }${r.issueCount > 0 ? ` (замечаний: ${r.issueCount})` : ''}${
            summary ? `: ${summary}` : '.'
          } Одобрение ролика проверка не меняет.`,
          owner: 'operator',
          href: `/assistant${query({
            tab: 'videos',
            subjectKey: r.subjectKey,
            locale: r.locale,
            quality: r.assetId,
          })}`,
        },
        toDate(r.checkedAt) ?? toDate(r.updatedAt) ?? now,
        now,
      ),
    );
  }
  if (errors.length > 0) {
    out.push(
      makeItem(
        {
          id: 'demo-quality-error',
          severity: 'info',
          kind: 'demo-quality-error',
          title: 'Проверка качества демо не удалась',
          reason: `Повторы исчерпаны: ${listWithTail(
            errors.map((e) => pairLabel(e.subjectKey, e.locale)),
          )}. Это сбой проверки, а не вердикт ролику — запустите «Проверить» заново.`,
          owner: 'operator',
          href: '/assistant?tab=videos',
          count: errors.length,
        },
        minDate(...errors.map((e) => toDate(e.updatedAt))) ?? now,
        now,
      ),
    );
  }
  return out;
}
