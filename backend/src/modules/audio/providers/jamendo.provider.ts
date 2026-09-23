/**
 * Jamendo — каталог музыки, `GET /v3.0/tracks`.
 *
 * Важное про лицензию, из-за чего этот провайдер может не дать ни
 * одного результата и это будет ПРАВИЛЬНО: бесплатный тариф Jamendo
 * покрывает только некоммерческое использование. Поздравление в платном
 * продукте — использование коммерческое, значит без купленной
 * лицензии треки отсюда фильтр отсеет (`requiresPaidLicense`). Как
 * только лицензия есть — `JAMENDO_HAS_COMMERCIAL=true`, и они
 * появляются в выдаче.
 */

import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { loadConfiguration } from '../../../config/configuration';
import {
  AudioProvider,
  AudioRequest,
  NormalizedAudioTrack,
} from '../audio.types';

const BASE = 'https://api.jamendo.com/v3.0';
const TIMEOUT_MS = 10_000;

interface JamendoTrack {
  id?: number | string;
  name?: string;
  artist_name?: string;
  duration?: number | string;
  audio?: string;
  audiodownload?: string;
  license_ccurl?: string;
  musicinfo?: {
    tags?: { genres?: string[]; instruments?: string[]; vartags?: string[] };
  };
}

@Injectable()
export class JamendoProvider implements AudioProvider {
  readonly id = 'jamendo' as const;
  readonly capabilities = ['search'] as const;

  private get config() {
    // Читается на каждом вызове, а не в конструкторе: на Vercel
    // экземпляры живут разное время, и правка переменной иначе
    // вступала бы в силу для разных запросов в разное время.
    return loadConfiguration().audio.jamendo;
  }

  get enabled(): boolean {
    return !!this.config.clientId;
  }

  async search(req: AudioRequest): Promise<NormalizedAudioTrack[]> {
    const { clientId } = this.config;
    const params = new URLSearchParams({
      client_id: clientId,
      format: 'json',
      audioformat: 'mp32',
      include: 'musicinfo licenses',
      limit: String(req.maxResults ?? 20),
    });
    if (req.query) params.set('search', req.query);
    if (req.genre?.length) params.set('tags', req.genre.join('+'));
    if (req.durationSec) {
      // Окно, а не точная длина: трек ровно в пятнадцать секунд —
      // редкость, а подрезать длинный мы умеем сами (`atrim` в
      // постобработке).
      const pad = 60;
      params.set(
        'durationbetween',
        `${Math.max(0, req.durationSec - pad)}_${req.durationSec + pad}`,
      );
    }

    const res = await axios.get(`${BASE}/tracks/`, {
      params,
      timeout: TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Jamendo ответил ${res.status}`);
    }
    const results = (res.data as { results?: JamendoTrack[] })?.results;
    if (!Array.isArray(results)) return [];
    return results
      .map((r) => this.normalize(r))
      .filter((t): t is NormalizedAudioTrack => t !== null);
  }

  private normalize(r: JamendoTrack): NormalizedAudioTrack | null {
    const id = r.id === undefined ? '' : String(r.id);
    const audioUrl = r.audiodownload || r.audio || '';
    if (!id || !audioUrl) return null;
    const commercial = this.config.hasCommercialLicense;
    return {
      provider: this.id,
      providerTrackId: id,
      kind: 'music',
      title: r.name?.trim() || id,
      artist: r.artist_name?.trim() || undefined,
      durationSec: Number(r.duration) || 0,
      // BPM Jamendo через публичный API надёжно не отдаёт.
      bpm: undefined,
      mood: [],
      genre: r.musicinfo?.tags?.genres ?? [],
      tags: [
        ...(r.musicinfo?.tags?.vartags ?? []),
        ...(r.musicinfo?.tags?.instruments ?? []),
      ],
      previewUrl: r.audio,
      audioUrl,
      license: {
        type: commercial ? 'jamendo-commercial' : 'jamendo-noncommercial',
        commercialUse: commercial,
        attributionRequired: false,
        requiresPaidLicense: !commercial,
        licenseUrl: r.license_ccurl,
      },
    };
  }
}
