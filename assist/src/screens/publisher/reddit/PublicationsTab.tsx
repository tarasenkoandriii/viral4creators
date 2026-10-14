/**
 * P-R M2 — вкладка «Публикации»: отметки о публикации Reddit-материалов
 * (`user_reported` — «со слов пользователя», проверки не бывает, A12),
 * фильтры статуса/этапа, CSV. Ссылка — сохранённый канон, без превью.
 */
import { PUBLICATION_STATUSES } from '../../../lib/publisher/states';
import {
  PUBLICATION_STAGES_R,
  redditStudioListPath,
} from '../../../lib/publisher/reddit-studio-api';
import { useListFilters } from '../hooks';
import { DateText, ListToolbar, RecordLink, Section, Select } from '../parts';
import { ListRow, PagedFooter } from '../ops/ops-parts';
import { usePaged } from '../ops/ops-hooks';
import type { PublisherSectionProps } from '../registry';
import { useRedditStudio } from './reddit-hooks';
import { PublicationLine } from './StudioTab';

export function PublicationsTab({
  query,
}: {
  query: PublisherSectionProps['query'];
}) {
  const { r, studio, pid } = useRedditStudio();
  const f = useListFilters('reddit', query, ['tab', 'status', 'stage']);
  const filter = {
    status: f.values.status || undefined,
    stage: f.values.stage || undefined,
  };
  const page = usePaged(
    (before) => studio.publications({ ...filter, before }),
    [studio, filter.status, filter.stage]
  );
  return (
    <div className="space-y-4">
      <div className="text-sm text-silver-500">{r.studio.userReportedHint}</div>
      <ListToolbar
        statuses={PUBLICATION_STATUSES}
        status={f.values.status}
        onStatus={(v) => f.set('status', v)}
        statusLabels={r.publications.statuses}
        csvPath={redditStudioListPath(pid, 'publications')}
        csvQuery={filter}
        extra={
          <label className="text-xs text-silver-500 flex flex-col gap-1">
            {r.publications.stage}
            <Select
              value={(f.values.stage ?? '') as 'test' | 'live' | ''}
              options={PUBLICATION_STAGES_R}
              labels={r.studio.stages}
              empty={r.common.none}
              onChange={(v) => f.set('stage', v)}
            />
          </label>
        }
      />
      <Section title={r.publications.title}>
        <ul>
          {page.items.map((p) => (
            <ListRow key={p.id} title={<PublicationLine p={p} />}>
              <div>
                r/{p.subreddit} · {r.publications.postedAt}:{' '}
                <DateText iso={p.publishedAt} time /> ·{' '}
                <RecordLink
                  section="reddit"
                  id={p.contentId}
                  query={{ tab: 'studio' }}
                >
                  {r.publications.material}
                </RecordLink>
              </div>
            </ListRow>
          ))}
        </ul>
        <PagedFooter page={page} empty={r.publications.empty} />
      </Section>
    </div>
  );
}
