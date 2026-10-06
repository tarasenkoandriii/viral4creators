/**
 * Сухой прогон мемо «Админки» АМ-N в браузере владельца (аудит 06.10.2026;
 * ТЗ §5-бис.17 п.7 «закрытые страницы и «Админка» — всегда в браузере
 * владельца по одноразовой ссылке мастера (`?v4c_voicetest=`)»).
 *
 *  - кабинет `POST …/admin-mode/memos/:n/check-token` — ссылка мастера
 *    `admin-vc` на verified-хост админки (30 мин, в базе — хеш) для
 *    ПОСЛЕДНЕЙ версии на проверке; тест мастера помечен `report.kind = memo`
 *    (вставка — чистой ссылкой, триггер), отчёт общего мастера по ней не
 *    сдаётся, включить голосовое управление ею нельзя (она не «сдана»);
 *  - iframe `wa.` (сессия сотрудника, обменявшая ссылку):
 *    `memo-page` — снимок страницы → итог страницы КОДОМ
 *    (`adminMemoCheckPage` = ядро прогона «Сайта»), хранится в тесте на
 *    сервере (браузер итог не подделает); `memo-report` — вердикт кодом по
 *    сохранённым страницам + шаги `api` (наличие операции, включённость,
 *    права роли проверяющего — НИЧЕГО не вызывается) + фразы → отчёт в
 *    `checkReport` версии; публикует только владелец в TMA.
 * Голосовое управление «Админкой» (состояние, риски, голос) для прогона не
 * нужно: шаги на странице не исполняются, итог — по снимку.
 */
import { randomBytes } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { WIDGET_VOICE_TEST_PARAM } from '../../brand';
import { SitesDb } from '../../prisma/sites-db.service';
import { AdminMemoService } from '../assist-admin-actions/admin-memo.service';
import {
  ADMIN_MEMO_CHECK,
  adminMemoCheckPage,
  adminMemoCheckVerdict,
  adminMemoHasPageSteps,
  adminMemoStepLines,
  type AdminMemoCheckPage,
  type AdminMemoCheckReport,
} from '../assist-admin-actions/admin-memo-check';
import { adminMemoName } from '../assist-admin-actions/admin-memo';
import type { ResolvedAdminSession } from '../assist-admin-chat/admin-session.service';
import { AdminModeService } from '../assist-admin-mode/admin-mode.service';
import { MEMO_LIMITS, type MemoLang } from '../assist-ui-core/memo';
import { onSiteHost } from '../assist-ui-core/plan-checks';
import { parseSnapshot, snapshotTooLarge } from '../assist-ui-core/snapshot';
import type { UiSnapshot } from '../assist-ui-core/types';
import type { AccountMembership } from '../site-core/account/roles';
import { adminVoiceError, failPlan } from './admin-voice-errors';
import { adminRulesOf, defaultAdminRules } from './admin-voice-rules';
import {
  AdminVoiceSettingsService,
  sha256Hex,
  START_PATH_RE,
} from './admin-voice-settings.service';

/** Пометка теста мастера «это прогон мемо» (`assist_admin_voice_tests.report`). */
export interface MemoCheckMark {
  kind: 'memo';
  memoId: string;
  memoNumber: number;
  version: number;
  versionId: string;
  contentHash: string;
  pages: AdminMemoCheckPage[];
  /** Отчёт сдан (тест закрыт): `result` прогона. */
  result?: AdminMemoCheckReport['result'];
}

export function memoCheckMark(report: unknown): MemoCheckMark | null {
  if (!report || typeof report !== 'object' || Array.isArray(report))
    return null;
  const r = report as Partial<MemoCheckMark>;
  return r.kind === 'memo' &&
    typeof r.versionId === 'string' &&
    typeof r.contentHash === 'string'
    ? ({ ...r, pages: Array.isArray(r.pages) ? r.pages : [] } as MemoCheckMark)
    : null;
}

export interface AdminMemoCheckTokenView {
  testId: string;
  url: string;
  expiresAt: string;
  version: number;
}

export interface AdminMemoCheckSessionView {
  number: number;
  name: string;
  version: number;
  /** На странице есть что проверять (иначе — сразу «Завершить»). */
  pageSteps: boolean;
  steps: Array<{ i: number; kind: string; text: string }>;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const langOf = (v: unknown): MemoLang => (v === 'ru' || v === 'en' ? v : 'uk');

@Injectable()
export class AdminMemoCheckService {
  private readonly logger = new Logger(AdminMemoCheckService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly mode: AdminModeService,
    private readonly settings: AdminVoiceSettingsService,
    private readonly memos: AdminMemoService,
  ) {}

  private db(accountId: string) {
    return this.sitesDb.forAccount(accountId);
  }

  // ── кабинет (assistAdmin: owner) ───────────────────────────────────────

  /** «Прогнать»: одноразовая ссылка мастера для последней версии на проверке. */
  async token(
    m: AccountMembership,
    siteId: string,
    n: number,
    body: { hostId?: unknown; path?: unknown } | null | undefined,
  ): Promise<AdminMemoCheckTokenView> {
    const target = await this.memos.checkTarget(m, siteId, n);
    const s = await this.mode.ensureSettings(m.accountId, siteId);
    const now = this.now();
    const hosts = (
      await this.settings.adminHosts(m.accountId, siteId, s, now)
    ).filter((h) => h.verified && h.scheme === 'https');
    if (
      !s.adminModeEnabled ||
      (s.adminAccess !== 'script' && s.adminAccess !== 'both') ||
      !hosts.length
    ) {
      throw adminVoiceError(
        409,
        'ADMIN_VC_MODE_REQUIRED',
        'Прогон мемо — в админке со скриптом помощника (подтверждённый хост админки)',
      );
    }
    const want = typeof body?.hostId === 'string' ? body.hostId : null;
    const h = want ? hosts.find((x) => x.id === want) : hosts[0];
    if (!h) {
      throw adminVoiceError(
        409,
        'ADMIN_VC_HOST_REQUIRED',
        'Прогон — только на подтверждённом адресе самой админки',
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
    const expiresAt = new Date(now.getTime() + MEMO_LIMITS.checkTokenTtlMs);
    const mark: MemoCheckMark = {
      kind: 'memo',
      memoId: target.memoId,
      memoNumber: target.memoNumber,
      version: target.number,
      versionId: target.id,
      contentHash: target.contentHash,
      pages: [],
    };
    const db = this.db(m.accountId);
    // Вставка — только чистой ссылкой (триггер); пометка — UPDATE'ом.
    const t = await db.$transaction(async (tx) => {
      const row = await tx.assistAdminVoiceTest.create({
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
      await tx.assistAdminVoiceTest.update({
        where: { id: row.id },
        data: { report: mark as unknown as Prisma.InputJsonValue },
      });
      return row;
    });
    this.logger.log(
      `admin memo-check token site=${siteId} memo=${target.memoNumber} v=${target.number} test=${t.id}`,
    );
    return {
      testId: t.id,
      url: `${h.origin}${path}?${WIDGET_VOICE_TEST_PARAM}=${encodeURIComponent(token)}`,
      expiresAt: expiresAt.toISOString(),
      version: target.number,
    };
  }

  // ── iframe `wa.` (сессия, обменявшая ссылку) ───────────────────────────

  /** Живой тест прогона мемо ЭТОЙ сессии (обменян, не сдан, не истёк). */
  private async live(s: ResolvedAdminSession, tid: string) {
    if (!ID_RE.test(tid)) return failPlan('not_found');
    const t = await this.db(s.accountId).assistAdminVoiceTest.findFirst({
      where: {
        id: tid,
        siteId: s.siteId,
        sessionId: s.sessionId,
        actor: s.employeeRef,
        reportedAt: null,
        sessionExpiresAt: { gt: this.now() },
      },
      select: { id: true, host: true, report: true },
    });
    const mark = memoCheckMark(t?.report);
    if (!t || !mark || mark.result) return failPlan('not_found');
    const v = await this.memos.checkVersion(
      s.accountId,
      s.siteId,
      mark.versionId,
      mark.contentHash,
    );
    // Версию собрали заново/опубликовали/сняли — прогон этой ссылкой окончен.
    if (!v) return failPlan('conflict');
    return { t, mark, v };
  }

  /** Обмен ссылки: тест — прогон мемо? Тогда его карточка (без значений). */
  async session(
    s: ResolvedAdminSession,
    tid: string,
    lang: unknown,
  ): Promise<AdminMemoCheckSessionView | null> {
    const t = await this.db(s.accountId).assistAdminVoiceTest.findFirst({
      where: { id: tid, siteId: s.siteId },
      select: { report: true },
    });
    const mark = memoCheckMark(t?.report);
    if (!mark) return null;
    const v = await this.memos.checkVersion(
      s.accountId,
      s.siteId,
      mark.versionId,
      mark.contentHash,
    );
    if (!v) return failPlan('conflict');
    const l = langOf(lang);
    return {
      number: v.memoNumber,
      name: adminMemoName(v.content, l),
      version: v.version,
      pageSteps: adminMemoHasPageSteps(v.content),
      steps: adminMemoStepLines(v.content, l).map((x) => ({
        ...x,
        text: x.text.slice(0, 80),
      })),
    };
  }

  private async hostsAndRules(s: ResolvedAdminSession, host: string) {
    const st = await this.mode.ensureSettings(s.accountId, s.siteId);
    const hosts = (
      await this.settings.adminHosts(s.accountId, s.siteId, st, this.now())
    )
      .filter((h) => h.verified)
      .map((h) => h.host);
    return {
      // Снимки прогона — только с хоста его ссылки.
      hosts: hosts.filter((h) => h === host),
      rules: adminRulesOf(st.voiceControlAdminRules) ?? defaultAdminRules(),
    };
  }

  private snapshotOf(raw: unknown, hosts: string[]): UiSnapshot {
    if (snapshotTooLarge(raw)) return failPlan('too_large');
    const snap = parseSnapshot(raw);
    if (!snap || !onSiteHost(snap.url, hosts)) return failPlan('bad_request');
    return snap;
  }

  /** «Перевірити сторінку»: итог страницы кодом; хранится в тесте. */
  async page(
    s: ResolvedAdminSession,
    tid: string,
    body: { snapshot?: unknown } | null,
  ): Promise<AdminMemoCheckPage & { pages: number }> {
    const { t, mark, v } = await this.live(s, tid);
    const { hosts, rules } = await this.hostsAndRules(s, t.host);
    const snapshot = this.snapshotOf(body?.snapshot, hosts);
    const page = adminMemoCheckPage(v.content, snapshot, { rules, hosts });
    // Повторная проверка той же страницы заменяет прежнюю (страницу могли
    // поправить); порядок — по времени (вердикт берёт последнюю).
    const pages = [
      ...mark.pages.filter((p) => p.path !== page.path),
      page,
    ].slice(-ADMIN_MEMO_CHECK.maxPages);
    const w = await this.db(s.accountId).assistAdminVoiceTest.updateMany({
      where: { id: t.id, sessionId: s.sessionId, reportedAt: null },
      data: {
        report: { ...mark, pages } as unknown as Prisma.InputJsonValue,
      },
    });
    if (w.count !== 1) return failPlan('conflict');
    return { ...page, pages: pages.length };
  }

  /**
   * «Завершити прогін»: вердикт КОДОМ по страницам из базы + шаги `api`
   * (без вызова) + фразы. Один раз: тест закрыт, отчёт — в версии.
   */
  async report(
    s: ResolvedAdminSession,
    tid: string,
  ): Promise<{ testId: string; result: string; report: AdminMemoCheckReport }> {
    const { t, mark, v } = await this.live(s, tid);
    const now = this.now();
    const api = await this.memos.apiChecks(
      s.accountId,
      s.siteId,
      v.content,
      s.role,
    );
    const conflicts = await this.memos.phraseConflicts(
      s.accountId,
      s.siteId,
      v.memoId,
      v.content,
    );
    const verdict = adminMemoCheckVerdict(
      v.content,
      mark.pages,
      api,
      conflicts.length,
    );
    const report: AdminMemoCheckReport = {
      v: 1,
      kind: 'memo-check',
      testId: t.id,
      version: v.version,
      contentHash: mark.contentHash,
      result: verdict.result,
      steps: verdict.steps,
      goal: verdict.goal,
      phraseConflicts: conflicts,
      pages: mark.pages.map((p) => p.path),
      by: s.employeeRef,
      at: now.toISOString(),
    };
    // Тест закрыт ДО записи в версию: повторный отчёт той же ссылкой — нет.
    // `reportedAt` не ставится: это не отчёт общего мастера (он годится для
    // включения голосового управления, прогон мемо — нет).
    const w = await this.db(s.accountId).assistAdminVoiceTest.updateMany({
      where: {
        id: t.id,
        sessionId: s.sessionId,
        reportedAt: null,
        sessionExpiresAt: { gt: now },
      },
      data: {
        report: {
          ...mark,
          result: verdict.result,
        } as unknown as Prisma.InputJsonValue,
        sessionExpiresAt: now,
      },
    });
    if (w.count !== 1) return failPlan('conflict');
    const ok = await this.memos.recordCheck(
      {
        accountId: s.accountId,
        siteId: s.siteId,
        versionId: mark.versionId,
        actor: s.employeeRef,
        actorRole: s.customerRole,
      },
      report,
    );
    if (!ok) return failPlan('conflict');
    this.logger.log(
      `admin memo-check report site=${s.siteId} memo=${v.memoNumber} v=${v.version} result=${verdict.result}`,
    );
    return { testId: t.id, result: verdict.result, report };
  }
}
