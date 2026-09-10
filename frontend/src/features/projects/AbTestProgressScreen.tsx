/**
 * AbTestProgressScreen — статус запуска A/B-вариантов (TODO §III.6, этап
 * 66). Опрашивает `GET /projects/:projectId/ab-test/:runId`, который сам
 * читает состояние живьём из сессий (см. `AbTestService.getStatus`) —
 * этот экран только отображает то, что вернул сервер, никакой своей
 * логики статусов. Список из 3 карточек — по одной на вариант хук+CTA,
 * без отдельного «start»-экрана (нечего выбирать, см. AbTestPanel).
 *
 * Интервал опроса — 8 секунд, тот же приём, что у CatalogBatchProgressScreen
 * (этап 65): воркер тикает кроном раз в 1-2 минуты (backend/vercel.json),
 * опрашивать чаще самого воркера смысла нет, а `setTimeout`-цепочка (не
 * `setInterval`) не даёт тикам наложиться друг на друга, если ответ вдруг
 * задержится.
 */

import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Clapperboard,
  Circle,
  Loader2,
  SplitSquareHorizontal,
  XCircle,
} from 'lucide-react';
import { Alert, Badge, Card, Spinner } from '../../components/ui';
import { getAbTest } from '../../services/ab-test-api';
import { errorMessage } from '../../services/projects-api';
import type { AbTestStatusView, AbTestVariantStatus } from '../../types';
import { navigate, routes } from '../../lib/router';
import { useI18n } from '../../lib/i18n-context';
import { ScreenHeader } from './shared';

const POLL_MS = 8000;

function statusMeta(
  status: AbTestVariantStatus,
  dict: ReturnType<typeof useI18n>['dict']
) {
  switch (status) {
    case 'PENDING':
      return {
        label: dict.abTest.statusPending,
        icon: <Circle size={16} className="text-silver-400" />,
        tone: undefined,
      };
    case 'GENERATING':
      return {
        label: dict.abTest.statusGenerating,
        icon: <Loader2 size={16} className="animate-spin text-accent" />,
        tone: 'warning' as const,
      };
    case 'DONE':
      return {
        label: dict.abTest.statusDone,
        icon: <CheckCircle2 size={16} className="text-emerald-500" />,
        tone: 'success' as const,
      };
    case 'FAILED':
      return {
        label: dict.abTest.statusFailed,
        icon: <XCircle size={16} className="text-rose-500" />,
        tone: 'danger' as const,
      };
  }
}

export function AbTestProgressScreen({
  projectId,
  runId,
}: {
  projectId: string;
  runId: string;
}) {
  const { dict } = useI18n();
  const [status, setStatus] = useState<AbTestStatusView | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const poll = () => {
      getAbTest(projectId, runId)
        .then((r) => {
          if (!alive) return;
          setStatus(r);
          setLoadError(null);
          // Ещё есть что ждать — очередь или рендер — планируем следующий
          // тик; всё завершилось (done+failed == total) — опрос сам
          // останавливается, дальше сервер уже нечего сообщить нового.
          const active = r.summary.pending > 0 || r.summary.generating > 0;
          if (active) timer.current = window.setTimeout(poll, POLL_MS);
        })
        .catch((e) => {
          if (!alive) return;
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
    poll();
    return () => {
      alive = false;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [projectId, runId]);

  const openResult = (sessionId: string) => {
    localStorage.setItem('sessionId', sessionId);
    navigate(routes.generate());
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
        title={dict.abTest.progressTitle}
        back={routes.project(projectId)}
        hint={dict.abTest.progressHint}
      />

      {loadError !== null && (
        <Alert tone="error" className="mb-3">
          {errorMessage(loadError)}
        </Alert>
      )}

      {status && (
        <>
          <p className="mb-3 text-xs text-silver-400 tabular">
            {dict.abTest.summaryLabel
              .replace('{{done}}', String(status.summary.done))
              .replace('{{total}}', String(status.variants.length))}
            {status.summary.failed > 0 &&
              ` · ${dict.abTest.summaryFailed.replace(
                '{{count}}',
                String(status.summary.failed)
              )}`}
          </p>

          <div className="space-y-2">
            {status.variants.map((variant) => {
              const meta = statusMeta(variant.status, dict);
              const openable = variant.status === 'DONE' && variant.sessionId;
              return (
                <Card
                  key={variant.variantId}
                  className={`flex items-center gap-3 p-3 ${
                    openable ? 'cursor-pointer hover:border-accent/60' : ''
                  }`}
                  onClick={() =>
                    openable &&
                    variant.sessionId &&
                    openResult(variant.sessionId)
                  }
                >
                  <div className="h-12 w-12 shrink-0 grid place-items-center rounded-lg bg-silver-200/60 text-silver-400 dark:bg-silver-800/60">
                    <SplitSquareHorizontal size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">
                      {variant.hookLabel}
                    </div>
                    <div className="truncate text-xs text-silver-400">
                      {variant.ctaLabel}
                    </div>
                    {variant.status === 'FAILED' && variant.error && (
                      <div className="truncate text-xs text-rose-500">
                        {variant.error}
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
