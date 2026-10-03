/**
 * Кабинет: мемо «Сайта» (Э6-бис (е), ТЗ помощника §5-бис.17 п.2–4, п.6–9,
 * п.12–14; Р-61, Р-62; решения владельца Р-68…Р-72). Экран — «Голос →
 * Мемо» (assist/src/screens/widget/MemoSection.tsx).
 *
 *  - номер `М-N` — из `assist_sites.memoCounter` (не переиспользуется), ключ
 *    `[a-z0-9-]{2,40}` неизменен после первой публикации, имя уникально в
 *    сайте по нормализованной форме в языке;
 *  - черновик — операциями с `expectedRevision` (409 «мемо изменили в
 *    другой вкладке»), каждая операция — строка истории;
 *  - версия: сборка → ворота кода (`memoGates`; `held`) → сухой прогон
 *    мастером в браузере владельца (ссылка `check-token`, отчёт `kind =
 *    memo`) → публикация человеком (здесь, в TMA); индекс фраз сайта —
 *    уникальный ключ ловит гонку; откат — новая версия с новым прогоном;
 *  - «сохранить как мемо» из удачного плана (значения не переносятся) и
 *    кандидаты из боя (≥ 3 разных посетителей и хешей IP за 7 дней, В-73);
 *  - выключение — сразу (безопасно), удаление — мягкое, номер не
 *    освобождается; лимиты — по тарифу (В-71).
 * Каждый маршрут ищет мемо по (siteId из пути, номер) после проверки прав
 * на сайт; чужой сайт и несуществующее мемо — один и тот же 404.
 * Основная роль (SitesDb.forAccount — кабинет владельца).
 */
import { createHash, randomBytes } from 'crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WIDGET_VOICE_TEST_PARAM } from '../../../brand';
import { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import { readState } from '../../assist-billing/public/entitlements';
import {
  hostOriginOf,
  loadAssistSite,
} from '../../assist-site-setup/widget-settings.service';
import { MEMO_DECISIONS } from '../../assist-ui-core/decisions';
import {
  emptyMemoContent,
  MEMO_LANGS,
  MEMO_LIMITS,
  memoFromPlan,
  memoGates,
  memoPhrases,
  memoTextProblem,
  parseMemoContent,
  phraseNorm,
  planSignature,
  suggestMemoKey,
  type MemoContent,
  type MemoGateReport,
  type MemoLang,
  type MemoOrigin,
  type MemoStatus,
  type MemoView,
  type PlanStepLike,
} from '../../assist-ui-core/memo';
import { defaultVoiceControlRules, rulesOf } from '../../assist-ui-core/rules';
import type { AccountMembership } from '../../site-core/account/roles';
import { evaluateHostAccess } from '../../site-core/ownership/host-access';
import type {
  MemoChangeView,
  MemoCheckReport,
  MemoCheckTokenView,
  MemoCreateRequest,
  MemoDetailView,
  MemoDraftOp,
  MemoDraftPatch,
  MemoListView,
  MemoStatsView,
  MemoSuggestionView,
  MemoSummary,
  MemoVersionView,
} from '../api-types';
import { sha256Hex } from '../public/voice-test-store';
import { voiceControlError } from './voice-control-errors';

const DAY = 24 * 60 * 60_000;

type Db = ReturnType<SitesDb['forAccount']>;

interface MemoRow {
  id: string;
  accountId: string;
  siteId: string;
  number: number;
  key: string;
  status: string;
  publishedVersion: number | null;
  draftRevision: number;
  draft: unknown;
  listed: boolean;
  view: string;
  staleViews: string[];
  origin: string;
  reviewReason: unknown;
  updatedAt: Date;
}

const notFound = () =>
  voiceControlError(HttpStatus.NOT_FOUND, 'MEMO_NOT_FOUND', 'Мемо не найдено');

const invalid = (
  errors: Array<{ path: string; code: string }>,
  message = 'Мемо не прошло проверку',
) =>
  voiceControlError(HttpStatus.UNPROCESSABLE_ENTITY, 'MEMO_INVALID', message, {
    errors,
  });

/** Хеш содержимого версии — сверка «прогнали ту же версию». */
export function memoContentHash(c: unknown): string {
  return createHash('sha256').update(JSON.stringify(c)).digest('base64url');
}

const nameOf = (c: MemoContent, lang: MemoLang = 'uk'): string | null =>
  c.names[lang] ?? MEMO_LANGS.map((l) => c.names[l]).find(Boolean) ?? null;

@Injectable()
export class MemoService {
  private readonly logger = new Logger(MemoService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly prisma: PrismaService,
  ) {}

  private db(m: AccountMembership): Db {
    return this.sitesDb.forAccount(m.accountId);
  }

  // ── общее ──────────────────────────────────────────────────────────────

  private async site(m: AccountMembership, siteId: string) {
    const { row } = await loadAssistSite(this.db(m), m.accountId, siteId);
    return row;
  }

  private async memo(
    m: AccountMembership,
    siteId: string,
    n: string | number,
  ): Promise<MemoRow> {
    await this.site(m, siteId);
    const num = typeof n === 'number' ? n : Number(n);
    if (!Number.isInteger(num) || num < 1 || num > 1_000_000) throw notFound();
    const row = (await this.db(m).assistSiteMemo.findFirst({
      where: { siteId, number: num, status: { not: 'removed' } },
    })) as MemoRow | null;
    if (!row) throw notFound();
    return row;
  }

  private async limit(m: AccountMembership): Promise<number> {
    const state = await readState(this.prisma, m.accountId, this.now());
    return state.planId ? MEMO_DECISIONS.limitByPlan[state.planId] : 0;
  }

  private async rulesHost(m: AccountMembership, siteId: string) {
    const row = await this.site(m, siteId);
    const rules =
      rulesOf(row.voiceControlSiteRules) ?? defaultVoiceControlRules();
    const h = await this.db(m).siteHost.findFirst({
      where: { siteId, status: 'verified' },
      orderBy: { createdAt: 'asc' },
      select: { host: true },
    });
    return { rules, host: h?.host ?? 'example.invalid' };
  }

  /** Фразы сайта, занятые ДРУГИМИ сущностями (индекс фраз), `lang:norm`. */
  private async takenPhrases(
    db: Db,
    siteId: string,
    memoId: string,
  ): Promise<Set<string>> {
    const rows = await db.assistSitePhrase.findMany({
      where: { siteId, owner: { not: `memo:${memoId}` } },
      select: { lang: true, norm: true },
    });
    return new Set(rows.map((r) => `${r.lang}:${r.norm}`));
  }

  private gates(
    c: MemoContent,
    ctx: { rules: ReturnType<typeof defaultVoiceControlRules>; host: string },
    taken?: Set<string>,
  ): MemoGateReport {
    return memoGates(c, { rules: ctx.rules, host: ctx.host, taken });
  }

  /** Имя занято другим мемо сайта (нормализованная форма, в пределах языка). */
  private async nameTaken(
    db: Db,
    siteId: string,
    memoId: string | null,
    c: MemoContent,
  ): Promise<string | null> {
    const others = await db.assistSiteMemo.findMany({
      where: {
        siteId,
        status: { not: 'removed' },
        ...(memoId ? { id: { not: memoId } } : {}),
      },
      select: { draft: true },
    });
    for (const lang of MEMO_LANGS) {
      const mine = c.names[lang];
      if (!mine) continue;
      const norm = phraseNorm(mine);
      for (const o of others) {
        const n = parseMemoContent(o.draft).content.names[lang];
        if (n && phraseNorm(n) === norm) return `names.${lang}`;
      }
    }
    return null;
  }

  private async change(
    db: Db,
    m: AccountMembership,
    memo: { id: string; siteId: string },
    revision: number,
    source: string,
    op: unknown,
  ): Promise<void> {
    await db.assistSiteMemoChange.create({
      data: {
        accountId: m.accountId,
        siteId: memo.siteId,
        memoId: memo.id,
        revision,
        actor: m.memberId,
        source,
        op: op as Prisma.InputJsonValue,
      },
    });
  }

  private async goalRates(
    db: Db,
    siteId: string,
    since: Date,
  ): Promise<
    Map<string, { runs: number; reached: number; last: Date | null }>
  > {
    const rows = await db.assistSiteUiPlan.findMany({
      where: {
        siteId,
        memoId: { not: null },
        voiceTestId: null,
        createdAt: { gte: since },
      },
      select: { memoId: true, goalStatus: true, createdAt: true },
      take: 20_000,
    });
    const out = new Map<
      string,
      { runs: number; reached: number; last: Date | null }
    >();
    for (const r of rows) {
      if (!r.memoId) continue;
      const a = out.get(r.memoId) ?? { runs: 0, reached: 0, last: null };
      a.runs++;
      if (r.goalStatus === 'reached') a.reached++;
      if (!a.last || r.createdAt > a.last) a.last = r.createdAt;
      out.set(r.memoId, a);
    }
    return out;
  }

  private summary(
    row: MemoRow,
    stat: { runs: number; reached: number; last: Date | null } | undefined,
  ): MemoSummary {
    const c = parseMemoContent(row.draft).content;
    return {
      number: row.number,
      key: row.key,
      status: row.status as MemoStatus,
      name: nameOf(c),
      view: (row.view as MemoView) ?? 'any',
      listed: row.listed,
      origin: row.origin as MemoOrigin,
      publishedVersion: row.publishedVersion,
      staleViews: row.staleViews ?? [],
      runs30: stat?.runs ?? 0,
      reached30: stat?.reached ?? 0,
      lastRunAt: stat?.last?.toISOString() ?? null,
      reviewReason: row.reviewReason ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // ── список, создание ───────────────────────────────────────────────────

  async list(m: AccountMembership, siteId: string): Promise<MemoListView> {
    await this.site(m, siteId);
    const db = this.db(m);
    const rows = (await db.assistSiteMemo.findMany({
      where: { siteId, status: { not: 'removed' } },
      orderBy: { number: 'asc' },
    })) as MemoRow[];
    const rates = await this.goalRates(
      db,
      siteId,
      new Date(this.now().getTime() - 30 * DAY),
    );
    const candidates = MEMO_DECISIONS.candidates
      ? (await this.suggestions(m, siteId)).length
      : 0;
    return {
      items: rows.map((r) => this.summary(r, rates.get(r.id))),
      used: rows.length,
      limit: await this.limit(m),
      candidates,
    };
  }

  /** Новый черновик: номер из счётчика сайта, ключ из имени (свободный). */
  private async insertMemo(
    m: AccountMembership,
    siteId: string,
    p: {
      content: MemoContent;
      origin: MemoOrigin;
      key?: string | null;
      source: string;
      op: unknown;
    },
  ): Promise<MemoRow> {
    const db = this.db(m);
    const used = await db.assistSiteMemo.count({
      where: { siteId, status: { not: 'removed' } },
    });
    const limit = await this.limit(m);
    if (used >= limit)
      throw voiceControlError(
        HttpStatus.PAYMENT_REQUIRED,
        'MEMO_LIMIT',
        `Мемо на этом тарифе — не больше ${limit}`,
      );
    const taken = await this.nameTaken(db, siteId, null, p.content);
    if (taken)
      throw voiceControlError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'MEMO_NAME_TAKEN',
        'Мемо с таким именем уже есть',
        { errors: [{ path: taken, code: 'taken' }] },
      );
    let key = p.key ?? suggestMemoKey(nameOf(p.content) ?? 'memo');
    if (!MEMO_LIMITS.keyRe.test(key))
      throw invalid([{ path: 'key', code: 'format' }]);
    const busy = new Set(
      (
        await db.assistSiteMemo.findMany({
          where: { siteId, key: { startsWith: key.slice(0, 30) } },
          select: { key: true },
        })
      ).map((r) => r.key),
    );
    if (busy.has(key)) {
      if (p.key)
        throw voiceControlError(
          HttpStatus.CONFLICT,
          'MEMO_CONFLICT',
          'Ключ уже занят',
          { errors: [{ path: 'key', code: 'taken' }] },
        );
      let n = 2;
      while (busy.has(`${key.slice(0, 36)}-${n}`)) n++;
      key = `${key.slice(0, 36)}-${n}`;
    }
    const row = await db.$transaction(async (tx) => {
      // Номер — из счётчика сайта атомарно; удалённый номер не вернётся.
      const site = await tx.assistSite.update({
        where: { siteId },
        data: { memoCounter: { increment: 1 } },
        select: { memoCounter: true },
      });
      return tx.assistSiteMemo.create({
        data: {
          accountId: m.accountId,
          siteId,
          number: site.memoCounter,
          key,
          status: 'draft',
          draft: p.content as unknown as Prisma.InputJsonValue,
          listed: MEMO_DECISIONS.listedByDefault,
          view: p.content.view,
          origin: p.origin,
          createdBy: m.memberId,
          updatedBy: m.memberId,
        },
      });
    });
    await this.change(db, m, row, 0, p.source, p.op);
    this.logger.log(
      `memo create site=${siteId} memo=${row.number} origin=${p.origin} member=${m.memberId}`,
    );
    return row as MemoRow;
  }

  async create(
    m: AccountMembership,
    siteId: string,
    body: MemoCreateRequest | null | undefined,
  ): Promise<MemoDetailView> {
    await this.site(m, siteId);
    const lang: MemoLang =
      body?.lang === 'ru' || body?.lang === 'en' ? body.lang : 'uk';
    const parsed = parseMemoContent(body?.draft ?? emptyMemoContent());
    if (parsed.issues.length) throw invalid(parsed.issues);
    const content = parsed.content;
    if (typeof body?.name === 'string') {
      const t = body.name.replace(/\s+/g, ' ').trim();
      const p = memoTextProblem(t, MEMO_LIMITS.nameChars);
      if (p) throw invalid([{ path: 'name', code: p }]);
      content.names[lang] = t;
    }
    if (!nameOf(content)) throw invalid([{ path: 'name', code: 'empty' }]);
    if (body?.key !== undefined && typeof body.key !== 'string')
      throw invalid([{ path: 'key', code: 'type' }]);
    const row = await this.insertMemo(m, siteId, {
      content,
      origin: 'manual',
      key: body?.key ?? null,
      source: 'tma',
      op: { op: 'create', origin: 'manual' },
    });
    return this.get(m, siteId, row.number);
  }

  /**
   * «Сохранить как мемо» из удачного плана ЭТОГО сайта (§5-бис.17 п.6):
   * `done`, все исполнимые шаги `done`, не мемо, не сухой прогон. Значения
   * не переносятся; фраза — замаскированная команда, только предложением.
   */
  async saveAsMemo(
    m: AccountMembership,
    siteId: string,
    planId: string,
    origin: 'plan' | 'suggestion' = 'plan',
  ): Promise<MemoDetailView> {
    await this.site(m, siteId);
    const db = this.db(m);
    const plan = /^[A-Za-z0-9_-]{1,64}$/.test(planId)
      ? await db.assistSiteUiPlan.findFirst({
          where: { id: planId, siteId },
          select: {
            status: true,
            steps: true,
            pageUrl: true,
            utteranceMasked: true,
            lang: true,
            planOrigin: true,
            dryRun: true,
          },
        })
      : null;
    if (!plan) throw notFound();
    const steps = (Array.isArray(plan.steps)
      ? plan.steps
      : []) as unknown as PlanStepLike[];
    const exec = steps.filter(
      (s) =>
        (s as { risk?: string }).risk === 'auto' ||
        (s as { risk?: string }).risk === 'confirm',
    );
    if (
      plan.status !== 'done' ||
      plan.dryRun ||
      plan.planOrigin === 'memo' ||
      !exec.length ||
      exec.some((s) => s.state !== 'done')
    )
      throw voiceControlError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'MEMO_PLAN_NOT_ELIGIBLE',
        'Сохранить как мемо можно только план, выполненный до конца',
      );
    const lang: MemoLang =
      plan.lang === 'ru' || plan.lang === 'en' ? plan.lang : 'uk';
    const content = memoFromPlan({
      steps,
      pageUrl: plan.pageUrl,
      utteranceMasked: plan.utteranceMasked,
      lang,
    });
    // Имя — черновое из замаскированной команды (владелец переименует);
    // без ПД и без запрещённых знаков, иначе «Мемо N».
    const draftName = plan.utteranceMasked
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    content.names[lang] = memoTextProblem(draftName, MEMO_LIMITS.nameChars)
      ? `Memo ${new Date().toISOString().slice(0, 10)}`
      : draftName;
    // Имя занято — уникальный хвост (имя всё равно правит человек).
    if (await this.nameTaken(db, siteId, null, content))
      content.names[lang] =
        `${content.names[lang]?.slice(0, 50)} ${randomBytes(2).toString('hex')}`;
    const row = await this.insertMemo(m, siteId, {
      content,
      origin,
      source: origin === 'suggestion' ? 'suggestion' : 'plan',
      op: { op: 'create', origin, planId },
    });
    return this.get(m, siteId, row.number);
  }

  /**
   * Кандидаты из боя (В-73, Р-71): удачные планы (не мемо, не тестовые) с
   * одной и той же подписью (страница + цели) у ≥ 3 разных посетителей И
   * ≥ 3 разных хешей IP за 7 дней. Фразы — только замаскированные
   * команды, только предложением.
   */
  async suggestions(
    m: AccountMembership,
    siteId: string,
  ): Promise<MemoSuggestionView[]> {
    if (!MEMO_DECISIONS.candidates) return [];
    await this.site(m, siteId);
    const db = this.db(m);
    const since = new Date(
      this.now().getTime() - MEMO_DECISIONS.candidateWindowMs,
    );
    const plans = await db.assistSiteUiPlan.findMany({
      where: {
        siteId,
        status: 'done',
        dryRun: false,
        voiceTestId: null,
        planOrigin: { not: 'memo' },
        createdAt: { gte: since },
      },
      select: {
        id: true,
        visitorId: true,
        steps: true,
        pageUrl: true,
        utteranceMasked: true,
        conversation: { select: { ipHash: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 2_000,
    });
    // Уже сохранённые как мемо подписи — не предлагаем.
    const memos = await db.assistSiteMemo.findMany({
      where: { siteId, status: { not: 'removed' } },
      select: { draft: true },
    });
    const known = new Set(
      memos
        .map((x) => {
          const c = parseMemoContent(x.draft).content;
          return planSignature({
            pageUrl: `https://x${c.steps[0]?.page ?? '/'}`,
            steps: c.steps.map((s) => ({
              kind: s.action,
              target: s.target
                ? {
                    assistId: s.target.pin.assistId,
                    role: s.target.pin.role,
                    text: s.target.pin.text,
                    href: s.target.pin.href,
                  }
                : null,
              value: null,
              expect: null,
              nav: false,
            })),
          });
        })
        .filter((x): x is string => !!x),
    );
    const groups = new Map<
      string,
      {
        planId: string;
        page: string;
        steps: PlanStepLike[];
        visitors: Set<string>;
        ips: Set<string>;
        phrases: Set<string>;
      }
    >();
    for (const p of plans) {
      const steps = (Array.isArray(p.steps)
        ? p.steps
        : []) as unknown as PlanStepLike[];
      const sig = planSignature({ pageUrl: p.pageUrl, steps });
      if (!sig || known.has(sig)) continue;
      const g = groups.get(sig) ?? {
        planId: p.id,
        page: sig.split('|')[0],
        steps,
        visitors: new Set<string>(),
        ips: new Set<string>(),
        phrases: new Set<string>(),
      };
      g.visitors.add(p.visitorId);
      if (p.conversation?.ipHash) g.ips.add(p.conversation.ipHash);
      if (g.phrases.size < 5 && !memoTextProblem(p.utteranceMasked, 120))
        g.phrases.add(p.utteranceMasked);
      groups.set(sig, g);
    }
    const min = MEMO_DECISIONS.candidateMinVisitors;
    return [...groups.entries()]
      .filter(([, g]) => g.visitors.size >= min && g.ips.size >= min)
      .sort((a, b) => b[1].visitors.size - a[1].visitors.size)
      .slice(0, 20)
      .map(([signature, g]) => ({
        signature,
        planId: g.planId,
        page: g.page,
        steps: g.steps
          .filter((s) => s.target && s.kind !== 'wait' && s.kind !== 'say')
          .map((s) => ({ kind: s.kind, text: s.target?.text ?? '' })),
        visitors: g.visitors.size,
        phrases: [...g.phrases],
      }));
  }

  // ── карточка и черновик ────────────────────────────────────────────────

  private versionView(
    v: {
      number: number;
      status: string;
      contentHash: string;
      gateReport: unknown;
      checkReport: unknown;
      rollbackOf: number | null;
      requestedBy: string;
      publishedBy: string | null;
      createdAt: Date;
      publishedAt: Date | null;
      content?: unknown;
    },
    withContent = false,
  ): MemoVersionView {
    return {
      number: v.number,
      status: v.status as MemoVersionView['status'],
      contentHash: v.contentHash,
      gateReport: (v.gateReport ?? null) as MemoVersionView['gateReport'],
      checkReport: (v.checkReport ?? null) as MemoCheckReport | null,
      rollbackOf: v.rollbackOf,
      requestedBy: v.requestedBy,
      publishedBy: v.publishedBy,
      createdAt: v.createdAt.toISOString(),
      publishedAt: v.publishedAt?.toISOString() ?? null,
      ...(withContent && v.content
        ? { content: parseMemoContent(v.content).content }
        : {}),
    };
  }

  async get(
    m: AccountMembership,
    siteId: string,
    n: string | number,
  ): Promise<MemoDetailView> {
    const row = await this.memo(m, siteId, n);
    const db = this.db(m);
    const draft = parseMemoContent(row.draft).content;
    const ctx = await this.rulesHost(m, siteId);
    const [versions, rates] = await Promise.all([
      db.assistSiteMemoVersion.findMany({
        where: { memoId: row.id },
        orderBy: { number: 'desc' },
        take: MEMO_LIMITS.versionsKept,
      }),
      this.goalRates(db, siteId, new Date(this.now().getTime() - 30 * DAY)),
    ]);
    // Сухой прогон в TMA виден у версии, когда отчёт сдан.
    const withReports = await Promise.all(
      versions.map(async (v) => ({
        ...v,
        checkReport: v.checkReport ?? (await this.checkReportOf(db, v)),
      })),
    );
    return {
      ...this.summary(row, rates.get(row.id)),
      draft,
      draftRevision: row.draftRevision,
      gates: this.gates(
        draft,
        ctx,
        await this.takenPhrases(db, siteId, row.id),
      ),
      versions: withReports.map((v) => this.versionView(v)),
    };
  }

  /** Отчёт сухого прогона версии (тест мастера `kind = memo`). */
  private async checkReportOf(
    db: Db,
    v: { checkId: string | null; contentHash: string },
  ): Promise<MemoCheckReport | null> {
    if (!v.checkId) return null;
    const t = await db.assistSiteVoiceTest.findFirst({
      where: { id: v.checkId, kind: 'memo' },
      select: { report: true, reportedAt: true, validUntil: true },
    });
    const r = t?.report as MemoCheckReport | null | undefined;
    if (!r || r.kind !== 'memo' || r.contentHash !== v.contentHash) return null;
    return r;
  }

  /**
   * Операции над черновиком: `expectedRevision` — 409 при расхождении
   * (другая вкладка/редактор); разбор строгий (422 с путями); риск ниже
   * расчёта кода — 422 `MEMO_RISK_LOWERING_FORBIDDEN`; ключ после первой
   * публикации — 422 `MEMO_KEY_LOCKED`; имя занято — 422.
   */
  async patchDraft(
    m: AccountMembership,
    siteId: string,
    n: string,
    body: MemoDraftPatch | null | undefined,
  ): Promise<MemoDetailView> {
    const row = await this.memo(m, siteId, n);
    const db = this.db(m);
    if (
      !body ||
      typeof body.expectedRevision !== 'number' ||
      !Array.isArray(body.ops) ||
      !body.ops.length ||
      body.ops.length > 50
    )
      throw invalid([{ path: 'ops', code: 'type' }]);
    if (body.expectedRevision !== row.draftRevision)
      throw voiceControlError(
        HttpStatus.CONFLICT,
        'MEMO_CONFLICT',
        'Мемо изменили в другой вкладке — обновите',
      );
    const raw = JSON.parse(JSON.stringify(row.draft ?? {})) as Record<
      string,
      unknown
    >;
    let listed = row.listed;
    let key = row.key;
    for (const op of body.ops as MemoDraftOp[]) {
      if (!op || typeof op !== 'object')
        throw invalid([{ path: 'ops', code: 'type' }]);
      switch (op.op) {
        case 'set':
          if (
            ![
              'names',
              'triggers',
              'goal',
              'slots',
              'steps',
              'view',
              'suggested',
            ].includes(op.field)
          )
            throw invalid([{ path: 'ops.field', code: 'enum' }]);
          raw[op.field] = op.value;
          break;
        case 'acceptSuggested': {
          const sug = (raw.suggested ?? {}) as Record<string, string[]>;
          const list = Array.isArray(sug[op.lang]) ? sug[op.lang] : [];
          if (!list.includes(op.phrase))
            throw invalid([{ path: 'ops.phrase', code: 'not_suggested' }]);
          const tr = (raw.triggers ?? {}) as Record<string, string[]>;
          tr[op.lang] = [...(tr[op.lang] ?? []), op.phrase];
          raw.triggers = tr;
          sug[op.lang] = list.filter((x) => x !== op.phrase);
          raw.suggested = sug;
          break;
        }
        case 'removeStep': {
          const st = Array.isArray(raw.steps) ? raw.steps : [];
          if (
            !Number.isInteger(op.index) ||
            op.index < 0 ||
            op.index >= st.length
          )
            throw invalid([{ path: 'ops.index', code: 'range' }]);
          st.splice(op.index, 1);
          raw.steps = st;
          break;
        }
        case 'moveStep': {
          const st = Array.isArray(raw.steps) ? raw.steps : [];
          if (
            !Number.isInteger(op.from) ||
            !Number.isInteger(op.to) ||
            op.from < 0 ||
            op.to < 0 ||
            op.from >= st.length ||
            op.to >= st.length
          )
            throw invalid([{ path: 'ops.from', code: 'range' }]);
          const [x] = st.splice(op.from, 1);
          st.splice(op.to, 0, x);
          raw.steps = st;
          break;
        }
        case 'listed':
          listed = op.value === true;
          break;
        case 'key':
          if (row.publishedVersion !== null)
            throw voiceControlError(
              HttpStatus.UNPROCESSABLE_ENTITY,
              'MEMO_KEY_LOCKED',
              'Ключ мемо не меняется после первой публикации',
            );
          if (typeof op.value !== 'string' || !MEMO_LIMITS.keyRe.test(op.value))
            throw invalid([{ path: 'key', code: 'format' }]);
          key = op.value;
          break;
        default:
          throw invalid([{ path: 'ops.op', code: 'enum' }]);
      }
    }
    const parsed = parseMemoContent(raw);
    if (parsed.issues.length) throw invalid(parsed.issues);
    const content = parsed.content;
    const taken = await this.nameTaken(db, siteId, row.id, content);
    if (taken)
      throw voiceControlError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'MEMO_NAME_TAKEN',
        'Мемо с таким именем уже есть',
        { errors: [{ path: taken, code: 'taken' }] },
      );
    const ctx = await this.rulesHost(m, siteId);
    const g = this.gates(content, ctx);
    const lowering = g.problems.filter(
      (p) => p.code === 'risk_lowering_forbidden',
    );
    if (lowering.length)
      throw voiceControlError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'MEMO_RISK_LOWERING_FORBIDDEN',
        'Класс риска можно только ужесточить',
        { errors: lowering.map((p) => ({ path: p.path, code: p.code })) },
      );
    const constPii = g.problems.filter((p) => p.code === 'const_in_pii');
    if (constPii.length)
      throw invalid(
        constPii.map((p) => ({ path: p.path, code: p.code })),
        'Константа в поле персональных данных запрещена',
      );
    if (key !== row.key) {
      const busy = await db.assistSiteMemo.findFirst({
        where: { siteId, key, id: { not: row.id } },
        select: { id: true },
      });
      if (busy)
        throw voiceControlError(
          HttpStatus.CONFLICT,
          'MEMO_CONFLICT',
          'Ключ уже занят',
          { errors: [{ path: 'key', code: 'taken' }] },
        );
    }
    const r = await db.assistSiteMemo.updateMany({
      where: { id: row.id, draftRevision: row.draftRevision },
      data: {
        draft: content as unknown as Prisma.InputJsonValue,
        draftRevision: { increment: 1 },
        listed,
        key,
        view: content.view,
        updatedBy: m.memberId,
      },
    });
    if (r.count !== 1)
      throw voiceControlError(
        HttpStatus.CONFLICT,
        'MEMO_CONFLICT',
        'Мемо изменили в другой вкладке — обновите',
      );
    // История: что сделано (без значений — их в мемо нет).
    await this.change(db, m, row, row.draftRevision + 1, 'tma', {
      ops: (body.ops as MemoDraftOp[]).map((o) =>
        o.op === 'set' ? { op: 'set', field: o.field } : o,
      ),
    });
    return this.get(m, siteId, row.number);
  }

  async history(
    m: AccountMembership,
    siteId: string,
    n: string,
  ): Promise<{ items: MemoChangeView[] }> {
    const row = await this.memo(m, siteId, n);
    const items = await this.db(m).assistSiteMemoChange.findMany({
      where: { memoId: row.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      items: items.map((c) => ({
        revision: c.revision,
        actor: c.actor,
        source: c.source,
        op: c.op,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  }

  // ── версии: сборка, прогон, публикация, откат ──────────────────────────

  /**
   * Собрать версию из черновика: ворота кода — `held` с отчётом или
   * `checking` (ждёт сухого прогона). Правка ТОЛЬКО имени/фраз/описания
   * цели (шаги, слоты, условия цели, вид — как у опубликованной) — без
   * прогона: отчёт наследуется (§5-бис.17 п.7).
   */
  async buildVersion(
    m: AccountMembership,
    siteId: string,
    n: string,
    from?: { content: MemoContent; rollbackOf: number },
  ): Promise<MemoDetailView> {
    const row = await this.memo(m, siteId, n);
    const db = this.db(m);
    const content = from?.content ?? parseMemoContent(row.draft).content;
    const ctx = await this.rulesHost(m, siteId);
    const gate = this.gates(
      content,
      ctx,
      await this.takenPhrases(db, siteId, row.id),
    );
    // Предложения фраз (ИИ/план/кандидаты — замаскированные команды
    // посетителей) в версию не идут: её читает публичная роль (представление
    // `assist_site_memo_published`), а им там нечего делать (аудит 03.10).
    const stored = { ...content, suggested: {}, computed: gate.computed };
    const hash = memoContentHash(stored);
    const last = await db.assistSiteMemoVersion.findFirst({
      where: { memoId: row.id },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    let checkReport: MemoCheckReport | null = null;
    // Аудит 03.10: отчёт наследуется ТОЛЬКО у работающего мемо. «Требует
    // проверки» и выключенное (в т.ч. нарушением) выходят только новым
    // прогоном (§5-бис.17 п.8): сайт изменился — старый `pass` не в счёт.
    if (
      gate.ok &&
      row.publishedVersion !== null &&
      row.status === 'published'
    ) {
      const pub = await db.assistSiteMemoVersion.findFirst({
        where: { memoId: row.id, number: row.publishedVersion },
        select: { content: true, checkReport: true },
      });
      const prev = pub ? parseMemoContent(pub.content).content : null;
      const same = (a: MemoContent, b: MemoContent) =>
        JSON.stringify([a.steps, a.slots, a.goal.expect, a.view]) ===
        JSON.stringify([b.steps, b.slots, b.goal.expect, b.view]);
      const prevReport = pub?.checkReport as MemoCheckReport | null;
      if (prev && same(prev, content) && prevReport?.result === 'pass')
        checkReport = { ...prevReport, contentHash: hash };
    }
    const number = (last?.number ?? 0) + 1;
    await db.assistSiteMemoVersion.create({
      data: {
        accountId: m.accountId,
        siteId,
        memoId: row.id,
        number,
        status: gate.ok ? 'checking' : 'held',
        content: stored as unknown as Prisma.InputJsonValue,
        contentHash: hash,
        gateReport: gate as unknown as Prisma.InputJsonValue,
        checkReport: checkReport
          ? (checkReport as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
        rollbackOf: from?.rollbackOf ?? null,
        requestedBy: m.memberId,
      },
    });
    if (
      row.status === 'draft' ||
      row.status === 'held' ||
      row.status === 'checking'
    )
      await db.assistSiteMemo.update({
        where: { id: row.id },
        data: { status: gate.ok ? 'checking' : 'held', updatedBy: m.memberId },
      });
    // Версий — последние 20 (опубликованная остаётся всегда).
    const old = await db.assistSiteMemoVersion.findMany({
      where: { memoId: row.id },
      orderBy: { number: 'desc' },
      skip: MEMO_LIMITS.versionsKept,
      select: { id: true, number: true },
    });
    const drop = old
      .filter((v) => v.number !== row.publishedVersion)
      .map((v) => v.id);
    if (drop.length)
      await db.assistSiteMemoVersion.deleteMany({
        where: { id: { in: drop } },
      });
    await this.change(
      db,
      m,
      row,
      row.draftRevision,
      from ? 'rollback' : 'tma',
      {
        op: 'version',
        number,
        gates: gate.ok ? 'ok' : gate.problems.map((p) => p.code),
        ...(from ? { rollbackOf: from.rollbackOf } : {}),
      },
    );
    this.logger.log(
      `memo version site=${siteId} memo=${row.number} v=${number} gates=${gate.ok ? 'ok' : 'held'}`,
    );
    return this.get(m, siteId, row.number);
  }

  private async version(
    m: AccountMembership,
    memoId: string,
    v: string | number,
  ) {
    const num = Number(v);
    if (!Number.isInteger(num) || num < 1) throw notFound();
    const row = await this.db(m).assistSiteMemoVersion.findFirst({
      where: { memoId, number: num },
    });
    if (!row) throw notFound();
    return row;
  }

  async getVersion(
    m: AccountMembership,
    siteId: string,
    n: string,
    v: string,
  ): Promise<MemoVersionView> {
    const row = await this.memo(m, siteId, n);
    const ver = await this.version(m, row.id, v);
    const db = this.db(m);
    return this.versionView(
      {
        ...ver,
        checkReport: ver.checkReport ?? (await this.checkReportOf(db, ver)),
      },
      true,
    );
  }

  /**
   * Ссылка мастера для сухого прогона ПОСЛЕДНЕЙ версии на проверке (30 мин,
   * подтверждённый хост, `?v4c_voicetest=`): владелец открывает страницы
   * шагов в своём браузере, итог считает код (`memo-page`/`memo-report`).
   */
  async checkToken(
    m: AccountMembership,
    siteId: string,
    n: string,
    body: { host?: unknown } | null | undefined,
  ): Promise<MemoCheckTokenView> {
    const row = await this.memo(m, siteId, n);
    const db = this.db(m);
    const ver = await db.assistSiteMemoVersion.findFirst({
      where: { memoId: row.id, status: 'checking' },
      orderBy: { number: 'desc' },
    });
    if (!ver)
      throw voiceControlError(
        HttpStatus.CONFLICT,
        'MEMO_GATES',
        'Сначала соберите версию, прошедшую ворота',
      );
    const now = this.now();
    const hosts = await db.siteHost.findMany({
      where: { siteId },
      orderBy: { createdAt: 'asc' },
    });
    const ok = hosts.filter((h) => {
      const a = evaluateHostAccess(h, 'assist-widget', now);
      return a.ok && !a.grace && h.scheme === 'https';
    });
    const want = typeof body?.host === 'string' ? body.host : null;
    const h = want ? ok.find((x) => x.host === want) : ok[0];
    if (!h)
      throw voiceControlError(
        HttpStatus.CONFLICT,
        'VOICE_CONTROL_HOST_REQUIRED',
        'Проверка — только на подтверждённом адресе сайта',
      );
    const origin = hostOriginOf(h);
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(now.getTime() + MEMO_LIMITS.checkTokenTtlMs);
    const t = await db.assistSiteVoiceTest.create({
      data: {
        accountId: m.accountId,
        siteId,
        kind: 'memo',
        host: h.host,
        origin,
        startedBy: m.memberId,
        tokenHash: sha256Hex(token),
        tokenExpiresAt: expiresAt,
        memoVersionId: ver.id,
      },
      select: { id: true },
    });
    await db.assistSiteMemoVersion.update({
      where: { id: ver.id },
      data: { checkId: t.id },
    });
    const first = parseMemoContent(ver.content).content.steps[0]?.page ?? '/';
    const path = first.replace(/\*.*$/, '').replace(/\/+$/, '') || '';
    return {
      testId: t.id,
      url: `${origin}${path || '/'}?${WIDGET_VOICE_TEST_PARAM}=${encodeURIComponent(token)}`,
      expiresAt: expiresAt.toISOString(),
      version: ver.number,
    };
  }

  /**
   * Публикация — подтверждение ЧЕЛОВЕКОМ в TMA (владелец/менеджер): версия
   * на проверке, ворота заново на снимке версии, отчёт сухого прогона
   * `pass`/`partial` той же версии (хеш содержимого). Индекс фраз — в одной
   * транзакции: фраза занята другой сущностью (гонка) — 409.
   */
  async publish(
    m: AccountMembership,
    siteId: string,
    n: string,
    v: string,
  ): Promise<MemoDetailView> {
    const row = await this.memo(m, siteId, n);
    const db = this.db(m);
    const ver = await this.version(m, row.id, v);
    if (ver.status !== 'checking')
      throw voiceControlError(
        HttpStatus.CONFLICT,
        'MEMO_GATES',
        'Опубликовать можно версию, прошедшую ворота и проверку',
      );
    // Аудит 03.10: выключенное мемо (человеком или нарушением) публикацией
    // не «оживает» — сначала «Включить» (→ черновик), §5-бис.17 п.4.
    if (row.status === 'disabled')
      throw voiceControlError(
        HttpStatus.CONFLICT,
        'MEMO_CONFLICT',
        'Мемо выключено — сначала включите его',
      );
    const content = parseMemoContent(ver.content).content;
    const ctx = await this.rulesHost(m, siteId);
    const gate = this.gates(
      content,
      ctx,
      await this.takenPhrases(db, siteId, row.id),
    );
    if (!gate.ok) {
      await db.assistSiteMemoVersion.update({
        where: { id: ver.id },
        data: {
          status: 'held',
          gateReport: gate as unknown as Prisma.InputJsonValue,
        },
      });
      throw voiceControlError(
        HttpStatus.CONFLICT,
        'MEMO_GATES',
        'Версия не прошла ворота',
        { errors: gate.problems.map((p) => ({ path: p.path, code: p.code })) },
      );
    }
    const report =
      (ver.checkReport as MemoCheckReport | null) ??
      (await this.checkReportOf(db, ver));
    if (!report || (report.result !== 'pass' && report.result !== 'partial')) {
      if (report?.result === 'fail')
        await db.assistSiteMemoVersion.update({
          where: { id: ver.id },
          data: {
            status: 'held',
            checkReport: report as unknown as Prisma.InputJsonValue,
          },
        });
      throw voiceControlError(
        HttpStatus.CONFLICT,
        'MEMO_CHECK_REQUIRED',
        report?.result === 'fail'
          ? 'Проверка мемо на сайте не прошла'
          : 'Опубликовать можно после проверки мемо на сайте',
      );
    }
    const now = this.now();
    try {
      await db.$transaction(async (tx) => {
        await tx.assistSitePhrase.deleteMany({
          where: { siteId, owner: `memo:${row.id}` },
        });
        const phrases = memoPhrases(content);
        if (phrases.length)
          await tx.assistSitePhrase.createMany({
            data: phrases.map((p) => ({
              siteId,
              accountId: m.accountId,
              lang: p.lang,
              norm: p.norm,
              owner: `memo:${row.id}`,
              kind: p.kind,
            })),
          });
        await tx.assistSiteMemoVersion.update({
          where: { id: ver.id },
          data: {
            status: 'published',
            publishedBy: m.memberId,
            publishedAt: now,
            checkReport: report as unknown as Prisma.InputJsonValue,
          },
        });
        // Гонка с «Выключить»/«Удалить» в другой вкладке: мемо, ушедшее в
        // `disabled`/`removed` после чтения, публикация не воскрешает.
        const up = await tx.assistSiteMemo.updateMany({
          where: { id: row.id, status: { notIn: ['disabled', 'removed'] } },
          data: {
            status: 'published',
            publishedVersion: ver.number,
            view: content.view,
            staleViews: [],
            reviewReason: Prisma.DbNull,
            updatedBy: m.memberId,
          },
        });
        if (up.count !== 1)
          throw voiceControlError(
            HttpStatus.CONFLICT,
            'MEMO_CONFLICT',
            'Мемо выключили или удалили — обновите',
          );
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        throw voiceControlError(
          HttpStatus.CONFLICT,
          'MEMO_PHRASE_CONFLICT',
          'Фраза мемо уже занята другим мемо или целью',
        );
      throw e;
    }
    await this.change(db, m, row, row.draftRevision, 'tma', {
      op: 'publish',
      number: ver.number,
    });
    this.logger.log(
      `memo publish site=${siteId} memo=${row.number} v=${ver.number} member=${m.memberId}`,
    );
    return this.get(m, siteId, row.number);
  }

  async discard(
    m: AccountMembership,
    siteId: string,
    n: string,
    v: string,
  ): Promise<MemoDetailView> {
    const row = await this.memo(m, siteId, n);
    const ver = await this.version(m, row.id, v);
    if (ver.status !== 'checking' && ver.status !== 'held')
      throw voiceControlError(
        HttpStatus.CONFLICT,
        'MEMO_CONFLICT',
        'Отклонить можно только неопубликованную версию',
      );
    await this.db(m).assistSiteMemoVersion.update({
      where: { id: ver.id },
      data: { status: 'discarded' },
    });
    await this.change(this.db(m), m, row, row.draftRevision, 'tma', {
      op: 'discard',
      number: ver.number,
    });
    return this.get(m, siteId, row.number);
  }

  /** «Вернуть версию N» = новая версия с содержимым N и НОВЫМ прогоном. */
  async rollback(
    m: AccountMembership,
    siteId: string,
    n: string,
    v: string,
  ): Promise<MemoDetailView> {
    const row = await this.memo(m, siteId, n);
    const ver = await this.version(m, row.id, v);
    const content = parseMemoContent(ver.content).content;
    const detail = await this.buildVersion(m, siteId, n, {
      content,
      rollbackOf: ver.number,
    });
    // Откат — с повторным прогоном: унаследованный отчёт не засчитываем.
    const db = this.db(m);
    const last = await db.assistSiteMemoVersion.findFirst({
      where: { memoId: row.id },
      orderBy: { number: 'desc' },
      select: { id: true },
    });
    if (last)
      await db.assistSiteMemoVersion.update({
        where: { id: last.id },
        data: { checkReport: Prisma.DbNull },
      });
    return { ...detail, versions: (await this.get(m, siteId, n)).versions };
  }

  // ── выключение, удаление ───────────────────────────────────────────────

  /** Выключить — сразу, без ворот (безопасно); фразы освобождаются. */
  async disable(
    m: AccountMembership,
    siteId: string,
    n: string,
  ): Promise<MemoDetailView> {
    const row = await this.memo(m, siteId, n);
    const db = this.db(m);
    await db.$transaction(async (tx) => {
      await tx.assistSitePhrase.deleteMany({
        where: { siteId, owner: `memo:${row.id}` },
      });
      await tx.assistSiteMemo.update({
        where: { id: row.id },
        data: {
          status: 'disabled',
          reviewReason: { code: 'owner', at: this.now().toISOString() },
          updatedBy: m.memberId,
        },
      });
    });
    await this.change(db, m, row, row.draftRevision, 'tma', { op: 'disable' });
    return this.get(m, siteId, row.number);
  }

  /** Включить — в черновик: снова ворота, прогон и публикация человеком. */
  async enable(
    m: AccountMembership,
    siteId: string,
    n: string,
  ): Promise<MemoDetailView> {
    const row = await this.memo(m, siteId, n);
    if (row.status !== 'disabled')
      throw voiceControlError(
        HttpStatus.CONFLICT,
        'MEMO_CONFLICT',
        'Мемо не выключено',
      );
    const db = this.db(m);
    await db.assistSiteMemo.update({
      where: { id: row.id },
      data: { status: 'draft', updatedBy: m.memberId },
    });
    await this.change(db, m, row, row.draftRevision, 'tma', { op: 'enable' });
    return this.get(m, siteId, row.number);
  }

  /**
   * Удаление — мягкое (`removed`): номер не освобождается никогда, ключ —
   * через 180 дней (ретенция); история и статистика — 180 дней.
   */
  async remove(
    m: AccountMembership,
    siteId: string,
    n: string,
  ): Promise<{ ok: true }> {
    const row = await this.memo(m, siteId, n);
    const db = this.db(m);
    await db.$transaction(async (tx) => {
      await tx.assistSitePhrase.deleteMany({
        where: { siteId, owner: `memo:${row.id}` },
      });
      await tx.assistSiteMemo.update({
        where: { id: row.id },
        data: {
          status: 'removed',
          removedAt: this.now(),
          updatedBy: m.memberId,
        },
      });
    });
    await this.change(db, m, row, row.draftRevision, 'tma', { op: 'remove' });
    return { ok: true };
  }

  // ── статистика (§5-бис.17 п.13) ────────────────────────────────────────

  async stats(
    m: AccountMembership,
    siteId: string,
    n: string,
    days: unknown,
  ): Promise<MemoStatsView> {
    const row = await this.memo(m, siteId, n);
    const db = this.db(m);
    const windowDays = days === '30' || days === 30 ? 30 : 7;
    const since = new Date(this.now().getTime() - windowDays * DAY);
    const plans = await db.assistSiteUiPlan.findMany({
      where: {
        siteId,
        memoId: row.id,
        voiceTestId: null,
        createdAt: { gte: since },
      },
      select: {
        id: true,
        status: true,
        goalStatus: true,
        chainStatus: true,
        confirmedBy: true,
      },
      take: 5_000,
    });
    const ids = plans.map((p) => p.id);
    const logs = ids.length
      ? await db.assistSiteUiActionLog.findMany({
          where: { planId: { in: ids } },
          select: {
            action: true,
            result: true,
            stepIndex: true,
            pinMismatch: true,
            target: true,
          },
          take: 50_000,
        })
      : [];
    const out: MemoStatsView = {
      windowDays,
      runs: plans.length,
      reached: plans.filter((p) => p.goalStatus === 'reached').length,
      notReached: plans.filter((p) => p.goalStatus === 'not_reached').length,
      unknown: plans.filter((p) => p.goalStatus === 'unknown').length,
      direct: 0,
      lite: 0,
      pinMismatch: logs.filter((l) => l.pinMismatch).length,
      self: 0,
      cancelled: plans.filter(
        (p) => p.status === 'stopped' && p.confirmedBy === null,
      ).length,
      failuresByStep: {},
      chainAfterFailure: {},
    };
    for (const l of logs) {
      if (l.action === 'plan') {
        const via = (l.target as { via?: string } | null)?.via;
        if (via === 'direct') out.direct++;
        else if (via === 'lite') out.lite++;
        continue;
      }
      if (
        (l.result === 'failed' || l.result === 'manual') &&
        !['refused', 'violation', 'undo'].includes(l.action)
      ) {
        out.self++;
        const k = String(l.stepIndex + 1);
        out.failuresByStep[k] = (out.failuresByStep[k] ?? 0) + 1;
      }
    }
    for (const p of plans)
      if ((p.status === 'failed' || p.status === 'stopped') && p.chainStatus)
        out.chainAfterFailure[p.chainStatus] =
          (out.chainAfterFailure[p.chainStatus] ?? 0) + 1;
    return out;
  }
}
