import { useEffect, useState, type ReactNode } from 'react';
import { Download } from 'lucide-react';
import { fmt, useAsync, useKit } from '../../kit';
import {
  Alert,
  Button,
  Card,
  ScreenTitle,
  Spinner,
  Tabs,
  inputClass,
} from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import {
  PERIOD_PRESETS,
  STATS_TABS,
  canManageSecrets,
  canSeeStats,
  delta,
  pct,
  periodOf,
  usd,
  type PeriodPreset,
  type StatsTab,
} from '../../lib/e3-view';
import { navigate } from '../../lib/router';
import {
  EXPORT_KINDS,
  type AnalyticsSettingsView,
  type ExportKind,
  type ExportView,
  type MetricView,
  type ReportSubscriptionView,
  type StatsPeriod,
} from '../../lib/stats-types';
import { useE3ErrorNotice, useE3ErrorText } from '../../lib/use-error-text';
import { LoadError, NoticeBar, type Notice } from '../knowledge/parts';
import { Field, NumberInput, Select, Toggle } from '../widget/controls';
import { ManagerOnly, MasksInput, MiniTable } from './parts';
import {
  AiTab,
  BehaviorTab,
  ExperimentsTab,
  InsightsTab,
} from './AiAnalyticsScreens';

function PeriodPicker({
  value,
  onChange,
}: {
  value: PeriodPreset;
  onChange: (p: PeriodPreset) => void;
}) {
  const { appDict } = useAssist();
  return (
    <div className="flex gap-1" role="group">
      {PERIOD_PRESETS.map((p) => (
        <Button
          key={p}
          variant={p === value ? 'solid' : 'outline'}
          onClick={() => onChange(p)}
        >
          {fmt(appDict.e3.stats.days, { n: p })}
        </Button>
      ))}
    </div>
  );
}

function Metric({
  label,
  m,
  format = (n) => String(n),
}: {
  label: string;
  m: MetricView;
  format?: (n: number) => string;
}) {
  const { appDict } = useAssist();
  const d = delta(m);
  return (
    <Card className="space-y-0.5">
      <div className="text-xs text-silver-500">{label}</div>
      <div className="text-xl font-semibold">{format(m.value)}</div>
      {d && (
        <div
          className={`text-xs ${
            m.noise
              ? 'text-silver-500'
              : d.tone === 'up'
                ? 'text-green-600'
                : d.tone === 'down'
                  ? 'text-red-600'
                  : 'text-silver-500'
          }`}
        >
          {d.text}
          {m.noise && ` · ${appDict.e3.stats.noise}`}
        </div>
      )}
    </Card>
  );
}

function PeriodNote({ p }: { p: StatsPeriod }) {
  const { appDict } = useAssist();
  const t = appDict.e3.stats;
  return (
    <div className="text-xs text-silver-500 space-y-0.5">
      <div>{fmt(t.timezone, { tz: p.timezone })}</div>
      {p.attributionWindowOpenFrom && <div>{t.windowOpen}</div>}
    </div>
  );
}

function Loaded<T>({
  state,
  children,
}: {
  state: {
    data: T | null;
    loading: boolean;
    error: unknown;
    reload: () => void;
  };
  children: (d: T) => ReactNode;
}) {
  const { dict } = useKit();
  if (state.loading && !state.data)
    return <Spinner label={dict.common.loading} />;
  if (!state.data)
    return <LoadError error={state.error} onRetry={state.reload} />;
  return <>{children(state.data)}</>;
}

/** Статистика сайта (§5-тер.6): обзор, конверсии, темы + экспорт и отчёты. */
export function StatsScreen({
  siteId,
  tab,
}: {
  siteId: string;
  tab: StatsTab;
}) {
  const { account } = useKit();
  const { appDict } = useAssist();
  const t = appDict.e3.stats;
  const [preset, setPreset] = useState<PeriodPreset>(30);
  if (!canSeeStats(account.me)) {
    return (
      <div className="space-y-4">
        <ScreenTitle>{t.title}</ScreenTitle>
        <Alert tone="warning">{t.operatorNote}</Alert>
        <Button
          variant="outline"
          onClick={() => navigate({ name: 'dialogs', siteId })}
        >
          {appDict.e3.site.dialogs}
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      <Tabs
        label={t.title}
        active={tab}
        onChange={(k) => navigate({ name: 'stats', siteId, tab: k }, true)}
        tabs={STATS_TABS.map((k) => ({
          key: k,
          label:
            k in t.tabs
              ? t.tabs[k as keyof typeof t.tabs]
              : appDict.e3b.tabs[k as keyof typeof appDict.e3b.tabs],
        }))}
      />
      {tab !== 'insights' && tab !== 'experiments' && (
        <PeriodPicker value={preset} onChange={setPreset} />
      )}
      {tab === 'ai' && <AiTab siteId={siteId} preset={preset} />}
      {tab === 'insights' && <InsightsTab siteId={siteId} />}
      {tab === 'experiments' && <ExperimentsTab siteId={siteId} />}
      {tab === 'behavior' && <BehaviorTab siteId={siteId} preset={preset} />}
      {tab === 'overview' && <Overview siteId={siteId} preset={preset} />}
      {tab === 'conversions' && <Conversions siteId={siteId} preset={preset} />}
      {tab === 'topics' && <Topics siteId={siteId} preset={preset} />}
      {tab === 'overview' && (
        <>
          <Exports siteId={siteId} preset={preset} />
          <Subscription siteId={siteId} />
          <AnalyticsSettings siteId={siteId} />
        </>
      )}
    </div>
  );
}

function Overview({
  siteId,
  preset,
}: {
  siteId: string;
  preset: PeriodPreset;
}) {
  const { appDict, stats } = useAssist();
  const t = appDict.e3.stats;
  const state = useAsync(
    () =>
      stats.overview(siteId, {
        ...periodOf(preset, new Date()),
        compare: 'prev',
      }),
    [stats, siteId, preset]
  );
  return (
    <Loaded state={state}>
      {(o) => (
        <div className="space-y-3">
          <PeriodNote p={o.period} />
          <div className="grid grid-cols-2 gap-2">
            <Metric label={t.metrics.dialogs} m={o.dialogs} />
            <Metric label={t.metrics.resolved} m={o.resolved} />
            <Metric
              label={t.metrics.resolvedShare}
              m={o.resolvedShare}
              format={(n) => pct(n)}
            />
            <Metric label={t.metrics.handoffs} m={o.handoffs} />
            <Metric label={t.metrics.handoffsMissed} m={o.handoffsMissed} />
            <Metric label={t.metrics.leads} m={o.leads} />
            <Metric label={t.metrics.conversions} m={o.conversions.total} />
            <Metric
              label={t.metrics.thumbsUp}
              m={o.thumbsUpShare}
              format={(n) => pct(n)}
            />
          </div>
          <Card className="text-sm space-y-1">
            <div>
              {t.attribution.direct}: <b>{o.conversions.direct.value}</b>
            </div>
            <div>
              {t.attribution.assisted}: <b>{o.conversions.assisted.value}</b>
            </div>
            <div className="text-silver-500">
              {fmt(t.hoursSaved, {
                n: Math.round(o.operatorHoursSaved * 10) / 10,
                m: o.minutesPerQuestion,
              })}
            </div>
            <div className="text-silver-500">
              {fmt(t.cost, { usd: usd(o.costMicroUsd) })}
            </div>
          </Card>
          {o.series.length > 0 && (
            <Card className="space-y-1">
              <div className="text-sm font-medium">{t.series}</div>
              <MiniTable
                head={[
                  t.seriesCols.day,
                  t.seriesCols.dialogs,
                  t.seriesCols.resolved,
                  t.seriesCols.handoffs,
                  t.seriesCols.leads,
                  t.seriesCols.conversions,
                ]}
                rows={o.series.map((s) => [
                  s.day,
                  s.dialogs,
                  s.resolved,
                  s.handoffs,
                  s.leads,
                  s.conversions,
                ])}
              />
            </Card>
          )}
        </div>
      )}
    </Loaded>
  );
}

function money(v: number, cur: string | null): string {
  return `${Math.round(v * 100) / 100}${cur ? ` ${cur}` : ''}`;
}

function Conversions({
  siteId,
  preset,
}: {
  siteId: string;
  preset: PeriodPreset;
}) {
  const { appDict, stats } = useAssist();
  const t = appDict.e3.stats;
  const state = useAsync(
    () => stats.conversions(siteId, periodOf(preset, new Date())),
    [stats, siteId, preset]
  );
  return (
    <Loaded state={state}>
      {(c) => (
        <div className="space-y-3">
          <PeriodNote p={c.period} />
          {c.goals.length === 0 && <Card className="text-sm">{t.empty}</Card>}
          {c.goals.map((g) => (
            <Card key={g.goalId} className="space-y-1 text-sm">
              <div className="font-semibold">{g.name || g.key}</div>
              <div>
                {t.total}: <b>{g.total}</b> · {t.refunds}: {g.refunds}
              </div>
              <div>
                {t.attribution.direct}: {g.direct}
              </div>
              <div>
                {t.attribution.assisted}: {g.assisted}
              </div>
              <div className="text-silver-500">
                {t.attribution.unassisted}: {g.unassisted}
              </div>
              <div>
                {fmt(t.valueVerified, {
                  v: money(g.value.verified, g.value.currency),
                })}
                <span className="text-silver-500">
                  {' · '}
                  {fmt(t.valuePage, {
                    v: money(g.value.page, g.value.currency),
                  })}
                </span>
              </div>
              <div className="text-silver-500">
                {fmt(t.dialogConversion, { p: pct(g.dialogConversion) })}
              </div>
            </Card>
          ))}
          {c.proactive.length > 0 && (
            <Card className="space-y-1">
              <div className="text-sm font-medium">{t.proactive}</div>
              <MiniTable
                head={[
                  t.proactiveCols.key,
                  t.proactiveCols.shown,
                  t.proactiveCols.accepted,
                  t.proactiveCols.dismissed,
                  t.proactiveCols.dialogs,
                  t.proactiveCols.conversions,
                ]}
                rows={c.proactive.map((p) => [
                  p.key,
                  p.shown,
                  p.accepted,
                  p.dismissed,
                  p.dialogs,
                  p.conversions,
                ])}
              />
            </Card>
          )}
        </div>
      )}
    </Loaded>
  );
}

function Topics({ siteId, preset }: { siteId: string; preset: PeriodPreset }) {
  const { appDict, stats } = useAssist();
  const t = appDict.e3.stats;
  const state = useAsync(
    () => stats.topics(siteId, periodOf(preset, new Date())),
    [stats, siteId, preset]
  );
  return (
    <Loaded state={state}>
      {(v) => (
        <div className="space-y-3">
          <PeriodNote p={v.period} />
          <div className="text-sm">{fmt(t.uncovered, { n: v.uncovered })}</div>
          {v.topics.length === 0 && <Card className="text-sm">{t.empty}</Card>}
          {v.topics.map((x) => (
            <Card key={x.clusterId} className="space-y-1 text-sm">
              <div className="font-medium break-words">{x.label}</div>
              <div className="text-xs text-silver-500">
                {fmt(t.visitors, { n: x.distinctVisitors })} ·{' '}
                {fmt(t.unknownShare, { p: pct(x.unknownShare) })} ·{' '}
                {t.metrics.conversions}: {x.conversions} ·{' '}
                {t.topicStatus[x.status]}
              </div>
            </Card>
          ))}
          <Button
            variant="outline"
            onClick={() => navigate({ name: 'learning', siteId, tab: 'queue' })}
          >
            {appDict.e3.site.learning}
          </Button>
        </div>
      )}
    </Loaded>
  );
}

function Exports({ siteId, preset }: { siteId: string; preset: PeriodPreset }) {
  const { account } = useKit();
  const { appDict, stats } = useAssist();
  const t = appDict.e3.stats;
  const errText = useE3ErrorText();
  const list = useAsync(() => stats.exports(siteId), [stats, siteId]);
  const [items, setItems] = useState<ExportView[] | null>(null);
  const [kind, setKind] = useState<ExportKind>('daily');
  const [withText, setWithText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const shown = items ?? list.data ?? [];
  const pending = shown.some(
    (x) => x.status === 'queued' || x.status === 'running'
  );

  // Готовится — переспрашиваем раз в 5 с, пока не готово.
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      stats.exports(siteId).then(setItems, () => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, [pending, stats, siteId]);

  async function create() {
    setBusy(true);
    setNotice(null);
    try {
      await stats.createExport(siteId, {
        kind,
        ...periodOf(preset, new Date()),
        ...(withText ? { withText: true } : {}),
      });
      setItems(await stats.exports(siteId));
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2">
      <div className="font-semibold">{t.exports}</div>
      <NoticeBar notice={notice} />
      <Select
        value={kind}
        options={EXPORT_KINDS}
        labels={t.exportKinds}
        onChange={setKind}
      />
      {canManageSecrets(account.me) && kind === 'dialogs' && (
        <Toggle checked={withText} onChange={setWithText} label={t.withText} />
      )}
      <Button loading={busy} onClick={() => void create()}>
        {t.createExport}
      </Button>
      <ul className="text-sm space-y-1">
        {shown.map((x) => (
          <li key={x.id} className="flex flex-wrap items-center gap-2">
            <span>{t.exportKinds[x.kind]}</span>
            <span className="text-silver-500">{t.exportStatus[x.status]}</span>
            {x.rows !== null && (
              <span className="text-silver-500">
                {fmt(t.rows, { n: x.rows })}
              </span>
            )}
            {x.url && (
              <a
                className="inline-flex items-center gap-1 underline"
                href={x.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Download size={14} /> {t.download}
              </a>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Subscription({ siteId }: { siteId: string }) {
  const { appDict, stats } = useAssist();
  const t = appDict.e3.stats;
  const errText = useE3ErrorText();
  const loaded = useAsync(() => stats.subscription(siteId), [stats, siteId]);
  const [sub, setSub] = useState<ReportSubscriptionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const v = sub ?? loaded.data;
  if (!v) return null;
  const save = async (next: ReportSubscriptionView) => {
    setError(null);
    try {
      setSub(await stats.saveSubscription(siteId, next));
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <Card className="space-y-2">
      <div className="font-semibold">{t.reports}</div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Toggle
        checked={v.digest}
        onChange={(digest) => void save({ ...v, digest })}
        label={t.digest}
      />
      <Toggle
        checked={v.weekly}
        onChange={(weekly) => void save({ ...v, weekly })}
        label={t.weekly}
      />
    </Card>
  );
}

function AnalyticsSettings({ siteId }: { siteId: string }) {
  const { appDict, stats } = useAssist();
  const t = appDict.e3.stats;
  const errNotice = useE3ErrorNotice();
  const loaded = useAsync(
    () => stats.analyticsSettings(siteId),
    [stats, siteId]
  );
  const [draft, setDraft] = useState<AnalyticsSettingsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const v = draft ?? loaded.data;
  if (!v) return null;
  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      setDraft(
        await stats.saveAnalyticsSettings(siteId, {
          config: v.config,
          timezone: v.timezone,
          currency: v.currency,
        })
      );
      setNotice({ tone: 'success', text: appDict.e3.common.saved });
    } catch (e) {
      setNotice(errNotice(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-2">
      <div className="font-semibold">{t.settings}</div>
      <NoticeBar notice={notice} />
      <Field label={t.minutesPerQuestion}>
        <NumberInput
          value={v.config.minutesPerQuestion}
          min={1}
          max={60}
          onChange={(n) =>
            setDraft({ ...v, config: { ...v.config, minutesPerQuestion: n } })
          }
        />
      </Field>
      <MasksInput
        label={t.officeCidrs}
        value={v.config.officeCidrs}
        onChange={(officeCidrs) =>
          setDraft({ ...v, config: { ...v.config, officeCidrs } })
        }
      />
      <MasksInput
        label={t.excludedPaths}
        value={v.config.excludedPaths}
        onChange={(excludedPaths) =>
          setDraft({ ...v, config: { ...v.config, excludedPaths } })
        }
      />
      <Field label={t.tzLabel}>
        <input
          className={inputClass}
          maxLength={64}
          value={v.timezone}
          onChange={(e) => setDraft({ ...v, timezone: e.target.value.trim() })}
        />
      </Field>
      <Field label={t.currency}>
        <input
          className={inputClass}
          maxLength={3}
          value={v.currency}
          onChange={(e) =>
            setDraft({ ...v, currency: e.target.value.toUpperCase() })
          }
        />
      </Field>
      <Button loading={busy} disabled={!draft} onClick={() => void save()}>
        {appDict.e3.common.save}
      </Button>
    </Card>
  );
}

/** Сводная по сайтам кабинета (§5-тер.6 «Мультисайт»), `#/stats`. */
export function StatsSitesScreen() {
  const { account } = useKit();
  const { appDict, stats } = useAssist();
  const t = appDict.e3.stats;
  const [preset, setPreset] = useState<PeriodPreset>(30);
  const ok = canSeeStats(account.me);
  const state = useAsync(
    () =>
      ok ? stats.sites(periodOf(preset, new Date())) : Promise.resolve(null),
    [stats, preset, ok]
  );
  if (!ok) return <ManagerOnly />;
  return (
    <div className="space-y-4">
      <ScreenTitle>{t.sitesTitle}</ScreenTitle>
      <PeriodPicker value={preset} onChange={setPreset} />
      <Loaded state={state}>
        {(v) =>
          v ? (
            <Card>
              <MiniTable
                head={[
                  t.sitesCols.site,
                  t.sitesCols.dialogs,
                  t.sitesCols.resolvedShare,
                  t.sitesCols.conversions,
                  t.sitesCols.cost,
                ]}
                rows={v.sites.map((s) => [
                  <button
                    key={s.siteId}
                    type="button"
                    className="underline text-left"
                    onClick={() =>
                      /^[A-Za-z0-9_-]{1,64}$/.test(s.siteId) &&
                      navigate({
                        name: 'stats',
                        siteId: s.siteId,
                        tab: 'overview',
                      })
                    }
                  >
                    {s.name}
                  </button>,
                  s.dialogs,
                  pct(s.resolvedShare),
                  s.conversions,
                  usd(s.costMicroUsd),
                ])}
              />
            </Card>
          ) : null
        }
      </Loaded>
    </div>
  );
}
