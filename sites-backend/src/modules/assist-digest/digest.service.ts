/**
 * Утренняя сводка и отчёт недели — A (ТЗ §4.15 `assist-digest` 30 6 * * *,
 * §5-тер.7; план Э3 «Утренняя сводка владельцу»). Нейтральный оркестратор
 * (модуль assist-digest — правило графа `digest-leaf`: его не импортирует
 * никто): «Сайт» — StatsService/AnalyticsRollup (A), LearningReadApi (L),
 * передачи (свёртка A: handoffsMissed); «Админка» — AdminDigestSource.
 * Получатели — владелец и assist: manager с ботом, без отписки
 * (assist_site_report_subscriptions); раздел «Админка» — только
 * assistAdmin: owner (У-27). По понедельникам (пояс сайта) — отчёт недели
 * вместо сводки (кнопка «Открыть статистику» — startapp `st_<siteId>`).
 * Сообщение — notify.ts (sendToMembers), по одному получателю, целиком на
 * его языке (заход 10, Р-З10-14: язык — recipientsWithLang; рамка —
 * report-text, выводы — текст модели на языке читателя `insightTextFor`,
 * иначе сухая строка `dryFindingLine(f, lang)`).
 *
 * Уточнения A:
 *  - сайты — с опубликованным видом (widgetVersion > 0); сводка за вчера
 *    (сутки сайта), отчёт недели — прошлые 7 дней против предыдущих 7;
 *  - перед сводкой вчерашний день пересчитывается (rollupDay — идемпотентно);
 *  - пустые сутки/неделя (все числа 0, тревог и пробелов нет) — не шлём
 *    (заход 9: кроме владельцев «Админки», если в её разделе есть новости —
 *    мемо «требует проверки», удержанная версия, карантин, якорь журнала);
 *  - тревоги №29: доля «не знаю» среди ответов, доля 👎 среди оценок и
 *    доля передач среди диалогов за вчера ≥ alertSpikeRatio × средняя за 7
 *    дней до того, при ≥ alertMinDialogs диалогов вчера;
 *  - кнопка — web_app на `#/sites/<id>/stats` (тот же экран, что
 *    `startapp=st_<id>`: имени бота для t.me-ссылки в env sites-backend нет;
 *    sendToMembers Э1 умеет только web_app);
 *  - без ASSIST_BOT_TOKEN/ASSIST_TMA_URL не шлём вовсе (запасная ветка
 *    sendToMembers пишет текст в лог);
 *  - факты L (очередь) — через LearningReadApi; его сбой не роняет сводку
 *    (нули по обучению, в лог — код).
 * В лог — id сайта и числа отправок, без текста сообщения.
 *
 * Заход 11 (Р-З11-В3): отчёт недели «Админки», который ждёт сегодняшней
 * сводки (AdminWeeklyDigest, admin-weekly-digest.ts), уходит разделом в
 * конце сообщения получателю с разделом «Админка» — на его языке, с
 * второй кнопкой «Статистика „Админки“»; id забирается из ожидания до
 * отправки, не отправилось — возвращается (крон «Админки» дошлёт
 * отдельно). Пустые для «Сайта» сутки без новостей «Админки» — уходит
 * только отчёт недели «Админки» (без рамки из нулей), и только если он
 * забран этим вызовом (аудит з11 P3-1/P3-7).
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ANALYTICS_DEFAULTS } from '../../config/assist-defaults';
import type { CronScope } from '../../common/cron-scope';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  AdminWeeklyDigest,
  type AdminWeeklyPending,
} from '../assist-admin-analytics/admin-weekly-digest';
import { AdminDigestSource } from '../assist-admin-knowledge/admin-digest';
import { effectiveAnalyticsConfig } from '../assist-analytics/analytics-config';
import { sumConversions } from '../assist-analytics/exports.service';
import {
  COINCIDENCE_NOTE,
  dryFindingLine,
  hasCoincidenceNote,
  insightTextFor,
  type Finding,
} from '../assist-analytics/ai/findings';
import { RUN_CODE } from '../assist-analytics/ai/insights.service';
import {
  addDays,
  dayInTz,
  dayRangeUtc,
  isoWeekdayInTz,
  siteTz,
} from '../assist-analytics/site-time';
import { AnalyticsRollup } from '../assist-analytics/system/analytics-rollup.service';
import {
  recipientsWithLang,
  sendToMembers,
  type BotNotifyEnv,
  type FetchLike,
  type NotifyLang,
} from '../assist-knowledge-core/notify';
import { LearningReadApi } from '../assist-site-learning/learning-read.service';
import {
  parseAccountRole,
  parseProductRoles,
  REQUIRE_ASSIST_ADMIN_OWNER,
  satisfiesProductRoles,
} from '../site-core/account/roles';
import {
  appendAdminWeekly,
  dailyDigestText,
  digestTexts,
  weeklyReportText,
  type SiteDigestFacts,
} from './report-text';

interface DayTotals {
  day: string;
  dialogs: number;
  resolved: number;
  answers: number;
  unknown: number;
  handoffs: number;
  handoffsMissed: number;
  leads: number;
  thumbsUp: number;
  thumbsDown: number;
  conversions: unknown;
}

/** Тревоги №29 — чистая функция (вчера против средней за 7 дней до). */
export function digestAlerts(
  day: Pick<
    DayTotals,
    'dialogs' | 'answers' | 'unknown' | 'handoffs' | 'thumbsUp' | 'thumbsDown'
  >,
  base: Array<
    Pick<
      DayTotals,
      'dialogs' | 'answers' | 'unknown' | 'handoffs' | 'thumbsUp' | 'thumbsDown'
    >
  >,
): SiteDigestFacts['alerts'] {
  const out: SiteDigestFacts['alerts'] = [];
  if (day.dialogs < ANALYTICS_DEFAULTS.alertMinDialogs) return out;
  const sum = (f: (d: (typeof base)[number]) => number) =>
    base.reduce((a, d) => a + f(d), 0);
  const spike = (x: number, n: number, bx: number, bn: number) =>
    n > 0 &&
    bn > 0 &&
    bx > 0 &&
    x / n >= ANALYTICS_DEFAULTS.alertSpikeRatio * (bx / bn);
  if (
    spike(
      day.unknown,
      day.answers,
      sum((d) => d.unknown),
      sum((d) => d.answers),
    )
  ) {
    out.push('unknown_spike');
  }
  if (
    spike(
      day.thumbsDown,
      day.thumbsUp + day.thumbsDown,
      sum((d) => d.thumbsDown),
      sum((d) => d.thumbsUp + d.thumbsDown),
    )
  ) {
    out.push('thumbs_down_spike');
  }
  if (
    spike(
      day.handoffs,
      day.dialogs,
      sum((d) => d.handoffs),
      sum((d) => d.dialogs),
    )
  ) {
    out.push('handoff_spike');
  }
  return out;
}

@Injectable()
export class AssistDigestService {
  private readonly logger = new Logger(AssistDigestService.name);
  now: () => Date = () => new Date();
  env: BotNotifyEnv & NodeJS.ProcessEnv = process.env;
  fetchImpl: FetchLike | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sitesDb: SitesDb,
    private readonly rollup: AnalyticsRollup,
    private readonly admin: AdminDigestSource,
    @Optional() private readonly learning?: LearningReadApi,
    @Optional() private readonly adminWeekly?: AdminWeeklyDigest,
  ) {}

  /** `scope` — только тесты на общей базе (контракт Э3 §9 п.6). */
  async run(
    now: Date,
    scope?: CronScope,
  ): Promise<{ sites: number; sent: number; weekly: boolean }> {
    if (
      !this.env.ASSIST_BOT_TOKEN?.trim() ||
      !this.env.ASSIST_TMA_URL?.trim()
    ) {
      this.logger.warn(
        'сводка не отправлена: нет ASSIST_BOT_TOKEN/ASSIST_TMA_URL',
      );
      return { sites: 0, sent: 0, weekly: false };
    }
    const sites = await this.prisma.assistSite.findMany({
      where: {
        widgetVersion: { gt: 0 },
        ...(scope ? { siteId: { in: scope.siteIds } } : {}),
      },
      select: {
        accountId: true,
        siteId: true,
        timezone: true,
        analytics: true,
        site: { select: { name: true } },
      },
      orderBy: { siteId: 'asc' },
    });
    let done = 0;
    let sent = 0;
    let anyWeekly = false;
    for (const s of sites) {
      try {
        const r = await this.site(s, now);
        if (r.weekly) anyWeekly = true;
        sent += r.sent;
        done++;
      } catch (e) {
        this.logger.warn(
          `сводка сайта ${s.siteId} не отправлена (${(e as Error | null)?.name ?? 'Error'})`,
        );
      }
    }
    this.logger.log(`сводка: сайтов ${done}, отправлено ${sent}`);
    return { sites: done, sent, weekly: anyWeekly };
  }

  private async totals(
    siteId: string,
    from: string,
    to: string,
  ): Promise<DayTotals[]> {
    return this.prisma.assistSiteDailyTotal.findMany({
      where: { siteId, group: 'all', day: { gte: from, lte: to } },
      orderBy: { day: 'asc' },
      select: {
        day: true,
        dialogs: true,
        resolved: true,
        answers: true,
        unknown: true,
        handoffs: true,
        handoffsMissed: true,
        leads: true,
        thumbsUp: true,
        thumbsDown: true,
        conversions: true,
      },
    });
  }

  private async site(
    s: {
      accountId: string;
      siteId: string;
      timezone: string;
      analytics: unknown;
      site: { name: string };
    },
    now: Date,
  ): Promise<{ weekly: boolean; sent: number }> {
    const tz = siteTz(s.timezone);
    const today = dayInTz(now, tz);
    const yesterday = addDays(today, -1);
    const weekly = isoWeekdayInTz(now, tz) === 1;
    await this.rollup.rollupDay(s.siteId, yesterday);
    const from = weekly ? addDays(today, -7) : yesterday;
    const cur = await this.totals(s.siteId, from, yesterday);
    const prevFrom = weekly ? addDays(today, -14) : addDays(yesterday, -1);
    const prevTo = addDays(from, -1);
    const prev = await this.totals(s.siteId, prevFrom, prevTo);
    const base = await this.totals(
      s.siteId,
      addDays(yesterday, -7),
      addDays(yesterday, -1),
    );
    const sum = (rows: DayTotals[], f: (d: DayTotals) => number) =>
      rows.reduce((a, d) => a + f(d), 0);
    const conv = cur.map((d) => sumConversions(d.conversions));
    const cfg = effectiveAnalyticsConfig(s.analytics);
    const since = dayRangeUtc(from, tz).start;

    let learn = { newClusters: 0, goldenConflicts: 0 };
    // Находки — по языку читателя (заход 10): собираются один раз на язык.
    let unanswered: Array<{ label: string; n: number }> = [];
    let insights: Array<{ text: unknown; finding: Finding }> = [];
    if (this.learning) {
      try {
        const f = await this.learning.digestFacts({
          accountId: s.accountId,
          siteId: s.siteId,
          since,
        });
        learn = {
          newClusters: f.newClusters,
          goldenConflicts: f.goldenConflicts,
        };
        if (weekly) {
          const topics = await this.learning.topics({
            accountId: s.accountId,
            siteId: s.siteId,
            from: since,
            to: dayRangeUtc(yesterday, tz).end,
            limit: 20,
          });
          unanswered = topics
            .filter((t) => t.status === 'open' && t.distinctVisitors >= 3)
            .sort((a, b) => b.distinctVisitors - a.distinctVisitors)
            .slice(0, 2)
            .map((t) => ({ label: t.label, n: t.distinctVisitors }));
        }
      } catch (e) {
        this.logger.warn(
          `сводка ${s.siteId}: факты обучения недоступны (${(e as Error | null)?.name ?? 'Error'})`,
        );
      }
    }
    // Э3-бис (§5-тер.7 п.2): выводы недели — текст модели (Business+,
    // прошёл проверку чисел) или сухая строка кода (Start, без модели,
    // отброшен проверкой); «Не актуально» не попадает в отчёт.
    if (weekly) {
      const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
      const rows = await this.prisma.assistSiteInsight.findMany({
        where: {
          siteId: s.siteId,
          weekStart: from,
          code: { not: RUN_CODE },
          status: { not: 'dismissed' },
        },
        select: { impact: true, text: true, finding: true },
        take: 20,
      });
      insights = rows
        .sort((a, b) => (rank[a.impact] ?? 3) - (rank[b.impact] ?? 3))
        .map((r) => ({
          text: r.text,
          finding: r.finding as unknown as Finding,
        }));
    }
    const missed = sum(cur, (d) => d.handoffsMissed);
    const findingsCache = new Map<NotifyLang, string[]>();
    const findingsFor = (lang: NotifyLang): string[] => {
      const hit = findingsCache.get(lang);
      if (hit) return hit;
      const t = digestTexts(lang);
      const out = [
        ...insights.map(({ text, finding }) => {
          const own = insightTextFor(text, lang);
          if (!own) return dryFindingLine(finding, lang);
          const line = `${own.title} — ${own.action}`;
          // N11 (§5-тер.5): оговорка «совпадение во времени» — и в отчёте.
          return finding?.code === 'N11' && !hasCoincidenceNote(line)
            ? `${line} ${COINCIDENCE_NOTE[lang]}`
            : line;
        }),
        ...unanswered.map((u) => t.unanswered(u.label, u.n)),
        ...(weekly && missed > 0 ? [t.missedHandoffs(missed)] : []),
      ].filter((x) => x);
      findingsCache.set(lang, out);
      return out;
    };
    const heldVersions = await this.prisma.assistSiteKnowledgeVersion.count({
      where: { siteId: s.siteId, status: 'held' },
    });
    const yRow = cur.find((d) => d.day === yesterday);
    const facts: SiteDigestFacts = {
      siteName: s.site.name,
      period: { from, to: yesterday },
      dialogs: sum(cur, (d) => d.dialogs),
      dialogsPrev: prev.length ? sum(prev, (d) => d.dialogs) : null,
      resolved: sum(cur, (d) => d.resolved),
      operatorHours:
        Math.round((sum(cur, (d) => d.resolved) * cfg.minutesPerQuestion) / 6) /
        10,
      handoffs: sum(cur, (d) => d.handoffs),
      handoffsMissed: missed,
      leads: sum(cur, (d) => d.leads),
      conversionsDirect: conv.reduce((a, c) => a + c.direct, 0),
      conversionsAssisted: conv.reduce((a, c) => a + c.assisted, 0),
      newTopics: learn.newClusters,
      heldVersions,
      goldenConflicts: learn.goldenConflicts,
      alerts: yRow ? digestAlerts(yRow, base) : [],
      findings: [],
    };
    const empty =
      !facts.dialogs &&
      !facts.handoffs &&
      !facts.leads &&
      !facts.conversionsDirect &&
      !facts.conversionsAssisted &&
      !facts.newTopics &&
      !facts.heldVersions &&
      !facts.goldenConflicts;
    // Заход 9: при пустом «Сайте» отчёт всё равно уходит владельцам
    // «Админки», если там есть что сказать (мемо «требует проверки»,
    // удержанная версия, а в отчёте недели — новые записи журнала: якорь
    // цепочки Р-З9-20 не должен пропадать в тихую для «Сайта» неделю).
    const adminNews = (a: Awaited<ReturnType<AdminDigestSource['facts']>>) =>
      (a.memosNeedReviewTotal ?? 0) > 0 ||
      a.heldVersions > 0 ||
      a.quarantined > 0 ||
      (weekly &&
        !!a.chainHead &&
        new Date(a.chainHead.at).getTime() >= since.getTime());

    const kind = weekly ? 'weekly' : 'digest';
    const members = await this.sitesDb
      .forAccount(s.accountId)
      .siteAccountMember.findMany({
        select: { telegramId: true, role: true, productRoles: true },
      });
    const off = await this.prisma.assistSiteReportSubscription.findMany({
      where: { siteId: s.siteId, kind, enabled: false },
      select: { telegramId: true },
    });
    const unsubscribed = new Set(off.map((o) => o.telegramId.toString()));
    // Язык каждого получателя (Р-З9-7): assist_bot_users, нет строки — uk.
    const langOf = new Map(
      (await recipientsWithLang(this.sitesDb, s.accountId, () => true)).map(
        (r) => [r.chatId.toString(), r.lang],
      ),
    );
    let adminFacts: Awaited<ReturnType<AdminDigestSource['facts']>> | null =
      null;
    // Р-З11-В3: отчёт недели «Админки», ждущий этой сводки (раз на сайт).
    let weeklyAdmin: AdminWeeklyPending | null | undefined;
    let sent = 0;
    for (const mem of members) {
      const role = parseAccountRole(mem.role);
      if (!role) continue;
      const pr = parseProductRoles(mem.productRoles);
      if (role !== 'owner' && pr.assist !== 'manager') continue;
      if (unsubscribed.has(mem.telegramId.toString())) continue;
      // Раздел «Админка» — только assistAdmin: owner (У-27, §5-тер.16 п.9).
      const seesAdmin = satisfiesProductRoles(
        { role, productRoles: pr },
        REQUIRE_ASSIST_ADMIN_OWNER,
      );
      if (empty && !seesAdmin) continue;
      if (seesAdmin && !adminFacts) {
        adminFacts = await this.admin.facts({
          accountId: s.accountId,
          siteId: s.siteId,
          since,
        });
      }
      if (seesAdmin && weeklyAdmin === undefined) {
        weeklyAdmin = this.adminWeekly
          ? await this.adminWeekly
              .pending(s.accountId, s.siteId)
              .catch(() => null)
          : null;
      }
      const chat = mem.telegramId.toString();
      const weeklyFor =
        seesAdmin && weeklyAdmin?.chatIds.includes(chat) ? weeklyAdmin : null;
      const news = !!adminFacts && adminNews(adminFacts);
      if (empty && !news && !weeklyFor) continue;
      const lang = langOf.get(chat) ?? 'uk';
      const claim = async (w: AdminWeeklyPending): Promise<boolean> =>
        !!this.adminWeekly &&
        (await this.adminWeekly
          .claim(s.accountId, w.id, mem.telegramId)
          .catch(() => false));
      let text: string;
      let button = {
        text: digestTexts(lang).button,
        hashPath: `/sites/${s.siteId}/stats`,
      };
      let moreButtons: Array<{ text: string; hashPath: string }> = [];
      let withWeekly = false;
      if (weeklyFor && empty && !news) {
        // Аудит з11 P3-7: «Сайту» и «Админке» за сутки сказать нечего —
        // уходит ТОЛЬКО отчёт недели «Админки», без рамки «Сайта» из нулей.
        // P3-1: решение — после забора; не достался (досылка забрала
        // раньше) — пустую сводку не шлём вовсе.
        withWeekly = await claim(weeklyFor);
        if (!withWeekly) continue;
        text = weeklyFor.texts[lang].text;
        button = {
          text: weeklyFor.texts[lang].button,
          hashPath: `/sites/${s.siteId}/admin-mode/stats`,
        };
      } else {
        text = (weekly ? weeklyReportText : dailyDigestText)(
          { ...facts, findings: findingsFor(lang).slice(0, 3) },
          seesAdmin ? adminFacts : null,
          lang,
        );
        // Раздел «отчёт недели „Админки“»: влез и забран из ожидания именно
        // этим вызовом — в сообщение; иначе крон «Админки» дошлёт отдельно.
        const combined = weeklyFor
          ? appendAdminWeekly(text, weeklyFor.texts[lang].text)
          : null;
        withWeekly = !!combined && !!weeklyFor && (await claim(weeklyFor));
        if (withWeekly && combined) {
          text = combined;
          moreButtons = [
            {
              text: digestTexts(lang).admin.weeklyButton,
              hashPath: `/sites/${s.siteId}/admin-mode/stats`,
            },
          ];
        } else if (empty && !news) {
          // P3-1: сутки пустые, раздел не достался — сводку из нулей не шлём.
          continue;
        }
      }
      const n = await sendToMembers({
        chatIds: [mem.telegramId],
        text,
        button,
        ...(moreButtons.length ? { moreButtons } : {}),
        env: this.env,
        fetchImpl: this.fetchImpl,
      });
      if (withWeekly && weeklyFor && n === 0) {
        await this.adminWeekly
          ?.release(s.accountId, weeklyFor.id, mem.telegramId)
          .catch(() => undefined);
      }
      sent += n;
    }
    return { weekly, sent };
  }
}
