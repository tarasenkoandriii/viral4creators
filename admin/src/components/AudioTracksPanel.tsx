'use client';

// Передача звуковых дорожек оператору (этап 139 ТЗ
// TZ-Multilingual-YouTube.md).
//
// Экран живёт в админке, потому что мультиязычным делается НАШ канал:
// в Studio заходит наш же оператор. Задача экрана ровно одна — провести
// человека по пути «скачал файлы → залил в Studio → отметил» без чтения
// ТЗ, поэтому инструкция стоит прямо здесь, а не в отдельной справке.
//
// Два предупреждения на экране не декоративные. Advanced features —
// условие Google: без них раздела Languages в Studio не будет вовсе, и
// человек решит, что сломан продукт. Автодубляж — ловушка: если YouTube
// уже озвучил ролик сам, свою дорожку на тот же язык он не примет, пока
// автодубляж не удалён.
//
// Отметка называется отметкой, а не проверкой: API звуковых дорожек у
// YouTube нет — убедиться машиной, что файл на месте, нельзя ничем.
//
// Субтитры дорожки (этап 141) отдаются тем же заходом и тем же путём —
// файлом в руки. Загрузить их можно и через API (`captions.insert`), но
// вызов стоит 400 единиц квоты из 10 000 в сутки на ВЕСЬ проект, и
// толку от перевода субтитра без переведённой дорожки немного: обе
// половины одного языка, а вторая всё равно идёт руками.

import { useCallback, useEffect, useState } from 'react';
import {
  buildAudioTrack,
  getAudioTracks,
  setAudioTrackUploaded,
} from '../lib/endpoints';
import type { AudioTracksResult, AudioTrackView } from '../lib/types';
import { ApiRequestError } from '../lib/admin-api';

const LOCALE_LABEL: Record<string, string> = {
  ru: 'Русский',
  uk: 'Українська',
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
};

function localeLabel(locale: string): string {
  return LOCALE_LABEL[locale] ?? locale;
}

/** Секунды с одним знаком: «6.2 с». Пусто — длительность не измерена. */
function seconds(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)} с`;
}

/**
 * Скачать субтитры строкой, а не ссылкой: `.srt` лежит в самой строке
 * дорожки (он считается из сценария и перевода, отдельного файла в
 * хранилище у него нет).
 */
function downloadSrt(track: AudioTrackView, sessionId: string): void {
  if (!track.subtitlesSrt) return;
  const blob = new Blob([track.subtitlesSrt], {
    type: 'text/plain;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // Имя с роликом, а не просто «de.srt»: оператор, открывший два
  // ролика подряд, получил бы «de.srt» и «de (1).srt» — и залил бы в
  // Studio субтитры от чужого ролика. Ровно та ошибка, от которой
  // экран и бережёт (аудит этапа 139 про дорожку от прежней версии).
  a.download = `${sessionId}-${track.locale}.srt`;
  // Ссылка добавляется в документ, а адрес освобождается СЛЕДУЮЩЕЙ
  // задачей: Firefox не кликает по узлу вне документа, а Safari
  // отменяет скачивание, если адрес отозвать в том же такте
  // (находка аудита этапа 141 — кнопка могла молча ничего не делать).
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}

function statusLabel(track: AudioTrackView): string {
  // Устаревшая — раньше всего остального: «залито» и «готово» у дорожки
  // от прежней версии ролика вводят в заблуждение сильнее, чем молчание.
  if (track.stale) return 'от прежней версии ролика';
  if (track.uploadedAt) return 'залито';
  if (track.mixing) return 'собирается';
  if (track.status === 'HANDOVER') return 'нужна правка';
  if (track.status === 'FAILED') return 'не собралась';
  if (track.trackUrl) return 'готово к заливке';
  return 'есть голос, нет сборки';
}

export function AudioTracksPanel({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<AudioTracksResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Какую локаль собираем прямо сейчас — прогресс виден человеку. */
  const [building, setBuilding] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getAudioTracks(sessionId));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : String(e));
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Пока хоть одна дорожка собирается, экран переспрашивает сам: задача
  // ffmpeg асинхронная, а список на бэкенде дозабирает готовое. Без
  // этого «собирается» висело бы до перезагрузки страницы.
  const mixing = (data?.tracks ?? []).some((t) => t.mixing);
  useEffect(() => {
    if (!mixing || building) return;
    const timer = setTimeout(() => void load(), 10_000);
    return () => clearTimeout(timer);
  }, [mixing, building, load, data]);

  /**
   * Сборка идёт ПО ОДНОЙ дорожке: на сервере один запрос — одна локаль
   * (перевод, синтез и задача ffmpeg не укладываются в таймаут функции
   * вчетвером). Здесь тот же список проходится последовательно, и
   * человек видит, на какой локали мы сейчас.
   */
  const buildAll = async (locales: string[]) => {
    setError(null);
    for (const locale of locales) {
      setBuilding(locale);
      try {
        await buildAudioTrack(sessionId, locale);
      } catch (e) {
        setError(e instanceof ApiRequestError ? e.message : String(e));
        break;
      }
    }
    setBuilding(null);
    await load();
  };

  const mark = async (track: AudioTrackView, uploaded: boolean) => {
    setBusy(track.id);
    try {
      await setAudioTrackUploaded(track.id, uploaded);
      await load();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const ready = (data?.tracks ?? []).filter(
    (t) => t.trackUrl && !t.uploadedAt && !t.stale,
  );

  return (
    <section style={{ marginTop: 24 }}>
      <h2>Звуковые дорожки на других языках</h2>
      <p style={{ color: '#666', fontSize: 13 }}>
        Дорожки заливаются в YouTube Studio руками: API для них у площадки
        нет вовсе. Продукт готовит файлы и помнит, что уже залито.
      </p>

      <ol style={{ color: '#444', fontSize: 13, lineHeight: 1.6 }}>
        <li>Открыть ролик в YouTube Studio → «Языки» (Languages).</li>
        <li>«Добавить язык» → выбрать язык дорожки.</li>
        <li>В строке языка загрузить скачанный здесь файл как звуковую дорожку.</li>
        <li>
          Там же, в строке языка, загрузить скачанный здесь <code>.srt</code>{' '}
          как субтитры этого языка.
        </li>
        <li>Вернуться сюда и отметить дорожку залитой.</li>
      </ol>

      <p style={{ fontSize: 13, color: '#8a5b00' }}>
        Раздел «Языки» появляется только у каналов с расширенными функциями
        (Advanced features). Если его нет — дело не в файлах, а в доступе
        канала.
      </p>
      <p style={{ fontSize: 13, color: '#8a5b00' }}>
        Если YouTube уже озвучил ролик сам (автодубляж), свою дорожку на тот
        же язык он не примет: сначала удалите автодубляж этого языка.
      </p>

      {error && <p style={{ color: '#b00' }}>{error}</p>}

      <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        <button
          onClick={() => void buildAll(data?.toBuild ?? [])}
          disabled={!!building || (data?.toBuild.length ?? 0) === 0}
        >
          {building
            ? `Собираем ${localeLabel(building)}…`
            : `Собрать недостающие (${data?.toBuild.length ?? 0})`}
        </button>
        <button
          onClick={() =>
            ready.forEach((t) => window.open(t.trackUrl as string, '_blank'))
          }
          disabled={ready.length === 0}
        >
          Открыть все готовые ({ready.length})
        </button>
        {/* Сборка асинхронная: без этой кнопки «собирается» висело бы до
            перезагрузки страницы. Автообновление ниже снимает её сам,
            но человеку нужна и явная возможность. */}
        <button onClick={() => void load()} disabled={!!building}>
          Обновить
        </button>
      </div>

      {data && data.tracks.length === 0 && (
        <p style={{ color: '#666', fontSize: 13 }}>
          Дорожек пока нет. Язык оригинала — {localeLabel(data.sourceLocale)}:
          на него дорожка не нужна.
        </p>
      )}

      {data && data.tracks.length > 0 && (
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
              <th>Язык</th>
              <th>Состояние</th>
              <th>Реплика</th>
              <th>Длина</th>
              <th>Файлы</th>
              <th>Залито</th>
            </tr>
          </thead>
          <tbody>
            {data.tracks.map((track) => (
              <tr key={track.id} style={{ borderBottom: '1px solid #eee' }}>
                <td>{localeLabel(track.locale)}</td>
                <td>
                  {statusLabel(track)}
                  {/* Причина всегда рядом с состоянием: «нужна правка» без
                      объяснения — это тупик для оператора. */}
                  {track.note && (
                    <div style={{ color: '#666' }}>{track.note}</div>
                  )}
                  {track.mixError && (
                    <div style={{ color: '#b00' }}>{track.mixError}</div>
                  )}
                </td>
                {/* Реплика из нескольких битов так и показывается —
                    строками: оператор сверяет их с субтитром. */}
                <td style={{ maxWidth: 280, whiteSpace: 'pre-line' }}>
                  {track.speech ?? '—'}
                </td>
                <td>
                  {seconds(track.voiceSeconds)}
                  {track.tempoRate && (
                    <div style={{ color: '#666' }}>
                      ускорена ×{track.tempoRate}
                    </div>
                  )}
                </td>
                <td>
                  {track.trackUrl ? (
                    <a href={track.trackUrl} target="_blank" rel="noreferrer">
                      дорожка
                    </a>
                  ) : (
                    <span style={{ color: '#666' }}>—</span>
                  )}
                  {track.voiceUrl && (
                    <>
                      {' · '}
                      <a href={track.voiceUrl} target="_blank" rel="noreferrer">
                        голос
                      </a>
                    </>
                  )}
                  {track.subtitlesSrt && (
                    <>
                      {' · '}
                      <button
                        type="button"
                        onClick={() => downloadSrt(track, sessionId)}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          color: '#06c',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          font: 'inherit',
                        }}
                      >
                        .srt
                      </button>
                    </>
                  )}
                </td>
                <td>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!track.uploadedAt}
                      // Отметить «залито» то, чего не скачивал, можно
                      // только по ошибке; устаревшую — тем более.
                      disabled={
                        busy === track.id ||
                        (!track.uploadedAt && (!track.trackUrl || track.stale))
                      }
                      onChange={(e) => void mark(track, e.target.checked)}
                    />{' '}
                    {track.uploadedAt
                      ? new Date(track.uploadedAt).toLocaleString('ru-RU')
                      : 'нет'}
                  </label>
                  {/* Отданное человеку скопом не пересобирается: там
                      нужно его решение. Кнопка в строке — и есть это
                      решение. */}
                  {!track.uploadedAt && (
                    <div>
                      <button
                        type="button"
                        onClick={() => void buildAll([track.locale])}
                        disabled={!!building}
                      >
                        собрать заново
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
