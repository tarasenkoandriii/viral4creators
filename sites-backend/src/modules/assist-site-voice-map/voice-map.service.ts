/**
 * Голосовая карта «Сайта» — кабинет и общая часть редактора (Э6-тер, ТЗ
 * помощника §5-кватер.9, §5-кватер.11–13; Р-51…Р-54, Р-73…Р-82). Основная
 * роль (SitesDb.forAccount): черновик пишут TMA и сессия редактора, оба — с
 * `expectedRevision` (409 «карту изменили в другой вкладке»).
 *
 *  - операции черновика — чистое ядро `assist-ui-core/voice-map.ts`
 *    (`applyMapOps`): риск только вверх (422 `risk_lowering_forbidden`),
 *    имена у цели «никогда» — 422, тексты — правила §5-кватер.11 п.6;
 *    пакет применяется целиком или не применяется;
 *  - версия: сборка → ворота кода (`held`) → запрос публикации (из
 *    редактора — уведомление в бот) → ПУБЛИКАЦИЯ ТОЛЬКО ЧЕЛОВЕКОМ В TMA
 *    (В-50): маршрута публикации у сессии редактора нет;
 *  - публикация: индекс фраз сайта (`assist_site_phrases`, владелец
 *    `voice-map`) — гонка с мемо ловится уникальным ключом (409); номер —
 *    условным UPDATE; цели с разметкой уходят в общую карту Ш4 источником
 *    `manual` (уверенность 100) — подсветка и запасной путь их видят;
 *  - откат — новая версия с содержимым N (через ворота и подтверждение);
 *  - ссылка редактора: только владелец/менеджер (гвард маршрута), только
 *    verified-хост «Сайта» без льготы и не admin-хост; в базе — SHA-256.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WIDGET_EDITOR_PARAM } from '../../brand';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  recipients,
  sendToMembers,
  type FetchLike,
} from '../assist-knowledge-core/notify';
import { loadAssistSite } from '../assist-site-setup/widget-settings.service';
import { hostOriginOf } from '../assist-site-setup/widget-settings.service';
import {
  applyMapOps,
  canonicalJson,
  descriptorCandidates,
  emptyVoiceMap,
  exportPayload,
  importOps,
  parseVoiceMapContent,
  platformTemplateOps,
  PLATFORM_TEMPLATES,
  suggestTemplates,
  targetPhrases,
  versionContent,
  voiceMapDiff,
  voiceMapGates,
  VOICE_MAP_LIMITS,
  type MapChangeSource,
  type MapGateReport,
  type VoiceMapContent,
} from '../assist-ui-core/voice-map';
import type { AccountMembership } from '../site-core/account/roles';
import { adminHostIdsOf } from '../site-core/ownership/host-roles';
import { evaluateHostAccess } from '../site-core/ownership/host-access';
import { ingestUiSnapshot } from '../site-core/ui-map/ui-map-store';
import { uiMapHost } from '../site-core/ui-map/ui-map';
import type {
  EditorLinkView,
  EditorSessionSummary,
  VoiceMapDraftView,
  VoiceMapExportView,
  VoiceMapImportView,
  VoiceMapPatchView,
  VoiceMapSummaryView,
  VoiceMapVersionSummary,
  VoiceMapVersionView,
} from './api-types';
import { voiceMapError } from './voice-map-errors';

type Db = ReturnType<SitesDb['forAccount']>;

export interface MapActor {
  accountId: string;
  memberId: string;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Ошибки операций → поле `errors` конверта (`{ path: ops.N.поле, code }`). */
export function issuesToErrors(
  issues: ReadonlyArray<{ index: number; code: string; path?: string }>,
): Array<{ path: string; code: string }> {
  return issues.map((i) => ({
    path: `ops.${i.index}${i.path ? `.${i.path}` : ''}`,
    code: i.code,
  }));
}

export function contentHash(c: VoiceMapContent): string {
  return createHash('sha256').update(canonicalJson(c)).digest('base64url');
}

const PHRASE_OWNER = 'voice-map';

interface HostRow {
  id: string;
  accountId: string;
  host: string;
  scheme: string;
  port: number;
  status: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  reverifyBlockedAt: Date | null;
}

interface VersionRow {
  id: string;
  number: number;
  status: string;
  content: unknown;
  contentHash: string;
  gateReport: unknown;
  rollbackOf: number | null;
  requestedVia: string;
  createdAt: Date;
  publishedAt: Date | null;
}

/** Метка производного ключа подписи экспорта карты (аудит Н-5). */
const VOICE_MAP_EXPORT_LABEL = 'voice-map-export-v1';
/** Без ключа подпись формальна (формат файла), «нашим» файл не признаётся. */
const UNSIGNED_EXPORT_KEY = 'v4c-voice-map-export-unsigned';

@Injectable()
export class VoiceMapService {
  private readonly logger = new Logger(VoiceMapService.name);
  now: () => Date = () => new Date();
  env: NodeJS.ProcessEnv = process.env;
  /** Подмена отправки в бот — только тестами. */
  fetchImpl: FetchLike | undefined;

  constructor(private readonly sitesDb: SitesDb) {}

  db(accountId: string): Db {
    return this.sitesDb.forAccount(accountId);
  }

  // ── хосты «Сайта» (§5-кватер.2 «условия входа») ────────────────────────

  /**
   * Хосты, где открывается редактор и считается риск ссылок: `verified`
   * (L1 `assist-crawl` — без льготы 72 ч), не admin-хосты сайта.
   */
  async siteHosts(db: Db, siteId: string, now: Date): Promise<HostRow[]> {
    const [hosts, admin] = await Promise.all([
      db.siteHost.findMany({
        where: { siteId },
        orderBy: { createdAt: 'asc' },
      }),
      adminHostIdsOf(db, siteId),
    ]);
    return hosts.filter(
      (h) => !admin.has(h.id) && evaluateHostAccess(h, 'assist-crawl', now).ok,
    );
  }

  hostNames(hosts: readonly HostRow[]): string[] {
    return hosts.map((h) =>
      h.port === (h.scheme === 'https' ? 443 : 80)
        ? h.host
        : `${h.host}:${h.port}`,
    );
  }

  // ── черновик ────────────────────────────────────────────────────────────

  async loadMap(db: Db, accountId: string, siteId: string) {
    const row = await db.assistSiteVoiceMap.findFirst({ where: { siteId } });
    if (row) return row;
    try {
      return await db.assistSiteVoiceMap.create({
        data: {
          siteId,
          accountId,
          draft: emptyVoiceMap() as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const again = await db.assistSiteVoiceMap.findFirst({
          where: { siteId },
        });
        if (again) return again;
      }
      throw e;
    }
  }

  /** Фразы опубликованных мемо (`lang:norm`) — ворота «фраза мемо». */
  private async memoPhrases(db: Db, siteId: string): Promise<Set<string>> {
    const rows = await db.assistSitePhrase.findMany({
      where: { siteId, owner: { not: PHRASE_OWNER } },
      select: { lang: true, norm: true },
    });
    return new Set(rows.map((r) => `${r.lang}:${r.norm}`));
  }

  async gatesOf(
    db: Db,
    siteId: string,
    content: VoiceMapContent,
  ): Promise<MapGateReport> {
    return voiceMapGates(content, {
      memoPhrases: await this.memoPhrases(db, siteId),
    });
  }

  async draft(
    m: AccountMembership,
    siteId: string,
  ): Promise<VoiceMapDraftView> {
    const db = this.db(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    const row = await this.loadMap(db, m.accountId, siteId);
    const content = parseVoiceMapContent(row.draft);
    return {
      revision: row.draftRevision,
      publishedVersion: row.publishedVersion,
      content,
      gates: await this.gatesOf(db, siteId, versionContent(content)),
    };
  }

  /**
   * Пакет операций черновика (TMA, редактор, импорт, откат). Ревизия —
   * условным UPDATE: две вкладки — вторая получает 409. Любая ошибка
   * операции — 422 на весь пакет, черновик не меняется.
   */
  async patch(
    actor: MapActor,
    siteId: string,
    body: unknown,
    source: MapChangeSource,
  ): Promise<VoiceMapPatchView> {
    const db = this.db(actor.accountId);
    const b = (body ?? {}) as { expectedRevision?: unknown; ops?: unknown };
    if (
      typeof b.expectedRevision !== 'number' ||
      !Number.isInteger(b.expectedRevision)
    )
      throw voiceMapError(
        HttpStatus.BAD_REQUEST,
        'VOICE_MAP_INVALID',
        'Нужна ревизия черновика (expectedRevision)',
        { errors: [{ path: 'expectedRevision', code: 'bad_op' }] },
      );
    const row = await this.loadMap(db, actor.accountId, siteId);
    if (row.draftRevision !== b.expectedRevision) throw this.conflict();
    const now = this.now();
    const hosts = this.hostNames(await this.siteHosts(db, siteId, now));
    const res = applyMapOps(parseVoiceMapContent(row.draft), b.ops, {
      hosts,
      newId: () => `t-${randomBytes(5).toString('hex')}`,
      source,
    });
    if (res.issues.length)
      throw voiceMapError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'VOICE_MAP_INVALID',
        res.issues.some((i) => i.code === 'risk_lowering_forbidden')
          ? 'Риск можно только ужесточить'
          : 'Изменение карты не прошло проверку',
        { errors: issuesToErrors(res.issues) },
      );
    const next = b.expectedRevision + 1;
    const upd = await db.assistSiteVoiceMap.updateMany({
      where: { siteId, draftRevision: b.expectedRevision },
      data: {
        draft: res.content as unknown as Prisma.InputJsonValue,
        draftRevision: next,
        updatedBy: actor.memberId,
      },
    });
    if (upd.count !== 1) throw this.conflict();
    if (res.changes.length)
      await db.assistSiteVoiceMapChange.createMany({
        data: res.changes.map((op) => ({
          accountId: actor.accountId,
          siteId,
          revision: next,
          actor: actor.memberId,
          source,
          op: op as Prisma.InputJsonValue,
        })),
      });
    return { revision: next, applied: res.changes.length };
  }

  private conflict() {
    return voiceMapError(
      HttpStatus.CONFLICT,
      'VOICE_MAP_CONFLICT',
      'Карту изменили в другой вкладке — обновите',
    );
  }

  // ── версии ──────────────────────────────────────────────────────────────

  private summaryOf(
    v: VersionRow,
    prev: VoiceMapContent | null,
  ): VoiceMapVersionSummary {
    const g = (v.gateReport ?? null) as MapGateReport | null;
    const d = voiceMapDiff(prev, parseVoiceMapContent(v.content));
    return {
      number: v.number,
      status: v.status,
      requestedVia: v.requestedVia,
      rollbackOf: v.rollbackOf,
      createdAt: v.createdAt.toISOString(),
      publishedAt: v.publishedAt ? v.publishedAt.toISOString() : null,
      ok: g?.ok ?? false,
      problems: g?.problems?.length ?? 0,
      warnings: g?.warnings?.length ?? 0,
      diff: {
        added: d.added.length,
        changed: d.changed.length,
        removed: d.removed.length,
      },
    };
  }

  private async publishedContent(
    db: Db,
    siteId: string,
    n: number,
  ): Promise<VoiceMapContent | null> {
    if (!n) return null;
    const v = await db.assistSiteVoiceMapVersion.findFirst({
      where: { siteId, number: n },
      select: { content: true },
    });
    return v ? parseVoiceMapContent(v.content) : null;
  }

  /**
   * Собрать версию из черновика (или содержимого версии N — откат): ворота
   * кода → `checking` | `held`. Из редактора — уведомление владельцам и
   * менеджерам в бот: публикуют они в TMA.
   */
  async buildVersion(
    actor: MapActor,
    siteId: string,
    via: 'editor' | 'tma',
    rollbackOf: number | null = null,
  ): Promise<VoiceMapVersionView> {
    const db = this.db(actor.accountId);
    const row = await this.loadMap(db, actor.accountId, siteId);
    let content: VoiceMapContent;
    if (rollbackOf !== null) {
      const src = await this.publishedContent(db, siteId, rollbackOf);
      if (!src) throw this.versionNotFound();
      content = src;
    } else content = versionContent(parseVoiceMapContent(row.draft));
    const gates = await this.gatesOf(db, siteId, content);
    let number = 0;
    for (let i = 0; i < 5 && !number; i++) {
      const cur = await db.assistSiteVoiceMap.findFirst({
        where: { siteId },
        select: { versionSeq: true },
      });
      const seq = (cur?.versionSeq ?? 0) + 1;
      const u = await db.assistSiteVoiceMap.updateMany({
        where: { siteId, versionSeq: seq - 1 },
        data: { versionSeq: seq },
      });
      if (u.count === 1) number = seq;
    }
    if (!number) throw this.conflict();
    const v = await db.assistSiteVoiceMapVersion.create({
      data: {
        accountId: actor.accountId,
        siteId,
        number,
        status: gates.ok ? 'checking' : 'held',
        content: content as unknown as Prisma.InputJsonValue,
        contentHash: contentHash(content),
        gateReport: gates as unknown as Prisma.InputJsonValue,
        rollbackOf,
        requestedBy: actor.memberId,
        requestedVia: via,
      },
    });
    await this.trimVersions(db, siteId, row.publishedVersion);
    const prev = await this.publishedContent(db, siteId, row.publishedVersion);
    const view = this.versionView(v, prev);
    if (via === 'editor') await this.notifyRequest(actor, siteId, view);
    this.logger.log(
      `voice-map version site=${siteId} v=${number} status=${v.status} via=${via}`,
    );
    return view;
  }

  /** Хранятся последние 20 версий (опубликованная — всегда). */
  private async trimVersions(db: Db, siteId: string, published: number) {
    const old = await db.assistSiteVoiceMapVersion.findMany({
      where: { siteId },
      orderBy: { number: 'desc' },
      skip: VOICE_MAP_LIMITS.versionsKept,
      select: { id: true, number: true },
    });
    const ids = old.filter((o) => o.number !== published).map((o) => o.id);
    if (ids.length)
      await db.assistSiteVoiceMapVersion.deleteMany({
        where: { id: { in: ids } },
      });
  }

  private versionView(
    v: VersionRow,
    prev: VoiceMapContent | null,
  ): VoiceMapVersionView {
    const content = parseVoiceMapContent(v.content);
    return {
      ...this.summaryOf(v, prev),
      gateReport: (v.gateReport ?? null) as MapGateReport | null,
      content,
      diffKeys: voiceMapDiff(prev, content),
    };
  }

  private async notifyRequest(
    actor: MapActor,
    siteId: string,
    v: VoiceMapVersionView,
  ): Promise<void> {
    try {
      const gates = v.ok
        ? `ворота: зелёні${v.warnings ? ` / ${v.warnings} попереджень` : ''}`
        : `ворота: ${v.problems} проблем — версію затримано`;
      await sendToMembers({
        chatIds: await recipients(
          this.sitesDb,
          actor.accountId,
          (m) => m.role === 'owner' || m.productRoles.assist === 'manager',
        ),
        text: `Опублікувати голосову карту v${v.number}? +${v.diff.added} ~${v.diff.changed} −${v.diff.removed} · ${gates}`,
        button: {
          text: 'Відкрити',
          hashPath: `/sites/${siteId}/voice-map`,
        },
        env: this.env,
        fetchImpl: this.fetchImpl,
      });
    } catch {
      /* уведомление — справочно: запрос уже в TMA */
    }
  }

  private versionNotFound() {
    return voiceMapError(
      HttpStatus.NOT_FOUND,
      'VOICE_MAP_VERSION_NOT_FOUND',
      'Версия не найдена',
    );
  }

  private async version(db: Db, siteId: string, n: string | number) {
    const num = typeof n === 'number' ? n : Number(n);
    if (!Number.isInteger(num) || num < 1) throw this.versionNotFound();
    const v = await db.assistSiteVoiceMapVersion.findFirst({
      where: { siteId, number: num },
    });
    if (!v) throw this.versionNotFound();
    return v;
  }

  async versions(
    m: AccountMembership,
    siteId: string,
  ): Promise<{ items: VoiceMapVersionSummary[] }> {
    const db = this.db(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    const row = await this.loadMap(db, m.accountId, siteId);
    const prev = await this.publishedContent(db, siteId, row.publishedVersion);
    const list = await db.assistSiteVoiceMapVersion.findMany({
      where: { siteId },
      orderBy: { number: 'desc' },
      take: VOICE_MAP_LIMITS.versionsKept,
    });
    return { items: list.map((v) => this.summaryOf(v, prev)) };
  }

  async getVersion(
    m: AccountMembership,
    siteId: string,
    n: string,
  ): Promise<VoiceMapVersionView> {
    const db = this.db(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    const row = await this.loadMap(db, m.accountId, siteId);
    const v = await this.version(db, siteId, n);
    const prev =
      row.publishedVersion && row.publishedVersion !== v.number
        ? await this.publishedContent(db, siteId, row.publishedVersion)
        : null;
    return this.versionView(v, prev);
  }

  /**
   * Публикация — только человеком в TMA (В-50): ворота пересчитываются
   * (фразы мемо могли измениться), индекс фраз и номер — в транзакции.
   */
  async publish(
    m: AccountMembership,
    siteId: string,
    n: string,
  ): Promise<VoiceMapVersionView> {
    const db = this.db(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    const row = await this.loadMap(db, m.accountId, siteId);
    const v = await this.version(db, siteId, n);
    if (v.status !== 'checking')
      throw voiceMapError(
        HttpStatus.CONFLICT,
        'VOICE_MAP_VERSION_STATE',
        `Версия в статусе «${v.status}» — публикуется только версия на проверке`,
      );
    const content = parseVoiceMapContent(v.content);
    const gates = await this.gatesOf(db, siteId, content);
    if (!gates.ok) {
      await db.assistSiteVoiceMapVersion.updateMany({
        where: { id: v.id, status: 'checking' },
        data: {
          status: 'held',
          gateReport: gates as unknown as Prisma.InputJsonValue,
        },
      });
      throw voiceMapError(
        HttpStatus.CONFLICT,
        'VOICE_MAP_HELD',
        'Ворота не пройдены — версия задержана',
        {
          errors: gates.problems.map((p) => ({
            path: p.key ? `targets.${p.key}` : 'map',
            code: p.code,
          })),
        },
      );
    }
    const now = this.now();
    const phrases = new Map<
      string,
      { lang: string; norm: string; kind: string }
    >();
    for (const t of content.targets)
      if (!t.denylisted && t.status === 'active')
        for (const p of targetPhrases(t))
          phrases.set(`${p.lang}:${p.norm}`, {
            lang: p.lang,
            norm: p.norm,
            kind: p.kind,
          });
    try {
      await db.$transaction(async (tx) => {
        const u = await tx.assistSiteVoiceMap.updateMany({
          where: { siteId, publishedVersion: row.publishedVersion },
          data: { publishedVersion: v.number },
        });
        if (u.count !== 1) throw this.conflict();
        const vu = await tx.assistSiteVoiceMapVersion.updateMany({
          where: { id: v.id, status: 'checking' },
          data: {
            status: 'published',
            publishedBy: m.memberId,
            publishedAt: now,
          },
        });
        if (vu.count !== 1) throw this.conflict();
        await tx.assistSitePhrase.deleteMany({
          where: { siteId, owner: PHRASE_OWNER },
        });
        if (phrases.size)
          await tx.assistSitePhrase.createMany({
            data: [...phrases.values()].map((p) => ({
              siteId,
              accountId: m.accountId,
              lang: p.lang,
              norm: p.norm,
              owner: PHRASE_OWNER,
              kind: p.kind,
            })),
          });
        await tx.assistSiteVoiceMapChange.create({
          data: {
            accountId: m.accountId,
            siteId,
            revision: row.draftRevision,
            actor: m.memberId,
            source: 'tma',
            op: { op: 'publish', version: v.number },
          },
        });
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        throw voiceMapError(
          HttpStatus.CONFLICT,
          'VOICE_MAP_PHRASE_TAKEN',
          'Фраза карты уже занята мемо — переименуйте и соберите заново',
        );
      throw e;
    }
    await this.toSharedMap(m.accountId, siteId, content, now);
    this.logger.log(
      `voice-map publish site=${siteId} v=${v.number} member=${m.memberId}`,
    );
    const fresh = await this.version(db, siteId, v.number);
    const prev = await this.publishedContent(db, siteId, row.publishedVersion);
    return this.versionView(fresh, prev);
  }

  /**
   * Цели с разметкой/тестовым атрибутом/id — в общую карту Ш4 источником
   * `manual` (уверенность 100, сброс «устарел» своего вида): подсветка
   * «показать на экране» и запасной путь плана находят их тоже. Только
   * страницы целей-«страниц» и образцы шаблонов; первый verified-хост.
   * Сбой — не сбой публикации.
   */
  private async toSharedMap(
    accountId: string,
    siteId: string,
    content: VoiceMapContent,
    now: Date,
  ): Promise<void> {
    try {
      const db = this.db(accountId);
      const hosts = await this.siteHosts(db, siteId, now);
      const h = hosts[0];
      if (!h) return;
      const pages = new Map<string, Array<Record<string, unknown>>>();
      const add = (path: string, el: Record<string, unknown>) => {
        const list = pages.get(path) ?? [];
        if (list.length < 60) list.push(el);
        pages.set(path, list);
      };
      for (const t of content.targets) {
        if (t.status !== 'active' || t.denylisted) continue;
        const d = t.descriptor;
        const label = d.text || t.names.uk || t.names.ru || t.names.en || '';
        if (!label) continue;
        const cs = descriptorCandidates(d).filter((c) => c.kind !== 'text');
        if (!cs.length) continue;
        const el = {
          tag: d.tag,
          label,
          role: d.role,
          ...(d.assistId ? { assistId: d.assistId } : {}),
          candidates: cs,
        };
        if (t.scope === 'page' && t.pagePath) add(t.pagePath, el);
        if (t.scope === 'template') {
          const tpl = content.templates.find((x) => x.id === t.templateId);
          for (const p of tpl?.samplePages ?? []) add(p, el);
        }
      }
      for (const [path, elements] of pages)
        await ingestUiSnapshot(db, {
          accountId,
          siteId,
          hostId: h.id,
          host: uiMapHost(h.host),
          path,
          source: 'manual',
          viewport: 'any',
          elements,
          now,
        });
    } catch (e) {
      this.logger.warn(
        `voice-map → ui-map manual failed site=${siteId}: ${(e as Error).name}`,
      );
    }
  }

  async discard(
    m: AccountMembership,
    siteId: string,
    n: string,
  ): Promise<VoiceMapVersionView> {
    const db = this.db(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    const v = await this.version(db, siteId, n);
    const u = await db.assistSiteVoiceMapVersion.updateMany({
      where: { id: v.id, status: { in: ['checking', 'held'] } },
      data: { status: 'discarded' },
    });
    if (u.count !== 1)
      throw voiceMapError(
        HttpStatus.CONFLICT,
        'VOICE_MAP_VERSION_STATE',
        'Отклонить можно только версию на проверке или задержанную',
      );
    return this.getVersion(m, siteId, String(v.number));
  }

  /** «Вернуть версию N» = новая версия с содержимым N (ворота и подтверждение). */
  async rollback(
    m: AccountMembership,
    siteId: string,
    n: string,
  ): Promise<VoiceMapVersionView> {
    const db = this.db(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    const v = await this.version(db, siteId, n);
    if (v.status !== 'published')
      throw voiceMapError(
        HttpStatus.CONFLICT,
        'VOICE_MAP_VERSION_STATE',
        'Вернуть можно только бывшую опубликованную версию',
      );
    const out = await this.buildVersion(
      { accountId: m.accountId, memberId: m.memberId },
      siteId,
      'tma',
      v.number,
    );
    return out;
  }

  // ── сводка TMA ──────────────────────────────────────────────────────────

  async summary(
    m: AccountMembership,
    siteId: string,
  ): Promise<VoiceMapSummaryView> {
    const db = this.db(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    const row = await this.loadMap(db, m.accountId, siteId);
    const now = this.now();
    const content = versionContent(parseVoiceMapContent(row.draft));
    const gates = await this.gatesOf(db, siteId, content);
    const published = await this.publishedContent(
      db,
      siteId,
      row.publishedVersion,
    );
    const versions = await this.versions(m, siteId);
    const active = await db.assistSiteVoiceMapEditorSession.count({
      where: {
        siteId,
        revokedAt: null,
        OR: [
          { exchangedAt: null, linkExpiresAt: { gt: now } },
          { expiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
        ],
      },
    });
    const pages = await db.sitePage.findMany({
      where: { siteId },
      select: { url: true },
      take: 2000,
    });
    const paths = pages
      .map((p) => {
        try {
          return new URL(p.url).pathname;
        } catch {
          return null;
        }
      })
      .filter((p): p is string => !!p);
    const hosts = this.hostNames(await this.siteHosts(db, siteId, now));
    const d = published ? voiceMapDiff(published, content) : null;
    return {
      siteId,
      publishedVersion: row.publishedVersion,
      draftRevision: row.draftRevision,
      targets: gates.counts.targets,
      denylisted: gates.counts.denylisted,
      templates: gates.counts.templates,
      fragile: gates.counts.fragile,
      draftGates: gates,
      draftDirty: d
        ? d.added.length + d.changed.length + d.removed.length > 0
        : content.targets.length > 0,
      versions: versions.items,
      activeSessions: active,
      templateSuggestions: suggestTemplates(
        paths,
        content.templates.map((t) => t.pathPattern),
      ),
      hosts,
    };
  }

  // ── ссылка и сессии редактора (§5-кватер.2, §5-кватер.11 п.3) ──────────

  async editorLink(
    m: AccountMembership,
    siteId: string,
    body: unknown,
  ): Promise<EditorLinkView> {
    const db = this.db(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    const b = (body ?? {}) as {
      host?: unknown;
      path?: unknown;
      focus?: unknown;
    };
    const now = this.now();
    const hosts = (await this.siteHosts(db, siteId, now)).filter(
      (h) => h.scheme === 'https',
    );
    const want = typeof b.host === 'string' ? b.host : null;
    const h = want
      ? hosts.find(
          (x) => x.host === want || uiMapHost(x.host) === uiMapHost(want),
        )
      : hosts[0];
    if (!h)
      throw voiceMapError(
        HttpStatus.CONFLICT,
        'VOICE_MAP_HOST_REQUIRED',
        'Редактор — только на подтверждённом адресе сайта (не «Админки», без льготы)',
      );
    const path =
      typeof b.path === 'string' &&
      b.path.length <= 300 &&
      /^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/.test(b.path)
        ? b.path
        : '/';
    const focus =
      typeof b.focus === 'string' && VOICE_MAP_LIMITS.keyRe.test(b.focus)
        ? b.focus
        : null;
    const token = randomBytes(24).toString('base64url');
    const origin = hostOriginOf(h);
    const expiresAt = new Date(now.getTime() + VOICE_MAP_LIMITS.linkTtlMs);
    await db.assistSiteVoiceMapEditorSession.create({
      data: {
        accountId: m.accountId,
        siteId,
        memberId: m.memberId,
        hostId: h.id,
        host: h.host,
        parentOrigin: origin,
        pagePath: path,
        focusKey: focus,
        linkTokenHash: sha256Hex(token),
        linkExpiresAt: expiresAt,
      },
    });
    await db.assistSiteVoiceMapChange.create({
      data: {
        accountId: m.accountId,
        siteId,
        revision: 0,
        actor: m.memberId,
        source: 'tma',
        op: { op: 'editor-link', host: h.host },
      },
    });
    const u = new URL(path, origin);
    u.searchParams.set(WIDGET_EDITOR_PARAM, token);
    return { url: u.href, expiresAt: expiresAt.toISOString(), host: h.host };
  }

  async sessions(
    m: AccountMembership,
    siteId: string,
  ): Promise<{ items: EditorSessionSummary[] }> {
    const db = this.db(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    const now = this.now();
    const list = await db.assistSiteVoiceMapEditorSession.findMany({
      where: {
        siteId,
        revokedAt: null,
        OR: [
          { exchangedAt: null, linkExpiresAt: { gt: now } },
          { expiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      items: list.map((s) => ({
        id: s.id,
        host: s.host,
        pagePath: s.pagePath,
        memberId: s.memberId,
        createdAt: s.createdAt.toISOString(),
        exchangedAt: s.exchangedAt ? s.exchangedAt.toISOString() : null,
        expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
        lastSeenAt: s.lastSeenAt ? s.lastSeenAt.toISOString() : null,
      })),
    };
  }

  /** «Завершить все сессии» (или одну): следующая операция панели — 401. */
  async revokeSessions(
    m: AccountMembership,
    siteId: string,
    sid: string | null,
  ): Promise<{ revoked: number }> {
    const db = this.db(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    const u = await db.assistSiteVoiceMapEditorSession.updateMany({
      where: { siteId, revokedAt: null, ...(sid ? { id: sid } : {}) },
      data: { revokedAt: this.now(), revokeReason: 'tma' },
    });
    return { revoked: u.count };
  }

  // ── экспорт / импорт (§5-кватер.12) ────────────────────────────────────

  /**
   * Ключ подписи экспорта (аудит Н-5): свой `ASSIST_VOICE_MAP_EXPORT_KEY`
   * или ПРОИЗВОДНЫЙ от `ASSIST_SECRETS_KEY` с меткой — сам KEK как ключ
   * HMAC файла, который уходит владельцу, не используется (тот же приём,
   * что lead-crypto). Нет ни того, ни другого — `null`: подпись в файле
   * есть (формат), но признаком «наш файл» не считается.
   */
  private signKey(): Buffer | null {
    const own = this.env.ASSIST_VOICE_MAP_EXPORT_KEY?.trim();
    if (own) return Buffer.from(own, 'utf8');
    const kek = this.env.ASSIST_SECRETS_KEY?.trim();
    if (kek)
      return createHmac('sha256', kek).update(VOICE_MAP_EXPORT_LABEL).digest();
    return null;
  }

  private signature(payload: unknown): string {
    return createHmac('sha256', this.signKey() ?? UNSIGNED_EXPORT_KEY)
      .update(canonicalJson(payload))
      .digest('base64url');
  }

  /** Подпись файла сошлась (за постоянное время; без ключа — никогда). */
  private signatureValid(payload: unknown, got: unknown): boolean {
    if (typeof got !== 'string' || !this.signKey()) return false;
    const a = Buffer.from(got, 'utf8');
    const b = Buffer.from(this.signature(payload), 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async exportFile(
    m: AccountMembership,
    siteId: string,
  ): Promise<VoiceMapExportView> {
    const db = this.db(m.accountId);
    const { site } = await loadAssistSite(db, m.accountId, siteId);
    const row = await this.loadMap(db, m.accountId, siteId);
    const payload = exportPayload(
      versionContent(parseVoiceMapContent(row.draft)),
    );
    const slug =
      (site.name || 'site')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'site';
    return {
      name: `voice-map.${slug}.site.v${row.publishedVersion}.json`,
      file: { ...payload, signature: this.signature(payload) },
    };
  }

  /**
   * Импорт — в черновик пакетом операций со всеми проверками; отклонённые
   * цели — в отчёт. `kind: admin` — отказ целиком. Подпись — только пометка
   * «наш файл без правок», не запрет.
   */
  async importFile(
    m: AccountMembership,
    siteId: string,
    body: unknown,
  ): Promise<VoiceMapImportView> {
    const db = this.db(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    const b = (body ?? {}) as { expectedRevision?: unknown; file?: unknown };
    const file = (b.file ?? null) as Record<string, unknown> | null;
    const parsed = importOps(file, () => `t-${randomBytes(5).toString('hex')}`);
    if (!parsed.ok)
      throw voiceMapError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        parsed.reason === 'kind'
          ? 'VOICE_MAP_IMPORT_KIND'
          : 'VOICE_MAP_IMPORT_FORMAT',
        parsed.reason === 'kind'
          ? 'Файл карты другого вида («Админка») — в карту «Сайта» не импортируется'
          : 'Это не файл голосовой карты',
      );
    const { signature, ...payload } = file as Record<string, unknown>;
    const signed = this.signatureValid(payload, signature);
    // Проверка по одной операции: отклонённая цель не валит пакет.
    const row = await this.loadMap(db, m.accountId, siteId);
    if (row.draftRevision !== b.expectedRevision) throw this.conflict();
    const hosts = this.hostNames(await this.siteHosts(db, siteId, this.now()));
    let content = parseVoiceMapContent(row.draft);
    const accepted: unknown[] = [];
    const rejected: VoiceMapImportView['rejected'] = [];
    parsed.ops.forEach((op, index) => {
      const r = applyMapOps(content, [op], {
        hosts,
        newId: () => `t-${randomBytes(5).toString('hex')}`,
        source: 'import',
      });
      if (r.issues.length) {
        const t = (op as { target?: { key?: unknown } }).target;
        rejected.push({
          index,
          key: typeof t?.key === 'string' ? t.key : null,
          code: r.issues[0].code,
        });
      } else {
        content = r.content;
        accepted.push(op);
      }
    });
    let revision = row.draftRevision;
    if (accepted.length) {
      const res = await this.patch(
        { accountId: m.accountId, memberId: m.memberId },
        siteId,
        { expectedRevision: row.draftRevision, ops: accepted },
        'import',
      );
      revision = res.revision;
    }
    return {
      revision,
      accepted: accepted.filter(
        (o) => (o as { op: string }).op === 'upsert-target',
      ).length,
      rejected,
      signed,
    };
  }

  // ── шаблон платформы (§5-кватер.12; В-54: одна платформа — WooCommerce) ──

  async platformTemplate(
    m: AccountMembership,
    siteId: string,
    body: unknown,
  ): Promise<VoiceMapPatchView> {
    const db = this.db(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    const b = (body ?? {}) as {
      platform?: unknown;
      expectedRevision?: unknown;
    };
    const platform = typeof b.platform === 'string' ? b.platform : '';
    const row = await this.loadMap(db, m.accountId, siteId);
    const keys = new Set(
      parseVoiceMapContent(row.draft).targets.map((t) => t.key),
    );
    const ops = platformTemplateOps(platform, keys);
    if (!ops)
      throw voiceMapError(
        HttpStatus.BAD_REQUEST,
        'VOICE_MAP_INVALID',
        'Шаблон платформы не найден',
        { errors: [{ path: 'platform', code: 'bad_op' }] },
      );
    if (!ops.length) return { revision: row.draftRevision, applied: 0 };
    const res = await this.patch(
      { accountId: m.accountId, memberId: m.memberId },
      siteId,
      { expectedRevision: b.expectedRevision, ops },
      'template',
    );
    await db.assistSiteVoiceMap.updateMany({
      where: { siteId },
      data: { platformTemplate: PLATFORM_TEMPLATES[platform].version },
    });
    return res;
  }
}
