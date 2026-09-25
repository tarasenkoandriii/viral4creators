/**
 * Ролик на других языках (этап 148, TODO §III п.12).
 *
 * Сборка — платная операция (перевод, синтез, задача ffmpeg), и сервер
 * проверяет тариф и суточный потолок сам. Здесь только вызовы.
 */

import { api } from './api';
import type { AudioTracksResult, AudioTrackView } from '../lib/audio-tracks';

export type { AudioTracksResult, AudioTrackView };

export async function getAudioTracks(
  sessionId: string
): Promise<AudioTracksResult> {
  const res = await api.get<AudioTracksResult>(
    `/sessions/${encodeURIComponent(sessionId)}/audio-tracks`
  );
  if (!res.data) throw new Error('Пустой ответ: дорожки');
  return res.data;
}

export async function buildAudioTrack(
  sessionId: string,
  locale: string
): Promise<AudioTrackView> {
  const res = await api.post<AudioTrackView>(
    `/sessions/${encodeURIComponent(sessionId)}/audio-tracks/${encodeURIComponent(locale)}`
  );
  if (!res.data) throw new Error('Пустой ответ: сборка дорожки');
  return res.data;
}
