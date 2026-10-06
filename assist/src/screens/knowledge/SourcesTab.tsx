import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, FileUp, Flame, Link2 } from 'lucide-react';
import { fmt, formatDate, skipReasonText, useAsync, useKit } from '../../kit';
import { Alert, Badge, Button, Card, Spinner } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { uploadWithTicket } from '../../lib/blob-upload';
import {
  sourceUrls,
  type ModeKnowledgeClient,
  type SiteKnowledgeClient,
} from '../../lib/knowledge-api';
import { ClientKnowledgeError } from '../../lib/knowledge-errors';
import {
  DOCUMENT_STATUSES,
  type AssistSettingsView,
  type DocumentStatus,
  type DocumentView,
  type SourceView,
} from '../../lib/knowledge-types';
import {
  DOCUMENT_ACCEPT,
  MAX_URLS_PER_SOURCE,
  checkUpload,
  exclusionForDocument,
  parseUrlList,
  toggleHot,
} from '../../lib/knowledge-view';
import {
  ConfirmButton,
  LoadError,
  NoticeBar,
  textareaClass,
  type Notice,
} from './parts';
import { useErrorText } from '../../lib/use-error-text';

const SOURCE_TONE = {
  pending_upload: 'neutral',
  processing: 'accent',
  active: 'success',
  failed: 'danger',
  disabled: 'neutral',
} as const;

const DOC_TONE = {
  active: 'success',
  gone: 'neutral',
  excluded: 'neutral',
  failed: 'danger',
  skipped: 'warning',
} as const;

/**
 * Источники режима: обход/копия, отдельные адреса, документы, FAQ.
 * Документ — клиентским токеном Blob мимо функции (контракт Э1 §1 п.11).
 * «Сайт» — с подтверждением «этот файл увидят все посетители» (§3.4) и
 * «горячими страницами»; «Админка» — без них.
 */
export function SourcesTab({
  client,
  site,
  settings,
  onSettings,
}: {
  client: ModeKnowledgeClient;
  /** Только режим «Сайт» (горячие страницы). */
  site: SiteKnowledgeClient | null;
  settings: AssistSettingsView | null;
  onSettings: (s: AssistSettingsView) => void;
}) {
  const { dict } = useKit();
  const { appDict } = useAssist();
  const t = appDict.knowledge.sources;
  const errText = useErrorText();
  const sources = useAsync(() => client.sources(), [client]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  async function act(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice({ tone: 'success', text: ok });
      sources.reload();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <NoticeBar notice={notice} />
      <AddUrls client={client} onDone={sources.reload} />
      <AddFile client={client} onDone={sources.reload} />

      {sources.loading && !sources.data ? (
        <Spinner label={dict.common.loading} />
      ) : !sources.data ? (
        <LoadError error={sources.error} onRetry={sources.reload} />
      ) : sources.data.length === 0 ? (
        <Card className="text-sm text-silver-500">{t.empty}</Card>
      ) : (
        <div className="space-y-2">
          {sources.data.map((s) => (
            <SourceRow
              key={s.id}
              s={s}
              busy={busy}
              open={open === s.id}
              onToggleOpen={() => setOpen(open === s.id ? null : s.id)}
              onStatus={(status) =>
                act(s.id, () => client.patchSource(s.id, { status }))
              }
              onDelete={() =>
                act(s.id, () => client.deleteSource(s.id), t.removed)
              }
            >
              {open === s.id && (
                <DocumentsList
                  client={client}
                  sourceId={s.id}
                  site={site}
                  settings={settings}
                  onSettings={onSettings}
                />
              )}
            </SourceRow>
          ))}
        </div>
      )}
    </div>
  );
}

function SourceRow({
  s,
  busy,
  open,
  onToggleOpen,
  onStatus,
  onDelete,
  children,
}: {
  s: SourceView;
  busy: string | null;
  open: boolean;
  onToggleOpen: () => void;
  onStatus: (st: 'active' | 'disabled') => void;
  onDelete: () => void;
  children?: ReactNode;
}) {
  const { locale } = useKit();
  const { appDict } = useAssist();
  const t = appDict.knowledge.sources;
  const urls = s.kind === 'url' ? sourceUrls(s) : [];
  // Обход и копию публичного сайта не удаляют: обход — суть режима,
  // копию выключает переключатель в сводке «Админки». Источник API знаний
  // (Э-С Ш5) управляется ключом интеграции — отзыв ключа и DELETE по API.
  const managedByApi = s.kind === 'api';
  const removable =
    s.kind !== 'crawl' && s.kind !== 'public_copy' && !managedByApi;
  return (
    <Card className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold flex-1 min-w-0 truncate">
          {s.title || s.fileName || t.kind[s.kind]}
        </span>
        <Badge tone={SOURCE_TONE[s.status]}>{t.status[s.status]}</Badge>
      </div>
      <div className="text-silver-500">
        {t.kind[s.kind]} · {fmt(t.docs, { n: s.documentsCount })}
        {s.lastSyncAt &&
          ` · ${fmt(t.synced, { date: formatDate(s.lastSyncAt, locale) })}`}
      </div>
      {urls.length > 0 && (
        <ul className="text-xs font-mono break-all text-silver-500">
          {urls.slice(0, 5).map((u) => (
            <li key={u}>{u}</li>
          ))}
          {urls.length > 5 && <li>… +{urls.length - 5}</li>}
        </ul>
      )}
      {s.error && <Alert tone="danger">{s.error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          icon={open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          onClick={onToggleOpen}
        >
          {open ? t.hideDocs : t.showDocs}
        </Button>
        {!managedByApi &&
          (s.status === 'active' || s.status === 'disabled') && (
            <Button
              variant="outline"
              loading={busy === s.id}
              onClick={() =>
                onStatus(s.status === 'active' ? 'disabled' : 'active')
              }
            >
              {s.status === 'active' ? t.disable : t.enable}
            </Button>
          )}
        {removable && (
          <ConfirmButton
            variant="danger"
            hint={t.removeHint}
            loading={busy === s.id}
            onConfirm={onDelete}
          >
            {t.remove}
          </ConfirmButton>
        )}
      </div>
      {children}
    </Card>
  );
}

function AddUrls({
  client,
  onDone,
}: {
  client: ModeKnowledgeClient;
  onDone: () => void;
}) {
  const { appDict } = useAssist();
  const t = appDict.knowledge.sources;
  const errText = useErrorText();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function submit() {
    const { urls, invalid, tooMany } = parseUrlList(value);
    if (tooMany) {
      setNotice({
        tone: 'warning',
        text: fmt(t.urlsTooMany, { n: MAX_URLS_PER_SOURCE }),
      });
      return;
    }
    if (invalid.length || urls.length === 0) {
      setNotice({
        tone: 'warning',
        text: fmt(t.urlsInvalid, {
          list: invalid.length ? invalid.join(', ') : '—',
        }),
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await client.addUrls(urls);
      setValue('');
      setNotice({ tone: 'success', text: t.urlsAdded });
      onDone();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2 text-sm">
      <div className="font-semibold">{t.addUrls}</div>
      <NoticeBar notice={notice} />
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t.urlsPlaceholder}
        className={`${textareaClass} font-mono`}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        inputMode="url"
      />
      <div className="text-xs text-silver-500">{t.urlsHint}</div>
      <Button
        variant="outline"
        icon={<Link2 size={16} />}
        loading={busy}
        disabled={!value.trim()}
        onClick={submit}
      >
        {t.addUrls}
      </Button>
    </Card>
  );
}

function AddFile({
  client,
  onDone,
}: {
  client: ModeKnowledgeClient;
  onDone: () => void;
}) {
  const { appDict } = useAssist();
  const t = appDict.knowledge.sources;
  const errText = useErrorText();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const isSite = client.mode === 'site';

  async function upload() {
    if (!file) return;
    const check = checkUpload(file);
    if (!check.ok) {
      setNotice({
        tone: 'danger',
        text: errText(new ClientKnowledgeError(check.code)),
      });
      return;
    }
    if (isSite && !confirmed) {
      setNotice({ tone: 'warning', text: t.confirmPublicRequired });
      return;
    }
    setNotice(null);
    setPct(0);
    try {
      const created = await client.addFile({
        fileName: file.name,
        mimeType: check.mimeType,
        bytes: file.size,
        ...(isSite ? { confirmPublic: true as const } : {}),
      });
      if (!created.upload) throw new ClientKnowledgeError('UPLOAD_FAILED');
      await uploadWithTicket(created.upload, file, { onProgress: setPct });
      await client.uploaded(created.source.id);
      setFile(null);
      setConfirmed(false);
      if (input.current) input.current.value = '';
      setNotice({ tone: 'success', text: t.uploaded });
      onDone();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
      // Источник мог остаться в pending_upload — список покажет его.
      onDone();
    } finally {
      setPct(null);
    }
  }

  return (
    <Card className="space-y-2 text-sm">
      <div className="font-semibold">{t.addFile}</div>
      <NoticeBar notice={notice} />
      <input
        ref={input}
        type="file"
        accept={DOCUMENT_ACCEPT}
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="block w-full text-sm"
        aria-label={t.chooseFile}
      />
      <div className="text-xs text-silver-500">
        {t.fileHint} {isSite ? '' : t.adminFileHint}
      </div>
      {isSite && (
        <label className="flex gap-2 items-start">
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>{t.confirmPublic}</span>
        </label>
      )}
      <Button
        variant="outline"
        icon={<FileUp size={16} />}
        loading={pct !== null}
        disabled={!file || (isSite && !confirmed)}
        onClick={upload}
      >
        {pct !== null ? fmt(t.uploading, { pct }) : t.addFile}
      </Button>
    </Card>
  );
}

function DocumentsList({
  client,
  sourceId,
  site,
  settings,
  onSettings,
}: {
  client: ModeKnowledgeClient;
  sourceId: string;
  site: SiteKnowledgeClient | null;
  settings: AssistSettingsView | null;
  onSettings: (s: AssistSettingsView) => void;
}) {
  const { dict } = useKit();
  const { appDict } = useAssist();
  const t = appDict.knowledge.documents;
  const errText = useErrorText();
  const [status, setStatus] = useState<DocumentStatus | ''>('');
  const [extra, setExtra] = useState<DocumentView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const first = useAsync(
    () => client.documents({ sourceId, status: status || undefined }),
    [client, sourceId, status]
  );
  // Новая первая страница (фильтр, перезагрузка) — «ещё» начинается заново.
  useEffect(() => {
    setExtra([]);
    setCursor(first.data?.nextCursor ?? null);
  }, [first.data]);

  async function more() {
    if (!cursor) return;
    setBusy('more');
    try {
      const p = await client.documents({
        sourceId,
        status: status || undefined,
        cursor,
      });
      setExtra((x) => [...x, ...p.items]);
      setCursor(p.nextCursor);
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  async function exclude(d: DocumentView) {
    setBusy(d.id);
    setNotice(null);
    try {
      await client.addExclusion(exclusionForDocument(d));
      setNotice({ tone: 'success', text: t.excluded });
      first.reload();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  async function hot(d: DocumentView, on: boolean) {
    if (!site || !settings || !d.url) return;
    const next = toggleHot(settings.hotPages, d.url, on);
    if (!next.ok) {
      setNotice({ tone: 'warning', text: appDict.errors[next.code] });
      return;
    }
    setBusy(d.id);
    setNotice(null);
    try {
      onSettings(await site.setHotPages(next.urls));
      first.reload();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  const docs = [...(first.data?.items ?? []), ...extra];
  const hotPages = settings?.hotPages ?? [];

  return (
    <div className="space-y-2 border-t border-silver-200 dark:border-silver-800 pt-2">
      <NoticeBar notice={notice} />
      <select
        value={status}
        onChange={(e) => setStatus(e.target.value as DocumentStatus | '')}
        className="rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-2 py-1 min-h-[36px]"
      >
        <option value="">{t.all}</option>
        {DOCUMENT_STATUSES.map((s) => (
          <option key={s} value={s}>
            {t.status[s]}
          </option>
        ))}
      </select>
      {site && <div className="text-xs text-silver-500">{t.hotHint}</div>}
      {first.loading && !first.data ? (
        <Spinner label={dict.common.loading} />
      ) : !first.data ? (
        <LoadError error={first.error} onRetry={first.reload} />
      ) : docs.length === 0 ? (
        <div className="text-silver-500">{t.empty}</div>
      ) : (
        <ul className="space-y-2">
          {docs.map((d) => {
            const isHot = d.hot || (!!d.url && hotPages.includes(d.url));
            return (
              <li key={d.id} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex-1 min-w-0 truncate">
                    {d.url ? (
                      <a
                        href={d.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline"
                      >
                        {d.title || d.url}
                      </a>
                    ) : (
                      d.title || d.id
                    )}
                  </span>
                  {isHot && (
                    <Badge tone="warning">
                      <Flame size={12} />
                      {t.hot}
                    </Badge>
                  )}
                  <Badge tone={DOC_TONE[d.status]}>{t.status[d.status]}</Badge>
                </div>
                <div className="text-xs text-silver-500">
                  {d.lang ? `${d.lang} · ` : ''}
                  {fmt(t.chunks, { n: d.chunks })}
                  {d.skipReason && ` · ${skipReasonText(d.skipReason, dict)}`}
                </div>
                <div className="flex flex-wrap gap-2">
                  {site && settings && d.url && d.kind === 'page' && (
                    <Button
                      variant="ghost"
                      loading={busy === d.id}
                      onClick={() => hot(d, !isHot)}
                    >
                      {isHot ? t.unHot : t.makeHot}
                    </Button>
                  )}
                  {d.status !== 'excluded' && (
                    <ConfirmButton
                      variant="ghost"
                      hint={t.excludeHint}
                      loading={busy === d.id}
                      onConfirm={() => exclude(d)}
                    >
                      {t.exclude}
                    </ConfirmButton>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {cursor && (
        <Button variant="ghost" loading={busy === 'more'} onClick={more}>
          {t.more}
        </Button>
      )}
    </div>
  );
}
