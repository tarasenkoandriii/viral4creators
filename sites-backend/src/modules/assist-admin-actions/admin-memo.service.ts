/**
 * Мемо «Админки» АМ-N — кабинет и исполнение (Э8, ТЗ §5-бис.17 п.4, п.10,
 * п.12, п.15 п.17; Р-61, Р-68, Р-69).
 *
 * Кабинет (только `assistAdmin: owner`, гвард контроллера): номер из
 * счётчика сайта (не переиспользуется), ключ (неизменен после первой
 * публикации), черновик с ревизией (409 при расхождении), версия = ворота
 * кода + проверка по живому каталогу коннекторов, затем СУХОЙ ПРОГОН в
 * браузере владельца (аудит 06.10, §5-бис.17 п.7: ссылка мастера `admin-vc`,
 * `admin-memo-check.ts`; шаги `api` в прогоне не исполняются), публикация —
 * отдельным подтверждением владельца и только с годным отчётом прогона
 * ЭТОЙ версии (409 `MEMO_CHECK_REQUIRED`), индекс фраз — уникальный ключ БД
 * (гонка двух публикаций с одной фразой — одна получает 409). Журнал
 * изменений — записи `memo` в append-only assist_admin_action_log
 * (§5-бис.17 п.10). «Требует проверки» и статистика запусков —
 * `admin-memo-review.ts` (монитор — `admin-memo-monitor.service.ts`).
 *
 * Исполнение (сотрудник): «АМ-5 …» или фраза → опубликованная версия
 * (закреплена в запуске) → права роли на КАЖДУЮ операцию до первого шага
 * (мемо не расширяет права) → шаги по порядку: `read` — сразу, write/danger —
 * предложение и «Да» (каждое отдельно), `say` — реплика; итог шага
 * продолжает запуск (`ProposalsService.onSettled`).
 */
import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { readState } from '../assist-billing/public/entitlements';
import { ASSIST_PLANS } from '../assist-billing/plans';
import {
  AdminActionLogService,
  canonicalJson,
} from '../assist-admin-mode/action-log.service';
import { adminError } from '../assist-admin-mode/admin-errors';
import { AdminModeService } from '../assist-admin-mode/admin-mode.service';
import {
  ConnectorsService,
  type ToolOperation,
} from '../assist-admin-mode/connectors.service';
import type {
  OperationKind,
  OperationParam,
} from '../assist-admin-mode/openapi-import';
import {
  buildMemoChoicePrompt,
  memoMentioned,
  parseMemoChoice,
  suggestMemoKey,
  MEMO_LIMITS,
  type MemoLang,
} from '../assist-ui-core/memo';
import { adminSpentToday } from '../assist-admin-mode/admin-budget';
import { siteDailyCapFromPlan } from '../assist-billing/plans';
import { geminiOutputCeiling } from '../site-ai/gemini-output';
import { GeminiText } from '../site-ai/text-model';
import { AiUsageRecorder } from '../site-ai/usage-recorder';
import { estimateCost } from '../../shared/ai-pricing';
import { GEMINI_MODEL } from '../../shared/gemini-model';
import type { AccountMembership } from '../site-core/account/roles';
import { ACTION_LIMITS } from './action-core';
import {
  ADMIN_MEMO_LIMITS,
  type AdminMemoContent,
  type AdminMemoGateReport,
  type MemoCatalogOp,
  adminMemoGates,
  adminMemoName,
  adminMemoPhrases,
  emptyAdminMemo,
  fillAdminSlots,
  liteAdminSlotsRest,
  markPii,
  memoNumberIn,
  parseAdminMemo,
  phrasePrefix,
  stepArgs,
} from './admin-memo';
import type { AdminMemoUiStep } from '../assist-admin-voice/admin-voice-rules';
import {
  adminMemoApiChecks,
  adminMemoCheckUsable,
  adminMemoSameSteps,
  type AdminMemoApiCheck,
  type AdminMemoCheckReport,
} from './admin-memo-check';
import {
  adminMemoStats,
  type AdminMemoReviewReason,
  type AdminMemoStats,
} from './admin-memo-review';
import {
  type ActorCtx,
  ProposalsService,
  type ProposalView,
} from './proposals.service';

export interface AdminMemoListItem {
  number: number;
  key: string;
  name: string;
  status: string;
  publishedVersion: number | null;
  draftRevision: number;
  updatedAt: string;
  /** «Требует проверки» (§5-бис.17 п.8): причина от монитора; иначе null. */
  reviewReason: AdminMemoReviewReason | null;
  /** Запуски опубликованных версий за 30 дней (§5-бис.17 п.13, п.14). */
  stats: AdminMemoStats;
}

export interface AdminMemoView extends AdminMemoListItem {
  draft: AdminMemoContent;
  /** Те же метрики за 7 дней (окно порогов `needs_review`). */
  stats7: AdminMemoStats;
  versions: Array<{
    number: number;
    status: string;
    gateReport: AdminMemoGateReport | null;
    /** Отчёт сухого прогона этой версии (null — прогона не было). */
    checkReport: AdminMemoCheckReport | null;
    createdAt: string;
    publishedAt: string | null;
    rollbackOf: number | null;
  }>;
}

/** Окна статистики мемо «Админки», дней. */
export const ADMIN_MEMO_STATS_DAYS = { list: 30, review: 7 } as const;
const DAY_MS = 86_400_000;

const MEMO_TEXT = {
  started: {
    uk: (n: number, name: string) => `Виконую АМ-${n} «${name}».`,
    ru: (n: number, name: string) => `Выполняю АМ-${n} «${name}».`,
    en: (n: number, name: string) => `Running AM-${n} «${name}».`,
  },
  step: {
    uk: (i: number, total: number) =>
      `Крок ${i} з ${total}: потрібне ваше «Так».`,
    ru: (i: number, total: number) => `Шаг ${i} из ${total}: нужно ваше «Да».`,
    en: (i: number, total: number) =>
      `Step ${i} of ${total}: your "Yes" is needed.`,
  },
  done: {
    uk: (n: number, goal: string) =>
      `АМ-${n} виконано${goal ? `: ${goal}` : ''}.`,
    ru: (n: number, goal: string) =>
      `АМ-${n} выполнено${goal ? `: ${goal}` : ''}.`,
    en: (n: number, goal: string) =>
      `AM-${n} is done${goal ? `: ${goal}` : ''}.`,
  },
  stopped: {
    uk: (n: number, i: number, done: string) =>
      `АМ-${n} зупинено на кроці ${i}.${done ? ` Уже зроблено: ${done}.` : ' Нічого не змінено.'}`,
    ru: (n: number, i: number, done: string) =>
      `АМ-${n} остановлено на шаге ${i}.${done ? ` Уже сделано: ${done}.` : ' Ничего не изменено.'}`,
    en: (n: number, i: number, done: string) =>
      `AM-${n} stopped at step ${i}.${done ? ` Already done: ${done}.` : ' Nothing was changed.'}`,
  },
  missing: {
    uk: (n: number, names: string) =>
      `Для АМ-${n} вкажіть: ${names} (наприклад, «АМ-${n} назва=значення»).`,
    ru: (n: number, names: string) =>
      `Для АМ-${n} укажите: ${names} (например, «АМ-${n} имя=значение»).`,
    en: (n: number, names: string) =>
      `For AM-${n}, please provide: ${names} (e.g. "AM-${n} name=value").`,
  },
  forbidden: {
    uk: (n: number) =>
      `У вас немає прав на операції АМ-${n} — зверніться до власника.`,
    ru: (n: number) =>
      `У вас нет прав на операции АМ-${n} — обратитесь к владельцу.`,
    en: (n: number) =>
      `You don't have rights for the operations of AM-${n} — ask the owner.`,
  },
  unknownMemo: {
    uk: (n: number) => `Мемо АМ-${n} не знайдено або вимкнено.`,
    ru: (n: number) => `Мемо АМ-${n} не найдено или выключено.`,
    en: (n: number) => `Memo AM-${n} was not found or is disabled.`,
  },
  readFailed: {
    uk: 'запит до системи не вдався',
    ru: 'запрос к системе не удался',
    en: 'the system request failed',
  },
  // Э6-бис (б): шаги на странице (Р-Э6б-10).
  uiNeedsPage: {
    uk: (n: number) =>
      `АМ-${n} має кроки на сторінці адмінки — запустіть його в помічнику на сторінці з увімкненим голосовим керуванням.`,
    ru: (n: number) =>
      `В АМ-${n} есть шаги на странице админки — запустите его в помощнике на странице с включённым голосовым управлением.`,
    en: (n: number) =>
      `AM-${n} has steps on the admin page — run it from the assistant on the page with voice control enabled.`,
  },
  uiNext: {
    uk: (i: number, total: number) => `Крок ${i} з ${total} — на сторінці.`,
    ru: (i: number, total: number) => `Шаг ${i} из ${total} — на странице.`,
    en: (i: number, total: number) => `Step ${i} of ${total} is on the page.`,
  },
  // D3 (§5-бис.17 п.5 п.8): мемо перестало быть рабочим посреди запуска.
  halted: {
    uk: (n: number, i: number, why: string, done: string) =>
      `АМ-${n} зупинено перед кроком ${i}: ${why}.${done ? ` Уже зроблено: ${done}.` : ' Нічого не змінено.'}`,
    ru: (n: number, i: number, why: string, done: string) =>
      `АМ-${n} остановлено перед шагом ${i}: ${why}.${done ? ` Уже сделано: ${done}.` : ' Ничего не изменено.'}`,
    en: (n: number, i: number, why: string, done: string) =>
      `AM-${n} stopped before step ${i}: ${why}.${done ? ` Already done: ${done}.` : ' Nothing was changed.'}`,
  },
  haltWhy: {
    needs_review: {
      uk: 'мемо позначено «потребує перевірки» — власник має перевірити й опублікувати нову версію',
      ru: 'мемо помечено «требует проверки» — владелец должен проверить и опубликовать новую версию',
      en: 'the memo was marked "needs review" — the owner has to check it and publish a new version',
    },
    disabled: {
      uk: 'власник вимкнув мемо',
      ru: 'владелец выключил мемо',
      en: 'the owner disabled the memo',
    },
    removed: {
      uk: 'мемо видалено',
      ru: 'мемо удалено',
      en: 'the memo was removed',
    },
    unavailable: {
      uk: 'мемо зараз не опубліковане',
      ru: 'мемо сейчас не опубликовано',
      en: 'the memo is not published right now',
    },
  },
} as const;

/**
 * Почему запуск мемо больше не исполняет шаги (D3): мемо ушло в «требует
 * проверки», выключено, удалено или иначе перестало быть опубликованным.
 */
export type MemoHaltReason = keyof typeof MEMO_TEXT.haltWhy;

/** Исполнять шаги можно только у опубликованного и включённого мемо. */
export function memoHaltReason(
  memo: { status: string } | null,
): MemoHaltReason | null {
  if (!memo) return 'removed';
  switch (memo.status) {
    case 'published':
      return null;
    case 'needs_review':
    case 'disabled':
    case 'removed':
      return memo.status;
    default:
      return 'unavailable';
  }
}

/** Отрезок шагов на странице, который ждёт исполнения (Э6-бис (б)). */
export interface MemoUiSegment {
  runId: string;
  memoNumber: number;
  name: string;
  from: number;
  to: number;
  steps: AdminMemoUiStep[];
  slots: Record<string, string>;
}

type MemoRow = Prisma.AssistAdminMemoGetPayload<object>;

function contentHash(c: unknown): string {
  return createHash('sha256').update(canonicalJson(c)).digest('hex');
}

const RUN_FACT = {
  memoId: true,
  memoVersion: true,
  actor: true,
  status: true,
  step: true,
  goalStatus: true,
  progress: true,
  createdAt: true,
} as const;

@Injectable()
export class AdminMemoService {
  /**
   * Запуск закончился сбоем — монитор «требует проверки» смотрит это мемо
   * сразу (как монитор голосового управления «Админки» — на концах планов,
   * без крона; крон — страховочный проход). Ставит монитор.
   */
  onRunFailed:
    ((accountId: string, memoId: string) => Promise<unknown>) | null = null;

  constructor(
    private readonly db: SitesDb,
    private readonly prisma: PrismaService,
    private readonly mode: AdminModeService,
    private readonly connectors: ConnectorsService,
    private readonly proposals: ProposalsService,
    private readonly log: AdminActionLogService,
    private readonly text: GeminiText,
    private readonly usage: AiUsageRecorder,
  ) {
    this.proposals.onSettled = (ctx, row, status) =>
      this.afterStep(ctx, row.memoRunId!, row.memoStep!, status);
    // D3: «Да» на шаге мемо — тоже шаг; мемо, ушедшее в «требует проверки»
    // или выключенное, не исполняет и уже предложенный шаг.
    this.proposals.beforeMemoStep = (ctx, row) =>
      this.haltRun(ctx, row.memoRunId!, row.memoStep ?? 0);
  }

  /** Статус мемо прямо сейчас (D3) — перед каждым шагом запуска. */
  private async memoHalt(
    accountId: string,
    memoId: string,
  ): Promise<MemoHaltReason | null> {
    return memoHaltReason(
      await this.db.forAccount(accountId).assistAdminMemo.findFirst({
        where: { id: memoId },
        select: { status: true },
      }),
    );
  }

  /**
   * D3: запуск остановлен, потому что мемо перестало быть рабочим, —
   * статус `stopped` (не сбой мемо: монитор его не считает), прогресс с
   * отметкой, текст с причиной и перечнем сделанного.
   */
  private async markHalted(
    accountId: string,
    run: { id: string; memoNumber: number },
    i: number,
    why: MemoHaltReason,
    progress: Array<{ i: number; operation: string; outcome: string }>,
    lang: MemoLang,
    where: Prisma.AssistAdminMemoRunWhereInput = {},
  ): Promise<string> {
    progress.push({ i, operation: 'memo', outcome: `halted:${why}` });
    await this.db.forAccount(accountId).assistAdminMemoRun.updateMany({
      where: { id: run.id, ...where },
      data: {
        status: 'stopped',
        step: i,
        goalStatus: 'not_reached',
        slots: Prisma.DbNull,
        progress: progress as unknown as Prisma.InputJsonValue,
      },
    });
    const done = progress
      .filter((p) => p.outcome === 'ok' || p.outcome === 'done')
      .map((p) => p.operation)
      .join(', ');
    return MEMO_TEXT.halted[lang](
      run.memoNumber,
      i + 1,
      MEMO_TEXT.haltWhy[why][lang],
      done,
    );
  }

  /**
   * D3: запуск этого сотрудника, а мемо уже не рабочее, — остановить с
   * причиной (текст) или `null`, если мемо в порядке / запуска нет.
   * Зовут «Да» на шаге мемо и план голосового управления перед отрезком
   * шагов на странице.
   */
  async haltRun(
    ctx: ActorCtx,
    runId: string,
    /** Шаг, перед которым остановка; нет — текущий шаг запуска. */
    step?: number,
  ): Promise<{ number: number; text: string } | null> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) return null;
    const run = await this.db
      .forAccount(ctx.accountId)
      .assistAdminMemoRun.findFirst({
        where: { id: runId, siteId: ctx.siteId, actor: ctx.actor },
      });
    if (!run) return null;
    const why = await this.memoHalt(ctx.accountId, run.memoId);
    if (!why) return null;
    const at = step ?? run.step;
    const progress = Array.isArray(run.progress)
      ? (run.progress as Array<{
          i: number;
          operation: string;
          outcome: string;
        }>)
      : [];
    const lang = (
      ['uk', 'ru', 'en'].includes(ctx.lang) ? ctx.lang : 'uk'
    ) as MemoLang;
    // Запуск ещё идёт — остановить (условие на статус: гонка с итогом шага);
    // уже закончился — только причина.
    const text = ['waiting', 'ui', 'running'].includes(run.status)
      ? await this.markHalted(ctx.accountId, run, at, why, progress, lang, {
          status: run.status,
        })
      : MEMO_TEXT.halted[lang](
          run.memoNumber,
          at + 1,
          MEMO_TEXT.haltWhy[why][lang],
          '',
        );
    return { number: run.memoNumber, text };
  }

  // ── каталог операций сайта ─────────────────────────────────────────────

  private async catalog(
    accountId: string,
    siteId: string,
  ): Promise<Map<string, MemoCatalogOp & ToolOperation>> {
    const rows = await this.db
      .forAccount(accountId)
      .assistAdminOperation.findMany({
        where: { siteId },
        include: {
          connector: { select: { id: true, name: true, status: true } },
        },
      });
    return new Map(
      rows.map((o) => [
        o.id,
        {
          rowId: o.id,
          key: `${o.connector.name}.${o.operationId}`,
          kind: o.kind as OperationKind,
          enabled: o.enabled && o.connector.status === 'active',
          unsupported: o.unsupported,
          params: Array.isArray(o.params)
            ? (o.params as unknown as OperationParam[])
            : [],
          roles: o.roles,
          connectorId: o.connector.id,
          connectorName: o.connector.name,
          operationId: o.operationId,
          method: o.method,
          path: o.path,
          summary: o.summary,
          dailyLimit: o.dailyLimit,
        },
      ]),
    );
  }

  // ── кабинет ────────────────────────────────────────────────────────────

  private async limit(accountId: string): Promise<number> {
    const st = await readState(this.prisma, accountId, new Date());
    return st.planId && ASSIST_PLANS[st.planId].adminActions
      ? ADMIN_MEMO_LIMITS.perSitePro
      : 0;
  }

  private async memoRow(
    accountId: string,
    siteId: string,
    n: number,
  ): Promise<MemoRow> {
    const r = await this.db.forAccount(accountId).assistAdminMemo.findFirst({
      where: { siteId, number: n, status: { not: 'removed' } },
    });
    if (!r) throw adminError(404, 'MEMO_NOT_FOUND', 'Мемо не найдено');
    return r;
  }

  private async memoLog(
    m: AccountMembership,
    siteId: string,
    memo: { number: number; id: string },
    outcome: string,
    details: Record<string, unknown> = {},
  ) {
    await this.log.append({
      accountId: m.accountId,
      siteId,
      actor: `tg:${m.telegramId.toString()}`,
      actorRole: 'owner',
      channel: 'tma',
      conversationId: null,
      connectorId: null,
      operationRowId: null,
      operation: `memo:АМ-${memo.number}`,
      kind: 'memo',
      outcome,
      httpStatus: null,
      durationMs: null,
      requestMasked: { memo: memo.id, ...details } as Prisma.InputJsonValue,
      responseBytes: null,
      error: null,
    });
  }

  private item(
    r: MemoRow,
    runs: ReadonlyArray<Parameters<typeof adminMemoStats>[0][number]>,
  ): AdminMemoListItem {
    const d = parseAdminMemo(r.draft).content;
    return {
      number: r.number,
      key: r.key,
      name: adminMemoName(d, 'uk'),
      status: r.status,
      publishedVersion: r.publishedVersion,
      draftRevision: r.draftRevision,
      updatedAt: r.updatedAt.toISOString(),
      reviewReason:
        r.status === 'needs_review' && r.reviewReason
          ? (r.reviewReason as unknown as AdminMemoReviewReason)
          : null,
      stats: adminMemoStats(runs, ADMIN_MEMO_STATS_DAYS.list),
    };
  }

  /** Запуски мемо сайта за окно (без значений слотов — их не читаем). */
  private async runFacts(
    accountId: string,
    siteId: string,
    since: Date,
    memoId?: string,
  ) {
    return this.db.forAccount(accountId).assistAdminMemoRun.findMany({
      where: {
        siteId,
        createdAt: { gte: since },
        ...(memoId ? { memoId } : {}),
      },
      select: RUN_FACT,
      orderBy: { createdAt: 'asc' },
      take: 20_000,
    });
  }

  async list(m: AccountMembership, siteId: string) {
    await this.mode.requireSite(m.accountId, siteId);
    const rows = await this.db
      .forAccount(m.accountId)
      .assistAdminMemo.findMany({
        where: { siteId, status: { not: 'removed' } },
        orderBy: { number: 'asc' },
      });
    const runs = rows.length
      ? await this.runFacts(
          m.accountId,
          siteId,
          new Date(Date.now() - ADMIN_MEMO_STATS_DAYS.list * DAY_MS),
        )
      : [];
    return {
      limit: await this.limit(m.accountId),
      used: rows.length,
      memos: rows.map((r) =>
        this.item(
          r,
          runs.filter((x) => x.memoId === r.id),
        ),
      ),
    };
  }

  /** Статистика мемо (§5-бис.17 п.13): 30 дней и 7 дней опубликованной версии. */
  async stats(m: AccountMembership, siteId: string, n: number) {
    await this.mode.requireSite(m.accountId, siteId);
    const r = await this.memoRow(m.accountId, siteId, n);
    const now = Date.now();
    const runs = await this.runFacts(
      m.accountId,
      siteId,
      new Date(now - ADMIN_MEMO_STATS_DAYS.list * DAY_MS),
      r.id,
    );
    const since7 = now - ADMIN_MEMO_STATS_DAYS.review * DAY_MS;
    return {
      number: r.number,
      status: r.status,
      reviewReason: this.item(r, []).reviewReason,
      stats: adminMemoStats(runs, ADMIN_MEMO_STATS_DAYS.list),
      stats7: adminMemoStats(
        runs.filter(
          (x) =>
            x.createdAt.getTime() >= since7 &&
            x.memoVersion === r.publishedVersion,
        ),
        ADMIN_MEMO_STATS_DAYS.review,
      ),
    };
  }

  async get(
    m: AccountMembership,
    siteId: string,
    n: number,
  ): Promise<AdminMemoView> {
    await this.mode.requireSite(m.accountId, siteId);
    const r = await this.memoRow(m.accountId, siteId, n);
    const versions = await this.db
      .forAccount(m.accountId)
      .assistAdminMemoVersion.findMany({
        where: { memoId: r.id },
        orderBy: { number: 'desc' },
        take: MEMO_LIMITS.versionsKept,
      });
    const now = Date.now();
    const runs = await this.runFacts(
      m.accountId,
      siteId,
      new Date(now - ADMIN_MEMO_STATS_DAYS.list * DAY_MS),
      r.id,
    );
    const since7 = now - ADMIN_MEMO_STATS_DAYS.review * DAY_MS;
    return {
      ...this.item(r, runs),
      stats7: adminMemoStats(
        runs.filter(
          (x) =>
            x.createdAt.getTime() >= since7 &&
            x.memoVersion === r.publishedVersion,
        ),
        ADMIN_MEMO_STATS_DAYS.review,
      ),
      draft: parseAdminMemo(r.draft).content,
      versions: versions.map((v) => ({
        number: v.number,
        status: v.status,
        gateReport: (v.gateReport as unknown as AdminMemoGateReport) ?? null,
        checkReport:
          v.checkReport &&
          (v.checkReport as { kind?: unknown }).kind === 'memo-check'
            ? (v.checkReport as unknown as AdminMemoCheckReport)
            : null,
        createdAt: v.createdAt.toISOString(),
        publishedAt: v.publishedAt?.toISOString() ?? null,
        rollbackOf: v.rollbackOf,
      })),
    };
  }

  private invalid(issues: Array<{ path: string; code: string }>) {
    const click = issues.find((i) => i.code === 'click_forbidden');
    return adminError(
      422,
      'MEMO_INVALID',
      click
        ? `Шаг-клик в мемо «Админки» не сохраняется (${click.path}): серверные действия — только шагом api (операция коннектора)`
        : `Мемо не прошло проверку: ${issues
            .slice(0, 5)
            .map((i) => `${i.path} ${i.code}`)
            .join('; ')}`,
    );
  }

  async create(
    m: AccountMembership,
    siteId: string,
    body: { key?: string; draft?: unknown },
  ): Promise<AdminMemoView> {
    await this.mode.requireSite(m.accountId, siteId);
    const limit = await this.limit(m.accountId);
    const db = this.db.forAccount(m.accountId);
    if (limit === 0) {
      throw adminError(
        402,
        'ADMIN_ACTIONS_PLAN',
        'Мемо «Админки» — в тарифе Pro',
      );
    }
    const overLimit = () =>
      adminError(
        409,
        'MEMO_LIMIT',
        `Мемо «Админки» — не больше ${limit} на сайт`,
      );
    const parsed = parseAdminMemo(body.draft ?? emptyAdminMemo());
    if (parsed.issues.length) throw this.invalid(parsed.issues);
    const name = adminMemoName(parsed.content, 'uk');
    let key = (body.key ?? suggestMemoKey(name || 'memo')).toLowerCase();
    if (!MEMO_LIMITS.keyRe.test(key)) {
      throw adminError(
        422,
        'MEMO_INVALID',
        'Ключ — латиница, цифры и дефис, 2–40 символов',
      );
    }
    await this.mode.ensureSettings(m.accountId, siteId);
    const actor = `tg:${m.telegramId.toString()}`;
    const row = await db.$transaction(async (tx) => {
      const taken = await tx.assistAdminMemo.findFirst({
        where: { siteId, key },
      });
      if (taken) {
        if (body.key) throw adminError(409, 'MEMO_CONFLICT', 'Ключ уже занят');
        key = `${key.slice(0, 33)}-${Date.now().toString(36).slice(-6)}`;
      }
      // UPDATE счётчика блокирует строку настроек сайта до конца
      // транзакции: лимит считаем ПОСЛЕ него — параллельные создания не
      // проходят сверх лимита (аудит Э6-бис (е) (4)); отказ откатывает и
      // счётчик.
      const s = await tx.assistAdminSettings.update({
        where: { siteId },
        data: { memoCounter: { increment: 1 } },
        select: { memoCounter: true },
      });
      const used = await tx.assistAdminMemo.count({
        where: { siteId, status: { not: 'removed' } },
      });
      if (used >= limit) throw overLimit();
      return tx.assistAdminMemo.create({
        data: {
          accountId: m.accountId,
          siteId,
          number: s.memoCounter,
          key,
          draft: parsed.content as unknown as Prisma.InputJsonValue,
          createdBy: actor,
          updatedBy: actor,
        },
      });
    });
    await this.memoLog(m, siteId, row, 'create', { key });
    return this.get(m, siteId, row.number);
  }

  async patchDraft(
    m: AccountMembership,
    siteId: string,
    n: number,
    body: { expectedRevision: number; draft: unknown; key?: string },
  ): Promise<AdminMemoView> {
    await this.mode.requireSite(m.accountId, siteId);
    const r = await this.memoRow(m.accountId, siteId, n);
    const parsed = parseAdminMemo(body.draft);
    if (parsed.issues.length) throw this.invalid(parsed.issues);
    const data: Prisma.AssistAdminMemoUpdateManyMutationInput = {
      draft: parsed.content as unknown as Prisma.InputJsonValue,
      draftRevision: { increment: 1 },
      updatedBy: `tg:${m.telegramId.toString()}`,
    };
    if (body.key !== undefined && body.key !== r.key) {
      if (r.publishedVersion !== null) {
        throw adminError(
          422,
          'MEMO_INVALID',
          'Ключ не меняется после первой публикации',
        );
      }
      if (!MEMO_LIMITS.keyRe.test(body.key)) {
        throw adminError(
          422,
          'MEMO_INVALID',
          'Ключ — латиница, цифры и дефис, 2–40 символов',
        );
      }
      data.key = body.key;
    }
    const done = await this.db
      .forAccount(m.accountId)
      .assistAdminMemo.updateMany({
        where: { id: r.id, draftRevision: body.expectedRevision },
        data,
      });
    if (done.count === 0) {
      throw adminError(
        409,
        'MEMO_REVISION',
        'Мемо изменили в другой вкладке — обновите',
      );
    }
    await this.memoLog(m, siteId, r, 'draft', {
      revision: body.expectedRevision + 1,
      steps: parsed.content.steps.length,
    });
    return this.get(m, siteId, n);
  }

  /** Собрать версию: ворота кода + проверка по живому каталогу (§5-бис.17 п.7). */
  async buildVersion(
    m: AccountMembership,
    siteId: string,
    n: number,
    opts: { rollbackOf?: number } = {},
  ) {
    await this.mode.requireSite(m.accountId, siteId);
    const r = await this.memoRow(m.accountId, siteId, n);
    const db = this.db.forAccount(m.accountId);
    let source: unknown = r.draft;
    if (opts.rollbackOf !== undefined) {
      const v = await db.assistAdminMemoVersion.findFirst({
        where: { memoId: r.id, number: opts.rollbackOf },
      });
      if (!v) throw adminError(404, 'MEMO_NOT_FOUND', 'Версия не найдена');
      source = v.content;
    }
    const parsed = parseAdminMemo(source);
    if (parsed.issues.length) throw this.invalid(parsed.issues);
    const catalog = await this.catalog(m.accountId, siteId);
    const content = markPii(parsed.content, catalog);
    const gate = adminMemoGates(content, catalog);
    const last = await db.assistAdminMemoVersion.findFirst({
      where: { memoId: r.id },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    const number = (last?.number ?? 0) + 1;
    const status = gate.result === 'pass' ? 'checking' : 'held';
    const hash = contentHash(content);
    // Сухой прогон (§5-бис.17 п.7, аудит 06.10): новая версия — без отчёта,
    // публикация ждёт прогона в браузере владельца. Правка только имён/фраз/
    // цели у РАБОТАЮЩЕГО мемо — отчёт опубликованной версии переносится;
    // «требует проверки» и выключенное выходят только новым прогоном.
    let checkReport: AdminMemoCheckReport | null = null;
    if (
      status === 'checking' &&
      r.status === 'published' &&
      r.publishedVersion !== null
    ) {
      const pub = await db.assistAdminMemoVersion.findFirst({
        where: { memoId: r.id, number: r.publishedVersion },
        select: { content: true, contentHash: true, checkReport: true },
      });
      const prev: unknown = pub?.checkReport;
      if (
        pub &&
        adminMemoCheckUsable(prev, pub.contentHash) &&
        prev.result === 'pass' &&
        adminMemoSameSteps(parseAdminMemo(pub.content).content, content)
      )
        checkReport = {
          ...prev,
          contentHash: hash,
          version: number,
          inherited: r.publishedVersion,
        };
    }
    await db.assistAdminMemoVersion.create({
      data: {
        accountId: m.accountId,
        siteId,
        memoId: r.id,
        number,
        status,
        content: content as unknown as Prisma.InputJsonValue,
        contentHash: hash,
        gateReport: gate as unknown as Prisma.InputJsonValue,
        checkReport: checkReport
          ? (checkReport as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
        rollbackOf: opts.rollbackOf ?? null,
        requestedBy: `tg:${m.telegramId.toString()}`,
      },
    });
    await db.assistAdminMemo.updateMany({
      where: { id: r.id },
      data: {
        status:
          r.publishedVersion === null
            ? status === 'held'
              ? 'held'
              : 'checking'
            : r.status,
      },
    });
    await this.memoLog(m, siteId, r, opts.rollbackOf ? 'rollback' : 'build', {
      version: number,
      result: gate.result,
    });
    return {
      version: number,
      status,
      gateReport: gate,
      checkRequired: status === 'checking' && !checkReport,
    };
  }

  /** Публикация — подтверждение владельца в TMA; фразы — уникальный индекс. */
  async publish(m: AccountMembership, siteId: string, n: number, v: number) {
    await this.mode.requireSite(m.accountId, siteId);
    const r = await this.memoRow(m.accountId, siteId, n);
    const db = this.db.forAccount(m.accountId);
    const ver = await db.assistAdminMemoVersion.findFirst({
      where: { memoId: r.id, number: v },
    });
    if (!ver) throw adminError(404, 'MEMO_NOT_FOUND', 'Версия не найдена');
    if (ver.status !== 'checking') {
      throw adminError(
        409,
        'MEMO_INVALID',
        'Публикуется только версия, прошедшая проверку',
      );
    }
    // Сухой прогон ЭТОЙ версии (тот же хеш содержимого) — pass/partial;
    // нет — отказ с кодом (§5-бис.17 п.7: «публикация только после прогона»).
    if (!adminMemoCheckUsable(ver.checkReport, ver.contentHash)) {
      throw adminError(
        409,
        'MEMO_CHECK_REQUIRED',
        'Опубликовать можно после прогона мемо в админке (кнопка «Прогнать»)',
      );
    }
    const content = parseAdminMemo(ver.content).content;
    const phrases = adminMemoPhrases(content);
    const owner = `memo:${r.id}`;
    try {
      await db.$transaction(async (tx) => {
        await tx.assistAdminPhrase.deleteMany({ where: { siteId, owner } });
        await tx.assistAdminPhrase.createMany({
          data: phrases.map((p) => ({
            siteId,
            accountId: m.accountId,
            lang: p.lang,
            norm: p.norm,
            owner,
            kind: p.kind,
          })),
        });
        await tx.assistAdminMemoVersion.updateMany({
          where: { id: ver.id },
          data: {
            status: 'published',
            publishedBy: `tg:${m.telegramId.toString()}`,
            publishedAt: new Date(),
          },
        });
        await tx.assistAdminMemo.updateMany({
          where: { id: r.id },
          data: {
            status: 'published',
            publishedVersion: v,
            reviewReason: Prisma.DbNull,
          },
        });
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw adminError(
          409,
          'MEMO_CONFLICT',
          'Фраза мемо уже занята другим мемо этого сайта',
        );
      }
      throw e;
    }
    await this.memoLog(m, siteId, r, 'publish', { version: v });
    return this.get(m, siteId, n);
  }

  async setEnabled(
    m: AccountMembership,
    siteId: string,
    n: number,
    on: boolean,
  ) {
    await this.mode.requireSite(m.accountId, siteId);
    const r = await this.memoRow(m.accountId, siteId, n);
    const db = this.db.forAccount(m.accountId);
    if (on && r.publishedVersion === null) {
      throw adminError(409, 'MEMO_INVALID', 'Сначала опубликуйте версию');
    }
    // «Требует проверки» не снимается выключением/включением (аудит 06.10):
    // причина остаётся, выход — новая версия с прогоном и публикацией.
    await db.assistAdminMemo.updateMany({
      where: { id: r.id },
      data: {
        status: on
          ? r.reviewReason !== null
            ? 'needs_review'
            : 'published'
          : 'disabled',
      },
    });
    await this.memoLog(m, siteId, r, on ? 'enable' : 'disable');
    return this.get(m, siteId, n);
  }

  async remove(m: AccountMembership, siteId: string, n: number) {
    await this.mode.requireSite(m.accountId, siteId);
    const r = await this.memoRow(m.accountId, siteId, n);
    const db = this.db.forAccount(m.accountId);
    await db.$transaction(async (tx) => {
      await tx.assistAdminPhrase.deleteMany({
        where: { siteId, owner: `memo:${r.id}` },
      });
      await tx.assistAdminMemo.updateMany({
        where: { id: r.id },
        data: { status: 'removed', removedAt: new Date() },
      });
    });
    await this.memoLog(m, siteId, r, 'remove');
    return { removed: true };
  }

  // ── сухой прогон (§5-бис.17 п.7; аудит 06.10) ──────────────────────────

  /**
   * Версия для прогона: последняя на проверке (`checking`), прошедшая
   * ворота. Нет — 409 `MEMO_GATES` (сначала «Собрать версию»).
   */
  async checkTarget(m: AccountMembership, siteId: string, n: number) {
    await this.mode.requireSite(m.accountId, siteId);
    const r = await this.memoRow(m.accountId, siteId, n);
    const ver = await this.db
      .forAccount(m.accountId)
      .assistAdminMemoVersion.findFirst({
        where: { memoId: r.id, status: 'checking' },
        orderBy: { number: 'desc' },
        select: { id: true, number: true, contentHash: true },
      });
    if (!ver) {
      throw adminError(
        409,
        'MEMO_GATES',
        'Сначала соберите версию, прошедшую ворота',
      );
    }
    return { memoId: r.id, memoNumber: r.number, ...ver };
  }

  /** Версия прогона (только на проверке и с тем же хешем) — или null. */
  async checkVersion(
    accountId: string,
    siteId: string,
    versionId: string,
    hash: string,
  ): Promise<{
    memoId: string;
    memoNumber: number;
    version: number;
    content: AdminMemoContent;
  } | null> {
    const db = this.db.forAccount(accountId);
    const v = await db.assistAdminMemoVersion.findFirst({
      where: { id: versionId, siteId, contentHash: hash, status: 'checking' },
      select: { memoId: true, number: true, content: true },
    });
    if (!v) return null;
    const memo = await db.assistAdminMemo.findFirst({
      where: { id: v.memoId, siteId, status: { not: 'removed' } },
      select: { number: true },
    });
    if (!memo) return null;
    return {
      memoId: v.memoId,
      memoNumber: memo.number,
      version: v.number,
      content: parseAdminMemo(v.content).content,
    };
  }

  /** Шаги `api` прогона — по живому каталогу и роли проверяющего, БЕЗ вызова. */
  async apiChecks(
    accountId: string,
    siteId: string,
    content: AdminMemoContent,
    role: string | null,
  ): Promise<AdminMemoApiCheck[]> {
    if (!content.steps.some((s) => s.action === 'api')) return [];
    return adminMemoApiChecks(
      content,
      await this.catalog(accountId, siteId),
      role,
    );
  }

  /** Фразы мемо, уже занятые ДРУГИМ опубликованным мемо сайта. */
  async phraseConflicts(
    accountId: string,
    siteId: string,
    memoId: string,
    content: AdminMemoContent,
  ): Promise<Array<{ lang: string; phrase: string }>> {
    const phrases = adminMemoPhrases(content);
    if (!phrases.length) return [];
    const taken = await this.db
      .forAccount(accountId)
      .assistAdminPhrase.findMany({
        where: {
          siteId,
          norm: { in: phrases.map((p) => p.norm) },
          owner: { not: `memo:${memoId}` },
        },
        select: { lang: true, norm: true },
      });
    return phrases
      .filter((p) => taken.some((t) => t.lang === p.lang && t.norm === p.norm))
      .map((p) => ({ lang: p.lang, phrase: p.norm }));
  }

  /**
   * Итог прогона → `checkReport` версии (условно: версия всё ещё на
   * проверке и с тем же хешем). `fail` — версия `held` (и мемо, если оно
   * ещё не опубликовано). Журнал — запись `memo` от проверяющего.
   */
  async recordCheck(
    p: {
      accountId: string;
      siteId: string;
      versionId: string;
      actor: string;
      actorRole: string | null;
    },
    report: AdminMemoCheckReport,
  ): Promise<boolean> {
    const db = this.db.forAccount(p.accountId);
    const held = report.result === 'fail';
    const w = await db.assistAdminMemoVersion.updateMany({
      where: {
        id: p.versionId,
        siteId: p.siteId,
        status: 'checking',
        contentHash: report.contentHash,
      },
      data: {
        checkReport: report as unknown as Prisma.InputJsonValue,
        ...(held ? { status: 'held' } : {}),
      },
    });
    if (w.count !== 1) return false;
    const v = await db.assistAdminMemoVersion.findFirstOrThrow({
      where: { id: p.versionId },
      select: { memoId: true },
    });
    const memo = await db.assistAdminMemo.findFirstOrThrow({
      where: { id: v.memoId },
      select: { id: true, number: true, publishedVersion: true },
    });
    if (held && memo.publishedVersion === null)
      await db.assistAdminMemo.updateMany({
        where: { id: memo.id, status: { in: ['draft', 'checking'] } },
        data: { status: 'held' },
      });
    await this.log.append({
      accountId: p.accountId,
      siteId: p.siteId,
      actor: p.actor,
      actorRole: p.actorRole,
      channel: 'embed',
      conversationId: null,
      connectorId: null,
      operationRowId: null,
      operation: `memo:АМ-${memo.number}`,
      kind: 'memo',
      outcome: `check:${report.result}`,
      httpStatus: null,
      durationMs: null,
      requestMasked: {
        memo: memo.id,
        version: report.version,
        test: report.testId,
        pages: report.pages.length,
        failed: report.steps.filter((x) => !x.ok).map((x) => x.i),
      } as Prisma.InputJsonValue,
      responseBytes: null,
      error: null,
    });
    return true;
  }

  private async runFailed(accountId: string, memoId: string): Promise<void> {
    if (!this.onRunFailed) return;
    try {
      await this.onRunFailed(accountId, memoId);
    } catch {
      /* монитор — не повод сломать ход сотрудника */
    }
  }

  // ── исполнение ─────────────────────────────────────────────────────────

  /** «АМ-N не найдено» — тот же ответ для несуществующего и выключенного. */
  unknownText(lang: string, n: number): string {
    const l = (['uk', 'ru', 'en'].includes(lang) ? lang : 'uk') as MemoLang;
    return MEMO_TEXT.unknownMemo[l](n);
  }

  /**
   * Команда сотрудника — мемо? По номеру АМ-N или фразе из индекса; только
   * опубликованное и включённое. null — не мемо (обычный ход).
   */
  async match(
    ctx: ActorCtx,
    text: string,
  ): Promise<
    | null
    | { kind: 'missing'; number: number }
    | { kind: 'memo'; memo: MemoRow; content: AdminMemoContent; rest: string }
  > {
    const db = this.db.forAccount(ctx.accountId);
    let memo: MemoRow | null = null;
    let rest = '';
    const byNum = memoNumberIn(text);
    if (byNum) {
      memo = await db.assistAdminMemo.findFirst({
        where: { siteId: ctx.siteId, number: byNum.number },
      });
      if (
        !memo ||
        memo.status !== 'published' ||
        memo.publishedVersion === null
      ) {
        return { kind: 'missing', number: byNum.number };
      }
      rest = byNum.rest;
    } else {
      const phrases = await db.assistAdminPhrase.findMany({
        where: { siteId: ctx.siteId },
        select: { norm: true, owner: true },
        take: 2000,
      });
      if (!phrases.length) return null;
      const index = new Map(phrases.map((p) => [p.norm, p.owner]));
      const hit = phrasePrefix(text, (n) => index.has(n));
      // Ни номера, ни фразы — lite-выбор моделью (как у «Сайта»).
      if (!hit) return this.liteMatch(ctx, text);
      const owner = index.get(hit.norm)!;
      memo = await db.assistAdminMemo.findFirst({
        where: { siteId: ctx.siteId, id: owner.replace(/^memo:/, '') },
      });
      if (
        !memo ||
        memo.status !== 'published' ||
        memo.publishedVersion === null
      )
        return null;
      rest = hit.rest;
    }
    const ver = await db.assistAdminMemoVersion.findFirst({
      where: { memoId: memo.id, number: memo.publishedVersion! },
    });
    if (!ver) return null;
    return {
      kind: 'memo',
      memo,
      content: parseAdminMemo(ver.content).content,
      rest,
    };
  }

  /**
   * Lite-выбор мемо АМ-N моделью (аудит Э8-хвост (2); ТЗ §5-бис.17 п.5 п.3 —
   * как у «Сайта»): только если команда делит слово с именем/фразой/целью
   * опубликованного мемо; модель видит ТОЛЬКО команду и список мемо блоком
   * данных (`buildMemoChoicePrompt`), отвечает ключом из списка
   * (`parseMemoChoice`); слоты — код (`liteAdminSlotsRest`). Суточный
   * потолок денег «Админки» — до вызова (с оценкой вызова); сбой, отказ,
   * потолок — null (обычный ход). Права на операции — в `start()`, как
   * всегда.
   */
  private async liteMatch(
    ctx: ActorCtx,
    text: string,
    now = new Date(),
  ): Promise<null | {
    kind: 'memo';
    memo: MemoRow;
    content: AdminMemoContent;
    rest: string;
  }> {
    const db = this.db.forAccount(ctx.accountId);
    const memos = await db.assistAdminMemo.findMany({
      where: {
        siteId: ctx.siteId,
        status: 'published',
        publishedVersion: { not: null },
      },
      orderBy: { number: 'asc' },
      take: MEMO_LIMITS.choiceMaxMemos * 3,
    });
    if (!memos.length) return null;
    const vers = await db.assistAdminMemoVersion.findMany({
      where: {
        OR: memos.map((m) => ({ memoId: m.id, number: m.publishedVersion! })),
      },
      select: { memoId: true, content: true },
    });
    const byId = new Map(vers.map((v) => [v.memoId, v.content]));
    const cands = memos
      .map((memo) => ({
        memo,
        key: memo.key,
        content: parseAdminMemo(byId.get(memo.id)).content,
      }))
      .filter((c) => byId.has(c.memo.id) && memoMentioned(text, c.content))
      .slice(0, MEMO_LIMITS.choiceMaxMemos);
    if (!cands.length) return null;
    const lang = (
      ['uk', 'ru', 'en'].includes(ctx.lang) ? ctx.lang : 'uk'
    ) as MemoLang;
    const prompt = buildMemoChoicePrompt({
      transcript: text,
      memos: cands,
      lang,
      actor: 'employee',
    });
    // Потолок «Админки» (тот же расчёт, что у хода чата) — с оценкой вызова.
    const st = await readState(this.prisma, ctx.accountId, now);
    const est = estimateCost(GEMINI_MODEL, {
      inputTokens: Math.max(
        MEMO_LIMITS.choiceReserveInputTokens,
        Math.ceil((prompt.system.length + prompt.user.length) / 2),
      ),
      // Сверху — потолок, который уходит провайдеру (с запасом на мысли).
      outputTokens: geminiOutputCeiling(MEMO_LIMITS.choiceMaxOutputTokens),
    }).costMicroUsd;
    const spent = await adminSpentToday(db, ctx.siteId, now);
    if (spent + est > siteDailyCapFromPlan(st.planId)) return null;
    let out: string;
    try {
      const gen = await this.text.generate({
        system: prompt.system,
        user: prompt.user,
        json: true,
        temperature: 0,
        maxOutputTokens: MEMO_LIMITS.choiceMaxOutputTokens,
        timeoutMs: MEMO_LIMITS.choiceTimeoutMs,
      });
      out = gen.text;
      try {
        await this.usage.record(
          this.db.system(
            'учёт расходов «Админки»: строка site_ai_usage с accountId сайта',
          ),
          {
            accountId: ctx.accountId,
            siteId: ctx.siteId,
            operation: 'assist-admin-memo',
            model: gen.model,
            units: {
              inputTokens: gen.inputTokens,
              outputTokens: gen.outputTokens,
              cachedInputTokens: gen.cachedInputTokens,
            },
          },
        );
      } catch {
        /* учёт — не повод отказать в ходе */
      }
    } catch {
      return null;
    }
    const choice = parseMemoChoice(out, cands);
    if (!choice) return null;
    return {
      kind: 'memo',
      memo: choice.memo.memo,
      content: choice.memo.content,
      rest: liteAdminSlotsRest(
        choice.memo.content.slots,
        text,
        choice.slots,
        now,
      ),
    };
  }

  /**
   * Запустить мемо: права роли на каждую операцию — ДО первого шага
   * (§5-бис.17 п.10: мемо не расширяет права; приёмка Э8 п.7), слоты из
   * текста, затем шаги до первого «Да».
   */
  async start(
    ctx: ActorCtx,
    hit: { memo: MemoRow; content: AdminMemoContent; rest: string },
    now = new Date(),
    /** Э6-бис (б): запуск со страницы (голосовое управление) — шаги `ui` можно. */
    page = false,
  ): Promise<{
    text: string;
    proposal: ProposalView | null;
    ui?: { runId: string; from: number; to: number } | null;
  }> {
    const lang = ctx.lang as MemoLang;
    const n = hit.memo.number;
    const catalog = await this.catalog(ctx.accountId, ctx.siteId);
    for (const s of hit.content.steps) {
      if (s.action !== 'api') continue;
      const op = catalog.get(s.op);
      const allowed =
        !!op &&
        op.enabled &&
        !op.unsupported &&
        ctx.assistRole !== null &&
        (ctx.assistRole === '*' || op.roles.includes(ctx.assistRole));
      if (!allowed)
        return { text: MEMO_TEXT.forbidden[lang](n), proposal: null };
    }
    const { values, missing } = fillAdminSlots(
      hit.content.slots,
      hit.rest,
      now,
    );
    if (missing.length) {
      return {
        text: MEMO_TEXT.missing[lang](n, missing.join(', ')),
        proposal: null,
      };
    }
    const run = await this.db
      .forAccount(ctx.accountId)
      .assistAdminMemoRun.create({
        data: {
          accountId: ctx.accountId,
          siteId: ctx.siteId,
          memoId: hit.memo.id,
          memoNumber: n,
          memoVersion: hit.memo.publishedVersion!,
          conversationId: ctx.conversationId,
          actor: ctx.actor,
          channel: ctx.channel,
          slots: values as Prisma.InputJsonValue,
          expiresAt: new Date(now.getTime() + ACTION_LIMITS.memoRunTtlMs),
        },
      });
    const head = MEMO_TEXT.started[lang](n, adminMemoName(hit.content, lang));
    const r = await this.advance(ctx, run.id, hit.content, 0, now, page);
    return {
      text: `${head}\n\n${r.text}`,
      proposal: r.proposal,
      ui: r.ui ? { runId: run.id, ...r.ui } : null,
    };
  }

  /** Исполнять шаги с `from` до первого write/danger (предложение) или конца. */
  private async advance(
    ctx: ActorCtx,
    runId: string,
    content: AdminMemoContent,
    from: number,
    now: Date,
    page = false,
  ): Promise<{
    text: string;
    proposal: ProposalView | null;
    ui?: { from: number; to: number } | null;
  }> {
    const db = this.db.forAccount(ctx.accountId);
    const lang = ctx.lang as MemoLang;
    const run = await db.assistAdminMemoRun.findFirstOrThrow({
      where: { id: runId },
    });
    const slots = (run.slots ?? {}) as Record<string, string>;
    const progress = Array.isArray(run.progress)
      ? (run.progress as Array<{
          i: number;
          operation: string;
          outcome: string;
        }>)
      : [];
    const catalog = await this.catalog(ctx.accountId, ctx.siteId);
    const lines: string[] = [];
    const total = content.steps.length;
    const stop = async (i: number, goal: 'not_reached' | 'unknown') => {
      await db.assistAdminMemoRun.updateMany({
        where: { id: runId },
        data: {
          status: 'failed',
          step: i,
          goalStatus: goal,
          slots: Prisma.DbNull,
          progress: progress as unknown as Prisma.InputJsonValue,
        },
      });
      const done = progress
        .filter((p) => p.outcome === 'ok' || p.outcome === 'done')
        .map((p) => p.operation)
        .join(', ');
      lines.push(MEMO_TEXT.stopped[lang](run.memoNumber, i + 1, done));
      await this.runFailed(ctx.accountId, run.memoId);
      return { text: lines.join('\n'), proposal: null };
    };
    for (let i = from; i < total; i++) {
      // D3 (§5-бис.17 п.5 п.8): статус мемо — перед КАЖДЫМ шагом. Ушло в
      // «требует проверки», выключено или удалено посреди запуска —
      // следующий шаг не исполняется, запуск остановлен с причиной.
      const why = await this.memoHalt(ctx.accountId, run.memoId);
      if (why) {
        lines.push(
          await this.markHalted(ctx.accountId, run, i, why, progress, lang),
        );
        return { text: lines.filter(Boolean).join('\n'), proposal: null };
      }
      const s = content.steps[i];
      if (s.action === 'say') {
        lines.push(s.say[lang] ?? s.say.uk ?? s.say.ru ?? s.say.en ?? '');
        continue;
      }
      if (s.action === 'ui') {
        // Э6-бис (б): шаги на странице — отрезком подряд; исполняет план
        // голосового управления в виджете (те же проверки кода). Без
        // страницы (TMA, чат без голосового управления) — честный стоп.
        if (!page) {
          lines.push(MEMO_TEXT.uiNeedsPage[lang](run.memoNumber));
          // Не сбой мемо — канал без страницы (монитор такие не считает).
          progress.push({ i, operation: 'ui', outcome: 'needs_page' });
          return stop(i, 'not_reached');
        }
        let to = i;
        while (to < total && content.steps[to].action === 'ui') to++;
        await db.assistAdminMemoRun.updateMany({
          where: { id: runId },
          data: {
            status: 'ui',
            step: i,
            progress: progress as unknown as Prisma.InputJsonValue,
          },
        });
        lines.push(MEMO_TEXT.uiNext[lang](i + 1, total));
        return {
          text: lines.filter(Boolean).join('\n'),
          proposal: null,
          ui: { from: i, to },
        };
      }
      const op = catalog.get(s.op);
      const allowed =
        !!op &&
        op.enabled &&
        ctx.assistRole !== null &&
        (ctx.assistRole === '*' || op.roles.includes(ctx.assistRole));
      if (!op || !allowed) {
        lines.push(MEMO_TEXT.forbidden[lang](run.memoNumber));
        return stop(i, 'not_reached');
      }
      const args = stepArgs(s, slots);
      if (op.kind === 'read') {
        const r = await this.connectors.runRead(ctx, op, args, now);
        progress.push({ i, operation: op.key, outcome: r.outcome });
        if (r.outcome !== 'ok') {
          lines.push(`${op.key}: ${MEMO_TEXT.readFailed[lang]}`);
          return stop(i, 'not_reached');
        }
        continue;
      }
      const actionOp = (
        await this.proposals.catalog(ctx.accountId, ctx.siteId, ctx.assistRole)
      ).find((a) => a.rowId === op.rowId);
      if (!actionOp) {
        lines.push(MEMO_TEXT.forbidden[lang](run.memoNumber));
        return stop(i, 'not_reached');
      }
      const p = await this.proposals.propose(
        ctx,
        actionOp,
        args,
        '',
        {
          requested: true,
          memoRunId: runId,
          memoStep: i,
        },
        now,
      );
      if (!p.ok) {
        lines.push(p.text);
        return stop(i, 'not_reached');
      }
      await db.assistAdminMemoRun.updateMany({
        where: { id: runId },
        data: {
          status: 'waiting',
          step: i,
          progress: progress as unknown as Prisma.InputJsonValue,
        },
      });
      lines.push(MEMO_TEXT.step[lang](i + 1, total), p.text);
      return { text: lines.filter(Boolean).join('\n'), proposal: p.proposal };
    }
    await db.assistAdminMemoRun.updateMany({
      where: { id: runId },
      data: {
        status: 'done',
        step: total,
        goalStatus: 'reached',
        slots: Prisma.DbNull,
        progress: progress as unknown as Prisma.InputJsonValue,
      },
    });
    const goal = content.goal.text[lang] ?? content.goal.text.uk ?? '';
    lines.push(MEMO_TEXT.done[lang](run.memoNumber, goal));
    return { text: lines.filter(Boolean).join('\n'), proposal: null };
  }

  /** Итог шага write/danger (подписка ProposalsService.onSettled). */
  async afterStep(
    ctx: ActorCtx,
    runId: string,
    step: number,
    status: 'done' | 'failed' | 'unknown' | 'rejected' | 'expired',
    now = new Date(),
  ): Promise<{ next: ProposalView | null; text: string | null }> {
    const db = this.db.forAccount(ctx.accountId);
    const run = await db.assistAdminMemoRun.findFirst({
      where: { id: runId, siteId: ctx.siteId, actor: ctx.actor },
    });
    if (!run || run.status !== 'waiting' || run.step !== step) {
      return { next: null, text: null };
    }
    const ver = await db.assistAdminMemoVersion.findFirst({
      where: { memoId: run.memoId, number: run.memoVersion },
    });
    if (!ver) return { next: null, text: null };
    const content = parseAdminMemo(ver.content).content;
    const progress = Array.isArray(run.progress)
      ? (run.progress as Array<{
          i: number;
          operation: string;
          outcome: string;
        }>)
      : [];
    const s = content.steps[step];
    progress.push({
      i: step,
      operation: s && s.action === 'api' ? s.opKey : '',
      outcome: status,
    });
    await db.assistAdminMemoRun.updateMany({
      where: { id: runId },
      data: {
        progress: progress as unknown as Prisma.InputJsonValue,
        status: 'running',
      },
    });
    if (status !== 'done') {
      const done = progress
        .filter((p) => p.outcome === 'ok' || p.outcome === 'done')
        .map((p) => p.operation)
        .join(', ');
      await db.assistAdminMemoRun.updateMany({
        where: { id: runId },
        data: {
          status: status === 'rejected' ? 'stopped' : 'failed',
          goalStatus: status === 'unknown' ? 'unknown' : 'not_reached',
          slots: Prisma.DbNull,
        },
      });
      if (status !== 'rejected')
        await this.runFailed(ctx.accountId, run.memoId);
      return {
        next: null,
        text: MEMO_TEXT.stopped[ctx.lang as MemoLang](
          run.memoNumber,
          step + 1,
          done,
        ),
      };
    }
    if (run.expiresAt.getTime() <= now.getTime()) {
      await db.assistAdminMemoRun.updateMany({
        where: { id: runId },
        data: {
          status: 'expired',
          slots: Prisma.DbNull,
          goalStatus: 'not_reached',
        },
      });
      return { next: null, text: null };
    }
    const r = await this.advance(
      ctx,
      runId,
      content,
      step + 1,
      now,
      ctx.channel === 'embed',
    );
    return { next: r.proposal, text: r.text };
  }

  // ── Э6-бис (б): шаги на странице ───────────────────────────────────────

  /** Запуск этого сотрудника, ждущий шагов на странице (статус `ui`). */
  async pendingUi(ctx: ActorCtx, now = new Date()): Promise<string | null> {
    const run = await this.db
      .forAccount(ctx.accountId)
      .assistAdminMemoRun.findFirst({
        where: {
          siteId: ctx.siteId,
          actor: ctx.actor,
          status: 'ui',
          expiresAt: { gt: now },
        },
        orderBy: { updatedAt: 'desc' },
        select: { id: true },
      });
    return run?.id ?? null;
  }

  /**
   * Отрезок шагов `ui`, который ждёт запуск ЭТОГО сотрудника: версия
   * закреплена в запуске; права роли перепроверены в `start`.
   */
  async uiSegment(
    ctx: ActorCtx,
    runId: string,
    now = new Date(),
  ): Promise<MemoUiSegment | null> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) return null;
    const db = this.db.forAccount(ctx.accountId);
    const run = await db.assistAdminMemoRun.findFirst({
      where: { id: runId, siteId: ctx.siteId, actor: ctx.actor },
    });
    if (!run || run.status !== 'ui' || run.expiresAt.getTime() <= now.getTime())
      return null;
    // D3: отрезок шагов на странице не отдаётся мемо, которое уже не рабочее.
    if (await this.memoHalt(ctx.accountId, run.memoId)) return null;
    const ver = await db.assistAdminMemoVersion.findFirst({
      where: { memoId: run.memoId, number: run.memoVersion },
    });
    if (!ver) return null;
    const content = parseAdminMemo(ver.content).content;
    let to = run.step;
    while (to < content.steps.length && content.steps[to].action === 'ui') to++;
    const steps = content.steps
      .slice(run.step, to)
      .filter((x): x is AdminMemoUiStep => x.action === 'ui');
    if (!steps.length) return null;
    return {
      runId: run.id,
      memoNumber: run.memoNumber,
      name: adminMemoName(content, ctx.lang as MemoLang),
      from: run.step,
      to,
      steps,
      slots: (run.slots ?? {}) as Record<string, string>,
    };
  }

  /**
   * Итог отрезка шагов на странице (план голосового управления закончился):
   * `done` — запуск продолжается со следующего шага (предложение API,
   * следующий отрезок или «выполнено»); иначе — стоп с перечнем сделанного.
   */
  async afterUi(
    ctx: ActorCtx,
    runId: string,
    from: number,
    to: number,
    status: 'done' | 'failed' | 'stopped',
    now = new Date(),
    /**
     * Где именно отрезок не прошёл (монитор: сбой на шаге, `pin_mismatch` —
     * цель на странице не сошлась с сохранённой). Нет — весь отрезок.
     */
    fail?: { at: number; pin: boolean } | null,
  ): Promise<{
    text: string | null;
    proposal: ProposalView | null;
    nextUi: boolean;
  }> {
    const db = this.db.forAccount(ctx.accountId);
    const run = await db.assistAdminMemoRun.findFirst({
      where: { id: runId, siteId: ctx.siteId, actor: ctx.actor },
    });
    if (!run || run.status !== 'ui' || run.step !== from)
      return { text: null, proposal: null, nextUi: false };
    const ver = await db.assistAdminMemoVersion.findFirst({
      where: { memoId: run.memoId, number: run.memoVersion },
    });
    if (!ver) return { text: null, proposal: null, nextUi: false };
    const content = parseAdminMemo(ver.content).content;
    const progress = Array.isArray(run.progress)
      ? (run.progress as Array<{
          i: number;
          operation: string;
          outcome: string;
        }>)
      : [];
    const at =
      status === 'failed' && fail && fail.at >= from && fail.at < to
        ? fail.at
        : null;
    for (let i = from; i < (at ?? to); i++)
      progress.push({
        i,
        operation: 'ui',
        outcome: status === 'done' || at !== null ? 'done' : status,
      });
    if (at !== null)
      progress.push({
        i: at,
        operation: 'ui',
        outcome: fail!.pin ? 'pin_mismatch' : 'failed',
      });
    if (status !== 'done' || run.expiresAt.getTime() <= now.getTime()) {
      await db.assistAdminMemoRun.updateMany({
        where: { id: runId, status: 'ui' },
        data: {
          status: status === 'stopped' ? 'stopped' : 'failed',
          ...(at !== null ? { step: at } : {}),
          goalStatus: 'not_reached',
          slots: Prisma.DbNull,
          progress: progress as unknown as Prisma.InputJsonValue,
        },
      });
      if (status === 'failed') await this.runFailed(ctx.accountId, run.memoId);
      const done = progress
        .filter((p) => p.outcome === 'ok' || p.outcome === 'done')
        .map((p) => p.operation)
        .join(', ');
      return {
        text: MEMO_TEXT.stopped[ctx.lang as MemoLang](
          run.memoNumber,
          from + 1,
          done,
        ),
        proposal: null,
        nextUi: false,
      };
    }
    const moved = await db.assistAdminMemoRun.updateMany({
      where: { id: runId, status: 'ui', step: from },
      data: {
        status: 'running',
        progress: progress as unknown as Prisma.InputJsonValue,
      },
    });
    if (moved.count !== 1) return { text: null, proposal: null, nextUi: false };
    const r = await this.advance(ctx, runId, content, to, now, true);
    return { text: r.text, proposal: r.proposal, nextUi: !!r.ui };
  }
}
