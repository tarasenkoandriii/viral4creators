/**
 * AdminVideoProviderSettingsService — «Провайдер видео-генерации по
 * умолчанию» на вкладке /settings (§11.1 ТЗ
 * VEO-MODEL-VERSION-CHOICE-SPEC.md — закрывает недостающую
 * админскую половину решения, найденную при аудите).
 *
 * Тонкая обёртка над `PlatformSettingsService`, тот же паттерн, что
 * `AdminAnalysisSettingsService`/`AdminVoiceoverSettingsService`.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import {
  VideoProviderKey,
  DEFAULT_VIDEO_PROVIDER_SETTING_KEY,
  isVideoProviderKey,
  resolveDefaultVideoProvider,
} from '../generation/default-video-provider';

export interface VideoProviderOptionView {
  key: VideoProviderKey;
}

export interface VideoProviderSettingsView {
  active: VideoProviderKey;
  /** `admin` — задано явно из этого экрана; `env-default` — стенд ни
   * разу не трогал селектор, используется `grok` по умолчанию. */
  source: 'admin' | 'env-default';
  options: VideoProviderOptionView[];
}

@Injectable()
export class AdminVideoProviderSettingsService {
  constructor(private readonly settings: PlatformSettingsService) {}

  private options(): VideoProviderOptionView[] {
    // Оба провайдера уже полностью реализованы и доступны для выбора
    // на конкретной генерации (§11.1 ТЗ) — в отличие от разбора видео
    // (§17), здесь нет пункта «показан, но недоступен».
    return [{ key: 'grok' }, { key: 'veo' }];
  }

  async get(): Promise<VideoProviderSettingsView> {
    const stored = await this.settings.get(DEFAULT_VIDEO_PROVIDER_SETTING_KEY);
    return {
      active: resolveDefaultVideoProvider(stored),
      source: isVideoProviderKey(stored) ? 'admin' : 'env-default',
      options: this.options(),
    };
  }

  async setDefault(
    key: string,
    updatedBy: string,
  ): Promise<VideoProviderSettingsView> {
    if (!isVideoProviderKey(key)) {
      throw new BadRequestException(`Неизвестный провайдер видео: ${key}`);
    }
    await this.settings.set(DEFAULT_VIDEO_PROVIDER_SETTING_KEY, key, updatedBy);
    return this.get();
  }
}
