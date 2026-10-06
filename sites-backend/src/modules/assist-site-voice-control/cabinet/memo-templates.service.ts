/**
 * Кабинет: мемо «Сайта» из шаблона платформы и публикация пакетом (Э6-тер
 * (к), ТЗ §5-бис.17 п.6 «Шаблоны платформ», п.14 «Применить шаблон
 * платформы»; В-54 — одна платформа, WooCommerce):
 *
 *  - шаблоны — `PLATFORM_TEMPLATES[platform].memos` (assist-ui-core);
 *    подписи целей, путь корзины и маска страницы товара — с ЭТОГО сайта:
 *    цель голосовой карты (подпись выбрал владелец в редакторе) важнее
 *    карты интерфейса Ш4 (обход); цель нажатия без подписи — `unresolved`
 *    (ворота задержат публикацию — нажатие только по отпечатку с текстом);
 *  - создание — ТОЛЬКО черновики (`origin: template`, лимит тарифа в
 *    транзакции — `memo-drafts.ts`) и сразу сборка версии (ворота кода →
 *    «на проверке» или `held`); прогон на сайте — ссылкой мастера в
 *    карточке мемо, как у любого мемо;
 *  - публикация — пакетом по подтверждению человека в TMA: каждое мемо —
 *    тем же `MemoService.publish` (ворота заново, отчёт прогона `pass`/
 *    `partial` ТОЙ ЖЕ версии, индекс фраз в транзакции); не прошедшее — в
 *    отчёт с кодом, остальные публикуются.
 * Сайт ищется в кабинете из пути (чужой — 404, как у мемо).
 */
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { SitesDb } from '../../../prisma/sites-db.service';
import { loadAssistSite } from '../../assist-site-setup/widget-settings.service';
import { parseMemoContent } from '../../assist-ui-core/memo';
import {
  platformMemoBinds,
  platformMemoDrafts,
  type PlatformFact,
} from '../../assist-ui-core/memo-io';
import { normText } from '../../assist-ui-core/normalize';
import {
  parseVoiceMapContent,
  PLATFORM_TEMPLATES,
} from '../../assist-ui-core/voice-map';
import type { AccountMembership } from '../../site-core/account/roles';
import { insertMemoDrafts } from './memo-drafts';
import { MemoService } from './memo.service';
import { voiceControlError } from './voice-control-errors';

type Db = ReturnType<SitesDb['forAccount']>;

/** Подписи кнопки отправки поиска (Ш4 — роль `button`), uk/ru/en. */
const SEARCH_SUBMIT = new Set(
  ['пошук', 'шукати', 'знайти', 'поиск', 'искать', 'найти', 'search', 'go'].map(
    normText,
  ),
);

export interface MemoTemplateView {
  platform: string;
  key: string;
  names: Partial<Record<'uk' | 'ru' | 'en', string>>;
  goal: Partial<Record<'uk' | 'ru' | 'en', string>>;
  /** Мемо с этим ключом шаблона в сайте уже есть (создать ещё раз — `-2`). */
  exists: boolean;
}

/** GET /assist/sites/:id/memo-templates */
export interface MemoTemplatesView {
  /** Платформа сайта по голосовой карте (применён шаблон карты) или null. */
  platform: string | null;
  templates: MemoTemplateView[];
}

/** POST /assist/sites/:id/memo-templates */
export interface MemoTemplatesApplyView {
  created: Array<{
    number: number;
    key: string;
    /** Ворота собранной версии: ok или коды проблем. */
    gates: 'ok' | string[];
  }>;
  rejected: Array<{ key: string | null; code: string }>;
  /** Цели шагов без подписи на этом сайте (по мемо). */
  unresolved: Array<{ key: string; binds: string[] }>;
}

/** POST /assist/sites/:id/memo-batch/publish */
export interface MemoBatchPublishView {
  results: Array<{
    number: number;
    version: number | null;
    ok: boolean;
    code: string | null;
  }>;
}

const MAX_BATCH = 50;
const ASSIST_SEL = /\[data-assist-id="((?:[^"\\]|\\.)*)"\]$/;

@Injectable()
export class MemoTemplatesService {
  private readonly logger = new Logger(MemoTemplatesService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly memos: MemoService,
  ) {}

  private db(m: AccountMembership): Db {
    return this.sitesDb.forAccount(m.accountId);
  }

  /** Платформа сайта — по применённому шаблону голосовой карты. */
  private async platformOf(db: Db, siteId: string): Promise<string | null> {
    const row = await db.assistSiteVoiceMap.findFirst({
      where: { siteId },
      select: { platformTemplate: true },
    });
    const p = (row?.platformTemplate ?? '').split('@')[0];
    return p && PLATFORM_TEMPLATES[p]?.memos ? p : null;
  }

  async list(m: AccountMembership, siteId: string): Promise<MemoTemplatesView> {
    const db = this.db(m);
    await loadAssistSite(db, m.accountId, siteId);
    const keys = new Set(
      (
        await db.assistSiteMemo.findMany({
          where: { siteId, status: { not: 'removed' } },
          select: { key: true },
        })
      ).map((r) => r.key),
    );
    const templates: MemoTemplateView[] = [];
    for (const [platform, t] of Object.entries(PLATFORM_TEMPLATES))
      for (const memo of t.memos ?? []) {
        const c = parseMemoContent(memo.content).content;
        templates.push({
          platform,
          key: memo.key,
          names: c.names,
          goal: c.goal.text,
          exists: keys.has(memo.key),
        });
      }
    return { platform: await this.platformOf(db, siteId), templates };
  }

  /**
   * Факты сайта для целей шаблона: подпись (карта → Ш4), путь ссылки,
   * страница, где элемент видели. Кнопка поиска — по подписи в Ш4.
   */
  private async facts(
    db: Db,
    siteId: string,
    binds: readonly string[],
  ): Promise<Record<string, PlatformFact>> {
    const out: Record<string, PlatformFact> = {};
    const map = await db.assistSiteVoiceMap.findFirst({
      where: { siteId },
      select: { draft: true },
    });
    if (map)
      for (const t of parseVoiceMapContent(map.draft).targets) {
        const id = t.descriptor.assistId;
        if (t.status !== 'active' || !id || !binds.includes(id) || out[id])
          continue;
        if (!t.descriptor.text) continue;
        out[id] = {
          text: t.descriptor.text,
          href: t.descriptor.hrefPath,
          page: t.pagePath,
        };
      }
    const els = await db.siteUiElement.findMany({
      where: {
        siteId,
        OR: [{ selector: { contains: 'data-assist-id=' } }, { role: 'button' }],
      },
      orderBy: [{ confidence: 'desc' }, { lastSeenAt: 'desc' }],
      select: { selector: true, label: true, role: true, path: true },
      take: 500,
    });
    for (const e of els) {
      const id = e.selector ? ASSIST_SEL.exec(e.selector)?.[1] : undefined;
      if (id && binds.includes(id)) {
        const f = out[id] ?? {};
        out[id] = {
          text: f.text || e.label || null,
          href: f.href ?? null,
          page: f.page || e.path || null,
        };
      } else if (
        !id &&
        e.role === 'button' &&
        binds.includes('search-submit') &&
        !out['search-submit']?.text &&
        SEARCH_SUBMIT.has(normText(e.label))
      )
        out['search-submit'] = { text: e.label, page: e.path };
    }
    return out;
  }

  async apply(
    m: AccountMembership,
    siteId: string,
    body: { platform?: unknown; keys?: unknown } | null | undefined,
  ): Promise<MemoTemplatesApplyView> {
    const db = this.db(m);
    await loadAssistSite(db, m.accountId, siteId);
    const platform = typeof body?.platform === 'string' ? body.platform : '';
    const keys = Array.isArray(body?.keys)
      ? body.keys.filter((k): k is string => typeof k === 'string').slice(0, 20)
      : undefined;
    if (!PLATFORM_TEMPLATES[platform]?.memos)
      throw voiceControlError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'MEMO_INVALID',
        'Шаблон платформы не найден',
        { errors: [{ path: 'platform', code: 'enum' }] },
      );
    const facts = await this.facts(db, siteId, platformMemoBinds(platform));
    const drafts = platformMemoDrafts(platform, facts, keys) ?? [];
    const items = drafts.map((d, index) => {
      const parsed = parseMemoContent(d.raw);
      return { index, key: d.key, listed: true, content: parsed.content };
    });
    const res = await insertMemoDrafts(db, {
      accountId: m.accountId,
      memberId: m.memberId,
      siteId,
      origin: 'template',
      items,
      now: this.now(),
    });
    // Сразу — версия на проверку (ворота кода): прогон и публикация — человеком.
    const created: MemoTemplatesApplyView['created'] = [];
    for (const c of res.created) {
      const d = await this.memos.buildVersion(m, siteId, String(c.number));
      const v = d.versions[0];
      created.push({
        number: c.number,
        key: c.key,
        gates: v?.gateReport?.ok
          ? 'ok'
          : (v?.gateReport?.problems ?? []).map((p) => p.code),
      });
    }
    this.logger.log(
      `memo template site=${siteId} platform=${platform} created=${created.length} rejected=${res.rejected.length}`,
    );
    return {
      created,
      rejected: res.rejected.map((r) => ({
        key: drafts[r.index]?.key ?? r.key,
        code: r.code,
      })),
      unresolved: drafts
        .filter((d) => d.unresolved.length)
        .map((d) => ({ key: d.key, binds: d.unresolved })),
    };
  }

  /**
   * Публикация пакетом (подтверждение человека): по номерам или все мемо
   * из шаблона с версией «на проверке». Каждое — `MemoService.publish`.
   */
  async publishBatch(
    m: AccountMembership,
    siteId: string,
    body: { numbers?: unknown } | null | undefined,
  ): Promise<MemoBatchPublishView> {
    const db = this.db(m);
    await loadAssistSite(db, m.accountId, siteId);
    const asked = Array.isArray(body?.numbers)
      ? body.numbers.filter(
          (n): n is number =>
            typeof n === 'number' && Number.isInteger(n) && n >= 1,
        )
      : null;
    if (asked && asked.length > MAX_BATCH)
      throw voiceControlError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'MEMO_INVALID',
        `Не больше ${MAX_BATCH} мемо за раз`,
        { errors: [{ path: 'numbers', code: 'too_many' }] },
      );
    const rows = await db.assistSiteMemo.findMany({
      where: {
        siteId,
        status: { notIn: ['removed', 'disabled'] },
        ...(asked ? { number: { in: asked } } : { origin: 'template' }),
      },
      orderBy: { number: 'asc' },
      select: { id: true, number: true },
      take: MAX_BATCH,
    });
    const results: MemoBatchPublishView['results'] = [];
    for (const r of rows) {
      const ver = await db.assistSiteMemoVersion.findFirst({
        where: { memoId: r.id, status: 'checking' },
        orderBy: { number: 'desc' },
        select: { number: true },
      });
      if (!ver) {
        if (asked)
          results.push({
            number: r.number,
            version: null,
            ok: false,
            code: 'MEMO_GATES',
          });
        continue;
      }
      try {
        await this.memos.publish(
          m,
          siteId,
          String(r.number),
          String(ver.number),
        );
        results.push({
          number: r.number,
          version: ver.number,
          ok: true,
          code: null,
        });
      } catch (e) {
        if (!(e instanceof HttpException)) throw e;
        const code = (e.getResponse() as { code?: unknown }).code;
        results.push({
          number: r.number,
          version: ver.number,
          ok: false,
          code: typeof code === 'string' ? code : 'MEMO_CONFLICT',
        });
      }
    }
    // Номера, которых нет в сайте, — как несуществующее мемо.
    if (asked)
      for (const n of asked)
        if (!rows.some((r) => r.number === n))
          results.push({
            number: n,
            version: null,
            ok: false,
            code: 'MEMO_NOT_FOUND',
          });
    this.logger.log(
      `memo batch publish site=${siteId} ok=${results.filter((x) => x.ok).length} of=${results.length} member=${m.memberId}`,
    );
    return { results };
  }
}
