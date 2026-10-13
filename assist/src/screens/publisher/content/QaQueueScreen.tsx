import { useAsync } from '../../../kit';
import { Alert, Badge } from '../../../kit/ui';
import type {
  ContentView,
  QaCheckView,
} from '../../../lib/publisher/content-api';
import { fmtText, qaState } from '../../../lib/publisher/view';
import { usePubApis, usePubContent } from '../hooks';
import {
  EmptyState,
  ListToolbar,
  Loadable,
  RecordLink,
  Section,
  StatusBadge,
} from '../parts';
import { usePublisher } from '../publisher-context';
import type { PublisherSectionProps } from '../registry';

interface QueueItem {
  content: ContentView;
  checks: QaCheckView[] | null;
}

/**
 * Очередь проверки (§14.1 `qa`): материалы `editorial_review` и
 * `changes_requested` с текущей версией, недостающими проверками
 * (редакционная, техническая, смысл адаптации) и открытыми блокерами.
 * Ответственный — фильтром (`owner`), выгрузка — CSV материалов.
 */
export function QaQueueScreen({ query }: PublisherSectionProps) {
  const { product, memberId, go } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const owner = query.owner ?? '';
  const status = query.status ?? 'editorial_review';
  const queue = useAsync(async (): Promise<QueueItem[]> => {
    const page = await apis.content.contents({
      status,
      owner: owner || undefined,
      limit: 50,
    });
    return Promise.all(
      page.items.map(async (content) => ({
        content,
        checks: content.currentVersionId
          ? await apis.content.qaChecks(content.currentVersionId)
          : null,
      }))
    );
  }, [apis, product.id, status, owner]);
  return (
    <div className="space-y-4">
      <Alert tone="neutral" title={c.qa.title}>
        {c.qa.hint}
      </Alert>
      <Section title={c.qa.title}>
        <ListToolbar
          statuses={['editorial_review', 'changes_requested']}
          status={status}
          onStatus={(v) =>
            go('qa', null, {
              ...(v ? { status: v } : {}),
              ...(owner ? { owner } : {}),
            })
          }
          statusLabels={c.materials.statuses}
          owner={owner}
          onOwner={(v) =>
            go('qa', null, {
              status,
              ...(v ? { owner: v } : {}),
            })
          }
          csvPath={`products/${product.id}/contents`}
          csvQuery={{ status, owner: owner || undefined }}
        />
        <Loadable state={queue}>
          {(items) =>
            items.length ? (
              <ul className="divide-y divide-silver-200 dark:divide-silver-800">
                {items.map(({ content: x, checks }) => {
                  const state = checks
                    ? qaState(checks, x.kind !== 'article')
                    : null;
                  const missing = state ? state.missing : null;
                  const blockers = state ? state.blockers : 0;
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
                        {blockers > 0 && (
                          <Badge tone="danger">
                            {fmtText(c.qa.blockersOpen, { n: blockers })}
                          </Badge>
                        )}
                        {x.ownerMemberId === memberId && memberId && (
                          <Badge tone="accent">✓</Badge>
                        )}
                      </div>
                      {missing === null ? (
                        <div className="text-xs text-amber-700">
                          {c.qa.noVersion}
                        </div>
                      ) : missing.length > 0 ? (
                        <div className="text-xs text-amber-700">
                          {fmtText(c.qa.missing, {
                            list: missing
                              .map((k) => c.materials.qaKinds[k])
                              .join(', '),
                          })}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState>{c.qa.empty}</EmptyState>
            )
          }
        </Loadable>
      </Section>
    </div>
  );
}
