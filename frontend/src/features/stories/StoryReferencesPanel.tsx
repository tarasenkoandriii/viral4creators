import { useEffect, useRef, useState } from 'react';
import { Button, Card } from '../../components/ui';
import { api } from '../../services/api';
import {
  REFERENCE_STATUS_LABELS,
  canRetryReference,
  editionOptionLabel,
  formatMicroUsd,
  parseUsdBudget,
  referenceListPath,
  referencePlanPath,
  referenceSearchPath,
  referenceStatusLabel,
  storyTime as time,
} from './story-library';
import { storyErrorText } from './story-errors';
type Reference = {
  id: string;
  title: string;
  channel: string;
  url: string;
  durationSeconds: number;
  model: string;
  status: string;
  error?: string;
  editionId?: string | null;
  attempts?: number;
  expiresAt?: string | null;
  retryAllowed?: boolean;
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
type Edition = {
  id: string;
  title: string;
  kindLabel: string;
  locale: string;
  availableInWizard: boolean;
};
type Quota = { used: number; limit: number; remaining: number };
type Candidate = {
  videoId: string;
  url: string;
  title: string;
  channelTitle: string;
  durationSeconds: number;
  saved: boolean;
};
type Plan = {
  editionTitle: string;
  editionKind: string;
  baseRevision: string | null;
  scenes: {
    index: number;
    kind: string;
    start: number;
    end: number;
    reference: { start: number; end: number; confidence: string } | null;
    chapterTitle: string;
    staging: string;
  }[];
  lines: { key: string; label: string; microUsd: number; note: string }[];
  totalMicroUsd: number;
  budgetUsd: number;
  fits: boolean;
  warnings: string[];
};
const fieldStyle =
  'mt-1 w-full rounded-lg border border-silver-500/30 bg-transparent p-2';
const withoutKey = <T,>(map: Record<string, T>, key: string) =>
  Object.fromEntries(Object.entries(map).filter(([k]) => k !== key));
const apiError = (e: unknown, fallback: string, noResponse?: string) =>
  storyErrorText(e, { fallback, noResponse });
export function StoryReferencesPanel() {
  const [url, setUrl] = useState('');
  const [references, setReferences] = useState<Reference[]>([]);
  const [editions, setEditions] = useState<Edition[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [searchText, setSearchText] = useState('');
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [budget, setBudget] = useState('1');
  const [plans, setPlans] = useState<Record<string, Plan>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  async function refresh(q = query, s = status) {
    const [list, left] = await Promise.all([
      api.get<Reference[]>(referenceListPath(q, s)),
      api.get<Quota>('/story-gifts/references/quota'),
    ]);
    setReferences(list.data || []);
    setQuota(left.data || null);
  }
  useEffect(() => {
    void refresh('', '').catch((e) =>
      setError(apiError(e, 'Не удалось загрузить референсы'))
    );
    void api
      .get<Edition[]>('/story-gifts/editions')
      .then((r) =>
        setEditions((r.data || []).filter((e) => e.availableInWizard))
      )
      .catch((e) =>
        setError(apiError(e, 'Не удалось загрузить реестр редакций'))
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function run(
    action: () => Promise<unknown>,
    fallback: string,
    noResponse?: string
  ) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(apiError(e, fallback, noResponse));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const analyze = (referenceUrl = url, retry = false) =>
    run(
      async () => {
        await api.post(
          '/story-gifts/references/analyze',
          { url: referenceUrl, retry },
          { timeout: 150000 }
        );
        await refresh();
      },
      'Разбор не выполнен.',
      'Ответ сервера не получен. Обновите список: сервер мог сохранить разбор. Повтор той же ссылки не запускает второй платный вызов.'
    );
  const remove = (r: Reference) => {
    if (
      !window.confirm(
        `Удалить разбор «${r.title}»? Запись и промежуточный ответ модели будут удалены, суточная квота не вернётся.`
      )
    )
      return;
    void run(async () => {
      await api.delete(`/story-gifts/references/${r.id}`);
      setPlans((p) => withoutKey(p, r.id));
      await refresh();
    }, 'Не удалось удалить референс');
  };
  const link = (r: Reference, editionId: string) =>
    run(async () => {
      await api.patch(`/story-gifts/references/${r.id}`, {
        editionId: editionId || null,
      });
      setPlans((p) => withoutKey(p, r.id));
      await refresh();
    }, 'Не удалось связать редакцию');
  const plan = (r: Reference) => {
    const { value, error: budgetError } = parseUsdBudget(budget);
    if (value === null) {
      setError(`План постановки: ${budgetError}`);
      return;
    }
    void run(async () => {
      const res = await api.get<Plan>(
        referencePlanPath(r.id, { budgetUsd: String(value) })
      );
      if (res.data) setPlans((p) => ({ ...p, [r.id]: res.data! }));
    }, 'Не удалось построить план');
  };
  const searchYoutube = () =>
    run(async () => {
      const res = await api.get<{ results: Candidate[] }>(
        referenceSearchPath(searchText)
      );
      setCandidates(res.data?.results || []);
    }, 'Поиск YouTube недоступен — вставьте ссылку вручную');
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
        Gemini.{' '}
        {quota
          ? `Сегодня осталось ${quota.remaining} из ${quota.limit} платных разборов (UTC), включая явные повторы.`
          : 'До трёх платных разборов в сутки UTC, включая явные повторы.'}{' '}
        Обычный повтор сохранённой ссылки возвращает прежний результат.
        Подтверждённые разборы хранятся 180 дней без изменений, неподтверждённые
        — 30 дней.
      </p>
      <label className="block">
        Ссылка YouTube
        <input
          className={fieldStyle}
          type="url"
          maxLength={500}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=…"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !url.trim()} onClick={() => void analyze()}>
          {busy ? 'Подождите…' : 'Разобрать референс'}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void refresh().catch((e) =>
              setError(apiError(e, 'Не удалось обновить список'))
            )
          }
        >
          Обновить референсы
        </Button>
      </div>
      <details>
        <summary>Найти новый ролик на YouTube</summary>
        <p className="mt-2 text-sm">
          Поиск расходует общую суточную квоту поиска, не деньги. Показываются
          только ролики до 5 минут; разбор запускается отдельной кнопкой.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            className={fieldStyle}
            aria-label="Что искать на YouTube"
            maxLength={120}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Например: репка сказка"
          />
          <Button
            size="sm"
            disabled={busy || searchText.trim().length < 2}
            onClick={() => void searchYoutube()}
          >
            Найти
          </Button>
        </div>
        {candidates && !candidates.length && (
          <p className="mt-2">Подходящих роликов до 5 минут не найдено.</p>
        )}
        <ul className="mt-2 space-y-2">
          {(candidates || []).map((c) => (
            <li key={c.videoId} className="text-sm">
              <a
                className="underline"
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {c.title}
              </a>{' '}
              · {c.channelTitle} · {time(c.durationSeconds)}{' '}
              {c.saved ? (
                '· уже в библиотеке'
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setUrl(c.url)}>
                  Подставить ссылку
                </Button>
              )}
            </li>
          ))}
        </ul>
      </details>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          Поиск по библиотеке
          <input
            className={fieldStyle}
            maxLength={100}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter')
                void refresh().catch((e) =>
                  setError(apiError(e, 'Не удалось найти'))
                );
            }}
            placeholder="Название, канал, сцена"
          />
        </label>
        <label className="block">
          Статус
          <select
            className={fieldStyle}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              void refresh(query, e.target.value).catch((err) =>
                setError(apiError(err, 'Не удалось отфильтровать'))
              );
            }}
          >
            <option value="">Все</option>
            {Object.entries(REFERENCE_STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block">
        Бюджет плана постановки, USD
        <input
          className={fieldStyle}
          type="number"
          min="1"
          max="1000"
          step="0.01"
          value={budget}
          aria-invalid={!!parseUsdBudget(budget).error}
          onChange={(e) => setBudget(e.target.value)}
        />
        {parseUsdBudget(budget).error && (
          <span className="mt-1 block text-sm text-amber-500">
            {parseUsdBudget(budget).error}
          </span>
        )}
      </label>
      {error && <p role="alert">{error}</p>}
      {!references.length && <p className="text-sm">Референсов не найдено.</p>}
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
            {referenceStatusLabel(r.status)}
            {r.attempts && r.attempts > 1
              ? ` · платных попыток: ${r.attempts}`
              : ''}
            {r.expiresAt
              ? ` · хранится до ${new Date(r.expiresAt).toLocaleDateString('ru-RU')}`
              : ''}
          </p>
          {r.error && <p>{r.error}</p>}
          <div className="flex flex-wrap gap-2">
            {canRetryReference(r) && (
              <Button
                disabled={busy || quota?.remaining === 0}
                variant="ghost"
                aria-describedby={
                  quota?.remaining === 0 ? `retry-quota-${r.id}` : undefined
                }
                onClick={() => void analyze(r.url, true)}
              >
                Повторить разбор явно (новый платный вызов)
              </Button>
            )}
            <Button
              disabled={busy || r.status === 'running'}
              variant="ghost"
              onClick={() => remove(r)}
            >
              Удалить
            </Button>
          </div>
          {canRetryReference(r) && quota?.remaining === 0 && (
            <p id={`retry-quota-${r.id}`} className="text-sm">
              Повтор недоступен: суточная квота платных разборов исчерпана (
              {quota.used} из {quota.limit}). Она обновится в 00:00 UTC.
            </p>
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
              <h4 className="font-semibold">Идея постановки от модели</h4>
              <p>{r.assessment.ownProductionPlan}</p>
              <label className="block">
                Редакция для собственного ролика
                <select
                  className={fieldStyle}
                  value={r.editionId || ''}
                  disabled={busy}
                  onChange={(e) => void link(r, e.target.value)}
                >
                  <option value="">Не выбрана</option>
                  {editions.map((e) => (
                    <option key={e.id} value={e.id}>
                      {editionOptionLabel(e)}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                size="sm"
                disabled={busy || !r.editionId}
                onClick={() => plan(r)}
              >
                План постановки в пределах бюджета
              </Button>
              {plans[r.id] && <PlanView plan={plans[r.id]} />}
            </>
          )}
        </article>
      ))}
    </Card>
  );
}
function PlanView({ plan }: { plan: Plan }) {
  return (
    <section className="space-y-2 rounded-lg border border-silver-500/30 p-3">
      <h4 className="font-semibold">
        План: «{plan.editionTitle}»
        {plan.editionKind === 'adaptation' ? ' · адаптация' : ''}
        {plan.baseRevision ? ` · мастер ${plan.baseRevision}` : ''}
      </h4>
      <ol className="space-y-1 text-sm">
        {plan.scenes.map((s) => (
          <li key={s.index}>
            <strong>
              {time(s.start)}–{time(s.end)}
            </strong>{' '}
            · {s.chapterTitle} · {s.staging}
            {s.reference
              ? ` (референс ${time(s.reference.start)}–${time(s.reference.end)}, уверенность: ${s.reference.confidence})`
              : ''}
          </li>
        ))}
      </ol>
      <ul className="space-y-1 text-sm">
        {plan.lines.map((l) => (
          <li key={l.key}>
            {l.label}: <strong>{formatMicroUsd(l.microUsd)}</strong> — {l.note}
          </li>
        ))}
      </ul>
      <p className={plan.fits ? '' : 'rounded-lg border border-amber-500 p-2'}>
        Резерв {formatMicroUsd(plan.totalMicroUsd)} из бюджета $
        {plan.budgetUsd.toFixed(2)} —{' '}
        {plan.fits ? 'укладывается' : 'не укладывается'}. Это оценка с запасом,
        не счёт провайдера; таймкоды уточняются после озвучки.
      </p>
      {plan.warnings.map((w) => (
        <p key={w} role="status" className="text-sm">
          {w}
        </p>
      ))}
    </section>
  );
}
