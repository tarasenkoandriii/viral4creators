'use client';

// Пилот говорящего AI-аватара (Hedra Character-3 + Resemble),
// doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md §5.3, этап 72. Admin-only, как и
// вкладка «Кроны»: признак avatarLipsync выключен на всех тарифах —
// это не пользовательская кнопка, а ручной инструмент оператора для
// нескольких тестовых роликов (см. actors.controller.ts). Персонаж
// указывается ИНДЕКСОМ в снимке манифеста бренда сессии
// (session.brandManifestSnapshot.characters), не id — тот же приём,
// что уже применён в проекте для CastReplacement.brandCharacterId
// (см. доккомментарий actors.types.ts).

import { useEffect, useRef, useState } from 'react';
import {
  generateAvatarVideo,
  getAvatarSoundCheck,
  getAvatarVideoStatus,
  runAvatarSoundCheck,
} from '../../lib/endpoints';
import type { AvatarVideo, SoundCheck } from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

// Этап 73: «звучит ли голос как живой человек» — по прямому запросу
// владельца продукта, тот же повод, что у выбора Resemble вместо
// ElevenLabs (doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md §1). У пилота
// аватара это первая проверка качества вообще — до этого этапа никакого
// аудита не было.
const SOUND_VERDICT_LABEL: Record<SoundCheck['verdict'], string> = {
  human: 'Звучит как живой человек',
  synthetic: 'Похоже на синтез (TTS)',
  ambiguous: 'Неоднозначно',
  unknown: 'Ответ Gemini не разобран',
};

const SOUND_VERDICT_SEVERITY: Record<SoundCheck['verdict'], 'ok' | 'warning' | 'critical'> = {
  human: 'ok',
  synthetic: 'warning',
  ambiguous: 'warning',
  unknown: 'warning',
};

const STATUS_LABEL: Record<AvatarVideo['status'], string> = {
  pending: 'В очереди',
  processing: 'Рендерится',
  complete: 'Готово',
  failed: 'Ошибка',
};

const STATUS_SEVERITY: Record<AvatarVideo['status'], 'ok' | 'warning' | 'critical'> = {
  complete: 'ok',
  pending: 'warning',
  processing: 'warning',
  failed: 'critical',
};

// Субтитры (этап 72а) — отдельная фаза ПОСЛЕ рендера Hedra, свой статус.
const SUBTITLE_STATUS_LABEL: Record<AvatarVideo['subtitleStatus'], string> = {
  skipped: 'выключены',
  pending: 'прожигаются…',
  done: 'вшиты',
  failed: 'не удались',
};

// Опрос статуса — тот же интервал, что у экрана прогресса обычной
// генерации во фронтенде (не даём Hedra захлебнуться частым поллингом).
const POLL_INTERVAL_MS = 4000;

export default function ActorsPage() {
  const [sessionId, setSessionId] = useState('');
  const [characterIndex, setCharacterIndex] = useState('0');
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('9:16');
  const [resolution, setResolution] = useState<'540p' | '720p' | '1080p'>('720p');
  // Явный чекбокс, выключен по умолчанию — субтитры нужны не всем
  // роликам (то же решение владельца продукта, что и у SubtitlesMode
  // брендового пайплайна).
  const [subtitles, setSubtitles] = useState(false);
  // Этап 73 (регламент товара в кадре, doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md
  // §5.2/§3.6): Hedra не умеет компоновать товар в кадр поверх портрета —
  // единственный путь остаётся регламентом, не кодом («заказывать у той
  // же модели/актёра фотосессию уже с товаром в руках»). Раз кода нет,
  // единственная проверка, которую МОЖЕТ сделать этот экран — не пустить
  // оператора дальше без явного подтверждения, что он это условие
  // проверил сам. Сбрасывается при каждой смене сессии/персонажа —
  // подтверждение относится к конкретному фото, не сохраняется впрок.
  const [productInFrameConfirmed, setProductInFrameConfirmed] = useState(false);

  const [video, setVideo] = useState<AvatarVideo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Этап 73 — звуковой чек, независимый от статуса рендера/поллинга выше.
  const [soundChecks, setSoundChecks] = useState<SoundCheck[]>([]);
  const [soundCheckRunning, setSoundCheckRunning] = useState(false);
  const [soundCheckError, setSoundCheckError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  function schedulePoll(id: string) {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(() => void poll(id), POLL_INTERVAL_MS);
  }

  async function poll(id: string) {
    try {
      const status = await getAvatarVideoStatus(id);
      setVideo(status);
      setError(null);
      if (status.status === 'pending' || status.status === 'processing') {
        schedulePoll(id);
      } else if (status.status === 'complete') {
        void loadSoundChecks(id);
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось получить статус');
    }
  }

  // Этап 73 — история звуковых чеков подгружается сама, как только ролик
  // готов; кнопка ниже запускает новую (платную) проверку по требованию.
  async function loadSoundChecks(id: string) {
    try {
      const state = await getAvatarSoundCheck(id);
      setSoundChecks(state.history);
    } catch {
      // Тихо — история необязательна для основного экрана, ошибку покажет
      // только явный клик «Проверить звук».
    }
  }

  async function runSoundCheckNow() {
    if (!sessionId.trim()) return;
    setSoundCheckRunning(true);
    setSoundCheckError(null);
    try {
      const state = await runAvatarSoundCheck(sessionId.trim());
      setSoundChecks(state.history);
    } catch (err) {
      setSoundCheckError(
        err instanceof ApiRequestError ? err.message : 'Не удалось проверить звук',
      );
    } finally {
      setSoundCheckRunning(false);
    }
  }

  async function run() {
    const idx = Number(characterIndex);
    if (!sessionId.trim() || !Number.isInteger(idx) || idx < 0) {
      setError('Укажите ID сессии и неотрицательный индекс персонажа');
      return;
    }
    if (!productInFrameConfirmed) {
      setError(
        'Подтвердите регламент товара в кадре ниже — Hedra не умеет вставлять товар сама (§5.2/§3.6 ТЗ)',
      );
      return;
    }
    setRunning(true);
    setError(null);
    setSoundChecks([]);
    setSoundCheckError(null);
    try {
      const result = await generateAvatarVideo(sessionId.trim(), {
        characterIndex: idx,
        prompt: prompt.trim() || undefined,
        aspectRatio,
        resolution,
        subtitles,
      });
      setVideo(result);
      if (result.status === 'pending' || result.status === 'processing') {
        schedulePoll(sessionId.trim());
      } else if (result.status === 'complete') {
        void loadSoundChecks(sessionId.trim());
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось запустить генерацию');
    } finally {
      setRunning(false);
    }
  }

  async function checkStatus() {
    if (!sessionId.trim()) return;
    setError(null);
    await poll(sessionId.trim());
  }

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>AI-аватар (пилот)</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Hedra Character-3 (видео) + Resemble (голос) — отдельная ветка пайплайна, не Veo (см.
        doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md). Персонаж и его фото берутся из уже сделанного снимка
        манифеста бренда этой сессии — индекс 0 обычно означает первого персонажа в списке.
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            ID сессии
            <input
              type="text"
              value={sessionId}
              onChange={(e) => {
                setSessionId(e.target.value);
                setProductInFrameConfirmed(false);
              }}
              placeholder="uuid сессии"
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            Индекс персонажа в снимке манифеста
            <input
              type="number"
              min={0}
              value={characterIndex}
              onChange={(e) => {
                setCharacterIndex(e.target.value);
                setProductInFrameConfirmed(false);
              }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            Сцена/описание для Hedra (необязательно — по умолчанию из описания персонажа)
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="например: персонаж держит товар и естественно рассказывает о нём"
            />
          </label>
          <div style={{ display: 'flex', gap: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              Формат кадра
              <select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
                <option value="9:16">9:16</option>
                <option value="16:9">16:9</option>
                <option value="1:1">1:1</option>
                <option value="4:3">4:3</option>
                <option value="3:4">3:4</option>
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              Разрешение
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value as '540p' | '720p' | '1080p')}
              >
                <option value="540p">540p</option>
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
              </select>
            </label>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={subtitles}
              onChange={(e) => setSubtitles(e.target.checked)}
            />
            Вшить субтитры (не всем роликам они нужны — второй, отдельный проход ffmpeg после
            рендера Hedra)
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              fontSize: 13,
              padding: 10,
              border: '1px solid var(--border)',
              borderRadius: 8,
            }}
          >
            <input
              type="checkbox"
              checked={productInFrameConfirmed}
              onChange={(e) => setProductInFrameConfirmed(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              <strong>Регламент товара в кадре (§5.2/§3.6 ТЗ).</strong> Hedra рендерит только то,
              что уже есть на исходном портрете — вставить товар в кадр программно она не умеет.
              Подтверждаю, что фото персонажа по указанному индексу уже показывает его с товаром в
              руках/в кадре (реальная фотосъёмка).
            </span>
          </label>

          <div style={{ display: 'flex', gap: 12 }}>
            <button
              type="button"
              disabled={running || !productInFrameConfirmed}
              onClick={() => void run()}
            >
              {running ? 'Запускается…' : 'Запустить рендер'}
            </button>
            <button type="button" onClick={() => void checkStatus()}>
              Проверить статус
            </button>
          </div>
        </div>
      </div>

      {error && (
        <p className="critical" style={{ marginBottom: 16 }}>
          {error}
        </p>
      )}

      {video && (
        <div className="card">
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 12,
              marginBottom: 8,
            }}
          >
            <div>
              <p style={{ fontWeight: 600 }}>{video.characterLabel}</p>
              <p className="muted" style={{ fontSize: 13 }}>
                {video.provider} · задача {video.providerJobId ?? '—'}
              </p>
            </div>
            <span className={`badge-status badge-status-${STATUS_SEVERITY[video.status]}`}>
              {STATUS_LABEL[video.status]}
            </span>
          </div>

          <p style={{ fontSize: 13, marginBottom: 8 }}>{video.prompt}</p>

          <p className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
            Субтитры: {SUBTITLE_STATUS_LABEL[video.subtitleStatus]}
            {video.subtitleStatus === 'failed' && video.subtitleError
              ? ` — ${video.subtitleError}`
              : ''}
          </p>

          {video.error && (
            <p className="critical" style={{ fontSize: 13, marginBottom: 8 }}>
              ⚠ {video.error.message}
            </p>
          )}

          {video.status === 'complete' && video.downloadUrl && (
            <p style={{ fontSize: 13 }}>
              <a href={video.downloadUrl} target="_blank" rel="noreferrer">
                Скачать готовый ролик
              </a>
            </p>
          )}

          {(video.status === 'pending' || video.status === 'processing') && (
            <p className="muted" style={{ fontSize: 13 }}>
              Опрашиваем статус каждые {POLL_INTERVAL_MS / 1000} с…
            </p>
          )}

          {video.status === 'complete' && video.downloadUrl && (
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  marginBottom: 8,
                }}
              >
                <p style={{ fontWeight: 600, fontSize: 14 }}>Звуковой чек</p>
                <button type="button" disabled={soundCheckRunning} onClick={() => void runSoundCheckNow()}>
                  {soundCheckRunning ? 'Слушаем…' : 'Проверить звук'}
                </button>
              </div>

              {soundCheckError && (
                <p className="critical" style={{ fontSize: 13, marginBottom: 8 }}>
                  {soundCheckError}
                </p>
              )}

              {soundChecks.length === 0 && !soundCheckRunning && !soundCheckError && (
                <p className="muted" style={{ fontSize: 13 }}>
                  Проверок ещё не было.
                </p>
              )}

              {soundChecks.map((c, i) => (
                <div key={c.checkId} style={{ marginBottom: i === 0 ? 0 : 8, opacity: i === 0 ? 1 : 0.7 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    {c.status === 'failed' ? (
                      <span className="badge-status badge-status-critical">Ошибка проверки</span>
                    ) : (
                      <span className={`badge-status badge-status-${SOUND_VERDICT_SEVERITY[c.verdict]}`}>
                        {SOUND_VERDICT_LABEL[c.verdict]}
                      </span>
                    )}
                    <span className="muted" style={{ fontSize: 12 }}>
                      {new Date(c.requestedAt).toLocaleString('ru-RU')}
                    </span>
                  </div>
                  {c.status === 'failed' ? (
                    <p className="critical" style={{ fontSize: 13 }}>
                      {c.error ?? 'Ошибка Gemini'}
                    </p>
                  ) : (
                    <>
                      {c.summary && <p style={{ fontSize: 13, marginBottom: 4 }}>{c.summary}</p>}
                      {c.notes.length > 0 && (
                        <ul style={{ fontSize: 12, paddingLeft: 18, margin: 0 }}>
                          {c.notes.map((n, ni) => (
                            <li key={ni}>{n}</li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
