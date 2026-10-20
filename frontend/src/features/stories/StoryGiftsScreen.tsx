import { exclusiveStoryPlayback } from './story-media-playback';
import { StoryVideoPanel } from './StoryVideoPanel';
import { StoryReferencesPanel } from './StoryReferencesPanel';
import { StoryEditionsPanel } from './StoryEditionsPanel'; // WP2
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BookOpen, Cake, Heart, Moon, Sun } from 'lucide-react';
import {
  OCCASION_KINDS,
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
  themeLabel,
  type GiftNotePosition,
  type OccasionKind,
  type StoryEstimate,
  type StoryPreview,
  type StoryThemeIcon,
  type StoryThemeId,
  type WizardState,
} from './story-wizard';
import { Alert, Button, Card } from '../../components/ui';
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
  novaConfirmMember,
  qaConfirmMember,
  reserveSuffix,
} from './story-confirm';
import { useStoryConfirm } from './StoryConfirm';
import { fitStoryPhoto } from './story-photo-fit';
import { useI18n } from '../../lib/i18n-context';
import { useStoryAccess } from './story-access-context';
import {
  storyCanShare,
  storyChargeOf,
  storyChargeParagraphs,
  storyCode,
  storyCreditsRequired,
  storyPromiseText,
  storyRetentionWarning,
  storySharingEnabled,
  storySharedUntil,
  storyNarratorConsentPending,
  type StoryCharge,
  fill,
  storyAccessCode,
  storyIsOwner,
  storyPriceChanged,
  storyServerText,
  type StoryUiStrings,
} from './story-pilot';
import {
  StoryChargeLine,
  StoryCreditsNotice,
  StoryRetentionBadge,
  StoryRetentionNotice,
  StorySharePanel,
} from './StoryPilotParts';

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
  /** ST3: цена аудио-сборки в кредитах (смета карточки). */
  charge?: StoryCharge | null;
};
/** Подпись статуса сказки на языке интерфейса. */
const stateName = (u: StoryUiStrings, status: string) =>
  (u.status as Record<string, string>)[status] ?? status;
const inputStyle =
  'w-full rounded-lg border border-silver-700 bg-transparent p-3';
function errorText(e: unknown, u: StoryUiStrings, locale: string): string {
  return storyErrorText(e, {
    fallback: u.errors.actionFallback,
    noResponse: u.errors.actionNoResponse,
    locale,
    ui: u,
  });
}
async function photoPng(file: File, u: StoryUiStrings): Promise<string> {
  if (
    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
    file.size > 10 * 1024 * 1024
  )
    throw new StoryClientError(u.errors.photoType);
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
          ? u.errors.photoTooLarge
          : u.errors.photoCompress
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
  const { dict } = useI18n();
  const t = STORY_THEMES[theme];
  const Icon = THEME_ICONS[t.icon];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-sm"
      style={{ background: t.soft, color: t.ink }}
    >
      <Icon size={16} aria-hidden="true" />{' '}
      {themeLabel(theme, dict.storyUi.wiz)}
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
  const { dict } = useI18n();
  return (
    <div className="space-y-3 rounded-lg border border-silver-700 p-3">
      {parts.map((p, i) =>
        p.kind === 'giftNote' ? (
          <p key={i}>
            <mark className="rounded px-1">{p.text}</mark>{' '}
            <span className="text-xs text-silver-400">
              · {dict.storyUi.wizard.giftNoteMark}
            </span>
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
  const { dict } = useI18n();
  const w = dict.storyUi.wizard;
  const warning = budgetWarning(estimate, dict.storyUi.wiz);
  return (
    <div className="space-y-2">
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            <th className="py-1">{w.colItem}</th>
            <th className="py-1">{w.colCost}</th>
            <th className="py-1">{w.colReserve}</th>
          </tr>
        </thead>
        <tbody>
          {estimateRows(estimate, dict.storyUi.wiz).map((row) => (
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
        {fill(w.estimateTotal, {
          reserve: formatUsd(estimate.totalReserveMicroUsd),
          budget: formatUsd(estimate.budgetMicroUsd),
        })}{' '}
        {estimate.policy}
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
  const { dict } = useI18n();
  const w = dict.storyUi.wizard;
  if (scene === 'turnip')
    return (
      <svg
        viewBox="0 0 640 360"
        className="w-full rounded-xl"
        role="img"
        aria-label={w.altTurnip}
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
        aria-label={w.altMitten}
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
        aria-label={w.altPigs}
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
      aria-label={w.altFox}
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
  const { dict, locale } = useI18n();
  const t = dict.storyTales;
  const u = dict.storyUi;
  const w = u.wizard;
  const c = u.card;
  const storyAccess = useStoryAccess();
  const mode = storyAccess.access?.mode ?? 'owner';
  /** ST3-U-03/U-07: суммы провайдеров и внутренние инструменты — владельцу. */
  const owner = storyIsOwner(storyAccess.access);
  /** ST3-U-01: отозванный участник — только просмотр, скачивание, удаление. */
  const readOnly = storyAccess.access?.readOnly === true;
  const errText = (e: unknown) => errorText(e, u, locale);
  /** Для эффектов загрузки медиа: текущий язык без лишних зависимостей. */
  const errTextRef = useRef(errText);
  errTextRef.current = errText;
  /** 402 `STORY_CREDITS_REQUIRED` последнего запуска (бриф ST3, п. 2). */
  const [credits, setCredits] = useState<{
    required: number | null;
    balance: number | null;
  } | null>(null);
  /** Текст ошибки: валидатор обещаний — на языке интерфейса по коду. */
  const failText = (e: unknown) =>
    storyPromiseText(storyCode(e), errText(e), t);
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
    [storyLanguage, setStoryLanguage] = useState(
      locale === 'uk' || locale === 'en' ? locale : 'ru'
    );
  const [storyId, setStoryId] = useState('turnip-ushinsky-ru-1949-v1'),
    // Не-владелец бюджет провайдера не выбирает (ST3-U-03): цена — в
    // кредитах по смете, потолок резерва — максимальный пресет.
    [budget, setBudget] = useState(owner ? '1' : '5');
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
  const createGate = canCreate(wizard, previewedKey, u.wiz);
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
  /** Сбой загрузки; текст — на языке интерфейса при отрисовке. */
  const [loadError, setLoadError] = useState<unknown>(null);
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
    setLoadError(null);
    void Promise.all([
      // Только чтение: каталог и мастер не нужны (ST3-U-01).
      readOnly
        ? Promise.resolve({ data: [] as Story[] })
        : api.get<Story[]>('/story-gifts/catalog'),
      api.get<Gift[]>('/story-gifts'),
    ])
      .then(([c, g]) => {
        if (!alive) return;
        setAccess(true);
        const list = c.data || [];
        setCatalog(list);
        // Язык интерфейса — лишь начальный выбор: нет сказок на нём — первый
        // язык каталога (иначе выбор сказки пропал бы целиком).
        setStoryLanguage((l) =>
          list.length === 0 || list.some((x) => x.locale === l)
            ? l
            : list[0].locale
        );
        setGifts(g.data || []);
      })
      .catch((e) => {
        if (!alive) return;
        if (storyLoadFailure(e) === 'closed') {
          setAccess(false);
          return;
        }
        setAccess('error');
        setLoadError(e);
      });
    return () => {
      alive = false;
    };
    // Смена языка интерфейса перечитывает каталог: права (`rights`) сервер
    // отдаёт на языке запроса.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadNonce, locale]);
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
        if (!disposed) setError(errTextRef.current(e));
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
        if (!disposed) setError(errTextRef.current(e));
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
    setCredits(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      const need = storyCreditsRequired(e);
      if (need) setCredits(need);
      else {
        // Правила обновились или доступ отозван, пока экран был открыт:
        // перечитать доступ — App покажет экран правил или режим чтения.
        if (storyAccessCode(e)) storyAccess.refresh();
        setError(failText(e));
      }
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
  /**
   * Озвучка: подтверждение с ценой (владельцу — резерв провайдера, остальным —
   * только кредиты, ST3-U-03). Сервер сверяет показанную цену
   * (`expectedCredits`, ST3-U-04); при 409 `STORY_PRICE_CHANGED` карточка
   * перечитывается и подтверждение открывается заново с новой ценой.
   */
  function launchNova(gift: Gift) {
    const charge = storyChargeOf(gift);
    const paragraphs = storyChargeParagraphs(charge, t, locale);
    const ownerText = novaConfirm(gift, u.confirm);
    const text = owner
      ? { ...ownerText, body: [...ownerText.body, ...paragraphs] }
      : novaConfirmMember(
          paragraphs,
          !!charge?.free,
          t.charge.confirmTitleFree,
          u.confirm
        );
    confirm.ask(
      text,
      () =>
        void run(async () => {
          try {
            await update('render', { expectedCredits: charge?.credits ?? 0 });
          } catch (e) {
            const changed = storyPriceChanged(e);
            if (!changed) throw e;
            const fresh =
              (await api.get<Gift>(`/story-gifts/${gift.id}`)).data ?? gift;
            const next = changed.charge
              ? { ...fresh, charge: changed.charge }
              : fresh;
            setSelected(next);
            setError(u.codes.STORY_PRICE_CHANGED);
            setTimeout(() => launchNova(next), 0);
          }
        })
    );
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
      .catch((e) => setError(errText(e)));
  }
  if (access === 'error')
    return (
      <Card className="space-y-3 p-5">
        <p role="alert">
          {storyErrorText(loadError, {
            fallback: t.access.loadError,
            noResponse: t.access.noResponse,
            locale,
            ui: u,
          })}
        </p>
        <Button onClick={() => setLoadNonce((n) => n + 1)}>
          {t.access.retry}
        </Button>
      </Card>
    );
  if (access !== true)
    return (
      <Card className="p-5">
        {access === null ? t.access.checking : dict.notFound.title}
      </Card>
    );
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {readOnly ? (
        <Card className="space-y-2 p-5">
          <BookOpen className="text-accent" />
          <div role="status">
            <Alert tone="warning" title={c.readOnlyTitle}>
              {c.readOnlyBody}
            </Alert>
          </div>
          {gifts.length === 0 && <p>{c.readOnlyEmpty}</p>}
        </Card>
      ) : (
        <Card className="space-y-3 p-5">
          <BookOpen className="text-accent" />
          <h1 className="text-2xl font-semibold">{w.title}</h1>
          <p>{w.intro}</p>
          <Button variant="ghost" onClick={() => navigate(routes.manifests())}>
            {w.narratorProfile}
          </Button>
        </Card>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-red-400 p-3">
          {error}
        </p>
      )}
      <StoryCreditsNotice info={credits} />
      {/* ST3-U-07: разбор референсов и реестр редакций — инструменты владельца. */}
      {owner && !readOnly && <StoryReferencesPanel />}
      {owner && !readOnly && <StoryEditionsPanel />}
      {!readOnly && catalog.length > 0 && (
        <Card className="space-y-4 p-5">
          <h2 className="text-xl font-semibold">
            {owner ? w.catalogTitle : w.catalogTitleMember}
          </h2>
          <label className="block">
            {w.country}
            <select
              className={inputStyle}
              value={country}
              onChange={(e) => chooseRegion(e.target.value, storyLanguage)}
            >
              <option value="UA">{w.countryUA}</option>
              <option value="GB">{w.countryGB}</option>
              <option value="US">{w.countryUS}</option>
              <option value="DE">{w.countryDE}</option>
              <option value="ES">{w.countryES}</option>
              <option value="OTHER">{w.countryOTHER}</option>
            </select>
          </label>
          <label className="block">
            {w.language}
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
            {w.tale}
            <select
              className={inputStyle}
              value={story?.id || ''}
              onChange={(e) => setStoryId(e.target.value)}
            >
              {variants.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} · {fill(w.seconds, { n: s.targetSeconds })} ·{' '}
                  {s.kind === 'original'
                    ? w.optionOriginal
                    : s.kind === 'classic'
                      ? w.optionClassic
                      : w.optionAdaptation}
                </option>
              ))}
            </select>
          </label>
          <p>{w.catalogNote}</p>
          {owner && (
            <>
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
                {w.budgetLabel}
                <input
                  className={inputStyle}
                  type="number"
                  min="1"
                  max="1000"
                  step="0.01"
                  value={budget}
                  aria-invalid={!!budgetError}
                  aria-describedby={
                    budgetError ? 'story-budget-error' : undefined
                  }
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
              <p className="text-sm">{w.budgetNote}</p>
            </>
          )}
        </Card>
      )}
      {!readOnly && story && (
        <Card className="space-y-4 p-5">
          <h2 className="text-xl font-semibold">{story.title}</h2>
          <p className="text-sm text-silver-400">
            {[
              story.kind === 'classic'
                ? w.kindClassic
                : story.kind === 'adaptation'
                  ? w.kindAdaptation
                  : w.kindOriginal,
              fill(w.target, { n: story.targetSeconds }),
              storyServerText(story.rights, locale, ''),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {story.sourceUrl && (
            <a
              className="underline"
              href={story.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {story.kind === 'adaptation' ? w.sourcePlot : w.sourceText}
            </a>
          )}
          {story.sourceEdition && (
            <details>
              <summary>{w.editionSummary}</summary>
              <p>
                {story.sourceEdition.author} · {story.sourceEdition.edition},{' '}
                {fill(w.pages, { pages: story.sourceEdition.pages })}
              </p>
              {storyServerText(story.sourceEdition.changes, locale, '') && (
                <p>{story.sourceEdition.changes}</p>
              )}
              <p className="break-all text-xs">
                {fill(w.textHash, { hash: story.sourceEdition.textSha256 })}
              </p>
            </details>
          )}
          <fieldset className="min-w-0 space-y-2">
            <legend>{w.occasionLegend}</legend>
            <div className="flex flex-wrap gap-2">
              <Chip
                active={occasionKind === null}
                onClick={() => setOccasionKind(null)}
              >
                {w.skip}
              </Chip>
              {OCCASION_KINDS.map((kind) => (
                <Chip
                  key={kind}
                  active={occasionKind === kind}
                  onClick={() => setOccasionKind(kind)}
                >
                  {u.wiz[kind]}
                </Chip>
              ))}
            </div>
            {occasionKind === 'other' && (
              <label className="block">
                {w.occasionOwn}
                <input
                  className={inputStyle}
                  maxLength={80}
                  placeholder={w.occasionPlaceholder}
                  value={occasionLabel}
                  onChange={(e) => setOccasionLabel(e.target.value)}
                />
              </label>
            )}
            <p className="text-sm">{w.occasionNote}</p>
          </fieldset>
          <fieldset className="min-w-0 space-y-2">
            <legend>{w.themeLegend}</legend>
            <div className="flex flex-wrap gap-2">
              <Chip active={theme === null} onClick={() => setTheme(null)}>
                {w.themeByOccasion}
              </Chip>
              {STORY_THEME_IDS.map((id) => (
                <Chip
                  key={id}
                  active={theme === id}
                  onClick={() => setTheme(id)}
                >
                  {themeLabel(id, u.wiz)}
                </Chip>
              ))}
            </div>
            <ThemeBadge theme={themeFor(occasionKind, theme)} />
          </fieldset>
          <fieldset className="min-w-0 space-y-3 rounded-lg border border-silver-700 p-3">
            <legend>{w.giftLegend}</legend>
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={noteEnabled}
                onChange={(e) => setNoteEnabled(e.target.checked)}
              />
              {w.mentionGift}
            </label>
            {noteEnabled && (
              <>
                <label className="block">
                  {w.noteLabel}
                  <textarea
                    className={inputStyle}
                    maxLength={180}
                    placeholder={w.notePlaceholder}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </label>
                <label className="block">
                  {w.notePosition}
                  <select
                    className={inputStyle}
                    value={position}
                    onChange={(e) =>
                      setPosition(e.target.value as GiftNotePosition)
                    }
                  >
                    <option value="beginning">{w.beginning}</option>
                    <option value="end">{w.end}</option>
                  </select>
                </label>
                <p className="text-sm">{w.noteWarn}</p>
              </>
            )}
            <label className="block">
              {w.photoLabel}
              <input
                className="block w-full max-w-full text-sm"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    setPhotoBusy(true);
                    void photoPng(file, u)
                      .then(setPhoto)
                      .catch((err) =>
                        setError(
                          storyErrorText(err, {
                            fallback: u.errors.photoRead,
                            locale,
                            ui: u,
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
                  alt={w.photoAlt}
                />
                <Button variant="ghost" onClick={() => setPhoto(null)}>
                  {w.photoRemove}
                </Button>
              </>
            )}
            <label className="block">
              {w.photoDescLabel}
              <input
                className={inputStyle}
                maxLength={200}
                placeholder={w.photoDescPlaceholder}
                value={photoDescription}
                onChange={(e) => setPhotoDescription(e.target.value)}
              />
            </label>
            <p className="text-sm">{w.photoNote}</p>
          </fieldset>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={includeVideo}
              onChange={(e) => setIncludeVideo(e.target.checked)}
            />
            {w.includeVideo}
          </label>
          {budgetError && (
            <p id="story-preview-reason" className="text-sm">
              {fill(w.previewBlocked, { reason: budgetError })}
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
              ? owner
                ? w.previewNote
                : w.previewNoteMember
              : owner
                ? w.previewText
                : w.previewTextMember}
          </Button>
          {preview && (
            <div className="space-y-3">
              {!previewFresh && (
                <p role="status" className="text-sm">
                  {w.previewStale}
                </p>
              )}
              <h3 className="font-semibold">{w.exactText}</h3>
              <SpokenText parts={preview.parts} />
              <p className="text-sm">
                {fill(w.duration, {
                  n: Math.round(preview.durationSeconds.estimated),
                })}
                {preview.giftNote
                  ? ` (${fill(w.noteDuration, {
                      n: Math.round(preview.giftNote.seconds),
                      position:
                        preview.giftNote.position === 'beginning'
                          ? w.atBeginning
                          : w.atEnd,
                    })})`
                  : ''}
                .{' '}
                {!preview.durationSeconds.withinLimits &&
                  fill(w.outOfLimits, {
                    min: preview.durationSeconds.min,
                    max: preview.durationSeconds.max,
                  })}
              </p>
              {preview.hints.map((h) => (
                <p key={h.code} className="text-sm">
                  {storyPromiseText(h.code, h.message, t)}
                </p>
              ))}
              {preview.occasion.lines.length > 0 && (
                <details>
                  <summary>{w.occasionLines}</summary>
                  {preview.occasion.lines.map((line) => (
                    <p key={line} className="my-2">
                      «{line}»
                    </p>
                  ))}
                </details>
              )}
              {owner && <EstimateTable estimate={preview.estimate} />}
              <StoryChargeLine charge={storyChargeOf(preview)} />
            </div>
          )}
          <p className="text-sm">{w.pilotNote}</p>
          {createGate.reason && <p className="text-sm">{createGate.reason}</p>}
          {alreadyCreated && (
            <p role="status" className="text-sm">
              {w.alreadyCreated}
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
            {photoBusy ? w.photoPreparing : w.createDraft}
          </Button>
        </Card>
      )}
      {gifts.length > 0 && (
        <Card className="space-y-3 p-5">
          <h2 className="text-xl font-semibold">{c.myTales}</h2>
          {gifts.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`block w-full break-words rounded-lg border p-3 text-left ${selected?.id === g.id ? 'border-accent' : 'border-silver-700'}`}
              onClick={() => selectGift(g)}
            >
              <ThemeBadge
                theme={themeFor(
                  g.occasionKind as OccasionKind | null,
                  g.occasionTheme
                )}
              />{' '}
              {g.title}
              {occasionCaption(g, u.wiz)
                ? ` · ${occasionCaption(g, u.wiz)}`
                : ''}{' '}
              — {stateName(u, g.status)}
              <StoryRetentionBadge
                text={storyRetentionWarning(g, t, locale)?.badge ?? null}
              />
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
            {selected.title} · {stateName(u, selected.status)}
          </h2>
          <p>
            <ThemeBadge
              theme={themeFor(
                selected.occasionKind as OccasionKind | null,
                selected.occasionTheme
              )}
            />{' '}
            {occasionCaption(selected, u.wiz)}
          </p>
          <StoryRetentionNotice
            warning={storyRetentionWarning(selected, t, locale)}
            audio={audio}
          />
          {owner && (
            <p>
              {fill(c.budgetLine, {
                budget: `$${(selected.budgetCents / 100).toFixed(2)}`,
                reserve: `$${(selected.reservedMicroUsd / 1e6).toFixed(2)}`,
              })}
            </p>
          )}
          {owner && selected.estimate && (
            <details>
              <summary>{c.estimateSummary}</summary>
              <EstimateTable estimate={selected.estimate} />
            </details>
          )}
          {selected.giftNote && selected.status !== 'DRAFT' && (
            <p>
              {fill(c.giftNoteAt, {
                position:
                  selected.giftNotePosition === 'beginning'
                    ? w.atBeginning
                    : w.atEnd,
                text: selected.giftNote,
              })}
            </p>
          )}
          {savedPhoto && (
            <img
              className="max-h-64 rounded-lg"
              src={savedPhoto}
              alt={c.savedPhotoAlt}
            />
          )}
          {selected.giftPhotoDescription && (
            <p>{fill(c.giftDesc, { text: selected.giftPhotoDescription })}</p>
          )}
          {!readOnly && selected.status === 'DRAFT' && (
            <>
              <details open={Boolean(selected.giftNote)}>
                <summary>
                  {selected.giftNote ? c.exactWithNote : w.exactText}
                </summary>
                <SpokenText parts={draftParts(selected)} />
              </details>
              <p>{c.voiceFixed}</p>
              <StoryChargeLine charge={storyChargeOf(selected)} />
              <Button disabled={busy} onClick={() => launchNova(selected)}>
                {owner
                  ? `${c.voiceNova}${reserveSuffix(selected.reservedMicroUsd, u.confirm)}`
                  : c.voiceMember}
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
                  {c.savePhoto}
                </Button>
              )}
              <label className="block">
                {c.photoDesc}
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
                {c.saveDesc}
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
                  {c.removePhoto}
                </Button>
              )}
            </>
          )}
          {selected.status === 'SYNTHESIZING' && (
            <p role="status">{c.synthesizing}</p>
          )}
          {selected.error && (
            <p role="alert">
              {storyServerText(selected.error, locale, u.errors.buildFailed)}
            </p>
          )}
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
            {c.refresh}
          </Button>
          {audio && (
            <>
              <p>
                {fill(c.durationNova, {
                  n: Math.round(selected.durationSeconds || 0),
                })}
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
                {c.downloadMp3}
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
                {fill(c.qaLine, {
                  status:
                    (u.audioQa as Record<string, string>)[
                      selected.audioQaStatus
                    ] ?? '',
                })}
              </p>
              {selected.audioQa && (
                <p>
                  {fill(c.wer, {
                    n: (selected.audioQa.wer * 100).toFixed(1),
                  })}
                </p>
              )}
              {!readOnly && (
                <Button
                  variant="ghost"
                  disabled={busy || selected.audioQaStatus !== 'PENDING'}
                  onClick={() =>
                    confirm.ask(
                      owner
                        ? audioQaConfirm(selected, u.confirm)
                        : qaConfirmMember('audio', u.confirm),
                      () => void run(() => update('quality'))
                    )
                  }
                >
                  {owner
                    ? `${c.qaButton}${includedInReserve(selected.reservedMicroUsd, u.confirm)}`
                    : c.qaButtonMember}
                </Button>
              )}
            </div>
          )}
          {!readOnly && selected.status === 'READY' && (
            <>
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                {c.reviewed}
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
                {c.approve}
              </Button>
            </>
          )}
          {storyCanShare(mode, selected.status) ? (
            <StorySharePanel
              key={`share-${selected.id}`}
              giftId={selected.id}
              gift={selected}
              readOnly={readOnly}
              onChanged={() => {
                const id = selected.id;
                void Promise.all([
                  api.get<Gift>(`/story-gifts/${id}`),
                  refresh(),
                ])
                  .then(([r]) => {
                    const full = r.data;
                    if (full)
                      setSelected((cur) => (cur && cur.id === id ? full : cur));
                  })
                  .catch(() => {});
              }}
            />
          ) : readOnly ? null : (
            <p className="text-sm">
              {storySharingEnabled(mode)
                ? t.share.afterApprove
                : t.share.ownerClosed}
            </p>
          )}
          {['READY', 'APPROVED'].includes(selected.status) && (
            <StoryVideoPanel
              key={selected.id}
              giftId={selected.id}
              owner={owner}
              readOnly={readOnly}
              publicNote={
                !storySharingEnabled(mode)
                  ? u.video.ownerOnly
                  : storySharedUntil(selected)
                    ? storyNarratorConsentPending(selected)
                      ? u.video.publicConsent
                      : u.video.publicLinked
                    : u.video.publicNotShared
              }
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
                deleteGiftConfirm(target, u.confirm),
                () =>
                  void run(async () => {
                    await api.delete(`/story-gifts/${target.id}`);
                    setSelected((cur) => (cur?.id === target.id ? null : cur));
                  })
              );
            }}
          >
            {c.delete}
          </Button>
        </Card>
      )}
      {confirm.dialog}
    </div>
  );
}
