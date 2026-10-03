/**
 * Публичный конфиг, картинки бренда, пинг загрузчика, обмен токена
 * предпросмотра — W2 (ТЗ §3-бис.1, §3-бис.2, §3-бис.4).
 *
 * config: только ОПУБЛИКОВАННАЯ версия (assist_site_config_versions по
 * assist_sites.widgetVersion), без hosts (вместо них — origin включённых
 * verified-хостов), кэш-заголовок 5 мин; решения о допуске здесь нет.
 * asset: байты из assist_site_assets с `Content-Type` из колонки, nosniff,
 * `Content-Security-Policy: default-src 'none'`, immutable.
 * ping: `GET /widget/v1/ping?pk=&v=&c=0|1` КАРТИНКОЙ (img-src — работает и
 * при CSP без connect-src; `c` — получил ли загрузчик конфиг fetch'ем);
 * origin — из Referer (только origin-часть), upsert assist_site_install_pings
 * (allowed = хост допущен, configFetchOk); ответ — GIF 1×1 всегда (не
 * оракул допуска).
 * preview/exchange: одноразовый условный UPDATE (usedAt IS NULL AND
 * expiresAt > now AND siteId по pk AND origin совпал) → sessionHash.
 *
 * Э3 (W): в конфиге — `engagement` (публичная часть вовлечения
 * опубликованного вида, T: `publicEngagement`; из `config` она убрана —
 * выключенные триггеры наружу не идут), `handoff` (включена ли передача и
 * «~N минут», H: `HandoffIntake.availability`), `goals` (активные цели с
 * детекторами загрузчика, A: `GoalIntake.publicGoals`). Эти части
 * НЕОБЯЗАТЕЛЬНЫ: сбой одной из них — поле отсутствует (лог — имя ошибки),
 * а не 500 на загрузчик всех посетителей сайта.
 *
 * Интеграция Э3: `status: 'lead_only'` и тогда, когда СЕГОДНЯ ответ модели
 * заведомо будет отказан — суточный денежный потолок сайта или платформы
 * исчерпан так, что не влезает даже минимальная оценка ответа, или месячная
 * квота диалогов выбрана (`site_quota`/`platform_budget` конвейера).
 * Загрузчик при этом не показывает проактивные сигналы (§5-тер.12), iframe —
 * сразу форма заявки. Одно чтение трёх строк счётчиков (ровно тех, что
 * резервирует конвейер); ответ кэшируется CDN 5 мин — задержка «квота
 * кончилась/обнулилась → статус» ≤ 5 мин, приемлемо. Ошибка чтения — статус
 * не трогаем (конвейер всё равно откажет сам).
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { WIDGET_POWERED_BY_URL } from '../../brand';
import {
  readWidgetRelease,
  releaseForSite,
} from '../../common/voice-control-platform';
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import {
  previewFrameAncestors,
  widgetOrigin,
  widgetPlatformEnabled,
} from '../../config/widget-env';
import { AssistPublicDb } from '../../prisma/assist-public-db.service';
import {
  defaultLeadsConfig,
  parseLeadsConfig,
  type LeadsConfig,
} from '../assist-site-setup/leads-config';
import type { WidgetConfig } from '../assist-site-setup/widget-config';
import {
  parseEngagementConfig,
  publicEngagement,
} from '../assist-site-setup/engagement-config';
import { GoalIntake } from '../assist-analytics/public/goal-intake.service';
import {
  PLATFORM_KEY,
  answerEstimateMicroUsd,
  utcDay,
} from '../assist-site-chat/budget';
import {
  effectiveLimit,
  readState,
  readUsage,
  siteDailyCapMicroUsd,
} from '../assist-billing/public/entitlements';
import { assistPlanAllows } from '../assist-billing/plans';
import type { SubscriptionState } from '../assist-billing/subscription-state';
import { widgetPlatformDailyCapMicroUsd } from '../../config/widget-env';
import {
  effectivePlatformCapMicroUsd,
  readWidgetPlatformSettings,
} from '../../common/platform-settings';
import { HandoffIntake } from '../assist-site-handoff/public/handoff-intake.service';
import { SiteVoiceService } from '../assist-site-voice/public/site-voice.service';
import { VOICE_DEFAULTS } from '../assist-site-voice/voice-config';
import { SiteUiPlanService } from '../assist-site-voice-control/public/ui-plan.service';
import type { WidgetSiteContext } from '../assist-site-chat/chat-types';
import type {
  WidgetPreviewExchangeRequest,
  WidgetPreviewExchangeResponse,
  WidgetPublicConfig,
} from './api-types';
import { frameAncestors } from './origin-guard';
import {
  allowedOrigins,
  exactOrigin,
  findSiteByKey,
  hostRulesOf,
  isLocalOrigin,
  publishedWidgetConfig,
  sha256Hex,
  siteHostAccess,
  type WidgetSiteRow,
} from './site-access';
import { widgetError } from './widget-errors';

/** Картинки бренда — только растр (контракт Э2 §1 п.13; SVG — отказ). */
export const ASSET_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Подсказки-вопросы из знаний (§3.4): не больше 5, по 200 символов. */
const SUGGESTED_MAX = 5;
const SUGGESTED_MAX_CHARS = 200;

function withoutHosts(
  config: Record<string, unknown>,
): Omit<WidgetConfig, 'hosts'> {
  // engagement — отдельным полем ответа (только включённое, T).
  const { hosts: _hosts, engagement: _engagement, ...rest } = config;
  return rest as unknown as Omit<WidgetConfig, 'hosts'>;
}

/** Контекст сайта для решений без посетителя (доступность передачи). */
function siteContext(
  site: WidgetSiteRow,
  keyKind: 'live' | 'test',
): WidgetSiteContext {
  return {
    accountId: site.accountId,
    siteId: site.siteId,
    knowledgeVersion: site.knowledgeVersion,
    configVersion: site.configVersion,
    widgetVersion: site.widgetVersion,
    parentOrigin: '',
    keyKind,
    preview: false,
  };
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

function leadsOf(raw: unknown): LeadsConfig {
  if (raw !== null && raw !== undefined) {
    const parsed = parseLeadsConfig(raw);
    if (parsed.ok) return parsed.config;
  }
  return defaultLeadsConfig();
}

/** Подсказки из знаний — только для ТЕКУЩЕЙ опубликованной версии базы. */
function suggestedOf(site: WidgetSiteRow): string[] {
  if (site.suggestedForVersion !== site.knowledgeVersion) return [];
  const raw = site.suggestedQuestions;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.slice(0, SUGGESTED_MAX_CHARS))
    .slice(0, SUGGESTED_MAX);
}

/** 1×1 прозрачный GIF — ответ пинга всегда один и тот же. */
export const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

@Injectable()
export class WidgetPublicConfigService {
  private readonly logger = new Logger(WidgetPublicConfigService.name);

  constructor(
    private readonly db: AssistPublicDb,
    private readonly handoff: HandoffIntake,
    private readonly goals: GoalIntake,
    // Э5: голос (микрофон/озвучка) — необязателен для тестов Э2–Э4.
    @Optional() private readonly voice?: SiteVoiceService,
    // Э6-бис: голосовое управление — необязательно для тестов Э2–Э6.
    @Optional() private readonly uiPlans?: SiteUiPlanService,
  ) {}

  async config(
    pk: string,
    now: Date = new Date(),
  ): Promise<WidgetPublicConfig> {
    const found = await findSiteByKey(this.db, pk);
    if (!found) throw widgetError('WIDGET_UNKNOWN_KEY');
    const { site, kind } = found;
    const published = await publishedWidgetConfig(this.db, site);
    if (!published) {
      // Не опубликован — загрузчик не рисует кнопку; вида ещё нет.
      throw widgetError('WIDGET_DISABLED');
    }
    let hosts: WidgetPublicConfig['hosts'] = [];
    if (kind === 'live') {
      const access = await siteHostAccess(this.db, site.siteId, now);
      hosts = allowedOrigins(access, hostRulesOf(published), true).map((h) => ({
        origin: h.origin,
        pathMasks: h.pathMasks,
        hideOn: h.hideOn,
      }));
    }
    const lead = leadsOf(site.leadsConfig);
    // Э4: тариф кабинета — мягкий стоп (лимит единиц выбран, тариф истёк) и
    // право убрать «на базе …» (Business+). Сбой чтения — как раньше:
    // статус не трогаем, конвейер всё равно откажет сам.
    const plan = await readState(this.db, site.accountId, now).catch(
      (err: unknown) => {
        this.logger.warn(
          `plan read failed site=${site.siteId}: ${errName(err)}`,
        );
        return null;
      },
    );
    const platform = await readWidgetPlatformSettings(this.db);
    const leadOnly =
      !widgetPlatformEnabled() ||
      !platform.enabled ||
      !site.enabled ||
      site.chatPaused ||
      site.operatorBlockedAt !== null ||
      (plan !== null && (await this.spentOut(site, now, plan)));
    const config = withoutHosts(published);
    const brand = (published.brand ?? {}) as Record<string, unknown>;
    const out: WidgetPublicConfig = {
      status: leadOnly ? 'lead_only' : 'active',
      widgetVersion: site.widgetVersion,
      config,
      hosts,
      allowClientPreview: site.allowClientPreview,
      lead: { fields: lead.fields, consentText: lead.consentText },
      suggestedQuestions: suggestedOf(site),
      poweredByUrl:
        brand.poweredBy === false &&
        (plan === null || assistPlanAllows(plan.planId, 'removePoweredBy'))
          ? null
          : WIDGET_POWERED_BY_URL,
    };
    await this.addE3(out, published, site, kind, now);
    // Э5 (§4.10): голос — только при активном чате и тарифе с голосом;
    // потолки решаются в момент запроса (кэш конфига — 5 минут).
    if (this.voice && plan && out.status === 'active') {
      try {
        const a = await this.voice.access(site, plan);
        if (a.input || a.output) {
          out.voice = {
            input: a.input,
            output: a.output,
            maxRecordMs: VOICE_DEFAULTS.maxRecordMs,
            minSpeechMs: VOICE_DEFAULTS.minSpeechMs,
            endSilenceMs: VOICE_DEFAULTS.endSilenceMs,
          };
        }
      } catch (err) {
        this.logger.warn(
          `voice access failed site=${site.siteId}: ${errName(err)}`,
        );
      }
    }
    // Э6-бис (г): выпуск чанков (канарейка по хешу siteId) — путь ленивых
    // чанков загрузчика; сбой чтения — без поля (чанки из `/v1/`).
    try {
      const rel = releaseForSite(
        site.siteId,
        await readWidgetRelease(this.db, now.getTime()),
      );
      if (rel) out.release = rel;
    } catch (err) {
      this.logger.warn(
        `release read failed site=${site.siteId}: ${errName(err)}`,
      );
    }
    // Э6-бис (§5-бис.2, §5-бис.11): голосовое управление — только при
    // голосе (микрофон) и переключателе on/degraded; запреты кабинета —
    // загрузчику для снимка (селекторы не секрет: они и так в DOM сайта).
    if (this.uiPlans && plan && out.voice?.input) {
      try {
        const a = await this.uiPlans.access(site, plan);
        if (a.mode && a.rules) {
          out.voiceControl = {
            mode: a.mode,
            denySelectors: a.rules.denySelectors,
            allowSelectors: a.rules.allowSelectors,
            maxSteps: a.rules.maxSteps,
          };
        }
      } catch (err) {
        this.logger.warn(
          `voice control access failed site=${site.siteId}: ${errName(err)}`,
        );
      }
    }
    return out;
  }

  /**
   * Сегодня ответ модели заведомо не пройдёт: остаток суточного потолка
   * сайта или платформы меньше МИНИМАЛЬНОЙ оценки ответа (резерв откажет при
   * любом вопросе), лимит единиц периода подписки выбран (с докупкой и
   * авто-пакетом) или действующего тарифа нет (Э4, мягкий стоп §3.10).
   */
  async spentOut(
    site: Pick<WidgetSiteRow, 'siteId' | 'accountId'>,
    now: Date = new Date(),
    plan?: SubscriptionState,
  ): Promise<boolean> {
    try {
      const state = plan ?? (await readState(this.db, site.accountId, now));
      if (!state.planId) return true;
      const rows = await this.db.$queryRawUnsafe<
        Array<{
          cap: bigint | number | null;
          site_used: bigint | number | null;
          platform_used: bigint | number | null;
        }>
      >(
        `SELECT
           (SELECT "dailyCapMicroUsd" FROM "sites"."assist_sites" WHERE "siteId" = $1) AS cap,
           (SELECT "spentMicroUsd" + "reservedMicroUsd" FROM "sites"."assist_budget_days"
             WHERE "scope" = 'site' AND "key" = $1 AND "day" = $2) AS site_used,
           (SELECT "spentMicroUsd" + "reservedMicroUsd" FROM "sites"."assist_budget_days"
             WHERE "scope" = 'platform' AND "key" = $3 AND "day" = $2) AS platform_used`,
        site.siteId,
        utcDay(now),
        PLATFORM_KEY,
      );
      const r = rows[0];
      if (!r) return false;
      const minAnswer = answerEstimateMicroUsd({
        systemChars: 0,
        historyChars: 0,
        questionChars: 1,
      });
      const siteCap = siteDailyCapMicroUsd(
        r.cap === null ? null : Number(r.cap),
        state,
      );
      const siteUsed = Number(r.site_used ?? 0);
      const platformUsed = Number(r.platform_used ?? 0);
      const usage = await readUsage(this.db, site.accountId, state.periodKey);
      return (
        siteUsed + minAnswer > siteCap ||
        platformUsed + minAnswer >
          effectivePlatformCapMicroUsd(
            widgetPlatformDailyCapMicroUsd(),
            await readWidgetPlatformSettings(this.db),
          ) ||
        usage.units >= effectiveLimit(state, usage)
      );
    } catch (err) {
      this.logger.warn(
        `quota read failed site=${site.siteId}: ${errName(err)}`,
      );
      return false;
    }
  }

  private async addE3(
    out: WidgetPublicConfig,
    published: Record<string, unknown>,
    site: WidgetSiteRow,
    kind: 'live' | 'test',
    now: Date,
  ): Promise<void> {
    if (published.engagement !== undefined && published.engagement !== null) {
      try {
        const parsed = parseEngagementConfig(published.engagement);
        if (parsed.ok) out.engagement = publicEngagement(parsed.config);
        else this.logger.warn(`engagement invalid site=${site.siteId}`);
      } catch (err) {
        this.logger.warn(
          `engagement failed site=${site.siteId}: ${errName(err)}`,
        );
      }
    }
    const [handoff, goals] = await Promise.allSettled([
      this.handoff.availability(siteContext(site, kind), now),
      this.goals.publicGoals(site.siteId),
    ]);
    if (handoff.status === 'fulfilled') {
      const a = handoff.value;
      out.handoff = {
        // «Включена» — настройка владельца; рабочие часы и операторы решает
        // `POST handoff` в момент нажатия (кэш конфига — 5 минут).
        enabled: a.available || a.reason !== 'disabled',
        etaMinutes: a.etaMinutes,
        etaText: a.etaText,
      };
    } else {
      this.logger.warn(
        `handoff availability failed site=${site.siteId}: ${errName(handoff.reason)}`,
      );
    }
    if (goals.status === 'fulfilled') out.goals = goals.value;
    else {
      this.logger.warn(
        `public goals failed site=${site.siteId}: ${errName(goals.reason)}`,
      );
    }
  }

  async asset(
    id: string,
  ): Promise<{ mime: string; bytes: Buffer; sha256: string } | null> {
    if (typeof id !== 'string' || !/^[a-z0-9]{10,40}$/i.test(id)) return null;
    const row = await this.db.assistSiteAsset.findUnique({
      where: { id },
      select: { mime: true, bytes: true, sha256: true },
    });
    if (!row || !(ASSET_MIMES as readonly string[]).includes(row.mime)) {
      return null;
    }
    return {
      mime: row.mime,
      bytes: Buffer.from(row.bytes),
      sha256: row.sha256,
    };
  }

  /**
   * Пинг установки. Пишем только origin, который хоть как-то относится к
   * сайту (любой его хост или localhost у test-ключа): иначе любой мог бы
   * засыпать таблицу строками с выдуманными origin.
   */
  async ping(p: {
    pk: string;
    referer: string | undefined;
    loaderVersion: string | null;
    configFetchOk: boolean | null;
    now?: Date;
  }): Promise<void> {
    const now = p.now ?? new Date();
    let origin: string | null = null;
    try {
      origin = p.referer ? exactOrigin(new URL(p.referer).origin) : null;
    } catch {
      origin = null;
    }
    if (!origin) return;
    const found = await findSiteByKey(this.db, p.pk);
    if (!found) return;
    const { site, kind } = found;
    let allowed = false;
    if (kind === 'test') {
      if (!isLocalOrigin(origin)) return;
      allowed = site.widgetVersion > 0;
    } else {
      const access = await siteHostAccess(this.db, site.siteId, now);
      if (!access.some((h) => h.origin === origin)) return;
      const published = await publishedWidgetConfig(this.db, site);
      allowed =
        published !== null &&
        allowedOrigins(access, hostRulesOf(published), true).some(
          (h) => h.origin === origin,
        );
    }
    const version =
      p.loaderVersion && /^[A-Za-z0-9._-]{1,32}$/.test(p.loaderVersion)
        ? p.loaderVersion
        : null;
    await this.db.$executeRaw(Prisma.sql`
      INSERT INTO "sites"."assist_site_install_pings"
        ("siteId", "origin", "allowed", "loaderVersion", "configFetchOk", "firstSeenAt", "lastSeenAt", "count")
      VALUES (${site.siteId}, ${origin}, ${allowed}, ${version}, ${p.configFetchOk}, ${now}, ${now}, 1)
      ON CONFLICT ("siteId", "origin") DO UPDATE SET
        "allowed" = EXCLUDED."allowed",
        "loaderVersion" = COALESCE(EXCLUDED."loaderVersion", "sites"."assist_site_install_pings"."loaderVersion"),
        "configFetchOk" = COALESCE(EXCLUDED."configFetchOk", "sites"."assist_site_install_pings"."configFetchOk"),
        "lastSeenAt" = EXCLUDED."lastSeenAt",
        "count" = "sites"."assist_site_install_pings"."count" + 1`);
  }

  async exchangePreview(
    body: WidgetPreviewExchangeRequest,
    requestOrigin: string | undefined,
    now: Date = new Date(),
  ): Promise<WidgetPreviewExchangeResponse> {
    if (requestOrigin !== widgetOrigin()) throw widgetError('ORIGIN_DENIED');
    const found = await findSiteByKey(this.db, body.pk);
    const parent = exactOrigin(body.parentOrigin);
    if (
      !found ||
      !parent ||
      typeof body.token !== 'string' ||
      !/^[A-Za-z0-9_-]{20,100}$/.test(body.token)
    ) {
      throw widgetError('PREVIEW_INVALID');
    }
    const tokenHash = sha256Hex(body.token);
    const row = await this.db.assistSitePreviewToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        siteId: true,
        purpose: true,
        origin: true,
        draft: true,
        expiresAt: true,
        usedAt: true,
      },
    });
    if (
      !row ||
      row.siteId !== found.site.siteId ||
      row.usedAt !== null ||
      row.expiresAt.getTime() <= now.getTime()
    ) {
      throw widgetError('PREVIEW_INVALID');
    }
    // Куда можно: tma — предки конфигуратора; site — ровно тот origin, для
    // которого выдана ссылка, и он всё ещё допущен ядром.
    if (row.purpose === 'tma') {
      if (!previewFrameAncestors().includes(parent)) {
        throw widgetError('PREVIEW_INVALID');
      }
    } else if (row.purpose === 'site') {
      if (row.origin !== parent) throw widgetError('PREVIEW_INVALID');
      const access = await siteHostAccess(this.db, row.siteId, now);
      const ok = allowedOrigins(access, [], false).some(
        (h) => h.origin === parent,
      );
      if (!ok && !(found.kind === 'test' && isLocalOrigin(parent))) {
        throw widgetError('PREVIEW_INVALID');
      }
    } else {
      throw widgetError('PREVIEW_INVALID');
    }

    let draft: Record<string, unknown> | null =
      row.draft && typeof row.draft === 'object' && !Array.isArray(row.draft)
        ? (row.draft as Record<string, unknown>)
        : null;
    // Черновик кабинета (widgetDraft) роли не виден — без снимка в токене
    // показываем опубликованный вид.
    draft ??= await publishedWidgetConfig(this.db, found.site);
    if (!draft) throw widgetError('PREVIEW_INVALID');

    const session = randomBytes(32).toString('base64url');
    const sessionExpiresAt = new Date(
      now.getTime() + WIDGET_DEFAULTS.previewSessionTtlMs,
    );
    // Одноразовость — условием UPDATE, а не чтением выше: два параллельных
    // обмена одного токена получат одну сессию на двоих не могут.
    const used = await this.db.assistSitePreviewToken.updateMany({
      where: {
        id: row.id,
        tokenHash,
        siteId: found.site.siteId,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        usedAt: now,
        sessionHash: sha256Hex(session),
        sessionExpiresAt,
      },
    });
    if (used.count !== 1) throw widgetError('PREVIEW_INVALID');
    this.logger.log(
      `preview exchanged site=${row.siteId} purpose=${row.purpose}`,
    );
    return {
      previewSession: session,
      expiresAt: sessionExpiresAt.toISOString(),
      config: withoutHosts(draft),
    };
  }

  /** Для /w/v1/frame: выпуск чанков сайта по pk (канарейка, §5-бис.12). */
  async releaseFor(pk: string, now: Date = new Date()): Promise<string | null> {
    const found = await findSiteByKey(this.db, pk);
    if (!found) return null;
    return releaseForSite(
      found.site.siteId,
      await readWidgetRelease(this.db, now.getTime()),
    );
  }

  /** Для /w/v1/frame: строка CSP frame-ancestors по pk (кэш 5 мин). */
  async frameAncestorsFor(
    pk: string,
    preview: boolean,
    now: Date = new Date(),
  ): Promise<string> {
    const found = await findSiteByKey(this.db, pk);
    if (!found) return "'none'";
    const { site, kind } = found;
    let origins: string[] = [];
    if (kind === 'live') {
      const access = await siteHostAccess(this.db, site.siteId, now);
      if (preview) {
        origins = allowedOrigins(access, [], false).map((h) => h.origin);
      } else {
        const published = await publishedWidgetConfig(this.db, site);
        origins = published
          ? allowedOrigins(access, hostRulesOf(published), true).map(
              (h) => h.origin,
            )
          : [];
      }
    } else if (!preview && site.widgetVersion <= 0) {
      return "'none'";
    }
    return frameAncestors({
      keyKind: kind,
      allowedOrigins: origins,
      preview,
      previewAncestors: preview ? previewFrameAncestors() : [],
    });
  }
}
