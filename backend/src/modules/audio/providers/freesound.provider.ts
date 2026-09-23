/**
 * Freesound — каталог звуков и музыки, `GET /apiv2/search/text`.
 *
 * Главный источник для поздравлений: там есть CC0 (ничего не требует)
 * и CC-BY (требует упоминания автора). Некоммерческие CC-BY-NC фильтр
 * отсеет сам — разбор лицензии делает `normalizeCcLicense`.
 *
 * Полноразмерный файл у них за OAuth; без него берём превью — для
 * подложки под пятнадцатисекундный ролик его качества достаточно, а
 * ждать от пользователя заведения OAuth-приложения ради фоновой
 * музыки было бы странно.
 */

import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { loadConfiguration } from '../../../config/configuration';
import {
  AudioProvider,
  AudioRequest,
  NormalizedAudioTrack,
  normalizeCcLicense,
} from '../audio.types';

const BASE = 'https://freesound.org/apiv2';
const TIMEOUT_MS = 10_000;

interface FreesoundSound {
  id?: number;
  name?: string;
  username?: string;
  duration?: number;
  license?: string;
  tags?: string[];
  previews?: Record<string, string>;
  ac_analysis?: { ac_tempo?: number; ac_tonality?: string };
}

@Injectable()
export class FreesoundProvider implements AudioProvider {
  readonly id = 'freesound' as const;
  readonly capabilities = ['search'] as const;

  private get config() {
    return loadConfiguration().audio.freesound;
  }

  get enabled(): boolean {
    return !!this.config.token;
  }

  async search(req: AudioRequest): Promise<NormalizedAudioTrack[]> {
    const filters: string[] = [];
    if (req.durationSec) {
      filters.push(
        `duration:[${Math.max(0, req.durationSec - 20)} TO ${req.durationSec + 60}]`,
      );
    }
    if (req.bpmRange) {
      filters.push(`ac_tempo:[${req.bpmRange[0]} TO ${req.bpmRange[1]}]`);
    }
    const params = new URLSearchParams({
      query: req.query ?? req.mood?.join(' ') ?? '',
      fields: 'id,name,username,duration,previews,license,tags,ac_analysis',
      page_size: String(req.maxResults ?? 20),
      token: this.config.token,
    });
    if (filters.length) params.set('filter', filters.join(' '));

    const res = await axios.get(`${BASE}/search/text/`, {
      params,
      timeout: TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Freesound ответил ${res.status}`);
    }
    const results = (res.data as { results?: FreesoundSound[] })?.results;
    if (!Array.isArray(results)) return [];
    return results
      .map((s) => this.normalize(s, req.kind))
      .filter((t): t is NormalizedAudioTrack => t !== null);
  }

  async resolveDownloadUrl(t: NormalizedAudioTrack): Promise<string> {
    if (!this.config.oauthBearer) return t.audioUrl;
    const res = await axios.get(
      `${BASE}/sounds/${encodeURIComponent(t.providerTrackId)}/download/`,
      {
        headers: { Authorization: `Bearer ${this.config.oauthBearer}` },
        timeout: TIMEOUT_MS,
        maxRedirects: 5,
        validateStatus: () => true,
      },
    );
    // Не удалось — возвращаем превью, а не падаем: подложка хуже
    // качеством всё же лучше, чем поздравление без музыки.
    if (res.status < 200 || res.status >= 300) return t.audioUrl;
    return (res.request?.res?.responseUrl as string) || t.audioUrl;
  }

  private normalize(
    s: FreesoundSound,
    kind: AudioRequest['kind'],
  ): NormalizedAudioTrack | null {
    const id = s.id === undefined ? '' : String(s.id);
    const audioUrl =
      s.previews?.['preview-hq-mp3'] ?? s.previews?.['preview-lq-mp3'] ?? '';
    if (!id || !audioUrl) return null;
    const license = normalizeCcLicense(s.license ?? '');
    if (license.attributionRequired) {
      license.attributionText = `«${s.name ?? id}» — ${
        s.username ?? 'автор неизвестен'
      } (${license.type}), Freesound`;
    }
    return {
      provider: this.id,
      providerTrackId: id,
      kind: kind === 'music' ? 'music' : 'ambience',
      title: s.name?.trim() || id,
      artist: s.username?.trim() || undefined,
      durationSec: s.duration ?? 0,
      bpm: s.ac_analysis?.ac_tempo,
      key: s.ac_analysis?.ac_tonality,
      mood: [],
      genre: [],
      tags: s.tags ?? [],
      previewUrl: audioUrl,
      audioUrl,
      license,
    };
  }
}
