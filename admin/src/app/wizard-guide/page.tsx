'use client';

/**
 * Вкладка «Советник в мастере» — «Тонкая красная линия» §10, волна C.
 *
 * Рядом с «ИИ-консультантом», а не внутри: разные фичи, разные бюджеты,
 * и смешивать их метрики значит потерять обе.
 *
 * Четыре под-вкладки, и порядок в них не случайный — он повторяет
 * порядок работы оператора:
 *  1. «Очередь» — сигналы с поля ждут решения. Это то, ради чего сюда
 *     заходят.
 *  2. «Корпус» — что уже утверждено, что ждёт публикации и какие
 *     переводы никто не читал.
 *  3. «Шаги» — частоты: где чаще всего жмут «непонятно» и откатывают.
 *     По ним решают, какую граблю описывать следующей.
 *  4. «Пороги» — сведение дублей и гистограмма решений.
 *
 * Доля попаданий в кеш висит над всеми вкладками: это первое число, по
 * которому видно, разорит фича или нет (§10).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  attachWizardCandidate,
  getWizardHints,
  getWizardCandidates,
  getWizardExperience,
  getWizardSiblings,
  getWizardStats,
  getWizardSteps,
  markWizardTextReviewed,
  mergeWizardCandidate,
  promoteWizardCandidate,
  publishWizardExperience,
  rejectWizardCandidate,
  saveWizardText,
  setWizardExperienceStatus,
  setWizardSiblings,
  unmergeWizardCandidate,
} from '../../lib/endpoints';
import type {
  WizardCandidateRow,
  WizardHintRow,
  WizardExperienceRow,
  WizardSiblingStats,
  WizardStatsView,
  WizardStepFrequency,
  WizardTextInput,
} from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

type Tab = 'queue' | 'corpus' | 'hints' | 'steps' | 'thresholds';

const TABS: Array<[Tab, string]> = [
  ['queue', 'Очередь'],
  ['corpus', 'Корпус'],
  ['hints', 'Лента подсказок'],
  ['steps', 'Шаги'],
  ['thresholds', 'Пороги'],
];

const KIND_LABEL: Record<string, string> = {
  enter: 'входы',
  leave: 'уходы',
  hint_open: 'раскрыли совет',
  hint_useless: '«непонятно»',
  undo: 'откаты',
  error: 'отказы',
};

const LOCALES = ['ru', 'uk', 'en', 'de', 'es'];

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

export default function WizardGuidePage() {
  const [tab, setTab] = useState<Tab>('queue');
  const [stats, setStats] = useState<WizardStatsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getWizardStats().then(setStats).catch((e) => setError(errText(e)));
  }, []);

  return (
    <main>
      <h1>Советник в мастере</h1>
      <p className="muted" style={{ fontSize: 13 }}>
        Подсказки ИИ на шагах мастера и корпус опыта, на котором они
        строятся. Рубильник, бюджет и личный лимит — на вкладке
        «Настройки».
      </p>

      {error && <p style={{ color: 'var(--signal-critical)' }}>{error}</p>}

      {stats && <StatsRow stats={stats} />}

      <nav style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            style={{ fontWeight: tab === key ? 700 : 400 }}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'queue' && <QueueTab />}
      {tab === 'corpus' && <CorpusTab />}
      {tab === 'hints' && <HintsTab />}
      {tab === 'steps' && <StepsTab />}
      {tab === 'thresholds' && <ThresholdsTab />}
    </main>
  );
}

/**
 * Доля попаданий в кеш — первое число на экране.
 *
 * Ниже примерно половины через сутки после запуска означает, что
 * дайджест состояния слишком подробен: ключ становится уникальным на
 * каждого человека, и кеш перестаёт быть кешем, не подавая никаких
 * других признаков. Чинится это классификатором, а не бюджетом.
 */
function StatsRow({ stats }: { stats: WizardStatsView }) {
  const rate = Math.round(stats.cache.hitRate * 100);
  const low = stats.cache.hits + stats.cache.rows > 20 && rate < 50;
  return (
    <section className="card" style={{ display: 'flex', gap: 24 }}>
      <div>
        <div className="muted" style={{ fontSize: 12 }}>
          Попаданий в кеш
        </div>
        <div
          style={{
            fontSize: 24,
            fontWeight: 700,
            color: low ? 'var(--signal-critical)' : undefined,
          }}
        >
          {rate}%
        </div>
        {low && (
          <div className="muted" style={{ fontSize: 12 }}>
            Низко — дайджест состояния слишком подробен
          </div>
        )}
      </div>
      <div>
        <div className="muted" style={{ fontSize: 12 }}>
          Подсказок выдано
        </div>
        <div style={{ fontSize: 24, fontWeight: 700 }}>{stats.hints.total}</div>
      </div>
      <div>
        <div className="muted" style={{ fontSize: 12 }}>
          Помечено пост-фильтром
        </div>
        <div style={{ fontSize: 24, fontWeight: 700 }}>
          {stats.hints.flagged}
        </div>
      </div>
    </section>
  );
}

// ── Очередь кандидатов ──────────────────────────────────────────────

function QueueTab() {
  const [rows, setRows] = useState<WizardCandidateRow[]>([]);
  const [experiences, setExperiences] = useState<WizardExperienceRow[]>([]);
  const [merged, setMerged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    Promise.all([
      // Фильтр «сведённые» — про АВТОМАТИКУ (§6.4): у сведённых
      // оператором своя история, и «это другое» там означало бы «я
      // передумал», а не страховку от ложного склеивания.
      getWizardCandidates(
        merged ? { status: 'MERGED', decision: 'AUTO' } : { status: 'NEW' },
      ),
      getWizardExperience(),
    ])
      .then(([c, e]) => {
        setRows(c);
        setExperiences(e);
      })
      .catch((e) => setError(errText(e)));
  }, [merged]);

  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={merged}
          onChange={(e) => setMerged(e.target.checked)}
        />
        Показать сведённые автоматически
      </label>
      <p className="muted" style={{ fontSize: 13 }}>
        {merged
          ? 'Кнопка «это другое» возвращает кандидата в очередь и откатывает счётчик встреч. Это единственная страховка от того, что новая проблема утонет как мнимый дубль.'
          : 'Сырой текст сигнала пользователю не показывается никогда. Совет по нему пишете вы своими словами — опубликованная запись доедет до людей сразу после публикации.'}
      </p>

      {error && <p style={{ color: 'var(--signal-critical)' }}>{error}</p>}
      {rows.length === 0 && <p className="muted">Пусто.</p>}

      {rows.map((row) => (
        <CandidateCard
          key={row.id}
          row={row}
          experiences={experiences}
          busy={busy}
          merged={merged}
          onPromote={(body) => act(() => promoteWizardCandidate(row.id, body))}
          onMerge={(id) => act(() => mergeWizardCandidate(row.id, id))}
          onAttach={(id, body) =>
            act(() => attachWizardCandidate(row.id, id, body))
          }
          onUnmerge={() => act(() => unmergeWizardCandidate(row.id))}
          onReject={() => act(() => rejectWizardCandidate(row.id))}
        />
      ))}
    </section>
  );
}

function CandidateCard({
  row,
  experiences,
  busy,
  merged,
  onPromote,
  onMerge,
  onAttach,
  onUnmerge,
  onReject,
}: {
  row: WizardCandidateRow;
  experiences: WizardExperienceRow[];
  busy: boolean;
  merged: boolean;
  onPromote: (body: WizardTextInput) => void;
  onMerge: (experienceId: string) => void;
  onAttach: (experienceId: string, body: WizardTextInput) => void;
  onUnmerge: () => void;
  onReject: () => void;
}) {
  const [form, setForm] = useState<WizardTextInput>({
    symptom: '',
    cause: '',
    advice: '',
  });
  const [target, setTarget] = useState('');
  // Отклонённые ситуации в выбор не идут: свести сигнал с тем, что
  // оператор уже признал шумом, — способ потерять его молча.
  const sameStep = experiences.filter(
    (e) =>
      e.scenario === row.scenario &&
      e.stepId === row.stepId &&
      e.status !== 'REJECTED',
  );
  const percent =
    row.matchScore === null ? null : Math.round(row.matchScore * 100);

  return (
    <article className="card" style={{ marginTop: 12 }}>
      <div className="muted" style={{ fontSize: 12 }}>
        {row.scenario} · {row.stepId} · {row.locale} · {row.origin} ·{' '}
        {new Date(row.createdAt).toLocaleString('ru-RU')}
      </div>
      <p style={{ whiteSpace: 'pre-wrap' }}>{row.rawText}</p>

      {percent !== null && (
        <p className="muted" style={{ fontSize: 13 }}>
          Совпадение {percent}%
          {row.matched?.texts?.[0]
            ? ` с «${row.matched.texts[0].symptom}»`
            : ''}
          {row.why ? ` — ${row.why}` : ''}
        </p>
      )}

      {merged ? (
        <button type="button" disabled={busy} onClick={onUnmerge}>
          Это другое
        </button>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">— существующая ситуация —</option>
              {sameStep.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.texts[0]?.symptom ?? e.id} ({e.occurrences})
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || !target}
              onClick={() => onMerge(target)}
            >
              Свести
            </button>
            <button
              type="button"
              disabled={busy || !target || !form.symptom || !form.advice}
              title={`Прикрепить как текст на языке «${row.locale}»`}
              onClick={() => onAttach(target, form)}
            >
              Прикрепить текстом ({row.locale})
            </button>
          </div>

          <fieldset style={{ marginTop: 12 }}>
            <legend className="muted" style={{ fontSize: 12 }}>
              Новая ситуация — совет пишете вы, не копируя сигнал
            </legend>
            <input
              placeholder="Симптом: как это выглядит для человека"
              value={form.symptom}
              style={{ width: '100%', marginBottom: 6 }}
              onChange={(e) => setForm({ ...form, symptom: e.target.value })}
            />
            <input
              placeholder="Причина (можно пусто)"
              value={form.cause}
              style={{ width: '100%', marginBottom: 6 }}
              onChange={(e) => setForm({ ...form, cause: e.target.value })}
            />
            <input
              placeholder="Что делать. Кнопки — ключом: {{clientSiteWizard.liveButton}}"
              value={form.advice}
              style={{ width: '100%', marginBottom: 6 }}
              onChange={(e) => setForm({ ...form, advice: e.target.value })}
            />
            <button
              type="button"
              disabled={busy || !form.symptom || !form.advice}
              onClick={() => onPromote(form)}
            >
              Завести черновиком
            </button>
            <button type="button" disabled={busy} onClick={onReject} style={{ marginLeft: 8 }}>
              Отклонить
            </button>
          </fieldset>
        </>
      )}
    </article>
  );
}

// ── Корпус ──────────────────────────────────────────────────────────

function CorpusTab() {
  const [rows, setRows] = useState<WizardExperienceRow[]>([]);
  const [status, setStatus] = useState('');
  const [unreviewed, setUnreviewed] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    getWizardExperience({
      status: status || undefined,
      unreviewedLocale: unreviewed || undefined,
    })
      .then(setRows)
      .catch((e) => setError(errText(e)));
  }, [status, unreviewed]);

  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">все статусы</option>
          <option value="DRAFT">черновики</option>
          <option value="PUBLISHED">опубликованные</option>
          <option value="REJECTED">отклонённые</option>
        </select>
        <select
          value={unreviewed}
          onChange={(e) => setUnreviewed(e.target.value)}
          title="Непрочитанные переводы по локали"
        >
          <option value="">все локали</option>
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              непрочитанные: {l}
            </option>
          ))}
        </select>
      </div>

      {error && <p style={{ color: 'var(--signal-critical)' }}>{error}</p>}
      {rows.length === 0 && <p className="muted">Пусто.</p>}

      {rows.map((row) => (
        <ExperienceCard
          key={row.id}
          row={row}
          busy={busy}
          onPublish={() => act(() => publishWizardExperience(row.id))}
          onStatus={(s) => act(() => setWizardExperienceStatus(row.id, s))}
          onSaveText={(locale, body) =>
            act(() => saveWizardText(row.id, locale, body))
          }
          onReviewed={(locale) =>
            act(() => markWizardTextReviewed(row.id, locale))
          }
        />
      ))}
    </section>
  );
}

function ExperienceCard({
  row,
  busy,
  onPublish,
  onStatus,
  onSaveText,
  onReviewed,
}: {
  row: WizardExperienceRow;
  busy: boolean;
  onPublish: () => void;
  onStatus: (status: string) => void;
  onSaveText: (locale: string, body: WizardTextInput) => void;
  onReviewed: (locale: string) => void;
}) {
  const [locale, setLocale] = useState('ru');
  const current = row.texts.find((t) => t.locale === locale);
  const [form, setForm] = useState<WizardTextInput>({
    symptom: '',
    cause: '',
    advice: '',
  });

  useEffect(() => {
    setForm({
      symptom: current?.symptom ?? '',
      cause: current?.cause ?? '',
      advice: current?.advice ?? '',
    });
  }, [current?.symptom, current?.cause, current?.advice, locale]);

  return (
    <article className="card" style={{ marginTop: 12 }}>
      <div className="muted" style={{ fontSize: 12 }}>
        {row.scenario} · {row.stepId} · {row.status} · встреч:{' '}
        {row.occurrences} · языки:{' '}
        {row.texts
          .map((t) => `${t.locale}${t.reviewed ? '' : '*'}`)
          .join(', ') || '—'}
      </div>

      {row.brokenKeys.length > 0 && (
        <p style={{ color: 'var(--signal-critical)', fontSize: 13 }}>
          Ключи словаря исчезли: {row.brokenKeys.join(', ')} — запись не идёт
          в подсказки, пока их не поправить.
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {LOCALES.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => setLocale(l)}
            style={{ fontWeight: l === locale ? 700 : 400 }}
          >
            {l}
            {row.texts.some((t) => t.locale === l && !t.reviewed) ? '*' : ''}
          </button>
        ))}
      </div>

      <input
        placeholder="Симптом"
        value={form.symptom}
        style={{ width: '100%', marginTop: 8, marginBottom: 6 }}
        onChange={(e) => setForm({ ...form, symptom: e.target.value })}
      />
      <input
        placeholder="Причина (можно пусто)"
        value={form.cause}
        style={{ width: '100%', marginBottom: 6 }}
        onChange={(e) => setForm({ ...form, cause: e.target.value })}
      />
      <input
        placeholder="Что делать"
        value={form.advice}
        style={{ width: '100%', marginBottom: 6 }}
        onChange={(e) => setForm({ ...form, advice: e.target.value })}
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          disabled={busy || !form.symptom || !form.advice}
          onClick={() => onSaveText(locale, form)}
        >
          Сохранить {locale}
        </button>
        {current && !current.reviewed && (
          <button type="button" disabled={busy} onClick={() => onReviewed(locale)}>
            Прочитано, всё верно
          </button>
        )}
        {row.status !== 'PUBLISHED' && (
          <button
            type="button"
            disabled={busy || !row.publishable}
            title={
              row.publishable
                ? 'Запись станет видна людям сразу'
                : 'Нужен русский совет, прочитанный человеком'
            }
            onClick={onPublish}
          >
            Опубликовать
          </button>
        )}
        {row.status === 'PUBLISHED' && (
          <button type="button" disabled={busy} onClick={() => onStatus('DRAFT')}>
            Снять с публикации
          </button>
        )}
      </div>
    </article>
  );
}

// ── Лента подсказок ─────────────────────────────────────────────────

/**
 * Что и кому советник сказал (§10).
 *
 * В журнале лежат ответы МОДЕЛИ, а не попадания в кеш: попадание не
 * порождает нового текста, и считается оно счётчиком на самой записи
 * кеша — он и складывается в долю попаданий наверху экрана.
 */
function HintsTab() {
  const [rows, setRows] = useState<WizardHintRow[]>([]);
  const [locale, setLocale] = useState('');
  const [flagged, setFlagged] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getWizardHints({
      locale: locale || undefined,
      flagged: flagged || undefined,
    })
      .then(setRows)
      .catch((e) => setError(errText(e)));
  }, [locale, flagged]);

  return (
    <section>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <select value={locale} onChange={(e) => setLocale(e.target.value)}>
          <option value="">все языки</option>
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={flagged}
            onChange={(e) => setFlagged(e.target.checked)}
          />
          только помеченные пост-фильтром
        </label>
      </div>
      {error && <p style={{ color: 'var(--signal-critical)' }}>{error}</p>}
      {rows.length === 0 && <p className="muted">Пока пусто.</p>}
      {rows.map((row) => (
        <article className="card" key={row.id} style={{ marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            {new Date(row.createdAt).toLocaleString('ru-RU')} · {row.scenario} ·{' '}
            {row.stepId} · {row.locale} · {row.source} · {row.latencyMs} мс ·{' '}
            {(row.costMicroUsd / 1_000_000).toFixed(5)} $
            {row.flagged ? ' · помечено' : ''}
          </div>
          <p style={{ whiteSpace: 'pre-wrap' }}>{row.hint}</p>
        </article>
      ))}
    </section>
  );
}

// ── Частоты по шагам ────────────────────────────────────────────────

function StepsTab() {
  const [rows, setRows] = useState<WizardStepFrequency[]>([]);
  const [days, setDays] = useState(7);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getWizardSteps(days)
      .then(setRows)
      .catch((e) => setError(errText(e)));
  }, [days]);

  return (
    <section>
      <p className="muted" style={{ fontSize: 13 }}>
        Где чаще открывают совет, где жмут «тут непонятно», где откатывают.
        Идентификаторов людей в этой таблице нет — считаются частоты по
        шагам, а не люди.
      </p>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        За дней:
        <input
          type="number"
          min={1}
          max={90}
          value={days}
          style={{ width: 80 }}
          onChange={(e) => setDays(Number(e.target.value) || 7)}
        />
      </label>
      {error && <p style={{ color: 'var(--signal-critical)' }}>{error}</p>}
      <table style={{ marginTop: 12, width: '100%' }}>
        <thead>
          <tr>
            <th>Сценарий</th>
            <th>Шаг</th>
            {Object.entries(KIND_LABEL).map(([k, label]) => (
              <th key={k}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.scenario}|${r.stepId}`}>
              <td>{r.scenario}</td>
              <td>{r.stepId}</td>
              {Object.keys(KIND_LABEL).map((k) => (
                <td key={k}>{r.counts[k] ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="muted">Пока пусто.</p>}
    </section>
  );
}

// ── Пороги сведения дублей ──────────────────────────────────────────

function ThresholdsTab() {
  const [state, setState] = useState<WizardSiblingStats | null>(null);
  const [auto, setAuto] = useState('');
  const [suggest, setSuggest] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getWizardSiblings()
      .then((s) => {
        setState(s);
        setAuto(String(s.auto));
        setSuggest(String(s.suggest));
      })
      .catch((e) => setError(errText(e)));
  }, []);

  useEffect(load, [load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await setWizardSiblings({ auto: Number(auto), suggest: Number(suggest) });
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const max = Math.max(1, ...(state?.histogram.buckets ?? []).map((b) => b.count));

  return (
    <section>
      <p className="muted" style={{ fontSize: 13 }}>
        Выше верхнего порога кандидат сводится без вас; между порогами
        попадает в очередь с процентом; ниже нижнего заводится новой
        ситуацией. Процент сохраняется ВСЕГДА — по распределению ниже и
        видно, где на самом деле проходит граница.
      </p>
      {error && <p style={{ color: 'var(--signal-critical)' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <label>
          Сводить сам от{' '}
          <input
            type="number"
            min={0}
            max={1}
            step="0.01"
            value={auto}
            style={{ width: 90 }}
            onChange={(e) => setAuto(e.target.value)}
          />
        </label>
        <label>
          Предлагать от{' '}
          <input
            type="number"
            min={0}
            max={1}
            step="0.01"
            value={suggest}
            style={{ width: 90 }}
            onChange={(e) => setSuggest(e.target.value)}
          />
        </label>
        <button type="button" disabled={busy} onClick={() => void save()}>
          Сохранить
        </button>
      </div>

      {state && (
        <div style={{ marginTop: 16 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            Последние {state.histogram.total} решений
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 100 }}>
            {state.histogram.buckets.map((b) => (
              <div key={b.from} style={{ textAlign: 'center', flex: 1 }}>
                <div
                  title={`${b.from.toFixed(1)}–${(b.from + 0.1).toFixed(1)}: ${b.count}`}
                  style={{
                    height: `${(b.count / max) * 80}px`,
                    background:
                      b.from + 0.05 >= state.auto
                        ? 'var(--accent, #4a7)'
                        : b.from + 0.05 >= state.suggest
                          ? '#c90'
                          : 'var(--border, #999)',
                  }}
                />
                <div className="muted" style={{ fontSize: 10 }}>
                  {b.from.toFixed(1)}
                </div>
              </div>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            Решения: {Object.entries(state.histogram.decisions)
              .map(([k, v]) => `${k} — ${v}`)
              .join(', ') || '—'}
          </p>
        </div>
      )}
    </section>
  );
}
