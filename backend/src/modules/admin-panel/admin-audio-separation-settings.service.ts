/**
 * AdminAudioSeparationSettingsService — карточка «Фон при дубляже» на
 * вкладке /settings (ТЗ `docs-tz/TZ-Voice-Replace-Keep-Background.md`,
 * этап E).
 *
 * Тонкая обёртка, ровно как `AdminVoiceoverSettingsService`: сама
 * настройка живёт в `AudioSeparationSettingsService`, здесь только
 * витрина для оператора. Витрине нужно показать не только «включено ли
 * это», но и «а сработает ли вообще» — выключатель при ненастроенном
 * Replicate выглядел бы работающим и не делал бы ничего.
 */
import { Injectable } from '@nestjs/common';
import {
  AudioSeparationSettingsService,
  AudioSeparationState,
} from '../audio-separation/audio-separation-settings';
import { ReplicateSeparationService } from '../audio-separation/replicate-separation.service';

export interface AudioSeparationSettingsView {
  state: AudioSeparationState;
  /** Настроен ли провайдер: без ключа выключатель бессмыслен. */
  providerConfigured: boolean;
  /**
   * Что произойдёт при следующем дубляже — одной фразой, чтобы
   * оператору не приходилось складывать два флага в голове.
   */
  effect: string;
}

@Injectable()
export class AdminAudioSeparationSettingsService {
  constructor(
    private readonly settings: AudioSeparationSettingsService,
    private readonly provider: ReplicateSeparationService,
  ) {}

  async view(): Promise<AudioSeparationSettingsView> {
    const state = await this.settings.state();
    const providerConfigured = this.provider.configured();
    return {
      state,
      providerConfigured,
      effect: !providerConfigured
        ? 'Replicate не настроен: дубляж выбрасывает звук ролика целиком, как и раньше.'
        : state === 'on'
          ? 'Дубляж заменяет голос модели, сохраняя фон ролика. Каждый такой ролик добавляет один платный прогон разделения.'
          : 'Разделение выключено: дубляж выбрасывает звук ролика целиком. Ключ есть — можно включить в любой момент.',
    };
  }

  async set(state: AudioSeparationState, updatedBy?: string): Promise<void> {
    await this.settings.set(state, updatedBy);
  }
}
