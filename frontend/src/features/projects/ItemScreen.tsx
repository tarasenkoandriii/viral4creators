/**
 * Item wizard — Экраны 2–5 of doc/PRODUCT-PROJECT-SPEC.md §4 for one
 * ProductItem: photo (camera/gallery → analog search + category) →
 * analogs (sort by relevance/price) → voice description (MediaRecorder →
 * Gemini) → price (pick an analog's or type your own).
 *
 * Step is part of the URL (#/projects/:id/items/:itemId/<step>) so the
 * Telegram BackButton / browser back moves one step, and any step can be
 * revisited. Nothing is a gate (spec §7.4): photo and analogs can be
 * skipped; only price + description make the item "complete".
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Camera,
  Check,
  ExternalLink,
  History,
  Images,
  Mic,
  RefreshCw,
  Square,
  Tag,
} from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  FeaturePanel,
  Field,
  Input,
  Spinner,
  Stepper,
  Textarea,
} from '../../components/ui';
import {
  errorMessage,
  getProject,
  listItemSessions,
  updateItem,
  uploadAndProcessPhoto,
  uploadAndTranscribeVoice,
} from '../../services/projects-api';
import { releaseMicrophone } from '../../lib/mic-recorder';
import { revokeObjectUrl } from '../../lib/object-url';
import { useAsync } from '../../lib/useAsync';
import { runState, sortRuns } from '../../lib/item-runs';
import type { RunState } from '../../lib/item-runs';
import { formatRunTime } from '../../lib/intl-locale';
import { navigate, routes } from '../../lib/router';
import { haptic } from '../../lib/telegram';
import { useI18n } from '../../lib/i18n-context';
import { LoadError, ScreenHeader } from './shared';
import { SketchSlotActions } from '../sketch/SketchSlotActions';
import { AudienceCard } from '../../components/AudienceCard';
import { formatPrice, itemLabel } from './format';
import type {
  ProcessPhotoResult,
  ProductItemView,
  ProjectView,
} from '../../types/project';

const STEPS = ['photo', 'analogs', 'voice', 'price'] as const;
type Step = (typeof STEPS)[number];

export function ItemScreen({
  projectId,
  itemId,
  step,
}: {
  projectId: string;
  itemId: string;
  step?: string;
}) {
  const { dict } = useI18n();
  const STEP_LABELS: Record<Step, string> = {
    photo: dict.itemScreen.steps.photo,
    analogs: dict.itemScreen.steps.analogs,
    voice: dict.itemScreen.steps.voice,
    price: dict.itemScreen.steps.price,
  };
  const {
    data: project,
    setData,
    loading,
    error,
    reload,
  } = useAsync(() => getProject(projectId), [projectId]);
  /**
   * Почему аналогов нет — из ответа сервера (§6.1, этап 39, А-2.13).
   * Живёт на уровне экрана, а не шага: причину рождает шаг «Фото», а
   * показывает шаг «Аналоги».
   */
  const [analogsReason, setAnalogsReason] = useState<string | null>(null);
  const current: Step = (STEPS as readonly string[]).includes(step ?? '')
    ? (step as Step)
    : 'photo';
  const item = project?.items.find((i) => i.id === itemId) ?? null;
  const index = project?.items.findIndex((i) => i.id === itemId) ?? 0;

  const go = (s: Step) => navigate(routes.item(projectId, itemId, s));
  const patchItem = (next: ProductItemView) =>
    setData((p) =>
      p ? { ...p, items: p.items.map((i) => (i.id === next.id ? next : i)) } : p
    );

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={28} />
      </div>
    );
  }
  if (error || !project || !item) {
    return (
      <div>
        <ScreenHeader
          title={dict.itemScreen.title}
          back={routes.project(projectId)}
        />
        {error ? (
          <LoadError error={error} onRetry={reload} />
        ) : (
          <Alert tone="error">{dict.itemScreen.itemNotFound}</Alert>
        )}
      </div>
    );
  }

  return (
    <div className="animate-fadeIn">
      <ScreenHeader
        title={itemLabel(item, index, dict.projectFormat.itemFallback)}
        back={routes.project(projectId)}
        hint={
          <>
            {project.title} ·{' '}
            <span className="tabular">{project.currency}</span>
            {item.category && (
              <>
                {' '}
                · <Badge>{item.category}</Badge>
              </>
            )}
          </>
        }
      />
      <Stepper
        steps={STEPS.map((s) => STEP_LABELS[s])}
        current={STEPS.indexOf(current)}
        onSelect={(i) => go(STEPS[i])}
      />

      <ItemRuns projectId={projectId} itemId={itemId} />

      {current === 'photo' && (
        <PhotoStep
          project={project}
          item={item}
          onDone={(r) => {
            patchItem(r.item);
            // §6.1 (этап 39, А-2.13): сервер специально отдаёт причину,
            // «чтобы пустая выдача из-за сбоя отличалась от
            // “аналогов не найдено”». До этого этапа клиент её
            // выбрасывал, и при истёкшем ключе SerpApi пользователь
            // переснимал фото ещё три раза, каждый раз оплачивая
            // распознавание.
            setAnalogsReason(r.analogsReason ?? r.recognitionReason ?? null);
            go('analogs');
          }}
          onSkip={() => go('voice')}
        />
      )}
      {current === 'analogs' && (
        <AnalogsStep
          project={project}
          item={item}
          reason={analogsReason}
          onNext={() => go('voice')}
          onRetake={() => go('photo')}
        />
      )}
      {current === 'voice' && (
        <VoiceStep
          project={project}
          item={item}
          onSaved={patchItem}
          onNext={() => go('price')}
        />
      )}
      {current === 'price' && (
        <PriceStep
          project={project}
          item={item}
          onSaved={patchItem}
          onFinish={() => navigate(routes.project(projectId))}
        />
      )}
    </div>
  );
}

// ── Прогоны генерации товара (Б-2.9, этап 121) ──────────────────────────

/**
 * Единственное место в интерфейсе, где видно НЕЗАВЕРШЁННЫЙ прогон.
 *
 * Список готовых роликов (`/postprod`) отбирает только завершённые, а
 * мастер держится за единственный `localStorage['sessionId']` — запуск
 * следующего товара его затирал, и идущий рендер становился недостижим
 * навсегда: через сутки TTL уносил и сессию, и уже оплаченный ролик.
 * Маршрут `GET …/sessions` для этого и был написан — и не вызывался
 * ничем с самого своего появления.
 *
 * Пустой ответ ничего не рисует: карточка «прогонов пока нет» на экране
 * товара, который ещё заполняют, — это шум.
 */
function ItemRuns({
  projectId,
  itemId,
}: {
  projectId: string;
  itemId: string;
}) {
  const { dict, locale } = useI18n();
  const t = dict.projectScreen;
  const { data, error, reload } = useAsync(
    () => listItemSessions(projectId, itemId),
    [projectId, itemId]
  );

  // Сбой этого списка не должен мешать заполнению товара — он
  // вспомогательный, и карточка висит над формой на КАЖДОМ шаге. Но и
  // молчать нельзя: «прогонов нет» и «не удалось посмотреть» — разные
  // вещи (этап 119, тот же урок). Поэтому строка с повтором, а не
  // блок с ошибкой во весь экран.
  if (error) {
    return (
      <p className="mb-4 text-xs text-silver-400">
        {t.runsLoadError}{' '}
        <button
          type="button"
          className="text-accent underline"
          onClick={reload}
        >
          {t.runsRetry}
        </button>
      </p>
    );
  }
  // Пустые сессии (`fresh`) не показываем вовсе: в них ничего нет, а
  // накапливаются они от случайных нажатий «Сделать ролик».
  const runs = sortRuns((data ?? []).filter((r) => runState(r) !== 'fresh'));
  if (runs.length === 0) return null;
  const stateLabel: Record<RunState, string> = {
    done: t.runStateDone,
    running: t.runStateRunning,
    stalled: t.runStateStalled,
    failed: t.runStateFailed,
    // Не рисуется (такие строки отфильтрованы выше) — ключ есть только
    // ради полноты словаря состояний.
    fresh: t.runStateStalled,
  };
  const tone: Record<RunState, 'success' | 'warning' | 'neutral' | 'danger'> = {
    done: 'success',
    running: 'warning',
    stalled: 'neutral',
    failed: 'danger',
    fresh: 'neutral',
  };

  const resume = (sessionId: string) => {
    // Та же ручка, которой мастер и жил всегда, — см. `ProjectScreen`.
    localStorage.setItem('sessionId', sessionId);
    navigate(routes.generate());
  };

  return (
    <Card className="mb-4 p-4">
      <div className="mb-1 flex items-center gap-2">
        <History size={14} className="text-accent" />
        <span className="text-sm font-semibold">{t.runsHeading}</span>
      </div>
      <p className="mb-3 text-xs text-silver-400">{t.runsHint}</p>
      <ul className="space-y-2">
        {runs.map((run) => {
          const state = runState(run);
          return (
            <li
              key={run.sessionId}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-silver-200/70 p-2 text-xs dark:border-silver-800"
            >
              <Badge tone={tone[state]}>{stateLabel[state]}</Badge>
              <span className="tabular text-silver-400">
                {formatRunTime(run.lastActivityAt || run.createdAt, locale)}
              </span>
              <span className="ml-auto">
                {state === 'done' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      navigate(routes.postprodVideo(run.sessionId))
                    }
                  >
                    {t.runOpen}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => resume(run.sessionId)}
                  >
                    {t.runResume}
                  </Button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ── Экран 2 — Фото ──────────────────────────────────────────────────────

function PhotoStep({
  project,
  item,
  onDone,
  onSkip,
}: {
  project: ProjectView;
  item: ProductItemView;
  onDone: (r: ProcessPhotoResult) => void;
  onSkip: () => void;
}) {
  const { dict } = useI18n();
  const [preview, setPreview] = useState<string | null>(item.photoUrl);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'processing'>(
    'idle'
  );
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  // Ссылка на снятое фото отзывается и при пересъёмке, и при уходе с
  // шага (этап 119). Начальное значение — обычная ссылка на фото с
  // сервера, поэтому отзыв через `revokeObjectUrl`, а не напрямую.
  useEffect(() => () => revokeObjectUrl(preview), [preview]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setErr(dict.itemScreen.photo.invalidFormat);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setErr(dict.itemScreen.photo.tooLarge);
      return;
    }
    setErr(null);
    setPreview(URL.createObjectURL(file));
    setPhase('uploading');
    setProgress(0);
    try {
      const result = await uploadAndProcessPhoto(
        project.id,
        item.id,
        file,
        (p) => {
          setProgress(p);
          if (p >= 100) setPhase('processing');
        }
      );
      haptic('medium');
      onDone(result);
    } catch (e) {
      setErr(errorMessage(e));
      setPhase('idle');
    }
  };

  const busy = phase !== 'idle';

  return (
    <Card className="p-5">
      <CardHeader
        icon={<Camera size={18} className="text-accent" />}
        title={dict.itemScreen.photo.title}
        hint={dict.itemScreen.photo.hint}
      />

      <div className="mb-4 grid place-items-center overflow-hidden rounded-xl border border-dashed border-silver-300 dark:border-silver-700 min-h-[12rem]">
        {preview ? (
          <img
            src={preview}
            alt=""
            // Фото товара может смениться на ИИ-скетч (§7.2) — крон
            // UI-снимков не должен считать это регрессом вёрстки.
            data-qa-mask="item-photo"
            className="max-h-72 w-full object-contain"
          />
        ) : (
          <div className="py-8 text-center text-silver-400">
            <Images size={30} className="mx-auto mb-2" />
            <p className="text-xs">{dict.itemScreen.photo.placeholder}</p>
          </div>
        )}
      </div>

      {busy && (
        <FeaturePanel className="mb-4">
          <div className="flex items-center gap-3">
            <Spinner size={18} />
            <div className="min-w-0 flex-1 text-xs">
              {phase === 'uploading' ? (
                <>
                  <div className="font-medium">
                    {dict.itemScreen.photo.uploading}{' '}
                    <span className="tabular">{progress}%</span>
                  </div>
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-silver-200/60 dark:bg-silver-800/60">
                    <div
                      className="h-full rounded-full bg-accent transition-all"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="font-medium">
                    {dict.itemScreen.photo.analyzing}
                  </div>
                  <div className="text-silver-400">
                    {dict.itemScreen.photo.analyzingSub}
                  </div>
                </>
              )}
            </div>
          </div>
        </FeaturePanel>
      )}

      {err && (
        <Alert tone="error" className="mb-4">
          {err}
        </Alert>
      )}

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />

      {/* ИИ-скетч слота S6 (doc/AI-SKETCH-SPEC.md §7.2). Оригинал товара
          разделяемый: на него ссылаются сессии, созданные из этого
          товара, — перевод этих ссылок на скетч делает сервер, экрану
          достаточно показать новый активный вариант из `slot.url`. */}
      {item.photoUrl && (
        <SketchSlotActions
          className="mb-3"
          target={{ type: 'project-item', id: item.id }}
          hasImage
          // ИСХОДНОЕ фото, а не то, что на экране: после перезагрузки
          // `photoUrl` — это уже скетч, и сравнение «до/после»
          // показывало бы одно и то же (аудит A-15).
          originalUrl={item.originalPhotoUrl ?? item.photoUrl}
          activeUrl={item.photoUrl}
          variant={item.photoVariant ?? 'original'}
          activeSketchId={item.activeSketchId ?? null}
          originalDeleted={item.originalDeleted ?? false}
          description={
            [item.title, item.description].filter(Boolean).join('. ') ||
            undefined
          }
          disabled={busy}
          onSlot={(slot) => setPreview(slot.url)}
        />
      )}

      <div className="grid grid-cols-2 gap-2">
        <Button
          size="lg"
          icon={<Camera size={16} />}
          onClick={() => cameraRef.current?.click()}
          disabled={busy}
        >
          {dict.itemScreen.photo.takePhoto}
        </Button>
        <Button
          size="lg"
          variant="outline"
          icon={<Images size={16} />}
          onClick={() => galleryRef.current?.click()}
          disabled={busy}
        >
          {dict.itemScreen.photo.fromGallery}
        </Button>
      </div>

      <div className="mt-3 flex items-center justify-between">
        {item.photoUrl && item.analogs.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              navigate(routes.item(project.id, item.id, 'analogs'))
            }
            disabled={busy}
          >
            {dict.itemScreen.photo.toAnalogs} <ArrowRight size={14} />
          </Button>
        ) : (
          <span />
        )}
        <Button variant="ghost" size="sm" onClick={onSkip} disabled={busy}>
          {dict.itemScreen.photo.skipToDescription} <ArrowRight size={14} />
        </Button>
      </div>
    </Card>
  );
}

// ── Экран 3 — Аналоги ───────────────────────────────────────────────────

type Sort = 'relevance' | 'price-asc' | 'price-desc';

function AnalogsStep({
  project,
  item,
  reason,
  onNext,
  onRetake,
}: {
  project: ProjectView;
  item: ProductItemView;
  /** Причина пустой выдачи от сервера — сбой это или честное «не нашлось». */
  reason: string | null;
  onNext: () => void;
  onRetake: () => void;
}) {
  const { dict, locale } = useI18n();
  const [sort, setSort] = useState<Sort>('relevance');
  const rows = useMemo(() => {
    const list = [...item.analogs];
    if (sort === 'relevance')
      return list.sort((a, b) => a.relevanceRank - b.relevanceRank);
    const inf =
      sort === 'price-asc'
        ? Number.POSITIVE_INFINITY
        : Number.NEGATIVE_INFINITY;
    return list.sort((a, b) => {
      const pa = a.price ?? inf;
      const pb = b.price ?? inf;
      return sort === 'price-asc' ? pa - pb : pb - pa;
    });
  }, [item.analogs, sort]);

  return (
    <Card className="p-5">
      <CardHeader
        icon={<Tag size={18} className="text-accent" />}
        title={dict.itemScreen.analogs.title}
        hint={
          item.analogs.length > 0
            ? dict.itemScreen.analogs.countHint.replace(
                '{{count}}',
                String(item.analogs.length)
              )
            : undefined
        }
      />

      {item.analogs.length > 1 && (
        <div className="mb-3 flex gap-2">
          {(
            [
              ['relevance', dict.itemScreen.analogs.sort.relevance],
              ['price-asc', dict.itemScreen.analogs.sort.priceAsc],
              ['price-desc', dict.itemScreen.analogs.sort.priceDesc],
            ] as [Sort, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setSort(value)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                sort === value
                  ? 'bg-accent text-accent-on'
                  : 'bg-silver-200/60 dark:bg-silver-800/60 text-silver-500 hover:text-silver-700 dark:hover:text-silver-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {item.analogs.length === 0 ? (
        <EmptyState
          title={
            !item.photoUrl
              ? dict.itemScreen.analogs.noPhotoTitle
              : reason
                ? dict.itemScreen.analogs.searchFailedTitle
                : dict.itemScreen.analogs.notFoundTitle
          }
          hint={
            !item.photoUrl
              ? dict.itemScreen.analogs.noPhotoHint
              : reason
                ? // Без причины пользователь читает пустоту как «нет
                  // аналогов» и переснимает фото, оплачивая распознавание
                  // каждый раз.
                  `${reason}${dict.itemScreen.analogs.reasonHintSuffix}`
                : dict.itemScreen.analogs.notFoundHint
          }
          action={
            <Button
              variant="outline"
              size="sm"
              icon={<RefreshCw size={14} />}
              onClick={onRetake}
            >
              {!item.photoUrl
                ? dict.itemScreen.analogs.takePhotoAction
                : reason
                  ? dict.itemScreen.analogs.retryAction
                  : dict.itemScreen.analogs.otherPhotoAction}
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-silver-200/60 dark:divide-silver-800 -mx-2">
          {rows.map((a) => (
            // На 320px названию оставалось ~95px — около десяти символов,
            // по которым аналог не узнать (аудит 2026-09-06, А-3.10).
            // Строка теперь переносится: пока названию хватает basis-40,
            // цена стоит справа как раньше, иначе уходит на вторую строку,
            // а название забирает всю ширину.
            <li
              key={a.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2.5"
            >
              <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-silver-200/60 dark:bg-silver-800/60">
                {a.thumbnailUrl && (
                  <img
                    src={a.thumbnailUrl}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                )}
              </div>
              <div className="min-w-0 flex-1 basis-40">
                <a
                  href={a.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex max-w-full items-center gap-1 text-sm hover:text-accent hover:underline"
                >
                  <span className="truncate">{a.title}</span>
                  <ExternalLink
                    size={12}
                    className="shrink-0 text-silver-400"
                  />
                </a>
                <div className="text-[11px] text-silver-400 truncate">
                  #{a.relevanceRank} · {safeHost(a.sourceUrl)}
                </div>
              </div>
              <div className="tabular ml-auto shrink-0 text-sm font-semibold">
                {a.price !== null ? (
                  formatPrice(a.price, a.currency, locale)
                ) : (
                  <span className="text-silver-400">—</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex justify-end">
        <Button icon={<ArrowRight size={16} />} onClick={onNext}>
          {dict.itemScreen.analogs.next}
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-silver-400">
        {dict.itemScreen.analogs.footerHint}{' '}
        <span className="tabular">{project.currency}</span>.
      </p>
    </Card>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// ── Экран 4 — Описание голосом ─────────────────────────────────────────

function pickRecorderMime(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const c of candidates) {
    if (
      typeof MediaRecorder !== 'undefined' &&
      MediaRecorder.isTypeSupported?.(c)
    )
      return c;
  }
  return 'audio/webm';
}

function VoiceStep({
  project,
  item,
  onSaved,
  onNext,
}: {
  project: ProjectView;
  item: ProductItemView;
  onSaved: (i: ProductItemView) => void;
  onNext: () => void;
}) {
  const { dict } = useI18n();
  const [text, setText] = useState(item.description ?? '');
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{
    tone: 'error' | 'info' | 'success';
    text: string;
  } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  // Сам поток микрофона, а не только запись (этап 119, В-5.17): до этого
  // `stream` жил локальной переменной внутри `start()`, и дотянуться до
  // его дорожек можно было ровно из одного места — обработчика `onstop`.
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const supported =
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;

  // Уход с шага (шаг в «Степпере», ссылка «назад», вкладка внизу)
  // снимает компонент, но микрофон принадлежит не компоненту, а
  // вкладке: до этапа 119 запись продолжалась в никуда, индикатор
  // микрофона горел до конца сессии, а `onstop` — если бы его кто-то
  // вызвал — дописывал бы расшифровку в состояние уже снятого экрана.
  useEffect(
    () => () => {
      stopTimer();
      releaseMic();
    },
    []
  );
  const stopTimer = () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
  };

  /** Отпустить микрофон. Уже законченную запись — не трогать. */
  const releaseMic = () => {
    const interrupted = releaseMicrophone(
      recorderRef.current,
      streamRef.current
    );
    recorderRef.current = null;
    streamRef.current = null;
    // Куски выбрасываются ТОЛЬКО если запись прервали мы. Если человек
    // нажал «Стоп» и мы попали в окно до `onstop`, эти куски — его
    // расшифровка, и она ещё доедет до сервера сама.
    if (interrupted) chunksRef.current = [];
  };

  const start = async () => {
    setNote(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickRecorderMime();
      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      rec.ondataavailable = (e) =>
        e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: mime });
        await transcribe(blob, mime);
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
      setSeconds(0);
      timerRef.current = window.setInterval(
        () => setSeconds((s) => s + 1),
        1000
      );
      haptic();
    } catch (e) {
      // Поток мог быть уже получен, а `new MediaRecorder` — упасть
      // (Safari и неподдерживаемый контейнер). Тогда человек читает
      // «микрофон недоступен», а индикатор микрофона горит: отпускаем.
      releaseMic();
      setNote({
        tone: 'error',
        text: dict.itemScreen.voice.micUnavailable.replace(
          '{{error}}',
          errorMessage(e)
        ),
      });
    }
  };

  const stop = () => {
    stopTimer();
    setRecording(false);
    // `onstop` придёт асинхронно, и до него кнопка «Записать ещё» была
    // доступна: нажатие в это окно обнуляло куски ещё не расшифрованной
    // записи, и человек получал «пустая запись» вместо своего текста.
    setTranscribing(true);
    recorderRef.current?.stop();
    haptic();
  };

  const transcribe = async (blob: Blob, mime: string) => {
    if (blob.size === 0) {
      setNote({ tone: 'error', text: dict.itemScreen.voice.emptyRecording });
      setTranscribing(false);
      return;
    }
    setTranscribing(true);
    try {
      // apply:false — we show the text in the editor first; it is saved
      // together with any manual edits on "Сохранить".
      const r = await uploadAndTranscribeVoice(
        project.id,
        item.id,
        blob,
        mime,
        false
      );
      if (r.text) {
        // Этап 52 (В-1.7): расшифровка сохраняется сразу, а не только
        // кнопкой. Степпер экрана кликабелен, и уход на «Аналоги» стирал
        // надиктованное — платный вызов Gemini, аудиофайл после
        // расшифровки удалён, диктовать и платить заново. Правки руками
        // по-прежнему уходят кнопкой «Сохранить».
        const merged = text.trim() ? `${text.trim()}\n${r.text}` : r.text;
        setText(merged);
        try {
          const updated = await updateItem(project.id, item.id, {
            description: merged.trim() || null,
          });
          onSaved(updated);
          setNote({
            tone: 'success',
            text: dict.itemScreen.voice.transcribedSaved,
          });
        } catch (e) {
          setNote({
            tone: 'error',
            text: dict.itemScreen.voice.transcribedNotSaved.replace(
              '{{error}}',
              errorMessage(e)
            ),
          });
        }
      } else {
        setNote({
          tone: 'error',
          text: dict.itemScreen.voice.recognitionFailed.replace(
            '{{reasonSuffix}}',
            r.reason ? ` (${r.reason})` : ''
          ),
        });
      }
    } catch (e) {
      setNote({ tone: 'error', text: errorMessage(e) });
    } finally {
      setTranscribing(false);
    }
  };

  const [audienceSaving, setAudienceSaving] = useState(false);

  const save = async (andNext: boolean) => {
    setSaving(true);
    setNote(null);
    try {
      const updated = await updateItem(project.id, item.id, {
        description: text.trim() ? text.trim() : null,
      });
      onSaved(updated);
      if (andNext) onNext();
      else setNote({ tone: 'success', text: dict.itemScreen.voice.saved });
    } catch (e) {
      setNote({ tone: 'error', text: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  const dirty = (text.trim() || '') !== (item.description ?? '');

  return (
    <Card className="p-5">
      <CardHeader
        icon={<Mic size={18} className="text-accent" />}
        title={dict.itemScreen.voice.title}
        hint={dict.itemScreen.voice.hint}
      />

      <div className="mb-4 flex items-center gap-3">
        {supported ? (
          recording ? (
            <Button
              variant="danger"
              size="lg"
              icon={<Square size={16} />}
              onClick={stop}
              className="animate-pulseRing"
            >
              {dict.itemScreen.voice.stopLabel} ·{' '}
              <span className="tabular">{fmtSec(seconds)}</span>
            </Button>
          ) : (
            <Button
              size="lg"
              icon={<Mic size={16} />}
              onClick={start}
              disabled={transcribing || saving}
              loading={transcribing}
            >
              {transcribing
                ? dict.itemScreen.voice.transcribing
                : text
                  ? dict.itemScreen.voice.recordMore
                  : dict.itemScreen.voice.record}
            </Button>
          )
        ) : (
          <span className="text-xs text-silver-400">
            {dict.itemScreen.voice.recordingUnsupported}
          </span>
        )}
      </div>

      <Field
        label={dict.itemScreen.voice.textLabel}
        htmlFor="item-description"
        counter={`${text.length}/2000`}
      >
        <Textarea
          id="item-description"
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 2000))}
          placeholder={dict.itemScreen.voice.textPlaceholder}
          disabled={recording || transcribing}
        />
      </Field>

      {/* Spec §18: who buys it — Gemini's read of the photo, correctable here. */}
      <div className="mt-3">
        <AudienceCard
          key={`${item.id}:${item.updatedAt}`}
          audience={item.audience}
          saving={audienceSaving}
          onSave={async (draft) => {
            setAudienceSaving(true);
            try {
              onSaved(
                await updateItem(project.id, item.id, { audience: draft })
              );
            } finally {
              setAudienceSaving(false);
            }
          }}
        />
      </div>

      {note && (
        <Alert tone={note.tone} className="mt-3">
          {note.text}
        </Alert>
      )}

      <div className="mt-4 flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          onClick={() => void save(false)}
          disabled={!dirty || saving || recording}
          loading={saving}
        >
          {dict.itemScreen.voice.save}
        </Button>
        <Button
          icon={<ArrowRight size={16} />}
          onClick={() => (dirty ? void save(true) : onNext())}
          disabled={saving || recording || transcribing}
        >
          {dict.itemScreen.voice.next}
        </Button>
      </div>
    </Card>
  );
}

function fmtSec(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── Экран 5 — Цена ──────────────────────────────────────────────────────

function PriceStep({
  project,
  item,
  onSaved,
  onFinish,
}: {
  project: ProjectView;
  item: ProductItemView;
  onSaved: (i: ProductItemView) => void;
  onFinish: () => void;
}) {
  const { dict, locale } = useI18n();
  const [value, setValue] = useState(
    item.price !== null ? String(item.price) : ''
  );
  const [source, setSource] = useState<'MANUAL' | 'ANALOG'>(item.priceSource);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Этап 54 (В-4.7): подставить одним нажатием можно только цену в валюте
  // проекта. У аналога валюта своя (источник мог быть иностранным), а у
  // цены товара — валюта проекта, и «$19» превращался в «19 UAH» без
  // пересчёта. Курса у сервиса нет и не будет ради этого: чужая валюта
  // остаётся видимой как ориентир, но в поле не попадает.
  const priced = useMemo(
    () =>
      item.analogs
        .filter((a) => a.price !== null)
        .sort((a, b) => (a.price ?? 0) - (b.price ?? 0)),
    [item.analogs]
  );
  const sameCurrency = (a: { currency: string | null }) =>
    !a.currency || a.currency.toUpperCase() === project.currency.toUpperCase();
  const pickable = priced.filter(sameCurrency);
  const foreign = priced.filter((a) => !sameCurrency(a));
  const parsed = value.trim() === '' ? null : Number(value.replace(',', '.'));
  const valid =
    parsed === null ||
    (Number.isFinite(parsed) &&
      parsed >= 0 &&
      Math.round(parsed * 100) === parsed * 100);

  const pick = (price: number) => {
    setValue(String(price));
    setSource('ANALOG');
    haptic();
  };

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    setErr(null);
    try {
      const updated = await updateItem(project.id, item.id, {
        price: parsed,
        ...(parsed !== null ? { priceSource: source } : {}),
      });
      onSaved(updated);
      haptic('medium');
      onFinish();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5">
      <CardHeader
        icon={<Tag size={18} className="text-accent" />}
        title={dict.itemScreen.price.title}
        hint={
          <>
            {dict.itemScreen.price.hintPrefix}{' '}
            <span className="tabular">{project.currency}</span>
            {dict.itemScreen.price.hintSuffix}
          </>
        }
      />

      {priced.length > 0 && (
        <div className="mb-4">
          <span className="label">
            {dict.itemScreen.price.analogPricesLabel}
          </span>
          <div className="flex flex-wrap gap-2">
            {pickable.slice(0, 12).map((a) => {
              const active = source === 'ANALOG' && parsed === a.price;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => pick(a.price as number)}
                  title={a.title}
                  className={`tabular min-h-[44px] rounded-xl px-3 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? 'bg-accent text-accent-on'
                      : 'bg-silver-200/60 dark:bg-silver-800/60 text-silver-600 dark:text-silver-300 hover:text-accent'
                  }`}
                >
                  {formatPrice(a.price, a.currency ?? project.currency, locale)}
                </button>
              );
            })}
            {foreign.slice(0, 6).map((a) => (
              <span
                key={a.id}
                title={dict.itemScreen.price.foreignPriceTitle
                  .replace('{{title}}', a.title)
                  .replace('{{currency}}', a.currency ?? '')}
                aria-disabled="true"
                className="tabular inline-flex min-h-[44px] items-center rounded-xl border border-dashed border-silver-300 dark:border-silver-700 px-3 py-1.5 text-xs text-silver-500 dark:text-silver-400"
              >
                {formatPrice(a.price, a.currency, locale)}
              </span>
            ))}
          </div>
          {pickable.length === 0 && (
            <p className="hint mt-1">
              {dict.itemScreen.price.allForeignHint.replace(
                '{{currency}}',
                project.currency
              )}
            </p>
          )}
          {pickable.length > 0 && foreign.length > 0 && (
            <p className="hint mt-1">{dict.itemScreen.price.foreignHint}</p>
          )}
        </div>
      )}

      <Field
        label={dict.itemScreen.price.fieldLabel.replace(
          '{{currency}}',
          project.currency
        )}
        htmlFor="item-price"
        error={!valid ? dict.itemScreen.price.invalidError : undefined}
        hint={
          source === 'ANALOG' && parsed !== null
            ? dict.itemScreen.price.fromAnalogHint
            : dict.itemScreen.price.customHint
        }
      >
        <Input
          id="item-price"
          inputMode="decimal"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSource('MANUAL');
          }}
          placeholder="0.00"
          invalid={!valid}
          className="tabular text-lg"
        />
      </Field>

      {err && (
        <Alert tone="error" className="mt-3">
          {err}
        </Alert>
      )}

      <Button
        block
        size="lg"
        className="mt-4"
        icon={<Check size={16} />}
        onClick={() => void save()}
        disabled={!valid || saving}
        loading={saving}
      >
        {dict.itemScreen.price.saveAndReturn}
      </Button>
      {!item.description && (
        <p className="mt-2 text-center text-[11px] text-silver-400">
          {dict.itemScreen.price.needDescriptionHint}
        </p>
      )}
    </Card>
  );
}
