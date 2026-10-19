import { useState } from 'react';
import { ApiError } from '../kit';
import { Button, Card, inputClass } from '../kit/ui';
import { useAssist } from '../lib/assist-context';
import {
  exportQaCsv,
  parseQaCsv,
  requirementLinks,
  type CsvQaCase,
} from '../lib/qa-catalog-csv';
export function QaCatalogTools({
  siteId,
  write,
  onImported,
}: {
  siteId: string;
  write: boolean;
  onImported: () => void;
}) {
  const { qaCatalog: api } = useAssist();
  const [search, setSearch] = useState(''),
    [rows, setRows] = useState<CsvQaCase[] | null>(null),
    [truncated, setTruncated] = useState(false),
    [preview, setPreview] = useState<CsvQaCase[] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
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
          : e instanceof Error
            ? e.message
            : 'Не удалось обработать каталог.'
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <details>
        <summary>Поиск, CSV и связи требований</summary>
        <div className="space-y-2 mt-2">
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          <label className="block">
            Поиск по ключу или названию
            <input
              className={inputClass}
              maxLength={100}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              disabled={busy}
            />
          </label>
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const p = await api.inventory(siteId, search);
                setRows(p.items);
                setTruncated(p.truncated);
              })
            }
          >
            Найти кейсы
          </Button>
          {rows && (
            <>
              <p>
                Найдено: {rows.length}
                {truncated ? ' (выборка неполная — уточните поиск)' : ''}.
                Архивные кейсы не включены.
              </p>
              {rows.map((c) => (
                <p key={c.caseKey}>
                  <strong>{c.caseKey}</strong> · {c.payload.title} ·{' '}
                  {c.payload.type === 'manual' ? 'ручной' : 'автоматический'}
                </p>
              ))}
              <Button
                variant="outline"
                disabled={busy || truncated || !rows.length}
                onClick={() => {
                  const csv = exportQaCsv(rows);
                  if (new TextEncoder().encode(csv).length > 512 * 1024) {
                    setError(
                      'Выгрузка больше 512 КиБ. Уточните поиск и выгружайте каталог частями.'
                    );
                    return;
                  }
                  const url = URL.createObjectURL(
                    new Blob([csv], {
                      type: 'text/csv;charset=utf-8',
                    })
                  );
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'qa-catalog.csv';
                  a.click();
                  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                Скачать найденные кейсы CSV
              </Button>
              <h3 className="font-semibold">Связанные требования</h3>
              <p className="text-sm">
                Это связи в найденных кейсах, а не подтверждение прохождения и
                не полный реестр требований продукта. Без требований:{' '}
                {rows.filter((c) => !c.payload.requirementIds.length).length}.
              </p>
              {requirementLinks(rows).map((r) => (
                <p key={r.requirement}>
                  {r.requirement}: ручные — {r.manual.join(', ') || 'нет'};
                  автоматические — {r.automated.join(', ') || 'нет'}.
                </p>
              ))}
            </>
          )}
          {write && (
            <div className="space-y-2">
              <h3 className="font-semibold">Импорт CSV</h3>
              <p className="text-sm">
                Используйте формат выгрузки каталога: UTF-8, разделитель —
                запятая. До 100 кейсов и 512 КиБ. Сначала предпросмотр, затем
                явный импорт. Существующие ключи не перезаписываются; конфликт
                отменяет всю пачку. Не включайте секреты и данные клиентов.
              </p>
              <label className="block">
                CSV каталога
                <input
                  type="file"
                  accept=".csv,text/csv"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.currentTarget.value = '';
                    setPreview(null);
                    if (file)
                      void act(async () => {
                        if (file.size > 512 * 1024)
                          throw new Error('CSV больше 512 КиБ.');
                        setPreview(parseQaCsv(await file.text()));
                      });
                  }}
                />
              </label>
              {preview && (
                <>
                  <p>Предпросмотр: {preview.length} кейсов.</p>
                  {preview.map((c) => (
                    <p key={c.caseKey}>
                      {c.caseKey} · {c.payload.title} · шагов:{' '}
                      {c.payload.steps.length}
                    </p>
                  ))}
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const r = await api.importCases(siteId, preview);
                        setNotice(
                          r.replayed
                            ? 'Эта пачка уже импортирована; дубликаты не созданы.'
                            : `Импортировано: ${r.created}.`
                        );
                        setPreview(null);
                        setRows(null);
                        onImported();
                      })
                    }
                  >
                    Импортировать {preview.length} кейсов
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </details>
    </Card>
  );
}
