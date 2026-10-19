import { useEffect, useState } from 'react';
import { ApiError, useKit } from '../kit';
import { Button, inputClass } from '../kit/ui';
import { useAssist } from '../lib/assist-context';
import type {
  QaPlan,
  QaPlanHead,
  QaPlanBody,
  QaEnvironment,
} from '../lib/qa-plan-api';
import type { QaRunHead } from '../lib/qa-runs-api';
const environment = (): QaEnvironment => ({
  name: 'Desktop',
  browser: 'Chromium',
  device: 'Desktop',
  viewport: '1280x720',
  theme: 'dark',
  locale: 'ru',
});
export function QaPlans({
  siteId,
  selectedCaseIds,
  write,
  disabled,
  onStarted,
  onDirtyChange,
}: {
  siteId: string;
  selectedCaseIds: string[];
  write: boolean;
  disabled: boolean;
  onStarted: (run: QaRunHead) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const {
      qaRuns: { plans: api },
    } = useAssist(),
    { account } = useKit();
  const [rows, setRows] = useState<QaPlanHead[]>([]),
    [before, setBefore] = useState<string | null>(null),
    [selected, setSelected] = useState<QaPlan | null>(null),
    [key, setKey] = useState(''),
    [title, setTitle] = useState(''),
    [suite, setSuite] = useState(''),
    [description, setDescription] = useState(''),
    [envs, setEnvs] = useState<QaEnvironment[]>([environment()]),
    [assignMe, setAssignMe] = useState(false),
    [useSelection, setUseSelection] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [history, setHistory] = useState<
      Array<{ version: number; createdAt: string; payload: QaPlan['payload'] }>
    >([]),
    [historyBefore, setHistoryBefore] = useState<number | null>(null),
    [environmentIndex, setEnvironmentIndex] = useState(0),
    [startId, setStartId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let active = true;
    api
      .list(siteId)
      .then((p) => {
        if (active) {
          setRows(p.items);
          setBefore(p.nextBeforeId);
        }
      })
      .catch(() => {
        if (active) setError('Не удалось загрузить планы QA.');
      });
    return () => {
      active = false;
    };
  }, [api, siteId]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'Не удалось обработать план. Черновик сохранён.'
      );
    } finally {
      setBusy(false);
    }
  }
  const locked = busy || disabled;
  function load(p: QaPlan) {
    setSelected(p);
    setUseSelection(false);
    setKey(p.planKey);
    setTitle(p.payload.title);
    setSuite(p.payload.suite);
    setDescription(p.payload.description);
    setEnvs(p.payload.environments);
    setAssignMe(p.payload.assigneeMemberId === account.me.memberId);
    setEnvironmentIndex(0);
    setStartId(crypto.randomUUID());
  }
  function body(archived = selected?.archived ?? false): QaPlanBody {
    return {
      title,
      suite,
      description,
      caseIds:
        !selected || useSelection ? selectedCaseIds : selected.payload.caseIds,
      environments: envs,
      assigneeMemberId: assignMe
        ? account.me.memberId
        : selected?.payload.assigneeMemberId === account.me.memberId
          ? null
          : (selected?.payload.assigneeMemberId ?? null),
      archived,
    };
  }
  const planDirty = selected
    ? JSON.stringify(body(selected.archived)) !==
      JSON.stringify({
        title: selected.payload.title,
        suite: selected.payload.suite,
        description: selected.payload.description,
        caseIds: selected.payload.caseIds,
        environments: selected.payload.environments,
        assigneeMemberId: selected.payload.assigneeMemberId,
        archived: selected.archived,
      })
    : Boolean(
        key.trim() ||
        title.trim() ||
        suite.trim() ||
        description.trim() ||
        assignMe ||
        JSON.stringify(envs) !== JSON.stringify([environment()])
      );
  useEffect(() => {
    onDirtyChange(planDirty);
  }, [planDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  return (
    <section className="space-y-3" aria-label="Планы QA">
      <h2 className="font-semibold">Планы QA и окружения</h2>
      <p className="text-sm">
        План сохраняет точные версии кейсов. Каждый запуск получает свой снимок
        и выбранное окружение; старые результаты сохраняются. Создание запуска
        ничего не выполняет и не вызывает платные сервисы.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="flex flex-wrap gap-2">
        {rows.map((p) => (
          <Button
            key={p.id}
            disabled={locked}
            variant="outline"
            onClick={() =>
              void act(async () => {
                if (
                  (selected || title.trim() || key.trim()) &&
                  !window.confirm(
                    'Открыть другой план? Несохранённые изменения формы будут потеряны.'
                  )
                )
                  return;
                load(await api.get(siteId, p.id));
                setHistory([]);
                setHistoryBefore(null);
              })
            }
          >
            {p.planKey} · {p.title} · v{p.currentVersion}
            {p.archived ? ' · архив' : ''}
          </Button>
        ))}
      </div>
      {before && (
        <Button
          variant="outline"
          disabled={locked}
          onClick={() =>
            void act(async () => {
              const p = await api.list(siteId, before);
              setRows((old) => [...old, ...p.items]);
              setBefore(p.nextBeforeId);
            })
          }
        >
          Ещё планы
        </Button>
      )}
      {write && (
        <details>
          <summary>
            {selected
              ? 'Редактировать план'
              : 'Создать план из выбранных кейсов'}
          </summary>
          <div className="space-y-2 mt-2">
            <p>
              Выбрано в форме запуска: {selectedCaseIds.length}.{' '}
              {selected && !selectedCaseIds.length
                ? 'При сохранении останется прежний набор кейсов, обновлённый по текущему каталогу.'
                : ''}
            </p>
            {selected && (
              <label>
                <input
                  type="checkbox"
                  disabled={locked}
                  checked={useSelection}
                  onChange={(e) => setUseSelection(e.target.checked)}
                />{' '}
                Заменить набор плана выбранными выше кейсами (
                {selectedCaseIds.length})
              </label>
            )}
            <label className="block">
              Ключ плана
              <input
                className={inputClass}
                disabled={locked || !!selected}
                value={key}
                maxLength={64}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <label className="block">
              Название плана
              <input
                className={inputClass}
                disabled={locked}
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label className="block">
              Группа проверок (suite)
              <input
                className={inputClass}
                disabled={locked}
                value={suite}
                maxLength={100}
                onChange={(e) => setSuite(e.target.value)}
              />
            </label>
            <label className="block">
              Описание плана
              <textarea
                className={inputClass}
                disabled={locked}
                value={description}
                maxLength={2000}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                disabled={locked}
                checked={assignMe}
                onChange={(e) => setAssignMe(e.target.checked)}
              />{' '}
              Назначить меня ответственным
            </label>
            {envs.map((env, i) => (
              <fieldset key={i} className="space-y-1 border rounded p-2">
                <legend>Окружение {i + 1}</legend>
                {(
                  ['name', 'browser', 'device', 'viewport', 'locale'] as const
                ).map((k) => (
                  <label key={k} className="block">
                    {
                      {
                        name: 'Название окружения',
                        browser: 'Браузер',
                        device: 'Устройство',
                        viewport: 'Размер экрана, например 1280x720',
                        locale: 'Язык, например ru или en-US',
                      }[k]
                    }
                    <input
                      className={inputClass}
                      disabled={locked}
                      value={env[k]}
                      maxLength={80}
                      onChange={(e) =>
                        setEnvs((old) =>
                          old.map((v, j) =>
                            j === i ? { ...v, [k]: e.target.value } : v
                          )
                        )
                      }
                    />
                  </label>
                ))}
                <label>
                  Тема
                  <select
                    className={inputClass}
                    disabled={locked}
                    value={env.theme}
                    onChange={(e) =>
                      setEnvs((old) =>
                        old.map((v, j) =>
                          j === i
                            ? {
                                ...v,
                                theme: e.target.value as QaEnvironment['theme'],
                              }
                            : v
                        )
                      )
                    }
                  >
                    <option value="dark">Тёмная</option>
                    <option value="light">Светлая</option>
                    <option value="system">Системная</option>
                  </select>
                </label>
                {envs.length > 1 && (
                  <Button
                    variant="outline"
                    disabled={locked}
                    onClick={() =>
                      setEnvs((old) => old.filter((_, j) => j !== i))
                    }
                  >
                    Убрать окружение
                  </Button>
                )}
              </fieldset>
            ))}
            <Button
              variant="outline"
              disabled={locked || envs.length >= 12}
              onClick={() =>
                setEnvs((old) => [
                  ...old,
                  { ...environment(), name: `Окружение ${old.length + 1}` },
                ])
              }
            >
              Добавить окружение
            </Button>
            <Button
              disabled={
                locked ||
                !title.trim() ||
                (!selectedCaseIds.length && !selected)
              }
              onClick={() =>
                void act(async () => {
                  let id = selected?.id;
                  if (selected)
                    await api.replace(
                      siteId,
                      selected.id,
                      selected.currentVersion,
                      body()
                    );
                  else id = (await api.create(siteId, key, body())).id;
                  load(await api.get(siteId, id!));
                  const p = await api.list(siteId);
                  setRows(p.items);
                  setBefore(p.nextBeforeId);
                  setNotice('План сохранён; версии кейсов зафиксированы.');
                })
              }
            >
              {selected ? 'Сохранить новую версию плана' : 'Сохранить план'}
            </Button>
          </div>
        </details>
      )}
      {selected && (
        <div className="space-y-2">
          <p>
            Снимок плана {selected.planKey} v{selected.currentVersion}:{' '}
            {selected.payload.snapshot
              .map((c) => `${c.caseKey} v${c.version}`)
              .join(', ')}
            .
          </p>
          <p>
            Группа: {selected.payload.suite || 'без группы'}. Ответственный:{' '}
            {selected.payload.assigneeMemberId === account.me.memberId
              ? 'вы'
              : (selected.payload.assigneeMemberId ?? 'не назначен')}
            .
          </p>
          <label className="block">
            Окружение запуска
            <select
              className={inputClass}
              disabled={locked}
              value={environmentIndex}
              onChange={(e) => {
                setEnvironmentIndex(+e.target.value);
                setStartId(crypto.randomUUID());
              }}
            >
              {selected.payload.environments.map((e, i) => (
                <option key={i} value={i}>
                  {e.name} · {e.browser} · {e.device} · {e.viewport} · {e.theme}{' '}
                  · {e.locale}
                </option>
              ))}
            </select>
          </label>
          {write && (
            <Button
              disabled={locked || selected.archived}
              onClick={() =>
                void act(async () => {
                  const r = await api.start(
                    siteId,
                    selected.id,
                    selected.currentVersion,
                    environmentIndex,
                    startId
                  );
                  onStarted(r);
                  setNotice(
                    'Запуск создан без выполнения проверок. Повторное нажатие откроет тот же запуск. Для новой попытки нажмите «Новый запуск».'
                  );
                })
              }
            >
              Создать запуск по плану
            </Button>
          )}
          {write && (
            <Button
              variant="outline"
              disabled={locked}
              onClick={() => {
                setStartId(crypto.randomUUID());
                setNotice(
                  'Подготовлен новый ключ запуска; предыдущие результаты сохранятся.'
                );
              }}
            >
              Новый запуск
            </Button>
          )}
          <Button
            variant="outline"
            disabled={locked}
            onClick={() =>
              void act(async () => {
                const h = await api.history(siteId, selected.id);
                setHistory(h.items);
                setHistoryBefore(h.nextBeforeVersion);
              })
            }
          >
            История плана
          </Button>
          {history.map((h) => (
            <p key={h.version}>
              v{h.version} · {h.createdAt} · {h.payload.title} ·{' '}
              {h.payload.snapshot
                .map((c) => `${c.caseKey} v${c.version}`)
                .join(', ')}{' '}
              ·{' '}
              {h.payload.environments
                .map((e) => `${e.name} ${e.viewport} ${e.theme} ${e.locale}`)
                .join('; ')}
            </p>
          ))}
          {historyBefore && (
            <Button
              variant="outline"
              disabled={locked}
              onClick={() =>
                void act(async () => {
                  const h = await api.history(
                    siteId,
                    selected.id,
                    historyBefore
                  );
                  setHistory((old) => [...old, ...h.items]);
                  setHistoryBefore(h.nextBeforeVersion);
                })
              }
            >
              Ещё версии плана
            </Button>
          )}
          {write && (
            <Button
              variant="outline"
              disabled={locked}
              onClick={() =>
                void act(async () => {
                  await api.replace(
                    siteId,
                    selected.id,
                    selected.currentVersion,
                    {
                      title: selected.payload.title,
                      suite: selected.payload.suite,
                      description: selected.payload.description,
                      caseIds: selected.payload.caseIds,
                      environments: selected.payload.environments,
                      assigneeMemberId: selected.payload.assigneeMemberId,
                      archived: !selected.archived,
                    }
                  );
                  load(await api.get(siteId, selected.id));
                  const p = await api.list(siteId);
                  setRows(p.items);
                })
              }
            >
              {selected.archived ? 'Восстановить план' : 'Архивировать план'}
            </Button>
          )}
        </div>
      )}
      {write && (
        <Button
          variant="outline"
          disabled={locked}
          onClick={() => {
            if (
              !window.confirm(
                'Очистить форму плана? Несохранённые изменения будут потеряны.'
              )
            )
              return;
            setSelected(null);
            setKey('');
            setTitle('');
            setSuite('');
            setDescription('');
            setEnvs([environment()]);
            setAssignMe(false);
            setHistory([]);
            setHistoryBefore(null);
          }}
        >
          Новый план
        </Button>
      )}
    </section>
  );
}
