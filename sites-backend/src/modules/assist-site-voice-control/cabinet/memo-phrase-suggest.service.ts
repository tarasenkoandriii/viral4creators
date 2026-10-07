/**
 * ИИ-предложения фраз запуска мемо «Сайта» — сервис (чистая часть —
 * `memo-phrase-suggest.ts`). Только по кнопке владельца/менеджера в TMA
 * (`POST …/memos/:n/suggest-phrases`), без автозапусков и кронов.
 *
 * Порядок (деньги — до модели, как у вопросов сайта):
 *  1. мемо этого сайта (права и 404 — `MemoService.get`), ревизия черновика
 *     совпадает (`expectedRevision`, иначе 409 до трат);
 *  2. частота: раз в минуту на мемо, 30 в сутки (UTC) на сайт — по истории
 *     черновика (источник `suggestion`, поле `suggested`) → 429;
 *  3. резерв бюджета обучения (`LearningBudget`, операция `assist-learn`) —
 *     не помещается → 402 `MEMO_SUGGEST_BUDGET`; после вызова — поправка на
 *     факт (сбой модели — возврат резерва целиком);
 *  4. модель (`GeminiText`, строгий JSON) → отбор фраз той же проверкой,
 *     что у ручных, и тем же индексом фраз сайта;
 *  5. запись — СУЩЕСТВУЮЩЕЙ операцией черновика `set suggested`
 *     (`MemoService.patchDraft`: ревизия 409, разбор, история с источником
 *     `suggestion`). В версию предложения не идут (`buildVersion`).
 * В лог — id сайта, номер мемо и числа; ни фраз, ни имён.
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { SitesDb } from '../../../prisma/sites-db.service';
import { estimateCost } from '../../../shared/ai-pricing';
import { GEMINI_MODEL } from '../../../shared/gemini-model';
import { parsePersona } from '../../assist-site-setup/persona';
import {
  MEMO_LANGS,
  phraseNorm,
  type MemoLang,
} from '../../assist-ui-core/memo';
import { LearningBudget } from '../../site-ai/learning-budget';
import {
  GeminiText,
  TextModelError,
  spentOf,
  type TextModelSpent,
} from '../../site-ai/text-model';
import { AiUsageRecorder } from '../../site-ai/usage-recorder';
import type { AccountMembership } from '../../site-core/account/roles';
import type { MemoDetailView } from '../api-types';
import { MemoService } from './memo.service';
import {
  buildPhrasePrompt,
  filterSuggestedPhrases,
  MEMO_PHRASE_SUGGEST,
  parsePhraseReply,
  suggestLangs,
  type PhraseDropCode,
} from './memo-phrase-suggest';
import { voiceControlError } from './voice-control-errors';

export interface MemoPhraseSuggestView {
  memo: MemoDetailView;
  report: {
    langs: MemoLang[];
    /** Сколько фраз принято в предложения по языкам. */
    kept: Partial<Record<MemoLang, number>>;
    dropped: Partial<Record<PhraseDropCode, number>>;
  };
}

@Injectable()
export class MemoPhraseSuggestService {
  private readonly logger = new Logger(MemoPhraseSuggestService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly memos: MemoService,
    private readonly text: GeminiText,
    private readonly budget: LearningBudget,
    private readonly usage: AiUsageRecorder,
  ) {}

  async suggest(
    m: AccountMembership,
    siteId: string,
    n: string,
    body: { expectedRevision?: unknown } | null | undefined,
  ): Promise<MemoPhraseSuggestView> {
    const detail = await this.memos.get(m, siteId, n);
    if (
      typeof body?.expectedRevision !== 'number' ||
      body.expectedRevision !== detail.draftRevision
    )
      throw voiceControlError(
        HttpStatus.CONFLICT,
        'MEMO_CONFLICT',
        'Мемо изменили в другой вкладке — обновите',
      );
    const db = this.sitesDb.forAccount(m.accountId);
    const memo = await db.assistSiteMemo.findFirst({
      where: { siteId, number: detail.number, status: { not: 'removed' } },
      select: { id: true },
    });
    if (!memo)
      throw voiceControlError(
        HttpStatus.NOT_FOUND,
        'MEMO_NOT_FOUND',
        'Мемо не найдено',
      );
    await this.assertRate(m, siteId, memo.id);
    const draft = detail.draft;
    const langs = suggestLangs(await this.siteLangs(m, siteId), draft);
    const est =
      estimateCost(GEMINI_MODEL, MEMO_PHRASE_SUGGEST.estUnits).costMicroUsd ||
      2_000;
    if (!(await this.budget.reserve(m.accountId, siteId, est)))
      throw voiceControlError(
        HttpStatus.PAYMENT_REQUIRED,
        'MEMO_SUGGEST_BUDGET',
        'Бюджет обучения на этот месяц исчерпан',
      );
    let actual = 0;
    let replyText: string;
    const record = async (r: TextModelSpent) => {
      const rec = await this.usage.record(
        this.sitesDb.system('учёт расходов ИИ: фразы мемо (assist-learn)'),
        {
          accountId: m.accountId,
          siteId,
          operation: 'assist-learn',
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
      const prompt = buildPhrasePrompt(draft, langs);
      const r = await this.text.generate({
        system: prompt.system,
        user: prompt.user,
        json: true,
        maxOutputTokens: MEMO_PHRASE_SUGGEST.maxOutputTokens,
        temperature: MEMO_PHRASE_SUGGEST.temperature,
        timeoutMs: MEMO_PHRASE_SUGGEST.timeoutMs,
      });
      await record(r);
      replyText = r.text;
    } catch (e) {
      // empty/truncated: провайдер ответил — расход в учёт и в бюджет
      // обучения, ответ владельцу тот же (503). Сбой записи — не повод
      // подменять ошибку модели.
      const spent = spentOf(e);
      if (spent) await record(spent).catch(() => undefined);
      if (e instanceof TextModelError)
        throw voiceControlError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'MEMO_SUGGEST_UNAVAILABLE',
          'Модель сейчас недоступна — попробуйте позже',
        );
      throw e;
    } finally {
      await this.budget.adjust(m.accountId, siteId, actual - est);
    }
    const proposed = parsePhraseReply(replyText, langs);
    const { kept, dropped } = filterSuggestedPhrases(proposed, draft, {
      taken: await this.takenPhrases(m, siteId, memo.id),
      otherNames: await this.otherNames(m, siteId, memo.id),
    });
    // Сгенерированные языки заменяются, остальные предложения — как были.
    const suggested: Partial<Record<MemoLang, string[]>> = {
      ...draft.suggested,
    };
    for (const l of langs) suggested[l] = kept[l] ?? [];
    const updated = await this.memos.patchDraft(
      m,
      siteId,
      n,
      {
        expectedRevision: detail.draftRevision,
        ops: [{ op: 'set', field: 'suggested', value: suggested }],
      },
      'suggestion',
    );
    const keptN: Partial<Record<MemoLang, number>> = {};
    for (const l of langs) keptN[l] = kept[l]?.length ?? 0;
    this.logger.log(
      `memo phrases site=${siteId} memo=${detail.number} langs=${langs.join(',')} kept=${langs.map((l) => keptN[l]).join('/')} cost=${actual}`,
    );
    return { memo: updated, report: { langs, kept: keptN, dropped } };
  }

  /** Раз в минуту на мемо, 30 в сутки (UTC) на сайт — по истории черновика. */
  private async assertRate(
    m: AccountMembership,
    siteId: string,
    memoId: string,
  ): Promise<void> {
    const now = this.now();
    const dayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const rows = await this.sitesDb
      .forAccount(m.accountId)
      .assistSiteMemoChange.findMany({
        where: {
          siteId,
          source: 'suggestion',
          createdAt: {
            gte: new Date(
              Math.min(
                dayStart.getTime(),
                now.getTime() - MEMO_PHRASE_SUGGEST.memoCooldownMs,
              ),
            ),
          },
        },
        select: { memoId: true, op: true, createdAt: true },
        take: 500,
      });
    const mine = rows.filter((r) =>
      JSON.stringify(r.op).includes('"suggested"'),
    );
    const recent = mine.some(
      (r) =>
        r.memoId === memoId &&
        now.getTime() - r.createdAt.getTime() <
          MEMO_PHRASE_SUGGEST.memoCooldownMs,
    );
    const today = mine.filter((r) => r.createdAt >= dayStart).length;
    if (recent || today >= MEMO_PHRASE_SUGGEST.sitePerDay)
      throw voiceControlError(
        HttpStatus.TOO_MANY_REQUESTS,
        'MEMO_SUGGEST_LIMIT',
        recent
          ? 'Предложения для этого мемо — не чаще раза в минуту'
          : 'Предложения фраз на сегодня исчерпаны — завтра снова',
      );
  }

  /** Языки опубликованной персоны сайта (без персоны — пусто). */
  private async siteLangs(
    m: AccountMembership,
    siteId: string,
  ): Promise<string[]> {
    const db = this.sitesDb.forAccount(m.accountId);
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

  /** Фразы сайта, занятые ДРУГИМИ сущностями (индекс фраз), `lang:norm`. */
  private async takenPhrases(
    m: AccountMembership,
    siteId: string,
    memoId: string,
  ): Promise<Set<string>> {
    const rows = await this.sitesDb
      .forAccount(m.accountId)
      .assistSitePhrase.findMany({
        where: { siteId, owner: { not: `memo:${memoId}` } },
        select: { lang: true, norm: true },
      });
    return new Set(rows.map((r) => `${r.lang}:${r.norm}`));
  }

  /** Имена других мемо сайта (черновики тоже), `lang:norm`. */
  private async otherNames(
    m: AccountMembership,
    siteId: string,
    memoId: string,
  ): Promise<Set<string>> {
    const rows = await this.sitesDb
      .forAccount(m.accountId)
      .assistSiteMemo.findMany({
        where: { siteId, status: { not: 'removed' }, id: { not: memoId } },
        select: { draft: true },
      });
    const out = new Set<string>();
    for (const r of rows) {
      const names = ((r.draft ?? {}) as { names?: Record<string, unknown> })
        .names;
      for (const l of MEMO_LANGS) {
        const v = names?.[l];
        if (typeof v === 'string' && v.trim()) out.add(`${l}:${phraseNorm(v)}`);
      }
    }
    return out;
  }
}
