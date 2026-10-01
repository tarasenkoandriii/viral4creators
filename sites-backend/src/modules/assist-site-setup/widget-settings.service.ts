/**
 * Кабинет: вид виджета, ключи, публикация/откат, предпросмотр, рубильник
 * владельца (ТЗ §3-бис, §3.6 п.1–3, §4.16). Владелец — W4.
 *
 * Сайт ищется через SitesDb.forAccount(m.accountId) (чужой — 404). Публикация
 * — ОДНОЙ транзакцией: строка assist_site_config_versions(kind=widget,
 * version = widgetVersion+1) + assist_sites.widgetVersion (условным UPDATE по
 * прежнему номеру — две параллельные публикации не получат один номер).
 * Откат N = новая версия с содержимым N (`rolledBackFrom`). Хосты в
 * конфигурации — только verified-хосты этого сайта на момент публикации.
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { WIDGET_PREVIEW_PARAM } from '../../brand';
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import { widgetOrigin as envWidgetOrigin } from '../../config/widget-env';
import { SitesDb } from '../../prisma/sites-db.service';
import { qualified } from '../assist-knowledge-core/tables';
import type { AccountMembership } from '../site-core/account/roles';
import { evaluateHostAccess } from '../site-core/ownership/host-access';
import { notFoundSite } from '../site-core/site-core.constants';
import type {
  AssetView,
  ConfigHistoryItem,
  PreviewTokenResult,
  WidgetHostView,
  WidgetSettingsView,
  WidgetWarning,
} from './api-types';
import {
  ASSET_KINDS,
  ASSET_MAX_BYTES,
  ASSET_MIMES,
  AVATAR_MIN_SIDE,
  decodeBase64Strict,
  sniffImage,
  type AssetKind,
} from './assets';
import { setupError, type FieldError } from './errors';
import { generatePublicKey } from './keys';
import { buildCspSnippet, buildEmbedSnippet } from './snippet';
import {
  defaultWidgetConfig,
  parseWidgetConfig,
  type WidgetConfig,
  type WidgetConfigAdjustment,
} from './widget-config';

type Db = ReturnType<SitesDb['forAccount']>;

export interface HostRow {
  id: string;
  accountId: string;
  scheme: string;
  host: string;
  port: number;
  status: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  reverifyBlockedAt: Date | null;
}

export const HOST_SELECT = {
  id: true,
  accountId: true,
  scheme: true,
  host: true,
  port: true,
  status: true,
  expiresAt: true,
  revokedAt: true,
  reverifyBlockedAt: true,
} as const;

export function hostOriginOf(h: Pick<HostRow, 'scheme' | 'host' | 'port'>) {
  const def = h.scheme === 'https' ? 443 : 80;
  return `${h.scheme}://${h.host}${h.port === def ? '' : `:${h.port}`}`;
}

/** Повторов условного UPDATE номера при гонке публикаций. */
const PUBLISH_ATTEMPTS = 5;

/** Канонический JSON (ключи по алфавиту) — «черновик отличается от публикации». */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function sha256Hex(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Общая для вида и персоны публикация номера: блокировка строки сайта →
 * условный UPDATE прежнего номера → строка версии → обрезка истории до
 * 20. Гонка публикаций: вторая ждёт блокировку, видит новый номер (ни
 * потери, ни дубля); UPDATE мимо номера — повтор цикла.
 */
export async function publishConfigVersion(
  db: Db,
  p: {
    accountId: string;
    siteId: string;
    kind: 'widget' | 'persona';
    config: unknown;
    gateReport?: unknown;
    rolledBackFrom?: number | null;
    byTelegramId: bigint;
  },
): Promise<number> {
  const column = p.kind === 'widget' ? 'widgetVersion' : 'configVersion';
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
    const done = await db.$transaction(async (tx) => {
      // Блокировка строки сайта ДО чтения номера: параллельные публикации
      // встают в очередь и каждая видит номер предыдущей (условный UPDATE
      // ниже — вторая линия защиты, повтор цикла — третья).
      await tx.$queryRawUnsafe(
        `SELECT 1 FROM ${qualified('assist_sites')} WHERE "siteId" = $1 AND "accountId" = $2 FOR UPDATE`,
        p.siteId,
        p.accountId,
      );
      const row = await tx.assistSite.findFirst({
        where: { siteId: p.siteId, accountId: p.accountId },
        select: { widgetVersion: true, configVersion: true },
      });
      if (!row) throw notFoundSite();
      const prev = row[column];
      const next = prev + 1;
      const upd = await tx.assistSite.updateMany({
        where: { siteId: p.siteId, accountId: p.accountId, [column]: prev },
        data: { [column]: next },
      });
      if (upd.count !== 1) return null;
      await tx.assistSiteConfigVersion.create({
        data: {
          accountId: p.accountId,
          siteId: p.siteId,
          kind: p.kind,
          version: next,
          config: p.config as Prisma.InputJsonValue,
          gateReport:
            p.gateReport === undefined
              ? undefined
              : (p.gateReport as Prisma.InputJsonValue),
          rolledBackFrom: p.rolledBackFrom ?? null,
          publishedByTelegramId: p.byTelegramId,
        },
      });
      await tx.assistSiteConfigVersion.deleteMany({
        where: {
          siteId: p.siteId,
          accountId: p.accountId,
          kind: p.kind,
          version: { lte: next - WIDGET_DEFAULTS.configHistoryKeep },
        },
      });
      return next;
    });
    if (done !== null) return done;
  }
  throw setupError(
    HttpStatus.CONFLICT,
    'VERSION_CONFLICT',
    'Публикация не удалась из-за одновременных изменений — повторите',
  );
}

export function historyItem(r: {
  version: number;
  createdAt: Date;
  publishedByTelegramId: bigint | null;
  rolledBackFrom: number | null;
}): ConfigHistoryItem {
  return {
    version: r.version,
    publishedAt: r.createdAt.toISOString(),
    publishedByTelegramId:
      r.publishedByTelegramId === null ? null : String(r.publishedByTelegramId),
    rolledBackFrom: r.rolledBackFrom,
  };
}

/** Сайт кабинета (чужой — 404) + строка assist_sites (создаётся при нужде). */
export async function loadAssistSite(
  db: Db,
  accountId: string,
  siteId: string,
) {
  const site = await db.site.findFirst({
    where: { id: siteId },
    select: { id: true, name: true },
  });
  if (!site) throw notFoundSite();
  let row = await db.assistSite.findFirst({ where: { siteId } });
  if (!row) {
    try {
      row = await db.assistSite.create({ data: { accountId, siteId } });
    } catch (e) {
      // Гонка двух первых вызовов — строка уже есть.
      if (
        !(e instanceof Prisma.PrismaClientKnownRequestError) ||
        e.code !== 'P2002'
      ) {
        throw e;
      }
      row = await db.assistSite.findFirst({ where: { siteId } });
      if (!row) throw e;
    }
  }
  return { site, row };
}

type AssistRow = Awaited<ReturnType<typeof loadAssistSite>>['row'];

@Injectable()
export class WidgetSettingsService {
  /** Часы — подменяются в тестах. */
  now: () => Date = () => new Date();
  /** Origin виджета — env (одно место чтения: config/widget-env.ts). */
  widgetOrigin: () => string = () => envWidgetOrigin();

  constructor(private readonly sitesDb: SitesDb) {}

  private db(m: AccountMembership): Db {
    return this.sitesDb.forAccount(m.accountId);
  }

  async get(m: AccountMembership, siteId: string): Promise<WidgetSettingsView> {
    const db = this.db(m);
    const { site, row } = await loadAssistSite(db, m.accountId, siteId);
    return this.view(db, site, row, []);
  }

  /** Выдать pk_live_/pk_test_ и соль ipHash, если их ещё нет (идемпотентно). */
  async ensureKeys(
    m: AccountMembership,
    siteId: string,
  ): Promise<WidgetSettingsView> {
    const db = this.db(m);
    const { row } = await loadAssistSite(db, m.accountId, siteId);
    if (!row.publicKey || !row.testKey || !row.ipSalt) {
      // Условие «ключа ещё нет»: два параллельных нажатия не перезапишут
      // уже выданный (и, возможно, вставленный на сайт) ключ.
      for (let i = 0; i < 3; i++) {
        try {
          await db.assistSite.updateMany({
            where: { siteId, publicKey: null },
            data: {
              publicKey: generatePublicKey('live'),
              testKey: generatePublicKey('test'),
            },
          });
          break;
        } catch (e) {
          // Совпадение ключа (unique) — 142 бита, но повторить дёшево.
          if (
            !(e instanceof Prisma.PrismaClientKnownRequestError) ||
            e.code !== 'P2002' ||
            i === 2
          ) {
            throw e;
          }
        }
      }
      await db.assistSite.updateMany({
        where: { siteId, ipSalt: null },
        data: { ipSalt: randomBytes(32).toString('hex') },
      });
    }
    return this.get(m, siteId);
  }

  async saveDraft(
    m: AccountMembership,
    siteId: string,
    config: unknown,
  ): Promise<WidgetSettingsView> {
    const db = this.db(m);
    const { site, row } = await loadAssistSite(db, m.accountId, siteId);
    const parsed = parseWidgetConfig(config);
    if (!parsed.ok) throw this.invalid(parsed.errors);
    const errors = await this.checkRefs(db, siteId, parsed.config);
    if (errors.length) throw this.invalid(errors);
    const saved = await db.assistSite.update({
      where: { id: row.id },
      data: { widgetDraft: parsed.config as unknown as Prisma.InputJsonValue },
    });
    return this.view(db, site, saved, parsed.adjustments);
  }

  async publish(
    m: AccountMembership,
    siteId: string,
  ): Promise<WidgetSettingsView> {
    const db = this.db(m);
    const { site, row } = await loadAssistSite(db, m.accountId, siteId);
    const hosts = await this.hosts(db, siteId);
    const draft = this.draftOf(site.name, row, hosts);
    // Повторная проверка: черновик мог быть записан старой версией кода.
    const parsed = parseWidgetConfig(draft);
    if (!parsed.ok) throw this.invalid(parsed.errors);
    const refErrors = await this.checkRefs(db, siteId, parsed.config);
    if (refErrors.length) throw this.invalid(refErrors);
    const adjustments = [...parsed.adjustments];
    const now = this.now();
    const config: WidgetConfig = {
      ...parsed.config,
      hosts: parsed.config.hosts.filter((rule) => {
        const h = hosts.find((x) => x.id === rule.hostId);
        const a = h ? evaluateHostAccess(h, 'assist-widget', now) : null;
        // Только подтверждённые сейчас; льгота 72 ч — не подтверждение.
        if (a?.ok && !a.grace) return true;
        adjustments.push({
          path: `hosts.${rule.hostId}`,
          reason: 'host_not_verified',
          from: rule,
          to: null,
        });
        return false;
      }),
    };
    await publishConfigVersion(db, {
      accountId: m.accountId,
      siteId,
      kind: 'widget',
      config,
      byTelegramId: m.telegramId,
    });
    const fresh = await db.assistSite.findFirstOrThrow({ where: { siteId } });
    return this.view(db, site, fresh, adjustments);
  }

  async rollback(
    m: AccountMembership,
    siteId: string,
    version: number,
  ): Promise<WidgetSettingsView> {
    const db = this.db(m);
    const { site } = await loadAssistSite(db, m.accountId, siteId);
    const old = await db.assistSiteConfigVersion.findFirst({
      where: { siteId, kind: 'widget', version },
      select: { config: true },
    });
    if (!old) {
      throw setupError(404, 'VERSION_NOT_FOUND', 'Такой версии нет в истории');
    }
    await publishConfigVersion(db, {
      accountId: m.accountId,
      siteId,
      kind: 'widget',
      config: old.config,
      rolledBackFrom: version,
      byTelegramId: m.telegramId,
    });
    const fresh = await db.assistSite.findFirstOrThrow({ where: { siteId } });
    return this.view(db, site, fresh, []);
  }

  /**
   * Одноразовый токен предпросмотра (§3-бис.4): `site` — ссылка на
   * verified-хост с `?<WIDGET_PREVIEW_PARAM>=` (30 мин, привязан к origin
   * хоста); `tma` — для конфигуратора кабинета. В базе — SHA-256.
   */
  async previewToken(
    m: AccountMembership,
    siteId: string,
    body: { purpose: 'site'; hostId: string } | { purpose: 'tma' },
  ): Promise<PreviewTokenResult> {
    const db = this.db(m);
    const { site, row } = await loadAssistSite(db, m.accountId, siteId);
    const b = (body ?? {}) as { purpose?: unknown; hostId?: unknown };
    if (b.purpose !== 'site' && b.purpose !== 'tma') {
      throw setupError(400, 'BAD_REQUEST', 'purpose: site или tma');
    }
    if (!row.publicKey) {
      throw setupError(
        400,
        'KEYS_MISSING',
        'Сначала получите код установки виджета',
      );
    }
    const now = this.now();
    let origin: string | null = null;
    const hosts = await this.hosts(db, siteId);
    if (b.purpose === 'site') {
      if (typeof b.hostId !== 'string') {
        throw setupError(400, 'BAD_REQUEST', 'Укажите хост');
      }
      const h = hosts.find((x) => x.id === b.hostId);
      const a = h ? evaluateHostAccess(h, 'assist-widget', now) : null;
      if (!h || !a?.ok || a.grace || h.scheme !== 'https') {
        throw setupError(
          400,
          'HOST_NOT_VERIFIED',
          'Ссылка предпросмотра — только для подтверждённого хоста',
        );
      }
      origin = hostOriginOf(h);
    }
    // Снимок черновика — для ОБОИХ назначений: «посмотреть на сайте» видит
    // то же, что TMA, а конфигуратор TMA (§3-бис.4 «настоящий виджет с
    // черновой конфигурацией») — свой черновик. Без снимка обмен отдавал
    // опубликованный вид, а до первой публикации — PREVIEW_INVALID (аудит Э2):
    // черновик кабинета (widgetDraft) роли assist_public не виден.
    const draft = this.draftOf(
      site.name,
      row,
      hosts,
    ) as unknown as Prisma.InputJsonValue;
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      now.getTime() + WIDGET_DEFAULTS.previewTokenTtlMs,
    );
    await db.assistSitePreviewToken.create({
      data: {
        accountId: m.accountId,
        siteId,
        tokenHash: sha256Hex(token),
        purpose: b.purpose,
        origin,
        draft,
        createdByTelegramId: m.telegramId,
        expiresAt,
      },
    });
    return {
      url: origin
        ? `${origin}/?${WIDGET_PREVIEW_PARAM}=${encodeURIComponent(token)}`
        : null,
      token,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** Рубильник владельца (§4.13 п.6): чат отвечает формой заявки. */
  async setPaused(
    m: AccountMembership,
    siteId: string,
    paused: boolean,
  ): Promise<WidgetSettingsView> {
    const db = this.db(m);
    const { row } = await loadAssistSite(db, m.accountId, siteId);
    await db.assistSite.update({
      where: { id: row.id },
      data: { chatPaused: paused === true },
    });
    return this.get(m, siteId);
  }

  /**
   * Логотип/аватар (§3-бис.1): тело `{ kind, mime, dataBase64 }` ≤ 200 КБ;
   * тип — по СИГНАТУРЕ байтов (PNG/JPEG/WebP), SVG и прочее — отказ
   * `ASSET_TYPE`; размеры из заголовка картинки (квадрат ≥ 128 px для аватара).
   */
  async uploadAsset(
    m: AccountMembership,
    siteId: string,
    body: unknown,
  ): Promise<AssetView> {
    const db = this.db(m);
    await loadAssistSite(db, m.accountId, siteId);
    const b = (body && typeof body === 'object' ? body : {}) as Record<
      string,
      unknown
    >;
    if (!(ASSET_KINDS as readonly unknown[]).includes(b.kind)) {
      throw setupError(400, 'BAD_REQUEST', 'kind: logo или avatar');
    }
    const kind = b.kind as AssetKind;
    // Заявленный тип — только из перечня (SVG, HTML — сразу отказ); решает
    // всё равно сигнатура байтов.
    if (!(ASSET_MIMES as readonly unknown[]).includes(b.mime)) {
      throw setupError(400, 'ASSET_TYPE', 'Только PNG, JPEG или WebP');
    }
    const bytes = decodeBase64Strict(b.dataBase64, ASSET_MAX_BYTES);
    if (bytes === 'too_large') {
      throw setupError(400, 'ASSET_TOO_LARGE', 'Картинка больше 200 КБ');
    }
    if (!bytes) throw setupError(400, 'BAD_REQUEST', 'dataBase64 — base64');
    const img = sniffImage(bytes);
    if (!img) {
      throw setupError(400, 'ASSET_TYPE', 'Только PNG, JPEG или WebP');
    }
    if (
      kind === 'avatar' &&
      (img.width !== img.height || img.width < AVATAR_MIN_SIDE)
    ) {
      throw setupError(
        400,
        'ASSET_TYPE',
        `Аватар — квадрат не меньше ${AVATAR_MIN_SIDE}×${AVATAR_MIN_SIDE} px`,
        { reason: 'dimensions' },
      );
    }
    const sha256 = sha256Hex(bytes);
    const existing = await db.assistSiteAsset.findFirst({
      where: { siteId, kind, sha256 },
      select: { id: true, kind: true, mime: true, width: true, height: true },
    });
    const saved =
      existing ??
      (await db.assistSiteAsset.create({
        data: {
          accountId: m.accountId,
          siteId,
          kind,
          mime: img.mime,
          sha256,
          bytes: new Uint8Array(bytes),
          width: img.width,
          height: img.height,
        },
        select: { id: true, kind: true, mime: true, width: true, height: true },
      }));
    return assetView(saved);
  }

  // ── Внутреннее ──────────────────────────────────────────────────────

  private invalid(errors: FieldError[]) {
    return setupError(
      400,
      'WIDGET_CONFIG_INVALID',
      'Настройки виджета не прошли проверку',
      { errors },
    );
  }

  private hosts(db: Db, siteId: string): Promise<HostRow[]> {
    return db.siteHost.findMany({
      where: { siteId },
      orderBy: { createdAt: 'asc' },
      select: HOST_SELECT,
    });
  }

  /** Хосты и картинки конфигурации — только этого сайта. */
  private async checkRefs(
    db: Db,
    siteId: string,
    config: WidgetConfig,
  ): Promise<FieldError[]> {
    const errors: FieldError[] = [];
    const hostIds = new Set((await this.hosts(db, siteId)).map((h) => h.id));
    config.hosts.forEach((h, i) => {
      if (!hostIds.has(h.hostId)) {
        errors.push({ path: `hosts[${i}].hostId`, code: 'host_unknown' });
      }
    });
    const want: Array<{ path: string; id: string; kind: AssetKind }> = [];
    if (config.brand.logoAssetId) {
      want.push({
        path: 'brand.logoAssetId',
        id: config.brand.logoAssetId,
        kind: 'logo',
      });
    }
    if (config.brand.avatar.kind === 'asset') {
      want.push({
        path: 'brand.avatar.assetId',
        id: config.brand.avatar.assetId,
        kind: 'avatar',
      });
    }
    if (want.length) {
      const found = await db.assistSiteAsset.findMany({
        where: { siteId, id: { in: want.map((w) => w.id) } },
        select: { id: true, kind: true },
      });
      for (const w of want) {
        if (!found.some((f) => f.id === w.id && f.kind === w.kind)) {
          errors.push({ path: w.path, code: 'asset_unknown' });
        }
      }
    }
    return errors;
  }

  /**
   * Черновик для экрана: сохранённый (без ссылок на удалённые хосты) или
   * умолчание с включёнными подтверждёнными хостами сайта.
   */
  private draftOf(
    siteName: string,
    row: AssistRow,
    hosts: HostRow[],
  ): WidgetConfig {
    const parsed = row.widgetDraft ? parseWidgetConfig(row.widgetDraft) : null;
    if (parsed?.ok) {
      const ids = new Set(hosts.map((h) => h.id));
      return {
        ...parsed.config,
        hosts: parsed.config.hosts.filter((h) => ids.has(h.hostId)),
      };
    }
    const now = this.now();
    const def = defaultWidgetConfig(siteName);
    def.hosts = hosts
      .filter((h) => {
        const a = evaluateHostAccess(h, 'assist-widget', now);
        return a.ok && !a.grace;
      })
      .map((h) => ({ hostId: h.id, enabled: true, pathMasks: [], hideOn: [] }));
    return def;
  }

  private async view(
    db: Db,
    site: { id: string; name: string },
    row: AssistRow,
    adjustments: WidgetConfigAdjustment[],
  ): Promise<WidgetSettingsView> {
    const siteId = site.id;
    const now = this.now();
    const hosts = await this.hosts(db, siteId);
    const versions = await db.assistSiteConfigVersion.findMany({
      where: { siteId, kind: 'widget' },
      orderBy: { version: 'desc' },
      take: WIDGET_DEFAULTS.configHistoryKeep,
      select: {
        version: true,
        config: true,
        createdAt: true,
        publishedByTelegramId: true,
        rolledBackFrom: true,
      },
    });
    const publishedRow =
      row.widgetVersion > 0
        ? versions.find((v) => v.version === row.widgetVersion)
        : undefined;
    const published = publishedRow
      ? (publishedRow.config as unknown as WidgetConfig)
      : null;
    const draft = this.draftOf(site.name, row, hosts);

    const hostViews: WidgetHostView[] = hosts.map((h) => {
      const a = evaluateHostAccess(h, 'assist-widget', now);
      return {
        hostId: h.id,
        origin: hostOriginOf(h),
        status: h.status,
        widgetAllowed: a.ok,
        graceUntil: a.ok && a.grace ? a.graceUntil.toISOString() : null,
        enabledPublished: !!published?.hosts.some(
          (r) => r.hostId === h.id && r.enabled,
        ),
      };
    });

    const warnings: WidgetWarning[] = [];
    if (adjustments.some((a) => a.reason.startsWith('contrast_'))) {
      warnings.push({ code: 'low_contrast' });
    }
    if (adjustments.some((a) => a.reason === 'powered_by_locked')) {
      warnings.push({ code: 'powered_by_locked' });
    }
    let enabledAllowed = 0;
    for (const rule of draft.hosts) {
      if (!rule.enabled) continue;
      const hv = hostViews.find((h) => h.hostId === rule.hostId);
      if (!hv) continue;
      if (!hv.widgetAllowed) {
        warnings.push({ code: 'host_not_verified', hostId: rule.hostId });
      } else if (hv.graceUntil) {
        warnings.push({
          code: 'host_grace',
          hostId: rule.hostId,
          details: hv.graceUntil,
        });
      } else {
        enabledAllowed++;
      }
    }
    if (enabledAllowed === 0) warnings.push({ code: 'no_enabled_hosts' });
    if (row.widgetVersion === 0) warnings.push({ code: 'not_published' });

    const origin = this.widgetOrigin();
    const assets = await db.assistSiteAsset.findMany({
      where: { siteId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, kind: true, mime: true, width: true, height: true },
    });
    return {
      siteId,
      publicKey: row.publicKey,
      testKey: row.testKey,
      publishedVersion: row.widgetVersion,
      published,
      draft,
      adjustments,
      history: versions.map(historyItem),
      hosts: hostViews,
      warnings,
      snippet: row.publicKey
        ? buildEmbedSnippet({
            publicKey: row.publicKey,
            widgetOrigin: origin,
            config: draft,
          })
        : '',
      cspSnippet: buildCspSnippet(origin),
      chatPaused: row.chatPaused,
      operatorBlocked: row.operatorBlockedAt !== null,
      widgetOrigin: origin,
      draftChanged: !published || canonical(published) !== canonical(draft),
      assets: assets.map(assetView),
    };
  }
}

function assetView(a: {
  id: string;
  kind: string;
  mime: string;
  width: number;
  height: number;
}): AssetView {
  return {
    id: a.id,
    kind: a.kind === 'avatar' ? 'avatar' : 'logo',
    mime: a.mime,
    width: a.width,
    height: a.height,
    path: `/widget/v1/asset/${a.id}`,
  };
}
