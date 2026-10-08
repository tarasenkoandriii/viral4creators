/**
 * Э-С Ш5: ролики штатной обучалки генератора → ролики сайта тенанта
 * «viral4creators» (виджет платформы на лендинге отвечает действием
 * `video` Э6, как старый консультант — `kind: "video"`).
 *
 * БАРЬЕР ЛЕНДИНГА — тот же, что у консультанта (`assistant.service.ts`,
 * `availableVideoSubjectKeys`/`resolveVideoActions`): только одобренные
 * оператором (`reviewed`), собранные (`blobUrl`) и НЕ ролики обучалки по
 * сайту заказчика (`clientSiteDraftId: null`). Ролик сайта A никогда не
 * попадает на сайт B: условие — в запросе И повторно в коде (строка с
 * `clientSiteDraftId` выбрасывается, даже если запрос её вернул), а в
 * обратную сторону — `ClientSiteMediaService` не даёт привязать к сайту
 * лендинга черновик обучалки по чужому сайту и не шлёт туда их набор.
 * Ролики демо обучающего лендинга (`site-tutorial-demo-*`, витрина-
 * полигон) в набор не идут — тоже в запросе и повторно в коде.
 *
 * Набор — ПОЛНЫЙ (замена, как у Э6): потолки — те же, что у роликов сайтов
 * заказчиков (`SYNC_VIDEOS_MAX` = 60 роликов и `SYNC_BODY_BUDGET` = 60 000 Б
 * тела; маршрут `site-videos` у sites-backend один и принимает ≤ 64 КБ,
 * Р-З10-2 — до захода 10 здесь оставались старые 15 / 7 500 Б, и лендинг
 * отдавал только 15 роликов из 50 — ru и половину uk), поэтому порядок — по
 * языкам лендинга (ru, uk, en, de, es), внутри языка — по номеру шага;
 * последний одобренный на (тема, язык). Поводы:
 * одобрение/снятие одобрения в админке (`TutorialVideoAdminService`) и
 * (Ш5 (12)) удаление одобренного ролика подметальщиком раннера
 * (`sweepOldAssets` → `requestSync`): иначе в тенанте до следующего
 * одобрения висела бы ссылка на стёртый mp4.
 * Никогда не бросает: сбой — в лог, следующий повод пришлёт набор заново.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SitesInternalClient,
  type SitesVideoInput,
} from '../sites-internal/sites-internal.client';
import { landingAssistConfig } from './landing-assist-config';
import { SYNC_BODY_BUDGET, SYNC_VIDEOS_MAX } from './client-site-media.service';
import {
  isSiteTutorialDemoFamilyKey,
  NOT_SITE_TUTORIAL_DEMO_WHERE,
} from '../tutorial-help/site-tutorial-demo';

/**
 * Те же потолки, что у роликов сайтов заказчиков (sites-backend Э6,
 * `media-config.ts` `syncVideosMax: 60`, тело ≤ 64 КБ) — одна константа на
 * оба набора, чтобы они больше не расходились (Р-З10-2).
 */
export const LANDING_SYNC_VIDEOS_MAX = SYNC_VIDEOS_MAX;
export const LANDING_SYNC_BODY_BUDGET = SYNC_BODY_BUDGET;
const LOCALE_ORDER = ['ru', 'uk', 'en', 'de', 'es'];

interface AssetRow {
  id: string;
  subjectKey: string;
  locale: string;
  title: string;
  durationMs: number | null;
  blobUrl: string | null;
  clientSiteDraftId: string | null;
  reviewed: boolean;
}

function subjectOrder(key: string): number {
  return /^\d{1,3}$/.test(key) ? Number(key) : 1000;
}

@Injectable()
export class LandingVideosService {
  private readonly logger = new Logger(LandingVideosService.name);
  env: NodeJS.ProcessEnv = process.env;
  now: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SitesInternalClient,
  ) {}

  /** Набор роликов лендинга для тенанта (барьер лендинга — см. шапку). */
  async collect(
    ownerTelegramId: string,
    hosts: string[],
  ): Promise<SitesVideoInput[]> {
    const rows = (await this.prisma.tutorialVideoAsset.findMany({
      where: {
        reviewed: true,
        blobUrl: { not: null },
        clientSiteDraftId: null,
        // Лендинг светлый — только светлые ролики (заход 3, 06.10.2026:
        // у пары появился тёмный ролик). NULL — строки до колонки темы.
        OR: [{ theme: null }, { theme: 'light' }],
        // Демо обучающего лендинга (`site-tutorial-demo-*`) — ролики
        // витрины-полигона для секции обучающего лендинга, а не обучалка
        // продукта: в набор тенанта не идут (черновик демо, раздел 5.3).
        ...NOT_SITE_TUTORIAL_DEMO_WHERE,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        subjectKey: true,
        locale: true,
        title: true,
        durationMs: true,
        blobUrl: true,
        clientSiteDraftId: true,
        reviewed: true,
      },
    })) as AssetRow[];
    const latest = new Map<string, AssetRow>();
    for (const r of rows) {
      // Повторная проверка барьера в коде: запрос — первая линия, это — вторая.
      if (r.clientSiteDraftId || !r.reviewed || !r.blobUrl) continue;
      if (isSiteTutorialDemoFamilyKey(r.subjectKey)) continue;
      if (!/^[a-z]{2}$/.test(r.locale)) continue;
      const k = `${r.subjectKey}\u001f${r.locale}`;
      if (!latest.has(k)) latest.set(k, r); // строки — от новых к старым
    }
    const rank = (l: string) => {
      const i = LOCALE_ORDER.indexOf(l);
      return i < 0 ? LOCALE_ORDER.length : i;
    };
    const sorted = [...latest.values()].sort(
      (a, b) =>
        rank(a.locale) - rank(b.locale) ||
        subjectOrder(a.subjectKey) - subjectOrder(b.subjectKey) ||
        a.subjectKey.localeCompare(b.subjectKey),
    );
    const out: SitesVideoInput[] = [];
    for (const r of sorted) {
      if (out.length >= LANDING_SYNC_VIDEOS_MAX) break;
      const next: SitesVideoInput = {
        externalId: r.id,
        draftId: 'landing',
        ownerTelegramId,
        title: r.title.slice(0, 120),
        locale: r.locale,
        durationMs: r.durationMs,
        url: r.blobUrl as string,
        requiresLogin: false,
        stepHosts: hosts,
      };
      const size = Buffer.byteLength(
        JSON.stringify({
          siteId: 'x'.repeat(64),
          asOf: 9_999_999_999_999,
          videos: [...out, next],
        }),
        'utf8',
      );
      if (size > LANDING_SYNC_BODY_BUDGET) break;
      out.push(next);
    }
    return out;
  }

  /** Склейка поводов `requestSync` (мс): серия удалений — одна пересылка. */
  debounceMs = 1_000;
  private pending: Promise<boolean> | null = null;
  /** Пересылка уже идёт (окно дебаунса прошло) — новый повод нужен следом. */
  private syncing = false;
  private rerun = false;

  /**
   * Ш5 (12): пересылка набора после удаления одобренного ролика — с
   * дебаунсом: поводы в окне `debounceMs` и во время идущей пересылки
   * склеиваются (одна отправка сейчас + не больше одной следом, если
   * повод пришёл посреди неё — набор читается заново и уже без
   * удалённого). Промис — итог последней пересылки; не бросает никогда
   * (подметальщик не должен падать из-за sites-backend).
   */
  requestSync(): Promise<boolean> {
    if (this.pending) {
      // В окне дебаунса набор ещё не читался — повод уже учтён.
      if (this.syncing) this.rerun = true;
      return this.pending;
    }
    const run = async (): Promise<boolean> => {
      if (this.debounceMs > 0) {
        await new Promise((r) => setTimeout(r, this.debounceMs));
      }
      this.syncing = true;
      let ok = await this.sync();
      while (this.rerun) {
        this.rerun = false;
        ok = await this.sync();
      }
      return ok;
    };
    const p = run()
      .catch(() => false)
      .finally(() => {
        this.syncing = false;
        if (this.pending === p) this.pending = null;
        // Повод между последней проверкой и этой строкой — не потерять.
        if (this.rerun) {
          this.rerun = false;
          void this.requestSync();
        }
      });
    this.pending = p;
    return p;
  }

  /** Полный набор → sites-backend. false — не настроено или сбой. */
  async sync(): Promise<boolean> {
    const cfg = landingAssistConfig(this.env);
    if (!cfg || !this.sites.configured()) return false;
    try {
      const asOf = this.now();
      const videos = await this.collect(cfg.ownerTelegramId, cfg.hosts);
      const res = await this.sites.syncSiteVideos(cfg.siteId, videos, asOf);
      if (res?.rejected?.length) {
        this.logger.warn(
          `ролики лендинга: sites-backend не принял ${res.rejected.length} (${[
            ...new Set(res.rejected.map((r) => r.reason)),
          ].join(', ')})`,
        );
      }
      return true;
    } catch (e) {
      this.logger.warn(
        `ролики лендинга не отправлены: ${e instanceof Error ? e.name : 'error'}`,
      );
      return false;
    }
  }
}
