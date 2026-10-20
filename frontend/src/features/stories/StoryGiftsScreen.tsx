import { exclusiveStoryPlayback } from './story-media-playback';
import { StoryVideoPanel } from './StoryVideoPanel';
import { StoryReferencesPanel } from './StoryReferencesPanel';
import { StoryEditionsPanel } from './StoryEditionsPanel'; // WP2
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BookOpen, Cake, Heart, Moon, Sun } from 'lucide-react';
import {
  OCCASION_KINDS,
  OCCASION_LABELS,
  STORY_THEME_IDS,
  STORY_THEMES,
  budgetWarning,
  buildPreviewPayload,
  buildStoryPayload,
  canCreate,
  draftParts,
  estimateRows,
  formatUsd,
  occasionCaption,
  previewKey,
  themeFor,
  type GiftNotePosition,
  type OccasionKind,
  type StoryEstimate,
  type StoryPreview,
  type StoryThemeIcon,
  type StoryThemeId,
  type WizardState,
} from './story-wizard';
import { Button, Card } from '../../components/ui';
import { api } from '../../services/api';
import { navigate, routes } from '../../lib/router';
import {
  StoryClientError,
  storyErrorText,
  storyLoadFailure,
} from './story-errors';
import { parseUsdBudget } from './story-library';
import {
  audioQaConfirm,
  deleteGiftConfirm,
  includedInReserve,
  novaConfirm,
  reserveSuffix,
} from './story-confirm';
import { useStoryConfirm } from './StoryConfirm';
import { fitStoryPhoto } from './story-photo-fit';

type Chapter = { title: string; text: string; scene: string };
type Story = {
  id: string;
  title: string;
  rights: string;
  chapters: Chapter[];
  locale: string;
  countries: string[];
  targetSeconds: number;
  kind: string;
  sourceUrl?: string;
  sourceEdition?: {
    author: string;
    edition: string;
    pages: string;
    changes: string;
    textSha256: string;
  };
  audioReserveUsd: number;
};
type Gift = {
  budgetCents: number;
  reservedMicroUsd: number;
  locale: string;
  audioQaStatus: string;
  audioQa: {
    wer: number;
    recognizedWords: number;
    referenceWords: number;
  } | null;
  chapters: Chapter[];
  id: string;
  catalogId?: string;
  title: string;
  occasion: string | null;
  occasionKind: string | null;
  occasionTheme: string | null;
  giftNoteEnabled?: boolean;
  giftPhotoDescription: string | null;
  estimate?: StoryEstimate;
  giftNote: string | null;
  giftNotePosition: string | null;
  hasGiftPhoto: boolean;
  status: string;
  durationSeconds: number | null;
  audioHash: string | null;
  error: string | null;
};
const stateNames: Record<string, string> = {
  DRAFT: 'Черновик',
  SYNTHESIZING: 'Озвучивается',
  READY: 'Готово к просмотру',
  APPROVED: 'Одобрено',
  UNKNOWN: 'Нужна проверка оператора',
  FAILED: 'Ошибка',
};
const inputStyle =
  'w-full rounded-lg border border-silver-700 bg-transparent p-3';
function errorText(e: unknown): string {
  return storyErrorText(e, {
    fallback:
      'Не удалось выполнить действие. Обновите список — повторная озвучка автоматически не запускается.',
    noResponse:
      'Ответ сервера не получен. Обновите список: действие могло выполниться — повторная озвучка автоматически не запускается.',
  });
}
async function photoPng(file: File): Promise<string> {
  if (
    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
    file.size > 10 * 1024 * 1024
  )
    throw new StoryClientError('Фото PNG, JPEG или WebP до 10 МБ');
  const bitmap = await createImageBitmap(file);
  try {
    // ST2-U-02: сервер принимает только PNG ≤1024 px и ≤1 МиБ — размер
    // подбирается шагами, пока PNG не уложится в лимит (story-photo-fit).
    const fitted = await fitStoryPhoto(
      bitmap.width,
      bitmap.height,
      async (width, height) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, width, height);
        return canvas.toDataURL('image/png').split(',')[1] ?? '';
      }
    ).catch((e: unknown) => {
      throw new StoryClientError(
        e instanceof Error && e.name === 'StoryPhotoTooLarge'
          ? e.message
          : 'Не удалось сжать фото — выберите другой файл PNG, JPEG или WebP.'
      );
    });
    return fitted.base64;
  } finally {
    bitmap.close();
  }
}
const THEME_ICONS: Record<StoryThemeIcon, typeof BookOpen> = {
  book: BookOpen,
  cake: Cake,
  moon: Moon,
  heart: Heart,
  sun: Sun,
};
function ThemeBadge({ theme }: { theme: StoryThemeId }) {
  const t = STORY_THEMES[theme];
  const Icon = THEME_ICONS[t.icon];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-sm"
      style={{ background: t.soft, color: t.ink }}
    >
      <Icon size={16} aria-hidden="true" /> {t.label}
    </span>
  );
}
function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-sm ${active ? 'border-accent bg-accent/10' : 'border-silver-700'}`}
    >
      {children}
    </button>
  );
}
function SpokenText({
  parts,
}: {
  parts: Array<{ kind: 'giftNote' | 'main'; text: string }>;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-silver-700 p-3">
      {parts.map((p, i) =>
        p.kind === 'giftNote' ? (
          <p key={i}>
            <mark className="rounded px-1">{p.text}</mark>{' '}
            <span className="text-xs text-silver-400">· реплика о подарке</span>
          </p>
        ) : (
          <p key={i} className="whitespace-pre-line">
            {p.text}
          </p>
        )
      )}
    </div>
  );
}
function EstimateTable({ estimate }: { estimate: StoryEstimate }) {
  const warning = budgetWarning(estimate);
  return (
    <div className="space-y-2">
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            <th className="py-1">Статья</th>
            <th className="py-1">Оценка</th>
            <th className="py-1">Резерв</th>
          </tr>
        </thead>
        <tbody>
          {estimateRows(estimate).map((row) => (
            <tr
              key={row.id}
              className={row.muted ? 'text-silver-400' : undefined}
              title={row.detail}
            >
              <td className="py-1">
                {row.label}
                {row.status ? ` · ${row.status}` : ''}
                <div className="text-xs text-silver-400">{row.detail}</div>
              </td>
              <td className="py-1">{row.cost}</td>
              <td className="py-1">{row.reserve}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-sm">
        Итого резерв: {formatUsd(estimate.totalReserveMicroUsd)} из бюджета{' '}
        {formatUsd(estimate.budgetMicroUsd)}. Оценка по внутреннему прайсу, не
        счёт провайдера. {estimate.policy}
      </p>
      {warning && (
        <p role="alert" className="rounded-lg border border-red-400 p-3">
          {warning}
        </p>
      )}
    </div>
  );
}
function Illustration({ scene }: { scene: string }) {
  if (scene === 'turnip')
    return (
      <svg
        viewBox="0 0 640 360"
        className="w-full rounded-xl"
        role="img"
        aria-label="Большая репка на грядке"
      >
        <rect width="640" height="360" rx="24" fill="#d8e9e0" />
        <circle cx="530" cy="65" r="35" fill="#ffe29a" />
        <path d="M0 245Q320 195 640 245V360H0" fill="#8ca97c" />
        <path d="M0 295Q320 250 640 295V360H0" fill="#946f56" />
        <path
          d="M310 205Q245 120 280 80Q330 100 324 175Q340 80 390 75Q415 130 340 210"
          fill="#538759"
        />
        <path
          d="M270 200Q325 165 380 200Q430 250 325 325Q230 270 270 200Z"
          fill="#f1d09b"
        />
        <path
          d="M300 225Q325 245 350 225"
          fill="none"
          stroke="#b4936b"
          strokeWidth="4"
        />
      </svg>
    );
  if (scene === 'mitten')
    return (
      <svg
        viewBox="0 0 640 360"
        className="w-full rounded-xl"
        role="img"
        aria-label="Рукавичка в зимнем лесу"
      >
        <rect width="640" height="360" rx="24" fill="#dcebf0" />
        <path d="M0 285Q160 220 320 280T640 255V360H0" fill="#f9fcfc" />
        <path
          d="M55 260L120 65L185 260ZM460 270L530 80L605 270Z"
          fill="#4f7774"
        />
        <path
          d="M270 285V175Q270 145 300 145H330Q360 145 360 175V205L380 185Q403 170 416 190Q425 210 405 230L360 280V300H270Z"
          fill="#cd745d"
        />
        <path d="M270 277H360V304H270Z" fill="#efc18d" />
        <circle cx="250" cy="299" r="16" fill="#a6adb7" />
        <circle cx="240" cy="285" r="8" fill="#c8cdd2" />
        <circle cx="260" cy="285" r="8" fill="#c8cdd2" />
      </svg>
    );
  if (scene === 'pigs')
    return (
      <svg
        viewBox="0 0 640 360"
        className="w-full rounded-xl"
        role="img"
        aria-label="Три поросёнка у кирпичного дома"
      >
        <rect width="640" height="360" rx="24" fill="#cfe5e5" />
        <path d="M0 265Q320 190 640 250V360H0" fill="#86a986" />
        <path d="M360 135L465 55L570 135" fill="#936b5d" />
        <rect x="375" y="135" width="180" height="145" rx="8" fill="#ca8d72" />
        <rect x="440" y="205" width="42" height="75" fill="#6d7769" />
        {[120, 210, 300].map((x) => (
          <g key={x}>
            <ellipse cx={x} cy="275" rx="34" ry="29" fill="#e6aba2" />
            <circle cx={x} cy="248" r="28" fill="#f4c2b7" />
            <ellipse cx={x} cy="257" rx="15" ry="10" fill="#d79890" />
            <circle cx={x - 6} cy="257" r="2" />
            <circle cx={x + 6} cy="257" r="2" />
            <circle cx={x - 10} cy="242" r="2" />
            <circle cx={x + 10} cy="242" r="2" />
          </g>
        ))}
      </svg>
    );
  return (
    <svg
      viewBox="0 0 640 300"
      role="img"
      aria-label="Иллюстрация сказки: лисёнок с фонариком"
      className="w-full rounded-xl"
    >
      <rect
        width="640"
        height="300"
        rx="20"
        fill={scene === 'stars' ? '#162340' : '#274c54'}
      />
      <circle cx="510" cy="62" r="30" fill="#ffdf9d" />
      <path d="M0 240Q160 160 320 240T640 220V300H0Z" fill="#376554" />
      <path
        d="M65 260L125 75L185 260ZM475 275L535 95L605 275Z"
        fill="#143f39"
      />
      <ellipse cx="310" cy="254" rx="48" ry="25" fill="#dd995c" />
      <path d="M278 240L278 180L300 201L326 183L339 240Z" fill="#e5a56b" />
      <path d="M288 220L309 242L331 217" fill="#ffe4bb" />
      <circle cx="296" cy="212" r="3" />
      <circle cx="321" cy="212" r="3" />
      <circle cx="374" cy="229" r="40" fill="#ffdf92" opacity=".2" />
      <rect x="362" y="216" width="25" height="32" rx="5" fill="#ffdf92" />
    </svg>
  );
}
export function StoryGiftsScreen() {
  const [catalog, setCatalog] = useState<Story[]>([]),
    [gifts, setGifts] = useState<Gift[]>([]),
    [selected, setSelected] = useState<Gift | null>(null);
  const [occasionKind, setOccasionKind] = useState<OccasionKind | null>(null),
    [occasionLabel, setOccasionLabel] = useState(''),
    [theme, setTheme] = useState<StoryThemeId | null>(null);
  const [noteEnabled, setNoteEnabled] = useState(false),
    [note, setNote] = useState(''),
    [position, setPosition] = useState<GiftNotePosition>('end'),
    [photoDescription, setPhotoDescription] = useState(''),
    [includeVideo, setIncludeVideo] = useState(false);
  const [preview, setPreview] = useState<StoryPreview | null>(null),
    [previewedKey, setPreviewedKey] = useState<string | null>(null),
    [draftDescription, setDraftDescription] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  /** Версия сохранённого фото: замена фото в черновике перезагружает превью. */
  const [photoRev, setPhotoRev] = useState(0);
  /** S3‑9: ввод, по которому уже создан черновик — повтор только после изменения. */
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [photo, setPhoto] = useState<string | null>(null),
    [savedPhoto, setSavedPhoto] = useState<string | null>(null);
  const [audio, setAudio] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [reviewed, setReviewed] = useState(false);
  const [country, setCountry] = useState('UA'),
    [storyLanguage, setStoryLanguage] = useState('ru');
  const [storyId, setStoryId] = useState('turnip-ushinsky-ru-1949-v1'),
    [budget, setBudget] = useState('1');
  const variants = catalog.filter((s) => s.locale === storyLanguage);
  const story =
    variants.find((s) => s.id === storyId) ||
    variants.find((s) => s.countries.includes(country)) ||
    variants[0];
  const wizard: WizardState = {
    catalogId: story?.id || '',
    budget,
    country,
    occasionKind,
    occasionLabel,
    theme,
    giftNoteEnabled: noteEnabled,
    giftNote: note,
    giftNotePosition: position,
    photoDescription,
    includeVideo,
  };
  const createGate = canCreate(wizard, previewedKey);
  const createKey = `${previewKey(wizard)}|${photo ? `${photo.length}:${photo.slice(-32)}` : ''}`;
  const alreadyCreated = createdKey === createKey;
  const budgetError = parseUsdBudget(budget).error;
  const previewFresh = preview !== null && previewedKey === previewKey(wizard);
  function chooseRegion(nextCountry: string, nextLanguage: string) {
    setCountry(nextCountry);
    setStoryLanguage(nextLanguage);
    const candidate =
      catalog.find(
        (s) => s.locale === nextLanguage && s.countries.includes(nextCountry)
      ) ||
      catalog.find((s) => s.locale === nextLanguage && s.kind === 'classic') ||
      catalog.find((s) => s.locale === nextLanguage && s.kind === 'adaptation');
    if (candidate) setStoryId(candidate.id);
  }
  /** ST2-U-13: 404/401/403 — раздел закрыт; иной сбой — текст и «Повторить». */
  const [access, setAccess] = useState<boolean | null | 'error'>(null);
  const [loadError, setLoadError] = useState('');
  const [loadNonce, setLoadNonce] = useState(0);
  const actionLock = useRef(false);
  const confirm = useStoryConfirm();
  async function refresh() {
    const res = await api.get<Gift[]>('/story-gifts');
    setGifts(res.data || []);
  }
  useEffect(() => {
    let alive = true;
    setAccess(null);
    setLoadError('');
    void Promise.all([
      api.get<Story[]>('/story-gifts/catalog'),
      api.get<Gift[]>('/story-gifts'),
    ])
      .then(([c, g]) => {
        if (!alive) return;
        setAccess(true);
        setCatalog(c.data || []);
        setGifts(g.data || []);
      })
      .catch((e) => {
        if (!alive) return;
        if (storyLoadFailure(e) === 'closed') {
          setAccess(false);
          return;
        }
        setAccess('error');
        setLoadError(
          storyErrorText(e, {
            fallback: 'Не удалось загрузить раздел сказок.',
            noResponse:
              'Не удалось загрузить раздел сказок: ответ сервера не получен (нет связи или истекло ожидание).',
          })
        );
      });
    return () => {
      alive = false;
    };
  }, [loadNonce]);
  // S3‑8: медиа выпуска зависят только от выпуска и его статуса, а не от
  // каждого нового объекта `selected` (GET карточки, ответ действия):
  // иначе аудио качалось дважды, а галочка проверки сбрасывалась.
  const selectedId = selected?.id ?? null;
  const selectedStatus = selected?.status ?? null;
  const selectedHasPhoto = selected?.hasGiftPhoto ?? false;
  useEffect(() => {
    setReviewed(false);
  }, [selectedId, selectedStatus]);
  useEffect(() => {
    setAudio(null);
    if (!selectedId || !['READY', 'APPROVED'].includes(selectedStatus ?? ''))
      return;
    let disposed = false;
    let url: string | null = null;
    void api
      .get<{ base64: string; mime: string }>(`/story-gifts/${selectedId}/audio`)
      .then((r) => {
        if (disposed || !r.data) return;
        const bytes = Uint8Array.from(atob(r.data.base64), (c) =>
          c.charCodeAt(0)
        );
        url = URL.createObjectURL(new Blob([bytes], { type: r.data.mime }));
        setAudio(url);
      })
      .catch((e) => {
        if (!disposed) setError(errorText(e));
      });
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [selectedId, selectedStatus]); // immutable edition; no repeat synthesis on reload
  useEffect(() => {
    setSavedPhoto(null);
    if (!selectedId || !selectedHasPhoto) return;
    let disposed = false;
    void api
      .get<{ base64: string }>(`/story-gifts/${selectedId}/photo`)
      .then((r) => {
        if (!disposed && r.data)
          setSavedPhoto(`data:image/png;base64,${r.data.base64}`);
      })
      .catch((e) => {
        if (!disposed) setError(errorText(e));
      });
    return () => {
      disposed = true;
    };
  }, [selectedId, selectedHasPhoto, photoRev]);
  async function run(action: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  async function update(path: string, body: unknown = {}) {
    const res = await api.post<Gift>(
      `/story-gifts/${selected!.id}/${path}`,
      body
    );
    const next = res.data;
    if (next)
      setSelected((prev) => ({
        ...next,
        estimate: next.estimate ?? prev?.estimate,
      }));
  }
  /** Список не несёт смету: подгружаем карточку целиком (GET :id). */
  function selectGift(g: Gift) {
    setSelected(g);
    setDraftDescription(g.giftPhotoDescription || '');
    void api
      .get<Gift>(`/story-gifts/${g.id}`)
      .then((r) => {
        const full = r.data;
        if (full) setSelected((cur) => (cur && cur.id === g.id ? full : cur));
      })
      .catch((e) => setError(errorText(e)));
  }
  if (access === 'error')
    return (
      <Card className="space-y-3 p-5">
        <p role="alert">{loadError}</p>
        <Button onClick={() => setLoadNonce((n) => n + 1)}>Повторить</Button>
      </Card>
    );
  if (access !== true)
    return (
      <Card className="p-5">
        {access === null
          ? 'Проверяем доступ…'
          : 'Раздел в закрытой разработке.'}
      </Card>
    );
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Card className="space-y-3 p-5">
        <BookOpen className="text-accent" />
        <h1 className="text-2xl font-semibold">Story‑Tales · Создать сказку</h1>
        <p>
          Первый формат: короткая классическая сказка с иллюстрациями и озвучкой
          Nova по умолчанию. В видео «Репки» можно выбрать собственный готовый
          голос из профиля рассказчика с подтверждением согласия. Основная речь
          и преамбула сохраняются отдельно.
        </p>
        <Button variant="ghost" onClick={() => navigate(routes.manifests())}>
          Профиль рассказчика в брендбуке
        </Button>
      </Card>
      {error && (
        <p role="alert" className="rounded-lg border border-red-400 p-3">
          {error}
        </p>
      )}
      <StoryReferencesPanel />
      <StoryEditionsPanel />
      {catalog.length > 0 && (
        <Card className="space-y-4 p-5">
          <h2 className="text-xl font-semibold">Сказка и бюджет подарка</h2>
          <label className="block">
            Страна пользователя
            <select
              className={inputStyle}
              value={country}
              onChange={(e) => chooseRegion(e.target.value, storyLanguage)}
            >
              <option value="UA">Украина</option>
              <option value="GB">Великобритания</option>
              <option value="US">США</option>
              <option value="DE">Германия</option>
              <option value="ES">Испания</option>
              <option value="OTHER">Другая страна</option>
            </select>
          </label>
          <label className="block">
            Язык сказки
            <select
              className={inputStyle}
              value={storyLanguage}
              onChange={(e) => chooseRegion(country, e.target.value)}
            >
              <option value="ru">Русский</option>
              <option value="uk">Українська</option>
              <option value="en">English</option>
            </select>
          </label>
          <label className="block">
            Сказка
            <select
              className={inputStyle}
              value={story?.id || ''}
              onChange={(e) => setStoryId(e.target.value)}
            >
              {variants.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} · {s.targetSeconds} с{' '}
                  {s.kind === 'original'
                    ? '· длинный аудиообразец'
                    : s.kind === 'classic'
                      ? '· точная классическая редакция'
                      : '· короткая адаптация'}
                </option>
              ))}
            </select>
          </label>
          <p>
            Страна подбирает рекомендуемую сказку; язык выбирается отдельно.
            Каталог пока небольшой, его можно расширять без изменения ваших
            сохранённых выпусков.
          </p>
          <div className="flex flex-wrap gap-2">
            {[1, 2, 3, 5].map((value) => (
              <Button
                key={value}
                size="sm"
                variant="ghost"
                onClick={() => setBudget(String(value))}
              >
                ${value}
              </Button>
            ))}
          </div>
          <label className="block">
            Общий бюджет подарка, USD
            <input
              className={inputStyle}
              type="number"
              min="1"
              max="1000"
              step="0.01"
              value={budget}
              aria-invalid={!!budgetError}
              aria-describedby={budgetError ? 'story-budget-error' : undefined}
              onChange={(e) => setBudget(e.target.value)}
            />
            {budgetError && (
              <span
                id="story-budget-error"
                className="mt-1 block text-sm text-amber-500"
              >
                {budgetError}
              </span>
            )}
          </label>
          <p className="text-sm">
            Это выбранный потолок, не цена и не списание. Сначала создаются
            озвучка и её проверка. Для «Репки» после этого доступна отдельная
            сборка видео со сменной преамбулой. Перед озвучкой черновик покажет
            расчётный резерв с запасом по внутреннему прайсу.
          </p>
        </Card>
      )}
      {story && (
        <Card className="space-y-4 p-5">
          <h2 className="text-xl font-semibold">{story.title}</h2>
          <p className="text-sm text-silver-400">
            {story.kind === 'classic'
              ? 'Классика · текст выбранной редакции'
              : story.kind === 'adaptation'
                ? 'Короткая адаптация народного сюжета'
                : 'Авторская сказка'}{' '}
            · ориентир {story.targetSeconds} с · {story.rights}
          </p>
          {story.sourceUrl && (
            <a
              className="underline"
              href={story.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {story.kind === 'adaptation'
                ? 'Источник сюжета (текст адаптации отличается)'
                : 'Источник выбранного текста'}
            </a>
          )}
          {story.sourceEdition && (
            <details>
              <summary>Проверенная редакция и происхождение текста</summary>
              <p>
                {story.sourceEdition.author} · {story.sourceEdition.edition}, с.{' '}
                {story.sourceEdition.pages}
              </p>
              <p>{story.sourceEdition.changes}</p>
              <p className="break-all text-xs">
                SHA-256 текста: {story.sourceEdition.textSha256}
              </p>
            </details>
          )}
          <fieldset className="min-w-0 space-y-2">
            <legend>Повод — необязательно</legend>
            <div className="flex flex-wrap gap-2">
              <Chip
                active={occasionKind === null}
                onClick={() => setOccasionKind(null)}
              >
                Пропустить
              </Chip>
              {OCCASION_KINDS.map((kind) => (
                <Chip
                  key={kind}
                  active={occasionKind === kind}
                  onClick={() => setOccasionKind(kind)}
                >
                  {OCCASION_LABELS[kind]}
                </Chip>
              ))}
            </div>
            {occasionKind === 'other' && (
              <label className="block">
                Своя подпись повода (до 80 символов)
                <input
                  className={inputStyle}
                  maxLength={80}
                  placeholder="Например: первый день в садике"
                  value={occasionLabel}
                  onChange={(e) => setOccasionLabel(e.target.value)}
                />
              </label>
            )}
            <p className="text-sm">
              Повод не меняет текст сказки: он задаёт оформление и подсказки для
              обращения. Даты возвращения и обещания «вылечит»/«перестанешь
              бояться» не принимаются.
            </p>
          </fieldset>
          <fieldset className="min-w-0 space-y-2">
            <legend>Оформление обложки</legend>
            <div className="flex flex-wrap gap-2">
              <Chip active={theme === null} onClick={() => setTheme(null)}>
                По поводу
              </Chip>
              {STORY_THEME_IDS.map((id) => (
                <Chip
                  key={id}
                  active={theme === id}
                  onClick={() => setTheme(id)}
                >
                  {STORY_THEMES[id].label}
                </Chip>
              ))}
            </div>
            <ThemeBadge theme={themeFor(occasionKind, theme)} />
          </fieldset>
          <fieldset className="min-w-0 space-y-3 rounded-lg border border-silver-700 p-3">
            <legend>Физический подарок — необязательно</legend>
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={noteEnabled}
                onChange={(e) => setNoteEnabled(e.target.checked)}
              />
              Упомянуть подарок в озвучке
            </label>
            {noteEnabled && (
              <>
                <label className="block">
                  Точная реплика (до 180 символов)
                  <textarea
                    className={inputStyle}
                    maxLength={180}
                    placeholder="Например: рядом с тобой лежит небольшой подарок. Открой его после сказки."
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </label>
                <label className="block">
                  Где озвучить реплику
                  <select
                    className={inputStyle}
                    value={position}
                    onChange={(e) =>
                      setPosition(e.target.value as GiftNotePosition)
                    }
                  >
                    <option value="beginning">В начале</option>
                    <option value="end">В конце</option>
                  </select>
                </label>
                <p className="text-sm">
                  Не пишите о доставке, курьере и сроках получения: сервис их не
                  знает, а запись будут переслушивать.
                </p>
              </>
            )}
            <label className="block">
              Фото подарка — необязательно
              <input
                className="block w-full max-w-full text-sm"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    setPhotoBusy(true);
                    void photoPng(file)
                      .then(setPhoto)
                      .catch((err) =>
                        setError(
                          storyErrorText(err, {
                            fallback:
                              'Не удалось прочитать фото — выберите другой файл PNG, JPEG или WebP.',
                          })
                        )
                      )
                      .finally(() => setPhotoBusy(false));
                  }
                }}
              />
            </label>
            {photo && (
              <>
                <img
                  className="max-h-48 rounded-lg"
                  src={`data:image/png;base64,${photo}`}
                  alt="Выбранное фото подарка"
                />
                <Button variant="ghost" onClick={() => setPhoto(null)}>
                  Убрать выбранное фото
                </Button>
              </>
            )}
            <label className="block">
              Описание подарка к фото (до 200 символов)
              <input
                className={inputStyle}
                maxLength={200}
                placeholder="Например: мягкий заяц в голубой коробке"
                value={photoDescription}
                onChange={(e) => setPhotoDescription(e.target.value)}
              />
            </label>
            <p className="text-sm">
              Фото и описание показываются отдельной карточкой и не
              озвучиваются. Можно добавить фото без реплики или реплику без
              фото.
            </p>
          </fieldset>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={includeVideo}
              onChange={(e) => setIncludeVideo(e.target.checked)}
            />
            Учесть в смете будущую видеоверсию (преамбула, сборка, проверка)
          </label>
          {budgetError && (
            <p id="story-preview-reason" className="text-sm">
              Предпросмотр недоступен: {budgetError.toLowerCase()}.
            </p>
          )}
          <Button
            variant="ghost"
            disabled={busy || !story || !!budgetError}
            aria-describedby={budgetError ? 'story-preview-reason' : undefined}
            onClick={() =>
              void run(async () => {
                const key = previewKey(wizard);
                const res = await api.post<StoryPreview>(
                  '/story-gifts/preview',
                  buildPreviewPayload(wizard)
                );
                if (res.data) {
                  setPreview(res.data);
                  setPreviewedKey(key);
                }
              })
            }
          >
            {noteEnabled
              ? 'Показать точную реплику и смету'
              : 'Показать текст озвучки и смету'}
          </Button>
          {preview && (
            <div className="space-y-3">
              {!previewFresh && (
                <p role="status" className="text-sm">
                  Ввод изменился — обновите предпросмотр.
                </p>
              )}
              <h3 className="font-semibold">Точный текст озвучки</h3>
              <SpokenText parts={preview.parts} />
              <p className="text-sm">
                Длительность ≈ {Math.round(preview.durationSeconds.estimated)} с
                {preview.giftNote
                  ? ` (реплика ≈ ${Math.round(preview.giftNote.seconds)} с, ${preview.giftNote.position === 'beginning' ? 'в начале' : 'в конце'})`
                  : ''}
                .{' '}
                {!preview.durationSeconds.withinLimits &&
                  `Озвучка вне допустимых ${preview.durationSeconds.min}–${preview.durationSeconds.max} с.`}
              </p>
              {preview.hints.map((h) => (
                <p key={h.code} className="text-sm">
                  {h.message}
                </p>
              ))}
              {preview.occasion.lines.length > 0 && (
                <details>
                  <summary>Подсказки для обращения в преамбуле видео</summary>
                  {preview.occasion.lines.map((line) => (
                    <p key={line} className="my-2">
                      «{line}»
                    </p>
                  ))}
                </details>
              )}
              <EstimateTable estimate={preview.estimate} />
            </div>
          )}
          <p className="text-sm">
            Повод, подарок и фото независимы, всё можно пропустить. Пилот: три
            новых сказки в сутки; до озвучки можно проверить сохранённый
            черновик.
          </p>
          {createGate.reason && <p className="text-sm">{createGate.reason}</p>}
          {alreadyCreated && (
            <p role="status" className="text-sm">
              Черновик с этими данными уже создан и открыт ниже в «Мои сказки».
              Чтобы создать ещё один, измените ввод.
            </p>
          )}
          <Button
            disabled={busy || photoBusy || !createGate.ok || alreadyCreated}
            onClick={() =>
              void run(async () => {
                const key = createKey;
                const result = await api.post<Gift>(
                  '/story-gifts',
                  buildStoryPayload(wizard)
                );
                if (result.data) {
                  setCreatedKey(key);
                  setSelected(result.data);
                  setDraftDescription(result.data.giftPhotoDescription || '');
                  if (photo) {
                    const p = await api.post<Gift>(
                      `/story-gifts/${result.data.id}/photo`,
                      { base64: photo }
                    );
                    if (p.data) setSelected(p.data);
                    setPhotoRev((n) => n + 1);
                  }
                }
              })
            }
          >
            {photoBusy ? 'Подготовка фото…' : 'Создать черновик'}
          </Button>
        </Card>
      )}
      {gifts.length > 0 && (
        <Card className="space-y-3 p-5">
          <h2 className="text-xl font-semibold">Мои сказки</h2>
          {gifts.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`block w-full rounded-lg border p-3 text-left ${selected?.id === g.id ? 'border-accent' : 'border-silver-700'}`}
              onClick={() => selectGift(g)}
            >
              <ThemeBadge
                theme={themeFor(
                  g.occasionKind as OccasionKind | null,
                  g.occasionTheme
                )}
              />{' '}
              {g.title}
              {occasionCaption(g) ? ` · ${occasionCaption(g)}` : ''} —{' '}
              {stateNames[g.status] || g.status}
            </button>
          ))}
        </Card>
      )}
      {selected && (
        <Card
          className="space-y-4 p-5"
          style={{
            borderTop: `6px solid ${STORY_THEMES[themeFor(selected.occasionKind as OccasionKind | null, selected.occasionTheme)].accent}`,
          }}
        >
          <h2 className="text-xl font-semibold">
            {selected.title} · {stateNames[selected.status]}
          </h2>
          <p>
            <ThemeBadge
              theme={themeFor(
                selected.occasionKind as OccasionKind | null,
                selected.occasionTheme
              )}
            />{' '}
            {occasionCaption(selected)}
          </p>
          <p>
            Бюджет: ${(selected.budgetCents / 100).toFixed(2)} · расчётный
            резерв аудиопилота с запасом: $
            {(selected.reservedMicroUsd / 1e6).toFixed(2)}. Это оценка, не счёт
            провайдера.
          </p>
          {selected.estimate && (
            <details>
              <summary>Смета по строкам</summary>
              <EstimateTable estimate={selected.estimate} />
            </details>
          )}
          {selected.giftNote && selected.status !== 'DRAFT' && (
            <p>
              Реплика о подарке{' '}
              {selected.giftNotePosition === 'beginning'
                ? 'в начале'
                : 'в конце'}
              : «{selected.giftNote}»
            </p>
          )}
          {savedPhoto && (
            <img
              className="max-h-64 rounded-lg"
              src={savedPhoto}
              alt="Сохранённое фото физического подарка"
            />
          )}
          {selected.giftPhotoDescription && (
            <p>Подарок: {selected.giftPhotoDescription}</p>
          )}
          {selected.status === 'DRAFT' && (
            <>
              <details open={Boolean(selected.giftNote)}>
                <summary>
                  {selected.giftNote
                    ? 'Точная озвучка с репликой о подарке'
                    : 'Точный текст озвучки'}
                </summary>
                <SpokenText parts={draftParts(selected)} />
              </details>
              <p>
                Голос: Nova · Resemble. Текст и изображение будут зафиксированы
                при запуске.
              </p>
              <Button
                disabled={busy}
                onClick={() =>
                  confirm.ask(
                    novaConfirm(selected),
                    () => void run(() => update('render'))
                  )
                }
              >
                Озвучить Nova{reserveSuffix(selected.reservedMicroUsd)}
              </Button>
              {photo && (
                <Button
                  disabled={busy}
                  variant="ghost"
                  onClick={() =>
                    void run(async () => {
                      await update('photo', { base64: photo });
                      setPhotoRev((n) => n + 1);
                    })
                  }
                >
                  Сохранить выбранное фото в черновик
                </Button>
              )}
              <label className="block">
                Описание подарка к фото
                <input
                  className={inputStyle}
                  maxLength={200}
                  value={draftDescription}
                  onChange={(e) => setDraftDescription(e.target.value)}
                />
              </label>
              <Button
                disabled={
                  busy ||
                  draftDescription.trim() ===
                    (selected.giftPhotoDescription || '')
                }
                variant="ghost"
                onClick={() =>
                  void run(() =>
                    update('photo', { description: draftDescription.trim() })
                  )
                }
              >
                Сохранить описание
              </Button>
              {selected.hasGiftPhoto && (
                <Button
                  disabled={busy}
                  variant="ghost"
                  onClick={() =>
                    void run(async () => {
                      const r = await api.deleteWithBody<Gift>(
                        `/story-gifts/${selected.id}/photo`
                      );
                      if (r.data) setSelected(r.data);
                      setDraftDescription('');
                    })
                  }
                >
                  Убрать фото и описание из черновика
                </Button>
              )}
            </>
          )}
          {selected.status === 'SYNTHESIZING' && (
            <p role="status">
              Синтез ещё не завершён. Повторная отправка не создаёт новую
              озвучку.
            </p>
          )}
          {selected.error && <p role="alert">{selected.error}</p>}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await api.get<Gift>(`/story-gifts/${selected.id}`);
                if (r.data) setSelected(r.data);
              })
            }
          >
            Обновить статус
          </Button>
          {audio && (
            <>
              <p>
                Длительность: {Math.round(selected.durationSeconds || 0)} с ·
                Nova · синтетическая озвучка
              </p>
              <audio
                onPlay={exclusiveStoryPlayback}
                className="w-full"
                controls
                preload="metadata"
                src={audio}
              />
              <a
                className="text-accent underline"
                href={audio}
                download="story-tales.mp3"
              >
                Скачать MP3
              </a>
            </>
          )}
          {['READY', 'APPROVED'].includes(selected.status) &&
            selected.chapters.map((c) => (
              <section className="space-y-3" key={c.title}>
                <Illustration scene={c.scene} />
                <h3 className="text-lg font-semibold">{c.title}</h3>
                <p>{c.text}</p>
              </section>
            ))}
          {['READY', 'APPROVED'].includes(selected.status) && (
            <div className="space-y-2">
              <p>
                Сверка речи с текстом:{' '}
                {
                  (
                    {
                      PENDING: 'ещё не запускалась',
                      RUNNING: 'выполняется',
                      PASS: 'пройдена',
                      WARN: 'есть расхождения',
                      UNKNOWN: 'результат не подтверждён',
                    } as Record<string, string>
                  )[selected.audioQaStatus]
                }
              </p>
              {selected.audioQa && (
                <p>
                  Расхождение слов: {(selected.audioQa.wer * 100).toFixed(1)}%.
                  Это проверка полноты текста; естественность и произношение
                  оцениваются при прослушивании.
                </p>
              )}
              <Button
                variant="ghost"
                disabled={busy || selected.audioQaStatus !== 'PENDING'}
                onClick={() =>
                  confirm.ask(
                    audioQaConfirm(selected),
                    () => void run(() => update('quality'))
                  )
                }
              >
                Проверить озвучку через Soniox
                {includedInReserve(selected.reservedMicroUsd)}
              </Button>
            </div>
          )}
          {selected.status === 'READY' && (
            <>
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                Подтверждаю этот выпуск: текст, фото и озвучка проверены
              </label>
              <Button
                disabled={busy || !reviewed || !audio}
                onClick={() =>
                  void run(() =>
                    update('approve', {
                      audioHash: selected.audioHash,
                      reviewed: true,
                    })
                  )
                }
              >
                Одобрить этот выпуск
              </Button>
            </>
          )}
          <p className="text-sm">
            Закрытая разработка: публикация и доступ по ссылке отключены.
            Выпуски доступны только в вашем кабинете.
          </p>
          {['READY', 'APPROVED'].includes(selected.status) && (
            <StoryVideoPanel
              key={selected.id}
              giftId={selected.id}
              classicText={
                (catalog.find((s) => s.id === selected.catalogId)?.kind ??
                  'classic') === 'classic'
              }
            />
          )}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              // ST2-U-01: необратимо — сначала диалог с перечнем того, что
              // сотрётся; DELETE уходит только после подтверждения.
              const target = selected;
              confirm.ask(
                deleteGiftConfirm(target),
                () =>
                  void run(async () => {
                    await api.delete(`/story-gifts/${target.id}`);
                    setSelected((cur) => (cur?.id === target.id ? null : cur));
                  })
              );
            }}
          >
            Удалить сказку и её медиа
          </Button>
        </Card>
      )}
      {confirm.dialog}
    </div>
  );
}
