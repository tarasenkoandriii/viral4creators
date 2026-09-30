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
import { SESSION_NOT_FOUND } from '../../common/user-facing-errors';
import { SupportedLocale } from '../../common/locale';
import { createGeminiClient, geminiApiKey } from '../../common/gemini-client';
import { GEMINI_MODEL } from '../../common/gemini-model';
import {
  GREETING_VOICE_MAX_BYTES,
  voiceLanguageHints,
} from '../../common/greeting-voice';
import {
  REPLIES,
  VoiceBriefState,
  VoiceSessionState,
  VoiceUnderstandContext,
  VoiceUnderstandResult,
  briefStateFromRow,
  briefStateFromSnapshot,
  buildUnderstandPrompt,
  normalizeModelAnswer,
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
import { planAllows } from '../../common/plans';
import { GreetingVoiceService } from './greeting-voice.service';
import { audioExtension, VoiceUploadUrl } from './voice.service';
import {
  GreetingVoiceUnderstandRequestDto,
  GreetingVoiceUploadUrlRequestDto,
  ProjectGreetingVoiceUnderstandRequestDto,
} from './dto/greeting-voice.dto';

/**
 * Почему голос сейчас нельзя: потолок голоса, лимит аккаунта, нет входа,
 * советник выключен оператором.
 */
type VoiceRefusal = 'voice-cap' | 'account-limit' | 'login' | 'operator-off';

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
    const pathname = projectGreetingVoicePathname(projectId, dto.mimeType);
    const { uploadUrl } = await this.blobService.createUploadUrl(
      pathname,
      dto.mimeType,
      GREETING_VOICE_MAX_BYTES,
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
      throw new BadRequestException(`pathname должен начинаться с «${prefix}»`);
    }
    return this.run({
      pathname: dto.pathname,
      screen: dto.screen,
      pending: dto.pending ?? null,
      brief: briefStateFromRow(row),
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
      throw new BadRequestException(`pathname должен начинаться с «${prefix}»`);
    }
    return this.run({
      pathname: dto.pathname,
      screen: dto.screen,
      pending: dto.pending ?? null,
      brief: briefStateFromSnapshot(session.greetingBriefSnapshot!),
      scope: 'session',
      hasScript: !!session.generationPrompt,
      uiLocale,
      hintsLocale: session.locale,
      userId: session.userId ?? null,
      sessionId,
      assertPlanSpend: () => this.plans.assertCanSpendSession(sessionId),
      sessionState: () => this.sessionState(session),
    });
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
      const resolved = resolveIntent(
        normalizeModelAnswer(raw),
        transcript,
        ctx,
      );
      return {
        ...base,
        status: 'ok',
        intent: resolved.intent,
        confidence: resolved.confidence,
        reply: resolved.reply,
      };
    } finally {
      // Транзитная копия — не храним ни при каком исходе. С `await`: на
      // Vercel работа, не дождавшаяся ответа, может не выполниться вовсе.
      await this.blobService.deleteBlob(input.pathname);
    }
  }

  /**
   * Можно ли тратить на голос: `null` — да, иначе причина отказа.
   * Блокировка оператором и прочие отказы — наружу как есть (403).
   */
  private async gate(input: RunInput): Promise<VoiceRefusal | null> {
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
      if (e instanceof VoiceBudgetExhaustedException) return 'voice-cap';
      if (e instanceof VoiceLoginRequiredException) return 'login';
      if (e instanceof DailySpendLimitExceededException) return 'account-limit';
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
    const [voice, presets, clones, music, cards, sticker, scenes] =
      await Promise.all([
        safe(this.senderVoice.get(id)),
        // Экран тоже глотает сбой роестра и прячет блок пресетов.
        // Кеш и короткий потолок ожидания (аудит волны K2): реплика не
        // ждёт xAI дольше пары секунд, сбой — пустой список.
        this.senderVoice.listPresetVoicesQuick().catch(() => []),
        safe(this.readyClones(session.userId ?? null)),
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
