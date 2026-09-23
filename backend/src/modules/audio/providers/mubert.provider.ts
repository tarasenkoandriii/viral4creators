/**
 * Mubert — ГЕНЕРАТОР, а не каталог: вместо поиска шлём настроение,
 * длительность и темп и получаем сгенерированный трек. Лицензия
 * royalty-free и покрывает коммерческое использование, то есть для
 * поздравлений это идеальный источник — если он настроен.
 *
 * ОДНАКО. Этот адаптер перенесён из `atm-travel` как есть, и там он
 * помечен автором как скелет: имена полей нужно сверить с актуальным
 * B2B-контрактом, а настоящий API асинхронный — готовую ссылку,
 * возможно, придётся опрашивать, а не получать первым же ответом.
 * Боевого вызова за ним пока не стояло.
 *
 * Что это значит на практике: без `MUBERT_API_KEY` провайдер молча не
 * участвует, а с ключом первый же вызов либо сработает, либо честно
 * провалится — и резолвер перейдёт к следующему провайдеру
 * (`resolveAudio` ловит исключение каждого по отдельности). Сломать
 * выдачу он не может; отдать неверный трек — тоже. Поэтому он здесь, а
 * не выброшен: когда контракт сверят, править придётся один файл.
 */

import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { loadConfiguration } from '../../../config/configuration';
import {
  AudioProvider,
  AudioRequest,
  NormalizedAudioTrack,
  bpmCenter,
} from '../audio.types';

const TIMEOUT_MS = 30_000;

interface MubertResponse {
  data?: { id?: string; download_link?: string };
}

@Injectable()
export class MubertProvider implements AudioProvider {
  readonly id = 'mubert' as const;
  readonly capabilities = ['generate'] as const;

  private get config() {
    return loadConfiguration().audio.mubert;
  }

  get enabled(): boolean {
    return !!this.config.apiKey;
  }

  async generate(req: AudioRequest): Promise<NormalizedAudioTrack> {
    const duration = req.durationSec ?? 30;
    const bpm = bpmCenter(req.bpmRange);
    const promptTags = [...(req.mood ?? []), ...(req.genre ?? []), req.query]
      .filter(Boolean)
      .join(', ');

    const res = await axios.post(
      `${this.config.baseUrl}/RecordTrackTTM`,
      {
        method: 'RecordTrackTTM',
        params: {
          pat: this.config.apiKey,
          duration,
          bitrate: 320,
          intensity: 'medium',
          text: promptTags || 'warm, celebration',
          ...(bpm ? { bpm } : {}),
        },
      },
      { timeout: TIMEOUT_MS, validateStatus: () => true },
    );
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Mubert ответил ${res.status}`);
    }
    const url = (res.data as MubertResponse)?.data?.download_link;
    if (!url) {
      // Скорее всего трек ещё рендерится — см. доккомментарий класса.
      throw new Error('Mubert: ссылки на файл нет (трек ещё готовится?)');
    }

    return {
      provider: this.id,
      providerTrackId:
        (res.data as MubertResponse)?.data?.id ?? `mubert-${Date.now()}`,
      kind: 'generative',
      title: promptTags || 'Сгенерированный трек',
      durationSec: duration,
      bpm,
      mood: req.mood ?? [],
      genre: req.genre ?? [],
      tags: [],
      audioUrl: url,
      license: {
        type: 'mubert-royalty-free',
        commercialUse: true,
        attributionRequired: false,
        // Покрыто тарифом Mubert, отдельной покупки не требует.
        requiresPaidLicense: false,
      },
    };
  }
}
