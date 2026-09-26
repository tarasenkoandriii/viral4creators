/**
 * Выключатель разделения дорожки — третий уровень отката §9 ТЗ
 * `docs-tz/TZ-Voice-Replace-Keep-Background.md`.
 *
 * Первые два уровня (нет ключа Replicate; сбой прогона) срабатывают
 * сами. Третий — на случай, который автоматика распознать не может:
 * разделение прошло успешно, счёт выставлен, а звучит плохо. Такое
 * решение принимает ухо человека, и принять его он должен **без
 * деплоя** — тем же приёмом, каким уже переключается провайдер
 * озвучки (`default-tts-provider.ts`).
 *
 * ## Почему умолчание — ВЫКЛЮЧЕНО
 *
 * Казалось бы, наличие ключа и есть согласие. Но схему входа модели
 * проверить из среды разработки не удалось (см. шапку
 * `replicate-separation.service.ts`), и если имена полей окажутся
 * другими, первый же деплой начнёт платить по 2,6 цента за каждый
 * дубляж всех пользователей, получая отказ и молча откатываясь.
 * Поэтому включение — осознанное действие после первого удачного
 * прогона, а не побочный эффект появления ключа в окружении.
 */
import { Injectable } from '@nestjs/common';
import { PlatformSettingsService } from '../../common/platform-settings.service';

export const AUDIO_SEPARATION_SETTING_KEY = 'postprod.keepBackground';

export type AudioSeparationState = 'on' | 'off';

/**
 * Чистая функция разбора — ровно как `resolveDefaultProviderKey`:
 * логика «что считается включённым» не должна жить внутри сервиса,
 * который ходит в базу, иначе её не проверить без базы.
 */
export function resolveSeparationState(
  stored: string | null | undefined,
): AudioSeparationState {
  return stored === 'on' ? 'on' : 'off';
}

@Injectable()
export class AudioSeparationSettingsService {
  constructor(private readonly settings: PlatformSettingsService) {}

  async state(): Promise<AudioSeparationState> {
    return resolveSeparationState(
      await this.settings.get(AUDIO_SEPARATION_SETTING_KEY),
    );
  }

  async enabled(): Promise<boolean> {
    return (await this.state()) === 'on';
  }

  async set(state: AudioSeparationState, updatedBy?: string): Promise<void> {
    await this.settings.set(AUDIO_SEPARATION_SETTING_KEY, state, updatedBy);
  }
}
