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
  recipientsWithLang,
  sendToMembers,
  sendToMembersByLang,
  type FetchLike,
  type NotifyLang,
} from '../../assist-knowledge-core/notify';
import {
  MEMO_REVIEW,
  parseMemoContent,
  planIpOf,
} from '../../assist-ui-core/memo';
import { pathMatches } from '../../assist-ui-core/rules';
import {
  cursorPage,
  decideCanary,
  decideMemoReview,
  decideSite,
  MONITOR_THRESHOLDS,
  notHeardLangs,
  platformTrip,
  type MonitorCode,
  type SiteVoiceMetrics,
} from '../monitor-rules';
import {
  canaryAggregates,
  readSttCounters,
  siteMetrics,
} from './voice-monitor-store';

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

/**
 * Текст уведомлений — без ПД (только коды, проценты, ссылка в TMA). Язык —
 * получателя (`assist_bot_users.languageCode`, иначе uk; Р-З9-7, заход 9 —
 * аудит (г) (7)).
 */
export const OWNER_TEXT: Record<
  | 'transition'
  | 'violation'
  | 'degraded'
  | 'alert'
  | 'undo_low'
  | 'not_heard'
  | 'memo_review',
  Record<NotifyLang, string>
> = {
  transition: {
    uk: 'Голосове керування сайтом переведено в режим «Тест»: перевірку (майстер) не пройдено за 14 днів. Пройдіть перевірку — це кілька хвилин.',
    ru: 'Голосовое управление сайтом переведено в режим «Тест»: проверка (мастер) не пройдена за 14 дней. Пройдите проверку — это несколько минут.',
    en: 'Site voice control was switched to “Test”: the check (wizard) was not passed within 14 days. Run the check — it takes a few minutes.',
  },
  violation: {
    uk: 'Голосове керування сайтом ВИМКНЕНО: помічник спробував дію з категорії «ніколи». Ми розбираємось; увімкнути знову можна після нової перевірки.',
    ru: 'Голосовое управление сайтом ВЫКЛЮЧЕНО: помощник попытался выполнить действие из категории «никогда». Мы разбираемся; включить снова можно после новой проверки.',
    en: 'Site voice control is OFF: the assistant attempted an action from the “never” category. We are investigating; it can be re-enabled after a new check.',
  },
  degraded: {
    uk: 'Голосове керування сайтом працює погано — переведено в режим підказки (лише підсвічує). Пройдіть перевірку ще раз, щоб повернути натискання.',
    ru: 'Голосовое управление сайтом работает плохо — переведено в режим подсказки (только подсвечивает). Пройдите проверку ещё раз, чтобы вернуть нажатия.',
    en: 'Site voice control is performing poorly — switched to hint mode (highlight only). Run the check again to restore clicking.',
  },
  alert: {
    uk: 'Голосове керування сайтом працює погано на частині сторінок. Перегляньте промахи і пройдіть перевірку ще раз.',
    ru: 'Голосовое управление сайтом работает плохо на части страниц. Посмотрите промахи и пройдите проверку ещё раз.',
    en: 'Site voice control is performing poorly on some pages. Review the misses and run the check again.',
  },
  undo_low: {
    uk: 'Помічник не може повернути поля після збою — розмітка відміни на сайті, схоже, застаріла. Перевірте сторінки з формами.',
    ru: 'Помощник не может вернуть поля после сбоя — разметка отмены на сайте, похоже, устарела. Проверьте страницы с формами.',
    en: 'The assistant cannot restore fields after a failure — the undo markup on the site seems outdated. Check the pages with forms.',
  },
  not_heard: {
    uk: 'Помічник часто «не розчув» голосові команди ({langs}): понад 30% за добу. Ймовірно, шум або мікрофон відвідувачів; перевірте мови голосу в налаштуваннях.',
    ru: 'Помощник часто «не расслышал» голосовые команды ({langs}): больше 30% за сутки. Вероятно, шум или микрофон посетителей; проверьте языки голоса в настройках.',
    en: 'The assistant often “didn’t catch” voice commands ({langs}): over 30% in 24 hours. Likely noise or visitors’ microphones; check the voice languages in settings.',
  },
  memo_review: {
    uk: 'Мемо М-{n} потребує перевірки: сайт змінився або мемо часто не доходить до мети. Поки що помічник виконує команди звичайним шляхом. Відкрийте «Голос → Мемо».',
    ru: 'Мемо М-{n} требует проверки: сайт изменился или мемо часто не доходит до цели. Пока помощник выполняет команды обычным путём. Откройте «Голос → Мемо».',
    en: 'Memo M-{n} needs review: the site changed or the memo often fails to reach its goal. Meanwhile the assistant runs commands the usual way. Open “Voice → Memos”.',
  },
};

const OPEN_BUTTON: Record<NotifyLang, string> = {
  uk: 'Відкрити',
  ru: 'Открыть',
  en: 'Open',
};

/** Тексты уведомления на три языка с подстановкой `{n}`/`{langs}`. */
export function ownerTexts(
  key: keyof typeof OWNER_TEXT,
  vars: Record<string, string> = {},
): Record<NotifyLang, { text: string; button: string }> {
  const out = {} as Record<NotifyLang, { text: string; button: string }>;
  for (const l of ['uk', 'ru', 'en'] as const) {
    let t = OWNER_TEXT[key][l];
    for (const [k, v] of Object.entries(vars)) t = t.split(`{${k}}`).join(v);
    out[l] = { text: t, button: OPEN_BUTTON[l] };
  }
  return out;
}

/** Ключ настройки платформы с курсором шага прохода (аудит (г) (1)). */
export const MONITOR_CURSOR_KEY = 'voice-monitor-cursor';

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
  /** Только тесты: свой префикс курсоров и размер страницы прохода. */
  cursorKey: string = MONITOR_CURSOR_KEY;
  sitesPerRun: number = MONITOR_THRESHOLDS.sitesPerRun;

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
    texts: Record<NotifyLang, { text: string; button: string }>,
  ): Promise<number> {
    return sendToMembersByLang({
      recipients: await recipientsWithLang(
        this.sitesDb,
        accountId,
        (m) => m.role === 'owner' || m.productRoles.assist === 'manager',
      ),
      texts,
      hashPath: `/sites/${siteId}/persona`,
      env: this.env,
      fetchImpl: this.fetchImpl,
    });
  }

  /**
   * (заход 9, аудит (г) (1)) Сайты шага прохода по keyset-курсору
   * (`siteId`, по кругу) — при > `sitesPerRun` сайтах остальные не
   * голодают: следующий проход берёт следующую страницу. Курсор — в
   * настройках платформы (`voice-monitor-cursor:<шаг>`), без миграции.
   */
  private async pageOfSites(
    step: 'metrics' | 'commands',
    where: Prisma.AssistSiteWhereInput,
  ): Promise<Array<{ accountId: string; siteId: string }>> {
    const key = `${this.cursorKey}:${step}`;
    const row = await this.prisma.assistPlatformSetting.findUnique({
      where: { key },
      select: { value: true },
    });
    const v = row?.value as { after?: unknown } | null | undefined;
    const cursor = typeof v?.after === 'string' ? v.after : null;
    const q = (w: Prisma.AssistSiteWhereInput) =>
      this.sys().assistSite.findMany({
        where: { ...this.scope(), ...where, ...w },
        select: { accountId: true, siteId: true },
        orderBy: { siteId: 'asc' },
        take: this.sitesPerRun,
      });
    const after = await q(cursor ? { siteId: { gt: cursor } } : {});
    const wrapped =
      cursor && after.length < this.sitesPerRun
        ? await q({ siteId: { lte: cursor } })
        : [];
    const r = cursorPage({ after, wrapped, limit: this.sitesPerRun });
    if (r.cursor !== cursor)
      await this.prisma.assistPlatformSetting.upsert({
        where: { key },
        create: { key, value: { after: r.cursor }, updatedBy: 'monitor' },
        update: { value: { after: r.cursor }, updatedBy: 'monitor' },
      });
    return r.page;
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
        ownerTexts('transition'),
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
        (await this.notifyOwners(
          e.accountId,
          siteId,
          ownerTexts('violation'),
        )) +
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
    const sites = await this.pageOfSites('metrics', {
      voiceControlSiteState: 'on',
    });
    let alerts = 0;
    let degraded = 0;
    for (const s of sites) {
      try {
        const db = this.sitesDb.forAccount(s.accountId);
        const m = await siteMetrics(db, s.siteId, now);
        // (заход 9) «Не расслышал» по языкам — счётчики маршрута голоса.
        m.stt = await readSttCounters(this.sys(), s.siteId, now);
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
              ownerTexts('degraded'),
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
          // (заход 9, P3-3) Дедуп — по КАЖДОМУ коду: новая проблема рядом
          // со старой (уже отправленной сегодня) не теряется.
          const fresh: MonitorCode[] = [];
          for (const c of d.codes)
            if (!(await this.recentlyAlerted(s.siteId, c, now))) fresh.push(c);
          if (!fresh.length) continue;
          alerts++;
          const only = fresh.length === 1 ? fresh[0] : null;
          const notified = await this.notifyOwners(
            s.accountId,
            s.siteId,
            only === 'undo_low'
              ? ownerTexts('undo_low')
              : only === 'not_heard_high'
                ? ownerTexts('not_heard', {
                    langs: notHeardLangs(m.stt).join(', '),
                  })
                : ownerTexts('alert'),
          );
          for (const [k, code] of fresh.entries())
            await this.incident({
              accountId: s.accountId,
              siteId: s.siteId,
              kind: 'alert',
              code,
              metrics: summary(m, d.codes),
              notified: k === 0 ? notified : 0,
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
                reason: true,
                target: true,
                pinMismatch: true,
              },
              take: 50_000,
            })
          : [];
        // Хеш IP плана — из строки `plan` (соль на окно, аудит (7)); у
        // старых планов её нет — хеш диалога.
        const planIp = new Map<string, string>();
        for (const l of logs)
          if (l.action === 'plan') {
            const ip = planIpOf(l.target);
            if (ip) planIp.set(l.planId, ip);
          }
        const failures = new Map<
          number,
          { visitors: Set<string>; ips: Set<string>; pin: boolean }
        >();
        for (const l of logs) {
          // Цель шага мемо не найдена на странице при сборке плана (отказ
          // `no_target` с номером шага мемо) — тоже сбой шага (аудит (5)).
          const missing =
            l.action === 'refused' &&
            l.reason === 'no_target' &&
            typeof (l.target as { memoStep?: unknown } | null)?.memoStep ===
              'number';
          const bad =
            l.pinMismatch ||
            missing ||
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
          const ip = planIp.get(p.id) ?? p.conversation?.ipHash;
          if (ip) f.ips.add(ip);
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
          ownerTexts('memo_review', { n: String(memo.number) }),
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
    // (заход 9, аудит (г) (2)) Агрегаты SQL по выпуску вместо выборки
    // строк (≤ 20 000 — нарушения и планы выпадали при росте платформы);
    // правила те же, что `computeMetrics` (сверка — приёмка e6b).
    const sys = this.sys();
    const [cm, sm] = await Promise.all([
      canaryAggregates(sys, { since, release: rel.canary }),
      canaryAggregates(sys, { since, release: rel.stable }),
    ]);
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
    const sites = await this.pageOfSites('commands', {
      voiceControlSiteState: { in: ['on', 'degraded', 'test'] },
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
