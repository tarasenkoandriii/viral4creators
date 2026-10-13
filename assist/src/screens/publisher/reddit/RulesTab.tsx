/**
 * P-R — вкладка «Правила» (Policy Gate, §M1.3): версии снимков правил
 * сообщества (новые сверху), у каждого — первоисточник (https-ссылка, не
 * загружается), выдержка ТОЛЬКО текстом, политика продвижения/ссылок,
 * условия, дата проверки, `state` (`unreviewed|reviewed|stale`),
 * `selfReview` («проверено автором») и гейт с причинами.
 * «Подтвердить проверку» — только при `reddit.rules.review` и только у
 * текущего неподтверждённого снимка; автору снимка — с предупреждением о
 * `selfReview` (решает и помечает сервер). Новый снимок — `reddit.manage`.
 */
import { useState } from 'react';
import { Alert, Badge, Button } from '../../../kit/ui';
import { useAsync } from '../../../kit';
import {
  REDDIT_LINKS_POLICIES,
  REDDIT_PROMOTION_POLICIES,
  type RedditCommunityView,
  type RedditRuleSnapshotView,
} from '../../../lib/publisher/reddit-api';
import {
  canReviewSnapshot,
  emptyRulesForm,
  isOwnSnapshot,
  rulesBody,
  snapshotStateTone,
  type Flair,
  type RulesForm,
} from '../../../lib/publisher/reddit-view';
import { actorLabel, fmtText } from '../../../lib/publisher/view';
import { useMutation } from '../hooks';
import {
  ConfirmButton,
  DateText,
  Field,
  Loadable,
  Notice,
  RecordLink,
  Row,
  Section,
  Select,
  TextArea,
  TextInput,
} from '../parts';
import type { PublisherSectionProps } from '../registry';
import {
  useProjectScope,
  useReddit,
  useRedditCommunities,
} from './reddit-hooks';
import { ProjectBar } from './ProjectBar';
import { RulesSummaryLine } from './CommunitiesTab';
import {
  CommunitySelect,
  GateBlock,
  PlainQuote,
  ReadOnlyNote,
  RedditErrorAlert,
  RedditLink,
  RevokeEvidence,
  SourceLink,
} from './reddit-parts';

export function RulesTab({ id, query }: PublisherSectionProps) {
  const { r } = useReddit();
  const scope = useProjectScope(query);
  const communities = useRedditCommunities(scope.projectId);
  const { go } = useReddit();
  return (
    <div className="space-y-4">
      {!id && <ProjectBar scope={scope} tab="rules" />}
      {!id && scope.projectId && (
        <CommunitySelect
          communities={communities.data ?? []}
          value=""
          label={r.rules.pickCommunity}
          empty={r.common.choose}
          onChange={(v) => v && go('reddit', v, { tab: 'rules' })}
        />
      )}
      {!id && scope.projectId && communities.data?.length === 0 && (
        <Alert tone="neutral">{r.common.noCommunity}</Alert>
      )}
      {id && <CommunityRules communityId={id} />}
    </div>
  );
}

function CommunityRules({ communityId }: { communityId: string }) {
  const { r, api } = useReddit();
  const community = useAsync(
    () => api.community(communityId),
    [api, communityId]
  );
  const rules = useAsync(() => api.rules(communityId), [api, communityId]);
  const reloadAll = () => {
    community.reload();
    rules.reload();
  };
  return (
    <div className="space-y-4">
      <RecordLink section="reddit" query={{ tab: 'rules' }}>
        {r.common.back}
      </RecordLink>
      <Loadable state={community}>
        {(c) => (
          <>
            <Section title={`${r.rules.title}: r/${c.subreddit}`}>
              <RedditLink url={c.canonicalUrl} />
              <RulesSummaryLine c={c} />
              <div className="text-xs text-silver-500">
                {fmtText(r.communities.staleHint, { n: c.staleDays })}
              </div>
            </Section>
            <Loadable state={rules}>
              {(list) => (
                <Section title={r.rules.versions}>
                  {list.items.length === 0 ? (
                    <Alert tone="warning">{r.rules.empty}</Alert>
                  ) : (
                    <div className="space-y-3">
                      {list.items.map((s) => (
                        <SnapshotCard key={s.id} s={s} onChanged={reloadAll} />
                      ))}
                    </div>
                  )}
                </Section>
              )}
            </Loadable>
            <NewSnapshot c={c} onDone={reloadAll} />
          </>
        )}
      </Loadable>
    </div>
  );
}

function SnapshotCard({
  s,
  onChanged,
}: {
  s: RedditRuleSnapshotView;
  onChanged: () => void;
}) {
  const { r, api, canReview, memberId } = useReddit();
  const m = useMutation();
  const [done, setDone] = useState<string | null>(null);
  const own = isOwnSnapshot(s, memberId);
  const current = s.status === 'current';
  return (
    <div
      className={`rounded-xl border p-3 space-y-2 ${
        current
          ? 'border-silver-300 dark:border-silver-700'
          : 'border-silver-200/60 dark:border-silver-800'
      }`}
    >
      <div className="flex flex-wrap items-center gap-1">
        <span className="font-semibold mr-1">
          {fmtText(r.rules.version, { n: s.version })}
        </span>
        <Badge tone={current ? 'accent' : 'neutral'}>
          {r.rules.snapshotStatuses[s.status]}
        </Badge>
        <Badge
          tone={snapshotStateTone(s.state, s.gate.reasons, s.source.usage)}
        >
          {r.rules.states[s.state]}
        </Badge>
        {s.selfReview && <Badge tone="warning">{r.rules.selfReview}</Badge>}
      </div>
      <GateBlock gate={s.gate} />
      <Row label={r.rules.fields.promotionPolicy}>
        {r.rules.promotion[s.promotionPolicy]}
      </Row>
      <Row label={r.rules.fields.linksPolicy}>
        {r.rules.links[s.linksPolicy]}
      </Row>
      <Row label={r.rules.fields.flairRequired}>
        {s.flairRequired === null
          ? r.rules.flair.unknown
          : s.flairRequired
            ? r.rules.flair.yes
            : r.rules.flair.no}
      </Row>
      {s.conditions.length > 0 && (
        <div className="text-sm">
          <div className="text-silver-500">{r.rules.fields.conditions}:</div>
          <ul className="list-disc pl-5">
            {s.conditions.map((x, i) => (
              <li key={i} className="whitespace-pre-wrap break-words">
                {x}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Row label={r.rules.checkedAt}>
        <DateText iso={s.checkedAt} time />
      </Row>
      <Row label={r.rules.createdBy}>{actorLabel(s.createdBy)}</Row>
      {s.reviewedAt && (
        <Row label={r.rules.reviewedBy}>
          {actorLabel(s.reviewedBy)} · <DateText iso={s.reviewedAt} time />
        </Row>
      )}
      <Row label={r.rules.source}>
        <SourceLink url={s.source.url} />
      </Row>
      <div className="text-xs text-silver-500">
        {r.rules.excerpt} · {r.rules.usage[s.source.usage]}
      </div>
      <PlainQuote
        text={s.source.excerpt}
        injectionFlag={s.source.injectionFlag}
      />
      {s.source.usage === 'revoked' ? (
        <RevokedSourceNote communityId={s.communityId} snapshotId={s.id} />
      ) : (
        // Отзыв первоисточника — у ЛЮБОГО снимка, и у заменённого (S2-2).
        <RevokeEvidence
          sourceId={s.source.id}
          label={r.common.revokeRulesSource}
          onDone={onChanged}
          context={fmtText(r.rules.version, { n: s.version })}
        />
      )}
      {canReviewSnapshot(s) &&
        (canReview ? (
          <div className="space-y-2 pt-1">
            <div className="text-xs text-silver-500">{r.rules.reviewHint}</div>
            {own && <Alert tone="warning">{r.rules.selfReviewWarning}</Alert>}
            <RedditErrorAlert error={m.error} onReload={onChanged} />
            <ConfirmButton
              variant="solid"
              loading={m.busy}
              onConfirm={async () => {
                setDone(null);
                const x = await m.run(
                  (k) => api.reviewRules(s.id, k),
                  `review:${s.id}`
                );
                if (x) {
                  setDone(r.rules.reviewed);
                  onChanged();
                }
              }}
            >
              {r.rules.review}
            </ConfirmButton>
          </div>
        ) : null)}
      <Notice text={done} />
    </div>
  );
}

/**
 * Отозванный первоисточник: пометка и причина (`GET …/rules/:sid/source`,
 * работает и у заменённого снимка); повторного отзыва нет.
 */
function RevokedSourceNote({
  communityId,
  snapshotId,
}: {
  communityId: string;
  snapshotId: string;
}) {
  const { r, api } = useReddit();
  const st = useAsync(
    () => api.rulesSource(communityId, snapshotId),
    [api, communityId, snapshotId]
  );
  return (
    <Alert tone="danger" title={r.rules.sourceRevokedNote}>
      {st.data ? (
        <span>
          <DateText iso={st.data.source.revokedAt} time />
          {' · '}
          {r.opportunities.evidenceRevokeReason}:{' '}
          {st.data.source.revokeReason ?? r.common.none}
        </span>
      ) : st.error ? (
        <RedditErrorAlert error={st.error} />
      ) : null}
    </Alert>
  );
}

function NewSnapshot({
  c,
  onDone,
}: {
  c: RedditCommunityView;
  onDone: () => void;
}) {
  const { r, api, canManage } = useReddit();
  const m = useMutation();
  const [v, setV] = useState<RulesForm>(emptyRulesForm());
  const [done, setDone] = useState<string | null>(null);
  if (!canManage) return <ReadOnlyNote />;
  if (c.status !== 'active') {
    return <Alert tone="warning">{r.communities.archiveHint}</Alert>;
  }
  const { body, issues } = rulesBody(v);
  const touched = v.sourceUrl !== '' || v.sourceExcerpt !== '';
  return (
    <Section title={r.rules.newSnapshot}>
      <div className="text-xs text-silver-500">{r.rules.newSnapshotHint}</div>
      <Field
        label={r.rules.fields.sourceUrl}
        hint={
          touched && v.sourceUrl && issues.includes('url')
            ? r.rules.urlInvalid
            : undefined
        }
      >
        <TextInput
          type="url"
          value={v.sourceUrl}
          maxLength={2048}
          placeholder={`${c.canonicalUrl}/about/rules`}
          onChange={(x) => setV({ ...v, sourceUrl: x })}
        />
      </Field>
      <Field label={r.rules.fields.sourceExcerpt}>
        <TextArea
          value={v.sourceExcerpt}
          rows={5}
          maxLength={5000}
          onChange={(x) => setV({ ...v, sourceExcerpt: x })}
        />
      </Field>
      <Field label={r.rules.fields.promotionPolicy}>
        <Select
          value={v.promotionPolicy}
          options={REDDIT_PROMOTION_POLICIES}
          labels={r.rules.promotion}
          empty={r.common.choose}
          onChange={(x) => setV({ ...v, promotionPolicy: x })}
        />
      </Field>
      <Field label={r.rules.fields.linksPolicy}>
        <Select
          value={v.linksPolicy}
          options={REDDIT_LINKS_POLICIES}
          labels={r.rules.links}
          empty={r.common.choose}
          onChange={(x) => setV({ ...v, linksPolicy: x })}
        />
      </Field>
      <Field label={r.rules.fields.flairRequired}>
        <Select<Flair>
          value={v.flair}
          options={['unknown', 'yes', 'no']}
          labels={r.rules.flair}
          onChange={(x) => setV({ ...v, flair: x || 'unknown' })}
        />
      </Field>
      <Field
        label={r.rules.fields.conditions}
        hint={
          issues.includes('conditions') ? r.rules.conditionsTooMany : undefined
        }
      >
        <TextArea
          value={v.conditions}
          rows={3}
          onChange={(x) => setV({ ...v, conditions: x })}
        />
      </Field>
      <Field
        label={r.rules.fields.checkedAt}
        hint={issues.includes('future') ? r.rules.future : undefined}
      >
        <TextInput
          type="datetime-local"
          value={v.checkedAt}
          onChange={(x) => setV({ ...v, checkedAt: x })}
        />
      </Field>
      <RedditErrorAlert error={m.error} onReload={onDone} />
      <Notice text={done} />
      <Button
        loading={m.busy}
        disabled={!body}
        onClick={async () => {
          if (!body) return;
          setDone(null);
          const x = await m.run(
            (k) => api.createRules(c.id, k, body),
            JSON.stringify(body)
          );
          if (x) {
            setV(emptyRulesForm());
            setDone(r.rules.created);
            onDone();
          }
        }}
      >
        {r.rules.newSnapshot}
      </Button>
    </Section>
  );
}
