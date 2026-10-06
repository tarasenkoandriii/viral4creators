/**
 * Мемо в визуальном редакторе (Э6-тер (д), ТЗ помощника §5-бис.17 п.6–8,
 * §5-кватер.5): запись кликами, перепривязка шага мышкой, «Сохранить
 * черновик», «Прогнать» — в СЕССИИ редактора (`EditorSessionService.resolve`:
 * сессия жива, участник — владелец/менеджер, хост — verified «Сайта»).
 *
 *  - состояние записи держит панель `we.` (её `sessionStorage` переживает
 *    переход MPA, как сама сессия); каждый шаг делает СЕРВЕР из дескриптора
 *    (`recordStep`), сохранение перепроверяет ВСЕ шаги (`recordedDraft`) —
 *    подложить шаг мимо проверок нельзя;
 *  - черновик пишет обычный кабинет мемо (`MemoService.create/patchDraft`):
 *    те же разбор, имя/ключ, ревизии (409), лимит тарифа в транзакции;
 *    `origin: recording`, источник истории — `editor`; публикация — только
 *    в TMA (ворота, сухой прогон мастером, подтверждение человеком);
 *  - «Прогнать» — по ЧЕРНОВИКУ, снимок страницы с подтверждённого хоста,
 *    без нажатий; потолок — общий с «Сказать сейчас» (100 в сутки на сайт).
 * Основная роль: клиент тенанта сессии (`SitesDb.forAccount`).
 */
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import { readState } from '../../assist-billing/public/entitlements';
import { MemoService } from '../../assist-site-voice-control/cabinet/memo.service';
import { MEMO_DECISIONS } from '../../assist-ui-core/decisions';
import {
  MEMO_LIMITS,
  memoTextProblem,
  parseMemoContent,
  type MemoContent,
  type MemoLang,
  type MemoStep,
} from '../../assist-ui-core/memo';
import { onSiteHost } from '../../assist-ui-core/plan-checks';
import { defaultVoiceControlRules, rulesOf } from '../../assist-ui-core/rules';
import {
  cleanText,
  parseSnapshot,
  snapshotTooLarge,
} from '../../assist-ui-core/snapshot';
import {
  descriptorCandidates,
  parseDescriptor,
  parseVoiceMapContent,
  targetsForPage,
  templateFor,
  type VoiceMapDescriptor,
} from '../../assist-ui-core/voice-map';
import {
  parseAccountRole,
  parseProductRoles,
  type AccountMembership,
} from '../../site-core/account/roles';
import { uiMapHost } from '../../site-core/ui-map/ui-map';
import { candidateKeys } from '../../site-core/ui-map/ui-map-model';
import { VoiceMapService } from '../voice-map.service';
import {
  EditorSessionService,
  type ResolvedEditor,
} from './editor-session.service';
import {
  memoNameOf,
  memoTry,
  recordedDraft,
  recordStep,
  type MemoTryView,
  type RecordStepResult,
} from './memo-record';

const PATH_RE = /^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/;
const LANGS: readonly MemoLang[] = ['uk', 'ru', 'en'];

export type EditorMemoErrorCode =
  | 'EDITOR_MEMO_BAD_REQUEST'
  | 'EDITOR_MEMO_STEP_SKIPPED'
  | 'EDITOR_MEMO_INVALID';

function memoError(
  status: HttpStatus,
  code: EditorMemoErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  return new HttpException({ error: code, code, message, ...extra }, status);
}

const bad = (message: string) =>
  memoError(HttpStatus.BAD_REQUEST, 'EDITOR_MEMO_BAD_REQUEST', message);

/** POST /editor/v1/memo/record/start → */
export interface EditorMemoStartView {
  page: string;
  maxSteps: number;
  limit: { used: number; max: number };
  /** Правка существующего мемо (ссылка `focus` / «Открыть в редакторе»). */
  memo: {
    number: number;
    key: string;
    status: string;
    draftRevision: number;
    name: string | null;
    goalText: string | null;
    steps: MemoStep[];
    slots: MemoContent['slots'];
    reviewReason: unknown;
  } | null;
}

/** POST /editor/v1/memo/record/step → */
export type EditorMemoStepView =
  | {
      kind: 'step';
      step: MemoStep;
      slot: MemoContent['slots'][number] | null;
      risk: 'auto' | 'confirm';
      exec: boolean;
    }
  | { kind: 'stop'; reason: string; step: MemoStep | null };

/** POST /editor/v1/memo/record/stop → */
export interface EditorMemoSavedView {
  number: number;
  key: string;
  status: string;
  draftRevision: number;
  gates: { ok: boolean; problems: Array<{ code: string; path: string }> };
}

/** POST /editor/v1/memo/:key/try → */
export interface EditorMemoTryView extends MemoTryView {
  number: number;
  key: string;
  left: number;
}

@Injectable()
export class EditorMemoService {
  private readonly logger = new Logger(EditorMemoService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly prisma: PrismaService,
    private readonly maps: VoiceMapService,
    private readonly editor: EditorSessionService,
    private readonly memos: MemoService,
  ) {}

  /** Участник сессии в форме кабинета (роль — живая, её сверил `resolve`). */
  private async member(ed: ResolvedEditor): Promise<AccountMembership> {
    const m = await this.sitesDb
      .forAccount(ed.accountId)
      .siteAccountMember.findFirst({
        where: { id: ed.memberId },
        select: { role: true, productRoles: true, telegramId: true },
      });
    const role = m ? parseAccountRole(m.role) : null;
    if (!m || !role)
      throw new HttpException(
        {
          error: 'EDITOR_SESSION_EXPIRED',
          code: 'EDITOR_SESSION_EXPIRED',
          message: 'Сессия редактора завершена',
        },
        HttpStatus.UNAUTHORIZED,
      );
    return {
      accountId: ed.accountId,
      memberId: ed.memberId,
      telegramId: m.telegramId,
      role,
      productRoles: parseProductRoles(m.productRoles),
    };
  }

  private async ctx(ed: ResolvedEditor) {
    const db = this.sitesDb.forAccount(ed.accountId);
    const hosts = this.maps.hostNames(
      await this.maps.siteHosts(db, ed.siteId, this.now()),
    );
    const site = await db.assistSite.findFirst({
      where: { siteId: ed.siteId },
      select: { voiceControlSiteRules: true },
    });
    const rules =
      rulesOf(site?.voiceControlSiteRules ?? null) ??
      defaultVoiceControlRules();
    const map = parseVoiceMapContent(
      (await this.maps.loadMap(db, ed.accountId, ed.siteId)).draft,
    );
    return { db, hosts, rules, map };
  }

  private pathOf(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length > 300 || !PATH_RE.test(raw))
      throw bad('Нужен путь страницы');
    return raw;
  }

  /** Маска страницы шага: активный шаблон голосовой карты, иначе сам путь. */
  private pageOf(map: ReturnType<typeof parseVoiceMapContent>, path: string) {
    return templateFor(map, path)?.pathPattern ?? path;
  }

  private async limit(ed: ResolvedEditor) {
    const state = await readState(this.prisma, ed.accountId, this.now());
    const max = state.planId
      ? (MEMO_DECISIONS.limitByPlan[
          state.planId as keyof typeof MEMO_DECISIONS.limitByPlan
        ] ?? 0)
      : 0;
    const used = await this.sitesDb
      .forAccount(ed.accountId)
      .assistSiteMemo.count({
        where: { siteId: ed.siteId, status: { not: 'removed' } },
      });
    return { used, max };
  }

  /**
   * Начало записи (новое мемо — лимит тарифа сразу, чтобы владелец не
   * записывал впустую; окончательно — в транзакции создания) или правка
   * мемо `memo: N` (шаги черновика — в панель, «Открыть в редакторе»).
   */
  async start(ed: ResolvedEditor, body: unknown): Promise<EditorMemoStartView> {
    const b = (body ?? {}) as {
      path?: unknown;
      memo?: unknown;
      lang?: unknown;
    };
    const path = this.pathOf(b.path);
    const { rules, map } = await this.ctx(ed);
    const limit = await this.limit(ed);
    const base = {
      page: this.pageOf(map, path),
      maxSteps: rules.maxSteps,
      limit,
    };
    if (b.memo === undefined || b.memo === null) {
      if (limit.used >= limit.max)
        throw new HttpException(
          {
            error: 'MEMO_LIMIT',
            code: 'MEMO_LIMIT',
            message: `Мемо на этом тарифе — не больше ${limit.max}`,
          },
          HttpStatus.PAYMENT_REQUIRED,
        );
      return { ...base, memo: null };
    }
    if (typeof b.memo !== 'number' && typeof b.memo !== 'string')
      throw bad('Номер мемо');
    const m = await this.member(ed);
    const d = await this.memos.get(m, ed.siteId, b.memo);
    const lang: MemoLang =
      b.lang === 'ru' || b.lang === 'en' ? (b.lang as MemoLang) : 'uk';
    return {
      ...base,
      memo: {
        number: d.number,
        key: d.key,
        status: d.status,
        draftRevision: d.draftRevision,
        name: memoNameOf(d.draft, lang),
        goalText:
          d.draft.goal.text[lang] ??
          LANGS.map((l) => d.draft.goal.text[l]).find(Boolean) ??
          null,
        steps: d.draft.steps,
        slots: d.draft.slots,
        reviewReason: d.reviewReason,
      },
    };
  }

  /** Строка Ш4 элемента: по ключам кандидатов дескриптора на этой странице. */
  private async uiElementOf(
    ed: ResolvedEditor,
    d: VoiceMapDescriptor,
    path: string,
  ) {
    const keys = candidateKeys(
      descriptorCandidates(d),
      d.tag === 'other' ? 'button' : d.tag,
    );
    if (!keys.length) return null;
    const rows = await this.sitesDb
      .forAccount(ed.accountId)
      .siteUiElement.findMany({
        where: {
          siteId: ed.siteId,
          host: uiMapHost(ed.host.replace(/:\d+$/, '')),
          path: path.replace(/\/+$/, '') || '/',
          elementKey: { in: keys },
        },
        select: { id: true, elementKey: true, stability: true },
        orderBy: { confidence: 'desc' },
        take: 5,
      });
    // Лучший — по порядку кандидатов (разметка раньше текста).
    for (const k of keys) {
      const r = rows.find((x) => x.elementKey === k);
      if (r) return { id: r.id, key: r.elementKey, stability: r.stability };
    }
    return null;
  }

  /**
   * Клик владельца → шаг (или остановка записи с причиной). Тело:
   * `{ path, descriptor, fieldName?, options?, slots: string[], count,
   * prev? }` — `prev` при перепривязке шага (цель — новая, слот — прежний).
   */
  async step(ed: ResolvedEditor, body: unknown): Promise<EditorMemoStepView> {
    const b = (body ?? {}) as Record<string, unknown>;
    const path = this.pathOf(b.path);
    const { hosts, rules, map } = await this.ctx(ed);
    const d = parseDescriptor(b.descriptor);
    const mapTarget = d
      ? (targetsForPage(map, path).find(
          (t) =>
            (d.assistId && t.descriptor.assistId === d.assistId) ||
            (!d.assistId &&
              !t.descriptor.assistId &&
              t.descriptor.text === d.text &&
              t.descriptor.role === d.role &&
              t.descriptor.hrefPath === d.hrefPath),
        ) ?? null)
      : null;
    const taken = Array.isArray(b.slots)
      ? b.slots.filter((x): x is string => typeof x === 'string').slice(0, 20)
      : [];
    let prev: MemoStep | null = null;
    if (b.prev !== undefined && b.prev !== null) {
      const p = parseMemoContent({ steps: [b.prev] });
      prev = p.content.steps[0] ?? null;
      if (!prev) throw bad('Шаг для перепривязки не разобран');
    }
    const r: RecordStepResult = recordStep({
      descriptor: b.descriptor,
      fieldName: b.fieldName,
      options: b.options,
      path,
      page: this.pageOf(map, path),
      hosts,
      rules,
      mapTarget,
      uiElement: d ? await this.uiElementOf(ed, d, path) : null,
      takenSlots: taken,
      count: typeof b.count === 'number' && b.count >= 0 ? b.count : 0,
      prev,
    });
    if (r.kind === 'skip')
      throw memoError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'EDITOR_MEMO_STEP_SKIPPED',
        r.code === 'unnamed'
          ? 'У элемента нет видимой подписи — добавьте data-assist-id или подпись'
          : r.code === 'disabled'
            ? 'Элемент неактивен'
            : 'Элемент не разобран',
        { reason: r.code },
      );
    if (r.kind === 'stop')
      this.logger.log(
        `editor memo record stop site=${ed.siteId} reason=${r.reason}`,
      );
    return r;
  }

  /**
   * «Сохранить черновик»: шаги записи (после правок в панели) + имя и цель
   * → новый черновик (`origin: recording`) или правка мемо `memo: N` с
   * `expectedRevision` (409 — изменили в другой вкладке/TMA).
   */
  async stop(ed: ResolvedEditor, body: unknown): Promise<EditorMemoSavedView> {
    const b = (body ?? {}) as Record<string, unknown>;
    const lang: MemoLang =
      b.lang === 'ru' || b.lang === 'en' ? (b.lang as MemoLang) : 'uk';
    const endPath =
      typeof b.path === 'string' && b.path.length <= 300 && PATH_RE.test(b.path)
        ? b.path
        : null;
    if (!Array.isArray(b.steps) || !b.steps.length || b.steps.length > 20)
      throw bad('Нужны шаги записи');
    const name =
      typeof b.name === 'string' ? b.name.replace(/\s+/g, ' ').trim() : '';
    const goalText =
      typeof b.goalText === 'string'
        ? b.goalText.replace(/\s+/g, ' ').trim()
        : '';
    const goalAppear = cleanText(b.goalAppear, 80);
    const { rules, map, hosts } = await this.ctx(ed);
    const m = await this.member(ed);
    const existing =
      typeof b.memo === 'number' || typeof b.memo === 'string'
        ? await this.memos.get(m, ed.siteId, b.memo)
        : null;
    const prev = existing?.draft ?? null;
    const raw: Record<string, unknown> = {
      names: { ...(prev?.names ?? {}), ...(name ? { [lang]: name } : {}) },
      triggers: prev?.triggers ?? {},
      suggested: prev?.suggested ?? {},
      goal: {
        text: {
          ...(prev?.goal.text ?? {}),
          ...(goalText ? { [lang]: goalText } : {}),
        },
        expect: goalAppear
          ? [
              ...(prev?.goal.expect ?? []).filter((g) => g.kind !== 'text'),
              { kind: 'text', text: goalAppear },
            ]
          : (prev?.goal.expect ?? []),
      },
      slots: Array.isArray(b.slots) ? b.slots : [],
      steps: b.steps,
      view: prev?.view ?? 'any',
    };
    const rec = recordedDraft(raw, {
      rules,
      host: hosts[0] ?? 'example.invalid',
      endPage: endPath ? this.pageOf(map, endPath) : null,
      fresh: !existing,
    });
    if (name && memoTextProblem(name, MEMO_LIMITS.nameChars))
      rec.issues.push({
        path: `names.${lang}`,
        code: memoTextProblem(name, MEMO_LIMITS.nameChars)!,
      });
    if (!existing && !name) rec.issues.push({ path: 'name', code: 'empty' });
    if (rec.issues.length)
      throw memoError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'EDITOR_MEMO_INVALID',
        'Мемо не сохранено: шаги или тексты не прошли проверку',
        { errors: rec.issues.slice(0, 30) },
      );
    const c = rec.content;
    const detail = existing
      ? await this.memos.patchDraft(
          m,
          ed.siteId,
          String(existing.number),
          {
            expectedRevision:
              typeof b.expectedRevision === 'number' ? b.expectedRevision : -1,
            ops: [
              { op: 'set', field: 'names', value: c.names },
              { op: 'set', field: 'goal', value: c.goal },
              { op: 'set', field: 'slots', value: c.slots },
              { op: 'set', field: 'steps', value: c.steps },
            ],
          },
          'editor',
        )
      : await this.memos.create(
          m,
          ed.siteId,
          { name, lang, draft: c },
          { origin: 'recording', source: 'editor' },
        );
    this.logger.log(
      `editor memo saved site=${ed.siteId} memo=${detail.number} steps=${c.steps.length} new=${!existing}`,
    );
    return {
      number: detail.number,
      key: detail.key,
      status: detail.status,
      draftRevision: detail.draftRevision,
      gates: {
        ok: detail.gates.ok,
        problems: detail.gates.problems.map((p) => ({
          code: p.code,
          path: p.path,
        })),
      },
    };
  }

  /**
   * «Прогнать» черновик мемо `key` на ЭТОЙ странице (снимок пикера, без
   * нажатий): шаги по порядку с `from` до первого сбоя или перехода.
   */
  async tryMemo(
    ed: ResolvedEditor,
    keyRaw: unknown,
    body: unknown,
  ): Promise<EditorMemoTryView> {
    if (typeof keyRaw !== 'string' || !MEMO_LIMITS.keyRe.test(keyRaw))
      throw bad('Ключ мемо');
    const b = (body ?? {}) as { snapshot?: unknown; from?: unknown };
    if (snapshotTooLarge(b.snapshot))
      throw bad('Снимок страницы слишком велик');
    const snapshot = parseSnapshot(b.snapshot);
    if (!snapshot) throw bad('Снимок страницы не разобран');
    const { db, hosts, rules } = await this.ctx(ed);
    if (!onSiteHost(snapshot.url, hosts))
      throw bad('Снимок не с подтверждённого адреса сайта');
    const row = await db.assistSiteMemo.findFirst({
      where: { siteId: ed.siteId, key: keyRaw, status: { not: 'removed' } },
      select: { number: true },
    });
    if (!row)
      throw new HttpException(
        {
          error: 'MEMO_NOT_FOUND',
          code: 'MEMO_NOT_FOUND',
          message: 'Мемо не найдено',
        },
        HttpStatus.NOT_FOUND,
      );
    const m = await this.member(ed);
    const d = await this.memos.get(m, ed.siteId, row.number);
    const left = await this.editor.spendTry(db, ed.siteId);
    const from =
      typeof b.from === 'number' && Number.isInteger(b.from) && b.from >= 0
        ? b.from
        : 0;
    const view = memoTry(
      d.draft,
      d.gates.computed,
      snapshot,
      { rules, hosts },
      from,
    );
    return { ...view, number: d.number, key: d.key, left };
  }
}
