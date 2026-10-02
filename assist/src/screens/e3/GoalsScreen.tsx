import { useEffect, useRef, useState } from 'react';
import { fmt, formatDate, useAsync, useKit } from '../../kit';
import {
  Alert,
  Badge,
  Button,
  Card,
  ScreenTitle,
  Spinner,
  inputClass,
} from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import {
  GOAL_POLL_MS,
  canManageSecrets,
  canSeeStats,
  pickedDetector,
  pickerShouldPoll,
  templateDetectors,
} from '../../lib/e3-view';
import {
  GOAL_KEY,
  GOAL_LIMITS,
  GOAL_TEMPLATES,
  VALUE_MODES,
  type GoalDetector,
  type GoalInput,
  type GoalPickerStatusView,
  type GoalPickerTokenView,
  type GoalRecentEventView,
  type GoalView,
} from '../../lib/stats-types';
import { useE3ErrorNotice, useE3ErrorText } from '../../lib/use-error-text';
import {
  ConfirmButton,
  LoadError,
  NoticeBar,
  type Notice,
} from '../knowledge/parts';
import { Field, NumberInput, Select } from '../widget/controls';
import { ManagerOnly } from './parts';
import { openExternal } from '../../lib/open-link';

/** Детектор → короткая подпись. */
function detectorText(
  d: GoalDetector,
  t: ReturnType<typeof useAssist>['appDict']['e3']['goals']
): string {
  if (d.kind === 'click' && 'auto' in d.config) return t.auto[d.config.auto];
  if (d.kind === 'url') return `${t.detectorKinds.url}: ${d.config.pathMask}`;
  if (
    (d.kind === 'click' || d.kind === 'form_submit') &&
    'descriptor' in d.config
  ) {
    const de = d.config.descriptor;
    return `${t.detectorKinds[d.kind]}: ${
      de.assistGoal ?? de.text ?? de.assistId ?? de.role ?? '—'
    }`;
  }
  return t.detectorKinds[d.kind];
}

/** Цели сайта (§5-тер.1): шаблоны, детекторы, выбор на сайте, проверка. */
export function GoalsScreen({ siteId }: { siteId: string }) {
  const { account, dict, api, locale } = useKit();
  const { appDict, stats } = useAssist();
  const t = appDict.e3.goals;
  const errNotice = useE3ErrorNotice();
  const ok = canSeeStats(account.me);
  const loaded = useAsync(
    () => (ok ? stats.goals(siteId) : Promise.resolve([] as GoalView[])),
    [stats, siteId, ok]
  );
  const sites = useAsync(
    () => (ok ? api.listSites() : Promise.resolve([])),
    [api, ok]
  );
  const [goals, setGoals] = useState<GoalView[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [orderId, setOrderId] = useState('');

  if (!ok) return <ManagerOnly />;
  const list = goals ?? loaded.data;
  if (loaded.loading && !list) return <Spinner label={dict.common.loading} />;
  if (!list) return <LoadError error={loaded.error} onRetry={loaded.reload} />;
  const site = sites.data?.find((s) => s.id === siteId);
  const verifiedHosts = (site?.hosts ?? []).filter(
    (h) => h.status === 'verified'
  );

  async function act(name: string, job: () => Promise<void>) {
    setBusy(name);
    setNotice(null);
    try {
      await job();
    } catch (e) {
      setNotice(errNotice(e));
    } finally {
      setBusy(null);
    }
  }
  const reload = async () => setGoals(await stats.goals(siteId));

  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      <p className="text-sm text-silver-500">{t.intro}</p>
      <NoticeBar notice={notice} />
      {list.length === 0 && <Card className="text-sm">{t.empty}</Card>}
      {list.map((g) => (
        <Card key={g.id} className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold flex-1 min-w-0 truncate">
              {g.name || g.key}
            </span>
            <Badge
              tone={
                g.status === 'active'
                  ? 'success'
                  : g.status === 'stale'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {t.status[g.status]}
            </Badge>
          </div>
          <div className="text-xs text-silver-500">
            {t.templates[g.template]} ·{' '}
            <span className="font-mono">{g.key}</span> ·{' '}
            {g.lastFiredAt
              ? fmt(t.lastFired, { date: formatDate(g.lastFiredAt, locale) })
              : t.never}
          </div>
          <ul className="text-sm list-disc pl-5">
            {g.detectors.map((d, i) => (
              <li key={i} className="break-words">
                {detectorText(d, t)}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => setChecking(checking === g.id ? null : g.id)}
            >
              {checking === g.id ? t.stopCheck : t.check}
            </Button>
            <Button
              variant="outline"
              loading={busy === `st-${g.id}`}
              onClick={() =>
                void act(`st-${g.id}`, async () => {
                  await stats.patchGoal(siteId, g.id, {
                    status: g.status === 'paused' ? 'active' : 'paused',
                  });
                  await reload();
                })
              }
            >
              {g.status === 'paused' ? t.resume : t.pause}
            </Button>
            <ConfirmButton
              variant="ghost"
              loading={busy === `del-${g.id}`}
              onConfirm={() =>
                void act(`del-${g.id}`, async () => {
                  await stats.deleteGoal(siteId, g.id);
                  setNotice({ tone: 'success', text: t.deleted });
                  await reload();
                })
              }
            >
              {appDict.e3.common.remove}
            </ConfirmButton>
          </div>
          {checking === g.id && <GoalCheck siteId={siteId} goalId={g.id} />}
        </Card>
      ))}

      {list.length >= GOAL_LIMITS.perSite ? (
        <Alert tone="neutral">{fmt(t.limit, { n: GOAL_LIMITS.perSite })}</Alert>
      ) : adding ? (
        <GoalForm
          siteId={siteId}
          taken={list.map((g) => g.key)}
          hosts={verifiedHosts.map((h) => ({ id: h.id, host: h.host }))}
          onCancel={() => setAdding(false)}
          onCreated={async () => {
            setAdding(false);
            setNotice({ tone: 'success', text: t.created });
            await reload();
          }}
        />
      ) : (
        <Button onClick={() => setAdding(true)}>{t.add}</Button>
      )}

      {canManageSecrets(account.me) && (
        <Card className="space-y-2">
          <div className="text-sm font-medium">{t.deleteOrder}</div>
          <input
            aria-label={t.orderId}
            placeholder={t.orderId}
            className={inputClass}
            maxLength={64}
            value={orderId}
            onChange={(e) => setOrderId(e.target.value.trim())}
          />
          <ConfirmButton
            variant="outline"
            disabled={!/^[A-Za-z0-9._:-]{1,64}$/.test(orderId)}
            loading={busy === 'order'}
            onConfirm={() =>
              void act('order', async () => {
                const r = await stats.deleteGoalEvents(siteId, orderId);
                setOrderId('');
                setNotice({
                  tone: 'success',
                  text: fmt(t.deletedEvents, { n: r.deleted }),
                });
              })
            }
          >
            {t.deleteOrder}
          </ConfirmButton>
        </Card>
      )}
    </div>
  );
}

/** «Проверить цель»: последние события, опрос каждые 3 с, пока открыто. */
function GoalCheck({ siteId, goalId }: { siteId: string; goalId: string }) {
  const { locale } = useKit();
  const { appDict, stats } = useAssist();
  const t = appDict.e3.goals;
  const [events, setEvents] = useState<GoalRecentEventView[] | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      stats.recent(siteId, goalId).then(
        (r) => alive && setEvents(r),
        () => undefined
      );
    void tick();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void tick();
    }, GOAL_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [stats, siteId, goalId]);
  return (
    <div className="rounded-lg border border-dashed border-silver-300 dark:border-silver-700 p-2 space-y-1 text-sm">
      <div className="text-xs text-silver-500">{t.checkHint}</div>
      {events && events.length === 0 && <div>{t.checkEmpty}</div>}
      {(events ?? []).map((ev) => (
        <div key={ev.id} className="flex flex-wrap gap-2 text-xs">
          <span>{formatDate(ev.occurredAt, locale)}</span>
          <span>{t.trust[ev.trust]}</span>
          <span>{appDict.e3.stats.attribution[ev.attribution]}</span>
          <span>{t.eventStatus[ev.status]}</span>
          {ev.path && <span className="font-mono break-all">{ev.path}</span>}
          {ev.value !== null && (
            <span>
              {ev.value} {ev.currency ?? ''}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function GoalForm({
  siteId,
  taken,
  hosts,
  onCancel,
  onCreated,
}: {
  siteId: string;
  taken: string[];
  hosts: Array<{ id: string; host: string }>;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const { appDict, stats } = useAssist();
  const t = appDict.e3.goals;
  const errNotice = useE3ErrorNotice();
  const [g, setG] = useState<GoalInput>(() => ({
    key: taken.includes('lead') ? '' : 'lead',
    template: 'lead',
    name: t.templates.lead,
    detectors: templateDetectors('lead'),
    valueMode: 'none',
    fixedValue: null,
    currency: null,
  }));
  const [urlMask, setUrlMask] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Notice | null>(null);
  const keyOk = GOAL_KEY.test(g.key) && !taken.includes(g.key);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await stats.createGoal(siteId, g);
      onCreated();
    } catch (e) {
      setError(errNotice(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3">
      <Field label={t.template}>
        <Select
          value={g.template}
          options={GOAL_TEMPLATES}
          labels={t.templates}
          onChange={(template) =>
            setG({
              ...g,
              template,
              name: t.templates[template],
              key: taken.includes(template) ? g.key : template,
              detectors: templateDetectors(template),
            })
          }
        />
      </Field>
      <Field label={t.key}>
        <input
          className={`${inputClass} font-mono`}
          maxLength={40}
          value={g.key}
          onChange={(e) =>
            setG({ ...g, key: e.target.value.toLowerCase().trim() })
          }
        />
      </Field>
      <Field label={t.name}>
        <input
          className={inputClass}
          maxLength={GOAL_LIMITS.nameChars}
          value={g.name}
          onChange={(e) => setG({ ...g, name: e.target.value })}
        />
      </Field>
      <div className="space-y-1">
        <div className="text-sm font-medium">{t.detectors}</div>
        <ul className="text-sm list-disc pl-5">
          {g.detectors.map((d, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="flex-1 break-words">{detectorText(d, t)}</span>
              <button
                type="button"
                aria-label={appDict.e3.common.remove}
                className="text-silver-500"
                onClick={() =>
                  setG({
                    ...g,
                    detectors: g.detectors.filter((_, j) => j !== i),
                  })
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        {g.detectors.length < GOAL_LIMITS.detectorsPerGoal && (
          <div className="flex flex-wrap items-end gap-2">
            <input
              aria-label={t.pathMask}
              placeholder="/thank-you*"
              className={`${inputClass} flex-1 font-mono`}
              maxLength={200}
              value={urlMask}
              onChange={(e) => setUrlMask(e.target.value.trim())}
            />
            <Button
              variant="outline"
              disabled={!/^\/\S*$/.test(urlMask)}
              onClick={() => {
                setG({
                  ...g,
                  detectors: [
                    ...g.detectors,
                    {
                      kind: 'url',
                      config: { pathMask: urlMask, fromPathMask: null },
                    },
                  ],
                });
                setUrlMask('');
              }}
            >
              {t.detectorKinds.url}
            </Button>
          </div>
        )}
        {g.detectors.length < GOAL_LIMITS.detectorsPerGoal && (
          <Picker
            siteId={siteId}
            hosts={hosts}
            onPicked={(d) => setG({ ...g, detectors: [...g.detectors, d] })}
          />
        )}
      </div>
      <Field label={t.valueMode}>
        <Select
          value={g.valueMode}
          options={VALUE_MODES}
          labels={t.valueModes}
          onChange={(valueMode) =>
            setG({
              ...g,
              valueMode,
              fixedValue: valueMode === 'fixed' ? (g.fixedValue ?? 0) : null,
              currency: valueMode === 'none' ? null : (g.currency ?? 'UAH'),
            })
          }
        />
      </Field>
      {g.valueMode === 'fixed' && (
        <Field label={t.fixedValue}>
          <NumberInput
            value={g.fixedValue ?? 0}
            min={0}
            max={10_000_000}
            onChange={(n) => setG({ ...g, fixedValue: n })}
          />
        </Field>
      )}
      {g.valueMode !== 'none' && (
        <Field label={t.currency}>
          <input
            className={inputClass}
            maxLength={3}
            value={g.currency ?? ''}
            onChange={(e) =>
              setG({ ...g, currency: e.target.value.toUpperCase() })
            }
          />
        </Field>
      )}
      <NoticeBar notice={error} />
      <div className="flex gap-2">
        <Button
          loading={busy}
          disabled={!keyOk || !g.name.trim() || g.detectors.length === 0}
          onClick={() => void create()}
        >
          {t.add}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {appDict.e3.common.cancel}
        </Button>
      </div>
    </Card>
  );
}

/**
 * «Выбрать на сайте» (§5-тер.1 WYSIWYG, контракт §5 T ↔ A): токен →
 * ссылка во внешнем браузере → опрос статуса 3 с → «считать целью?».
 */
function Picker({
  siteId,
  hosts,
  onPicked,
}: {
  siteId: string;
  hosts: Array<{ id: string; host: string }>;
  onPicked: (d: GoalDetector) => void;
}) {
  const { appDict, stats } = useAssist();
  const t = appDict.e3.goals;
  const errText = useE3ErrorText();
  const [hostId, setHostId] = useState(hosts[0]?.id ?? '');
  const [path, setPath] = useState('');
  const [token, setToken] = useState<GoalPickerTokenView | null>(null);
  const [status, setStatus] = useState<GoalPickerStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Текст ошибки — через ref: функция новая на каждый рендер, а опрос
  // не должен перезапускаться от этого.
  const errRef = useRef(errText);
  errRef.current = errText;

  const polling = pickerShouldPoll(token?.tokenId ?? null, status);
  useEffect(() => {
    if (!token || !polling) return;
    timer.current = setInterval(() => {
      stats.pickerStatus(siteId, token.tokenId).then(setStatus, (e) => {
        setError(errRef.current(e));
      });
    }, GOAL_POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [token, polling, stats, siteId]);

  if (hosts.length === 0) {
    return <div className="text-xs text-silver-500">{t.pickNoHosts}</div>;
  }

  async function start() {
    setError(null);
    setStatus(null);
    try {
      const tok = await stats.pickerToken(siteId, {
        hostId,
        ...(path.startsWith('/') ? { path } : {}),
      });
      if (!tok.url || !tok.tokenId) throw new Error('picker');
      setToken(tok);
      openExternal(tok.url);
    } catch (e) {
      setError(errText(e));
    }
  }

  const r = status?.result;
  return (
    <div className="rounded-lg border border-silver-200 dark:border-silver-800 p-2 space-y-2 text-sm">
      <div className="font-medium">{t.pick}</div>
      <Field label={t.pickHost}>
        <Select
          value={hostId}
          options={hosts.map((h) => h.id)}
          labels={Object.fromEntries(hosts.map((h) => [h.id, h.host]))}
          onChange={setHostId}
        />
      </Field>
      <Field label={t.pickPath}>
        <input
          className={`${inputClass} font-mono`}
          maxLength={200}
          placeholder="/"
          value={path}
          onChange={(e) => setPath(e.target.value.trim())}
        />
      </Field>
      <Button variant="outline" onClick={() => void start()}>
        {t.pickStart}
      </Button>
      {token && !status && <div className="text-xs">{t.pickOpen}</div>}
      {status?.status === 'waiting' && (
        <div className="text-xs">{t.pickWaiting}</div>
      )}
      {status?.status === 'expired' && (
        <Alert tone="warning">{t.pickExpired}</Alert>
      )}
      {r && pickedDetector(status) && (
        <div className="space-y-1">
          <div>
            {fmt(t.picked, {
              label: r.label,
              kind: t.detectorKinds[r.kind],
              path: r.path,
            })}
          </div>
          <Button
            onClick={() => {
              const d = pickedDetector(status);
              if (d) onPicked(d);
              setToken(null);
              setStatus(null);
            }}
          >
            {t.pickConfirm}
          </Button>
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
