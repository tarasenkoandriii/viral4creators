import {
  Injectable,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { LegalService } from '../legal/legal.service';
import { GoogleGenAI, Part } from '@google/genai';
import { createGeminiClient } from '../../common/gemini-client';
import { BlobService } from '../storage/blob.service';
import { GeminiFilesService } from './gemini-files.service';
import { createHash } from 'crypto';
import { SessionService } from '../../common/session.service';
import { LibraryService } from '../library/library.service';
import {
  sourceKeyOf,
  uploadSourceKey,
  youtubeSourceKey,
} from '../../common/library';
import {
  VideoAnalysis,
  AnalysisStatus,
} from '../../common/types/analysis.types';
import { SessionStatus } from '../../common/types/session.types';
import { OriginalVideo, VideoSourceType } from '../../common/types/video.types';
import { v4 as uuidv4 } from 'uuid';
import { parseAnalysisResponse } from './analysis-response';
import {
  buildAnalysisTranslationPrompt,
  applyAnalysisTranslation,
} from './analysis-translation';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { PlanService } from '../plan/plan.service';
import { GEMINI_MODEL } from '../../common/gemini-model';
import { languageNameForLocale, normalizeLocale } from '../../common/locale';

/**
 * Замок разбора (этап 47, В-2.3). Сам разбор — синхронный `await` до
 * 280 с (потолок функции на Vercel — 300 с), поэтому и замок держится
 * столько же; протухший считается свободным.
 */
const ANALYZE_CLAIM_TTL_MS = 5 * 60 * 1000;

export const ANALYSIS_IN_FLIGHT_MESSAGE =
  'Разбор уже идёт — дождитесь его окончания.';

const ANALYSIS_PROMPT = `You are analyzing a video to extract key scenes for recreating an 8-second viral video using AI video generation tools.
Focus ONLY on the most impactful, engaging moments. Ignore filler, transitions, credits, or non-essential content. Prioritize intensity, visual impact, and message clarity.

You must respond with a valid JSON object with seven keys — "sceneBreakdown" (a string with the scene breakdown), "frame" (the video's picture format), "characters" (an array of the people or presenters visible in the video), "scenes" (a compact array of the scenes with timecodes), "extras" (incidental background people, if any), "audience" (who this video is made for) and "promotedProduct" (what it sells), like so:
{
  "sceneBreakdown": "",
  "frame": { "orientation": "vertical", "aspectRatio": "9:16" },
  "characters": [
    {
      "label": "Woman in red jacket",
      "role": "presenter",
      "appearance": "Woman in her late 20s, shoulder-length dark hair, red puffer jacket, small gold earrings, warm smile, speaks directly to camera",
      "prominence": "main",
      "previewAt": 1.5
    }
  ],
  "scenes": [
    { "start": 0, "end": 2.5, "title": "Hook: unboxing on the kitchen table", "previewAt": 1.2 }
  ],
  "extras": [
    { "label": "Passers-by on the street", "description": "Blurred pedestrians crossing behind the presenter in scenes 2-3, no faces", "previewAt": 4.0 }
  ],
  "audience": {
    "ageRange": "25-34",
    "gender": "women",
    "interests": ["running", "healthy lifestyle"],
    "summary": "Young urban women who run casually and buy mid-range sportswear on impulse after seeing it worn by someone like them"
  },
  "promotedProduct": { "category": "running shoes", "description": "Lightweight cushioned running shoes, shown on foot", "priceTier": "mid" }
}

For each scene, provide:
SCENE BREAKDOWN:
[Timestamp from original video]
Duration: [seconds needed in 8-sec format]
Scene Purpose: [Hook/Problem/Solution/CTA]
Visual Details:
Camera angle and movement: [specific framing and any dolly, pan, or zoom]
Subject positioning and action: [what's happening, who/what is visible, direction of movement]
Lighting: [dominant color temperature, intensity, shadows, mood]
Color palette: [primary colors, grading, emotional tone]
On-screen elements: [text, graphics, overlays, props visible]
Visual effects or transitions: [any special effects, cuts, or stylistic elements]
Cinematic Details:
Shot type: [wide, medium, close-up, detail shot]
Pacing/rhythm: [speed of action, cut timing]
Style and aesthetic: [documentary, cinematic, animated, product demo, etc.]
Audio Details:
Dialogue/voiceover: [exact words if present, tone, emotional delivery]
Sound design: [music genre, ambient sounds, sound effects, music intensity]
Timing: [when sounds occur relative to visuals]

FRAME:
Report the picture format of the source video: "orientation" is "vertical", "horizontal" or "square"; "aspectRatio" is the closest of "9:16", "16:9", "3:4", "4:3", "1:1", "4:5" (letterboxed/pillarboxed videos: report the ratio of the actual picture, not of the black bars).

CHARACTERS:
List every distinct person, presenter, mascot or animal that acts in the video (not incidental background crowds). For each give:
label: a short handle (3-6 words) that tells characters apart
role: what they do in the video (presenter, customer, passer-by, voice-over on screen, etc.)
appearance: clothing, approximate age, gender, hair, build, distinctive features, expression and manner — enough detail that a video model could recreate the same person without seeing the footage
prominence: "main" (carries the video), "secondary" (appears in several shots) or "background" (brief)
previewAt: ONE timestamp in seconds (number) where this character is seen most clearly — face towards the camera, not blurred, not mid-cut. This is the only timecode per character. If nobody appears, return an empty array.

EXTRAS:
Incidental background people that are NOT characters: crowds, passers-by, customers in the background, a blurred barista. One row per group: "label" (3-6 words), "description" (where and how they appear, how many, how visible), "previewAt" (a second where the group is visible). Empty array if the video has none.

SCENES:
The same scenes as in sceneBreakdown, one row each, in order: "start" and "end" in seconds of the ORIGINAL video (numbers), "title" — 3-8 words naming the purpose and what is on screen ("Hook: unboxing on the kitchen table"), "previewAt" — the single most representative second of that scene (number, inside start..end).

AUDIENCE:
Who this video is made for, judged from the content, tone, music, presenters and comments-style cues: "ageRange" (e.g. "18-24", "25-34", "35-44", "45+", or a combination), "gender" — exactly one of "women", "men", "any"; "interests" — 3-6 short tags; "summary" — one or two sentences about who watches this and why it works on them.

PROMOTED PRODUCT:
What the video sells or shows off: "category" — free text (1-3 words), "description" — one sentence, "priceTier" — "budget", "mid" or "premium". If it is not selling anything, set category to null and explain in description.

IMPORTANT REQUIREMENTS:
Maintain the original video's core message and visual identity.
Optimize for maximum virality: emotional impact, pattern interrupts, clarity, and urgency.
Respond with a valid JSON with exactly 7 keys, "sceneBreakdown", "frame", "characters", "scenes", "extras", "audience" and "promotedProduct", without any additional explanation or text outside the JSON object.`;

/**
 * AnalysisService
 *
 * Handles video analysis operations using Google Gemini AI.
 * Provides methods for triggering analysis, checking status,
 * and updating user-edited results.
 *
 * Two reference-video sources are supported (see common/types/video.types.ts):
 *  - UPLOAD: bytes were PUT by the browser to Vercel Blob. We download them
 *    once, hand them to Gemini's Files API, wait for processing, then
 *    reference the file by URI. Both the Gemini file and the blob are
 *    deleted right after — see the `finally` block in performAnalysis.
 *  - YOUTUBE: no download/upload at all. Gemini fetches the public YouTube
 *    URL itself; we just pass the link straight through.
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  private readonly genai: GoogleGenAI;

  constructor(
    private readonly blobService: BlobService,
    private readonly geminiFilesService: GeminiFilesService,
    private readonly library: LibraryService,
    private readonly sessionService: SessionService,
    private readonly aiUsage: AiUsageService,
    private readonly plans: PlanService,
    private readonly legal: LegalService,
  ) {
    // Ключ — явно в SDK (этап 53, В-6.15): `new GoogleGenAI({})` читал
    // только свои переменные, и GOOGLE_GEMINI_API_KEY до него не доходил.
    this.genai = createGeminiClient();
  }

  /**
   * Analyze the session's reference video using Google Gemini.
   *
   * Runs synchronously to completion (`await`s `performAnalysis` directly)
   * rather than firing it in the background — that was the previous
   * design (return PROCESSING immediately, let an un-awaited promise
   * finish "later"), and it's broken on Vercel: a Function is not
   * guaranteed to keep running once its response has been sent, so the
   * analysis could simply be cut off mid-flight, leaving the client
   * polling GET /analysis forever for a PROCESSING status that would
   * never change. See doc/VERCEL-READINESS-AUDIT.md, finding #3.
   *
   * This is safe specifically because reference clips here are short
   * (8–30s UGC ads) — Gemini analysis comfortably finishes within
   * Vercel's fixed 300s Function duration. A source that could run much
   * longer would need an async-job/poll pattern instead (as generation
   * already does for Veo) rather than a synchronous await here.
   *
   * @param sessionId - Session identifier
   * @returns The completed (or, if it throws, never-returned) analysis
   */
  async analyzeVideo(
    sessionId: string,
  ): Promise<{ analysisId: string; status: AnalysisStatus }> {
    // Validate session exists and has a reference video registered
    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      throw new BadRequestException('Session not found');
    }

    if (!session.originalVideo) {
      throw new BadRequestException('No reference video registered yet');
    }

    // ТЗ §25.3: заблокированному платные вызовы запрещены.
    await this.plans.assertCanSpendUser(session.userId ?? null);
    // ТЗ §20 (этап 38): на согласии стоят права сервиса на Разбор и
    // легитимность общей Библиотеки — проверка не может жить только в
    // интерфейсе.
    await this.legal.assertAccepted(session.userId ?? null);

    // Этап 47 (В-2.3): у разбора не было замка вообще. Два параллельных
    // разбора одного видео — двойная оплата Gemini, и хуже: первый в
    // конце удаляет транзитную копию видео, второй на ней падает и
    // пишет FAILED поверх готового оплаченного результата. Занимаем
    // разбор одним условным UPDATE; проигравшему — 409, экран продолжит
    // опрашивать статус первого.
    const claimed = await this.sessionService.claimWork(
      sessionId,
      'analyze',
      ANALYZE_CLAIM_TTL_MS,
    );
    if (!claimed) {
      throw new ConflictException(ANALYSIS_IN_FLIGHT_MESSAGE);
    }
    try {
      return await this.runAnalysis(sessionId, session.originalVideo);
    } finally {
      await this.sessionService.releaseWork(sessionId, 'analyze');
    }
  }

  /** Тело разбора — под замком `claimWork('analyze')`, см. выше. */
  private async runAnalysis(
    sessionId: string,
    originalVideo: OriginalVideo,
  ): Promise<{ analysisId: string; status: AnalysisStatus }> {
    // Create initial analysis record
    const analysisId = uuidv4();
    const videoAnalysis: VideoAnalysis = {
      analysisId,
      analyzedAt: new Date(),
      status: AnalysisStatus.PROCESSING,
      sceneBreakdown: '',
    };

    // Update session status to analyzing
    await this.sessionService.updateSession(sessionId, {
      videoAnalysis,
      status: SessionStatus.ANALYZING,
    });

    try {
      // Spec §21 (Stage 24): a reference we have already analysed is
      // copied from the library instead of being sent to Gemini again.
      // For a YouTube link the key is known upfront; an upload is keyed by
      // the file hash, checked inside performAnalysis once the bytes are
      // in hand (still before the expensive call).
      const key = sourceKeyOf(originalVideo);
      const cached = key ? await this.library.findAnalysis(key) : null;
      if (cached) {
        await this.applyCached(sessionId, key!, cached);
      } else {
        await this.performAnalysis(sessionId, originalVideo);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Video analysis failed';

      this.logger.error(
        `Video analysis failed for session ${sessionId}: ${message}`,
      );

      // Этап 47: FAILED пишется только поверх СВОЕГО разбора. Если за
      // время работы кто-то успел записать другой — готовый из
      // библиотеки или повторный, — затирать его отказом нельзя:
      // пользователь заплатил и увидел бы «не удалось».
      const current = await this.sessionService.getSession(sessionId);
      if (current?.videoAnalysis?.analysisId === analysisId) {
        await this.sessionService.updateSession(sessionId, {
          videoAnalysis: {
            ...videoAnalysis,
            status: AnalysisStatus.FAILED,
            error: {
              code: 'ANALYSIS_FAILED',
              message,
              timestamp: new Date(),
            },
          },
          status: SessionStatus.ERROR,
        });
      }

      throw new BadRequestException(message);
    }

    // performAnalysis already wrote the COMPLETE result onto the session
    // (see its own final updateSession call) — re-read it so the actual
    // final status/id are what we hand back, not the PROCESSING stub.
    const completedSession = await this.sessionService.getSession(sessionId);
    const completed = completedSession?.videoAnalysis ?? videoAnalysis;

    // Этап 59 (ТЗ §35.5): перевод НА СЕССИЮ, никогда обратно в библиотеку —
    // выполняется здесь, ПОСЛЕ того как и performAnalysis (свежий разбор),
    // и applyCached (попадание в библиотеку) уже вернулись и, в случае
    // свежего разбора, уже сохранили канонический английский текст в
    // library.save() (см. analysis-translation.ts — почему кеш должен
    // остаться англоязычным). Лучшая попытка: сбой перевода не должен
    // портить уже готовый (английский) разбор.
    if (completed.status === AnalysisStatus.COMPLETE) {
      await this.translateForSessionLocale(sessionId, completed);
    }

    return {
      analysisId: completed.analysisId,
      status: completed.status,
    };
  }

  /**
   * Переводит текстовые поля готового разбора на локаль сессии, если она
   * задана и отличается от английского (канонический язык генерации,
   * см. ANALYSIS_PROMPT). Результат пишется ТОЛЬКО в сессию, не в
   * library — см. заголовок analysis-translation.ts.
   */
  private async translateForSessionLocale(
    sessionId: string,
    analysis: VideoAnalysis,
  ): Promise<void> {
    const session = await this.sessionService.getSession(sessionId);
    const locale = normalizeLocale(session?.locale);
    if (locale === 'en') return; // канонический язык разбора — переводить нечего

    try {
      const languageName = languageNameForLocale(locale);
      const response = await this.genai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          { text: buildAnalysisTranslationPrompt(analysis, languageName) },
        ],
        config: { responseMimeType: 'application/json' },
      });
      await this.aiUsage.recordGemini(response, {
        operation: 'analysis-translate',
        model: GEMINI_MODEL,
        sessionId,
      });
      const translated = applyAnalysisTranslation(
        analysis,
        response?.text ?? '',
      );
      // Раздельные updateSession, а не один общий: сессия могла продвинуться
      // дальше разбора (маловероятно за секунды одного текстового вызова,
      // но не невозможно) — перезаписываем только сам разбор, не весь снимок.
      const current = await this.sessionService.getSession(sessionId);
      if (current?.videoAnalysis?.analysisId === analysis.analysisId) {
        await this.sessionService.updateSession(sessionId, {
          videoAnalysis: translated,
        });
      }
    } catch (error) {
      // Лучшая попытка (как и applyCached/performAnalysis не блокируются
      // необязательными шагами) — пользователь видит английский оригинал,
      // а не ошибку, если перевод недоступен.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Analysis translation failed for session ${sessionId} (locale ${locale}): ${message}`,
      );
    }
  }

  /**
   * Library hit (§21): the stored analysis becomes this session's, with a
   * fresh analysisId so the UI treats it as its own run. No Gemini call,
   * no frame/preview work — previews live inside the stored analysis.
   */
  private async applyCached(
    sessionId: string,
    sourceKey: string,
    cached: VideoAnalysis,
  ): Promise<void> {
    this.logger.log(`Analysis served from the library (${sourceKey})`);
    const session = await this.sessionService.getSession(sessionId);
    const frame = cached.frame ?? undefined;
    await this.sessionService.updateSession(sessionId, {
      videoAnalysis: {
        ...cached,
        analysisId: session?.videoAnalysis?.analysisId ?? cached.analysisId,
        analyzedAt: new Date(),
        status: AnalysisStatus.COMPLETE,
        fromLibrary: true,
      },
      ...(session?.originalVideo && frame && !session.originalVideo.frame
        ? { originalVideo: { ...session.originalVideo, frame } }
        : {}),
      status: SessionStatus.ANALYSIS_COMPLETE,
    });
    await this.library.markUsed(sourceKey);
    // Кадры этой сессии подтвердятся позже — тогда по этому ключу их
    // допишут в запись библиотеки (§21, этап 39).
    await this.sessionService.updateSession(sessionId, {
      librarySourceKey: sourceKey,
    });
  }

  /**
   * Perform video analysis using Gemini
   * @param sessionId - Session identifier
   * @param originalVideo - The registered reference video (upload or YouTube)
   */
  private async performAnalysis(
    sessionId: string,
    originalVideo: OriginalVideo,
  ): Promise<void> {
    this.logger.log(
      `Starting analysis for session ${sessionId} (source: ${originalVideo.sourceType})`,
    );

    let videoPart: Part;
    let cleanup: () => void = () => undefined;
    let uploadKey: string | null = null;

    if (originalVideo.sourceType === VideoSourceType.YOUTUBE) {
      // Gemini fetches the video itself — nothing to download, upload,
      // or clean up on our side.
      videoPart = { fileData: { fileUri: originalVideo.youtubeUrl } };
    } else {
      // UPLOAD: pull the transit copy from Blob, hand it to Gemini's
      // Files API, and reference the resulting file by URI. If either
      // step fails, still delete the blob — there's no point leaving a
      // dead upload sitting in storage just because Gemini rejected it.
      let geminiFileName: string | undefined;
      try {
        const buffer = await this.blobService.downloadBuffer(
          originalVideo.blobPathname,
        );
        // §21: an upload is keyed by its bytes — check the library before
        // paying for Gemini (and before uploading the file to it).
        uploadKey = uploadSourceKey(
          createHash('sha256').update(buffer).digest('hex'),
        );
        const cached = await this.library.findAnalysis(uploadKey);
        if (cached) {
          await this.blobService.deleteBlob(originalVideo.blobPathname);
          await this.applyCached(sessionId, uploadKey, cached);
          return;
        }
        const geminiFile = await this.geminiFilesService.uploadAndWaitActive(
          buffer,
          originalVideo.mimeType,
        );
        geminiFileName = geminiFile.name;
        videoPart = {
          fileData: {
            fileUri: geminiFile.uri,
            mimeType: geminiFile.mimeType,
          },
        };
      } catch (error) {
        await this.blobService.deleteBlob(originalVideo.blobPathname);
        throw error;
      }

      // Both deletes are best-effort and only run after generateContent
      // below has actually used the file — deleting earlier would pull
      // the reference out from under Gemini mid-request.
      cleanup = () => {
        if (geminiFileName) {
          void this.geminiFilesService.deleteFile(geminiFileName);
        }
        void this.blobService.deleteBlob(originalVideo.blobPathname);
      };
    }

    try {
      this.logger.log('Sending request to Gemini API...');

      const response = await this.genai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [videoPart, { text: ANALYSIS_PROMPT }],
        // JSON mode: with a second structured key (characters, spec §10)
        // we want the model held to JSON, not just asked for it. The
        // parser still tolerates fences/prose in case a model ignores it.
        config: { responseMimeType: 'application/json' },
      });

      this.logger.log('Received response from Gemini');

      // ТЗ §26: разбор — самый дорогой из текстовых вызовов (в него уходит
      // всё видео), поэтому расход пишется сразу, до разбора ответа: даже
      // если парсер ниже споткнётся, деньги уже потрачены и в отчёте
      // должны быть.
      await this.aiUsage.recordGemini(response, {
        operation: 'analysis',
        model: GEMINI_MODEL,
        sessionId,
      });

      // Tolerant parse (analysis-response.ts): sceneBreakdown behaves as
      // before; `characters` (spec §10) degrades to undefined when absent
      // or malformed rather than failing the analysis.
      const {
        sceneBreakdown,
        characters,
        frame,
        scenes,
        extras,
        audience,
        promotedProduct,
      } = parseAnalysisResponse(response?.text || '');
      this.logger.log(
        `Analysis parsed: ${sceneBreakdown.length} chars of breakdown, ${
          characters === undefined
            ? 'no characters key'
            : `${characters.length} character(s)`
        }`,
      );

      // Update session with complete analysis
      const session = await this.sessionService.getSession(sessionId);
      if (session?.videoAnalysis) {
        // Spec §16: Gemini's read of the picture format fills the frame
        // when the browser could not (YouTube links); an exact size read
        // from an uploaded file always wins over the model's estimate.
        const existingFrame = session.originalVideo?.frame;
        const nextFrame =
          existingFrame?.source === 'file'
            ? existingFrame
            : frame
              ? {
                  width: null,
                  height: null,
                  aspectRatio: frame,
                  source: 'gemini' as const,
                }
              : existingFrame;
        // Доп. запрос владельца продукта (ТЗ §9.4, этап 4 плана §14) —
        // длительность референса выводится из уже разобранных сцен
        // (`scenes[last].end`), не отдельным полем в схеме Gemini и не
        // через ffprobe — тот же принцип экономии вызовов, что у
        // `reframe.ts` («Почему без ffprobe»): сцены и так уже просят
        // "start"/"end" в секундах ОРИГИНАЛЬНОГО видео, последняя граница
        // и есть общая длительность.
        const referenceDurationSeconds =
          scenes && scenes.length > 0
            ? scenes[scenes.length - 1].end
            : undefined;
        await this.sessionService.updateSession(sessionId, {
          videoAnalysis: {
            ...session.videoAnalysis,
            status: AnalysisStatus.COMPLETE,
            sceneBreakdown,
            ...(characters !== undefined ? { characters } : {}),
            ...(scenes !== undefined ? { scenes } : {}),
            ...(extras !== undefined ? { extras } : {}),
            ...(audience !== undefined ? { audience } : {}),
            ...(promotedProduct !== undefined ? { promotedProduct } : {}),
            ...(referenceDurationSeconds !== undefined
              ? { referenceDurationSeconds }
              : {}),
          },
          ...(session.originalVideo && nextFrame
            ? { originalVideo: { ...session.originalVideo, frame: nextFrame } }
            : {}),
          status: SessionStatus.ANALYSIS_COMPLETE,
        });
        this.logger.log(`Analysis complete for session ${sessionId}`);

        // §21: store the finished analysis so the next user of the same
        // reference gets it for free — and so it can be recommended.
        const stored = await this.sessionService.getSession(sessionId);
        const key =
          originalVideo.sourceType === VideoSourceType.YOUTUBE
            ? youtubeSourceKey(originalVideo.youtubeUrl)
            : uploadKey;
        if (key && stored?.videoAnalysis) {
          await this.sessionService.updateSession(sessionId, {
            librarySourceKey: key,
          });
          await this.library.save({
            sourceKey: key,
            sourceType:
              originalVideo.sourceType === VideoSourceType.YOUTUBE
                ? 'youtube'
                : 'upload',
            sourceUrl:
              originalVideo.sourceType === VideoSourceType.YOUTUBE
                ? originalVideo.youtubeUrl
                : null,
            aspectRatio: nextFrame?.aspectRatio ?? null,
            analysis: stored.videoAnalysis,
            sessionId,
            // Author of the entry: not an owner (offer §5.2 — the analyses
            // belong to the service), but the one person a PRIVATE entry is
            // shown back to (§21.3), and the trail an operator follows.
            userId: stored.userId ?? null,
          });
        }
      }
    } catch (error) {
      this.logger.error('Analysis failed:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Gemini analysis failed: ${errorMessage}`);
    } finally {
      cleanup();
    }
  }

  /**
   * Get analysis status and results
   * @param sessionId - Session identifier
   * @returns Video analysis data
   */
  async getAnalysisStatus(sessionId: string): Promise<VideoAnalysis> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      throw new BadRequestException('Session not found');
    }

    if (!session.videoAnalysis) {
      throw new BadRequestException('Analysis not started');
    }

    return session.videoAnalysis;
  }

  /**
   * Update analysis with user edits
   * @param sessionId - Session identifier
   * @param editedText - User's edited analysis text
   * @returns Updated video analysis
   */
  async updateAnalysis(
    sessionId: string,
    editedText: string,
  ): Promise<VideoAnalysis> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      throw new BadRequestException('Session not found');
    }

    if (!session.videoAnalysis) {
      throw new BadRequestException('Analysis not started');
    }

    // Update with user edits
    const updatedAnalysis: VideoAnalysis = {
      ...session.videoAnalysis,
      userEdits: editedText,
    };

    await this.sessionService.updateSession(sessionId, {
      videoAnalysis: updatedAnalysis,
    });

    return updatedAnalysis;
  }

  /**
   * Доп. запрос владельца продукта — короткий образец РЕЧИ (не текста
   * на экране) из оригинального референсного видео, для пробы голоса
   * кандидатом на замену (§ этот же принцип, что уже применён к
   * `PromptService.extractLiteralTexts()`, только источник другой —
   * `sceneBreakdown` уже готового разбора, не сгенерированный промпт).
   *
   * НЕ клонирование голоса диктора оригинала — только вычленение ТЕКСТА
   * его реплик, чтобы кандидат-голос прочитал их СВОИМ голосом. Диктор
   * оригинала — почти всегда третье лицо (нанятый актёр озвучки из
   * чужой рекламы), не согласившееся на клонирование своего голоса —
   * тот же принцип, что уже защищает клонирование явным чекбоксом
   * согласия в `VoicePicker.tsx`/`UserVoicesController`.
   *
   * Кэшируется на `analysis.originalDialogueSample` — вычленяется один
   * раз, не на каждый клик «прослушать». `null` (не `undefined`) —
   * вычленено, но реплик в оригинале не было (не значит «повторить
   * попытку», в отличие от собственно отсутствия попытки).
   *
   * Best-effort, как и `extractLiteralTexts()`: сбой — `null`, не
   * исключение, проба голоса просто останется недоступна с этим
   * текстом, session не падает.
   */
  async extractOriginalDialogueSample(
    sessionId: string,
  ): Promise<string | null> {
    const session = await this.sessionService.getSession(sessionId);
    const analysis = session?.videoAnalysis;
    if (!analysis) return null;
    if (analysis.originalDialogueSample !== undefined) {
      return analysis.originalDialogueSample;
    }

    let sample: string | null = null;
    try {
      const response = await this.genai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          {
            text: `Below is a scene-by-scene breakdown of a reference video ad. Extract ONLY the spoken dialogue/voiceover lines (not scene descriptions, not on-screen text) as a single short sample suitable for a text-to-speech voice preview — combine the lines in order, ≤280 characters total. If there is no spoken dialogue/voiceover at all, respond with an empty string.\n\nBreakdown:\n${analysis.sceneBreakdown}\n\nRespond with a valid JSON object only: {"sample": "..."}`,
          },
        ],
        config: {
          temperature: 0.1,
          maxOutputTokens: 300,
          responseMimeType: 'application/json',
        },
      });
      await this.aiUsage.recordGemini(response, {
        operation: 'original-dialogue-extraction',
        model: GEMINI_MODEL,
        sessionId,
      });
      const raw = response?.text?.trim();
      if (raw) {
        const parsed = JSON.parse(raw) as { sample?: unknown };
        if (typeof parsed.sample === 'string' && parsed.sample.trim()) {
          sample = parsed.sample.trim().slice(0, 280);
        }
      }
    } catch (error) {
      this.logger.warn(
        `extractOriginalDialogueSample: вызов не удался (${error instanceof Error ? error.message : String(error)}) — сессия ${sessionId} продолжит без пробы оригинала`,
      );
      // Сбой вызова — НЕ кэшируем как "реплик нет" (`null`), в отличие
      // от genuинно пустого результата модели выше: транзиентная
      // ошибка не должна навсегда закрыть повторную попытку. Метод
      // просто вернёт null в этот раз, следующий вызов попробует снова
      // (originalDialogueSample останется `undefined` на сессии).
      return null;
    }

    // Кэшируем результат — успешный (строка) или genuинно пустой
    // (null) — на сессии, чтобы не звать модель повторно на каждый
    // клик «прослушать».
    const fresh = await this.sessionService.getSession(sessionId);
    if (fresh?.videoAnalysis) {
      await this.sessionService.updateSession(sessionId, {
        videoAnalysis: {
          ...fresh.videoAnalysis,
          originalDialogueSample: sample,
        },
      });
    }

    return sample;
  }
}
