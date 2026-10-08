/**
 * «Распознавание речи» на вкладке /settings — Gemini или Soniox для
 * всего голосового ввода продукта (диктовка описания товара, реплики
 * мастера поздравления). Решение владельца 29.09.2026. Тот же приём,
 * что у «Озвучки по умолчанию» рядом (`admin-voiceover-settings.service.ts`):
 * тонкая обёртка над `PlatformSettingsService`, логика «что активно» —
 * в чистой функции, здесь только чтение, запись и витрина с признаком
 * «настроен ли ключ на этом стенде».
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { geminiApiKey } from '../../common/gemini-client';
import { sonioxApiKey } from '../../common/soniox';
import {
  SPEECH_RECOGNITION_PROVIDER_SETTING_KEY,
  SpeechRecognitionProviderKey,
  isSpeechRecognitionProviderKey,
  resolveSpeechRecognitionProvider,
} from '../../common/speech-recognition-provider';

export interface SpeechRecognitionProviderSettingsView {
  active: SpeechRecognitionProviderKey;
  /** `admin` — выбрано здесь; `default` — не менялось, работает умолчание (Soniox). */
  source: 'admin' | 'default';
  options: Array<{ key: SpeechRecognitionProviderKey; configured: boolean }>;
}

@Injectable()
export class AdminSpeechRecognitionSettingsService {
  constructor(private readonly settings: PlatformSettingsService) {}

  async get(): Promise<SpeechRecognitionProviderSettingsView> {
    const stored = await this.settings.get(
      SPEECH_RECOGNITION_PROVIDER_SETTING_KEY,
    );
    return {
      active: resolveSpeechRecognitionProvider(stored),
      source: isSpeechRecognitionProviderKey(stored) ? 'admin' : 'default',
      options: [
        { key: 'gemini', configured: !!geminiApiKey() },
        { key: 'soniox', configured: !!sonioxApiKey() },
      ],
    };
  }

  async set(
    key: string,
    updatedBy: string,
  ): Promise<SpeechRecognitionProviderSettingsView> {
    if (!isSpeechRecognitionProviderKey(key)) {
      throw new BadRequestException(
        `Неизвестный провайдер распознавания: ${key}`,
      );
    }
    await this.settings.set(
      SPEECH_RECOGNITION_PROVIDER_SETTING_KEY,
      key,
      updatedBy,
    );
    return this.get();
  }
}
