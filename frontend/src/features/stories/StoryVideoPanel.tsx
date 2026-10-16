import { exclusiveStoryPlayback } from './story-media-playback';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui';
import { api } from '../../services/api';
type Render = {
  id: string;
  status: string;
  preambleText: string;
  preambleDuration: number | null;
  durationSeconds: number | null;
  baseHash: string;
  mainAudioHash: string;
  videoHash: string | null;
  reservedMicroUsd: number;
  approvedAt: string | null;
  qaStatus: string;
  qa: { wer: number } | null;
  error: string | null;
};
type View = {
  supported: boolean;
  baseUrl: string;
  coverUrl: string;
  base: { baseSha256: string; durationSeconds: number; revision: string };
  budgetUsd: number;
  reservedUsd: number;
  renders: Render[];
};
const errorText = (e: unknown) =>
  (e as { response?: { data?: { message?: string } } }).response?.data
    ?.message || 'Действие не подтверждено. Обновите статус перед повтором.';
function media(base64: string, mime: string) {
  return URL.createObjectURL(
    new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], {
      type: mime,
    })
  );
}
export function StoryVideoPanel({ giftId }: { giftId: string }) {
  const [view, setView] = useState<View | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [intro, setIntro] = useState(
      'Сегодня я расскажу тебе сказку «Репка». Давай послушаем её вместе.'
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [video, setVideo] = useState<string | null>(null),
    [introAudio, setIntroAudio] = useState<string | null>(null),
    [reviewed, setReviewed] = useState(false);
  const lock = useRef(false);
  const render =
    view?.renders.find((r) => r.id === selected) || view?.renders[0];
  const refresh = useCallback(async () => {
    const res = await api.get<View>(`/story-gifts/${giftId}/video`);
    if (res.data) setView(res.data);
  }, [giftId]);
  const renderId = render?.id;
  const renderStatus = render?.status;
  useEffect(() => {
    void refresh().catch((e) => setError(errorText(e)));
  }, [refresh]);
  useEffect(() => {
    if (!renderId || !['PREPARING', 'PENDING'].includes(renderStatus!)) return;
    let alive = true;
    const timer = setInterval(() => {
      void api
        .get<Render>(`/story-gifts/${giftId}/video/${renderId}`)
        .then(() => {
          if (alive) void refresh().catch(() => {});
        })
        .catch(() => {});
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [giftId, renderId, renderStatus, refresh]);
  useEffect(() => {
    setVideo(null);
    setIntroAudio(null);
    setReviewed(false);
    if (!renderId || renderStatus! !== 'READY') return;
    let active = true;
    const urls: string[] = [];
    void Promise.all([
      api.get<{ base64: string; mime: string }>(
        `/story-gifts/${giftId}/video/${renderId}/file`
      ),
      api.get<{ base64: string; mime: string }>(
        `/story-gifts/${giftId}/video/${renderId}/intro`
      ),
    ])
      .then(([v, a]) => {
        if (!active || !v.data || !a.data) return;
        const u = media(v.data.base64, v.data.mime),
          i = media(a.data.base64, a.data.mime);
        urls.push(u, i);
        setVideo(u);
        setIntroAudio(i);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
      urls.forEach(URL.revokeObjectURL);
    };
  }, [giftId, renderId, renderStatus]);
  async function action(fn: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (!view?.supported) return null;
  return (
    <section
      className="space-y-4 rounded-xl border border-silver-500/30 p-4"
      aria-label="Базовое видео и сменная преамбула"
    >
      <h3 className="text-xl font-semibold">
        Видео «Репки» · сменная преамбула
      </h3>
      <p>
        Один базовый видеоряд без речи. Основная Nova уже записана и
        переиспользуется; сейчас оплачиваются только новая преамбула и сборка.
        Для родительского голоса позже заменяется отдельная дорожка, не сцены.
      </p>
      <p className="text-sm">
        Бюджет выпуска: ${view.budgetUsd.toFixed(2)} · общий расчётный резерв: $
        {view.reservedUsd.toFixed(2)}. Новая сборка резервирует не меньше $0.52
        плюс запас на преамбулу. Это оценка, не счёт провайдера; при нехватке
        лимита запуск блокируется.
      </p>
      <label className="block">
        Сменная преамбула
        <textarea
          className="mt-1 w-full rounded-lg border border-silver-500/30 bg-transparent p-2"
          maxLength={180}
          value={intro}
          onChange={(e) => setIntro(e.target.value)}
        />
      </label>
      <Button
        disabled={busy || !intro.trim()}
        onClick={() =>
          void action(async () => {
            const r = await api.post<Render>(
              `/story-gifts/${giftId}/video`,
              { preambleText: intro },
              { timeout: 150000 }
            );
            if (r.data) setSelected(r.data.id);
          })
        }
      >
        Собрать видео с Nova
      </Button>
      <div className="flex flex-wrap gap-3 text-sm">
        <a
          className="underline"
          href={view.baseUrl}
          download="repka-base-silent.mp4"
          target="_blank"
          rel="noopener noreferrer"
        >
          Базовый MP4 без звука
        </a>
        <a
          className="underline"
          href="/story-assets/turnip-v1/manifest.json"
          target="_blank"
          rel="noopener noreferrer"
        >
          Манифест сцен
        </a>
      </div>
      <details>
        <summary>Неизменная версия базового видео</summary>
        <p className="break-all text-xs">
          {view.base.revision} · SHA-256 {view.base.baseSha256}
        </p>
      </details>
      {error && <p role="alert">{error}</p>}
      {view.renders.map((r) => (
        <Button
          key={r.id}
          variant="ghost"
          disabled={busy}
          onClick={() => setSelected(r.id)}
        >
          {r.preambleText} · {r.status}
        </Button>
      ))}
      {render && (
        <div className="space-y-3">
          <p>
            Сборка:{' '}
            {(
              {
                PREPARING: 'Подготовка преамбулы',
                PENDING: 'Собирается',
                READY: 'Готово',
                UNKNOWN: 'Требует проверки',
                FAILED: 'Ошибка',
              } as Record<string, string>
            )[render.status] || render.status}
            {render.durationSeconds
              ? ` · ${render.durationSeconds.toFixed(2)} с`
              : ''}
          </p>
          {render.error && <p role="alert">{render.error}</p>}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void action(() =>
                api.get(`/story-gifts/${giftId}/video/${render.id}`)
              )
            }
          >
            Обновить сборку видео
          </Button>
          {video && (
            <>
              <video
                onPlay={exclusiveStoryPlayback}
                className="w-full rounded-lg"
                controls
                playsInline
                src={video}
                poster={view.coverUrl}
              />
              <div className="flex flex-wrap gap-3">
                <a href={video} download="repka-nova.mp4" className="underline">
                  Скачать готовый MP4
                </a>
                {introAudio && (
                  <a
                    href={introAudio}
                    download="repka-preamble-nova.mp3"
                    className="underline"
                  >
                    Преамбула отдельно (MP3)
                  </a>
                )}
              </div>
              <p className="text-sm">
                Основная озвучка отдельно — кнопка «Скачать MP3» выше. Музыка не
                добавлялась и не смешана с голосом.
              </p>
            </>
          )}
          <p>
            Сверка полного видео с текстом:{' '}
            {
              (
                {
                  PENDING: 'не запускалась',
                  RUNNING: 'проверяется',
                  PASS: 'пройдена',
                  WARN: 'нужен просмотр',
                  UNKNOWN: 'не подтверждена',
                } as Record<string, string>
              )[render.qaStatus]
            }
            {render.qa
              ? ` · расхождение слов ${(render.qa.wer * 100).toFixed(1)}%`
              : ''}
          </p>
          <Button
            disabled={
              busy || render.status !== 'READY' || render.qaStatus !== 'PENDING'
            }
            onClick={() =>
              void action(() =>
                api.post(
                  `/story-gifts/${giftId}/video/${render.id}/quality`,
                  {},
                  { timeout: 150000 }
                )
              )
            }
          >
            Проверить речь готового видео
          </Button>
          {render.approvedAt ? (
            <p>Видео одобрено для ссылки на подарок.</p>
          ) : (
            <>
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                Видео просмотрено, преамбула и основная речь проверены
              </label>
              <Button
                disabled={
                  busy ||
                  !reviewed ||
                  render.qaStatus !== 'PASS' ||
                  !render.videoHash
                }
                onClick={() =>
                  void action(() =>
                    api.post(
                      `/story-gifts/${giftId}/video/${render.id}/approve`,
                      { videoHash: render.videoHash, reviewed: true }
                    )
                  )
                }
              >
                Одобрить видео для подарка
              </Button>
            </>
          )}
          <details>
            <summary>Независимые активы этого выпуска</summary>
            <p className="break-all text-xs">
              Базовый видеоряд: {render.baseHash}
            </p>
            <p className="break-all text-xs">
              Основная аудиодорожка: {render.mainAudioHash}
            </p>
            <p>Преамбула: {render.preambleText}</p>
          </details>
        </div>
      )}
    </section>
  );
}
