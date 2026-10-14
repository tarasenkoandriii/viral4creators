import { useState } from 'react';
import { useAsync } from '../../../kit';
import { Alert, Badge, Button, Card } from '../../../kit/ui';
import {
  decodeAdaptation,
  decodeQaReview,
  type AiCallView,
} from '../../../lib/publisher/ai-api';
import type {
  ApprovalView,
  ClaimView,
  ContentView,
  VersionMeta,
  VersionView,
} from '../../../lib/publisher/content-api';
import { approveBody } from '../../../lib/publisher/content-api';
import type {
  ChannelView,
  PublicationView,
} from '../../../lib/publisher/calendar-api';
import {
  publicationTargets,
  publicationTransitionBody,
  withdrawTakesDownPage,
  type PublicationTarget,
} from '../../../lib/publisher/channels-view';
import {
  ADAPTATION_KINDS,
  CLAIM_RISKS,
  CLAIM_SUPPORTS,
  CLAIM_TYPES,
  type AdaptationKind,
  type ClaimRisk,
  type ClaimSupports,
  type ClaimType,
  type ContentStatus,
  type QaResult,
} from '../../../lib/publisher/states';
import {
  actorLabel,
  fmtDateTime,
  fmtText,
  publicationTone,
} from '../../../lib/publisher/view';
import { useMutation, usePubApis, usePubContent } from '../hooks';
import {
  ConfirmButton,
  DateText,
  EmptyState,
  ExternalUrl,
  Field,
  Loadable,
  NoPermission,
  Notice,
  PubErrorAlert,
  RecordLink,
  Row,
  Section,
  Select,
  StatusBadge,
  TextArea,
  TextInput,
} from '../parts';
import { usePublisher } from '../publisher-context';
import { AcceptCallButton, AiRunner } from './AiRunner';

const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Карточка материала (§14.1 `materials/:id`): статус и переходы машины 7.1
 * (сервер отдаёт `allowedTransitions`), версии и diff, паспорт утверждений
 * F04 с источниками («подтверждает/не подтверждает»), проверки QA, AI-
 * проверка (предложение), согласование hash, запись публикации, адаптации
 * F06 (вручную и из AI-черновика), история переходов.
 */
export function MaterialScreen({ cid }: { cid: string }) {
  const { product } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const content = useAsync(
    () => apis.content.content(cid),
    [apis, product.id, cid]
  );
  const versions = useAsync(
    () => apis.content.versions(cid),
    [apis, product.id, cid]
  );
  const [vid, setVid] = useState<string | null>(null);
  const reload = () => {
    content.reload();
    versions.reload();
  };
  return (
    <Loadable state={content}>
      {(x) => {
        const list = versions.data ?? [];
        const selected =
          list.find((v) => v.id === vid) ??
          list.find((v) => v.id === x.currentVersionId) ??
          list[list.length - 1] ??
          null;
        return (
          <div className="space-y-4">
            {x.redditStudio && (
              <Alert tone="neutral" title={c.materials.redditStudio}>
                <RecordLink
                  section="reddit"
                  id={x.id}
                  query={{ tab: 'studio' }}
                >
                  {c.materials.openRedditStudio}
                </RecordLink>
              </Alert>
            )}
            <ContentHeader
              key={`h-${x.revision}`}
              content={x}
              onChanged={reload}
            />
            <VersionsPanel
              content={x}
              versions={list}
              selected={selected}
              onSelect={setVid}
              onChanged={reload}
            />
            {selected && (
              <>
                <ClaimsPanel version={selected} />
                <QaPanel content={x} version={selected} />
                <ApprovalPanel
                  content={x}
                  version={selected}
                  onChanged={reload}
                />
                <PublicationsPanel
                  version={selected}
                  studio={!!x.redditStudio}
                />
              </>
            )}
            {x.kind === 'article' && <AdaptationsPanel content={x} />}
            <HistoryPanel cid={x.id} />
          </div>
        );
      }}
    </Loadable>
  );
}

function ContentHeader({
  content: x,
  onChanged,
}: {
  content: ContentView;
  onChanged: () => void;
}) {
  const { t, can, memberId } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const [slug, setSlug] = useState(x.slug ?? '');
  const [ownerName, setOwnerName] = useState(x.ownerDisplayName ?? '');
  const [due, setDue] = useState(x.nextDueAt ? x.nextDueAt.slice(0, 16) : '');
  const [block, setBlock] = useState(x.blockReason ?? '');
  const [to, setTo] = useState<ContentStatus | ''>('');
  const [reason, setReason] = useState('');
  const [plannedAt, setPlannedAt] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation();
  const move = useMutation();
  const editable = can('version.manage');
  return (
    <Section
      title={`${c.materials.kinds[x.kind]} · ${x.slug ?? x.id}`}
      action={<StatusBadge status={x.status} labels={c.materials.statuses} />}
    >
      {x.criticalStale && (
        <Alert tone="danger">{c.materials.criticalStale}</Alert>
      )}
      {x.openTasks.length > 0 && (
        <Alert
          tone="warning"
          title={fmtText(c.materials.openTasks, { n: x.openTasks.length })}
        >
          <ul className="list-disc pl-5">
            {x.openTasks.map((task) => (
              <li key={task.id}>
                {t.review.reasons[task.reason]} ({task.objectType})
              </li>
            ))}
          </ul>
        </Alert>
      )}
      <Row label={c.materials.owner}>
        {x.ownerDisplayName ?? x.ownerMemberId ?? '—'}
      </Row>
      <Row label={c.materials.nextDue}>
        <DateText iso={x.nextDueAt} time />
      </Row>
      {x.blockReason && (
        <Row label={c.materials.blockReason}>{x.blockReason}</Row>
      )}
      {x.firstPublishedAt && (
        <Row label={c.materials.statuses.published}>
          <DateText iso={x.firstPublishedAt} />
        </Row>
      )}
      {x.briefId && (
        <Row label={c.brief.title}>
          <RecordLink section="briefs" id={x.briefId}>
            {x.briefId}
          </RecordLink>
        </Row>
      )}
      {x.parentContentId && (
        <Row label={c.materials.parent}>
          <RecordLink section="materials" id={x.parentContentId}>
            {x.parentContentId}
          </RecordLink>
        </Row>
      )}
      <Notice text={notice} />
      {editable && (
        <Card className="space-y-2">
          <div className="grid gap-2 md:grid-cols-2">
            {x.kind === 'article' && (
              <Field label={c.materials.slug}>
                <TextInput value={slug} onChange={setSlug} maxLength={120} />
              </Field>
            )}
            <Field label={c.materials.ownerName}>
              <TextInput
                value={ownerName}
                onChange={setOwnerName}
                maxLength={80}
              />
            </Field>
            <Field label={c.materials.nextDue}>
              <TextInput value={due} onChange={setDue} type="datetime-local" />
            </Field>
            <Field label={c.materials.blockReason}>
              <TextInput value={block} onChange={setBlock} maxLength={64} />
            </Field>
          </div>
          <PubErrorAlert error={save.error} onReload={onChanged} />
          <Button
            variant="outline"
            loading={save.busy}
            onClick={async () => {
              const r = await save.run((k) =>
                apis.content.patchContent(
                  x.id,
                  {
                    expectedRevision: x.revision,
                    ...(x.kind === 'article'
                      ? { slug: slug.trim() || null }
                      : {}),
                    ownerMemberId: memberId || x.ownerMemberId,
                    ownerDisplayName: ownerName.trim() || null,
                    nextDueAt: due ? new Date(due).toISOString() : null,
                    blockReason: block.trim() || null,
                  },
                  k
                )
              );
              if (r) {
                setNotice(c.materials.saved);
                onChanged();
              }
            }}
          >
            {c.materials.save}
          </Button>
        </Card>
      )}
      {(editable || can('publication.manage')) &&
        !x.redditStudio &&
        x.allowedTransitions.length > 0 && (
          <Card className="space-y-2">
            <div className="font-medium text-sm">{c.materials.transitions}</div>
            <Select
              value={to}
              options={x.allowedTransitions}
              labels={c.materials.statuses}
              empty="—"
              onChange={setTo}
              ariaLabel={c.materials.transitions}
            />
            <TextInput
              value={reason}
              onChange={setReason}
              placeholder={c.materials.transitionReason}
              maxLength={500}
            />
            {to === 'scheduled' && (
              <Field label={c.materials.plannedAt}>
                <TextInput
                  value={plannedAt}
                  onChange={setPlannedAt}
                  type="datetime-local"
                />
              </Field>
            )}
            {to === 'withdrawn' && (
              <div className="text-xs text-amber-700">
                {c.materials.withdrawHint}
              </div>
            )}
            <PubErrorAlert error={move.error} onReload={onChanged} />
            <ConfirmButton
              variant="outline"
              loading={move.busy}
              disabled={!to}
              onConfirm={async () => {
                if (!to) return;
                const r = await move.run((k) =>
                  apis.content.transition(
                    x.id,
                    {
                      to,
                      expectedRevision: x.revision,
                      reason: reason.trim() || null,
                      ...(to === 'scheduled' && plannedAt
                        ? { plannedAt: new Date(plannedAt).toISOString() }
                        : {}),
                    },
                    k
                  )
                );
                if (r) {
                  setNotice(c.materials.moved);
                  onChanged();
                }
              }}
            >
              {to ? c.materials.statuses[to] : c.materials.transitions}
            </ConfirmButton>
          </Card>
        )}
    </Section>
  );
}

// ── Версии ────────────────────────────────────────────────────────────────

function VersionsPanel({
  content: x,
  versions,
  selected,
  onSelect,
  onChanged,
}: {
  content: ContentView;
  versions: VersionView[];
  selected: VersionView | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const { can, locale } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const [mode, setMode] = useState<'new' | 'edit' | null>(null);
  const [diffWith, setDiffWith] = useState('');
  const submit = useMutation();
  const diff = useAsync(
    async () =>
      selected && diffWith
        ? apis.content.diff(x.id, diffWith, selected.id)
        : null,
    [apis, x.id, selected?.id, diffWith]
  );
  return (
    <Section
      title={c.materials.versions}
      action={
        can('version.manage') && !x.redditStudio ? (
          <Button
            variant="outline"
            onClick={() => setMode(mode === 'new' ? null : 'new')}
          >
            {c.materials.newVersion}
          </Button>
        ) : undefined
      }
    >
      {versions.length === 0 && (
        <EmptyState>{c.materials.noVersion}</EmptyState>
      )}
      <ul className="space-y-1">
        {versions.map((v) => (
          <li key={v.id}>
            <button
              type="button"
              onClick={() => onSelect(v.id)}
              className={`w-full text-left rounded-lg px-2 py-1 flex flex-wrap items-center gap-2 text-sm ${
                selected?.id === v.id ? 'bg-accent/10' : ''
              }`}
            >
              <span className="font-medium">
                {fmtText(c.materials.version, { n: v.number })}
              </span>
              <span className="flex-1 min-w-0 truncate">{v.title}</span>
              <StatusBadge
                status={v.status}
                labels={c.materials.versionStatuses}
              />
              {v.id === x.currentVersionId && (
                <Badge tone="neutral">{c.materials.currentVersion}</Badge>
              )}
              {v.id === x.approvedVersionId && (
                <Badge tone="success">{c.materials.approvedVersion}</Badge>
              )}
              {v.id === x.publishedVersionId && (
                <Badge tone="accent">{c.materials.publishedVersion}</Badge>
              )}
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <Card className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-silver-500">
            <span>
              {c.materials.hash}:{' '}
              <code className="break-all">{selected.hash ?? '—'}</code>
            </span>
            {selected.frozenAt && (
              <span>
                {fmtText(c.materials.frozen, {
                  date: fmtDateTime(selected.frozenAt, locale),
                })}
              </span>
            )}
            {selected.isScript && (
              <Badge tone="warning">{c.materials.script}</Badge>
            )}
            <span>{actorLabel(`member:${selected.authorMemberId}`)}</span>
            {selected.aiCallId && (
              <code className="break-all">AI {selected.aiCallId}</code>
            )}
          </div>
          <div className="font-semibold">{selected.title}</div>
          <MetaView meta={selected.meta} />
          <pre
            className="text-sm whitespace-pre-wrap break-words max-h-96 overflow-auto"
            tabIndex={0}
            role="region"
            aria-label={c.materials.versions}
          >
            {selected.body}
          </pre>
          <div className="text-xs text-silver-500">
            {c.materials.vfields.sources}: {selected.sourceIds.length} ·{' '}
            {c.materials.vfields.claims}: {selected.claimIds.length} ·{' '}
            {c.materials.vfields.facts}: {selected.factIds.length}
          </div>
          {can('version.manage') &&
            !x.redditStudio &&
            selected.status === 'draft' && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  onClick={() => setMode(mode === 'edit' ? null : 'edit')}
                >
                  {c.materials.editDraft}
                </Button>
                <Button
                  loading={submit.busy}
                  onClick={async () => {
                    const r = await submit.run((k) =>
                      apis.content.submitVersion(
                        x.id,
                        selected.id,
                        selected.revision,
                        k
                      )
                    );
                    if (r) onChanged();
                  }}
                >
                  {c.materials.submit}
                </Button>
              </div>
            )}
          <PubErrorAlert error={submit.error} onReload={onChanged} />
          {versions.length > 1 && (
            <Field label={c.materials.diffWith}>
              <select
                className="w-full rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 min-h-[44px] text-sm"
                value={diffWith}
                onChange={(e) => setDiffWith(e.target.value)}
              >
                <option value="">—</option>
                {versions
                  .filter((v) => v.id !== selected.id)
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {fmtText(c.materials.version, { n: v.number })}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          {diffWith && (
            <Loadable state={diff}>
              {(d) =>
                d ? (
                  <div className="space-y-1 text-sm">
                    {d.title && (
                      <div>
                        <del className="text-rose-600">{d.title.from}</del> →{' '}
                        <ins className="text-emerald-700">{d.title.to}</ins>
                      </div>
                    )}
                    {d.bodyCoarse && (
                      <div className="text-xs text-silver-500">
                        {c.materials.diffCoarse}
                      </div>
                    )}
                    {d.metaChanged.length > 0 && (
                      <div className="text-xs">
                        {fmtText(c.materials.diffMeta, {
                          list: d.metaChanged.join(', '),
                        })}
                      </div>
                    )}
                    {d.offerChanged && (
                      <div className="text-xs">{c.materials.diffOffer}</div>
                    )}
                    {(['sources', 'claims', 'facts'] as const).map((k) =>
                      d[k].added.length || d[k].removed.length ? (
                        <div key={k} className="text-xs">
                          {c.materials.vfields[k]}: +{d[k].added.length} / −
                          {d[k].removed.length}
                        </div>
                      ) : null
                    )}
                    <pre
                      className="text-xs whitespace-pre-wrap max-h-80 overflow-auto"
                      tabIndex={0}
                      role="region"
                      aria-label={c.materials.diffWith}
                    >
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
                  </div>
                ) : null
              }
            </Loadable>
          )}
        </Card>
      )}
      {mode && can('version.manage') && (
        <VersionForm
          key={`${mode}-${selected?.id ?? ''}`}
          content={x}
          base={selected}
          editId={mode === 'edit' && selected ? selected : null}
          onDone={(v) => {
            setMode(null);
            onSelect(v.id);
            onChanged();
          }}
        />
      )}
      {can('ai.generate') && can('version.manage') && (
        <AiRunner
          generator="pub.draft.write"
          label={c.materials.aiDraft}
          manualHint={c.materials.aiDraftManual}
          // В P0 генератор выключен (409 PUB_AI_DISABLED) — ручной путь.
          start={(k) => apis.ai.draftWrite(x.id, k)}
          render={() => null}
        />
      )}
    </Section>
  );
}

function MetaView({ meta }: { meta: VersionMeta }) {
  const c = usePubContent();
  return (
    <div className="space-y-1 text-sm">
      {meta.description && (
        <Row label={c.materials.vfields.description}>{meta.description}</Row>
      )}
      {meta.shortAnswer && (
        <Row label={c.materials.vfields.shortAnswer}>{meta.shortAnswer}</Row>
      )}
      {meta.example && (
        <Row label={c.materials.vfields.example}>{meta.example}</Row>
      )}
      {meta.limitations && meta.limitations.length > 0 && (
        <Row label={c.materials.vfields.limitations}>
          {meta.limitations.join('; ')}
        </Row>
      )}
      {meta.cta && <Row label={c.materials.vfields.cta}>{meta.cta}</Row>}
      {meta.cards && (
        <ul className="list-disc pl-5">
          {meta.cards.map((x, i) => (
            <li key={i}>
              <b>{x.title}</b> — {x.text}
            </li>
          ))}
        </ul>
      )}
      {meta.scenes && (
        <ol className="list-decimal pl-5">
          {meta.scenes.map((x, i) => (
            <li key={i}>
              {x.visual} / {x.voice} / {x.caption}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function VersionForm({
  content: x,
  base,
  editId,
  onDone,
  preset,
}: {
  content: ContentView;
  base: VersionView | null;
  editId: VersionView | null;
  onDone: (v: VersionView) => void;
  preset?: {
    title: string;
    body: string;
    meta: VersionMeta;
    sourceIds: string[];
    parentVersionId: string | null;
    aiCallId: string;
  };
}) {
  const { t } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const offers = useAsync(
    async () => (await apis.content.offers({ limit: 50 })).items,
    [apis]
  );
  const sources = useAsync(
    async () =>
      (await apis.content.sources({ usage: 'allowed', limit: 100 })).items,
    [apis]
  );
  const facts = useAsync(
    async () =>
      (await apis.content.facts({ status: 'active', limit: 100 })).items,
    [apis]
  );
  const claims = useAsync(
    async () => (await apis.content.claims({ limit: 100 })).items,
    [apis]
  );
  const src = preset ?? base;
  const [title, setTitle] = useState(src?.title ?? '');
  const [body, setBody] = useState(preset?.body ?? base?.body ?? '');
  const m0 = preset?.meta ?? base?.meta ?? {};
  const [description, setDescription] = useState(m0.description ?? '');
  const [shortAnswer, setShortAnswer] = useState(m0.shortAnswer ?? '');
  const [example, setExample] = useState(m0.example ?? '');
  const [limitations, setLimitations] = useState(
    (m0.limitations ?? []).join('\n')
  );
  const [cta, setCta] = useState(m0.cta ?? '');
  const [offerId, setOfferId] = useState(base?.offerVersionId ?? '');
  const [sourceIds, setSourceIds] = useState<string[]>(
    preset?.sourceIds ?? base?.sourceIds ?? []
  );
  const [claimIds, setClaimIds] = useState<string[]>(base?.claimIds ?? []);
  const [factIds, setFactIds] = useState<string[]>(base?.factIds ?? []);
  const [parentVersionId, setParentVersionId] = useState(
    preset?.parentVersionId ?? base?.parentVersionId ?? ''
  );
  const m = useMutation();
  const activeOffer = (offers.data ?? []).find((o) => o.status === 'active');
  const offer = offerId || activeOffer?.id || '';
  const meta: VersionMeta = {
    ...(description.trim() ? { description: description.trim() } : {}),
    ...(shortAnswer.trim() ? { shortAnswer: shortAnswer.trim() } : {}),
    ...(example.trim() ? { example: example.trim() } : {}),
    ...(lines(limitations).length ? { limitations: lines(limitations) } : {}),
    ...(cta.trim() ? { cta: cta.trim() } : {}),
    ...(m0.cards ? { cards: m0.cards } : {}),
    ...(m0.scenes ? { scenes: m0.scenes } : {}),
  };
  const toggle =
    (set: (f: (p: string[]) => string[]) => void) =>
    (id: string, on: boolean) =>
      set((p) => (on ? [...p, id] : p.filter((y) => y !== id)));
  return (
    <Card className="space-y-2">
      <Field label={c.materials.vfields.title}>
        <TextInput value={title} onChange={setTitle} maxLength={300} />
      </Field>
      <Field label={c.materials.vfields.body}>
        <TextArea value={body} onChange={setBody} rows={10} />
      </Field>
      <div className="grid gap-2 md:grid-cols-2">
        <Field label={c.materials.vfields.description}>
          <TextInput
            value={description}
            onChange={setDescription}
            maxLength={300}
          />
        </Field>
        <Field label={c.materials.vfields.cta}>
          <TextInput value={cta} onChange={setCta} maxLength={300} />
        </Field>
      </div>
      <Field label={c.materials.vfields.shortAnswer}>
        <TextArea value={shortAnswer} onChange={setShortAnswer} rows={2} />
      </Field>
      <Field label={c.materials.vfields.example}>
        <TextArea value={example} onChange={setExample} rows={2} />
      </Field>
      <Field label={c.materials.vfields.limitations}>
        <TextArea value={limitations} onChange={setLimitations} rows={2} />
      </Field>
      <Field label={c.materials.vfields.offerVersion}>
        <select
          className="w-full rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 min-h-[44px] text-sm"
          value={offer}
          onChange={(e) => setOfferId(e.target.value)}
        >
          <option value="">—</option>
          {(offers.data ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              v{o.version} · {o.title} ({c.brand.offerStatuses[o.status]})
            </option>
          ))}
        </select>
      </Field>
      {x.parentContentId && (
        <Field label={c.materials.vfields.parentVersion}>
          <TextInput value={parentVersionId} onChange={setParentVersionId} />
        </Field>
      )}
      <PickList
        label={c.materials.vfields.sources}
        items={(sources.data ?? []).map((s) => ({
          id: s.id,
          label: s.title ?? s.id,
        }))}
        picked={sourceIds}
        onToggle={toggle(setSourceIds)}
      />
      <PickList
        label={c.materials.vfields.claims}
        items={(claims.data ?? []).map((cl) => ({
          id: cl.id,
          label: cl.statement,
        }))}
        picked={claimIds}
        onToggle={toggle(setClaimIds)}
      />
      <PickList
        label={c.materials.vfields.facts}
        items={(facts.data ?? []).map((f) => ({ id: f.id, label: f.factKey }))}
        picked={factIds}
        onToggle={toggle(setFactIds)}
      />
      <PubErrorAlert error={m.error} />
      <Button
        loading={m.busy}
        disabled={!title.trim() || !body.trim() || !offer}
        onClick={async () => {
          const payload = {
            title: title.trim(),
            body,
            meta,
            sourceIds,
            claimIds,
            factIds,
            offerVersionId: offer,
            ...(x.parentContentId
              ? { parentVersionId: parentVersionId || null }
              : {}),
          };
          const r = await m.run((k) =>
            editId
              ? apis.content.patchVersion(
                  x.id,
                  editId.id,
                  { ...payload, expectedRevision: editId.revision },
                  k
                )
              : apis.content.createVersion(
                  x.id,
                  {
                    ...payload,
                    ...(preset ? { aiCallId: preset.aiCallId } : {}),
                  },
                  k
                )
          );
          if (r) onDone(r);
        }}
      >
        {editId ? t.common.save : c.materials.newVersion}
      </Button>
    </Card>
  );
}

function PickList({
  label,
  items,
  picked,
  onToggle,
}: {
  label: string;
  items: Array<{ id: string; label: string }>;
  picked: string[];
  onToggle: (id: string, on: boolean) => void;
}) {
  const unknown = picked.filter((p) => !items.some((i) => i.id === p));
  return (
    <Field label={`${label} (${picked.length})`}>
      <div className="max-h-32 overflow-auto space-y-1">
        {items.map((i) => (
          <label key={i.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={picked.includes(i.id)}
              onChange={(e) => onToggle(i.id, e.target.checked)}
            />
            <span className="truncate">{i.label}</span>
          </label>
        ))}
        {unknown.map((u) => (
          <label
            key={u}
            className="flex items-center gap-2 text-sm text-amber-700"
          >
            <input
              type="checkbox"
              checked
              onChange={() => onToggle(u, false)}
            />
            <code className="break-all">{u}</code>
          </label>
        ))}
      </div>
    </Field>
  );
}

// ── Утверждения F04 ───────────────────────────────────────────────────────

function ClaimsPanel({ version }: { version: VersionView }) {
  const { can } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const claims = useAsync(
    async () =>
      (await apis.content.claims({ versionId: version.id, limit: 100 })).items,
    [apis, version.id]
  );
  const linked = useAsync(
    async () =>
      (await apis.content.claims({ limit: 100 })).items.filter((cl) =>
        version.claimIds.includes(cl.id)
      ),
    [apis, version.id, version.claimIds.join(',')]
  );
  const sources = useAsync(
    async () => (await apis.content.sources({ limit: 100 })).items,
    [apis]
  );
  const all = [
    ...(claims.data ?? []),
    ...(linked.data ?? []).filter(
      (x) => !(claims.data ?? []).some((y) => y.id === x.id)
    ),
  ];
  return (
    <Section title={c.materials.claims}>
      <p className="text-xs text-silver-500">{c.materials.claimOrder}</p>
      <Loadable state={claims}>
        {() =>
          all.length ? (
            <ul className="divide-y divide-silver-200 dark:divide-silver-800">
              {all.map((cl) => (
                <ClaimRow
                  key={cl.id}
                  claim={cl}
                  sources={(sources.data ?? []).map((s) => ({
                    id: s.id,
                    label: s.title ?? s.id,
                    usage: s.usage,
                  }))}
                  onChanged={() => {
                    claims.reload();
                    linked.reload();
                  }}
                />
              ))}
            </ul>
          ) : (
            <EmptyState />
          )
        }
      </Loadable>
      {can('version.manage') && (
        <NewClaim versionId={version.id} onDone={claims.reload} />
      )}
      {can('ai.generate') && (
        <AiRunner
          generator="pub.claims.extract"
          label={c.materials.aiExtract}
          manualHint={c.materials.aiExtractManual}
          start={(k) => apis.ai.claimsExtract(version.id, k)}
          render={() => null}
        />
      )}
    </Section>
  );
}

function ClaimRow({
  claim: cl,
  sources,
  onChanged,
}: {
  claim: ClaimView;
  sources: Array<{ id: string; label: string; usage: string }>;
  onChanged: () => void;
}) {
  const { can } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const [sourceId, setSourceId] = useState('');
  const [supports, setSupports] = useState<ClaimSupports | ''>('yes');
  const [note, setNote] = useState('');
  const [status, setStatus] = useState<
    'supported' | 'unsupported' | 'unknown' | 'needs_review' | ''
  >('');
  const link = useMutation();
  const verify = useMutation();
  const label = (id: string) => sources.find((s) => s.id === id)?.label ?? id;
  return (
    <li className="py-2 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 min-w-0">{cl.statement}</span>
        <Badge tone="neutral">{c.materials.claimTypes[cl.type]}</Badge>
        <Badge
          tone={
            cl.risk === 'critical'
              ? 'danger'
              : cl.risk === 'high'
                ? 'warning'
                : 'neutral'
          }
        >
          {c.materials.claimRisks[cl.risk]}
        </Badge>
        <StatusBadge status={cl.status} labels={c.materials.claimStatuses} />
      </div>
      {cl.sources.length > 0 && (
        <ul className="text-xs space-y-0.5 pl-2">
          {cl.sources.map((s) => (
            <li key={s.sourceId} className="flex flex-wrap items-center gap-2">
              <StatusBadge status={s.supports} labels={c.materials.supports} />
              <span>{label(s.sourceId)}</span>
              {s.note && <span className="text-silver-500">— {s.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {cl.sources.length === 0 && (
        <div className="text-xs text-amber-700">
          {c.materials.supports.unknown}
        </div>
      )}
      {can('claim.verify') && (
        <div className="grid gap-2 md:grid-cols-4 items-end">
          <Field label={c.materials.linkSource}>
            <select
              className="w-full rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 min-h-[44px] text-sm"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
            >
              <option value="">—</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} ({s.usage})
                </option>
              ))}
            </select>
          </Field>
          <Field label={c.materials.supportsLabel}>
            <Select
              value={supports}
              options={CLAIM_SUPPORTS}
              labels={c.materials.supports}
              onChange={setSupports}
            />
          </Field>
          <Field label={c.materials.note}>
            <TextInput value={note} onChange={setNote} maxLength={500} />
          </Field>
          <Button
            variant="outline"
            loading={link.busy}
            disabled={!sourceId || !supports}
            onClick={async () => {
              if (!supports) return;
              const r = await link.run((k) =>
                apis.content.claimSource(
                  cl.id,
                  { sourceId, supports, note: note.trim() || null },
                  k
                )
              );
              if (r) onChanged();
            }}
          >
            {c.materials.linkSource}
          </Button>
          <Field label={c.materials.verify}>
            <Select
              value={status}
              options={
                ['supported', 'unsupported', 'unknown', 'needs_review'] as const
              }
              labels={c.materials.claimStatuses}
              empty="—"
              onChange={setStatus}
            />
          </Field>
          <Button
            variant="outline"
            loading={verify.busy}
            disabled={!status}
            onClick={async () => {
              if (!status) return;
              const r = await verify.run((k) =>
                apis.content.verifyClaim(
                  cl.id,
                  { status, expectedRevision: cl.revision },
                  k
                )
              );
              if (r) onChanged();
            }}
          >
            {c.materials.verify}
          </Button>
        </div>
      )}
      <PubErrorAlert error={link.error ?? verify.error} onReload={onChanged} />
    </li>
  );
}

function NewClaim({
  versionId,
  onDone,
}: {
  versionId: string;
  onDone: () => void;
}) {
  const c = usePubContent();
  const apis = usePubApis();
  const [statement, setStatement] = useState('');
  const [type, setType] = useState<ClaimType | ''>('fact');
  const [risk, setRisk] = useState<ClaimRisk | ''>('normal');
  const [notice, setNotice] = useState<string | null>(null);
  const m = useMutation();
  return (
    <Card className="space-y-2">
      <div className="font-medium text-sm">{c.materials.claimAdd}</div>
      <Field label={c.materials.statement}>
        <TextArea value={statement} onChange={setStatement} rows={2} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={c.materials.claimType}>
          <Select
            value={type}
            options={CLAIM_TYPES}
            labels={c.materials.claimTypes}
            onChange={setType}
          />
        </Field>
        <Field label={c.materials.claimRisk}>
          <Select
            value={risk}
            options={CLAIM_RISKS}
            labels={c.materials.claimRisks}
            onChange={setRisk}
          />
        </Field>
      </div>
      <Notice text={notice} />
      <PubErrorAlert error={m.error} />
      <Button
        variant="outline"
        loading={m.busy}
        disabled={!statement.trim() || !type || !risk}
        onClick={async () => {
          if (!type || !risk) return;
          const r = await m.run((k) =>
            apis.content.createClaim(
              {
                statement: statement.trim(),
                type,
                risk,
                extractedFromVersionId: versionId,
              },
              k
            )
          );
          if (r) {
            setNotice(c.materials.claimAdded);
            setStatement('');
            onDone();
          }
        }}
      >
        {c.materials.claimAdd}
      </Button>
    </Card>
  );
}

// ── QA ───────────────────────────────────────────────────────────────────

function parseBlockers(s: string) {
  return lines(s).map((l) => {
    const i = l.indexOf(':');
    return i > 0
      ? {
          code:
            l
              .slice(0, i)
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9_.-]/g, '_') || 'other',
          text: l.slice(i + 1).trim() || l,
        }
      : { code: 'other', text: l };
  });
}

function QaPanel({
  content: x,
  version,
}: {
  content: ContentView;
  version: VersionView;
}) {
  const { can } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const checks = useAsync(
    () => apis.content.qaChecks(version.id),
    [apis, version.id]
  );
  const [kind, setKind] = useState<
    'editorial' | 'technical' | 'adaptation_meaning' | ''
  >('editorial');
  const [result, setResult] = useState<QaResult | ''>('pass');
  const [blockers, setBlockers] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const m = useMutation();
  const kinds = x.parentContentId
    ? (['editorial', 'technical', 'adaptation_meaning'] as const)
    : (['editorial', 'technical'] as const);
  const canWrite = can('qa.editorial') || can('qa.technical');
  return (
    <Section title={c.materials.qa}>
      <Loadable state={checks}>
        {(items) =>
          items.length ? (
            <ul className="divide-y divide-silver-200 dark:divide-silver-800">
              {items.map((q) => (
                <li key={q.id} className="py-2 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {c.materials.qaKinds[q.kind]}
                    </span>
                    <StatusBadge
                      status={q.result}
                      labels={c.materials.qaResults}
                    />
                    {q.selfReview && <Badge tone="warning">self</Badge>}
                    <span className="text-xs text-silver-500">
                      {actorLabel(q.checkedBy)} ·{' '}
                      <DateText iso={q.checkedAt} time />
                    </span>
                  </div>
                  {q.blockers.length > 0 && (
                    <ul className="list-disc pl-5 text-sm text-rose-700 dark:text-rose-400">
                      {q.blockers.map((b, i) => (
                        <li key={i}>
                          <code className="break-all">{b.code}</code>: {b.text}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState />
          )
        }
      </Loadable>
      {canWrite ? (
        <Card className="space-y-2">
          <div className="font-medium text-sm">{c.materials.qaAdd}</div>
          <div className="grid grid-cols-2 gap-2">
            <Field label={c.materials.qaKind}>
              <Select
                value={kind}
                options={kinds}
                labels={c.materials.qaKinds}
                onChange={setKind}
              />
            </Field>
            <Field label={c.materials.qaResult}>
              <Select
                value={result}
                options={['pass', 'fail', 'unknown'] as const}
                labels={c.materials.qaResults}
                onChange={setResult}
              />
            </Field>
          </div>
          <Field label={c.materials.blockers}>
            <TextArea value={blockers} onChange={setBlockers} rows={3} />
          </Field>
          <Notice text={notice} />
          <PubErrorAlert error={m.error} />
          <Button
            variant="outline"
            loading={m.busy}
            disabled={!kind || !result}
            onClick={async () => {
              if (!kind || !result) return;
              const r = await m.run((k) =>
                apis.content.qaCheck(
                  version.id,
                  { kind, result, blockers: parseBlockers(blockers) },
                  k
                )
              );
              if (r) {
                setNotice(c.materials.qaAdded);
                setBlockers('');
                checks.reload();
              }
            }}
          >
            {c.materials.qaAdd}
          </Button>
        </Card>
      ) : (
        <NoPermission />
      )}
      {can('ai.generate') && (
        <AiRunner
          generator="pub.qa.review"
          label={c.materials.aiReview}
          manualHint={c.ai.manualPath}
          start={(k) => apis.ai.qaReview(version.id, k)}
          render={(call: AiCallView) => {
            let d: ReturnType<typeof decodeQaReview> | null = null;
            try {
              d = decodeQaReview(call.output);
            } catch {
              d = null;
            }
            if (!d) return <Alert tone="warning">{c.ai.manualPath}</Alert>;
            const review = d;
            return (
              <div className="space-y-2 text-sm">
                <div className="text-xs text-silver-500">
                  {c.materials.aiReviewHint}
                </div>
                <div>{review.recommendation}</div>
                {review.claims.length > 0 && (
                  <ul className="list-disc pl-5">
                    {review.claims.map((cl, i) => (
                      <li key={i}>
                        {cl.statement}{' '}
                        <Badge
                          tone={cl.supported === 'yes' ? 'neutral' : 'warning'}
                        >
                          {c.materials.supports[cl.supported]}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
                {review.blockers.length > 0 && (
                  <ul className="list-disc pl-5 text-rose-700">
                    {review.blockers.map((b, i) => (
                      <li key={i}>
                        <code className="break-all">{b.code}</code>: {b.text}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap gap-2">
                  {review.blockers.length > 0 && (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setBlockers(
                          review.blockers
                            .map((b) => `${b.code}: ${b.text}`)
                            .join('\n')
                        )
                      }
                    >
                      {c.materials.useAsBlockers}
                    </Button>
                  )}
                  <AcceptCallButton call={call} />
                </div>
              </div>
            );
          }}
        />
      )}
    </Section>
  );
}

// ── Согласование ─────────────────────────────────────────────────────────

function ApprovalPanel({
  content,
  version,
  onChanged,
}: {
  content: ContentView;
  version: VersionView;
  onChanged: () => void;
}) {
  const { can } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const approvals = useAsync(
    () => apis.content.approvals({ objectId: version.id }),
    [apis, version.id]
  );
  const [reason, setReason] = useState('');
  const approve = useMutation();
  const reload = () => {
    approvals.reload();
    onChanged();
  };
  const hash = version.hash;
  return (
    <Section title={c.materials.approval}>
      <Loadable state={approvals}>
        {(items) =>
          items.length ? (
            <ul className="space-y-2">
              {items.map((a) => (
                <ApprovalRow
                  key={a.id}
                  approval={a}
                  shown={
                    content.publishedVersionId !== null &&
                    content.publishedVersionId === a.objectId
                  }
                  onChanged={reload}
                />
              ))}
            </ul>
          ) : (
            <EmptyState />
          )
        }
      </Loadable>
      {!hash ? (
        <Alert tone="neutral">{c.materials.noHash}</Alert>
      ) : can('version.approve') && !content.redditStudio ? (
        <div className="space-y-2">
          <p className="text-xs text-silver-500">
            {c.materials.approverFromRole}
          </p>
          <Field label={c.materials.approveReason}>
            <TextInput value={reason} onChange={setReason} maxLength={500} />
          </Field>
          <PubErrorAlert error={approve.error} onReload={reload} />
          <ConfirmButton
            variant="solid"
            loading={approve.busy}
            onConfirm={async () => {
              const r = await approve.run((k) =>
                apis.content.approve(version.id, approveBody(hash, reason), k)
              );
              if (r) {
                setReason('');
                reload();
              }
            }}
          >
            {fmtText(c.materials.approve, { hash: hash.slice(0, 12) })}
          </ConfirmButton>
        </div>
      ) : (
        <NoPermission>{c.materials.onlyPoApprove}</NoPermission>
      )}
    </Section>
  );
}

/**
 * Строка согласования: своя причина отзыва и своя мутация на строку.
 * Отзыв согласования показанной версии снимает страницу (410) и
 * публикации в каналах (P-B1 S3-3) — предупреждение явное.
 */
function ApprovalRow({
  approval: a,
  shown,
  onChanged,
}: {
  approval: ApprovalView;
  shown: boolean;
  onChanged: () => void;
}) {
  const { can } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const [reason, setReason] = useState('');
  const revoke = useMutation();
  return (
    <li className="space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={a.status} labels={c.materials.approvalStatuses} />
        <code className="text-xs break-all">{a.versionHash.slice(0, 12)}</code>
        <span>{a.approverDisplayName}</span>
        <DateText iso={a.decidedAt} time />
        {a.selfReview && <Badge tone="warning">self</Badge>}
      </div>
      {a.reason && <div className="text-xs text-silver-500">{a.reason}</div>}
      {a.status === 'active' && can('approval.revoke') && (
        <div className="space-y-1">
          {shown && <Alert tone="warning">{c.materials.revokeTakeDown}</Alert>}
          <Field label={c.materials.revokeReason}>
            <TextInput value={reason} onChange={setReason} maxLength={500} />
          </Field>
          <PubErrorAlert error={revoke.error} onReload={onChanged} />
          <ConfirmButton
            loading={revoke.busy}
            disabled={!reason.trim()}
            onConfirm={async () => {
              const r = await revoke.run((k) =>
                apis.content.revokeApproval(a.id, reason.trim(), k)
              );
              if (r) onChanged();
            }}
          >
            {shown ? c.materials.revokeAndTakeDown : c.materials.revokeApproval}
          </ConfirmButton>
        </div>
      )}
    </li>
  );
}

// ── Публикации ───────────────────────────────────────────────────────────

function PublicationsPanel({
  version,
  studio = false,
}: {
  version: VersionView;
  /** Reddit-материал: отметка о публикации — только в студии (§12.5). */
  studio?: boolean;
}) {
  const { can } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const pubs = useAsync(
    async () =>
      (await apis.calendar.publications({ versionId: version.id, limit: 50 }))
        .items,
    [apis, version.id]
  );
  const channels = useAsync(() => apis.calendar.channels(), [apis]);
  const [channelId, setChannelId] = useState('');
  const [finalUrl, setFinalUrl] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const m = useMutation();
  const chName = (id: string) =>
    channels.data?.find((x) => x.id === id)?.title ?? id;
  const ch = channels.data?.find((x) => x.id === channelId);
  return (
    <Section title={c.materials.publications}>
      <Loadable state={pubs}>
        {(items) =>
          items.length ? (
            <ul className="space-y-1 text-sm">
              {items.map((p) => (
                <PublicationRow
                  key={p.id}
                  publication={p}
                  channel={channels.data?.find((x) => x.id === p.channelId)}
                  channelName={chName(p.channelId)}
                  onChanged={pubs.reload}
                />
              ))}
            </ul>
          ) : (
            <EmptyState />
          )
        }
      </Loadable>
      {can('publication.manage') && !studio && (
        <Card className="space-y-2">
          <Field label={c.materials.channel}>
            <select
              className="w-full rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 min-h-[44px] text-sm"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
            >
              <option value="">—</option>
              {(channels.data ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title} ({x.kind})
                </option>
              ))}
            </select>
          </Field>
          {ch && ch.kind !== 'site' && (
            <Field label={c.materials.finalUrl}>
              <TextInput value={finalUrl} onChange={setFinalUrl} type="url" />
            </Field>
          )}
          <label className="text-sm flex items-center gap-2">
            <input
              type="checkbox"
              checked={pending}
              onChange={(e) => setPending(e.target.checked)}
            />
            {c.materials.pending}
          </label>
          <Notice text={notice} />
          <PubErrorAlert error={m.error} />
          <Button
            variant="outline"
            loading={m.busy}
            disabled={
              !channelId ||
              (!!ch && ch.kind !== 'site' && !/^https:\/\//.test(finalUrl))
            }
            onClick={async () => {
              const r = await m.run((k) =>
                apis.calendar.createPublication(
                  {
                    versionId: version.id,
                    channelId,
                    ...(ch && ch.kind !== 'site'
                      ? { finalUrl: finalUrl.trim() }
                      : {}),
                    pending,
                  },
                  k
                )
              );
              if (r) {
                setNotice(c.materials.publicationAdded);
                pubs.reload();
              }
            }}
          >
            {c.materials.addPublication}
          </Button>
        </Card>
      )}
    </Section>
  );
}

/**
 * Строка публикации со сменой статуса (`publication.manage` — PO/OP):
 * переходы — `publicationTargets` (машина сервера), снятие — с причиной и,
 * для канала сайта, с предупреждением о снятии страницы (410). Своя
 * мутация (и ключ попытки) на строку.
 */
function PublicationRow({
  publication: p,
  channel,
  channelName,
  onChanged,
}: {
  publication: PublicationView;
  channel: ChannelView | undefined;
  channelName: string;
  onChanged: () => void;
}) {
  const { can } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const m = useMutation();
  const targets = can('publication.manage') ? publicationTargets(p) : [];
  const move = async (to: PublicationTarget) => {
    const body = publicationTransitionBody(p, to, reason);
    if (!body) return;
    const r = await m.run(
      (k) => apis.calendar.publicationTransition(p.id, body, k),
      JSON.stringify([p.id, body])
    );
    if (r) {
      setOpen(false);
      setReason('');
      onChanged();
    }
  };
  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={p.status} tone={publicationTone(p)} />
        <Badge tone="neutral">{c.materials.stages[p.stage]}</Badge>
        <span>{channelName}</span>
        <ExternalUrl url={p.finalUrl} />
        <span className="text-xs">
          {c.materials.verifyStatus}: <StatusBadge status={p.verifyStatus} />
        </span>
        {targets.length > 0 && (
          <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
            {c.materials.pubActions}
          </Button>
        )}
      </div>
      {open && targets.length > 0 && (
        <div className="space-y-2 pl-2">
          {targets.includes('published') && (
            <div className="text-xs text-silver-500">
              {c.materials.pubPublishedHint}
            </div>
          )}
          <Field label={c.materials.pubReason}>
            <TextInput value={reason} onChange={setReason} maxLength={2000} />
          </Field>
          {withdrawTakesDownPage(channel?.kind) && (
            <Alert tone="warning">{c.materials.pubWithdrawSite}</Alert>
          )}
          <PubErrorAlert error={m.error} onReload={onChanged} />
          <div className="flex flex-wrap gap-2">
            {targets.map((to) =>
              to === 'withdrawn' ? (
                <ConfirmButton
                  key={to}
                  loading={m.busy}
                  disabled={!publicationTransitionBody(p, to, reason)}
                  onConfirm={() => void move(to)}
                >
                  {c.materials.pubTo[to]}
                </ConfirmButton>
              ) : (
                <Button
                  key={to}
                  variant={to === 'published' ? 'solid' : 'outline'}
                  loading={m.busy}
                  onClick={() => void move(to)}
                >
                  {c.materials.pubTo[to]}
                </Button>
              )
            )}
          </div>
        </div>
      )}
    </li>
  );
}

// ── Адаптации F06 ────────────────────────────────────────────────────────

function AdaptationsPanel({ content: x }: { content: ContentView }) {
  const { can, go } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const children = useAsync(
    async () =>
      (await apis.content.contents({ parentContentId: x.id, limit: 50 })).items,
    [apis, x.id]
  );
  const [kind, setKind] = useState<AdaptationKind | ''>('post');
  const [request, setRequest] = useState('');
  const m = useMutation();
  const make = useMutation();
  const createFrom = async (call: AiCallView) => {
    const d = decodeAdaptation(call.output);
    const existing = (children.data ?? []).find((ch) => ch.kind === d.format);
    const target =
      existing ??
      (await make.run((k) =>
        apis.content.createContent({ kind: d.format, parentContentId: x.id }, k)
      ));
    if (!target) return;
    const offers = (await apis.content.offers({ limit: 50 })).items;
    const offer = offers.find((o) => o.status === 'active');
    if (!offer) return;
    const v = await make.run((k) =>
      apis.content.createVersion(
        target.id,
        {
          title: d.title,
          body:
            d.body ??
            d.cards?.map((cd) => `${cd.title}\n${cd.text}`).join('\n\n') ??
            d.scenes?.map((s) => s.voice).join('\n') ??
            d.title,
          meta: {
            cta: d.cta,
            ...(d.cards ? { cards: d.cards } : {}),
            ...(d.scenes ? { scenes: d.scenes } : {}),
            ...(d.preserved_caveats.length
              ? { limitations: d.preserved_caveats }
              : {}),
          },
          sourceIds: d.used_source_ids,
          offerVersionId: offer.id,
          parentVersionId: x.approvedVersionId,
          aiCallId: call.callId,
        },
        k
      )
    );
    if (v) go('materials', target.id);
  };
  return (
    <Section title={c.materials.adaptations}>
      <Loadable state={children}>
        {(items) =>
          items.length ? (
            <ul className="space-y-1">
              {items.map((ch) => (
                <li
                  key={ch.id}
                  className="flex flex-wrap items-center gap-2 text-sm"
                >
                  <RecordLink section="materials" id={ch.id}>
                    {c.materials.kinds[ch.kind]}
                  </RecordLink>
                  <StatusBadge
                    status={ch.status}
                    labels={c.materials.statuses}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState />
          )
        }
      </Loadable>
      {!x.approvedVersionId && (
        <Alert tone="neutral">{c.materials.needApprovedParent}</Alert>
      )}
      {can('version.manage') && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label={c.materials.kind}>
            <Select
              value={kind}
              options={ADAPTATION_KINDS}
              labels={c.materials.kinds}
              onChange={setKind}
            />
          </Field>
          <Button
            variant="outline"
            loading={m.busy}
            disabled={!kind}
            onClick={async () => {
              if (!kind) return;
              const r = await m.run((k) =>
                apis.content.createContent({ kind, parentContentId: x.id }, k)
              );
              if (r) go('materials', r.id);
            }}
          >
            {c.materials.adaptationAdd}
          </Button>
        </div>
      )}
      <PubErrorAlert error={m.error ?? make.error} />
      {can('ai.generate') && kind && (
        <AiRunner
          generator="pub.adaptation.make"
          label={c.materials.aiAdaptation}
          manualHint={c.ai.manualPath}
          disabled={!x.approvedVersionId}
          extraInput={
            <TextInput
              value={request}
              onChange={setRequest}
              placeholder={c.materials.aiAdaptationRequest}
              maxLength={500}
            />
          }
          start={(k) =>
            apis.ai.adaptationDraft(
              x.id,
              {
                format: kind,
                ...(request.trim() ? { request: request.trim() } : {}),
              },
              k
            )
          }
          render={(call) => {
            let d: ReturnType<typeof decodeAdaptation> | null = null;
            try {
              d = decodeAdaptation(call.output);
            } catch {
              d = null;
            }
            if (!d) return <Alert tone="warning">{c.ai.manualPath}</Alert>;
            return (
              <div className="space-y-2 text-sm">
                <div className="font-semibold">{d.title}</div>
                {d.is_script && (
                  <Badge tone="warning">{c.materials.script}</Badge>
                )}
                {d.body && <pre className="whitespace-pre-wrap">{d.body}</pre>}
                <MetaView
                  meta={{
                    cards: d.cards ?? undefined,
                    scenes: d.scenes ?? undefined,
                    cta: d.cta,
                  }}
                />
                {d.unresolved_questions.length > 0 && (
                  <div className="text-xs text-amber-700">
                    {d.unresolved_questions.join('; ')}
                  </div>
                )}
                <Button
                  loading={make.busy}
                  onClick={() => void createFrom(call)}
                >
                  {c.materials.useAdaptation}
                </Button>
              </div>
            );
          }}
        />
      )}
    </Section>
  );
}

// ── История ──────────────────────────────────────────────────────────────

function HistoryPanel({ cid }: { cid: string }) {
  const { product, can } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const audit = useAsync(
    async () =>
      can('audit.read')
        ? (
            await apis.core.audit(product.id, {
              objectType: 'content',
              objectId: cid,
              limit: 30,
            })
          ).items
        : null,
    [apis, product.id, cid]
  );
  return (
    <Section
      title={c.materials.history}
      action={
        can('audit.read') ? (
          <RecordLink
            section="audit"
            query={{ objectType: 'content', objectId: cid }}
          >
            →
          </RecordLink>
        ) : undefined
      }
    >
      {!can('audit.read') ? (
        <NoPermission />
      ) : (
        <Loadable state={audit}>
          {(items) =>
            items && items.length ? (
              <ul className="text-sm space-y-1">
                {items.map((e) => (
                  <li key={e.id}>
                    <DateText iso={e.occurredAt} time /> · {e.action}{' '}
                    {e.fromStatus || e.toStatus
                      ? `${e.fromStatus ?? '∅'} → ${e.toStatus ?? '∅'}`
                      : ''}{' '}
                    <span className="text-xs text-silver-500">
                      {actorLabel(e.actor)}
                    </span>
                    {e.reason ? ` — ${e.reason}` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState />
            )
          }
        </Loadable>
      )}
    </Section>
  );
}
