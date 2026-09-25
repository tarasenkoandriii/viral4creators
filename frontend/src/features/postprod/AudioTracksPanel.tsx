/**
 * AudioTracksPanel — «ролик на других языках» для ВЛАДЕЛЬЦА ролика
 * (этап 148, TODO §III п.12). Экранная половина того же, что у
 * оператора делает admin-панель (этапы 138–141).
 *
 * ## Почему панель, а не шаг мастера
 *
 * Дорожки заказывают ПОСЛЕ готового ролика и не обязательно в тот же
 * день: человек снял, выложил, через неделю решил выйти на немецкий
 * рынок. Поэтому это самостоятельная панель на экране готового ролика,
 * рядом с экспортом, а не ещё один шаг в мастере генерации.
 *
 * ## Список читается без Premium, собирается — с ним
 *
 * Тариф закрывает СБОРКУ, а не просмотр (аудит этапа 148, А-1). Сервер
 * специально отдаёт список без проверки права — «платного в нём ничего
 * нет, и собранные дорожки не должны пропадать при смене режима», —
 * и первая версия экрана эту гарантию отменяла: без Premium он
 * показывал замок вместо уже собранных дорожек, то есть человек,
 * понизивший режим, терял доступ к тому, за что уже заплатил. Теперь
 * без Premium панель показывает дорожки и даёт их скачать, а замок
 * стоит на месте кнопок сборки.
 *
 * Того же происхождения и второй замок, который пришлось снять
 * (А-6): `useFeature(...).loading` — это `state === null`, а состояние
 * остаётся `null` и когда матрица режимов НЕ ЗАГРУЗИЛАСЬ (этап 119,
 * В-5.6: отличить одно от другого по одному полю нельзя, ради этого в
 * контексте и появился `error`). Панель, спрятанная «пока грузится»,
 * из-за одного упавшего `GET /me/plan` исчезала бы вместе с уже
 * собранными дорожками. Поэтому упавшая матрица — не «ещё грузится»:
 * список показываем, кнопки сборки прячем, замок с подписью тарифа не
 * рисуем вовсе (подпись была бы выдумкой: режим нам неизвестен).
 *
 * ## Один опрос на оба пути, и реже, чем у экспорта
 *
 * Сборка звука — задача чужого ffmpeg-сервиса, и `GET .../audio-tracks`
 * на сервере не просто читает базу: он дозабирает готовые сборки,
 * дёргая этот сервис по каждой незавершённой дорожке (`pollMix`).
 * Пятисекундный тик `ExportPanel` здесь означал бы до четырёх чужих
 * запросов каждые пять секунд на каждое открытое окно — поэтому тик
 * реже. Приём тот же: самопланирующийся `setTimeout`, а не
 * `setInterval` (ответ не должен наложиться на следующий тик).
 *
 * Реализация опроса ОДНА на оба пути — и экранный тик, и дозапрос
 * сразу после сборки (аудит этапа 148, А-2). Их было две, и они
 * разошлись в самом важном месте: экранная при сетевой осечке
 * переставляла таймер, а та, что после сборки, — останавливалась
 * насовсем и показывала ошибку. То есть одна икота сети после УДАЧНОЙ
 * платной сборки оставляла человека с вечным «собирается» и с красным
 * сообщением о неудаче там, где деньги были потрачены не зря.
 *
 * Отсюда же правило: ошибку опроса человеку не показываем — она не про
 * его действие. Видимой ошибка бывает только у первой загрузки (там
 * «не смогли показать» — это и есть весь ответ) и у самой сборки.
 *
 * В отличие от `ExportPanel` у опроса есть флаг остановки: без него
 * таймер, поставленный из уже улетевшего запроса, переживал бы
 * размонтирование — и панель, которую человек закрыл, продолжала бы
 * дёргать ffmpeg до перезагрузки страницы.
 *
 * ## Почему «собрать все» просит подтверждения
 *
 * Сервер собирает по одной дорожке за запрос (у serverless нет фона —
 * находка аудита этапа 139), так что «собрать недостающие» — это N
 * запросов подряд, то есть N списаний с одного касания. Подтверждение
 * называет языки поимённо: одно касание на четыре платные операции без
 * предупреждения — это счёт, которого человек не заказывал.
 *
 * Начатую очередь уход с экрана не отменяет: заказ уже подтверждён и
 * оплачивается по факту работы, а брошенная на середине сборка — это
 * списания без результата. Диалог так и говорит.
 *
 * ## Почему заливает человек
 *
 * API звуковых дорожек у YouTube нет вовсе (этап 139): ни загрузить, ни
 * проверить. Поэтому панель заканчивается инструкцией для Studio, а не
 * кнопкой «опубликовать», — и это честнее, чем обещать чужую
 * автоматику.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  Download,
  Languages,
  Loader2,
  Mic,
  Subtitles,
} from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  LockedNote,
  Spinner,
} from '../../components/ui';
import { useFeature, usePlanContext } from '../../lib/plan-context';
import { useI18n } from '../../lib/i18n-context';
import { errorMessage } from '../../services/projects-api';
import {
  buildAudioTrack,
  getAudioTracks,
} from '../../services/audio-tracks-api';
import {
  buildable,
  isDownloadable,
  needsPolling,
  offersVoice,
  panelAccess,
  subtitlesFileName,
  subtitlesHref,
  trackState,
  type AudioTracksResult,
  type AudioTrackView,
  type TrackState,
} from '../../lib/audio-tracks';
import { LOCALE_LABELS, isLocale } from '../../lib/i18n';
import type { GeneratedVideo } from '../../services/api';

/** Реже, чем у экспорта: каждый тик — опрос чужого ffmpeg. См. шапку. */
const POLL_MS = 10000;

function localeLabel(code: string): string {
  return isLocale(code) ? LOCALE_LABELS[code] : code.toUpperCase();
}

export function AudioTracksPanel({
  sessionId,
  video,
}: {
  sessionId: string;
  video: GeneratedVideo;
}) {
  const { dict } = useI18n();
  const t = dict.audioTracksPanel;
  const feature = useFeature('multilingualTracks');
  // `feature.loading` не отличает «ещё грузится» от «не загрузилось» —
  // см. шапку, А-6. Отличает только это поле.
  const { error: planError } = usePlanContext();
  const planFailed = feature.loading && Boolean(planError);
  const [result, setResult] = useState<AudioTracksResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const stopped = useRef(false);
  /** Та же самая функция опроса для кода вне эффекта — см. шапку, А-2. */
  const poll = useRef<() => Promise<void>>(async () => {});

  // Постобработка ещё идёт — собирать нечего и рано: дорожку считают
  // от ТЕКУЩЕЙ версии ролика, а она сейчас меняется, и собранная
  // сейчас стала бы устаревшей к моменту готовности.
  const ready = video.postStatus !== 'pending';

  useEffect(() => {
    stopped.current = false;

    const schedule = () => {
      if (stopped.current) return;
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void tick(), POLL_MS);
    };

    const tick = async () => {
      if (stopped.current) return;
      try {
        const fresh = await getAudioTracks(sessionId);
        if (stopped.current) return;
        setResult(fresh);
        if (needsPolling(fresh)) schedule();
      } catch {
        // Сетевая осечка опрос не останавливает: следующий тик всё
        // равно планируем — как только сеть отойдёт, он восстановится
        // сам. И не показываем её: это не про действие человека.
        schedule();
      }
    };
    poll.current = tick;

    const first = async () => {
      // Список читается и без Premium — см. шапку. Единственное, что
      // откладывает первый запрос, — незавершённая постобработка.
      if (!ready) {
        setLoading(false);
        return;
      }
      try {
        const fresh = await getAudioTracks(sessionId);
        if (stopped.current) return;
        setResult(fresh);
        if (needsPolling(fresh)) schedule();
      } catch (e) {
        // У ПЕРВОЙ загрузки ошибка видима: «не смогли показать» — это и
        // есть весь ответ, показывать вместо него «дорожек нет» значило
        // бы соврать (аудит этапа 148, А-3).
        if (!stopped.current) setError(errorMessage(e));
      } finally {
        if (!stopped.current) setLoading(false);
      }
    };

    void first();
    return () => {
      stopped.current = true;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [sessionId, ready]);

  const runBuild = async (locales: string[]) => {
    setError(null);
    for (const locale of locales) {
      setBusy(locale);
      try {
        // По одной за запрос: у serverless нет фона, и четыре подряд не
        // укладываются в таймаут функции (аудит этапа 139).
        await buildAudioTrack(sessionId, locale);
      } catch (e) {
        // Останавливаемся на первой же неудаче. Чаще всего это выбранный
        // суточный потолок — и продолжать очередь значит гарантированно
        // получить ту же ошибку ещё трижды.
        setError(errorMessage(e));
        break;
      }
    }
    setBusy(null);
    // Тем же опросом, что крутит экран: он и обновит список сразу, и
    // сам продолжит, пока идёт сборка.
    await poll.current();
  };

  const tracks = result?.tracks ?? [];
  // Правило целиком — в `lib/audio-tracks.ts`, под тестом: аудит этапа
  // 148 нашёл здесь две ошибки подряд, пока оно жило в разметке.
  const access = panelAccess({
    videoReady: ready,
    planLoading: feature.loading,
    planFailed,
    allowed: feature.allowed,
    hasTracks: tracks.length > 0,
  });

  if (access === 'hidden') return null;
  if (access === 'locked') {
    return (
      <LockedNote title={t.lockedTitle} lock={feature.lock}>
        {t.lockedBody}
      </LockedNote>
    );
  }

  const toBuild = access === 'full' ? buildable(result) : [];

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<Languages size={18} className="text-accent" />}
        title={t.title}
        hint={t.hint}
      />

      {error && (
        <Alert tone="error" className="mb-3" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {result && (
        <p className="mb-3 text-xs text-silver-400">
          {t.sourceLocale}: {localeLabel(result.sourceLocale)}
        </p>
      )}

      {loading ? (
        <Spinner size={20} />
      ) : (
        <>
          {tracks.length > 0 && (
            <div className="mb-4 space-y-2">
              {tracks.map((track) => (
                <TrackRow key={track.id} track={track} />
              ))}
            </div>
          )}

          {access === 'locked-list' && (
            <LockedNote
              title={t.lockedWithTracks}
              lock={feature.lock}
              compact
            />
          )}

          {toBuild.length > 0 && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {toBuild.map((locale) => (
                  <Button
                    key={locale}
                    variant="outline"
                    size="sm"
                    loading={busy === locale}
                    disabled={busy !== null}
                    onClick={() => void runBuild([locale])}
                  >
                    {busy === locale
                      ? t.building.replace('{{locale}}', localeLabel(locale))
                      : `${t.build} ${localeLabel(locale)}`}
                  </Button>
                ))}
              </div>
              {toBuild.length > 1 && (
                <Button
                  block
                  variant="solid"
                  // Очередь идёт минутами: без этого кнопка выглядела бы
                  // мёртвой, а не занятой (аудит этапа 148, А-5).
                  loading={busy !== null}
                  onClick={() => setConfirmAll(true)}
                >
                  {busy !== null
                    ? t.building.replace('{{locale}}', localeLabel(busy))
                    : t.buildAll.replace('{{n}}', String(toBuild.length))}
                </Button>
              )}
              <p className="text-xs text-silver-400">{t.paidNote}</p>
            </div>
          )}

          {/* «Дорожек нет» — только когда список ДОШЁЛ и он пуст. Пока
              он не дошёл, об этом говорит алерт выше (А-3). */}
          {result && tracks.length === 0 && toBuild.length === 0 && (
            <p className="text-sm text-silver-400">{t.empty}</p>
          )}

          {tracks.some(isDownloadable) && <StudioSteps />}
        </>
      )}

      <ConfirmDialog
        open={confirmAll}
        danger={false}
        title={t.buildAllTitle}
        confirmLabel={t.buildAllConfirm}
        onCancel={() => setConfirmAll(false)}
        onConfirm={() => {
          setConfirmAll(false);
          void runBuild(toBuild);
        }}
      >
        {t.buildAllBody.replace(
          '{{list}}',
          toBuild.map(localeLabel).join(', ')
        )}
      </ConfirmDialog>
    </Card>
  );
}

const TONES: Record<TrackState, 'success' | 'warning' | 'danger'> = {
  ready: 'success',
  stale: 'warning',
  mixing: 'warning',
  handover: 'warning',
  voiceOnly: 'warning',
  failed: 'danger',
};

/** Одна дорожка: состояние, что она произносит, и что можно скачать. */
function TrackRow({ track }: { track: AudioTrackView }) {
  const { dict } = useI18n();
  const t = dict.audioTracksPanel;
  const state = trackState(track);
  const labels: Record<TrackState, string> = {
    stale: t.stateStale,
    mixing: t.stateMixing,
    handover: t.stateHandover,
    failed: t.stateFailed,
    ready: t.stateReady,
    voiceOnly: t.stateVoiceOnly,
  };
  const full = isDownloadable(track);
  const srt = subtitlesHref(track);

  return (
    <div className="rounded-xl border border-silver-300 px-3 py-2 dark:border-silver-700">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">
          {localeLabel(track.locale)}
        </span>
        <Badge tone={TONES[state]}>
          {state === 'mixing' && <Loader2 size={11} className="animate-spin" />}
          {labels[state]}
        </Badge>
      </div>

      {track.speech && (
        <p className="mt-1 line-clamp-2 text-xs text-silver-400">
          {track.speech}
        </p>
      )}

      {/* `tempoRate` не null только когда речь и правда ускоряли
          (`action: 'retempo'`, всегда больше единицы). */}
      {track.tempoRate !== null && (
        <p className="mt-1 text-xs text-silver-400">
          {t.speed.replace('{{rate}}', track.tempoRate.toFixed(2))}
        </p>
      )}

      {/* Причину неудачи показываем: без неё «не собралась» — это
          тупик, из которого человек не знает, что делать дальше. */}
      {state === 'failed' && track.mixError && (
        <p className="mt-1 text-xs text-danger">{track.mixError}</p>
      )}
      {track.note && (
        <p className="mt-1 text-xs text-silver-400">{track.note}</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-3">
        {/* Полная дорожка — только когда её и правда можно заливать:
            у устаревшей файл на месте, но он от прежнего ролика. */}
        {full && track.trackUrl && (
          <DownloadLink href={track.trackUrl} icon={<Download size={12} />}>
            {t.download}
          </DownloadLink>
        )}
        {/* Голос — запасной выход; условие и почему — `offersVoice`. */}
        {offersVoice(track) && track.voiceUrl && (
          <DownloadLink href={track.voiceUrl} icon={<Mic size={12} />}>
            {t.voice}
          </DownloadLink>
        )}
        {srt && (
          <DownloadLink
            href={srt}
            download={subtitlesFileName(track)}
            icon={<Subtitles size={12} />}
          >
            {t.subtitles}
          </DownloadLink>
        )}
      </div>
    </div>
  );
}

function DownloadLink({
  href,
  download,
  icon,
  children,
}: {
  href: string;
  download?: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      download={download}
      // У `data:`-ссылки субтитров своя вкладка не нужна — её открывает
      // атрибут `download`; у файлов хранилища нужна.
      target={download ? undefined : '_blank'}
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
    >
      {icon}
      {children}
    </a>
  );
}

/** Инструкция для Studio: заливать дорожки человек будет руками. */
function StudioSteps() {
  const { dict } = useI18n();
  const t = dict.audioTracksPanel;
  return (
    <div className="mt-4 rounded-xl bg-silver-100 p-3 dark:bg-silver-800">
      <p className="text-xs font-semibold">{t.studioTitle}</p>
      <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs text-silver-400">
        <li>{t.studioStep1}</li>
        <li>{t.studioStep2}</li>
        <li>{t.studioStep3}</li>
      </ol>
      <p className="mt-2 flex items-start gap-1.5 text-xs text-silver-400">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
        {t.studioWarning}
      </p>
    </div>
  );
}
