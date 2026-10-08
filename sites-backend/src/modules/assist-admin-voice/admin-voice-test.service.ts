/**
 * Мастер проверки голосового управления «Админки» Т-2 — сторона сотрудника
 * (Э6-бис (б), ТЗ §5-бис.13 «Т-2 для Админки», §5-бис.10 п.15; Р-Э6б-8).
 * Зовут маршруты `/assist-admin/v1/voice-test/*` ПОСЛЕ сессии сотрудника:
 *
 *  - `exchange` — одноразовая ссылка из TMA (`?v4c_voicetest=`, 30 мин,
 *    хеш в базе, условный UPDATE — один обмен) → тест привязан к ЭТОЙ
 *    сессии сотрудника `wa.` (и её `sub`) до конца мастера;
 *  - `analyze` — по снимку: команды сухого прогона и безопасного прогона,
 *    «запреты без звука» «Админки» (удаление, отмена, возврат, списание,
 *    массовое, оплата, пароль, чужая ссылка) через ТЕ ЖЕ проверки, что живой
 *    план, + куда ушла бы команда (предложение API), список «никогда» и
 *    распознанные кнопки «удалить/отменить/возврат»;
 *  - `attempt` — регистратор загрузчика: попытка исполнить шаг на цели
 *    класса «никогда» (даже отсечённая проверкой) — в счётчик теста;
 *  - `report` — вердикт считает КОД (`wizardVerdict` + «Админка»: попыток
 *    > 0 — `fail`, на рабочем хосте — ни одной отправки), прогоны — по
 *    планам ЭТОГО теста в базе; отчёт — один раз, в `assist_admin_voice_tests`
 *    и строкой `ui-test` в append-only журнале действий (виден только с
 *    `assistAdmin`, К-9).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../prisma/sites-db.service';
import type { ResolvedAdminSession } from '../assist-admin-chat/admin-session.service';
import { ProposalsService } from '../assist-admin-actions/proposals.service';
import { AdminActionLogService } from '../assist-admin-mode/action-log.service';
import { onSiteHost } from '../assist-ui-core/plan-checks';
import {
  maskLabel,
  parseSnapshot,
  snapshotTooLarge,
} from '../assist-ui-core/snapshot';
import type { UiSnapshot } from '../assist-ui-core/types';
import {
  neverList,
  parseSuspicious,
  suggestCommands,
  WIZARD_LIMITS,
  wizardVerdict,
  type ForbiddenProbeResult,
  type MicPolicy,
  type MicStatus,
  type WizardLang,
} from '../assist-ui-core/wizard';
import { failPlan } from './admin-voice-errors';
import {
  adminDangerButtons,
  adminForbiddenProbes,
  adminMarkupFragment,
  type ApiCatalogOp,
} from './admin-voice-rules';
import { sha256Hex } from './admin-voice-settings.service';
import {
  AdminMemoCheckService,
  memoCheckMark,
  type AdminMemoCheckSessionView,
} from './admin-memo-check.service';
import { AdminUiPlanService, type AdminVcCtx } from './admin-ui-plan.service';
import type { AdminVoiceReport } from './api-types';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MIC: readonly MicStatus[] = [
  'ok',
  'denied_policy',
  'denied_user',
  'no_device',
  'ios_gesture',
  'skipped',
];
const POLICY: readonly MicPolicy[] = ['allowed', 'denied', 'unknown'];

const int = (v: unknown, max: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : 0;
const langOf = (v: unknown): WizardLang =>
  v === 'ru' || v === 'en' ? v : 'uk';
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

@Injectable()
export class AdminVoiceTestService {
  private readonly logger = new Logger(AdminVoiceTestService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly plans: AdminUiPlanService,
    private readonly proposals: ProposalsService,
    private readonly log: AdminActionLogService,
    private readonly memoCheck: AdminMemoCheckService,
  ) {}

  private db(accountId: string) {
    return this.sitesDb.forAccount(accountId);
  }

  /**
   * Живой тест ЭТОЙ сессии (не сдан, не истёк) — или null. Ссылка прогона
   * мемо (аудит 06.10) — не тестовая сессия голосового управления: план,
   * разбор и отчёт мастера ею не открываются (только `memo-page/report`).
   */
  async live(
    s: ResolvedAdminSession,
    testId: unknown,
  ): Promise<{ testId: string; testHost: boolean; host: string } | null> {
    if (typeof testId !== 'string' || !ID_RE.test(testId)) return null;
    const t = await this.db(s.accountId).assistAdminVoiceTest.findFirst({
      where: {
        id: testId,
        siteId: s.siteId,
        sessionId: s.sessionId,
        actor: s.employeeRef,
        reportedAt: null,
        sessionExpiresAt: { gt: this.now() },
      },
      select: { id: true, testHost: true, host: true, report: true },
    });
    return t && !memoCheckMark(t.report)
      ? { testId: t.id, testHost: t.testHost, host: t.host }
      : null;
  }

  async exchange(
    s: ResolvedAdminSession,
    body: { token?: unknown; lang?: unknown } | null,
  ): Promise<{
    testId: string;
    testHost: boolean;
    host: string;
    expiresAt: string;
    /** Ссылка прогона мемо «Админки»: карточка мемо вместо шагов мастера. */
    memo?: AdminMemoCheckSessionView;
  }> {
    const token = body?.token;
    if (typeof token !== 'string' || !TOKEN_RE.test(token))
      return failPlan('not_found');
    const now = this.now();
    const expiresAt = new Date(now.getTime() + WIZARD_LIMITS.sessionTtlMs);
    const db = this.db(s.accountId);
    // Одноразово и только для ЭТОГО сайта: условный UPDATE по хешу.
    const r = await db.assistAdminVoiceTest.updateMany({
      where: {
        tokenHash: sha256Hex(token),
        siteId: s.siteId,
        usedAt: null,
        tokenExpiresAt: { gt: now },
      },
      data: {
        usedAt: now,
        sessionId: s.sessionId,
        actor: s.employeeRef,
        sessionExpiresAt: expiresAt,
      },
    });
    if (r.count !== 1) return failPlan('not_found');
    const t = await db.assistAdminVoiceTest.findFirstOrThrow({
      where: { tokenHash: sha256Hex(token) },
      select: { id: true, testHost: true, host: true },
    });
    // Прогон мемо: голосовое управление не нужно (шаги не исполняются).
    const memo = await this.memoCheck.session(s, t.id, body?.lang);
    if (memo) {
      this.logger.log(`admin memo-check session site=${s.siteId} test=${t.id}`);
      return {
        testId: t.id,
        testHost: t.testHost,
        host: t.host,
        expiresAt: expiresAt.toISOString(),
        memo,
      };
    }
    const a = await this.plans.access(s, true, now);
    if (!a.mode) return failPlan('off');
    this.logger.log(`admin voice-test session site=${s.siteId} test=${t.id}`);
    // Отметка в журнале действий: мастер начат этим сотрудником.
    await this.log.append(
      {
        accountId: s.accountId,
        siteId: s.siteId,
        actor: s.employeeRef,
        actorRole: s.customerRole,
        channel: 'embed',
        conversationId: null,
        connectorId: null,
        operationRowId: null,
        operation: 'ui.test',
        kind: 'ui-test',
        outcome: 'started',
        httpStatus: null,
        durationMs: null,
        requestMasked: { test: t.id, host: t.host, testHost: t.testHost },
        responseBytes: null,
        error: null,
      },
      now,
    );
    return {
      testId: t.id,
      testHost: t.testHost,
      host: t.host,
      expiresAt: expiresAt.toISOString(),
    };
  }

  private async mine(ctx: AdminVcCtx, tid: string) {
    if (!ctx.test || ctx.test.testId !== tid) return failPlan('not_found');
    const a = await this.plans.access(ctx.session, true, this.now());
    if (!a.mode || !a.rules) return failPlan('off');
    // Снимки мастера — только с хоста его ссылки (не любого хоста админки).
    return {
      rules: a.rules,
      hosts: a.hosts,
      snapHosts: a.hosts.filter((h) => h === ctx.test!.host),
    };
  }

  private snapshotOf(raw: unknown, hosts: string[]): UiSnapshot {
    if (snapshotTooLarge(raw)) return failPlan('too_large');
    const s = parseSnapshot(raw);
    if (!s || !onSiteHost(s.url, hosts)) return failPlan('bad_request');
    return s;
  }

  private async catalog(s: ResolvedAdminSession): Promise<ApiCatalogOp[]> {
    return (await this.proposals.catalog(s.accountId, s.siteId, s.role)).map(
      (o) => ({
        rowId: o.rowId,
        key: o.key,
        operationId: o.operationId,
        summary: o.summary,
        kind: o.kind,
      }),
    );
  }

  async analyze(
    ctx: AdminVcCtx,
    tid: string,
    body: { snapshot?: unknown; lang?: unknown } | null,
  ) {
    const { rules, hosts, snapHosts } = await this.mine(ctx, tid);
    const snapshot = this.snapshotOf(body?.snapshot, snapHosts);
    const lang = langOf(body?.lang);
    return {
      commands: suggestCommands({ snapshot, rules, hosts, lang }),
      forbidden: adminForbiddenProbes({
        snapshot,
        rules,
        hosts,
        lang,
        catalog: await this.catalog(ctx.session),
        onHost: (h) => onSiteHost(h, hosts),
      }),
      never: neverList({ snapshot, rules, hosts }),
      dangerButtons: adminDangerButtons(snapshot),
    };
  }

  /** Регистратор загрузчика: попытки по целям «никогда» и заглушённые отправки. */
  async attempt(
    ctx: AdminVcCtx,
    tid: string,
    body: { kind?: unknown; n?: unknown; text?: unknown } | null,
  ): Promise<{ attempts: number }> {
    await this.mine(ctx, tid);
    const s = ctx.session;
    const kind = body?.kind === 'submit' ? 'submit' : 'never';
    const n = Math.max(1, int(body?.n, 50));
    if (kind === 'never')
      await this.db(s.accountId).assistAdminVoiceTest.updateMany({
        where: { id: tid, reportedAt: null },
        data: { attempts: { increment: n } },
      });
    await this.log.append(
      {
        accountId: s.accountId,
        siteId: s.siteId,
        actor: s.employeeRef,
        actorRole: s.customerRole,
        channel: 'embed',
        conversationId: null,
        connectorId: null,
        operationRowId: null,
        operation: 'ui.test',
        kind: 'ui-test',
        outcome: kind === 'submit' ? 'submit_blocked' : 'attempt',
        httpStatus: null,
        durationMs: null,
        requestMasked: {
          test: tid,
          n,
          target:
            typeof body?.text === 'string'
              ? maskLabel(body.text).slice(0, 80)
              : null,
        },
        responseBytes: null,
        error: null,
      },
      this.now(),
    );
    const t = await this.db(s.accountId).assistAdminVoiceTest.findFirst({
      where: { id: tid },
      select: { attempts: true },
    });
    return { attempts: t?.attempts ?? 0 };
  }

  async report(
    ctx: AdminVcCtx,
    tid: string,
    body: Record<string, unknown> | null,
  ): Promise<{
    testId: string;
    result: string;
    validUntil: string;
    report: AdminVoiceReport;
  }> {
    if (JSON.stringify(body ?? {}).length > WIZARD_LIMITS.bodyChars)
      return failPlan('bad_request');
    const { rules, hosts, snapHosts } = await this.mine(ctx, tid);
    const s = ctx.session;
    const snapshot = this.snapshotOf(body?.snapshot, snapHosts);
    const lang = langOf(body?.lang);
    const now = this.now();
    const env = obj(body?.env);
    const mic: MicStatus = (MIC as readonly unknown[]).includes(body?.mic)
      ? (body?.mic as MicStatus)
      : 'skipped';
    const markup = obj(body?.markup);
    const suspicious = parseSuspicious(body?.suspicious);
    const keys = new Set(suspicious.map((x) => x.key));
    const reviewed: Record<string, 'deny' | 'safe'> = {};
    for (const [k, v] of Object.entries(obj(body?.reviewed)))
      if (keys.has(k) && (v === 'deny' || v === 'safe')) reviewed[k] = v;
    const submitsBlocked = int(body?.submitsBlocked, 1000);

    // Прогоны — по планам ЭТОГО теста в базе (не по словам страницы).
    const rows = await this.plans.testPlans(s.accountId, tid);
    const okBy = new Map<string, number>();
    for (const d of (Array.isArray(body?.dry) ? body.dry : []).slice(0, 10)) {
      const o = obj(d);
      if (typeof o.planId === 'string') okBy.set(o.planId, int(o.ok, 15));
    }
    type St = { state?: string; risk?: string; undo?: string; kind?: string };
    const stepsOf = (raw: Prisma.JsonValue) =>
      (Array.isArray(raw) ? raw : []).filter(
        (x) => !!x && typeof x === 'object',
      ) as St[];
    const exec = (raw: Prisma.JsonValue) =>
      stepsOf(raw).filter((x) => x.risk === 'auto' || x.risk === 'confirm');
    const isSave = (raw: Prisma.JsonValue) =>
      exec(raw).some((x) => x.undo === 'irrev');
    const doneOf = (r: (typeof rows)[number]) => {
      const ex = exec(r.steps);
      return (
        r.status === 'done' &&
        ex.length > 0 &&
        ex.every((x) => x.state === 'done') &&
        !stepsOf(r.steps).some((x) =>
          ['manual', 'failed'].includes(String(x.state)),
        )
      );
    };
    const dry = rows
      .filter((r) => r.dryRun)
      .slice(-WIZARD_LIMITS.dryCommands)
      .map((r) => {
        const steps = exec(r.steps).length;
        return {
          planId: r.id,
          command: r.utteranceMasked.slice(0, 120),
          steps,
          ok: Math.min(okBy.get(r.id) ?? 0, steps),
        };
      });
    const live = rows.filter((r) => !r.dryRun);
    const safe = live
      .filter((r) => !isSave(r.steps))
      .slice(-WIZARD_LIMITS.safeCommands)
      .map((r) => ({
        planId: r.id,
        command: r.utteranceMasked.slice(0, 120),
        status: r.status,
        done: doneOf(r),
      }));
    const saveRow = ctx.test?.testHost
      ? [...live].reverse().find((r) => isSave(r.steps))
      : undefined;
    const save = saveRow
      ? {
          planId: saveRow.id,
          done: doneOf(saveRow),
          fields: exec(saveRow.steps).filter((x) =>
            ['fill', 'select', 'check'].includes(String(x.kind)),
          ).length,
        }
      : null;
    // Отправка на РАБОЧЕМ хосте — дефект (сервер её в план не пускает).
    const submitOnWork =
      !ctx.test?.testHost && live.some((r) => isSave(r.steps) && doneOf(r));
    const forbidden = adminForbiddenProbes({
      snapshot,
      rules,
      hosts,
      lang,
      catalog: await this.catalog(s),
      onHost: (h) => onSiteHost(h, hosts),
    });
    const t = await this.db(s.accountId).assistAdminVoiceTest.findFirst({
      where: { id: tid },
      select: { attempts: true, host: true, testHost: true },
    });
    const attempts = t?.attempts ?? 0;
    const verdict = wizardVerdict({
      env: {
        widget: env.widget === true,
        chunks: env.chunks === true,
        csp: int(env.csp, 1000),
        tt: int(env.tt, 1000),
        micPolicy: (POLICY as readonly unknown[]).includes(env.micPolicy)
          ? (env.micPolicy as MicPolicy)
          : 'unknown',
        release: null,
      },
      mic,
      markup: {
        total: int(markup.total, 10_000),
        withId: int(markup.withId, 10_000),
        unnamed: [],
        closedShadow: int(markup.closedShadow, 1000),
        extIframes: int(markup.extIframes, 1000),
        duplicates: [],
        denied: int(markup.denied, 1000),
      },
      suspicious,
      reviewed,
      dry,
      safe,
      // Пробы «Админки» шире 5 видов «Сайта»: вердикт смотрит на `blocked`.
      forbidden: forbidden as unknown as ForbiddenProbeResult[],
    });
    let result = verdict.result;
    const items = [...verdict.items];
    if (attempts > 0 || submitOnWork) {
      result = 'fail';
      items.push({
        step: 6,
        level: 'fail',
        code: 'forbidden_leak',
        data: { attempts, submitOnWork: submitOnWork ? 1 : 0 },
      });
    }
    let page = '/';
    try {
      page = new URL(snapshot.url).pathname;
    } catch {
      /* разобран выше */
    }
    const dangerButtons = adminDangerButtons(snapshot);
    const report: AdminVoiceReport = {
      v: 1,
      lang,
      host: t?.host ?? '',
      page,
      testHost: ctx.test?.testHost ?? false,
      result,
      items,
      attempts,
      submitsBlocked,
      forbidden,
      dangerButtons,
      dry,
      safe,
      save,
      suspicious: suspicious.map((x) => ({
        key: x.key,
        why: x.why,
        label: x.label,
        selector: x.selector,
      })),
      reviewed,
      // Фрагмент разметки для разработчика (аудит Э6-бис (б) (1)).
      fragment: adminMarkupFragment({
        suspicious,
        reviewed,
        dangerButtons,
        lang,
      }),
    };
    const validUntil = new Date(now.getTime() + WIZARD_LIMITS.validMs);
    const w = await this.db(s.accountId).assistAdminVoiceTest.updateMany({
      where: { id: tid, sessionId: s.sessionId, reportedAt: null },
      data: {
        report: report as unknown as Prisma.InputJsonValue,
        result,
        validUntil,
        reportedAt: now,
        sessionExpiresAt: now,
      },
    });
    if (w.count !== 1) return failPlan('conflict');
    await this.log.append(
      {
        accountId: s.accountId,
        siteId: s.siteId,
        actor: s.employeeRef,
        actorRole: s.customerRole,
        channel: 'embed',
        conversationId: null,
        connectorId: null,
        operationRowId: null,
        operation: 'ui.test',
        kind: 'ui-test',
        outcome: result,
        httpStatus: null,
        durationMs: null,
        requestMasked: {
          test: tid,
          host: report.host,
          testHost: report.testHost,
          attempts,
          submitsBlocked,
          forbidden: forbidden.map((f) => ({
            kind: f.kind,
            blocked: f.blocked,
            api: f.api,
          })),
          dry: dry.length,
          safe: safe.length,
          save: save ? save.done : null,
        },
        responseBytes: null,
        error: null,
      },
      now,
    );
    this.logger.log(
      `admin voice-test report site=${s.siteId} test=${tid} result=${result}`,
    );
    return {
      testId: tid,
      result,
      validUntil: validUntil.toISOString(),
      report,
    };
  }
}
