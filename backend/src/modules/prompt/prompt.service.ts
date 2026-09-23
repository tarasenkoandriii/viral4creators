/**
 * Prompt Service
 *
 * Handles text-to-video prompt generation using GPT-5,
 * prompt updates, and basic content moderation.
 */

import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { createGeminiClient } from '../../common/gemini-client';
import { GEMINI_MODEL } from '../../common/gemini-model';
import { v4 as uuidv4 } from 'uuid';
import { SessionService } from '../../common/session.service';
import {
  GenerationPrompt,
  ModerationStatus,
  OnScreenTextMoment,
} from '../../common/types/prompt.types';
import { SessionStatus } from '../../common/types/session.types';
import {
  brandBriefText,
  buildReferencePlan,
  characterBriefText,
  sceneBriefText,
  ReferencePlan,
  grokReferencePromptText,
} from '../../common/reference-plan';
import { relevanceBriefText } from '../relevance/relevance-response';
import {
  extrasBriefText,
  scenesBriefText,
} from '../../common/analysis-selection';
import { voiceoverBriefText } from '../../common/voiceover';
import { findModerationFlags } from '../../common/text-moderation';
import {
  normalizeVoiceMode,
  usesOwnVoice,
  voiceModeBriefText,
} from '../../common/voice-mode';
import { parsePromptResponse } from '../../common/voiceover-script';
import {
  AbVariantDraft,
  parseAbVariantsResponse,
} from '../../common/ab-variant-response';
import { cameraBriefText, normalizeCameraMove } from '../../common/camera-move';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { AiOperation } from '../../common/ai-pricing';
import { PlanService } from '../plan/plan.service';
import { readinessOfSession } from '../../common/wizard-readiness.session';

/**
 * Замок сборки промпта (этап 47, В-2.3): клиентский таймаут вызова —
 * 120 с, замок держится с запасом на умерший экземпляр функции.
 */
const PROMPT_CLAIM_TTL_MS = 3 * 60 * 1000;

export const PROMPT_IN_FLIGHT_MESSAGE =
  'Промпт уже собирается — дождитесь ответа первого запроса.';

/**
 * Разбирает `ApiError`, которую бросает `@google/genai` при отказе
 * Gemini API — подтверждено буквально по реальным логам прода
 * (2026-09-13): `.message` целиком является JSON-строкой вида
 * `{"error":{"code":429,"message":"...","status":"RESOURCE_EXHAUSTED"}}`,
 * не структурированным объектом с отдельными полями `.status`/`.code` —
 * тот SDK устроен иначе, чем `AxiosError`, который эта функция заменяет.
 * Если `error.message` не JSON (сетевой сбой, таймаут, что угодно ещё
 * не в этой форме) — возвращает оба поля `undefined`, не бросает сама.
 */
function parseGeminiApiError(error: unknown): {
  status?: number;
  upstream?: string;
} {
  if (!(error instanceof Error)) return {};
  try {
    const parsed = JSON.parse(error.message) as {
      error?: { code?: number; message?: string };
    };
    return { status: parsed?.error?.code, upstream: parsed?.error?.message };
  } catch {
    return {};
  }
}

/**
 * PromptService generates and manages text-to-video prompts
 */
@Injectable()
export class PromptService {
  private readonly logger = new Logger(PromptService.name);
  private readonly genai: GoogleGenAI;

  // Basic moderation patterns (simple keyword matching for POC)
  constructor(
    private readonly sessionService: SessionService,
    private readonly aiUsage: AiUsageService,
    private readonly plans: PlanService,
  ) {
    // Доп. запрос владельца продукта: генерация промптов (и A/B-варианты,
    // и переписывание сцены для Grok-референсов) переведена с GPT-5 через
    // Laozhang.ai на Gemini — тот же провайдер, что уже настроен и
    // работает для разбора видео/релевантности, чтобы не держать третий
    // отдельный платный аккаунт (найдено по реальному сбою: 403 «квота
    // исчерпана» на аккаунте Laozhang, 2026-09-13). `createGeminiClient()`
    // сам бросит понятную ошибку, если GEMINI_API_KEY не задан — тот же
    // принцип, что уже применяется в AnalysisService/RelevanceService.
    this.genai = createGeminiClient();
  }

  /**
   * Единая точка вызова текстовой модели для всего этого класса — до
   * этой правки каждый из трёх вызовов (`generatePrompt`, A/B-варианты,
   * `rewriteForGrokReferences`) заново собирал `httpClient.post(...)` с
   * похожей, но не идентичной обработкой ошибок. Один общий путь проще
   * держать в курсе того, что провайдер сменился, — не забыть обновить
   * какой-то из трёх при следующей смене.
   */
  private async callTextModel(
    prompt: string,
    options: {
      operation: AiOperation;
      sessionId: string;
      temperature?: number;
      maxOutputTokens?: number;
      /** Просить у Gemini `application/json` напрямую (§ AnalysisService
       * уже делает так же), а не полагаться только на инструкцию в
       * тексте промпта, как это делал GPT-5. */
      json?: boolean;
    },
  ): Promise<string> {
    const response = await this.genai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{ text: prompt }],
      config: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxOutputTokens ?? 4000,
        ...(options.json ? { responseMimeType: 'application/json' } : {}),
      },
    });
    await this.aiUsage.recordGemini(response, {
      operation: options.operation,
      model: GEMINI_MODEL,
      sessionId: options.sessionId,
    });
    return response.text?.trim() ?? '';
  }

  /**
   * Generate a text-to-video prompt using GPT-5
   * Combines video analysis and product information
   *
   * @param sessionId - The session ID
   * @returns Generated prompt with moderation status
   * @throws BadRequestException if session not ready or missing data
   */
  async generatePrompt(sessionId: string): Promise<GenerationPrompt> {
    this.logger.log(`Generating prompt for session ${sessionId}`);
    // ТЗ §25.3: заблокированному платные вызовы запрещены.
    await this.plans.assertCanSpendSession(sessionId);

    // Get session and validate state
    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      throw new BadRequestException('Session not found');
    }

    // Условия читаются ТЕМ ЖЕ списком, что рисует строку «до готового
    // ролика» на экране («Тонкая красная линия» §7.2 п.3). Раньше они
    // жили здесь и только здесь — человек узнавал о них, НАЖАВ кнопку,
    // то есть в конце пути. Тексты отказов остаются прежними: их
    // читают и тесты, и люди.
    const ready = readinessOfSession(session);
    const done = (key: string) =>
      ready.items.find((i) => i.key === key)?.done === true;

    if (!session.videoAnalysis) {
      throw new BadRequestException(
        'Video analysis not complete. Please analyze video first.',
      );
    }

    if (!session.productInformation || !done('product')) {
      throw new BadRequestException(
        'Product information not provided. Please submit product details first.',
      );
    }

    if (!done('analysis')) {
      throw new BadRequestException(
        'Video analysis is not complete. Please wait for analysis to finish.',
      );
    }

    // Этап 47 (В-2.3): у сборки промпта не было замка — повтор после
    // клиентского таймаута оплачивал GPT-5 второй раз. Занимаем работу
    // одним условным UPDATE; проигравшему — 409.
    const claimed = await this.sessionService.claimWork(
      sessionId,
      'prompt',
      PROMPT_CLAIM_TTL_MS,
    );
    if (!claimed) {
      throw new ConflictException(PROMPT_IN_FLIGHT_MESSAGE);
    }

    try {
      // Build prompt generation request
      const analysisText =
        session.videoAnalysis.userEdits || session.videoAnalysis.sceneBreakdown;
      const productName = session.productInformation.productName;
      const productDescription = session.productInformation.productDescription;

      // Spec §10/§12 (Stage 15): active characters — with their replacement
      // text and reference-image numbers — and the brand style guide ride
      // into the prompt-writer's brief. Same plan GenerationService will use
      // to pick the actual images, so the numbers line up.
      const plan = buildReferencePlan(session);
      const characterBrief = characterBriefText(plan);
      const brandBrief = brandBriefText(session.brandManifestSnapshot);
      // Spec §13 (voice-over minimum): language of the spoken lines + build
      // them from the description the user typed/dictated + brand voice.
      const voiceBrief = voiceoverBriefText(
        session.productInformation,
        session.brandManifestSnapshot?.voiceNotes,
      );
      // ТЗ §15.1 (этап 35): если реплики озвучиваем мы, Veo не должен
      // снимать говорящие головы — рассинхрон губ и звука читается как
      // брак, и никакой микс это уже не чинит.
      const voiceMode = normalizeVoiceMode(
        session.brandManifestSnapshot?.voiceMode,
      );
      const voiceModeBrief = voiceModeBriefText(voiceMode);
      const frame = session.originalVideo?.frame?.aspectRatio;
      // ТЗ §29 (этап 46): движение камеры — часть стиля бренда. Просим
      // модель, а не двигаем кадр в ffmpeg: программный зум теряет
      // резкость и выдаёт себя дрожанием на краях. Амплитуда меньше,
      // когда формат неродной: там кадр ещё и обрежут по центру (§16.1),
      // и наезд сужает безопасную зону второй раз.
      const cameraMove = normalizeCameraMove(
        session.brandManifestSnapshot?.cameraMove,
      );
      const cameraBrief = cameraBriefText(cameraMove, frame);
      const frameBrief = frame
        ? `PICTURE FORMAT: the reference is ${frame}${frame === '9:16' ? ' (vertical)' : frame === '16:9' ? ' (horizontal)' : ''}; compose the new video for the same orientation unless told otherwise at generation time.`
        : '';
      const sceneBrief = sceneBriefText(plan);
      // Spec §18.3 (Stage 23): the relevance report's advice — what to bend
      // so the clone speaks to the PRODUCT's buyers — unless switched off.
      const audienceBrief = relevanceBriefText(session.relevance);
      // Spec §19 (Stage 24): scenes the user dropped and the background crowd.
      const scenesBrief = scenesBriefText(
        session.videoAnalysis,
        session.analysisSelection,
      );
      const extrasBrief = extrasBriefText(
        session.videoAnalysis,
        session.analysisSelection,
      );
      const extraSections = [
        scenesBrief,
        characterBrief,
        extrasBrief,
        sceneBrief,
        brandBrief,
        voiceBrief,
        voiceModeBrief,
        cameraBrief,
        frameBrief,
        audienceBrief,
      ]
        .filter(Boolean)
        .map((t) => `\n${t}\n`)
        .join('');

      const userMessage = `You are an expert AI video prompt engineer specializing in Veo 3.1. 
Below is a detailed description of an existing viral UGC video which includes scene breakdown and Dialogue/voiceover.
${analysisText}
${extraSections}
Your task is to analyze all the scenes and generate a single, detailed video generation prompt that Veo could use to recreate the 8-second video but tailored for a product ${productName} ${productDescription}.
Format as: "[Duration] seconds; [Camera style/lens]. [Subject + action]. Characters: [each kept character with appearance; say "match reference image N" where a reference image exists]. Aesthetic: [visual style]. Camera movement: [specific movements]. Pacing: [fast/medium/slow with rhythm description]. Colors: [palette]. Audio: [music/sound style]. Text overlay: [if needed — a SHORT text (under 100 characters, e.g. a price, a short call-to-action, or the brand name alone) written out VERBATIM, character-for-character, in the dialogue language, and explicitly state it must appear on screen exactly as written, with no other words or numbers substituted; video models frequently misrender on-screen text, especially non-Latin scripts, so shorter and simpler text renders far more reliably than a full sentence]. Dialogue: [spoken lines written out verbatim in the required language, built from the product description, following the reference's rhythm]. End with: [CTA visual and audio].

Please respond with a valid JSON object only, with two keys:
- "prompt": the complete, ready-to-use prompt for text-to-video generation, without any conversational filler.
- "voiceoverScript": ONLY the spoken lines, in the dialogue language, in order, one line per beat, with no scene numbers, no timecodes and no speaker labels. This text is read out loud by a separate narrator, so write exactly what should be heard and nothing else. Keep it short enough to be spoken calmly within the clip's duration.${
        usesOwnVoice(voiceMode)
          ? '\nThe voiceoverScript is what will actually be voiced, so it carries the whole message — the video itself has no spoken words.'
          : ''
      }
`;

      // Доп. запрос владельца продукта: переведено с GPT-5/Laozhang.ai на
      // Gemini (см. доккомментарий конструктора) — `callTextModel` сам
      // просит `application/json`, что надёжнее словесной инструкции
      // ниже, которую раньше приходилось давать GPT-5 текстом.
      const generatedText = await this.callTextModel(userMessage, {
        operation: 'prompt',
        sessionId,
        temperature: 0.7,
        maxOutputTokens: 4000,
        json: true,
      });

      if (!generatedText) {
        this.logger.error(
          `Empty response from Gemini for session ${sessionId}`,
        );
        throw new Error(
          'Gemini returned an empty response. This may be due to content filtering or API issues.',
        );
      }

      // ТЗ §15.2: разбор терпимый — модель то оборачивает объект в
      // ```json, то забывает второй ключ. Строгий разбор означал бы «нет
      // озвучки» на ровном месте, поэтому при отсутствии поля реплики
      // достаются из самого промпта.
      const parts = parsePromptResponse(generatedText);
      if (parts.source === 'none' && usesOwnVoice(voiceMode)) {
        this.logger.warn(
          `сессия ${sessionId}: режим озвучки «${voiceMode}», но реплик в ответе модели нет — текст придётся написать вручную`,
        );
      }

      // Дальше живёт РАЗОБРАННЫЙ промпт, а не сырой ответ (Б-2.1).
      //
      // С этапа 35 модель просят ответить объектом с двумя ключами, и
      // `parsePromptResponse` их достаёт. Но в сессию клался
      // `generatedText` — то есть весь JSON целиком, вместе с ключами и
      // экранированными переводами строк. Пользователь редактировал эту
      // обёртку руками, а в Veo — самый дорогой вызов сервиса — уходила
      // строка вида `{"prompt": "8 seconds; …"}`; в режимах со своей
      // озвучкой реплики уезжали в Veo вторым экземпляром.
      //
      // Когда модель отвечает не объектом, `parts.prompt` — это тот же
      // сырой текст (см. `parsePromptResponse`), так что старый путь
      // сохраняется без изменений.
      const promptText = parts.prompt;

      // Модерация смотрит на то, что действительно уйдёт в Veo.
      const moderation = this.moderateContent(promptText);

      // Доп. запрос владельца продукта (ТЗ §20.2, оживление никогда не
      // сделанного Этапа 3 из §8.5 п.1) — отдельный, дешёвый вызов
      // ПОСЛЕ основного промпта, не вместо него. Best-effort: сбой
      // здесь не должен ронять уже готовый и оплаченный основной
      // промпт — тот же принцип отказоустойчивости, что уже применён
      // в `rewriteForGrokReferences()`.
      const onScreenTextMoments = await this.extractLiteralTexts(
        promptText,
        sessionId,
      );

      // Create prompt object
      const prompt: GenerationPrompt = {
        promptId: uuidv4(),
        generatedText: promptText,
        finalText: promptText,
        characterCount: promptText.length,
        generatedAt: new Date(),
        moderationStatus: moderation.status,
        moderationFlags: moderation.flags,
        voiceoverScript: parts.script ?? undefined,
        finalVoiceoverScript: parts.script ?? undefined,
        voiceoverScriptSource: parts.source,
        // В-1.9 (этап 120): под что писался текст. Формат кадра выберут
        // позже, и амплитуду наезда придётся поправлять — поправлять
        // надо ОТ ЭТОГО, а не от того, что окажется в снимке манифеста
        // к моменту генерации (его можно сменить между шагами).
        cameraBriefFor: { aspectRatio: frame ?? null, move: cameraMove },
        // `null` (сбой) и `[]` (текста нет) равнозначны здесь — это
        // ПЕРВОЕ извлечение, прежних моментов, которые стоило бы
        // сохранить при сбое, ещё не существует (в отличие от
        // `updatePrompt()` ниже).
        ...(onScreenTextMoments?.length ? { onScreenTextMoments } : {}),
      };

      // Передаём ТОЛЬКО затронутые ключи, а не весь прочитанный снимок
      // (этап 39, А-2.3). Оговорка (Б-1.10): `updateSession` всё равно
      // перезаписывает колонку `data` целиком — он перечитывает сессию
      // сам и сливает патч с ней. Смысл правки в том, что окно между
      // чтением и записью сжалось со 120 секунд (таймаут GPT-5) до
      // миллисекунд; полностью гонку это НЕ закрывает — для этого нужен
      // `jsonb_set` по ключу, как в `claimPostProduction`.
      //
      // Между чтением сессии в начале метода и этой строкой проходит до
      // 120 секунд — столько отведено GPT-5. Всё, что пользователь
      // изменил за это время на том же экране (снял галочку «учитывать
      // релевантность», запустил платную перепроверку Gemini),
      // откатывалось бы без следа: сюда уезжал бы снимок минутной
      // давности.
      await this.sessionService.updateSession(sessionId, {
        generationPrompt: prompt,
        status: SessionStatus.PROMPT_GENERATED,
      });

      this.logger.log(
        `Prompt generated successfully for session ${sessionId} (${promptText.length} chars)`,
      );

      return prompt;
    } catch (error) {
      this.logger.error(
        `Failed to generate prompt for session ${sessionId}`,
        error,
      );

      // Этап 54 (Б-3.6): текст ответа апстрима — в лог (выше), клиенту —
      // класс сбоя и код. Раньше здесь разбирался AxiosError от
      // Laozhang.ai; при переходе на Gemini (`@google/genai`) выяснилось,
      // что этот SDK кидает не AxiosError, а свой `ApiError`, у которого
      // `.message` — это ЦЕЛИКОМ JSON-строка вида
      // `{"error":{"code":429,"message":"...","status":"RESOURCE_EXHAUSTED"}}`
      // — подтверждено буквально по реальным логам прода (2026-09-13,
      // тот самый 404 на gemini-2.5-flash и 429 на исчерпанных кредитах),
      // не догадкой по документации.
      const { status, upstream } = parseGeminiApiError(error);
      if (upstream) {
        this.logger.error(`ответ сервиса ИИ (${status}): ${upstream}`);
      }

      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('timeout') || message.includes('ECONNABORTED')) {
        throw new BadRequestException(
          'Сервис ИИ отвечал слишком долго. Попробуйте ещё раз.',
        );
      } else if (status === 401 || status === 403) {
        throw new BadRequestException(
          'Ключ сервиса ИИ не принят. Сообщите оператору.',
        );
      } else if (status === 429) {
        throw new BadRequestException(
          'Сервис ИИ ограничил частоту запросов. Попробуйте через минуту.',
        );
      } else if (status) {
        throw new BadRequestException(
          `Не удалось составить бриф: сервис ИИ ответил ошибкой (код ${status}). Попробуйте ещё раз.`,
        );
      }

      // Не сетевая ошибка (пустой ответ модели, неожиданная форма JSON):
      // подробности уже в логе, клиенту — что делать.
      throw new BadRequestException(
        'Не удалось составить бриф: ответ сервиса ИИ не удалось разобрать. Попробуйте ещё раз.',
      );
    } finally {
      await this.sessionService.releaseWork(sessionId, 'prompt');
    }
  }

  /**
   * A/B-варианты одного ролика (TODO §III.6, этап 66). Один вызов GPT-5,
   * который сразу пишет `count` альтернативных промптов на основе УЖЕ
   * одобренного промпта данной сессии — раскадровка, камера, персонажи,
   * темп и цвет остаются теми же (та же бриф-сборка, что у
   * `generatePrompt`, переиспользуется целиком), меняются только хук
   * (открывающие секунды) и CTA (закрывающий бит).
   *
   * Ничего не пишет в саму сессию — вызывающий код (`AbTestService.create`)
   * решает, куда положить каждый вариант (через `seedPrompt` ниже, на
   * дочерние сессии, которые ещё предстоит создать воркеру).
   *
   * @param sessionId - сессия с уже одобренным промптом (источник стиля)
   * @param count - сколько вариантов запросить (этап 66: всегда 3)
   */
  async generateAbVariants(
    sessionId: string,
    count: number,
  ): Promise<AbVariantDraft[]> {
    this.logger.log(
      `Generating ${count} A/B variants for session ${sessionId}`,
    );
    await this.plans.assertCanSpendSession(sessionId);

    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      throw new BadRequestException('Session not found');
    }
    if (!session.videoAnalysis || session.videoAnalysis.status !== 'complete') {
      throw new BadRequestException(
        'Video analysis is not complete. Please analyze video first.',
      );
    }
    if (!session.productInformation) {
      throw new BadRequestException('Product information not provided.');
    }
    if (!session.generationPrompt?.finalText) {
      throw new BadRequestException(
        'У сессии нет одобренного промпта — A/B-варианты собираются только поверх уже готового ролика.',
      );
    }

    // Отдельный вид работы от 'prompt' — сборка вариантов не должна ни
    // блокироваться, ни блокировать обычное редактирование промпта той
    // же сессии, это разные по смыслу действия.
    const claimed = await this.sessionService.claimWork(
      sessionId,
      'ab-variants',
      PROMPT_CLAIM_TTL_MS,
    );
    if (!claimed) {
      throw new ConflictException(
        'Сборка A/B-вариантов уже идёт — дождитесь ответа первого запроса.',
      );
    }

    try {
      const analysisText =
        session.videoAnalysis.userEdits || session.videoAnalysis.sceneBreakdown;
      const productName = session.productInformation.productName;
      const productDescription = session.productInformation.productDescription;

      // Та же бриф-сборка, что у generatePrompt (строки выше) — чистые
      // экспортируемые функции, безопасно вызвать второй раз тем же
      // способом.
      const plan = buildReferencePlan(session);
      const characterBrief = characterBriefText(plan);
      const brandBrief = brandBriefText(session.brandManifestSnapshot);
      const voiceMode = normalizeVoiceMode(
        session.brandManifestSnapshot?.voiceMode,
      );
      const voiceModeBrief = voiceModeBriefText(voiceMode);
      const frame = session.originalVideo?.frame?.aspectRatio;
      const cameraMove = normalizeCameraMove(
        session.brandManifestSnapshot?.cameraMove,
      );
      const cameraBrief = cameraBriefText(cameraMove, frame);
      const sceneBrief = sceneBriefText(plan);
      const audienceBrief = relevanceBriefText(session.relevance);
      const scenesBrief = scenesBriefText(
        session.videoAnalysis,
        session.analysisSelection,
      );
      const extrasBrief = extrasBriefText(
        session.videoAnalysis,
        session.analysisSelection,
      );
      const extraSections = [
        scenesBrief,
        characterBrief,
        extrasBrief,
        sceneBrief,
        brandBrief,
        voiceModeBrief,
        cameraBrief,
        audienceBrief,
      ]
        .filter(Boolean)
        .map((t) => `\n${t}\n`)
        .join('');

      const baseVoiceover =
        session.generationPrompt.finalVoiceoverScript ??
        session.generationPrompt.voiceoverScript ??
        '';

      const userMessage = `You are an expert AI video prompt engineer specializing in Veo 3.1.
Below is the reference analysis, and the prompt already approved and used to generate the CURRENT video for product ${productName} ${productDescription}:
${analysisText}
${extraSections}
Currently approved prompt:
${session.generationPrompt.finalText}
${baseVoiceover ? `\nIts voiceover script:\n${baseVoiceover}\n` : ''}
Your task: write exactly ${count} ALTERNATIVE versions of this SAME prompt, each a complete, ready-to-use Veo prompt in the same format as the one above ("[Duration] seconds; [Camera style/lens]. [Subject + action]. Characters: [...]. Aesthetic: [...]. Camera movement: [...]. Pacing: [...]. Colors: [...]. Audio: [...]. Text overlay: [...]. Dialogue: [...]. End with: [CTA visual and audio]."). Keep the storyboard body — scenes, characters, camera movement, pacing, colors, aesthetic — IDENTICAL across all ${count} versions and identical to the currently approved prompt. Change ONLY two things per version: (a) the opening hook — the first 1-2 seconds of action/dialogue that grabs attention, and (b) the closing call-to-action beat (visual + spoken line). Make the ${count} versions clearly distinct from each other and from the currently approved prompt in hook angle and CTA angle (e.g. a question vs a bold claim vs a relatable-problem hook; a discount vs urgency vs social-proof CTA) — do not just reword the same idea ${count} times.

Please respond with a valid JSON object only, with one key "variants": an array of exactly ${count} objects, each with four keys:
- "hookLabel": a short (3-6 word) label IN RUSSIAN describing this variant's hook angle, for a comparison screen (e.g. "Хук: провокационный вопрос").
- "ctaLabel": a short (3-6 word) label IN RUSSIAN describing this variant's CTA angle (e.g. "CTA: скидка 20% сегодня").
- "prompt": the complete, ready-to-use alternate prompt for text-to-video generation, without any conversational filler.
- "voiceoverScript": ONLY the spoken lines for THIS variant, in the dialogue language, in order, one line per beat, with no scene numbers, no timecodes and no speaker labels.${
        usesOwnVoice(voiceMode)
          ? '\nThe voiceoverScript is what will actually be voiced, so it carries the whole message — the video itself has no spoken words.'
          : ''
      }
`;

      // ТЗ §26 — та же учётная запись, что у обычной сборки промпта, но
      // отдельной операцией ('ab-variants', common/ai-pricing.ts) — иной
      // профиль по токенам, должна быть видна в отчёте расходов отдельно.
      const generatedText = await this.callTextModel(userMessage, {
        operation: 'ab-variants',
        sessionId,
        temperature: 0.8,
        maxOutputTokens: 6000,
        json: true,
      });

      if (!generatedText) {
        this.logger.error(
          `Empty response from Gemini for A/B variants, session ${sessionId}`,
        );
        throw new Error(
          'Gemini returned an empty response. This may be due to content filtering or API issues.',
        );
      }

      const drafts = parseAbVariantsResponse(generatedText);
      if (drafts.length < count) {
        this.logger.warn(
          `Session ${sessionId}: requested ${count} A/B variants, model returned ${drafts.length} usable`,
        );
      }

      this.logger.log(
        `A/B variants generated for session ${sessionId}: ${drafts.length} usable of ${count} requested`,
      );

      return drafts.slice(0, count);
    } catch (error) {
      this.logger.error(
        `Failed to generate A/B variants for session ${sessionId}`,
        error,
      );

      // Тот же разбор, что у generatePrompt выше — см. доккомментарий
      // parseGeminiApiError за подтверждением по реальным логам прода.
      const { status, upstream } = parseGeminiApiError(error);
      if (upstream) {
        this.logger.error(`ответ сервиса ИИ (${status}): ${upstream}`);
      }

      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('timeout') || message.includes('ECONNABORTED')) {
        throw new BadRequestException(
          'Сервис ИИ отвечал слишком долго. Попробуйте ещё раз.',
        );
      } else if (status === 401 || status === 403) {
        throw new BadRequestException(
          'Ключ сервиса ИИ не принят. Сообщите оператору.',
        );
      } else if (status === 429) {
        throw new BadRequestException(
          'Сервис ИИ ограничил частоту запросов. Попробуйте через минуту.',
        );
      } else if (status) {
        throw new BadRequestException(
          `Не удалось собрать A/B-варианты: сервис ИИ ответил ошибкой (код ${status}). Попробуйте ещё раз.`,
        );
      }

      throw new BadRequestException(
        'Не удалось собрать A/B-варианты: ответ сервиса ИИ не удалось разобрать. Попробуйте ещё раз.',
      );
    } finally {
      await this.sessionService.releaseWork(sessionId, 'ab-variants');
    }
  }

  /**
   * Пишет уже готовый (не сгенерированный здесь) текст промпта в сессию
   * — без обращения к GPT-5. Нужен для A/B-вариантов (этап 66): текст
   * всех вариантов уже получен ОДНИМ вызовом `generateAbVariants` при
   * создании запуска, и воркеру, который сажает каждый вариант в свою
   * дочернюю сессию, незачем платить за GPT-5 второй раз.
   *
   * В отличие от `updatePrompt`, работает и на сессии, где
   * `generationPrompt` ещё нет вовсе (свежесозданная дочерняя сессия) —
   * строит объект с нуля, тем же способом, что хвост `generatePrompt`.
   */
  async seedPrompt(
    sessionId: string,
    text: string,
    voiceoverScript?: string | null,
    /**
     * Под что писался ИСХОДНЫЙ текст (В-1.9, этап 120). Засеянная
     * сессия своего референса не имеет вовсе, и без этого поправка
     * амплитуды на шаге генерации считалась бы от `undefined` — то
     * есть всегда «как для неродного формата», хотя родитель мог быть
     * снят под родной. Экспорт яруса B — ровно тот случай, где формат
     * выбирают ПОСЛЕ написания промпта, ради чего В-1.9 и заведена.
     */
    cameraBriefFor?: GenerationPrompt['cameraBriefFor'],
  ): Promise<GenerationPrompt> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      throw new BadRequestException('Session not found');
    }

    // Модерация смотрит на то, что действительно уйдёт в Veo — тот же
    // приём, что у generatePrompt/updatePrompt.
    const moderation = this.moderateContent(text);
    const script = voiceoverScript?.trim() || undefined;

    const prompt: GenerationPrompt = {
      promptId: uuidv4(),
      generatedText: text,
      finalText: text,
      characterCount: text.length,
      generatedAt: new Date(),
      moderationStatus: moderation.status,
      moderationFlags: moderation.flags,
      voiceoverScript: script,
      finalVoiceoverScript: script,
      voiceoverScriptSource: script ? 'field' : 'none',
      ...(cameraBriefFor ? { cameraBriefFor } : {}),
    };

    await this.sessionService.updateSession(sessionId, {
      generationPrompt: prompt,
      status: SessionStatus.PROMPT_GENERATED,
    });

    this.logger.log(
      `Prompt seeded for session ${sessionId} (${text.length} chars, no GPT-5 call)`,
    );

    return prompt;
  }

  /**
   * Update an existing prompt with user edits
   *
   * @param sessionId - The session ID
   * @param editedText - User's edited prompt text
   * @returns Updated prompt
   * @throws BadRequestException if session not found or no prompt exists
   */
  async updatePrompt(
    sessionId: string,
    editedText: string,
    editedVoiceoverScript?: string,
  ): Promise<GenerationPrompt> {
    this.logger.log(`Updating prompt for session ${sessionId}`);

    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      throw new BadRequestException('Session not found');
    }

    if (!session.generationPrompt) {
      throw new BadRequestException(
        'No prompt exists. Please generate a prompt first.',
      );
    }

    // Run moderation on edited text
    const moderation = this.moderateContent(editedText);

    // Update prompt
    session.generationPrompt.userEditedText = editedText;
    session.generationPrompt.finalText = editedText;
    session.generationPrompt.characterCount = editedText.length;
    session.generationPrompt.moderationStatus = moderation.status;
    session.generationPrompt.moderationFlags = moderation.flags;
    session.generationPrompt.approvedAt = undefined; // Reset approval if edited

    // ТЗ §15.2: текст озвучки правится отдельно от промпта — это разные
    // тексты для разных читателей. Не переданный текст не трогаем: иначе
    // правка промпта молча стирала бы выверенные реплики.
    //
    // Пустая строка — это НЕ «не передано», а «пользователь стёр реплики»,
    // и хранить её надо именно пустой строкой (этап 37, А-2.5). Свернуть
    // её в `undefined` значило бы откатиться к тексту, который написал
    // GPT: пользователь читает подсказку «пусто — ролик останется со
    // звуком модели», стирает реплики и получает ролик, озвученный ровно
    // тем, что он только что удалил, — и платит за этот синтез.
    if (editedVoiceoverScript !== undefined) {
      const trimmed = editedVoiceoverScript.trim();
      session.generationPrompt.voiceoverScriptEdited = trimmed;
      session.generationPrompt.finalVoiceoverScript = trimmed;
    }

    // Найдено при повторном аудите §20: без этого `onScreenTextMoments`
    // (§20.2) навсегда оставался бы таким, каким его извлекли из ПЕРВОЙ
    // версии промпта — правка текста здесь никогда не отражалась бы в
    // текстовых карточках, и хэш в `TextCardService` не смог бы
    // обнаружить расхождение (нечему было бы измениться).
    //
    // `result === null` — сбой вызова, не «текста теперь нет»: тогда
    // СОХРАНЯЕМ прежние моменты (и уже отрендеренные для них
    // text-card) вместо того, чтобы стереть их транзиентной ошибкой.
    const result = await this.extractLiteralTexts(editedText, sessionId);
    if (result !== null) {
      session.generationPrompt.onScreenTextMoments = result;
    }

    // Только промпт — по той же причине, что выше (А-2.3).
    await this.sessionService.updateSession(sessionId, {
      generationPrompt: session.generationPrompt,
    });

    this.logger.log(
      `Prompt updated for session ${sessionId} (${editedText.length} chars)`,
    );

    return session.generationPrompt;
  }

  /**
   * Approve a prompt for video generation
   *
   * @param sessionId - The session ID
   * @returns Approved prompt
   * @throws BadRequestException if session not found or no prompt exists
   */
  async approvePrompt(sessionId: string): Promise<GenerationPrompt> {
    this.logger.log(`Approving prompt for session ${sessionId}`);

    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      throw new BadRequestException('Session not found');
    }

    if (!session.generationPrompt) {
      throw new BadRequestException(
        'No prompt exists. Please generate a prompt first.',
      );
    }

    // Mark as approved
    session.generationPrompt.approvedAt = new Date();

    // If flagged, mark as bypassed (user explicitly approved)
    if (
      session.generationPrompt.moderationStatus === ModerationStatus.FLAGGED
    ) {
      session.generationPrompt.moderationStatus = ModerationStatus.BYPASSED;
    } else if (
      session.generationPrompt.moderationStatus === ModerationStatus.PENDING
    ) {
      session.generationPrompt.moderationStatus = ModerationStatus.APPROVED;
    }

    await this.sessionService.updateSession(sessionId, {
      generationPrompt: session.generationPrompt,
    });

    this.logger.log(`Prompt approved for session ${sessionId}`);

    return session.generationPrompt;
  }

  /**
   * Публичная обёртка над `moderateContent` — единственная причина её
   * существования: `GreetingPromptService` (GREETING_VIDEO, ТЗ
   * TZ-Greeting-Video-Project-Type.md) собирает промпт своим отдельным
   * конвейером (нет `ProductInformation`/`videoAnalysis`, см. её
   * doc-comment), но текст, который реально уходит в рендер, обязан
   * проходить ту же проверку, что и у SINGLE/LINE — не отдельную свою и
   * не отсутствующую вовсе (найдено при аудите пайплайна GREETING_VIDEO,
   * находка №2: до этой правки `moderationStatus` там был жёстко
   * `APPROVED` без единого вызова модерации).
   */
  moderateText(text: string): { status: ModerationStatus; flags: string[] } {
    return this.moderateContent(text);
  }

  /**
   * Ключевой фильтр текста.
   *
   * До 23.09.2026 здесь лежали четыре английские регулярки со `\b`. У
   * продукта, где половина аудитории пишет по-русски и по-украински,
   * это значило, что гейт не ловит почти ничего, — а на него опирается
   * отказ рендерить поздравление (`GreetingVideoService.startVideo`
   * не пускает `FLAGGED` дальше).
   *
   * Сам список и разбор переехали в `common/text-moderation.ts`:
   * чистый модуль тестируется без контейнера, и там же объяснено,
   * почему насилие ловится адресованной угрозой, а не словом
   * «смерть» (иначе блокировались бы соболезнования — отдельный повод
   * этого продукта).
   *
   * Это по-прежнему дешёвый первый гейт, а не модерация. Настоящий
   * ответ — модерационный API или вызов модели, он стоит денег на
   * каждом промпте и потому остаётся решением владельца.
   */
  private moderateContent(text: string): {
    status: ModerationStatus;
    flags: string[];
  } {
    const flags = findModerationFlags(text);
    const status =
      flags.length > 0 ? ModerationStatus.FLAGGED : ModerationStatus.PENDING;
    return { status, flags };
  }

  /**
   * Оживление никогда не сделанного Этапа 3 (§8.5 п.1 ТЗ) — по
   * прямому запросу для §20.2 (text-card): отдельный, дешёвый вызов
   * той же `GEMINI_MODEL`, что и весь остальной класс, ПОСЛЕ основной
   * сборки промпта — вычленяет из уже готового `Text overlay: [...]`
   * до трёх отдельных текстовых моментов по ролям (hook/callout/cta).
   *
   * Не пытается угадывать роли для сцен, где текста на экране нет
   * вовсе — модель прямо просят вернуть пустой массив в этом случае,
   * не выдумывать текст, которого не было в промпте.
   *
   * Отказоустойчиво, как и `rewriteForGrokReferences` ниже: любая
   * ошибка — лог и пустой массив, не падение уже готового и
   * оплаченного основного промпта.
   */
  private async extractLiteralTexts(
    promptText: string,
    sessionId: string,
  ): Promise<OnScreenTextMoment[] | null> {
    try {
      const raw = await this.callTextModel(
        `Below is a complete video generation prompt for an 8-second UGC ad. Find every distinct piece of ON-SCREEN TEXT it describes (the "Text overlay" field or any other mention of text/words appearing visually in the frame — NOT spoken dialogue, NOT scene descriptions). For each one, classify its role: "hook" (an opening line/slogan shown early), "callout" (a mid-video detail like a price, discount, or feature), or "cta" (a closing call-to-action, e.g. a website, promo code, or "order now"). If the prompt describes NO on-screen text at all, return an empty array — do not invent text that isn't there. Each text must be ≤100 characters, verbatim from the prompt (do not paraphrase or translate it).\n\nPrompt:\n${promptText}\n\nRespond with a valid JSON object only: {"moments": [{"text": "...", "role": "hook" | "callout" | "cta"}, ...]}`,
        {
          // Найдено при аудите: раньше было 'prompt' — та же логика,
          // что уже развела 'grok-reference-rewrite' отдельно от
          // 'prompt' (§15.3 ТЗ), сюда не была применена с первого
          // раза. Отдельная строка расхода, не слитая с основной
          // сборкой промпта.
          operation: 'text-extraction',
          sessionId,
          temperature: 0.2,
          maxOutputTokens: 500,
          json: true,
        },
      );
      // Пустой ответ модели — не то же самое, что «сбой вызова»: сеть и
      // модель отработали, просто без содержимого. Это генуинный
      // результат «текста нет», не повод хранить старые моменты.
      if (!raw) return [];
      const parsed = JSON.parse(raw) as { moments?: unknown };
      if (!Array.isArray(parsed.moments)) return [];
      const validRoles = new Set(['hook', 'callout', 'cta']);
      return (
        parsed.moments
          .filter(
            (m): m is OnScreenTextMoment =>
              !!m &&
              typeof m === 'object' &&
              typeof (m as OnScreenTextMoment).text === 'string' &&
              (m as OnScreenTextMoment).text.length > 0 &&
              (m as OnScreenTextMoment).text.length <= 100 &&
              validRoles.has((m as OnScreenTextMoment).role),
          )
          // Не больше одной карточки на роль (§20.4 п.1 предполагает
          // ровно три возможных слота, не больше) — если модель вернула
          // дубликаты роли, оставляем первую.
          .filter((m, i, arr) => arr.findIndex((x) => x.role === m.role) === i)
      );
    } catch (error) {
      // Найдено при повторном аудите §20 (правка `updatePrompt()`,
      // вызывающей этот метод повторно): `null`, не `[]` — сбой сети/
      // модели должен ОТЛИЧАТЬСЯ от «текста на экране нет» genuinely.
      // Иначе транзиентная ошибка при правке промпта тихо стёрла бы
      // уже успешно отрендеренные text-card с прошлого извлечения —
      // вызывающий код обязан на `null` СОХРАНИТЬ прежние моменты, не
      // затирать их пустым массивом.
      this.logger.warn(
        `extractLiteralTexts: вызов не удался (${error instanceof Error ? error.message : String(error)}) — сессия ${sessionId} продолжит без text-card`,
      );
      return null;
    }
  }

  /**
   * Доп. запрос владельца продукта: реализация улучшения из ТЗ §15.3 —
   * `grokReferencePromptText()` (`common/reference-plan.ts`) добавляет
   * список «Reference <IMAGE_N> shows …» ПОСЛЕ текста сцены, который
   * написан для Veo и ничего не знает про метки Grok. Официальная
   * конвенция xAI хочет метки ВНУТРИ действия («they wear the shirt
   * from <IMAGE_2>») — это и делает этот метод: узкий, точный
   * переписывающий шаг (не творческий — сцена уже придумана, здесь
   * только вплетаются метки). Изначально этот шаг звал отдельную,
   * более дешёвую модель (`OPENAI_FAST_MODEL`) — с переходом на Gemini
   * (по прямому запросу, 2026-09-13, см. доккомментарий конструктора)
   * зовёт тот же `GEMINI_MODEL`, что и остальные два вызова этого
   * класса — отдельной "быстрой" модели под Gemini не заводили, раз
   * все три вызова уже используют одну и ту же.
   *
   * Отказоустойчиво: любая ошибка (сеть, модель отказала, пустой
   * ответ) — лог и откат на `grokReferencePromptText()` (то же
   * приближение, что было раньше) — генерация не должна падать из-за
   * необязательного шага косметики промпта.
   */
  async rewriteForGrokReferences(
    sceneText: string,
    plan: ReferencePlan,
    sessionId: string,
  ): Promise<string> {
    if (plan.images.length === 0) return sceneText;

    const fallback = () =>
      [sceneText, grokReferencePromptText(plan)].filter(Boolean).join('\n');

    const refDescriptions = plan.images
      .map((i) => {
        const what =
          i.kind === 'character'
            ? `the person "${i.label}"`
            : i.kind === 'scene'
              ? `the location/set "${i.label}"`
              : `the actual product "${i.label}"`;
        return `<IMAGE_${i.index}> = ${what}`;
      })
      .join('; ');

    try {
      const rewritten = await this.callTextModel(
        `Rewrite the following video scene description so that each reference image is mentioned NATURALLY, INSIDE the action it belongs to — the same way a director's shot list would cite reference photos — using the exact tag syntax <IMAGE_N>. Reference tags and what they show: ${refDescriptions}. Do not add a separate list of references at the end — weave each tag into the sentence describing what that character/product/location does or looks like in the scene. Keep everything else about the scene (camera, pacing, dialogue, on-screen text) unchanged. Return ONLY the rewritten scene text, nothing else.\n\nScene:\n${sceneText}`,
        {
          operation: 'grok-reference-rewrite',
          sessionId,
          temperature: 0.3,
          maxOutputTokens: 2000,
        },
      );

      if (!rewritten) {
        this.logger.warn(
          'rewriteForGrokReferences: пустой ответ модели — откат на grokReferencePromptText',
        );
        return fallback();
      }
      return rewritten;
    } catch (error) {
      this.logger.warn(
        `rewriteForGrokReferences: вызов не удался (${error instanceof Error ? error.message : String(error)}) — откат на grokReferencePromptText`,
      );
      return fallback();
    }
  }
}
