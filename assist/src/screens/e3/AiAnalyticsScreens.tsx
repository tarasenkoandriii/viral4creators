/**
 * Э3-бис «Аналитика с ИИ» (ТЗ §5-тер.3–5, 8–10, 14–17): вкладки статистики
 * «ИИ-оценка», «Выводы», «Эксперименты», «Поведение» и карточка настроек
 * согласия. Числа — с сервера (код), модель только формулирует; эксперимент
 * показывает итог лишь после фиксированного срока.
 */
import { useState, type ReactNode } from 'react';
import { fmt, formatDate, useAsync, useKit } from '../../kit';
import { Alert, Badge, Button, Card, Spinner, inputClass } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import {
  AI_INTENTS,
  EXPERIMENT_KINDS,
  LEAD_BUCKETS,
  VERTICALS,
  type AiDialogView,
  type AiIntent,
  type AiPlanView,
  type AiSettings,
  type AiStage,
  type AiFailure,
  type Dist,
  type ExperimentKind,
  type ExperimentRequest,
  type InsightView,
  type LeadBucket,
  type PowerView,
} from '../../lib/ai-types';
import { CMP_IDS, cmpSnippet, type CmpId } from '../../lib/cmp-snippets';
import {
  coverageShare,
  dryLine,
  experimentLines,
  followUpValue,
  impactTone,
  powerLine,
} from '../../lib/ai-view';
import {
  isOwner,
  pct,
  periodOf,
  usd,
  type PeriodPreset,
} from '../../lib/e3-view';
import { useE3ErrorNotice } from '../../lib/use-error-text';
import { WIDGET_GLOBAL } from '../../lib/widget-brand';
import { WIDGET_UI_LANGS, type WidgetUiLang } from '../../lib/widget-types';
import { LoadError, NoticeBar, type Notice } from '../knowledge/parts';
import { Field, NumberInput, Select, Toggle } from '../widget/controls';
import { MiniTable } from './parts';

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

function DistList({
  title,
  items,
  name,
}: {
  title: string;
  items: Dist[];
  name: (k: string) => string;
}) {
  if (items.length === 0) return null;
  const total = items.reduce((s, x) => s + x.n, 0) || 1;
  return (
    <Card className="space-y-1 text-sm">
      <div className="font-medium">{title}</div>
      {items.slice(0, 8).map((x) => (
        <div key={x.key} className="flex justify-between gap-2">
          <span className="break-words">{name(x.key)}</span>
          <span className="text-silver-500 whitespace-nowrap">
            {x.n} · {pct(x.n / total)}
          </span>
        </div>
      ))}
    </Card>
  );
}

const named =
  <K extends string>(map: Record<K, string>) =>
  (k: string): string =>
    k in map ? map[k as K] : k;

// ── ИИ-оценка ────────────────────────────────────────────────────────

export function AiTab({
  siteId,
  preset,
}: {
  siteId: string;
  preset: PeriodPreset;
}) {
  const { appDict, ai } = useAssist();
  const t = appDict.e3b;
  const state = useAsync(() => {
    const p = periodOf(preset, new Date());
    return ai.summary(siteId, p.from, p.to);
  }, [ai, siteId, preset]);
  return (
    <Loaded state={state}>
      {(s) => (
        <div className="space-y-3">
          <div className="text-xs text-silver-500">{t.ai.intro}</div>
          {!s.plan.aiAnalytics && (
            <Alert tone="warning">{t.plan.needBusiness}</Alert>
          )}
          {s.plan.aiAnalytics && !s.model.ok && (
            <Alert tone="warning">{t.plan.modelOff}</Alert>
          )}
          <Card className="space-y-1 text-sm">
            <div>
              {fmt(t.ai.coverage, {
                labeled: s.coverage.labeled,
                closed: s.coverage.closed,
              })}
              {coverageShare(s.coverage) !== null &&
                ` (${pct(coverageShare(s.coverage))})`}
            </div>
            {s.coverage.pending > 0 && (
              <div className="text-silver-500">
                {fmt(t.ai.pending, { n: s.coverage.pending })}
              </div>
            )}
            {s.coverage.failed > 0 && (
              <div className="text-silver-500">
                {fmt(t.ai.failed, { n: s.coverage.failed })}
              </div>
            )}
            {s.coverage.injection > 0 && (
              <div className="text-silver-500">
                {fmt(t.ai.injection, { n: s.coverage.injection })}
              </div>
            )}
            {s.coverage.sampled && (
              <div className="text-silver-500">{t.ai.sampled}</div>
            )}
            {s.budget.capMicroUsd > 0 && (
              <div className="text-silver-500">
                {fmt(t.ai.budget, {
                  spent: usd(s.budget.spentMicroUsd),
                  cap: usd(s.budget.capMicroUsd),
                })}
              </div>
            )}
            {s.overridden > 0 && (
              <div className="text-silver-500">
                {fmt(t.ai.overridden, { n: s.overridden })}
              </div>
            )}
          </Card>
          <div className="grid grid-cols-3 gap-2">
            {LEAD_BUCKETS.map((b) => (
              <Card key={b} className="space-y-0.5">
                <div className="text-xs text-silver-500">{t.ai.buckets[b]}</div>
                <div className="text-xl font-semibold">{s.buckets[b]}</div>
              </Card>
            ))}
          </div>
          {s.buckets.hotNoLead > 0 && (
            <Alert tone="warning">
              {fmt(t.ai.hotNoLead, { n: s.buckets.hotNoLead })}
            </Alert>
          )}
          <div className="text-xs text-silver-500">
            {s.calibration
              ? fmt(t.ai.calibration, {
                  n: s.calibration.total,
                  auc:
                    s.calibration.auc === null
                      ? '—'
                      : s.calibration.auc.toFixed(2),
                })
              : t.ai.calibrationNone}
          </div>
          <DistList
            title={t.ai.intents}
            items={s.intents}
            name={named(t.ai.intentNames)}
          />
          <DistList
            title={t.ai.stages}
            items={s.stages}
            name={named(t.ai.stageNames)}
          />
          <DistList
            title={t.ai.failures}
            items={s.failureReasons}
            name={named(t.ai.failureNames)}
          />
          <Dialogs siteId={siteId} preset={preset} />
          <AiSettingsCard siteId={siteId} plan={s.plan} />
        </div>
      )}
    </Loaded>
  );
}

function Dialogs({ siteId, preset }: { siteId: string; preset: PeriodPreset }) {
  const { appDict, ai } = useAssist();
  const t = appDict.e3b.ai;
  const [bucket, setBucket] = useState<LeadBucket | ''>('');
  const [more, setMore] = useState<AiDialogView[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const state = useAsync(async () => {
    setMore([]);
    setCursor(undefined);
    return ai.dialogs(siteId, {
      ...periodOf(preset, new Date()),
      ...(bucket ? { bucket } : {}),
    });
  }, [ai, siteId, preset, bucket]);
  const next = cursor === undefined ? state.data?.nextCursor : cursor;
  const loadMore = async () => {
    if (!next) return;
    const page = await ai.dialogs(siteId, {
      ...periodOf(preset, new Date()),
      ...(bucket ? { bucket } : {}),
      cursor: next,
    });
    setMore((m) => [...m, ...page.items]);
    setCursor(page.nextCursor);
  };
  return (
    <Card className="space-y-2">
      <div className="font-semibold">{t.dialogs}</div>
      <div className="flex flex-wrap gap-1" role="group">
        {(['', ...LEAD_BUCKETS] as const).map((b) => (
          <Button
            key={b || 'all'}
            variant={b === bucket ? 'solid' : 'outline'}
            onClick={() => setBucket(b)}
          >
            {b ? t.buckets[b] : t.all}
          </Button>
        ))}
      </div>
      <Loaded state={state}>
        {(p) => {
          const items = [...p.items, ...more];
          return (
            <div className="space-y-2">
              {items.length === 0 && (
                <div className="text-sm text-silver-500">{t.empty}</div>
              )}
              {items.map((d) => (
                <DialogRow key={d.conversationId} siteId={siteId} d={d} />
              ))}
              {next && (
                <Button variant="outline" onClick={() => void loadMore()}>
                  {t.more}
                </Button>
              )}
            </div>
          );
        }}
      </Loaded>
    </Card>
  );
}

function DialogRow({ siteId, d }: { siteId: string; d: AiDialogView }) {
  const { locale } = useKit();
  const { appDict, ai } = useAssist();
  const t = appDict.e3b.ai;
  const errNotice = useE3ErrorNotice();
  const [open, setOpen] = useState(false);
  const [fix, setFix] = useState(false);
  const [intent, setIntent] = useState<AiIntent>(
    (AI_INTENTS as readonly string[]).includes(d.intent ?? '')
      ? (d.intent as AiIntent)
      : 'other'
  );
  const [bucket, setBucket] = useState<LeadBucket>(d.leadBucket ?? 'cold');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [fixed, setFixed] = useState(d.overridden);
  const save = async () => {
    setNotice(null);
    try {
      await ai.fixLabel(siteId, d.conversationId, {
        intent,
        leadBucket: bucket,
      });
      setFixed(true);
      setFix(false);
    } catch (e) {
      setNotice(errNotice(e));
    }
  };
  return (
    <div className="border-t border-silver-200 dark:border-silver-800 pt-2 text-sm space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        {d.leadBucket && (
          <Badge
            tone={
              d.leadBucket === 'hot'
                ? 'danger'
                : d.leadBucket === 'warm'
                  ? 'warning'
                  : 'neutral'
            }
          >
            {t.buckets[d.leadBucket]}
          </Badge>
        )}
        {d.intent && <span>{named(t.intentNames)(d.intent)}</span>}
        {d.stage && (
          <span className="text-silver-500">
            · {named(t.stageNames)(d.stage as AiStage)}
          </span>
        )}
        {d.converted && <Badge tone="success">{t.converted}</Badge>}
        {d.lead && <Badge tone="accent">{t.lead}</Badge>}
        {d.handoff && <Badge>{t.handoff}</Badge>}
        {fixed && <span className="text-xs text-silver-500">{t.fixed}</span>}
      </div>
      <div className="text-xs text-silver-500 break-words">
        {formatDate(d.createdAt, locale)}
        {d.pagePath && ` · ${d.pagePath}`}
        {d.leadScore !== null && ` · ${fmt(t.score, { n: d.leadScore })}`}
        {d.leadProb !== null && ` · ${fmt(t.prob, { p: pct(d.leadProb) })}`}
        {d.failureReason &&
          ` · ${named(t.failureNames)(d.failureReason as AiFailure)}`}
      </div>
      <div className="flex flex-wrap gap-2">
        {d.features.length > 0 && (
          <button
            type="button"
            className="text-xs underline"
            onClick={() => setOpen(!open)}
          >
            {t.why}
          </button>
        )}
        <button
          type="button"
          className="text-xs underline"
          onClick={() => setFix(!fix)}
        >
          {t.fix}
        </button>
      </div>
      {open && (
        <ul className="text-xs space-y-0.5">
          {d.features.map((f) => (
            <li key={f.f} className="flex justify-between gap-2">
              <span>{t.features[f.f]}</span>
              <span className={f.c >= 0 ? 'text-green-600' : 'text-red-600'}>
                {f.c >= 0 ? '+' : '−'}
                {Math.abs(Math.round(f.c * 100) / 100)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {fix && (
        <div className="space-y-2">
          <NoticeBar notice={notice} />
          <Field label={t.fixIntent}>
            <Select
              value={intent}
              options={AI_INTENTS}
              labels={t.intentNames}
              onChange={setIntent}
            />
          </Field>
          <Field label={t.fixBucket}>
            <Select
              value={bucket}
              options={LEAD_BUCKETS}
              labels={t.buckets}
              onChange={setBucket}
            />
          </Field>
          <Button onClick={() => void save()}>
            {appDict.e3b.settings.save}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Выводы ───────────────────────────────────────────────────────────

export function InsightsTab({ siteId }: { siteId: string }) {
  const { locale } = useKit();
  const { appDict, ai } = useAssist();
  const t = appDict.e3b;
  const [week, setWeek] = useState<string | undefined>(undefined);
  // Тексты выводов — на языке экрана (заход 9).
  const state = useAsync(
    () => ai.insights(siteId, week, locale),
    [ai, siteId, week, locale]
  );
  return (
    <Loaded state={state}>
      {(v) => (
        <div className="space-y-3">
          <div className="text-xs text-silver-500">{t.insights.intro}</div>
          {v.weeks.length > 1 && (
            <select
              className={inputClass}
              value={v.weekStart ?? ''}
              onChange={(e) => setWeek(e.target.value)}
            >
              {v.weeks.map((w) => (
                <option key={w} value={w}>
                  {fmt(t.insights.week, { d: formatDate(w, locale) })}
                </option>
              ))}
            </select>
          )}
          {v.weeks.length === 1 && v.weekStart && (
            <div className="text-sm">
              {fmt(t.insights.week, { d: formatDate(v.weekStart, locale) })}
            </div>
          )}
          {v.items.length === 0 && (
            <Card className="text-sm">{t.insights.empty}</Card>
          )}
          {v.items.map((i) => (
            <InsightCard key={i.id} siteId={siteId} i={i} />
          ))}
        </div>
      )}
    </Loaded>
  );
}

function InsightCard({ siteId, i }: { siteId: string; i: InsightView }) {
  const { appDict, ai } = useAssist();
  const t = appDict.e3b.insights;
  const errNotice = useE3ErrorNotice();
  const [cur, setCur] = useState(i);
  const [notice, setNotice] = useState<Notice | null>(null);
  const dry = dryLine(appDict.e3b, cur);
  const mark = async (patch: {
    status?: InsightView['status'];
    feedback?: 1 | -1 | 0;
  }) => {
    setNotice(null);
    try {
      await ai.markInsight(siteId, cur.id, patch);
      setCur({
        ...cur,
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.feedback !== undefined
          ? { feedback: patch.feedback === 0 ? null : patch.feedback }
          : {}),
      });
    } catch (e) {
      setNotice(errNotice(e));
    }
  };
  const skipped =
    cur.textSkipped && cur.textSkipped in t.skipped
      ? t.skipped[cur.textSkipped as keyof typeof t.skipped]
      : null;
  return (
    <Card
      className={`space-y-1 text-sm ${cur.status === 'dismissed' ? 'opacity-60' : ''}`}
    >
      <NoticeBar notice={notice} />
      <div className="flex items-center gap-2">
        <Badge tone={impactTone(cur.impact)}>{t.impact[cur.impact]}</Badge>
        {cur.status === 'done' && <Badge tone="success">{t.done}</Badge>}
      </div>
      {cur.text ? (
        <>
          <div className="font-semibold break-words">{cur.text.title}</div>
          <div className="break-words">{cur.text.what}</div>
          <div className="break-words">→ {cur.text.action}</div>
          <div className="text-xs text-silver-500 break-words">{dry}</div>
        </>
      ) : (
        <>
          <div className="font-medium break-words">{dry}</div>
          {skipped && <div className="text-xs text-silver-500">{skipped}</div>}
        </>
      )}
      {cur.followUp?.after && (
        <div className="text-xs text-silver-500">
          {fmt(t.followUp, {
            before: followUpValue(cur, cur.followUp.before),
            after: followUpValue(cur, cur.followUp.after),
          })}
        </div>
      )}
      <div className="flex flex-wrap gap-1 pt-1">
        {cur.status === 'new' ? (
          <>
            <Button
              variant="outline"
              onClick={() => void mark({ status: 'done' })}
            >
              {t.done}
            </Button>
            <Button
              variant="ghost"
              onClick={() => void mark({ status: 'dismissed' })}
            >
              {t.dismiss}
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => void mark({ status: 'new' })}>
            {t.reopen}
          </Button>
        )}
        <Button
          variant={cur.feedback === 1 ? 'solid' : 'ghost'}
          onClick={() => void mark({ feedback: cur.feedback === 1 ? 0 : 1 })}
        >
          👍 {t.useful}
        </Button>
        <Button
          variant={cur.feedback === -1 ? 'solid' : 'ghost'}
          onClick={() => void mark({ feedback: cur.feedback === -1 ? 0 : -1 })}
        >
          👎 {t.useless}
        </Button>
      </div>
    </Card>
  );
}

// ── Эксперименты ─────────────────────────────────────────────────────

export function ExperimentsTab({ siteId }: { siteId: string }) {
  const { account, locale } = useKit();
  const { appDict, ai, stats } = useAssist();
  const t = appDict.e3b.experiments;
  const errNotice = useE3ErrorNotice();
  const list = useAsync(() => ai.experiments(siteId), [ai, siteId]);
  const goals = useAsync(() => stats.goals(siteId), [stats, siteId]);
  const settings = useAsync(() => ai.settings(siteId), [ai, siteId]);
  const owner = isOwner(account.me);
  const [kind, setKind] = useState<ExperimentKind>('holdout');
  const [goalKey, setGoalKey] = useState('');
  const [share, setShare] = useState(10);
  const [horizon, setHorizon] = useState(28);
  const [lang, setLang] = useState<WidgetUiLang>('uk');
  const [text, setText] = useState('');
  const [power, setPower] = useState<PowerView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const activeGoals = (goals.data ?? []).filter((g) => g.status !== 'paused');
  const goal = goalKey || activeGoals[0]?.key || '';
  const running = (list.data ?? []).find((e) => e.status === 'running');

  const request = (): ExperimentRequest => {
    const lines = text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 4);
    return {
      kind,
      goalKey: goal,
      horizonDays: horizon,
      ...(kind === 'holdout'
        ? { share: share / 100 }
        : {
            variant: {
              [lang]: kind === 'greeting' ? text.trim() : lines,
            },
          }),
    };
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice(errNotice(e));
    } finally {
      setBusy(false);
    }
  };
  const preview = () =>
    run(async () => setPower(await ai.preview(siteId, request())));
  const start = () =>
    run(async () => {
      await ai.startExperiment(siteId, request());
      setPower(null);
      list.reload();
    });
  const stop = (id: string) =>
    run(async () => {
      await ai.stopExperiment(siteId, id);
      list.reload();
    });

  return (
    <div className="space-y-3">
      <div className="text-xs text-silver-500">{t.intro}</div>
      <NoticeBar notice={notice} />
      {settings.data && !settings.data.linked && (
        <Alert tone="warning">{t.needLinked}</Alert>
      )}
      {!owner && <Alert tone="warning">{t.ownerOnly}</Alert>}
      <Loaded state={list}>
        {(items) => (
          <div className="space-y-2">
            {items.length === 0 && <Card className="text-sm">{t.empty}</Card>}
            {items.map((e) => (
              <Card key={e.id} className="space-y-1 text-sm">
                <div className="font-semibold">
                  {t.kinds[e.kind]} · {e.goalKey}
                </div>
                <div className="text-xs text-silver-500">
                  {formatDate(e.startedAt, locale)} —{' '}
                  {formatDate(e.endsAt, locale)}
                </div>
                {experimentLines(
                  appDict.e3b,
                  e,
                  formatDate(e.endsAt, locale)
                ).map((l, k) => (
                  <div key={k}>{l}</div>
                ))}
                {owner && e.status === 'running' && (
                  <Button
                    variant="outline"
                    loading={busy}
                    onClick={() => void stop(e.id)}
                  >
                    {t.stop}
                  </Button>
                )}
              </Card>
            ))}
          </div>
        )}
      </Loaded>
      {owner && !running && settings.data?.linked && (
        <Card className="space-y-2">
          <Select
            value={kind}
            options={EXPERIMENT_KINDS}
            labels={t.kinds}
            onChange={(k) => {
              setKind(k);
              setPower(null);
            }}
          />
          <Field label={t.goal}>
            <select
              className={inputClass}
              value={goal}
              onChange={(e) => {
                setGoalKey(e.target.value);
                setPower(null);
              }}
            >
              {activeGoals.map((g) => (
                <option key={g.id} value={g.key}>
                  {g.name || g.key}
                </option>
              ))}
            </select>
          </Field>
          <div className="text-xs text-silver-500">{t.goalHint}</div>
          {kind === 'holdout' ? (
            <Field label={`${t.share}, %`}>
              <NumberInput value={share} min={5} max={20} onChange={setShare} />
            </Field>
          ) : (
            <Field
              label={fmt(kind === 'greeting' ? t.variant : t.variantList, {
                lang,
              })}
            >
              <div className="flex gap-1 pb-1" role="group">
                {WIDGET_UI_LANGS.map((l) => (
                  <Button
                    key={l}
                    variant={l === lang ? 'solid' : 'outline'}
                    onClick={() => setLang(l)}
                  >
                    {l}
                  </Button>
                ))}
              </div>
              <textarea
                className={`${inputClass} min-h-[72px]`}
                maxLength={kind === 'greeting' ? 300 : 4 * 81}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
          )}
          <Field label={t.horizon}>
            <NumberInput
              value={horizon}
              min={14}
              max={56}
              onChange={setHorizon}
            />
          </Field>
          <div className="flex gap-2">
            <Button
              variant="outline"
              loading={busy}
              disabled={!goal}
              onClick={() => void preview()}
            >
              {t.preview}
            </Button>
            <Button
              loading={busy}
              disabled={!power?.ok}
              onClick={() => void start()}
            >
              {t.start}
            </Button>
          </div>
          {power && (
            <Alert tone={power.ok ? 'success' : 'warning'}>
              {powerLine(appDict.e3b, power, horizon)}
            </Alert>
          )}
        </Card>
      )}
    </div>
  );
}

// ── Поведение ────────────────────────────────────────────────────────

export function BehaviorTab({
  siteId,
  preset,
}: {
  siteId: string;
  preset: PeriodPreset;
}) {
  const { appDict, ai } = useAssist();
  const t = appDict.e3b.behavior;
  const state = useAsync(() => {
    const p = periodOf(preset, new Date());
    return ai.behavior(siteId, p.from, p.to);
  }, [ai, siteId, preset]);
  return (
    <Loaded state={state}>
      {(v) => (
        <div className="space-y-3">
          <div className="text-xs text-silver-500">{t.intro}</div>
          {v.reason === 'plan' && <Alert tone="warning">{t.needPlan}</Alert>}
          {v.reason === 'settings' && (
            <Alert tone="warning">{t.needSettings}</Alert>
          )}
          {v.quota.limit > 0 && (
            <div className="text-xs text-silver-500">
              {fmt(t.quota, { used: v.quota.used, limit: v.quota.limit })}
            </div>
          )}
          {v.quota.limit > 0 && v.quota.sampleRate <= 0 && (
            <Alert tone="warning">{t.capped}</Alert>
          )}
          {v.quota.sampleRate > 0 && v.quota.sampleRate < 1 && (
            <div className="text-xs text-silver-500">
              {fmt(t.sampled, { rate: pct(v.quota.sampleRate) })}
            </div>
          )}
          {v.pages.length === 0 ? (
            <Card className="text-sm">{t.empty}</Card>
          ) : (
            <Card>
              <MiniTable
                head={[
                  t.cols.path,
                  t.cols.views,
                  t.cols.active,
                  t.cols.scroll,
                  t.cols.rage,
                  t.cols.errors,
                  t.cols.forms,
                  t.cols.field,
                  t.cols.lcp,
                  t.cols.inp,
                ]}
                rows={v.pages.map((p) => [
                  <span key="p" className="break-all">
                    {p.path}
                  </span>,
                  p.views,
                  Math.round(p.activeMsMedian / 1000),
                  pct(p.scrollMedian),
                  p.rage,
                  p.jsErrors,
                  `${p.formAbandons}/${p.formStarts}`,
                  p.topAbandonField ?? '—',
                  p.lcpP75 === null ? '—' : `${Math.round(p.lcpP75)} ms`,
                  p.inpP75 === null ? '—' : `${Math.round(p.inpP75)} ms`,
                ])}
              />
            </Card>
          )}
        </div>
      )}
    </Loaded>
  );
}

// ── Настройки: разметка, тип бизнеса, согласие, поведение ────────────

export function AiSettingsCard({
  siteId,
  plan,
}: {
  siteId: string;
  plan: AiPlanView;
}) {
  const { account } = useKit();
  const { appDict, ai } = useAssist();
  const t = appDict.e3b.settings;
  const errNotice = useE3ErrorNotice();
  const loaded = useAsync(() => ai.settings(siteId), [ai, siteId]);
  const [draft, setDraft] = useState<AiSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const owner = isOwner(account.me);
  // Готовая связка для баннера сайта (заход 9): GCM — без фрагмента.
  const [cmp, setCmp] = useState<CmpId>('custom');
  const v = draft ?? loaded.data;
  if (!v) return null;
  const snippet = cmpSnippet(cmp, WIDGET_GLOBAL);
  const set = (p: Partial<AiSettings>) => setDraft({ ...v, ...p });
  const maxWindow = Math.max(1, plan.linkedWindowDays || 1);
  const save = async () => {
    if (!draft || !loaded.data) return;
    setBusy(true);
    setNotice(null);
    try {
      // Только изменённые ключи: не-владелец не трогает ключи согласия.
      const patch: Partial<AiSettings> = {};
      for (const k of Object.keys(draft) as Array<keyof AiSettings>) {
        if (draft[k] !== loaded.data[k])
          (patch as Record<string, unknown>)[k] = draft[k];
      }
      setDraft(await ai.saveSettings(siteId, patch));
      setNotice({ tone: 'success', text: t.saved });
    } catch (e) {
      setNotice(errNotice(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-2">
      <div className="font-semibold">{t.title}</div>
      <NoticeBar notice={notice} />
      <Toggle
        checked={v.aiLabeling}
        onChange={(aiLabeling) => set({ aiLabeling })}
        label={t.aiLabeling}
        disabled={!plan.aiAnalytics}
      />
      <Field label={t.vertical}>
        <Select
          value={v.vertical}
          options={VERTICALS}
          labels={t.verticals}
          onChange={(vertical) => set({ vertical })}
        />
      </Field>
      {!owner && <div className="text-xs text-silver-500">{t.ownerOnly}</div>}
      <Toggle
        checked={v.linked}
        onChange={(linked) => set({ linked })}
        label={t.linked}
        disabled={!owner}
      />
      <div className="text-xs text-silver-500">{t.linkedNote}</div>
      {v.linked && (
        <>
          <Toggle
            checked={v.linkedGcm}
            onChange={(linkedGcm) => set({ linkedGcm })}
            label={t.gcm}
            disabled={!owner}
          />
          {plan.linkedWindowDays > 0 && (
            <Field
              label={t.window}
              hint={fmt(t.windowMax, { n: plan.linkedWindowDays })}
            >
              <NumberInput
                value={Math.min(v.linkedWindowDays, maxWindow)}
                min={1}
                max={maxWindow}
                onChange={(linkedWindowDays) => set({ linkedWindowDays })}
              />
            </Field>
          )}
          <Toggle
            checked={v.behavior}
            onChange={(behavior) => set({ behavior })}
            label={t.behavior}
            disabled={!owner || plan.behaviorViewsPerMonth === 0}
          />
          <Field label={t.cmp}>
            <Select
              value={cmp}
              options={CMP_IDS}
              labels={t.cmps}
              onChange={setCmp}
            />
          </Field>
          <div className="text-xs">{t.cmpHints[cmp]}</div>
          {snippet && (
            <pre className="text-xs font-mono whitespace-pre-wrap break-all rounded bg-silver-100 dark:bg-silver-900 p-2">
              {snippet}
            </pre>
          )}
        </>
      )}
      <Button loading={busy} disabled={!draft} onClick={() => void save()}>
        {t.save}
      </Button>
    </Card>
  );
}
