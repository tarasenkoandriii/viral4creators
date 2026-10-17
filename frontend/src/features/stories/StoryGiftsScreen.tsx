import { exclusiveStoryPlayback } from './story-media-playback';
import { StoryVideoPanel } from './StoryVideoPanel';
import { StoryReferencesPanel } from './StoryReferencesPanel';
import { useEffect, useRef, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { Button, Card } from '../../components/ui';
import { api } from '../../services/api';
import { navigate, routes } from '../../lib/router';

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
  title: string;
  occasion: string | null;
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
  const err = e as {
    response?: { data?: { error?: { message?: string }; message?: string } };
  };
  return (
    err.response?.data?.error?.message ||
    err.response?.data?.message ||
    'Не удалось выполнить действие. Обновите список — повторная озвучка автоматически не запускается.'
  );
}
async function photoPng(file: File): Promise<string> {
  if (
    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
    file.size > 10 * 1024 * 1024
  )
    throw new Error('Фото PNG, JPEG или WebP до 10 МБ');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas
      .getContext('2d')!
      .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const value = canvas.toDataURL('image/png').split(',')[1];
    if (value.length > 1398104)
      throw new Error(
        'Слишком большое фото после обработки: выберите изображение поменьше'
      );
    return value;
  } finally {
    bitmap.close();
  }
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
  const [occasion, setOccasion] = useState(''),
    [note, setNote] = useState(''),
    [position, setPosition] = useState('end');
  const [photoBusy, setPhotoBusy] = useState(false);
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
  const [access, setAccess] = useState<boolean | null>(null);
  const actionLock = useRef(false);
  async function refresh() {
    const res = await api.get<Gift[]>('/story-gifts');
    setGifts(res.data || []);
  }
  useEffect(() => {
    void Promise.all([
      api.get<Story[]>('/story-gifts/catalog'),
      api.get<Gift[]>('/story-gifts'),
    ])
      .then(([c, g]) => {
        setAccess(true);
        setCatalog(c.data || []);
        setGifts(g.data || []);
      })
      .catch((e) => {
        setAccess(false);
        setError(errorText(e));
      });
  }, []);
  useEffect(() => {
    setAudio(null);
    setSavedPhoto(null);
    setReviewed(false);
    if (!selected) return;
    let disposed = false;
    let url: string | null = null;
    if (['READY', 'APPROVED'].includes(selected.status))
      void api
        .get<{ base64: string; mime: string }>(
          `/story-gifts/${selected.id}/audio`
        )
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
    if (selected.hasGiftPhoto)
      void api
        .get<{ base64: string }>(`/story-gifts/${selected.id}/photo`)
        .then((r) => {
          if (!disposed && r.data)
            setSavedPhoto(`data:image/png;base64,${r.data.base64}`);
        })
        .catch((e) => {
          if (!disposed) setError(errorText(e));
        });
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [selected]); // immutable edition; no repeat synthesis on reload
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
    if (res.data) setSelected(res.data);
  }
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
              onChange={(e) => setBudget(e.target.value)}
            />
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
          <label className="block">
            Повод подарка — необязательно
            <input
              className={inputStyle}
              maxLength={80}
              placeholder="Например: день рождения или просто перед сном"
              value={occasion}
              onChange={(e) => setOccasion(e.target.value)}
            />
          </label>
          <label className="block">
            Упоминание физического подарка — необязательно
            <textarea
              className={inputStyle}
              maxLength={180}
              placeholder="Например: рядом с тобой лежит небольшой подарок. Открой его после сказки."
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <label className="block">
            Где озвучить эту фразу
            <select
              className={inputStyle}
              value={position}
              onChange={(e) => setPosition(e.target.value)}
            >
              <option value="beginning">В начале</option>
              <option value="end">В конце</option>
            </select>
          </label>
          <label className="block">
            Фото физического подарка — необязательно
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  setPhotoBusy(true);
                  void photoPng(file)
                    .then(setPhoto)
                    .catch((err) => setError(err.message))
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
          <details>
            <summary>Прочитать точный текст до создания</summary>
            {position === 'beginning' && note && <p className="my-3">{note}</p>}
            {story.chapters.map((c) => (
              <p className="my-3" key={c.title}>
                {c.text}
              </p>
            ))}
            {position === 'end' && note && <p className="my-3">{note}</p>}
          </details>
          <p className="text-sm">
            Повод показывается подписью. Фраза о подарке войдёт в озвучку. Фото
            появляется отдельной карточкой. Все три поля можно пропустить.
            Пилот: три новых сказки в сутки; до озвучки можно проверить
            сохранённый черновик.
          </p>
          <Button
            disabled={
              busy ||
              photoBusy ||
              !Number.isFinite(Number(budget)) ||
              Number(budget) < 1 ||
              Number(budget) > 1000
            }
            onClick={() =>
              void run(async () => {
                const result = await api.post<Gift>('/story-gifts', {
                  catalogId: story.id,
                  budgetUsd: Number(budget),
                  countryCode: country,
                  occasion: occasion || undefined,
                  giftNote: note || undefined,
                  giftNotePosition: position,
                });
                if (result.data) {
                  setSelected(result.data);
                  if (photo) {
                    const p = await api.post<Gift>(
                      `/story-gifts/${result.data.id}/photo`,
                      { base64: photo }
                    );
                    if (p.data) setSelected(p.data);
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
              onClick={() => setSelected(g)}
            >
              {g.title}
              {g.occasion ? ` · ${g.occasion}` : ''} —{' '}
              {stateNames[g.status] || g.status}
            </button>
          ))}
        </Card>
      )}
      {selected && (
        <Card className="space-y-4 p-5">
          <h2 className="text-xl font-semibold">
            {selected.title} · {stateNames[selected.status]}
          </h2>
          <p>{selected.occasion}</p>
          <p>
            Бюджет: ${(selected.budgetCents / 100).toFixed(2)} · расчётный
            резерв аудиопилота с запасом: $
            {(selected.reservedMicroUsd / 1e6).toFixed(2)}. Это оценка, не счёт
            провайдера.
          </p>
          {selected.giftNote && (
            <p>
              Фраза{' '}
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
          {selected.status === 'DRAFT' && (
            <>
              <p>
                Голос: Nova · Resemble. Текст и изображение будут зафиксированы
                при запуске.
              </p>
              <Button
                disabled={busy}
                onClick={() => void run(() => update('render'))}
              >
                Озвучить Nova
              </Button>
              {photo && (
                <Button
                  disabled={busy}
                  variant="ghost"
                  onClick={() =>
                    void run(() => update('photo', { base64: photo }))
                  }
                >
                  Сохранить выбранное фото в черновик
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
                onClick={() => void run(() => update('quality'))}
              >
                Проверить озвучку через Soniox
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
            <StoryVideoPanel key={selected.id} giftId={selected.id} />
          )}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.delete(`/story-gifts/${selected.id}`);
                setSelected(null);
              })
            }
          >
            Удалить сказку и её медиа
          </Button>
        </Card>
      )}
    </div>
  );
}
