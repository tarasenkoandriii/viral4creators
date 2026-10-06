/**
 * Кабинет: мемо из шагов одобренной обучалки (Э6-тер (к), ТЗ помощника
 * §5-бис.17 п.6 «Шаги обучалки»; TMA «Голос → Мемо» → «Из обучалки»).
 *
 *  - список — одобренные ролики ЭТОГО сайта (`assist_site_videos`: их
 *    присылает генератор полным набором, хозяин каждого проверен членством
 *    при синхронизации, Э6), по черновику обучалки — с мемо, уже сделанным
 *    из него (ссылка — операция `create` истории мемо, `op.draftId`);
 *  - «создать черновик» — шаги у генератора (`GeneratorMemoStepsClient`,
 *    только чтение: режим A, этот сайт, одобрено; вход, значения полей и
 *    секреты отброшены ещё там) → хост обучалки обязан быть
 *    ПОДТВЕРЖДЁННЫМ хостом «Сайта» этого сайта (иначе отказ, не «как-нибудь»)
 *    → цели шагов — элементы карты Ш4 этого хоста → `memoFromTutorial` →
 *    `MemoService.createFromTutorial` (строгий разбор, лимит тарифа в
 *    транзакции, история `source = tutorial`). Ворота кода — в карточке;
 *    публикация — как у любого мемо (сборка → ворота → сухой прогон →
 *    подтверждение человеком).
 * Права — как у мемо (владелец или менеджер Помічника); чужой сайт — 404
 * от `loadAssistSite`, чужая/неодобренная обучалка — один код 404.
 */
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { SitesDb } from '../../../prisma/sites-db.service';
import { loadAssistSite } from '../../assist-site-setup/widget-settings.service';
import type { MemoLang, MemoStatus } from '../../assist-ui-core/memo';
import type { AccountMembership } from '../../site-core/account/roles';
import { PUBLIC_SITE_HOST } from '../../site-core/ownership/host-roles';
import { uiMapHost } from '../../site-core/ui-map/ui-map';
import type { MemoDetailView } from '../api-types';
import {
  GeneratorMemoStepsClient,
  GeneratorNotConfiguredError,
  GeneratorRefusedError,
  GeneratorUnavailableError,
} from './generator-memo-steps.client';
import { memoFromTutorial } from './memo-from-tutorial';
import { MemoService } from './memo.service';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ELEMENTS_MAX = 5_000;

export type MemoTutorialErrorCode =
  | 'MEMO_TUTORIAL_NOT_FOUND'
  | 'MEMO_TUTORIAL_EXISTS'
  | 'MEMO_TUTORIAL_NOT_ELIGIBLE'
  | 'MEMO_TUTORIAL_UNAVAILABLE';

function tutorialError(
  status: HttpStatus,
  code: MemoTutorialErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  return new HttpException({ error: code, code, message, ...extra }, status);
}

const notFound = () =>
  tutorialError(
    HttpStatus.NOT_FOUND,
    'MEMO_TUTORIAL_NOT_FOUND',
    'Одобренная обучалка этого сайта не найдена',
  );

export interface MemoTutorialItem {
  draftId: string;
  title: string;
  locale: string;
  requiresLogin: boolean;
  syncedAt: string;
  /** Мемо, уже сделанное из этой обучалки (не удалённое). */
  memo: { number: number; status: MemoStatus } | null;
}

export interface MemoTutorialList {
  items: MemoTutorialItem[];
  /** Канал к генератору настроен (иначе «создать» ответит 503). */
  configured: boolean;
}

export interface MemoFromTutorialView {
  memo: MemoDetailView;
  report: {
    steps: number;
    /** Номера шагов (с 1) без цели в карте Ш4 — выбрать в TMA/редакторе. */
    unresolved: number[];
    slotsOverflow: number;
    dropped: { login: number; foreign: number; other: number };
    requiresLogin: boolean;
  };
}

@Injectable()
export class MemoFromTutorialService {
  private readonly logger = new Logger(MemoFromTutorialService.name);

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly memos: MemoService,
    private readonly generator: GeneratorMemoStepsClient,
  ) {}

  private db(m: AccountMembership) {
    return this.sitesDb.forAccount(m.accountId);
  }

  /** draftId → мемо из него (не удалённые), по истории `source = tutorial`. */
  private async memosByDraft(
    m: AccountMembership,
    siteId: string,
  ): Promise<Map<string, { number: number; status: MemoStatus }>> {
    const db = this.db(m);
    const changes = await db.assistSiteMemoChange.findMany({
      where: { siteId, source: 'tutorial' },
      select: { memoId: true, op: true },
      orderBy: { createdAt: 'desc' },
      take: 2_000,
    });
    const byMemo = new Map<string, string>();
    for (const c of changes) {
      const op = c.op as { op?: unknown; draftId?: unknown } | null;
      if (op?.op === 'create' && typeof op.draftId === 'string')
        byMemo.set(c.memoId, op.draftId);
    }
    const out = new Map<string, { number: number; status: MemoStatus }>();
    if (!byMemo.size) return out;
    const rows = await db.assistSiteMemo.findMany({
      where: {
        siteId,
        id: { in: [...byMemo.keys()] },
        status: { not: 'removed' },
      },
      select: { id: true, number: true, status: true },
      orderBy: { number: 'asc' },
    });
    for (const r of rows) {
      const d = byMemo.get(r.id);
      if (d && !out.has(d))
        out.set(d, { number: r.number, status: r.status as MemoStatus });
    }
    return out;
  }

  async list(m: AccountMembership, siteId: string): Promise<MemoTutorialList> {
    await loadAssistSite(this.db(m), m.accountId, siteId);
    const videos = await this.db(m).assistSiteVideo.findMany({
      where: { siteId },
      select: {
        draftId: true,
        title: true,
        locale: true,
        requiresLogin: true,
        syncedAt: true,
      },
      orderBy: { syncedAt: 'desc' },
      take: 200,
    });
    const memos = await this.memosByDraft(m, siteId);
    const seen = new Set<string>();
    const items: MemoTutorialItem[] = [];
    for (const v of videos) {
      if (seen.has(v.draftId)) continue;
      seen.add(v.draftId);
      items.push({
        draftId: v.draftId,
        title: v.title,
        locale: v.locale,
        requiresLogin: v.requiresLogin,
        syncedAt: v.syncedAt.toISOString(),
        memo: memos.get(v.draftId) ?? null,
      });
    }
    return { items, configured: this.generator.configured() };
  }

  async create(
    m: AccountMembership,
    siteId: string,
    draftId: string,
  ): Promise<MemoFromTutorialView> {
    await loadAssistSite(this.db(m), m.accountId, siteId);
    if (!ID.test(draftId)) throw notFound();
    const db = this.db(m);
    // Обучалка — среди одобренных роликов ЭТОГО сайта (иначе генератор и не
    // спрашиваем: чужой черновик не оракул).
    const video = await db.assistSiteVideo.findFirst({
      where: { siteId, draftId },
      select: { locale: true },
      orderBy: { syncedAt: 'desc' },
    });
    if (!video) throw notFound();
    const existing = (await this.memosByDraft(m, siteId)).get(draftId);
    if (existing)
      throw tutorialError(
        HttpStatus.CONFLICT,
        'MEMO_TUTORIAL_EXISTS',
        `Мемо из этой обучалки уже есть: М-${existing.number}`,
        { number: existing.number },
      );
    let src;
    try {
      src = await this.generator.memoSteps(siteId, draftId);
    } catch (e) {
      if (e instanceof GeneratorRefusedError) {
        if (e.status === 404) throw notFound();
        throw tutorialError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'MEMO_TUTORIAL_NOT_ELIGIBLE',
          'Эта обучалка не годится для мемо',
          { reason: e.reason },
        );
      }
      if (
        e instanceof GeneratorNotConfiguredError ||
        e instanceof GeneratorUnavailableError
      )
        throw tutorialError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'MEMO_TUTORIAL_UNAVAILABLE',
          'Генератор обучалок сейчас недоступен — попробуйте позже',
        );
      throw e;
    }
    // Хост обучалки — подтверждённый хост «Сайта» ЭТОГО сайта (не «Админки»).
    const host = uiMapHost(src.host);
    const hosts = await db.siteHost.findMany({
      where: {
        siteId,
        status: 'verified',
        revokedAt: null,
        ...PUBLIC_SITE_HOST,
      },
      select: { host: true },
    });
    if (!hosts.some((h) => uiMapHost(h.host) === host))
      throw tutorialError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'MEMO_TUTORIAL_NOT_ELIGIBLE',
        'Обучалка снята не на подтверждённом адресе этого сайта',
        { reason: 'host' },
      );
    const elements = await db.siteUiElement.findMany({
      where: { siteId, host },
      select: {
        id: true,
        path: true,
        viewport: true,
        elementKey: true,
        tag: true,
        label: true,
        role: true,
        selector: true,
        candidates: true,
        stability: true,
      },
      orderBy: [{ sourceRank: 'asc' }, { position: 'asc' }],
      take: ELEMENTS_MAX,
    });
    const lang: MemoLang =
      video.locale === 'ru' || video.locale === 'en' ? video.locale : 'uk';
    const conv = memoFromTutorial(src, elements, lang);
    const memo = await this.memos.createFromTutorial(m, siteId, conv.content, {
      draftId,
      requiresLogin: src.requiresLogin,
      dropped: src.dropped,
      unresolved: conv.unresolved.length,
    });
    this.logger.log(
      `memo from tutorial site=${siteId} memo=${memo.number} steps=${conv.content.steps.length} unresolved=${conv.unresolved.length} login=${src.requiresLogin}`,
    );
    return {
      memo,
      report: {
        steps: conv.content.steps.length,
        unresolved: conv.unresolved.map((i) => i + 1),
        slotsOverflow: conv.slotsOverflow,
        dropped: src.dropped,
        requiresLogin: src.requiresLogin,
      },
    };
  }
}
