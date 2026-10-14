/**
 * P-R M2 — студия Reddit-материала (`reddit/<cid>?tab=studio`, §M2.5–M2.6,
 * §7): генерация 2–3 вариантов (при `PUB_AI_DISABLED`/флаге off — ручной
 * путь «написать самому», без потери ввода), сравнение вариантов, выбор →
 * черновик (`aiCallId` + `variantIndex`), редактор черновика (у comment
 * нет заголовка), счётчик слов, безопасный предпросмотр (приблизительно),
 * «перегенерировать абзац» (только в черновик), версии и diff (общий
 * маршрут), панели утверждений/правил/раскрытия, проверка `reddit_policy`
 * (BLOCK — словами, WARN — подтверждаются при согласовании), проверки
 * человека, согласование (PO, пометка автора), копирование РОВНО
 * утверждённого текста (PO/OP; копирование ≠ публикация), «Открыть Reddit»
 * по сохранённому URL и отметка о публикации «со слов пользователя» (без
 * «подтверждено»). Кабинет к Reddit не обращается (A11).
 */
import { useState } from 'react';
import { Alert, Badge, Button } from '../../../kit/ui';
import { useAsync } from '../../../kit';
import { pollCall, type AiCallView } from '../../../lib/publisher/ai-api';
import type {
  QaCheckView,
  QaFindingParams,
  VersionView,
} from '../../../lib/publisher/content-api';
import {
  REDDIT_AFFILIATIONS,
  REDDIT_DRAFT_TEMPLATES,
  type RedditAffiliation,
  type RedditBriefView,
  type RedditCopyView,
  type RedditDraftTemplate,
  type RedditMaterialView,
  type RedditPublicationView,
} from '../../../lib/publisher/reddit-studio-api';
import { publicationTransitionBody } from '../../../lib/publisher/channels-view';
import {
  ackWarningsOf,
  approveAckBody,
  approveRedditBody,
  findingText,
  DISCLOSURE_CODES,
  draftForm,
  draftIssues,
  draftPatchBody,
  withAiChoice,
  humanQaBody,
  manualPathShown,
  manualVersionBody,
  materialSteps,
  studioPanels,
  paragraphs,
  replaceParagraph,
  reportBody,
  reportIssues,
  rewrittenParagraph,
  rulesBasis,
  variantVersionBody,
  variantsOf,
  type DraftForm,
} from '../../../lib/publisher/reddit-studio-view';
import { fmtDateTime, fmtText } from '../../../lib/publisher/view';
import { useMutation, usePubApis, usePubContent } from '../hooks';
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
  StatusBadge,
  TextArea,
  TextInput,
} from '../parts';
import { ActionBlock } from '../ops/ops-parts';
import type { PublisherSectionProps } from '../registry';
import {
  useProductSources,
  useRebaseForm,
  useRedditStudio,
} from './reddit-hooks';
import {
  ConflictPanel,
  GateBlock,
  PlainQuote,
  ReadOnlyNote,
  RedditLink,
  Wrap,
} from './reddit-parts';
import {
  CopyBlock,
  MarkdownPreview,
  StudioErrorAlert,
  WordCount,
} from './studio-parts';

export function StudioTab({ id, query }: PublisherSectionProps) {
  const { r, studio } = useRedditStudio();
  const state = useAsync(
    async () => (id ? studio.material(id) : null),
    [studio, id]
  );
  if (!id) return <Alert tone="neutral">{r.common.notFound}</Alert>;
  return (
    <Loadable state={state}>
      {(m) =>
        m ? (
          <StudioBody m={m} reload={state.reload} callId={query.call ?? ''} />
        ) : null
      }
    </Loadable>
  );
}

function StudioBody({
  m,
  reload,
  callId,
}: {
  m: RedditMaterialView;
  reload: () => void;
  callId: string;
}) {
  const { r, studio, locale, canVersion, canHandoff, canApprove } =
    useRedditStudio();
  const apis = usePubApis();
  const brief = useAsync(
    () => studio.brief(m.briefId),
    [studio, m.briefId, m.content.revision]
  );
  const versions = useAsync(
    () => apis.content.versions(m.content.id),
    [apis, m.content.id, m.content.revision, m.currentVersion?.revision]
  );
  const steps = materialSteps(m);
  const panels = studioPanels(steps, { canVersion, canApprove, canHandoff });
  const draft = m.currentVersion?.status === 'draft' ? m.currentVersion : null;
  const refresh = () => {
    reload();
    versions.reload();
  };
  const passed = m.policyCheck?.result === 'pass';
  const reported = m.publications.find((p) => p.status === 'published') ?? null;
  return (
    <div className="space-y-4">
      <RecordLink section="reddit" id={m.briefId} query={{ tab: 'briefs' }}>
        {r.studio.back}
      </RecordLink>
      <Section
        title={r.studio.title}
        action={
          <StatusBadge status={m.content.status} labels={r.studio.statuses} />
        }
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Badge tone="neutral">{r.briefs.contentTypes[m.contentType]}</Badge>
          <span className="text-sm">r/{m.subreddit}</span>
          <RedditLink url={m.openUrl}>
            {m.contentType === 'comment'
              ? r.studio.openThread
              : r.studio.openCommunity}
          </RedditLink>
          {/* После отметки — сохранённый finalUrl (со слов пользователя). */}
          {reported && (
            <RedditLink url={reported.finalUrl}>
              {r.studio.openReddit}
            </RedditLink>
          )}
        </div>
        <div className="text-sm">
          {m.rules
            ? passed
              ? rulesBasis(m, r, (iso) => fmtDateTime(iso, locale))
              : fmtText(r.studio.rulesSnapshot, {
                  v: m.rules.version,
                  date: fmtDateTime(m.rules.checkedAt, locale),
                })
            : r.studio.rulesNone}
        </div>
        {steps.unscheduleFirst && (
          <Alert tone="warning">{r.studio.unscheduleFirst}</Alert>
        )}
      </Section>
      <Loadable state={brief}>
        {(b) => (
          <>
            {panels.write && (
              <GeneratePanel
                m={m}
                b={b}
                draft={draft}
                initialCallId={
                  callId ||
                  m.lastGeneration?.callId ||
                  m.currentVersion?.aiCallId ||
                  ''
                }
                onChosen={refresh}
              />
            )}
            {panels.write ? (
              draft ? (
                <DraftEditor
                  key={draft.id}
                  m={m}
                  b={b}
                  draft={draft}
                  onSaved={refresh}
                />
              ) : (
                <ManualDraft m={m} b={b} onSaved={refresh} />
              )
            ) : null}
            <DisclosurePanel
              b={b}
              v={m.currentVersion ?? m.approvedVersion}
              check={m.policyCheck}
            />
          </>
        )}
      </Loadable>
      <Loadable state={versions}>
        {(vs) => <VersionsPanel m={m} versions={vs} />}
      </Loadable>
      <EvidencePanel v={m.currentVersion ?? m.approvedVersion} />
      <RulesPanel m={m} />
      <PolicyPanel m={m} onChanged={refresh} />
      {m.currentVersion?.status === 'submitted' && (
        <HumanQaPanel v={m.currentVersion} />
      )}
      {panels.approve && m.currentVersion && (
        <ApprovePanel
          key={m.policyCheck?.id ?? 'no-check'}
          m={m}
          v={m.currentVersion}
          onDone={refresh}
        />
      )}
      {m.content.allowedTransitions.includes('changes_requested') &&
        canApprove && (
          <TransitionPanel
            m={m}
            to="changes_requested"
            title={r.studio.approve.requestChanges}
            reasonLabel={r.studio.approve.requestReason}
            onDone={refresh}
          />
        )}
      {steps.unscheduleFirst &&
        m.content.allowedTransitions.includes('approved') &&
        canHandoff && (
          <TransitionPanel
            m={m}
            to="approved"
            title={r.studio.unschedule}
            reasonLabel={r.studio.unscheduleReason}
            onDone={refresh}
          />
        )}
      {panels.copy && <CopyPanel m={m} onCopied={reload} />}
      {panels.report && <ReportPanel m={m} onDone={reload} />}
      <PublicationsPanel m={m} onChanged={reload} />
      {!canVersion && !canHandoff && !canApprove && <ReadOnlyNote />}
    </div>
  );
}

// ── Генерация и варианты ──────────────────────────────────────────────────

function useCallRunner() {
  const apis = usePubApis();
  const [live, setLive] = useState<AiCallView | null>(null);
  const [polling, setPolling] = useState(false);
  const settle = async (callId: string, call: AiCallView | null) => {
    if (call && call.status !== 'running') {
      setLive(call);
      return;
    }
    setPolling(true);
    try {
      setLive(await pollCall(apis.ai, callId));
    } finally {
      setPolling(false);
    }
  };
  return { live, setLive, polling, settle };
}

function GeneratePanel({
  m,
  b,
  draft,
  initialCallId,
  onChosen,
}: {
  m: RedditMaterialView;
  b: RedditBriefView;
  draft: VersionView | null;
  initialCallId: string;
  onChosen: () => void;
}) {
  const { r, studio, studioAi, canGenerate, go, locale } = useRedditStudio();
  const apis = usePubApis();
  const gen = useMutation();
  const pick = useMutation();
  const runner = useCallRunner();
  const [template, setTemplate] = useState<RedditDraftTemplate | ''>(
    m.contentType === 'comment' ? 'helpful_answer' : 'educational_post'
  );
  const [count, setCount] = useState<'2' | '3'>('3');
  const [request, setRequest] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const content = usePubContent();
  const src = useProductSources();
  // Удачные ПОЛНЫЕ генерации ЭТОГО брифа (задача брифа), новые сверху;
  // переписывания абзацев сюда не входят (аудит S3-2).
  const calls = useAsync(async () => {
    try {
      return (
        await apis.ai.calls({
          objectId: b.id,
          generator: 'pub.reddit.draft',
          limit: 50,
        })
      ).items.filter((x) => x.status === 'ok');
    } catch {
      return [];
    }
  }, [apis, b.id, runner.live?.callId]);
  const okCalls = calls.data ?? [];
  const [sel, setSel] = useState('');
  // `?call=` — только вызов этого брифа.
  const fromQuery = okCalls.some((x) => x.callId === initialCallId)
    ? initialCallId
    : '';
  const chosenId = sel || fromQuery || okCalls[0]?.callId || '';
  const stored = useAsync(
    async () => (chosenId ? apis.ai.call(chosenId) : null),
    [apis, chosenId]
  );
  const call = (sel ? null : runner.live) ?? stored.data ?? null;
  const variants = variantsOf(call);
  const draftHasText = !!draft && !!draft.body.trim();
  const manual = manualPathShown(b.ai, gen.error);
  return (
    <Section title={r.studio.generate.title}>
      {!b.ai.available && b.ai.reason && (
        <Alert tone="neutral">{r.briefs.ai[b.ai.reason]}</Alert>
      )}
      {manual && (
        <Alert tone="neutral" title={r.studio.manual.title}>
          {r.studio.manual.hint}
        </Alert>
      )}
      {canGenerate && b.ai.available && (
        <div className="space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Field label={r.studio.generate.template}>
              <Select
                value={template}
                options={REDDIT_DRAFT_TEMPLATES}
                labels={r.studio.generate.templates}
                onChange={setTemplate}
              />
            </Field>
            <Field label={r.studio.generate.count}>
              <Select
                value={count}
                options={['2', '3'] as const}
                onChange={(x) => setCount(x || '3')}
              />
            </Field>
          </div>
          <Field label={r.studio.generate.request}>
            <TextArea
              value={request}
              maxLength={1000}
              rows={2}
              onChange={setRequest}
            />
          </Field>
          <StudioErrorAlert error={gen.error} />
          <Button
            loading={gen.busy || runner.polling}
            disabled={!template}
            onClick={async () => {
              if (!template) return;
              setNotice(null);
              const body = {
                template,
                variants: Number(count) as 2 | 3,
                ...(request.trim() ? { request: request.trim() } : {}),
              };
              const x = await gen.run(
                (k) => studioAi.generate(b.id, k, body),
                `gen:${b.id}:${JSON.stringify(body)}`
              );
              if (!x) return;
              go('reddit', m.content.id, { tab: 'studio', call: x.callId });
              await runner.settle(x.callId, x.call);
            }}
          >
            {runner.polling ? r.studio.generate.running : r.studio.generate.run}
          </Button>
        </div>
      )}
      {call && call.status === 'running' && !runner.polling && (
        <Alert tone="neutral">{r.studio.generate.stillRunning}</Alert>
      )}
      {okCalls.length > 1 && (
        <Field label={r.studio.generate.callSet}>
          <Select
            value={chosenId}
            options={okCalls.map((x) => x.callId)}
            labels={Object.fromEntries(
              okCalls.map((x) => [
                x.callId,
                fmtText(r.studio.generate.callAt, {
                  date: fmtDateTime(x.requestedAt, locale),
                }),
              ])
            )}
            onChange={(v) => setSel(v)}
          />
        </Field>
      )}
      {call && call.status !== 'running' && !variants && (
        <Alert tone="warning">
          {fmtText(r.studio.generate.failed, {
            status:
              (content.ai.callStatuses as Record<string, string>)[
                call.status
              ] ?? call.status,
          })}
        </Alert>
      )}
      {call && call.findings.length > 0 && (
        <Alert tone="warning" title={r.studio.generate.findings}>
          <ul className="list-disc pl-5">
            {call.findings.map((f, i) => (
              <li key={i}>
                {(r.studio.generate.findingCodes as Record<string, string>)[
                  f.code
                ] ?? r.studio.findings.other}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {variants && call && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {variants.map((v, i) => (
            <div
              key={i}
              data-reddit-variant={i}
              className="rounded-xl border border-silver-200 dark:border-silver-800 p-3 space-y-2 min-w-0"
            >
              <div className="font-medium text-sm">
                {fmtText(r.studio.generate.variant, { n: i + 1 })}
              </div>
              {m.contentType === 'post' && v.title && (
                <div className="font-semibold break-words">{v.title}</div>
              )}
              <PlainQuote text={v.body} />
              <WordCount text={v.body} />
              {v.claim_map.length > 0 && (
                <div className="text-xs space-y-0.5">
                  <div className="text-silver-500">
                    {r.studio.generate.claimMap}
                  </div>
                  <ul className="list-disc pl-5">
                    {v.claim_map.map((c, j) => (
                      <li key={j} className="break-words">
                        {c.text} (
                        {c.source_ids === 'needs_verification'
                          ? r.studio.evidence.needsVerification
                          : c.source_ids
                              .map((x) => src.titles.get(x) ?? x)
                              .join(', ')}
                        )
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {v.uncertainties.length > 0 && (
                <div className="text-xs">
                  <span className="text-silver-500">
                    {r.studio.generate.uncertainties}:
                  </span>{' '}
                  {v.uncertainties.join('; ')}
                </div>
              )}
              <ChooseVariant
                confirm={draftHasText}
                loading={pick.busy}
                label={r.studio.generate.choose}
                hint={r.studio.generate.replaceDraft}
                onChoose={async () => {
                  const body = variantVersionBody(
                    m.contentType,
                    v,
                    call.callId,
                    i
                  );
                  const x = await pick.run(
                    (k) =>
                      draft
                        ? studio.patchVersion(m.content.id, draft.id, k, {
                            expectedRevision: draft.revision,
                            ...body,
                          })
                        : studio.createVersion(m.content.id, k, body),
                    `pick:${call.callId}:${i}:${draft?.revision ?? 'new'}`
                  );
                  if (x) {
                    setNotice(r.studio.generate.chosen);
                    onChosen();
                  }
                }}
              />
            </div>
          ))}
        </div>
      )}
      <StudioErrorAlert error={pick.error} onReload={onChosen} />
      <Notice text={notice} />
    </Section>
  );
}

/**
 * «Взяти в чернетку»: поверх непустого черновика — подтверждение (аудит
 * S3-3: ручной текст черновика не версия, в истории его нет).
 */
function ChooseVariant({
  confirm,
  loading,
  label,
  hint,
  onChoose,
}: {
  confirm: boolean;
  loading: boolean;
  label: string;
  hint: string;
  onChoose: () => void;
}) {
  if (!confirm)
    return (
      <Button variant="outline" loading={loading} onClick={onChoose}>
        {label}
      </Button>
    );
  return (
    <div className="space-y-1">
      <ConfirmButton variant="outline" loading={loading} onConfirm={onChoose}>
        {label}
      </ConfirmButton>
      <div className="text-xs text-silver-500">{hint}</div>
    </div>
  );
}

// ── Черновик ─────────────────────────────────────────────────────────────

function DraftFields({
  m,
  b,
  v,
  set,
}: {
  m: RedditMaterialView;
  b: RedditBriefView;
  v: DraftForm;
  set: (v: DraftForm) => void;
}) {
  const { r } = useRedditStudio();
  const issues = draftIssues(m.contentType, v);
  return (
    <>
      {m.contentType === 'post' ? (
        <Field label={r.studio.draft.fields.title}>
          <TextInput
            value={v.title}
            maxLength={300}
            onChange={(x) => set({ ...v, title: x })}
          />
        </Field>
      ) : (
        <div className="text-xs text-silver-500">
          {r.studio.draft.commentNoTitle}
        </div>
      )}
      <Field
        label={r.studio.draft.fields.disclosure}
        hint={
          b.affiliation && b.affiliation !== 'none'
            ? r.studio.draft.disclosureRule
            : undefined
        }
      >
        <TextInput
          value={v.disclosure}
          maxLength={300}
          onChange={(x) => set({ ...v, disclosure: x })}
        />
      </Field>
      <Field label={r.studio.draft.fields.body}>
        <TextArea
          value={v.body}
          rows={12}
          maxLength={m.contentType === 'comment' ? 10_000 : 40_000}
          onChange={(x) => set({ ...v, body: x })}
        />
      </Field>
      <WordCount text={v.body} />
      <Field label={r.studio.draft.fields.flair}>
        <TextInput
          value={v.flair}
          maxLength={64}
          onChange={(x) => set({ ...v, flair: x })}
        />
      </Field>
      <div className="text-xs text-silver-500">{r.studio.draft.claimHint}</div>
      {issues.length > 0 && (
        <ul className="text-xs list-disc pl-5 text-amber-700 dark:text-amber-400">
          {issues.map((x) => (
            <li key={x}>{r.studio.draft.issues[x]}</li>
          ))}
        </ul>
      )}
      <ActionBlock title={r.studio.preview.title}>
        <MarkdownPreview text={v.body} />
      </ActionBlock>
    </>
  );
}

function ManualDraft({
  m,
  b,
  onSaved,
}: {
  m: RedditMaterialView;
  b: RedditBriefView;
  onSaved: () => void;
}) {
  const { r, studio } = useRedditStudio();
  const mu = useMutation();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<DraftForm>(draftForm());
  const body = manualVersionBody(m.contentType, v);
  return (
    <Section title={r.studio.draft.newDraft}>
      {!open ? (
        <Button variant="outline" onClick={() => setOpen(true)}>
          {r.studio.manual.start}
        </Button>
      ) : (
        <>
          <DraftFields m={m} b={b} v={v} set={setV} />
          <StudioErrorAlert error={mu.error} onReload={onSaved} />
          <Button
            loading={mu.busy}
            disabled={!body}
            onClick={async () => {
              if (!body) return;
              const x = await mu.run(
                (k) => studio.createVersion(m.content.id, k, body),
                JSON.stringify(body)
              );
              if (x) onSaved();
            }}
          >
            {r.studio.draft.save}
          </Button>
        </>
      )}
    </Section>
  );
}

function DraftEditor({
  m,
  b,
  draft,
  onSaved,
}: {
  m: RedditMaterialView;
  b: RedditBriefView;
  draft: VersionView;
  onSaved: () => void;
}) {
  const { r, studio } = useRedditStudio();
  const apis = usePubApis();
  const save = useMutation();
  const submit = useMutation();
  const [notice, setNotice] = useState<string | null>(null);
  const f = useRebaseForm<DraftForm>(draftForm(draft), draft.revision);
  // Принятый вариант переписывания уходит с правкой черновика (§10.9).
  const [choice, setChoice] = useState<{
    aiCallId: string;
    variantIndex: number;
  } | null>(null);
  const patch = f.conflicts.length
    ? null
    : withAiChoice(draftPatchBody(m.contentType, draft, f.v, f.base), choice);
  const dirty =
    f.v.title !== f.base.title ||
    f.v.body !== f.base.body ||
    f.v.disclosure !== f.base.disclosure ||
    f.v.flair !== f.base.flair;
  return (
    <Section title={r.studio.draft.title}>
      <div className="text-xs text-silver-500">
        {fmtText(r.studio.versions.version, { n: draft.number })}
        {draft.aiCallId &&
          ` · ${fmtText(r.studio.generate.call, { id: draft.aiCallId })}`}
      </div>
      <DraftFields m={m} b={b} v={f.v} set={f.set} />
      <ConflictPanel
        conflicts={f.conflicts}
        label={(k) => r.studio.draft.fields[k]}
        show={(_k, x) => String(x)}
        resolve={f.resolve}
      />
      <Notice text={notice} />
      <StudioErrorAlert error={save.error} onReload={onSaved} />
      <div className="flex flex-wrap gap-2">
        <Button
          loading={save.busy}
          disabled={!patch}
          onClick={async () => {
            if (!patch) return;
            const x = await save.run(
              (k) => studio.patchVersion(m.content.id, draft.id, k, patch),
              JSON.stringify(patch)
            );
            if (x) {
              setNotice(r.studio.draft.saved);
              setChoice(null);
              onSaved();
            }
          }}
        >
          {r.studio.draft.save}
        </Button>
        <Button
          variant="outline"
          loading={submit.busy}
          disabled={dirty || !draft.body.trim()}
          onClick={async () => {
            const x = await submit.run(
              (k) =>
                apis.content.submitVersion(
                  m.content.id,
                  draft.id,
                  draft.revision,
                  k
                ),
              `submit:${draft.id}:${draft.revision}`
            );
            if (x) onSaved();
          }}
        >
          {r.studio.draft.submit}
        </Button>
      </div>
      <div className="text-xs text-silver-500">{r.studio.draft.submitHint}</div>
      <StudioErrorAlert error={submit.error} onReload={onSaved} />
      <RewritePanel
        m={m}
        b={b}
        draft={draft}
        disabled={dirty}
        onApply={(index, text, c) => {
          f.set({ ...f.v, body: replaceParagraph(f.v.body, index, text) });
          setChoice(c);
        }}
      />
    </Section>
  );
}

function RewritePanel({
  m,
  b,
  draft,
  disabled,
  onApply,
}: {
  m: RedditMaterialView;
  b: RedditBriefView;
  draft: VersionView;
  disabled: boolean;
  /** Абзац варианта → черновик; `choice` — вызов и индекс (§10.9). */
  onApply: (
    index: number,
    text: string,
    choice: { aiCallId: string; variantIndex: number }
  ) => void;
}) {
  const { r, studioAi, canGenerate } = useRedditStudio();
  const gen = useMutation();
  const runner = useCallRunner();
  const [idx, setIdx] = useState('');
  // Номер абзаца фиксируется в момент запроса (аудит S3-1).
  const [reqIdx, setReqIdx] = useState(-1);
  const content = usePubContent();
  const [notice, setNotice] = useState<string | null>(null);
  const ps = paragraphs(draft.body);
  if (!canGenerate || !b.ai.available || ps.length === 0) return null;
  const n = idx === '' ? -1 : Number(idx);
  const variants = variantsOf(runner.live);
  const options = ps.map((_, i) => String(i));
  return (
    <ActionBlock title={r.studio.rewrite.title}>
      <div className="text-xs text-silver-500">{r.studio.rewrite.hint}</div>
      {disabled && <Alert tone="neutral">{r.studio.rewrite.saveFirst}</Alert>}
      <Field label={r.studio.rewrite.paragraph}>
        <Select
          value={idx}
          options={options}
          labels={Object.fromEntries(
            ps.map((p, i) => [
              String(i),
              `${i + 1}: ${[...p].slice(0, 60).join('')}`,
            ])
          )}
          empty={r.common.choose}
          onChange={setIdx}
        />
      </Field>
      <StudioErrorAlert error={gen.error} />
      <Button
        variant="outline"
        disabled={disabled || n < 0}
        loading={gen.busy || runner.polling}
        onClick={async () => {
          if (n < 0) return;
          setNotice(null);
          setReqIdx(n);
          const body = {
            template: (m.contentType === 'comment'
              ? 'helpful_answer'
              : 'educational_post') as RedditDraftTemplate,
            variants: 2 as const,
            rewrite: { versionId: draft.id, paragraph: n },
          };
          const x = await gen.run(
            (k) => studioAi.generate(b.id, k, body),
            `rewrite:${draft.id}:${draft.revision}:${n}`
          );
          if (x) await runner.settle(x.callId, x.call);
        }}
      >
        {r.studio.rewrite.run}
      </Button>
      {runner.live && !variants && runner.live.status !== 'running' && (
        <Alert tone="warning">
          {fmtText(r.studio.generate.failed, {
            status:
              (content.ai.callStatuses as Record<string, string>)[
                runner.live.status
              ] ?? runner.live.status,
          })}
        </Alert>
      )}
      {variants?.map((v, i) => {
        const p = rewrittenParagraph(v.body, reqIdx);
        if (!p) return null;
        return (
          <div key={i} className="space-y-1">
            <div className="text-xs text-silver-500">
              {fmtText(r.studio.rewrite.forParagraph, { n: reqIdx + 1 })}
              {' · '}
              {r.studio.rewrite.result} {i + 1}
            </div>
            <PlainQuote text={p} />
            <Button
              variant="ghost"
              onClick={() => {
                onApply(reqIdx, p, {
                  aiCallId: runner.live!.callId,
                  variantIndex: i,
                });
                setNotice(r.studio.rewrite.applied);
              }}
            >
              {r.studio.rewrite.apply}
            </Button>
          </div>
        );
      })}
      <Notice text={notice} />
    </ActionBlock>
  );
}

// ── Версии и diff ────────────────────────────────────────────────────────

function VersionsPanel({
  m,
  versions,
}: {
  m: RedditMaterialView;
  versions: VersionView[];
}) {
  const { r } = useRedditStudio();
  const apis = usePubApis();
  const [sel, setSel] = useState('');
  const [other, setOther] = useState('');
  const selected =
    versions.find((v) => v.id === sel) ??
    versions.find((v) => v.id === m.content.currentVersionId) ??
    versions[versions.length - 1] ??
    null;
  const diff = useAsync(
    async () =>
      selected && other
        ? apis.content.diff(m.content.id, other, selected.id)
        : null,
    [apis, m.content.id, selected?.id, other]
  );
  if (!versions.length) return null;
  const label = (v: VersionView) =>
    fmtText(r.studio.versions.version, { n: v.number });
  return (
    <Section title={r.studio.versions.title}>
      <ul className="space-y-1">
        {versions.map((v) => (
          <li key={v.id}>
            <button
              type="button"
              onClick={() => setSel(v.id)}
              className={`w-full text-left rounded-lg px-2 py-1 flex flex-wrap items-center gap-2 text-sm min-h-[44px] ${
                selected?.id === v.id ? 'bg-accent/10' : ''
              }`}
            >
              <span className="font-medium">{label(v)}</span>
              <StatusBadge
                status={v.status}
                labels={r.studio.versionStatuses}
              />
              {v.id === m.content.currentVersionId && (
                <Badge tone="neutral">{r.studio.versions.current}</Badge>
              )}
              {v.id === m.content.approvedVersionId && (
                <Badge tone="success">{r.studio.versions.approved}</Badge>
              )}
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <>
          {m.contentType === 'post' && (
            <div className="font-semibold break-words">{selected.title}</div>
          )}
          <PlainQuote text={selected.body} />
          {versions.length > 1 && (
            <Field label={r.studio.versions.diffWith}>
              <Select
                value={other}
                options={versions
                  .filter((v) => v.id !== selected.id)
                  .map((v) => v.id)}
                labels={Object.fromEntries(
                  versions.map((v) => [v.id, label(v)])
                )}
                empty={r.common.none}
                onChange={setOther}
              />
            </Field>
          )}
          {other && (
            <Loadable state={diff}>
              {(d) =>
                d ? (
                  <pre
                    data-reddit-diff=""
                    tabIndex={0}
                    role="region"
                    aria-label={r.studio.versions.diffWith}
                    className="text-xs whitespace-pre-wrap break-words max-h-80 overflow-auto"
                  >
                    {d.title && m.contentType === 'post' && (
                      <div>
                        <del className="text-rose-600">{d.title.from}</del> →{' '}
                        <ins className="text-emerald-700">{d.title.to}</ins>
                      </div>
                    )}
                    {d.body.map((l, i) => (
                      <div
                        key={i}
                        className={
                          l.op === 'add'
                            ? 'bg-emerald-500/10'
                            : l.op === 'del'
                              ? 'bg-rose-500/10 line-through'
                              : ''
                        }
                      >
                        {l.op === 'add' ? '+ ' : l.op === 'del' ? '− ' : '  '}
                        {l.text}
                      </div>
                    ))}
                  </pre>
                ) : null
              }
            </Loadable>
          )}
        </>
      )}
    </Section>
  );
}

// ── Панели: утверждения, правила, раскрытие ───────────────────────────────

function EvidencePanel({ v }: { v: VersionView | null }) {
  const { r } = useRedditStudio();
  const src = useProductSources();
  const cm = v?.meta.claimMap ?? [];
  const un = v?.meta.uncertainties ?? [];
  return (
    <Section title={r.studio.evidence.title}>
      {cm.length === 0 ? (
        <div className="text-sm text-silver-500">{r.studio.evidence.none}</div>
      ) : (
        <ul className="list-disc pl-5 text-sm space-y-0.5">
          {cm.map((c, i) => (
            <li key={i} className="break-words">
              {c.text}{' '}
              <span className="text-xs text-silver-500">
                {c.sourceIds === 'needs_verification'
                  ? `(${r.studio.evidence.needsVerification})`
                  : `(${fmtText(r.studio.evidence.sources, {
                      list: c.sourceIds
                        .map((x) => src.titles.get(x) ?? x)
                        .join(', '),
                    })})`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {un.length > 0 && (
        <Row label={r.studio.generate.uncertainties}>{un.join('; ')}</Row>
      )}
    </Section>
  );
}

function RulesPanel({ m }: { m: RedditMaterialView }) {
  const { r } = useRedditStudio();
  return (
    <Section title={r.studio.rules.title}>
      {m.rules ? (
        <>
          <Row label={r.opportunities.snapshot}>
            <RecordLink
              section="reddit"
              id={m.communityId}
              query={{ tab: 'rules' }}
            >
              {fmtText(r.rules.version, { n: m.rules.version })}
            </RecordLink>{' '}
            ·{' '}
            {m.rules.state === 'reviewed'
              ? r.studio.rules.reviewed
              : r.rules.states[m.rules.state]}
          </Row>
          <Row label={r.rules.checkedAt}>
            <DateText iso={m.rules.checkedAt} time />
          </Row>
          <Row label={r.rules.fields.promotionPolicy}>
            {r.rules.promotion[m.rules.promotionPolicy]}
          </Row>
          <Row label={r.rules.fields.linksPolicy}>
            {r.rules.links[m.rules.linksPolicy]}
          </Row>
          <GateBlock gate={m.rules.gate} />
        </>
      ) : (
        <Alert tone="warning">{r.studio.rulesNone}</Alert>
      )}
    </Section>
  );
}

function DisclosurePanel({
  b,
  v,
  check,
}: {
  b: RedditBriefView;
  v: VersionView | null;
  check: QaCheckView | null;
}) {
  const { r } = useRedditStudio();
  // Замороженная версия несёт свою связь (`meta.affiliation`, §9.3).
  const frozen = v?.meta.affiliation;
  const aff: RedditAffiliation | null =
    frozen && (REDDIT_AFFILIATIONS as readonly string[]).includes(frozen)
      ? (frozen as RedditAffiliation)
      : b.affiliation;
  const text = v?.meta.disclosure ?? '';
  // Вердикт — только сервера: коды раскрытия последней `reddit_policy`.
  const verdict = [
    ...(check?.blockers ?? []).map((x) => ({ ...x, block: true })),
    ...(check?.warnings ?? []).map((x) => ({ ...x, block: false })),
  ].filter((x) => (DISCLOSURE_CODES as readonly string[]).includes(x.code));
  return (
    <Section title={r.studio.disclosure.title}>
      <Row label={r.briefs.fields.affiliation}>
        {aff ? r.briefs.affiliations[aff] : r.common.none}
      </Row>
      {aff === 'none' ? (
        <div className="text-sm text-silver-500">
          {r.studio.disclosure.none}
        </div>
      ) : text ? (
        <PlainQuote text={text} />
      ) : (
        <div className="text-sm text-silver-500">
          {r.studio.disclosure.empty}
        </div>
      )}
      {aff && aff !== 'none' && (
        <div className="text-xs text-silver-500">
          {r.studio.draft.disclosureRule}
        </div>
      )}
      {verdict.length > 0 && (
        <Alert
          tone={verdict.some((x) => x.block) ? 'danger' : 'warning'}
          title={r.studio.disclosure.verdict}
        >
          <ul className="list-disc pl-5">
            {verdict.map((x, i) => (
              <li key={i}>
                {findingText(x, x.block ? 'blocker' : 'warning', r)}
              </li>
            ))}
          </ul>
        </Alert>
      )}
    </Section>
  );
}

// ── Проверки и согласование ───────────────────────────────────────────────

function PolicyPanel({
  m,
  onChanged,
}: {
  m: RedditMaterialView;
  onChanged: () => void;
}) {
  const { r, studio, canQaTechnical, locale } = useRedditStudio();
  const mu = useMutation();
  const p = m.policyCheck;
  return (
    <Section title={r.studio.policy.title}>
      {!p ? (
        <div className="text-sm text-silver-500">{r.studio.policy.none}</div>
      ) : (
        <div className="space-y-2" data-reddit-policy={p.result}>
          <div className="text-xs text-silver-500">
            {fmtText(r.studio.policy.checkedAt, {
              date: fmtDateTime(p.checkedAt, locale),
            })}
          </div>
          {p.blockers.length === 0 ? (
            <Alert tone="success">{r.studio.policy.pass}</Alert>
          ) : (
            <Alert tone="danger" title={r.studio.policy.fail}>
              <ul className="list-disc pl-5">
                {p.blockers.map((x, i) => (
                  <li key={i}>{findingText(x, 'blocker', r)}</li>
                ))}
              </ul>
            </Alert>
          )}
          {p.warnings.length > 0 && (
            <Alert tone="warning" title={r.studio.policy.warns}>
              <ul className="list-disc pl-5">
                {p.warnings.map((x, i) => (
                  <li key={i}>{findingText(x, 'warning', r)}</li>
                ))}
              </ul>
            </Alert>
          )}
        </div>
      )}
      {canQaTechnical &&
        m.currentVersion &&
        m.currentVersion.status !== 'draft' && (
          <>
            <StudioErrorAlert error={mu.error} onReload={onChanged} />
            <Button
              variant="outline"
              loading={mu.busy}
              onClick={async () => {
                const x = await mu.run(
                  (k) => studio.check(m.content.id, k),
                  `check:${m.content.id}:${m.content.revision}:${p?.id ?? ''}`
                );
                if (x) onChanged();
              }}
            >
              {r.studio.policy.recheck}
            </Button>
          </>
        )}
    </Section>
  );
}

function HumanQaPanel({ v }: { v: VersionView }) {
  const { r, canQaEditorial, canQaTechnical } = useRedditStudio();
  const apis = usePubApis();
  const checks = useAsync(() => apis.content.qaChecks(v.id), [apis, v.id]);
  return (
    <Section title={r.studio.humanQa.title}>
      <Loadable state={checks}>
        {(items) => (
          <div className="space-y-2">
            {(['editorial', 'technical'] as const).map((kind) => {
              const last = items.filter((q) => q.kind === kind).pop();
              const can =
                kind === 'editorial' ? canQaEditorial : canQaTechnical;
              return (
                <HumanQaRow
                  key={kind}
                  kind={kind}
                  v={v}
                  result={last?.result ?? null}
                  self={last?.selfReview ?? false}
                  can={can}
                  onDone={checks.reload}
                />
              );
            })}
          </div>
        )}
      </Loadable>
    </Section>
  );
}

function HumanQaRow({
  kind,
  v,
  result,
  self,
  can,
  onDone,
}: {
  kind: 'editorial' | 'technical';
  v: VersionView;
  result: string | null;
  self: boolean;
  can: boolean;
  onDone: () => void;
}) {
  const { r } = useRedditStudio();
  const apis = usePubApis();
  const mu = useMutation();
  const [text, setText] = useState('');
  const send = async (pass: boolean) => {
    const body = humanQaBody(kind, pass, text);
    if (!body) return;
    const x = await mu.run(
      (k) => apis.content.qaCheck(v.id, body, k),
      `qa:${v.id}:${JSON.stringify(body)}`
    );
    if (x) {
      setText('');
      onDone();
    }
  };
  return (
    <div className="rounded-lg border border-silver-200 dark:border-silver-800 p-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{r.studio.humanQa[kind]}</span>
        {result ? (
          <StatusBadge
            status={result}
            labels={{
              pass: r.studio.humanQa.pass,
              fail: r.studio.humanQa.fail,
            }}
            tone={result === 'pass' ? 'success' : 'danger'}
          />
        ) : (
          <span className="text-xs text-silver-500">
            {r.studio.humanQa.none}
          </span>
        )}
        {self && <Badge tone="warning">{r.studio.humanQa.self}</Badge>}
      </div>
      {can && (
        <>
          <Field label={r.studio.humanQa.failText}>
            <TextInput value={text} maxLength={1000} onChange={setText} />
          </Field>
          <StudioErrorAlert error={mu.error} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              loading={mu.busy}
              onClick={() => send(true)}
            >
              {r.studio.humanQa.pass}
            </Button>
            <Button
              variant="outline"
              loading={mu.busy}
              disabled={!text.trim()}
              onClick={() => send(false)}
            >
              {r.studio.humanQa.fail}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function ApprovePanel({
  m,
  v,
  onDone,
}: {
  m: RedditMaterialView;
  v: VersionView;
  onDone: () => void;
}) {
  const { r, memberId } = useRedditStudio();
  const apis = usePubApis();
  const mu = useMutation();
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const check = m.policyCheck;
  // 409 `warnings_not_acknowledged` (S2-1): набор WARN изменился при
  // согласовании — чекбоксы и тело повтора по `details` (как при копировании).
  const drift = ackWarningsOf(mu.error);
  const warnings: Array<{ code: string; params?: QaFindingParams }> = drift
    ? drift.warnings
    : (check?.warnings ?? []);
  // Блокеры `reddit_policy` — согласовать нельзя (сервер всё равно
  // проверит заново: свежая проверка пишется при согласовании).
  const blocked = (check?.blockers.length ?? 0) > 0;
  const body =
    !v.hash || blocked
      ? null
      : drift
        ? approveAckBody(v.hash, reason, drift.codes, acked)
        : approveRedditBody(v.hash, reason, check, acked);
  const all = warnings.every((w) => acked.has(w.code));
  const own = v.authorMemberId === memberId;
  return (
    <Section title={r.studio.approve.title}>
      {own && <Alert tone="warning">{r.studio.approve.selfReview}</Alert>}
      {blocked && <Alert tone="danger">{r.studio.policy.fail}</Alert>}
      {drift ? (
        <StudioErrorAlert error={mu.error} />
      ) : (
        <StudioErrorAlert error={mu.error} onReload={onDone} />
      )}
      {warnings.length > 0 && !blocked && (
        <fieldset className="space-y-1" data-reddit-approve-warnings="">
          <legend className="text-xs text-silver-500">
            {r.studio.policy.warns}
          </legend>
          {warnings.map((w) => (
            <label
              key={w.code}
              className="flex items-start gap-2 text-sm min-h-[44px]"
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={acked.has(w.code)}
                onChange={(e) => {
                  const next = new Set(acked);
                  if (e.target.checked) next.add(w.code);
                  else next.delete(w.code);
                  setAcked(next);
                }}
              />
              {fmtText(r.studio.approve.ack, {
                text: findingText(w, 'warning', r),
              })}
            </label>
          ))}
          {!all && (
            <div className="text-xs text-amber-700 dark:text-amber-400">
              {r.studio.approve.ackAll}
            </div>
          )}
        </fieldset>
      )}
      <Field label={r.studio.approve.reason}>
        <TextInput value={reason} maxLength={500} onChange={setReason} />
      </Field>
      <Button
        loading={mu.busy}
        disabled={!body}
        onClick={async () => {
          if (!body) return;
          const x = await mu.run(
            (k) => apis.content.approve(v.id, body, k),
            `approve:${v.id}:${JSON.stringify(body)}`
          );
          if (x) onDone();
        }}
      >
        {drift ? r.studio.approve.ackRetry : r.studio.approve.run}
      </Button>
    </Section>
  );
}

function TransitionPanel({
  m,
  to,
  title,
  reasonLabel,
  onDone,
}: {
  m: RedditMaterialView;
  to: 'changes_requested' | 'approved';
  title: string;
  reasonLabel: string;
  onDone: () => void;
}) {
  const apis = usePubApis();
  const mu = useMutation();
  const [reason, setReason] = useState('');
  return (
    <ActionBlock title={title}>
      <Field label={reasonLabel}>
        <TextInput value={reason} maxLength={500} onChange={setReason} />
      </Field>
      <StudioErrorAlert error={mu.error} onReload={onDone} />
      <Button
        variant="outline"
        loading={mu.busy}
        disabled={!reason.trim()}
        onClick={async () => {
          const x = await mu.run(
            (k) =>
              apis.content.transition(
                m.content.id,
                {
                  expectedRevision: m.content.revision,
                  to,
                  reason: reason.trim(),
                },
                k
              ),
            `tr:${m.content.id}:${m.content.revision}:${to}`
          );
          if (x) onDone();
        }}
      >
        {title}
      </Button>
    </ActionBlock>
  );
}

// ── Копирование, отчёт, публикации ────────────────────────────────────────

/**
 * Результат копирования: РОВНО строки ответа `copy` (утверждённая версия
 * сервера) — не текущий черновик и не согласованная версия из кэша.
 */
export function CopyResult({ copy }: { copy: RedditCopyView }) {
  const { r, locale } = useRedditStudio();
  return (
    <div className="space-y-3" data-reddit-copy={copy.copyToken}>
      <div className="text-xs text-silver-500 break-all">
        {fmtText(r.studio.copy.hash, { hash: copy.versionHash.slice(0, 12) })}
        {' · '}
        {fmtText(r.studio.rulesBasis, {
          v: copy.rules.version,
          date: fmtDateTime(copy.rules.checkedAt, locale),
        })}
      </div>
      {copy.title !== null && (
        <CopyBlock
          label={r.studio.draft.fields.title}
          text={copy.title}
          buttonLabel={r.studio.copy.copyTitle}
        />
      )}
      <CopyBlock
        label={r.studio.draft.fields.body}
        text={copy.body}
        buttonLabel={r.studio.copy.copyBody}
      />
      {copy.flairSuggestion && (
        <div className="text-sm">
          {fmtText(r.studio.copy.flair, { flair: copy.flairSuggestion })}
        </div>
      )}
      <RedditLink url={copy.openUrl}>{r.studio.openReddit}</RedditLink>
    </div>
  );
}

export function CopyPanel({
  m,
  onCopied,
}: {
  m: RedditMaterialView;
  onCopied: () => void;
}) {
  const { r, studio, locale } = useRedditStudio();
  const mu = useMutation();
  const [copy, setCopy] = useState<RedditCopyView | null>(null);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  // 409: WARN появились после согласования — подтвердить и повторить (§9.7).
  const fresh = ackWarningsOf(mu.error);
  const run = async (ack: string[]) => {
    const body = ack.length ? { acknowledgedWarnings: ack } : {};
    const x = await mu.run(
      (k) => studio.copy(m.content.id, k, body),
      `copy:${m.content.id}:${m.copies.count}:${ack.join(',')}`
    );
    if (x) {
      setCopy(x);
      setAcked(new Set());
      if (x.scheduled) onCopied();
    }
  };
  return (
    <Section title={r.studio.copy.title}>
      <Alert tone="neutral">{r.studio.copy.note}</Alert>
      <div className="text-xs text-silver-500">
        {fmtText(r.studio.copy.count, { n: m.copies.count })}
        {m.copies.lastAt &&
          ` · ${fmtText(r.studio.copy.last, {
            date: fmtDateTime(m.copies.lastAt, locale),
          })}`}
      </div>
      {fresh ? (
        <fieldset className="space-y-1" data-reddit-copy-warnings="">
          <legend className="text-sm font-medium">
            {r.studio.copy.newWarnings}
          </legend>
          {fresh.warnings.map((w) => (
            <label
              key={w.code}
              className="flex items-start gap-2 text-sm min-h-[44px]"
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={acked.has(w.code)}
                onChange={(e) => {
                  const next = new Set(acked);
                  if (e.target.checked) next.add(w.code);
                  else next.delete(w.code);
                  setAcked(next);
                }}
              />
              {fmtText(r.studio.approve.ack, {
                text: findingText(w, 'warning', r),
              })}
            </label>
          ))}
          <Button
            loading={mu.busy}
            disabled={!fresh.codes.every((c) => acked.has(c))}
            onClick={() => run(fresh.codes)}
          >
            {r.studio.copy.ackCopy}
          </Button>
        </fieldset>
      ) : (
        <>
          <StudioErrorAlert error={mu.error} onReload={onCopied} />
          <Button loading={mu.busy} onClick={() => run([])}>
            {r.studio.copy.prepare}
          </Button>
        </>
      )}
      {copy && <CopyResult copy={copy} />}
    </Section>
  );
}

export function ReportPanel({
  m,
  onDone,
}: {
  m: RedditMaterialView;
  onDone: () => void;
}) {
  const { r, studio } = useRedditStudio();
  const mu = useMutation();
  const [url, setUrl] = useState('');
  const [postedAt, setPostedAt] = useState('');
  const [notes, setNotes] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  // Нижняя граница — заморозка согласованной версии (сервер — создание
  // материала, 400 `before_material`), верхняя — «не в будущем».
  const chk = reportIssues(
    m,
    url,
    postedAt,
    notes,
    new Date(),
    m.approvedVersion?.frozenAt ?? null
  );
  // До ввода не ругаемся на пустые поля.
  const shown = chk.issues.filter(
    (x) => !(x === 'format' && !url.trim()) && !(x === 'date' && !postedAt)
  );
  const ok = chk.issues.length === 0;
  return (
    <Section title={r.studio.report.title}>
      <Alert tone="neutral">{r.studio.userReportedHint}</Alert>
      <Field
        label={r.studio.report.url}
        hint={
          chk.canon
            ? fmtText(r.studio.report.canon, { url: chk.canon })
            : undefined
        }
      >
        <TextInput value={url} maxLength={2048} onChange={setUrl} />
      </Field>
      <Field label={r.studio.report.postedAt}>
        <TextInput
          type="datetime-local"
          value={postedAt}
          onChange={setPostedAt}
        />
      </Field>
      <Field label={r.studio.report.notes}>
        <TextArea value={notes} maxLength={1000} rows={2} onChange={setNotes} />
      </Field>
      {shown.length > 0 && (
        <ul className="text-xs list-disc pl-5 text-amber-700 dark:text-amber-400">
          {shown.map((x) => (
            <li key={x}>
              {fmtText(r.studio.report.issues[x], { sub: m.subreddit })}
            </li>
          ))}
        </ul>
      )}
      <Notice text={notice} />
      <StudioErrorAlert error={mu.error} onReload={onDone} />
      <Button
        loading={mu.busy}
        disabled={!ok}
        onClick={async () => {
          const body = ok ? reportBody(url, postedAt, notes) : null;
          if (!body) return;
          const x = await mu.run(
            (k) => studio.reportPublication(m.content.id, k, body),
            JSON.stringify(body)
          );
          if (x) {
            setNotice(r.studio.report.done);
            setUrl('');
            setNotes('');
            onDone();
          }
        }}
      >
        {r.studio.report.run}
      </Button>
    </Section>
  );
}

export function PublicationsPanel({
  m,
  onChanged,
}: {
  m: RedditMaterialView;
  onChanged: () => void;
}) {
  const { r, canHandoff } = useRedditStudio();
  if (!m.publications.length) return null;
  return (
    <Section title={r.studio.publications}>
      <ul className="space-y-2">
        {m.publications.map((p) => (
          <li key={p.id} className="space-y-1 text-sm">
            <PublicationLine p={p} />
            {canHandoff && p.status === 'published' && (
              <WithdrawMark p={p} onDone={onChanged} />
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Отметка о публикации: статус, этап, «зі слів користувача», дата, ссылка. */
export function PublicationLine({ p }: { p: RedditPublicationView }) {
  const { r } = useRedditStudio();
  return (
    <div className="space-y-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={p.status} labels={r.publications.statuses} />
        <Badge tone="neutral">{r.studio.stages[p.stage]}</Badge>
        {p.reportKind === 'user_reported' && (
          <Badge tone="warning">{r.studio.userReported}</Badge>
        )}
        <span className="text-xs text-silver-500">
          <DateText iso={p.publishedAt} time />
        </span>
      </div>
      <RedditLink url={p.finalUrl}>
        <Wrap>{p.finalUrl}</Wrap>
      </RedditLink>
    </div>
  );
}

/** Снять ошибочную отметку (общий переход публикации `withdrawn`, S3-5). */
function WithdrawMark({
  p,
  onDone,
}: {
  p: RedditPublicationView;
  onDone: () => void;
}) {
  const { r } = useRedditStudio();
  const apis = usePubApis();
  const mu = useMutation();
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const body = publicationTransitionBody(p, 'withdrawn', reason);
  return (
    <ActionBlock title={r.publications.withdraw}>
      <Field label={r.publications.withdrawReason}>
        <TextInput value={reason} maxLength={500} onChange={setReason} />
      </Field>
      <Notice text={notice} />
      <StudioErrorAlert error={mu.error} onReload={onDone} />
      <ConfirmButton
        variant="outline"
        loading={mu.busy}
        disabled={!body}
        onConfirm={async () => {
          if (!body) return;
          const x = await mu.run(
            (k) => apis.calendar.publicationTransition(p.id, body, k),
            JSON.stringify([p.id, body])
          );
          if (x) {
            setNotice(r.publications.withdrawn);
            onDone();
          }
        }}
      >
        {r.publications.withdraw}
      </ConfirmButton>
    </ActionBlock>
  );
}
