import { useState } from 'react';
import { useAsync } from '../../../kit';
import { Alert, Badge, Button } from '../../../kit/ui';
import type { BriefView } from '../../../lib/publisher/content-api';
import { BRIEF_FORMATS, type BriefFormat } from '../../../lib/publisher/states';
import { fmtText } from '../../../lib/publisher/view';
import { useMutation, usePubApis, usePubContent } from '../hooks';
import {
  ConfirmButton,
  Field,
  Loadable,
  NoPermission,
  Notice,
  PubErrorAlert,
  RecordLink,
  Section,
  Select,
  StatusBadge,
  TextArea,
  TextInput,
} from '../parts';
import { usePublisher } from '../publisher-context';
import type { PublisherSectionProps } from '../registry';

const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Бриф F03 (§14.1 `briefs/:id`): поля, «чего не хватает» до готовности
 * (`missing` сервера, а не догадка экрана), «готов», отклонение, создание
 * статьи из готового брифа. Без id — к плану тем.
 */
export function BriefScreen({ id }: PublisherSectionProps) {
  const { product } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const brief = useAsync(
    async () => (id ? apis.content.brief(id) : null),
    [apis, product.id, id]
  );
  if (!id) {
    return <RecordLink section="plan">{c.plan.title}</RecordLink>;
  }
  return (
    <Loadable state={brief}>
      {(b) =>
        b ? (
          <BriefEditor key={b.revision} brief={b} onReload={brief.reload} />
        ) : null
      }
    </Loadable>
  );
}

function BriefEditor({
  brief: b,
  onReload,
}: {
  brief: BriefView;
  onReload: () => void;
}) {
  const { t, can, go } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const question = useAsync(
    async () =>
      (await apis.content.questions({ limit: 100 })).items.find(
        (q) => q.id === b.questionId
      ) ?? null,
    [apis, b.questionId]
  );
  const sources = useAsync(
    async () =>
      (await apis.content.sources({ usage: 'allowed', limit: 100 })).items,
    [apis]
  );
  const [goal, setGoal] = useState(b.goal);
  const [format, setFormat] = useState<BriefFormat | ''>(b.format);
  const [own, setOwn] = useState(b.ownContribution ?? '');
  const [shortAnswer, setShortAnswer] = useState(b.shortAnswer ?? '');
  const [cta, setCta] = useState(b.cta ?? '');
  const [ctaNote, setCtaNote] = useState(b.ctaIntentNote ?? '');
  const [structure, setStructure] = useState(b.structure.join('\n'));
  const [channels, setChannels] = useState(b.channels.join('\n'));
  const [criteria, setCriteria] = useState(b.readinessCriteria.join('\n'));
  const [effort, setEffort] = useState(
    b.effortMinutes === null ? '' : String(b.effortMinutes)
  );
  const [unresolved, setUnresolved] = useState(b.unresolved.join('\n'));
  const [sourceIds, setSourceIds] = useState<string[]>(b.sourceIds);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation();
  const ready = useMutation();
  const reject = useMutation();
  const material = useMutation();
  const editable = can('brief.manage');

  return (
    <div className="space-y-4">
      <Section
        title={c.brief.title}
        action={<StatusBadge status={b.status} labels={c.plan.briefStatuses} />}
      >
        {question.data && (
          <div className="text-sm">
            <span className="text-silver-500">{c.brief.question}: </span>
            <RecordLink section="questions">{question.data.text}</RecordLink>
          </div>
        )}
        {b.aiCallId && (
          <div className="text-xs text-silver-500">
            {fmtText(c.brief.aiRef, { id: b.aiCallId })}
          </div>
        )}
        <Alert
          tone={b.missing.length ? 'warning' : 'neutral'}
          title={c.brief.missingTitle}
        >
          {b.missing.length ? (
            <ul className="list-disc pl-5">
              {b.missing.map((m) => (
                <li key={m}>{c.brief.missing[m]}</li>
              ))}
            </ul>
          ) : (
            c.brief.readyOk
          )}
        </Alert>
        <Notice text={notice} />
        {!editable && <NoPermission />}
        <fieldset disabled={!editable} className="space-y-2">
          <Field label={c.brief.fields.goal}>
            <TextInput value={goal} onChange={setGoal} maxLength={500} />
          </Field>
          <Field label={c.brief.fields.format}>
            <Select
              value={format}
              options={BRIEF_FORMATS}
              labels={c.plan.formats}
              onChange={setFormat}
            />
          </Field>
          <Field label={c.brief.fields.ownContribution}>
            <TextArea value={own} onChange={setOwn} />
          </Field>
          <Field label={c.brief.fields.shortAnswer}>
            <TextArea value={shortAnswer} onChange={setShortAnswer} />
          </Field>
          <div className="grid gap-2 md:grid-cols-2">
            <Field label={c.brief.fields.cta}>
              <TextInput value={cta} onChange={setCta} maxLength={300} />
            </Field>
            <Field label={c.brief.fields.ctaIntentNote}>
              <TextInput
                value={ctaNote}
                onChange={setCtaNote}
                maxLength={500}
              />
            </Field>
          </div>
          <Field label={c.brief.fields.structure}>
            <TextArea value={structure} onChange={setStructure} rows={4} />
          </Field>
          <div className="grid gap-2 md:grid-cols-2">
            <Field label={c.brief.fields.channels}>
              <TextArea value={channels} onChange={setChannels} />
            </Field>
            <Field label={c.brief.fields.readinessCriteria}>
              <TextArea value={criteria} onChange={setCriteria} />
            </Field>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <Field label={c.brief.fields.effortMinutes}>
              <TextInput value={effort} onChange={setEffort} type="number" />
            </Field>
            <Field label={c.brief.fields.unresolved}>
              <TextArea value={unresolved} onChange={setUnresolved} />
            </Field>
          </div>
          <Field label={c.brief.fields.sourceIds}>
            <div className="max-h-40 overflow-auto space-y-1">
              {(sources.data ?? []).map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={sourceIds.includes(s.id)}
                    onChange={(e) =>
                      setSourceIds((p) =>
                        e.target.checked
                          ? [...p, s.id]
                          : p.filter((x) => x !== s.id)
                      )
                    }
                  />
                  {s.title ?? s.id}
                </label>
              ))}
              {sourceIds
                .filter((x) => !(sources.data ?? []).some((s) => s.id === x))
                .map((x) => (
                  <Badge key={x} tone="warning">
                    {x}
                  </Badge>
                ))}
            </div>
          </Field>
        </fieldset>
        <PubErrorAlert
          error={save.error ?? ready.error ?? reject.error}
          onReload={onReload}
        />
        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              loading={save.busy}
              disabled={!goal.trim() || !format}
              onClick={async () => {
                if (!format) return;
                const r = await save.run((k) =>
                  apis.content.patchBrief(
                    b.id,
                    {
                      expectedRevision: b.revision,
                      goal: goal.trim(),
                      format,
                      ownContribution: own.trim() || null,
                      shortAnswer: shortAnswer.trim() || null,
                      cta: cta.trim() || null,
                      ctaIntentNote: ctaNote.trim() || null,
                      structure: lines(structure),
                      channels: lines(channels),
                      readinessCriteria: lines(criteria),
                      effortMinutes: effort === '' ? null : Number(effort),
                      unresolved: lines(unresolved),
                      sourceIds,
                    },
                    k
                  )
                );
                if (r) {
                  setNotice(c.brief.saved);
                  onReload();
                }
              }}
            >
              {t.common.save}
            </Button>
            {b.status === 'draft' && (
              <Button
                loading={ready.busy}
                onClick={async () => {
                  const r = await ready.run((k) =>
                    apis.content.briefReady(b.id, b.revision, k)
                  );
                  if (r) {
                    setNotice(c.brief.ready);
                    onReload();
                  }
                }}
              >
                {c.brief.markReady}
              </Button>
            )}
            {b.status !== 'rejected' && (
              <ConfirmButton
                loading={reject.busy}
                onConfirm={async () => {
                  const r = await reject.run((k) =>
                    apis.content.patchBrief(
                      b.id,
                      { expectedRevision: b.revision, status: 'rejected' },
                      k
                    )
                  );
                  if (r) onReload();
                }}
              >
                {c.brief.rejectBrief}
              </ConfirmButton>
            )}
          </div>
        )}
      </Section>
      {b.status === 'ready' && can('version.manage') && (
        <Section title={c.brief.createMaterial}>
          <PubErrorAlert error={material.error} />
          <Button
            loading={material.busy}
            onClick={async () => {
              const r = await material.run((k) =>
                apis.content.createContent(
                  { kind: 'article', briefId: b.id },
                  k
                )
              );
              if (r) go('materials', r.id);
            }}
          >
            {c.brief.createMaterial}
          </Button>
        </Section>
      )}
    </div>
  );
}
