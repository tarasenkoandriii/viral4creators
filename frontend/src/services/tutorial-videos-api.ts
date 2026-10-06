/**
 * Обучалки в «Постпроде» (темп и покадровая озвучка, 06.10.2026) —
 * `GET/POST /postprod/tutorials/…`, за той же личностью, что список
 * роликов. Обучалка — не сессия генерации: свой маршрут и свой id
 * (`assetId`), владение проверяет сервер через черновик проекта; чужой
 * ролик отвечает 404.
 *
 * Расчёт темпа (`getTutorialTempo`) бесплатный — его можно звать на
 * каждое движение ползунка; платный только `requestTutorialVersion`.
 */

import { api } from './api';
import { unwrapApiData } from '../lib/unwrap-api-data';
import type {
  TempoPreview,
  TempoUnavailableReason,
  TempoWarning,
} from '../lib/tutorial-tempo';

const unwrap = unwrapApiData;

export interface UserTutorialItem {
  assetId: string;
  draftId: string;
  title: string;
  url: string;
  durationMs: number | null;
  createdAt: string;
  editable: boolean;
  reason: TempoUnavailableReason | null;
  activeFactor: number;
  voiced: boolean;
  inFlight: boolean;
}

export interface TutorialVersionView {
  id: string;
  kind: 'source' | 'tempo';
  factor: number;
  preset: 'calm' | 'normal' | 'fast' | null;
  status: 'preparing' | 'pending' | 'complete' | 'failed';
  durationMs: number | null;
  url: string | null;
  active: boolean;
  requiresApproval: boolean;
  approved: boolean;
  createdAt: string;
}

export interface TutorialTempoEstimate {
  assetId: string;
  title: string;
  url: string | null;
  currentDurationMs: number | null;
  editable: boolean;
  reason: TempoUnavailableReason | null;
  factor: number;
  preset: 'calm' | 'normal' | 'fast' | null;
  durationMs: number | null;
  sourceDurationMs: number | null;
  minimumDurationMs: number | null;
  warnings: TempoWarning[];
  preview: TempoPreview | null;
  voiced: boolean;
  activeFactor: number;
  inFlight: TutorialVersionView | null;
}

export async function listTutorials(): Promise<UserTutorialItem[]> {
  const res = unwrap<{ items: UserTutorialItem[] }>(
    await api.get<{ items: UserTutorialItem[] }>('/postprod/tutorials'),
    'список обучалок'
  );
  return res.items;
}

export async function getTutorialTempo(
  assetId: string,
  factor: number
): Promise<TutorialTempoEstimate> {
  return unwrap<TutorialTempoEstimate>(
    await api.get<TutorialTempoEstimate>(
      `/postprod/tutorials/${encodeURIComponent(assetId)}/tempo?factor=${factor}`
    ),
    'расчёт темпа'
  );
}

export async function requestTutorialVersion(
  assetId: string,
  factor: number
): Promise<{ version: TutorialVersionView; reused: boolean }> {
  return unwrap<{ version: TutorialVersionView; reused: boolean }>(
    await api.post<{ version: TutorialVersionView; reused: boolean }>(
      `/postprod/tutorials/${encodeURIComponent(assetId)}/versions`,
      { factor }
    ),
    'сборка версии'
  );
}

export async function listTutorialVersions(
  assetId: string
): Promise<TutorialVersionView[]> {
  return unwrap<TutorialVersionView[]>(
    await api.get<TutorialVersionView[]>(
      `/postprod/tutorials/${encodeURIComponent(assetId)}/versions`
    ),
    'версии обучалки'
  );
}

export async function activateTutorialVersion(
  assetId: string,
  versionId: string
): Promise<TutorialVersionView> {
  return unwrap<TutorialVersionView>(
    await api.post<TutorialVersionView>(
      `/postprod/tutorials/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(versionId)}/activate`
    ),
    'активация версии'
  );
}

export async function revertTutorialTempo(
  assetId: string
): Promise<TutorialVersionView> {
  return unwrap<TutorialVersionView>(
    await api.post<TutorialVersionView>(
      `/postprod/tutorials/${encodeURIComponent(assetId)}/revert`
    ),
    'возврат к обычному темпу'
  );
}
