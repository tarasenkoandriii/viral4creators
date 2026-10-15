'use client';

// «Публикации»: отметки о публикации Reddit-материалов — только «со слов
// пользователя» (`user_reported`, проверки не бывает), фильтры статуса и
// этапа; ссылка — сохранённый канон; снятие ошибочной отметки с причиной.

import { useState } from 'react';
import { fmtDateTime, R } from '../../lib/reddit';
import { PUBLICATION_STAGES_R } from '../../lib/reddit-shared/lib/publisher/reddit-studio-api';
import { PUBLICATION_STATUSES } from '../../lib/reddit-shared/lib/publisher/states';
import { Alert, CsvButton, PagedFooter, Section, Select, usePaged, useRx } from './ui';
import { PublicationLine, WithdrawMark } from './StudioTab';

export function PublicationsTab() {
  const { api, go } = useRx();
  const [status, setStatus] = useState('');
  const [stage, setStage] = useState<'' | 'test' | 'live'>('');
  const page = usePaged((before) => api.studio.publications({ status: status || undefined, stage: stage || undefined, before, limit: 50 }), [api, status, stage]);
  return (
    <div className="rx-stack">
      <Alert tone="neutral">{R.studio.userReportedHint}</Alert>
      <div className="rx-row">
        <Select ariaLabel={R.common.status} value={status} options={PUBLICATION_STATUSES} labels={R.publications.statuses} empty="все статусы" onChange={setStatus} />
        <Select ariaLabel={R.publications.stage} value={stage} options={PUBLICATION_STAGES_R} labels={R.studio.stages} empty="все этапы" onChange={setStage} />
        <CsvButton list="publications" query={{ status: status || undefined, stage: stage || undefined }} />
      </div>
      <Section title={R.publications.title}>
        <ul className="rx-items">
          {page.items.map((p) => (
            <li key={p.id} className="rx-item">
              <PublicationLine p={p} />
              <div className="rx-row">
                <span className="muted">
                  r/{p.subreddit} · {R.publications.postedAt}: {fmtDateTime(p.publishedAt)}
                </span>
                <button type="button" className="rx-linkbtn" onClick={() => go({ tab: 'studio', id: p.contentId })}>
                  {R.publications.material}
                </button>
              </div>
              {p.status === 'published' && <WithdrawMark p={p} onDone={page.reload} />}
            </li>
          ))}
        </ul>
        <PagedFooter page={page} empty={R.publications.empty} />
      </Section>
    </div>
  );
}
