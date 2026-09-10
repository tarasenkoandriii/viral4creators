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
import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { SessionService } from '../../common/session.service';
import {
  GenerationPrompt,
  ModerationStatus,
} from '../../common/types/prompt.types';
import { SessionStatus } from '../../common/types/session.types';
import {
  brandBriefText,
  buildReferencePlan,
  characterBriefText,
  sceneBriefText,
} from '../../common/reference-plan';
import { relevanceBriefText } from '../relevance/relevance-response';
import {
  extrasBriefText,
  scenesBriefText,
} from '../../common/analysis-selection';
import { voiceoverBriefText } from '../../common/voiceover';
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
import { loadConfiguration } from '../../config/configuration';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { PlanService } from '../plan/plan.service';

/**
 * Замок сборки промпта (этап 47, В-2.3): клиентский таймаут вызова —
 * 120 с, замок держится с запасом на умерший экземпляр функции.
 */
const PROMPT_CLAIM_TTL_MS = 3 * 60 * 1000;

export const PROMPT_IN_FLIGHT_MESSAGE =
  'Промпт уже собирается — дождитесь ответа первого запроса.';

/**
 * PromptService generates and manages text-to-video prompts
 */
@Injectable()
export class PromptService {
  private readonly logger = new Logger(PromptService.name);
  private readonly httpClient: AxiosInstance;
  private readonly gptModel: string;

  // Basic moderation patterns (simple keyword matching for POC)
  private readonly moderationPatterns = [
    /\b(violence|violent|kill|death|blood|gore)\b/i,
    /\b(explicit|sexual|nude|nudity|porn)\b/i,
    /\b(hate|racist|discrimination|offensive)\b/i,
    /\b(illegal|drugs|weapon|bomb)\b/i,
  ];

  private readonly moderationCategories = [
    'violence',
    'sexual-content',
    'hate-speech',
    'illegal-content',
  ];

  constructor(
    private readonly sessionService: SessionService,
    private readonly aiUsage: AiUsageService,
    private readonly plans: PlanService,
  ) {
    // Get OpenAI/laozhang.ai configuration from centralized config
    const config = loadConfiguration();
    const apiKey = config.openai.apiKey;
    const baseUrl = config.openai.baseUrl;
    this.gptModel = config.openai.gptModel;

    if (!apiKey) {
      throw new Error(
        'OPENAI_API_KEY or LAOZHANG_API_KEY environment variable is required',
      );
    }

    // Initialize axios client for laozhang.ai API
    this.httpClient = axios.create({
      baseURL: baseUrl,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: 120000, // 120 second timeout for GPT-5 (prompt generation can be slow)
    });
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

    if (!session.videoAnalysis) {
      throw new BadRequestException(
        'Video analysis not complete. Please analyze video first.',
      );
    }

    if (!session.productInformation) {
      throw new BadRequestException(
        'Product information not provided. Please submit product details first.',
      );
    }

    if (session.videoAnalysis.status !== 'complete') {
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
      const cameraBrief = cameraBriefText(
        normalizeCameraMove(session.brandManifestSnapshot?.cameraMove),
        frame,
      );
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
Format as: "[Duration] seconds; [Camera style/lens]. [Subject + action]. Characters: [each kept character with appearance; say "match reference image N" where a reference image exists]. Aesthetic: [visual style]. Camera movement: [specific movements]. Pacing: [fast/medium/slow with rhythm description]. Colors: [palette]. Audio: [music/sound style]. Text overlay: [if needed, in the dialogue language]. Dialogue: [spoken lines written out verbatim in the required language, built from the product description, following the reference's rhythm]. End with: [CTA visual and audio].

Please respond with a valid JSON object only, with two keys:
- "prompt": the complete, ready-to-use prompt for text-to-video generation, without any conversational filler.
- "voiceoverScript": ONLY the spoken lines, in the dialogue language, in order, one line per beat, with no scene numbers, no timecodes and no speaker labels. This text is read out loud by a separate narrator, so write exactly what should be heard and nothing else. Keep it short enough to be spoken calmly within the clip's duration.${
        usesOwnVoice(voiceMode)
          ? '\nThe voiceoverScript is what will actually be voiced, so it carries the whole message — the video itself has no spoken words.'
          : ''
      }
`;

      // [PROD] Call GPT-5 via laozhang.ai
      const response = await this.httpClient.post('/chat/completions', {
        model: this.gptModel,
        messages: [{ role: 'user', content: userMessage }],
        temperature: 0.7,
        max_tokens: 4000,
      });

      // DEBUG
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // const response: any = {};
      // response.data = {
      //   id: 'chatcmpl-CfVgjLYMX3CHZcKNsupj595S3k2r1',
      //   object: 'chat.completion',
      //   created: 1764009293,
      //   model: 'gpt-5-2025-08-07',
      //   choices: [
      //     {
      //       index: 0,
      //       message: {
      //         role: 'assistant',
      //         content:
      //           '{\n  "prompt": "8 seconds; UGC smartphone realism, 35mm-equivalent prime lens, shallow depth of field, 4K, 24fps. Subject + action: A fast, clean UGC unboxing-to-testimonial sequence showcasing SuperBelly Mango Passion Fruit as an easy daily gut-support drink. Aesthetic: bright natural daylight, lifestyle product demo with authentic testimonial energy, minimal props, no distracting clutter.\\nCamera movement: Scene 1 (0:00–0:01.5) slight upward pan from inside an open mango-yellow shipping box to a matte mango-yellow SuperBelly pouch; Scene 2 (0:01.5–0:03.5) static medium shot on woman in a bright kitchen, hard cut to tight detail of scoop; Scene 3 (0:03.5–0:05.5) static medium close-up on man speaking; Scene 4 (0:05.5–0:08.0) medium close-up on man holding a clear shaker, hard cut to overhead product flat lay.\\nPacing: fast and upbeat with snappy hard cuts on the musical beat; quick intro hook, direct benefit line, punchy CTA finish.\\nColors: mango-yellow and passionfruit purple accents, fresh greens, crisp white backgrounds, warm wood tones, natural skin tones. High contrast but soft shadows.\\nAudio: upbeat tropical pop bed (light marimba, claps, soft kick), medium intensity, rises slightly toward the end; subtle foley for the powder scoop; clean, intimate VO. No reverb.\\nText overlay: persistent top-left sans-serif, white with soft drop shadow: “Free Shaker Bottle + 5 Free Travel Sticks.” Keep size readable on mobile; animate in subtly at 0:00 and gently scale up 5% at the CTA.\\nDialogue (timed to scenes):\\n- Scene 1 (0:00–0:01.5, female VO over unboxing): “Remembering to take all of my supplements is a lot sometimes.”\\n- Scene 2 (0:01.5–0:03.5, female VO over medium shot and scoop close-up): “And this is so much more than just a mango passion fruit drink—it’s packed with prebiotics, probiotics, and belly-loving fiber.”\\n- Scene 3 (0:03.5–0:05.5, male on-camera): “It’s helped my gut health, regularity, and daily energy—and I’ve noticed way less bloating.”\\n- Scene 4 (0:05.5–0:08.0, male VO on shaker and flat lay): “Order SuperBelly Mango Passion Fruit now and get a free shaker bottle and five free travel sticks.”\\nVisual direction by scene:\\n- Scene 1 Hook (0:00–0:01.5): Medium close-up; hand with rings gently lifts a large matte mango-yellow SuperBelly pouch from a custom-fit mango-yellow box lined with tropical leaf print. Clear white “SuperBelly” wordmark, flavor copy “Mango Passion Fruit,” and small icons: Prebiotic • Probiotic • Fiber. Bright, even daylight; soft shadows. No VFX.\\n- Scene 2 Solution (0:01.5–0:03.5): Medium shot; smiling woman in white tee and jeans, slight three-quarter angle in a sunlit minimalist kitchen, holding a clear shaker with a golden-mango drink (tiny bubbles, condensation). Hard cut to close-up of a mango-colored scoop pulling sunny-yellow powder from a brushed-metal canister; a soft “scoop” foley. Subtle logo visible on shaker.\\n- Scene 3 Benefits (0:03.5–0:05.5): Medium close-up; bearded man with glasses and cap, blue hoodie over green tee, holding the SuperBelly pouch at chest level, gesturing with animated excitement. Bright, soft, even lighting with gentle shadow for depth. Clean white patterned wall behind.\\n- Scene 4 CTA (0:05.5–0:08.0): Medium close-up; same man now holds a clear BPA-free shaker with SuperBelly logo toward camera, smiles. Hard cut to overhead flat lay: five mango-yellow SuperBelly travel sticks fanned neatly on warm walnut wood beside the pouch and shaker. The overlay text subtly scales up. Music hits a feel-good flourish on the last beat.\\nEnd with: CTA visual and audio: freeze on the overhead flat lay of the five travel sticks, pouch, and shaker with the overlay “Free Shaker Bottle + 5 Free Travel Sticks” and a small URL/tag @SuperBelly in bottom-right; music button resolves on the final word of the CTA VO."\n}',
      //         refusal: null,
      //         annotations: [],
      //       },
      //       finish_reason: 'stop',
      //     },
      //   ],
      //   usage: {
      //     prompt_tokens: 1667,
      //     completion_tokens: 3562,
      //     total_tokens: 5229,
      //     prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      //     completion_tokens_details: {
      //       reasoning_tokens: 2560,
      //       audio_tokens: 0,
      //       accepted_prediction_tokens: 0,
      //       rejected_prediction_tokens: 0,
      //     },
      //   },
      //   service_tier: 'default',
      //   system_fingerprint: null,
      // };

      // ТЗ §26: у ответа chat.completions расход в `usage`; модель берём
      // ту, что реально вернул провайдер (через прокси она может
      // отличаться от заказанной), и только если он её не назвал —
      // заказанную.
      await this.aiUsage.recordOpenAi(response.data, {
        operation: 'prompt',
        model: (response.data as { model?: string })?.model ?? this.gptModel,
        sessionId,
      });

      console.log('GPT-5 response:', JSON.stringify(response.data));

      // Optional-chained all the way through `choices` too — a wrong
      // LAOZHANG_API_BASE_URL (missing /v1) hits a different endpoint
      // that returns a 200 with a non-OpenAI-shaped body (no `choices`
      // array at all); response.data.choices[0] without the leading
      // `?.` throws a plain TypeError there, which used to fall through
      // to the catch block's generic "Please try again" (below) with no
      // trace of what actually happened.
      const generatedText =
        response.data?.choices?.[0]?.message?.content?.trim() || '';

      if (!generatedText) {
        this.logger.error(
          `Empty response from GPT-5. Response data: ${JSON.stringify(response.data)}`,
        );
        throw new Error(
          'GPT-5 returned an empty response. This may be due to content filtering or API issues.',
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
      // класс сбоя и код. Раньше сюда уходило `data.error.message` OpenAI
      // целиком: адрес шлюза, имя модели, иногда — эхо запроса.
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const upstream = error.response?.data?.error?.message;
        if (upstream) {
          this.logger.error(`ответ сервиса ИИ (${status}): ${upstream}`);
        }

        if (
          error.code === 'ECONNABORTED' ||
          error.message.includes('timeout')
        ) {
          throw new BadRequestException(
            'Сервис ИИ отвечал слишком долго. Попробуйте ещё раз.',
          );
        } else if (status === 401) {
          throw new BadRequestException(
            'Ключ сервиса ИИ не принят. Сообщите оператору.',
          );
        } else if (status === 429) {
          throw new BadRequestException(
            'Сервис ИИ ограничил частоту запросов. Попробуйте через минуту.',
          );
        } else {
          throw new BadRequestException(
            `Не удалось составить бриф: сервис ИИ ответил ошибкой${
              status ? ` (код ${status})` : ''
            }. Попробуйте ещё раз.`,
          );
        }
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
      const cameraBrief = cameraBriefText(
        normalizeCameraMove(session.brandManifestSnapshot?.cameraMove),
        frame,
      );
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

      const response = await this.httpClient.post('/chat/completions', {
        model: this.gptModel,
        messages: [{ role: 'user', content: userMessage }],
        temperature: 0.8,
        max_tokens: 6000,
      });

      // ТЗ §26 — та же учётная запись, что у обычной сборки промпта, но
      // отдельной операцией ('ab-variants', common/ai-pricing.ts) — иной
      // профиль по токенам, должна быть видна в отчёте расходов отдельно.
      await this.aiUsage.recordOpenAi(response.data, {
        operation: 'ab-variants',
        model: (response.data as { model?: string })?.model ?? this.gptModel,
        sessionId,
      });

      const generatedText =
        response.data?.choices?.[0]?.message?.content?.trim() || '';

      if (!generatedText) {
        this.logger.error(
          `Empty response from GPT-5 for A/B variants. Response data: ${JSON.stringify(response.data)}`,
        );
        throw new Error(
          'GPT-5 returned an empty response. This may be due to content filtering or API issues.',
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

      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const upstream = error.response?.data?.error?.message;
        if (upstream) {
          this.logger.error(`ответ сервиса ИИ (${status}): ${upstream}`);
        }

        if (
          error.code === 'ECONNABORTED' ||
          error.message.includes('timeout')
        ) {
          throw new BadRequestException(
            'Сервис ИИ отвечал слишком долго. Попробуйте ещё раз.',
          );
        } else if (status === 401) {
          throw new BadRequestException(
            'Ключ сервиса ИИ не принят. Сообщите оператору.',
          );
        } else if (status === 429) {
          throw new BadRequestException(
            'Сервис ИИ ограничил частоту запросов. Попробуйте через минуту.',
          );
        } else {
          throw new BadRequestException(
            `Не удалось собрать A/B-варианты: сервис ИИ ответил ошибкой${
              status ? ` (код ${status})` : ''
            }. Попробуйте ещё раз.`,
          );
        }
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
   * Basic content moderation using keyword matching
   * This is a simple POC implementation - production would use a proper moderation API
   *
   * @param text - Text to moderate
   * @returns Moderation result with status and flags
   */
  private moderateContent(text: string): {
    status: ModerationStatus;
    flags: string[];
  } {
    const flags: string[] = [];

    // Check each pattern
    this.moderationPatterns.forEach((pattern, index) => {
      if (pattern.test(text)) {
        flags.push(this.moderationCategories[index]);
      }
    });

    const status =
      flags.length > 0 ? ModerationStatus.FLAGGED : ModerationStatus.PENDING;

    return { status, flags };
  }
}
