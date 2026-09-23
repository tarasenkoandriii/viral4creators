/**
 * Сведение дублей — «Тонкая красная линия» §6.4, этап 10.
 *
 * Один вызов модели на КАНДИДАТА, а не на пару: сравниваем сразу со
 * всеми ситуациями того же шага. Их обычно единицы, а вызов на пару
 * означал бы квадрат от числа записей на ровном месте.
 *
 * Кандидатов на порядки меньше, чем подсказок, поэтому своего бюджета
 * у этой операции нет — хватает общего дневного бюджета советника.
 * Отдельная строка в `ai-pricing.ts` нужна не ради экономии, а чтобы в
 * отчёте было видно, сколько стоит именно разбор входящих сигналов.
 */

import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { createGeminiClient, geminiApiKey } from '../../common/gemini-client';
import { GEMINI_MODEL } from '../../common/gemini-model';
import {
  AI_GUIDE_BUDGET_KEY,
  DEFAULT_DAILY_BUDGET_MICRO_USD,
  DEFAULT_SIBLING_AUTO,
  DEFAULT_SIBLING_SUGGEST,
  SIBLING_AUTO_KEY,
  SIBLING_SUGGEST_KEY,
  numberSettingValue,
  thresholdValue,
} from './guide-settings';
import { guideSpentToday } from './guide-budget';
import { WizardGuideService } from './wizard-guide.service';
import {
  SIBLING_CANDIDATES_MAX,
  buildSiblingPrompt,
  parseSiblingAnswer,
  siblingVerdict,
  type SiblingSubject,
  type SiblingVerdict,
} from './siblings';

const SIBLING_TIMEOUT_MS = 20_000;

@Injectable()
export class SiblingsService {
  private readonly logger = new Logger(SiblingsService.name);
  private readonly genai: GoogleGenAI | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
    private readonly aiUsage: AiUsageService,
    private readonly guide: WizardGuideService,
  ) {
    this.genai = geminiApiKey() ? createGeminiClient() : null;
  }

  /** Общий дневной потолок фичи — тот же, что у подсказки. */
  private async budgetLeft(): Promise<boolean> {
    const budget = numberSettingValue(
      await this.settings.get(AI_GUIDE_BUDGET_KEY),
      DEFAULT_DAILY_BUDGET_MICRO_USD,
    );
    const spent = await guideSpentToday(this.aiUsage);
    if (spent < budget) return true;
    this.logger.warn(
      `сведение дублей пропущено: дневной бюджет советника исчерпан (${spent} мкд при потолке ${budget})`,
    );
    return false;
  }

  async thresholds(): Promise<{ auto: number; suggest: number }> {
    const [auto, suggest] = await Promise.all([
      this.settings.get(SIBLING_AUTO_KEY),
      this.settings.get(SIBLING_SUGGEST_KEY),
    ]);
    return {
      auto: thresholdValue(auto, DEFAULT_SIBLING_AUTO),
      suggest: thresholdValue(suggest, DEFAULT_SIBLING_SUGGEST),
    };
  }

  /**
   * Правка порогов.
   *
   * Пишутся только переданные — по той же причине, что у настроек
   * советника: карточка правит их по одному, и сохранение верхнего не
   * должно возвращать нижний к тому, что лежало на экране.
   */
  async setThresholds(
    input: { auto?: number; suggest?: number },
    updatedBy?: string,
  ): Promise<{ auto: number; suggest: number }> {
    const clamp = (n: number) => String(Math.min(1, Math.max(0, n)));
    const ops: Promise<void>[] = [];
    if (input.auto !== undefined)
      ops.push(
        this.settings.set(SIBLING_AUTO_KEY, clamp(input.auto), updatedBy),
      );
    if (input.suggest !== undefined)
      ops.push(
        this.settings.set(SIBLING_SUGGEST_KEY, clamp(input.suggest), updatedBy),
      );
    await Promise.all(ops);
    return this.thresholds();
  }

  /**
   * Разобрать кандидата: сравнить, записать вердикт, при `AUTO` —
   * свести.
   *
   * Возвращает вердикт даже когда сводить не с чем: `matchScore`
   * хранится у КАЖДОГО кандидата, включая отвергнутых и тех, кого
   * потом сведёт человек. Через месяц по распределению видно, где на
   * самом деле проходит граница, и порог двигают по факту, а не по
   * ощущению — ради этого всё и сохраняется.
   */
  async classify(candidateId: string): Promise<SiblingVerdict | null> {
    const candidate: {
      id: string;
      scenario: string;
      stepId: string;
      rawText: string;
      status: string;
    } | null = await this.prisma.wizardExperienceCandidate.findUnique({
      where: { id: candidateId },
      select: {
        id: true,
        scenario: true,
        stepId: true,
        rawText: true,
        status: true,
      },
    });
    if (!candidate || candidate.status !== 'NEW') return null;

    const subjects = await this.subjectsOf(
      candidate.scenario,
      candidate.stepId,
    );
    // Сравнивать не с чем — это не «нет совпадений по мнению модели», а
    // отсутствие вопроса. Платить за него незачем.
    if (!subjects.length) return null;
    if (!this.genai) return null;

    // Рубильник и бюджет — те же, что у подсказки, и проверяются здесь
    // тоже (аудит волны C). Жалоба приходит с формы, то есть этот вызов
    // умеет запускать посторонний человек; без общего потолка «$2 в
    // сутки» ограничивал бы только подсказки, а счёт рос бы мимо него.
    // Кандидат при этом не теряется — он остаётся в очереди без
    // процента, и оператор разберёт его руками.
    if (!(await this.guide.available())) return null;
    if (!(await this.budgetLeft())) return null;

    const { auto, suggest } = await this.thresholds();
    let verdict: SiblingVerdict;
    try {
      const response = await this.genai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ text: 'Сравни сигнал со списком.' }],
        config: {
          systemInstruction: buildSiblingPrompt(candidate.rawText, subjects),
          maxOutputTokens: 300,
          abortSignal: AbortSignal.timeout(SIBLING_TIMEOUT_MS),
        },
      });
      await this.aiUsage.recordGemini(response, {
        operation: 'wizard-sibling',
        model: GEMINI_MODEL,
        userId: null,
      });
      verdict = siblingVerdict(
        parseSiblingAnswer(
          response?.text ?? '',
          subjects.map((s) => s.id),
        ),
        auto,
        suggest,
      );
    } catch (e) {
      // Кандидат остаётся в очереди без процента — оператор разберёт
      // руками. Потерянный разбор дешевле ложного сведения.
      this.logger.warn(
        `сравнение кандидата ${candidateId} не вышло: ${String(e)}`,
      );
      return null;
    }

    await this.apply(candidateId, verdict);
    return verdict;
  }

  /**
   * Сравниваем ТОЛЬКО с ситуациями того же шага.
   *
   * И дёшево, и правильно: грабля привязана к шагу по определению, а
   * «похожая проблема на другом шаге» — это другая проблема.
   *
   * Берутся и черновики: ситуация, которую оператор ещё не
   * опубликовал, для сведения дублей так же хороша — счётчик встреч
   * растёт и у неё, и к моменту публикации она будет знать свою частоту.
   */
  private async subjectsOf(
    scenario: string,
    stepId: string,
  ): Promise<SiblingSubject[]> {
    const rows: Array<{
      id: string;
      texts: Array<{ symptom: string; locale: string }>;
    }> = await this.prisma.wizardExperience.findMany({
      where: { scenario, stepId, status: { in: ['DRAFT', 'PUBLISHED'] } },
      orderBy: { occurrences: 'desc' },
      take: SIBLING_CANDIDATES_MAX,
      select: { id: true, texts: { select: { symptom: true, locale: true } } },
    });
    return rows
      .map((r) => {
        // Русский симптом — рабочий язык модерации и самый полный
        // текст; если его нет, годится любой: сравнение межъязыковое.
        const text =
          r.texts.find((t) => t.locale === 'ru') ?? r.texts[0] ?? null;
        return text ? { id: r.id, symptom: text.symptom } : null;
      })
      .filter((s): s is SiblingSubject => s !== null);
  }

  /**
   * Записать вердикт.
   *
   * `AUTO` двигает и статус, и счётчик встреч — одной транзакцией:
   * счётчик без статуса означал бы, что кандидат остался в очереди и
   * будет сведён второй раз, а статус без счётчика — что частота
   * потеряна навсегда.
   */
  private async apply(
    candidateId: string,
    verdict: SiblingVerdict,
  ): Promise<void> {
    const data = {
      matchScore: verdict.score,
      why: verdict.why || null,
      matchedId: verdict.matchedId,
      // `OPERATOR` в вердикте означает «решать человеку», и решения
      // ещё нет: `null` — «ждёт очереди», а `NONE` по §6.2 означает
      // «совпадений нет», что при заполненном `matchedId` было бы
      // прямым противоречием.
      decision: verdict.decision === 'OPERATOR' ? null : verdict.decision,
      ...(verdict.decision === 'AUTO'
        ? { status: 'MERGED', decidedBy: 'siblings' }
        : {}),
    };
    if (verdict.decision === 'AUTO' && verdict.matchedId) {
      await this.prisma.$transaction([
        this.prisma.wizardExperienceCandidate.update({
          where: { id: candidateId },
          data,
        }),
        this.prisma.wizardExperience.update({
          where: { id: verdict.matchedId },
          data: { occurrences: { increment: 1 } },
        }),
      ]);
      return;
    }
    await this.prisma.wizardExperienceCandidate.update({
      where: { id: candidateId },
      data,
    });
  }

  /**
   * Гистограмма последних решений (§10).
   *
   * Не украшение: модель меняется, распределение вместе с ней, и только
   * по нему видно, что 0.85 перестал значить то же, что месяц назад.
   */
  async histogram(limit = 100): Promise<{
    buckets: Array<{ from: number; count: number }>;
    decisions: Record<string, number>;
    total: number;
  }> {
    const rows: Array<{ matchScore: number | null; decision: string | null }> =
      await this.prisma.wizardExperienceCandidate.findMany({
        where: { matchScore: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { matchScore: true, decision: true },
      });
    const buckets = Array.from({ length: 10 }, (_, i) => ({
      from: i / 10,
      count: 0,
    }));
    const decisions: Record<string, number> = {};
    for (const r of rows) {
      const score = r.matchScore ?? 0;
      const index = Math.min(9, Math.max(0, Math.floor(score * 10)));
      buckets[index].count += 1;
      const key = r.decision ?? 'NONE';
      decisions[key] = (decisions[key] ?? 0) + 1;
    }
    return { buckets, decisions, total: rows.length };
  }
}
