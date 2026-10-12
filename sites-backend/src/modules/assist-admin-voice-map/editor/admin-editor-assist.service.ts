/**
 * Подсказки панели редактора карты «Админки» (iframe `wa.`) — заход 13,
 * хвост Р-З11-А11 (паритет с панелью `we.` «Сайта», №113; ТЗ §5-кватер.4
 * «Предложения ИИ», §5-кватер.10 «Т-4 → Промахи», §5-кватер.9 «Изоляция»):
 *
 *   POST /assist-admin/v1/editor/suggest-synonyms   { expectedRevision, key } — ИИ-синонимы цели
 *   GET  /assist-admin/v1/editor/misses?path=       «Промахи»: Т-4 по целям страницы,
 *                                                   «просили, не нашли», тепловые значки, «не туда»
 *   GET  /assist-admin/v1/editor/suggestions?path=  «Пропозиції» (пороги «Админки», без отклонённых)
 *   POST /assist-admin/v1/editor/suggestions/mute   { id } | { key, lang, text } — не предлагать 30 дней
 *   POST /assist-admin/v1/editor/suggestions/term   у «Админки» терминов распознавания нет — 400
 *
 * Общее с «Сайтом» — ЧИСТОЕ ядро (`assist-ui-core/editor-assist.ts`,
 * `…/map-misses-core.ts`: промпт, разбор, отбор синонимов, свёртки и
 * карточки), а данные, деньги и журнал — свои (граф admin↛site, Р-З13-А1):
 *  - источник промахов — журнал действий «Админки» (`ui-plan`/`ui-step`,
 *    `mapKey`/`mapMiss`/`mapVersion` захода 11 + `mapKey` шага захода 13),
 *    команды — `assist_admin_ui_plans.utteranceMasked`, «посетитель» —
 *    сотрудник (`jwt:<sub>`); планы мастера и сухие прогоны — не сигнал;
 *  - ИИ-синонимы — суточный потолок «Админки» (резерв ДО модели, операция
 *    `assist-admin-map-synonyms`), частота — окна `assist_rate_buckets`
 *    (раз в минуту на цель, 30 в UTC-сутки на сайт); запись — обычная
 *    операция черновика (`suggested`, в версию не идут), журнал
 *    `voice-map.draft` + строка `voice-map.ai-synonyms` (числа, без фраз);
 *  - «не предлагать» — строки `voice-map.suggestion-mute` (только хеш пары)
 *    в append-only журнале «Админки», ≤ 200 в сутки.
 * Фразы занятости — другие цели черновика и мемо АМ-N (`assist_admin_phrases`).
 * В лог — id сайта, ключ цели и числа; ни фраз, ни команд сотрудников.
 */
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { SitesDb } from '../../../prisma/sites-db.service';
import { estimateCost } from '../../../shared/ai-pricing';
import { GEMINI_MODEL } from '../../../shared/gemini-model';
import { AdminSessionService } from '../../assist-admin-chat/admin-session.service';
import {
  aiMuteId,
  askedNotFound,
  buildSynonymPrompt,
  EDITOR_ASSIST_CORE,
  filterSynonyms,
  parseSynonymReply,
  suggestionCards,
  wrongAsked,
  type AskedItem,
  type AskedRow,
  type SuggestionCard,
  type SuggestionThresholds,
  type WrongItem,
  type WrongRow,
} from '../../assist-ui-core/editor-assist';
import {
  MAP_MISSES_LIMITS,
  mapMissStats,
  mapMissWrongs,
  type MapMissItem,
  type MapMissRow,
} from '../../assist-ui-core/map-misses-core';
import {
  effectiveRisk,
  parseVoiceMapContent,
  targetPhrases,
  targetsForPage,
  templateFor,
  VOICE_MAP_LANGS,
  VOICE_MAP_LIMITS,
  type VoiceMapContent,
  type VoiceMapLang,
  type VoiceMapTarget,
} from '../../assist-ui-core/voice-map';
import { maskPagePath } from '../../assist-ui-core/snapshot';
import { geminiOutputCeiling } from '../../site-ai/gemini-output';
import {
  GeminiText,
  TextModelError,
  spentOf,
  type TextModelSpent,
} from '../../site-ai/text-model';
import { AiUsageRecorder } from '../../site-ai/usage-recorder';
import { adminVoiceMapError } from '../admin-voice-map-errors';
import {
  ADMIN_MAP_PHRASE_OWNER,
  AdminVoiceMapService,
} from '../admin-voice-map.service';
import type { AdminEditorSuggestView } from '../api-types';
import {
  adminEditorActor,
  type ResolvedAdminEditor,
} from './admin-editor-session.service';
import { AdminEditorBudget } from './admin-editor-budget';
import {
  adminMissRows,
  adminPhrasePd,
  askedPlanRows,
  type AdminJournalRow,
} from './admin-map-misses';

const PATH_RE = /^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/;
const ID_RE = /^[0-9a-f]{24}$/;
const KEY_RE = VOICE_MAP_LIMITS.keyRe;
const DAY_MS = 86_400_000;

/** Операция `site_ai_usage` ИИ-синонимов «Админки» (суточный потолок). */
export const ADMIN_MAP_SYNONYMS_OPERATION = 'assist-admin-map-synonyms';

export const ADMIN_EDITOR_ASSIST = {
  /** Оценка резерва суточного потолка «Админки» (сверху). */
  estUnits: { inputTokens: 1_200, outputTokens: geminiOutputCeiling(600) },
  /**
   * Р-З13-А3 (аудит З13-А P3-3): пороги «Пропозицій» «Админки» —
   * сотрудники по `sub` (их единицы): «просили» — 2 разных сотрудника И 3
   * повтора; «не туда» — 2 сотрудника; «натисніть самі» — 3, как у «Сайта».
   */
  thresholds: {
    minVisitors: 2,
    minWrongVisitors: 2,
    minTermVisitors: 2,
    minSelf: EDITOR_ASSIST_CORE.minSelf,
    askedCount: 3,
  } satisfies SuggestionThresholds,
  /** Строк журнала «Админки» за окно 7 дней (планы и шаги). */
  journalRows: 20_000,
} as const;

export interface AdminEditorMissesView {
  days: number;
  path: string;
  items: MapMissItem[];
  asked: AskedItem[];
  heat: MapMissItem[];
  wrong: WrongItem[];
}

export interface AdminEditorSuggestionsView {
  path: string;
  items: SuggestionCard[];
}

type Db = ReturnType<SitesDb['forAccount']>;

/**
 * Языки ИИ-синонимов «Админки» (Р-З13-А4): персоны с языками у «Админки»
 * нет; сотрудники украинских компаний говорят по-украински и по-русски —
 * uk и ru всегда, en — если у цели есть английское имя.
 */
export function adminSynonymLangs(
  t: Pick<VoiceMapTarget, 'names'>,
): VoiceMapLang[] {
  return VOICE_MAP_LANGS.filter((l) => l === 'uk' || l === 'ru' || t.names[l]);
}

@Injectable()
export class AdminEditorAssistService {
  private readonly logger = new Logger(AdminEditorAssistService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly maps: AdminVoiceMapService,
    private readonly sessions: AdminSessionService,
    private readonly text: GeminiText,
    private readonly usage: AiUsageRecorder,
    private readonly budget: AdminEditorBudget,
  ) {}

  private bad(message: string) {
    return adminVoiceMapError(
      HttpStatus.BAD_REQUEST,
      'EDITOR_BAD_REQUEST',
      message,
    );
  }

  private conflict() {
    return adminVoiceMapError(
      HttpStatus.CONFLICT,
      'VOICE_MAP_CONFLICT',
      'Карту изменили в другой вкладке — обновите',
    );
  }

  private limit(scope: 'target' | 'site' | 'mute', message: string) {
    return adminVoiceMapError(
      HttpStatus.TOO_MANY_REQUESTS,
      'EDITOR_SUGGEST_LIMIT',
      message,
      { scope },
    );
  }

  // ── ИИ-синонимы ─────────────────────────────────────────────────────────

  async suggestSynonyms(
    ed: ResolvedAdminEditor,
    body: unknown,
  ): Promise<AdminEditorSuggestView> {
    const b = (body ?? {}) as { expectedRevision?: unknown; key?: unknown };
    if (
      typeof b.expectedRevision !== 'number' ||
      !Number.isInteger(b.expectedRevision) ||
      typeof b.key !== 'string' ||
      !KEY_RE.test(b.key)
    )
      throw this.bad('Нужны ревизия черновика и ключ цели');
    const db = this.sitesDb.forAccount(ed.accountId);
    const row = await this.maps.loadMap(db, ed.accountId, ed.siteId);
    // Деньги — после всех бесплатных отказов (ревизия, цель, «никогда»).
    if (row.draftRevision !== b.expectedRevision) throw this.conflict();
    const content = parseVoiceMapContent(row.draft);
    const t = content.targets.find(
      (x) => x.key === b.key && x.status === 'active',
    );
    if (!t) throw this.bad('Цели с таким ключом в черновике нет');
    if (t.denylisted || effectiveRisk(t) === 'never')
      throw adminVoiceMapError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'EDITOR_SUGGEST_NEVER',
        'У цели «никогда» синонимов нет — она только в списке запретов',
      );
    // Аудит З13-А P3-1: окна частоты не тратятся на отказы до модели.
    //  1. «раз в минуту на цель» — СКОЛЬЗЯЩЕЕ окно по строкам журнала
    //     `voice-map.ai-synonyms` этой цели (только чтение);
    //  2. резерв суточного потолка «Админки» (402 — ничего не потрачено);
    //  3. 30 в UTC-сутки на сайт — атомарное окно `assist_rate_buckets`
    //     (отказ — резерв назад);
    //  4. строка `started` в журнал ДО модели (сбой модели тоже засчитан).
    const now = this.now();
    const recent = await this.sitesDb
      .forAccount(ed.accountId)
      .assistAdminActionLog.findFirst({
        where: {
          siteId: ed.siteId,
          kind: 'voice-map',
          operation: 'voice-map.ai-synonyms',
          at: {
            gt: new Date(now.getTime() - EDITOR_ASSIST_CORE.targetCooldownMs),
          },
          requestMasked: { path: ['key'], equals: t.key },
        },
        select: { id: true },
      });
    if (recent)
      throw this.limit(
        'target',
        'Синонимы для этой цели — не чаще раза в минуту',
      );
    const langs = adminSynonymLangs(t);
    const est =
      estimateCost(GEMINI_MODEL, ADMIN_EDITOR_ASSIST.estUnits).costMicroUsd ||
      2_000;
    const rsv = await this.budget.reserve(ed.accountId, ed.siteId, est);
    if (!rsv)
      throw adminVoiceMapError(
        HttpStatus.PAYMENT_REQUIRED,
        'EDITOR_SUGGEST_BUDGET',
        'Суточный лимит помощника сотрудников исчерпан — продолжим завтра',
      );
    try {
      if (
        !(await this.sessions.rateHit(
          'admin-map-ai-day',
          ed.siteId,
          EDITOR_ASSIST_CORE.sitePerDay,
          DAY_MS,
          now,
        ))
      )
        throw this.limit(
          'site',
          `Предложений синонимов сегодня больше ${EDITOR_ASSIST_CORE.sitePerDay} — продолжите завтра`,
        );
      await this.maps.journal(
        adminEditorActor(ed),
        ed.siteId,
        'voice-map.ai-synonyms',
        'started',
        { key: t.key },
      );
    } catch (e) {
      await this.budget.settle(rsv, 0);
      throw e;
    }
    let actual: number | null = null;
    let replyText = '';
    const record = async (r: TextModelSpent) => {
      const rec = await this.usage.record(
        this.sitesDb.system(
          'учёт расходов «Админки»: ИИ-синонимы карты (assist-admin-map-synonyms)',
        ),
        {
          accountId: ed.accountId,
          siteId: ed.siteId,
          operation: ADMIN_MAP_SYNONYMS_OPERATION,
          model: r.model,
          units: {
            inputTokens: r.inputTokens,
            cachedInputTokens: r.cachedInputTokens,
            outputTokens: r.outputTokens,
          },
        },
      );
      actual = rec.costMicroUsd;
    };
    try {
      const page =
        t.scope === 'site'
          ? '/*'
          : t.scope === 'template'
            ? (content.templates.find((x) => x.id === t.templateId)
                ?.pathPattern ?? '/')
            : (t.pagePath ?? '/');
      const prompt = buildSynonymPrompt(t, langs, page, 'employee');
      const r = await this.text.generate({
        system: prompt.system,
        user: prompt.user,
        json: true,
        maxOutputTokens: EDITOR_ASSIST_CORE.maxOutputTokens,
        temperature: EDITOR_ASSIST_CORE.temperature,
        timeoutMs: EDITOR_ASSIST_CORE.timeoutMs,
      });
      replyText = r.text;
      await record(r);
    } catch (e) {
      const spent = spentOf(e);
      if (spent) await record(spent).catch(() => undefined);
      // Провайдер денег не взял (таймаут/недоступен, без ответа) — резерв
      // снимается нулём; иной сбой без факта — оценка в расход (строже).
      else if (e instanceof TextModelError) actual = 0;
      await this.budget.settle(rsv, actual);
      await this.journalAi(ed, t.key, 'failed', {});
      if (e instanceof TextModelError)
        throw adminVoiceMapError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'EDITOR_SUGGEST_UNAVAILABLE',
          'Модель сейчас недоступна — попробуйте позже',
        );
      throw e;
    }
    await this.budget.settle(rsv, actual);
    const proposed = parseSynonymReply(replyText, langs);
    const muted = await this.mutedIds(db, ed.siteId);
    // Ответ оплачен — пока ждали модель, черновик могли поменять: к СВЕЖЕЙ
    // ревизии (цель перепроверяется), одна повторная попытка на гонку.
    for (let attempt = 0; ; attempt++) {
      const fresh = await this.maps.loadMap(db, ed.accountId, ed.siteId);
      const cur = parseVoiceMapContent(fresh.draft);
      const ft = cur.targets.find(
        (x) => x.key === t.key && x.status === 'active',
      );
      const keptN: Partial<Record<VoiceMapLang, number>> = {};
      for (const l of langs) keptN[l] = 0;
      if (!ft || ft.denylisted || effectiveRisk(ft) === 'never') {
        await this.journalAi(ed, t.key, 'target-gone', keptN);
        return {
          revision: fresh.draftRevision,
          key: t.key,
          langs,
          kept: keptN,
          dropped: {},
        };
      }
      const { kept, dropped } = filterSynonyms(proposed, ft, {
        taken: await this.takenPhrases(db, ed.siteId, cur, t.key),
        muted,
      });
      for (const l of langs) keptN[l] = kept[l]?.length ?? 0;
      let revision = fresh.draftRevision;
      if (Object.keys(kept).length) {
        const synonyms = { ...ft.synonyms };
        for (const l of VOICE_MAP_LANGS)
          if (kept[l])
            synonyms[l] = [
              ...(ft.synonyms[l] ?? []),
              ...(kept[l] as string[]).map((text) => ({
                text,
                origin: 'suggested' as const,
              })),
            ];
        try {
          const res = await this.maps.patch(
            adminEditorActor(ed),
            ed.siteId,
            {
              expectedRevision: fresh.draftRevision,
              ops: [{ op: 'upsert-target', target: { key: ft.key, synonyms } }],
            },
            'suggestion',
          );
          revision = res.revision;
        } catch (e) {
          if (
            attempt < 1 &&
            e instanceof HttpException &&
            e.getStatus() === 409
          )
            continue;
          throw e;
        }
      }
      await this.journalAi(ed, t.key, 'ok', keptN);
      this.logger.log(
        `admin editor synonyms site=${ed.siteId} key=${t.key} kept=${langs.map((l) => keptN[l]).join('/')} cost=${actual ?? est}`,
      );
      return { revision, key: t.key, langs, kept: keptN, dropped };
    }
  }

  /** Строка `voice-map.ai-synonyms`: кто и сколько (ни фраз, ни подписей). */
  private async journalAi(
    ed: ResolvedAdminEditor,
    key: string,
    outcome: string,
    kept: Partial<Record<VoiceMapLang, number>>,
  ): Promise<void> {
    await this.maps
      .journal(
        adminEditorActor(ed),
        ed.siteId,
        'voice-map.ai-synonyms',
        outcome,
        {
          key,
          kept,
        },
      )
      .catch(() => undefined);
  }

  /** Фразы ДРУГИХ целей черновика и мемо АМ-N (`lang:norm`). */
  private async takenPhrases(
    db: Db,
    siteId: string,
    content: VoiceMapContent,
    key: string,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    for (const t of content.targets)
      if (t.key !== key && t.status === 'active' && !t.denylisted)
        for (const p of targetPhrases(t, { withSuggested: true }))
          out.add(`${p.lang}:${p.norm}`);
    const memo = await db.assistAdminPhrase.findMany({
      where: { siteId, owner: { not: ADMIN_MAP_PHRASE_OWNER } },
      select: { lang: true, norm: true },
      take: 2000,
    });
    for (const r of memo) out.add(`${r.lang}:${r.norm}`);
    return out;
  }

  // ── «Не предлагать» ─────────────────────────────────────────────────────

  /** Отклонённые за 30 дней (id пар) — строки `voice-map.suggestion-mute`. */
  private async mutedIds(db: Db, siteId: string): Promise<Set<string>> {
    const rows = await db.assistAdminActionLog.findMany({
      where: {
        siteId,
        kind: 'voice-map',
        operation: 'voice-map.suggestion-mute',
        at: {
          gte: new Date(
            this.now().getTime() - VOICE_MAP_LIMITS.suggestionMuteMs,
          ),
        },
      },
      select: { requestMasked: true },
      orderBy: { at: 'desc' },
      take: 5_000,
    });
    const out = new Set<string>();
    for (const r of rows) {
      const id = (r.requestMasked as { id?: unknown } | null)?.id;
      if (typeof id === 'string') out.add(id);
    }
    return out;
  }

  async mute(ed: ResolvedAdminEditor, body: unknown): Promise<{ id: string }> {
    const b = (body ?? {}) as {
      id?: unknown;
      key?: unknown;
      lang?: unknown;
      text?: unknown;
    };
    let id: string | null = null;
    if (typeof b.id === 'string' && ID_RE.test(b.id)) id = b.id;
    else if (
      typeof b.key === 'string' &&
      KEY_RE.test(b.key) &&
      typeof b.lang === 'string' &&
      (VOICE_MAP_LANGS as readonly string[]).includes(b.lang) &&
      typeof b.text === 'string' &&
      b.text.length <= VOICE_MAP_LIMITS.synonymChars
    )
      id = aiMuteId(b.key, b.lang, b.text);
    if (!id) throw this.bad('Нужен id предложения или ключ, язык и фраза');
    if (
      !(await this.sessions.rateHit(
        'admin-map-mute',
        ed.siteId,
        EDITOR_ASSIST_CORE.mutePerDay,
        DAY_MS,
        this.now(),
      ))
    )
      throw this.limit(
        'mute',
        'Отклонений сегодня слишком много — продолжите завтра',
      );
    // Только хеш пары: текста фраз сотрудников в журнале нет.
    await this.maps.journal(
      adminEditorActor(ed),
      ed.siteId,
      'voice-map.suggestion-mute',
      'ok',
      { id },
    );
    return { id };
  }

  /**
   * Термины распознавания «Админки» не собираются (неуверенное
   * распознавание пишет только голос посетителя «Сайта»): карточек `term`
   * нет — принять нечего (Р-З13-А5).
   */
  async acceptTerm(_ed: ResolvedAdminEditor, body: unknown): Promise<never> {
    const b = (body ?? {}) as { id?: unknown };
    if (typeof b.id !== 'string' || !ID_RE.test(b.id))
      throw this.bad('Нужны ревизия черновика и id предложения');
    throw this.bad('Такого предложения термина нет');
  }

  // ── «Промахи» и «Пропозиції» ────────────────────────────────────────────

  private pathOf(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length > 300 || !PATH_RE.test(raw))
      throw this.bad('Неверный путь страницы');
    return raw;
  }

  async misses(
    ed: ResolvedAdminEditor,
    pathRaw: unknown,
  ): Promise<AdminEditorMissesView> {
    return (await this.collect(ed, pathRaw)).view;
  }

  async suggestions(
    ed: ResolvedAdminEditor,
    pathRaw: unknown,
  ): Promise<AdminEditorSuggestionsView> {
    const muted = await this.mutedIds(
      this.sitesDb.forAccount(ed.accountId),
      ed.siteId,
    );
    const { view: v } = await this.collect(ed, pathRaw, muted);
    return {
      path: v.path,
      items: suggestionCards(
        v.asked,
        v.items,
        muted,
        { wrong: v.wrong },
        ADMIN_EDITOR_ASSIST.thresholds,
      ),
    };
  }

  /** Строки журнала «Админки» за 7 дней → строки ядра свёртки. */
  private async journalRows(db: Db, siteId: string): Promise<MapMissRow[]> {
    const rows: AdminJournalRow[] = await db.assistAdminActionLog.findMany({
      where: {
        siteId,
        kind: { in: ['ui-plan', 'ui-step'] },
        at: {
          gte: new Date(this.now().getTime() - MAP_MISSES_LIMITS.windowMs),
        },
      },
      select: {
        at: true,
        kind: true,
        operation: true,
        outcome: true,
        error: true,
        requestMasked: true,
      },
      orderBy: { at: 'desc' },
      take: ADMIN_EDITOR_ASSIST.journalRows,
    });
    return adminMissRows(rows);
  }

  private async collect(
    ed: ResolvedAdminEditor,
    pathRaw: unknown,
    muted?: ReadonlySet<string>,
  ): Promise<{ view: AdminEditorMissesView; content: VoiceMapContent }> {
    const path = this.pathOf(pathRaw);
    const db = this.sitesDb.forAccount(ed.accountId);
    const row = await this.maps.loadMap(db, ed.accountId, ed.siteId);
    const content = parseVoiceMapContent(row.draft);
    const rows = await this.journalRows(db, ed.siteId);
    const stats = mapMissStats(rows, { all: true });
    const keys = new Set(targetsForPage(content, path).map((t) => t.key));
    const heat = stats.items.filter((i) => keys.has(i.key));
    const plans = await this.plans(db, ed.siteId, [
      ...askedPlanRows(rows).map((r) => r.planId),
      ...mapMissWrongs(rows).map((w) => w.planId),
    ]);
    const view: AdminEditorMissesView = {
      days: stats.days,
      path,
      items: heat
        .filter((i) => i.self + i.notFound + i.wrong + i.missed > 0)
        .slice(0, MAP_MISSES_LIMITS.items),
      asked: this.asked(rows, plans, content, path, muted),
      heat,
      wrong: wrongAsked(
        mapMissWrongs(rows)
          .filter((w) => keys.has(w.key) && !w.multi)
          .flatMap((w): WrongRow[] => {
            const p = plans.get(w.planId);
            // Аудит З13-А P3-3: имя/номер клиента — не фраза карты.
            return p && !adminPhrasePd(p.utteranceMasked)
              ? [
                  {
                    key: w.key,
                    planId: w.planId,
                    visitorId: p.actor,
                    // «Посетитель» «Админки» — сотрудник по `sub`; IP не нужен.
                    ipHash: null,
                    utterance: p.utteranceMasked,
                    lang: p.lang,
                  },
                ]
              : [];
          }),
        muted,
      ),
    };
    return { view, content };
  }

  /** Команды планов (маскированные); мастер и сухие прогоны — нет. */
  private async plans(db: Db, siteId: string, ids: readonly string[]) {
    const uniq = [...new Set(ids)].slice(0, 2000);
    if (!uniq.length)
      return new Map<
        string,
        { actor: string; utteranceMasked: string; lang: string | null }
      >();
    const rows = await db.assistAdminUiPlan.findMany({
      where: { siteId, id: { in: uniq }, voiceTestId: null, dryRun: false },
      select: { id: true, actor: true, utteranceMasked: true, lang: true },
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** «Просили, не нашли» на шаблоне этой страницы админки. */
  private asked(
    rows: readonly MapMissRow[],
    plans: ReadonlyMap<
      string,
      { actor: string; utteranceMasked: string; lang: string | null }
    >,
    content: VoiceMapContent,
    path: string,
    muted?: ReadonlySet<string>,
  ): AskedItem[] {
    const tpl = templateFor(content, path);
    const trim = (p: string) => p.replace(/\/+$/, '');
    // Путь страницы в журнале «Админки» — маской ПД (`maskPageUrl`).
    const masked = trim(maskPagePath(path));
    const here = (p: string) =>
      p === path ||
      trim(p) === trim(path) ||
      trim(p) === masked ||
      (!!tpl && templateFor(content, p)?.id === tpl.id);
    const out: AskedRow[] = [];
    for (const r of askedPlanRows(rows)) {
      const page = r.url;
      const p = plans.get(r.planId);
      if (!page || !p || !here(page) || adminPhrasePd(p.utteranceMasked))
        continue;
      out.push({
        planId: r.planId,
        visitorId: p.actor,
        utterance: p.utteranceMasked,
        lang: p.lang,
        page,
        key: r.mapMiss ? r.mapKey : null,
        at: r.createdAt,
      });
    }
    const known = new Set<string>();
    for (const t of content.targets)
      if (t.status === 'active')
        for (const ph of targetPhrases(t)) known.add(`${ph.lang}:${ph.norm}`);
    return askedNotFound(out, known, muted);
  }
}
