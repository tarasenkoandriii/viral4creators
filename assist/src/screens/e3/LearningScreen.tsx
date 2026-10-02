import { useState } from 'react';
import { fmt, formatDate, useAsync, useKit } from '../../kit';
import {
  Alert,
  Badge,
  Button,
  Card,
  ScreenTitle,
  Spinner,
  Tabs,
  inputClass,
} from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import {
  canResolveLearning,
  hasAssist,
  learningTabs,
  pct,
  usd,
  type LearningTab,
} from '../../lib/e3-view';
import {
  LEARNING_KINDS,
  type CandidateEntry,
  type ClusterEntry,
  type GoldenView,
  type LearningKind,
  type QueueDraftView,
  type QueueView,
  type SimulationView,
} from '../../lib/learning-types';
import { navigate } from '../../lib/router';
import { useE3ErrorText } from '../../lib/use-error-text';
import {
  ConfirmButton,
  LoadError,
  NoticeBar,
  textareaClass,
  type Notice,
} from '../knowledge/parts';
import { MiniTable } from './parts';

/** «Обучение → Сайт» (§4-тер.3–4, §4-тер.15): очередь, проверенные ответы, качество. */
export function LearningScreen({
  siteId,
  tab,
}: {
  siteId: string;
  tab: LearningTab;
}) {
  const { account } = useKit();
  const { appDict } = useAssist();
  const t = appDict.e3.learning;
  if (!hasAssist(account.me)) {
    return <Alert tone="warning">{appDict.e3.common.noAccessManager}</Alert>;
  }
  const tabs = learningTabs(account.me);
  const active = tabs.includes(tab) ? tab : 'queue';
  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      {tabs.length > 1 && (
        <Tabs
          label={t.title}
          active={active}
          onChange={(k) => navigate({ name: 'learning', siteId, tab: k }, true)}
          tabs={tabs.map((k) => ({ key: k, label: t.tabs[k] }))}
        />
      )}
      {active === 'queue' && <Queue siteId={siteId} />}
      {active === 'golden' && <Golden siteId={siteId} />}
      {active === 'quality' && <Quality siteId={siteId} />}
    </div>
  );
}

function Queue({ siteId }: { siteId: string }) {
  const { account, dict } = useKit();
  const { appDict, learning } = useAssist();
  const t = appDict.e3.learning;
  const manager = canResolveLearning(account.me);
  const [kind, setKind] = useState<LearningKind | 'all'>('all');
  const loaded = useAsync(
    () => learning.queue(siteId, kind === 'all' ? {} : { kind }),
    [learning, siteId, kind]
  );
  const [view, setView] = useState<QueueView | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const v = view ?? loaded.data;
  const reload = async () =>
    setView(await learning.queue(siteId, kind === 'all' ? {} : { kind }));

  return (
    <div className="space-y-3">
      {!manager && <Alert tone="neutral">{t.operatorNote}</Alert>}
      <NoticeBar notice={notice} />
      <div className="flex flex-wrap gap-1">
        {(['all', ...LEARNING_KINDS] as const).map((k) => (
          <Button
            key={k}
            variant={k === kind ? 'solid' : 'outline'}
            onClick={() => {
              setView(null);
              setKind(k);
            }}
          >
            {k === 'all' ? t.all : t.kinds[k]}
            {v && k !== 'all' && v.counts[k] > 0 ? ` · ${v.counts[k]}` : ''}
          </Button>
        ))}
      </div>
      {loaded.loading && !v ? (
        <Spinner label={dict.common.loading} />
      ) : !v ? (
        <LoadError error={loaded.error} onRetry={loaded.reload} />
      ) : v.entries.length === 0 ? (
        <Card className="text-sm">{t.empty}</Card>
      ) : (
        v.entries.map((en) =>
          en.entry === 'cluster' ? (
            <ClusterCard
              key={en.id}
              siteId={siteId}
              c={en}
              manager={manager}
              onDone={(text) => {
                setNotice({ tone: 'success', text });
                void reload();
              }}
              onError={(text) => setNotice({ tone: 'danger', text })}
            />
          ) : (
            <CandidateCard
              key={en.id}
              siteId={siteId}
              c={en}
              manager={manager}
              onDone={(text) => {
                setNotice({ tone: 'success', text });
                void reload();
              }}
              onError={(text) => setNotice({ tone: 'danger', text })}
            />
          )
        )
      )}
    </div>
  );
}

function ClusterCard({
  siteId,
  c,
  manager,
  onDone,
  onError,
}: {
  siteId: string;
  c: ClusterEntry;
  manager: boolean;
  onDone: (text: string) => void;
  onError: (text: string) => void;
}) {
  const { locale } = useKit();
  const { appDict, learning } = useAssist();
  const t = appDict.e3.learning;
  const errText = useE3ErrorText();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState(c.examples[0] ?? c.label);
  const [answer, setAnswer] = useState('');
  const [note, setNote] = useState('');
  const [draft, setDraft] = useState<QueueDraftView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(name: string, job: () => Promise<void>) {
    setBusy(name);
    try {
      await job();
    } catch (e) {
      onError(errText(e));
    } finally {
      setBusy(null);
    }
  }
  const resolve = (body: Parameters<typeof learning.resolve>[2]) =>
    act(body.action, async () => {
      await learning.resolve(siteId, c.id, body);
      onDone(t.done);
    });

  return (
    <Card className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{t.kinds[c.kind]}</Badge>
        {c.reopened && <Badge tone="warning">{t.reopened}</Badge>}
        <span className="text-xs text-silver-500">
          {fmt(t.size, { n: c.size })} ·{' '}
          {fmt(t.visitors, { n: c.distinctVisitors })} ·{' '}
          {formatDate(c.lastSeenAt, locale)}
        </span>
      </div>
      <div className="font-medium break-words">{c.label}</div>
      {c.examples.length > 0 && (
        <ul className="text-xs text-silver-600 dark:text-silver-300 list-disc pl-5">
          {c.examples.map((x, i) => (
            <li key={i} className="break-words">
              {x}
            </li>
          ))}
        </ul>
      )}
      {c.pages.length > 0 && (
        <div className="text-xs text-silver-500 break-all">
          {t.pages}: {c.pages.join(', ')}
        </div>
      )}
      {manager && c.status === 'open' && (
        <>
          {!open ? (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setOpen(true)}>{t.answer}</Button>
              <Button
                variant="outline"
                loading={busy === 'out_of_scope'}
                onClick={() => void resolve({ action: 'out_of_scope' })}
              >
                {t.outOfScope}
              </Button>
              <ConfirmButton
                variant="ghost"
                loading={busy === 'ignore'}
                onConfirm={() => void resolve({ action: 'ignore' })}
              >
                {t.ignore}
              </ConfirmButton>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="block text-xs font-medium">
                {t.question}
                <input
                  className={inputClass}
                  maxLength={300}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                />
              </label>
              <label className="block text-xs font-medium">
                {t.answerText}
                <textarea
                  className={textareaClass}
                  maxLength={2000}
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                />
              </label>
              {draft && (
                <div className="text-xs text-silver-500">
                  {draft.status === 'budget'
                    ? t.draftBudget
                    : draft.status === 'no_sources'
                      ? t.draftNoSources
                      : null}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  loading={busy === 'draft'}
                  onClick={() =>
                    void act('draft', async () => {
                      const d = await learning.draft(siteId, c.id);
                      setDraft(d);
                      if (d.status === 'ok' && d.text) setAnswer(d.text);
                    })
                  }
                >
                  {t.draft}
                </Button>
                <Button
                  loading={busy === 'golden'}
                  disabled={!question.trim() || !answer.trim()}
                  onClick={() =>
                    void resolve({
                      action: 'golden',
                      question: question.trim(),
                      answer: answer.trim(),
                      lang: c.lang,
                      variants: c.examples.filter((x) => x !== question),
                    })
                  }
                >
                  {t.publish}
                </Button>
              </div>
              <label className="block text-xs font-medium">
                {t.sourceNote}
                <input
                  className={inputClass}
                  maxLength={300}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <Button
                variant="outline"
                loading={busy === 'source'}
                onClick={() =>
                  void resolve({ action: 'source', note: note.trim() || null })
                }
              >
                {t.source}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function CandidateCard({
  siteId,
  c,
  manager,
  onDone,
  onError,
}: {
  siteId: string;
  c: CandidateEntry;
  manager: boolean;
  onDone: (text: string) => void;
  onError: (text: string) => void;
}) {
  const { locale } = useKit();
  const { appDict, learning } = useAssist();
  const t = appDict.e3.learning;
  const errText = useE3ErrorText();
  const [answer, setAnswer] = useState(c.proposedAnswer);
  const [busy, setBusy] = useState<string | null>(null);
  const resolve = async (
    name: string,
    body: Parameters<typeof learning.resolve>[2]
  ) => {
    setBusy(name);
    try {
      await learning.resolve(siteId, c.id, body);
      onDone(t.done);
    } catch (e) {
      onError(errText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{t.candidates}</Badge>
        <span className="text-xs text-silver-500">
          {fmt(t.proposedBy, {
            who: c.proposedByMe ? t.me : t.operator,
            date: formatDate(c.proposedAt, locale),
          })}{' '}
          · {t.status[c.status]}
        </span>
      </div>
      <div className="font-medium break-words">{c.questionMasked}</div>
      {manager && c.status === 'proposed' ? (
        <>
          <textarea
            aria-label={t.answerText}
            className={textareaClass}
            maxLength={2000}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              loading={busy === 'accept'}
              disabled={!answer.trim()}
              onClick={() =>
                void resolve('accept', {
                  action: 'accept',
                  answer:
                    answer.trim() === c.proposedAnswer ? null : answer.trim(),
                })
              }
            >
              {t.accept}
            </Button>
            <ConfirmButton
              variant="ghost"
              loading={busy === 'reject'}
              onConfirm={() => void resolve('reject', { action: 'reject' })}
            >
              {t.reject}
            </ConfirmButton>
          </div>
        </>
      ) : (
        <div className="whitespace-pre-wrap break-words text-silver-600 dark:text-silver-300">
          {c.proposedAnswer}
        </div>
      )}
      {c.conversationId && (
        <button
          type="button"
          className="text-xs underline text-silver-500"
          onClick={() =>
            navigate({
              name: 'dialog',
              siteId,
              cid: c.conversationId as string,
            })
          }
        >
          {appDict.e3.dialogs.title}
        </button>
      )}
    </Card>
  );
}

/** Проверенные ответы: только manager (оператору вкладка не показывается). */
function Golden({ siteId }: { siteId: string }) {
  const { account, dict, api, locale } = useKit();
  const { appDict, learning } = useAssist();
  const t = appDict.e3.learning;
  const errText = useE3ErrorText();
  const loaded = useAsync(() => learning.golden(siteId), [learning, siteId]);
  const sites = useAsync(() => api.listSites(), [api]);
  const [list, setList] = useState<GoldenView[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const [a, setA] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  if (!canResolveLearning(account.me)) {
    return <Alert tone="warning">{appDict.e3.common.noAccessManager}</Alert>;
  }
  const v = list ?? loaded.data;
  if (loaded.loading && !v) return <Spinner label={dict.common.loading} />;
  if (!v) return <LoadError error={loaded.error} onRetry={loaded.reload} />;
  const others = (sites.data ?? []).filter((s) => s.id !== siteId);

  async function act(name: string, job: () => Promise<string | void>) {
    setBusy(name);
    setNotice(null);
    try {
      const text = await job();
      setList(await learning.golden(siteId));
      if (text) setNotice({ tone: 'success', text });
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <NoticeBar notice={notice} />
      {v.length === 0 && <Card className="text-sm">{t.goldenEmpty}</Card>}
      {v.map((g) => (
        <Card key={g.id} className="space-y-1 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="checkbox"
              aria-label={t.copyTo}
              checked={picked.includes(g.id)}
              onChange={(e) =>
                setPicked(
                  e.target.checked
                    ? [...picked, g.id]
                    : picked.filter((x) => x !== g.id)
                )
              }
            />
            <Badge
              tone={
                g.status === 'active'
                  ? 'success'
                  : g.status === 'needs_review'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {t.goldenStatus[g.status]}
            </Badge>
            <span className="text-xs text-silver-500">
              {t.origins[g.origin]}
            </span>
            {g.reviewAt && (
              <span className="text-xs text-silver-500">
                {fmt(t.reviewAt, { date: formatDate(g.reviewAt, locale) })}
              </span>
            )}
          </div>
          <div className="font-medium break-words">{g.question}</div>
          <div className="whitespace-pre-wrap break-words">{g.answer}</div>
          {g.conflictNote && (
            <Alert tone="warning">
              {fmt(t.conflict, { note: g.conflictNote })}
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            {g.status === 'needs_review' && (
              <Button
                variant="outline"
                loading={busy === `rev-${g.id}`}
                onClick={() =>
                  void act(`rev-${g.id}`, async () => {
                    await learning.patchGolden(siteId, g.id, {
                      reviewed: true,
                    });
                  })
                }
              >
                {t.reviewed}
              </Button>
            )}
            <Button
              variant="outline"
              loading={busy === `arc-${g.id}`}
              onClick={() =>
                void act(`arc-${g.id}`, async () => {
                  await learning.patchGolden(siteId, g.id, {
                    status: g.status === 'archived' ? 'active' : 'archived',
                  });
                })
              }
            >
              {g.status === 'archived' ? t.restore : t.archive}
            </Button>
            <ConfirmButton
              variant="ghost"
              loading={busy === `del-${g.id}`}
              onConfirm={() =>
                void act(`del-${g.id}`, () =>
                  learning.deleteGolden(siteId, g.id)
                )
              }
            >
              {appDict.e3.common.remove}
            </ConfirmButton>
          </div>
        </Card>
      ))}

      {adding ? (
        <Card className="space-y-2">
          <input
            aria-label={t.question}
            placeholder={t.question}
            className={inputClass}
            maxLength={300}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <textarea
            aria-label={t.answerText}
            placeholder={t.answerText}
            className={textareaClass}
            maxLength={2000}
            value={a}
            onChange={(e) => setA(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              loading={busy === 'add'}
              disabled={!q.trim() || !a.trim()}
              onClick={() =>
                void act('add', async () => {
                  await learning.createGolden(siteId, {
                    question: q.trim(),
                    answer: a.trim(),
                  });
                  setAdding(false);
                  setQ('');
                  setA('');
                })
              }
            >
              {t.publish}
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              {appDict.e3.common.cancel}
            </Button>
          </div>
        </Card>
      ) : (
        <Button onClick={() => setAdding(true)}>{t.goldenAdd}</Button>
      )}

      {others.length > 0 && v.length > 0 && (
        <Card className="space-y-2">
          <div className="text-sm font-medium">{t.copyTo}</div>
          <div className="text-xs text-silver-500">{t.copyPick}</div>
          <select
            aria-label={t.copyTo}
            className={inputClass}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">—</option>
            {others.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            disabled={!target || picked.length === 0}
            loading={busy === 'copy'}
            onClick={() =>
              void act('copy', async () => {
                const r = await learning.copyGolden(siteId, target, picked);
                setPicked([]);
                return fmt(t.copied, { n: r.copied, m: r.skipped.length });
              })
            }
          >
            {t.copyTo}
          </Button>
        </Card>
      )}
    </div>
  );
}

function Quality({ siteId }: { siteId: string }) {
  const { account, dict, locale } = useKit();
  const { appDict, learning } = useAssist();
  const t = appDict.e3.learning;
  const errText = useE3ErrorText();
  const loaded = useAsync(() => learning.quality(siteId), [learning, siteId]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sim, setSim] = useState<SimulationView | null>(null);
  if (!canResolveLearning(account.me)) {
    return <Alert tone="warning">{appDict.e3.common.noAccessManager}</Alert>;
  }
  const q = loaded.data;
  if (loaded.loading && !q) return <Spinner label={dict.common.loading} />;
  if (!q) return <LoadError error={loaded.error} onRetry={loaded.reload} />;

  async function run(name: string, job: () => Promise<void>) {
    setBusy(name);
    setNotice(null);
    try {
      await job();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <NoticeBar notice={notice} />
      <Card className="space-y-1 text-sm">
        <div>{fmt(t.completeness, q.completeness)}</div>
        <div>
          {fmt(t.budget, {
            spent: usd(q.learningBudget.spentMicroUsd),
            cap: usd(q.learningBudget.capMicroUsd),
            period: q.learningBudget.period,
          })}
        </div>
        {q.nextScheduledEvalAt && (
          <div className="text-silver-500">
            {fmt(t.nextEval, {
              date: formatDate(q.nextScheduledEvalAt, locale),
            })}
          </div>
        )}
        {q.goldenNeedsReview > 0 && (
          <div>{fmt(t.needsReview, { n: q.goldenNeedsReview })}</div>
        )}
      </Card>
      <Card className="space-y-2 text-sm">
        {q.lastEval ? (
          <>
            <div>
              {fmt(t.lastEval, { date: formatDate(q.lastEval.at, locale) })} —{' '}
              {fmt(t.evalCounts, {
                passed: q.lastEval.passed,
                failed: q.lastEval.failed,
                stale: q.lastEval.stale,
              })}
            </div>
            {q.lastEval.failures.map((f, i) => (
              <div
                key={i}
                className="text-xs border-t border-silver-200 dark:border-silver-800 pt-1"
              >
                <div className="font-medium break-words">{f.question}</div>
                {f.expected && (
                  <div>{fmt(t.expected, { text: f.expected })}</div>
                )}
                <div>{fmt(t.got, { text: f.got })}</div>
                <div className="text-silver-500">{f.reason}</div>
              </div>
            ))}
          </>
        ) : (
          <div>{t.noEval}</div>
        )}
        <Button
          variant="outline"
          loading={busy === 'eval'}
          onClick={() =>
            void run('eval', async () => {
              const r = await learning.evalRun(siteId);
              setNotice(
                r.status === 'deferred'
                  ? { tone: 'warning', text: t.evalDeferred }
                  : {
                      tone: 'success',
                      text: fmt(t.evalDone, {
                        passed: r.passed,
                        failed: r.failed,
                      }),
                    }
              );
              loaded.reload();
            })
          }
        >
          {t.runEval}
        </Button>
      </Card>
      {q.weekly.length > 0 && (
        <Card className="space-y-1">
          <div className="text-sm font-medium">{t.weekly}</div>
          <MiniTable
            head={[
              t.weeklyCols.week,
              t.weeklyCols.dialogs,
              t.weeklyCols.unknown,
              t.weeklyCols.up,
              t.weeklyCols.handoff,
            ]}
            rows={q.weekly.map((w) => [
              w.weekStart,
              w.dialogs,
              pct(w.unknownShare),
              pct(w.thumbsUpShare),
              pct(w.handoffShare),
            ])}
          />
        </Card>
      )}
      <Card className="space-y-2 text-sm">
        <Button
          variant="outline"
          loading={busy === 'sim'}
          onClick={() =>
            void run('sim', async () => {
              const r = await learning.simulate(siteId);
              setSim(r);
              if (r.status === 'deferred') {
                setNotice({ tone: 'warning', text: t.simDeferred });
              }
            })
          }
        >
          {t.simulate}
        </Button>
        {sim?.personas.map((p) => (
          <div
            key={p.key}
            className="border-t border-silver-200 dark:border-silver-800 pt-1 space-y-1"
          >
            <div className="font-medium">{p.title}</div>
            {p.turns.map((turn, i) => (
              <div key={i} className="text-xs space-y-0.5">
                <div className="break-words">— {turn.question}</div>
                <div className="break-words text-silver-600 dark:text-silver-300">
                  {turn.refused ? `[${t.refused}] ` : ''}
                  {turn.answer}
                </div>
              </div>
            ))}
            {p.issues.length > 0 && (
              <div className="text-xs text-amber-600">
                {fmt(t.issues, { list: p.issues.join(', ') })}
              </div>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}
