/**
 * Монитор голосового управления в бою Т-4 — `assist-voice-monitor` ТЗ
 * (§5-бис.14, §5-бис.12 «канарейка»; решение владельца 03.10.2026 п.1).
 * Отдельного крона НЕТ (Vercel Hobby — кроны экономно): проход зовёт
 * существующий крон `GET /cron/assist-analytics-run` (каждые 10 минут —
 * «деградация ≤ 15 мин после порога» выполняется). Основная роль: читает и
 * пишет все кабинеты (system — как остальные кроны), строки кабинета — с
 * тенантом.
 *
 * За проход:
 *  1. конец переходного периода (решение п.1): `on` без отчёта мастера и
 *     срок вышел → `test` (молча не выключаем: 14 дней баннера в TMA);
 *  2. нарушения запрета (последний рубеж публичного кода уже перевёл сайт в
 *     `off` функцией базы): инцидент, владельцам и в служебный канал; на
 *     ≥ 2 сайтах за сутки — дефект нашего кода: рубильник голосового
 *     управления ВСЕЙ платформы (настройка `voice-control`);
 *  3. метрики 24 ч по сайтам в `on`: тревога владельцу (раз в сутки на вид)
 *     или авто-деградация в `degraded` (подсветка и «нажмите здесь»);
 *  4. канарейка выпуска чанков: падение `done` > 10 п.п. против стабильного
 *     или нарушение на канарейке → откат (`canary: null`);
 *  5. контрольные команды: из отчёта мастера и до 20 частых успешных
 *     команд боя (Т-3 их разрешает — с общим QA-воркером, отложен);
 *  6. срок журнала монитора — 90 дней;
 *  7. (е) мемо «требует проверки» (§5-бис.17 п.8): элемент шага устарел
 *     (Ш4, по виду), сбой/`pinMismatch` на шаге у ≥ 3 разных посетителей и
 *     хешей IP за 7 дней, успех цели < 60% на ≥ 10 запусках — мемо в
 *     `needs_review` (в бою не исполняется), владельцу — сигнал; само-
 *     лечения нет. (д) Тревога «возврат полей не удаётся» — в п.3.
 * Служебный канал — `ASSIST_OPS_CHAT_ID` (Telegram, тот же бот помощника);
 * нет — только лог.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  readVoiceControlPlatform,
  readWidgetRelease,
  writePlatformSetting,
  VOICE_CONTROL_SETTINGS_KEY,
  WIDGET_RELEASE_KEY,
} from '../../../common/voice-control-platform';
import { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import {
  recipients,
  sendToMembers,
  type FetchLike,
} from '../../assist-knowledge-core/notify';
import { MEMO_REVIEW, parseMemoContent } from '../../assist-ui-core/memo';
import { pathMatches } from '../../assist-ui-core/rules';
import {
  computeMetrics,
  decideCanary,
  decideMemoReview,
  decideSite,
  MONITOR_THRESHOLDS,
  platformTrip,
  type MonitorCode,
  type SiteVoiceMetrics,
} from '../monitor-rules';
import { loadWindow, siteMetrics } from './voice-monitor-store';

export interface VoiceMonitorResult {
  transitions: number;
  violations: number;
  platformOff: boolean;
  alerts: number;
  degraded: number;
  rolledBack: boolean;
  commands: number;
  /** (е) Мемо, переведённых в «требует проверки» за проход. */
  memoReviews: number;
}

const DAY = 24 * 60 * 60_000;

/** Текст уведомлений — без ПД (только коды, проценты, ссылка в TMA). */
const OWNER_TEXT: Record<string, string> = {
  transition:
    'Голосове керування сайтом переведено в режим «Тест»: перевірку (майстер) не пройдено за 14 днів. Пройдіть перевірку — це кілька хвилин.',
  violation:
    'Голосове керування сайтом ВИМКНЕНО: помічник спробував дію з категорії «ніколи». Ми розбираємось; увімкнути знову можна після нової перевірки.',
  degraded:
    'Голосове керування сайтом працює погано — переведено в режим підказки (лише підсвічує). Пройдіть перевірку ще раз, щоб повернути натискання.',
  alert:
    'Голосове керування сайтом працює погано на частині сторінок. Перегляньте промахи і пройдіть перевірку ще раз.',
  undo_low:
    'Помічник не може повернути поля після збою — розмітка відміни на сайті, схоже, застаріла. Перевірте сторінки з формами.',
  memo_review:
    'Мемо М-{n} потребує перевірки: сайт змінився або мемо часто не доходить до мети. Поки що помічник виконує команди звичайним шляхом. Відкрийте «Голос → Мемо».',
};

@Injectable()
export class VoiceMonitorService {
  private readonly logger = new Logger(VoiceMonitorService.name);
  now: () => Date = () => new Date();
  env: NodeJS.ProcessEnv = process.env;
  /** Подмена отправки — только тестами. */
  fetchImpl: FetchLike | undefined;
  /** Только тесты: кабинеты прохода (наборы на общей базе идут параллельно). */
  onlyAccountIds: string[] | null = null;
  /**
   * Только тесты: свои ключи настроек платформы — рубильник и выпуски общие
   * для всех наборов на одной базе (и кэшируются 30 с в каждом процессе).
   */
  platformKey: string = VOICE_CONTROL_SETTINGS_KEY;
  releaseKey: string = WIDGET_RELEASE_KEY;

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly prisma: PrismaService,
  ) {}

  private sys(): PrismaService {
    return this.sitesDb.system(
      'монитор голосового управления Т-4: сайты всех кабинетов',
    );
  }

  private scope(): Prisma.AssistSiteWhereInput {
    return this.onlyAccountIds
      ? { accountId: { in: this.onlyAccountIds } }
      : {};
  }

  async run(): Promise<VoiceMonitorResult> {
    const now = this.now();
    const out: VoiceMonitorResult = {
      transitions: 0,
      violations: 0,
      platformOff: false,
      alerts: 0,
      degraded: 0,
      rolledBack: false,
      commands: 0,
      memoReviews: 0,
    };
    out.transitions = await this.transitions(now);
    const v = await this.violations(now);
    out.violations = v.sites;
    out.platformOff = v.platformOff;
    const m = await this.metrics(now);
    out.alerts = m.alerts;
    out.degraded = m.degraded;
    out.rolledBack = await this.canary(now);
    out.commands = await this.commands(now);
    out.memoReviews = await this.memoReviews(now);
    await this.sys().assistSiteVoiceIncident.deleteMany({
      where: {
        createdAt: {
          lt: new Date(now.getTime() - MONITOR_THRESHOLDS.incidentRetentionMs),
        },
      },
    });
    if (
      out.transitions ||
      out.violations ||
      out.alerts ||
      out.degraded ||
      out.rolledBack ||
      out.platformOff
    )
      this.logger.log(
        `голосовое управление: переход→test ${out.transitions}, нарушений ${out.violations}, тревог ${out.alerts}, деградаций ${out.degraded}, откат канарейки ${out.rolledBack}, рубильник ${out.platformOff}`,
      );
    return out;
  }

  // ── уведомления и журнал ────────────────────────────────────────────────

  private async notifyOwners(
    accountId: string,
    siteId: string,
    text: string,
  ): Promise<number> {
    return sendToMembers({
      chatIds: await recipients(
        this.sitesDb,
        accountId,
        (m) => m.role === 'owner' || m.productRoles.assist === 'manager',
      ),
      text,
      button: { text: 'Відкрити', hashPath: `/sites/${siteId}/persona` },
      env: this.env,
      fetchImpl: this.fetchImpl,
    });
  }

  /** Служебный канал платформы (ASSIST_OPS_CHAT_ID); без него — лог. */
  private async notifyOps(text: string): Promise<number> {
    const raw = this.env.ASSIST_OPS_CHAT_ID?.trim();
    if (!raw || !/^-?\d{1,20}$/.test(raw)) {
      this.logger.warn(
        `служебный канал не задан (ASSIST_OPS_CHAT_ID): ${text}`,
      );
      return 0;
    }
    return sendToMembers({
      chatIds: [BigInt(raw)],
      text,
      button: { text: 'TMA', hashPath: '/' },
      env: this.env,
      fetchImpl: this.fetchImpl,
    });
  }

  private async incident(p: {
    accountId: string | null;
    siteId: string | null;
    kind: string;
    code: string;
    metrics?: unknown;
    notified: number;
  }): Promise<void> {
    await this.sys().assistSiteVoiceIncident.create({
      data: {
        accountId: p.accountId,
        siteId: p.siteId,
        kind: p.kind,
        code: p.code,
        metrics: (p.metrics ?? null) as Prisma.InputJsonValue,
        notified: p.notified,
      },
    });
  }

  // ── 1. переходный период ────────────────────────────────────────────────

  private async transitions(now: Date): Promise<number> {
    const due = await this.sys().assistSite.findMany({
      where: {
        ...this.scope(),
        voiceControlSiteState: 'on',
        voiceControlSiteTestId: null,
        voiceControlCheckDeadline: { lte: now },
      },
      select: { accountId: true, siteId: true },
      take: MONITOR_THRESHOLDS.sitesPerRun,
    });
    let n = 0;
    for (const s of due) {
      const r = await this.sitesDb
        .forAccount(s.accountId)
        .assistSite.updateMany({
          where: {
            siteId: s.siteId,
            voiceControlSiteState: 'on',
            voiceControlSiteTestId: null,
          },
          data: {
            voiceControlSiteState: 'test',
            voiceControlSiteStateAt: now,
            voiceControlSiteStateBy: 'transition',
            voiceControlSiteStateReason: 'transition_expired',
            voiceControlCheckDeadline: null,
          },
        });
      if (!r.count) continue;
      n++;
      const notified = await this.notifyOwners(
        s.accountId,
        s.siteId,
        OWNER_TEXT.transition,
      );
      await this.incident({
        accountId: s.accountId,
        siteId: s.siteId,
        kind: 'transition',
        code: 'transition_expired',
        notified,
      });
    }
    return n;
  }

  // ── 2. нарушения запрета ────────────────────────────────────────────────

  private async violations(
    now: Date,
  ): Promise<{ sites: number; platformOff: boolean }> {
    const since = new Date(now.getTime() - MONITOR_THRESHOLDS.windowMs);
    const rows = await this.sys().assistSiteUiActionLog.findMany({
      where: {
        action: 'violation',
        createdAt: { gte: since },
        ...(this.onlyAccountIds
          ? { accountId: { in: this.onlyAccountIds } }
          : {}),
      },
      select: { accountId: true, siteId: true, reason: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });
    const bySite = new Map<
      string,
      { accountId: string; last: Date; reasons: Set<string> }
    >();
    for (const r of rows) {
      const e = bySite.get(r.siteId) ?? {
        accountId: r.accountId,
        last: r.createdAt,
        reasons: new Set<string>(),
      };
      e.last = r.createdAt;
      if (r.reason) e.reasons.add(r.reason);
      bySite.set(r.siteId, e);
    }
    let fresh = 0;
    for (const [siteId, e] of bySite) {
      const seen = await this.sys().assistSiteVoiceIncident.findFirst({
        where: {
          siteId,
          kind: 'off',
          code: 'violation',
          createdAt: { gte: e.last },
        },
        select: { id: true },
      });
      if (seen) continue;
      // Предохранитель публичного кода уже выключил; здесь — на случай
      // сбоя функции (и тестовой сессии) — то же условным UPDATE.
      await this.sitesDb.forAccount(e.accountId).assistSite.updateMany({
        where: { siteId, NOT: { voiceControlSiteState: 'off' } },
        data: {
          voiceControlSiteState: 'off',
          voiceControlSiteTestId: null,
          voiceControlSiteStateAt: now,
          voiceControlSiteStateBy: 'violation',
          voiceControlSiteStateReason: 'violation',
        },
      });
      fresh++;
      const notified =
        (await this.notifyOwners(e.accountId, siteId, OWNER_TEXT.violation)) +
        (await this.notifyOps(
          `ІНЦИДЕНТ голосового керування: порушення заборони на сайті ${siteId} (${[...e.reasons].join(',')}). Сайт вимкнено.`,
        ));
      await this.incident({
        accountId: e.accountId,
        siteId,
        kind: 'off',
        code: 'violation',
        metrics: { reasons: [...e.reasons] },
        notified,
      });
    }
    // Нарушения на ≥ 2 сайтах (в ≥ 2 кабинетах) за сутки — дефект кода, а
    // не одного сайта или кабинета.
    let platformOff = false;
    if (platformTrip([...bySite.values()])) {
      const cur = await readVoiceControlPlatform(
        this.prisma,
        now.getTime(),
        this.platformKey,
      );
      // Аудит (г) 03.10: оператор включил платформу после разбора — те же
      // нарушения окна (24 ч) не выключают её снова на следующем проходе;
      // считаются только нарушения НОВЕЕ этого включения.
      const since = cur.at ? Date.parse(cur.at) : 0;
      const recent = [...bySite.values()].filter(
        (e) => e.last.getTime() > since,
      );
      if (cur.enabled && platformTrip(recent)) {
        await writePlatformSetting(
          this.prisma,
          this.platformKey,
          { enabled: false, reason: 'violation_sites', at: now.toISOString() },
          'monitor',
        );
        platformOff = true;
        const notified = await this.notifyOps(
          `РУБИЛЬНИК: голосове керування вимкнено на всій платформі — порушення заборони на ${bySite.size} сайтах за добу. Увімкнення — лише оператором після розбору.`,
        );
        await this.incident({
          accountId: null,
          siteId: null,
          kind: 'platform_off',
          code: 'violation_sites',
          metrics: { sites: bySite.size },
          notified,
        });
      }
    }
    return { sites: fresh, platformOff };
  }

  // ── 3. метрики и пороги ─────────────────────────────────────────────────

  private async metrics(
    now: Date,
  ): Promise<{ alerts: number; degraded: number }> {
    const sites = await this.sys().assistSite.findMany({
      where: { ...this.scope(), voiceControlSiteState: 'on' },
      select: { accountId: true, siteId: true },
      take: MONITOR_THRESHOLDS.sitesPerRun,
    });
    let alerts = 0;
    let degraded = 0;
    for (const s of sites) {
      try {
        const db = this.sitesDb.forAccount(s.accountId);
        const m = await siteMetrics(db, s.siteId, now);
        const d = decideSite(m, 'on');
        if (d.action === 'degrade') {
          const r = await db.assistSite.updateMany({
            where: { siteId: s.siteId, voiceControlSiteState: 'on' },
            data: {
              voiceControlSiteState: 'degraded',
              voiceControlSiteStateAt: now,
              voiceControlSiteStateBy: 'monitor',
              voiceControlSiteStateReason: d.codes[0],
            },
          });
          if (!r.count) continue;
          degraded++;
          const notified =
            (await this.notifyOwners(
              s.accountId,
              s.siteId,
              OWNER_TEXT.degraded,
            )) +
            (await this.notifyOps(
              `Голосове керування: сайт ${s.siteId} → режим підказки (${d.codes.join(',')}; планів ${m.plans}, done ${pct(m.done, m.plans)}).`,
            ));
          await this.incident({
            accountId: s.accountId,
            siteId: s.siteId,
            kind: 'degraded',
            code: d.codes[0],
            metrics: summary(m, d.codes),
            notified,
          });
        } else if (d.action === 'alert') {
          if (await this.recentlyAlerted(s.siteId, d.codes[0], now)) continue;
          alerts++;
          const notified = await this.notifyOwners(
            s.accountId,
            s.siteId,
            d.codes.length === 1 && d.codes[0] === 'undo_low'
              ? OWNER_TEXT.undo_low
              : OWNER_TEXT.alert,
          );
          await this.incident({
            accountId: s.accountId,
            siteId: s.siteId,
            kind: 'alert',
            code: d.codes[0],
            metrics: summary(m, d.codes),
            notified,
          });
        }
      } catch (e) {
        // Один сломанный сайт не останавливает проход.
        this.logger.error(`монитор ${s.siteId}: ${(e as Error).name}`);
      }
    }
    return { alerts, degraded };
  }

  // ── 7. мемо: «требует проверки» ────────────────────────────────────────

  private async memoReviews(now: Date): Promise<number> {
    const since = new Date(now.getTime() - MEMO_REVIEW.windowMs);
    const memos = await this.sys().assistSiteMemo.findMany({
      where: {
        status: 'published',
        ...(this.onlyAccountIds
          ? { accountId: { in: this.onlyAccountIds } }
          : {}),
      },
      select: {
        id: true,
        accountId: true,
        siteId: true,
        number: true,
        view: true,
        staleViews: true,
        publishedVersion: true,
      },
      take: 2_000,
    });
    let changed = 0;
    for (const memo of memos) {
      try {
        const db = this.sitesDb.forAccount(memo.accountId);
        const ver = await db.assistSiteMemoVersion.findFirst({
          where: { memoId: memo.id, number: memo.publishedVersion ?? -1 },
          select: { content: true },
        });
        if (!ver) continue;
        const content = parseMemoContent(ver.content).content;
        // (1) Ш4: элементы шагов, устаревшие для вида.
        const els = await db.siteUiElement.findMany({
          where: {
            siteId: memo.siteId,
            OR: [
              { staleDesktopAt: { not: null } },
              { staleMobileAt: { not: null } },
            ],
          },
          select: {
            id: true,
            path: true,
            elementKey: true,
            staleDesktopAt: true,
            staleMobileAt: true,
          },
          take: 5_000,
        });
        const staleViews: Array<'desktop' | 'mobile'> = [];
        for (const st of content.steps) {
          if (!st.target) continue;
          const pin = st.target.pin;
          const key = pin.assistId
            ? `a:${pin.assistId}`
            : pin.role
              ? `r:${pin.role}|${pin.text.toLowerCase()}`
              : null;
          for (const e of els) {
            const same =
              (st.target.uiElementId && e.id === st.target.uiElementId) ||
              (key !== null &&
                e.elementKey === key &&
                pathMatches(e.path, st.page));
            if (!same) continue;
            if (e.staleDesktopAt) staleViews.push('desktop');
            if (e.staleMobileAt) staleViews.push('mobile');
          }
        }
        // (4)–(5) Сбои по шагам и успех цели за 7 дней (без тестовых сессий)
        // — только ОПУБЛИКОВАННОЙ версии (аудит 03.10): сбои старой версии,
        // из-за которых мемо уже было «требует проверки», не возвращают
        // туда исправленную версию сразу после публикации.
        const plans = await db.assistSiteUiPlan.findMany({
          where: {
            siteId: memo.siteId,
            memoId: memo.id,
            memoVersion: memo.publishedVersion ?? -1,
            voiceTestId: null,
            createdAt: { gte: since },
          },
          select: {
            id: true,
            visitorId: true,
            goalStatus: true,
            conversation: { select: { ipHash: true } },
          },
          take: 5_000,
        });
        const byPlan = new Map(plans.map((p) => [p.id, p]));
        const logs = plans.length
          ? await db.assistSiteUiActionLog.findMany({
              where: { planId: { in: plans.map((p) => p.id) } },
              select: {
                planId: true,
                stepIndex: true,
                action: true,
                result: true,
                pinMismatch: true,
              },
              take: 50_000,
            })
          : [];
        const failures = new Map<
          number,
          { visitors: Set<string>; ips: Set<string>; pin: boolean }
        >();
        for (const l of logs) {
          const bad =
            l.pinMismatch ||
            ((l.result === 'failed' || l.result === 'manual') &&
              ![
                'plan',
                'refused',
                'violation',
                'undo',
                'stop',
                'confirm',
              ].includes(l.action));
          if (!bad) continue;
          const p = byPlan.get(l.planId);
          if (!p) continue;
          const f = failures.get(l.stepIndex) ?? {
            visitors: new Set<string>(),
            ips: new Set<string>(),
            pin: false,
          };
          f.visitors.add(p.visitorId);
          if (p.conversation?.ipHash) f.ips.add(p.conversation.ipHash);
          if (l.pinMismatch) f.pin = true;
          failures.set(l.stepIndex, f);
        }
        const withGoal = plans.filter((p) => p.goalStatus !== null);
        const d = decideMemoReview({
          view:
            memo.view === 'desktop' || memo.view === 'mobile'
              ? memo.view
              : 'any',
          staleViews,
          stepFailures: failures,
          goalRuns: withGoal.length,
          goalReached: withGoal.filter((p) => p.goalStatus === 'reached')
            .length,
          thresholds: MEMO_REVIEW,
        });
        const sameStale =
          JSON.stringify([...(memo.staleViews ?? [])].sort()) ===
          JSON.stringify([...d.staleViews].sort());
        if (!d.review) {
          if (!sameStale)
            await db.assistSiteMemo.updateMany({
              where: { id: memo.id, status: 'published' },
              data: { staleViews: d.staleViews },
            });
          continue;
        }
        const r = await db.assistSiteMemo.updateMany({
          where: { id: memo.id, status: 'published' },
          data: {
            status: 'needs_review',
            staleViews: d.staleViews,
            reviewReason: {
              code: d.review.code,
              step: d.review.step,
              at: now.toISOString(),
            },
          },
        });
        if (!r.count) continue;
        changed++;
        const notified = await this.notifyOwners(
          memo.accountId,
          memo.siteId,
          OWNER_TEXT.memo_review.replace('{n}', String(memo.number)),
        );
        await this.incident({
          accountId: memo.accountId,
          siteId: memo.siteId,
          kind: 'memo_review',
          code: d.review.code,
          metrics: {
            memo: memo.number,
            step: d.review.step,
            runs: withGoal.length,
          },
          notified,
        });
      } catch (e) {
        this.logger.error(`монитор мемо ${memo.siteId}: ${(e as Error).name}`);
      }
    }
    return changed;
  }

  private async recentlyAlerted(
    siteId: string,
    code: MonitorCode,
    now: Date,
  ): Promise<boolean> {
    const r = await this.sys().assistSiteVoiceIncident.findFirst({
      where: {
        siteId,
        kind: 'alert',
        code,
        createdAt: {
          gte: new Date(now.getTime() - MONITOR_THRESHOLDS.alertDedupMs),
        },
      },
      select: { id: true },
    });
    return !!r;
  }

  // ── 4. канарейка ────────────────────────────────────────────────────────

  private async canary(now: Date): Promise<boolean> {
    const rel = await readWidgetRelease(
      this.prisma,
      now.getTime(),
      this.releaseKey,
    );
    if (!rel.canary || !rel.stable) return false;
    const since = new Date(
      Math.max(
        now.getTime() - MONITOR_THRESHOLDS.windowMs,
        rel.canarySince ? Date.parse(rel.canarySince) : 0,
      ),
    );
    const sys = this.sys();
    const [c, st] = await Promise.all([
      loadWindow(sys, { since, release: rel.canary }),
      loadWindow(sys, { since, release: rel.stable }),
    ]);
    const cm = computeMetrics(c.plans, c.logs);
    const sm = computeMetrics(st.plans, st.logs);
    const d = decideCanary({
      canary: { plans: cm.plans, done: cm.done, violations: cm.violations },
      stable: { plans: sm.plans, done: sm.done },
    });
    if (!d.rollback || !d.code) return false;
    await writePlatformSetting(
      this.prisma,
      this.releaseKey,
      {
        ...rel,
        canary: null,
        canarySince: null,
        rolledBack: {
          release: rel.canary,
          at: now.toISOString(),
          reason: d.code,
        },
      },
      'monitor',
    );
    const notified = await this.notifyOps(
      `ОТКАТ канарейки виджета ${rel.canary} → ${rel.stable} (${d.code}): done ${pct(cm.done, cm.plans)} против ${pct(sm.done, sm.plans)}.`,
    );
    await this.incident({
      accountId: null,
      siteId: null,
      kind: 'rollback',
      code: d.code,
      metrics: {
        canary: rel.canary,
        stable: rel.stable,
        canaryPlans: cm.plans,
        canaryDone: cm.done,
        stablePlans: sm.plans,
        stableDone: sm.done,
      },
      notified,
    });
    return true;
  }

  // ── 5. контрольные команды (для Т-3) ────────────────────────────────────

  private async commands(now: Date): Promise<number> {
    const sites = await this.sys().assistSite.findMany({
      where: {
        ...this.scope(),
        voiceControlSiteState: { in: ['on', 'degraded', 'test'] },
      },
      select: { accountId: true, siteId: true },
      take: MONITOR_THRESHOLDS.sitesPerRun,
    });
    let n = 0;
    for (const s of sites) {
      const db = this.sitesDb.forAccount(s.accountId);
      // Раз в сутки на сайт.
      const fresh = await db.assistSiteVoiceControlCommand.findFirst({
        where: {
          siteId: s.siteId,
          createdAt: { gte: new Date(now.getTime() - DAY) },
        },
        select: { id: true },
      });
      if (fresh) continue;
      const test = await db.assistSiteVoiceTest.findFirst({
        where: { siteId: s.siteId, kind: 'wizard', reportedAt: { not: null } },
        orderBy: { reportedAt: 'desc' },
        select: { id: true },
      });
      const fromTest = test
        ? await db.assistSiteUiPlan.findMany({
            where: { siteId: s.siteId, voiceTestId: test.id },
            select: {
              utteranceMasked: true,
              pageUrl: true,
              lang: true,
              steps: true,
            },
            take: 10,
          })
        : [];
      const top = await db.assistSiteUiPlan.groupBy({
        by: ['utteranceMasked', 'pageUrl'],
        where: {
          siteId: s.siteId,
          voiceTestId: null,
          status: 'done',
          createdAt: { gte: new Date(now.getTime() - 30 * DAY) },
        },
        _count: { _all: true },
        orderBy: { _count: { id: 'desc' } },
        take: 20,
      });
      const rows: Array<{
        origin: 'wizard' | 'production_top';
        utteranceMasked: string;
        pageUrl: string;
        lang: string | null;
        steps: unknown;
      }> = fromTest.map((p) => ({ origin: 'wizard' as const, ...p }));
      for (const t of top) {
        if (t._count._all < 2) continue;
        const p = await db.assistSiteUiPlan.findFirst({
          where: {
            siteId: s.siteId,
            voiceTestId: null,
            status: 'done',
            utteranceMasked: t.utteranceMasked,
            pageUrl: t.pageUrl,
          },
          orderBy: { createdAt: 'desc' },
          select: {
            utteranceMasked: true,
            pageUrl: true,
            lang: true,
            steps: true,
          },
        });
        if (p) rows.push({ origin: 'production_top', ...p });
      }
      // Набор — заново раз в сутки: «частые» меняются, отчёт мастера — новый.
      const data: Prisma.AssistSiteVoiceControlCommandCreateManyInput[] = [];
      const keys = new Set<string>();
      for (const r of rows) {
        const expected = descriptors(r.steps);
        if (!expected.length) continue;
        let path = '/';
        try {
          path = new URL(r.pageUrl).pathname;
        } catch {
          /* адрес уже маскирован и разобран при плане */
        }
        const utt = r.utteranceMasked.slice(0, 600);
        const k = `${r.origin}\n${path}\n${utt}`;
        if (keys.has(k)) continue;
        keys.add(k);
        data.push({
          accountId: s.accountId,
          siteId: s.siteId,
          testId: r.origin === 'wizard' ? (test?.id ?? null) : null,
          pagePath: path,
          utteranceMasked: utt,
          lang: r.lang,
          expected: expected as Prisma.InputJsonValue,
          origin: r.origin,
        });
      }
      if (!data.length) continue;
      await db.assistSiteVoiceControlCommand.deleteMany({
        where: { siteId: s.siteId },
      });
      await db.assistSiteVoiceControlCommand.createMany({ data });
      n += data.length;
    }
    return n;
  }
}

/** Дескрипторы целей шагов (роль, видимый текст, `data-assist-id`) — без значений. */
export function descriptors(
  raw: unknown,
): Array<{ kind: string; role: unknown; text: unknown; assistId: unknown }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (s): s is { kind: string; target: Record<string, unknown> | null } =>
        !!s &&
        typeof s === 'object' &&
        typeof (s as { kind?: unknown }).kind === 'string',
    )
    .filter((s) => s.target && typeof s.target === 'object')
    .map((s) => ({
      kind: s.kind,
      role: s.target!.role ?? null,
      text: s.target!.text ?? null,
      assistId: s.target!.assistId ?? null,
    }))
    .slice(0, 15);
}

function pct(n: number, d: number): string {
  return d ? `${Math.round((100 * n) / d)}%` : '—';
}

function summary(m: SiteVoiceMetrics, codes: string[]) {
  return { ...m, codes };
}
