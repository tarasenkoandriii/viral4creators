/**
 * usePostprodVideo — состояние ОДНОГО выбранного ролика для вкладки
 * «Постпрод» (этап 88: «добавить вкладку постпрод... весь комплект
 * постпродакшена перенести туда»). Намеренно НЕ `useWorkflow`: тот
 * тянет весь конечный автомат мастера (upload → ... → complete) и
 * жёстко завязан на единственный `localStorage['sessionId']` — у него
 * нет способа открыть ЧУЖОЙ (в смысле «не текущий активный») sessionId,
 * не сломав резюме активной сессии мастера при следующей перезагрузке
 * (см. доккомментарий у его init-эффекта). Здесь нужно ровно то, что
 * ждут перенесённые панели: сама сессия (video/voiceoverScript/
 * snapshot/productInformation) и два колбэка (`reVoice`, `setSnapshot`).
 *
 * Опрос статуса — сокращённая версия `useWorkflow.startVideoPolling`
 * (тот же интервал 4с и та же пауза на свёрнутой вкладке, М-7.3), без
 * batch-специфичного троттлинга xAI и без разбора ошибок на «ролик уже
 * есть vs ещё нет» — здесь ролик уже гарантированно есть (иначе панелей
 * бы не было), поэтому сетевая икота просто тихо гасит опрос, ничего не
 * затирая на экране.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSession, getVideoStatus } from '../services/api';
import type { GeneratedVideo } from '../services/api';
import { reVoiceVideo } from '../services/postprod-api';
import { shouldKeepPolling } from '../lib/video-polling';
import type { BrandManifestSnapshot, Session } from '../types';

const POLL_INTERVAL_MS = 4000;

/**
 * `Session['generatedVideo']` (types/index.ts) и `GeneratedVideo` из
 * services/api.ts — два независимых, чуть разошедшихся зеркала одного и
 * того же бэкендового типа (см. доккомментарий у services/api.ts) —
 * useWorkflow.ts обходит это тем, что вообще не типизирует своё
 * состояние через `Session`, а держит `generatedVideo` отдельным полем
 * типа services/api.ts. Тот же приём здесь: локальный тип сессии с
 * ОДНИМ переопределённым полем — `getSession()` даёт более строгий
 * (enum) тип, `getVideoStatus()`/`reVoiceVideo()` — более широкий
 * (строковый union); RevoicePanel/ExportPanel ждут именно второй.
 */
type PostprodSession = Omit<Session, 'generatedVideo'> & {
  generatedVideo?: GeneratedVideo;
};

export function usePostprodVideo(sessionId: string) {
  const [session, setSession] = useState<PostprodSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlight = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    inFlight.current = false;
    pollRef.current = setInterval(async () => {
      if (inFlight.current) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      inFlight.current = true;
      try {
        const status = await getVideoStatus(sessionId);
        setSession((prev) =>
          prev ? { ...prev, generatedVideo: status } : prev
        );
        if (!shouldKeepPolling(status)) stopPolling();
      } catch {
        // Необязательное фоновое обновление — сетевая икота тихо гасит
        // опрос, а не подменяет уже показанный ролик ошибкой.
        stopPolling();
      } finally {
        inFlight.current = false;
      }
    }, POLL_INTERVAL_MS);
  }, [sessionId, stopPolling]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    getSession(sessionId)
      .then((s) => {
        if (!alive) return;
        setSession(s);
        if (s?.generatedVideo && shouldKeepPolling(s.generatedVideo)) {
          startPolling();
        }
      })
      .catch((e) => {
        if (alive) setError(e);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- перезапуск только по смене sessionId
  }, [sessionId]);

  const reVoice = useCallback(
    async (voiceoverScript?: string) => {
      const video = await reVoiceVideo(sessionId, voiceoverScript);
      setSession((prev) => (prev ? { ...prev, generatedVideo: video } : prev));
      startPolling();
      return video;
    },
    [sessionId, startPolling]
  );

  const setSnapshot = useCallback((snapshot: BrandManifestSnapshot) => {
    setSession((prev) =>
      prev ? { ...prev, brandManifestSnapshot: snapshot } : prev
    );
  }, []);

  const video: GeneratedVideo | null = session?.generatedVideo ?? null;

  return {
    session,
    video,
    voiceoverScript:
      session?.generationPrompt?.finalVoiceoverScript ??
      session?.generationPrompt?.voiceoverScript ??
      '',
    snapshot: session?.brandManifestSnapshot ?? null,
    productName: session?.productInformation?.productName ?? null,
    productDescription: session?.productInformation?.productDescription ?? null,
    productCategory: session?.productInformation?.category ?? null,
    loading,
    error,
    reVoice,
    setSnapshot,
  };
}
