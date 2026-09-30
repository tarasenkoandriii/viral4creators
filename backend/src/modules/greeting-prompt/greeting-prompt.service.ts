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
import {
  presenterExpression,
  presenterMood,
  registerOfBrief,
  sceneMoodFor,
  textFitsRegister,
} from '../../common/greeting-policy';
import { GreetingRegister } from '../../common/types/greeting.types';
import { SceneAsset } from '../../common/types/reference.types';
import { BrandManifestSnapshot } from '../../common/types/brand-manifest.types';
import {
  assertGreetingReferencesAllowed,
  brandPersonaVoiceNeedsPresenter,
  greetingVideoReferences,
} from '../../common/greeting-persona';
import { PrismaService } from '../../prisma/prisma.service';
import { isPersonaVoice } from '../user-voices/persona-voice';
import type { Session } from '../../common/types/session.types';
import { MAX_GREETING_REFERENCE_IMAGES } from '../greeting-reference/greeting-reference.service';
import {
  VoiceMode,
  normalizeVoiceMode,
  usesOwnVoice,
} from '../../common/voice-mode';
import { greetingVoiceMode } from '../../common/greeting-soniox-voice';
import { SESSION_NOT_FOUND } from '../../common/user-facing-errors';
import {
  GreetingScriptLanguage,
  scriptLanguageForPrompt,
  scriptLanguageOf,
} from '../../common/greeting-language';
import { editModeOf } from '../../common/greeting-session-edit';
import {
  GREETING_PROMPT_LOCK_TTL_MS,
  assertNoRenderAfterWrite,
  editDuringRender,
  greetingScriptInputs,
} from './script-inputs';
import {
  GREETING_ERROR_CODES,
  greetingError,
} from '../../common/greeting-errors';

// Общий срок замка 'prompt' поздравления (см. `GREETING_PROMPT_LOCK_TTL_MS`).
const GREETING_PROMPT_CLAIM_TTL_MS = GREETING_PROMPT_LOCK_TTL_MS;

export const GREETING_PROMPT_IN_FLIGHT_MESSAGE =
  'Сценарий уже собирается — дождитесь ответа первого запроса.';

export const GREETING_PROMPT_AFTER_VIDEO_MESSAGE =
  'Ролик уже готов. Чтобы изменить текст, поправьте его на шаге «Сценарий» или в брифе — ' +
  'появится новая версия, а готовый ролик останется как был.';

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
  /**
   * Этап C (§3.8, Г-5): язык текста. Раньше здесь стояло жёсткое «на
   * русском языке», и выбрать другой было нельзя вовсе.
   */
  language: GreetingScriptLanguage = scriptLanguageOf(brief),
): string {
  const spec = GREETING_OCCASION_SPECS[brief.occasion];
  const register = registerOfBrief(brief);
  return [
    // «Сообщение», а не «поздравление»: соболезнование и извинение —
    // тоже сообщения этого типа проекта, и просить у модели
    // «поздравление на повод «соболезнование»» значило бы толкать её
    // ровно к той ошибке, которую мы предотвращаем.
    `Напиши короткий текст для видео-сообщения ${scriptLanguageForPrompt(language)} (2–4 предложения, не длиннее 45 секунд озвучки).`,
    `Повод: ${occasionText}.`,
    // Та самая промптовая ветка на каждый повод (находка 1.8 аудита):
    // без неё «Соболезнование» отличалось бы от «Дня рождения» только
    // подставленным словом.
    spec.intent,
    // Этап B: у «Особого повода» замысел каталога общий на все случаи —
    // регистр уточняет, праздник это или нет. Без этой строки
    // «Особый повод: похороны» получал бы только «опирайся на описание».
    brief.occasion === 'OTHER' ? REGISTER_INTENT[register] : '',
    `Получатель: ${brief.recipientName}.`,
    brief.senderName ? `От кого: ${brief.senderName}.` : '',
    `Тон: ${GREETING_TONE_LABELS[brief.tone]}.`,
    `Обращайся к получателю по имени, без вступлений вида "вот твой текст" — выдай ТОЛЬКО сам текст сообщения, без кавычек и пояснений.`,
    // Подписи повода и тона выше — по-русски; без этой строки модель
    // иногда отвечала на языке подписей, а не на выбранном.
    language === 'ru'
      ? ''
      : `Весь текст сообщения — строго ${scriptLanguageForPrompt(language)}, даже если описание повода выше написано на другом языке.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Замысел «Особого повода» по регистру (этап B ТЗ
 * docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §3.4). Формулировки
 * — те же, что у каталожных поводов этого регистра (`intent` в
 * `greeting-occasions.ts`), чтобы свой повод не звучал иначе, чем
 * соседний из списка.
 */
const REGISTER_INTENT: Readonly<Record<GreetingRegister, string>> = {
  CELEBRATORY: 'Это праздничный повод — поздравь тепло и по-человечески.',
  WARM_NEUTRAL:
    'Это тёплое личное сообщение, не обязательно праздник: не используй праздничные клише.',
  SOLEMN:
    'Это торжественный, сдержанный повод: без шуток и без праздничных клише.',
  SENSITIVE:
    'Это деликатный повод. Не поздравляй и не шути; говори бережно, без восклицательных знаков.',
  MOURNING:
    'Это ТРАУРНЫЙ повод. Не поздравляй, не желай радости и веселья, не используй восклицательные знаки и праздничные слова. Вырази сочувствие сдержанно и коротко, предложи поддержку.',
};

@Injectable()
export class GreetingPromptService {
  private readonly logger = new Logger(GreetingPromptService.name);
  private readonly genai: GoogleGenAI;

  constructor(
    private readonly sessions: SessionService,
    private readonly aiUsage: AiUsageService,
    private readonly plans: PlanService,
    private readonly promptService: PromptService,
    // Необязателен ради юнит-тестов без базы: без него голос бренда не
    // опознаётся как голос персоны здесь, но тот же запрет повторно стоит
    // у денег (`personaRenderProblem`, greeting-video).
    private readonly prisma?: PrismaService,
  ) {
    this.genai = createGeminiClient();
  }

  /**
   * Голос бренд-бука — голос персоны автора (CONTRACT6 п.3, см.
   * `brandPersonaVoiceNeedsPresenter`). В базу ходим, только когда ответ
   * что-то решает: Hedra без образа и без клона отправителя.
   */
  private async brandPersonaVoice(
    session: Pick<Session, 'userId' | 'brandManifestSnapshot'>,
    brief: GreetingBriefSnapshot,
  ): Promise<boolean> {
    if (!brandPersonaVoiceNeedsPresenter(brief, true)) return false;
    const voiceId = session.brandManifestSnapshot?.ttsVoiceId;
    if (!this.prisma || !session.userId || !voiceId) return false;
    return isPersonaVoice(this.prisma, session.userId, voiceId);
  }

  async generateGreetingPrompt(sessionId: string): Promise<GenerationPrompt> {
    await this.plans.assertCanSpendSession(sessionId);

    const session = await this.sessions.getSession(sessionId);
    if (!session) {
      throw new BadRequestException(SESSION_NOT_FOUND);
    }
    const brief = session.greetingBriefSnapshot;
    if (!brief) {
      throw new BadRequestException(
        greetingError(
          GREETING_ERROR_CODES.GREETING_NOT_GREETING_SESSION,
          'Это не поздравление: у сессии нет брифа поздравления.',
        ),
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
    // Этап C (§3.6): те же правила, что у правки брифа и сценария. Во
    // время рендера сценарий не меняется — ролик собирался бы по одному
    // тексту, а в сессии лежал бы другой. У готового ролика сценарий тоже
    // не переписывается на месте: правка из шага «Сценарий» или брифа
    // заводит новую версию, и готовый ролик остаётся со своим текстом.
    const mode = editModeOf(session.generatedVideo);
    if (mode === 'busy') throw editDuringRender();
    if (mode === 'new-version' && session.generationPrompt) {
      throw new ConflictException(
        greetingError(
          GREETING_ERROR_CODES.GREETING_VIDEO_ALREADY_READY,
          GREETING_PROMPT_AFTER_VIDEO_MESSAGE,
        ),
      );
    }

    const likeness =
      findCelebrityLikeness(brief.personalMessage) ??
      findCelebrityLikeness(brief.customOccasionText) ??
      // Этап G (Г-6): заметки стиля бренд-бука теперь тоже доходят до
      // промпта — «в стиле Монро» там так же недопустимо, как в тексте.
      findCelebrityLikeness(session.brandManifestSnapshot?.styleNotes);
    if (likeness) {
      throw new BadRequestException(celebrityLikenessMessage(likeness));
    }
    assertGreetingReferencesAllowed(
      brief,
      session.greetingReferenceImages ?? [],
      await this.brandPersonaVoice(session, brief),
    );

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
      throw new ConflictException(
        greetingError(
          GREETING_ERROR_CODES.GREETING_EDIT_IN_PROGRESS,
          GREETING_PROMPT_IN_FLIGHT_MESSAGE,
        ),
      );
    }

    try {
      // CONTRACT6 п.3: решения — по сессии, перечитанной под замком.
      // Старт ролика держит тот же замок 'prompt' на всё время старта,
      // поэтому ролик, запущенный между первым чтением и замком, виден
      // здесь; а тот, что запустится после, будет ждать нас.
      const locked = await this.sessions.getSession(sessionId);
      const lockedMode = editModeOf(locked?.generatedVideo);
      if (lockedMode === 'busy') throw editDuringRender();
      if (lockedMode === 'new-version' && locked?.generationPrompt) {
        throw new ConflictException(
          greetingError(
            GREETING_ERROR_CODES.GREETING_VIDEO_ALREADY_READY,
            GREETING_PROMPT_AFTER_VIDEO_MESSAGE,
          ),
        );
      }
      // Дальше — только перечитанное: правка брифа могла закончиться
      // между первым чтением и замком.
      const current = locked ?? session;
      const brief =
        current.greetingBriefSnapshot ?? session.greetingBriefSnapshot!;
      assertGreetingReferencesAllowed(
        brief,
        current.greetingReferenceImages ?? [],
        await this.brandPersonaVoice(current, brief),
      );
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
        : await this.draftPersonalMessage(
            sessionId,
            brief,
            occasionText,
            scriptLanguageOf(brief, current.locale),
          );

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
        current.greetingReferenceImages ?? [],
        normalizeVoiceMode(current.brandManifestSnapshot?.voiceMode),
        current.brandManifestSnapshot ?? null,
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
        // Под какие фото, образ и голос собрана сцена — рендер сверит
        // (CONTRACT6 п.4, `script-inputs.ts`).
        greetingScriptInputs: greetingScriptInputs(current),
      };

      const updated = await this.sessions.updateSession(sessionId, {
        generationPrompt: prompt,
      });
      // CONTRACT6 п.3: страховка на истёкший замок (старт держит его не
      // дольше TTL). Ролик успел запуститься — возвращаем прежний сценарий,
      // по которому он считается, и говорим об этом прямо.
      await assertNoRenderAfterWrite(this.sessions, sessionId, {
        generationPrompt: current.generationPrompt,
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
    language: GreetingScriptLanguage,
  ): Promise<string> {
    const prompt = buildScriptPrompt(brief, occasionText, language);
    const register = registerOfBrief(brief);
    const fallback = () =>
      fallbackMessage(
        brief.occasion,
        brief.recipientName,
        occasionText,
        brief.occasionRegister ?? null,
        language,
      );

    // Этап B, §3.7 ТЗ: для деликатного и траурного регистров текст
    // модели проверяется, а не только запрашивается «не поздравляй».
    // Провал — одна повторная попытка, затем запасной текст регистра.
    // Две попытки, а не больше: каждая — платный вызов, а запасной
    // текст для этих регистров написан ровно на такой случай.
    for (let attempt = 0; attempt < 2; attempt++) {
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
        // упасть. С этапа C человек может поправить его на шаге сценария
        // (`PATCH /sessions/:id/greeting-script`), но запасной текст всё
        // равно обязан быть уместным сам по себе — он и выбирается по
        // регистру и языку.
        this.logger.warn(
          `сессия ${sessionId}: Gemini не вернул текст поздравления, использую нейтральный шаблон`,
        );
        return fallback();
      }
      if (textFitsRegister(register, text)) return text;
      this.logger.warn(
        `сессия ${sessionId}: текст для регистра ${register} звучит празднично (попытка ${attempt + 1})`,
      );
    }
    return fallback();
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
  /**
   * Бренд-бук сессии (этап G, Г-6): до этапа G из него в поздравление
   * шёл только `voiceMode`, а сцены и `styleNotes` терялись. Нет снимка
   * бренда — как раньше.
   */
  brand?: Pick<BrandManifestSnapshot, 'styleNotes' | 'scenes'> | null,
): string {
  // Пресетный голос xAI: реплику произносит сама модель, своим
  // липсинком (`reference_audios`, метка `<AUDIO_0>` — так же, как
  // `<IMAGE_n>` у картинок). Тогда наш синтез для этой сессии
  // выключен (`PostProductionService.planWork`), и молчаливая
  // формулировка ниже была бы прямо противоположна тому, что нужно.
  const presetVoiceId = brief.presetVoiceId?.trim() || null;
  // Этап G: тот же порядок изображений, что уйдёт в Grok
  // (`greetingVideoReferences` — одна функция на промпт и рендер): образ
  // ведущего первым, затем свои фото без заблокированных лиц (Г-8), затем
  // сцены бренд-бука (Г-6). Метка `<IMAGE_n>` — по позиции в этом списке.
  const plan = greetingVideoReferences({
    presenter: brief.presenter ?? null,
    images: referenceImages,
    brandScenes: brand?.scenes ?? null,
    max: MAX_GREETING_REFERENCE_IMAGES,
  });
  const presenterTag = plan.refs[0]?.role === 'presenter' ? '<IMAGE_1>' : null;
  const referenceLines = plan.refs
    .map((ref, i) => ({ ref, tag: `<IMAGE_${i + 1}>` }))
    .filter(({ ref }) => ref.role !== 'presenter')
    .map(({ ref, tag }) => `${tag} — ${ref.caption}`);
  const styleNotes = promptSafeNote(brand?.styleNotes);
  // Этап B: настроение, лицо и декорации — из политики по регистру.
  // Раньше «smiling» стояло безусловно (Г-2 ТЗ), а декорации брались из
  // каталога, где «Особый повод» был праздничным.
  const register = registerOfBrief(brief);
  const mood = presenterMood(register, brief.tone);
  const expression = presenterExpression(brief.occasion, register, brief.tone);
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
  //
  // S2: голос Soniox — наш синтез поверх, как у клона, и звучит даже
  // при режиме бренда 'veo' (`greetingVoiceMode`): та же функция решает
  // и у рендера Grok, и у постобработки, иначе сцена и звук разойдутся.
  const silent =
    !presetVoiceId && usesOwnVoice(greetingVoiceMode(brief, voiceMode));
  return [
    // `message`, не `greeting`: см. тот же довод в draftPersonalMessage.
    `A short vertical video message for ${occasionText} addressed to ${brief.recipientName}.`,
    // Т-17 (§4.8): образ автора — первый референс, и промпт говорит прямо,
    // кто ведущий. Раньше референсы шли «where they naturally fit», и лицо
    // могло достаться не ведущему, а случайному прохожему в кадре.
    presenterTag
      ? `The presenter is the person shown in ${presenterTag}${
          brief.presenter?.variant === 'sketch'
            ? ', keeping their drawn, illustrated look'
            : ', keeping their face, hairstyle and outfit exactly as in that image'
        }; nobody else in the scene looks like them.`
      : '',
    silent
      ? `A camera-facing presenter looks straight at the viewer with a ${mood} mood (${expression}), gesturing and reacting naturally — but does NOT say the line out loud: no lip-synced dialogue, no audible speech from anyone in the scene.`
      : presetVoiceId
        ? `A camera-facing presenter speaks directly to the viewer with the voice from <AUDIO_0>, ${expression}, ${mood} mood.`
        : `A camera-facing presenter speaks directly to the viewer, ${expression}, ${mood} mood.`,
    // Декорации приходят от повода, а не от тона: у соболезнования
    // нет праздничного варианта ни при каком тоне.
    `${sceneMoodFor(brief.occasion, register)}; no on-screen text.`,
    silent
      ? 'Audio: ambience and music only — the greeting itself is carried by a separate voice track added afterwards.'
      : '',
    referenceLines.length
      ? `Use these visual references where they naturally fit the scene: ${referenceLines.join('; ')}.`
      : '',
    // Г-6: стиль серии и постоянные места бренда — и у личного, и у
    // корпоративного бренд-бука. Сцены без фото (или не поместившиеся в
    // потолок изображений) — словами.
    plan.textScenes.length
      ? `Possible settings from the brand: ${plan.textScenes.map(promptSafeNote).filter(Boolean).join('; ')}.`
      : '',
    styleNotes ? `Visual style of the brand: ${styleNotes}.` : '',
    presetVoiceId
      ? `Spoken line, to be said aloud by the presenter (never rendered as on-screen text): "${speech.replace(/"/g, "'")}"`
      : `Spoken line (for reference, not to be rendered as on-screen text): "${speech.replace(/"/g, "'")}"`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Длина заметки стиля в промпте: это подсказка, а не второй сценарий. */
export const MAX_STYLE_NOTE_PROMPT_LENGTH = 300;

/**
 * Пользовательский текст бренд-бука в промпт — одной строкой, без кавычек
 * (они обрамляют реплику ниже) и с потолком длины.
 */
export function promptSafeNote(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/["\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_STYLE_NOTE_PROMPT_LENGTH)
    .trim();
}
