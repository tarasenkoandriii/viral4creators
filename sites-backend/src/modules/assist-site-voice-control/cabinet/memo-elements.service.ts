/**
 * Правка мемо с телефона в TMA — сервис (чистая часть — `memo-elements.ts`):
 *   GET  …/memos/:n/elements?step=<с 0>|page=<путь или маска>
 *        элементы карты Ш4 страницы шага с готовым отпечатком `pin`;
 *   POST …/memos/:n/steps/element { expectedRevision, uiElementId,
 *        mode: add|replace, index?, page? } → карточка мемо.
 *
 * Права — как у мемо (владелец/менеджер Помічника; контроллер) и ЭТОТ сайт
 * (`MemoService.get` — чужой сайт и чужое мемо — один 404). Элементы —
 * только хостов «Сайта» этого сайта, подтверждённых и не отозванных
 * (`PUBLIC_SITE_HOST`; хост «Админки» и чужой хост не отдаются и не
 * принимаются). Без ПД: подписи — маска (`maskLabel`), селекторы и
 * кандидаты наружу не уходят.
 *
 * Сохранение — СУЩЕСТВУЮЩИМИ операциями черновика (`set steps` [+ `set
 * slots`] через `MemoService.patchDraft`: ревизия 409, разбор, «риск только
 * вверх», константа в ПД, история). Шаг, который ворота кода
 * (`memoGates`) признают «никогда» (оплата, удаление, поле карты/пароля,
 * запрет кабинета), не сохраняется — 422 `MEMO_INVALID` (`never_step`).
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { SitesDb } from '../../../prisma/sites-db.service';
import {
  memoGates,
  parseMemoContent,
  type MemoContent,
  type MemoSlot,
  type MemoStep,
} from '../../assist-ui-core/memo';
import { defaultVoiceControlRules, rulesOf } from '../../assist-ui-core/rules';
import type { AccountMembership } from '../../site-core/account/roles';
import { PUBLIC_SITE_HOST } from '../../site-core/ownership/host-roles';
import type { MemoDetailView, MemoDraftOp } from '../api-types';
import {
  MEMO_ELEMENTS_LIMITS,
  MEMO_MAX_SLOTS,
  memoElementViews,
  memoPageParam,
  memoStepFromElement,
  memoStepRetarget,
  type MemoUiElementRow,
  type MemoUiElementView,
} from './memo-elements';
import { MemoService } from './memo.service';
import { voiceControlError } from './voice-control-errors';

export interface MemoElementsView {
  page: string;
  view: 'any' | 'desktop' | 'mobile';
  items: MemoUiElementView[];
}

export interface MemoElementApplyBody {
  expectedRevision?: unknown;
  uiElementId?: unknown;
  mode?: unknown;
  index?: unknown;
  page?: unknown;
}

const ELEMENT_SELECT = {
  id: true,
  hostId: true,
  path: true,
  viewport: true,
  elementKey: true,
  tag: true,
  label: true,
  role: true,
  selector: true,
  candidates: true,
  stability: true,
  staleDesktopAt: true,
  staleMobileAt: true,
} as const;

const invalid = (path: string, code: string, message = 'Шаг не подходит') =>
  voiceControlError(HttpStatus.UNPROCESSABLE_ENTITY, 'MEMO_INVALID', message, {
    errors: [{ path, code }],
  });

@Injectable()
export class MemoElementsService {
  constructor(
    private readonly sitesDb: SitesDb,
    private readonly memos: MemoService,
  ) {}

  private db(m: AccountMembership) {
    return this.sitesDb.forAccount(m.accountId);
  }

  /** Подтверждённые, не отозванные хосты «Сайта» (не «Админки») сайта. */
  private async publicHostIds(
    m: AccountMembership,
    siteId: string,
  ): Promise<string[]> {
    const hosts = await this.db(m).siteHost.findMany({
      where: {
        siteId,
        status: 'verified',
        revokedAt: null,
        ...PUBLIC_SITE_HOST,
      },
      select: { id: true },
    });
    return hosts.map((h) => h.id);
  }

  private async rows(
    m: AccountMembership,
    siteId: string,
    page: string,
  ): Promise<MemoUiElementRow[]> {
    const hostIds = await this.publicHostIds(m, siteId);
    if (!hostIds.length) return [];
    const star = page.endsWith('*');
    return this.db(m).siteUiElement.findMany({
      where: {
        siteId,
        hostId: { in: hostIds },
        path: star
          ? { startsWith: page.slice(0, -1) }
          : { in: [page, `${page}/`] },
      },
      select: ELEMENT_SELECT,
      orderBy: [{ sourceRank: 'asc' }, { position: 'asc' }],
      take: MEMO_ELEMENTS_LIMITS.scan,
    });
  }

  /** Страница выбора: шаг (его маска) или явный путь; иначе — первый шаг или «/». */
  private pageOf(
    draft: MemoContent,
    q: { step?: unknown; page?: unknown },
  ): string {
    if (q.step !== undefined && q.step !== null && q.step !== '') {
      const i = Number(q.step);
      if (!Number.isInteger(i) || i < 0 || i >= draft.steps.length)
        throw invalid('step', 'range', 'Шага с таким номером нет');
      return draft.steps[i].page;
    }
    if (q.page !== undefined && q.page !== null && q.page !== '') {
      const p = memoPageParam(q.page);
      if (!p) throw invalid('page', 'format', 'Адрес страницы не подходит');
      return p;
    }
    return draft.steps[draft.steps.length - 1]?.page ?? '/';
  }

  async elements(
    m: AccountMembership,
    siteId: string,
    n: string,
    q: { step?: unknown; page?: unknown },
  ): Promise<MemoElementsView> {
    const detail = await this.memos.get(m, siteId, n);
    const page = this.pageOf(detail.draft, q);
    const view = detail.draft.view;
    return {
      page,
      view,
      items: memoElementViews(await this.rows(m, siteId, page), page, view),
    };
  }

  async apply(
    m: AccountMembership,
    siteId: string,
    n: string,
    body: MemoElementApplyBody | null | undefined,
  ): Promise<MemoDetailView> {
    const detail = await this.memos.get(m, siteId, n);
    const b = body ?? {};
    if (typeof b.expectedRevision !== 'number')
      throw invalid('expectedRevision', 'type');
    if (b.expectedRevision !== detail.draftRevision)
      throw voiceControlError(
        HttpStatus.CONFLICT,
        'MEMO_CONFLICT',
        'Мемо изменили в другой вкладке — обновите',
      );
    if (b.mode !== 'add' && b.mode !== 'replace') throw invalid('mode', 'enum');
    if (
      typeof b.uiElementId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(b.uiElementId)
    )
      throw invalid('uiElementId', 'format');
    // Элемент — ЭТОГО сайта и его подтверждённого хоста «Сайта».
    const hostIds = await this.publicHostIds(m, siteId);
    const el = hostIds.length
      ? await this.db(m).siteUiElement.findFirst({
          where: { id: b.uiElementId, siteId, hostId: { in: hostIds } },
          select: ELEMENT_SELECT,
        })
      : null;
    if (!el)
      throw voiceControlError(
        HttpStatus.NOT_FOUND,
        'MEMO_ELEMENT_NOT_FOUND',
        'Элемент не найден на подтверждённом адресе сайта',
      );
    const draft = detail.draft;
    const steps: MemoStep[] = draft.steps.map((s) => ({ ...s }));
    const slots: MemoSlot[] = draft.slots.map((s) => ({ ...s }));
    let at: number;
    let newSlot: MemoSlot | null = null;
    if (b.mode === 'add') {
      const index =
        b.index === undefined || b.index === null ? steps.length : b.index;
      if (
        typeof index !== 'number' ||
        !Number.isInteger(index) ||
        index < 0 ||
        index > steps.length
      )
        throw invalid('index', 'range');
      const page =
        memoPageParam(b.page) ??
        steps[index - 1]?.page ??
        steps[index]?.page ??
        el.path;
      const made = memoStepFromElement(el, page, slots);
      if (made.slot && slots.length >= MEMO_MAX_SLOTS)
        throw invalid('slots', 'too_many', 'Слотов в мемо — не больше 5');
      steps.splice(index, 0, made.step);
      newSlot = made.slot;
      if (newSlot) slots.push(newSlot);
      at = index;
    } else {
      const index = b.index;
      if (
        typeof index !== 'number' ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= steps.length
      )
        throw invalid('index', 'range');
      const s = steps[index];
      if (['wait', 'say', 'scroll'].includes(s.action))
        throw invalid(`steps[${index}].action`, 'no_target');
      steps[index] = memoStepRetarget(s, el);
      at = index;
    }
    // Ворота кода — те же, что у карточки: «никогда» в новом шаге не пишем.
    const parsed = parseMemoContent(
      JSON.parse(JSON.stringify({ ...draft, steps, slots })),
    );
    if (parsed.issues.length)
      throw voiceControlError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'MEMO_INVALID',
        'Мемо не прошло проверку',
        { errors: parsed.issues },
      );
    const gate = memoGates(parsed.content, await this.rulesHost(m, siteId));
    const bad = gate.problems.find(
      (p) =>
        p.path === `steps[${at}]` &&
        (p.code === 'never_step' || p.code === 'no_target'),
    );
    if (bad)
      throw invalid(
        bad.path,
        bad.code,
        'Этот элемент голосом не нажимается (оплата, удаление, пароль или запрет) — выберите другой',
      );
    const ops: MemoDraftOp[] = [];
    if (newSlot) ops.push({ op: 'set', field: 'slots', value: slots });
    ops.push({ op: 'set', field: 'steps', value: steps });
    return this.memos.patchDraft(m, siteId, n, {
      expectedRevision: detail.draftRevision,
      ops,
    });
  }

  /** Правила кабинета и хост «Сайта» — как ворота карточки. */
  private async rulesHost(m: AccountMembership, siteId: string) {
    const db = this.db(m);
    const row = await db.assistSite.findFirst({
      where: { siteId },
      select: { voiceControlSiteRules: true },
    });
    const h = await db.siteHost.findFirst({
      where: { siteId, status: 'verified', ...PUBLIC_SITE_HOST },
      orderBy: { createdAt: 'asc' },
      select: { host: true },
    });
    return {
      rules: rulesOf(row?.voiceControlSiteRules) ?? defaultVoiceControlRules(),
      host: h?.host ?? 'example.invalid',
    };
  }
}
