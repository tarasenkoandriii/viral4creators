/**
 * GreetingPromptService — сборка сценария/промпта для GREETING_VIDEO (ТЗ
 * TZ-Greeting-Video-Project-Type.md §5.1/§5.2).
 *
 * НЕ ветка внутри `PromptService.generatePrompt()` — отдельный метод,
 * потому что вход другой (`GreetingBriefSnapshot`, не
 * `ProductInformation`+`VideoAnalysis`) и предусловия другие: §5.1 прямо
 * говорит, что для GREETING_VIDEO разбор референса ПРОПУСКАЕТСЯ —
 * `generatePrompt()` же требует `session.videoAnalysis` (см. её первую
 * проверку) и упадёт 400 на сессии без него. Смешивать эти два метода
 * значило бы городить `if` внутри метода, который для трёх остальных
 * типов проекта прекрасно работает как есть.
 *
 * Выход — тот же `GenerationPrompt`, что и у `PromptService`, записанный
 * в то же поле `session.generationPrompt`: всё, что читает это поле
 * ниже по пайплайну (озвучка, постобработка — `postprod.service.ts`'s
 * `planWork()` читает только `session.generationPrompt`/
 * `session.brandManifestSnapshot`, никогда `Project.type` или
 * `productInformation`, см. аудит §9/§11.3 ТЗ) продолжает работать без
 * изменений.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { v4 as uuidv4 } from 'uuid';
import { createGeminiClient } from '../../common/gemini-client';
import { GEMINI_MODEL } from '../../common/gemini-model';
import { SessionService } from '../../common/session.service';
import { PlanService } from '../plan/plan.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { PromptService } from '../prompt/prompt.service';
import {
  GenerationPrompt,
  ModerationStatus,
} from '../../common/types/prompt.types';
import { GreetingBriefSnapshot } from '../../common/types/greeting.types';
import {
  celebrityLikenessMessage,
  findCelebrityLikeness,
} from '../../common/celebrity-likeness';
import {
  GREETING_OCCASION_SPECS,
  GREETING_TONE_LABELS,
  fallbackMessage,
} from '../../common/greeting-occasions';
import { SceneAsset } from '../../common/types/reference.types';
import {
  VoiceMode,
  normalizeVoiceMode,
  usesOwnVoice,
} from '../../common/voice-mode';

const GREETING_PROMPT_CLAIM_TTL_MS = 3 * 60 * 1000;

export const GREETING_PROMPT_IN_FLIGHT_MESSAGE =
  'Сценарий уже собирается — дождитесь ответа первого запроса.';

/**
 * Этап 2: подписи поводов и тонов больше не живут здесь двумя
 * локальными map'ами. Повод теперь несёт не только название, но и
 * замысел сообщения и настроение сцены, и всё это нужно ещё и админке,
 * и визарду — поэтому единственный источник правды вынесен в
 * `common/greeting-occasions.ts`.
 */
const OCCASION_LABEL = Object.fromEntries(
  Object.entries(GREETING_OCCASION_SPECS).map(([k, v]) => [k, v.label]),
) as Record<GreetingBriefSnapshot['occasion'], string>;

const TONE_LABEL = GREETING_TONE_LABELS;

/**
 * Сборка запроса к Gemini на текст сообщения — чистая функция,
 * экспортированная ради теста (тот же приём, что у
 * `snapshotFromSession` в SharedVideoService: поведение, которое стоит
 * закрепить, не должно требовать мока внешнего API).
 *
 * Мутационная проверка этапа 2 показала, почему это понадобилось:
 * мутант, выбрасывающий `spec.intent` из запроса, не уронил ни одного
 * теста — то есть главная идея фичи №1 («повод — не метка, а
 * инструкция модели») не была закреплена ничем.
 */
export function buildScriptPrompt(
  brief: GreetingBriefSnapshot,
  occasionText: string,
): string {
  const spec = GREETING_OCCASION_SPECS[brief.occasion];
  return [
    // «Сообщение», а не «поздравление»: соболезнование и извинение —
    // тоже сообщения этого типа проекта, и просить у модели
    // «поздравление на повод «соболезнование»» значило бы толкать её
    // ровно к той ошибке, которую мы предотвращаем.
    `Напиши короткий текст для видео-сообщения на русском языке (2–4 предложения, не длиннее 45 секунд озвучки).`,
    `Повод: ${occasionText}.`,
    // Та самая промптовая ветка на каждый повод (находка 1.8 аудита):
    // без неё «Соболезнование» отличалось бы от «Дня рождения» только
    // подставленным словом.
    spec.intent,
    `Получатель: ${brief.recipientName}.`,
    brief.senderName ? `От кого: ${brief.senderName}.` : '',
    `Тон: ${GREETING_TONE_LABELS[brief.tone]}.`,
    `Обращайся к получателю по имени, без вступлений вида "вот твой текст" — выдай ТОЛЬКО сам текст сообщения, без кавычек и пояснений.`,
  ]
    .filter(Boolean)
    .join('\n');
}

@Injectable()
export class GreetingPromptService {
  private readonly logger = new Logger(GreetingPromptService.name);
  private readonly genai: GoogleGenAI;

  constructor(
    private readonly sessions: SessionService,
    private readonly aiUsage: AiUsageService,
    private readonly plans: PlanService,
    private readonly promptService: PromptService,
  ) {
    this.genai = createGeminiClient();
  }

  async generateGreetingPrompt(sessionId: string): Promise<GenerationPrompt> {
    await this.plans.assertCanSpendSession(sessionId);

    const session = await this.sessions.getSession(sessionId);
    if (!session) {
      throw new BadRequestException('Session not found');
    }
    const brief = session.greetingBriefSnapshot;
    if (!brief) {
      throw new BadRequestException(
        'This session has no greeting brief — it was not created from a GREETING_VIDEO project.',
      );
    }

    // Фича №35: просьба сделать ролик похожим на конкретного реального
    // человека отклоняется ДО первого платного вызова — и отдельным,
    // понятным текстом, а не общим флагом модерации. Причина разделения:
    // `moderateText` ниже — список ключевых слов про насилие и
    // непристойности, он про другое и отвечает пользователю молчаливым
    // отказом рендера. Здесь же человек чаще всего не задумывался о
    // правах на образ и хотел просто смешно — ему нужно сказать, что
    // именно убрать.
    //
    // Проверяется ТО, ЧТО НАПИСАЛ ЧЕЛОВЕК, а не сгенерированный текст:
    // сценарий пишет Gemini по этому же брифу, и ловить чужой образ
    // после генерации значило бы заплатить за вызов, чтобы отказать.
    const likeness =
      findCelebrityLikeness(brief.personalMessage) ??
      findCelebrityLikeness(brief.customOccasionText);
    if (likeness) {
      throw new BadRequestException(celebrityLikenessMessage(likeness));
    }

    // Тот же замок, что уже используют другие платные сборки промпта
    // (`WORK_KINDS` в session.service.ts включает 'prompt' без правок —
    // это тот же вид работы «идёт сборка текста для этой сессии», просто
    // из другого источника данных).
    const claimed = await this.sessions.claimWork(
      sessionId,
      'prompt',
      GREETING_PROMPT_CLAIM_TTL_MS,
    );
    if (!claimed) {
      throw new ConflictException(GREETING_PROMPT_IN_FLIGHT_MESSAGE);
    }

    try {
      const occasionText =
        brief.occasion === 'OTHER' && brief.customOccasionText
          ? brief.customOccasionText
          : OCCASION_LABEL[brief.occasion];

      // §5.2: если пользователь текст не задал — генерируем черновик по
      // (occasion, recipientName, tone); заданный текст используется как
      // есть, без похода в Gemini (§5.2: «черновик текста бесплатно,
      // видео — платно» — здесь симметрично: заданный пользователем текст
      // бесплатен, платный вызов — только когда действительно нечего
      // подставить).
      const speech = brief.personalMessage?.trim()
        ? brief.personalMessage.trim()
        : await this.draftPersonalMessage(sessionId, brief, occasionText);

      // Режим озвучки — тот же, что прочитает постобработка
      // (`PostProductionService.planWork`): у поздравления снимка
      // бренда чаще всего нет вовсе, и `normalizeVoiceMode`
      // читает отсутствие как 'voiceover' — то есть реплику
      // ПРОИЗНЕСЁМ МЫ. Сцена обязана знать об этом, иначе модель
      // проговорит ту же реплику своим голосом, а наша дорожка ляжет
      // поверх (см. `buildSceneDescription`).
      const sceneDescription = buildSceneDescription(
        brief,
        occasionText,
        speech,
        session.greetingReferenceImages ?? [],
        normalizeVoiceMode(session.brandManifestSnapshot?.voiceMode),
      );

      // Найдено при аудите пайплайна GREETING_VIDEO (находка №2): раньше
      // здесь стоял жёсткий `moderationStatus: APPROVED` без единого
      // вызова модерации — пользовательский `personalMessage`/
      // `customOccasionText` и сгенерированный Gemini `speech` уходили в
      // рендер видео без проверки на ключевые слова, в отличие от
      // SINGLE/LINE (`PromptService.generatePrompt`'s `moderateContent`).
      // `sceneDescription` — то же самое, что там называется `promptText`:
      // финальный текст, который реально уйдёт в Grok (он же содержит
      // `speech` внутри себя, см. `buildSceneDescription`), поэтому
      // модерируем именно его, тем же самым конвейером ключевых слов.
      const moderation = this.promptService.moderateText(sceneDescription);
      const flagged = moderation.status === ModerationStatus.FLAGGED;
      const now = new Date();
      const prompt: GenerationPrompt = {
        promptId: uuidv4(),
        generatedText: sceneDescription,
        finalText: sceneDescription,
        characterCount: sceneDescription.length,
        generatedAt: now,
        moderationStatus: flagged
          ? ModerationStatus.FLAGGED
          : ModerationStatus.APPROVED,
        ...(moderation.flags.length
          ? { moderationFlags: moderation.flags }
          : {}),
        // GREETING_VIDEO не проходит через отдельный экран одобрения
        // промпта (`PromptService.approvePrompt`, SINGLE/LINE) — чистый
        // текст (без флагов) считается одобренным сразу, поэтому
        // `approvedAt` проставляется тут же. Без этого экспорт tier B
        // (`ExportService.startRerender`, требует
        // `session.generationPrompt?.approvedAt`, export.service.ts)
        // отказывал бы 400 даже чистым GREETING_VIDEO-сессиям. Флаженный
        // текст `approvedAt` НЕ получает — у GREETING_VIDEO нет экрана
        // ручного одобрения, чтобы осознанно обойти флаг (в отличие от
        // `approvePrompt()`'s FLAGGED → BYPASSED), поэтому дальше по
        // конвейеру `GreetingVideoService.startVideo` отдельно отказывает
        // генерацию видео по флагу (см. её doc-comment).
        ...(flagged ? {} : { approvedAt: now }),
        voiceoverScript: speech,
        finalVoiceoverScript: speech,
        voiceoverScriptSource: 'field',
      };

      const updated = await this.sessions.updateSession(sessionId, {
        generationPrompt: prompt,
      });
      return updated?.generationPrompt ?? prompt;
    } finally {
      await this.sessions.releaseWork(sessionId, 'prompt');
    }
  }

  /** §5.2 — черновик текста поздравления по (occasion, recipientName, tone). */
  private async draftPersonalMessage(
    sessionId: string,
    brief: GreetingBriefSnapshot,
    occasionText: string,
  ): Promise<string> {
    const prompt = buildScriptPrompt(brief, occasionText);

    const response = await this.genai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{ text: prompt }],
      config: { temperature: 0.8, maxOutputTokens: 500 },
    });
    await this.aiUsage.recordGemini(response, {
      operation: 'greeting-prompt',
      model: GEMINI_MODEL,
      sessionId,
    });
    const text = response.text?.trim();
    if (!text) {
      // Best-effort деградация: лучше отдать нейтральный текст, чем
      // упасть — пользователь всё равно может отредактировать бриф и
      // задать personalMessage вручную (PATCH .../greeting-brief).
      this.logger.warn(
        `сессия ${sessionId}: Gemini не вернул текст поздравления, использую нейтральный шаблон`,
      );
      return fallbackMessage(brief.occasion, brief.recipientName, occasionText);
    }
    return text;
  }
}

/**
 * Описание сцены для видео-генерации (§5.3): для 'grok' это `prompt`
 * text-to-video или reference-to-video (нет сгенерированного
 * референсного кадра — см. аудит и GreetingVideoService doc-comment;
 * вместо него — загруженные пользователем `referenceImages`, доп.
 * запрос к ТЗ); для 'hedra' это `promptOverride` мимики говорящего
 * аватара.
 *
 * `referenceImages` присутствуют → каждому вставляется метка
 * `<IMAGE_n>` РЯДОМ С УПОМИНАНИЕМ в тексте, как того требует Grok
 * reference-to-video (docs.x.ai, `GrokVideoService`'s doc-comment:
 * «модель ожидает метки <IMAGE_1>, <IMAGE_2> … прямо в тексте
 * промпта», а не отдельным списком-приложением, как у Veo). Честно
 * говоря — приближение, не точное следование: подпись берётся из
 * `label`/`description`, заданных пользователем при загрузке, не
 * из анализа самого изображения.
 */
export function buildSceneDescription(
  brief: GreetingBriefSnapshot,
  occasionText: string,
  speech: string,
  referenceImages: SceneAsset[],
  voiceMode: VoiceMode,
): string {
  const toneText = TONE_LABEL[brief.tone];
  const referenceLines = referenceImages.map((img, i) => {
    const tag = `<IMAGE_${i + 1}>`;
    const caption = (img.description || img.label).trim();
    return `${tag} — ${caption}`;
  });
  const spec = GREETING_OCCASION_SPECS[brief.occasion];
  const mood =
    toneText === TONE_LABEL.FUNNY
      ? 'playful and lighthearted'
      : toneText === TONE_LABEL.FORMAL
        ? 'composed and professional'
        : toneText === TONE_LABEL.RESPECTFUL
          ? 'quiet and respectful'
          : toneText === TONE_LABEL.SUPPORTIVE
            ? 'gentle and reassuring'
            : 'warm and sincere';
  // Реплику озвучиваем мы — значит на экране её НЕ произносят.
  //
  // До этой правки сцена всегда просила «presenter speaks directly to
  // the viewer», а постобработка всегда (режим по умолчанию —
  // 'voiceover') подмешивала СВОЮ дорожку с тем же текстом поверх
  // приглушённого оригинала (`common/postprod.ts`, `amix`). Слышно было
  // обе: модель читала поздравление своим голосом, мы — своим, с
  // небольшим сдвигом. Товарные ролики от этого избавлены давно — там
  // ту же мысль в бриф кладёт `voiceModeBriefText`
  // (`PromptService.generatePrompt`), а `GreetingPromptService` её
  // просто не звала.
  //
  // Дословно `voiceModeBriefText` здесь не подходит: она запрещает
  // говорящие головы вообще и предлагает нести смысл экранным текстом —
  // а у поздравления ведущий в кадре и есть весь смысл, и экранный
  // текст запрещён соседней строкой этого же промпта. Поэтому
  // формулировка своя: ведущий в кадре остаётся, произнесение — нет.
  const silent = usesOwnVoice(voiceMode);
  return [
    // `message`, не `greeting`: см. тот же довод в draftPersonalMessage.
    `A short vertical video message for ${occasionText} addressed to ${brief.recipientName}.`,
    silent
      ? `A camera-facing presenter looks straight at the viewer with a ${mood} mood, smiling, gesturing and reacting — but does NOT say the line out loud: no lip-synced dialogue, no audible speech from anyone in the scene.`
      : `A camera-facing presenter speaks directly to the viewer, natural expression, ${mood} mood.`,
    // Декорации приходят от повода, а не от тона: у соболезнования
    // нет праздничного варианта ни при каком тоне.
    `${spec.sceneMood}; no on-screen text.`,
    silent
      ? 'Audio: ambience and music only — the greeting itself is carried by a separate voice track added afterwards.'
      : '',
    referenceLines.length
      ? `Use these visual references where they naturally fit the scene: ${referenceLines.join('; ')}.`
      : '',
    `Spoken line (for reference, not to be rendered as on-screen text): "${speech.replace(/"/g, "'")}"`,
  ]
    .filter(Boolean)
    .join(' ');
}
