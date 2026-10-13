import { useState } from 'react';
import { useAsync } from '../../../kit';
import { Badge, Button } from '../../../kit/ui';
import type { ReviewTaskView } from '../../../lib/publisher/core-api';
import { REVIEW_STATUSES } from '../../../lib/publisher/states';
import { fmtDate, fmtText, objectSection } from '../../../lib/publisher/view';
import { useMutation, usePubApis } from '../hooks';
import {
  EmptyState,
  ListToolbar,
  Loadable,
  LoadMore,
  NoPermission,
  PubErrorAlert,
  RecordLink,
  Section,
  StatusBadge,
  TextInput,
} from '../parts';
import { usePublisher } from '../publisher-context';

/**
 * Открытые задачи проверки (обзор, §14.1): фильтр по статусу и
 * исполнителю, ссылка на объект, решить/отклонить/взять себе. Список
 * видят редактор и владелец продукта (продажи — `retention_review`).
 */
export function ReviewTasksCard() {
  const { product, t, can, memberId } = usePublisher();
  const apis = usePubApis();
  const [status, setStatus] = useState('open');
  const [assignee, setAssignee] = useState('');
  const [extra, setExtra] = useState<ReviewTaskView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const allowed = can('review.manage') || can('review.retention');
  const list = useAsync(async () => {
    if (!allowed) return null;
    const page = await apis.core.reviewTasks(product.id, {
      status: status || undefined,
      assignee: assignee || undefined,
      limit: 20,
    });
    setExtra([]);
    setNext(page.nextBefore);
    return page.items;
  }, [apis, product.id, status, assignee, allowed]);

  if (!allowed) {
    return (
      <Section title={t.home.reviewTitle}>
        <NoPermission>{t.home.reviewNoAccess}</NoPermission>
      </Section>
    );
  }
  return (
    <Section title={t.home.reviewTitle}>
      <ListToolbar
        statuses={REVIEW_STATUSES}
        status={status}
        onStatus={setStatus}
        owner={assignee}
        onOwner={setAssignee}
      />
      <Loadable state={list}>
        {(items) =>
          items && items.length + extra.length > 0 ? (
            <ul className="divide-y divide-silver-200 dark:divide-silver-800">
              {[...items, ...extra].map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  me={memberId}
                  onChanged={list.reload}
                />
              ))}
              <LoadMore
                next={next}
                onMore={async (before) => {
                  const page = await apis.core.reviewTasks(product.id, {
                    status: status || undefined,
                    assignee: assignee || undefined,
                    before,
                    limit: 20,
                  });
                  setExtra((x) => [...x, ...page.items]);
                  setNext(page.nextBefore);
                }}
              />
            </ul>
          ) : (
            <EmptyState>{t.home.reviewEmpty}</EmptyState>
          )
        }
      </Loadable>
    </Section>
  );
}

function TaskRow({
  task,
  me,
  onChanged,
}: {
  task: ReviewTaskView;
  me: string;
  onChanged: () => void;
}) {
  const { product, t, locale } = usePublisher();
  const apis = usePubApis();
  const [resolution, setResolution] = useState('');
  const [open, setOpen] = useState(false);
  const m = useMutation();
  const section = objectSection(task.objectType);
  const overdue =
    task.status === 'open' && task.dueAt && Date.parse(task.dueAt) < Date.now();
  return (
    <li className="py-2 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={task.severity === 'critical' ? 'danger' : 'neutral'}>
          {t.review.severities[task.severity]}
        </Badge>
        <span className="font-medium">{t.review.reasons[task.reason]}</span>
        <StatusBadge status={task.status} />
        {task.dueAt && (
          <span
            className={`text-xs ${overdue ? 'text-rose-600' : 'text-silver-500'}`}
          >
            {fmtText(t.review.due, { date: fmtDate(task.dueAt, locale) })}
          </span>
        )}
      </div>
      <div className="text-xs text-silver-500 flex flex-wrap gap-2">
        <span>
          {t.review.object}: {task.objectType}{' '}
          {section ? (
            <RecordLink
              section={section}
              id={
                task.objectType === 'content' || task.objectType === 'brief'
                  ? task.objectId
                  : null
              }
            >
              {task.objectId}
            </RecordLink>
          ) : (
            task.objectId
          )}
        </span>
        <span>
          {t.review.assignee}: {task.assigneeMemberId ?? t.review.unassigned}
        </span>
      </div>
      {task.status === 'open' && (
        <div className="flex flex-wrap gap-2">
          {task.assigneeMemberId !== me && me && (
            <Button
              variant="ghost"
              loading={m.busy}
              onClick={async () => {
                const r = await m.run((k) =>
                  apis.core.assignTask(
                    product.id,
                    task.id,
                    { assigneeMemberId: me, expectedRevision: task.revision },
                    k
                  )
                );
                if (r) onChanged();
              }}
            >
              {t.review.assignToMe}
            </Button>
          )}
          <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
            {t.review.resolve}
          </Button>
        </div>
      )}
      {open && task.status === 'open' && (
        <div className="space-y-2">
          <TextInput
            value={resolution}
            onChange={setResolution}
            placeholder={t.review.resolution}
            maxLength={1000}
          />
          <div className="flex gap-2">
            {(['resolved', 'dismissed'] as const).map((st) => (
              <Button
                key={st}
                variant={st === 'resolved' ? 'solid' : 'outline'}
                loading={m.busy}
                disabled={!resolution.trim()}
                onClick={async () => {
                  const r = await m.run((k) =>
                    apis.core.resolveTask(
                      product.id,
                      task.id,
                      {
                        status: st,
                        resolution: resolution.trim(),
                        expectedRevision: task.revision,
                      },
                      k
                    )
                  );
                  if (r) onChanged();
                }}
              >
                {st === 'resolved' ? t.review.resolve : t.review.dismiss}
              </Button>
            ))}
          </div>
        </div>
      )}
      <PubErrorAlert error={m.error} onReload={onChanged} />
    </li>
  );
}
