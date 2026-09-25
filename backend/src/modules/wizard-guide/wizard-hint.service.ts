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
import { PlanService } from '../plan/plan.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { createGeminiClient, geminiApiKey } from '../../common/gemini-client';
import { GEMINI_MODEL } from '../../common/gemini-model';
import { estimateCost } from '../../common/ai-pricing';
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
import { SCENARIO_HINTS, knowledgeStamp, stepIdsOf } from './hint-scenarios';
import { factsOfScenario } from './hint-facts';
// Через enum, а не строкой: значения там строчные, и литерал,
// написанный по памяти заглавными, молча выключил бы факт — как это
// уже случилось в тесте барьера greeting.
import { ModerationStatus } from '../../common/types/prompt.types';
import { GenerationStatus } from '../../common/types/generation.types';
import { activeProductImage } from '../../common/active-image';
import { AVATAR_PRESENTER } from '../../common/wizard-readiness.session';

/** Ровно те поля сессии, которые читают факты состояния. */
interface SessionShape {
  status?: string;
  greetingBriefSnapshot?: {
    occasion?: string;
    customOccasionText?: string | null;
    recipientName?: string;
    senderName?: string | null;
    presenterProvider?: string;
    resolvedPresenterProvider?: string;
  } | null;
  greetingReferenceImages?: unknown[] | null;
  generationPrompt?: {
    approvedAt?: string | null;
    moderationStatus?: string | null;
  } | null;
  generatedVideo?: { status?: string } | null;
  videoAnalysis?: { status?: string } | null;
  /** Приём сцены вместо референса (этап 153). */
  sceneTemplate?: { templateId?: string } | null;
  productInformation?: unknown;
}
import { guideSpentToday } from './guide-budget';
import {
  AI_GUIDE_BUDGET_KEY,
  AI_GUIDE_PERSONAL_LIMIT_KEY,
  DEFAULT_DAILY_BUDGET_MICRO_USD,
  DEFAULT_PERSONAL_LIMIT,
  numberSettingValue,
} from './guide-settings';
import { WizardGuideService } from './wizard-guide.service';
import { ExperienceService } from './experience.service';
import type { ExperienceText } from './experience';
import { TranslationService } from './translation.service';
import { usesTemplate } from '../../common/scene-templates';

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

/**
 * Код, а не текст.
 *
 * Единственная фраза, которую советник говорит вслух, — и мини-апп
 * живёт на пяти языках. Русская строка отсюда доезжала бы до немецкого
 * интерфейса как есть; подпись даёт словарь (`wizardGuide.personalLimit`),
 * у которого языки есть.
 */
export const PERSONAL_LIMIT_NOTICE = 'personal-limit';

/** Токены ответа модели — те же поля, по которым считается расход. */
function usageOf(response: unknown): { inTokens: number; outTokens: number } {
  const meta = (
    response as {
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
      };
    }
  )?.usageMetadata;
  return {
    inTokens: meta?.promptTokenCount ?? 0,
    outTokens:
      (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
  };
}

@Injectable()
export class WizardHintService {
  private readonly logger = new Logger(WizardHintService.name);
  private readonly genai: GoogleGenAI | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
    private readonly aiUsage: AiUsageService,
    private readonly guide: WizardGuideService,
    private readonly plan: PlanService,
    private readonly experience: ExperienceService,
    private readonly translation: TranslationService,
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
    // Срез корпуса опыта (§6) читается ДО кеша: его отпечаток входит в
    // ключ, иначе опубликованная запись ждала бы суточного TTL — то
    // есть модерация работала бы с задержкой в день, и никто бы не
    // понял почему.
    const slice = await this.experience.sliceFor(scenario, stepId, locale);
    const key = hintCacheKey({
      scenario,
      stepId,
      locale,
      knowledgeStamp: `${knowledgeStamp()}.${slice.stamp}`,
      digest: digestOfFacts(facts),
    });

    const cached = await this.fromCache(key);
    if (cached) return cached;

    // Личный лимит. Ноль — это НЕ «у вас кончилось»: ноль ставит
    // оператор, когда приостанавливает фичу, и говорить человеку про
    // его лимит там, где лимита нет ни у кого, — вводить в заблуждение.
    const { left, limit } = await this.personalLeft(userId);
    if (limit <= 0) return NOTHING;
    if (left <= 0) return { ...NOTHING, notice: PERSONAL_LIMIT_NOTICE };

    if (!(await this.budgetLeft())) return NOTHING;
    // Блокировка оператора и суточный потолок самого человека — общие
    // для всех платных вызовов, и подсказка не исключение. Своего
    // бюджета фичи для этого мало: он про НАШИ деньги, а блокировка —
    // про решение оператора, и заблокированный аккаунт не должен
    // продолжать тратить. Отказ здесь молчит, как и всё остальное:
    // человек уже видит блокировку там, где она что-то решает.
    if (!(await this.canSpend(userId, projectId))) return NOTHING;
    if (!this.genai) return NOTHING;

    const instruction = buildHintInstruction({
      locale,
      scenarioGoal: hints.goal,
      card,
      facts,
      experience: slice.lines,
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
          // Только таймаут — отмены снаружи здесь нет и не было.
          //
          // Параметр `signal` в сигнатуре был, и его никто никогда не
          // передавал: контроллер вызывает `hint()` четырьмя
          // аргументами (найдено приёмочным проходом §14). Клиент при
          // уходе с шага и снятии галочки рвёт СВОЁ соединение — это
          // про экран, а не про деньги, и `HintLine` прямо об этом
          // говорит: «разрыв соединения его не останавливает».
          //
          // Довести отмену до сервера (слушать `close` запроса) было
          // бы дёшево, но цена ошибки несимметрична: ложная отмена
          // даёт молчание, а молчание у этой фичи НЕОТЛИЧИМО от
          // «нечего сказать» — по замыслу (§5.9). Экономия же — хвост
          // из четырёхсот токенов на брошенной подсказке. Поэтому
          // сервер досчитывает и кладёт ответ в кеш: следующий,
          // вставший на тот же шаг, получит его бесплатно.
          abortSignal: AbortSignal.timeout(HINT_TIMEOUT_MS),
        },
      });
      await this.aiUsage.recordGemini(response, {
        operation: 'wizard-hint',
        model: GEMINI_MODEL,
        userId,
      });
      const usage = usageOf(response);

      const split = splitHintActions(response?.text ?? '');
      const text = cleanHint(split.text);
      if (!text) return NOTHING;

      // Пост-фильтр. Контакты и ключи МАСКИРУЮТСЯ — подсказка при этом
      // остаётся полезной; запрещённое обещание ОТБРАСЫВАЕТСЯ целиком.
      //
      // Ассистент на лендинге так не делает и не может: он стримит, и
      // к моменту проверки текст уже у посетителя (его §5.5 называет
      // это осознанным компромиссом). Советник не стримит — ровно
      // затем, чтобы этим компромиссом не пользоваться. Отбрасывать
      // важно вдвойне: кеш здесь ОБЩИЙ, и одно обещание «безлимита»
      // иначе выдавалось бы всем на этом шаге сутки.
      const masked = maskSensitiveEcho(text);
      const promise = containsForbiddenPromise(masked);
      const flagged = masked !== text || promise;

      if (promise) {
        await this.journal({
          scenario,
          stepId,
          locale,
          source: 'model',
          hint: masked,
          latencyMs: Date.now() - started,
          flagged: true,
          usage,
        });
        return NOTHING;
      }

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
        usage,
      });
      // Накопление локалей (§6.7, этап 11) — ПОСЛЕ того, как подсказка
      // собрана: перевод нужен следующему показу, а не этому, и ждать
      // его, чтобы показать совет, значило бы добавить второй вызов
      // модели в путь, который и так небыстрый.
      await this.fillLocale(slice.needTranslation, locale);
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

  /**
   * Перевести ОДНУ запись за вызов.
   *
   * Одну, а не все: подсказке нужны пять записей, и переводить их разом
   * значило бы пять вызовов модели в одном запросе человека. Ситуации
   * повторяются — за несколько показов локаль заполнится сама, и это
   * ровно тот механизм накопления, ради которого §6.7 и написан.
   */
  private async fillLocale(
    pending: Array<{ id: string; from: ExperienceText }>,
    locale: SupportedLocale,
  ): Promise<void> {
    const next = pending[0];
    if (!next) return;
    await this.translation
      .translate(next.id, locale, next.from)
      .catch(() => false);
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
   * Сами формулировки — в `hint-facts.ts`, рядом с карточками знаний:
   * добавить сценарий в один файл и забыть про другой значит получить
   * ПОСТОЯННЫЙ дайджест, то есть один кеш на всех (см. шапку того
   * файла). Здесь остаётся только чтение из базы.
   */
  private async factsOf(
    scenario: FreeScenario,
    projectId: string,
  ): Promise<string[]> {
    if (scenario === 'CLIENT_SITE') {
      const draft: {
        stepsPerRound: number[];
        title: string | null;
        status: string;
        requiresLiveLoginReplay: boolean;
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
      return factsOfScenario({
        scenario,
        state: draft
          ? {
              rounds: draft.stepsPerRound.length,
              title: draft.title,
              status: draft.status,
              hasCredentials: !!draft.credentialsEnc,
              requiresLiveLoginReplay: draft.requiresLiveLoginReplay,
            }
          : null,
      });
    }

    // Greeting и товарка живут в сессии. Берём последнюю: мастер
    // работает с ней же, а прошлые прогоны к текущему шагу отношения
    // не имеют.
    const row: { status: string; data: unknown; liveData: unknown } | null =
      await this.prisma.session.findFirst({
        where: { projectId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { status: true, data: true, liveData: true },
      });
    const session = row
      ? ({
          ...(row.data as Record<string, unknown>),
          ...(row.liveData as Record<string, unknown>),
          status: row.status,
        } as SessionShape)
      : null;

    if (scenario === 'GREETING_VIDEO') {
      const brief = session?.greetingBriefSnapshot;
      return factsOfScenario({
        scenario,
        state: session
          ? {
              occasion: brief?.occasion ?? null,
              customOccasionText: brief?.customOccasionText ?? null,
              recipientName: brief?.recipientName ?? null,
              senderName: brief?.senderName ?? null,
              usesAvatar:
                (brief?.resolvedPresenterProvider ??
                  brief?.presenterProvider) === AVATAR_PRESENTER,
              referenceImages: session.greetingReferenceImages?.length ?? 0,
              hasPrompt: !!session.generationPrompt,
              promptFlagged:
                session.generationPrompt?.moderationStatus ===
                ModerationStatus.FLAGGED,
              hasVideo: !!session.generatedVideo,
            }
          : null,
      });
    }

    return factsOfScenario({
      scenario,
      state: session
        ? {
            hasReference: !!session.videoAnalysis,
            analysisComplete: session.videoAnalysis?.status === 'complete',
            onSceneTemplate: usesTemplate(
              session.videoAnalysis?.status,
              session.sceneTemplate?.templateId,
            ),
            hasProductInfo: !!session.productInformation,
            hasProductImage: !!activeProductImage(
              session.productInformation as never,
            )?.pathname,
            promptApproved: !!session.generationPrompt?.approvedAt,
            renderInFlight:
              session.generatedVideo?.status === GenerationStatus.PENDING ||
              session.generatedVideo?.status === GenerationStatus.PROCESSING,
            hasVideo: session.generatedVideo?.status === 'completed',
          }
        : null,
    });
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
        update: {
          hint,
          actions: actions as unknown as object,
          hits: 0,
          // Возраст записи обязан обновиться вместе с ответом. Без этой
          // строки протухший ключ переписывался свежим текстом, но со
          // старой датой — и `fromCache` считал его протухшим СНОВА, то
          // есть после первых суток кеш по этому ключу умирал навсегда
          // и модель звалась на каждый запрос.
          createdAt: new Date(),
        },
      })
      .catch((e: unknown) =>
        this.logger.warn(`кеш подсказки не записан: ${String(e)}`),
      );
  }

  /**
   * Журнал выданных подсказок.
   *
   * Токены и цена заполняются из того же ответа модели, по которому
   * считается расход: пустые колонки, которые ВЫГЛЯДЯТ как данные, —
   * ловушка для следующего экрана админки, который на них обопрётся.
   */
  private async journal(row: {
    scenario: string;
    stepId: string;
    locale: string;
    source: string;
    hint: string;
    latencyMs: number;
    flagged: boolean;
    usage?: { inTokens: number; outTokens: number };
  }): Promise<void> {
    const { usage, ...rest } = row;
    const cost = usage
      ? estimateCost(GEMINI_MODEL, {
          inputTokens: usage.inTokens,
          outputTokens: usage.outTokens,
        }).costMicroUsd
      : 0;
    await this.prisma.wizardHint
      .create({
        data: {
          ...rest,
          inTokens: usage?.inTokens ?? 0,
          outTokens: usage?.outTokens ?? 0,
          costMicroUsd: cost,
        },
      })
      .catch((e: unknown) =>
        this.logger.warn(`журнал подсказок не записан: ${String(e)}`),
      );
  }

  /**
   * Сколько подсказок человеку ещё положено сегодня — и каков сам
   * лимит. Второе значение нужно вызывающему, чтобы отличить «у ВАС
   * кончилось» (говорим) от «лимит нулевой у всех» (молчим).
   */
  private async personalLeft(
    userId: string,
  ): Promise<{ left: number; limit: number }> {
    const limit = await this.numberSetting(
      AI_GUIDE_PERSONAL_LIMIT_KEY,
      DEFAULT_PERSONAL_LIMIT,
    );
    const used = await this.aiUsage.countToday(userId, 'wizard-hint');
    return { left: limit - used, limit };
  }

  /**
   * Общие правила расхода: блокировка оператора и суточный потолок
   * пользователя (а для тестовых аккаунтов — их собственный потолок по
   * сценарию проекта). Отказ — не ошибка маршрута, а причина промолчать.
   */
  private async canSpend(userId: string, projectId: string): Promise<boolean> {
    try {
      await this.plan.assertCanSpendUser(userId, { projectId });
      return true;
    } catch (e) {
      this.logger.log(
        `подсказка не выдана: расход не разрешён (${e instanceof Error ? e.message : String(e)})`,
      );
      return false;
    }
  }

  /** Общий дневной бюджет фичи. Исчерпан — молчим, оператору алерт. */
  private async budgetLeft(): Promise<boolean> {
    const budget = await this.numberSetting(
      AI_GUIDE_BUDGET_KEY,
      DEFAULT_DAILY_BUDGET_MICRO_USD,
    );
    // Сумма по ВСЕМ операциям советника, а не только по подсказкам:
    // иначе «$2 в сутки» перестаёт быть потолком фичи, как только у неё
    // появляется вторая платная операция (аудит волны C).
    const spent = await guideSpentToday(this.aiUsage);
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
