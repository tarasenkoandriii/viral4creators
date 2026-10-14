import { useState } from 'react';
import { Button, Card, inputClass } from '../kit/ui';
import type {
  Stand,
  MockResult,
  createQaStandsApi,
} from '../lib/qa-stands-api';
export function GeneratedStandPreview({
  stand,
  api,
  siteId,
  write,
  onDeleted,
}: {
  stand: Stand;
  api: ReturnType<typeof createQaStandsApi>;
  siteId: string;
  write: boolean;
  onDeleted: () => void;
}) {
  const screens = stand.contract.screens ?? [],
    entities = stand.contract.entities ?? [];
  const [screenId, setScreenId] = useState(screens[0]?.id),
    [role, setRole] = useState('viewer'),
    [scenario, setScenario] = useState('normal'),
    [records, setRecords] = useState(stand.records),
    [values, setValues] = useState<string[]>([]),
    [query, setQuery] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<MockResult | null>(null),
    [checks, setChecks] = useState<{
      scope: string;
      checks: Array<{ name: string; passed: boolean }>;
    } | null>(null);
  const screen = screens.find((s) => s.id === screenId),
    entity = entities.find((e) => e.id === screen?.entityId);
  if (!screen || !entity)
    return <p role="alert">Контракт не содержит выбранный экран.</p>;
  const returned =
    result?.status === 200 &&
    result.data &&
    typeof result.data === 'object' &&
    'items' in result.data
      ? (result.data as { items: Stand['records'] }).items
      : records;
  const current = returned.filter(
    (r) =>
      r.entityId === entity.id &&
      r.values.join(' ').toLowerCase().includes(query.toLowerCase())
  );
  async function run(fn: () => Promise<void>) {
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
  async function command(method: string, id?: string) {
    await run(async () => {
      const r = await api.command(siteId, stand.id, {
        method,
        role,
        scenario,
        entityId: entity!.id,
        values: entity!.fields.map((_, i) => values[i] ?? ''),
        query,
        id,
      });
      setResult(r);
      setRecords((await api.get(siteId, stand.id)).records);
      if (r.status === 201 && screen!.nextScreenId) {
        setScreenId(screen!.nextScreenId);
        setValues([]);
      }
    });
  }
  return (
    <Card className="min-w-0 break-words">
      <h2 className="text-lg font-semibold">{stand.contract.title}</h2>
      <p>Сгенерированный тестовый интерфейс · синтетические данные</p>
      <nav className="flex flex-wrap gap-2" aria-label="Экраны стенда">
        {screens.map((s) => (
          <Button
            className="max-w-full break-all"
            variant={s.id === screen.id ? 'solid' : 'outline'}
            key={s.id}
            disabled={busy}
            onClick={() => {
              setScreenId(s.id);
              setResult(null);
              setValues([]);
              setQuery('');
            }}
          >
            {s.title}
          </Button>
        ))}
      </nav>
      <label>
        Демо-роль
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
        Сценарий API
        <select
          className={inputClass}
          value={scenario}
          onChange={(e) => setScenario(e.target.value)}
        >
          {['normal', '500', '429', 'empty'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <h3 className="mt-4 font-semibold">{screen.title}</h3>
      {screen.kind === 'dashboard' ? (
        <p>
          Записей «{entity.title}»:{' '}
          {records.filter((r) => r.entityId === entity.id).length}
        </p>
      ) : screen.kind === 'form' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void command('POST');
          }}
          className="space-y-2"
        >
          {entity.fields.map((f, i) => (
            <label className="block" key={f.name}>
              {f.name}
              {f.required ? ' *' : ''}
              {f.type === 'select' ? (
                <select
                  required={f.required}
                  className={inputClass}
                  value={values[i] ?? ''}
                  onChange={(e) =>
                    setValues((v) =>
                      entity.fields.map((_, j) =>
                        j === i ? e.target.value : (v[j] ?? '')
                      )
                    )
                  }
                >
                  <option value="">Выберите…</option>
                  {f.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <input
                  className={inputClass}
                  type={f.type === 'text' ? 'text' : f.type}
                  step={f.type === 'number' ? 'any' : undefined}
                  required={f.required}
                  maxLength={500}
                  value={values[i] ?? ''}
                  onChange={(e) =>
                    setValues((v) =>
                      entity.fields.map((_, j) =>
                        j === i ? e.target.value : (v[j] ?? '')
                      )
                    )
                  }
                />
              )}
            </label>
          ))}
          <Button type="submit" disabled={busy || !write}>
            Сохранить {entity.title}
          </Button>
        </form>
      ) : (
        <div>
          <label>
            Поиск
            <input
              className={inputClass}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <Button disabled={busy} onClick={() => command('GET')}>
            Загрузить из mock API
          </Button>
          {!current.length && <p>Записей пока нет.</p>}
          <ul>
            {current.map((r) => (
              <li key={r.id} className="break-words my-2">
                {entity.fields
                  .map((f, i) => `${f.name}: ${r.values[i] ?? ''}`)
                  .join(' · ')}
                <Button
                  variant="outline"
                  disabled={busy || !write}
                  onClick={() => {
                    if (window.confirm('Удалить синтетическую запись?'))
                      void command('DELETE', r.id);
                  }}
                >
                  Удалить
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {screen.nextScreenId && (
        <Button
          disabled={busy}
          variant="outline"
          onClick={() => {
            setScreenId(screen.nextScreenId!);
            setValues([]);
          }}
        >
          Перейти: {screens.find((s) => s.id === screen.nextScreenId)?.title}
        </Button>
      )}
      <div className="mt-4">
        <Button
          disabled={busy}
          onClick={() =>
            run(async () => setChecks(await api.check(siteId, stand.id)))
          }
        >
          Проверить все сущности
        </Button>
        <Button
          disabled={busy || !write}
          variant="outline"
          onClick={() => {
            if (window.confirm('Сбросить синтетические данные стенда?'))
              void run(async () => {
                setResult(await api.reset(siteId, stand.id));
                setRecords((await api.get(siteId, stand.id)).records);
              });
          }}
        >
          Сбросить данные
        </Button>
      </div>
      {stand.contract.assumptions?.length ? (
        <div>
          <h3>Допущения и ограничения</h3>
          <ul>
            {stand.contract.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {error && <p role="alert">{error}</p>}
      {result && (
        <pre className="overflow-auto" aria-live="polite">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
      {checks && (
        <div>
          <p>{checks.scope}</p>
          {checks.checks.map((c) => (
            <p key={c.name}>
              {c.passed ? '✓' : '✗'} {c.name}
            </p>
          ))}
        </div>
      )}
      <Button
        variant="outline"
        onClick={() => {
          const blob = new Blob([JSON.stringify(stand.contract, null, 2)], {
            type: 'application/json',
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'generated-stand-contract.json';
          a.click();
          URL.revokeObjectURL(url);
        }}
      >
        Экспорт контракта
      </Button>
      <Button
        disabled={busy || !write}
        variant="outline"
        onClick={() => {
          if (window.confirm('Удалить стенд и его синтетические данные?'))
            void run(async () => {
              await api.remove(siteId, stand.id);
              onDeleted();
            });
        }}
      >
        Удалить стенд
      </Button>
      <details>
        <summary>Контракт UI и API</summary>
        <pre className="overflow-auto">
          {JSON.stringify(stand.contract, null, 2)}
        </pre>
        <p>
          REST /qa/sites/{siteId}/stands/{stand.id}/mock/records?entity=
          {entity.id}. Для POST передайте entityId, role, values; GET/DELETE
          используют query entity.
        </p>
      </details>
    </Card>
  );
}
