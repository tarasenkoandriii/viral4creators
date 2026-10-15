import { useState } from 'react';
import { Button, Card, inputClass } from '../kit/ui';
import type { createQaStandsApi } from '../lib/qa-stands-api';
import { navigate } from '../lib/router';
export function StandFormDrift({
  api,
  siteId,
  standId,
  write,
}: {
  api: ReturnType<typeof createQaStandsApi>;
  siteId: string;
  standId: string;
  write: boolean;
}) {
  const [baseline, setBaseline] = useState(''),
    [current, setCurrent] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof api.compareForm>
  > | null>(null);
  return (
    <Card>
      <h3 className="font-semibold">Сверка рабочей формы · ранний этап</h3>
      <p>
        Загрузите два снимка структуры. Если форма изменилась, появится
        замечание QA на обновление мока. Сайт не открывается, поля не
        заполняются.
      </p>
      <p>
        В снимках допустимы только описание полей и ограничения. Не добавляйте
        значения, пароли, ключи и cookies.
      </p>
      <details>
        <summary>Подготовить снимки формы</summary>
        <p>
          Пока снимки вводятся вручную. Автоматический сбор из браузера ещё не
          подключён.
        </p>
        <pre className="overflow-auto text-xs">
          {JSON.stringify(
            {
              url: 'https://example.invalid/app',
              version: 'v1',
              fields: [
                {
                  id: 'app_name',
                  type: 'text',
                  required: true,
                  maxLength: 100,
                },
              ],
            },
            null,
            2
          )}
        </pre>
        <label className="block">
          Ожидаемая структура
          <textarea
            className={inputClass}
            value={baseline}
            maxLength={30000}
            onChange={(e) => {
              setBaseline(e.target.value);
              setResult(null);
            }}
          />
        </label>
        <label className="block">
          Текущая структура
          <textarea
            className={inputClass}
            value={current}
            maxLength={30000}
            onChange={(e) => {
              setCurrent(e.target.value);
              setResult(null);
            }}
          />
        </label>
      </details>
      <Button
        disabled={!write || busy || !baseline || !current}
        onClick={async () => {
          setBusy(true);
          setError('');
          setResult(null);
          try {
            setResult(
              await api.compareForm(siteId, standId, {
                baseline: JSON.parse(baseline),
                current: JSON.parse(current),
              })
            );
          } catch (e) {
            setError(
              e instanceof Error ? e.message : 'Не удалось сравнить снимки'
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Сверяем…' : 'Сверить и создать замечание при изменениях'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {result && (
        <div role="status">
          <p>
            {result.blocked
              ? 'Перенос заблокирован: структура изменилась.'
              : 'Проверенные признаки совпадают. Это не разрешение на заполнение формы.'}
          </p>
          {result.changes.length > 0 && (
            <ul>
              {result.changes.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
          {result.findingId && (
            <>
              <p>
                {result.duplicate
                  ? 'Уже существует замечание'
                  : 'Создано замечание'}
                : {result.findingId}
              </p>
              <Button
                variant="outline"
                onClick={() => navigate({ name: 'qa-findings', siteId })}
              >
                Открыть замечания QA
              </Button>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
