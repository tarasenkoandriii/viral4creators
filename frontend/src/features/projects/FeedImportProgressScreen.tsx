/**
 * FeedImportProgressScreen — статус импорта товарного фида (TODO
 * §Уровень 2 п.8, этап 68, §47). Опрашивает
 * `GET /projects/:projectId/feed-imports/:runId`, который отдаёт то,
 * что воркер уже накопил в самой строке запуска (не живой пересчёт, в
 * отличие от catalog-batch/ab-test — см. product-feed-import.service.ts)
 * — этот экран только отображает счётчики и проблемные строки, никакой
 * своей логики статусов.
 *
 * Интервал опроса — 8 секунд, тот же приём, что у
 * CatalogBatchProgressScreen/AbTestProgressScreen: крон тикает раз в
 * 1-2 минуты (backend/vercel.json), опрашивать чаще самого воркера
 * смысла нет.
 *
 * Список строк рендерится только для проблемных (SKIPPED/FAILED, с
 * причиной) — успешно заведённые товары не нужно перечислять по одному,
 * их и так видно в списке проекта; при сотнях строк рендерить все было
 * бы лишней нагрузкой ради информации, которая никого не интересует.
 */

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  PackageCheck,
  Rss,
} from 'lucide-react';
import { Alert, Badge, Button, Card, Spinner } from '../../components/ui';
import { getFeedImport } from '../../services/product-feed-import-api';
import { errorMessage } from '../../services/projects-api';
import type { FeedImportStatusView } from '../../types';
import { navigate, routes } from '../../lib/router';
import { useI18n } from '../../lib/i18n-context';
import { ScreenHeader } from './shared';

const POLL_MS = 8000;
/** Проблемных строк в списке — с запасом сверх любого разумного экрана,
 * но не все 500 сразу: длинный список ничего не объясняет лучше, чем
 * первые полсотни причин. */
const MAX_PROBLEM_ROWS = 50;

export function FeedImportProgressScreen({
  projectId,
  runId,
}: {
  projectId: string;
  runId: string;
}) {
  const { dict } = useI18n();
  const [status, setStatus] = useState<FeedImportStatusView | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const poll = () => {
      getFeedImport(projectId, runId)
        .then((r) => {
          if (!alive) return;
          setStatus(r);
          setLoadError(null);
          const active = r.status === 'PENDING' || r.status === 'IMPORTING';
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

  if (!status && !loadError) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={28} />
      </div>
    );
  }

  const active = status?.status === 'PENDING' || status?.status === 'IMPORTING';
  const problemRows = (status?.items ?? []).filter(
    (i) => i.status === 'SKIPPED' || i.status === 'FAILED'
  );

  return (
    <div className="animate-fadeIn">
      <ScreenHeader
        title={dict.feedImport.progressTitle}
        back={routes.project(projectId)}
        hint={dict.feedImport.progressHint}
      />

      {loadError !== null && (
        <Alert tone="error" className="mb-3">
          {errorMessage(loadError)}
        </Alert>
      )}

      {status && (
        <>
          <Card className="p-4 mb-3">
            <div className="flex items-center gap-2 mb-2">
              {active ? (
                <Loader2 size={16} className="animate-spin text-accent" />
              ) : status.status === 'DONE' ? (
                <CheckCircle2 size={16} className="text-emerald-500" />
              ) : (
                <AlertTriangle size={16} className="text-rose-500" />
              )}
              <span className="text-sm font-semibold">
                {active
                  ? dict.feedImport.statusRunning
                  : status.status === 'DONE'
                    ? dict.feedImport.statusDone
                    : dict.feedImport.statusFailed}
              </span>
            </div>

            {status.status === 'FAILED' && status.error && (
              <p className="mb-2 text-xs text-rose-500">{status.error}</p>
            )}

            <div className="flex flex-wrap gap-2 text-xs">
              <Badge tone="success">
                {dict.feedImport.countImported.replace(
                  '{{count}}',
                  String(status.importedCount)
                )}
              </Badge>
              {status.skippedCount > 0 && (
                <Badge tone="warning">
                  {dict.feedImport.countSkipped.replace(
                    '{{count}}',
                    String(status.skippedCount)
                  )}
                </Badge>
              )}
              {status.failedCount > 0 && (
                <Badge tone="danger">
                  {dict.feedImport.countFailed.replace(
                    '{{count}}',
                    String(status.failedCount)
                  )}
                </Badge>
              )}
              {status.totalRows > 0 && (
                <span className="text-silver-400 tabular">
                  {dict.feedImport.countTotal.replace(
                    '{{count}}',
                    String(status.totalRows)
                  )}
                </span>
              )}
            </div>
          </Card>

          {status.importedCount > 0 && (
            <Button
              block
              className="mb-3"
              variant="outline"
              icon={<PackageCheck size={14} />}
              onClick={() => navigate(routes.project(projectId))}
            >
              {dict.feedImport.openProjectButton}
            </Button>
          )}

          {problemRows.length > 0 && (
            <>
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-silver-400">
                <Rss size={12} />
                {dict.feedImport.problemsHeading}
              </div>
              <div className="space-y-1.5">
                {problemRows.slice(0, MAX_PROBLEM_ROWS).map((item) => (
                  <Card key={item.rowIndex} className="p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium">
                        {item.title?.trim() ||
                          dict.feedImport.rowFallback.replace(
                            '{{index}}',
                            String(item.rowIndex + 1)
                          )}
                      </span>
                      <Badge
                        tone={item.status === 'FAILED' ? 'danger' : 'warning'}
                      >
                        {item.status === 'FAILED'
                          ? dict.feedImport.rowFailed
                          : dict.feedImport.rowSkipped}
                      </Badge>
                    </div>
                    {item.reason && (
                      <p className="mt-0.5 text-xs text-silver-400">
                        {item.reason}
                      </p>
                    )}
                  </Card>
                ))}
                {problemRows.length > MAX_PROBLEM_ROWS && (
                  <p className="text-xs text-silver-400">
                    {dict.feedImport.problemsMore.replace(
                      '{{count}}',
                      String(problemRows.length - MAX_PROBLEM_ROWS)
                    )}
                  </p>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
