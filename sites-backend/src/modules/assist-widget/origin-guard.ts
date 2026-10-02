/**
 * Гвард сайта виджета (ТЗ §4.13 п.1, §4.12, §3.3) — W2. ВСЕ запросы — под
 * ролью assist_public (AssistPublicDb).
 *
 * Допуск решают ТОЛЬКО session и chat (и всё, что идёт по visitor-token):
 *  (а) `Origin` запроса обязан быть origin виджета (widgetOrigin(), iframe
 *      и API — один origin через rewrite Vercel-проекта `widget`); иной или
 *      отсутствующий → ORIGIN_DENIED;
 *  (б) parentOrigin из тела — ТОЧНОЕ совпадение (схема+хост+порт) с хостом
 *      этого pk: роль public, статус по evaluateHostAccess(…, 'assist-widget')
 *      (льгота 72 ч — только здесь), хост включён в ОПУБЛИКОВАННОЙ
 *      конфигурации; поддомен подтверждённого apex — НЕ совпадение;
 *      pk_test_ — только http(s)://localhost|127.0.0.1 любого порта;
 *  (в) origin вшивается в visitor-token; каждый следующий запрос сверяет его
 *      заново (отзыв подтверждения + 72 ч → ORIGIN_DENIED в живой сессии).
 * Сессия предпросмотра (sessionHash в assist_site_preview_tokens) с
 * purpose=tma допускает parentOrigin из previewFrameAncestors().
 *
 * Э2: «роль public» у хоста — все хосты сайта (роли хостов `public|admin`
 * появятся с «Админкой», Э7); виджет «Сайта» включается на хосте только
 * через `hosts[]` опубликованного вида.
 */
import { Injectable } from '@nestjs/common';
import { previewFrameAncestors, widgetOrigin } from '../../config/widget-env';
import { AssistPublicDb } from '../../prisma/assist-public-db.service';
import type { WidgetSiteContext } from '../assist-site-chat/chat-types';
import {
  allowedOrigins,
  exactOrigin,
  findSiteByKey,
  findSiteById,
  hostRulesOf,
  isLocalOrigin,
  publishedWidgetConfig,
  sha256Hex,
  siteHostAccess,
  type KeyKind,
  type WidgetSiteRow,
} from './site-access';

export type OriginDecision =
  | { ok: true; site: WidgetSiteContext; graceUntil: Date | null }
  | {
      ok: false;
      code: 'ORIGIN_DENIED' | 'WIDGET_UNKNOWN_KEY' | 'WIDGET_DISABLED';
    };

/** Действующая сессия предпросмотра (после обмена одноразового токена). */
export interface PreviewSessionRow {
  siteId: string;
  purpose: string;
  origin: string | null;
  sessionExpiresAt: Date;
}

const DENIED = { ok: false, code: 'ORIGIN_DENIED' } as const;

@Injectable()
export class WidgetOriginGuard {
  constructor(private readonly db: AssistPublicDb) {}

  resolve(p: {
    pk: string;
    requestOrigin: string | undefined;
    parentOrigin: string;
    previewSession?: string | null;
    now?: Date;
  }): Promise<OriginDecision> {
    return this.resolveDetailed(p).then((r) => r.decision);
  }

  /**
   * То же, что resolve, плюс строка сайта и сессия предпросмотра — их
   * дальше использует выдача сессии (соль ipHash, срок токена).
   */
  async resolveDetailed(p: {
    pk: string;
    requestOrigin: string | undefined;
    parentOrigin: string;
    previewSession?: string | null;
    now?: Date;
  }): Promise<{
    decision: OriginDecision;
    row: WidgetSiteRow | null;
    preview: PreviewSessionRow | null;
  }> {
    const now = p.now ?? new Date();
    const none = { row: null, preview: null };
    if (p.requestOrigin !== widgetOrigin())
      return { decision: DENIED, ...none };
    const found = await findSiteByKey(this.db, p.pk);
    if (!found) {
      return {
        decision: { ok: false, code: 'WIDGET_UNKNOWN_KEY' },
        ...none,
      };
    }
    const parent = exactOrigin(p.parentOrigin);
    if (!parent) return { decision: DENIED, row: found.site, preview: null };

    const preview = p.previewSession
      ? await this.previewSession(found.site.siteId, p.previewSession, now)
      : null;
    const decision = await this.decide({
      site: found.site,
      keyKind: found.kind,
      parentOrigin: parent,
      preview: preview !== null,
      previewPurpose: preview?.purpose ?? null,
      previewOrigin: preview?.origin ?? null,
      now,
    });
    return { decision, row: found.site, preview: decision.ok ? preview : null };
  }

  /**
   * Повторная сверка на КАЖДОМ запросе по visitor-token (§4.13 п.1в): тот
   * же сайт, тот же parentOrigin — допущен ли он СЕЙЧАС. Тип ключа
   * восстанавливается из origin: localhost бывает только у pk_test_.
   */
  async recheck(p: {
    siteId: string;
    parentOrigin: string;
    preview: boolean;
    now: Date;
  }): Promise<{ decision: OriginDecision; row: WidgetSiteRow | null }> {
    const row = await findSiteById(this.db, p.siteId);
    if (!row) return { decision: DENIED, row: null };
    const keyKind: KeyKind = isLocalOrigin(p.parentOrigin) ? 'test' : 'live';
    if (keyKind === 'live' && !row.publicKey && !p.preview) {
      return { decision: { ok: false, code: 'WIDGET_UNKNOWN_KEY' }, row };
    }
    if (keyKind === 'test' && !row.testKey && !p.preview) {
      return { decision: { ok: false, code: 'WIDGET_UNKNOWN_KEY' }, row };
    }
    const decision = await this.decide({
      site: row,
      keyKind,
      parentOrigin: p.parentOrigin,
      preview: p.preview,
      // Сессия предпросмотра в токене не хранится (только флаг): допуск —
      // «любой допущенный хост сайта или предок конфигуратора».
      previewPurpose: p.preview ? 'any' : null,
      previewOrigin: null,
      now: p.now,
    });
    return { decision, row };
  }

  /**
   * Э3: запрос СО СТРАНИЦЫ заказчика (загрузчик — счётчики `event`, цели
   * `goal` без visitor-token): `Origin` страницы обязан быть ТОЧНЫМ
   * допущенным хостом pk — те же правила, что у parentOrigin в `session`
   * (verified/льгота, включён в опубликованном виде; pk_test_ — localhost).
   * Предпросмотра здесь нет: со страницы владелец не считает себе цели.
   */
  async resolvePage(p: {
    pk: string;
    pageOrigin: string | undefined;
    now?: Date;
  }): Promise<{ decision: OriginDecision; row: WidgetSiteRow | null }> {
    const now = p.now ?? new Date();
    const found = await findSiteByKey(this.db, p.pk);
    if (!found) {
      return { decision: { ok: false, code: 'WIDGET_UNKNOWN_KEY' }, row: null };
    }
    const origin = exactOrigin(p.pageOrigin);
    if (!origin) return { decision: DENIED, row: found.site };
    const decision = await this.decide({
      site: found.site,
      keyKind: found.kind,
      parentOrigin: origin,
      preview: false,
      previewPurpose: null,
      previewOrigin: null,
      now,
    });
    return { decision, row: found.site };
  }

  private async decide(p: {
    site: WidgetSiteRow;
    keyKind: KeyKind;
    parentOrigin: string;
    preview: boolean;
    previewPurpose: string | null;
    previewOrigin: string | null;
    now: Date;
  }): Promise<OriginDecision> {
    const { site } = p;
    const ok = (graceUntil: Date | null): OriginDecision => ({
      ok: true,
      graceUntil,
      site: {
        accountId: site.accountId,
        siteId: site.siteId,
        knowledgeVersion: site.knowledgeVersion,
        configVersion: site.configVersion,
        widgetVersion: site.widgetVersion,
        parentOrigin: p.parentOrigin,
        keyKind: p.keyKind,
        preview: p.preview,
      },
    });

    if (p.preview) {
      // Конфигуратор TMA: предки — TMA/веб-кабинет/web.telegram.org.
      if (
        (p.previewPurpose === 'tma' || p.previewPurpose === 'any') &&
        previewFrameAncestors().includes(p.parentOrigin)
      ) {
        return ok(null);
      }
      // «Посмотреть на сайте»: допущенный ядром хост этого сайта (вид ещё
      // может быть не опубликован, а хост — не включён).
      if (p.previewPurpose === 'site' && p.previewOrigin !== p.parentOrigin) {
        return DENIED;
      }
      if (p.keyKind === 'test' && isLocalOrigin(p.parentOrigin)) {
        return ok(null);
      }
      const hosts = await siteHostAccess(this.db, site.siteId, p.now);
      const hit = allowedOrigins(hosts, [], false).find(
        (h) => h.origin === p.parentOrigin,
      );
      return hit ? ok(hit.graceUntil) : DENIED;
    }

    // Не опубликован — виджета нет нигде (загрузчик и так не рисует кнопку).
    if (site.widgetVersion <= 0) {
      return { ok: false, code: 'WIDGET_DISABLED' };
    }
    if (p.keyKind === 'test') {
      return isLocalOrigin(p.parentOrigin) ? ok(null) : DENIED;
    }
    if (isLocalOrigin(p.parentOrigin)) return DENIED;
    const config = await publishedWidgetConfig(this.db, site);
    if (!config) return { ok: false, code: 'WIDGET_DISABLED' };
    const hosts = await siteHostAccess(this.db, site.siteId, p.now);
    const hit = allowedOrigins(hosts, hostRulesOf(config), true).find(
      (h) => h.origin === p.parentOrigin,
    );
    return hit ? ok(hit.graceUntil) : DENIED;
  }

  /** Сессия предпросмотра по сырому значению из sessionStorage iframe. */
  async previewSession(
    siteId: string,
    raw: string,
    now: Date,
  ): Promise<PreviewSessionRow | null> {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(raw)) {
      return null;
    }
    const row = await this.db.assistSitePreviewToken.findUnique({
      where: { sessionHash: sha256Hex(raw) },
      select: {
        siteId: true,
        purpose: true,
        origin: true,
        sessionExpiresAt: true,
      },
    });
    if (
      !row ||
      row.siteId !== siteId ||
      !row.sessionExpiresAt ||
      row.sessionExpiresAt.getTime() <= now.getTime()
    ) {
      return null;
    }
    return { ...row, sessionExpiresAt: row.sessionExpiresAt };
  }
}

/** Локальная разработка с pk_test_ — любой порт (CSP host-source `:*`). */
export const LOCAL_FRAME_ANCESTORS = [
  'http://localhost:*',
  'https://localhost:*',
  'http://127.0.0.1:*',
  'https://127.0.0.1:*',
] as const;

/**
 * frame-ancestors для `GET /w/v1/frame?pk=` (§4.12): verified (или в
 * льготе) public-хосты сайта, включённые в опубликованной конфигурации;
 * пусто → `'none'`. pk_test_ → localhost/127.0.0.1. Предпросмотр (pv=1) →
 * плюс previewFrameAncestors(). Чистая функция над уже прочитанными строками.
 */
export function frameAncestors(p: {
  keyKind: 'live' | 'test';
  allowedOrigins: string[];
  preview: boolean;
  previewAncestors: string[];
}): string {
  const out = new Set<string>();
  if (p.keyKind === 'test') {
    for (const s of LOCAL_FRAME_ANCESTORS) out.add(s);
  } else {
    for (const o of p.allowedOrigins) {
      // localhost у live-ключа не бывает (его нельзя подтвердить) — и не
      // пропускаем, даже если строка в базе такая есть.
      if (exactOrigin(o) && !isLocalOrigin(o)) out.add(o);
    }
  }
  if (p.preview) {
    for (const o of p.previewAncestors) if (exactOrigin(o)) out.add(o);
  }
  return out.size ? [...out].join(' ') : "'none'";
}
