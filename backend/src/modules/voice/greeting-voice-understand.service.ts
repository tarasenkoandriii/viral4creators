/**
 * GreetingVoiceUnderstandService — голосовая реплика мастера поздравления
 * → поля брифа и команды. Этап K3 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.2 п.3–5.
 *
 * ## Два маршрута, один сервис
 *
 * Бриф заполняется ДО сессии (экран брифа проекта), а правится и после
 * старта. Поэтому вход двойной — `POST /projects/:projectId/greeting-voice/
 * understand` (под идентичностью, владелец проекта) и `POST /sessions/
 * :sessionId/voice/understand` (предъявитель UUID сессии, как у K2), — а
 * всё остальное общее: потолки, распознавание, разбор, проверка.
 *
 * ## Два шага, два вызова модели
 *
 * Распознавание — существующий путь K2 (`GreetingVoiceService.
 * recognizeRecording`, операция `voice-assistant-stt`), разбор — ОТДЕЛЬНЫЙ
 * текстовый вызов в JSON-режиме (`voice-assistant-understand`). Разделение
 * взято у Devil's Advocate (§4А.3, строка «Числа, даты»): одним вызовом
 * «звук → поля» ошибку распознавания не отличить от ошибки понимания, а
 * человек не увидел бы, что именно услышано.
 *
 * ## Порядок и деньги
 *
 * Владелец и бриф → потолки (общий лимит и потолок голоса В-14) → платное
 * распознавание → потолки ещё раз → платный разбор. Каждая проверка — до
 * своего вызова: между двумя вызовами потолок мог кончиться. Исчерпан
 * потолок ГОЛОСА — ответ `budget-exhausted`, а не ошибка: помощник
 * говорит об этом один раз, мастер работает руками. Исчерпан суточный
 * лимит АККАУНТА или голос выключен для сессии без владельца — ответ
 * `unavailable` со своей причиной (аудит волны K): это не «голос на
 * сегодня кончился», и путать их человеку нельзя.
 *
 * «Да» и «нет» на карточку подтверждения разбираются без модели
 * (`quickPendingAnswer`): самые частые реплики не должны стоить вызова.
 *
 * ## Приватность
 *
 * Запись транзитная: удаляется из Blob в `finally` при ЛЮБОМ исходе —
 * отказ по потолку, сбой модели, исключение (Условия, 3.4; шов check-docs
 * «голос не остаётся у провайдера»). Проверки владельца и префикса стоят
 * ДО `try`: чужой путь мы не читаем и не удаляем.
 *
 * Сервер ничего не применяет: разбор уходит карточкой «я понял так», и
 * применяет клиент после «Да» теми же обработчиками, что и ручной ввод.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionService } from '../../common/session.service';
import { Session } from '../../common/types/session.types';
import {
  SESSION_NOT_FOUND,
  VOICE_RECORDING_UPLOAD_FAILED,
} from '../../common/user-facing-errors';
import { SupportedLocale } from '../../common/locale';
import { createGeminiClient, geminiApiKey } from '../../common/gemini-client';
import { GEMINI_MODEL } from '../../common/gemini-model';
import { voiceLanguageHints } from '../../common/greeting-voice';
import { scriptLanguageOf } from '../../common/greeting-language';
import {
  REPLIES,
  VoiceBriefState,
  VoiceReason,
  VoiceSessionState,
  VoiceUnderstandContext,
  VoiceUnderstandResult,
  briefStateFromRow,
  briefStateFromSnapshot,
  buildUnderstandPrompt,
  normalizeModelAnswer,
  overlayCurrentBrief,
  quickPendingAnswer,
  quickNavigationAnswer,
  replyLocaleOf,
  resolveIntent,
  transcriptTooLong,
} from '../../common/greeting-voice-intent';
import { DailySpendLimitExceededException } from '../../common/spend-limits';
import {
  GREETING_PRESENTER_PROVIDERS,
  GreetingOccasion,
  GreetingPresenterProvider,
  GreetingRegister,
  GreetingTone,
} from '../../common/types/greeting.types';
import {
  maxGreetingResolutionFor,
  resolveGreetingConfig,
} from '../project/greeting-config';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { BlobService } from '../storage/blob.service';
import { PlanService } from '../plan/plan.service';
import {
  VoiceBudgetExhaustedException,
  VoiceBudgetService,
  VoiceLoginRequiredException,
} from '../voice-budget/voice-budget.service';

import { GreetingVoiceService as GreetingSenderVoiceService } from '../greeting-voice/greeting-voice.service';
import { GreetingMusicService } from '../greeting-music/greeting-music.service';
import { GreetingCardsService } from '../greeting-cards/greeting-cards.service';
import { GreetingStickerService } from '../greeting-sticker/greeting-sticker.service';
import { GreetingScenesService } from '../greeting-scenes/greeting-scenes.service';
import { WizardGuideService } from '../wizard-guide/wizard-guide.service';
import {
  GreetingState,
  greetingAnswer,
  greetingStateOf,
  greetingStateOfBrief,
} from '../wizard-guide/hint-facts';
import { planAllows } from '../../common/plans';
import {
  GreetingVoiceResult,
  GreetingVoiceService,
  assertGreetingVoiceSize,
} from './greeting-voice.service';
import { VoiceUploadService } from '../voice-upload/voice-upload.service';
import { audioExtension, VoiceUploadUrl } from './voice.service';
import {
  GreetingVoiceTranscribeRequestDto,
  GreetingVoiceUnderstandRequestDto,
  GreetingVoiceUploadUrlRequestDto,
  ProjectGreetingVoiceUnderstandRequestDto,
} from './dto/greeting-voice.dto';

/**
 * Почему голос сейчас нельзя: потолок голоса, лимит аккаунта, нет входа,
 * советник выключен оператором.
 */
type VoiceRefusal = 'voice-cap' | 'account-limit' | 'login' | 'operator-off';

/**
 * Причина в ответе (изменение контракта 2 финального аудита): клиент по
 * ней решает, слушать ли дальше. Потолок голоса причины не получает — у
 * него свой статус `budget-exhausted`.
 */
const REASON_OF: Readonly<Record<VoiceRefusal, VoiceReason | null>> = {
  'voice-cap': null,
  'account-limit': 'account-limit',
  login: 'login-required',
  'operator-off': 'operator-off',
};

/** Исключение потолка → причина отказа; прочее — `null` (наружу как есть). */
function refusalOf(e: unknown): VoiceRefusal | null {
  if (e instanceof VoiceBudgetExhaustedException) return 'voice-cap';
  if (e instanceof VoiceLoginRequiredException) return 'login';
  if (e instanceof DailySpendLimitExceededException) return 'account-limit';
  return null;
}

/** Что нужно входу (`gate`): чей расход и общий лимит. */
type GateInput = Pick<RunInput, 'userId' | 'assertPlanSpend'>;

/** Ключ записи брифа до сессии: в префиксе проекта и с отметкой времени. Экспорт — для тестов. */
export function projectGreetingVoicePathname(
  projectId: string,
  mimeType: string,
  now: Date = new Date(),
): string {
  return `projects/${projectId}/greeting-voice-${now.getTime()}.${audioExtension(mimeType)}`;
}

/** Что тариф разрешает выбрать — тем же гейтом, что правка брифа. */
export function planChoices(
  plan: Parameters<typeof resolveGreetingConfig>[0],
): {
  presenters: GreetingPresenterProvider[];
  maxResolution: ReturnType<typeof maxGreetingResolutionFor>;
} {
  const presenters = GREETING_PRESENTER_PROVIDERS.filter((p) => {
    try {
      resolveGreetingConfig(plan, { presenterProvider: p });
      return true;
    } catch {
      return false;
    }
  });
  return { presenters, maxResolution: maxGreetingResolutionFor(plan) };
}

interface GreetingBriefRow {
  occasion: GreetingOccasion;
  customOccasionText: string | null;
  occasionRegister: GreetingRegister | null;
  registerSource: string | null;
  userOccasionRegister: GreetingRegister | null;
  scriptLanguage: string | null;
  recipientName: string;
  senderName: string | null;
  tone: GreetingTone;
  personalMessage: string | null;
  presenterProvider: string;
  resolution: string;
  occasionDate: Date | null;
  /** Образ персоны в кадре (этап G) — для ответов о фото (K4). */
  presenterLookId?: string | null;
}

interface RunInput {
  pathname: string;
  screen: VoiceUnderstandContext['screen'];
  pending: VoiceUnderstandContext['pending'];
  brief: VoiceBriefState;
  scope: VoiceUnderstandContext['scope'];
  hasScript: boolean;
  uiLocale: SupportedLocale;
  /** Язык интерфейса для подсказок распознаванию (у сессии — её локаль, как у K2). */
  hintsLocale: string | null | undefined;
  userId: string | null;
  sessionId: string | null;
  /** Общий лимит расхода (блокировка + суточный лимит тарифа). */
  assertPlanSpend: () => Promise<void>;
  /**
   * Элементы сессии на экране (K5) — только у сессионного маршрута.
   * Зовётся ПОСЛЕ быстрых путей («да»/«нет»): им состояние не нужно.
   */
  sessionState?: () => Promise<VoiceSessionState>;
  /**
   * K4: состояние поздравления для ответов на вопросы о шаге — то же
   * чтение, что у советника (`greetingStateOf`). До сессии — `null`.
   */
  greeting: GreetingState | null;
}

@Injectable()
export class GreetingVoiceUnderstandService {
  private readonly logger = new Logger(GreetingVoiceUnderstandService.name);
  private readonly genai: GoogleGenAI | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly blobService: BlobService,
    private readonly greetingVoice: GreetingVoiceService,
    private readonly plans: PlanService,
    private readonly voiceBudget: VoiceBudgetService,
    private readonly aiUsage: AiUsageService,
    private readonly senderVoice: GreetingSenderVoiceService,
    private readonly music: GreetingMusicService,
    private readonly cards: GreetingCardsService,
    private readonly stickers: GreetingStickerService,
    private readonly scenes: GreetingScenesService,
    private readonly guide: WizardGuideService,
    private readonly voiceUploads: VoiceUploadService,
  ) {
    this.genai = geminiApiKey() ? createGeminiClient() : null;
  }

  // ── Маршруты ──────────────────────────────────────────────────────────

  async createProjectUploadUrl(
    userId: string,
    projectId: string,
    dto: GreetingVoiceUploadUrlRequestDto,
  ): Promise<VoiceUploadUrl> {
    await this.loadProjectBrief(userId, projectId);
    // Потолок байт — по типу записи (минута, изменение контракта 4).
    const maxBytes = assertGreetingVoiceSize(dto);
    const pathname = projectGreetingVoicePathname(projectId, dto.mimeType);
    // Учёт выданного пути — до ссылки: необработанную запись удалит крон
    // `voice-uploads-sweep` в пределах часа (финальный аудит ветки K).
    await this.voiceUploads.remember(pathname);
    const { uploadUrl } = await this.blobService.createUploadUrl(
      pathname,
      dto.mimeType,
      maxBytes,
    );
    return { uploadUrl, pathname };
  }

  async understandForProject(
    userId: string,
    projectId: string,
    dto: ProjectGreetingVoiceUnderstandRequestDto,
    uiLocale: SupportedLocale,
  ): Promise<VoiceUnderstandResult> {
    const row = await this.loadProjectBrief(userId, projectId);
    const prefix = `projects/${projectId}/greeting-voice-`;
    if (!dto.pathname.startsWith(prefix)) {
      this.logger.warn(`запись пришла с чужим путём ${dto.pathname}`);
      throw new BadRequestException(VOICE_RECORDING_UPLOAD_FAILED);
    }
    return this.run({
      pathname: dto.pathname,
      screen: dto.screen,
      pending: dto.pending ?? null,
      // Значения на экране поверх сохранённого — только для проверки и
      // модели (изменение контракта 1); ничего не сохраняется.
      brief: overlayCurrentBrief(briefStateFromRow(row), dto.current),
      scope: 'project',
      hasScript: false,
      uiLocale,
      hintsLocale: uiLocale,
      userId,
      sessionId: null,
      // Проект передаётся: по нему определяется сценарий тестового
      // доступа, как у голоса товара.
      assertPlanSpend: () =>
        this.plans.assertCanSpendUser(userId, { projectId }),
      // До сессии — живой бриф (CONTRACT5): «что дальше?» видит заполненное.
      greeting: greetingStateOfBrief(row),
    });
  }

  async understandForSession(
    sessionId: string,
    dto: GreetingVoiceUnderstandRequestDto,
    uiLocale: SupportedLocale,
  ): Promise<VoiceUnderstandResult> {
    const session = await this.loadSession(sessionId);
    const prefix = `sessions/${sessionId}/`;
    if (!dto.pathname.startsWith(prefix)) {
      this.logger.warn(`запись пришла с чужим путём ${dto.pathname}`);
      throw new BadRequestException(VOICE_RECORDING_UPLOAD_FAILED);
    }
    return this.run({
      pathname: dto.pathname,
      screen: dto.screen,
      pending: dto.pending ?? null,
      brief: overlayCurrentBrief(
        briefStateFromSnapshot(session.greetingBriefSnapshot!),
        dto.current,
      ),
      scope: 'session',
      hasScript: !!session.generationPrompt,
      uiLocale,
      hintsLocale: session.locale,
      userId: session.userId ?? null,
      sessionId,
      assertPlanSpend: () => this.plans.assertCanSpendSession(sessionId),
      sessionState: () => this.sessionState(session),
      greeting: greetingStateOf(session),
    });
  }

  /**
   * `POST /sessions/:sessionId/voice/transcribe` (K2) — за тем же входом,
   * что разбор (финальный аудит ветки K): выключатель оператора и
   * потолки до платного вызова, и они же — перед повтором и запасным
   * путём. Клиент мастера этим маршрутом больше не пользуется, но маршрут
   * жив, и обходить выключатель через него было нельзя.
   */
  async transcribeForSession(
    sessionId: string,
    dto: GreetingVoiceTranscribeRequestDto,
  ): Promise<GreetingVoiceResult> {
    const session = await this.loadSession(sessionId);
    const prefix = `sessions/${sessionId}/`;
    if (!dto.pathname.startsWith(prefix)) {
      this.logger.warn(`запись пришла с чужим путём ${dto.pathname}`);
      throw new BadRequestException(VOICE_RECORDING_UPLOAD_FAILED);
    }
    const input: GateInput = {
      userId: session.userId ?? null,
      assertPlanSpend: () => this.plans.assertCanSpendSession(sessionId),
    };
    // Подсказки языка — те же, что уйдут распознаванию: ответ отказа
    // честно говорит, с какими языками слушали бы.
    const snapshot = session.greetingBriefSnapshot!;
    const hints = voiceLanguageHints(snapshot.scriptLanguage, session.locale);
    const refusedWith = (why: VoiceRefusal): GreetingVoiceResult => ({
      status: why === 'voice-cap' ? 'budget-exhausted' : 'unavailable',
      text: null,
      scriptMismatch: false,
      hints,
      language: null,
      reason: REASON_OF[why],
    });
    try {
      const refusal = await this.gate(input);
      if (refusal) return refusedWith(refusal);
      try {
        return await this.greetingVoice.transcribe(sessionId, dto, () =>
          this.gate(input).then(
            (r) => r === null,
            () => false,
          ),
        );
      } catch (e) {
        // Внутри расшифровки потолки проверяются ещё раз (K2), и между
        // двумя проверками лимит мог кончиться: тот же ответ, что у
        // входа, а не 403.
        const why = refusalOf(e);
        if (why) return refusedWith(why);
        throw e;
      }
    } finally {
      // Отказ входа тоже обязан убрать запись; после расшифровки она уже
      // удалена — повтор безвреден.
      // Строка учёта снимается только после настоящего удаления: не
      // удалилось — крон `voice-uploads-sweep` повторит (аудит после раунда).
      if (await this.blobService.deleteBlob(dto.pathname)) {
        await this.voiceUploads.forget(dto.pathname);
      }
    }
  }

  // ── Общий путь ────────────────────────────────────────────────────────

  private async run(input: RunInput): Promise<VoiceUnderstandResult> {
    try {
      // Потолки — внутри `try`: отказ тоже обязан убрать запись.
      const gate = await this.gate(input);
      if (gate) return this.refused(gate, input.uiLocale, null, null);

      const recognized = await this.greetingVoice.recognizeRecording({
        pathname: input.pathname,
        hints: voiceLanguageHints(
          input.brief.scriptLanguage,
          input.hintsLocale,
        ),
        names: [input.brief.recipientName, input.brief.senderName],
        owner: input.sessionId
          ? { sessionId: input.sessionId }
          : { userId: input.userId },
        canSpendAgain: () =>
          this.gate(input).then(
            (refusal) => refusal === null,
            () => false,
          ),
      });
      const language = recognized.language;
      const replyLocale = replyLocaleOf(language, input.uiLocale);
      const t = REPLIES[replyLocale];
      const base = {
        transcript: recognized.text,
        language,
        scriptMismatch: recognized.scriptMismatch,
      };

      // Длиннее минуты (изменение контракта 4) — без платного разбора;
      // клиент показывает реплику и слушает дальше.
      if (recognized.reason === 'too-long') {
        return {
          ...base,
          status: 'unavailable',
          transcript: null,
          intent: null,
          confidence: 0,
          reply: t.transcriptTooLong,
          reason: 'too-long',
        };
      }
      // Недоступно — возможно, не провайдер, а вход: запасной путь после
      // сбоя Soniox не пущен потолком, или выключатель щёлкнул между
      // вызовами. Тогда ответ — причиной входа, а не «недоступно».
      if (recognized.status === 'unavailable') {
        const why = await this.gate(input).catch(() => null);
        if (why) return this.refused(why, input.uiLocale, null, language);
      }

      if (recognized.status !== 'ok' || !recognized.text) {
        return {
          ...base,
          status:
            recognized.status === 'unavailable' ? 'unavailable' : 'not-heard',
          transcript: null,
          intent: null,
          confidence: 0,
          reply:
            recognized.status === 'unavailable' ? t.unavailable : t.notHeard,
        };
      }
      // Дважды услышано латиницей на кириллическом языке (K2): текст
      // показывается, но не разбирается — переспрос, а не догадка.
      if (recognized.scriptMismatch) {
        return {
          ...base,
          status: 'ok',
          intent: { kind: 'unknown' },
          confidence: 0,
          reply: t.scriptMismatch,
        };
      }
      // Уверенность модели понимания не исправляет ошибку распознавания.
      // В частности, неуверенное «да» не должно подтверждать карточку.
      const speechConfidence = recognized.speechConfidence;
      if (typeof speechConfidence === 'number' && speechConfidence < 0.6) {
        return {
          ...base,
          status: 'ok',
          intent: { kind: 'unknown' },
          confidence: speechConfidence,
          reply: t.notHeard,
        };
      }
      const transcript = recognized.text;

      const quick = input.pending ? quickPendingAnswer(transcript) : null;
      if (quick) {
        return {
          ...base,
          status: 'ok',
          intent: { kind: quick },
          confidence: 1,
          reply: null,
        };
      }

      // K6: «дальше», «к сценарию», «что здесь?» — тоже без модели.
      // Доступность шага решает клиент по своему степперу (§4А.7.2).
      const quickNav = input.pending ? null : quickNavigationAnswer(transcript);
      if (quickNav) {
        return {
          ...base,
          status: 'ok',
          intent: quickNav,
          confidence: 1,
          reply: null,
        };
      }

      // Реплика длиннее самого длинного поля брифа — не разбираем, а
      // просим короче: обрезанная диктовка молча потеряла бы хвост текста.
      if (transcriptTooLong(transcript)) {
        return {
          ...base,
          status: 'ok',
          intent: { kind: 'unknown' },
          confidence: 0,
          reply: t.transcriptTooLong,
        };
      }

      // Второй платный вызов — потолки ещё раз.
      const again = await this.gate(input);
      if (again) {
        return this.refused(again, input.uiLocale, transcript, language);
      }

      const plan = await this.plans.planOfUser(input.userId);
      const session = input.sessionState ? await input.sessionState() : null;
      const ctx: VoiceUnderstandContext = {
        brief: input.brief,
        ...planChoices(plan),
        scope: input.scope,
        hasScript: input.hasScript,
        screen: input.screen,
        pending: input.pending,
        uiLocale: input.uiLocale,
        replyLocale,
        session,
        // K4: ответ на вопрос о шаге — из фактов, не от модели.
        answerQuestion: (topic, locale) =>
          greetingAnswer(topic, input.greeting, locale),
      };
      const raw = await this.parse(transcript, ctx, input);
      if (raw === null) {
        return {
          ...base,
          status: 'unavailable',
          intent: null,
          confidence: 0,
          reply: t.unavailable,
        };
      }
      const answer = normalizeModelAnswer(raw);
      if (typeof speechConfidence === 'number')
        answer.confidence = Math.min(answer.confidence, speechConfidence);
      const resolved = resolveIntent(answer, transcript, ctx);
      return {
        ...base,
        status: 'ok',
        intent: resolved.intent,
        confidence: resolved.confidence,
        reply: resolved.reply,
        // K4: отказ, который помощник объяснит голосом, — только если был.
        ...(resolved.refusal ? { refusal: resolved.refusal } : {}),
      };
    } finally {
      // Транзитная копия — не храним ни при каком исходе. С `await`: на
      // Vercel работа, не дождавшаяся ответа, может не выполниться вовсе.
      // Строка учёта снимается только после настоящего удаления: не
      // удалилось — крон `voice-uploads-sweep` повторит (аудит после раунда).
      if (await this.blobService.deleteBlob(input.pathname)) {
        await this.voiceUploads.forget(input.pathname);
      }
    }
  }

  /**
   * Можно ли тратить на голос: `null` — да, иначе причина отказа.
   * Блокировка оператором и прочие отказы — наружу как есть (403).
   */
  private async gate(input: GateInput): Promise<VoiceRefusal | null> {
    // Выключатель оператора (аудит волны K, B2): голосовой помощник —
    // канал советника, и тот же переключатель, что гасит подсказки и их
    // озвучку (`hint-audio`), гасит и разбор реплик — до любого платного
    // вызова. Бюджетом он не является: это решение оператора, поэтому
    // ответ `unavailable`, а не «лимит на сегодня».
    if (!(await this.guide.available())) return 'operator-off';
    try {
      await input.assertPlanSpend();
      await this.voiceBudget.assertCanSpendVoice(input.userId);
      return null;
    } catch (e) {
      const why = refusalOf(e);
      if (why) return why;
      throw e;
    }
  }

  private refused(
    why: VoiceRefusal,
    uiLocale: SupportedLocale,
    transcript: string | null,
    language: string | null,
  ): VoiceUnderstandResult {
    const t = REPLIES[replyLocaleOf(language, uiLocale)];
    return {
      // Только потолок ГОЛОСА — `budget-exhausted`: клиент говорит «голос на
      // сегодня выключен» и больше не слушает до завтра. Лимит аккаунта и
      // выключенный голос без входа — своя причина репликой.
      status: why === 'voice-cap' ? 'budget-exhausted' : 'unavailable',
      transcript,
      language,
      intent: null,
      confidence: 0,
      reply:
        why === 'voice-cap'
          ? t.budgetExhausted
          : why === 'login'
            ? t.loginRequired
            : why === 'operator-off'
              ? t.unavailable
              : t.accountLimit,
      scriptMismatch: false,
      reason: REASON_OF[why],
    };
  }

  /**
   * Разбор реплики моделью. Никогда не бросает: сбой, таймаут, нет ключа —
   * `null`, и ответ помощника — «недоступно, введите руками». Ответ модели
   * возвращается СЫРЫМ: его форму проверяет `normalizeModelAnswer`.
   */
  private async parse(
    transcript: string,
    ctx: VoiceUnderstandContext,
    input: RunInput,
  ): Promise<string | null> {
    if (!this.genai) return null;
    try {
      const response = await this.genai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ text: buildUnderstandPrompt(transcript, ctx) }],
        // Ответ короткий, но модель с размышлениями тратит на них тот же
        // бюджет выхода — с малым потолком JSON мог прийти обрезанным.
        config: {
          responseMimeType: 'application/json',
          temperature: 0,
          maxOutputTokens: 2048,
        },
      });
      await this.aiUsage.recordGemini(response, {
        operation: 'voice-assistant-understand',
        model: GEMINI_MODEL,
        userId: input.userId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      });
      return response?.text ?? '';
    } catch (e) {
      this.logger.warn(
        `разбор реплики не удался: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  // ── Элементы сессии (K5) ──────────────────────────────────────────────

  /**
   * Что сейчас на экране у карточек сессии — из ТЕХ ЖЕ представлений,
   * что сервисы карточек отдают экрану (`get`/`view`): доступные темы
   * уже отфильтрованы по поводу и регистру, потолок сцен — по регистру,
   * наклейки — по регистру и ключу стенда. Своей копии этих правил у
   * голоса нет, значит и разойтись им негде.
   *
   * Без сценария блока «Характер ролика» на экране нет — и запросов нет.
   * Не загрузилось представление — карточки для голоса нет (`null`):
   * экран в этом случае тоже её не показывает или показывает без
   * знания о выборе, и угадывать за него нельзя. Никогда не бросает:
   * сбой соседнего сервиса не должен ронять разбор брифа.
   */
  private async sessionState(session: Session): Promise<VoiceSessionState> {
    const empty: VoiceSessionState = {
      voice: null,
      music: null,
      cards: null,
      sticker: null,
      scenes: null,
    };
    if (!session.generationPrompt) return empty;
    const id = session.sessionId;
    const safe = <T>(p: Promise<T>): Promise<T | null> =>
      p.catch((e: unknown) => {
        this.logger.warn(
          `состояние карточки для голоса не прочитано: ${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
      });
    const [voice, presets, clones, soniox, music, cards, sticker, scenes] =
      await Promise.all([
        safe(this.senderVoice.get(id)),
        // Экран тоже глотает сбой роестра и прячет блок пресетов.
        // Кеш и короткий потолок ожидания (аудит волны K2): реплика не
        // ждёт xAI дольше пары секунд, сбой — пустой список.
        this.senderVoice.listPresetVoicesQuick().catch(() => []),
        safe(this.readyClones(session.userId ?? null)),
        // S2: каталог Soniox — на том же языке, что раздел экрана (язык
        // поздравления), с тем же кешем и потолком ожидания, что роестр.
        this.senderVoice
          .listSonioxVoicesQuick(
            scriptLanguageOf(session.greetingBriefSnapshot, session.locale),
          )
          .catch(() => []),
        safe(this.music.get(id)),
        safe(this.cards.get(id)),
        safe(this.stickers.view(id, '')),
        safe(this.scenes.get(id)),
      ]);
    return {
      voice: voice
        ? {
            presets: presets.map((p) => ({ id: p.voiceId, name: p.name })),
            clones: clones ?? [],
            presetVoiceId: voice.presetVoiceId,
            cloneId: voice.senderVoice?.resembleVoiceId ?? null,
            soniox: soniox.map((v) => ({ id: v.voiceId, name: v.name })),
            sonioxVoiceId: voice.sonioxVoice?.voiceId ?? null,
            sonioxSelected: !!voice.sonioxVoice,
          }
        : null,
      music: music
        ? {
            themes: music.themes.map((t) => ({ id: t.id, title: t.title })),
            // Тема каталога подсвечена на экране только у каталожного
            // выбора: свой трек с тем же id темой не считается.
            selectedId:
              music.selected &&
              (music.selected.source ?? 'catalog') === 'catalog'
                ? music.selected.id
                : null,
            hasSelection: !!music.selected,
            libraryEnabled: music.libraryEnabled,
          }
        : null,
      cards: cards
        ? {
            title: cards.cards.title ?? null,
            closing: cards.cards.closing ?? null,
          }
        : null,
      sticker: sticker
        ? {
            configured: sticker.configured,
            allowed: sticker.allowed !== false,
            selected: !!sticker.selected,
            placement: sticker.selected?.placement ?? null,
          }
        : null,
      scenes: scenes
        ? { sceneCount: scenes.sceneCount, maxScenes: scenes.maxScenes }
        : null,
    };
  }

  /**
   * Свои ГОТОВЫЕ клоны — тот же отбор, что у выбора клона
   * (`GreetingVoiceService.resolveOwnClone`: свой, `READY`, с
   * `resembleVoiceId`): список, который голос предлагает, не шире
   * того, что примет «Да».
   */
  private async readyClones(
    userId: string | null,
  ): Promise<Array<{ id: string; label: string }>> {
    if (!userId) return [];
    // Тот же гейт тарифа, что у экрана (`useFeature('voiceCloning')`) и у
    // записи клона (`UserVoicesService`): без возможности тарифа своих
    // голосов на экране нет — нет их и у голоса (аудит волны K2).
    if (!planAllows(await this.plans.planOfUser(userId), 'voiceCloning')) {
      return [];
    }
    const rows: Array<{ label: string; resembleVoiceId: string | null }> =
      await this.prisma.userVoice.findMany({
        where: { userId, status: 'READY', resembleVoiceId: { not: null } },
        select: { label: true, resembleVoiceId: true },
      });
    return rows
      .filter((r) => !!r.resembleVoiceId)
      .map((r) => ({ id: r.resembleVoiceId!, label: r.label }));
  }

  // ── Владелец ──────────────────────────────────────────────────────────

  private async loadProjectBrief(
    userId: string,
    projectId: string,
  ): Promise<GreetingBriefRow> {
    // Владение — через проект, `deletedAt: null`: бриф мягко удалённого
    // проекта — 404, как всё под ним (тот же запрос, что у
    // `GreetingBriefService.findOwnBrief`).
    const row: GreetingBriefRow | null =
      await this.prisma.greetingBrief.findFirst({
        where: { projectId, project: { userId, deletedAt: null } },
      });
    if (!row) {
      throw new NotFoundException('Бриф поздравления не найден');
    }
    return row;
  }

  private async loadSession(sessionId: string): Promise<Session> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(SESSION_NOT_FOUND);
    if (!session.greetingBriefSnapshot) {
      throw new NotFoundException('это не поздравительная сессия');
    }
    return session;
  }
}
