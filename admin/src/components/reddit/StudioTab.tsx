'use client';

// «Студия» Reddit-материала (как студия кабинета, §M2.5–M2.6): варианты от
// модели (если генерация включена; иначе — «написать самому»), ручной
// черновик, правка (только изменённое, CAS), «перегенерировать абзац»,
// безопасный предпросмотр подмножества markdown, версии и diff, утверждения,
// правила, раскрытие, проверка `reddit_policy` (блокеры и WARN словами),
// проверки человека, согласование с подтверждением WARN, возврат на
// доработку, копирование РОВНО утверждённого текста (с подтверждением новых
// WARN), «Открыть Reddit» по сохранённому URL, отметка «опубликовано» (со
// слов пользователя) и её снятие. Админка к Reddit не обращается.

import { useCallback, useEffect, useRef, useState } from 'react';
import { aiReadiness, approvalIdOf, C, fmtDateTime, isOwnActor, R } from '../../lib/reddit';
import { isFinalCall, pollCall, POLL_MAX_MS, type AiCallView } from '../../lib/reddit-shared/lib/publisher/ai-api';
import type { ApprovalView, QaFindingParams, VersionView } from '../../lib/reddit-shared/lib/publisher/content-api';
import {
  REDDIT_AFFILIATIONS,
  REDDIT_DRAFT_TEMPLATES,
  type RedditAffiliation,
  type RedditBriefView,
  type RedditCopyView,
  type RedditDraftTemplate,
  type RedditMaterialView,
  type RedditPublicationView,
} from '../../lib/reddit-shared/lib/publisher/reddit-studio-api';
import { publicationTransitionBody } from '../../lib/reddit-shared/lib/publisher/channels-view';
import {
  ackWarningsOf,
  diffPartner,
  approveAckBody,
  approvalRevoked,
  approveRedditBody,
  generationClosed,
  variantsStale,
  DISCLOSURE_CODES,
  draftForm,
  draftIssues,
  draftPatchBody,
  findingText,
  humanQaBody,
  manualPathShown,
  manualVersionBody,
  materialSteps,
  paragraphs,
  replaceParagraph,
  reportBody,
  reportIssues,
  rewrittenParagraph,
  rulesBasis,
  variantsOf,
  variantVersionBody,
  withAiChoice,
  type DraftForm,
} from '../../lib/reddit-shared/lib/publisher/reddit-studio-view';
import { fmtText } from '../../lib/reddit-shared/lib/publisher/view';
import {
  Alert,
  Badge,
  ConfirmButton,
  ConflictPanel,
  CopyBlock,
  ErrorAlert,
  Field,
  GateBlock,
  Loading,
  MarkdownPreview,
  Notice,
  PlainQuote,
  RedditLink,
  Row,
  Section,
  Select,
  useLoad,
  useMutation,
  useRebaseForm,
  useRx,
  WordCount,
} from './ui';

const callStatusText = (s: string) => (C.ai.callStatuses as Record<string, string>)[s] ?? s;
const statusText = (s: string) => (R.studio.statuses as Record<string, string>)[s] ?? s;

/**
 * Вызов `pub.reddit.draft` до финального статуса: 200 — сразу, 202 —
 * опрос `cx/ai/calls/:callId` (`pollCall` кабинета: шаг 2 с, предел 180 с);
 * после предела — «ещё выполняется» и «Проверить ещё раз». Уход со
 * страницы прерывает опрос.
 */
function useCallPoller() {
  const { api } = useRx();
  const [call, setCall] = useState<AiCallView | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const settle = useCallback(
    async (id: string, initial: AiCallView | null) => {
      setCallId(id);
      setTimedOut(false);
      setError(null);
      setCall(initial);
      if (initial && isFinalCall(initial.status)) return;
      setPolling(true);
      try {
        const last = await pollCall(api.ai, id, { intervalMs: 2000, maxMs: POLL_MAX_MS, cancelled: () => !alive.current });
        if (!alive.current) return;
        setCall(last);
        setTimedOut(!isFinalCall(last.status));
      } catch (e) {
        if (alive.current) setError(e);
      } finally {
        if (alive.current) setPolling(false);
      }
    },
    [api],
  );
  return { call, callId, polling, timedOut, error, settle };
}

function CallStatus({ p }: { p: ReturnType<typeof useCallPoller> }) {
  return (
    <>
      {p.polling && (
        <Alert tone="neutral">
          <span role="status" data-ai-polling="">
            {R.studio.generate.running} {p.call ? `(${callStatusText(p.call.status)})` : ''}
          </span>
        </Alert>
      )}
      {p.timedOut && !p.polling && p.callId && (
        <Alert tone="warning">
          {R.studio.generate.stillRunning}
          <button type="button" onClick={() => void p.settle(p.callId as string, null)}>
            Проверить ещё раз
          </button>
        </Alert>
      )}
      <ErrorAlert error={p.error} />
    </>
  );
}

const APPROVALS_KEY = 'v4c-admin-reddit-approvals';
function readApprovals(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(APPROVALS_KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function StudioTab() {
  const { route, go } = useRx();
  if (!route.id) {
    return (
      <Section title={R.studio.title}>
        <p className="muted">Материал открывается из карточки брифа («Открыть студию») или из списка публикаций.</p>
        <button type="button" onClick={() => go({ tab: 'briefs', id: '' })}>
          {R.tabs.briefs}
        </button>
      </Section>
    );
  }
  return <StudioLoader id={route.id} />;
}

function StudioLoader({ id }: { id: string }) {
  const { api } = useRx();
  const state = useLoad(() => api.studio.material(id), [api, id]);
  if (state.error) return <ErrorAlert error={state.error} onReload={state.reload} onRetry={state.reload} />;
  if (!state.data) return <Loading />;
  return <StudioBody m={state.data} reload={state.reload} />;
}

function StudioBody({ m, reload }: { m: RedditMaterialView; reload: () => void }) {
  const { api, go, aiEnabled } = useRx();
  const brief = useLoad(() => api.studio.brief(m.briefId), [api, m.briefId, m.content.revision]);
  const versions = useLoad(() => api.content.versions(m.content.id), [api, m.content.id, m.content.revision, m.currentVersion?.revision]);
  const steps = materialSteps(m);
  const draft = m.currentVersion?.status === 'draft' ? m.currentVersion : null;
  const refresh = () => {
    reload();
    versions.reload();
  };
  const passed = m.policyCheck?.result === 'pass';
  const reported = m.publications.find((p) => p.status === 'published') ?? null;
  const write = steps.newDraft || steps.editDraft;
  // id согласования (для отзыва): ответ `approve` этой вкладки браузера.
  const [approvals, setApprovals] = useState<Record<string, string>>(readApprovals);
  const remember = (versionId: string, approvalId: string) => {
    const next = { ...approvals, [versionId]: approvalId };
    setApprovals(next);
    try {
      sessionStorage.setItem(APPROVALS_KEY, JSON.stringify(next));
    } catch {
      // приватный режим — останется в памяти вкладки
    }
  };
  const statusLabels = R.studio.statuses as Record<string, string>;
  return (
    <div className="rx-stack">
      <button type="button" className="rx-linkbtn" onClick={() => go({ tab: 'briefs', id: m.briefId })}>
        {R.studio.back}
      </button>
      <Section
        title={R.studio.title}
        action={
          <Badge tone={m.content.status === 'withdrawn' || approvalRevoked(m) ? 'warning' : 'accent'}>
            {approvalRevoked(m) ? 'согласование отозвано' : statusText(m.content.status)}
          </Badge>
        }
      >
        <div className="rx-row">
          <Badge>{R.briefs.contentTypes[m.contentType]}</Badge>
          <span>r/{m.subreddit}</span>
          <RedditLink url={m.openUrl}>{m.contentType === 'comment' ? R.studio.openThread : R.studio.openCommunity}</RedditLink>
          {/* После отметки — сохранённый finalUrl (со слов пользователя). */}
          {reported && <RedditLink url={reported.finalUrl}>{R.studio.openReddit}</RedditLink>}
        </div>
        <span>
          {m.rules
            ? passed
              ? rulesBasis(m, R, (iso) => fmtDateTime(iso))
              : fmtText(R.studio.rulesSnapshot, { v: m.rules.version, date: fmtDateTime(m.rules.checkedAt) })
            : R.studio.rulesNone}
        </span>
        {steps.unscheduleFirst && (
          <Alert tone="warning">{R.studio.unscheduleFirst}</Alert>
        )}
        {approvalRevoked(m) && (
          <Alert tone="warning" title="Согласование отозвано">
            <span data-approval-revoked="">{R.studio.approvalRevoked}</span>
          </Alert>
        )}
      </Section>
      {brief.error ? <ErrorAlert error={brief.error} onReload={brief.reload} onRetry={brief.reload} /> : null}
      {brief.data && (
        <>
          {write && (
            <GeneratePanel m={m} b={brief.data} draft={draft} aiEnabled={aiEnabled} closed={generationClosed(versions.data ?? [])} onChosen={refresh} />
          )}
          {write ? (
            draft ? (
              <DraftEditor key={draft.id} m={m} b={brief.data} draft={draft} aiEnabled={aiEnabled} onSaved={refresh} />
            ) : (
              <ManualDraft m={m} b={brief.data} onSaved={refresh} />
            )
          ) : null}
          <DisclosurePanel b={brief.data} v={m.currentVersion ?? m.approvedVersion} check={m.policyCheck} />
        </>
      )}
      {versions.error ? <ErrorAlert error={versions.error} onReload={versions.reload} onRetry={versions.reload} /> : null}
      {versions.data && <VersionsPanel m={m} versions={versions.data} />}
      <EvidencePanel v={m.currentVersion ?? m.approvedVersion} />
      <RulesPanel m={m} />
      <PolicyPanel m={m} onChanged={refresh} />
      {m.currentVersion?.status === 'submitted' && <HumanQaPanel v={m.currentVersion} />}
      {steps.approve && m.currentVersion && (
        <ApprovePanel
          key={m.policyCheck?.id ?? 'no-check'}
          m={m}
          v={m.currentVersion}
          onDone={(a) => {
            if (a) remember(a.objectId, a.id);
            refresh();
          }}
        />
      )}
      {m.content.allowedTransitions.includes('changes_requested') && (
        <TransitionPanel
          m={m}
          to="changes_requested"
          title={R.studio.approve.requestChanges}
          reasonLabel={R.studio.approve.requestReason}
          statusLabels={statusLabels}
          onDone={refresh}
        />
      )}
      {steps.unscheduleFirst && m.content.allowedTransitions.includes('approved') && (
        <TransitionPanel m={m} to="approved" title={R.studio.unschedule} reasonLabel={R.studio.unscheduleReason} statusLabels={statusLabels} onDone={refresh} />
      )}
      {m.approvedVersion && ['approved', 'scheduled'].includes(m.content.status) && (
        <RevokeApprovalPanel key={m.approvedVersion.id} m={m} known={approvalIdOf(m, approvals)} onDone={refresh} />
      )}
      {steps.copy && <CopyPanel m={m} onCopied={reload} />}
      {steps.report && <ReportPanel m={m} onDone={reload} />}
      <PublicationsPanel m={m} onChanged={reload} />
    </div>
  );
}

// ── Генерация и варианты ──────────────────────────────────────────────────

function GeneratePanel({
  m,
  b,
  draft,
  aiEnabled,
  closed,
  onChosen,
}: {
  m: RedditMaterialView;
  b: RedditBriefView;
  draft: VersionView | null;
  aiEnabled: boolean;
  /** Вариант уже взят в черновик — полная генерация брифа закрыта. */
  closed: boolean;
  onChosen: () => void;
}) {
  const { api, status } = useRx();
  const ready = status ? aiReadiness(status) : null;
  const gen = useMutation();
  const pick = useMutation();
  const [template, setTemplate] = useState<RedditDraftTemplate | ''>(m.contentType === 'comment' ? 'helpful_answer' : 'educational_post');
  const [count, setCount] = useState<'2' | '3'>('3');
  const [request, setRequest] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const poll = useCallPoller();
  const call = poll.call;
  const variants = variantsOf(call);
  const { settle } = poll;
  const lastId = m.lastGeneration?.callId ?? null;
  // Прошлая генерация брифа (`lastGeneration`): варианты — тем же опросом.
  useEffect(() => {
    if (lastId && aiEnabled) void settle(lastId, null);
  }, [lastId, aiEnabled, settle]);
  const draftHasText = !!draft && !!draft.body.trim();
  const manual = manualPathShown(b.ai, gen.error) || !aiEnabled;
  return (
    <Section title={R.studio.generate.title}>
      {!b.ai.available && b.ai.reason && <Alert tone="neutral">{R.briefs.ai[b.ai.reason]}</Alert>}
      {manual && (
        <Alert tone="neutral" title={R.studio.manual.title}>
          {R.studio.manual.hint}
        </Alert>
      )}
      {closed && <Alert tone="neutral">{R.studio.generate.closedHint}</Alert>}
      {!closed && ready && !ready.ready && b.ai.available && aiEnabled && (
        <Alert tone="warning" title="Генерация сейчас недоступна">
          <ul className="rx-list" data-ai-blocked="">
            {ready.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </Alert>
      )}
      {!closed && b.ai.available && aiEnabled && (
        <div className="rx-stack">
          <div className="rx-grid2">
            <Field label={R.studio.generate.template}>
              <Select value={template} options={REDDIT_DRAFT_TEMPLATES} labels={R.studio.generate.templates} onChange={setTemplate} />
            </Field>
            <Field label={R.studio.generate.count}>
              <Select value={count} options={['2', '3'] as const} labels={{}} onChange={(x) => setCount(x || '3')} />
            </Field>
          </div>
          <Field label={R.studio.generate.request}>
            <textarea rows={2} maxLength={1000} value={request} onChange={(e) => setRequest(e.target.value)} />
          </Field>
          <ErrorAlert error={gen.error} />
          <button
            type="button"
            disabled={!template || gen.busy || poll.polling}
            onClick={async () => {
              if (!template) return;
              setNotice(null);
              const body = { template, variants: Number(count) as 2 | 3, ...(request.trim() ? { request: request.trim() } : {}) };
              const x = await gen.run((k) => api.studio.generate(b.id, k, body), `gen:${b.id}:${JSON.stringify(body)}`);
              if (!x) return;
              await settle(x.callId, x.call);
            }}
          >
            {gen.busy || poll.polling ? R.studio.generate.running : R.studio.generate.run}
          </button>
        </div>
      )}
      <CallStatus p={poll} />
      {call && (
        <span className="muted rx-hint">
          {fmtText(R.studio.generate.callAt, { date: fmtDateTime(call.requestedAt) })} · {callStatusText(call.status)}
        </span>
      )}
      {variants && variantsStale(call, b) && (
        <Alert tone="warning">
          <span data-variants-stale="">{R.studio.generate.staleVariants}</span>
        </Alert>
      )}
      {call && isFinalCall(call.status) && !variants && <Alert tone="warning">{fmtText(R.studio.generate.failed, { status: callStatusText(call.status) })}</Alert>}
      {call && call.findings.length > 0 && (
        <Alert tone="warning" title={R.studio.generate.findings}>
          <ul className="rx-list">
            {call.findings.map((f, i) => (
              <li key={i}>{(R.studio.generate.findingCodes as Record<string, string>)[f.code] ?? R.studio.findings.other}</li>
            ))}
          </ul>
        </Alert>
      )}
      {variants && call && (
        <div className="rx-variants">
          {variants.map((v, i) => (
            <div key={i} data-reddit-variant={i} className="card rx-inner rx-stack">
              <b>{fmtText(R.studio.generate.variant, { n: i + 1 })}</b>
              {m.contentType === 'post' && v.title && <b className="rx-wrap">{v.title}</b>}
              <PlainQuote text={v.body} label={fmtText(R.studio.generate.variant, { n: i + 1 })} />
              <WordCount text={v.body} />
              {v.claim_map.length > 0 && (
                <div className="rx-hint">
                  <span className="muted">{R.studio.generate.claimMap}</span>
                  <ul className="rx-list">
                    {v.claim_map.map((c, j) => (
                      <li key={j} className="rx-wrap">
                        {c.text} ({c.source_ids === 'needs_verification' ? R.studio.evidence.needsVerification : c.source_ids.join(', ')})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {v.uncertainties.length > 0 && (
                <span className="rx-hint">
                  <span className="muted">{R.studio.generate.uncertainties}:</span> {v.uncertainties.join('; ')}
                </span>
              )}
              {draftHasText ? (
                <>
                  <ConfirmButton busy={pick.busy} onConfirm={() => void choose(i)}>
                    {R.studio.generate.choose}
                  </ConfirmButton>
                  <span className="muted rx-hint">{R.studio.generate.replaceDraft}</span>
                </>
              ) : (
                <button type="button" disabled={pick.busy} onClick={() => void choose(i)}>
                  {R.studio.generate.choose}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <ErrorAlert error={pick.error} onReload={onChosen} />
      <Notice text={notice} />
    </Section>
  );

  async function choose(i: number) {
    if (!call || !variants) return;
    const body = variantVersionBody(m.contentType, variants[i], call.callId, i);
    const x = await pick.run(
      (k) =>
        draft
          ? api.studio.patchVersion(m.content.id, draft.id, k, { expectedRevision: draft.revision, ...body })
          : api.studio.createVersion(m.content.id, k, body),
      `pick:${call.callId}:${i}:${draft?.revision ?? 'new'}`,
    );
    if (x) {
      setNotice(R.studio.generate.chosen);
      onChosen();
    }
  }
}

// ── Черновик ─────────────────────────────────────────────────────────────

function DraftFields({ m, b, v, set }: { m: RedditMaterialView; b: RedditBriefView; v: DraftForm; set: (v: DraftForm) => void }) {
  const issues = draftIssues(m.contentType, v);
  return (
    <>
      {m.contentType === 'post' ? (
        <Field label={R.studio.draft.fields.title}>
          <input value={v.title} maxLength={300} onChange={(e) => set({ ...v, title: e.target.value })} />
        </Field>
      ) : (
        <span className="muted rx-hint">{R.studio.draft.commentNoTitle}</span>
      )}
      <Field label={R.studio.draft.fields.disclosure} hint={b.affiliation && b.affiliation !== 'none' ? R.studio.draft.disclosureRule : undefined}>
        <input value={v.disclosure} maxLength={300} onChange={(e) => set({ ...v, disclosure: e.target.value })} />
      </Field>
      <Field label={R.studio.draft.fields.body}>
        <textarea rows={12} maxLength={m.contentType === 'comment' ? 10_000 : 40_000} value={v.body} onChange={(e) => set({ ...v, body: e.target.value })} />
      </Field>
      <WordCount text={v.body} />
      <Field label={R.studio.draft.fields.flair}>
        <input value={v.flair} maxLength={64} onChange={(e) => set({ ...v, flair: e.target.value })} />
      </Field>
      <span className="muted rx-hint">{R.studio.draft.claimHint}</span>
      {issues.length > 0 && (
        <ul className="rx-list rx-warn">
          {issues.map((x) => (
            <li key={x}>{R.studio.draft.issues[x]}</li>
          ))}
        </ul>
      )}
      <div className="rx-inner rx-stack">
        <b>{R.studio.preview.title}</b>
        <MarkdownPreview text={v.body} />
      </div>
    </>
  );
}

function ManualDraft({ m, b, onSaved }: { m: RedditMaterialView; b: RedditBriefView; onSaved: () => void }) {
  const { api } = useRx();
  const mu = useMutation();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<DraftForm>(draftForm());
  const body = manualVersionBody(m.contentType, v);
  return (
    <Section title={R.studio.draft.newDraft}>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)}>
          {R.studio.manual.start}
        </button>
      ) : (
        <>
          <DraftFields m={m} b={b} v={v} set={setV} />
          <ErrorAlert error={mu.error} onReload={onSaved} />
          <button
            type="button"
            disabled={!body || mu.busy}
            onClick={async () => {
              if (!body) return;
              const x = await mu.run((k) => api.studio.createVersion(m.content.id, k, body), `manual:${m.content.id}:${JSON.stringify(body)}`);
              if (x) onSaved();
            }}
          >
            {R.studio.draft.save}
          </button>
        </>
      )}
    </Section>
  );
}

function DraftEditor({
  m,
  b,
  draft,
  aiEnabled,
  onSaved,
}: {
  m: RedditMaterialView;
  b: RedditBriefView;
  draft: VersionView;
  aiEnabled: boolean;
  onSaved: () => void;
}) {
  const { api } = useRx();
  const save = useMutation();
  const submit = useMutation();
  const [notice, setNotice] = useState<string | null>(null);
  const f = useRebaseForm<DraftForm>(draftForm(draft), draft.revision);
  // Принятый вариант переписывания уходит с правкой черновика (§10.9).
  const [choice, setChoice] = useState<{ aiCallId: string; variantIndex: number } | null>(null);
  const patch = f.conflicts.length ? null : withAiChoice(draftPatchBody(m.contentType, draft, f.v, f.base), choice);
  const dirty = f.v.title !== f.base.title || f.v.body !== f.base.body || f.v.disclosure !== f.base.disclosure || f.v.flair !== f.base.flair;
  return (
    <Section title={R.studio.draft.title}>
      <span className="muted rx-hint">
        {fmtText(R.studio.versions.version, { n: draft.number })}
        {draft.aiCallId && ` · ${fmtText(R.studio.generate.call, { id: draft.aiCallId })}`}
      </span>
      <DraftFields m={m} b={b} v={f.v} set={f.set} />
      <ConflictPanel conflicts={f.conflicts} label={(k) => R.studio.draft.fields[k]} resolve={f.resolve} />
      <Notice text={notice} />
      <ErrorAlert error={save.error} onReload={onSaved} />
      <div className="rx-row">
        <button
          type="button"
          disabled={!patch || save.busy}
          onClick={async () => {
            if (!patch) return;
            const x = await save.run((k) => api.studio.patchVersion(m.content.id, draft.id, k, patch), `patchVersion:${draft.id}:${JSON.stringify(patch)}`);
            if (x) {
              setNotice(R.studio.draft.saved);
              setChoice(null);
              onSaved();
            }
          }}
        >
          {R.studio.draft.save}
        </button>
        <button
          type="button"
          disabled={dirty || !draft.body.trim() || submit.busy}
          onClick={async () => {
            const x = await submit.run((k) => api.content.submitVersion(m.content.id, draft.id, draft.revision, k), `submit:${draft.id}:${draft.revision}`);
            if (x) onSaved();
          }}
        >
          {R.studio.draft.submit}
        </button>
      </div>
      <span className="muted rx-hint">{R.studio.draft.submitHint}</span>
      <ErrorAlert error={submit.error} onReload={onSaved} />
      {aiEnabled && (
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
      )}
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
  onApply: (index: number, text: string, choice: { aiCallId: string; variantIndex: number }) => void;
}) {
  const { api } = useRx();
  const gen = useMutation();
  const [idx, setIdx] = useState('');
  // Номер абзаца фиксируется в момент запроса.
  const [reqIdx, setReqIdx] = useState(-1);
  const poll = useCallPoller();
  const call = poll.call;
  const [notice, setNotice] = useState<string | null>(null);
  const ps = paragraphs(draft.body);
  if (!b.ai.available || ps.length === 0) return null;
  const n = idx === '' ? -1 : Number(idx);
  const variants = variantsOf(call);
  return (
    <div className="rx-inner rx-stack">
      <b>{R.studio.rewrite.title}</b>
      <span className="muted rx-hint">{R.studio.rewrite.hint}</span>
      {disabled && <Alert tone="neutral">{R.studio.rewrite.saveFirst}</Alert>}
      <Field label={R.studio.rewrite.paragraph}>
        <Select
          value={idx}
          options={ps.map((_, i) => String(i))}
          labels={Object.fromEntries(ps.map((p, i) => [String(i), `${i + 1}: ${[...p].slice(0, 60).join('')}`]))}
          empty={R.common.choose}
          onChange={setIdx}
        />
      </Field>
      <ErrorAlert error={gen.error} />
      <button
        type="button"
        disabled={disabled || n < 0 || gen.busy || poll.polling}
        onClick={async () => {
          if (n < 0) return;
          setNotice(null);
          setReqIdx(n);
          const body = {
            template: (m.contentType === 'comment' ? 'helpful_answer' : 'educational_post') as RedditDraftTemplate,
            variants: 2 as const,
            rewrite: { versionId: draft.id, paragraph: n },
          };
          const x = await gen.run((k) => api.studio.generate(b.id, k, body), `rewrite:${draft.id}:${draft.revision}:${n}`);
          if (x) await poll.settle(x.callId, x.call);
        }}
      >
        {gen.busy || poll.polling ? R.studio.generate.running : R.studio.rewrite.run}
      </button>
      <CallStatus p={poll} />
      {call && isFinalCall(call.status) && !variants && <Alert tone="warning">{fmtText(R.studio.generate.failed, { status: callStatusText(call.status) })}</Alert>}
      {variants?.map((v, i) => {
        const p = rewrittenParagraph(v.body, reqIdx);
        if (!p || !call) return null;
        return (
          <div key={i} className="rx-stack">
            <span className="muted rx-hint">
              {fmtText(R.studio.rewrite.forParagraph, { n: reqIdx + 1 })} · {R.studio.rewrite.result} {i + 1}
            </span>
            <PlainQuote text={p} />
            <button
              type="button"
              onClick={() => {
                onApply(reqIdx, p, { aiCallId: call.callId, variantIndex: i });
                setNotice(R.studio.rewrite.applied);
              }}
            >
              {R.studio.rewrite.apply}
            </button>
          </div>
        );
      })}
      <Notice text={notice} />
    </div>
  );
}

// ── Версии и diff ────────────────────────────────────────────────────────

function VersionsPanel({ m, versions }: { m: RedditMaterialView; versions: VersionView[] }) {
  const { api } = useRx();
  const [sel, setSel] = useState('');
  const [other, setOther] = useState('');
  const selected =
    versions.find((v) => v.id === sel) ?? versions.find((v) => v.id === m.content.currentVersionId) ?? versions[versions.length - 1] ?? null;
  // «Сравнить с» = выбранная (или исчезла) — сравнения нет (аудит ui-10).
  const partner = diffPartner(selected?.id, other, versions.map((v) => v.id));
  const diff = useLoad(async () => (selected && partner ? api.content.diff(m.content.id, partner, selected.id) : null), [api, m.content.id, selected?.id, partner]);
  if (!versions.length) return null;
  const label = (v: VersionView) => fmtText(R.studio.versions.version, { n: v.number });
  return (
    <Section title={R.studio.versions.title}>
      <ul className="rx-items">
        {versions.map((v) => (
          <li key={v.id}>
            <button
              type="button"
              className={`rx-version${selected?.id === v.id ? ' rx-version-on' : ''}`}
              aria-pressed={selected?.id === v.id}
              onClick={() => {
                setSel(v.id);
                if (v.id === other) setOther('');
              }}
            >
              <b>{label(v)}</b> <Badge>{(R.studio.versionStatuses as Record<string, string>)[v.status] ?? v.status}</Badge>
              {v.id === m.content.currentVersionId && <Badge>{R.studio.versions.current}</Badge>}
              {v.id === m.content.approvedVersionId && <Badge tone="success">{R.studio.versions.approved}</Badge>}
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <>
          {m.contentType === 'post' && <b className="rx-wrap">{selected.title}</b>}
          <PlainQuote text={selected.body} label={label(selected)} />
          {versions.length > 1 && (
            <Field label={R.studio.versions.diffWith}>
              <Select
                value={partner}
                options={versions.filter((v) => v.id !== selected.id).map((v) => v.id)}
                labels={Object.fromEntries(versions.map((v) => [v.id, label(v)]))}
                empty={R.common.none}
                onChange={setOther}
              />
            </Field>
          )}
          {partner && diff.error ? <ErrorAlert error={diff.error} onRetry={diff.reload} /> : null}
          {partner && diff.loading ? <Loading /> : null}
          {/* Пока грузится новое сравнение, прошлое не показывается. */}
          {partner && !diff.loading && diff.data && (
            <div className="rx-pre rx-diff" data-reddit-diff="" tabIndex={0} role="region" aria-label={R.studio.versions.diffWith}>
              {diff.data.title && m.contentType === 'post' && (
                <div>
                  <del>{diff.data.title.from}</del> → <ins>{diff.data.title.to}</ins>
                </div>
              )}
              {diff.data.body.map((l, i) => (
                <div key={i} className={l.op === 'add' ? 'rx-diff-add' : l.op === 'del' ? 'rx-diff-del' : undefined}>
                  {l.op === 'add' ? '+ ' : l.op === 'del' ? '− ' : '  '}
                  {l.text}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// ── Панели: утверждения, правила, раскрытие ───────────────────────────────

function EvidencePanel({ v }: { v: VersionView | null }) {
  const cm = v?.meta.claimMap ?? [];
  const un = v?.meta.uncertainties ?? [];
  return (
    <Section title={R.studio.evidence.title}>
      {cm.length === 0 ? (
        <span className="muted">{R.studio.evidence.none}</span>
      ) : (
        <ul className="rx-list">
          {cm.map((c, i) => (
            <li key={i} className="rx-wrap">
              {c.text}{' '}
              <span className="muted rx-hint">
                {c.sourceIds === 'needs_verification'
                  ? `(${R.studio.evidence.needsVerification})`
                  : `(${fmtText(R.studio.evidence.sources, { list: c.sourceIds.join(', ') })})`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {un.length > 0 && <Row label={R.studio.generate.uncertainties}>{un.join('; ')}</Row>}
    </Section>
  );
}

function RulesPanel({ m }: { m: RedditMaterialView }) {
  const { go } = useRx();
  return (
    <Section title={R.studio.rules.title}>
      {m.rules ? (
        <>
          <Row label={R.opportunities.snapshot}>
            <button type="button" className="rx-linkbtn" onClick={() => go({ tab: 'communities', id: m.communityId })}>
              {fmtText(R.rules.version, { n: m.rules.version })}
            </button>{' '}
            · {m.rules.state === 'reviewed' ? R.studio.rules.reviewed : R.rules.states[m.rules.state]}
            {m.rules.selfReview ? ` (${R.rules.selfReview})` : ''}
          </Row>
          <Row label={R.rules.checkedAt}>{fmtDateTime(m.rules.checkedAt)}</Row>
          <Row label={R.rules.fields.promotionPolicy}>{R.rules.promotion[m.rules.promotionPolicy]}</Row>
          <Row label={R.rules.fields.linksPolicy}>{R.rules.links[m.rules.linksPolicy]}</Row>
          <GateBlock gate={m.rules.gate} />
        </>
      ) : (
        <Alert tone="warning">{R.studio.rulesNone}</Alert>
      )}
    </Section>
  );
}

function DisclosurePanel({ b, v, check }: { b: RedditBriefView; v: VersionView | null; check: RedditMaterialView['policyCheck'] }) {
  // Замороженная версия несёт свою связь (`meta.affiliation`, §9.3).
  const frozen = v?.meta.affiliation;
  const aff: RedditAffiliation | null = frozen && (REDDIT_AFFILIATIONS as readonly string[]).includes(frozen) ? (frozen as RedditAffiliation) : b.affiliation;
  const text = v?.meta.disclosure ?? '';
  // Вердикт — только сервера: коды раскрытия последней `reddit_policy`.
  const verdict = [...(check?.blockers ?? []).map((x) => ({ ...x, block: true })), ...(check?.warnings ?? []).map((x) => ({ ...x, block: false }))].filter((x) =>
    (DISCLOSURE_CODES as readonly string[]).includes(x.code),
  );
  return (
    <Section title={R.studio.disclosure.title}>
      <Row label={R.briefs.fields.affiliation}>{aff ? R.briefs.affiliations[aff] : R.common.none}</Row>
      {aff === 'none' ? (
        <span className="muted">{R.studio.disclosure.none}</span>
      ) : text ? (
        <PlainQuote text={text} label={R.studio.disclosure.title} />
      ) : (
        <span className="muted">{R.studio.disclosure.empty}</span>
      )}
      {aff && aff !== 'none' && <span className="muted rx-hint">{R.studio.draft.disclosureRule}</span>}
      {verdict.length > 0 && (
        <Alert tone={verdict.some((x) => x.block) ? 'danger' : 'warning'} title={R.studio.disclosure.verdict}>
          <ul className="rx-list">
            {verdict.map((x, i) => (
              <li key={i}>{findingText(x, x.block ? 'blocker' : 'warning', R)}</li>
            ))}
          </ul>
        </Alert>
      )}
    </Section>
  );
}

// ── Проверки и согласование ───────────────────────────────────────────────

function PolicyPanel({ m, onChanged }: { m: RedditMaterialView; onChanged: () => void }) {
  const { api } = useRx();
  const mu = useMutation();
  const p = m.policyCheck;
  return (
    <Section title={R.studio.policy.title}>
      {!p ? (
        <span className="muted">{R.studio.policy.none}</span>
      ) : (
        <div className="rx-stack" data-reddit-policy={p.result}>
          <span className="muted rx-hint">{fmtText(R.studio.policy.checkedAt, { date: fmtDateTime(p.checkedAt) })}</span>
          {p.blockers.length === 0 ? (
            <Alert tone="success">{R.studio.policy.pass}</Alert>
          ) : (
            <Alert tone="danger" title={R.studio.policy.fail}>
              <ul className="rx-list">
                {p.blockers.map((x, i) => (
                  <li key={i}>{findingText(x, 'blocker', R)}</li>
                ))}
              </ul>
            </Alert>
          )}
          {p.warnings.length > 0 && (
            <Alert tone="warning" title={R.studio.policy.warns}>
              <ul className="rx-list">
                {p.warnings.map((x, i) => (
                  <li key={i}>{findingText(x, 'warning', R)}</li>
                ))}
              </ul>
            </Alert>
          )}
        </div>
      )}
      {m.currentVersion && m.currentVersion.status !== 'draft' && (
        <>
          <ErrorAlert error={mu.error} onReload={onChanged} />
          <button
            type="button"
            disabled={mu.busy}
            onClick={async () => {
              const x = await mu.run((k) => api.studio.check(m.content.id, k), `check:${m.content.id}:${m.content.revision}:${p?.id ?? ''}`);
              if (x) onChanged();
            }}
          >
            {R.studio.policy.recheck}
          </button>
        </>
      )}
    </Section>
  );
}

function HumanQaPanel({ v }: { v: VersionView }) {
  const { api } = useRx();
  const checks = useLoad(() => api.content.qaChecks(v.id), [api, v.id]);
  return (
    <Section title={R.studio.humanQa.title}>
      {checks.error ? <ErrorAlert error={checks.error} onReload={checks.reload} onRetry={checks.reload} /> : null}
      {!checks.data ? (
        checks.loading ? <Loading /> : null
      ) : (
        (['editorial', 'technical'] as const).map((kind) => {
          const last = checks.data?.filter((q) => q.kind === kind).pop();
          return <HumanQaRow key={kind} kind={kind} v={v} result={last?.result ?? null} self={last?.selfReview ?? false} onDone={checks.reload} />;
        })
      )}
    </Section>
  );
}

function HumanQaRow({
  kind,
  v,
  result,
  self,
  onDone,
}: {
  kind: 'editorial' | 'technical';
  v: VersionView;
  result: string | null;
  self: boolean;
  onDone: () => void;
}) {
  const { api } = useRx();
  const mu = useMutation();
  const [text, setText] = useState('');
  const send = async (pass: boolean) => {
    const body = humanQaBody(kind, pass, text);
    if (!body) return;
    const x = await mu.run((k) => api.content.qaCheck(v.id, body, k), `qa:${v.id}:${JSON.stringify(body)}`);
    if (x) {
      setText('');
      onDone();
    }
  };
  return (
    <div className="rx-inner rx-stack">
      <div className="rx-row">
        <b>{R.studio.humanQa[kind]}</b>
        {result ? (
          <Badge tone={result === 'pass' ? 'success' : 'danger'}>{result === 'pass' ? R.studio.humanQa.pass : R.studio.humanQa.fail}</Badge>
        ) : (
          <span className="muted rx-hint">{R.studio.humanQa.none}</span>
        )}
        {self && <Badge tone="warning">{R.studio.humanQa.self}</Badge>}
      </div>
      <Field label={R.studio.humanQa.failText}>
        <input value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} />
      </Field>
      <ErrorAlert error={mu.error} />
      <div className="rx-row">
        <button type="button" disabled={mu.busy} onClick={() => void send(true)}>
          {R.studio.humanQa.pass}
        </button>
        <button type="button" disabled={mu.busy || !text.trim()} onClick={() => void send(false)}>
          {R.studio.humanQa.fail}
        </button>
      </div>
    </div>
  );
}

function AckList({
  warnings,
  acked,
  setAcked,
  legend,
}: {
  warnings: Array<{ code: string; params?: QaFindingParams }>;
  acked: Set<string>;
  setAcked: (s: Set<string>) => void;
  legend: string;
}) {
  return (
    <fieldset className="rx-fieldset rx-stack" data-reddit-ack="">
      <legend>{legend}</legend>
      {warnings.map((w) => (
        <label key={w.code} className="rx-check">
          <input
            type="checkbox"
            checked={acked.has(w.code)}
            onChange={(e) => {
              const next = new Set(acked);
              if (e.target.checked) next.add(w.code);
              else next.delete(w.code);
              setAcked(next);
            }}
          />
          {fmtText(R.studio.approve.ack, { text: findingText(w, 'warning', R) })}
        </label>
      ))}
    </fieldset>
  );
}

function ApprovePanel({ m, v, onDone }: { m: RedditMaterialView; v: VersionView; onDone: (a?: ApprovalView) => void }) {
  const { api, userId } = useRx();
  const mu = useMutation();
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const check = m.policyCheck;
  // 409 `warnings_not_acknowledged`: набор WARN изменился при согласовании —
  // чекбоксы и тело повтора по `details`.
  const drift = ackWarningsOf(mu.error);
  const warnings = drift ? drift.warnings : (check?.warnings ?? []);
  const blocked = (check?.blockers.length ?? 0) > 0;
  const body = !v.hash || blocked ? null : drift ? approveAckBody(v.hash, reason, drift.codes, acked) : approveRedditBody(v.hash, reason, check, acked);
  const all = warnings.every((w) => acked.has(w.code));
  const own = isOwnActor(v.authorMemberId, userId);
  return (
    <Section title={R.studio.approve.title}>
      {own && <Alert tone="warning">{R.studio.approve.selfReview}</Alert>}
      {blocked && <Alert tone="danger">{R.studio.policy.fail}</Alert>}
      <ErrorAlert error={mu.error} onReload={drift ? undefined : () => onDone()} />
      {warnings.length > 0 && !blocked && (
        <>
          <AckList warnings={warnings} acked={acked} setAcked={setAcked} legend={R.studio.policy.warns} />
          {!all && <span className="rx-hint rx-warn">{R.studio.approve.ackAll}</span>}
        </>
      )}
      <Field label={R.studio.approve.reason}>
        <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Notice text={done} />
      <button
        type="button"
        disabled={!body || mu.busy}
        onClick={async () => {
          if (!body) return;
          const x = await mu.run((k) => api.content.approve(v.id, body, k), `approve:${v.id}:${JSON.stringify(body)}`);
          if (x) {
            setDone(x.selfReview ? `${R.studio.approve.done} (согласовано автором)` : R.studio.approve.done);
            onDone(x);
          }
        }}
      >
        {drift ? R.studio.approve.ackRetry : R.studio.approve.run}
      </button>
    </Section>
  );
}

function TransitionPanel({
  m,
  to,
  title,
  reasonLabel,
  statusLabels,
  onDone,
}: {
  m: RedditMaterialView;
  to: 'changes_requested' | 'approved';
  title: string;
  reasonLabel: string;
  statusLabels: Record<string, string>;
  onDone: () => void;
}) {
  const { api } = useRx();
  const mu = useMutation();
  const [reason, setReason] = useState('');
  return (
    <Section title={title}>
      <Field label={reasonLabel}>
        <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorAlert error={mu.error} onReload={onDone} statusLabels={statusLabels} />
      <button
        type="button"
        disabled={!reason.trim() || mu.busy}
        onClick={async () => {
          const x = await mu.run(
            (k) => api.content.transition(m.content.id, { expectedRevision: m.content.revision, to, reason: reason.trim() }, k),
            `tr:${m.content.id}:${m.content.revision}:${to}`,
          );
          if (x) onDone();
        }}
      >
        {title}
      </button>
    </Section>
  );
}

/**
 * Отзыв согласования версии (`cx/approvals/:id/revoke`, причина
 * обязательна). Id — из `approval` вида материала (контракт v1.3); запасные
 * пути — ответ согласования этой вкладки или отметка о публикации
 * (`approvalIdOf`). Ручного ввода id нет: нет id — согласования нет.
 */
function RevokeApprovalPanel({ m, known, onDone }: { m: RedditMaterialView; known: string | null; onDone: () => void }) {
  const { api } = useRx();
  const mu = useMutation();
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const id = known;
  return (
    <Section title={C.materials.revokeApproval}>
      <span className="muted rx-hint">
        Отзыв возвращает материал к согласованию: скопированный текст перестаёт считаться утверждённым. Версия{' '}
        {fmtText(R.studio.versions.version, { n: m.approvedVersion?.number ?? 0 })}.
      </span>
      {!id && <span className="muted rx-hint">Активного согласования этой версии нет (отозвано или истекло) — отзывать нечего.</span>}
      {id && m.approval?.selfReview && <span className="muted rx-hint">Согласовано автором версии (selfReview).</span>}
      <Field label={C.materials.revokeReason}>
        <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorAlert error={mu.error} onReload={onDone} />
      <Notice text={notice} />
      <ConfirmButton
        danger
        busy={mu.busy}
        disabled={!id || !reason.trim()}
        onConfirm={async () => {
          if (!id) return;
          const x = await mu.run((k) => api.content.revokeApproval(id, reason.trim(), k), `revokeApproval:${id}:${reason.trim()}`);
          if (x) {
            setNotice(C.materials.approvalRevoked);
            onDone();
          }
        }}
      >
        {C.materials.revokeApproval}
      </ConfirmButton>
    </Section>
  );
}

// ── Копирование, отчёт, публикации ────────────────────────────────────────

/** Результат копирования: РОВНО строки ответа `copy` (утверждённая версия сервера). */
function CopyResult({ copy }: { copy: RedditCopyView }) {
  return (
    <div className="rx-stack" data-reddit-copy={copy.copyToken}>
      <span className="muted rx-hint rx-wrap">
        {fmtText(R.studio.copy.hash, { hash: copy.versionHash.slice(0, 12) })} ·{' '}
        {fmtText(R.studio.rulesBasis, { v: copy.rules.version, date: fmtDateTime(copy.rules.checkedAt) })}
      </span>
      {copy.title !== null && <CopyBlock label={R.studio.draft.fields.title} text={copy.title} buttonLabel={R.studio.copy.copyTitle} />}
      <CopyBlock label={R.studio.draft.fields.body} text={copy.body} buttonLabel={R.studio.copy.copyBody} />
      {copy.flairSuggestion && <span>{fmtText(R.studio.copy.flair, { flair: copy.flairSuggestion })}</span>}
      <RedditLink url={copy.openUrl}>{R.studio.openReddit}</RedditLink>
    </div>
  );
}

function CopyPanel({ m, onCopied }: { m: RedditMaterialView; onCopied: () => void }) {
  const { api } = useRx();
  const mu = useMutation();
  const [copy, setCopy] = useState<RedditCopyView | null>(null);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  // 409: WARN появились после согласования — подтвердить и повторить (§9.7).
  const fresh = ackWarningsOf(mu.error);
  const run = async (ack: string[]) => {
    const body = ack.length ? { acknowledgedWarnings: ack } : {};
    const x = await mu.run((k) => api.studio.copy(m.content.id, k, body), `copy:${m.content.id}:${m.copies.count}:${ack.join(',')}`);
    if (x) {
      setCopy(x);
      setAcked(new Set());
      if (x.scheduled) onCopied();
    }
  };
  return (
    <Section title={R.studio.copy.title}>
      <Alert tone="neutral">{R.studio.copy.note}</Alert>
      <span className="muted rx-hint">
        {fmtText(R.studio.copy.count, { n: m.copies.count })}
        {m.copies.lastAt && ` · ${fmtText(R.studio.copy.last, { date: fmtDateTime(m.copies.lastAt) })}`}
      </span>
      {fresh ? (
        <>
          <AckList warnings={fresh.warnings} acked={acked} setAcked={setAcked} legend={R.studio.copy.newWarnings} />
          <button type="button" disabled={mu.busy || !fresh.codes.every((c) => acked.has(c))} onClick={() => void run(fresh.codes)}>
            {R.studio.copy.ackCopy}
          </button>
        </>
      ) : (
        <>
          <ErrorAlert error={mu.error} onReload={onCopied} />
          <button type="button" disabled={mu.busy} onClick={() => void run([])}>
            {R.studio.copy.prepare}
          </button>
        </>
      )}
      {copy && <CopyResult copy={copy} />}
    </Section>
  );
}

function ReportPanel({ m, onDone }: { m: RedditMaterialView; onDone: () => void }) {
  const { api } = useRx();
  const mu = useMutation();
  const [url, setUrl] = useState('');
  const [postedAt, setPostedAt] = useState('');
  const [notes, setNotes] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const chk = reportIssues(m, url, postedAt, notes, new Date(), m.approvedVersion?.frozenAt ?? null);
  // До ввода не ругаемся на пустые поля.
  const shown = chk.issues.filter((x) => !(x === 'format' && !url.trim()) && !(x === 'date' && !postedAt));
  const ok = chk.issues.length === 0;
  return (
    <Section title={R.studio.report.title}>
      <Alert tone="neutral">{R.studio.userReportedHint}</Alert>
      <Field label={R.studio.report.url} hint={chk.canon ? fmtText(R.studio.report.canon, { url: chk.canon }) : undefined}>
        <input value={url} maxLength={2048} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <Field label={R.studio.report.postedAt}>
        <input type="datetime-local" value={postedAt} onChange={(e) => setPostedAt(e.target.value)} />
      </Field>
      <Field label={R.studio.report.notes}>
        <textarea rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {shown.length > 0 && (
        <ul className="rx-list rx-warn">
          {shown.map((x) => (
            <li key={x}>{fmtText(R.studio.report.issues[x], { sub: m.subreddit })}</li>
          ))}
        </ul>
      )}
      <Notice text={notice} />
      <ErrorAlert error={mu.error} onReload={onDone} />
      <button
        type="button"
        disabled={!ok || mu.busy}
        onClick={async () => {
          const body = ok ? reportBody(url, postedAt, notes) : null;
          if (!body) return;
          const x = await mu.run((k) => api.studio.reportPublication(m.content.id, k, body), `report:${m.content.id}:${JSON.stringify(body)}`);
          if (x) {
            setNotice(R.studio.report.done);
            setUrl('');
            setNotes('');
            onDone();
          }
        }}
      >
        {R.studio.report.run}
      </button>
    </Section>
  );
}

function PublicationsPanel({ m, onChanged }: { m: RedditMaterialView; onChanged: () => void }) {
  if (!m.publications.length) return null;
  return (
    <Section title={R.studio.publications}>
      <ul className="rx-items">
        {m.publications.map((p) => (
          <li key={p.id} className="rx-item">
            <PublicationLine p={p} />
            {p.status === 'published' && <WithdrawMark p={p} onDone={onChanged} />}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Отметка о публикации: статус, этап, «со слов пользователя», дата, ссылка. */
export function PublicationLine({ p }: { p: RedditPublicationView }) {
  return (
    <div className="rx-stack">
      <div className="rx-row">
        <Badge tone={p.status === 'published' ? 'accent' : p.status === 'withdrawn' ? 'neutral' : 'warning'}>
          {(R.publications.statuses as Record<string, string>)[p.status] ?? p.status}
        </Badge>
        <Badge>{(R.studio.stages as Record<string, string>)[p.stage] ?? p.stage}</Badge>
        {p.reportKind === 'user_reported' && <Badge tone="warning">{R.studio.userReported}</Badge>}
        <span className="muted rx-hint">{fmtDateTime(p.publishedAt)}</span>
      </div>
      <RedditLink url={p.finalUrl}>
        <span className="rx-wrap">{p.finalUrl}</span>
      </RedditLink>
    </div>
  );
}

/** Снять ошибочную отметку (переход публикации `withdrawn`, причина обязательна). */
export function WithdrawMark({ p, onDone }: { p: RedditPublicationView; onDone: () => void }) {
  const { api } = useRx();
  const mu = useMutation();
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const body = publicationTransitionBody(p, 'withdrawn', reason);
  return (
    <div className="rx-inner rx-stack">
      <Field label={R.publications.withdrawReason}>
        <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Notice text={notice} />
      <ErrorAlert error={mu.error} onReload={onDone} />
      <ConfirmButton
        danger
        busy={mu.busy}
        disabled={!body}
        onConfirm={async () => {
          if (!body) return;
          const x = await mu.run((k) => api.calendar.publicationTransition(p.id, body, k), `withdraw:${p.id}:${JSON.stringify(body)}`);
          if (x) {
            setNotice(R.publications.withdrawn);
            onDone();
          }
        }}
      >
        {R.publications.withdraw}
      </ConfirmButton>
    </div>
  );
}
