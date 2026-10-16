import { useEffect, useRef, useState } from 'react';
import { Button, Card } from '../../components/ui';
import { api } from '../../services/api';
type Reference = {
  id: string;
  title: string;
  channel: string;
  url: string;
  durationSeconds: number;
  model: string;
  status: string;
  error?: string;
  assessment?: {
    observed: boolean;
    audioObserved: boolean;
    summary: string;
    scenes: {
      start: number;
      end: number;
      observation: string;
      confidence: string;
    }[];
    pacing: string;
    narration: string;
    visuals: string;
    music: string;
    ownProductionPlan: string;
    limitations: string;
    timelineWarnings?: string;
  };
};
const time = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
export function StoryReferencesPanel() {
  const [url, setUrl] = useState('');
  const [references, setReferences] = useState<Reference[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  async function refresh() {
    setReferences(
      (await api.get<Reference[]>('/story-gifts/references')).data || []
    );
  }
  useEffect(() => {
    void refresh().catch(() => setError('Не удалось загрузить референсы'));
  }, []);
  async function analyze(referenceUrl = url, retry = false) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await api.post(
        '/story-gifts/references/analyze',
        { url: referenceUrl, retry },
        { timeout: 150000 }
      );
      await refresh();
    } catch (e) {
      setError(
        (e as { response?: { data?: { message?: string } } }).response?.data
          ?.message ||
          'Ответ не получен. Обновите список: сервер мог сохранить разбор. Повтор той же ссылки не запускает второй платный вызов.'
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Card className="space-y-4 p-5">
      <h2 className="text-xl font-semibold">YouTube · Референсы постановки</h2>
      <p>
        Разбираем публичные ролики до 5 минут: сцены, паузы, иллюстрации и
        подачу. Текст классики выбирается отдельно; чужие голос, музыка и кадры
        в сказку не переносятся.
      </p>
      <p className="text-sm">
        Разбор оплачивается отдельно от бюджета подарка по текущей модели
        Gemini. До трёх новых разборов в сутки UTC; повтор сохранённой ссылки
        возвращает прежний результат.
      </p>
      <label className="block">
        Ссылка YouTube
        <input
          className="mt-1 w-full rounded-lg border border-silver-500/30 bg-transparent p-2"
          type="url"
          maxLength={500}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=…"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !url.trim()} onClick={() => void analyze()}>
          {busy ? 'Разбор…' : 'Разобрать референс'}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void refresh().catch(() => setError('Не удалось обновить список'))
          }
        >
          Обновить референсы
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {references.map((r) => (
        <article
          key={r.id}
          className="space-y-3 rounded-lg border border-silver-500/30 p-3"
        >
          <h3 className="font-semibold">
            <a
              className="underline"
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {r.title}
            </a>
          </h3>
          <p className="text-sm">
            {r.channel} · {time(r.durationSeconds)} · {r.model} ·{' '}
            {(
              {
                complete: 'Разбор готов',
                partial: 'Частичный разбор · проверьте таймкоды',
                running: 'Выполняется',
                unavailable: 'Видео не удалось просмотреть',
                unknown: 'Результат не подтверждён',
              } as Record<string, string>
            )[r.status] || r.status}
          </p>
          {r.error && <p>{r.error}</p>}
          {['unknown', 'unavailable'].includes(r.status) && (
            <Button
              disabled={busy}
              variant="ghost"
              onClick={() => void analyze(r.url, true)}
            >
              Повторить разбор явно (новый платный вызов)
            </Button>
          )}
          {r.assessment?.observed && (
            <>
              <p>{r.assessment.summary}</p>
              {r.assessment.timelineWarnings && (
                <p
                  role="status"
                  className="rounded-lg border border-amber-500 p-2"
                >
                  {r.assessment.timelineWarnings}
                </p>
              )}
              <p className="text-sm">
                {r.assessment.audioObserved
                  ? 'Модель сообщает, что звук доступен; выводы требуют просмотра взрослым.'
                  : 'Звук не подтверждён: дикция и качество озвучки не оценены.'}
              </p>
              <ol className="space-y-2">
                {r.assessment.scenes.map((s, i) => (
                  <li key={i}>
                    <strong>
                      {time(s.start)}–{time(s.end)}
                    </strong>{' '}
                    · {s.observation}{' '}
                    <span className="text-sm">
                      (уверенность: {s.confidence})
                    </span>
                  </li>
                ))}
              </ol>
              <details>
                <summary>Подача, звук и ограничения</summary>
                {(
                  [
                    'pacing',
                    'narration',
                    'visuals',
                    'music',
                    'limitations',
                  ] as const
                ).map((k) => (
                  <p className="mt-2" key={k}>
                    {r.assessment![k]}
                  </p>
                ))}
              </details>
              <h4 className="font-semibold">План собственной постановки</h4>
              <p>{r.assessment.ownProductionPlan}</p>
            </>
          )}
        </article>
      ))}
    </Card>
  );
}
