import { useEffect, useState } from 'react';
import { ApiError, useKit } from '../kit';
import { Button, Card, inputClass } from '../kit/ui';
import { useAssist } from '../lib/assist-context';
import { qaAccess } from '../lib/qa-editor';
import { navigate } from '../lib/router';
import {
  findingFixPrompt,
  findingStatusLabels,
  type Finding,
  type FindingHead,
  type FindingPayload,
  type FindingRevision,
  type FindingStatus,
} from '../lib/qa-findings-api';
import { FixPromptDraft } from '../components/FixPromptDraft';
const fresh = (): FindingPayload => ({
  title: '',
  category: 'layout',
  severity: 'P2',
  status: 'needs_confirmation',
  url: '',
  context: '',
  steps: '',
  expected: '',
  actual: '',
  impact: '',
  evidence: [],
  deployedSha: null,
  observedAt: new Date().toISOString(),
  verification: null,
});
export function QaFindingsButton({ siteId }: { siteId: string }) {
  const { account } = useKit();
  return qaAccess(account.me).read ? (
    <Button
      variant="outline"
      onClick={() => navigate({ name: 'qa-findings', siteId })}
    >
      Замечания QA
    </Button>
  ) : null;
}
export function QaFindingsScreen({ siteId }: { siteId: string }) {
  const { account } = useKit();
  return <Registry key={`${account.account.id}:${siteId}`} siteId={siteId} />;
}
function Registry({ siteId }: { siteId: string }) {
  const { account } = useKit(),
    { qaFindings: api } = useAssist(),
    access = qaAccess(account.me);
  const [rows, setRows] = useState<FindingHead[]>([]),
    [before, setBefore] = useState<string | null>(null),
    [selected, setSelected] = useState<Finding | null>(null),
    [draft, setDraft] = useState(fresh),
    [history, setHistory] = useState<FindingRevision[]>([]),
    [historyBefore, setHistoryBefore] = useState<number | null>(null),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [conflict, setConflict] = useState(false),
    [notice, setNotice] = useState(''),
    [duplicateId, setDuplicateId] = useState<string | null>(null),
    [filter, setFilter] = useState<FindingStatus | 'all'>('all');
  useEffect(() => {
    let active = true;
    if (!access.read) return;
    setBusy(true);
    api
      .list(siteId)
      .then((p) => {
        if (active) {
          setRows(p.items);
          setBefore(p.nextBeforeId);
        }
      })
      .catch(() => {
        if (active)
          setError('Не удалось загрузить реестр. Повторите загрузку страницы.');
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [api, siteId, access.read]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function edit<K extends keyof FindingPayload>(
    key: K,
    value: FindingPayload[K]
  ) {
    setDraft((old) => ({ ...old, [key]: value }));
    setDirty(true);
    setNotice('');
  }
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setDuplicateId(null);
    try {
      await fn();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      setConflict(code === 'QA_FINDING_CONFLICT');
      const existingId = e instanceof ApiError ? e.details?.findingId : null;
      if (
        code === 'QA_FINDING_DUPLICATE' &&
        typeof existingId === 'string' &&
        /^[A-Za-z0-9_-]{1,64}$/.test(existingId)
      )
        setDuplicateId(existingId);
      setError(
        code === 'QA_FINDING_CONFLICT'
          ? 'Замечание изменилось. Черновик сохранён; скачайте его и обновите запись.'
          : code === 'QA_FINDING_DUPLICATE'
            ? 'Такое наблюдение уже есть. Откройте существующее замечание и дополните доказательства.'
            : code === 'QA_FINDING_SOURCE_INVALID'
              ? 'Не удалось подтвердить связь с попыткой. Проверьте ID запуска, ключ кейса и ID попытки: они должны относиться к этому сайту. Черновик сохранён.'
              : 'Не удалось сохранить или загрузить. Проверьте обязательные поля, дату, SHA и доказательства. Черновик сохранён.'
      );
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    if (dirty && !window.confirm('Отбросить несохранённое замечание?')) return;
    await act(async () => {
      const [f, h] = await Promise.all([
        api.get(siteId, id),
        api.history(siteId, id),
      ]);
      setSelected(f);
      setDraft(f.payload);
      setHistory(h.items);
      setHistoryBefore(h.nextBeforeVersion);
      setDirty(false);
      setConflict(false);
    });
  }
  function download(text: string, name: string, type = 'application/json') {
    const url = URL.createObjectURL(
      new Blob([text], { type: `${type};charset=utf-8` })
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const prompt = selected ? findingFixPrompt(selected) : null;
  if (!access.read) return <Card>Нет доступа к QA.</Card>;
  const fields: [keyof FindingPayload, string, number][] = [
    ['title', 'Название', 200],
    ['url', 'URL страницы без параметров и фрагмента', 500],
    ['context', 'Условия: роль, viewport, тема, язык', 300],
    ['steps', 'Шаги воспроизведения', 1000],
    ['expected', 'Ожидается; источник правила', 1000],
    ['actual', 'Фактический результат', 1000],
    ['impact', 'Влияние на пользователя', 600],
    ['observedAt', 'Время наблюдения ISO с часовым поясом', 40],
    ['deployedSha', 'SHA деплоя, если подтверждён', 40],
  ];
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Замечания QA</h1>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            if (dirty && !window.confirm('Отбросить черновик?')) return;
            navigate({ name: 'qa-runs', siteId });
          }}
        >
          Запуски QA
        </Button>
        {access.write && (
          <Button
            disabled={busy}
            onClick={() => {
              if (dirty && !window.confirm('Отбросить черновик?')) return;
              setSelected(null);
              setDraft(fresh());
              setHistory([]);
              setDirty(false);
              setConflict(false);
            }}
          >
            Новое замечание
          </Button>
        )}
      </div>
      <p>
        Ручной реестр наблюдений. Статусы указываются автором; форма не проводит
        автоматический аудит. Перед сохранением и экспортом удалите секреты и
        персональные данные.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {duplicateId && (
        <Button disabled={busy} onClick={() => void open(duplicateId)}>
          Открыть существующее замечание
        </Button>
      )}
      <Card>
        <h2>Реестр</h2>
        <label className="block">
          Фильтр статуса
          <select
            className={inputClass}
            value={filter}
            onChange={(e) => setFilter(e.target.value as FindingStatus | 'all')}
          >
            <option value="all">Все загруженные</option>
            {Object.entries(findingStatusLabels).map(([s, label]) => (
              <option key={s} value={s}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {rows
          .filter((r) => filter === 'all' || r.status === filter)
          .map((r) => (
            <Button
              key={r.id}
              variant="outline"
              disabled={busy}
              onClick={() => void open(r.id)}
            >
              {r.severity} · {r.title} · {findingStatusLabels[r.status]} · v
              {r.revision}
            </Button>
          ))}
        {!rows.length && <p>Замечаний пока нет.</p>}
        {before && (
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const p = await api.list(siteId, before);
                setRows((old) => [...old, ...p.items]);
                setBefore(p.nextBeforeId);
              })
            }
          >
            Загрузить ещё замечания
          </Button>
        )}
      </Card>
      <Card>
        <h2>
          {selected
            ? `Замечание ${selected.id} · v${selected.revision}`
            : 'Новое замечание'}
        </h2>
        <p>
          Обязательны название, URL, условия, шаги, ожидание, факт, влияние и
          время. Для подтверждения нужны доказательства; для закрытия —
          повторная проверка.
        </p>
        {fields.map(([key, label, max]) => (
          <label key={key} className="block">
            {label}
            <textarea
              className={inputClass}
              disabled={busy || !access.write}
              maxLength={max}
              rows={['steps', 'actual', 'expected'].includes(key) ? 3 : 2}
              value={
                typeof draft[key] === 'string' ? (draft[key] as string) : ''
              }
              onChange={(e) =>
                edit(
                  key,
                  key === 'deployedSha'
                    ? e.target.value || null
                    : e.target.value
                )
              }
            />
          </label>
        ))}
        <label className="block">
          Категория
          <select
            className={inputClass}
            disabled={busy || !access.write}
            value={draft.category}
            onChange={(e) =>
              edit('category', e.target.value as FindingPayload['category'])
            }
          >
            <option value="layout">Вёрстка</option>
            <option value="logic">Логика</option>
            <option value="accessibility">Доступность</option>
          </select>
        </label>
        <label className="block">
          Приоритет
          <select
            className={inputClass}
            disabled={busy || !access.write}
            value={draft.severity}
            onChange={(e) =>
              edit('severity', e.target.value as FindingPayload['severity'])
            }
          >
            {['P0', 'P1', 'P2', 'P3'].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="block">
          Статус
          <select
            className={inputClass}
            disabled={busy || !access.write}
            value={draft.status}
            onChange={(e) => edit('status', e.target.value as FindingStatus)}
          >
            {Object.entries(findingStatusLabels).map(([s, label]) => (
              <option key={s} value={s}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="space-y-2">
          <legend>Связь с сохранённой попыткой QA (необязательно)</legend>
          <p className="text-sm">
            Укажите все три поля. Сервер проверит запуск, кейс и попытку в этом
            сайте.
          </p>
          {(['runId', 'caseKey', 'attemptId'] as const).map((key) => (
            <label key={key} className="block">
              {
                {
                  runId: 'ID запуска',
                  caseKey: 'Ключ кейса',
                  attemptId: 'ID попытки',
                }[key]
              }
              <input
                className={inputClass}
                disabled={busy || !access.write}
                maxLength={64}
                value={draft.source?.[key] ?? ''}
                onChange={(e) =>
                  edit('source', {
                    runId: '',
                    caseKey: '',
                    attemptId: '',
                    ...draft.source,
                    [key]: e.target.value,
                  })
                }
              />
            </label>
          ))}
          {draft.source && access.write && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => edit('source', null)}
            >
              Убрать связь
            </Button>
          )}
        </fieldset>
        <label className="block">
          Доказательства: до 10 обезличенных описаний или ссылок, по одному на
          строку
          <textarea
            className={inputClass}
            disabled={busy || !access.write}
            rows={4}
            maxLength={5010}
            value={draft.evidence.join('\n')}
            onChange={(e) => edit('evidence', e.target.value.split('\n'))}
          />
        </label>
        {draft.status === 'fixed_verified' && (
          <fieldset className="space-y-2">
            <legend>Повторная проверка</legend>
            {(['steps', 'result', 'checkedAt', 'deployedSha'] as const).map(
              (key) => (
                <label key={key} className="block">
                  {
                    {
                      steps: 'Шаги повторной проверки',
                      result: 'Результат повторной проверки',
                      checkedAt: 'Время проверки ISO с часовым поясом',
                      deployedSha: 'SHA повторной проверки',
                    }[key]
                  }
                  <textarea
                    className={inputClass}
                    disabled={busy || !access.write}
                    maxLength={
                      key === 'deployedSha' || key === 'checkedAt' ? 40 : 600
                    }
                    value={draft.verification?.[key] ?? ''}
                    onChange={(e) =>
                      edit('verification', {
                        steps: '',
                        result: '',
                        checkedAt: '',
                        deployedSha: null,
                        ...draft.verification,
                        [key]:
                          key === 'deployedSha'
                            ? e.target.value || null
                            : e.target.value,
                      })
                    }
                  />
                </label>
              )
            )}
          </fieldset>
        )}
        <div className="flex flex-wrap gap-2">
          {access.write && (
            <Button
              disabled={busy || conflict || !dirty}
              onClick={() =>
                void act(async () => {
                  const payload = {
                    ...draft,
                    evidence: draft.evidence
                      .map((e) => e.trim())
                      .filter(Boolean),
                  };
                  let saved: Finding;
                  if (selected) {
                    const result = await api.replace(
                      siteId,
                      selected.id,
                      selected.revision,
                      payload
                    );
                    saved = { ...selected, revision: result.revision, payload };
                  } else {
                    saved = { ...(await api.create(siteId, payload)), payload };
                  }
                  setSelected(saved);
                  setDraft(payload);
                  setDirty(false);
                  setConflict(false);
                  setNotice(
                    'Замечание сохранено. Обновляю серверную запись и историю.'
                  );
                  try {
                    const [f, h, p] = await Promise.all([
                      api.get(siteId, saved.id),
                      api.history(siteId, saved.id),
                      api.list(siteId),
                    ]);
                    setSelected(f);
                    setDraft(f.payload);
                    setRows(p.items);
                    setBefore(p.nextBeforeId);
                    setHistory(h.items);
                    setHistoryBefore(h.nextBeforeVersion);
                    setNotice(
                      'Замечание сохранено. Предыдущие версии остались в истории.'
                    );
                  } catch {
                    setNotice(
                      'Запись сохранена, но история и дата обновления не перечитаны. Обновите запись отдельно; повторно сохранять не нужно.'
                    );
                  }
                })
              }
            >
              Сохранить замечание
            </Button>
          )}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              download(
                JSON.stringify(
                  {
                    schemaVersion: 1,
                    kind: 'local-draft',
                    findingId: selected?.id ?? null,
                    expectedRevision: selected?.revision ?? null,
                    payload: draft,
                  },
                  null,
                  2
                ),
                'qa-finding-draft.json'
              )
            }
          >
            Скачать черновик
          </Button>
          {selected && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void open(selected.id)}
            >
              Обновить запись
            </Button>
          )}
        </div>
        {selected && (
          <p>
            Создано: {selected.createdAt}; обновлено: {selected.updatedAt}.
            Версия деплоя известна только со слов автора. Закрытие замечания не
            запускает деплой.
          </p>
        )}
        {prompt && (
          <FixPromptDraft
            key={`${selected!.id}:${selected!.revision}`}
            initialPrompt={prompt}
            caseKey={selected!.id}
            version={selected!.revision}
          />
        )}
        <h3>История версий</h3>
        {history.map((h) => (
          <details key={h.id}>
            <summary>
              v{h.version} · {h.createdAt} ·{' '}
              {findingStatusLabels[h.payload.status]}
            </summary>
            <p className="whitespace-pre-wrap break-words">
              {JSON.stringify(h.payload, null, 2)}
            </p>
          </details>
        ))}
        {historyBefore && selected && (
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const p = await api.history(siteId, selected.id, historyBefore);
                setHistory((old) => [...old, ...p.items]);
                setHistoryBefore(p.nextBeforeVersion);
              })
            }
          >
            Ещё версии
          </Button>
        )}
      </Card>
    </div>
  );
}
