import { useState } from 'react';
import { fmt, formatDate, useAsync, useKit } from '../../kit';
import { Alert, Badge, Button, Card, Spinner, inputClass } from '../../kit/ui';
import { useAdminErrorText, useAdminTexts } from '../../lib/admin-mode-view';
import {
  ADMIN_TASK_TYPES,
  type AdminExportKind,
  type AdminInsightView,
} from '../../lib/admin-mode-api';
import { useAssist } from '../../lib/assist-context';
import { LoadError, NoticeBar, type Notice } from '../knowledge/parts';

/**
 * Заход 10, №57 (ТЗ §5-тер.13): аналитика «Админки» во вкладке
 * «Статистика (сотрудники)» — разметка диалогов ИИ агрегатами и её
 * настройки (минуты на тип задачи, отчёт недели), выводы недели со
 * статусами, выгрузки CSV. Только `assistAdmin: owner` (сервер — 403
 * остальным); рейтинга сотрудников нет.
 */
export function AdminAnalytics({
  siteId,
  days,
}: {
  siteId: string;
  days: 7 | 30;
}) {
  return (
    <div className="space-y-3">
      <LabelsCard siteId={siteId} days={days} />
      <InsightsCard siteId={siteId} />
      <ExportsCard siteId={siteId} />
    </div>
  );
}

const hours = (min: number) => String(Math.round((min / 60) * 10) / 10);

function LabelsCard({ siteId, days }: { siteId: string; days: 7 | 30 }) {
  const { adminMode } = useAssist();
  const t = useAdminTexts().analytics;
  const errText = useAdminErrorText();
  const st = useAsync(
    () => Promise.all([adminMode.labels(siteId, days), adminMode.get(siteId)]),
    [siteId, days]
  );
  const [draft, setDraft] = useState<{
    labeling?: boolean;
    weekly?: boolean;
    minutes?: Record<string, number>;
  }>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  if (st.loading && !st.data) return <Spinner />;
  if (st.error || !st.data)
    return <LoadError error={st.error} onRetry={st.reload} />;
  const [l, mode] = st.data;
  const labeling = draft.labeling ?? mode.analyticsLabeling;
  const weekly = draft.weekly ?? mode.weeklyReport;
  const minutes = draft.minutes ?? mode.analyticsTaskMinutes;
  const save = async () => {
    setBusy(true);
    try {
      await adminMode.patch(siteId, {
        analyticsLabeling: labeling,
        weeklyReport: weekly,
        analyticsTaskMinutes: minutes,
      });
      setDraft({});
      setNotice({ tone: 'success', text: t.saved2 });
      st.reload();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="text-sm space-y-2">
      <div className="font-semibold">{t.title}</div>
      <NoticeBar notice={notice} />
      {!l.labeling.enabled && <Alert tone="neutral">{t.labelingOff}</Alert>}
      {l.labeling.enabled && !l.labeling.model && (
        <Alert tone="neutral">{t.noModel}</Alert>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div>
          {t.conversations}: {l.conversations}
        </div>
        <div>
          {t.labeled}: {l.labeled}
        </div>
        <div>
          {t.found}: {l.answerYes}
        </div>
        <div>
          {t.partial}: {l.answerPartial}
        </div>
        <div>
          {t.notFound}: {l.answerNo}
        </div>
        <div>
          {t.toolErrors}: {l.toolErrors}
        </div>
      </div>
      {l.minutesSaved > 0 && (
        <div className="font-semibold">
          {fmt(t.saved, { hours: hours(l.minutesSaved) })}
        </div>
      )}
      {l.taskTypes.map((x) => (
        <div key={x.taskType}>
          {t.taskTypes[x.taskType]}: {x.count} · ✓ {x.found}
        </div>
      ))}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={labeling}
          onChange={(e) => setDraft({ ...draft, labeling: e.target.checked })}
        />
        {t.labeling}
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={weekly}
          onChange={(e) => setDraft({ ...draft, weekly: e.target.checked })}
        />
        {t.weeklyReport}
      </label>
      <div className="font-semibold pt-1">{t.minutesTitle}</div>
      <div className="text-xs text-silver-500">{t.minutesHint}</div>
      <div className="grid grid-cols-2 gap-2">
        {ADMIN_TASK_TYPES.map((k) => (
          <label key={k} className="text-xs space-y-1">
            <span className="block text-silver-500">{t.taskTypes[k]}</span>
            <input
              className={inputClass}
              type="number"
              min={0}
              max={480}
              value={minutes[k] ?? 0}
              onChange={(e) => {
                const n = Math.max(
                  0,
                  Math.min(480, Math.round(Number(e.target.value) || 0))
                );
                setDraft({ ...draft, minutes: { ...minutes, [k]: n } });
              }}
            />
          </label>
        ))}
      </div>
      <Button loading={busy} onClick={() => void save()}>
        {t.save}
      </Button>
    </Card>
  );
}

function FindingLine({ f }: { f: AdminInsightView['findings'][number] }) {
  const t = useAdminTexts().analytics;
  return (
    <div>
      •{' '}
      {fmt(t.findings[f.kind], {
        pct: f.pct ?? 0,
        value: f.value,
        n: f.n,
        task: f.taskType ? t.taskTypes[f.taskType] : '',
      })}
    </div>
  );
}

function InsightsCard({ siteId }: { siteId: string }) {
  const { adminMode } = useAssist();
  const { locale } = useKit();
  const t = useAdminTexts().analytics;
  const errText = useAdminErrorText();
  const st = useAsync(() => adminMode.insights(siteId), [siteId]);
  const [notice, setNotice] = useState<Notice | null>(null);
  if (st.loading && !st.data) return <Spinner />;
  if (st.error || !st.data)
    return <LoadError error={st.error} onRetry={st.reload} />;
  const act = async (
    id: string,
    body: Parameters<typeof adminMode.patchInsight>[2]
  ) => {
    try {
      await adminMode.patchInsight(siteId, id, body);
      st.reload();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    }
  };
  return (
    <Card className="text-sm space-y-2">
      <div className="font-semibold">{t.insightsTitle}</div>
      <NoticeBar notice={notice} />
      {st.data.length === 0 && (
        <div className="text-silver-500">{t.insightsNone}</div>
      )}
      {st.data.map((w) => {
        const covered = new Set(w.items.flatMap((i) => i.findingIds));
        return (
          <div key={w.id} className="space-y-1 border-t pt-2">
            <div className="flex items-center gap-2">
              <span className="font-medium">
                {fmt(t.week, { date: formatDate(w.weekStart, locale) })}
              </span>
              {w.status !== 'new' && (
                <Badge tone={w.status === 'done' ? 'success' : 'neutral'}>
                  {w.status === 'done' ? t.done : t.dismiss}
                </Badge>
              )}
            </div>
            {w.items.map((it, i) => (
              <div key={i}>
                • <b>{it[locale].title}</b> — {it[locale].action}
              </div>
            ))}
            {w.findings
              .filter((f) => !covered.has(f.id))
              .map((f) => (
                <FindingLine key={f.id} f={f} />
              ))}
            <div className="flex flex-wrap gap-2">
              {w.status === 'new' ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() => void act(w.id, { status: 'done' })}
                  >
                    {t.done}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void act(w.id, { status: 'dismissed' })}
                  >
                    {t.dismiss}
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => void act(w.id, { status: 'new' })}
                >
                  {t.reopen}
                </Button>
              )}
              <Button
                variant={w.feedback === 1 ? 'solid' : 'ghost'}
                onClick={() =>
                  void act(w.id, { feedback: w.feedback === 1 ? 0 : 1 })
                }
              >
                👍
              </Button>
              <Button
                variant={w.feedback === -1 ? 'solid' : 'ghost'}
                onClick={() =>
                  void act(w.id, { feedback: w.feedback === -1 ? 0 : -1 })
                }
              >
                👎
              </Button>
            </div>
          </div>
        );
      })}
    </Card>
  );
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function ExportsCard({ siteId }: { siteId: string }) {
  const { adminMode } = useAssist();
  const t = useAdminTexts().analytics;
  const errText = useAdminErrorText();
  const st = useAsync(() => adminMode.exports(siteId), [siteId]);
  const [kind, setKind] = useState<AdminExportKind>('daily');
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 30 * 864e5)));
  const [to, setTo] = useState(isoDay(new Date()));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const request = async () => {
    setBusy(true);
    try {
      await adminMode.requestExport(siteId, { kind, from, to });
      st.reload();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="text-sm space-y-2">
      <div className="font-semibold">{t.exportTitle}</div>
      <div className="text-xs text-silver-500">{t.exportHint}</div>
      <NoticeBar notice={notice} />
      <select
        className={inputClass}
        value={kind}
        onChange={(e) => setKind(e.target.value as AdminExportKind)}
      >
        {(['daily', 'labels', 'actions'] as const).map((k) => (
          <option key={k} value={k}>
            {t.exportKinds[k]}
          </option>
        ))}
      </select>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs">
          <span className="block text-silver-500">{t.exportFrom}</span>
          <input
            className={inputClass}
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="text-xs">
          <span className="block text-silver-500">{t.exportTo}</span>
          <input
            className={inputClass}
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
      </div>
      <Button loading={busy} onClick={() => void request()}>
        {t.exportRequest}
      </Button>
      {st.loading && !st.data && <Spinner />}
      {st.error && <LoadError error={st.error} onRetry={st.reload} />}
      {st.data?.map((x) => (
        <div key={x.id} className="flex flex-wrap items-center gap-2">
          <span>{t.exportKinds[x.kind]}</span>
          <Badge
            tone={
              x.status === 'done'
                ? 'success'
                : x.status === 'failed'
                  ? 'danger'
                  : 'neutral'
            }
          >
            {t.exportStatus[x.status]}
          </Badge>
          {x.rows !== null && <span>{x.rows}</span>}
          {x.url && (
            <a
              className="text-accent underline"
              href={x.url}
              target="_blank"
              rel="noreferrer"
            >
              {t.exportDownload}
            </a>
          )}
          {x.error === 'too_many_rows' && (
            <span className="text-xs text-silver-500">{t.exportTooMany}</span>
          )}
        </div>
      ))}
      {st.data &&
        st.data.some(
          (x) => x.status === 'queued' || x.status === 'running'
        ) && (
          <Button variant="ghost" onClick={st.reload}>
            ↻
          </Button>
        )}
    </Card>
  );
}
