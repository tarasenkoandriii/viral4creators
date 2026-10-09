/**
 * №113 (заход 10) — подсказки панели редактора (iframe `we.`), сервис;
 * чистая часть — `editor-assist.ts`. Допуск — сессия редактора
 * (`EditorSessionService.resolve` в контроллере: сессия жива, участник —
 * по-прежнему владелец/менеджер, хост — verified «Сайта»).
 *
 *   POST /editor/v1/suggest-synonyms   { expectedRevision, key } — ИИ-синонимы цели
 *   GET  /editor/v1/misses?path=       «Промахи»: Т-4 по целям страницы + «просили, не нашли»
 *   GET  /editor/v1/suggestions?path=  «Предложения» из очереди (пороги, без отклонённых)
 *   POST /editor/v1/suggestions/mute   { id } | { key, lang, text } — «не предлагать 30 дней»
 *   POST /editor/v1/suggestions/term   { expectedRevision, id } — (заход 11) принять
 *                                      термин распознавания → `set-terms` черновика
 *
 * Заход 11 (остаток №113): «Промахи» отдают ещё `heat` — по ВСЕМ целям
 * страницы с шагами за 7 дней (тепловые значки на странице: просили /
 * «натисніть самі» / «не туди» / не знайдено) и `wrong` — команды «не
 * туда» по целям (кнопка «перепривязати»); «Предложения» — ещё карточки
 * `wrong` (≥ 2 посетителей) и `term` (неуверенное распознавание, ≥ 2
 * посетителей; принять — термин в черновик, публикуется обычным путём).
 *
 * ИИ-синонимы — порядок как у фраз мемо (деньги — до модели):
 *  1. цель черновика активна и не «никогда» (иначе 422 — ей синонимы
 *     запрещены, модель не зовём); ревизия совпадает (иначе 409 до трат);
 *  2. частота: раз в минуту на цель, 30 в сутки (UTC) на сайт — по журналу
 *     карты (строки `ai-synonyms`) → 429;
 *  3. резерв бюджета обучения (`LearningBudget`, `assist-learn`) — не
 *     помещается → 402 `EDITOR_SUGGEST_BUDGET`; резерв прошёл — строка
 *     `ai-synonyms` в журнал ДО вызова модели (сбой модели тоже засчитан);
 *     после вызова — поправка резерва на факт (сбой — возврат);
 *  4. модель (`GeminiText`, строгий JSON) → отбор (`filterSynonyms`);
 *  5. запись — обычной операцией черновика `upsert-target` с синонимами
 *     `suggested` (источник `suggestion`, ревизия 409): в версию они не идут
 *     (`versionContent`), публикуются только принятием человека.
 * В лог — id сайта, ключ цели и числа; ни фраз, ни команд посетителей.
 */
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import { estimateCost } from '../../../shared/ai-pricing';
import { GEMINI_MODEL } from '../../../shared/gemini-model';
import { parsePersona } from '../../assist-site-setup/persona';
import { phraseNorm } from '../../assist-ui-core/memo';
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
} from '../../assist-ui-core/voice-map';
import { LearningBudget } from '../../site-ai/learning-budget';
import {
  GeminiText,
  TextModelError,
  spentOf,
  type TextModelSpent,
} from '../../site-ai/text-model';
import { AiUsageRecorder } from '../../site-ai/usage-recorder';
import type { MapMissItem } from '../map-misses';
import { MAP_MISSES_LIMITS, MapMissesService } from '../map-misses';
import { voiceMapError } from '../voice-map-errors';
import { VoiceMapService } from '../voice-map.service';
import {
  aiMuteId,
  askedNotFound,
  lowConfTermItems,
  termId,
  wrongAsked,
  buildSynonymPrompt,
  EDITOR_ASSIST,
  filterSynonyms,
  parseSynonymReply,
  suggestionCards,
  synonymLangs,
  type AskedItem,
  type AskedRow,
  type SuggestionCard,
  type SynonymDropCode,
  type TermItem,
  type WrongItem,
  type WrongRow,
} from './editor-assist';
import type { ResolvedEditor } from './editor-session.service';

const PATH_RE = /^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/;
const ID_RE = /^[0-9a-f]{24}$/;
const KEY_RE = VOICE_MAP_LIMITS.keyRe;

export interface EditorSuggestView {
  revision: number;
  key: string;
  langs: VoiceMapLang[];
  /** Сколько фраз принято в предложения по языкам. */
  kept: Partial<Record<VoiceMapLang, number>>;
  dropped: Partial<Record<SynonymDropCode, number>>;
}

export interface EditorMissesView {
  days: number;
  path: string;
  /** Промахи Т-4 по целям, действующим на этой странице. */
  items: MapMissItem[];
  /** «Просили, не нашли» на этом шаблоне страниц. */
  asked: AskedItem[];
  /** (заход 11) Все цели страницы с шагами за 7 дней — тепловые значки. */
  heat: MapMissItem[];
  /** (заход 11) Команды «не туда» по целям страницы — «перепривязать». */
  wrong: WrongItem[];
}

export interface EditorSuggestionsView {
  path: string;
  items: SuggestionCard[];
}

type Db = ReturnType<SitesDb['forAccount']>;

@Injectable()
export class EditorAssistService {
  private readonly logger = new Logger(EditorAssistService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly maps: VoiceMapService,
    private readonly missesSvc: MapMissesService,
    private readonly text: GeminiText,
    private readonly budget: LearningBudget,
    private readonly usage: AiUsageRecorder,
  ) {}

  private bad(message: string) {
    return voiceMapError(HttpStatus.BAD_REQUEST, 'EDITOR_BAD_REQUEST', message);
  }

  // ── ИИ-синонимы ─────────────────────────────────────────────────────────

  async suggestSynonyms(
    ed: ResolvedEditor,
    body: unknown,
  ): Promise<EditorSuggestView> {
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
    if (row.draftRevision !== b.expectedRevision)
      throw voiceMapError(
        HttpStatus.CONFLICT,
        'VOICE_MAP_CONFLICT',
        'Карту изменили в другой вкладке — обновите',
      );
    const content = parseVoiceMapContent(row.draft);
    const t = content.targets.find(
      (x) => x.key === b.key && x.status === 'active',
    );
    if (!t) throw this.bad('Цели с таким ключом в черновике нет');
    if (t.denylisted || effectiveRisk(t) === 'never')
      throw voiceMapError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'EDITOR_SUGGEST_NEVER',
        'У цели «никогда» синонимов нет — она только в списке запретов',
      );
    const langs = synonymLangs(await this.siteLangs(db, ed.siteId), t);
    const est =
      estimateCost(GEMINI_MODEL, EDITOR_ASSIST.estUnits).costMicroUsd || 2_000;
    await this.claim(db, ed, t.key, est, row.draftRevision);
    let actual = 0;
    let replyText: string;
    const record = async (r: TextModelSpent) => {
      const units = {
        inputTokens: r.inputTokens,
        cachedInputTokens: r.cachedInputTokens,
        outputTokens: r.outputTokens,
      };
      // Аудит Ж (P3-3): учёт упал — резерв поправляется на оценку по токенам
      // ответа (деньги ушли), а не возвращается целиком.
      actual = estimateCost(r.model, units).costMicroUsd || est;
      const rec = await this.usage.record(
        this.sitesDb.system('учёт расходов ИИ: синонимы карты (assist-learn)'),
        {
          accountId: ed.accountId,
          siteId: ed.siteId,
          operation: 'assist-learn',
          model: r.model,
          units,
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
      const prompt = buildSynonymPrompt(t, langs, page);
      const r = await this.text.generate({
        system: prompt.system,
        user: prompt.user,
        json: true,
        maxOutputTokens: EDITOR_ASSIST.maxOutputTokens,
        temperature: EDITOR_ASSIST.temperature,
        timeoutMs: EDITOR_ASSIST.timeoutMs,
      });
      replyText = r.text;
      await record(r);
    } catch (e) {
      const spent = spentOf(e);
      if (spent) await record(spent).catch(() => undefined);
      if (e instanceof TextModelError)
        throw voiceMapError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'EDITOR_SUGGEST_UNAVAILABLE',
          'Модель сейчас недоступна — попробуйте позже',
        );
      throw e;
    } finally {
      await this.budget.adjust(ed.accountId, ed.siteId, actual - est);
    }
    const proposed = parseSynonymReply(replyText, langs);
    const muted = await this.mutedIds(db, ed.siteId);
    // Аудит Ж (P3-2): ответ оплачен — пока ждали модель, черновик могли
    // поменять. Применяем к СВЕЖЕЙ ревизии (цель перепроверяется), одна
    // повторная попытка на гонку записи.
    for (let attempt = 0; ; attempt++) {
      const fresh = await this.maps.loadMap(db, ed.accountId, ed.siteId);
      const cur = parseVoiceMapContent(fresh.draft);
      const ft = cur.targets.find(
        (x) => x.key === t.key && x.status === 'active',
      );
      const keptN: Partial<Record<VoiceMapLang, number>> = {};
      for (const l of langs) keptN[l] = 0;
      if (!ft || ft.denylisted || effectiveRisk(ft) === 'never') {
        this.logger.log(
          `editor synonyms site=${ed.siteId} key=${t.key} target-gone cost=${actual}`,
        );
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
            { accountId: ed.accountId, memberId: ed.memberId },
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
      this.logger.log(
        `editor synonyms site=${ed.siteId} key=${t.key} langs=${langs.join(',')} kept=${langs.map((l) => keptN[l]).join('/')} cost=${actual}`,
      );
      return { revision, key: t.key, langs, kept: keptN, dropped };
    }
  }

  /**
   * Аудит Ж (P3-1, P3-3): частота и резерв — под `pg_advisory_xact_lock`
   * сайта: проверка журнала, резерв бюджета и строка `ai-synonyms` одной
   * транзакцией (две вкладки не проскочат вдвоём). Строка журнала не
   * записалась — резерв возвращается.
   */
  private async claim(
    db: Db,
    ed: ResolvedEditor,
    key: string,
    est: number,
    revision: number,
  ): Promise<void> {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`editor-ai-synonyms:${ed.siteId}`}))`;
      await this.assertRate(tx as unknown as Db, ed.siteId, key);
      if (!(await this.budget.reserve(ed.accountId, ed.siteId, est)))
        throw voiceMapError(
          HttpStatus.PAYMENT_REQUIRED,
          'EDITOR_SUGGEST_BUDGET',
          'Бюджет обучения на этот месяц исчерпан',
        );
      try {
        await this.journal(tx as unknown as Db, ed, revision, {
          op: 'ai-synonyms',
          key,
        });
      } catch (e) {
        await this.budget.adjust(ed.accountId, ed.siteId, -est);
        throw e;
      }
    });
  }

  /** Строка журнала карты без правки черновика (источник `suggestion`). */
  private async journal(
    db: Db,
    ed: ResolvedEditor,
    revision: number,
    op: Record<string, string>,
  ): Promise<void> {
    await db.assistSiteVoiceMapChange.create({
      data: {
        accountId: ed.accountId,
        siteId: ed.siteId,
        revision,
        actor: ed.memberId,
        source: 'suggestion',
        op: op as Prisma.InputJsonValue,
        // Часы сервиса (а не базы): частота и «не предлагать» считаются
        // ими же — тест на подменённых часах не зависит от нагрузки.
        createdAt: this.now(),
      },
    });
  }

  /** Строки журнала `op` за окно (фильтр — в SQL, свежие первыми). */
  private journalRows(
    db: Db,
    siteId: string,
    op: string,
    since: Date,
    take: number,
  ) {
    return db.assistSiteVoiceMapChange.findMany({
      where: {
        siteId,
        source: 'suggestion',
        createdAt: { gte: since },
        op: { path: ['op'], equals: op },
      },
      select: { op: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /** Частота ИИ-синонимов по журналу карты: раз в минуту на цель, 30 в сутки (UTC) на сайт. */
  private async assertRate(db: Db, siteId: string, key: string): Promise<void> {
    const now = this.now();
    const dayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const mine = await this.journalRows(
      db,
      siteId,
      'ai-synonyms',
      new Date(
        Math.min(
          dayStart.getTime(),
          now.getTime() - EDITOR_ASSIST.targetCooldownMs,
        ),
      ),
      EDITOR_ASSIST.sitePerDay + 50,
    );
    const recent = mine.some(
      (r) =>
        (r.op as { key?: unknown }).key === key &&
        now.getTime() - r.createdAt.getTime() < EDITOR_ASSIST.targetCooldownMs,
    );
    const today = mine.filter((r) => r.createdAt >= dayStart).length;
    if (recent || today >= EDITOR_ASSIST.sitePerDay)
      throw voiceMapError(
        HttpStatus.TOO_MANY_REQUESTS,
        'EDITOR_SUGGEST_LIMIT',
        recent
          ? 'Синонимы для этой цели — не чаще раза в минуту'
          : `Предложений синонимов сегодня больше ${EDITOR_ASSIST.sitePerDay} — продолжите завтра`,
        { scope: recent ? 'target' : 'site' },
      );
  }

  /** Языки опубликованной персоны сайта (без персоны — пусто). */
  private async siteLangs(db: Db, siteId: string): Promise<string[]> {
    const row = await db.assistSite.findFirst({
      where: { siteId },
      select: { configVersion: true, personaDraft: true },
    });
    if (!row) return [];
    const pub =
      row.configVersion > 0
        ? await db.assistSiteConfigVersion.findFirst({
            where: { siteId, kind: 'persona', version: row.configVersion },
            select: { config: true },
          })
        : null;
    const p = parsePersona(pub?.config ?? row.personaDraft ?? null);
    if (!p.ok) return [];
    const l = p.persona.languages;
    return [l.default, ...l.allowed.filter((x) => x !== l.default)];
  }

  /** Фразы ДРУГИХ целей черновика и мемо сайта (`lang:norm`). */
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
    const memo = await db.assistSitePhrase.findMany({
      where: { siteId, owner: { not: 'voice-map' } },
      select: { lang: true, norm: true },
    });
    for (const r of memo) out.add(`${r.lang}:${r.norm}`);
    return out;
  }

  // ── «Не предлагать» ─────────────────────────────────────────────────────

  /** Отклонённые за 30 дней (id пар) — по журналу карты. */
  private async mutedIds(db: Db, siteId: string): Promise<Set<string>> {
    const rows = await this.journalRows(
      db,
      siteId,
      'suggestion-mute',
      new Date(this.now().getTime() - VOICE_MAP_LIMITS.suggestionMuteMs),
      5_000,
    );
    const out = new Set<string>();
    for (const r of rows) {
      const id = (r.op as { id?: unknown } | null)?.id;
      if (typeof id === 'string') out.add(id);
    }
    return out;
  }

  async mute(ed: ResolvedEditor, body: unknown): Promise<{ id: string }> {
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
    const db = this.sitesDb.forAccount(ed.accountId);
    // Аудит Ж (P3-4): «не предлагать» — не больше 200 в сутки на сайт.
    const since = new Date(this.now().getTime() - 86_400_000);
    if (
      (
        await this.journalRows(
          db,
          ed.siteId,
          'suggestion-mute',
          since,
          EDITOR_ASSIST.mutePerDay,
        )
      ).length >= EDITOR_ASSIST.mutePerDay
    )
      throw voiceMapError(
        HttpStatus.TOO_MANY_REQUESTS,
        'EDITOR_SUGGEST_LIMIT',
        'Отклонений сегодня слишком много — продолжите завтра',
        { scope: 'mute' },
      );
    const row = await this.maps.loadMap(db, ed.accountId, ed.siteId);
    // Только хеш пары: текста фраз посетителей в журнале нет.
    await this.journal(db, ed, row.draftRevision, {
      op: 'suggestion-mute',
      id,
    });
    return { id };
  }

  // ── «Промахи» и «Предложения» ───────────────────────────────────────────

  private pathOf(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length > 300 || !PATH_RE.test(raw))
      throw this.bad('Неверный путь страницы');
    return raw;
  }

  async misses(
    ed: ResolvedEditor,
    pathRaw: unknown,
  ): Promise<EditorMissesView> {
    return (await this.collect(ed, pathRaw)).view;
  }

  private async collect(
    ed: ResolvedEditor,
    pathRaw: unknown,
    /** «Предложения»: отклонённые отсекаются ДО срезов (аудит P3-8). */
    muted?: ReadonlySet<string>,
  ): Promise<{ view: EditorMissesView; content: VoiceMapContent; db: Db }> {
    const path = this.pathOf(pathRaw);
    const db = this.sitesDb.forAccount(ed.accountId);
    const row = await this.maps.loadMap(db, ed.accountId, ed.siteId);
    const content = parseVoiceMapContent(row.draft);
    const { view: stats, wrongs } = await this.missesSvc.detailFor(
      ed.accountId,
      ed.siteId,
    );
    const keys = new Set(targetsForPage(content, path).map((t) => t.key));
    const heat = stats.items.filter((i) => keys.has(i.key));
    const view: EditorMissesView = {
      days: stats.days,
      path,
      items: heat
        .filter((i) => i.self + i.notFound + i.wrong + i.missed > 0)
        .slice(0, MAP_MISSES_LIMITS.items),
      asked: await this.asked(db, ed.siteId, content, path, muted),
      heat,
      wrong: await this.wrong(
        db,
        ed.siteId,
        wrongs.filter((w) => keys.has(w.key) && !w.multi),
        muted,
      ),
    };
    return { view, content, db };
  }

  async suggestions(
    ed: ResolvedEditor,
    pathRaw: unknown,
  ): Promise<EditorSuggestionsView> {
    const muted = await this.mutedIds(
      this.sitesDb.forAccount(ed.accountId),
      ed.siteId,
    );
    const { view: v, content, db } = await this.collect(ed, pathRaw, muted);
    return {
      path: v.path,
      items: suggestionCards(v.asked, v.items, muted, {
        wrong: v.wrong,
        terms: await this.terms(db, ed.siteId, content, muted),
      }),
    };
  }

  /** (заход 11) Команды планов «не туда» (маскированные; мастер и сухие — нет). */
  private async wrong(
    db: Db,
    siteId: string,
    wrongs: ReadonlyArray<{ key: string; planId: string }>,
    muted?: ReadonlySet<string>,
  ): Promise<WrongItem[]> {
    if (!wrongs.length) return [];
    const plans = await db.assistSiteUiPlan.findMany({
      where: {
        siteId,
        id: { in: [...new Set(wrongs.map((w) => w.planId))].slice(0, 2000) },
        voiceTestId: null,
        dryRun: false,
      },
      select: {
        id: true,
        visitorId: true,
        utteranceMasked: true,
        lang: true,
        conversationId: true,
      },
    });
    // Хеш IP — диалога плана (аудит P3-2: порог посетителей — и по IP).
    const convs = await db.assistSiteConversation.findMany({
      where: {
        siteId,
        id: { in: [...new Set(plans.map((p) => p.conversationId))] },
      },
      select: { id: true, ipHash: true },
    });
    const ipOf = new Map(convs.map((c) => [c.id, c.ipHash]));
    const byId = new Map(plans.map((p) => [p.id, p]));
    const rows: WrongRow[] = [];
    for (const w of wrongs) {
      const p = byId.get(w.planId);
      if (p)
        rows.push({
          key: w.key,
          planId: p.id,
          visitorId: p.visitorId,
          ipHash: ipOf.get(p.conversationId) ?? null,
          utterance: p.utteranceMasked,
          lang: p.lang,
        });
    }
    return wrongAsked(rows, muted);
  }

  /** (заход 11) Кандидаты в термины за 7 дней (известное карте — нет). */
  private async terms(
    db: Db,
    siteId: string,
    content: VoiceMapContent,
    muted?: ReadonlySet<string>,
  ): Promise<TermItem[]> {
    const rows = await db.assistSiteSttLowTerm.findMany({
      where: {
        siteId,
        createdAt: {
          gte: new Date(this.now().getTime() - EDITOR_ASSIST.windowMs),
        },
      },
      select: { norm: true, word: true, visitorHash: true, ipHash: true },
      orderBy: { createdAt: 'desc' },
      take: EDITOR_ASSIST.termRows,
    });
    const known = new Set<string>();
    for (const t of content.targets)
      if (t.status === 'active')
        for (const p of targetPhrases(t)) known.add(p.norm);
    for (const x of content.terms) known.add(phraseNorm(x));
    return lowConfTermItems(rows, known, muted);
  }

  /**
   * (заход 11) Принять термин распознавания: id — из СВЕЖЕГО списка
   * кандидатов (текст берёт сервер, не панель), запись — `set-terms`
   * черновика обычной операцией (ревизия 409, ≤ 100 терминов — 422);
   * публикуется, как всё, через ворота и подтверждение.
   */
  async acceptTerm(
    ed: ResolvedEditor,
    body: unknown,
  ): Promise<{ revision: number; term: string }> {
    const b = (body ?? {}) as { expectedRevision?: unknown; id?: unknown };
    if (
      typeof b.expectedRevision !== 'number' ||
      !Number.isInteger(b.expectedRevision) ||
      typeof b.id !== 'string' ||
      !ID_RE.test(b.id)
    )
      throw this.bad('Нужны ревизия черновика и id предложения');
    const db = this.sitesDb.forAccount(ed.accountId);
    const row = await this.maps.loadMap(db, ed.accountId, ed.siteId);
    if (row.draftRevision !== b.expectedRevision)
      throw voiceMapError(
        HttpStatus.CONFLICT,
        'VOICE_MAP_CONFLICT',
        'Карту изменили в другой вкладке — обновите',
      );
    const content = parseVoiceMapContent(row.draft);
    const item = (await this.terms(db, ed.siteId, content)).find(
      (t) => t.id === b.id && t.visitors >= EDITOR_ASSIST.minTermVisitors,
    );
    if (!item) throw this.bad('Такого предложения термина нет');
    if (content.terms.length >= EDITOR_ASSIST.termsMax)
      throw voiceMapError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'VOICE_MAP_INVALID',
        `Терминов в карте больше нет места (≤ ${EDITOR_ASSIST.termsMax})`,
        { errors: [{ path: 'terms', code: 'limit' }] },
      );
    const res = await this.maps.patch(
      { accountId: ed.accountId, memberId: ed.memberId },
      ed.siteId,
      {
        expectedRevision: row.draftRevision,
        ops: [{ op: 'set-terms', terms: [...content.terms, item.phrase] }],
      },
      'editor',
    );
    this.logger.log(
      `editor term site=${ed.siteId} id=${termId(phraseNorm(item.phrase))} terms=${content.terms.length + 1}`,
    );
    return { revision: res.revision, term: item.phrase };
  }

  /**
   * «Просили, не нашли» на шаблоне страницы: строки `plan` за 7 дней — 0
   * шагов (без причины или `no_target`) или промах карты; планы мастера и
   * сухие прогоны — нет. Команды — маскированные (`utteranceMasked`).
   */
  private async asked(
    db: Db,
    siteId: string,
    content: VoiceMapContent,
    path: string,
    muted?: ReadonlySet<string>,
  ): Promise<AskedItem[]> {
    const since = new Date(this.now().getTime() - EDITOR_ASSIST.windowMs);
    const logs = await db.assistSiteUiActionLog.findMany({
      where: {
        siteId,
        action: 'plan',
        createdAt: { gte: since },
        OR: [
          { mapMiss: true },
          {
            result: 'skipped',
            OR: [{ reason: null }, { reason: { contains: 'no_target' } }],
          },
        ],
      },
      select: {
        planId: true,
        url: true,
        mapKey: true,
        mapMiss: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: EDITOR_ASSIST.planRows,
    });
    const tpl = templateFor(content, path);
    const here = (p: string) =>
      p === path ||
      p.replace(/\/+$/, '') === path.replace(/\/+$/, '') ||
      (!!tpl && templateFor(content, p)?.id === tpl.id);
    const pageOf = (u: string | null) => {
      try {
        return u ? new URL(u).pathname : null;
      } catch {
        return null;
      }
    };
    const onPage = logs.filter((l) => {
      const p = pageOf(l.url);
      return p !== null && here(p);
    });
    if (!onPage.length) return [];
    const plans = await db.assistSiteUiPlan.findMany({
      where: {
        siteId,
        id: { in: [...new Set(onPage.map((l) => l.planId))] },
        voiceTestId: null,
        dryRun: false,
      },
      select: { id: true, visitorId: true, utteranceMasked: true, lang: true },
    });
    const byId = new Map(plans.map((p) => [p.id, p]));
    const rows: AskedRow[] = [];
    for (const l of onPage) {
      const p = byId.get(l.planId);
      if (!p) continue;
      rows.push({
        planId: p.id,
        visitorId: p.visitorId,
        utterance: p.utteranceMasked,
        lang: p.lang,
        page: pageOf(l.url) ?? '/',
        key: l.mapMiss ? l.mapKey : null,
        at: l.createdAt,
      });
    }
    const known = new Set<string>();
    for (const t of content.targets)
      if (t.status === 'active')
        for (const p of targetPhrases(t)) known.add(`${p.lang}:${p.norm}`);
    return askedNotFound(rows, known, muted);
  }
}
