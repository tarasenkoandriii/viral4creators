/**
 * Голосовая карта «Админки» — кабинет и общая часть редактора (заход 11,
 * №117; ТЗ помощника §5-кватер.2, §5-кватер.9 «Изоляция», §5-кватер.13;
 * К-9, В-55). Второй экземпляр карты Э6-тер: ядро (`assist-ui-core/
 * voice-map.ts` — операции, ворота, дифф, импорт/экспорт; `…/voice-map-
 * service-core.ts` — хеш, вид версии, подпись файла) ОБЩЕЕ с картой «Сайта»,
 * а таблицы (`assist_admin_voice_map*`), маршруты, хосты (роль `admin`),
 * origin панели (`wa.`) и журнал (`assist_admin_action_log`) — свои; модулей
 * «Сайта» не импортирует (граф admin↛site).
 *
 *  - права: ТОЛЬКО `assistAdmin: owner` (гвард маршрута TMA; сессия
 *    редактора перепроверяет участника на каждом запросе), менеджер и
 *    оператор «Сайта» — 403;
 *  - тариф: «Админка: действия» (Pro, В-55) — любое изменение карты, ссылка
 *    редактора, сборка, публикация, откат и импорт; без него — 402
 *    `ADMIN_VOICE_MAP_PLAN_REQUIRED` (сводка, черновик, версии, экспорт —
 *    читаются: тариф могли понизить, карта остаётся у владельца);
 *  - черновик — операции ядра (`applyMapOps`, риск только вверх,
 *    имена у «никогда» — 422) с `expectedRevision` (409 — две вкладки);
 *  - версии: сборка → ворота кода (`held`) → публикация ТОЛЬКО человеком в
 *    TMA (у сессии редактора маршрута публикации нет) → индекс фраз
 *    «Админки» (`assist_admin_phrases`, владелец `voice-map`: фраза мемо АМ-N
 *    и фраза карты не совпадут — ворота `memo_phrase`, гонка — 409);
 *    откат — новая версия с содержимым N; хранятся последние 20;
 *  - журнал: каждое изменение — строка `voice-map` в append-only
 *    `assist_admin_action_log` (кто, канал, что — сжатые операции без
 *    подписей страницы), как требует таблица изоляции §5-кватер.9.
 */
import { randomBytes } from 'crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WIDGET_EDITOR_PARAM } from '../../brand';
import { SitesDb } from '../../prisma/sites-db.service';
import { parseAdminMemo } from '../assist-admin-actions/admin-memo';
import { AdminActionLogService } from '../assist-admin-mode/action-log.service';
import {
  AdminModeService,
  parseRoleMap,
} from '../assist-admin-mode/admin-mode.service';
import { maskPagePath } from '../assist-ui-core/snapshot';
import {
  recipientsWithLang,
  sendToMembersByLang,
  type FetchLike,
} from '../assist-knowledge-core/notify';
import {
  applyMapOps,
  emptyVoiceMap,
  exportPayload,
  importOps,
  parseVoiceMapContent,
  targetPhrases,
  versionContent,
  voiceMapDiff,
  voiceMapGates,
  VOICE_MAP_LIMITS,
  type MapChangeSource,
  type MapGateReport,
  type VoiceMapContent,
} from '../assist-ui-core/voice-map';
import {
  editorFocusKey,
  editorLinkPath,
  mapExportSigner,
  mapIssuesToErrors,
  mapVersionSummary,
  mapVersionView,
  sha256Hex,
  voiceMapContentHash,
  type MapExportSigner,
} from '../assist-ui-core/voice-map-service-core';
import type { AccountMembership } from '../site-core/account/roles';
import { evaluateHostAccess } from '../site-core/ownership/host-access';
import { adminVoiceMapError } from './admin-voice-map-errors';
import { clearAdminVoiceMapCache } from './admin-voice-map-store';
import type {
  AdminEditorLinkView,
  AdminEditorSessionSummary,
  AdminVoiceMapDraftView,
  AdminVoiceMapExportView,
  AdminVoiceMapImportView,
  AdminVoiceMapPatchView,
  AdminVoiceMapSummaryView,
  AdminVoiceMapVersionSummary,
  AdminVoiceMapVersionView,
} from './api-types';

type Db = ReturnType<SitesDb['forAccount']>;

/** Кто меняет карту: владелец «Админки» в TMA или его сессия редактора `wa.`. */
export interface AdminMapActor {
  accountId: string;
  /** Участник кабинета (assistAdmin: owner). */
  memberId: string;
  /** Для журнала: `tg:<id>` (TMA) | `jwt:<sub>` (панель `wa.`). */
  actor: string;
  actorRole: string | null;
  channel: 'tma' | 'embed';
}

export function actorOfMember(m: AccountMembership): AdminMapActor {
  return {
    accountId: m.accountId,
    memberId: m.memberId,
    actor: `tg:${m.telegramId}`,
    actorRole: 'owner',
    channel: 'tma',
  };
}

interface HostRow {
  id: string;
  host: string;
  scheme: string;
  port: number;
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

/** Владелец фраз карты в общем индексе фраз «Админки». */
export const ADMIN_MAP_PHRASE_OWNER = 'voice-map';
/** Метка производного ключа подписи экспорта карты «Админки» (≠ «Сайта»). */
const EXPORT_LABEL = 'admin-voice-map-export-v1';
const UNSIGNED_EXPORT_KEY = 'v4c-admin-voice-map-export-unsigned';
/** Сжатых операций в одной строке журнала (остаток — счётчиком). */
const JOURNAL_OPS = 30;

@Injectable()
export class AdminVoiceMapService {
  private readonly logger = new Logger(AdminVoiceMapService.name);

  /**
   * Р-З11-А2-11 (аудит P2-1, ТЗ §5-кватер.2 «Админка»): обменять ссылку
   * редактора может только сотрудник «с ролью владельца у заказчика» —
   * чья роль из JWT в карте ролей «Админки» сопоставлена с ролью помощника
   * `owner` (и не тестовым ключом). Нет такой строки в карте — ссылку не
   * выдаём (409), чтобы владелец узнал об этом в TMA, а не в админке.
   */
  static readonly EDITOR_ROLE = 'owner';
  now: () => Date = () => new Date();
  env: NodeJS.ProcessEnv = process.env;
  /** Подмена отправки в бот — только тестами. */
  fetchImpl: FetchLike | undefined;

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly mode: AdminModeService,
    private readonly log: AdminActionLogService,
  ) {}

  db(accountId: string): Db {
    return this.sitesDb.forAccount(accountId);
  }

  // ── сайт, тариф, хосты «Админки» ────────────────────────────────────────

  /** Сайт кабинета (404 — не этого кабинета) и строка настроек «Админки». */
  async site(accountId: string, siteId: string) {
    const site = await this.mode.requireSite(accountId, siteId);
    const settings = await this.mode.ensureSettings(accountId, siteId);
    return { site, settings };
  }

  /** В-55: карта «Админки» — тариф Pro («Админка: действия»). */
  async requirePlan(accountId: string): Promise<void> {
    if (!(await this.mode.planAllowsActions(accountId, this.now())))
      throw adminVoiceMapError(
        HttpStatus.PAYMENT_REQUIRED,
        'ADMIN_VOICE_MAP_PLAN_REQUIRED',
        'Голосовая карта админки — в тарифе Pro',
      );
  }

  /**
   * Хосты САМОЙ админки (`adminHostIds`), verified для L1 `assist-admin`
   * без льготы (§5-кватер.2 «условия входа»): там открывается редактор, по
   * ним считается риск ссылок («чужой хост — никогда»).
   */
  async adminHosts(db: Db, siteId: string, now: Date): Promise<HostRow[]> {
    const s = await db.assistAdminSettings.findFirst({
      where: { siteId },
      select: { adminHostIds: true },
    });
    if (!s?.adminHostIds.length) return [];
    const hosts = await db.siteHost.findMany({
      where: { siteId, id: { in: s.adminHostIds } },
      orderBy: { createdAt: 'asc' },
    });
    return hosts.filter((h) => evaluateHostAccess(h, 'assist-admin', now).ok);
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
    const row = await db.assistAdminVoiceMap.findFirst({ where: { siteId } });
    if (row) return row;
    try {
      return await db.assistAdminVoiceMap.create({
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
        const again = await db.assistAdminVoiceMap.findFirst({
          where: { siteId },
        });
        if (again) return again;
      }
      throw e;
    }
  }

  /** Фразы опубликованных мемо АМ-N (`lang:norm`) — ворота «фраза мемо». */
  private async memoPhrases(db: Db, siteId: string): Promise<Set<string>> {
    const rows = await db.assistAdminPhrase.findMany({
      where: { siteId, owner: { not: ADMIN_MAP_PHRASE_OWNER } },
      select: { lang: true, norm: true },
      take: 2000,
    });
    return new Set(rows.map((r) => `${r.lang}:${r.norm}`));
  }

  /**
   * Опубликованные мемо АМ-N, чьи шаги на странице (`ui`) нажимают разметку
   * цели (`assistId`) — предупреждение ворот «затронутые мемо» (Р-З11-А4:
   * только предупреждение; живой план всё равно проверяет шаг кодом).
   */
  private async memoAssistIds(
    db: Db,
    siteId: string,
  ): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    const memos = await db.assistAdminMemo.findMany({
      where: {
        siteId,
        status: { in: ['published', 'needs_review'] },
        publishedVersion: { not: null },
      },
      select: { id: true, number: true, publishedVersion: true },
      take: 500,
    });
    if (!memos.length) return out;
    const num = new Map(memos.map((m) => [m.id, m.number]));
    const vers = await db.assistAdminMemoVersion.findMany({
      where: {
        OR: memos.map((m) => ({ memoId: m.id, number: m.publishedVersion! })),
      },
      select: { memoId: true, content: true },
    });
    for (const v of vers) {
      const n = num.get(v.memoId);
      if (n === undefined) continue;
      for (const st of parseAdminMemo(v.content).content.steps) {
        if (st.action !== 'ui' || !st.target?.assistId) continue;
        const list = out.get(st.target.assistId) ?? [];
        if (!list.includes(n)) list.push(n);
        out.set(st.target.assistId, list);
      }
    }
    return out;
  }

  private async publishedContent(
    db: Db,
    siteId: string,
    n: number,
  ): Promise<VoiceMapContent | null> {
    if (!n) return null;
    const v = await db.assistAdminVoiceMapVersion.findFirst({
      where: { siteId, number: n },
      select: { content: true },
    });
    return v ? parseVoiceMapContent(v.content) : null;
  }

  async gatesOf(
    db: Db,
    siteId: string,
    content: VoiceMapContent,
    previous?: VoiceMapContent | null,
  ): Promise<MapGateReport> {
    let prev = previous;
    if (prev === undefined) {
      const cur = await db.assistAdminVoiceMap.findFirst({
        where: { siteId },
        select: { publishedVersion: true },
      });
      prev = await this.publishedContent(
        db,
        siteId,
        cur?.publishedVersion ?? 0,
      );
    }
    return voiceMapGates(content, {
      memoPhrases: await this.memoPhrases(db, siteId),
      memoAssistIds: await this.memoAssistIds(db, siteId),
      previous: prev,
    });
  }

  async draft(
    m: AccountMembership,
    siteId: string,
  ): Promise<AdminVoiceMapDraftView> {
    await this.site(m.accountId, siteId);
    const db = this.db(m.accountId);
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
   * Пакет операций черновика (TMA, редактор `wa.`, импорт). Ревизия —
   * условным UPDATE (409); ошибка любой операции — 422 на весь пакет.
   */
  /** 400 без целой ревизии черновика — у правки и у импорта одинаково. */
  private needRevision(v: unknown): asserts v is number {
    if (typeof v !== 'number' || !Number.isInteger(v))
      throw adminVoiceMapError(
        HttpStatus.BAD_REQUEST,
        'VOICE_MAP_INVALID',
        'Нужна ревизия черновика (expectedRevision)',
        { errors: [{ path: 'expectedRevision', code: 'bad_op' }] },
      );
  }

  async patch(
    actor: AdminMapActor,
    siteId: string,
    body: unknown,
    source: MapChangeSource,
  ): Promise<AdminVoiceMapPatchView> {
    await this.requirePlan(actor.accountId);
    const db = this.db(actor.accountId);
    const b = (body ?? {}) as { expectedRevision?: unknown; ops?: unknown };
    this.needRevision(b.expectedRevision);
    const row = await this.loadMap(db, actor.accountId, siteId);
    if (row.draftRevision !== b.expectedRevision) throw this.conflict();
    const hosts = this.hostNames(await this.adminHosts(db, siteId, this.now()));
    const res = applyMapOps(parseVoiceMapContent(row.draft), b.ops, {
      hosts,
      newId: () => `t-${randomBytes(5).toString('hex')}`,
      source,
    });
    if (res.issues.length)
      throw adminVoiceMapError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'VOICE_MAP_INVALID',
        res.issues.some((i) => i.code === 'risk_lowering_forbidden')
          ? 'Риск можно только ужесточить'
          : 'Изменение карты не прошло проверку',
        { errors: mapIssuesToErrors(res.issues) },
      );
    return this.commitDraft(
      db,
      actor,
      siteId,
      b.expectedRevision,
      res.content,
      res.changes,
      source,
    );
  }

  private async commitDraft(
    db: Db,
    actor: AdminMapActor,
    siteId: string,
    expectedRevision: number,
    content: VoiceMapContent,
    changes: readonly Record<string, unknown>[],
    source: MapChangeSource,
  ): Promise<AdminVoiceMapPatchView> {
    const next = expectedRevision + 1;
    const upd = await db.assistAdminVoiceMap.updateMany({
      where: { siteId, draftRevision: expectedRevision },
      data: {
        draft: content as unknown as Prisma.InputJsonValue,
        draftRevision: next,
        updatedBy: actor.actor,
      },
    });
    if (upd.count !== 1) throw this.conflict();
    if (changes.length)
      await this.journal(actor, siteId, 'voice-map.draft', 'ok', {
        revision: next,
        source,
        ops: changes.slice(0, JOURNAL_OPS) as Prisma.InputJsonValue[],
        more: Math.max(0, changes.length - JOURNAL_OPS),
      });
    return { revision: next, applied: changes.length };
  }

  private conflict() {
    return adminVoiceMapError(
      HttpStatus.CONFLICT,
      'VOICE_MAP_CONFLICT',
      'Карту изменили в другой вкладке — обновите',
    );
  }

  /** Строка `voice-map` в append-only журнале действий «Админки». */
  async journal(
    actor: AdminMapActor,
    siteId: string,
    operation: string,
    outcome: string,
    request: Record<string, Prisma.InputJsonValue | null>,
  ): Promise<void> {
    await this.log.append(
      {
        accountId: actor.accountId,
        siteId,
        actor: actor.actor,
        actorRole: actor.actorRole,
        channel: actor.channel,
        conversationId: null,
        connectorId: null,
        operationRowId: null,
        operation,
        kind: 'voice-map',
        outcome,
        httpStatus: null,
        durationMs: null,
        requestMasked: request as Prisma.InputJsonValue,
        responseBytes: null,
        error: null,
      },
      this.now(),
    );
  }

  // ── версии ──────────────────────────────────────────────────────────────

  async buildVersion(
    actor: AdminMapActor,
    siteId: string,
    via: 'editor' | 'tma',
    rollbackOf: number | null = null,
  ): Promise<AdminVoiceMapVersionView> {
    await this.requirePlan(actor.accountId);
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
      const cur = await db.assistAdminVoiceMap.findFirst({
        where: { siteId },
        select: { versionSeq: true },
      });
      const seq = (cur?.versionSeq ?? 0) + 1;
      const u = await db.assistAdminVoiceMap.updateMany({
        where: { siteId, versionSeq: seq - 1 },
        data: { versionSeq: seq },
      });
      if (u.count === 1) number = seq;
    }
    if (!number) throw this.conflict();
    const v = await db.assistAdminVoiceMapVersion.create({
      data: {
        accountId: actor.accountId,
        siteId,
        number,
        status: gates.ok ? 'checking' : 'held',
        content: content as unknown as Prisma.InputJsonValue,
        contentHash: voiceMapContentHash(content),
        gateReport: gates as unknown as Prisma.InputJsonValue,
        rollbackOf,
        requestedBy: actor.actor,
        requestedVia: via,
      },
    });
    await this.trimVersions(db, siteId, row.publishedVersion);
    const prev = await this.publishedContent(db, siteId, row.publishedVersion);
    const view = mapVersionView(v, prev);
    await this.journal(actor, siteId, 'voice-map.version', v.status, {
      version: number,
      via,
      rollbackOf,
      problems: gates.problems.map((p) => p.code),
      diff: view.diff,
    });
    if (via === 'editor') await this.notifyRequest(actor, siteId, view);
    this.logger.log(
      `admin voice-map version site=${siteId} v=${number} status=${v.status} via=${via}`,
    );
    return view;
  }

  /** Хранятся последние 20 версий (опубликованная — всегда). */
  private async trimVersions(db: Db, siteId: string, published: number) {
    const old = await db.assistAdminVoiceMapVersion.findMany({
      where: { siteId },
      orderBy: { number: 'desc' },
      skip: VOICE_MAP_LIMITS.versionsKept,
      select: { id: true, number: true },
    });
    const ids = old.filter((o) => o.number !== published).map((o) => o.id);
    if (ids.length)
      await db.assistAdminVoiceMapVersion.deleteMany({
        where: { id: { in: ids } },
      });
  }

  /**
   * Запрос публикации из редактора — владельцам «Админки» в бот, на их
   * языке; публикуют они в TMA (кнопка — вкладка «Голос» «Админки»).
   */
  private async notifyRequest(
    actor: AdminMapActor,
    siteId: string,
    v: AdminVoiceMapVersionView,
  ): Promise<void> {
    try {
      const d = `+${v.diff.added} ~${v.diff.changed} −${v.diff.removed}`;
      await sendToMembersByLang({
        recipients: await recipientsWithLang(
          this.sitesDb,
          actor.accountId,
          (m) => m.role === 'owner' || m.productRoles.assistAdmin === 'owner',
        ),
        texts: {
          uk: {
            text: `Опублікувати голосову карту адмінки v${v.number}? ${d} · ${v.ok ? 'ворота: зелені' : `ворота: ${v.problems} проблем — версію затримано`}`,
            button: 'Відкрити',
          },
          ru: {
            text: `Опубликовать голосовую карту админки v${v.number}? ${d} · ${v.ok ? 'ворота: зелёные' : `ворота: ${v.problems} проблем — версия задержана`}`,
            button: 'Открыть',
          },
          en: {
            text: `Publish the admin voice map v${v.number}? ${d} · ${v.ok ? 'gates: green' : `gates: ${v.problems} problems — version held`}`,
            button: 'Open',
          },
        },
        hashPath: `/sites/${siteId}/admin-mode/voice`,
        env: this.env,
        fetchImpl: this.fetchImpl,
      });
    } catch {
      /* уведомление — справочно: запрос уже в TMA */
    }
  }

  private versionNotFound() {
    return adminVoiceMapError(
      HttpStatus.NOT_FOUND,
      'VOICE_MAP_VERSION_NOT_FOUND',
      'Версия не найдена',
    );
  }

  private async version(db: Db, siteId: string, n: string | number) {
    const num = typeof n === 'number' ? n : Number(n);
    if (!Number.isInteger(num) || num < 1) throw this.versionNotFound();
    const v = await db.assistAdminVoiceMapVersion.findFirst({
      where: { siteId, number: num },
    });
    if (!v) throw this.versionNotFound();
    return v;
  }

  async versions(
    m: AccountMembership,
    siteId: string,
  ): Promise<{ items: AdminVoiceMapVersionSummary[] }> {
    await this.site(m.accountId, siteId);
    const db = this.db(m.accountId);
    const row = await this.loadMap(db, m.accountId, siteId);
    const prev = await this.publishedContent(db, siteId, row.publishedVersion);
    const list: VersionRow[] = await db.assistAdminVoiceMapVersion.findMany({
      where: { siteId },
      orderBy: { number: 'desc' },
      take: VOICE_MAP_LIMITS.versionsKept,
    });
    return { items: list.map((v) => mapVersionSummary(v, prev)) };
  }

  async getVersion(
    m: AccountMembership,
    siteId: string,
    n: string,
  ): Promise<AdminVoiceMapVersionView> {
    await this.site(m.accountId, siteId);
    const db = this.db(m.accountId);
    const row = await this.loadMap(db, m.accountId, siteId);
    const v = await this.version(db, siteId, n);
    const prev =
      row.publishedVersion && row.publishedVersion !== v.number
        ? await this.publishedContent(db, siteId, row.publishedVersion)
        : null;
    return mapVersionView(v, prev);
  }

  /**
   * Публикация — только владельцем «Админки» в TMA: ворота пересчитываются
   * (фразы мемо могли измениться), индекс фраз и номер — в транзакции.
   */
  async publish(
    m: AccountMembership,
    siteId: string,
    n: string,
  ): Promise<AdminVoiceMapVersionView> {
    await this.site(m.accountId, siteId);
    await this.requirePlan(m.accountId);
    const actor = actorOfMember(m);
    const db = this.db(m.accountId);
    const row = await this.loadMap(db, m.accountId, siteId);
    const v = await this.version(db, siteId, n);
    if (v.status !== 'checking')
      throw adminVoiceMapError(
        HttpStatus.CONFLICT,
        'VOICE_MAP_VERSION_STATE',
        `Версия в статусе «${v.status}» — публикуется только версия на проверке`,
      );
    const content = parseVoiceMapContent(v.content);
    const gates = await this.gatesOf(
      db,
      siteId,
      content,
      await this.publishedContent(db, siteId, row.publishedVersion),
    );
    if (!gates.ok) {
      await db.assistAdminVoiceMapVersion.updateMany({
        where: { id: v.id, status: 'checking' },
        data: {
          status: 'held',
          gateReport: gates as unknown as Prisma.InputJsonValue,
        },
      });
      throw adminVoiceMapError(
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
        const u = await tx.assistAdminVoiceMap.updateMany({
          where: { siteId, publishedVersion: row.publishedVersion },
          data: { publishedVersion: v.number },
        });
        if (u.count !== 1) throw this.conflict();
        const vu = await tx.assistAdminVoiceMapVersion.updateMany({
          where: { id: v.id, status: 'checking' },
          data: {
            status: 'published',
            publishedBy: actor.actor,
            publishedAt: now,
          },
        });
        if (vu.count !== 1) throw this.conflict();
        await tx.assistAdminPhrase.deleteMany({
          where: { siteId, owner: ADMIN_MAP_PHRASE_OWNER },
        });
        if (phrases.size)
          await tx.assistAdminPhrase.createMany({
            data: [...phrases.values()].map((p) => ({
              siteId,
              accountId: m.accountId,
              lang: p.lang,
              norm: p.norm,
              owner: ADMIN_MAP_PHRASE_OWNER,
              kind: p.kind,
            })),
          });
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        throw adminVoiceMapError(
          HttpStatus.CONFLICT,
          'VOICE_MAP_PHRASE_TAKEN',
          'Фраза карты уже занята мемо — переименуйте и соберите заново',
        );
      throw e;
    }
    clearAdminVoiceMapCache(siteId);
    await this.journal(actor, siteId, 'voice-map.publish', 'published', {
      version: v.number,
      previous: row.publishedVersion,
      targets: gates.counts.targets,
      denylisted: gates.counts.denylisted,
      warnings: gates.warnings.map((w) => w.code),
    });
    this.logger.log(
      `admin voice-map publish site=${siteId} v=${v.number} member=${m.memberId}`,
    );
    const fresh = await this.version(db, siteId, v.number);
    const prev = await this.publishedContent(db, siteId, row.publishedVersion);
    return mapVersionView(fresh, prev);
  }

  async discard(
    m: AccountMembership,
    siteId: string,
    n: string,
  ): Promise<AdminVoiceMapVersionView> {
    await this.site(m.accountId, siteId);
    const db = this.db(m.accountId);
    const v = await this.version(db, siteId, n);
    const u = await db.assistAdminVoiceMapVersion.updateMany({
      where: { id: v.id, status: { in: ['checking', 'held'] } },
      data: { status: 'discarded' },
    });
    if (u.count !== 1)
      throw adminVoiceMapError(
        HttpStatus.CONFLICT,
        'VOICE_MAP_VERSION_STATE',
        'Отклонить можно только версию на проверке или задержанную',
      );
    await this.journal(actorOfMember(m), siteId, 'voice-map.discard', 'ok', {
      version: v.number,
    });
    return this.getVersion(m, siteId, String(v.number));
  }

  /** «Вернуть версию N» = новая версия с содержимым N (ворота и подтверждение). */
  async rollback(
    m: AccountMembership,
    siteId: string,
    n: string,
  ): Promise<AdminVoiceMapVersionView> {
    await this.site(m.accountId, siteId);
    const db = this.db(m.accountId);
    const v = await this.version(db, siteId, n);
    if (v.status !== 'published')
      throw adminVoiceMapError(
        HttpStatus.CONFLICT,
        'VOICE_MAP_VERSION_STATE',
        'Вернуть можно только бывшую опубликованную версию',
      );
    return this.buildVersion(actorOfMember(m), siteId, 'tma', v.number);
  }

  // ── сводка TMA ──────────────────────────────────────────────────────────

  async summary(
    m: AccountMembership,
    siteId: string,
  ): Promise<AdminVoiceMapSummaryView> {
    await this.site(m.accountId, siteId);
    const db = this.db(m.accountId);
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
    const active = await db.assistAdminVoiceMapEditorSession.count({
      where: {
        siteId,
        revokedAt: null,
        OR: [
          { exchangedAt: null, linkExpiresAt: { gt: now } },
          { expiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
        ],
      },
    });
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
      hosts: this.hostNames(await this.adminHosts(db, siteId, now)),
      planAllows: await this.mode.planAllowsActions(m.accountId, now),
    };
  }

  // ── ссылка и сессии редактора (§5-кватер.2 «Админка») ───────────────────

  /**
   * Одноразовая ссылка `?v4c_edit=` на verified-хост САМОЙ админки (10 мин,
   * в базе — SHA-256). Открыть её может только тот, у кого на странице
   * админки живая сессия сотрудника `wa.` (employee-JWT заказчика): обмен
   * привязывает сессию редактора к ней (`AdminEditorSessionService`).
   */
  async editorLink(
    m: AccountMembership,
    siteId: string,
    body: unknown,
  ): Promise<AdminEditorLinkView> {
    const { settings } = await this.site(m.accountId, siteId);
    await this.requirePlan(m.accountId);
    if (
      !Object.values(parseRoleMap(settings.roleMap) ?? {}).includes(
        AdminVoiceMapService.EDITOR_ROLE,
      )
    )
      throw adminVoiceMapError(
        HttpStatus.CONFLICT,
        'ADMIN_VOICE_MAP_OWNER_ROLE_REQUIRED',
        'Редактор карты открывает только владелец: в карте ролей «Админки» сопоставьте свою роль у заказчика с ролью помощника owner',
      );
    const db = this.db(m.accountId);
    const b = (body ?? {}) as {
      host?: unknown;
      path?: unknown;
      focus?: unknown;
    };
    const now = this.now();
    const hosts = (await this.adminHosts(db, siteId, now)).filter(
      (h) => h.scheme === 'https',
    );
    const want = typeof b.host === 'string' ? b.host.toLowerCase() : null;
    const h = want ? hosts.find((x) => x.host === want) : hosts[0];
    if (!h)
      throw adminVoiceMapError(
        HttpStatus.CONFLICT,
        'ADMIN_VOICE_MAP_HOST_REQUIRED',
        'Редактор карты админки — только на подтверждённом адресе самой админки (без льготы)',
      );
    const path = editorLinkPath(b.path);
    const focus = editorFocusKey(b.focus);
    const token = randomBytes(24).toString('base64url');
    const origin =
      h.port === (h.scheme === 'https' ? 443 : 80)
        ? `${h.scheme}://${h.host}`
        : `${h.scheme}://${h.host}:${h.port}`;
    const expiresAt = new Date(now.getTime() + VOICE_MAP_LIMITS.linkTtlMs);
    await db.assistAdminVoiceMapEditorSession.create({
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
    await this.journal(
      actorOfMember(m),
      siteId,
      'voice-map.editor-link',
      'ok',
      // Аудит P3-2: путь страницы — без ПД (e-mail, номера) в журнале.
      { host: h.host, path: maskPagePath(path) },
    );
    const u = new URL(path, origin);
    u.searchParams.set(WIDGET_EDITOR_PARAM, token);
    return { url: u.href, expiresAt: expiresAt.toISOString(), host: h.host };
  }

  async sessions(
    m: AccountMembership,
    siteId: string,
  ): Promise<{ items: AdminEditorSessionSummary[] }> {
    await this.site(m.accountId, siteId);
    const now = this.now();
    const list = await this.db(
      m.accountId,
    ).assistAdminVoiceMapEditorSession.findMany({
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
        employeeRef: s.employeeRef,
        createdAt: s.createdAt.toISOString(),
        exchangedAt: s.exchangedAt ? s.exchangedAt.toISOString() : null,
        expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
        lastSeenAt: s.lastSeenAt ? s.lastSeenAt.toISOString() : null,
      })),
    };
  }

  /** «Завершить все сессии» (или одну): следующий запрос панели — 401. */
  async revokeSessions(
    m: AccountMembership,
    siteId: string,
    sid: string | null,
  ): Promise<{ revoked: number }> {
    await this.site(m.accountId, siteId);
    const u = await this.db(
      m.accountId,
    ).assistAdminVoiceMapEditorSession.updateMany({
      where: { siteId, revokedAt: null, ...(sid ? { id: sid } : {}) },
      data: { revokedAt: this.now(), revokeReason: 'tma' },
    });
    if (u.count)
      await this.journal(
        actorOfMember(m),
        siteId,
        'voice-map.editor-revoke',
        'ok',
        { sessions: u.count, one: !!sid },
      );
    return { revoked: u.count };
  }

  // ── экспорт / импорт (§5-кватер.12; файл `kind: admin`) ─────────────────

  private signer(): MapExportSigner {
    return mapExportSigner(this.env, {
      ownKeyEnv: 'ASSIST_ADMIN_VOICE_MAP_EXPORT_KEY',
      label: EXPORT_LABEL,
      unsignedKey: UNSIGNED_EXPORT_KEY,
    });
  }

  async exportFile(
    m: AccountMembership,
    siteId: string,
  ): Promise<AdminVoiceMapExportView> {
    const { site } = await this.site(m.accountId, siteId);
    const row = await this.loadMap(this.db(m.accountId), m.accountId, siteId);
    // Мемо «Админки» в файл карты не входят (у АМ-N свой формат и шаги API).
    const payload = exportPayload(
      versionContent(parseVoiceMapContent(row.draft)),
      undefined,
      'admin',
    );
    const slug =
      (site.name || 'site')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'site';
    return {
      name: `voice-map.${slug}.admin.v${row.publishedVersion}.json`,
      file: { ...payload, signature: this.signer().sign(payload) },
    };
  }

  /**
   * Импорт — в черновик по одной операции (отклонённые цели — в отчёт);
   * файл карты «Сайта» (`kind: site`) — отказ целиком (У-28).
   */
  async importFile(
    m: AccountMembership,
    siteId: string,
    body: unknown,
  ): Promise<AdminVoiceMapImportView> {
    await this.site(m.accountId, siteId);
    await this.requirePlan(m.accountId);
    const db = this.db(m.accountId);
    const b = (body ?? {}) as { expectedRevision?: unknown; file?: unknown };
    this.needRevision(b.expectedRevision);
    const file = (b.file ?? null) as Record<string, unknown> | null;
    const parsed = importOps(
      file,
      () => `t-${randomBytes(5).toString('hex')}`,
      'admin',
    );
    if (!parsed.ok)
      throw adminVoiceMapError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        parsed.reason === 'kind'
          ? 'VOICE_MAP_IMPORT_KIND'
          : 'VOICE_MAP_IMPORT_FORMAT',
        parsed.reason === 'kind'
          ? 'Файл карты другого вида («Сайт») — в карту «Админки» не импортируется'
          : 'Это не файл голосовой карты',
      );
    const { signature, ...payload } = file as Record<string, unknown>;
    const signed = this.signer().valid(payload, signature);
    const row = await this.loadMap(db, m.accountId, siteId);
    if (row.draftRevision !== b.expectedRevision) throw this.conflict();
    const hosts = this.hostNames(await this.adminHosts(db, siteId, this.now()));
    let content = parseVoiceMapContent(row.draft);
    const changes: Record<string, unknown>[] = [];
    let accepted = 0;
    const rejected: AdminVoiceMapImportView['rejected'] = [];
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
        changes.push(...r.changes);
        if (op.op === 'upsert-target') accepted++;
      }
    });
    let revision = row.draftRevision;
    if (changes.length) {
      const res = await this.commitDraft(
        db,
        actorOfMember(m),
        siteId,
        row.draftRevision,
        content,
        changes,
        'import',
      );
      revision = res.revision;
    }
    return { revision, accepted, rejected, signed };
  }
}
