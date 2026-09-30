/**
 * ProactiveSpeechService — помощник говорит сам (ТЗ
 * docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §4А.2 п.1, п.5,
 * §4А.7.4; этап K4).
 *
 * `POST /projects/:projectId/wizard-guide/speak` — вид реплики и коды,
 * никогда не текст (почему — в шапке `proactive-speech.ts`). Здесь:
 * прочитать состояние, собрать фразу, пропустить через регистр повода и
 * озвучить через ТОТ ЖЕ путь, что подсказку (`HintAudioService`):
 * аудиокеш, блокировка и суточный лимит, бюджет советника, потолок
 * голоса В-14.
 *
 * ## Сервер проверяет повод, а не верит клиенту
 *
 * «Ролик готов» звучит, только если ролик последней сессии и правда
 * готов; «сценарий помечен проверкой» — только если помечен; «лимит
 * исчерпан» — только если общий лимит расхода сейчас правда отказывает;
 * сводка перед согласием — только со сценарием и с ценой, которую можно
 * назвать. Иначе — 204: клиент мог ошибиться поводом, а помощник, который
 * говорит неправду вслух, хуже молчащего.
 *
 * ## Деградация
 *
 * Как у подсказки: всё, что не удалось, — `null` (204), текст на экране
 * остаётся. Говорят только об исчерпанном потолке голоса (В-14).
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanService } from '../plan/plan.service';
import { CreditLedgerService } from '../credit-ledger/credit-ledger.service';
import { DailySpendLimitExceededException } from '../../common/spend-limits';
import { hasRenderRight, wallEnabled } from '../../common/free-tier';
import { renderChargeOf, type ChargeFacts } from '../../common/render-charge';
import { registerOfBrief, tonesFor } from '../../common/greeting-policy';
import type {
  GreetingBriefSnapshot,
  GreetingOccasion,
  GreetingRegister,
} from '../../common/types/greeting.types';
import { GenerationStatus } from '../../common/types/generation.types';
import { HintAudioResult, HintAudioService } from './hint-audio.service';
import { mayVoiceInRegister, speechForRegister } from './hint-audio';
import { REPLIES } from '../../common/greeting-voice-replies';
import {
  greetingAnswer,
  greetingStateOf,
  greetingStateOfBrief,
  type GreetingSessionShape,
} from './hint-facts';
import {
  type SpeakRequest,
  consentSummarySpeech,
  lockedSpeech,
  quotaSpeech,
  speechCacheKey,
  toneRefusalSpeech,
  videoReadySpeech,
} from './proactive-speech';

/** Последняя сессия проекта — ровно поля, которые читает речь. */
type SessionRow = GreetingSessionShape & {
  greetingBriefSnapshot?: Partial<GreetingBriefSnapshot> | null;
};

@Injectable()
export class ProactiveSpeechService {
  private readonly logger = new Logger(ProactiveSpeechService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audio: HintAudioService,
    private readonly plan: PlanService,
    private readonly credits: CreditLedgerService,
  ) {}

  async speak(
    userId: string,
    projectId: string,
    req: SpeakRequest,
  ): Promise<HintAudioResult | null> {
    // Рубильник, владение (чужой — 404), советник и «голосом» — тот же
    // вход, что у озвучки подсказки: у проактивной речи нет своего права
    // говорить там, где подсказка молчит.
    const scenario = await this.audio.voicedScenario(userId, projectId);
    // Поводы K4 — поздравления: сессия, ролик, согласие. У остальных
    // мастеров голоса пока нет вовсе.
    if (scenario !== 'GREETING_VIDEO') return null;

    const text = await this.textFor(userId, projectId, req);
    if (!text) return null;

    const register = await this.audio.registerOf(scenario, projectId);
    // В-?: цена должна прозвучать. Сводка перед согласием — исключение из
    // траурного предела в 160 знаков (`speechForRegister`): «коротко»
    // выбросило бы из неё цену, а согласие без названной цены — не
    // согласие (§4А.7.4). Длину держит обрезка чужого текста до 60 знаков
    // (`speakUserText`). Фильтр регистра §3.7 — как у всех.
    const spoken =
      req.kind === 'consent-summary'
        ? mayVoiceInRegister(register, text)
          ? text
          : null
        : speechForRegister(register, text);
    if (!spoken) {
      this.logger.log(
        `речь «${req.kind}» не озвучена: не для регистра повода (проект ${projectId})`,
      );
      return null;
    }
    // Сводка несёт имя получателя — мимо общего публичного кеша: файл со
    // случайным именем под префиксом проекта, живёт не дольше часа.
    if (req.kind === 'consent-summary') {
      return this.audio.synthesizeEphemeral(userId, projectId, {
        text: spoken,
        lang: req.locale,
      });
    }
    return this.audio.synthesizeCached(
      userId,
      projectId,
      { cacheKey: speechCacheKey(req), text: spoken, lang: req.locale },
      // «Лимит исчерпан» — ровно тогда, когда общий лимит отказывает:
      // с его проверкой эта фраза не прозвучала бы никогда (CONTRACT5).
      // Бюджет советника и потолок голоса В-14 — как всегда.
      { skipUserSpend: req.kind === 'refusal' && req.refusal === 'quota' },
    );
  }

  /** Фраза по виду реплики — или `null`, если повода на самом деле нет. */
  private async textFor(
    userId: string,
    projectId: string,
    req: SpeakRequest,
  ): Promise<string | null> {
    switch (req.kind) {
      case 'video-ready': {
        const session = await this.latestSession(projectId);
        return session?.generatedVideo?.status === GenerationStatus.COMPLETE
          ? videoReadySpeech(req.locale)
          : null;
      }
      case 'answer': {
        // Темы нет — «не знаю, посмотрите справку» вслух: та же фраза,
        // что в строке разбора (CONTRACT5).
        if (!req.topic) return REPLIES[req.locale].questionUnknown;
        const session = await this.latestSession(projectId);
        // До старта сессии — живой бриф проекта: «что дальше?» на брифе
        // видит заполненное, а не «сессии нет».
        const state = session
          ? greetingStateOf(session)
          : greetingStateOfBrief(await this.liveBrief(projectId));
        return (
          greetingAnswer(req.topic, state, req.locale) ??
          REPLIES[req.locale].questionUnknown
        );
      }
      case 'consent-summary':
        return this.consentSummary(userId, projectId, req.locale);
      case 'refusal':
        switch (req.refusal) {
          case 'tone':
            return toneRefusalSpeech(
              req.locale,
              await this.allowedTones(projectId),
            );
          case 'moderation': {
            // Та же фраза, что ответ на «почему не проходит?», — из
            // фактов, и только если сценарий правда помечен.
            const state = greetingStateOf(await this.latestSession(projectId));
            return state?.promptFlagged
              ? greetingAnswer('script-flagged', state, req.locale)
              : null;
          }
          case 'quota':
            return (await this.dailyLimitReached(userId, projectId))
              ? quotaSpeech(req.locale)
              : null;
          case 'locked': {
            const charge = renderChargeOf(await this.chargeFacts(userId));
            return charge.kind === 'unknown' && charge.reason === 'locked'
              ? lockedSpeech(req.locale)
              : null;
          }
        }
    }
    return null;
  }

  /**
   * Сводка перед согласием (§4А.7.4): со сценарием, без идущего или
   * готового ролика (кнопка генерации тогда не нажимается, и согласия
   * голосом нет) и с ценой.
   *
   * Значения — из снимка брифа ПОСЛЕДНЕЙ сессии: рендерится именно он.
   * Качество и ведущий — запрошенные, как на карточке сводки у кнопки.
   * Цена — тем же решением, что у кабинета и клиента (`renderChargeOf`).
   */
  private async consentSummary(
    userId: string,
    projectId: string,
    locale: SpeakRequest['locale'],
  ): Promise<string | null> {
    const session = await this.latestSession(projectId);
    const brief = session?.greetingBriefSnapshot;
    if (!session?.generationPrompt || !brief?.occasion) return null;
    const status = session.generatedVideo?.status;
    if (status && status !== GenerationStatus.FAILED) return null;
    return consentSummarySpeech(locale, {
      recipient: brief.recipientName ?? '',
      occasion: brief.occasion,
      customOccasion: brief.customOccasionText ?? null,
      resolution: brief.requestedResolution ?? brief.resolvedResolution ?? '',
      presenter:
        brief.requestedPresenterProvider ??
        brief.resolvedPresenterProvider ??
        '',
      persona: !!brief.presenter,
      charge: renderChargeOf(await this.chargeFacts(userId)),
    });
  }

  /** Живой бриф проекта — для ответов до старта сессии. */
  private async liveBrief(
    projectId: string,
  ): Promise<Parameters<typeof greetingStateOfBrief>[0]> {
    return this.prisma.greetingBrief.findUnique({
      where: { projectId },
      select: {
        occasion: true,
        customOccasionText: true,
        recipientName: true,
        senderName: true,
        presenterProvider: true,
        presenterLookId: true,
      },
    });
  }

  /** Тоны, доступные поводу брифа проекта, — как на экране. */
  private async allowedTones(projectId: string): Promise<string[] | null> {
    const brief: {
      occasion: string;
      occasionRegister: GreetingRegister | null;
    } | null = await this.prisma.greetingBrief.findUnique({
      where: { projectId },
      select: { occasion: true, occasionRegister: true },
    });
    if (!brief) return null;
    const occasion = brief.occasion as GreetingOccasion;
    const register = registerOfBrief({
      occasion,
      occasionRegister: brief.occasionRegister,
    });
    return [...tonesFor(occasion, register)];
  }

  /** Общий лимит расхода отказывает именно суточным лимитом. */
  private async dailyLimitReached(
    userId: string,
    projectId: string,
  ): Promise<boolean> {
    try {
      await this.plan.assertCanSpendUser(userId, { projectId });
      return false;
    } catch (e) {
      return e instanceof DailySpendLimitExceededException;
    }
  }

  /**
   * Поля кабинета, от которых зависит цена, — те же, что `GET
   * /referrals/me` (`InviteService.stateOf`). Своим чтением, а не через
   * сервис кабинета: модуль кабинета сам импортирует модуль советника, и
   * обратный импорт замкнул бы цикл; а `stateOf` вдобавок догоняет
   * отложенные начисления и читает воронку приглашений — речи это не
   * нужно. Правило права (`hasRenderRight`) и решение цены
   * (`renderChargeOf`) — общие функции, не копии. Не прочиталось —
   * `null`, то есть цена неизвестна и сводки нет.
   */
  private async chargeFacts(userId: string): Promise<ChargeFacts | null> {
    try {
      const [user, balance] = await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: {
            liteUnlockedAt: true,
            liteRevokedAt: true,
            subscription: { select: { status: true, currentPeriodEnd: true } },
          },
        }) as Promise<{
          liteUnlockedAt: Date | null;
          liteRevokedAt: Date | null;
          subscription: { status: string; currentPeriodEnd: Date } | null;
        } | null>,
        this.credits.balanceOf(userId),
      ]);
      const sub = user?.subscription ?? null;
      // ACTIVE/RENEWING с неистёкшим периодом — как у кабинета и
      // `RenderAccessService.hasRight`.
      const hasActiveSubscription =
        !!sub &&
        (sub.status === 'ACTIVE' || sub.status === 'RENEWING') &&
        sub.currentPeriodEnd.getTime() > Date.now();
      return {
        wallEnabled: wallEnabled(),
        generationsAvailable: Math.max(balance, 0),
        unlocked: hasRenderRight({
          liteUnlockedAt: user?.liteUnlockedAt ?? null,
          liteRevokedAt: user?.liteRevokedAt ?? null,
          hasActiveSubscription,
        }),
      };
    } catch (e) {
      this.logger.warn(
        `цена для сводки не прочитана: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /**
   * Последняя сессия проекта — та, с которой работает мастер (как у
   * советника, `WizardHintService.factsOf`): `data` и `liveData` одним
   * объектом.
   */
  private async latestSession(projectId: string): Promise<SessionRow | null> {
    const row: { data: unknown; liveData: unknown } | null =
      await this.prisma.session.findFirst({
        where: { projectId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { data: true, liveData: true },
      });
    if (!row) return null;
    return {
      ...(row.data as Record<string, unknown>),
      ...(row.liveData as Record<string, unknown>),
    } as SessionRow;
  }
}
