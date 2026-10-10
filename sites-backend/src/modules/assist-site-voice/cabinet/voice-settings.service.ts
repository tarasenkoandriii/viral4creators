import { ttsFailureBudgetCost } from '../public/tts-budget';
import { sonioxScope } from '../../soniox-observability/soniox-context';
/**
 * Кабинет: голос виджета (Э5, ТЗ §3.5 «Голос: выбор голоса из пресетов
 * текущего TTS-провайдера, прослушать пример»; §4.10). Экран — раздел
 * «Голос» на экране персоны TMA (assist/src/screens/widget/PersonaScreen.tsx).
 *
 *  - GET  — настройка, доступность (тариф/платформа/ключ), голоса
 *    провайдера, потолок голоса и расход сегодня;
 *  - PATCH — сохранить: действует сразу (как настройки лидов Э2, без
 *    публикации персоны — voice-config.ts «почему не в персоне»). Включить
 *    можно только на тарифе с голосом (Business+); выключить — всегда;
 *  - POST sample — прослушать голос: короткая фраза на выбранном языке,
 *    платит суточный бюджет сайта (+ потолок голоса), кэш тот же, что у
 *    ответов (повторное прослушивание бесплатно).
 *
 * Основная роль (SitesDb.forAccount — кабинет владельца); права —
 * контроллер (manager, как персона и лиды).
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { voicePlatformEnabled } from '../../../config/voice-env';
import { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import { estimateCost } from '../../../shared/ai-pricing';
import { assistPlanAllows } from '../../assist-billing/plans';
import {
  readState,
  siteDailyCapMicroUsd,
} from '../../assist-billing/public/entitlements';
import { SiteBudget, utcDay } from '../../assist-site-chat/budget';
import { loadAssistSite } from '../../assist-site-setup/widget-settings.service';
import type { AccountMembership } from '../../site-core/account/roles';
import { AiUsageRecorder } from '../../site-ai/usage-recorder';
import type { VoiceSampleRequest, VoiceSettingsView } from '../api-types';
import { SiteSonioxStt } from '../public/soniox-stt.client';
import { SiteSonioxTts } from '../public/soniox-tts.client';
import { readTtsCache, ttsCacheKey, writeTtsCache } from '../public/tts-cache';
import { voiceAccess } from '../public/voice-access';
import { parseVoiceConfig, voiceConfigOf } from '../voice-config';
import { voiceCabinetError } from './voice-errors';

/** Фраза для прослушивания голоса — без данных сайта (кэш общий по голосу). */
export const VOICE_SAMPLE_TEXT = {
  uk: 'Вітаю! Я помічник цього сайту. Чим можу допомогти?',
  ru: 'Здравствуйте! Я помощник этого сайта. Чем могу помочь?',
  en: "Hello! I'm this website's assistant. How can I help?",
} as const;

@Injectable()
export class VoiceSettingsService {
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly prisma: PrismaService,
    private readonly budget: SiteBudget,
    private readonly usage: AiUsageRecorder,
    private readonly stt: SiteSonioxStt,
    private readonly tts: SiteSonioxTts,
  ) {}

  private db(m: AccountMembership) {
    return this.sitesDb.forAccount(m.accountId);
  }

  async get(m: AccountMembership, siteId: string): Promise<VoiceSettingsView> {
    const { row } = await loadAssistSite(this.db(m), m.accountId, siteId);
    const now = this.now();
    const state = await readState(this.prisma, m.accountId, now);
    const access = voiceAccess({
      platformEnabled: voicePlatformEnabled(this.env),
      providerConfigured: this.stt.configured() && this.tts.configured(),
      planId: state.planId,
      siteActive:
        row.enabled && !row.chatPaused && row.operatorBlockedAt === null,
      voiceConfig: row.voiceConfig,
      capOverrideMicroUsd: row.voiceDailyCapMicroUsd,
    });
    const spent = await this.prisma.$queryRawUnsafe<
      Array<{ spent: bigint | number }>
    >(
      `SELECT "spentMicroUsd" AS spent FROM "sites"."assist_budget_days"
        WHERE "scope" = 'voice' AND "key" = $1 AND "day" = $2`,
      siteId,
      utcDay(now),
    );
    return {
      siteId,
      config: access.config,
      available:
        voicePlatformEnabled(this.env) &&
        this.tts.configured() &&
        access.reason !== 'plan',
      reason: access.reason,
      voices: await this.tts.voices(),
      defaultVoice: this.tts.defaultVoice(),
      dailyCapMicroUsd: access.capMicroUsd,
      todaySpentMicroUsd: Number(spent[0]?.spent ?? 0),
    };
  }

  async save(
    m: AccountMembership,
    siteId: string,
    input: unknown,
  ): Promise<VoiceSettingsView> {
    const db = this.db(m);
    const { row } = await loadAssistSite(db, m.accountId, siteId);
    const p = parseVoiceConfig(input);
    if (!p.ok) {
      throw voiceCabinetError(
        HttpStatus.BAD_REQUEST,
        'VOICE_CONFIG_INVALID',
        'Настройки голоса не прошли проверку',
        { errors: p.errors },
      );
    }
    // Включить можно только на тарифе с голосом; оставить включённым после
    // смены тарифа и выключить — всегда (выключение безопасно).
    const prev = voiceConfigOf(row.voiceConfig);
    const turningOn =
      (p.config.input && !prev.input) || (p.config.output && !prev.output);
    if (turningOn) {
      const state = await readState(this.prisma, m.accountId, this.now());
      if (!assistPlanAllows(state.planId, 'voice')) {
        throw voiceCabinetError(
          HttpStatus.PAYMENT_REQUIRED,
          'VOICE_PLAN_REQUIRED',
          'Голос доступен на тарифе Business и выше',
        );
      }
    }
    if (p.config.voiceId) {
      const voices = await this.tts.voices();
      // Справочник не ответил — не блокируем (голос проверит синтез);
      // ответил — голос должен быть в нём.
      if (voices.length && !voices.some((v) => v.id === p.config.voiceId)) {
        throw voiceCabinetError(
          HttpStatus.BAD_REQUEST,
          'VOICE_CONFIG_INVALID',
          'Такого голоса у провайдера нет',
          { errors: [{ path: 'voiceId', code: 'unknown_voice' }] },
        );
      }
    }
    await db.assistSite.update({
      where: { id: row.id },
      data: { voiceConfig: p.config as unknown as Prisma.InputJsonValue },
    });
    return this.get(m, siteId);
  }

  async sample(
    m: AccountMembership,
    siteId: string,
    body: VoiceSampleRequest,
  ): Promise<{ audio: Buffer; mime: string }> {
    const { row } = await loadAssistSite(this.db(m), m.accountId, siteId);
    const now = this.now();
    const state = await readState(this.prisma, m.accountId, now);
    if (!voicePlatformEnabled(this.env) || !this.tts.configured()) {
      throw voiceCabinetError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'VOICE_UNAVAILABLE',
        'Голос сейчас недоступен',
      );
    }
    const access = voiceAccess({
      platformEnabled: true,
      providerConfigured: true,
      planId: state.planId,
      siteActive: true,
      voiceConfig: { schema: 1, input: false, output: true, voiceId: null },
      capOverrideMicroUsd: row.voiceDailyCapMicroUsd,
    });
    if (access.reason === 'plan') {
      throw voiceCabinetError(
        HttpStatus.PAYMENT_REQUIRED,
        'VOICE_PLAN_REQUIRED',
        'Голос доступен на тарифе Business и выше',
      );
    }
    const lang = body.lang === 'ru' || body.lang === 'en' ? body.lang : 'uk';
    const raw = typeof body.voiceId === 'string' ? body.voiceId.trim() : '';
    const parsed = parseVoiceConfig({
      input: false,
      output: true,
      voiceId: raw || null,
    });
    if (!parsed.ok) {
      throw voiceCabinetError(
        HttpStatus.BAD_REQUEST,
        'VOICE_CONFIG_INVALID',
        'Неверное имя голоса',
        { errors: parsed.errors },
      );
    }
    const voice = parsed.config.voiceId ?? this.tts.defaultVoice();
    const text = VOICE_SAMPLE_TEXT[lang];
    const key = ttsCacheKey({ voice, lang, model: this.tts.model(), text });
    const hit = await readTtsCache(this.prisma, siteId, key, now);
    if (hit) return hit;
    const reserved = await this.budget.reserve(this.prisma, {
      siteId,
      siteCapMicroUsd: siteDailyCapMicroUsd(row.dailyCapMicroUsd, state),
      estMicroUsd: estimateCost(this.tts.pricingModel(), {
        characters: text.length,
      }).costMicroUsd,
      voiceCapMicroUsd: access.capMicroUsd,
      now,
    });
    if (!reserved.ok) {
      throw voiceCabinetError(
        HttpStatus.TOO_MANY_REQUESTS,
        'VOICE_LIMIT',
        'Суточный бюджет голоса сайта исчерпан — попробуйте завтра',
      );
    }
    let actual = reserved.reservation.estMicroUsd;
    let res: Awaited<ReturnType<SiteSonioxTts['synthesize']>>;
    try {
      sonioxScope({ accountId: m.accountId, siteId });
      res = await this.tts.synthesize({ text, voice, lang });
      if (res.ok) {
        actual = (
          await this.usage.record(this.prisma, {
            accountId: m.accountId,
            siteId,
            operation: 'assist-tts',
            model: this.tts.pricingModel(),
            units: { characters: res.characters },
          })
        ).costMicroUsd;
      }
      if (!res.ok) {
        actual = ttsFailureBudgetCost(res, reserved.reservation.estMicroUsd);
      }
    } finally {
      await this.budget.settle(this.prisma, reserved.reservation, actual);
    }
    if (!res.ok) {
      throw voiceCabinetError(
        HttpStatus.BAD_GATEWAY,
        'UPSTREAM',
        'Провайдер голоса не ответил — попробуйте ещё раз',
      );
    }
    await writeTtsCache(this.prisma, {
      siteId,
      key,
      voice,
      lang,
      mime: res.mime,
      audio: res.audio,
      characters: res.characters,
      now,
    });
    return { audio: res.audio, mime: res.mime };
  }
}
