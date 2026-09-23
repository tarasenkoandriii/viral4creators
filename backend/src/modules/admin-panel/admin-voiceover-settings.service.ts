/**
 * AdminVoiceoverSettingsService — «Озвучка по умолчанию» на вкладке
 * /settings (доп. запрос владельца продукта: ручной селектор
 * elevenlabs/resemble/veo, чтобы можно было быстро откатиться на
 * бесплатный голос Veo, когда на балансе ElevenLabs/Resemble нет
 * денег — не дожидаясь передеплоя с новым `TTS_PROVIDER`).
 *
 * Тонкая обёртка над `PlatformSettingsService`: вся логика «что
 * считается активным, если ничего не задано» уже в чистой функции
 * `resolveDefaultProviderKey` (`default-tts-provider.ts`) — этот сервис
 * её не дублирует, только читает/пишет саму настройку и собирает
 * витрину (плюс `configured()` каждого провайдера — оператору нужно
 * видеть не только «что выбрано», но и «а оно вообще может сработать»).
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { ElevenLabsService } from '../tts/elevenlabs.service';
import { ResembleService } from '../tts/resemble.service';
import {
  DEFAULT_VOICEOVER_PROVIDER_SETTING_KEY,
  isVoiceoverProviderKey,
  resolveDefaultProviderKey,
  VoiceoverProviderKey,
} from '../tts/default-tts-provider';

export interface VoiceoverProviderOptionView {
  key: VoiceoverProviderKey;
  /** Настроен ли ключ/аккаунт на этом стенде — `veo` всегда `true`:
   * ему нечего настраивать, он никогда не «не готов». */
  configured: boolean;
}

export interface VoiceoverProviderSettingsView {
  active: VoiceoverProviderKey;
  /** `admin` — задано явно из этого экрана; `env-default` — стенд ни
   * разу не трогал селектор, используется старый `TTS_PROVIDER`/
   * дефолт (см. resolveDefaultProviderKey). Отличать важно: пустая
   * табличная запись — не то же самое, что оператор осознанно выбрал
   * ElevenLabs. */
  source: 'admin' | 'env-default';
  options: VoiceoverProviderOptionView[];
}

@Injectable()
export class AdminVoiceoverSettingsService {
  constructor(
    private readonly settings: PlatformSettingsService,
    private readonly eleven: ElevenLabsService,
    private readonly resemble: ResembleService,
  ) {}

  private options(): VoiceoverProviderOptionView[] {
    return [
      { key: 'elevenlabs', configured: this.eleven.configured() },
      { key: 'resemble', configured: this.resemble.configured() },
      // Ничего не настраивается — это и есть смысл пункта.
      { key: 'veo', configured: true },
    ];
  }

  async get(): Promise<VoiceoverProviderSettingsView> {
    const stored = await this.settings.get(
      DEFAULT_VOICEOVER_PROVIDER_SETTING_KEY,
    );
    return {
      active: resolveDefaultProviderKey(stored),
      source: isVoiceoverProviderKey(stored) ? 'admin' : 'env-default',
      options: this.options(),
    };
  }

  async setDefault(
    key: string,
    updatedBy: string,
  ): Promise<VoiceoverProviderSettingsView> {
    if (!isVoiceoverProviderKey(key)) {
      throw new BadRequestException(`Неизвестный провайдер озвучки: ${key}`);
    }
    await this.settings.set(
      DEFAULT_VOICEOVER_PROVIDER_SETTING_KEY,
      key,
      updatedBy,
    );
    return this.get();
  }
}
