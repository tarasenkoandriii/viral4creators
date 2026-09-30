/**
 * ProviderUsageService — какими провайдерами из «Балансов» продукт
 * пользуется СЕЙЧАС.
 *
 * Запрос владельца 30.09.2026: «ElevenLabs пока не то качество».
 * Провайдер отложен, ключ от него остался, и сторож остатков каждый
 * день писал в канал ошибок «остаток не читается (400)» — про
 * провайдера, кончившийся баланс которого ничего не останавливает.
 * Канал, который кричит про неважное, перестают читать вместе с
 * важным, поэтому сторож должен знать, кто сейчас в деле.
 *
 * ## Кого это касается
 *
 * Только голосовых провайдеров, которых можно ВЫБРАТЬ и ОТЛОЖИТЬ:
 * ElevenLabs и Resemble. У остальных провайдеров «Балансов» признака
 * «отложен» в продукте нет — они либо обязательны (xAI, SerpApi), либо
 * остатка не отдают вовсе, и для них всё как раньше. Soniox сюда не
 * входит намеренно: тем же ключом идёт распознавание речи, и то, что
 * его не выбрали для озвучки, не значит, что им не пользуются.
 *
 * ## Что значит «используется»
 *
 * Выбран «Озвучкой по умолчанию» — ИЛИ выбран голосом помощника
 * (`voice_assistant_voice`) — ИЛИ по нему есть фактический расход
 * (`AiUsage`) за последние `VOICE_USAGE_WINDOW_DAYS` дней — ИЛИ на него
 * явно ссылается хоть один брендбук либо снимок бренда в сессии,
 * тронутые за то же окно.
 *
 * Расход — главный признак (аудит 30.09.2026): у синтеза есть пути,
 * не видные ни по одной настройке, — прослушивание и список голосов с
 * явным провайдером, виртуальная студия, клон отправителя поздравления
 * (всегда Resemble). Все они пишут строку расхода, и она ловит их разом,
 * без перечня, который устареет на следующей фиче. Голос помощника
 * проверяется отдельно: он выбран, но пока мастер молчит, расхода по
 * нему нет, а кончившийся баланс заглушит его на первой же подсказке.
 *
 * Ссылка из брендбука обязательна по той же причине:
 * брендбук с голосом ElevenLabs синтезирует через ElevenLabs, что бы
 * ни стояло в селекторе (`postprod.service.ts`, `resolveByKey`), и
 * молчание сторожа про такого провайдера — ровно тот вставший продукт,
 * ради которого сторож заведён. Окно по времени — потому что старые
 * брендбуки хранят тег провайдера, бывшего активным при сохранении
 * голоса, и без окна отложенный провайдер «использовался» бы вечно.
 *
 * ## Почему при сбое — «используется»
 *
 * Не смогли спросить базу — считаем, что используются все. Лишний крик
 * в канал раз в сутки дешевле, чем тихо не заметить кончившийся
 * баланс у провайдера, на котором стоит продукт.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import {
  parseAssistantVoice,
  VOICE_ASSISTANT_VOICE_KEY,
} from '../wizard-guide/hint-audio';
import {
  DEFAULT_VOICEOVER_PROVIDER_SETTING_KEY,
  resolveDefaultProviderKey,
  VoiceoverProviderKey,
} from '../tts/default-tts-provider';

/** Имя строки в «Балансах» → ключ провайдера синтеза. */
export const VOICE_BALANCE_PROVIDERS: Readonly<
  Record<string, VoiceoverProviderKey>
> = {
  ELEVENLABS: 'elevenlabs',
  RESEMBLE: 'resemble',
};

/**
 * Окно «недавнего» использования. Две недели — дольше самого длинного
 * перерыва между сериями роликов у живого бренда, и короче, чем держится
 * решение «провайдер отложен».
 */
export const VOICE_USAGE_WINDOW_DAYS = 14;

export interface ProviderUsage {
  /** Строки «Балансов», которыми продукт сейчас НЕ пользуется, → почему. */
  unused: Map<string, string>;
}

@Injectable()
export class ProviderUsageService {
  private readonly logger = new Logger(ProviderUsageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
  ) {}

  async usage(now: Date = new Date()): Promise<ProviderUsage> {
    const unused = new Map<string, string>();
    try {
      const active = resolveDefaultProviderKey(
        await this.settings.get(DEFAULT_VOICEOVER_PROVIDER_SETTING_KEY),
      );
      const assistant = parseAssistantVoice(
        await this.settings.get(VOICE_ASSISTANT_VOICE_KEY),
      ).provider;
      const since = new Date(
        now.getTime() - VOICE_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );
      for (const [provider, key] of Object.entries(VOICE_BALANCE_PROVIDERS)) {
        if (key === active || key === assistant) continue;
        if (await this.spent(provider, since)) continue;
        if (await this.referenced(key, since)) continue;
        // Причина перечисляет ВСЁ проверенное: по ней на экране видно,
        // что именно поменять, чтобы провайдер снова сторожился.
        unused.set(
          provider,
          `не используется: не выбран «Озвучкой по умолчанию» (сейчас: ${active}) ` +
            `и голосом помощника (сейчас: ${assistant}), расхода по нему за ` +
            `${VOICE_USAGE_WINDOW_DAYS} дней нет, в свежих брендбуках и сессиях ` +
            'не встречается — сторож остатков о нём не пишет',
        );
      }
    } catch (e) {
      this.logger.warn(
        `не удалось выяснить, какие провайдеры озвучки используются, — сторожим всех: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return { unused: new Map() };
    }
    return { unused };
  }

  /**
   * Был ли расход за окно. `provider` в `AiUsage` — те же имена, что у
   * строк «Балансов» (`AI_PROVIDERS`). Индекс по `createdAt` отсекает
   * старое, а `findFirst` останавливается на первой же строке.
   */
  private async spent(provider: string, since: Date): Promise<boolean> {
    const row = await this.prisma.aiUsage.findFirst({
      where: { provider, createdAt: { gte: since } },
      select: { id: true },
    });
    return Boolean(row);
  }

  /**
   * Есть ли свежая явная ссылка. `findFirst` с одним `id`, а не
   * `count`: ответ нужен «да/нет», и считать все совпадения незачем.
   * Сессии отсекаются по `lastActivityAt` (индекс есть) ДО разбора
   * JSON, так что путь в `data` проверяется лишь на свежих строках.
   */
  private async referenced(
    key: VoiceoverProviderKey,
    since: Date,
  ): Promise<boolean> {
    const brand = await this.prisma.brandManifest.findFirst({
      where: { ttsProvider: key, updatedAt: { gte: since } },
      select: { id: true },
    });
    if (brand) return true;
    const session = await this.prisma.session.findFirst({
      where: {
        deletedAt: null,
        lastActivityAt: { gte: since },
        data: { path: ['brandManifestSnapshot', 'ttsProvider'], equals: key },
      },
      select: { id: true },
    });
    return Boolean(session);
  }
}
