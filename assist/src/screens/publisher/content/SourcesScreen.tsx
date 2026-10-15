import { useState } from 'react';
import { useAsync } from '../../../kit';
import { Alert, Badge, Button } from '../../../kit/ui';
import type { SourceView } from '../../../lib/publisher/content-api';
import {
  SOURCE_KINDS,
  SOURCE_USAGES,
  SOURCE_VISIBILITIES,
  type SourceKind,
  type SourceVisibility,
} from '../../../lib/publisher/states';
import { sourceBody } from '../../../lib/publisher/brand-view';
import { actorLabel, fmtText } from '../../../lib/publisher/view';
import {
  useListFilters,
  useMutation,
  usePubApis,
  usePubContent,
} from '../hooks';
import {
  ConfirmButton,
  DateText,
  EmptyState,
  ExternalUrl,
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

/**
 * Источники (§14.1 SourcesScreen; F01–F04 вход): список с фильтрами и
 * выгрузкой, ручной ввод разрешённого текста, импорт URL (ошибки
 * `PUB_IMPORT_BLOCKED` человеческим текстом), «разрешить» (restricted →
 * allowed), отзыв с подтверждением и числом открытых задач проверки,
 * предпросмотр AI-контекста.
 */
export function SourcesScreen({ query }: PublisherSectionProps) {
  const { product, can } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const f = useListFilters('sources', query, ['usage', 'kind', 'visibility']);
  const q = {
    usage: f.values.usage || undefined,
    kind: f.values.kind || undefined,
    visibility: f.values.visibility || undefined,
  };
  const [extra, setExtra] = useState<SourceView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const list = useAsync(async () => {
    const page = await apis.content.sources({ ...q, limit: 50 });
    setExtra([]);
    setNext(page.nextBefore);
    return page.items;
  }, [apis, product.id, q.usage, q.kind, q.visibility]);

  return (
    <div className="space-y-4">
      <Alert tone="neutral" title={c.sources.title}>
        {c.sources.hint}
      </Alert>
      {can('source.manage') ? (
        <div className="grid gap-4 md:grid-cols-2">
          <ManualSource onDone={list.reload} />
          <ImportSource onDone={list.reload} />
        </div>
      ) : (
        <NoPermission />
      )}
      <Section title={c.sources.title}>
        <ListToolbar
          statuses={SOURCE_USAGES}
          status={f.values.usage}
          onStatus={(v) => f.set('usage', v)}
          statusLabels={c.sources.usages}
          csvPath={`products/${product.id}/sources`}
          csvQuery={q}
          extra={
            <>
              <Field label={c.sources.kind}>
                <Select
                  value={f.values.kind as SourceKind | ''}
                  options={SOURCE_KINDS}
                  labels={c.sources.kinds}
                  empty="—"
                  onChange={(v) => f.set('kind', v)}
                />
              </Field>
              <Field label={c.sources.visibility}>
                <Select
                  value={f.values.visibility as SourceVisibility | ''}
                  options={SOURCE_VISIBILITIES}
                  labels={c.sources.visibilities}
                  empty="—"
                  onChange={(v) => f.set('visibility', v)}
                />
              </Field>
            </>
          }
        />
        <Loadable state={list}>
          {(items) =>
            items.length + extra.length ? (
              <ul className="divide-y divide-silver-200 dark:divide-silver-800">
                {[...items, ...extra].map((s) => (
                  <SourceRow key={s.id} source={s} onChanged={list.reload} />
                ))}
                <LoadMore
                  next={next}
                  onMore={async (before) => {
                    const page = await apis.content.sources({
                      ...q,
                      before,
                      limit: 50,
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
      {can('source.manage') && <ContextPreviewCard />}
    </div>
  );
}

function SourceRow({
  source: s,
  onChanged,
}: {
  source: SourceView;
  onChanged: () => void;
}) {
  const { can, href, t } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [revokedTasks, setRevokedTasks] = useState<number | null>(null);
  const allow = useMutation();
  const revoke = useMutation();
  return (
    <li className="py-3 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium flex-1 min-w-0 break-words">
          {s.title ?? s.url ?? s.id}
        </span>
        <StatusBadge status={s.usage} labels={c.sources.usages} />
        <Badge tone="neutral">{c.sources.kinds[s.kind]}</Badge>
        <Badge tone="neutral">{c.sources.visibilities[s.visibility]}</Badge>
        <StatusBadge status={s.freshness} labels={c.sources.freshness} />
        {s.isSynthetic && <Badge tone="warning">{c.sources.synthetic}</Badge>}
      </div>
      {s.url && <ExternalUrl url={s.url} />}
      <div className="text-sm text-silver-700 dark:text-silver-300 line-clamp-3 whitespace-pre-wrap">
        {s.fragment}
      </div>
      <div className="text-xs text-silver-500">
        {c.sources.via[s.importedVia]} ·{' '}
        {actorLabel(s.createdBy, t.common.adminActor)} ·{' '}
        <DateText iso={s.createdAt} />
        {s.supersedesId && (
          <>
            {' '}
            · ← <code className="break-all">{s.supersedesId}</code>
          </>
        )}
      </div>
      {s.locked && (
        <div className="text-xs text-amber-700">{c.sources.locked}</div>
      )}
      {s.injectionFlag && (
        <Alert tone="warning">
          {fmtText(c.sources.injection, { flag: s.injectionFlag })}
        </Alert>
      )}
      {s.revokedAt && (
        <div className="text-xs text-rose-600">
          {c.sources.usages.revoked}: <DateText iso={s.revokedAt} />{' '}
          {s.revokeReason ? `— ${s.revokeReason}` : ''}
        </div>
      )}
      <Notice text={notice} />
      {can('source.manage') && s.usage !== 'revoked' && (
        <div className="flex flex-wrap items-center gap-2">
          {s.usage === 'restricted' && (
            <Button
              variant="outline"
              loading={allow.busy}
              onClick={async () => {
                const r = await allow.run((k) =>
                  apis.content.patchSource(
                    s.id,
                    { usage: 'allowed', expectedRevision: s.revision },
                    k
                  )
                );
                if (r) {
                  setNotice(c.sources.allowed);
                  onChanged();
                }
              }}
            >
              {c.sources.allow}
            </Button>
          )}
          <TextInput
            value={reason}
            onChange={setReason}
            placeholder={c.sources.revokeReason}
            maxLength={500}
          />
          <ConfirmButton
            loading={revoke.busy}
            disabled={!reason.trim()}
            onConfirm={async () => {
              const r = await revoke.run((k) =>
                apis.content.revokeSource(s.id, reason.trim(), k)
              );
              if (r) {
                setNotice(fmtText(c.sources.revoked, { n: r.tasksOpened }));
                setRevokedTasks(r.tasksOpened);
                onChanged();
              }
            }}
          >
            {c.sources.revoke}
          </ConfirmButton>
        </div>
      )}
      {can('source.manage') && s.usage !== 'revoked' && (
        <div className="text-xs text-silver-500">{c.sources.revokeHint}</div>
      )}
      <PubErrorAlert error={allow.error ?? revoke.error} onReload={onChanged} />
      {revokedTasks !== null && revokedTasks > 0 && (
        <a href={href(null)} className="text-xs text-accent hover:underline">
          {c.sources.toTasks}
        </a>
      )}
    </li>
  );
}

function ManualSource({ onDone }: { onDone: () => void }) {
  const c = usePubContent();
  const { t } = usePublisher();
  const apis = usePubApis();
  const [kind, setKind] = useState<SourceKind | ''>('manual_text');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [author, setAuthor] = useState('');
  const [publishedOn, setPublishedOn] = useState('');
  const [fragment, setFragment] = useState('');
  const [language, setLanguage] = useState('uk');
  const [visibility, setVisibility] = useState<SourceVisibility | ''>(
    'private'
  );
  const [usage, setUsage] = useState<'allowed' | 'restricted' | ''>('allowed');
  const [notice, setNotice] = useState<string | null>(null);
  const m = useMutation();
  const body = sourceBody({
    kind,
    title,
    url,
    author,
    publishedOn,
    fragment,
    language,
    visibility,
    usage,
  });
  return (
    <Section title={c.sources.add}>
      <Field label={c.sources.kind}>
        <Select
          value={kind}
          options={SOURCE_KINDS}
          labels={c.sources.kinds}
          onChange={setKind}
        />
      </Field>
      <Field label={c.sources.fields.title}>
        <TextInput value={title} onChange={setTitle} maxLength={300} />
      </Field>
      <Field label={c.sources.fields.url}>
        <TextInput value={url} onChange={setUrl} type="url" />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={c.sources.fields.author}>
          <TextInput value={author} onChange={setAuthor} maxLength={200} />
        </Field>
        <Field label={c.sources.fields.publishedOn}>
          <TextInput
            value={publishedOn}
            onChange={setPublishedOn}
            type="date"
          />
        </Field>
      </div>
      <Field label={c.sources.fields.fragment}>
        <TextArea value={fragment} onChange={setFragment} rows={5} />
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label={c.sources.fields.language}>
          <TextInput value={language} onChange={setLanguage} maxLength={8} />
        </Field>
        <Field label={c.sources.visibility}>
          <Select
            value={visibility}
            options={SOURCE_VISIBILITIES}
            labels={c.sources.visibilities}
            onChange={setVisibility}
          />
        </Field>
        <Field label={c.sources.usage}>
          <Select
            value={usage}
            options={['allowed', 'restricted'] as const}
            labels={c.sources.usages}
            onChange={setUsage}
          />
        </Field>
      </div>
      <Notice text={notice} />
      <PubErrorAlert error={m.error} />
      <Button
        loading={m.busy}
        disabled={!body}
        onClick={async () => {
          if (!body) return;
          const r = await m.run((k) => apis.content.createSource(body, k));
          if (r) {
            setNotice(c.sources.created);
            setTitle('');
            setUrl('');
            setFragment('');
            onDone();
          }
        }}
      >
        {t.common.add}
      </Button>
    </Section>
  );
}

function ImportSource({ onDone }: { onDone: () => void }) {
  const c = usePubContent();
  const apis = usePubApis();
  const [url, setUrl] = useState('');
  const [visibility, setVisibility] = useState<SourceVisibility | ''>('public');
  const [notice, setNotice] = useState<string | null>(null);
  const m = useMutation();
  return (
    <Section title={c.sources.import}>
      <p className="text-xs text-silver-500">{c.sources.importHint}</p>
      <Field label={c.sources.fields.url}>
        <TextInput value={url} onChange={setUrl} type="url" />
      </Field>
      <Field label={c.sources.visibility}>
        <Select
          value={visibility}
          options={SOURCE_VISIBILITIES}
          labels={c.sources.visibilities}
          onChange={setVisibility}
        />
      </Field>
      <Notice text={notice} />
      <PubErrorAlert error={m.error} />
      <Button
        loading={m.busy}
        disabled={!/^https:\/\//i.test(url.trim()) || !visibility}
        onClick={async () => {
          if (!visibility) return;
          const r = await m.run((k) =>
            apis.content.importUrl({ url: url.trim(), visibility }, k)
          );
          if (r) {
            setNotice(c.sources.imported);
            setUrl('');
            onDone();
          }
        }}
      >
        {c.sources.import}
      </Button>
    </Section>
  );
}

/** «Что увидит AI» (AT-F02-01, AT-CORE-21): id и заголовки, исключённое. */
function ContextPreviewCard() {
  const c = usePubContent();
  const apis = usePubApis();
  const [audience, setAudience] = useState<'internal' | 'public' | ''>(
    'internal'
  );
  const [shown, setShown] = useState(false);
  const preview = useAsync(
    async () =>
      shown && audience
        ? apis.content.contextPreview({ purpose: 'helper', audience })
        : null,
    [apis, shown, audience]
  );
  return (
    <Section
      title={c.sources.contextTitle}
      action={
        <Button variant="outline" onClick={() => setShown(true)}>
          {c.sources.contextShow}
        </Button>
      }
    >
      <p className="text-xs text-silver-500">{c.sources.contextHint}</p>
      <Select
        value={audience}
        options={['internal', 'public'] as const}
        labels={c.sources.contextAudience}
        onChange={setAudience}
        ariaLabel={c.sources.contextTitle}
      />
      {shown && (
        <Loadable state={preview}>
          {(p) =>
            p ? (
              <div className="space-y-2 text-sm">
                <div>
                  <div className="text-xs text-silver-500">
                    {c.sources.contextSources}
                  </div>
                  <ul className="list-disc pl-5">
                    {p.sources.map((s) => (
                      <li key={s.id}>
                        {s.title ?? s.id}{' '}
                        <span className="text-xs text-silver-500">
                          ({c.sources.visibilities[s.visibility]})
                        </span>
                        {s.injectionFlag && (
                          <Badge tone="warning">{s.injectionFlag}</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="text-xs text-silver-500">
                    {c.sources.contextFacts}
                  </div>
                  <ul className="list-disc pl-5">
                    {p.facts.map((f) => (
                      <li key={f.id}>
                        {f.factKey} (v{f.version})
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  {c.sources.contextOffer}:{' '}
                  {p.offer ? `${p.offer.title} (v${p.offer.version})` : '—'}
                </div>
                {p.forbiddenPromises.length > 0 && (
                  <div>
                    {c.sources.contextForbidden}:{' '}
                    {p.forbiddenPromises.map((f) => f.factKey).join(', ')}
                  </div>
                )}
                <div className="text-xs text-silver-500">
                  {fmtText(c.sources.contextExcluded, p.excluded)}
                </div>
              </div>
            ) : null
          }
        </Loadable>
      )}
    </Section>
  );
}
