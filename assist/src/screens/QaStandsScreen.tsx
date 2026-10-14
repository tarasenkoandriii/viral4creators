import { downloadStandOpenApi } from '../lib/qa-stand-openapi';
import { StandVoiceInput } from '../components/StandVoiceInput';
import { GeneratedStandPreview } from '../components/GeneratedStandPreview';
import { useEffect, useState } from 'react';
import { useKit } from '../kit';
import { Button, Card, inputClass } from '../kit/ui';
import { useAssist } from '../lib/assist-context';
import { navigate } from '../lib/router';
import { qaAccess } from '../lib/qa-editor';
import type { Stand, StandContract, MockResult } from '../lib/qa-stands-api';
export function QaStandsButton({ siteId }: { siteId: string }) {
  const { account } = useKit();
  return qaAccess(account.me).read ? (
    <Button
      variant="outline"
      onClick={() => navigate({ name: 'qa-stands', siteId })}
    >
      Стенды
    </Button>
  ) : null;
}
export function QaStandsScreen({ siteId }: { siteId: string }) {
  const { account } = useKit();
  return <Stands key={`${account.account.id}:${siteId}`} siteId={siteId} />;
}
function Stands({ siteId }: { siteId: string }) {
  const { qaStands: api } = useAssist();
  const { account } = useKit();
  const write = qaAccess(account.me).write;
  const [items, setItems] = useState<Stand[]>([]),
    [selected, setSelected] = useState<Stand | null>(null),
    [plan, setPlan] = useState<StandContract | null>(null),
    [description, setDescription] = useState(
      'Кабинет заказов с входом и списком. Поля: Название, Статус'
    ),
    [title, setTitle] = useState('Тестовый кабинет'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [role, setRole] = useState('viewer'),
    [scenario, setScenario] = useState('normal'),
    [values, setValues] = useState<string[]>([]),
    [query, setQuery] = useState(''),
    [result, setResult] = useState<MockResult | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [requestId, setRequestId] = useState('');
  const [checks, setChecks] = useState<{
    scope: string;
    checks: Array<{ name: string; passed: boolean }>;
  } | null>(null);
  useEffect(() => {
    let active = true;
    api
      .list(siteId)
      .then((x) => {
        if (active) setItems(x.items);
      })
      .catch((e) => {
        if (active) setError(String(e.message));
      });
    return () => {
      active = false;
    };
  }, [api, siteId]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка запроса');
    } finally {
      setBusy(false);
    }
  }
  function choose(s: Stand) {
    setSelected(s);
    setValues(s.contract.fields.map(() => ''));
    setResult(null);
    setRole('viewer');
    setQuery('');
    setChecks(null);
  }
  async function command(method: string, id?: string) {
    if (!selected) return;
    await action(async () => {
      const r = await api.command(siteId, selected.id, {
        method,
        role,
        scenario,
        values,
        id,
        query,
      });
      setResult(r);
      const x = await api.list(siteId);
      setItems(x.items);
      setSelected(await api.get(siteId, selected.id));
    });
  }
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">QA → Стенды · MVP</h1>
      <p>
        Опишите тестовый сайт текстом или голосом: ИИ предложит сущности, формы,
        списки и обзорные экраны с mock API. Перед созданием проверьте контракт
        и допущения. Все данные синтетические.
      </p>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Выполняем запрос…</p>}
      {write && (
        <Card>
          <label>
            Название
            <input
              className={inputClass}
              value={title}
              disabled={busy || voiceBusy}
              maxLength={100}
              onChange={(e) => {
                setTitle(e.target.value);
                setPlan(null);
              }}
            />
          </label>
          <label>
            Описание
            <textarea
              className={inputClass}
              value={description}
              disabled={busy || voiceBusy}
              maxLength={4000}
              onChange={(e) => {
                setDescription(e.target.value);
                setPlan(null);
              }}
            />
          </label>
          <p>
            Для простого варианта без ИИ добавьте «Поля: Название, Статус» и
            подготовьте базовый шаблон. Для нескольких экранов и сущностей
            используйте ИИ-генератор.
          </p>
          <StandVoiceInput
            disabled={busy || voiceBusy}
            onBusyChange={setVoiceBusy}
            transcribe={(audio) => api.voice(siteId, audio)}
            onText={(text) => {
              setDescription(text);
              setPlan(null);
            }}
          />
          <Button
            disabled={busy || voiceBusy}
            onClick={() =>
              action(async () => {
                setPlan(
                  await api.generate(
                    siteId,
                    description,
                    title.trim() && title !== 'Тестовый кабинет'
                      ? title
                      : undefined
                  )
                );
                setRequestId(crypto.randomUUID());
              })
            }
          >
            Сгенерировать UI и mock API с ИИ
          </Button>
          <p>
            Используется бюджет обучения аккаунта. Перед созданием проверьте
            предложенные экраны и допущения.
          </p>
          <Button
            disabled={busy || voiceBusy}
            onClick={() =>
              action(async () => {
                setPlan(await api.plan(siteId, description, title));
                setRequestId(crypto.randomUUID());
              })
            }
          >
            Подготовить базовый шаблон
          </Button>
          {plan && (
            <div>
              {plan.template === 'generated' && (
                <div>
                  <p>
                    Сущности: {plan.entities?.map((e) => e.title).join(', ')}
                  </p>
                  <p>Экраны: {plan.screens?.map((e) => e.title).join(', ')}</p>
                  {plan.assumptions?.map((a, i) => (
                    <p key={i}>{a}</p>
                  ))}
                  <details>
                    <summary>Проверить полный контракт</summary>
                    <pre className="overflow-auto">
                      {JSON.stringify(plan, null, 2)}
                    </pre>
                  </details>
                </div>
              )}
              <p>
                Поля: {plan.fields.join(', ')}. API: GET список, POST создание,
                DELETE удаление. Viewer читает; editor создаёт; admin удаляет.
                Лимит 100 записей.
              </p>
              <Button
                disabled={busy || voiceBusy}
                onClick={() =>
                  action(async () => {
                    const s = await api.create(siteId, plan, requestId);
                    setItems((x) => [s, ...x]);
                    choose(s);
                    setPlan(null);
                  })
                }
              >
                Подтвердить и создать стенд
              </Button>
            </div>
          )}
        </Card>
      )}
      <Card>
        <h2>Мои стенды</h2>
        <p>Последние 50 стендов; более ранние можно загрузить ниже.</p>
        {!items.length && <p>Стендов пока нет.</p>}
        {items.map((s) => (
          <Button
            key={s.id}
            variant="outline"
            disabled={busy || voiceBusy}
            onClick={() =>
              action(async () => choose(await api.get(siteId, s.id)))
            }
          >
            {s.contract.title}
          </Button>
        ))}
      </Card>
      {items.length >= 50 && (
        <Button
          disabled={busy || voiceBusy}
          onClick={() =>
            action(async () => {
              const x = await api.list(siteId, items[items.length - 1]?.id);
              setItems((v) => [...v, ...x.items]);
            })
          }
        >
          Загрузить более ранние
        </Button>
      )}
      {selected?.contract.template === 'generated' && (
        <GeneratedStandPreview
          key={`${selected.id}:${selected.revision}`}
          stand={selected}
          api={api}
          siteId={siteId}
          write={write}
          onDeleted={() => {
            setItems((v) => v.filter((s) => s.id !== selected.id));
            setSelected(null);
          }}
        />
      )}
      {selected && selected.contract.template === 'records' && (
        <Card>
          <h2>
            {selected.contract.title} · версия данных {selected.revision}
          </h2>
          <p>Тестовый стенд · синтетические данные · серверный mock API</p>
          <label>
            Вход в демо-роль
            <select
              className={inputClass}
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              {['viewer', 'editor', 'admin'].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label>
            Сценарий
            <select
              className={inputClass}
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
            >
              {['normal', '500', '429', 'empty'].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label>
            Поиск
            <input
              className={inputClass}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <Button disabled={busy || !write} onClick={() => command('GET')}>
            Выполнить GET
          </Button>
          <ul>
            {(result?.status === 200 &&
            typeof result.data === 'object' &&
            result.data !== null &&
            'items' in result.data
              ? (result.data as { items: Stand['records'] }).items
              : selected.records
            ).map((r) => (
              <li key={r.id} className="break-words">
                {r.values.join(' · ')}{' '}
                <Button
                  disabled={busy || !write}
                  variant="outline"
                  onClick={() => {
                    if (window.confirm('Удалить тестовую запись?'))
                      void command('DELETE', r.id);
                  }}
                >
                  Удалить
                </Button>
              </li>
            ))}
          </ul>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void command('POST');
            }}
          >
            {selected.contract.fields.map((f, i) => (
              <label key={f}>
                {f}
                <input
                  className={inputClass}
                  maxLength={500}
                  value={values[i] ?? ''}
                  onChange={(e) =>
                    setValues((v) =>
                      v.map((x, j) => (i === j ? e.target.value : x))
                    )
                  }
                />
              </label>
            ))}
            <button
              className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
              type="submit"
              disabled={busy || !write}
            >
              Создать запись
            </button>
          </form>
          <Button
            disabled={busy || !write}
            variant="outline"
            onClick={() => {
              if (window.confirm('Сбросить все тестовые данные?'))
                void action(async () => {
                  setResult(await api.reset(siteId, selected.id));
                  const x = await api.list(siteId);
                  setItems(x.items);
                  setSelected(
                    x.items.find((s) => s.id === selected.id) ?? null
                  );
                });
            }}
          >
            Сбросить данные
          </Button>
          <Button
            disabled={busy || voiceBusy}
            onClick={() =>
              action(async () =>
                setChecks(await api.check(siteId, selected.id))
              )
            }
          >
            Проверить контракт
          </Button>
          {checks && (
            <div>
              <p>{checks.scope}</p>
              <ul>
                {checks.checks.map((c) => (
                  <li key={c.name}>
                    {c.passed ? '✓' : '✗'} {c.name}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p>
            REST API (с авторизацией кабинета):{' '}
            <code className="break-all">
              /qa/sites/{siteId}/stands/{selected.id}/mock/records
            </code>
            . GET — список, POST — создание; DELETE /:recordId — удаление. Тело
            POST: role, values[].
          </p>
          <Button
            variant="outline"
            onClick={() => {
              const blob = new Blob(
                [JSON.stringify(selected.contract, null, 2)],
                { type: 'application/json' }
              );
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'stand-contract.json';
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Экспорт контракта
          </Button>
          <Button
            variant="outline"
            onClick={() => downloadStandOpenApi(siteId, selected)}
          >
            Скачать OpenAPI
          </Button>
          <Button
            disabled={busy || !write}
            variant="outline"
            onClick={() => {
              if (window.confirm('Удалить стенд и все его тестовые данные?'))
                void action(async () => {
                  await api.remove(siteId, selected.id);
                  setItems((v) => v.filter((s) => s.id !== selected.id));
                  setSelected(null);
                });
            }}
          >
            Удалить стенд
          </Button>
          {result && (
            <pre className="overflow-auto" aria-live="polite">
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </Card>
      )}
    </div>
  );
}
