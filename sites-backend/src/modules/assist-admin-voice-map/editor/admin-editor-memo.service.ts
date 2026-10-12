/**
 * Мемо АМ-N в панели редактора карты «Админки» (iframe `wa.`) — заход 13,
 * хвост Р-З11-А11 (паритет с `/editor/v1/memo/*` «Сайта»; ТЗ §5-бис.17
 * п.6–7, п.10, §5-кватер.5, §5-кватер.13):
 *   GET  /assist-admin/v1/editor/memo/list?lang=          все АМ-N сайта
 *   POST /assist-admin/v1/editor/memo/record/start        { path, memo?, lang } — новое (лимит Pro) / правка АМ-N
 *   POST /assist-admin/v1/editor/memo/record/step         { path, descriptor, fieldName?, options?, slots, count, prev? }
 *   POST /assist-admin/v1/editor/memo/record/stop         { memo?, expectedRevision?, lang, name, goalText, steps, slots }
 *   POST /assist-admin/v1/editor/memo/:key/try            { snapshot, from? } — «Прогнати» по черновику
 *   POST /assist-admin/v1/editor/memo/record/wait         у «Админки» нет («Чекати це» — цели мемо «Сайта») — 404
 * Допуск — обе сессии (сотрудника `wa.` и редактора), как у всех
 * `/assist-admin/v1/editor/*`. Черновик пишет КАБИНЕТ мемо «Админки»
 * (`AdminMemoService.create/patchDraft`: тот же строгий разбор — шаг-клик с
 * серверным эффектом 422, лимит Pro в транзакции, ревизия 409), журнал —
 * строки `memo` от имени сотрудника `jwt:<sub>` (канал `embed`). Публикация —
 * только в TMA (ворота + сухой прогон мастером + подтверждение владельца).
 */
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { SitesDb } from '../../../prisma/sites-db.service';
import {
  ADMIN_MEMO_LIMITS,
  adminMemoName,
  parseAdminMemo,
  type AdminMemoContent,
  type AdminMemoSlot,
} from '../../assist-admin-actions/admin-memo';
import { AdminMemoService } from '../../assist-admin-actions/admin-memo.service';
import { MEMO_LIMITS, memoTextProblem } from '../../assist-ui-core/memo';
import { parseSnapshot, snapshotTooLarge } from '../../assist-ui-core/snapshot';
import {
  parseDescriptor,
  parseVoiceMapContent,
  targetsForPage,
} from '../../assist-ui-core/voice-map';
import {
  parseAccountRole,
  parseProductRoles,
  type AccountMembership,
} from '../../site-core/account/roles';
import { adminVoiceMapError } from '../admin-voice-map-errors';
import { AdminVoiceMapService } from '../admin-voice-map.service';
import {
  AdminEditorSessionService,
  type ResolvedAdminEditor,
} from './admin-editor-session.service';
import {
  adminMemoTry,
  draftFromPanel,
  panelSteps,
  recordAdminUiStep,
  type AdminMemoTryView,
  type AdminPanelStep,
  type AdminRecordResult,
} from './admin-memo-record';

const PATH_RE = /^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/;
type Lang = 'uk' | 'ru' | 'en';
const langOf = (v: unknown): Lang => (v === 'ru' || v === 'en' ? v : 'uk');

const bad = (message: string) =>
  adminVoiceMapError(
    HttpStatus.BAD_REQUEST,
    'EDITOR_MEMO_BAD_REQUEST',
    message,
  );

export interface AdminEditorMemoStartView {
  page: string;
  maxSteps: number;
  limit: { used: number; max: number };
  memo: {
    number: number;
    key: string;
    status: string;
    draftRevision: number;
    name: string | null;
    goalText: string | null;
    steps: AdminPanelStep[];
    slots: AdminMemoSlot[];
    reviewReason: unknown;
    undo: null[];
    counter: null;
  } | null;
}

export interface AdminEditorMemoListView {
  items: Array<{
    number: number;
    key: string;
    name: string | null;
    status: string;
    page: string | null;
    steps: number;
  }>;
  limit: { used: number; max: number };
}

export interface AdminEditorMemoSavedView {
  number: number;
  key: string;
  status: string;
  draftRevision: number;
  gates: { ok: boolean; problems: Array<{ code: string; path: string }> };
}

export interface AdminEditorMemoTryView extends AdminMemoTryView {
  number: number;
  key: string;
  left: number;
}

@Injectable()
export class AdminEditorMemoService {
  private readonly logger = new Logger(AdminEditorMemoService.name);

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly maps: AdminVoiceMapService,
    private readonly editor: AdminEditorSessionService,
    private readonly memos: AdminMemoService,
  ) {}

  /** Участник кабинета, выдавший ссылку (владелец «Админки»; право сверил `resolve`). */
  private async member(ed: ResolvedAdminEditor): Promise<AccountMembership> {
    const m = await this.sitesDb
      .forAccount(ed.accountId)
      .siteAccountMember.findFirst({
        where: { id: ed.memberId },
        select: { role: true, productRoles: true, telegramId: true },
      });
    const role = m ? parseAccountRole(m.role) : null;
    if (!m || !role)
      throw adminVoiceMapError(
        HttpStatus.UNAUTHORIZED,
        'EDITOR_SESSION_EXPIRED',
        'Сессия редактора завершена — откройте редактор заново из Telegram',
      );
    return {
      accountId: ed.accountId,
      memberId: ed.memberId,
      telegramId: m.telegramId,
      role,
      productRoles: parseProductRoles(m.productRoles),
    };
  }

  private via(ed: ResolvedAdminEditor) {
    return {
      actor: ed.employeeRef,
      actorRole: ed.customerRole,
      channel: 'embed' as const,
    };
  }

  private pathOf(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length > 300 || !PATH_RE.test(raw))
      throw bad('Нужен путь страницы');
    return raw;
  }

  private async ctx(ed: ResolvedAdminEditor) {
    const db = this.sitesDb.forAccount(ed.accountId);
    const hosts = this.maps.hostNames(
      await this.maps.adminHosts(db, ed.siteId, new Date()),
    );
    const rules = await this.editor.rules(ed);
    const map = parseVoiceMapContent(
      (await this.maps.loadMap(db, ed.accountId, ed.siteId)).draft,
    );
    return { db, hosts, rules, map };
  }

  /** Лимит мемо «Админки» (Pro — 50, иначе 0) и сколько занято. */
  private async limit(m: AccountMembership, siteId: string) {
    const l = await this.memos.list(m, siteId);
    return { used: l.used, max: l.limit };
  }

  async start(
    ed: ResolvedAdminEditor,
    body: unknown,
  ): Promise<AdminEditorMemoStartView> {
    const b = (body ?? {}) as {
      path?: unknown;
      memo?: unknown;
      lang?: unknown;
    };
    const path = this.pathOf(b.path);
    const m = await this.member(ed);
    const limit = await this.limit(m, ed.siteId);
    const base = { page: path, maxSteps: ADMIN_MEMO_LIMITS.steps, limit };
    if (b.memo === undefined || b.memo === null) {
      if (limit.used >= limit.max)
        throw new HttpException(
          {
            error: 'MEMO_LIMIT',
            code: 'MEMO_LIMIT',
            message: `Мемо «Админки» — не больше ${limit.max} на сайт`,
          },
          HttpStatus.PAYMENT_REQUIRED,
        );
      return { ...base, memo: null };
    }
    const n = typeof b.memo === 'number' ? b.memo : Number(b.memo);
    if (!Number.isInteger(n) || n < 1) throw bad('Номер мемо');
    const d = await this.memos.get(m, ed.siteId, n);
    const lang = langOf(b.lang);
    return {
      ...base,
      memo: {
        number: d.number,
        key: d.key,
        status: d.status,
        draftRevision: d.draftRevision,
        name: d.draft.names[lang] ?? (adminMemoName(d.draft, lang) || null),
        goalText:
          d.draft.goal.text[lang] ??
          (['uk', 'ru', 'en'] as const)
            .map((l) => d.draft.goal.text[l])
            .find(Boolean) ??
          null,
        steps: panelSteps(d.draft, lang),
        slots: d.draft.slots,
        reviewReason: d.reviewReason,
        undo: d.draft.steps.map(() => null),
        counter: null,
      },
    };
  }

  async list(
    ed: ResolvedAdminEditor,
    langRaw: unknown,
  ): Promise<AdminEditorMemoListView> {
    const lang = langOf(langRaw);
    const m = await this.member(ed);
    const rows = await this.sitesDb
      .forAccount(ed.accountId)
      .assistAdminMemo.findMany({
        where: { siteId: ed.siteId, status: { not: 'removed' } },
        orderBy: { number: 'asc' },
        select: { number: true, key: true, status: true, draft: true },
        take: 200,
      });
    return {
      items: rows.map((r) => {
        const c = parseAdminMemo(r.draft).content;
        return {
          number: r.number,
          key: r.key,
          name: adminMemoName(c, lang) || null,
          status: r.status,
          page: null,
          steps: c.steps.length,
        };
      }),
      limit: await this.limit(m, ed.siteId),
    };
  }

  /** Клик владельца → шаг `ui` (или остановка записи с причиной). */
  async step(
    ed: ResolvedAdminEditor,
    body: unknown,
  ): Promise<Exclude<AdminRecordResult, { kind: 'skip' }>> {
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
    // Перепривязка: от прежнего шага нужен только слот (цель — новая).
    let prev: AdminPanelStep | null = null;
    if (b.prev !== undefined && b.prev !== null) {
      const pv = (b.prev as { value?: unknown }).value as
        { slot?: unknown } | null | undefined;
      const slot =
        pv && typeof pv === 'object' && typeof pv.slot === 'string'
          ? pv.slot
          : null;
      if (slot !== null && !/^[a-z][a-z0-9_]{0,19}$/.test(slot))
        throw bad('Шаг для перепривязки не разобран');
      prev = {
        action: 'click',
        page: '',
        target: null,
        value: slot ? { slot } : null,
        expect: null,
      };
    }
    const r = recordAdminUiStep({
      descriptor: b.descriptor,
      fieldName: b.fieldName,
      options: b.options,
      path,
      hosts,
      rules,
      mapTarget,
      takenSlots: taken,
      count: typeof b.count === 'number' && b.count >= 0 ? b.count : 0,
      prev,
      row: b.row,
    });
    if (r.kind === 'skip')
      throw new HttpException(
        {
          error: 'EDITOR_MEMO_STEP_SKIPPED',
          code: 'EDITOR_MEMO_STEP_SKIPPED',
          message:
            r.code === 'unnamed'
              ? 'У элемента нет видимой подписи — добавьте data-assist-id или подпись'
              : r.code === 'row'
                ? 'Элемент в строке таблицы: его подпись — данные клиента. Добавьте data-assist-id'
                : r.code === 'disabled'
                  ? 'Элемент неактивен'
                  : 'Элемент не разобран',
          reason: r.code,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    if (r.kind === 'stop')
      this.logger.log(
        `admin editor memo record stop site=${ed.siteId} reason=${r.reason}`,
      );
    return r;
  }

  /** «Чекати це» — у мемо «Админки» целей-ожиданий нет (Р-З13-А7). */
  wait(): never {
    throw new HttpException(
      {
        error: 'EDITOR_MEMO_BAD_REQUEST',
        code: 'EDITOR_MEMO_BAD_REQUEST',
        message: '«Чекати це» — только у мемо сайта',
      },
      HttpStatus.NOT_FOUND,
    );
  }

  /** «Зберегти чернетку»: новое АМ-N или правка `memo: N` (ревизия — 409). */
  async stop(
    ed: ResolvedAdminEditor,
    body: unknown,
  ): Promise<AdminEditorMemoSavedView> {
    const b = (body ?? {}) as Record<string, unknown>;
    const lang = langOf(b.lang);
    if (!Array.isArray(b.steps) || !b.steps.length || b.steps.length > 20)
      throw bad('Нужны шаги записи');
    const name =
      typeof b.name === 'string' ? b.name.replace(/\s+/g, ' ').trim() : '';
    const goalText =
      typeof b.goalText === 'string'
        ? b.goalText.replace(/\s+/g, ' ').trim()
        : '';
    // Аудит З13-А P3-2: номер мемо — целое ≥ 1 (иначе 400, а не NaN в базу).
    let memoNo: number | null = null;
    if (b.memo !== undefined && b.memo !== null) {
      memoNo = typeof b.memo === 'number' ? b.memo : Number(b.memo);
      if (
        (typeof b.memo !== 'number' && typeof b.memo !== 'string') ||
        !Number.isInteger(memoNo) ||
        memoNo < 1
      )
        throw bad('Номер мемо');
    }
    const m = await this.member(ed);
    const existing =
      memoNo !== null ? await this.memos.get(m, ed.siteId, memoNo) : null;
    // `keep` — индексы шагов черновика ТОЙ ревизии, что видела панель:
    // ревизия сверяется до разбора шагов (иначе — 409, а не «keep_invalid»).
    if (existing && b.expectedRevision !== existing.draftRevision)
      throw new HttpException(
        {
          error: 'MEMO_REVISION',
          code: 'MEMO_REVISION',
          message: 'Мемо изменили в другой вкладке — обновите',
        },
        HttpStatus.CONFLICT,
      );
    const prev: AdminMemoContent | null = existing?.draft ?? null;
    const fromPanel = draftFromPanel(
      prev,
      b.steps,
      Array.isArray(b.slots) ? b.slots : [],
    );
    const raw = {
      names: { ...(prev?.names ?? {}), ...(name ? { [lang]: name } : {}) },
      triggers: prev?.triggers ?? {},
      goal: {
        text: {
          ...(prev?.goal.text ?? {}),
          ...(goalText ? { [lang]: goalText } : {}),
        },
      },
      slots: fromPanel.slots,
      steps: fromPanel.steps,
    };
    const parsed = parseAdminMemo(raw);
    const issues = [...fromPanel.issues, ...parsed.issues];
    const nameProblem = name
      ? memoTextProblem(name, MEMO_LIMITS.nameChars)
      : null;
    if (nameProblem) issues.push({ path: `names.${lang}`, code: nameProblem });
    if (!existing && !name) issues.push({ path: 'name', code: 'empty' });
    if (issues.length)
      throw adminVoiceMapError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'EDITOR_MEMO_INVALID',
        issues.some((i) => i.code === 'click_forbidden')
          ? 'Шаг-клик с серверным действием в мемо «Админки» не сохраняется — добавьте шаг API в Telegram'
          : 'Мемо не сохранено: шаги или тексты не прошли проверку',
        { errors: issues.slice(0, 30) },
      );
    const via = this.via(ed);
    const detail = existing
      ? await this.memos.patchDraft(
          m,
          ed.siteId,
          existing.number,
          {
            expectedRevision:
              typeof b.expectedRevision === 'number' ? b.expectedRevision : -1,
            draft: parsed.content,
          },
          via,
        )
      : await this.memos.create(m, ed.siteId, { draft: parsed.content }, via);
    const gates = await this.memos.draftGates(
      ed.accountId,
      ed.siteId,
      detail.draft,
    );
    this.logger.log(
      `admin editor memo saved site=${ed.siteId} memo=${detail.number} steps=${parsed.content.steps.length} new=${!existing}`,
    );
    return {
      number: detail.number,
      key: detail.key,
      status: detail.status,
      draftRevision: detail.draftRevision,
      gates: {
        ok: gates.result === 'pass',
        problems: gates.problems.map((p) => ({ code: p.code, path: p.path })),
      },
    };
  }

  /** «Прогнати» черновик АМ-N `key` на ЭТОЙ странице (снимок пикера, без нажатий). */
  async tryMemo(
    ed: ResolvedAdminEditor,
    keyRaw: unknown,
    body: unknown,
  ): Promise<AdminEditorMemoTryView> {
    if (typeof keyRaw !== 'string' || !MEMO_LIMITS.keyRe.test(keyRaw))
      throw bad('Ключ мемо');
    const b = (body ?? {}) as { snapshot?: unknown; from?: unknown };
    if (snapshotTooLarge(b.snapshot))
      throw bad('Снимок страницы слишком велик');
    const snapshot = parseSnapshot(b.snapshot);
    if (!snapshot) throw bad('Снимок страницы не разобран');
    const { db, hosts, rules } = await this.ctx(ed);
    const row = await db.assistAdminMemo.findFirst({
      where: { siteId: ed.siteId, key: keyRaw, status: { not: 'removed' } },
      select: { number: true, key: true, draft: true },
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
    const left = await this.editor.spendTry(ed);
    const from =
      typeof b.from === 'number' && Number.isInteger(b.from) && b.from >= 0
        ? b.from
        : 0;
    const view = adminMemoTry(
      parseAdminMemo(row.draft).content,
      snapshot,
      { rules, hosts },
      from,
    );
    return { ...view, number: row.number, key: row.key, left };
  }
}
