import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, ShieldAlert } from 'lucide-react';
import {
  ApiError,
  crawlActive,
  fmt,
  formatDate,
  skipReasonText,
  sortedSkips,
  useAsync,
  useKit,
  type CrawlRunView,
} from '../../kit';
import { Alert, Badge, Button, Card, Spinner } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import type {
  AdminKnowledgeClient,
  SiteKnowledgeClient,
} from '../../lib/knowledge-api';
import {
  RECRAWL_EVERY,
  type AdminKnowledgeSettings,
  type AssistSettingsView,
  type KnowledgeMode,
  type RecrawlEvery,
} from '../../lib/knowledge-types';
import {
  budgetShare,
  formatUsd,
  langShares,
  setPendingQuestion,
  type KnowledgeTab,
} from '../../lib/knowledge-view';
import { navigate } from '../../lib/router';
import { LoadError, NoticeBar, type Notice } from './parts';
import { useErrorText } from '../../lib/use-error-text';

/** Опрос сводки, пока идёт обход: прогон видно без «обновите страницу». */
const CRAWL_POLL_MS = 5000;

/**
 * Сводка (ТЗ §3.4): «прочитано N страниц, M пропущено (почему —
 * списком), K фрагментов, языки», 5 вопросов «проверить ответ»,
 * удержанная версия и карантин — наверху, бюджет обучения. «Админка» —
 * плюс переключатель копии публичного обхода (§4.3-бис, Р-19).
 */
export function OverviewTab({
  mode,
  siteId,
  site,
  admin,
  settings,
  onSettings,
  hasVerifiedHost,
  onOpenTab,
  onNeedEnable,
}: {
  mode: KnowledgeMode;
  siteId: string;
  site: SiteKnowledgeClient;
  admin: AdminKnowledgeClient;
  settings: AssistSettingsView | null;
  onSettings: (s: AssistSettingsView) => void;
  hasVerifiedHost: boolean;
  onOpenTab: (t: KnowledgeTab) => void;
  onNeedEnable?: () => void;
}) {
  const { dict, locale } = useKit();
  const { appDict } = useAssist();
  const t = appDict.knowledge.overview;
  const errText = useErrorText();
  const client = mode === 'site' ? site : admin;
  const summary = useAsync(() => client.summary(), [client]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const running = crawlActive(summary.data?.lastCrawl ?? null);
  const reload = summary.reload;
  useEffect(() => {
    if (!running) return;
    const h = setTimeout(reload, CRAWL_POLL_MS);
    return () => clearTimeout(h);
  }, [running, reload, summary.data]);

  const notEnabled =
    summary.error instanceof ApiError &&
    summary.error.code === 'ASSIST_NOT_ENABLED';
  useEffect(() => {
    if (notEnabled) onNeedEnable?.();
  }, [notEnabled, onNeedEnable]);

  if (summary.loading && !summary.data) {
    return <Spinner label={dict.common.loading} />;
  }
  if (!summary.data) {
    return <LoadError error={summary.error} onRetry={summary.reload} />;
  }
  const s = summary.data;
  const skips = sortedSkips(s.pages.skippedByReason);
  const langs = langShares(s.langs);
  const share = budgetShare(s.learningBudget);

  async function recrawl() {
    setBusy('recrawl');
    setNotice(null);
    try {
      await site.recrawl();
      setNotice({ tone: 'success', text: t.recrawlStarted });
      summary.reload();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  async function setEvery(every: RecrawlEvery) {
    setBusy('every');
    setNotice(null);
    try {
      onSettings(await site.setRecrawlEvery(every));
      setNotice({ tone: 'success', text: appDict.knowledge.saved });
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <NoticeBar notice={notice} />

      {s.heldVersion && (
        <Alert tone="warning" title={fmt(t.held, { n: s.heldVersion.number })}>
          <Button
            variant="outline"
            className="mt-2"
            icon={<AlertTriangle size={16} />}
            onClick={() => onOpenTab('versions')}
          >
            {t.heldOpen}
          </Button>
        </Alert>
      )}
      {s.quarantineCount > 0 && (
        <Alert
          tone="danger"
          title={fmt(t.quarantine, { n: s.quarantineCount })}
        >
          <Button
            variant="outline"
            className="mt-2"
            icon={<ShieldAlert size={16} />}
            onClick={() => onOpenTab('quarantine')}
          >
            {t.quarantineOpen}
          </Button>
        </Alert>
      )}

      <Card className="space-y-2 text-sm">
        <div className="font-semibold">
          {s.publishedVersion > 0
            ? fmt(t.published, { n: s.publishedVersion })
            : t.noVersion}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <span>{fmt(t.pagesRead, { n: s.pages.read })}</span>
          <span>{fmt(t.pagesSkipped, { n: s.pages.skipped })}</span>
          <span>{fmt(t.documents, { n: s.documents })}</span>
          <span>{fmt(t.chunks, { n: s.chunks })}</span>
        </div>
        {langs.length > 0 && (
          <div className="text-silver-500">
            {t.langs}: {langs.map((l) => `${l.lang} ${l.pct}%`).join(' · ')}
          </div>
        )}
        {skips.length > 0 && (
          <details className="pt-1">
            <summary className="cursor-pointer text-silver-500">
              {t.skippedWhy}
            </summary>
            <ul className="mt-1 space-y-0.5">
              {skips.map(({ reason, n }) => (
                <li key={reason} className="flex justify-between gap-2">
                  <span>{skipReasonText(reason, dict)}</span>
                  <span className="tabular-nums text-silver-500">{n}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      <CrawlCard run={s.lastCrawl}>
        {mode === 'site' && (
          <div className="space-y-2 pt-2">
            {!hasVerifiedHost ? (
              <Alert tone="warning">
                {t.needVerified}
                <div className="mt-2">
                  <Button
                    variant="outline"
                    onClick={() => navigate({ name: 'site', siteId })}
                  >
                    {t.toSite}
                  </Button>
                </div>
              </Alert>
            ) : (
              <Button
                variant="outline"
                icon={<RefreshCw size={16} />}
                loading={busy === 'recrawl'}
                disabled={running}
                onClick={recrawl}
              >
                {t.recrawl}
              </Button>
            )}
            {settings && (
              <label className="flex flex-wrap items-center gap-2">
                <span>{t.recrawlEvery}</span>
                <select
                  value={settings.recrawlEvery}
                  disabled={busy === 'every'}
                  onChange={(e) => setEvery(e.target.value as RecrawlEvery)}
                  className="rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-2 py-1 min-h-[36px]"
                >
                  {RECRAWL_EVERY.map((v) => (
                    <option key={v} value={v}>
                      {t.every[v]}
                    </option>
                  ))}
                </select>
                {settings.nextCrawlAt && (
                  <span className="text-silver-500">
                    {fmt(t.nextCrawl, {
                      date: formatDate(settings.nextCrawlAt, locale),
                    })}
                  </span>
                )}
              </label>
            )}
          </div>
        )}
      </CrawlCard>

      {mode === 'site' && s.suggestedQuestions.length > 0 && (
        <Card className="space-y-2 text-sm">
          <div className="font-semibold">{t.suggested}</div>
          <ul className="space-y-2">
            {s.suggestedQuestions.map((q) => (
              <li key={q} className="flex items-center gap-2">
                <span className="flex-1 min-w-0">{q}</span>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setPendingQuestion(q);
                    navigate({ name: 'sandbox', siteId });
                  }}
                >
                  {t.check}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {mode === 'admin' && (
        <AdminCopySettings admin={admin} initial={s.settings ?? null} />
      )}

      <Card className="space-y-2 text-sm">
        <div className="font-semibold">
          {fmt(t.budget, { period: s.learningBudget.period })}
        </div>
        <div
          className="h-2 rounded-full bg-silver-200 dark:bg-silver-800 overflow-hidden"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share * 100)}
        >
          <div
            className={`h-full ${share >= 1 ? 'bg-rose-500' : 'bg-accent'}`}
            style={{ width: `${Math.round(share * 100)}%` }}
          />
        </div>
        <div className="text-silver-500">
          {fmt(t.budgetLine, {
            spent: formatUsd(s.learningBudget.spentMicroUsd),
            cap: formatUsd(s.learningBudget.capMicroUsd),
          })}
        </div>
        {share >= 1 && <Alert tone="warning">{t.budgetOut}</Alert>}
      </Card>
    </div>
  );
}

function CrawlCard({
  run,
  children,
}: {
  run: CrawlRunView | null;
  children?: ReactNode;
}) {
  const { dict, locale } = useKit();
  const { appDict } = useAssist();
  const t = appDict.knowledge.overview;
  const tone =
    run?.status === 'done'
      ? 'success'
      : run?.status === 'failed'
        ? 'danger'
        : run
          ? 'accent'
          : 'neutral';
  return (
    <Card className="space-y-1 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-semibold flex-1">{t.lastCrawl}</span>
        {run && <Badge tone={tone}>{dict.crawl.status[run.status]}</Badge>}
      </div>
      {run ? (
        <>
          <div className="text-silver-500">
            {fmt(t.crawlStats, {
              seen: run.pagesSeen,
              changed: run.pagesChanged,
              unchanged: run.pagesUnchanged,
              skipped: run.pagesSkipped,
              failed: run.pagesFailed,
              gone: run.pagesGone,
            })}
          </div>
          {(run.finishedAt || run.startedAt) && (
            <div className="text-silver-500">
              {formatDate(run.finishedAt ?? run.startedAt, locale)}
            </div>
          )}
          {run.error && <div className="text-rose-500">{run.error}</div>}
        </>
      ) : (
        <div className="text-silver-500">{t.noCrawl}</div>
      )}
      {children}
    </Card>
  );
}

/** Переключатель копии публичного обхода в «Админку» (только владелец «Админки»). */
function AdminCopySettings({
  admin,
  initial,
}: {
  admin: AdminKnowledgeClient;
  initial: AdminKnowledgeSettings | null;
}) {
  const { dict } = useKit();
  const { appDict } = useAssist();
  const t = appDict.knowledge.overview;
  const errText = useErrorText();
  const loaded = useAsync(
    () => (initial ? Promise.resolve(initial) : admin.settings()),
    [admin, initial]
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  if (loaded.loading && !loaded.data) {
    return <Spinner label={dict.common.loading} />;
  }
  if (!loaded.data) {
    return <LoadError error={loaded.error} onRetry={loaded.reload} />;
  }
  const v = loaded.data;

  async function save(patch: Partial<AdminKnowledgeSettings>) {
    setBusy(true);
    setNotice(null);
    try {
      loaded.setData(await admin.updateSettings(patch));
      setNotice({ tone: 'success', text: appDict.knowledge.saved });
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 text-sm">
      <div className="font-semibold">{t.copyTitle}</div>
      <NoticeBar notice={notice} />
      <label className="flex gap-3 items-start">
        <input
          type="checkbox"
          className="mt-1 h-5 w-5"
          checked={v.includePublicInAdmin}
          disabled={busy}
          onChange={(e) => save({ includePublicInAdmin: e.target.checked })}
        />
        <span>
          <span className="font-medium">{t.copyPublic}</span>
          <span className="block text-silver-500">{t.copyPublicHint}</span>
        </span>
      </label>
      <label className="flex gap-3 items-start">
        <input
          type="checkbox"
          className="mt-1 h-5 w-5"
          checked={v.includeUgcInAdmin}
          disabled={busy || !v.includePublicInAdmin}
          onChange={(e) => save({ includeUgcInAdmin: e.target.checked })}
        />
        <span>
          <span className="font-medium">{t.copyUgc}</span>
          <span className="block text-silver-500">{t.copyUgcHint}</span>
        </span>
      </label>
    </Card>
  );
}
