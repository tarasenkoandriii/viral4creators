/**
 * AudioService — поиск музыки, не зависящий от того, у кого именно мы
 * её ищем.
 *
 * Все адаптеры приходят через мульти-токен `AUDIO_PROVIDERS`. Провайдер
 * без ключей в выдаче не участвует, упавший провайдер не роняет
 * остальных: у каждого своя попытка, и сбой одного — это просто
 * отсутствие его результатов.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { AUDIO_PROVIDERS } from './audio.constants';
import {
  AudioProvider,
  AudioProviderId,
  AudioRequest,
  NormalizedAudioTrack,
  scoreTrack,
  trackPassesFilter,
} from './audio.types';

@Injectable()
export class AudioService {
  private readonly logger = new Logger(AudioService.name);

  constructor(
    @Inject(AUDIO_PROVIDERS) private readonly providers: AudioProvider[],
  ) {}

  /** Провайдеры, у которых реально есть ключи. */
  get available(): AudioProvider[] {
    return this.providers.filter((p) => p.enabled);
  }

  get enabled(): boolean {
    return this.available.length > 0;
  }

  /**
   * Кандидаты для экрана выбора: отфильтрованные по лицензии и
   * отранжированные.
   *
   * Каталоги отдают свои находки, генератор — один синтезированный
   * трек. Порядок провайдеров задаёт `prefer`; без него — порядок
   * регистрации.
   */
  async candidates(
    req: AudioRequest,
    prefer?: AudioProviderId[],
    limit = 12,
  ): Promise<NormalizedAudioTrack[]> {
    const provs = this.available;
    const order = prefer ?? provs.map((p) => p.id);
    const out: NormalizedAudioTrack[] = [];
    for (const id of order) {
      const p = provs.find((x) => x.id === id);
      if (!p) continue;
      try {
        if (p.capabilities.includes('search') && p.search) {
          const r = await p.search(req);
          out.push(...r.filter((t) => trackPassesFilter(t, req)));
        } else if (p.capabilities.includes('generate') && p.generate) {
          const t = await p.generate(req);
          if (trackPassesFilter(t, req)) out.push(t);
        }
      } catch (e) {
        // Сбой провайдера — это отсутствие его результатов, а не
        // ошибка экрана: остальные уже что-то нашли или найдут.
        this.logger.warn(
          `источник ${id} не ответил: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      if (out.length >= limit * 2) break;
    }
    return out
      .sort((a, b) => scoreTrack(b, req) - scoreTrack(a, req))
      .slice(0, limit);
  }

  /** Полноразмерная ссылка, если провайдер умеет её доставать. */
  async downloadUrl(track: NormalizedAudioTrack): Promise<string> {
    const provider = this.available.find((p) => p.id === track.provider);
    if (!provider?.resolveDownloadUrl) return track.audioUrl;
    try {
      return await provider.resolveDownloadUrl(track);
    } catch {
      return track.audioUrl;
    }
  }
}
