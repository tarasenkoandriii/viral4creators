/**
 * TtsController — каталог голосов и проба голоса (ТЗ §15.3).
 *
 *   GET  /tts/voices?language=   список голосов провайдера
 *   POST /tts/preview            короткая фраза выбранным голосом
 *
 * Каталог — отдельный маршрут, а не поле в манифесте: список живёт у
 * провайдера, меняется без нас и в базу не копируется — копия устареет в
 * первый же день, а выбранный голос всё равно хранится идентификатором.
 *
 * За TelegramIdentityGuard, как и манифесты: и то и другое нужно тому,
 * кто настраивает бренд, а проба к тому же стоит денег — анонимному её
 * не на кого записать (§26.4).
 */

import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { TTS_PROVIDER } from './tts-provider.token';
import { TtsProvider, VoiceOption } from './tts.types';
import { PreviewVoiceRequestDto } from './dto/preview-voice.dto';
import { PlanService } from '../plan/plan.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { PrismaService } from '../../prisma/prisma.service';

export interface VoiceCatalogueResponse {
  /** Настроен ли синтез на этом стенде — от этого зависит весь экран. */
  configured: boolean;
  voices: VoiceOption[];
  /** Почему список пуст, если он пуст. */
  error?: string;
  /**
   * Активный провайдер (§4.1 doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md) —
   * фронтенд сверяет с `BrandManifest.ttsProvider` сохранённого голоса
   * и предупреждает, если они разошлись (§4.2 того же документа).
   */
  provider: string;
}

export interface VoicePreviewResponse {
  ok: boolean;
  /** mp3 как data-URL; проигрывается сразу и нигде не оседает. */
  audio?: string;
  characters?: number;
  voiceId?: string;
  /** Сколько проб сегодня уже сделано и сколько всего можно. */
  used: number;
  limit: number;
  /** Почему не вышло: «не настроено» и «сломалось» разведены. */
  reason?: string;
  skipped?: boolean;
}

/**
 * Суточный потолок на пробы. Ограничение здесь не в деньгах, а в числе:
 * проба стоит копейки и суточный потолок расхода (§26.4) выберет очень
 * нескоро — а нажать «Прослушать» двести раз подряд можно за минуту.
 */
export const PREVIEWS_PER_DAY = 30;

@Controller('tts')
@UseGuards(TelegramIdentityGuard)
export class TtsController {
  constructor(
    @Inject(TTS_PROVIDER) private readonly tts: TtsProvider,
    private readonly plans: PlanService,
    private readonly aiUsage: AiUsageService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('voices')
  async voices(
    @Query('language') language?: string,
  ): Promise<VoiceCatalogueResponse> {
    const configured = this.tts.configured();
    if (!configured) {
      // Не ошибка и не 500: ненастроенный синтез — штатное состояние
      // стенда, и экран обязан сказать это спокойно.
      return {
        configured: false,
        voices: [],
        error: 'озвучка на этом стенде не подключена',
        provider: this.tts.providerKey,
      };
    }
    const { voices, error } = await this.tts.voices(
      language?.trim() || undefined,
    );
    return {
      configured: true,
      voices: await this.excludeClonedVoices(voices),
      error,
      provider: this.tts.providerKey,
    };
  }

  /**
   * Resemble отдаёт `/voices` НА ВЕСЬ аккаунт — а `RESEMBLE_API_KEY` один
   * на всех подписчиков (этап 73, TODO п.32). Без этого фильтра клон
   * одного пользователя со своей подписью («Голос Марии») попадал бы в
   * общий каталог всех остальных — межпользовательская утечка, а не
   * мелочь. Каталог — стоку, свои клоны видны только через `GET /voices`
   * (`UserVoicesController`, отдельный от каталога маршрут).
   */
  private async excludeClonedVoices(
    voices: VoiceOption[],
  ): Promise<VoiceOption[]> {
    const cloned = (await this.prisma.userVoice.findMany({
      where: { resembleVoiceId: { not: null } },
      select: { resembleVoiceId: true },
    })) as Array<{ resembleVoiceId: string | null }>;
    if (cloned.length === 0) return voices;
    const ids = new Set(cloned.map((c) => c.resembleVoiceId as string));
    return voices.filter((v) => !ids.has(v.voiceId));
  }

  /**
   * Проба голоса. Ответ — data-URL, а не файл в Blob: проба живёт секунды,
   * и класть её в хранилище значило бы заводить мусор, за которым потом
   * придётся ходить подметателю (§22).
   */
  @Post('preview')
  async preview(
    @Req() req: IdentifiedRequest,
    @Body() dto: PreviewVoiceRequestDto,
  ): Promise<VoicePreviewResponse> {
    const userId = req.telegramUserId;

    // Порядок важен: блокировку и бюджет проверяем ДО потолка на пробы —
    // заблокированному незачем объяснять, сколько проб у него осталось.
    await this.plans.assertCanSpendUser(userId);

    const used = await this.aiUsage.countToday(userId, 'voiceover-preview');
    if (used >= PREVIEWS_PER_DAY) {
      return {
        ok: false,
        used,
        limit: PREVIEWS_PER_DAY,
        skipped: false,
        reason: `Проб голоса на сегодня больше нет (${PREVIEWS_PER_DAY} в сутки). Голос уже выбран — послушать его целиком можно на готовом ролике.`,
      };
    }

    const outcome = await this.tts.synthesize({
      text: dto.text,
      voiceId: dto.voiceId ?? null,
      model: dto.model ?? null,
    });

    if (!outcome.ok) {
      return {
        ok: false,
        used,
        limit: PREVIEWS_PER_DAY,
        skipped: outcome.skipped,
        reason: outcome.reason,
      };
    }

    await this.aiUsage.record({
      operation: 'voiceover-preview',
      model: `${this.tts.providerKey}-tts`,
      userId,
      characters: outcome.characters,
    });

    return {
      ok: true,
      audio: `data:${outcome.mimeType};base64,${outcome.audio.toString('base64')}`,
      characters: outcome.characters,
      voiceId: outcome.voiceId,
      used: used + 1,
      limit: PREVIEWS_PER_DAY,
    };
  }
}
