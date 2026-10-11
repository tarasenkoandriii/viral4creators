import { useEffect, useRef, useState } from 'react';
import { ApiError, useKit } from '../kit';
import { Button, Card, inputClass } from '../kit/ui';
import { useAssist } from '../lib/assist-context';
import { qaAccess } from '../lib/qa-editor';
import { qaFixPrompt } from '../lib/qa-fix-prompt';
import { navigate } from '../lib/router';
import {
  qaRunSummary,
  type QaRun,
  type QaRunHead,
  type QaAttempt,
  type QaResult,
} from '../lib/qa-runs-api';
import type { QaCaseHead } from '../lib/qa-catalog-api';
export function QaRunsButton({ siteId }: { siteId: string }) {
  const { account } = useKit();
  return qaAccess(account.me).read ? (
    <Button
      variant="outline"
      onClick={() => navigate({ name: 'qa-runs', siteId })}
    >
      Запуски QA
    </Button>
  ) : null;
}
export function QaRunsScreen({ siteId }: { siteId: string }) {
  const { account } = useKit();
  return <Runs key={`${account.account.id}:${siteId}`} siteId={siteId} />;
}
const labels = {
  passed: 'Пройден',
  failed: 'Ошибка',
  blocked: 'Заблокирован',
  skipped: 'Пропущен',
  notRun: 'Не выполнен',
};
function Runs({ siteId }: { siteId: string }) {
  const { account } = useKit(),
    { qaRuns: api, qaCatalog } = useAssist(),
    access = qaAccess(account.me);
  const [runs, setRuns] = useState<QaRunHead[]>([]),
    [before, setBefore] = useState<string | null>(null);
  const [cases, setCases] = useState<QaCaseHead[]>([]),
    [after, setAfter] = useState<string | null>(null),
    [ids, setIds] = useState<string[]>([]),
    [title, setTitle] = useState('');
  const [run, setRun] = useState<QaRun | null>(null),
    [history, setHistory] = useState<QaAttempt[]>([]),
    [historyBefore, setHistoryBefore] = useState<string | null>(null);
  const [key, setKey] = useState(''),
    [status, setStatus] = useState<QaResult>('passed'),
    [comment, setComment] = useState(''),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [conflict, setConflict] = useState(false);
  const [report, setReport] = useState<unknown>(null),
    [reportName, setReportName] = useState(''),
    [project, setProject] = useState('');
  const hasDraft = dirty || report !== null;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!hasDraft) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasDraft]);
  useEffect(() => {
    if (!access.read) return;
    let active = true;
    setBusy(true);
    Promise.all([api.list(siteId), qaCatalog.list(siteId)])
      .then(([r, c]) => {
        if (active) {
          setRuns(r.items);
          setBefore(r.nextBeforeId);
          setCases(c.items);
          setAfter(c.nextAfterKey);
        }
      })
      .catch(() => {
        if (active)
          setError('Не удалось загрузить QA. Повторите загрузку страницы.');
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [api, qaCatalog, siteId, access.read]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      if (mounted.current) {
        const stale = e instanceof ApiError && e.code === 'QA_RUN_CONFLICT';
        setConflict(stale);
        setError(
          stale
            ? 'Запуск изменён другим участником. Черновик сохранён. Обновите запуск перед повторной записью.'
            : 'Не удалось выполнить действие. Проверьте данные и повторите.'
        );
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function open(id: string) {
    if (hasDraft && !window.confirm('Отбросить несохранённый результат?'))
      return;
    await act(async () => {
      const [r, h] = await Promise.all([
        api.get(siteId, id),
        api.history(siteId, id),
      ]);
      if (!mounted.current) return;
      setRun(r);
      setHistory(h.items);
      setHistoryBefore(h.nextBeforeId);
      setKey(r.snapshot[0].caseKey);
      setComment('');
      setStatus('passed');
      setDirty(false);
      setConflict(false);
      setReport(null);
      setReportName('');
      setProject(r.automationProject ?? '');
    });
  }
  if (!access.read) return <Card>Нет доступа к QA.</Card>;
  const selected = run?.snapshot.find((s) => s.caseKey === key),
    summary = run ? qaRunSummary(run) : null;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Запуски QA</h1>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          if (!hasDraft || window.confirm('Отбросить несохранённый результат?'))
            navigate({ name: 'qa-cases', siteId });
        }}
      >
        Каталог кейсов
      </Button>
      <p>
        Запуск сохраняет версии выбранных кейсов. Автоматические результаты
        загружаются из отчёта Playwright. Без отчёта кейс остаётся «Не
        выполнен».
      </p>
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {access.write && (
        <Card>
          <h2 className="font-semibold">Новый запуск</h2>
          <label className="block">
            Название
            <input
              className={inputClass}
              maxLength={200}
              value={title}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <fieldset disabled={busy}>
            <legend>Выберите до 100 кейсов</legend>
            {cases
              .filter((c) => !c.archived)
              .map((c) => (
                <label className="block" key={c.id}>
                  <input
                    type="checkbox"
                    checked={ids.includes(c.id)}
                    disabled={!ids.includes(c.id) && ids.length >= 100}
                    onChange={(e) =>
                      setIds(
                        e.target.checked
                          ? [...ids, c.id]
                          : ids.filter((id) => id !== c.id)
                      )
                    }
                  />{' '}
                  {c.caseKey} · {c.title} · v{c.currentVersion}
                </label>
              ))}
          </fieldset>
          {after && (
            <Button
              disabled={busy}
              variant="outline"
              onClick={() =>
                void act(async () => {
                  const c = await qaCatalog.list(siteId, after);
                  if (mounted.current) {
                    setCases((old) => [...old, ...c.items]);
                    setAfter(c.nextAfterKey);
                  }
                })
              }
            >
              Ещё кейсы
            </Button>
          )}
          <Button
            disabled={busy || !title.trim() || !ids.length}
            onClick={() => {
              if (
                hasDraft &&
                !window.confirm('Отбросить несохранённый результат?')
              )
                return;
              void act(async () => {
                const r = await api.create(siteId, title.trim(), ids);
                if (!mounted.current) return;
                setRuns((old) => [r, ...old]);
                setTitle('');
                setIds([]);
                setNotice('Запуск создан. Выберите его в списке.');
              });
            }}
          >
            Создать запуск ({ids.length})
          </Button>
        </Card>
      )}
      <Card>
        <h2 className="font-semibold">История запусков</h2>
        {runs.map((r) => (
          <Button
            key={r.id}
            disabled={busy}
            variant="outline"
            onClick={() => void open(r.id)}
          >
            {r.title} · {new Date(r.createdAt).toLocaleString()}
          </Button>
        ))}
        {!runs.length && !busy && <p>Запусков пока нет.</p>}
        {before && (
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const r = await api.list(siteId, before);
                if (mounted.current) {
                  setRuns((old) => [...old, ...r.items]);
                  setBefore(r.nextBeforeId);
                }
              })
            }
          >
            Ещё запуски
          </Button>
        )}
      </Card>
      {run && selected && summary && (
        <Card>
          <h2 className="font-semibold">
            {run.title} · ревизия {run.revision}
          </h2>
          <p>
            {Object.entries(summary)
              .map(([s, n]) => `${labels[s as keyof typeof labels]}: ${n}`)
              .join(' · ')}
          </p>
          <Button
            disabled={busy}
            variant="outline"
            onClick={() =>
              void act(async () => {
                const fresh = await api.get(siteId, run.id);
                if (mounted.current) {
                  setRun(fresh);
                  setConflict(false);
                  setNotice('Запуск обновлён. Черновик результата сохранён.');
                }
              })
            }
          >
            Обновить запуск, сохранив черновик
          </Button>
          <label className="block">
            Кейс
            <select
              className={inputClass}
              value={key}
              disabled={busy}
              onChange={(e) => {
                if (
                  hasDraft &&
                  !window.confirm('Отбросить несохранённый результат?')
                )
                  return;
                setKey(e.target.value);
                setComment('');
                setStatus('passed');
                setDirty(false);
              }}
            >
              {run.snapshot.map((s) => (
                <option key={s.caseKey} value={s.caseKey}>
                  {s.caseKey} · v{s.version}
                </option>
              ))}
            </select>
          </label>
          <h3>
            {selected.payload.title} ·{' '}
            {selected.payload.type === 'manual' ? 'Ручной' : 'Автоматический'}
          </h3>
          <p>{selected.payload.purpose}</p>
          <p>{selected.payload.preconditions}</p>
          <ol className="list-decimal pl-5">
            {selected.payload.steps.map((s, i) => (
              <li key={i}>
                {s.action}
                <p>Ожидается: {s.expected}</p>
              </li>
            ))}
          </ol>
          <p>
            Текущий результат:{' '}
            {
              labels[
                run.latestAttempts.find((a) => a.caseKey === key)?.status ??
                  'notRun'
              ]
            }
          </p>
          {(() => {
            const prompt = qaFixPrompt(
              selected,
              run.latestAttempts.find((a) => a.caseKey === key)
            );
            return prompt ? (
              <FixPromptDraft
                key={`${run.id}:${prompt}`}
                initialPrompt={prompt}
                caseKey={selected.caseKey}
                version={selected.version}
              />
            ) : null;
          })()}
          {access.write && selected.payload.type === 'manual' && (
            <div className="space-y-2">
              <label className="block">
                Результат
                <select
                  className={inputClass}
                  disabled={busy}
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value as QaResult);
                    setDirty(true);
                  }}
                >
                  {(['passed', 'failed', 'blocked', 'skipped'] as const).map(
                    (s) => (
                      <option key={s} value={s}>
                        {labels[s]}
                      </option>
                    )
                  )}
                </select>
              </label>
              <label className="block">
                Комментарий
                <textarea
                  className={inputClass}
                  maxLength={4000}
                  disabled={busy}
                  value={comment}
                  onChange={(e) => {
                    setComment(e.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <Button
                disabled={
                  busy || conflict || (status !== 'passed' && !comment.trim())
                }
                onClick={() =>
                  void act(async () => {
                    const saved = await api.record(
                      siteId,
                      run.id,
                      run.revision,
                      key,
                      status,
                      comment
                    );
                    if (!mounted.current) return;
                    setRun({
                      ...run,
                      revision: saved.revision,
                      flakyCaseKeys: run.flakyCaseKeys.filter((k) => k !== key),
                      latestAttempts: [
                        ...run.latestAttempts.filter((a) => a.caseKey !== key),
                        saved.attempt,
                      ],
                    });
                    setHistory((old) => [saved.attempt, ...old]);
                    setDirty(false);
                    setComment('');
                    setNotice(
                      'Результат записан. Предыдущие попытки сохранены.'
                    );
                    try {
                      const fresh = await api.get(siteId, run.id);
                      if (mounted.current) setRun(fresh);
                    } catch {
                      if (mounted.current)
                        setNotice(
                          'Результат записан. Не удалось обновить сводку; обновите запуск отдельно.'
                        );
                    }
                  })
                }
              >
                Записать ручной результат
              </Button>
            </div>
          )}
          {run.flakyCaseKeys.length > 0 && (
            <p>Успешно после ошибки: {run.flakyCaseKeys.join(', ')}</p>
          )}
          {access.write &&
            run.snapshot.some((s) => s.payload.type === 'automated') && (
              <div className="space-y-2">
                <h3 className="font-semibold">Импорт отчёта Playwright</h3>
                <p>
                  Выберите один браузерный проект. После первого импорта он
                  закрепляется за запуском. Все автоматические кейсы и версии
                  должны совпадать с запуском. Данные отчёта предоставлены
                  пользователем, подпись CI пока не проверяется.
                </p>
                <label className="block">
                  Браузерный проект
                  <input
                    className={inputClass}
                    maxLength={80}
                    value={run.automationProject ?? project}
                    disabled={busy || !!run.automationProject}
                    onChange={(e) => setProject(e.target.value)}
                  />
                </label>
                <label className="block">
                  Отчёт Playwright (.json)
                  <input
                    className="block w-full max-w-full"
                    type="file"
                    accept=".json,application/json"
                    disabled={busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      void act(async () => {
                        if (file.size > 512 * 1024)
                          throw new Error('Report too large');
                        const parsed: unknown = JSON.parse(await file.text());
                        if (mounted.current) {
                          setReport(parsed);
                          setReportName(file.name);
                        }
                      });
                    }}
                  />
                </label>
                <p>{reportName}</p>
                <Button
                  disabled={
                    busy ||
                    conflict ||
                    report === null ||
                    !(run.automationProject ?? project).trim()
                  }
                  onClick={() =>
                    void act(async () => {
                      const saved = await api.importReport(
                        siteId,
                        run.id,
                        run.revision,
                        run.automationProject ?? project,
                        report
                      );
                      if (!mounted.current) return;
                      setReport(null);
                      setReportName('');
                      setNotice(
                        saved.replayed
                          ? 'Этот отчёт уже импортирован; дубликаты не созданы.'
                          : `Импортировано попыток: ${saved.imported}.`
                      );
                      setRun({
                        ...run,
                        revision: saved.revision,
                        automationProject: saved.project,
                      });
                      try {
                        const [fresh, h] = await Promise.all([
                          api.get(siteId, run.id),
                          api.history(siteId, run.id),
                        ]);
                        if (mounted.current) {
                          setRun(fresh);
                          setHistory(h.items);
                          setHistoryBefore(h.nextBeforeId);
                        }
                      } catch {
                        if (mounted.current)
                          setNotice(
                            'Отчёт импортирован. Обновите запуск для загрузки сводки.'
                          );
                      }
                    })
                  }
                >
                  Импортировать результаты
                </Button>
              </div>
            )}
          <h3 className="font-semibold">Попытки</h3>
          {history.map((a) => (
            <p key={a.id}>
              {a.caseKey} · #{a.attemptNumber} · {labels[a.status]} ·{' '}
              {a.origin === 'automated'
                ? `Playwright: ${a.project}`
                : 'Ручная попытка'}{' '}
              · {new Date(a.createdAt).toLocaleString()} · {a.comment}
              {a.sourceMetadata && (
                <span className="block break-all text-sm">
                  Источник тестов:{' '}
                  {a.sourceMetadata.testSourceSha ?? 'не указан'} · версия
                  деплоя: {a.sourceMetadata.deployedSha ?? 'не подтверждена'} ·
                  runner: {a.sourceMetadata.runnerStatus}
                </span>
              )}
            </p>
          ))}
          {historyBefore && (
            <Button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const h = await api.history(siteId, run.id, historyBefore);
                  if (mounted.current) {
                    setHistory((old) => [...old, ...h.items]);
                    setHistoryBefore(h.nextBeforeId);
                  }
                })
              }
            >
              Ещё попытки
            </Button>
          )}
        </Card>
      )}
    </div>
  );
}

function FixPromptDraft({
  initialPrompt,
  caseKey,
  version,
}: {
  initialPrompt: string;
  caseKey: string;
  version: number;
}) {
  const [draft, setDraft] = useState(initialPrompt);
  const [copyStatus, setCopyStatus] = useState('');
  return (
    <details className="space-y-2">
      <summary>Промпт для разбора ошибки</summary>
      <p>
        Локальный черновик по сохранённому результату. Перед копированием или
        скачиванием удалите пароли, токены и личные данные. Ничего не
        отправляется ИИ автоматически. Изменения не сохраняются в результат
        проверки; при смене кейса черновик формируется заново.
      </p>
      <textarea
        className={inputClass}
        aria-label="Промпт для разбора ошибки"
        rows={12}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setCopyStatus('');
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!draft.trim()}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(draft);
              setCopyStatus('Промпт скопирован.');
            } catch {
              setCopyStatus(
                'Копирование недоступно. Выделите текст вручную или скачайте файл.'
              );
            }
          }}
        >
          Копировать промпт
        </Button>
        <Button
          variant="outline"
          disabled={!draft.trim()}
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([draft], { type: 'text/plain;charset=utf-8' })
            );
            const link = document.createElement('a');
            link.href = url;
            link.download = `qa-${caseKey.replace(/[^a-zA-Z0-9_-]/g, '_')}-v${version}-prompt.txt`;
            link.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          Скачать промпт (.txt)
        </Button>
      </div>
      <p role="status">{copyStatus}</p>
    </details>
  );
}
