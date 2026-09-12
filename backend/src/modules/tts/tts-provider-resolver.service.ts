/**
 * TtsProviderResolverService — то, что решает, какой провайдер синтеза
 * активен ПРЯМО СЕЙЧАС (было — статическая фабрика в `tts.module.ts`,
 * читавшая `process.env.TTS_PROVIDER` РОВНО ОДИН РАЗ при холодном
 * старте функции и державшая один и тот же выбор до следующего
 * передеплоя).
 *
 * Не реализует сам `TtsProvider` — намеренно: `providerKey` у
 * интерфейса объявлен обычным синхронным полем, а решить, кто активен,
 * можно только асинхронно (БД через `PlatformSettingsService`, пусть и
 * с коротким кешем). Проксирование интерфейса привело бы к тому, что
 * `providerKey` конкретного вызывающего навсегда стал бы
 * заглушкой-строкой вместо реального 'elevenlabs'/'resemble'/'veo' — а
 * ровно это значение сравнивается с `BrandManifest.ttsProvider`
 * (postprod.service.ts, «голос настроен для другого провайдера») и
 * записывается в неё же при сохранении голоса
 * (brand-manifest.service.ts, project-session.service.ts). Поэтому
 * контракт другой: вызывающий один раз получает КОНКРЕТНЫЙ экземпляр
 * (`resolve()`), а дальше работает с ним как раньше работал с
 * `this.tts` — включая синхронное чтение `.providerKey`.
 */
import { Injectable } from '@nestjs/common';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { ElevenLabsService } from './elevenlabs.service';
import { ResembleService } from './resemble.service';
import { VeoPassthroughService } from './veo-passthrough.service';
import {
  DEFAULT_VOICEOVER_PROVIDER_SETTING_KEY,
  resolveDefaultProviderKey,
  VoiceoverProviderKey,
} from './default-tts-provider';
import { TtsProvider } from './tts.types';

@Injectable()
export class TtsProviderResolverService {
  constructor(
    private readonly settings: PlatformSettingsService,
    private readonly eleven: ElevenLabsService,
    private readonly resemble: ResembleService,
    private readonly veo: VeoPassthroughService,
  ) {}

  private registry(): Record<VoiceoverProviderKey, TtsProvider> {
    return { elevenlabs: this.eleven, resemble: this.resemble, veo: this.veo };
  }

  /** Ключ, который сейчас активен — читает настройку из админки (с
   * фоллбеком на `TTS_PROVIDER`), без похода за самим провайдером. */
  async resolveKey(): Promise<VoiceoverProviderKey> {
    const stored = await this.settings.get(
      DEFAULT_VOICEOVER_PROVIDER_SETTING_KEY,
    );
    return resolveDefaultProviderKey(stored);
  }

  /** Конкретный активный провайдер — то, что раньше приходило один раз
   * через `@Inject(TTS_PROVIDER)`. Зовите один раз на входе в метод и
   * работайте с результатом, как раньше работали с `this.tts`. */
  async resolve(): Promise<TtsProvider> {
    return this.registry()[await this.resolveKey()];
  }
}
