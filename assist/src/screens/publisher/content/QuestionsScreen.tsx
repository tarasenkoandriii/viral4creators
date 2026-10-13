import { useState } from 'react';
import { useAsync } from '../../../kit';
import { Alert, Badge, Button, Card } from '../../../kit/ui';
import type {
  QuestionGroupView,
  QuestionScores,
  QuestionView,
  SourceView,
} from '../../../lib/publisher/content-api';
import {
  QUESTION_SCORE_KEYS,
  QUESTION_STAGES,
  QUESTION_STATUSES,
  type QuestionStage,
  type ScoreKey,
} from '../../../lib/publisher/states';
import { fmtText } from '../../../lib/publisher/view';
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
  LoadMore,
  NoPermission,
  Notice,
  PubErrorAlert,
  Section,
  Select,
  StatusBadge,
  TextArea,
  TextInput,
} from '../parts';
import { usePublisher } from '../publisher-context';
import type { PublisherSectionProps } from '../registry';
import { AiRunner } from './AiRunner';

/**
 * Вопросы аудитории F01 (§14.1 QuestionsScreen): оценки 0–2 с пояснением
 * по четырём критериям, «частотность неизвестна» (не ноль), выбор 6 тем с
 * местом, группы задач (вручную; AI-кластеризация в P0 выключена — ДТ-2,
 * экран показывает ручной путь).
 */
export function QuestionsScreen({ query }: PublisherSectionProps) {
  const { product, can } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const f = useListFilters('questions', query, ['status', 'groupId']);
  const q = {
    status: f.values.status || undefined,
    groupId: f.values.groupId || undefined,
  };
  const [extra, setExtra] = useState<QuestionView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const list = useAsync(async () => {
    const page = await apis.content.questions({ ...q, limit: 100 });
    setExtra([]);
    setNext(page.nextBefore);
    return page.items;
  }, [apis, product.id, q.status, q.groupId]);
  const groups = useAsync(
    async () => (await apis.content.groups({ limit: 100 })).items,
    [apis, product.id]
  );
  const sources = useAsync(
    async () =>
      (await apis.content.sources({ usage: 'allowed', limit: 100 })).items,
    [apis, product.id]
  );
  const selectedCount = useAsync(
    async () =>
      (await apis.content.questions({ status: 'selected', limit: 100 })).items
        .length,
    [apis, product.id, list.data]
  );
  const editable = can('question.manage');

  return (
    <div className="space-y-4">
      <Alert tone="neutral" title={c.questions.title}>
        {c.questions.hint}
      </Alert>
      {selectedCount.data !== null && (
        <Badge tone={selectedCount.data === 6 ? 'success' : 'warning'}>
          {fmtText(c.questions.selectedCount, { n: selectedCount.data })}
        </Badge>
      )}
      {editable ? (
        <NewQuestion sources={sources.data ?? []} onDone={list.reload} />
      ) : (
        <NoPermission />
      )}
      <Section title={c.questions.title}>
        <ListToolbar
          statuses={QUESTION_STATUSES}
          status={f.values.status}
          onStatus={(v) => f.set('status', v)}
          statusLabels={c.questions.statuses}
          csvPath={`products/${product.id}/questions`}
          csvQuery={q}
          extra={
            <Field label={c.questions.groupFilter}>
              <select
                className="w-full rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 min-h-[44px] text-sm"
                value={f.values.groupId}
                onChange={(e) => f.set('groupId', e.target.value)}
              >
                <option value="">—</option>
                {(groups.data ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.key}
                  </option>
                ))}
              </select>
            </Field>
          }
        />
        <Loadable state={list}>
          {(items) =>
            items.length + extra.length ? (
              <ul className="divide-y divide-silver-200 dark:divide-silver-800">
                {[...items, ...extra].map((x) => (
                  <QuestionRow
                    key={x.id}
                    q={x}
                    editable={editable}
                    checked={checked.includes(x.id)}
                    onCheck={(v) =>
                      setChecked((cur) =>
                        v ? [...cur, x.id] : cur.filter((y) => y !== x.id)
                      )
                    }
                    groups={groups.data ?? []}
                    onChanged={list.reload}
                  />
                ))}
                <LoadMore
                  next={next}
                  onMore={async (before) => {
                    const page = await apis.content.questions({
                      ...q,
                      before,
                      limit: 100,
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
      {editable && (
        <GroupsSection
          groups={groups.data ?? []}
          checked={checked}
          onChanged={() => {
            groups.reload();
            list.reload();
            setChecked([]);
          }}
        />
      )}
    </div>
  );
}

function QuestionRow({
  q,
  editable,
  checked,
  onCheck,
  groups,
  onChanged,
}: {
  q: QuestionView;
  editable: boolean;
  checked: boolean;
  onCheck: (v: boolean) => void;
  groups: QuestionGroupView[];
  onChanged: () => void;
}) {
  const c = usePubContent();
  const { t } = usePublisher();
  const apis = usePubApis();
  const [open, setOpen] = useState(false);
  const [scores, setScores] = useState<QuestionScores>(q.scores);
  const [rank, setRank] = useState(String(q.selectedRank ?? ''));
  const [notice, setNotice] = useState<string | null>(null);
  const m = useMutation();
  const group = groups.find((g) => g.id === q.groupId);

  const patch = async (body: Record<string, unknown>) => {
    const r = await m.run((k) =>
      apis.content.patchQuestion(
        q.id,
        { ...body, expectedRevision: q.revision },
        k
      )
    );
    if (r) {
      setNotice(c.questions.saved);
      onChanged();
    }
  };

  return (
    <li className="py-3 space-y-2">
      <div className="flex flex-wrap items-start gap-2">
        {editable && (
          <input
            type="checkbox"
            className="mt-1"
            checked={checked}
            onChange={(e) => onCheck(e.target.checked)}
            aria-label={c.questions.checked}
          />
        )}
        <span className="font-medium flex-1 min-w-0">{q.text}</span>
        <StatusBadge status={q.status} labels={c.questions.statuses} />
        {q.selectedRank !== null && (
          <Badge tone="accent">#{q.selectedRank}</Badge>
        )}
      </div>
      <div className="text-xs text-silver-500 flex flex-wrap gap-3">
        <span>
          {c.questions.stage}: {c.questions.stages[q.stage]}
        </span>
        <span
          className={
            q.frequency === null ? 'text-amber-700 dark:text-amber-400' : ''
          }
        >
          {c.questions.frequency}:{' '}
          {q.frequency === null ? c.questions.frequencyUnknown : q.frequency}
        </span>
        {q.observedRepeats !== null && (
          <span>{fmtText(c.questions.repeats, { n: q.observedRepeats })}</span>
        )}
        <span>{fmtText(c.questions.sources, { n: q.sources.length })}</span>
        {group && <span>{group.key}</span>}
      </div>
      <div className="flex flex-wrap gap-1">
        {QUESTION_SCORE_KEYS.map((k) => {
          const e = q.scores[k];
          return (
            <Badge key={k} tone={e && e.score !== null ? 'neutral' : 'warning'}>
              {c.questions.scoreKeys[k]}:{' '}
              {e && e.score !== null ? e.score : c.questions.scoreUnknown}
            </Badge>
          );
        })}
      </div>
      <Notice text={notice} />
      {editable && (
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
            {c.questions.editScores}
          </Button>
          {q.status !== 'selected' && (
            <>
              <TextInput
                value={rank}
                onChange={setRank}
                placeholder={c.questions.rank}
                type="number"
              />
              <Button
                variant="outline"
                loading={m.busy}
                disabled={!/^[1-6]$/.test(rank)}
                onClick={() =>
                  patch({ status: 'selected', selectedRank: Number(rank) })
                }
              >
                {c.questions.select}
              </Button>
            </>
          )}
          {q.status === 'selected' && (
            <Button
              variant="ghost"
              loading={m.busy}
              onClick={() => patch({ status: 'candidate', selectedRank: null })}
            >
              {c.questions.unselect}
            </Button>
          )}
          {q.status !== 'rejected' && (
            <Button
              variant="ghost"
              loading={m.busy}
              onClick={() => patch({ status: 'rejected', selectedRank: null })}
            >
              {c.questions.reject}
            </Button>
          )}
        </div>
      )}
      {open && editable && (
        <Card className="space-y-2">
          {QUESTION_SCORE_KEYS.map((k: ScoreKey) => (
            <div key={k} className="grid grid-cols-3 gap-2 items-end">
              <Field label={c.questions.scoreKeys[k]}>
                <Select
                  value={
                    scores[k]?.score === null || scores[k]?.score === undefined
                      ? ''
                      : (String(scores[k]!.score) as '0' | '1' | '2')
                  }
                  options={['0', '1', '2'] as const}
                  empty={c.questions.scoreUnknown}
                  onChange={(v) =>
                    setScores((s) => ({
                      ...s,
                      [k]: {
                        score: v === '' ? null : (Number(v) as 0 | 1 | 2),
                        why: s[k]?.why ?? null,
                      },
                    }))
                  }
                />
              </Field>
              <div className="col-span-2">
                <Field label={c.questions.why}>
                  <TextInput
                    value={scores[k]?.why ?? ''}
                    onChange={(v) =>
                      setScores((s) => ({
                        ...s,
                        [k]: { score: s[k]?.score ?? null, why: v || null },
                      }))
                    }
                    maxLength={500}
                  />
                </Field>
              </div>
            </div>
          ))}
          <Button loading={m.busy} onClick={() => patch({ scores })}>
            {t.common.save}
          </Button>
        </Card>
      )}
      <PubErrorAlert error={m.error} onReload={onChanged} />
    </li>
  );
}

function NewQuestion({
  sources,
  onDone,
}: {
  sources: SourceView[];
  onDone: () => void;
}) {
  const c = usePubContent();
  const { t } = usePublisher();
  const apis = usePubApis();
  const [text, setText] = useState('');
  const [audience, setAudience] = useState('');
  const [stage, setStage] = useState<QuestionStage | ''>('unknown');
  const [frequency, setFrequency] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const m = useMutation();
  return (
    <Section title={c.questions.add}>
      <Field label={c.questions.text}>
        <TextArea value={text} onChange={setText} rows={2} />
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label={c.questions.audience}>
          <TextInput value={audience} onChange={setAudience} />
        </Field>
        <Field label={c.questions.stage}>
          <Select
            value={stage}
            options={QUESTION_STAGES}
            labels={c.questions.stages}
            onChange={setStage}
          />
        </Field>
        <Field
          label={c.questions.frequency}
          hint={c.questions.frequencyUnknown}
        >
          <TextInput value={frequency} onChange={setFrequency} type="number" />
        </Field>
      </div>
      {sources.length > 0 && (
        <Field label={c.questions.pickSources}>
          <div className="max-h-40 overflow-auto space-y-1">
            {sources.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={picked.includes(s.id)}
                  onChange={(e) =>
                    setPicked((p) =>
                      e.target.checked
                        ? [...p, s.id]
                        : p.filter((x) => x !== s.id)
                    )
                  }
                />
                {s.title ?? s.id}
              </label>
            ))}
          </div>
        </Field>
      )}
      <Notice text={notice} />
      <PubErrorAlert error={m.error} />
      <Button
        loading={m.busy}
        disabled={!text.trim() || !stage}
        onClick={async () => {
          if (!stage) return;
          const r = await m.run((k) =>
            apis.content.createQuestion(
              {
                text: text.trim(),
                audience: audience.trim() || null,
                stage,
                // Пусто — частотность НЕ измерялась (null), не ноль.
                frequency: frequency === '' ? null : Number(frequency),
                sources: picked.map((sourceId) => ({ sourceId })),
              },
              k
            )
          );
          if (r) {
            setNotice(c.questions.added);
            setText('');
            setPicked([]);
            onDone();
          }
        }}
      >
        {t.common.add}
      </Button>
    </Section>
  );
}

function GroupsSection({
  groups,
  checked,
  onChanged,
}: {
  groups: QuestionGroupView[];
  checked: string[];
  onChanged: () => void;
}) {
  const c = usePubContent();
  const apis = usePubApis();
  const [key, setKey] = useState('');
  const [task, setTask] = useState('');
  const [stage, setStage] = useState<QuestionStage | ''>('unknown');
  const [rationale, setRationale] = useState('');
  const [mergeRisk, setMergeRisk] = useState('');
  const [move, setMove] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const m = useMutation();
  const pm = useMutation();
  return (
    <Section title={c.questions.groups}>
      <AiRunner
        generator="pub.questions.cluster"
        label={c.questions.aiCluster}
        manualHint={c.questions.aiClusterManual}
        disabled={checked.length < 2}
        start={(k) => apis.ai.questionsCluster(checked, k)}
        render={() => null}
      />
      <div className="text-xs text-silver-500">
        {fmtText(c.questions.checked, { n: checked.length })}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <Field label={c.questions.groupKey}>
          <TextInput value={key} onChange={setKey} maxLength={64} />
        </Field>
        <Field label={c.questions.stage}>
          <Select
            value={stage}
            options={QUESTION_STAGES}
            labels={c.questions.stages}
            onChange={setStage}
          />
        </Field>
      </div>
      <Field label={c.questions.groupTask}>
        <TextInput value={task} onChange={setTask} maxLength={500} />
      </Field>
      <Field label={c.questions.groupRationale}>
        <TextArea value={rationale} onChange={setRationale} rows={2} />
      </Field>
      <Field label={c.questions.groupMergeRisk}>
        <TextInput value={mergeRisk} onChange={setMergeRisk} maxLength={500} />
      </Field>
      <label className="text-sm flex items-center gap-2">
        <input
          type="checkbox"
          checked={move}
          onChange={(e) => setMove(e.target.checked)}
        />
        {c.questions.groupMove}
      </label>
      <Notice text={notice} />
      <PubErrorAlert error={m.error} />
      <Button
        loading={m.busy}
        disabled={
          !checked.length ||
          !key.trim() ||
          !task.trim() ||
          !rationale.trim() ||
          !stage
        }
        onClick={async () => {
          if (!stage) return;
          const r = await m.run((k) =>
            apis.content.createGroup(
              {
                key: key.trim(),
                task: task.trim(),
                stage,
                rationale: rationale.trim(),
                mergeRisk: mergeRisk.trim() || null,
                questionIds: checked,
                moveFromOtherGroups: move,
              },
              k
            )
          );
          if (r) {
            setNotice(c.questions.groupCreated);
            setKey('');
            setTask('');
            setRationale('');
            setMergeRisk('');
            onChanged();
          }
        }}
      >
        {c.questions.groupCreate}
      </Button>
      {groups.length > 0 && (
        <ul className="divide-y divide-silver-200 dark:divide-silver-800">
          {groups.map((g) => (
            <li key={g.id} className="py-2 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-xs break-all">{g.key}</code>
                <span className="flex-1 min-w-0">{g.task}</span>
                <StatusBadge
                  status={g.status}
                  labels={c.questions.groupStatuses}
                />
                <span className="text-xs text-silver-500">
                  {g.questionIds.length}
                </span>
              </div>
              {g.mergeRisk && (
                <div className="text-xs text-amber-700">{g.mergeRisk}</div>
              )}
              {(g.status === 'proposed' || g.status === 'confirmed') && (
                <div className="flex flex-wrap gap-2">
                  {g.status === 'proposed' && (
                    <Button
                      variant="ghost"
                      loading={pm.busy}
                      onClick={async () => {
                        const r = await pm.run((k) =>
                          apis.content.patchGroup(
                            g.id,
                            {
                              status: 'confirmed',
                              expectedRevision: g.revision,
                            },
                            k
                          )
                        );
                        if (r) onChanged();
                      }}
                    >
                      {c.questions.groupConfirm}
                    </Button>
                  )}
                  {(['split', 'rejected'] as const).map((st) => (
                    <Button
                      key={st}
                      variant="ghost"
                      loading={pm.busy}
                      onClick={async () => {
                        const r = await pm.run((k) =>
                          apis.content.patchGroup(
                            g.id,
                            { status: st, expectedRevision: g.revision },
                            k
                          )
                        );
                        if (r) onChanged();
                      }}
                    >
                      {st === 'split'
                        ? c.questions.groupSplit
                        : c.questions.groupReject}
                    </Button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <PubErrorAlert error={pm.error} onReload={onChanged} />
    </Section>
  );
}
