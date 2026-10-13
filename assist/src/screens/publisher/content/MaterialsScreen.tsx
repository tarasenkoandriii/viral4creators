import { useState } from 'react';
import { useAsync } from '../../../kit';
import { Alert, Badge } from '../../../kit/ui';
import type { ContentView } from '../../../lib/publisher/content-api';
import {
  CONTENT_KINDS,
  CONTENT_STATUSES,
  type ContentKind,
} from '../../../lib/publisher/states';
import { fmtText } from '../../../lib/publisher/view';
import { useListFilters, usePubApis, usePubContent } from '../hooks';
import {
  DateText,
  EmptyState,
  Field,
  ListToolbar,
  Loadable,
  LoadMore,
  RecordLink,
  Section,
  Select,
  StatusBadge,
} from '../parts';
import { usePublisher } from '../publisher-context';
import type { PublisherSectionProps } from '../registry';
import { MaterialScreen } from './MaterialScreen';

/**
 * Материалы (§14.1 `materials`): список с фильтрами по статусу, виду и
 * ответственному, выгрузка CSV; карточка `materials/:id` — `MaterialScreen`.
 */
export function MaterialsScreen({ id, query }: PublisherSectionProps) {
  if (id) return <MaterialScreen cid={id} />;
  return <MaterialsList query={query} />;
}

function MaterialsList({ query }: { query: PublisherSectionProps['query'] }) {
  const { product } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const f = useListFilters('materials', query, ['status', 'kind', 'owner']);
  const q = {
    status: f.values.status || undefined,
    kind: f.values.kind || undefined,
    owner: f.values.owner || undefined,
  };
  const [extra, setExtra] = useState<ContentView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const list = useAsync(async () => {
    const page = await apis.content.contents({ ...q, limit: 50 });
    setExtra([]);
    setNext(page.nextBefore);
    return page.items;
  }, [apis, product.id, q.status, q.kind, q.owner]);
  return (
    <div className="space-y-4">
      <Alert tone="neutral" title={c.materials.title}>
        {c.materials.createHint}
      </Alert>
      <Section title={c.materials.title}>
        <ListToolbar
          statuses={CONTENT_STATUSES}
          status={f.values.status}
          onStatus={(v) => f.set('status', v)}
          statusLabels={c.materials.statuses}
          owner={f.values.owner}
          onOwner={(v) => f.set('owner', v)}
          csvPath={`products/${product.id}/contents`}
          csvQuery={q}
          extra={
            <Field label={c.materials.kind}>
              <Select
                value={f.values.kind as ContentKind | ''}
                options={CONTENT_KINDS}
                labels={c.materials.kinds}
                empty="—"
                onChange={(v) => f.set('kind', v)}
              />
            </Field>
          }
        />
        <Loadable state={list}>
          {(items) =>
            items.length + extra.length ? (
              <ul className="divide-y divide-silver-200 dark:divide-silver-800">
                {[...items, ...extra].map((x) => {
                  const overdue =
                    x.nextDueAt && Date.parse(x.nextDueAt) < Date.now();
                  return (
                    <li key={x.id} className="py-2 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <RecordLink section="materials" id={x.id}>
                          {c.materials.kinds[x.kind]} · {x.slug ?? x.id}
                        </RecordLink>
                        <StatusBadge
                          status={x.status}
                          labels={c.materials.statuses}
                        />
                        {x.criticalStale && (
                          <Badge tone="danger">
                            {c.materials.criticalStale}
                          </Badge>
                        )}
                        {x.openTasks.length > 0 && (
                          <Badge tone="warning">
                            {fmtText(c.materials.openTasks, {
                              n: x.openTasks.length,
                            })}
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-silver-500 flex flex-wrap gap-3">
                        <span>
                          {c.materials.owner}:{' '}
                          {x.ownerDisplayName ?? x.ownerMemberId ?? '—'}
                        </span>
                        {x.nextDueAt && (
                          <span className={overdue ? 'text-rose-600' : ''}>
                            {c.materials.nextDue}:{' '}
                            <DateText iso={x.nextDueAt} />
                            {overdue ? ` · ${c.materials.overdue}` : ''}
                          </span>
                        )}
                        {x.blockReason && (
                          <span>
                            {c.materials.blockReason}: {x.blockReason}
                          </span>
                        )}
                        {x.parentContentId && (
                          <RecordLink
                            section="materials"
                            id={x.parentContentId}
                          >
                            {c.materials.parent}
                          </RecordLink>
                        )}
                      </div>
                    </li>
                  );
                })}
                <LoadMore
                  next={next}
                  onMore={async (before) => {
                    const page = await apis.content.contents({
                      ...q,
                      before,
                      limit: 50,
                    });
                    setExtra((x) => [...x, ...page.items]);
                    setNext(page.nextBefore);
                  }}
                />
              </ul>
            ) : (
              <EmptyState />
            )
          }
        </Loadable>
      </Section>
    </div>
  );
}
