import { useAsync } from '../../../kit';
import { Badge } from '../../../kit/ui';
import { usePubApis, usePubContent } from '../hooks';
import {
  DateText,
  EmptyState,
  Loadable,
  RecordLink,
  Section,
  StatusBadge,
} from '../parts';
import { usePublisher } from '../publisher-context';

/**
 * Ближайшие сроки материалов (обзор, §14.1): до 8 материалов с
 * `nextDueAt` по возрастанию; просроченные — красным. Читают все роли.
 */
export function DueCard() {
  const { t } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const list = useAsync(async () => {
    const page = await apis.content.contents({ limit: 100 });
    return page.items
      .filter((x) => x.nextDueAt && x.status !== 'withdrawn')
      .sort((a, b) => Date.parse(a.nextDueAt!) - Date.parse(b.nextDueAt!))
      .slice(0, 8);
  }, [apis]);
  return (
    <Section title={t.home.dueTitle}>
      <Loadable state={list}>
        {(items) =>
          items.length ? (
            <ul className="space-y-1">
              {items.map((x) => {
                const overdue = Date.parse(x.nextDueAt!) < Date.now();
                return (
                  <li
                    key={x.id}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <span className={overdue ? 'text-rose-600' : ''}>
                      <DateText iso={x.nextDueAt} time />
                    </span>
                    {overdue && (
                      <Badge tone="danger">{c.materials.overdue}</Badge>
                    )}
                    <RecordLink section="materials" id={x.id}>
                      {c.materials.kinds[x.kind]} {x.slug ?? x.id}
                    </RecordLink>
                    <StatusBadge
                      status={x.status}
                      labels={c.materials.statuses}
                    />
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState>{t.home.dueEmpty}</EmptyState>
          )
        }
      </Loadable>
    </Section>
  );
}
