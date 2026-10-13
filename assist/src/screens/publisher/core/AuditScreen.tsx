import { useState } from 'react';
import { useAsync } from '../../../kit';
import { Button } from '../../../kit/ui';
import type { AuditEventView } from '../../../lib/publisher/core-api';
import { actorLabel } from '../../../lib/publisher/view';
import { usePubApis } from '../hooks';
import {
  DateText,
  EmptyState,
  Field,
  Loadable,
  LoadMore,
  NoPermission,
  Section,
  TextInput,
} from '../parts';
import { usePublisher } from '../publisher-context';
import type { PublisherSectionProps } from '../registry';

/**
 * Журнал аудита (§14.1 AuditScreen): фильтры по типу и id объекта (ссылки
 * с карточек открывают журнал уже отфильтрованным: `audit?objectType=…`).
 * Видят владелец продукта, аналитик, администратор.
 */
export function AuditScreen({ query }: PublisherSectionProps) {
  const { product, t, can, go } = usePublisher();
  const apis = usePubApis();
  const [objectType, setObjectType] = useState(query.objectType ?? '');
  const [objectId, setObjectId] = useState(query.objectId ?? '');
  const [extra, setExtra] = useState<AuditEventView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const qType = query.objectType ?? '';
  const qId = query.objectId ?? '';
  const list = useAsync(async () => {
    if (!can('audit.read')) return null;
    const page = await apis.core.audit(product.id, {
      objectType: qType || undefined,
      objectId: qId || undefined,
      limit: 50,
    });
    setExtra([]);
    setNext(page.nextBefore);
    return page.items;
  }, [apis, product.id, qType, qId]);

  if (!can('audit.read'))
    return <NoPermission>{t.audit.noAccess}</NoPermission>;
  return (
    <Section title={t.audit.title}>
      <div className="flex flex-wrap gap-2 items-end">
        <Field label={t.audit.objectType}>
          <TextInput value={objectType} onChange={setObjectType} />
        </Field>
        <Field label={t.audit.objectId}>
          <TextInput value={objectId} onChange={setObjectId} />
        </Field>
        <Button
          variant="outline"
          onClick={() => {
            const q: Record<string, string> = {};
            if (objectType.trim()) q.objectType = objectType.trim();
            if (objectId.trim()) q.objectId = objectId.trim();
            go('audit', null, q);
          }}
        >
          {t.audit.apply}
        </Button>
      </div>
      <Loadable state={list}>
        {(items) =>
          items && items.length + extra.length ? (
            <ul className="divide-y divide-silver-200 dark:divide-silver-800 text-sm">
              {[...items, ...extra].map((e) => (
                <li key={e.id} className="py-2">
                  <div className="flex flex-wrap gap-2">
                    <span className="font-medium">{e.action}</span>
                    <span className="text-silver-500">
                      {e.objectType} · {e.objectId}
                    </span>
                    {(e.fromStatus || e.toStatus) && (
                      <span>
                        {e.fromStatus ?? '∅'} → {e.toStatus ?? '∅'}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-silver-500">
                    {t.audit.actor}: {actorLabel(e.actor)} ·{' '}
                    <DateText iso={e.occurredAt} time />
                    {e.reason ? ` · ${e.reason}` : ''}
                  </div>
                </li>
              ))}
              <LoadMore
                next={next}
                onMore={async (before) => {
                  const page = await apis.core.audit(product.id, {
                    objectType: qType || undefined,
                    objectId: qId || undefined,
                    before,
                    limit: 50,
                  });
                  setExtra((x) => [...x, ...page.items]);
                  setNext(page.nextBefore);
                }}
              />
            </ul>
          ) : (
            <EmptyState>{t.audit.empty}</EmptyState>
          )
        }
      </Loadable>
    </Section>
  );
}
