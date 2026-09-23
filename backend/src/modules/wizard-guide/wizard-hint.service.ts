/**
 * WizardHintService — подсказка на шаге мастера («Тонкая красная линия»
 * §5, этап 6).
 *
 * ## Порядок проверок и почему он такой
 *
 * Сначала бесплатное и быстрое, потом платное: рубильники → владение →
 * дайджест → кеш → бюджет → модель. Каждая ступень выше по списку
 * отсекает вызов дешевле, чем следующая, и самая дорогая стоит
 * последней.
 *
 * ## Чего здесь НЕТ намеренно
 *
 * Стрима. Лендинговый ассистент стримит, потому что отвечает абзацами
 * на произвольный вопрос; подсказка — одна реплика до 400 знаков в
 * свёрнутой строке, и стрим в неё не добавляет ничего, кроме второго
 * пути исполнения, который придётся отдельно тестировать. Таймауты и
 * отмена по разрыву при этом те же.
 *
 * ## Деградация
 *
 * Любая неудача — это `hint: null`, а не ошибка. Совет украшение пути,
 * а не сам путь: человек пришёл делать ролик, а не читать про наши
 * лимиты. Единственное исключение — ЕГО собственный суточный лимит: он
 * его, и завтра вернётся.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { createGeminiClient, geminiApiKey } from '../../common/gemini-client';
import { GEMINI_MODEL } from '../../common/gemini-model';
import {
  maskSensitiveEcho,
  containsForbiddenPromise,
} from '../assistant/post-filter';
import { DEFAULT_LOCALE, SupportedLocale } from '../../common/locale';
import {
  scenarioOfProjectType,
  type FreeScenario,
} from '../../common/test-user-scenarios';
import {
  buildHintInstruction,
  cleanHint,
  digestOfFacts,
  hintCacheKey,
} from './hint-context';
import {
  HINT_DOC_SLUGS,
  parseHintActions,
  splitHintActions,
  type GuideAction,
} from './hint-actions';
import { SCENARIO_HINTS, stepIdsOf } from './hint-scenarios';
import {
  AI_GUIDE_BUDGET_KEY,
  AI_GUIDE_PERSONAL_LIMIT_KEY,
  DEFAULT_DAILY_BUDGET_MICRO_USD,
  DEFAULT_PERSONAL_LIMIT,
  numberSettingValue,
} from './guide-settings';
import { WizardGuideService } from './wizard-guide.service';

/** Сколько ждём модель. Короткая реплика — короткое ожидание. */
const HINT_TIMEOUT_MS = 20_000;
/** Кеш живёт сутки: корпус меняется деплоем, состояние — шагами. */
export const HINT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Ключи и умолчания — в `guide-settings.ts`; здесь только реэкспорт
 * ради прежних импортов. */
export {
  AI_GUIDE_BUDGET_KEY,
  AI_GUIDE_PERSONAL_LIMIT_KEY,
  DEFAULT_DAILY_BUDGET_MICRO_USD,
  DEFAULT_PERSONAL_LIMIT,
};

export interface HintResult {
  /** `null` — сказать нечего. Причину наружу не выдаём (см. шапку). */
  hint: string | null;
  actions: GuideAction[];
  source: 'cache' | 'model' | 'static' | null;
  /** Заполняется ТОЛЬКО когда исчерпан личный лимит этого человека. */
  notice?: string;
}

const NOTHING: HintResult = { hint: null, actions: [], source: null };

@Injectable()
export class WizardHintService {
  private readonly logger = new Logger(WizardHintService.name);
  private readonly genai: GoogleGenAI | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
    private readonly aiUsage: AiUsageService,
    private readonly guide: WizardGuideService,
  ) {
    // Нет ключа — не падаем при старте: фича выключается сама, как у
    // ассистента, и остальной мастер продолжает работать.
    this.genai = geminiApiKey() ? createGeminiClient() : null;
  }

  async hint(
    userId: string,
    projectId: string,
    stepId: string,
    locale: SupportedLocale = DEFAULT_LOCALE,
    signal?: AbortSignal,
  ): Promise<HintResult> {
    if (!(await this.guide.available())) return NOTHING;

    const project = await this.projectOf(userId, projectId);
    if (!project.aiGuideEnabled) return NOTHING;

    const scenario = scenarioOfProjectType(project.type);
    const hints = scenario ? SCENARIO_HINTS[scenario] : undefined;
    const card = hints?.cards[stepId];
    // Шаг, про который нам нечего сказать, — не ошибка: сценарии
    // добавляются волнами, и пустой ответ честнее выдуманного.
    if (!scenario || !hints || !card) return NOTHING;

    const facts = await this.factsOf(scenario, projectId);
    const key = hintCacheKey({
      scenario,
      stepId,
      locale,
      knowledgeStamp: this.knowledgeStamp(),
      digest: digestOfFacts(facts),
    });

    const cached = await this.fromCache(key);
    if (cached) return cached;

    const personal = await this.personalLeft(userId);
    if (personal <= 0) {
      return {
        ...NOTHING,
        notice: 'На сегодня советы закончились — они вернутся завтра.',
      };
    }
    if (!(await this.budgetLeft())) return NOTHING;
    if (!this.genai) return NOTHING;

    const instruction = buildHintInstruction({
      locale,
      scenarioGoal: hints.goal,
      card,
      facts,
      // Тот же список, по которому потом проверяются действия: второй
      // список разошёлся бы, и кнопки начали бы вести в никуда ровно
      // на тех шагах, которые переименовали.
      stepIds: stepIdsOf(scenario),
      docSlugs: HINT_DOC_SLUGS,
    });

    const started = Date.now();
    try {
      const response = await this.genai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ text: 'Дай подсказку по текущему шагу.' }],
        config: {
          systemInstruction: instruction,
          maxOutputTokens: 400,
          abortSignal: signal ?? AbortSignal.timeout(HINT_TIMEOUT_MS),
        },
      });
      await this.aiUsage.recordGemini(response, {
        operation: 'wizard-hint',
        model: GEMINI_MODEL,
        userId,
      });

      const split = splitHintActions(response?.text ?? '');
      const text = cleanHint(split.text);
      if (!text) return NOTHING;

      // Пост-фильтр обязателен: модель пересказывает то, что ей дали, и
      // однажды перескажет не то. Маскируем, а не отбрасываем —
      // подсказка при этом остаётся полезной.
      const masked = maskSensitiveEcho(text);
      const flagged = masked !== text || containsForbiddenPromise(masked);
      const actions = parseHintActions(
        split.actionsJson,
        stepIdsOf(scenario),
        HINT_DOC_SLUGS,
      );

      await this.remember(key, masked, actions);
      await this.journal({
        scenario,
        stepId,
        locale,
        source: 'model',
        hint: masked,
        latencyMs: Date.now() - started,
        flagged,
      });
      return { hint: masked, actions, source: 'model' };
    } catch (e) {
      // Таймаут, отмена, отказ провайдера — всё это «строка свернулась
      // обратно», а не красная ошибка поверх мастера.
      this.logger.warn(
        `подсказка не получена (${stepId}): ${e instanceof Error ? e.message : String(e)}`,
      );
      return NOTHING;
    }
  }

  // ── Внутреннее ───────────────────────────────────────────────────

  private async projectOf(
    userId: string,
    projectId: string,
  ): Promise<{ type: string; aiGuideEnabled: boolean }> {
    const row: { type: string; aiGuideEnabled: boolean } | null =
      await this.prisma.project.findFirst({
        where: { id: projectId, userId, deletedAt: null },
        select: { type: true, aiGuideEnabled: true },
      });
    if (!row) throw new NotFoundException(`Project ${projectId} not found`);
    return row;
  }

  /**
   * Факты состояния словами.
   *
   * И положительные, и отрицательные: без «-title» ситуации «заголовка
   * нет» и «поле ещё не читали» дали бы один дайджест, а это разные
   * ситуации и разные советы.
   */
  private async factsOf(
    scenario: FreeScenario,
    projectId: string,
  ): Promise<string[]> {
    if (scenario !== 'CLIENT_SITE') return [];
    const draft: {
      stepsPerRound: number[];
      title: string | null;
      status: string;
      requiresLiveLoginReplay: boolean;
      hasCredentials?: boolean;
      credentialsEnc: string | null;
    } | null = await this.prisma.clientSiteTutorialDraft.findUnique({
      where: { projectId },
      select: {
        stepsPerRound: true,
        title: true,
        status: true,
        requiresLiveLoginReplay: true,
        credentialsEnc: true,
      },
    });
    if (!draft) return ['черновика ещё нет'];
    const rounds = draft.stepsPerRound.length;
    return [
      rounds > 0 ? `записано шагов: ${rounds}` : 'не записано ни одного шага',
      draft.title?.trim() ? 'название задано' : 'название не задано',
      draft.status === 'DRAFTING'
        ? 'черновик редактируется'
        : `черновик в статусе ${draft.status}`,
      draft.credentialsEnc
        ? 'вход на сайт уже пройден'
        : 'вход на сайт ещё не проходили',
      draft.requiresLiveLoginReplay
        ? 'вход придётся повторить живой сессией'
        : 'повтор входа не требуется',
    ];
  }

  /**
   * Штамп корпуса. Пока корпус состоит из карточек в коде, штампом
   * служит версия этого модуля: поменяли формулировки — сменили строку,
   * и кеш обновился целиком. Когда появится генератор (этап 9), сюда
   * приедет его дата сборки.
   */
  private knowledgeStamp(): string {
    return 'cards-1';
  }

  private async fromCache(key: string): Promise<HintResult | null> {
    const row: { hint: string; actions: unknown; createdAt: Date } | null =
      await this.prisma.wizardHintCache.findUnique({ where: { key } });
    if (!row) return null;
    if (Date.now() - row.createdAt.getTime() > HINT_CACHE_TTL_MS) return null;
    // Счётчик попаданий — не украшение: по его доле видно, разорит
    // фича или нет, и он же ловит слишком подробный дайджест.
    await this.prisma.wizardHintCache
      .update({ where: { key }, data: { hits: { increment: 1 } } })
      .catch(() => undefined);
    return {
      hint: row.hint,
      actions: Array.isArray(row.actions) ? (row.actions as GuideAction[]) : [],
      source: 'cache',
    };
  }

  private async remember(
    key: string,
    hint: string,
    actions: GuideAction[],
  ): Promise<void> {
    // Учёт не должен ронять выдачу: подсказка уже получена и оплачена.
    await this.prisma.wizardHintCache
      .upsert({
        where: { key },
        create: { key, hint, actions: actions as unknown as object },
        update: { hint, actions: actions as unknown as object, hits: 0 },
      })
      .catch((e: unknown) =>
        this.logger.warn(`кеш подсказки не записан: ${String(e)}`),
      );
  }

  private async journal(row: {
    scenario: string;
    stepId: string;
    locale: string;
    source: string;
    hint: string;
    latencyMs: number;
    flagged: boolean;
  }): Promise<void> {
    await this.prisma.wizardHint
      .create({ data: row })
      .catch((e: unknown) =>
        this.logger.warn(`журнал подсказок не записан: ${String(e)}`),
      );
  }

  /** Сколько подсказок человеку ещё положено сегодня. */
  private async personalLeft(userId: string): Promise<number> {
    const limit = await this.numberSetting(
      AI_GUIDE_PERSONAL_LIMIT_KEY,
      DEFAULT_PERSONAL_LIMIT,
    );
    const used = await this.aiUsage.countToday(userId, 'wizard-hint');
    return limit - used;
  }

  /** Общий дневной бюджет фичи. Исчерпан — молчим, оператору алерт. */
  private async budgetLeft(): Promise<boolean> {
    const budget = await this.numberSetting(
      AI_GUIDE_BUDGET_KEY,
      DEFAULT_DAILY_BUDGET_MICRO_USD,
    );
    const spent = await this.aiUsage.spentTodayForOperation('wizard-hint');
    if (spent < budget) return true;
    this.logger.warn(
      `дневной бюджет советника исчерпан: ${spent} мкд при потолке ${budget}`,
    );
    return false;
  }

  private async numberSetting(key: string, fallback: number): Promise<number> {
    return numberSettingValue(await this.settings.get(key), fallback);
  }
}
