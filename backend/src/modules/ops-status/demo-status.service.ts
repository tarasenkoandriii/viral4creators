/**
 * DemoStatusService — «можно ли сейчас показывать демо» одним ответом
 * для оператора (`GET /api/ops/demo-status`, TODO II «Оператор:
 * проверить последние прогоны существующего крона», 06.10.2026).
 *
 * Три вопроса, на которые раньше отвечали запросом в базу:
 *
 * 1. Живы ли кроны обучалки — когда был последний НАСТОЯЩИЙ успех
 *    (не пропуск по замку), последний провал и последний пропуск.
 * 2. Что из роликов можно показывать — матрица «тема обучалки × локаль
 *    × тема интерфейса»: есть ли одобренный ролик, какой он темы, когда
 *    снят и какой версией интерфейса, сколько собранных ждут одобрения.
 *    Светлая и тёмная — отдельные ролики пары (заход 3 «Актуального
 *    демо», 06.10.2026), поэтому у ячейки есть `byTheme`: свой
 *    одобренный и своя очередь на одобрение у каждой темы.
 * 3. Свежи ли снимки интерфейса — последний снимок каждой комбинации
 *    маршрут × локаль × тема.
 *
 * ## Только чтение и без персональных данных
 *
 * Ни одной записи. Из журнала кронов не отдаётся `triggeredBy` (у
 * ручного запуска это id пользователя-оператора) — только признак
 * «крон/вручную». Из роликов — ни сценария, ни id строк, ни ролики
 * обучалки по сайтам заказчиков (`clientSiteDraftId` не NULL — это
 * чужие сайты, у них своя очередь модерации). Тексты ошибок
 * обрезаются: оператору нужна причина, а не трассировка.
 *
 * ## Пропуск
 *
 * Пропущенный прогон (джоб-замок, ненастроенная фикстура) пишется в
 * журнал как SUCCESS со сводкой «пропущен — …» (`buildRunSummary`).
 * Считать его успехом нельзя — на этом и держится вопрос «жив ли
 * крон»: опрос сборок, который месяц только пропускает, выглядел бы
 * здоровым. Признак пропуска — эта сводка ИЛИ `skipped` в разобранном
 * результате (`debugLog`, если прогон был с debug), что раньше
 * встретится. Ни от одного из двух ответ не зависит целиком: без них
 * прогон просто считается успехом, как и до этого эндпоинта.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SUPPORTED_LOCALES } from '../../common/locale';
import { ASSISTANT_STEPS } from '../../common/tutorial-knowledge/generated';
import { greetingTopicKeys } from '../tutorial-scenario/tutorial-locales';
import {
  isSiteTutorialDemoFamilyKey,
  SITE_TUTORIAL_DEMO_KEYS,
} from '../tutorial-help/site-tutorial-demo';

/** Кроны, от которых зависит демо, в порядке конвейера. */
export const DEMO_CRON_JOB_KEYS = [
  'tutorial-scenario-generate',
  'tutorial-scenario-run',
  'tutorial-assembly-poll',
  'ui-snapshot-run',
] as const;
export type DemoCronJobKey = (typeof DEMO_CRON_JOB_KEYS)[number];

/** = `VERCEL_CRON_TRIGGERED_BY` в `cron-jobs.service.ts` (сверено
 * тестом): своя копия, чтобы не тянуть сюда весь сервис кронов. */
export const CRON_TRIGGERED_BY = 'vercel-cron';

/** Сводка «пропущен — причина» из `buildRunSummary`. */
export const SKIPPED_SUMMARY_PREFIX = 'пропущен';

/** Сколько дней назад искать снимки интерфейса: обычные хранятся 3
 * дня, «изменилось» — 30 (`ui-snapshot-retention.ts`). Комбинация,
 * которую не снимали месяц, — уже не «последний снимок», а её
 * отсутствие, и показывать её так и надо. */
export const UI_SNAPSHOT_LOOKBACK_DAYS = 30;

/** Потолок строк одобренных роликов за один ответ — страховка, а не
 * пагинация: одобренных по нашим темам десятки. */
export const APPROVED_ASSETS_CAP = 2000;

const TEXT_LIMIT = 300;

export type CronOutcome = 'success' | 'failed' | 'skipped' | 'running';

export interface DemoCronRun {
  outcome: CronOutcome;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** 'cron' — расписание Vercel, 'manual' — кнопка в админке. */
  trigger: 'cron' | 'manual';
  /** Сводка прогона или текст ошибки, обрезанные. */
  summary: string | null;
}

export interface DemoCronStatus {
  jobKey: DemoCronJobKey;
  lastRun: DemoCronRun | null;
  lastSuccess: DemoCronRun | null;
  lastFailure: DemoCronRun | null;
  lastSkip: DemoCronRun | null;
}

export interface DemoApprovedVideo {
  theme: string | null;
  approvedRowCreatedAt: string;
  capturedAt: string | null;
  captureBuild: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  hasPoster: boolean;
}

/** Темы интерфейса, по которым снимаются ролики — столбцы `byTheme`. */
export const DEMO_THEMES = ['light', 'dark'] as const;
export type DemoTheme = (typeof DEMO_THEMES)[number];

/** Тема строки ролика для матрицы: без темы — светлая (до тем всё
 *  снималось светлым; `approvedThemes` при этом честно покажет `null`). */
function demoTheme(raw: string | null): DemoTheme {
  return raw === 'dark' ? 'dark' : 'light';
}

export interface DemoThemeCell {
  /** Самый свежий одобренный ролик ЭТОЙ темы; `null` — его нет. */
  approved: DemoApprovedVideo | null;
  /** Собранные ролики этой темы, ждущие одобрения. */
  pendingReview: number;
}

export interface DemoTutorialCell {
  subjectKey: string;
  locale: string;
  /** 'step' — шаг мастера товара, 'greeting' — тема поздравления,
   * 'other' — ключ, которого нет в каталоге (свободный ключ воркфлоу
   * или тема, удалённая из каталога, а ролики остались). */
  family: 'step' | 'greeting' | 'other';
  /** Что увидит посетитель: самый свежий одобренный, любой темы. */
  approved: DemoApprovedVideo | null;
  /** Темы, для которых есть одобренный ролик (`null` — тема не записана). */
  approvedThemes: (string | null)[];
  /** Собранные (`complete`), но ещё не одобренные. */
  pendingReview: number;
  /** То же по каждой теме интерфейса — светлый и тёмный ролики пары
   *  одобряются и устаревают независимо. */
  byTheme: Record<DemoTheme, DemoThemeCell>;
}

/**
 * Ячейка демо обучающего лендинга (`site-tutorial-demo-*`, витрина-
 * полигон): та же форма, что у матрицы, но отдельным списком — это не
 * обучалка продукта, и в «пробелы» матрицы (сводка внимания) она не
 * идёт. Публикует ролик семейства не одобрение, а отдельная отметка
 * оператора; здесь — только что снято и что одобрено.
 */
export interface DemoSiteTutorialCell extends Omit<DemoTutorialCell, 'family'> {
  family: 'site-tutorial-demo';
}

export interface DemoUiSnapshot {
  routeKey: string;
  locale: string;
  theme: string;
  lastAt: string;
  /** Последний снимок без ошибки; `null` — за период удачных не было. */
  lastOkAt: string | null;
  changed: boolean;
  diffScore: number | null;
  error: string | null;
  imageUrl: string | null;
}

export interface DemoStatusView {
  generatedAt: string;
  crons: DemoCronStatus[];
  tutorials: {
    locales: string[];
    cells: DemoTutorialCell[];
    totals: {
      cells: number;
      withApproved: number;
      pendingReview: number;
      /** Ячеек с одобренным роликом каждой темы. */
      withApprovedByTheme: Record<DemoTheme, number>;
    };
    /** Демо обучающего лендинга — отдельно от матрицы и её итогов. */
    siteTutorialDemo: {
      cells: DemoSiteTutorialCell[];
      withApproved: number;
      pendingReview: number;
    };
  };
  uiSnapshots: {
    sinceDays: number;
    items: DemoUiSnapshot[];
  };
}

interface CronRow {
  status: 'RUNNING' | 'SUCCESS' | 'FAILED';
  triggeredBy: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  summary: string | null;
  errorMessage: string | null;
  debugLog: unknown;
}

interface AssetRow {
  subjectKey: string;
  locale: string;
  theme: string | null;
  createdAt: Date;
  capturedAt: Date | null;
  captureBuild: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  posterUrl: string | null;
}

interface SnapshotRow {
  routeKey: string;
  locale: string;
  theme: string;
  createdAt: Date;
  changed: boolean;
  diffScore: number | null;
  error: string | null;
  blobUrl: string | null;
}

const CRON_SELECT = {
  status: true,
  triggeredBy: true,
  startedAt: true,
  finishedAt: true,
  durationMs: true,
  summary: true,
  errorMessage: true,
  debugLog: true,
} as const;

function clip(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text;
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** Пропуск, а не успех: см. «Пропуск» в доккомментарии файла. */
export function isSkippedRun(row: {
  status: string;
  summary: string | null;
  debugLog?: unknown;
}): boolean {
  if (row.status !== 'SUCCESS') return false;
  if (row.summary?.startsWith(SKIPPED_SUMMARY_PREFIX)) return true;
  const log = row.debugLog;
  if (log && typeof log === 'object' && !Array.isArray(log)) {
    const skipped = (log as { skipped?: unknown }).skipped;
    return skipped === true || (typeof skipped === 'string' && skipped !== '');
  }
  return false;
}

export function cronOutcome(row: CronRow): CronOutcome {
  if (row.status === 'FAILED') return 'failed';
  if (row.status === 'RUNNING') return 'running';
  return isSkippedRun(row) ? 'skipped' : 'success';
}

function toRun(row: CronRow | null): DemoCronRun | null {
  if (!row) return null;
  const outcome = cronOutcome(row);
  return {
    outcome,
    startedAt: row.startedAt.toISOString(),
    finishedAt: iso(row.finishedAt),
    durationMs: row.durationMs,
    trigger: row.triggeredBy === CRON_TRIGGERED_BY ? 'cron' : 'manual',
    summary: clip(
      outcome === 'failed' ? (row.errorMessage ?? row.summary) : row.summary,
    ),
  };
}

function positive(value: number | null): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

/** Пары «ключ × локаль» из каталога — в порядке экрана. */
export function catalogSubjects(
  locale: string,
): { subjectKey: string; family: 'step' | 'greeting' }[] {
  const steps = ASSISTANT_STEPS[locale] ?? [];
  return [
    ...steps.map((_, i) => ({
      subjectKey: String(i + 1),
      family: 'step' as const,
    })),
    ...greetingTopicKeys(locale).map((subjectKey) => ({
      subjectKey,
      family: 'greeting' as const,
    })),
  ];
}

interface PendingGroup {
  subjectKey: string;
  locale: string;
  theme: string | null;
  _count: { _all: number };
}

/**
 * Ячейки матрицы по готовым строкам: сначала пары каталога в порядке
 * экрана, потом — пары, которых в каталоге нет, но ролики у них есть
 * (`extraFamily`). Одна функция на матрицу продукта и на демо
 * обучающего лендинга, чтобы правила ячейки у них не разошлись.
 */
function buildCells<F extends string>(
  approvedRows: readonly AssetRow[],
  pendingGroups: readonly PendingGroup[],
  catalog: readonly { subjectKey: string; locale: string; family: F }[],
  extraFamily: F,
): (Omit<DemoTutorialCell, 'family'> & { family: F })[] {
  const key = (subjectKey: string, locale: string) =>
    `${locale}\u0000${subjectKey}`;
  // Строки уже от новых к старым: первая встреченная — самая свежая.
  const approvedByPair = new Map<string, AssetRow[]>();
  for (const row of approvedRows) {
    const k = key(row.subjectKey, row.locale);
    const list = approvedByPair.get(k);
    if (list) list.push(row);
    else approvedByPair.set(k, [row]);
  }
  const pendingByPair = new Map<string, number>();
  const pendingByTheme = new Map<string, number>();
  for (const g of pendingGroups) {
    const k = key(g.subjectKey, g.locale);
    pendingByPair.set(k, (pendingByPair.get(k) ?? 0) + g._count._all);
    const kt = `${k}\u0000${demoTheme(g.theme)}`;
    pendingByTheme.set(kt, (pendingByTheme.get(kt) ?? 0) + g._count._all);
  }

  const cells: (Omit<DemoTutorialCell, 'family'> & { family: F })[] = [];
  const seen = new Set<string>();
  const cellFor = (subjectKey: string, locale: string, family: F) => {
    const k = key(subjectKey, locale);
    seen.add(k);
    const rows = approvedByPair.get(k) ?? [];
    // Строки — от новых к старым: первая своей темы — самая свежая.
    const byTheme = Object.fromEntries(
      DEMO_THEMES.map((theme) => [
        theme,
        {
          approved: approvedVideo(
            rows.find((r) => demoTheme(r.theme) === theme),
          ),
          pendingReview: pendingByTheme.get(`${k}\u0000${theme}`) ?? 0,
        },
      ]),
    ) as Record<DemoTheme, DemoThemeCell>;
    return {
      subjectKey,
      locale,
      family,
      approved: approvedVideo(rows[0]),
      approvedThemes: [...new Set(rows.map((r) => r.theme))],
      pendingReview: pendingByPair.get(k) ?? 0,
      byTheme,
    };
  };

  for (const { subjectKey, locale, family } of catalog) {
    cells.push(cellFor(subjectKey, locale, family));
  }
  // Ролики по ключам вне каталога — не прятать: они тоже кому-то
  // показываются (свободный ключ воркфлоу) или висят после удаления
  // темы из каталога.
  const extra = new Map<string, { subjectKey: string; locale: string }>();
  for (const row of approvedRows) {
    extra.set(key(row.subjectKey, row.locale), row);
  }
  for (const g of pendingGroups) {
    extra.set(key(g.subjectKey, g.locale), g);
  }
  for (const [k, { subjectKey, locale }] of extra) {
    if (!seen.has(k)) cells.push(cellFor(subjectKey, locale, extraFamily));
  }
  return cells;
}

function approvedVideo(row: AssetRow | undefined): DemoApprovedVideo | null {
  if (!row) return null;
  const width = positive(row.width);
  const height = positive(row.height);
  const sized = width !== null && height !== null;
  return {
    theme: row.theme,
    approvedRowCreatedAt: row.createdAt.toISOString(),
    capturedAt: iso(row.capturedAt),
    captureBuild: row.captureBuild,
    durationMs: row.durationMs,
    width: sized ? width : null,
    height: sized ? height : null,
    hasPoster: Boolean(row.posterUrl),
  };
}

@Injectable()
export class DemoStatusService {
  constructor(private readonly prisma: PrismaService) {}

  async get(now: Date = new Date()): Promise<DemoStatusView> {
    const [crons, tutorials, uiSnapshots] = await Promise.all([
      Promise.all(DEMO_CRON_JOB_KEYS.map((jobKey) => this.cronStatus(jobKey))),
      this.tutorialMatrix(),
      this.uiSnapshots(now),
    ]);
    return {
      generatedAt: now.toISOString(),
      crons,
      tutorials,
      uiSnapshots,
    };
  }

  private async cronStatus(jobKey: DemoCronJobKey): Promise<DemoCronStatus> {
    const latest = (where: Record<string, unknown>) =>
      this.prisma.cronRunLog.findFirst({
        where: { jobKey, ...where },
        orderBy: { startedAt: 'desc' },
        select: CRON_SELECT,
      }) as Promise<CronRow | null>;
    // Успех, сводка которого не «пропущен — …». `summary` бывает NULL
    // у строк до сводок — это тоже успех.
    const realSuccess = {
      status: 'SUCCESS',
      OR: [
        { summary: null },
        { NOT: { summary: { startsWith: SKIPPED_SUMMARY_PREFIX } } },
      ],
    };
    const [lastRun, firstSuccess, lastFailure, lastSkip] = await Promise.all([
      latest({}),
      latest(realSuccess),
      latest({ status: 'FAILED' }),
      latest({
        status: 'SUCCESS',
        summary: { startsWith: SKIPPED_SUMMARY_PREFIX },
      }),
    ]);
    // Пропуск, видный только по `skipped` в debug-результате, фильтром
    // по сводке не отсечь: такой прогон уходит в «пропуск», а успех
    // ищется дальше в прошлое (несколько шагов — debug-прогоны редки).
    let success = firstSuccess;
    let skip = lastSkip;
    for (let hop = 0; success && isSkippedRun(success) && hop < 5; hop++) {
      if (!skip || success.startedAt > skip.startedAt) skip = success;
      success = await latest({
        ...realSuccess,
        startedAt: { lt: success.startedAt },
      });
    }
    if (success && isSkippedRun(success)) success = null;
    return {
      jobKey,
      lastRun: toRun(lastRun),
      lastSuccess: toRun(success),
      lastFailure: toRun(lastFailure),
      lastSkip: toRun(skip),
    };
  }

  private async tutorialMatrix(): Promise<DemoStatusView['tutorials']> {
    const ours = { clientSiteDraftId: null };
    const [approvedRows, pendingGroups] = await Promise.all([
      this.prisma.tutorialVideoAsset.findMany({
        where: {
          ...ours,
          reviewed: true,
          OR: [{ blobUrl: { not: null } }, { externalUrl: { not: null } }],
        },
        orderBy: { createdAt: 'desc' },
        take: APPROVED_ASSETS_CAP,
        select: {
          subjectKey: true,
          locale: true,
          theme: true,
          createdAt: true,
          capturedAt: true,
          captureBuild: true,
          durationMs: true,
          width: true,
          height: true,
          posterUrl: true,
        },
      }) as Promise<AssetRow[]>,
      this.prisma.tutorialVideoAsset.groupBy({
        by: ['subjectKey', 'locale', 'theme'],
        where: { ...ours, reviewed: false, assemblyStatus: 'complete' },
        _count: { _all: true },
      }) as unknown as Promise<PendingGroup[]>,
    ]);

    // Демо обучающего лендинга — отдельным списком (раздел 5.3
    // черновика демо): ни в матрицу, ни в её итоги, ни в «другие» — это
    // не обучалка продукта, и пробелом матрицы она не считается.
    const isFamily = (r: { subjectKey: string }) =>
      isSiteTutorialDemoFamilyKey(r.subjectKey);
    const cells = buildCells(
      approvedRows.filter((r) => !isFamily(r)),
      pendingGroups.filter((g) => !isFamily(g)),
      SUPPORTED_LOCALES.flatMap((locale) =>
        catalogSubjects(locale).map(({ subjectKey, family }) => ({
          subjectKey,
          locale,
          family,
        })),
      ),
      'other',
    );
    const familyCells = buildCells(
      approvedRows.filter(isFamily),
      pendingGroups.filter(isFamily),
      SUPPORTED_LOCALES.flatMap((locale) =>
        SITE_TUTORIAL_DEMO_KEYS.map((subjectKey) => ({
          subjectKey,
          locale,
          family: 'site-tutorial-demo' as const,
        })),
      ),
      'site-tutorial-demo',
    );

    return {
      locales: [...SUPPORTED_LOCALES],
      cells,
      totals: {
        cells: cells.length,
        withApproved: cells.filter((c) => c.approved).length,
        pendingReview: cells.reduce((n, c) => n + c.pendingReview, 0),
        withApprovedByTheme: Object.fromEntries(
          DEMO_THEMES.map((theme) => [
            theme,
            cells.filter((c) => c.byTheme[theme].approved).length,
          ]),
        ) as Record<DemoTheme, number>,
      },
      siteTutorialDemo: {
        cells: familyCells,
        withApproved: familyCells.filter((c) => c.approved).length,
        pendingReview: familyCells.reduce((n, c) => n + c.pendingReview, 0),
      },
    };
  }

  private async uiSnapshots(now: Date): Promise<DemoStatusView['uiSnapshots']> {
    const since = new Date(
      now.getTime() - UI_SNAPSHOT_LOOKBACK_DAYS * 86_400_000,
    );
    const by = ['routeKey', 'locale', 'theme'] as const;
    type Group = {
      routeKey: string;
      locale: string;
      theme: string;
      _max: { createdAt: Date | null };
    };
    // Крон пишет строку на маршрут каждые две минуты — тянуть строки и
    // сворачивать их здесь нельзя. Группировка по индексу
    // `(routeKey, locale, theme, createdAt)`, потом одна строка на
    // комбинацию.
    const [latestGroups, okGroups] = (await Promise.all([
      this.prisma.uiSnapshot.groupBy({
        by: [...by],
        where: { createdAt: { gte: since } },
        _max: { createdAt: true },
      }),
      this.prisma.uiSnapshot.groupBy({
        by: [...by],
        where: { createdAt: { gte: since }, error: null },
        _max: { createdAt: true },
      }),
    ])) as unknown as [Group[], Group[]];

    const comboKey = (g: { routeKey: string; locale: string; theme: string }) =>
      `${g.routeKey}\u0000${g.locale}\u0000${g.theme}`;
    const okAt = new Map<string, Date | null>();
    for (const g of okGroups) okAt.set(comboKey(g), g._max.createdAt);

    const items = await Promise.all(
      latestGroups
        .filter((g) => g._max.createdAt)
        .map(async (g): Promise<DemoUiSnapshot | null> => {
          const row = (await this.prisma.uiSnapshot.findFirst({
            where: {
              routeKey: g.routeKey,
              locale: g.locale,
              theme: g.theme,
              createdAt: g._max.createdAt as Date,
            },
            orderBy: { createdAt: 'desc' },
            select: {
              routeKey: true,
              locale: true,
              theme: true,
              createdAt: true,
              changed: true,
              diffScore: true,
              error: true,
              blobUrl: true,
            },
          })) as SnapshotRow | null;
          if (!row) return null;
          return {
            routeKey: row.routeKey,
            locale: row.locale,
            theme: row.theme,
            lastAt: row.createdAt.toISOString(),
            lastOkAt: iso(okAt.get(comboKey(row)) ?? null),
            changed: row.changed,
            diffScore: row.diffScore,
            error: clip(row.error),
            imageUrl: row.blobUrl,
          };
        }),
    );
    return {
      sinceDays: UI_SNAPSHOT_LOOKBACK_DAYS,
      items: items
        .filter((i): i is DemoUiSnapshot => i !== null)
        .sort(
          (a, b) =>
            a.routeKey.localeCompare(b.routeKey) ||
            a.locale.localeCompare(b.locale) ||
            a.theme.localeCompare(b.theme),
        ),
    };
  }
}
