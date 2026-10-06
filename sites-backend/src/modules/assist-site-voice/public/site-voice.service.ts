/**
 * Голос посетителя — распознавание вопроса и озвучка ответа (Э5; ТЗ
 * помощника §4.10, §4.13, §6.3, §6.6, §7.1–§7.3; план, Приложение А
 * «Этап 5»). Зовут маршруты `POST /widget/v1/voice` и `POST /widget/v1/tts`
 * (assist-widget/widget-voice.controller.ts) ПОСЛЕ сессии посетителя и
 * лимитов частоты. Вся база — AssistPublicDb (роль assist_public).
 *
 * Порядок (все потолки — ДО платного вызова, как у ответа модели):
 *  1. Доступность (voice-access.ts): рубильник, ключ, тариф, владелец.
 *  2. Единицы: лимит периода выбран — `limit` (чат и так уйдёт в форму
 *     заявки); доплату за голос в засчитанном диалоге занимает
 *     voice-dialog.ts атомарно.
 *  3. Резерв денег дня: сайт + платформа + ОТДЕЛЬНЫЙ потолок голоса сайта
 *     (SiteBudget.reserve с voiceCapMicroUsd); отказ — `limit`.
 *  4. Провайдер; учёт в site_ai_usage (`assist-stt` секунды, `assist-tts`
 *     символы); списание факта и снятие резерва — в finally.
 *
 * Звук вопроса: только `Buffer` в памяти запроса — ни база, ни Blob, ни лог;
 * после ответа провайдера буфер затирается нулями (Условия п.3.4, §6.3
 * «Аудио голоса — 0, транзитно»). У провайдера — удаление в finally
 * (SiteSonioxStt). Озвучка: текст — уже маскированный ответ из базы, кэш —
 * 7 дней по (сайт, голос, язык, текст).
 *
 * В логах — только id сайта, коды и числа (§6.6): ни текста, ни языка речи.
 */
import { Injectable, Logger } from '@nestjs/common';
import { WIDGET_DEFAULTS } from '../../../config/assist-defaults';
import {
  voicePlatformEnabled,
  voiceTicketKey,
} from '../../../config/voice-env';
import { AssistPublicDb } from '../../../prisma/assist-public-db.service';
import { estimateCost } from '../../../shared/ai-pricing';
import {
  effectiveLimit,
  readState,
  readUsage,
  siteDailyCapMicroUsd,
} from '../../assist-billing/public/entitlements';
import type { SubscriptionState } from '../../assist-billing/subscription-state';
import { SiteBudget } from '../../assist-site-chat/budget';
import type {
  WidgetSiteContext,
  WidgetVisitor,
} from '../../assist-site-chat/chat-types';
import { readPublishedConfig } from '../../assist-site-chat/published-config';
import { insertOnlyUsageDb } from '../../assist-site-chat/usage';
import { parsePersona } from '../../assist-site-setup/persona';
import { AiUsageRecorder } from '../../site-ai/usage-recorder';
import { VOICE_DEFAULTS, audioMimeOf, sniffAudio } from '../voice-config';
import { SiteSonioxStt } from './soniox-stt.client';
import { SiteSonioxTts, ttsLanguage } from './soniox-tts.client';
import { readTtsCache, ttsCacheKey, writeTtsCache } from './tts-cache';
import { speakableText } from './tts-text';
import {
  readVoiceSiteRow,
  voiceAccess,
  type VoiceAccess,
} from './voice-access';
import { siteSttTerms } from './stt-terms';
import { markVoiceDialog } from './voice-dialog';
import { issueVoiceTicket } from './voice-ticket';

export const STT_PRICING_MODEL = 'soniox-stt-async';

export interface VoiceCtx {
  site: WidgetSiteContext;
  visitor: WidgetVisitor;
}

/** Отказы голоса — коды маршрута (assist-widget переводит в REST-коды). */
export type VoiceFailure =
  | 'unavailable'
  | 'limit'
  | 'audio_invalid'
  | 'not_heard'
  | 'upstream'
  | 'not_found';

export type TranscribeResult =
  | { ok: true; text: string; lang: string | null; ticket: string | null }
  | { ok: false; failure: VoiceFailure };

export type SpeakResult =
  | { ok: true; audio: Buffer; mime: string; cached: boolean }
  | { ok: false; failure: VoiceFailure };

@Injectable()
export class SiteVoiceService {
  private readonly logger = new Logger(SiteVoiceService.name);
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  constructor(
    private readonly db: AssistPublicDb,
    private readonly budget: SiteBudget,
    private readonly usage: AiUsageRecorder,
    readonly stt: SiteSonioxStt,
    readonly tts: SiteSonioxTts,
  ) {}

  /** Доступность голоса сайта (конфиг виджета, маршруты, кабинет). */
  async access(
    site: Pick<WidgetSiteContext, 'siteId'>,
    state: Pick<SubscriptionState, 'planId'>,
  ): Promise<VoiceAccess> {
    const row = await readVoiceSiteRow(this.db, site.siteId);
    return voiceAccess({
      platformEnabled: voicePlatformEnabled(this.env),
      providerConfigured: this.stt.configured() && this.tts.configured(),
      planId: state.planId,
      siteActive:
        !!row &&
        row.enabled &&
        !row.chatPaused &&
        row.operatorBlockedAt === null,
      voiceConfig: row?.voiceConfig ?? null,
      capOverrideMicroUsd: row?.voiceDailyCapMicroUsd ?? null,
    });
  }

  // ── Распознавание ───────────────────────────────────────────────────────

  async transcribe(
    ctx: VoiceCtx,
    audio: Buffer,
    contentType: unknown,
  ): Promise<TranscribeResult> {
    const { site } = ctx;
    const now = this.now();
    try {
      // Заголовок — только допуск (`audio/*` из списка); тип для провайдера
      // — по байтам записи (заголовку клиента не верим).
      const mime = audioMimeOf(contentType) ? sniffAudio(audio) : null;
      if (
        !mime ||
        audio.length < VOICE_DEFAULTS.minAudioBytes ||
        audio.length > VOICE_DEFAULTS.maxAudioBytes
      ) {
        return { ok: false, failure: 'audio_invalid' };
      }
      const state = await readState(this.db, site.accountId, now);
      const access = await this.access(site, state);
      if (!access.input) return { ok: false, failure: 'unavailable' };
      if (!site.preview && !(await this.unitsLeft(site.accountId, state))) {
        return { ok: false, failure: 'limit' };
      }
      const capRow = await this.siteCap(site.siteId);
      const reserved = await this.budget.reserve(this.db, {
        siteId: site.siteId,
        siteCapMicroUsd: siteDailyCapMicroUsd(capRow, state),
        estMicroUsd: estimateCost(STT_PRICING_MODEL, {
          seconds: VOICE_DEFAULTS.sttReserveSeconds,
        }).costMicroUsd,
        voiceCapMicroUsd: access.capMicroUsd,
        now,
      });
      if (!reserved.ok) {
        this.logger.warn(`voice: ${reserved.denied} (site ${site.siteId})`);
        return { ok: false, failure: 'limit' };
      }
      let actual = 0;
      let termsCount = 0;
      let r: Awaited<ReturnType<SiteSonioxStt['transcribe']>>;
      try {
        // Подсказки распознаванию — только опубликованное ЭТОГО сайта
        // («Сайт»; «Админка» — свои, admin-stt-terms.ts), в лог — число.
        const [languageHints, terms] = await Promise.all([
          this.siteLanguages(site),
          siteSttTerms(this.db, site.siteId),
        ]);
        termsCount = terms.length;
        r = await this.stt.transcribe({
          audio,
          mimeType: mime,
          languageHints,
          terms,
        });
        if (r.billable) {
          actual = await this.record(site, 'assist-stt', STT_PRICING_MODEL, {
            seconds: r.seconds,
          });
        }
      } finally {
        await this.budget.settle(this.db, reserved.reservation, actual);
      }
      this.logger.log(
        `voice site=${site.siteId} bytes=${audio.length} s=${r.seconds} ok=${!!r.text} reason=${r.reason ?? '-'} terms=${termsCount}`,
      );
      if (!r.text) {
        return {
          ok: false,
          failure:
            r.reason === 'no_speech' || r.reason === 'empty'
              ? 'not_heard'
              : 'upstream',
        };
      }
      const text = r.text.slice(0, WIDGET_DEFAULTS.maxQuestionChars).trim();
      const key = voiceTicketKey(this.env);
      return {
        ok: true,
        text,
        lang: r.language,
        ticket: key
          ? issueVoiceTicket(key, {
              siteId: site.siteId,
              visitorId: ctx.visitor.visitorId,
              text,
              now,
              ttlMs: VOICE_DEFAULTS.ticketTtlMs,
            })
          : null,
      };
    } finally {
      // Звук вопроса не живёт дольше запроса (Условия п.3.4, §6.3).
      audio.fill(0);
    }
  }

  // ── Озвучка ─────────────────────────────────────────────────────────────

  async speak(ctx: VoiceCtx, messageId: string): Promise<SpeakResult> {
    const { site } = ctx;
    const now = this.now();
    const state = await readState(this.db, site.accountId, now);
    const access = await this.access(site, state);
    if (!access.output) return { ok: false, failure: 'unavailable' };
    // Только ответ ЭТОМУ посетителю на ЭТОМ сайте, готовый целиком: чужой id
    // неотличим от несуществующего (не оракул).
    const msg = await this.db.assistSiteMessage.findFirst({
      where: {
        id: messageId,
        siteId: site.siteId,
        role: { in: ['assistant', 'operator'] },
        streamState: 'complete',
        conversation: { visitorId: ctx.visitor.visitorId },
      },
      select: { conversationId: true, text: true, lang: true },
    });
    if (!msg) return { ok: false, failure: 'not_found' };
    const text = speakableText(msg.text, VOICE_DEFAULTS.ttsMaxChars);
    if (!text) return { ok: false, failure: 'not_found' };
    const voice = access.voiceId ?? this.tts.defaultVoice();
    const lang = ttsLanguage(msg.lang, text);
    const key = ttsCacheKey({ voice, lang, model: this.tts.model(), text });

    let out = await readTtsCache(this.db, site.siteId, key, now);
    const cached = !!out;
    if (!out) {
      if (!site.preview && !(await this.unitsLeft(site.accountId, state))) {
        return { ok: false, failure: 'limit' };
      }
      const reserved = await this.budget.reserve(this.db, {
        siteId: site.siteId,
        siteCapMicroUsd: siteDailyCapMicroUsd(
          await this.siteCap(site.siteId),
          state,
        ),
        estMicroUsd: estimateCost(this.tts.pricingModel(), {
          characters: text.length,
        }).costMicroUsd,
        voiceCapMicroUsd: access.capMicroUsd,
        now,
      });
      if (!reserved.ok) {
        this.logger.warn(`tts: ${reserved.denied} (site ${site.siteId})`);
        return { ok: false, failure: 'limit' };
      }
      let actual = 0;
      let res: Awaited<ReturnType<SiteSonioxTts['synthesize']>>;
      try {
        res = await this.tts.synthesize({ text, voice, lang });
        if (res.ok) {
          actual = await this.record(
            site,
            'assist-tts',
            this.tts.pricingModel(),
            {
              characters: res.characters,
            },
          );
        }
      } finally {
        await this.budget.settle(this.db, reserved.reservation, actual);
      }
      if (!res.ok) return { ok: false, failure: 'upstream' };
      out = { mime: res.mime, audio: res.audio };
      await writeTtsCache(this.db, {
        siteId: site.siteId,
        key,
        voice,
        lang,
        mime: res.mime,
        audio: res.audio,
        characters: res.characters,
        now,
      });
    }
    // Диалог с озвучкой — весом 2 (§7.1); доплата не поместилась — голос
    // этого диалога закрыт, чат продолжается текстом.
    const mark = await markVoiceDialog(this.db, {
      accountId: site.accountId,
      conversationId: msg.conversationId,
      state,
      preview: site.preview,
    });
    if (mark === 'denied') return { ok: false, failure: 'limit' };
    this.logger.log(
      `tts site=${site.siteId} chars=${text.length} cached=${cached}`,
    );
    return { ok: true, audio: out.audio, mime: out.mime, cached };
  }

  // ── вспомогательное ─────────────────────────────────────────────────────

  /** Хоть одна единица периода осталась (последнее слово — у атомарного захвата). */
  private async unitsLeft(
    accountId: string,
    state: SubscriptionState,
  ): Promise<boolean> {
    if (!state.planId) return false;
    const usage = await readUsage(this.db, accountId, state.periodKey);
    return usage.units < effectiveLimit(state, usage);
  }

  private async siteCap(siteId: string): Promise<number | null> {
    const rows = await this.db.$queryRawUnsafe<Array<{ cap: number | null }>>(
      `SELECT "dailyCapMicroUsd" AS cap FROM "sites"."assist_sites" WHERE "siteId" = $1`,
      siteId,
    );
    const c = rows[0]?.cap;
    return c === null || c === undefined ? null : Number(c);
  }

  /** Языки опубликованной персоны — подсказка распознаванию (по умолчанию первым). */
  private async siteLanguages(site: WidgetSiteContext): Promise<string[]> {
    try {
      const raw = await readPublishedConfig(
        this.db,
        site.siteId,
        'persona',
        site.configVersion,
      );
      const p = raw ? parsePersona(raw) : null;
      if (p?.ok) {
        const l = p.persona.languages;
        return [l.default, ...l.allowed.filter((x) => x !== l.default)];
      }
    } catch {
      /* без персоны — Soniox определит язык сам */
    }
    return [];
  }

  private async record(
    site: WidgetSiteContext,
    operation: 'assist-stt' | 'assist-tts',
    model: string,
    units: { seconds?: number; characters?: number },
  ): Promise<number> {
    const r = await this.usage.record(insertOnlyUsageDb(this.db), {
      accountId: site.accountId,
      siteId: site.siteId,
      operation,
      model,
      units,
    });
    return r.costMicroUsd;
  }
}
