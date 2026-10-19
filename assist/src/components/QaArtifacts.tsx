import { useEffect, useState, useRef } from 'react';
import { ApiError } from '../kit';
import { Button } from '../kit/ui';
import { useAssist } from '../lib/assist-context';
import type { QaArtifact } from '../lib/qa-findings-api';
function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () =>
      reject(new Error('Не удалось прочитать PNG. Выберите файл повторно.'));
    r.readAsDataURL(file);
  });
}
export function QaArtifacts({
  siteId,
  findingId,
  write,
  onAttach,
}: {
  siteId: string;
  findingId: string;
  write: boolean;
  onAttach: (text: string) => void;
}) {
  const { qaFindings: api } = useAssist();
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<QaArtifact[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [file, setFile] = useState<File | null>(null),
    [redacted, setRedacted] = useState(false),
    [requestId, setRequestId] = useState(() => crypto.randomUUID()),
    [links, setLinks] = useState<
      Record<string, { url: string; validUntil: string }>
    >({});
  useEffect(() => {
    let active = true;
    api
      .artifacts(siteId, findingId)
      .then((r) => {
        if (active) setRows(r);
      })
      .catch(() => {
        if (active) setError('Не удалось загрузить файлы доказательств.');
      });
    return () => {
      active = false;
    };
  }, [api, siteId, findingId]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof ApiError || e instanceof Error
          ? e.message
          : 'Не удалось обработать доказательство. Обновите список перед повтором.'
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-2" aria-label="Приватные файлы доказательств">
      <h3 className="font-semibold">Приватные файлы доказательств</h3>
      <p className="text-sm">
        PNG RGB/RGBA или серый 8-bit без анимации, до 2 МБ, максимум 10 файлов.
        Метаданные изображения удаляются. Хранение — 30 дней; после удаления или
        истечения срока файл недоступен. Ссылку на чтение получат только
        участники QA этого кабинета; она действует до 5 минут. Не пересылайте её
        посторонним.
      </p>
      {error && <p role="alert">{error}</p>}
      {rows.map((row) => (
        <div key={row.id} className="rounded border p-2 space-y-1 break-all">
          <p>
            PNG · замечание v{row.findingRevision} · {row.bytes} байт · до{' '}
            {row.expiresAt}
          </p>
          <p>
            SHA-256: <code>{row.sha256}</code>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const link = await api.artifactLink(
                    siteId,
                    findingId,
                    row.id
                  );
                  setLinks((old) => ({ ...old, [row.id]: link }));
                })
              }
            >
              Получить ссылку
            </Button>
            {links[row.id] &&
              new Date(links[row.id].validUntil).getTime() > Date.now() && (
                <a
                  href={links[row.id].url}
                  target="_blank"
                  rel="noreferrer"
                  referrerPolicy="no-referrer"
                >
                  Открыть PNG (до 5 минут)
                </a>
              )}
            {write && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  onAttach(
                    `artifact:${row.id}; sha256:${row.sha256}; finding:v${row.findingRevision}; expires:${row.expiresAt}`
                  )
                }
              >
                Добавить к описанию доказательств
              </Button>
            )}
            {write && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      'Удалить файл доказательства навсегда? Ссылка в истории останется, но файл будет недоступен.'
                    )
                  )
                    void act(async () => {
                      await api.removeArtifact(siteId, findingId, row.id);
                      setRows((old) => old.filter((x) => x.id !== row.id));
                      setLinks((old) => {
                        const next = { ...old };
                        delete next[row.id];
                        return next;
                      });
                    });
                }}
              >
                Удалить файл
              </Button>
            )}
          </div>
        </div>
      ))}
      {write && (
        <div className="space-y-2">
          <label className="block">
            PNG-доказательство
            <input
              ref={inputRef}
              className="block"
              type="file"
              accept="image/png"
              disabled={busy}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setRedacted(false);
                setRequestId(crypto.randomUUID());
              }}
            />
          </label>
          <label className="block">
            <input
              type="checkbox"
              checked={redacted}
              disabled={busy}
              onChange={(e) => setRedacted(e.target.checked)}
            />{' '}
            Я проверил(а) изображение: в нём нет паролей, токенов, персональных
            и конфиденциальных данных.
          </label>
          <Button
            disabled={busy || !file || !redacted || rows.length >= 10}
            onClick={() =>
              void act(async () => {
                if (
                  !file ||
                  !redacted ||
                  file.type !== 'image/png' ||
                  file.size > 2 * 1024 * 1024
                )
                  throw new Error(
                    'Выберите PNG до 2 МБ и подтвердите отсутствие конфиденциальных данных.'
                  );
                const row = await api.uploadArtifact(
                  siteId,
                  findingId,
                  requestId,
                  await base64(file)
                );
                setRows((old) => [row, ...old.filter((x) => x.id !== row.id)]);
                if (inputRef.current) inputRef.current.value = '';
                setFile(null);
                setRedacted(false);
                setRequestId(crypto.randomUUID());
              })
            }
          >
            Загрузить приватно
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act(async () =>
                setRows(await api.artifacts(siteId, findingId))
              )
            }
          >
            Обновить файлы
          </Button>
        </div>
      )}
    </section>
  );
}
