import { useEffect, useRef, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { Button, Card } from '../../components/ui';
import { api } from '../../services/api';
import { navigate, routes } from '../../lib/router';

type Chapter = { title: string; text: string; scene: string };
type Story = { id: string; title: string; rights: string; chapters: Chapter[] };
type Gift = {
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
    [reviewed, setReviewed] = useState(false),
    [sharing, setSharing] = useState(false),
    [shareUrl, setShareUrl] = useState('');
  const story = catalog[0];
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
        setCatalog(c.data || []);
        setGifts(g.data || []);
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    setAudio(null);
    setSavedPhoto(null);
    setReviewed(false);
    setSharing(false);
    setShareUrl('');
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
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Card className="space-y-3 p-5">
        <BookOpen className="text-accent" />
        <h1 className="text-2xl font-semibold">Story‑Tales · Создать сказку</h1>
        <p>
          Первый формат: иллюстрированная аудиосказка на русском, голос Nova.
          Это синтетический рассказчик, не голос родителя. Семейный голос и
          видеообращение появятся отдельным этапом.
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
      {story && (
        <Card className="space-y-4 p-5">
          <h2 className="text-xl font-semibold">{story.title}</h2>
          <p className="text-sm text-silver-400">
            4–8 лет · оригинальная сказка · {story.rights}
          </p>
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
            disabled={busy || photoBusy}
            onClick={() =>
              void run(async () => {
                const result = await api.post<Gift>('/story-gifts', {
                  catalogId: story.id,
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
          {selected.status === 'APPROVED' && (
            <>
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={sharing}
                  onChange={(e) => setSharing(e.target.checked)}
                />
                Разрешаю доступ по ссылке: её сможет открыть любой получатель.
                Поисковая индексация запрещена.
              </label>
              <Button
                disabled={busy || !sharing}
                onClick={() =>
                  void run(async () => {
                    const r = await api.post<{ token: string }>(
                      `/story-gifts/${selected.id}/share`,
                      { publicLinkAccepted: true }
                    );
                    if (r.data)
                      setShareUrl(
                        `${(import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api').replace(/\/$/, '')}/story-gift/${r.data.token}`
                      );
                  })
                }
              >
                Создать ссылку на подарок
              </Button>
              {shareUrl && (
                <a
                  className="block break-all text-accent underline"
                  href={shareUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Открыть готовый подарок
                </a>
              )}
              <p className="text-sm">
                Сохраните ссылку сейчас: секрет повторно не выдаётся. Чтобы
                получить новую, отзовите прежнюю.
              </p>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.delete(`/story-gifts/${selected.id}/share`);
                    setShareUrl('');
                  })
                }
              >
                Отозвать ссылку
              </Button>
            </>
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
