/**
 * Сессия редактора карты «Админки» и действия панели (iframe `wa.`) —
 * заход 11 (№117), ТЗ помощника §5-кватер.2 «Админка», §5-кватер.3,
 * §5-кватер.13 (`/assist-admin/v1/editor/*` — «то же + employee-JWT
 * владельца»). Образец — редактор «Сайта» (`assist-site-voice-map/editor/
 * editor-session.service.ts`); отличия «Админки»:
 *
 *  - ДВА допуска на каждом запросе: сессия сотрудника `wa.` (заголовок
 *    `X-Assist-Admin-Session`, employee-JWT заказчика → наша сессия) и
 *    сессия редактора (`X-Assist-Editor`). Ссылку из TMA выдаёт только
 *    `assistAdmin: owner` (токен доказывает «это владелец кабинета»), а
 *    обменять её можно только из живой сессии сотрудника той же «Админки»
 *    (JWT доказывает «это его сессия в его админке»): обмен привязывает
 *    сессию редактора к ЭТОЙ сессии и её `sub` — другая сессия (другой
 *    сотрудник, другая вкладка после выхода) получает 401;
 *  - хост — verified-хост САМОЙ админки (L1 `assist-admin`, без льготы);
 *  - на каждом запросе: участник всё ещё `assistAdmin: owner`, хост всё ещё
 *    хост админки, тариф всё ещё Pro — иначе сессия гаснет (401);
 *  - «Сказать сейчас» — показ плана по ЧЕРНОВИКУ карты с проверками
 *    «Админки» (`checkAdminPlan`, правила кабинета), без нажатий и без
 *    модели; публикация из панели — 403 (только в TMA);
 *  - (раунд исправлений захода 11) обменять ссылку и работать в редакторе
 *    может только сотрудник с ролью владельца у заказчика: роль JWT в карте
 *    ролей «Админки» → `owner`, не тестовый ключ (аудит P2-1);
 *  - `rebind`: сессия сотрудника живёт до `exp` JWT (≤ 15 мин), а редактор —
 *    30 мин бездействия и ≤ 4 ч (ТЗ §5-кватер.14 п.1): панель берёт свежий
 *    JWT, новую сессию сотрудника и перепривязывает к ней редактор — ТОЛЬКО
 *    тот же сотрудник (`sub`) того же сайта (аудит P1-1).
 * Основная роль: сессия ищется системным чтением по хешу токена, дальше —
 * клиент тенанта.
 */
import { randomBytes } from 'crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { AssistAdminVoiceMapEditorSession } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import type { ResolvedAdminSession } from '../../assist-admin-chat/admin-session.service';
import {
  adminRulesOf,
  checkAdminPlan,
  defaultAdminRules,
} from '../../assist-admin-voice/admin-voice-rules';
import { directPlan } from '../../assist-ui-core/direct-plan';
import { onSiteHost } from '../../assist-ui-core/plan-checks';
import {
  cleanText,
  maskPagePath,
  parseSnapshot,
  snapshotTooLarge,
} from '../../assist-ui-core/snapshot';
import {
  directMapPlan,
  mapHintsOf,
  parseVoiceMapContent,
  resolveVoiceMap,
  targetsForPage,
  templateFor,
  versionContent,
  VOICE_MAP_LIMITS,
} from '../../assist-ui-core/voice-map';
import {
  editorLinkPath,
  sha256Hex,
  utcDay,
} from '../../assist-ui-core/voice-map-service-core';
import {
  parseAccountRole,
  parseProductRoles,
  REQUIRE_ASSIST_ADMIN_OWNER,
  satisfiesProductRoles,
} from '../../site-core/account/roles';
import { adminVoiceMapError } from '../admin-voice-map-errors';
import {
  AdminVoiceMapService,
  type AdminMapActor,
} from '../admin-voice-map.service';
import type {
  AdminEditorMapView,
  AdminEditorSessionView,
  AdminEditorTryView,
  AdminVoiceMapPatchView,
  AdminVoiceMapVersionView,
} from '../api-types';

export interface ResolvedAdminEditor {
  sessionId: string;
  accountId: string;
  siteId: string;
  memberId: string;
  hostId: string;
  host: string;
  origin: string;
  /** Сотрудник `wa.` (`jwt:<sub>`), с чьей сессией обменяна ссылка. */
  employeeRef: string;
  customerRole: string | null;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

@Injectable()
export class AdminEditorSessionService {
  private readonly logger = new Logger(AdminEditorSessionService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly maps: AdminVoiceMapService,
  ) {}

  private sys() {
    return this.sitesDb.system(
      'редактор карты «Админки»: сессия по хешу токена — кабинет берётся из строки сессии',
    );
  }

  private invalidLink() {
    return adminVoiceMapError(
      HttpStatus.FORBIDDEN,
      'EDITOR_LINK_INVALID',
      'Ссылка редактора недействительна или уже использована — возьмите новую в Telegram',
    );
  }

  /** Сотрудник — владелец у заказчика (роль JWT → `owner`), не тестовый ключ. */
  private ownerRole(s: ResolvedAdminSession): boolean {
    return !s.testKey && s.role === AdminVoiceMapService.EDITOR_ROLE;
  }

  private notOwner() {
    return adminVoiceMapError(
      HttpStatus.FORBIDDEN,
      'EDITOR_OWNER_REQUIRED',
      'Редактор карты — только владельцу у заказчика: роль в карте ролей «Админки» должна быть owner',
    );
  }

  private expired() {
    return adminVoiceMapError(
      HttpStatus.UNAUTHORIZED,
      'EDITOR_SESSION_EXPIRED',
      'Сессия редактора завершена — откройте редактор заново из Telegram',
    );
  }

  /** Участник по-прежнему владелец «Админки» (В-49 — делегирования нет). */
  private async memberOk(accountId: string, memberId: string) {
    const m = await this.sitesDb
      .forAccount(accountId)
      .siteAccountMember.findFirst({
        where: { id: memberId },
        select: { role: true, productRoles: true },
      });
    const role = m ? parseAccountRole(m.role) : null;
    return (
      !!m &&
      !!role &&
      satisfiesProductRoles(
        { role, productRoles: parseProductRoles(m.productRoles) },
        REQUIRE_ASSIST_ADMIN_OWNER,
      )
    );
  }

  /** Хост ссылки — всё ещё verified-хост самой админки; тариф — всё ещё Pro. */
  private async accessOk(accountId: string, siteId: string, hostId: string) {
    const db = this.sitesDb.forAccount(accountId);
    const hosts = await this.maps.adminHosts(db, siteId, this.now());
    if (!hosts.some((h) => h.id === hostId)) return false;
    try {
      await this.maps.requirePlan(accountId);
      return true;
    } catch {
      return false;
    }
  }

  private actor(ed: ResolvedAdminEditor): AdminMapActor {
    return {
      accountId: ed.accountId,
      memberId: ed.memberId,
      actor: ed.employeeRef,
      actorRole: ed.customerRole,
      channel: 'embed',
    };
  }

  /**
   * Обмен одноразовой ссылки на сессию редактора — из живой сессии
   * сотрудника `wa.` ЭТОЙ «Админки». Любой отказ — один код 403 (не оракул).
   */
  async exchange(
    s: ResolvedAdminSession,
    body: unknown,
  ): Promise<AdminEditorSessionView> {
    const b = (body ?? {}) as { token?: unknown; parentOrigin?: unknown };
    // До поиска ссылки: отказ по роли ничего не говорит о токене.
    if (!this.ownerRole(s)) throw this.notOwner();
    if (typeof b.token !== 'string' || !TOKEN_RE.test(b.token))
      throw this.invalidLink();
    const now = this.now();
    const row = await this.sys().assistAdminVoiceMapEditorSession.findFirst({
      where: { linkTokenHash: sha256Hex(b.token) },
    });
    if (
      !row ||
      row.siteId !== s.siteId ||
      row.accountId !== s.accountId ||
      row.exchangedAt ||
      row.revokedAt ||
      row.linkExpiresAt.getTime() <= now.getTime() ||
      typeof b.parentOrigin !== 'string' ||
      b.parentOrigin !== row.parentOrigin
    )
      throw this.invalidLink();
    if (
      !(await this.memberOk(row.accountId, row.memberId)) ||
      !(await this.accessOk(row.accountId, row.siteId, row.hostId))
    )
      throw this.invalidLink();
    const session = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + VOICE_MAP_LIMITS.sessionIdleMs);
    const absolute = new Date(now.getTime() + VOICE_MAP_LIMITS.sessionAbsMs);
    const u = await this.sitesDb
      .forAccount(row.accountId)
      .assistAdminVoiceMapEditorSession.updateMany({
        where: { id: row.id, exchangedAt: null, revokedAt: null },
        data: {
          exchangedAt: now,
          sessionTokenHash: sha256Hex(session),
          adminSessionId: s.sessionId,
          employeeRef: s.employeeRef,
          expiresAt,
          absoluteExpiresAt: absolute,
          lastSeenAt: now,
        },
      });
    if (u.count !== 1) throw this.invalidLink();
    await this.maps.journal(
      {
        accountId: row.accountId,
        memberId: row.memberId,
        actor: s.employeeRef,
        actorRole: s.customerRole,
        channel: 'embed',
      },
      row.siteId,
      'voice-map.editor-session',
      'started',
      { session: row.id, host: row.host, path: maskPagePath(row.pagePath) },
    );
    this.logger.log(`admin editor session site=${row.siteId} s=${row.id}`);
    return {
      session,
      expiresAt: expiresAt.toISOString(),
      absoluteExpiresAt: absolute.toISOString(),
      pagePath: row.pagePath,
      focusKey: row.focusKey,
      host: row.host,
      kind: 'admin',
    };
  }

  /**
   * Гвард каждого запроса панели: сессия редактора жива и привязана к ЭТОЙ
   * сессии сотрудника; право, хост и тариф — живые.
   */
  async resolve(
    s: ResolvedAdminSession,
    header: unknown,
  ): Promise<ResolvedAdminEditor> {
    const now = this.now();
    const row = await this.live(s, header, now);
    // Чужая сессия сотрудника (другая сессия, другой `sub`) — отказ без
    // отзыва: владелец сессии редактора её не терял.
    if (row.adminSessionId !== s.sessionId) throw this.expired();
    return this.touch(row, s, now);
  }

  /**
   * Сессия редактора жива (не отозвана, 30 мин бездействия, ≤ 4 ч), того же
   * сайта и ТОГО ЖЕ сотрудника (`sub`), что обменял ссылку; сотрудник — всё
   * ещё владелец у заказчика (роль могли убрать из карты ролей).
   */
  private async live(s: ResolvedAdminSession, header: unknown, now: Date) {
    if (typeof header !== 'string' || !TOKEN_RE.test(header))
      throw this.expired();
    const row = await this.sys().assistAdminVoiceMapEditorSession.findFirst({
      where: { sessionTokenHash: sha256Hex(header) },
    });
    if (
      !row ||
      row.revokedAt ||
      !row.expiresAt ||
      !row.absoluteExpiresAt ||
      row.expiresAt.getTime() <= now.getTime() ||
      row.absoluteExpiresAt.getTime() <= now.getTime() ||
      row.siteId !== s.siteId ||
      row.accountId !== s.accountId ||
      row.employeeRef !== s.employeeRef ||
      !this.ownerRole(s)
    )
      throw this.expired();
    return row as typeof row & { absoluteExpiresAt: Date };
  }

  /** Право, хост и тариф — живые; скользящий срок; вид для гварда. */
  private async touch(
    row: AssistAdminVoiceMapEditorSession & { absoluteExpiresAt: Date },
    s: ResolvedAdminSession,
    now: Date,
    adminSessionId?: string,
  ): Promise<ResolvedAdminEditor> {
    const db = this.sitesDb.forAccount(row.accountId);
    if (
      !(await this.memberOk(row.accountId, row.memberId)) ||
      !(await this.accessOk(row.accountId, row.siteId, row.hostId))
    ) {
      await db.assistAdminVoiceMapEditorSession.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'access' },
      });
      throw this.expired();
    }
    const slide = Math.min(
      now.getTime() + VOICE_MAP_LIMITS.sessionIdleMs,
      row.absoluteExpiresAt.getTime(),
    );
    const u = await db.assistAdminVoiceMapEditorSession.updateMany({
      where: {
        id: row.id,
        revokedAt: null,
        // Перепривязка — только с той сессии, что видели (гонка двух вкладок).
        ...(adminSessionId ? { adminSessionId: row.adminSessionId } : {}),
      },
      data: {
        expiresAt: new Date(slide),
        lastSeenAt: now,
        ...(adminSessionId ? { adminSessionId } : {}),
      },
    });
    if (adminSessionId && u.count !== 1) throw this.expired();
    return {
      sessionId: row.id,
      accountId: row.accountId,
      siteId: row.siteId,
      memberId: row.memberId,
      hostId: row.hostId,
      host: row.host,
      origin: row.parentOrigin,
      employeeRef: s.employeeRef,
      customerRole: s.customerRole,
    };
  }

  /**
   * Перепривязка живой сессии редактора к НОВОЙ сессии сотрудника (свежий
   * JWT после `exp`): тот же `sub`, тот же сайт, роль владельца; иначе 401.
   * Срок редактора (30 мин / 4 ч) не продлевается сверх обычного.
   */
  async rebind(
    s: ResolvedAdminSession,
    header: unknown,
  ): Promise<{ expiresAt: string; absoluteExpiresAt: string }> {
    const now = this.now();
    const row = await this.live(s, header, now);
    const ed = await this.touch(row, s, now, s.sessionId);
    if (row.adminSessionId !== s.sessionId)
      await this.maps.journal(
        this.actor(ed),
        ed.siteId,
        'voice-map.editor-session',
        'rebound',
        {
          session: row.id,
        },
      );
    const fresh = await this.sitesDb
      .forAccount(row.accountId)
      .assistAdminVoiceMapEditorSession.findFirst({
        where: { id: row.id },
        select: { expiresAt: true, absoluteExpiresAt: true },
      });
    return {
      expiresAt: (fresh?.expiresAt ?? now).toISOString(),
      absoluteExpiresAt: (fresh?.absoluteExpiresAt ?? now).toISOString(),
    };
  }

  async exit(ed: ResolvedAdminEditor): Promise<{ ok: true }> {
    await this.sitesDb
      .forAccount(ed.accountId)
      .assistAdminVoiceMapEditorSession.updateMany({
        where: { id: ed.sessionId, revokedAt: null },
        data: { revokedAt: this.now(), revokeReason: 'exit' },
      });
    return { ok: true };
  }

  /** Черновик для шаблона страницы админки. */
  async map(
    ed: ResolvedAdminEditor,
    pathRaw: unknown,
  ): Promise<AdminEditorMapView> {
    const path = editorLinkPath(pathRaw);
    const db = this.sitesDb.forAccount(ed.accountId);
    const row = await this.maps.loadMap(db, ed.accountId, ed.siteId);
    const content = parseVoiceMapContent(row.draft);
    const tpl = templateFor(content, path);
    return {
      revision: row.draftRevision,
      publishedVersion: row.publishedVersion,
      path,
      template: tpl,
      templates: content.templates.filter((t) => t.status !== 'removed'),
      targets: [
        ...targetsForPage(content, path),
        ...content.targets.filter(
          (t) =>
            t.status === 'removed' &&
            (t.scope === 'site' ||
              (t.scope === 'page' && t.pagePath === path) ||
              (t.scope === 'template' && t.templateId === tpl?.id)),
        ),
      ],
      keys: content.targets.map((t) => t.key),
      gates: await this.maps.gatesOf(db, ed.siteId, versionContent(content)),
      hosts: this.maps.hostNames(
        await this.maps.adminHosts(db, ed.siteId, this.now()),
      ),
      ...(({ denySelectors, allowSelectors }) => ({
        denySelectors,
        allowSelectors,
      }))(await this.rules(ed)),
    };
  }

  /** Правила голосового управления «Админки» кабинета (или по умолчанию). */
  private async rules(ed: ResolvedAdminEditor) {
    const st = await this.sitesDb
      .forAccount(ed.accountId)
      .assistAdminSettings.findFirst({
        where: { siteId: ed.siteId },
        select: { voiceControlAdminRules: true },
      });
    return (
      adminRulesOf(st?.voiceControlAdminRules ?? null) ?? defaultAdminRules()
    );
  }

  ops(ed: ResolvedAdminEditor, body: unknown): Promise<AdminVoiceMapPatchView> {
    return this.maps.patch(this.actor(ed), ed.siteId, body, 'editor');
  }

  /** Запрос публикации — сборка версии; публикует владелец в TMA. */
  async publishRequest(
    ed: ResolvedAdminEditor,
  ): Promise<AdminVoiceMapVersionView> {
    await this.spendPublishRequest(ed);
    return this.maps.buildVersion(this.actor(ed), ed.siteId, 'editor');
  }

  /**
   * «Сказать сейчас» по черновику карты «Админки»: прямой путь по карте или
   * прямой путь кода и проверки «Админки» (`checkAdminPlan`, правила
   * кабинета, «Сохранить» — не исполняемо) — ПОКАЗ без нажатий и без модели.
   */
  async tryCommand(
    ed: ResolvedAdminEditor,
    body: unknown,
  ): Promise<AdminEditorTryView> {
    const b = (body ?? {}) as { text?: unknown; snapshot?: unknown };
    const text = cleanText(b.text, 200);
    if (!text || snapshotTooLarge(b.snapshot))
      throw adminVoiceMapError(
        HttpStatus.BAD_REQUEST,
        'EDITOR_BAD_REQUEST',
        'Нужны текст команды и снимок страницы',
      );
    const snapshot = parseSnapshot(b.snapshot);
    if (!snapshot)
      throw adminVoiceMapError(
        HttpStatus.BAD_REQUEST,
        'EDITOR_BAD_REQUEST',
        'Снимок страницы не разобран',
      );
    const db = this.sitesDb.forAccount(ed.accountId);
    const hosts = this.maps.hostNames(
      await this.maps.adminHosts(db, ed.siteId, this.now()),
    );
    if (!onSiteHost(snapshot.url, hosts))
      throw adminVoiceMapError(
        HttpStatus.BAD_REQUEST,
        'EDITOR_BAD_REQUEST',
        'Снимок не с подтверждённого адреса админки',
      );
    const row = await this.maps.loadMap(db, ed.accountId, ed.siteId);
    const left = await this.spendTry(ed);
    const content = parseVoiceMapContent(row.draft);
    const rules = await this.rules(ed);
    let path = '/';
    try {
      path = new URL(snapshot.url).pathname;
    } catch {
      path = '/';
    }
    const resolved = resolveVoiceMap(content, snapshot, path);
    const work = {
      ...snapshot,
      elements: snapshot.elements.filter(
        (e) => !resolved.denyRefs.includes(e.ref),
      ),
    };
    const direct = directMapPlan(text, resolved);
    let via: AdminEditorTryView['via'] = 'none';
    let raw: ReturnType<typeof directPlan> = null;
    let key: string | null = null;
    let phrase: string | null = null;
    if (direct && 'raw' in direct) {
      raw = direct.raw;
      via = 'map';
      key = direct.key;
      phrase = direct.phrase;
    } else {
      raw = directPlan(text, work);
      via = raw ? 'direct' : 'model_needed';
      if (direct && 'miss' in direct) key = direct.miss;
    }
    const checked = raw
      ? checkAdminPlan({
          transcript: text,
          snapshot: work,
          map: [],
          steps: raw,
          rules,
          hosts,
          state: 'on',
          mapHints: mapHintsOf(resolved),
          noSubmit: true,
        })
      : null;
    return {
      heard: text,
      via,
      key,
      phrase,
      steps: checked?.steps ?? [],
      notes: checked?.notes ?? [],
      left,
    };
  }

  private publishLimit(scope: 'session' | 'site', retryAfterSec: number) {
    return adminVoiceMapError(
      HttpStatus.TOO_MANY_REQUESTS,
      'EDITOR_PUBLISH_LIMIT',
      scope === 'session'
        ? 'Запрос публикации уже отправлен — следующий не раньше чем через минуту'
        : `Запросов публикации сегодня больше ${VOICE_MAP_LIMITS.publishRequestsPerDay} — подтвердите версию в Telegram или продолжите завтра`,
      { scope, retryAfterSec: Math.max(1, Math.ceil(retryAfterSec)) },
    );
  }

  /** 1 в минуту на сессию, 10 в сутки (UTC) на сайт — как у «Сайта». */
  private async spendPublishRequest(ed: ResolvedAdminEditor): Promise<void> {
    const now = this.now();
    const db = this.sitesDb.forAccount(ed.accountId);
    const gap = VOICE_MAP_LIMITS.publishRequestIntervalMs;
    const s = await db.assistAdminVoiceMapEditorSession.updateMany({
      where: {
        id: ed.sessionId,
        revokedAt: null,
        OR: [
          { lastPublishRequestAt: null },
          { lastPublishRequestAt: { lte: new Date(now.getTime() - gap) } },
        ],
      },
      data: { lastPublishRequestAt: now },
    });
    if (s.count !== 1) {
      const row = await db.assistAdminVoiceMapEditorSession.findFirst({
        where: { id: ed.sessionId },
        select: { lastPublishRequestAt: true },
      });
      const last = row?.lastPublishRequestAt?.getTime() ?? now.getTime();
      throw this.publishLimit('session', (last + gap - now.getTime()) / 1000);
    }
    await this.maps.loadMap(db, ed.accountId, ed.siteId);
    const day = utcDay(now);
    await db.assistAdminVoiceMap.updateMany({
      where: {
        siteId: ed.siteId,
        OR: [{ publishReqDay: null }, { NOT: { publishReqDay: day } }],
      },
      data: { publishReqDay: day, publishReqCount: 0 },
    });
    const u = await db.assistAdminVoiceMap.updateMany({
      where: {
        siteId: ed.siteId,
        publishReqDay: day,
        publishReqCount: { lt: VOICE_MAP_LIMITS.publishRequestsPerDay },
      },
      data: { publishReqCount: { increment: 1 } },
    });
    if (u.count !== 1) {
      const midnight = Date.parse(`${day}T00:00:00.000Z`) + 86_400_000;
      throw this.publishLimit('site', (midnight - now.getTime()) / 1000);
    }
  }

  /** Потолок «Сказать сейчас» на сайт в сутки (UTC). */
  private async spendTry(ed: ResolvedAdminEditor): Promise<number> {
    const db = this.sitesDb.forAccount(ed.accountId);
    const day = utcDay(this.now());
    const cap = VOICE_MAP_LIMITS.tryPerDay;
    await db.assistAdminVoiceMap.updateMany({
      where: {
        siteId: ed.siteId,
        OR: [{ tryDay: null }, { NOT: { tryDay: day } }],
      },
      data: { tryDay: day, tryCount: 0 },
    });
    const u = await db.assistAdminVoiceMap.updateMany({
      where: { siteId: ed.siteId, tryDay: day, tryCount: { lt: cap } },
      data: { tryCount: { increment: 1 } },
    });
    if (u.count !== 1)
      throw adminVoiceMapError(
        HttpStatus.TOO_MANY_REQUESTS,
        'EDITOR_TRY_LIMIT',
        `Проверок «Сказать сейчас» сегодня больше ${cap} — продолжите завтра`,
      );
    const r = await db.assistAdminVoiceMap.findFirst({
      where: { siteId: ed.siteId },
      select: { tryCount: true },
    });
    return Math.max(0, cap - (r?.tryCount ?? cap));
  }
}
