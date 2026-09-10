/**
 * LibraryPicker — третий путь выбрать сценарий (spec §21, этап 24), рядом
 * с поиском по YouTube и загрузкой файла: готовые разборы из библиотеки
 * сервиса, отранжированные под аудиторию и категорию ТОВАРА этой сессии.
 *
 * Почему это быстрее двух других путей: разбор уже сделан — Gemini
 * повторно не вызывается вообще, мастер сразу открывается на шаге
 * «Анализ». Оценка совпадения считается на сервере простой формулой
 * (категория / пол / возраст / интересы), поэтому карточка честно
 * показывает, ПОЧЕМУ сценарий предложен.
 *
 * Приватные записи (§21.3) — разборы собственных загруженных файлов —
 * видит только их автор и с явной пометкой: чтобы никто не думал, что его
 * ролик попал в общую выдачу.
 */

import { useEffect, useState } from 'react';
import {
  Library,
  Lock,
  Play,
  RefreshCw,
  Sparkles,
  UsersRound,
} from 'lucide-react';
import { Alert, Badge, Button, Spinner } from './ui';
import { errorMessage, recommendFromLibrary } from '../services/projects-api';
import { genderLabel, scoreColor } from '../lib/audience';
import type { LibraryRecommendation } from '../types';
import { useI18n } from '../lib/i18n-context';

export function LibraryPicker({
  sessionId,
  onPick,
  disabled,
  hasProduct,
}: {
  sessionId: string | null;
  /** Взять разбор в работу — мастер перейдёт на шаг «Анализ». */
  onPick: (entryId: string) => void;
  disabled?: boolean;
  /** Без товара рекомендации не ранжируются — предупреждаем честно. */
  hasProduct: boolean;
}) {
  const { dict } = useI18n();
  const [items, setItems] = useState<LibraryRecommendation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    if (!sessionId) return;
    setError(null);
    recommendFromLibrary(sessionId)
      .then(setItems)
      .catch((e) => {
        setItems([]);
        setError(errorMessage(e));
      });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  if (!sessionId || items === null) {
    return (
      <div className="flex justify-center py-6">
        {error ? <Alert tone="error">{error}</Alert> : <Spinner size={20} />}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-xs text-silver-400">
          {hasProduct
            ? dict.libraryPicker.introWithProduct
            : dict.libraryPicker.introWithoutProduct}
        </p>
        <button
          type="button"
          aria-label={dict.libraryPicker.refresh}
          onClick={load}
          disabled={disabled}
          className="ml-auto shrink-0 rounded-lg p-1.5 text-silver-400 hover:text-accent disabled:opacity-50"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {error && (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-silver-300 p-4 text-center text-xs text-silver-400 dark:border-silver-700">
          {dict.libraryPicker.emptyLibrary}
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((it) => (
            <li
              key={it.id}
              className="flex gap-3 rounded-xl border border-silver-200/70 p-2.5 dark:border-silver-800"
            >
              <div className="relative h-16 w-24 shrink-0 overflow-hidden rounded-lg bg-silver-200/60 dark:bg-silver-800/60">
                {it.thumbnailUrl ? (
                  <img
                    src={it.thumbnailUrl}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="grid h-full place-items-center text-silver-400">
                    <Library size={18} />
                  </div>
                )}
                {it.aspectRatio && (
                  <span className="absolute bottom-1 left-1 rounded bg-silver-950/70 px-1 font-mono text-[11px] text-white tabular">
                    {it.aspectRatio}
                  </span>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  {it.own && it.visibility === 'PRIVATE' && (
                    <Badge>
                      <Lock size={9} /> {dict.libraryPicker.privateOnlyYours}
                    </Badge>
                  )}
                  {it.category && <Badge tone="accent">{it.category}</Badge>}
                  {it.audienceAgeRange && <Badge>{it.audienceAgeRange}</Badge>}
                  {it.audienceGender && (
                    <Badge>
                      {genderLabel(
                        it.audienceGender,
                        dict.audience.genderLabels
                      )}
                    </Badge>
                  )}
                  <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-silver-400">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${scoreColor(it.score)}`}
                    />
                    {it.score}/100
                  </span>
                </div>
                <p className="mt-1 truncate text-xs font-medium">
                  {it.title ?? dict.libraryPicker.untitledAnalysis}
                </p>
                <p className="mt-0.5 line-clamp-2 text-[11px] text-silver-400">
                  {it.reasons.length > 0
                    ? it.reasons.join(' · ')
                    : dict.libraryPicker.noAudienceMatch}
                </p>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] text-silver-400">
                    <Sparkles size={10} /> {it.sceneCount}
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] text-silver-400">
                    <UsersRound size={10} /> {it.characterCount}
                  </span>
                  {it.sourceUrl && (
                    <a
                      href={it.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] text-accent underline"
                    >
                      <Play size={10} /> {dict.libraryPicker.original}
                    </a>
                  )}
                  <Button
                    size="sm"
                    className="ml-auto"
                    loading={busy === it.id}
                    disabled={disabled || busy !== null}
                    onClick={() => {
                      setBusy(it.id);
                      onPick(it.id);
                    }}
                  >
                    {dict.libraryPicker.take}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
