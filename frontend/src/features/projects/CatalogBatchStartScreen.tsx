/**
 * CatalogBatchStartScreen — выбор товаров для партии (ТЗ §44, этап 65).
 * Открывается с карточки «Сделать так же для всей линейки»
 * (CatalogBatchPanel) на экране готового ролика: разбор + промпт сессии
 * `sourceSessionId` переносится на выбранные здесь товары ЭТОГО же
 * проекта, автоматически (без остановки на подтверждение по каждому —
 * решение владельца продукта, см. plan этапа 65).
 *
 * Список — только заполненные товары (`isComplete`, тот же критерий, что
 * фильтрует кнопку «Сгенерировать» на ProjectScreen), сам исходный товар
 * исключён (сервер и так его отбросит — `CatalogBatchService.create` —
 * но экран не должен предлагать зациклить видео само на себя). По
 * умолчанию отмечены все — партия существует именно для того, чтобы не
 * снимать галочки по одной.
 */

import { useMemo, useState } from 'react';
import { Layers } from 'lucide-react';
import { Alert, Button, Card, EmptyState, Pills, Spinner } from '../../components/ui';
import { getProject, errorMessage } from '../../services/projects-api';
import { getSession } from '../../services/api';
import { startCatalogBatch } from '../../services/catalog-batch-api';
import { useAsync } from '../../lib/useAsync';
import { navigate, routes } from '../../lib/router';
import { useI18n } from '../../lib/i18n-context';
import { ScreenHeader, LoadError } from './shared';
import { formatPrice, itemLabel } from './format';

export function CatalogBatchStartScreen({
  projectId,
  sourceSessionId,
}: {
  projectId: string;
  sourceSessionId: string;
}) {
  const { dict, locale } = useI18n();
  const {
    data: project,
    loading: projectLoading,
    error: projectError,
    reload,
  } = useAsync(() => getProject(projectId), [projectId]);
  const { data: sourceSession, loading: sessionLoading } = useAsync(
    () => getSession(sourceSessionId),
    [sourceSessionId]
  );
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Доп. запрос владельца продукта: Grok как провайдер для партии (ТЗ
  // VEO-MODEL-VERSION-CHOICE-SPEC.md §10–11/§13, этап 2 плана §14) —
  // найдено при аудите (§16.3): без этого выбора в интерфейсе весь
  // Grok-путь воркера партий был недостижим через реальный API.
  const [provider, setProvider] = useState<'veo' | 'grok'>('grok');
  const [resolution, setResolution] = useState<'480p' | '720p' | '1080p'>(
    '480p'
  );

  const candidates = useMemo(
    () =>
      (project?.items ?? []).filter(
        (i) => i.isComplete && i.id !== sourceSession?.productItemId
      ),
    [project, sourceSession]
  );

  // Отмечены по умолчанию все кандидаты — вычисляется лениво, один раз,
  // когда и проект, и исходная сессия уже загружены (до этого момента
  // candidates ещё пуст/неполон).
  const checked = selected ?? new Set(candidates.map((i) => i.id));

  const toggle = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const loading = projectLoading || sessionLoading;

  const onSubmit = async () => {
    const productItemIds = candidates
      .map((i) => i.id)
      .filter((id) => checked.has(id));
    if (productItemIds.length === 0) {
      setError(dict.catalogBatch.startEmptySelection);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await startCatalogBatch(projectId, {
        sourceSessionId,
        productItemIds,
        provider,
        resolution: provider === 'grok' ? resolution : undefined,
      });
      navigate(routes.catalogBatch(projectId, result.batchId), true);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={28} />
      </div>
    );
  }
  if (projectError || !project) {
    return (
      <div>
        <ScreenHeader
          title={dict.catalogBatch.startTitle}
          back={routes.project(projectId)}
        />
        <LoadError error={projectError} onRetry={reload} />
      </div>
    );
  }

  return (
    <div className="animate-fadeIn">
      <ScreenHeader
        title={dict.catalogBatch.startTitle}
        back={routes.project(projectId)}
        hint={dict.catalogBatch.startHint}
      />

      <Alert tone="info" className="mb-3">
        {dict.catalogBatch.startCreditsWarning}
      </Alert>

      {error && (
        <Alert tone="error" className="mb-3" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Доп. запрос владельца продукта: провайдер видео для партии (§16.3
          аудита ТЗ) — тот же выбор, что уже есть на экране одиночной
          генерации (GenerationWizard), просто применяется ко всей партии
          сразу, а не к одному ролику. */}
      <div className="mb-4">
        <span className="label">{dict.generationWizard.providerLabel}</span>
        <Pills
          value={provider}
          onChange={setProvider}
          options={[
            { value: 'grok', label: dict.generationWizard.providerGrokLabel },
            { value: 'veo', label: dict.generationWizard.providerVeoLabel },
          ]}
        />
        {provider === 'grok' && (
          <>
            <span className="label">
              {dict.generationWizard.resolutionLabel}
            </span>
            <Pills
              value={resolution}
              onChange={setResolution}
              options={[
                { value: '480p', label: '480p' },
                { value: '720p', label: '720p' },
                { value: '1080p', label: '1080p' },
              ]}
            />
          </>
        )}
      </div>

      {candidates.length === 0 ? (
        <EmptyState
          icon={<Layers size={28} />}
          title={dict.catalogBatch.startEmptyTitle}
          hint={dict.catalogBatch.startEmptyHint}
        />
      ) : (
        <>
          <div className="space-y-2">
            {candidates.map((item, index) => (
              <Card
                key={item.id}
                className="flex items-center gap-3 p-3 cursor-pointer"
                onClick={() => toggle(item.id)}
              >
                <input
                  type="checkbox"
                  checked={checked.has(item.id)}
                  onChange={() => toggle(item.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="h-4 w-4 shrink-0 accent-sky-400"
                  aria-label={itemLabel(
                    item,
                    index,
                    dict.projectFormat.itemFallback
                  )}
                />
                <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-silver-200/60 dark:bg-silver-800/60">
                  {item.photoUrl && (
                    <img
                      src={item.photoUrl}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">
                    {itemLabel(item, index, dict.projectFormat.itemFallback)}
                  </div>
                  <div className="text-xs text-silver-400 tabular">
                    {formatPrice(item.price, project.currency, locale)}
                  </div>
                </div>
              </Card>
            ))}
          </div>

          <Button
            block
            className="mt-4"
            icon={<Layers size={14} />}
            loading={busy}
            disabled={checked.size === 0}
            onClick={() => void onSubmit()}
          >
            {dict.catalogBatch.startSubmitButton.replace(
              '{{count}}',
              String(checked.size)
            )}
          </Button>
        </>
      )}
    </div>
  );
}
