/**
 * Мемо «Админки» АМ-N — кабинет и исполнение (Э8, ТЗ §5-бис.17 п.4, п.10,
 * п.12, п.15 п.17; Р-61, Р-68, Р-69).
 *
 * Кабинет (только `assistAdmin: owner`, гвард контроллера): номер из
 * счётчика сайта (не переиспользуется), ключ (неизменен после первой
 * публикации), черновик с ревизией (409 при расхождении), версия = ворота
 * кода + проверка по живому каталогу коннекторов (кликов нет — браузерный
 * прогон не нужен), публикация — отдельным подтверждением владельца, индекс
 * фраз — уникальный ключ БД (гонка двух публикаций с одной фразой — одна
 * получает 409). Журнал изменений — записи `memo` в append-only
 * assist_admin_action_log (§5-бис.17 п.10).
 *
 * Исполнение (сотрудник): «АМ-5 …» или фраза → опубликованная версия
 * (закреплена в запуске) → права роли на КАЖДУЮ операцию до первого шага
 * (мемо не расширяет права) → шаги по порядку: `read` — сразу, write/danger —
 * предложение и «Да» (каждое отдельно), `say` — реплика; итог шага
 * продолжает запуск (`ProposalsService.onSettled`).
 */
import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { readState } from '../assist-billing/public/entitlements';
import { ASSIST_PLANS } from '../assist-billing/plans';
import {
  AdminActionLogService,
  canonicalJson,
} from '../assist-admin-mode/action-log.service';
import { adminError } from '../assist-admin-mode/admin-errors';
import { AdminModeService } from '../assist-admin-mode/admin-mode.service';
import {
  ConnectorsService,
  type ToolOperation,
} from '../assist-admin-mode/connectors.service';
import type {
  OperationKind,
  OperationParam,
} from '../assist-admin-mode/openapi-import';
import {
  suggestMemoKey,
  MEMO_LIMITS,
  type MemoLang,
} from '../assist-ui-core/memo';
import type { AccountMembership } from '../site-core/account/roles';
import { ACTION_LIMITS } from './action-core';
import {
  ADMIN_MEMO_LIMITS,
  type AdminMemoContent,
  type AdminMemoGateReport,
  type MemoCatalogOp,
  adminMemoGates,
  adminMemoName,
  adminMemoPhrases,
  emptyAdminMemo,
  fillAdminSlots,
  markPii,
  memoNumberIn,
  parseAdminMemo,
  phrasePrefix,
  stepArgs,
} from './admin-memo';
import type { AdminMemoUiStep } from '../assist-admin-voice/admin-voice-rules';
import {
  type ActorCtx,
  ProposalsService,
  type ProposalView,
} from './proposals.service';

export interface AdminMemoListItem {
  number: number;
  key: string;
  name: string;
  status: string;
  publishedVersion: number | null;
  draftRevision: number;
  updatedAt: string;
}

export interface AdminMemoView extends AdminMemoListItem {
  draft: AdminMemoContent;
  versions: Array<{
    number: number;
    status: string;
    gateReport: AdminMemoGateReport | null;
    createdAt: string;
    publishedAt: string | null;
    rollbackOf: number | null;
  }>;
}

const MEMO_TEXT = {
  started: {
    uk: (n: number, name: string) => `Виконую АМ-${n} «${name}».`,
    ru: (n: number, name: string) => `Выполняю АМ-${n} «${name}».`,
    en: (n: number, name: string) => `Running AM-${n} «${name}».`,
  },
  step: {
    uk: (i: number, total: number) =>
      `Крок ${i} з ${total}: потрібне ваше «Так».`,
    ru: (i: number, total: number) => `Шаг ${i} из ${total}: нужно ваше «Да».`,
    en: (i: number, total: number) =>
      `Step ${i} of ${total}: your "Yes" is needed.`,
  },
  done: {
    uk: (n: number, goal: string) =>
      `АМ-${n} виконано${goal ? `: ${goal}` : ''}.`,
    ru: (n: number, goal: string) =>
      `АМ-${n} выполнено${goal ? `: ${goal}` : ''}.`,
    en: (n: number, goal: string) =>
      `AM-${n} is done${goal ? `: ${goal}` : ''}.`,
  },
  stopped: {
    uk: (n: number, i: number, done: string) =>
      `АМ-${n} зупинено на кроці ${i}.${done ? ` Уже зроблено: ${done}.` : ' Нічого не змінено.'}`,
    ru: (n: number, i: number, done: string) =>
      `АМ-${n} остановлено на шаге ${i}.${done ? ` Уже сделано: ${done}.` : ' Ничего не изменено.'}`,
    en: (n: number, i: number, done: string) =>
      `AM-${n} stopped at step ${i}.${done ? ` Already done: ${done}.` : ' Nothing was changed.'}`,
  },
  missing: {
    uk: (n: number, names: string) =>
      `Для АМ-${n} вкажіть: ${names} (наприклад, «АМ-${n} назва=значення»).`,
    ru: (n: number, names: string) =>
      `Для АМ-${n} укажите: ${names} (например, «АМ-${n} имя=значение»).`,
    en: (n: number, names: string) =>
      `For AM-${n}, please provide: ${names} (e.g. "AM-${n} name=value").`,
  },
  forbidden: {
    uk: (n: number) =>
      `У вас немає прав на операції АМ-${n} — зверніться до власника.`,
    ru: (n: number) =>
      `У вас нет прав на операции АМ-${n} — обратитесь к владельцу.`,
    en: (n: number) =>
      `You don't have rights for the operations of AM-${n} — ask the owner.`,
  },
  unknownMemo: {
    uk: (n: number) => `Мемо АМ-${n} не знайдено або вимкнено.`,
    ru: (n: number) => `Мемо АМ-${n} не найдено или выключено.`,
    en: (n: number) => `Memo AM-${n} was not found or is disabled.`,
  },
  readFailed: {
    uk: 'запит до системи не вдався',
    ru: 'запрос к системе не удался',
    en: 'the system request failed',
  },
  // Э6-бис (б): шаги на странице (Р-Э6б-10).
  uiNeedsPage: {
    uk: (n: number) =>
      `АМ-${n} має кроки на сторінці адмінки — запустіть його в помічнику на сторінці з увімкненим голосовим керуванням.`,
    ru: (n: number) =>
      `В АМ-${n} есть шаги на странице админки — запустите его в помощнике на странице с включённым голосовым управлением.`,
    en: (n: number) =>
      `AM-${n} has steps on the admin page — run it from the assistant on the page with voice control enabled.`,
  },
  uiNext: {
    uk: (i: number, total: number) => `Крок ${i} з ${total} — на сторінці.`,
    ru: (i: number, total: number) => `Шаг ${i} из ${total} — на странице.`,
    en: (i: number, total: number) => `Step ${i} of ${total} is on the page.`,
  },
} as const;

/** Отрезок шагов на странице, который ждёт исполнения (Э6-бис (б)). */
export interface MemoUiSegment {
  runId: string;
  memoNumber: number;
  name: string;
  from: number;
  to: number;
  steps: AdminMemoUiStep[];
  slots: Record<string, string>;
}

type MemoRow = Prisma.AssistAdminMemoGetPayload<object>;

function contentHash(c: unknown): string {
  return createHash('sha256').update(canonicalJson(c)).digest('hex');
}

@Injectable()
export class AdminMemoService {
  constructor(
    private readonly db: SitesDb,
    private readonly prisma: PrismaService,
    private readonly mode: AdminModeService,
    private readonly connectors: ConnectorsService,
    private readonly proposals: ProposalsService,
    private readonly log: AdminActionLogService,
  ) {
    this.proposals.onSettled = (ctx, row, status) =>
      this.afterStep(ctx, row.memoRunId!, row.memoStep!, status);
  }

  // ── каталог операций сайта ─────────────────────────────────────────────

  private async catalog(
    accountId: string,
    siteId: string,
  ): Promise<Map<string, MemoCatalogOp & ToolOperation>> {
    const rows = await this.db
      .forAccount(accountId)
      .assistAdminOperation.findMany({
        where: { siteId },
        include: {
          connector: { select: { id: true, name: true, status: true } },
        },
      });
    return new Map(
      rows.map((o) => [
        o.id,
        {
          rowId: o.id,
          key: `${o.connector.name}.${o.operationId}`,
          kind: o.kind as OperationKind,
          enabled: o.enabled && o.connector.status === 'active',
          unsupported: o.unsupported,
          params: Array.isArray(o.params)
            ? (o.params as unknown as OperationParam[])
            : [],
          roles: o.roles,
          connectorId: o.connector.id,
          connectorName: o.connector.name,
          operationId: o.operationId,
          method: o.method,
          path: o.path,
          summary: o.summary,
          dailyLimit: o.dailyLimit,
        },
      ]),
    );
  }

  // ── кабинет ────────────────────────────────────────────────────────────

  private async limit(accountId: string): Promise<number> {
    const st = await readState(this.prisma, accountId, new Date());
    return st.planId && ASSIST_PLANS[st.planId].adminActions
      ? ADMIN_MEMO_LIMITS.perSitePro
      : 0;
  }

  private async memoRow(
    accountId: string,
    siteId: string,
    n: number,
  ): Promise<MemoRow> {
    const r = await this.db.forAccount(accountId).assistAdminMemo.findFirst({
      where: { siteId, number: n, status: { not: 'removed' } },
    });
    if (!r) throw adminError(404, 'MEMO_NOT_FOUND', 'Мемо не найдено');
    return r;
  }

  private async memoLog(
    m: AccountMembership,
    siteId: string,
    memo: { number: number; id: string },
    outcome: string,
    details: Record<string, unknown> = {},
  ) {
    await this.log.append({
      accountId: m.accountId,
      siteId,
      actor: `tg:${m.telegramId.toString()}`,
      actorRole: 'owner',
      channel: 'tma',
      conversationId: null,
      connectorId: null,
      operationRowId: null,
      operation: `memo:АМ-${memo.number}`,
      kind: 'memo',
      outcome,
      httpStatus: null,
      durationMs: null,
      requestMasked: { memo: memo.id, ...details } as Prisma.InputJsonValue,
      responseBytes: null,
      error: null,
    });
  }

  private item(r: MemoRow): AdminMemoListItem {
    const d = parseAdminMemo(r.draft).content;
    return {
      number: r.number,
      key: r.key,
      name: adminMemoName(d, 'uk'),
      status: r.status,
      publishedVersion: r.publishedVersion,
      draftRevision: r.draftRevision,
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async list(m: AccountMembership, siteId: string) {
    await this.mode.requireSite(m.accountId, siteId);
    const rows = await this.db
      .forAccount(m.accountId)
      .assistAdminMemo.findMany({
        where: { siteId, status: { not: 'removed' } },
        orderBy: { number: 'asc' },
      });
    return {
      limit: await this.limit(m.accountId),
      used: rows.length,
      memos: rows.map((r) => this.item(r)),
    };
  }

  async get(
    m: AccountMembership,
    siteId: string,
    n: number,
  ): Promise<AdminMemoView> {
    await this.mode.requireSite(m.accountId, siteId);
    const r = await this.memoRow(m.accountId, siteId, n);
    const versions = await this.db
      .forAccount(m.accountId)
      .assistAdminMemoVersion.findMany({
        where: { memoId: r.id },
        orderBy: { number: 'desc' },
        take: MEMO_LIMITS.versionsKept,
      });
    return {
      ...this.item(r),
      draft: parseAdminMemo(r.draft).content,
      versions: versions.map((v) => ({
        number: v.number,
        status: v.status,
        gateReport: (v.gateReport as unknown as AdminMemoGateReport) ?? null,
        createdAt: v.createdAt.toISOString(),
        publishedAt: v.publishedAt?.toISOString() ?? null,
        rollbackOf: v.rollbackOf,
      })),
    };
  }

  private invalid(issues: Array<{ path: string; code: string }>) {
    const click = issues.find((i) => i.code === 'click_forbidden');
    return adminError(
      422,
      'MEMO_INVALID',
      click
        ? `Шаг-клик в мемо «Админки» не сохраняется (${click.path}): серверные действия — только шагом api (операция коннектора)`
        : `Мемо не прошло проверку: ${issues
            .slice(0, 5)
            .map((i) => `${i.path} ${i.code}`)
            .join('; ')}`,
    );
  }

  async create(
    m: AccountMembership,
    siteId: string,
    body: { key?: string; draft?: unknown },
  ): Promise<AdminMemoView> {
    await this.mode.requireSite(m.accountId, siteId);
    const limit = await this.limit(m.accountId);
    const db = this.db.forAccount(m.accountId);
    const used = await db.assistAdminMemo.count({
      where: { siteId, status: { not: 'removed' } },
    });
    if (limit === 0) {
      throw adminError(
        402,
        'ADMIN_ACTIONS_PLAN',
        'Мемо «Админки» — в тарифе Pro',
      );
    }
    if (used >= limit) {
      throw adminError(
        409,
        'MEMO_LIMIT',
        `Мемо «Админки» — не больше ${limit} на сайт`,
      );
    }
    const parsed = parseAdminMemo(body.draft ?? emptyAdminMemo());
    if (parsed.issues.length) throw this.invalid(parsed.issues);
    const name = adminMemoName(parsed.content, 'uk');
    let key = (body.key ?? suggestMemoKey(name || 'memo')).toLowerCase();
    if (!MEMO_LIMITS.keyRe.test(key)) {
      throw adminError(
        422,
        'MEMO_INVALID',
        'Ключ — латиница, цифры и дефис, 2–40 символов',
      );
    }
    await this.mode.ensureSettings(m.accountId, siteId);
    const actor = `tg:${m.telegramId.toString()}`;
    const row = await db.$transaction(async (tx) => {
      const taken = await tx.assistAdminMemo.findFirst({
        where: { siteId, key },
      });
      if (taken) {
        if (body.key) throw adminError(409, 'MEMO_CONFLICT', 'Ключ уже занят');
        key = `${key.slice(0, 33)}-${Date.now().toString(36).slice(-6)}`;
      }
      const s = await tx.assistAdminSettings.update({
        where: { siteId },
        data: { memoCounter: { increment: 1 } },
        select: { memoCounter: true },
      });
      return tx.assistAdminMemo.create({
        data: {
          accountId: m.accountId,
          siteId,
          number: s.memoCounter,
          key,
          draft: parsed.content as unknown as Prisma.InputJsonValue,
          createdBy: actor,
          updatedBy: actor,
        },
      });
    });
    await this.memoLog(m, siteId, row, 'create', { key });
    return this.get(m, siteId, row.number);
  }

  async patchDraft(
    m: AccountMembership,
    siteId: string,
    n: number,
    body: { expectedRevision: number; draft: unknown; key?: string },
  ): Promise<AdminMemoView> {
    await this.mode.requireSite(m.accountId, siteId);
    const r = await this.memoRow(m.accountId, siteId, n);
    const parsed = parseAdminMemo(body.draft);
    if (parsed.issues.length) throw this.invalid(parsed.issues);
    const data: Prisma.AssistAdminMemoUpdateManyMutationInput = {
      draft: parsed.content as unknown as Prisma.InputJsonValue,
      draftRevision: { increment: 1 },
      updatedBy: `tg:${m.telegramId.toString()}`,
    };
    if (body.key !== undefined && body.key !== r.key) {
      if (r.publishedVersion !== null) {
        throw adminError(
          422,
          'MEMO_INVALID',
          'Ключ не меняется после первой публикации',
        );
      }
      if (!MEMO_LIMITS.keyRe.test(body.key)) {
        throw adminError(
          422,
          'MEMO_INVALID',
          'Ключ — латиница, цифры и дефис, 2–40 символов',
        );
      }
      data.key = body.key;
    }
    const done = await this.db
      .forAccount(m.accountId)
      .assistAdminMemo.updateMany({
        where: { id: r.id, draftRevision: body.expectedRevision },
        data,
      });
    if (done.count === 0) {
      throw adminError(
        409,
        'MEMO_REVISION',
        'Мемо изменили в другой вкладке — обновите',
      );
    }
    await this.memoLog(m, siteId, r, 'draft', {
      revision: body.expectedRevision + 1,
      steps: parsed.content.steps.length,
    });
    return this.get(m, siteId, n);
  }

  /** Собрать версию: ворота кода + проверка по живому каталогу (§5-бис.17 п.7). */
  async buildVersion(
    m: AccountMembership,
    siteId: string,
    n: number,
    opts: { rollbackOf?: number } = {},
  ) {
    await this.mode.requireSite(m.accountId, siteId);
    const r = await this.memoRow(m.accountId, siteId, n);
    const db = this.db.forAccount(m.accountId);
    let source: unknown = r.draft;
    if (opts.rollbackOf !== undefined) {
      const v = await db.assistAdminMemoVersion.findFirst({
        where: { memoId: r.id, number: opts.rollbackOf },
      });
      if (!v) throw adminError(404, 'MEMO_NOT_FOUND', 'Версия не найдена');
      source = v.content;
    }
    const parsed = parseAdminMemo(source);
    if (parsed.issues.length) throw this.invalid(parsed.issues);
    const catalog = await this.catalog(m.accountId, siteId);
    const content = markPii(parsed.content, catalog);
    const gate = adminMemoGates(content, catalog);
    const last = await db.assistAdminMemoVersion.findFirst({
      where: { memoId: r.id },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    const number = (last?.number ?? 0) + 1;
    const status = gate.result === 'pass' ? 'checking' : 'held';
    await db.assistAdminMemoVersion.create({
      data: {
        accountId: m.accountId,
        siteId,
        memoId: r.id,
        number,
        status,
        content: content as unknown as Prisma.InputJsonValue,
        contentHash: contentHash(content),
        gateReport: gate as unknown as Prisma.InputJsonValue,
        checkReport: { result: gate.result } as Prisma.InputJsonValue,
        rollbackOf: opts.rollbackOf ?? null,
        requestedBy: `tg:${m.telegramId.toString()}`,
      },
    });
    await db.assistAdminMemo.updateMany({
      where: { id: r.id },
      data: {
        status:
          r.publishedVersion === null
            ? status === 'held'
              ? 'held'
              : 'checking'
            : r.status,
      },
    });
    await this.memoLog(m, siteId, r, opts.rollbackOf ? 'rollback' : 'build', {
      version: number,
      result: gate.result,
    });
    return { version: number, status, gateReport: gate };
  }

  /** Публикация — подтверждение владельца в TMA; фразы — уникальный индекс. */
  async publish(m: AccountMembership, siteId: string, n: number, v: number) {
    await this.mode.requireSite(m.accountId, siteId);
    const r = await this.memoRow(m.accountId, siteId, n);
    const db = this.db.forAccount(m.accountId);
    const ver = await db.assistAdminMemoVersion.findFirst({
      where: { memoId: r.id, number: v },
    });
    if (!ver) throw adminError(404, 'MEMO_NOT_FOUND', 'Версия не найдена');
    if (ver.status !== 'checking') {
      throw adminError(
        409,
        'MEMO_INVALID',
        'Публикуется только версия, прошедшая проверку',
      );
    }
    const content = parseAdminMemo(ver.content).content;
    const phrases = adminMemoPhrases(content);
    const owner = `memo:${r.id}`;
    try {
      await db.$transaction(async (tx) => {
        await tx.assistAdminPhrase.deleteMany({ where: { siteId, owner } });
        await tx.assistAdminPhrase.createMany({
          data: phrases.map((p) => ({
            siteId,
            accountId: m.accountId,
            lang: p.lang,
            norm: p.norm,
            owner,
            kind: p.kind,
          })),
        });
        await tx.assistAdminMemoVersion.updateMany({
          where: { id: ver.id },
          data: {
            status: 'published',
            publishedBy: `tg:${m.telegramId.toString()}`,
            publishedAt: new Date(),
          },
        });
        await tx.assistAdminMemo.updateMany({
          where: { id: r.id },
          data: {
            status: 'published',
            publishedVersion: v,
            reviewReason: Prisma.DbNull,
          },
        });
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw adminError(
          409,
          'MEMO_CONFLICT',
          'Фраза мемо уже занята другим мемо этого сайта',
        );
      }
      throw e;
    }
    await this.memoLog(m, siteId, r, 'publish', { version: v });
    return this.get(m, siteId, n);
  }

  async setEnabled(
    m: AccountMembership,
    siteId: string,
    n: number,
    on: boolean,
  ) {
    await this.mode.requireSite(m.accountId, siteId);
    const r = await this.memoRow(m.accountId, siteId, n);
    const db = this.db.forAccount(m.accountId);
    if (on && r.publishedVersion === null) {
      throw adminError(409, 'MEMO_INVALID', 'Сначала опубликуйте версию');
    }
    await db.assistAdminMemo.updateMany({
      where: { id: r.id },
      data: { status: on ? 'published' : 'disabled' },
    });
    await this.memoLog(m, siteId, r, on ? 'enable' : 'disable');
    return this.get(m, siteId, n);
  }

  async remove(m: AccountMembership, siteId: string, n: number) {
    await this.mode.requireSite(m.accountId, siteId);
    const r = await this.memoRow(m.accountId, siteId, n);
    const db = this.db.forAccount(m.accountId);
    await db.$transaction(async (tx) => {
      await tx.assistAdminPhrase.deleteMany({
        where: { siteId, owner: `memo:${r.id}` },
      });
      await tx.assistAdminMemo.updateMany({
        where: { id: r.id },
        data: { status: 'removed', removedAt: new Date() },
      });
    });
    await this.memoLog(m, siteId, r, 'remove');
    return { removed: true };
  }

  // ── исполнение ─────────────────────────────────────────────────────────

  /** «АМ-N не найдено» — тот же ответ для несуществующего и выключенного. */
  unknownText(lang: string, n: number): string {
    const l = (['uk', 'ru', 'en'].includes(lang) ? lang : 'uk') as MemoLang;
    return MEMO_TEXT.unknownMemo[l](n);
  }

  /**
   * Команда сотрудника — мемо? По номеру АМ-N или фразе из индекса; только
   * опубликованное и включённое. null — не мемо (обычный ход).
   */
  async match(
    ctx: ActorCtx,
    text: string,
  ): Promise<
    | null
    | { kind: 'missing'; number: number }
    | { kind: 'memo'; memo: MemoRow; content: AdminMemoContent; rest: string }
  > {
    const db = this.db.forAccount(ctx.accountId);
    let memo: MemoRow | null = null;
    let rest = '';
    const byNum = memoNumberIn(text);
    if (byNum) {
      memo = await db.assistAdminMemo.findFirst({
        where: { siteId: ctx.siteId, number: byNum.number },
      });
      if (
        !memo ||
        memo.status !== 'published' ||
        memo.publishedVersion === null
      ) {
        return { kind: 'missing', number: byNum.number };
      }
      rest = byNum.rest;
    } else {
      const phrases = await db.assistAdminPhrase.findMany({
        where: { siteId: ctx.siteId },
        select: { norm: true, owner: true },
        take: 2000,
      });
      if (!phrases.length) return null;
      const index = new Map(phrases.map((p) => [p.norm, p.owner]));
      const hit = phrasePrefix(text, (n) => index.has(n));
      if (!hit) return null;
      const owner = index.get(hit.norm)!;
      memo = await db.assistAdminMemo.findFirst({
        where: { siteId: ctx.siteId, id: owner.replace(/^memo:/, '') },
      });
      if (
        !memo ||
        memo.status !== 'published' ||
        memo.publishedVersion === null
      )
        return null;
      rest = hit.rest;
    }
    const ver = await db.assistAdminMemoVersion.findFirst({
      where: { memoId: memo.id, number: memo.publishedVersion! },
    });
    if (!ver) return null;
    return {
      kind: 'memo',
      memo,
      content: parseAdminMemo(ver.content).content,
      rest,
    };
  }

  /**
   * Запустить мемо: права роли на каждую операцию — ДО первого шага
   * (§5-бис.17 п.10: мемо не расширяет права; приёмка Э8 п.7), слоты из
   * текста, затем шаги до первого «Да».
   */
  async start(
    ctx: ActorCtx,
    hit: { memo: MemoRow; content: AdminMemoContent; rest: string },
    now = new Date(),
    /** Э6-бис (б): запуск со страницы (голосовое управление) — шаги `ui` можно. */
    page = false,
  ): Promise<{
    text: string;
    proposal: ProposalView | null;
    ui?: { runId: string; from: number; to: number } | null;
  }> {
    const lang = ctx.lang as MemoLang;
    const n = hit.memo.number;
    const catalog = await this.catalog(ctx.accountId, ctx.siteId);
    for (const s of hit.content.steps) {
      if (s.action !== 'api') continue;
      const op = catalog.get(s.op);
      const allowed =
        !!op &&
        op.enabled &&
        !op.unsupported &&
        ctx.assistRole !== null &&
        (ctx.assistRole === '*' || op.roles.includes(ctx.assistRole));
      if (!allowed)
        return { text: MEMO_TEXT.forbidden[lang](n), proposal: null };
    }
    const { values, missing } = fillAdminSlots(
      hit.content.slots,
      hit.rest,
      now,
    );
    if (missing.length) {
      return {
        text: MEMO_TEXT.missing[lang](n, missing.join(', ')),
        proposal: null,
      };
    }
    const run = await this.db
      .forAccount(ctx.accountId)
      .assistAdminMemoRun.create({
        data: {
          accountId: ctx.accountId,
          siteId: ctx.siteId,
          memoId: hit.memo.id,
          memoNumber: n,
          memoVersion: hit.memo.publishedVersion!,
          conversationId: ctx.conversationId,
          actor: ctx.actor,
          channel: ctx.channel,
          slots: values as Prisma.InputJsonValue,
          expiresAt: new Date(now.getTime() + ACTION_LIMITS.memoRunTtlMs),
        },
      });
    const head = MEMO_TEXT.started[lang](n, adminMemoName(hit.content, lang));
    const r = await this.advance(ctx, run.id, hit.content, 0, now, page);
    return {
      text: `${head}\n\n${r.text}`,
      proposal: r.proposal,
      ui: r.ui ? { runId: run.id, ...r.ui } : null,
    };
  }

  /** Исполнять шаги с `from` до первого write/danger (предложение) или конца. */
  private async advance(
    ctx: ActorCtx,
    runId: string,
    content: AdminMemoContent,
    from: number,
    now: Date,
    page = false,
  ): Promise<{
    text: string;
    proposal: ProposalView | null;
    ui?: { from: number; to: number } | null;
  }> {
    const db = this.db.forAccount(ctx.accountId);
    const lang = ctx.lang as MemoLang;
    const run = await db.assistAdminMemoRun.findFirstOrThrow({
      where: { id: runId },
    });
    const slots = (run.slots ?? {}) as Record<string, string>;
    const progress = Array.isArray(run.progress)
      ? (run.progress as Array<{
          i: number;
          operation: string;
          outcome: string;
        }>)
      : [];
    const catalog = await this.catalog(ctx.accountId, ctx.siteId);
    const lines: string[] = [];
    const total = content.steps.length;
    const stop = async (i: number, goal: 'not_reached' | 'unknown') => {
      await db.assistAdminMemoRun.updateMany({
        where: { id: runId },
        data: {
          status: 'failed',
          step: i,
          goalStatus: goal,
          slots: Prisma.DbNull,
          progress: progress as unknown as Prisma.InputJsonValue,
        },
      });
      const done = progress
        .filter((p) => p.outcome === 'ok' || p.outcome === 'done')
        .map((p) => p.operation)
        .join(', ');
      lines.push(MEMO_TEXT.stopped[lang](run.memoNumber, i + 1, done));
      return { text: lines.join('\n'), proposal: null };
    };
    for (let i = from; i < total; i++) {
      const s = content.steps[i];
      if (s.action === 'say') {
        lines.push(s.say[lang] ?? s.say.uk ?? s.say.ru ?? s.say.en ?? '');
        continue;
      }
      if (s.action === 'ui') {
        // Э6-бис (б): шаги на странице — отрезком подряд; исполняет план
        // голосового управления в виджете (те же проверки кода). Без
        // страницы (TMA, чат без голосового управления) — честный стоп.
        if (!page) {
          lines.push(MEMO_TEXT.uiNeedsPage[lang](run.memoNumber));
          return stop(i, 'not_reached');
        }
        let to = i;
        while (to < total && content.steps[to].action === 'ui') to++;
        await db.assistAdminMemoRun.updateMany({
          where: { id: runId },
          data: {
            status: 'ui',
            step: i,
            progress: progress as unknown as Prisma.InputJsonValue,
          },
        });
        lines.push(MEMO_TEXT.uiNext[lang](i + 1, total));
        return {
          text: lines.filter(Boolean).join('\n'),
          proposal: null,
          ui: { from: i, to },
        };
      }
      const op = catalog.get(s.op);
      const allowed =
        !!op &&
        op.enabled &&
        ctx.assistRole !== null &&
        (ctx.assistRole === '*' || op.roles.includes(ctx.assistRole));
      if (!op || !allowed) {
        lines.push(MEMO_TEXT.forbidden[lang](run.memoNumber));
        return stop(i, 'not_reached');
      }
      const args = stepArgs(s, slots);
      if (op.kind === 'read') {
        const r = await this.connectors.runRead(ctx, op, args, now);
        progress.push({ i, operation: op.key, outcome: r.outcome });
        if (r.outcome !== 'ok') {
          lines.push(`${op.key}: ${MEMO_TEXT.readFailed[lang]}`);
          return stop(i, 'not_reached');
        }
        continue;
      }
      const actionOp = (
        await this.proposals.catalog(ctx.accountId, ctx.siteId, ctx.assistRole)
      ).find((a) => a.rowId === op.rowId);
      if (!actionOp) {
        lines.push(MEMO_TEXT.forbidden[lang](run.memoNumber));
        return stop(i, 'not_reached');
      }
      const p = await this.proposals.propose(
        ctx,
        actionOp,
        args,
        '',
        {
          requested: true,
          memoRunId: runId,
          memoStep: i,
        },
        now,
      );
      if (!p.ok) {
        lines.push(p.text);
        return stop(i, 'not_reached');
      }
      await db.assistAdminMemoRun.updateMany({
        where: { id: runId },
        data: {
          status: 'waiting',
          step: i,
          progress: progress as unknown as Prisma.InputJsonValue,
        },
      });
      lines.push(MEMO_TEXT.step[lang](i + 1, total), p.text);
      return { text: lines.filter(Boolean).join('\n'), proposal: p.proposal };
    }
    await db.assistAdminMemoRun.updateMany({
      where: { id: runId },
      data: {
        status: 'done',
        step: total,
        goalStatus: 'reached',
        slots: Prisma.DbNull,
        progress: progress as unknown as Prisma.InputJsonValue,
      },
    });
    const goal = content.goal.text[lang] ?? content.goal.text.uk ?? '';
    lines.push(MEMO_TEXT.done[lang](run.memoNumber, goal));
    return { text: lines.filter(Boolean).join('\n'), proposal: null };
  }

  /** Итог шага write/danger (подписка ProposalsService.onSettled). */
  async afterStep(
    ctx: ActorCtx,
    runId: string,
    step: number,
    status: 'done' | 'failed' | 'unknown' | 'rejected' | 'expired',
    now = new Date(),
  ): Promise<{ next: ProposalView | null; text: string | null }> {
    const db = this.db.forAccount(ctx.accountId);
    const run = await db.assistAdminMemoRun.findFirst({
      where: { id: runId, siteId: ctx.siteId, actor: ctx.actor },
    });
    if (!run || run.status !== 'waiting' || run.step !== step) {
      return { next: null, text: null };
    }
    const ver = await db.assistAdminMemoVersion.findFirst({
      where: { memoId: run.memoId, number: run.memoVersion },
    });
    if (!ver) return { next: null, text: null };
    const content = parseAdminMemo(ver.content).content;
    const progress = Array.isArray(run.progress)
      ? (run.progress as Array<{
          i: number;
          operation: string;
          outcome: string;
        }>)
      : [];
    const s = content.steps[step];
    progress.push({
      i: step,
      operation: s && s.action === 'api' ? s.opKey : '',
      outcome: status,
    });
    await db.assistAdminMemoRun.updateMany({
      where: { id: runId },
      data: {
        progress: progress as unknown as Prisma.InputJsonValue,
        status: 'running',
      },
    });
    if (status !== 'done') {
      const done = progress
        .filter((p) => p.outcome === 'ok' || p.outcome === 'done')
        .map((p) => p.operation)
        .join(', ');
      await db.assistAdminMemoRun.updateMany({
        where: { id: runId },
        data: {
          status: status === 'rejected' ? 'stopped' : 'failed',
          goalStatus: status === 'unknown' ? 'unknown' : 'not_reached',
          slots: Prisma.DbNull,
        },
      });
      return {
        next: null,
        text: MEMO_TEXT.stopped[ctx.lang as MemoLang](
          run.memoNumber,
          step + 1,
          done,
        ),
      };
    }
    if (run.expiresAt.getTime() <= now.getTime()) {
      await db.assistAdminMemoRun.updateMany({
        where: { id: runId },
        data: {
          status: 'expired',
          slots: Prisma.DbNull,
          goalStatus: 'not_reached',
        },
      });
      return { next: null, text: null };
    }
    const r = await this.advance(
      ctx,
      runId,
      content,
      step + 1,
      now,
      ctx.channel === 'embed',
    );
    return { next: r.proposal, text: r.text };
  }

  // ── Э6-бис (б): шаги на странице ───────────────────────────────────────

  /** Запуск этого сотрудника, ждущий шагов на странице (статус `ui`). */
  async pendingUi(ctx: ActorCtx, now = new Date()): Promise<string | null> {
    const run = await this.db
      .forAccount(ctx.accountId)
      .assistAdminMemoRun.findFirst({
        where: {
          siteId: ctx.siteId,
          actor: ctx.actor,
          status: 'ui',
          expiresAt: { gt: now },
        },
        orderBy: { updatedAt: 'desc' },
        select: { id: true },
      });
    return run?.id ?? null;
  }

  /**
   * Отрезок шагов `ui`, который ждёт запуск ЭТОГО сотрудника: версия
   * закреплена в запуске; права роли перепроверены в `start`.
   */
  async uiSegment(
    ctx: ActorCtx,
    runId: string,
    now = new Date(),
  ): Promise<MemoUiSegment | null> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) return null;
    const db = this.db.forAccount(ctx.accountId);
    const run = await db.assistAdminMemoRun.findFirst({
      where: { id: runId, siteId: ctx.siteId, actor: ctx.actor },
    });
    if (!run || run.status !== 'ui' || run.expiresAt.getTime() <= now.getTime())
      return null;
    const ver = await db.assistAdminMemoVersion.findFirst({
      where: { memoId: run.memoId, number: run.memoVersion },
    });
    if (!ver) return null;
    const content = parseAdminMemo(ver.content).content;
    let to = run.step;
    while (to < content.steps.length && content.steps[to].action === 'ui') to++;
    const steps = content.steps
      .slice(run.step, to)
      .filter((x): x is AdminMemoUiStep => x.action === 'ui');
    if (!steps.length) return null;
    return {
      runId: run.id,
      memoNumber: run.memoNumber,
      name: adminMemoName(content, ctx.lang as MemoLang),
      from: run.step,
      to,
      steps,
      slots: (run.slots ?? {}) as Record<string, string>,
    };
  }

  /**
   * Итог отрезка шагов на странице (план голосового управления закончился):
   * `done` — запуск продолжается со следующего шага (предложение API,
   * следующий отрезок или «выполнено»); иначе — стоп с перечнем сделанного.
   */
  async afterUi(
    ctx: ActorCtx,
    runId: string,
    from: number,
    to: number,
    status: 'done' | 'failed' | 'stopped',
    now = new Date(),
  ): Promise<{
    text: string | null;
    proposal: ProposalView | null;
    nextUi: boolean;
  }> {
    const db = this.db.forAccount(ctx.accountId);
    const run = await db.assistAdminMemoRun.findFirst({
      where: { id: runId, siteId: ctx.siteId, actor: ctx.actor },
    });
    if (!run || run.status !== 'ui' || run.step !== from)
      return { text: null, proposal: null, nextUi: false };
    const ver = await db.assistAdminMemoVersion.findFirst({
      where: { memoId: run.memoId, number: run.memoVersion },
    });
    if (!ver) return { text: null, proposal: null, nextUi: false };
    const content = parseAdminMemo(ver.content).content;
    const progress = Array.isArray(run.progress)
      ? (run.progress as Array<{
          i: number;
          operation: string;
          outcome: string;
        }>)
      : [];
    for (let i = from; i < to; i++)
      progress.push({
        i,
        operation: 'ui',
        outcome: status === 'done' ? 'done' : status,
      });
    if (status !== 'done' || run.expiresAt.getTime() <= now.getTime()) {
      await db.assistAdminMemoRun.updateMany({
        where: { id: runId, status: 'ui' },
        data: {
          status: status === 'stopped' ? 'stopped' : 'failed',
          goalStatus: 'not_reached',
          slots: Prisma.DbNull,
          progress: progress as unknown as Prisma.InputJsonValue,
        },
      });
      const done = progress
        .filter((p) => p.outcome === 'ok' || p.outcome === 'done')
        .map((p) => p.operation)
        .join(', ');
      return {
        text: MEMO_TEXT.stopped[ctx.lang as MemoLang](
          run.memoNumber,
          from + 1,
          done,
        ),
        proposal: null,
        nextUi: false,
      };
    }
    const moved = await db.assistAdminMemoRun.updateMany({
      where: { id: runId, status: 'ui', step: from },
      data: {
        status: 'running',
        progress: progress as unknown as Prisma.InputJsonValue,
      },
    });
    if (moved.count !== 1) return { text: null, proposal: null, nextUi: false };
    const r = await this.advance(ctx, runId, content, to, now, true);
    return { text: r.text, proposal: r.proposal, nextUi: !!r.ui };
  }
}
