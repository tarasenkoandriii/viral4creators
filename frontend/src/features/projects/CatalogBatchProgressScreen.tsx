/**
 * CatalogBatchProgressScreen — статус партии (ТЗ §44, этап 65). Опрашивает
 * `GET /projects/:projectId/catalog-batch/:batchId`, который сам читает
 * состояние живьём из сессий (см. `CatalogBatchService.getStatus`) — этот
 * экран только отображает то, что вернул сервер, никакой своей логики
 * статусов.
 *
 * Интервал опроса — 8 секунд: воркер партии тикает кроном раз в 1-2
 * минуты (backend/vercel.json), опрашивать чаще самого воркера смысла
 * нет, а `setTimeout`-цепочка (не `setInterval`) не даёт тикам наложиться
 * друг на друга, если ответ вдруг задержится.
 */

import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Clapperboard,
  Circle,
  ImageOff,
  Loader2,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { Alert, Badge, Card, Spinner } from '../../components/ui';
import {
  getCatalogBatch,
  retryCatalogBatch,
} from '../../services/catalog-batch-api';
import { errorMessage } from '../../services/projects-api';
import type {
  CatalogBatchItemStatus,
  CatalogBatchStatusView,
} from '../../types';
import { navigate, routes } from '../../lib/router';
import { useI18n } from '../../lib/i18n-context';
import { ScreenHeader } from './shared';

const POLL_MS = 8000;

function statusMeta(
  status: CatalogBatchItemStatus,
  dict: ReturnType<typeof useI18n>['dict']
) {
  switch (status) {
    case 'PENDING':
      return {
        label: dict.catalogBatch.statusPending,
        icon: <Circle size={16} className="text-silver-400" />,
        tone: undefined,
      };
    // Найдено при аудите (ТЗ §13, этап 2 плана §14): без этой ветки
    // `switch` не покрывал `BATCH_QUEUED` (Grok-строки, ждущие подачи
    // как одна пачка) — функция возвращала `undefined`, и экран падал
    // при деструктуризации `{label, icon, tone}` на первой же такой
    // строке. С точки зрения пользователя это та же категория
    // «ожидание», что и PENDING — тот же ярлык и иконка.
    case 'BATCH_QUEUED':
      return {
        label: dict.catalogBatch.statusPending,
        icon: <Circle size={16} className="text-silver-400" />,
        tone: undefined,
      };
    case 'GENERATING':
      return {
        label: dict.catalogBatch.statusGenerating,
        icon: <Loader2 size={16} className="animate-spin text-accent" />,
        tone: 'warning' as const,
      };
    case 'DONE':
      return {
        label: dict.catalogBatch.statusDone,
        icon: <CheckCircle2 size={16} className="text-emerald-500" />,
        tone: 'success' as const,
      };
    case 'FAILED':
      return {
        label: dict.catalogBatch.statusFailed,
        icon: <XCircle size={16} className="text-rose-500" />,
        tone: 'danger' as const,
      };
    default:
      // Защита от будущего значения статуса, для которого забудут
      // добавить ветку сюда — тот же принцип, что уже применён для
      // 'BATCH_QUEUED' выше: лучше показать «ожидание», чем уронить
      // весь экран прогресса на одной строке.
      return {
        label: dict.catalogBatch.statusPending,
        icon: <Circle size={16} className="text-silver-400" />,
        tone: undefined,
      };
  }
}

export function CatalogBatchProgressScreen({
  projectId,
  batchId,
}: {
  projectId: string;
  batchId: string;
}) {
  const { dict } = useI18n();
  const [status, setStatus] = useState<CatalogBatchStatusView | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [retryError, setRetryError] = useState<unknown>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryingAll, setRetryingAll] = useState(false);
  // Е-2.4 шестого аудита: массовый повтор молча исключает товары, занятые
  // ДРУГОЙ активной партией (сервер не роняет весь запрос из-за них) — без
  // этого уведомления пользователь не узнал бы, почему часть строк не
  // вернулась в очередь.
  const [retrySkippedBusy, setRetrySkippedBusy] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  const aliveRef = useRef(true);
  // Стабильная ссылка на актуальный `poll` из эффекта ниже — нужна,
  // чтобы повтор (retryItem/retryAll) мог возобновить тот же
  // самопланирующийся цикл опроса, а не заводить второй, независимый.
  const pollRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    aliveRef.current = true;
    const poll = () => {
      if (timer.current) window.clearTimeout(timer.current);
      getCatalogBatch(projectId, batchId)
        .then((r) => {
          if (!aliveRef.current) return;
          setStatus(r);
          setLoadError(null);
          // Ещё есть что ждать — очередь или рендер — планируем следующий
          // тик; всё завершилось (done+failed == total) — опрос сам
          // останавливается, дальше сервер уже нечего сообщить нового
          // (до следующего вызова poll() — например, после retry, ниже).
          const active = r.summary.pending > 0 || r.summary.generating > 0;
          timer.current = active ? window.setTimeout(poll, POLL_MS) : undefined;
        })
        .catch((e) => {
          if (!aliveRef.current) return;
          setLoadError(e);
          // Пятый аудит, Д-5.3: раньше опрос на этом останавливался
          // навсегда — одна транзиентная сетевая ошибка "замораживала"
          // прогресс так, что дальнейшие успешные тики уже не могли его
          // разморозить (следующий setTimeout никто не планировал).
          // Показываем ошибку, но следующий тик всё равно планируем —
          // как только сеть отойдёт, опрос сам восстановится и ошибка
          // очистится веткой .then выше.
          timer.current = window.setTimeout(poll, POLL_MS);
        });
    };
    pollRef.current = poll;
    poll();
    return () => {
      aliveRef.current = false;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [projectId, batchId]);

  const openResult = (sessionId: string) => {
    localStorage.setItem('sessionId', sessionId);
    navigate(routes.generate());
  };

  // Точечный/массовый повтор FAILED-строк (Д-1.3, этап 74). Строка(и)
  // после повтора уходят в PENDING — `pollRef.current()` сразу же
  // перечитывает статус и, если опрос уже успел остановиться (все
  // строки были done+failed), возобновляет его самопланирующийся цикл.
  const retryItem = (productItemId: string) => {
    setRetryError(null);
    setRetrySkippedBusy(0);
    setRetryingId(productItemId);
    retryCatalogBatch(projectId, batchId, productItemId)
      .then(() => pollRef.current())
      .catch((e) => aliveRef.current && setRetryError(e))
      .finally(() => aliveRef.current && setRetryingId(null));
  };

  const retryAll = () => {
    setRetryError(null);
    setRetrySkippedBusy(0);
    setRetryingAll(true);
    retryCatalogBatch(projectId, batchId)
      .then((r) => {
        if (aliveRef.current) setRetrySkippedBusy(r.skippedBusy.length);
        pollRef.current();
      })
      .catch((e) => aliveRef.current && setRetryError(e))
      .finally(() => aliveRef.current && setRetryingAll(false));
  };

  if (!status && !loadError) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={28} />
      </div>
    );
  }

  return (
    <div className="animate-fadeIn">
      <ScreenHeader
        title={dict.catalogBatch.progressTitle}
        back={routes.project(projectId)}
        hint={dict.catalogBatch.progressHint}
      />

      {loadError !== null && (
        <Alert tone="error" className="mb-3">
          {errorMessage(loadError)}
        </Alert>
      )}

      {retryError !== null && (
        <Alert tone="error" className="mb-3">
          {dict.catalogBatch.retryError}: {errorMessage(retryError)}
        </Alert>
      )}

      {retrySkippedBusy > 0 && (
        <Alert tone="info" className="mb-3">
          {dict.catalogBatch.retrySkippedBusy.replace(
            '{{count}}',
            String(retrySkippedBusy)
          )}
        </Alert>
      )}

      {status && (
        <>
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-xs text-silver-400 tabular">
              {dict.catalogBatch.summaryLabel
                .replace('{{done}}', String(status.summary.done))
                .replace('{{total}}', String(status.items.length))}
              {status.summary.failed > 0 &&
                ` · ${dict.catalogBatch.summaryFailed.replace(
                  '{{count}}',
                  String(status.summary.failed)
                )}`}
            </p>
            {status.summary.failed > 0 && (
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-accent disabled:opacity-50"
                disabled={retryingAll || retryingId !== null}
                onClick={retryAll}
              >
                {retryingAll ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RotateCcw size={12} />
                )}
                {dict.catalogBatch.retryAllButton}
              </button>
            )}
          </div>

          <div className="space-y-2">
            {status.items.map((item) => {
              const meta = statusMeta(item.status, dict);
              const openable = item.status === 'DONE' && item.sessionId;
              const isRetryingThis = retryingId === item.productItemId;
              return (
                <Card
                  key={item.productItemId}
                  className={`flex items-center gap-3 p-3 ${
                    openable ? 'cursor-pointer hover:border-accent/60' : ''
                  }`}
                  onClick={() =>
                    openable && item.sessionId && openResult(item.sessionId)
                  }
                >
                  <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-silver-200/60 dark:bg-silver-800/60 grid place-items-center text-silver-400">
                    {item.photoUrl ? (
                      <img
                        src={item.photoUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <ImageOff size={16} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">
                      {item.title ?? dict.catalogBatch.itemFallback}
                    </div>
                    {item.status === 'FAILED' && item.error && (
                      <div className="truncate text-xs text-rose-500">
                        {item.error}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {meta.tone ? (
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-silver-400">
                        {meta.icon} {meta.label}
                      </span>
                    )}
                    {openable && (
                      <Clapperboard size={14} className="text-accent" />
                    )}
                    {item.status === 'FAILED' && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold text-accent disabled:opacity-50"
                        disabled={isRetryingThis || retryingAll}
                        onClick={(e) => {
                          e.stopPropagation();
                          retryItem(item.productItemId);
                        }}
                      >
                        {isRetryingThis ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <RotateCcw size={12} />
                        )}
                        {dict.catalogBatch.retryItemButton}
                      </button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
