import { useState } from 'react';
import { Button, Card, inputClass } from '../kit/ui';
import {
  parseFormSnapshot,
  transferable,
  type FormSnapshot,
  type TransferField,
} from '../lib/stand-transfer';
export function StandTransferPlan({
  standId,
  recordId,
  recordVersion,
  fields,
  values,
  stateField,
}: {
  standId: string;
  recordId: string;
  recordVersion: number;
  fields: TransferField[];
  values: string[];
  stateField?: string;
}) {
  const [snapshot, setSnapshot] = useState<FormSnapshot | null>(null),
    [url, setUrl] = useState(''),
    [formIndex, setFormIndex] = useState(0),
    [mapping, setMapping] = useState<Record<number, string>>({}),
    [reviewed, setReviewed] = useState(false),
    [error, setError] = useState('');
  const entries = fields.flatMap((field, i) =>
    mapping[i] && transferable(field, values[i] ?? '', stateField)
      ? [{ targetId: mapping[i], sourceName: field.name, value: values[i] }]
      : []
  );
  return (
    <Card>
      <h4 className="font-semibold">План переноса в рабочую форму</h4>
      <p>
        Выберите снимок целевой формы и сопоставьте поля. В файл попадут только
        выбранные данные. Расширение покажет фактические изменения и потребует
        отдельную команду заполнения.
      </p>
      <p>
        Поддержаны простые HTML-поля text/email/number/url. Пароли, MOCK-ключи,
        служебные URL, файлы, списки и состояния workflow исключены. React/Vue и
        другие управляемые формы требуют отдельного адаптера.
      </p>
      <label className="block">
        Снимок целевой формы
        <input
          type="file"
          accept=".json,application/json"
          onChange={async (e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            setReviewed(false);
            setError('');
            setSnapshot(null);
            setMapping({});
            if (!file) return;
            try {
              if (file.size > 30000) throw new Error('Файл больше 30 КБ');
              const x = parseFormSnapshot(JSON.parse(await file.text()));
              setSnapshot(x);
              setUrl(x.url);
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Ошибка файла');
            }
          }}
        />
      </label>
      {snapshot && (
        <>
          <label className="block">
            Полный безопасный адрес формы
            <input
              className={inputClass}
              type="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setReviewed(false);
              }}
            />
          </label>
          <label className="block">
            Номер формы (с нуля)
            <input
              className={inputClass}
              type="number"
              min="0"
              max="99"
              value={formIndex}
              onChange={(e) => {
                setFormIndex(Number(e.target.value));
                setReviewed(false);
              }}
            />
          </label>
          {fields.map(
            (field, i) =>
              transferable(field, values[i] ?? '', stateField) && (
                <label className="block" key={field.name}>
                  {field.name}: {values[i]}
                  <select
                    className={inputClass}
                    value={mapping[i] ?? ''}
                    onChange={(e) => {
                      setMapping({ ...mapping, [i]: e.target.value });
                      setReviewed(false);
                    }}
                  >
                    <option value="">Не переносить</option>
                    {snapshot.fields
                      .filter((f) =>
                        ['text', 'email', 'number', 'url'].includes(f.type)
                      )
                      .map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.id} · {f.type}
                        </option>
                      ))}
                  </select>
                </label>
              )
          )}
          <p>
            Идентификаторы непрозрачные. Сверьте назначение полей в
            предпросмотре расширения; не заполняйте форму при неоднозначности.
          </p>
          <label>
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />{' '}
            Проверил(а) адрес и выбранные данные; в них нет ключей, паролей и
            служебных заглушек.
          </label>
          <Button
            disabled={!reviewed || !entries.length}
            onClick={() => {
              setError('');
              try {
                const target = new URL(url);
                if (
                  target.protocol !== 'https:' ||
                  target.username ||
                  target.password ||
                  target.search ||
                  target.hash
                )
                  throw new Error('Проверьте безопасный HTTPS адрес');
                if (
                  !Number.isInteger(formIndex) ||
                  formIndex < 0 ||
                  formIndex > 99 ||
                  new Set(entries.map((x) => x.targetId)).size !==
                    entries.length
                )
                  throw new Error(
                    'Поля назначения должны быть разными; проверьте номер формы'
                  );
                const plan = {
                  version: 1,
                  source: { standId, recordId, recordVersion },
                  target: {
                    url: target.href,
                    formIndex,
                    fields: snapshot.fields,
                  },
                  entries,
                };
                const link = document.createElement('a'),
                  blob = URL.createObjectURL(
                    new Blob([JSON.stringify(plan, null, 2)], {
                      type: 'application/json',
                    })
                  );
                link.href = blob;
                link.download = 'qa-form-transfer.json';
                link.click();
                setTimeout(() => URL.revokeObjectURL(blob), 1000);
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : 'Не удалось подготовить план'
                );
              }
            }}
          >
            Скачать выбранные данные для переноса
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </Card>
  );
}
