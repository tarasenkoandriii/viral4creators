/**
 * Сессия редактора голосовой карты «Сайта» и действия панели (iframe `we.`)
 * — Э6-тер, ТЗ помощника §5-кватер.3, §5-кватер.6, §5-кватер.11.
 *
 *  - обмен ссылки: токен одноразовый (условный UPDATE `exchangedAt IS
 *    NULL`), 10 мин на открытие, origin родителя (из `ancestorOrigins` /
 *    `referrer` iframe) = origin хоста, на который выдана ссылка; хост
 *    по-прежнему verified «Сайта» без льготы; участник — по-прежнему
 *    владелец/менеджер. Любой отказ — один код 403 `EDITOR_LINK_INVALID`
 *    (не оракул);
 *  - сессия: 30 мин скользящих, ≤ 4 ч; смена роли, отзыв хоста, «завершить
 *    все» в TMA — 401 `EDITOR_SESSION_EXPIRED` на следующем запросе;
 *  - пикер на странице НЕ ходит в наш API и ничего не решает: всё, что он
 *    прислал, — недоверенные данные; черновик меняет только запрос панели
 *    `we.` (клик человека внутри iframe), публикация из сессии — 403.
 * Основная роль: сессия ищется системным чтением по хешу токена (кабинета
 * в запросе ещё нет), дальше — клиент тенанта.
 */
import { randomBytes } from 'crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { SitesDb } from '../../../prisma/sites-db.service';
import { directPlan } from '../../assist-ui-core/direct-plan';
import { checkPlan, onSiteHost } from '../../assist-ui-core/plan-checks';
import { defaultVoiceControlRules, rulesOf } from '../../assist-ui-core/rules';
import { parseSnapshot, snapshotTooLarge } from '../../assist-ui-core/snapshot';
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
import { cleanText } from '../../assist-ui-core/snapshot';
import {
  parseAccountRole,
  parseProductRoles,
  REQUIRE_ASSIST_MANAGER,
  satisfiesProductRoles,
} from '../../site-core/account/roles';
import type {
  EditorMapView,
  EditorSessionView,
  EditorTryView,
  VoiceMapPatchView,
  VoiceMapVersionView,
} from '../api-types';
import { voiceMapError } from '../voice-map-errors';
import { sha256Hex, VoiceMapService } from '../voice-map.service';

export interface ResolvedEditor {
  sessionId: string;
  accountId: string;
  siteId: string;
  memberId: string;
  hostId: string;
  host: string;
  origin: string;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
const PATH_RE = /^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/;

@Injectable()
export class EditorSessionService {
  private readonly logger = new Logger(EditorSessionService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly maps: VoiceMapService,
  ) {}

  private sys() {
    return this.sitesDb.system(
      'редактор голосовой карты: сессия по хешу токена — кабинета в запросе панели ещё нет',
    );
  }

  private invalidLink() {
    return voiceMapError(
      HttpStatus.FORBIDDEN,
      'EDITOR_LINK_INVALID',
      'Ссылка редактора недействительна или уже использована — возьмите новую в Telegram',
    );
  }

  private expired() {
    return voiceMapError(
      HttpStatus.UNAUTHORIZED,
      'EDITOR_SESSION_EXPIRED',
      'Сессия редактора завершена — откройте редактор заново из Telegram',
    );
  }

  /** Участник по-прежнему владелец/менеджер «Сайта» (В-49). */
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
        REQUIRE_ASSIST_MANAGER,
      )
    );
  }

  /** Хост ссылки по-прежнему verified «Сайта» (не admin, без льготы). */
  private async hostOk(accountId: string, siteId: string, hostId: string) {
    const hosts = await this.maps.siteHosts(
      this.sitesDb.forAccount(accountId),
      siteId,
      this.now(),
    );
    return hosts.some((h) => h.id === hostId);
  }

  async exchange(body: unknown): Promise<EditorSessionView> {
    const b = (body ?? {}) as { token?: unknown; parentOrigin?: unknown };
    if (typeof b.token !== 'string' || !TOKEN_RE.test(b.token))
      throw this.invalidLink();
    const now = this.now();
    const row = await this.sys().assistSiteVoiceMapEditorSession.findFirst({
      where: { linkTokenHash: sha256Hex(b.token) },
    });
    if (
      !row ||
      row.exchangedAt ||
      row.revokedAt ||
      row.linkExpiresAt.getTime() <= now.getTime() ||
      typeof b.parentOrigin !== 'string' ||
      b.parentOrigin !== row.parentOrigin
    )
      throw this.invalidLink();
    if (
      !(await this.memberOk(row.accountId, row.memberId)) ||
      !(await this.hostOk(row.accountId, row.siteId, row.hostId))
    )
      throw this.invalidLink();
    const session = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + VOICE_MAP_LIMITS.sessionIdleMs);
    const absolute = new Date(now.getTime() + VOICE_MAP_LIMITS.sessionAbsMs);
    const u = await this.sitesDb
      .forAccount(row.accountId)
      .assistSiteVoiceMapEditorSession.updateMany({
        where: { id: row.id, exchangedAt: null, revokedAt: null },
        data: {
          exchangedAt: now,
          sessionTokenHash: sha256Hex(session),
          expiresAt,
          absoluteExpiresAt: absolute,
          lastSeenAt: now,
        },
      });
    if (u.count !== 1) throw this.invalidLink();
    this.logger.log(`editor session site=${row.siteId} s=${row.id}`);
    return {
      session,
      expiresAt: expiresAt.toISOString(),
      absoluteExpiresAt: absolute.toISOString(),
      pagePath: row.pagePath,
      focusKey: row.focusKey,
      host: row.host,
    };
  }

  /** Гвард каждого запроса панели: сессия жива, право и хост — живые. */
  async resolve(header: unknown): Promise<ResolvedEditor> {
    if (typeof header !== 'string' || !TOKEN_RE.test(header))
      throw this.expired();
    const now = this.now();
    const row = await this.sys().assistSiteVoiceMapEditorSession.findFirst({
      where: { sessionTokenHash: sha256Hex(header) },
    });
    if (
      !row ||
      row.revokedAt ||
      !row.expiresAt ||
      !row.absoluteExpiresAt ||
      row.expiresAt.getTime() <= now.getTime() ||
      row.absoluteExpiresAt.getTime() <= now.getTime()
    )
      throw this.expired();
    const db = this.sitesDb.forAccount(row.accountId);
    if (
      !(await this.memberOk(row.accountId, row.memberId)) ||
      !(await this.hostOk(row.accountId, row.siteId, row.hostId))
    ) {
      await db.assistSiteVoiceMapEditorSession.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'access' },
      });
      throw this.expired();
    }
    const slide = Math.min(
      now.getTime() + VOICE_MAP_LIMITS.sessionIdleMs,
      row.absoluteExpiresAt.getTime(),
    );
    await db.assistSiteVoiceMapEditorSession.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { expiresAt: new Date(slide), lastSeenAt: now },
    });
    return {
      sessionId: row.id,
      accountId: row.accountId,
      siteId: row.siteId,
      memberId: row.memberId,
      hostId: row.hostId,
      host: row.host,
      origin: row.parentOrigin,
    };
  }

  /** Выход из редактора — сессия гаснет сразу. */
  async exit(ed: ResolvedEditor): Promise<{ ok: true }> {
    await this.sitesDb
      .forAccount(ed.accountId)
      .assistSiteVoiceMapEditorSession.updateMany({
        where: { id: ed.sessionId, revokedAt: null },
        data: { revokedAt: this.now(), revokeReason: 'exit' },
      });
    return { ok: true };
  }

  /** Черновик для шаблона страницы (§5-кватер.13 `GET /editor/v1/map`). */
  async map(ed: ResolvedEditor, pathRaw: unknown): Promise<EditorMapView> {
    const path =
      typeof pathRaw === 'string' &&
      pathRaw.length <= 300 &&
      PATH_RE.test(pathRaw)
        ? pathRaw
        : '/';
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
        // Удалённые цели этой страницы — «вернуть» до публикации.
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
        await this.maps.siteHosts(db, ed.siteId, this.now()),
      ),
    };
  }

  async ops(ed: ResolvedEditor, body: unknown): Promise<VoiceMapPatchView> {
    return this.maps.patch(
      { accountId: ed.accountId, memberId: ed.memberId },
      ed.siteId,
      body,
      'editor',
    );
  }

  /**
   * Запрос публикации — сборка версии; публикует человек в TMA (В-50).
   * Потолки (аудит Э6-тер (2)): украденная сессия не засыплет бот и журнал
   * версий — 1 в минуту на сессию, 10 в сутки на сайт; сверх — 429
   * `EDITOR_PUBLISH_LIMIT` (`scope`, `retryAfterSec`), версия не собирается.
   */
  async publishRequest(ed: ResolvedEditor): Promise<VoiceMapVersionView> {
    await this.spendPublishRequest(ed);
    return this.maps.buildVersion(
      { accountId: ed.accountId, memberId: ed.memberId },
      ed.siteId,
      'editor',
    );
  }

  /**
   * «Сказать сейчас» (§5-кватер.6): текст команды + снимок страницы, план
   * по ЧЕРНОВИКУ карты (прямой путь по карте или прямой путь кода) и все
   * проверки `checkPlan` — ПОКАЗ без нажатий (0 событий на странице, шаги
   * подсвечивает пикер). Модель плана здесь не зовётся (Р-79): команда без
   * прямого пути — «помощник спросит модель», проверка моделью — мастер Т-2.
   */
  async tryCommand(ed: ResolvedEditor, body: unknown): Promise<EditorTryView> {
    const b = (body ?? {}) as { text?: unknown; snapshot?: unknown };
    const text = cleanText(b.text, 200);
    if (!text || snapshotTooLarge(b.snapshot))
      throw voiceMapError(
        HttpStatus.BAD_REQUEST,
        'EDITOR_BAD_REQUEST',
        'Нужны текст команды и снимок страницы',
      );
    const snapshot = parseSnapshot(b.snapshot);
    if (!snapshot)
      throw voiceMapError(
        HttpStatus.BAD_REQUEST,
        'EDITOR_BAD_REQUEST',
        'Снимок страницы не разобран',
      );
    const db = this.sitesDb.forAccount(ed.accountId);
    const hosts = this.maps.hostNames(
      await this.maps.siteHosts(db, ed.siteId, this.now()),
    );
    if (!onSiteHost(snapshot.url, hosts))
      throw voiceMapError(
        HttpStatus.BAD_REQUEST,
        'EDITOR_BAD_REQUEST',
        'Снимок не с подтверждённого адреса сайта',
      );
    const row = await this.maps.loadMap(db, ed.accountId, ed.siteId);
    const left = await this.spendTry(db, ed.siteId);
    const content = parseVoiceMapContent(row.draft);
    const site = await db.assistSite.findFirst({
      where: { siteId: ed.siteId },
      select: { voiceControlSiteRules: true },
    });
    const rules =
      rulesOf(site?.voiceControlSiteRules ?? null) ??
      defaultVoiceControlRules();
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
    let via: EditorTryView['via'] = 'none';
    let raw = null as ReturnType<typeof directPlan>;
    let key: string | null = null;
    let phrase: string | null = null;
    if (direct && 'raw' in direct) {
      raw = direct.raw;
      via = 'map';
      key = direct.key;
      phrase = direct.phrase;
    } else {
      raw = directPlan(text, work);
      if (raw) via = 'direct';
      else via = 'model_needed';
      if (direct && 'miss' in direct) key = direct.miss;
    }
    const checked = raw
      ? checkPlan({
          transcript: text,
          snapshot: work,
          map: [],
          steps: raw,
          rules,
          hosts,
          state: 'on',
          mapHints: mapHintsOf(resolved),
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
    return voiceMapError(
      HttpStatus.TOO_MANY_REQUESTS,
      'EDITOR_PUBLISH_LIMIT',
      scope === 'session'
        ? 'Запрос публикации уже отправлен — следующий не раньше чем через минуту'
        : `Запросов публикации сегодня больше ${VOICE_MAP_LIMITS.publishRequestsPerDay} — подтвердите версию в Telegram или продолжите завтра`,
      { scope, retryAfterSec: Math.max(1, Math.ceil(retryAfterSec)) },
    );
  }

  /**
   * Потолки запроса публикации: сессия — условным UPDATE отметки (две
   * вкладки одной сессии не проскочат), сайт — счётчик дня UTC в строке
   * карты (тот же приём, что у «Сказать сейчас»).
   */
  private async spendPublishRequest(ed: ResolvedEditor): Promise<void> {
    const now = this.now();
    const db = this.sitesDb.forAccount(ed.accountId);
    const gap = VOICE_MAP_LIMITS.publishRequestIntervalMs;
    const s = await db.assistSiteVoiceMapEditorSession.updateMany({
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
      const row = await db.assistSiteVoiceMapEditorSession.findFirst({
        where: { id: ed.sessionId },
        select: { lastPublishRequestAt: true },
      });
      const last = row?.lastPublishRequestAt?.getTime() ?? now.getTime();
      throw this.publishLimit('session', (last + gap - now.getTime()) / 1000);
    }
    await this.maps.loadMap(db, ed.accountId, ed.siteId);
    const day = now.toISOString().slice(0, 10);
    const cap = VOICE_MAP_LIMITS.publishRequestsPerDay;
    await db.assistSiteVoiceMap.updateMany({
      where: {
        siteId: ed.siteId,
        OR: [{ publishReqDay: null }, { NOT: { publishReqDay: day } }],
      },
      data: { publishReqDay: day, publishReqCount: 0 },
    });
    const u = await db.assistSiteVoiceMap.updateMany({
      where: {
        siteId: ed.siteId,
        publishReqDay: day,
        publishReqCount: { lt: cap },
      },
      data: { publishReqCount: { increment: 1 } },
    });
    if (u.count !== 1) {
      const midnight = Date.parse(`${day}T00:00:00.000Z`) + 86_400_000;
      throw this.publishLimit('site', (midnight - now.getTime()) / 1000);
    }
  }

  /**
   * Потолок «Сказать сейчас» на сайт в сутки (§5-кватер.6, §5-кватер.11 п.9);
   * «Прогнать» мемо в редакторе (Э6-тер (д)) — из того же потолка.
   */
  async spendTry(
    db: ReturnType<SitesDb['forAccount']>,
    siteId: string,
  ): Promise<number> {
    const day = this.now().toISOString().slice(0, 10);
    const cap = VOICE_MAP_LIMITS.tryPerDay;
    await db.assistSiteVoiceMap.updateMany({
      where: { siteId, NOT: { tryDay: day } },
      data: { tryDay: day, tryCount: 0 },
    });
    await db.assistSiteVoiceMap.updateMany({
      where: { siteId, tryDay: null },
      data: { tryDay: day, tryCount: 0 },
    });
    const u = await db.assistSiteVoiceMap.updateMany({
      where: { siteId, tryDay: day, tryCount: { lt: cap } },
      data: { tryCount: { increment: 1 } },
    });
    if (u.count !== 1)
      throw voiceMapError(
        HttpStatus.TOO_MANY_REQUESTS,
        'EDITOR_TRY_LIMIT',
        `Проверок «Сказать сейчас» сегодня больше ${cap} — продолжите завтра`,
      );
    const r = await db.assistSiteVoiceMap.findFirst({
      where: { siteId },
      select: { tryCount: true },
    });
    return Math.max(0, cap - (r?.tryCount ?? cap));
  }
}
