/**
 * Кабинет: голосовое управление «Сайтом» (Э6-бис (а)+(г), ТЗ §5-бис.2,
 * §5-бис.8, §5-бис.11, §5-бис.13–14; решения владельца 03.10.2026 п.1–2).
 * Экран — раздел «Голосове керування» рядом с разделом «Голос»
 * (assist/src/screens/widget/VoiceControlSection.tsx).
 *
 *  - GET  — переключатель `off | test | on | degraded`, правила, можно ли
 *    включать, почему режим сейчас не работает, версия текста рисков; (г) кто/
 *    когда/почему сменил состояние, переходный период, последний отчёт мастера
 *    Т-2 (годен ли для `on`), суточный потолок планов, монитор Т-4 за 24 ч;
 *  - PATCH — `off` можно всегда и сразу (выключение безопасно). Из `off` —
 *    в `test`/`on`/`degraded` только с голосом сайта (тариф Business+, ключ,
 *    микрофон владельцем) и после экрана рисков ТЕКУЩЕЙ версии. (г) `on` —
 *    только при годном отчёте мастера (решение владельца п.1: `pass`, не
 *    старше 30 дней, тот же выпуск загрузчика, разметка проверенных страниц
 *    не менялась; `partial` — с подтверждением «понимаю…», §5-бис.13), иначе
 *    409 `VOICE_CONTROL_TEST_REQUIRED` с причиной; выход из `degraded` и из
 *    `off` по нарушению — только отчётом НОВЕЕ этой смены. Без отчёта
 *    доступен `test` (только тестовая сессия мастера по ссылке);
 *  - POST …/test-token — одноразовая ссылка мастера на подтверждённый хост
 *    (`?v4c_voicetest=`, 30 мин; в базе — хеш);
 *  - GET …/tests, …/tests/:tid — отчёты мастера.
 *
 * Основная роль (SitesDb.forAccount — кабинет владельца); права —
 * контроллер (владелец или менеджер помощника, как голос).
 */
import {
  AUTOTEST_KIND,
  AUTOTEST_LIST_MAX,
} from '../system/voice-monitor-autotest';
import { randomBytes } from 'crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WIDGET_VOICE_TEST_PARAM } from '../../../brand';
import {
  readVoiceControlPlatform,
  readWidgetRelease,
  releaseForSite,
} from '../../../common/voice-control-platform';
import {
  voicePlatformEnabled,
  voiceProviderConfigured,
} from '../../../config/voice-env';
import { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import { assistPlanAllows } from '../../assist-billing/plans';
import { readState } from '../../assist-billing/public/entitlements';
import {
  hostOriginOf,
  loadAssistSite,
} from '../../assist-site-setup/widget-settings.service';
import { voiceAccess } from '../../assist-site-voice/public/voice-access';
import {
  defaultVoiceControlRules,
  parseVoiceControlRules,
  rulesOf,
} from '../../assist-ui-core/rules';
import {
  markupChangedFrom,
  reportUsable,
  WIZARD_LIMITS,
  type ReportProblem,
  type WizardResult,
} from '../../assist-ui-core/wizard';
import type { AccountMembership } from '../../site-core/account/roles';
import { evaluateHostAccess } from '../../site-core/ownership/host-access';
import { PUBLIC_SITE_HOST } from '../../site-core/ownership/host-roles';
import { uiMapHost } from '../../site-core/ui-map/ui-map';
import {
  VOICE_CONTROL_RISKS_VERSION,
  type VoiceControlSettingsPatch,
  type VoiceControlSettingsView,
  type VoiceDevLinkView,
  type VoiceTestDetail,
  type VoiceTestSummary,
  type VoiceTestTokenRequest,
  type VoiceTestTokenView,
  type WizardReport,
} from '../api-types';
import { MONITOR_THRESHOLDS } from '../monitor-rules';
import { siteMetrics } from '../system/voice-monitor-store';
import {
  plansPerSitePerDay,
  stateOf,
  voiceControlAccess,
  voiceControlPlatformEnabled,
} from '../voice-control-config';
import { sha256Hex } from '../public/voice-test-store';
import { voiceControlError } from './voice-control-errors';
import {
  DEV_REPORT_KIND,
  DEV_REPORT_LIMITS,
  DEV_REPORT_ORIGIN,
  DEV_REPORT_PATH,
  devReportOf,
} from '../share/dev-report';
import { widgetOrigin } from '../../../config/widget-env';

type SiteRow = Awaited<ReturnType<typeof loadAssistSite>>['row'];

interface TestRow {
  id: string;
  kind: string;
  host: string;
  createdAt: Date;
  reportedAt: Date | null;
  result: string | null;
  validUntil: Date | null;
  release: string | null;
  partialAckAt: Date | null;
  pages: unknown;
  report?: unknown;
}

const TEST_SELECT = {
  id: true,
  kind: true,
  host: true,
  createdAt: true,
  reportedAt: true,
  result: true,
  validUntil: true,
  release: true,
  partialAckAt: true,
  pages: true,
} as const;

const RESULTS: readonly WizardResult[] = ['pass', 'partial', 'fail'];

@Injectable()
export class VoiceControlSettingsService {
  private readonly logger = new Logger(VoiceControlSettingsService.name);
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly prisma: PrismaService,
  ) {}

  private db(m: AccountMembership) {
    return this.sitesDb.forAccount(m.accountId);
  }

  private async voiceOf(m: AccountMembership, row: SiteRow) {
    const state = await readState(this.prisma, m.accountId, this.now());
    return {
      plan: state.planId,
      voice: voiceAccess({
        platformEnabled: voicePlatformEnabled(this.env),
        providerConfigured: voiceProviderConfigured(this.env),
        planId: state.planId,
        siteActive:
          row.enabled && !row.chatPaused && row.operatorBlockedAt === null,
        voiceConfig: row.voiceConfig,
        capOverrideMicroUsd: row.voiceDailyCapMicroUsd,
      }),
    };
  }

  private async platformOn(): Promise<boolean> {
    return (
      voiceControlPlatformEnabled(this.env) &&
      (await readVoiceControlPlatform(this.prisma)).enabled
    );
  }

  /**
   * Когда разметка проверенных страниц изменилась после отчёта — позже
   * всего (заход 9, аудит (г) (6)): ВСЕ страницы отчёта (не только
   * последняя) и не только «устарел» Ш4, но и промахи посетителей по
   * элементам этих страниц после отчёта (`markupChangedFrom`).
   */
  private async markupChangedAt(
    m: AccountMembership,
    siteId: string,
    t: TestRow,
  ): Promise<Date | null> {
    const pages = Array.isArray(t.pages)
      ? (t.pages as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    if (!pages.length || !t.reportedAt) return null;
    const host = uiMapHost(t.host.replace(/:\d+$/, ''));
    const paths = [
      ...new Set(pages.slice(0, 20).map((p) => p.replace(/\/+$/, '') || '/')),
    ];
    const after = { gt: t.reportedAt };
    const db = this.db(m);
    const [elements, misses] = await Promise.all([
      db.siteUiElement.findMany({
        where: {
          siteId,
          host,
          path: { in: paths },
          OR: [{ staleDesktopAt: after }, { staleMobileAt: after }],
        },
        select: { id: true, staleDesktopAt: true, staleMobileAt: true },
        take: 500,
      }),
      db.siteUiElementMiss.findMany({
        where: {
          siteId,
          kind: 'miss',
          createdAt: after,
          element: { host, path: { in: paths } },
        },
        select: { elementRowId: true, visitorId: true, createdAt: true },
        take: 2_000,
      }),
    ]);
    return markupChangedFrom({
      reportedAt: t.reportedAt,
      elements,
      misses,
    });
  }

  private async problemOf(
    m: AccountMembership,
    siteId: string,
    row: SiteRow,
    t: TestRow | null,
  ): Promise<ReportProblem | null> {
    const now = this.now();
    const release = releaseForSite(
      siteId,
      await readWidgetRelease(this.prisma, now.getTime()),
    );
    const downgradedAt = await this.downgradedAt(m, siteId, row);
    return reportUsable({
      report: t
        ? {
            result: t.result,
            reportedAt: t.reportedAt,
            validUntil: t.validUntil,
            release: t.release,
            partialAck: t.partialAckAt !== null,
          }
        : null,
      now,
      currentRelease: release,
      markupChangedAt: t ? await this.markupChangedAt(m, siteId, t) : null,
      stateChangedAt: downgradedAt,
      // Выход из деградации монитора и из выключения по нарушению — только
      // отчётом новее этой смены (§5-бис.11: «выход — новый pass мастера»).
      needNewerThanState: downgradedAt !== null,
    });
  }

  /**
   * Последнее понижение сайта: текущее `degraded`/`off` по нарушению, а
   * также журнал монитора (деградация, выключение) и нарушения запрета в
   * журнале шагов. Аудит (г) 03.10: смотреть только на ТЕКУЩЕЕ состояние
   * мало — `degraded`/`off` → `test` (можно без отчёта) → `on` пускал бы
   * старый отчёт, сданный ДО понижения.
   */
  private async downgradedAt(
    m: AccountMembership,
    siteId: string,
    row: SiteRow,
  ): Promise<Date | null> {
    const state = stateOf(row.voiceControlSiteState);
    const db = this.db(m);
    const [inc, vio] = await Promise.all([
      db.assistSiteVoiceIncident.findFirst({
        where: { siteId, kind: { in: ['degraded', 'off'] } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      db.assistSiteUiActionLog.findFirst({
        where: { siteId, action: 'violation' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);
    const cur =
      state === 'degraded' ||
      (state === 'off' && row.voiceControlSiteStateBy === 'violation')
        ? (row.voiceControlSiteStateAt?.getTime() ?? 0)
        : 0;
    const at = Math.max(
      cur,
      inc?.createdAt.getTime() ?? 0,
      vio?.createdAt.getTime() ?? 0,
    );
    return at > 0 ? new Date(at) : null;
  }

  private async summary(
    m: AccountMembership,
    siteId: string,
    row: SiteRow,
    t: TestRow,
  ): Promise<VoiceTestSummary> {
    return {
      id: t.id,
      kind: t.kind === 'autotest' ? 'autotest' : 'wizard',
      host: t.host,
      createdAt: t.createdAt.toISOString(),
      reportedAt: t.reportedAt?.toISOString() ?? null,
      result: (RESULTS as readonly unknown[]).includes(t.result)
        ? (t.result as WizardResult)
        : null,
      validUntil: t.validUntil?.toISOString() ?? null,
      release: t.release,
      partialAck: t.partialAckAt !== null,
      problem: await this.problemOf(m, siteId, row, t),
    };
  }

  private latestReported(m: AccountMembership, siteId: string) {
    return this.db(m).assistSiteVoiceTest.findFirst({
      where: { siteId, kind: 'wizard', reportedAt: { not: null } },
      orderBy: { reportedAt: 'desc' },
      select: TEST_SELECT,
    });
  }

  async get(
    m: AccountMembership,
    siteId: string,
  ): Promise<VoiceControlSettingsView> {
    const db = this.db(m);
    const { row } = await loadAssistSite(db, m.accountId, siteId);
    const { plan, voice } = await this.voiceOf(m, row);
    const platform = await this.platformOn();
    const access = voiceControlAccess({
      platformEnabled: platform,
      voice,
      state: row.voiceControlSiteState,
      rules: row.voiceControlSiteRules,
    });
    const now = this.now();
    const last = await this.latestReported(m, siteId);
    const [metrics, incidents] = await Promise.all([
      siteMetrics(db, siteId, now),
      db.assistSiteVoiceIncident.findMany({
        where: { siteId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { kind: true, code: true, createdAt: true },
      }),
    ]);
    return {
      siteId,
      state: stateOf(row.voiceControlSiteState),
      rules: rulesOf(row.voiceControlSiteRules) ?? defaultVoiceControlRules(),
      available: platform && assistPlanAllows(plan, 'voice') && voice.input,
      reason: access.reason,
      risksVersion: VOICE_CONTROL_RISKS_VERSION,
      // (д) Р-67: включено по прежней редакции рисков — баннер, без `test`.
      risksBanner:
        stateOf(row.voiceControlSiteState) !== 'off' &&
        row.voiceControlRisksVersion !== VOICE_CONTROL_RISKS_VERSION,
      stateBy: row.voiceControlSiteStateBy,
      stateAt: row.voiceControlSiteStateAt?.toISOString() ?? null,
      stateReason: row.voiceControlSiteStateReason,
      checkDeadline: row.voiceControlCheckDeadline?.toISOString() ?? null,
      lastTest: last ? await this.summary(m, siteId, row, last) : null,
      plansPerDay: plansPerSitePerDay(row.voiceControlPlansPerDay, plan),
      monitor: {
        windowHours: MONITOR_THRESHOLDS.windowMs / 3_600_000,
        metrics,
        incidents: incidents.map((i) => ({
          kind: i.kind,
          code: i.code,
          createdAt: i.createdAt.toISOString(),
        })),
      },
    };
  }

  async save(
    m: AccountMembership,
    siteId: string,
    body: VoiceControlSettingsPatch | null | undefined,
  ): Promise<VoiceControlSettingsView> {
    const db = this.db(m);
    const { row } = await loadAssistSite(db, m.accountId, siteId);
    const state = body?.state;
    if (
      state !== 'off' &&
      state !== 'on' &&
      state !== 'test' &&
      state !== 'degraded'
    ) {
      throw voiceControlError(
        HttpStatus.BAD_REQUEST,
        'VOICE_CONTROL_INVALID',
        'Состояние голосового управления — off, test, on или degraded',
        { errors: [{ path: 'state', code: 'enum' }] },
      );
    }
    let rules =
      rulesOf(row.voiceControlSiteRules) ?? defaultVoiceControlRules();
    if (body && body.rules !== undefined) {
      const p = parseVoiceControlRules(body.rules);
      if (!p.ok) {
        throw voiceControlError(
          HttpStatus.BAD_REQUEST,
          'VOICE_CONTROL_INVALID',
          'Правила голосового управления не прошли проверку',
          { errors: p.errors },
        );
      }
      rules = p.rules;
    }
    const prev = stateOf(row.voiceControlSiteState);
    const changed = state !== prev;
    const data: Prisma.AssistSiteUpdateInput = {
      voiceControlSiteRules: rules as unknown as Prisma.InputJsonValue,
    };
    // (д) Р-67, В-69: владелец прочитал ТЕКУЩУЮ редакцию рисков (при
    // включении — обязательно, у включённых — «прочитано» по баннеру).
    // Новую редакцию уже включённым не требуем: режим не понижается.
    if (body?.risksVersion === VOICE_CONTROL_RISKS_VERSION)
      data.voiceControlRisksVersion = VOICE_CONTROL_RISKS_VERSION;
    if (changed) {
      if (prev === 'off' && state !== 'off')
        await this.assertCanEnable(m, row, body?.risksVersion);
      if (state === 'degraded' && prev !== 'on' && prev !== 'test') {
        throw voiceControlError(
          HttpStatus.CONFLICT,
          'VOICE_CONTROL_INVALID',
          'Режим подсказки включается из «Увімкнено» или «Тест»',
        );
      }
      if (state === 'on') {
        const t = await this.usableReport(m, siteId, row, body?.partialAck);
        data.voiceControlSiteTestId = t.id;
        data.voiceControlCheckDeadline = null;
      }
      if (state !== 'on') data.voiceControlSiteTestId = null;
      if (state === 'off' || state === 'test')
        data.voiceControlCheckDeadline = null;
      data.voiceControlSiteState = state;
      data.voiceControlSiteStateAt = this.now();
      data.voiceControlSiteStateBy = 'owner';
      data.voiceControlSiteStateReason = null;
    }
    if (changed) {
      // Аудит (г) 03.10: смена состояния — условно, «от того, что видели».
      // Иначе гонка: монитор/предохранитель перевёл сайт в `degraded`/`off`
      // между чтением и записью, а `on` по старому отчёту его затёр бы.
      const r = await db.assistSite.updateMany({
        where: {
          id: row.id,
          voiceControlSiteState: row.voiceControlSiteState,
          voiceControlSiteStateAt: row.voiceControlSiteStateAt,
        },
        data: data as Prisma.AssistSiteUpdateManyMutationInput,
      });
      if (r.count !== 1) {
        throw voiceControlError(
          HttpStatus.CONFLICT,
          'VOICE_CONTROL_TEST_REQUIRED',
          'Состояние голосового управления только что изменилось — обновите экран',
          { errors: [{ path: 'test', code: 'older_than_state' }] },
        );
      }
    } else await db.assistSite.update({ where: { id: row.id }, data });
    // Журнал кабинета — кто и какую версию рисков принял (без ПД, §6.6).
    this.logger.log(
      `voice-control site=${siteId} state=${state} member=${m.memberId} risks=${body?.risksVersion === VOICE_CONTROL_RISKS_VERSION ? VOICE_CONTROL_RISKS_VERSION : '-'}`,
    );
    return this.get(m, siteId);
  }

  /**
   * (г) Годный отчёт мастера для `on` (решение владельца п.1) — или 409 с
   * причиной. `partial` — только с подтверждением владельца (оно пишется в
   * отчёт: кто и когда понял, что часть команд будет «нажмите сами»).
   */
  private async usableReport(
    m: AccountMembership,
    siteId: string,
    row: SiteRow,
    partialAck: unknown,
  ): Promise<TestRow> {
    let t = await this.latestReported(m, siteId);
    if (t && t.result === 'partial' && partialAck === true && !t.partialAckAt) {
      const at = this.now();
      await this.db(m).assistSiteVoiceTest.update({
        where: { id: t.id },
        data: { partialAckBy: m.memberId, partialAckAt: at },
      });
      t = { ...t, partialAckAt: at };
    }
    const problem = await this.problemOf(m, siteId, row, t);
    if (problem || !t) {
      throw voiceControlError(
        HttpStatus.CONFLICT,
        'VOICE_CONTROL_TEST_REQUIRED',
        'Включить для всех можно после проверки голосового управления на сайте',
        { errors: [{ path: 'test', code: problem ?? 'none' }] },
      );
    }
    return t;
  }

  /** Из `off` — только с голосом сайта и после экрана рисков. */
  private async assertCanEnable(
    m: AccountMembership,
    row: SiteRow,
    risksVersion: unknown,
  ): Promise<void> {
    await this.assertVoice(m, row);
    if (risksVersion !== VOICE_CONTROL_RISKS_VERSION) {
      throw voiceControlError(
        HttpStatus.BAD_REQUEST,
        'VOICE_CONTROL_RISKS_REQUIRED',
        'Перед включением прочитайте и примите риски',
      );
    }
  }

  private async assertVoice(m: AccountMembership, row: SiteRow) {
    const { plan, voice } = await this.voiceOf(m, row);
    if (!assistPlanAllows(plan, 'voice')) {
      throw voiceControlError(
        HttpStatus.PAYMENT_REQUIRED,
        'VOICE_CONTROL_PLAN_REQUIRED',
        'Голосовое управление доступно на тарифе с голосом (Business и выше)',
      );
    }
    if (!(await this.platformOn()) || !voice.input) {
      throw voiceControlError(
        HttpStatus.CONFLICT,
        'VOICE_CONTROL_VOICE_REQUIRED',
        'Сначала включите микрофон в разделе «Голос»',
      );
    }
  }

  // ── мастер Т-2 ──────────────────────────────────────────────────────────

  async testToken(
    m: AccountMembership,
    siteId: string,
    body: VoiceTestTokenRequest | null | undefined,
  ): Promise<VoiceTestTokenView> {
    const db = this.db(m);
    const { row } = await loadAssistSite(db, m.accountId, siteId);
    await this.assertVoice(m, row);
    const now = this.now();
    // Мастер «Сайта» — только на хостах «Сайта» (не «Админки», ТЗ §10).
    const hosts = await db.siteHost.findMany({
      where: { siteId, ...PUBLIC_SITE_HOST },
      orderBy: { createdAt: 'asc' },
    });
    const ok = hosts.filter((h) => {
      const a = evaluateHostAccess(h, 'assist-widget', now);
      return a.ok && !a.grace && h.scheme === 'https';
    });
    const want = typeof body?.host === 'string' ? body.host : null;
    const h = want ? ok.find((x) => x.host === want) : ok[0];
    if (!h) {
      throw voiceControlError(
        HttpStatus.CONFLICT,
        'VOICE_CONTROL_HOST_REQUIRED',
        'Проверка — только на подтверждённом адресе сайта',
      );
    }
    const origin = hostOriginOf(h);
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(now.getTime() + WIZARD_LIMITS.tokenTtlMs);
    const t = await db.assistSiteVoiceTest.create({
      data: {
        accountId: m.accountId,
        siteId,
        kind: 'wizard',
        host: h.host,
        origin,
        testHost: body?.testHost === true,
        startedBy: m.memberId,
        tokenHash: sha256Hex(token),
        tokenExpiresAt: expiresAt,
      },
      select: { id: true },
    });
    this.logger.log(
      `voice-test token site=${siteId} test=${t.id} member=${m.memberId}`,
    );
    return {
      testId: t.id,
      url: `${origin}/?${WIDGET_VOICE_TEST_PARAM}=${encodeURIComponent(token)}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async tests(
    m: AccountMembership,
    siteId: string,
  ): Promise<{ items: VoiceTestSummary[] }> {
    const db = this.db(m);
    const { row } = await loadAssistSite(db, m.accountId, siteId);
    // Сухие прогоны мемо (`memo`) — в карточке мемо, не в отчётах мастера.
    // Автотесты Т-3 (раз в сутки) — отдельной выборкой: не вытесняют
    // отчёты мастера из 20 последних (аудит пакета Д, P3 (5)).
    const [wizard, auto] = await Promise.all([
      db.assistSiteVoiceTest.findMany({
        where: { siteId, kind: 'wizard' },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: TEST_SELECT,
      }),
      db.assistSiteVoiceTest.findMany({
        where: { siteId, kind: AUTOTEST_KIND },
        orderBy: { createdAt: 'desc' },
        take: AUTOTEST_LIST_MAX,
        select: TEST_SELECT,
      }),
    ]);
    const list = [...wizard, ...auto].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const items: VoiceTestSummary[] = [];
    for (const t of list) items.push(await this.summary(m, siteId, row, t));
    return { items };
  }

  /**
   * (заход 9, Р-З9-9; ТЗ §5-бис.13 п.7) Одноразовая ссылка «отчёт для
   * разработчика»: строка `dev_report` (хеш токена, срок 72 ч, срез отчёта
   * без ПД — `devReportOf`). Обмен мастера по ней невозможен (origin-
   * заглушка, сессии нет). Новая ссылка гасит прежние неоткрытые ссылки
   * этого отчёта; истёкшие ссылки сайта — удаляются.
   */
  async devLink(
    m: AccountMembership,
    siteId: string,
    tid: string,
  ): Promise<VoiceDevLinkView> {
    const db = this.db(m);
    await loadAssistSite(db, m.accountId, siteId);
    const t = /^[A-Za-z0-9_-]{1,64}$/.test(tid)
      ? await db.assistSiteVoiceTest.findFirst({
          where: { id: tid, siteId, kind: 'wizard', reportedAt: { not: null } },
          select: { id: true, host: true, report: true, reportedAt: true },
        })
      : null;
    if (!t?.report) {
      throw voiceControlError(
        HttpStatus.NOT_FOUND,
        'VOICE_CONTROL_TEST_NOT_FOUND',
        'Отчёт не найден',
      );
    }
    const now = this.now();
    await db.assistSiteVoiceTest.deleteMany({
      where: {
        siteId,
        kind: DEV_REPORT_KIND,
        OR: [
          { tokenExpiresAt: { lte: now } },
          { usedAt: null, report: { path: ['src'], equals: t.id } },
        ],
      },
    });
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(now.getTime() + DEV_REPORT_LIMITS.ttlMs);
    const r = await db.assistSiteVoiceTest.create({
      data: {
        accountId: m.accountId,
        siteId,
        kind: DEV_REPORT_KIND,
        host: t.host,
        origin: DEV_REPORT_ORIGIN,
        startedBy: m.memberId,
        tokenHash: sha256Hex(token),
        tokenExpiresAt: expiresAt,
        report: devReportOf(t.report as unknown as WizardReport, {
          src: t.id,
          reportedAt: t.reportedAt,
        }) as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    this.logger.log(
      `voice dev-report link site=${siteId} test=${t.id} row=${r.id} member=${m.memberId}`,
    );
    return {
      url: `${widgetOrigin(this.env)}${DEV_REPORT_PATH}/${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async test(
    m: AccountMembership,
    siteId: string,
    tid: string,
  ): Promise<VoiceTestDetail> {
    const db = this.db(m);
    const { row } = await loadAssistSite(db, m.accountId, siteId);
    const t = /^[A-Za-z0-9_-]{1,64}$/.test(tid)
      ? await db.assistSiteVoiceTest.findFirst({
          // (заход 9, P3-2) Только отчёты мастера/автотеста: строки ссылок
          // `dev_report` и прогоны мемо — не «отчёт мастера».
          where: { id: tid, siteId, kind: { in: ['wizard', 'autotest'] } },
          select: { ...TEST_SELECT, report: true },
        })
      : null;
    if (!t) {
      throw voiceControlError(
        HttpStatus.NOT_FOUND,
        'VOICE_CONTROL_TEST_NOT_FOUND',
        'Отчёт не найден',
      );
    }
    return {
      ...(await this.summary(m, siteId, row, t)),
      report: (t.report ?? null) as WizardReport | null,
    };
  }
}
