/**
 * Кабинет: голосовое управление «Админкой» (Э6-бис (б), ТЗ §5-бис.2,
 * §5-бис.8, §5-бис.11, §5-бис.13–14; решения Р-Э6б-1, Р-Э6б-8). Экран —
 * вкладка «Голос» раздела «Помощник сотрудников» TMA
 * (`assist/src/screens/admin/AdminVoiceSection.tsx`). Только
 * `assistAdmin: owner` (гвард контроллера; менеджер и оператор «Сайта»,
 * сотрудник «Админки» — 403, К-9).
 *
 *  - GET  — переключатель `off | test | on | degraded`, правила, принятая
 *    редакция рисков, хосты админки (и какие «тестовые»), последний отчёт
 *    мастера и годен ли он для `on`, метрики 24 ч;
 *  - PATCH — `off` всегда и сразу; из `off` — только тариф Pro, режим
 *    «Админка» со встраиванием (verified-хост админки), голос платформы,
 *    экран рисков ТЕКУЩЕЙ редакции и ВВОД НАЗВАНИЯ САЙТА; `on` — только с
 *    годным отчётом мастера «Админки» (pass ≤ 30 дней; partial — с
 *    подтверждением; новее последнего автоматического понижения), иначе 409
 *    `ADMIN_VC_TEST_REQUIRED`. Смена состояния — условная (гонка с
 *    монитором), каждая — запись `voice-control` в append-only журнале
 *    действий (кто, когда, версия рисков — «журнал кабинета» §5-бис.2);
 *  - POST …/test-token — одноразовая ссылка мастера на verified-хост
 *    админки (`?v4c_voicetest=`, 30 мин, в базе — хеш); «тестовый» —
 *    только по отметке владельца в настройках, не по ссылке (Р-Э6б-8);
 *  - GET …/tests, …/tests/:tid — отчёты мастера.
 */
import { randomBytes, createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WIDGET_VOICE_TEST_PARAM } from '../../brand';
import { readVoiceControlPlatform } from '../../common/voice-control-platform';
import {
  voicePlatformEnabled,
  voiceProviderConfigured,
} from '../../config/voice-env';
import { SitesDb } from '../../prisma/sites-db.service';
import { AdminActionLogService } from '../assist-admin-mode/action-log.service';
import { AdminModeService } from '../assist-admin-mode/admin-mode.service';
import { reportUsable, WIZARD_LIMITS } from '../assist-ui-core/wizard';
import type { WizardResult } from '../assist-ui-core/wizard';
import type { VoiceControlState } from '../assist-ui-core/types';
import type { AccountMembership } from '../site-core/account/roles';
import { evaluateHostAccess } from '../site-core/ownership/host-access';
import { adminVoiceError } from './admin-voice-errors';
import {
  ADMIN_VC_RISKS_VERSION,
  adminRulesOf,
  adminStateOf,
  defaultAdminRules,
  parseAdminRules,
} from './admin-voice-rules';
import type {
  AdminVoiceHostView,
  AdminVoiceMetrics,
  AdminVoiceSettingsPatch,
  AdminVoiceSettingsView,
  AdminVoiceTestDetail,
  AdminVoiceTestSummary,
  AdminVoiceTestTokenView,
  AdminVoiceReport,
} from './api-types';

const STATES: readonly VoiceControlState[] = ['off', 'test', 'on', 'degraded'];
const RESULTS: readonly WizardResult[] = ['pass', 'partial', 'fail'];
const DAY = 24 * 60 * 60_000;

/** Путь страницы админки для ссылки мастера (как `startPath` обхода, аудит Э7). */
const START_PATH_RE = /^\/(?![/\\])[A-Za-z0-9\-._~%!$&'()*+,;=:@/]{0,300}$/;

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Название сайта при включении: без регистра и лишних пробелов. */
export function siteNameMatches(want: string, said: unknown): boolean {
  if (typeof said !== 'string') return false;
  const n = (s: string) =>
    s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return !!n(want) && n(want) === n(said);
}

/** Рубильник голосового управления платформы (env) — как у «Сайта». */
export function adminVcPlatformEnv(env: NodeJS.ProcessEnv): boolean {
  return env.ASSIST_VOICE_CONTROL_ENABLED?.trim().toLowerCase() !== 'false';
}

interface TestRow {
  id: string;
  host: string;
  testHost: boolean;
  createdAt: Date;
  reportedAt: Date | null;
  result: string | null;
  validUntil: Date | null;
  release: string | null;
  attempts: number;
  partialAckAt: Date | null;
  report?: Prisma.JsonValue;
}

const TEST_SELECT = {
  id: true,
  host: true,
  testHost: true,
  createdAt: true,
  reportedAt: true,
  result: true,
  validUntil: true,
  release: true,
  attempts: true,
  partialAckAt: true,
} as const;

@Injectable()
export class AdminVoiceSettingsService {
  private readonly logger = new Logger(AdminVoiceSettingsService.name);
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly mode: AdminModeService,
    private readonly log: AdminActionLogService,
  ) {}

  private db(accountId: string) {
    return this.sitesDb.forAccount(accountId);
  }

  /** Голос платформы для «Админки»: env-рубильники и провайдер. */
  voiceAvailable(): boolean {
    return voicePlatformEnabled(this.env) && voiceProviderConfigured(this.env);
  }

  async platformOn(now = this.now()): Promise<boolean> {
    if (!adminVcPlatformEnv(this.env)) return false;
    const p = await readVoiceControlPlatform(
      this.sitesDb.system(
        'голосовое управление: рубильник платформы — настройка без кабинета',
      ),
      now.getTime(),
    );
    return p.enabled;
  }

  /** Хосты САМОЙ админки (adminHostIds) с отметкой «тестовый». */
  async adminHosts(
    accountId: string,
    siteId: string,
    settings: {
      adminHostIds: string[];
      voiceControlAdminTestHostIds: string[];
    },
    now = this.now(),
  ): Promise<Array<AdminVoiceHostView & { origin: string; scheme: string }>> {
    if (!settings.adminHostIds.length) return [];
    const rows = await this.db(accountId).siteHost.findMany({
      where: { siteId, id: { in: settings.adminHostIds } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((h) => ({
      id: h.id,
      host: h.host,
      verified: evaluateHostAccess(h, 'assist-admin', now).ok,
      test: settings.voiceControlAdminTestHostIds.includes(h.id),
      scheme: h.scheme,
      origin: `${h.scheme}://${h.host}`,
    }));
  }

  /** Последнее автоматическое понижение (монитор/нарушение) — из журнала. */
  async downgradedAt(accountId: string, siteId: string): Promise<Date | null> {
    const row = await this.db(accountId).assistAdminActionLog.findFirst({
      where: {
        siteId,
        kind: 'voice-control',
        outcome: { in: ['auto:degraded', 'auto:off'] },
      },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      select: { at: true },
    });
    return row?.at ?? null;
  }

  private async latestReported(
    accountId: string,
    siteId: string,
  ): Promise<TestRow | null> {
    return this.db(accountId).assistAdminVoiceTest.findFirst({
      where: { siteId, reportedAt: { not: null } },
      orderBy: { reportedAt: 'desc' },
      select: TEST_SELECT,
    });
  }

  private async problemOf(
    accountId: string,
    siteId: string,
    t: TestRow | null,
  ): Promise<string | null> {
    return reportUsable({
      report: t
        ? {
            result: t.result,
            reportedAt: t.reportedAt,
            validUntil: t.validUntil,
            // «Админка» не канареится (`admin-act.js` всегда из /v1/).
            release: null,
            partialAck: !!t.partialAckAt,
          }
        : null,
      now: this.now(),
      currentRelease: null,
      markupChangedAt: null,
      stateChangedAt: await this.downgradedAt(accountId, siteId),
      needNewerThanState: true,
    });
  }

  private async summary(
    accountId: string,
    siteId: string,
    t: TestRow,
  ): Promise<AdminVoiceTestSummary> {
    const result = (RESULTS as readonly unknown[]).includes(t.result)
      ? (t.result as WizardResult)
      : null;
    return {
      id: t.id,
      host: t.host,
      testHost: t.testHost,
      createdAt: t.createdAt.toISOString(),
      reportedAt: t.reportedAt?.toISOString() ?? null,
      result,
      validUntil: t.validUntil?.toISOString() ?? null,
      attempts: t.attempts,
      problem: t.reportedAt
        ? await this.problemOf(accountId, siteId, t)
        : 'none',
      partialAck: !!t.partialAckAt,
    };
  }

  async metrics(
    accountId: string,
    siteId: string,
    now = this.now(),
  ): Promise<AdminVoiceMetrics> {
    const since = new Date(now.getTime() - DAY);
    const plans = await this.db(accountId).assistAdminUiPlan.findMany({
      where: { siteId, createdAt: { gte: since }, voiceTestId: null },
      select: { status: true, steps: true },
      take: 5000,
    });
    const m: AdminVoiceMetrics = {
      plans: plans.length,
      done: 0,
      manual: 0,
      failed: 0,
      stopped: 0,
      violations: 0,
      expectMisses: 0,
    };
    for (const p of plans) {
      if (p.status === 'done') m.done++;
      if (p.status === 'failed') m.failed++;
      if (p.status === 'stopped') m.stopped++;
      const steps = Array.isArray(p.steps)
        ? (p.steps as Array<{ state?: string }>)
        : [];
      if (steps.some((s) => s && s.state === 'manual')) m.manual++;
    }
    const logs = await this.db(accountId).assistAdminActionLog.groupBy({
      by: ['outcome', 'error'],
      where: { siteId, kind: 'ui-step', at: { gte: since } },
      _count: { _all: true },
    });
    for (const l of logs) {
      if (l.outcome === 'violation') m.violations += l._count._all;
      if (l.outcome === 'failed' && l.error === 'expect')
        m.expectMisses += l._count._all;
    }
    return m;
  }

  async get(
    m: AccountMembership,
    siteId: string,
  ): Promise<AdminVoiceSettingsView> {
    const site = await this.mode.requireSite(m.accountId, siteId);
    const s = await this.mode.ensureSettings(m.accountId, siteId);
    const now = this.now();
    const hosts = await this.adminHosts(m.accountId, siteId, s, now);
    const last = await this.latestReported(m.accountId, siteId);
    return {
      siteId,
      siteName: site.name,
      state: adminStateOf(s.voiceControlAdminState),
      stateAt: s.voiceControlAdminStateAt?.toISOString() ?? null,
      stateBy: s.voiceControlAdminStateBy,
      stateReason: s.voiceControlAdminStateReason,
      rules: adminRulesOf(s.voiceControlAdminRules) ?? defaultAdminRules(),
      risksVersion: ADMIN_VC_RISKS_VERSION,
      risksAccepted: s.voiceControlAdminRisksVersion === ADMIN_VC_RISKS_VERSION,
      enabledBy: s.voiceControlAdminEnabledBy,
      planAllows: await this.mode.planAllowsActions(m.accountId, now),
      adminModeOk:
        s.adminModeEnabled &&
        (s.adminAccess === 'script' || s.adminAccess === 'both') &&
        hosts.some((h) => h.verified),
      voiceAvailable: this.voiceAvailable(),
      platformOn: await this.platformOn(now),
      hosts: hosts.map(({ id, host, verified, test }) => ({
        id,
        host,
        verified,
        test,
      })),
      report: last ? await this.summary(m.accountId, siteId, last) : null,
      onProblem: await this.problemOf(m.accountId, siteId, last),
      metrics: await this.metrics(m.accountId, siteId, now),
    };
  }

  /** Условия выхода из `off` (кроме рисков и отчёта). */
  private async assertCanEnable(
    m: AccountMembership,
    siteId: string,
    s: Awaited<ReturnType<AdminModeService['ensureSettings']>>,
  ): Promise<void> {
    if (!(await this.mode.planAllowsActions(m.accountId, this.now()))) {
      throw adminVoiceError(
        402,
        'ADMIN_VC_PLAN_REQUIRED',
        'Голосовое управление админкой — в тарифе Pro',
      );
    }
    const hosts = await this.adminHosts(m.accountId, siteId, s);
    if (
      !s.adminModeEnabled ||
      (s.adminAccess !== 'script' && s.adminAccess !== 'both') ||
      !hosts.some((h) => h.verified)
    ) {
      throw adminVoiceError(
        409,
        'ADMIN_VC_MODE_REQUIRED',
        'Сначала включите помощника сотрудников со скриптом в админке (подтверждённый хост админки)',
      );
    }
    if (!this.voiceAvailable() || !(await this.platformOn())) {
      throw adminVoiceError(
        409,
        'ADMIN_VC_VOICE_REQUIRED',
        'Голос на платформе сейчас недоступен',
      );
    }
  }

  async save(
    m: AccountMembership,
    siteId: string,
    body: AdminVoiceSettingsPatch | null | undefined,
  ): Promise<AdminVoiceSettingsView> {
    const site = await this.mode.requireSite(m.accountId, siteId);
    const s = await this.mode.ensureSettings(m.accountId, siteId);
    const db = this.db(m.accountId);
    const now = this.now();
    const prev = adminStateOf(s.voiceControlAdminState);
    const state =
      body?.state === undefined ? prev : (body.state as VoiceControlState);
    if (!(STATES as readonly unknown[]).includes(state)) {
      throw adminVoiceError(
        400,
        'ADMIN_VC_INVALID',
        'Состояние голосового управления — off, test, on или degraded',
        { errors: [{ path: 'state', code: 'enum' }] },
      );
    }
    const data: Prisma.AssistAdminSettingsUpdateManyMutationInput = {};
    if (body && body.rules !== undefined) {
      const p = parseAdminRules(body.rules);
      if (!p.ok) {
        throw adminVoiceError(
          400,
          'ADMIN_VC_INVALID',
          'Правила голосового управления не прошли проверку',
          { errors: p.errors },
        );
      }
      data.voiceControlAdminRules = p.rules as unknown as Prisma.InputJsonValue;
    }
    if (body?.testHostIds !== undefined) {
      const ids = Array.isArray(body.testHostIds) ? body.testHostIds : null;
      const hosts = await this.adminHosts(m.accountId, siteId, s, now);
      if (
        !ids ||
        ids.length > 20 ||
        ids.some(
          (id) => typeof id !== 'string' || !hosts.some((h) => h.id === id),
        )
      ) {
        throw adminVoiceError(
          400,
          'ADMIN_VC_INVALID',
          'Тестовым можно отметить только хост самой админки',
          { errors: [{ path: 'testHostIds', code: 'host' }] },
        );
      }
      data.voiceControlAdminTestHostIds = [...new Set(ids)];
    }
    // Экран рисков: принять текущую редакцию можно и без смены состояния
    // (перед мастером). Включение — с вводом названия сайта.
    const risksNow = body?.risksVersion === ADMIN_VC_RISKS_VERSION;
    if (
      risksNow &&
      s.voiceControlAdminRisksVersion !== ADMIN_VC_RISKS_VERSION
    ) {
      if (!siteNameMatches(site.name, body?.siteName)) {
        throw adminVoiceError(
          400,
          'ADMIN_VC_SITE_NAME',
          'Введите название сайта, чтобы подтвердить, что риски прочитаны',
        );
      }
      data.voiceControlAdminRisksVersion = ADMIN_VC_RISKS_VERSION;
      data.voiceControlAdminRisksAt = now;
      data.voiceControlAdminEnabledBy = `tg:${m.telegramId}`;
    }
    const changed = state !== prev;
    let testId: string | null = null;
    if (changed) {
      if (prev === 'off' && state !== 'off') {
        await this.assertCanEnable(m, siteId, s);
        if (!risksNow || !siteNameMatches(site.name, body?.siteName)) {
          throw adminVoiceError(
            400,
            'ADMIN_VC_RISKS_REQUIRED',
            'Перед включением прочитайте риски и введите название сайта',
          );
        }
        data.voiceControlAdminRisksVersion = ADMIN_VC_RISKS_VERSION;
        data.voiceControlAdminRisksAt = now;
        data.voiceControlAdminEnabledBy = `tg:${m.telegramId}`;
      }
      if (state === 'degraded' && prev !== 'on' && prev !== 'test') {
        throw adminVoiceError(
          409,
          'ADMIN_VC_INVALID',
          'Режим подсказки включается из «Увімкнено» или «Тест»',
        );
      }
      if (state === 'on') {
        let t = await this.latestReported(m.accountId, siteId);
        if (
          t &&
          t.result === 'partial' &&
          body?.partialAck === true &&
          !t.partialAckAt
        ) {
          await db.assistAdminVoiceTest.updateMany({
            where: { id: t.id, partialAckAt: null },
            data: { partialAckBy: `tg:${m.telegramId}`, partialAckAt: now },
          });
          t = { ...t, partialAckAt: now };
        }
        const problem = await this.problemOf(m.accountId, siteId, t);
        if (problem || !t) {
          throw adminVoiceError(
            409,
            'ADMIN_VC_TEST_REQUIRED',
            'Включить для сотрудников можно после проверки голосового управления в админке',
            { errors: [{ path: 'test', code: problem ?? 'none' }] },
          );
        }
        testId = t.id;
      }
      data.voiceControlAdminState = state;
      data.voiceControlAdminTestId = state === 'on' ? testId : null;
      data.voiceControlAdminStateAt = now;
      data.voiceControlAdminStateBy = 'owner';
      data.voiceControlAdminStateReason = null;
      // Условно — «от того, что видели» (монитор мог понизить между чтением и
      // записью: `on` старым отчётом его не затрёт).
      const r = await db.assistAdminSettings.updateMany({
        where: {
          siteId,
          voiceControlAdminState: s.voiceControlAdminState,
          voiceControlAdminStateAt: s.voiceControlAdminStateAt,
        },
        data,
      });
      if (r.count !== 1) {
        throw adminVoiceError(
          409,
          'ADMIN_VC_TEST_REQUIRED',
          'Состояние голосового управления только что изменилось — обновите экран',
          { errors: [{ path: 'test', code: 'older_than_state' }] },
        );
      }
    } else if (Object.keys(data).length) {
      await db.assistAdminSettings.updateMany({ where: { siteId }, data });
    }
    if (changed || data.voiceControlAdminRisksVersion) {
      // «Журнал кабинета» (§5-бис.2): кто, когда, какую редакцию рисков.
      await this.log.append(
        {
          accountId: m.accountId,
          siteId,
          actor: `tg:${m.telegramId}`,
          actorRole: 'owner',
          channel: 'tma',
          conversationId: null,
          connectorId: null,
          operationRowId: null,
          operation: 'voice-control.state',
          kind: 'voice-control',
          outcome: changed ? `${prev}->${state}` : 'risks',
          httpStatus: null,
          durationMs: null,
          requestMasked: {
            risksVersion: data.voiceControlAdminRisksVersion ?? null,
            testId,
            rules: body?.rules !== undefined,
          },
          responseBytes: null,
          error: null,
        },
        now,
      );
    }
    this.logger.log(
      `admin voice-control site=${siteId} ${prev}->${state} member=${m.memberId}`,
    );
    return this.get(m, siteId);
  }

  // ── мастер Т-2 «Админки» ────────────────────────────────────────────────

  async testToken(
    m: AccountMembership,
    siteId: string,
    body: { hostId?: unknown; path?: unknown } | null | undefined,
  ): Promise<AdminVoiceTestTokenView> {
    await this.mode.requireSite(m.accountId, siteId);
    const s = await this.mode.ensureSettings(m.accountId, siteId);
    await this.assertCanEnable(m, siteId, s);
    if (s.voiceControlAdminRisksVersion !== ADMIN_VC_RISKS_VERSION) {
      throw adminVoiceError(
        400,
        'ADMIN_VC_RISKS_REQUIRED',
        'Перед проверкой прочитайте риски и введите название сайта',
      );
    }
    const now = this.now();
    const hosts = (await this.adminHosts(m.accountId, siteId, s, now)).filter(
      (h) => h.verified && h.scheme === 'https',
    );
    const want = typeof body?.hostId === 'string' ? body.hostId : null;
    const h = want ? hosts.find((x) => x.id === want) : hosts[0];
    if (!h) {
      throw adminVoiceError(
        409,
        'ADMIN_VC_HOST_REQUIRED',
        'Проверка — только на подтверждённом адресе самой админки',
      );
    }
    let path = '/';
    if (body?.path !== undefined && body.path !== null && body.path !== '') {
      if (typeof body.path !== 'string' || !START_PATH_RE.test(body.path)) {
        throw adminVoiceError(
          400,
          'ADMIN_VC_INVALID',
          'Путь страницы админки — от корня, без «//» и параметров',
          { errors: [{ path: 'path', code: 'format' }] },
        );
      }
      path = body.path;
    }
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(now.getTime() + WIZARD_LIMITS.tokenTtlMs);
    const t = await this.db(m.accountId).assistAdminVoiceTest.create({
      data: {
        accountId: m.accountId,
        siteId,
        hostId: h.id,
        host: h.host,
        origin: h.origin,
        testHost: h.test,
        startedBy: `tg:${m.telegramId}`,
        tokenHash: sha256Hex(token),
        tokenExpiresAt: expiresAt,
      },
      select: { id: true },
    });
    this.logger.log(`admin voice-test token site=${siteId} test=${t.id}`);
    return {
      testId: t.id,
      url: `${h.origin}${path}?${WIDGET_VOICE_TEST_PARAM}=${encodeURIComponent(token)}`,
      expiresAt: expiresAt.toISOString(),
      testHost: h.test,
    };
  }

  async tests(
    m: AccountMembership,
    siteId: string,
  ): Promise<{ items: AdminVoiceTestSummary[] }> {
    await this.mode.requireSite(m.accountId, siteId);
    const list = await this.db(m.accountId).assistAdminVoiceTest.findMany({
      where: { siteId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: TEST_SELECT,
    });
    const items: AdminVoiceTestSummary[] = [];
    for (const t of list)
      items.push(await this.summary(m.accountId, siteId, t));
    return { items };
  }

  async test(
    m: AccountMembership,
    siteId: string,
    tid: string,
  ): Promise<AdminVoiceTestDetail> {
    await this.mode.requireSite(m.accountId, siteId);
    const t = /^[A-Za-z0-9_-]{1,64}$/.test(tid)
      ? await this.db(m.accountId).assistAdminVoiceTest.findFirst({
          where: { id: tid, siteId },
          select: { ...TEST_SELECT, report: true },
        })
      : null;
    if (!t) {
      throw adminVoiceError(404, 'ADMIN_VC_TEST_NOT_FOUND', 'Отчёт не найден');
    }
    return {
      ...(await this.summary(m.accountId, siteId, t)),
      report: (t.report ?? null) as AdminVoiceReport | null,
    };
  }
}
