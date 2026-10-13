import { useState } from 'react';
import { useAsync } from '../../../kit';
import { Alert, Badge, Button, Card } from '../../../kit/ui';
import {
  decodeBriefDraft,
  type AiCallView,
} from '../../../lib/publisher/ai-api';
import type {
  BriefView,
  QuestionView,
} from '../../../lib/publisher/content-api';
import {
  BRIEF_FORMATS,
  BRIEF_STATUSES,
  type BriefFormat,
} from '../../../lib/publisher/states';
import { fmtText, planBalance } from '../../../lib/publisher/view';
import {
  useListFilters,
  useMutation,
  usePubApis,
  usePubContent,
} from '../hooks';
import {
  EmptyState,
  Field,
  ListToolbar,
  Loadable,
  Notice,
  PubErrorAlert,
  RecordLink,
  Section,
  Select,
  StatusBadge,
  TextInput,
} from '../parts';
import { usePublisher } from '../publisher-context';
import type { PublisherSectionProps } from '../registry';
import { AiRunner } from './AiRunner';

/**
 * План тем (§14.1 `plan`): 6 выбранных вопросов → брифы 2/2/2 формата,
 * статусы, ответственные (через материал), бриф вручную или из AI-черновика
 * (`pub.brief.draft`, предложение → бриф с `aiCallId` делает человек).
 */
export function PlanScreen({ query }: PublisherSectionProps) {
  const { product, can } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const f = useListFilters('plan', query, ['status']);
  const q = { status: f.values.status || undefined };
  const selected = useAsync(
    async () =>
      (await apis.content.questions({ status: 'selected', limit: 100 })).items
        .slice()
        .sort((a, b) => (a.selectedRank ?? 99) - (b.selectedRank ?? 99)),
    [apis, product.id]
  );
  const briefs = useAsync(
    async () => (await apis.content.briefs({ limit: 100 })).items,
    [apis, product.id]
  );
  const contents = useAsync(
    async () =>
      (await apis.content.contents({ kind: 'article', limit: 100 })).items,
    [apis, product.id]
  );
  const shown = (briefs.data ?? []).filter(
    (b) => !q.status || b.status === q.status
  );
  const balance = planBalance(briefs.data ?? []);
  const reload = () => {
    briefs.reload();
    selected.reload();
  };

  return (
    <div className="space-y-4">
      <Alert tone="neutral" title={c.plan.title}>
        {c.plan.hint}
      </Alert>
      <div className="flex flex-wrap gap-1">
        {BRIEF_FORMATS.map((fm) => (
          <Badge
            key={fm}
            tone={balance.counts[fm] === 2 ? 'neutral' : 'warning'}
          >
            {fmtText(c.plan.balance, {
              format: c.plan.formats[fm],
              n: balance.counts[fm],
            })}
          </Badge>
        ))}
        {!balance.balanced && <Badge tone="warning">{c.plan.balanceOff}</Badge>}
      </div>
      <Section title={c.plan.selectedQuestions}>
        <Loadable state={selected}>
          {(qs) =>
            qs.length ? (
              <ul className="space-y-3">
                {qs.map((x) => (
                  <PlanQuestion
                    key={x.id}
                    q={x}
                    briefs={(briefs.data ?? []).filter(
                      (b) => b.questionId === x.id
                    )}
                    canEdit={can('brief.manage')}
                    canAi={can('ai.generate')}
                    onDone={reload}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState>
                {c.plan.noSelected}{' '}
                <RecordLink section="questions">{c.questions.title}</RecordLink>
              </EmptyState>
            )
          }
        </Loadable>
      </Section>
      <Section title={c.plan.briefs}>
        <ListToolbar
          statuses={BRIEF_STATUSES}
          status={f.values.status}
          onStatus={(v) => f.set('status', v)}
          statusLabels={c.plan.briefStatuses}
          csvPath={`products/${product.id}/briefs`}
          csvQuery={q}
        />
        <Loadable state={briefs}>
          {() =>
            shown.length ? (
              <ul className="divide-y divide-silver-200 dark:divide-silver-800">
                {shown.map((b) => {
                  const material = (contents.data ?? []).find(
                    (m) => m.briefId === b.id
                  );
                  return (
                    <li
                      key={b.id}
                      className="py-2 flex flex-wrap items-center gap-2"
                    >
                      <RecordLink section="briefs" id={b.id}>
                        {b.goal}
                      </RecordLink>
                      <Badge tone="neutral">{c.plan.formats[b.format]}</Badge>
                      <StatusBadge
                        status={b.status}
                        labels={c.plan.briefStatuses}
                      />
                      {material && (
                        <RecordLink section="materials" id={material.id}>
                          {c.plan.toMaterial}:{' '}
                          {material.ownerDisplayName ??
                            material.slug ??
                            material.id}
                        </RecordLink>
                      )}
                    </li>
                  );
                })}
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

function PlanQuestion({
  q,
  briefs,
  canEdit,
  canAi,
  onDone,
}: {
  q: QuestionView;
  briefs: BriefView[];
  canEdit: boolean;
  canAi: boolean;
  onDone: () => void;
}) {
  const c = usePubContent();
  const { go } = usePublisher();
  const apis = usePubApis();
  const [goal, setGoal] = useState('');
  const [format, setFormat] = useState<BriefFormat | ''>('instruction');
  const [notice, setNotice] = useState<string | null>(null);
  const m = useMutation();
  const createFrom = async (call: AiCallView) => {
    const d = decodeBriefDraft(call.output);
    const r = await m.run((k) =>
      apis.content.createBrief(
        {
          questionId: q.id,
          goal: goal.trim() || d.short_answer.slice(0, 300),
          format: d.format,
          ownContribution: d.original_contribution,
          shortAnswer: d.short_answer,
          cta: d.cta.text,
          ctaIntentNote: d.cta.intent_fit_note,
          structure: d.structure,
          channels: d.channels,
          unresolved: [...d.unresolved_questions, ...d.limitations],
          sourceIds: d.source_ids,
          aiCallId: call.callId,
        },
        k
      )
    );
    if (r) go('briefs', r.id);
  };
  return (
    <li>
      <Card className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">#{q.selectedRank}</Badge>
          <span className="font-medium flex-1 min-w-0">{q.text}</span>
          {briefs.length === 0 && (
            <Badge tone="warning">{c.plan.noBrief}</Badge>
          )}
        </div>
        {briefs.map((b) => (
          <div key={b.id} className="flex flex-wrap items-center gap-2 text-sm">
            <RecordLink section="briefs" id={b.id}>
              {b.goal}
            </RecordLink>
            <Badge tone="neutral">{c.plan.formats[b.format]}</Badge>
            <StatusBadge status={b.status} labels={c.plan.briefStatuses} />
          </div>
        ))}
        {canEdit && (
          <div className="grid gap-2 md:grid-cols-3 items-end">
            <div className="md:col-span-2">
              <Field label={c.plan.goal}>
                <TextInput value={goal} onChange={setGoal} maxLength={500} />
              </Field>
            </div>
            <Field label={c.plan.format}>
              <Select
                value={format}
                options={BRIEF_FORMATS}
                labels={c.plan.formats}
                onChange={setFormat}
              />
            </Field>
          </div>
        )}
        <Notice text={notice} />
        <PubErrorAlert error={m.error} />
        {canEdit && (
          <Button
            variant="outline"
            loading={m.busy}
            disabled={!goal.trim() || !format}
            onClick={async () => {
              if (!format) return;
              const r = await m.run((k) =>
                apis.content.createBrief(
                  { questionId: q.id, goal: goal.trim(), format },
                  k
                )
              );
              if (r) {
                setNotice(c.plan.created);
                setGoal('');
                onDone();
              }
            }}
          >
            {c.plan.createBrief}
          </Button>
        )}
        {canEdit && canAi && (
          <AiRunner
            generator="pub.brief.draft"
            label={c.plan.aiDraft}
            manualHint={c.ai.manualPath}
            start={(k) => apis.ai.briefDraft({ questionId: q.id }, k)}
            render={(call) => {
              const d = (() => {
                try {
                  return decodeBriefDraft(call.output);
                } catch {
                  return null;
                }
              })();
              if (!d) return <Alert tone="warning">{c.ai.manualPath}</Alert>;
              return (
                <div className="space-y-1 text-sm">
                  <div>
                    <b>{c.plan.format}:</b> {c.plan.formats[d.format]}
                  </div>
                  <div>
                    <b>{c.brief.fields.shortAnswer}:</b> {d.short_answer}
                  </div>
                  <div>
                    <b>{c.brief.fields.ownContribution}:</b>{' '}
                    {d.original_contribution ?? '—'}
                  </div>
                  <div>
                    <b>{c.brief.fields.cta}:</b> {d.cta.text}
                  </div>
                  <ul className="list-disc pl-5">
                    {d.structure.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                  {d.unresolved_questions.length > 0 && (
                    <div className="text-xs text-amber-700">
                      {d.unresolved_questions.join('; ')}
                    </div>
                  )}
                  <Button
                    loading={m.busy}
                    onClick={() => void createFrom(call)}
                  >
                    {c.plan.createBrief}
                  </Button>
                </div>
              );
            }}
          />
        )}
      </Card>
    </li>
  );
}
