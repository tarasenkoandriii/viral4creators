import { useState } from 'react';
import { ExternalLink, Sparkles } from 'lucide-react';
import { ApiError, fmt, useAsync, useKit } from '../../kit';
import { Alert, Badge, Button, Card, ScreenTitle, Spinner } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { navigate } from '../../lib/router';
import { useSetupErrorText } from '../../lib/use-error-text';
import { canManageWidget } from '../../lib/widget-view';
import {
  WIZARD_BUSINESS_TYPES,
  type CompletenessView,
  type WizardBusinessType,
  type WizardItemView,
  type WizardView,
} from '../../lib/wizard-api';
import {
  ConfirmButton,
  LoadError,
  NoticeBar,
  textareaClass,
  type Notice,
} from '../knowledge/parts';
import { Field, Select } from './controls';

/**
 * Мастер «Научите помощника» (§4-тер.9): 10 тем, черновики по сайту
 * (данные — только текстом), ответ владельца → проверенный ответ или
 * черновик персоны. Сервер и логика — W5; экран — W4.
 */
export function WizardScreen({ siteId }: { siteId: string }) {
  const { account, dict } = useKit();
  const { appDict, wizard } = useAssist();
  const ok = canManageWidget(account.me);
  const loaded = useAsync<WizardView | null>(async () => {
    if (!ok) return null;
    try {
      return await wizard.get(siteId);
    } catch (e) {
      if (
        e instanceof ApiError &&
        (e.code === 'WIZARD_NOT_STARTED' || e.status === 404)
      )
        return null;
      throw e;
    }
  }, [wizard, siteId, ok]);
  const [view, setView] = useState<WizardView | null>(null);
  if (!ok) return <Alert tone="warning">{appDict.setup.common.noAccess}</Alert>;
  if (loaded.loading && !loaded.data && !view)
    return <Spinner label={dict.common.loading} />;
  if (loaded.error && !view)
    return <LoadError error={loaded.error} onRetry={loaded.reload} />;
  const v = view ?? loaded.data;
  return v ? (
    <WizardBody siteId={siteId} view={v} onView={setView} />
  ) : (
    <WizardStart siteId={siteId} onView={setView} />
  );
}

function WizardStart({
  siteId,
  onView,
}: {
  siteId: string;
  onView: (v: WizardView) => void;
}) {
  const { appDict, wizard } = useAssist();
  const t = appDict.setup.wizard;
  const errText = useSetupErrorText();
  const [type, setType] = useState<WizardBusinessType>('shop');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      <p className="text-sm text-silver-500">{t.intro}</p>
      <NoticeBar notice={notice} />
      <Card className="space-y-3">
        <Field label={t.businessType}>
          <Select
            value={type}
            options={WIZARD_BUSINESS_TYPES}
            labels={t.types}
            onChange={setType}
          />
        </Field>
        <Button
          icon={<Sparkles size={16} />}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setNotice(null);
            try {
              onView(await wizard.start(siteId, type));
            } catch (e) {
              setNotice({ tone: 'danger', text: errText(e) });
            } finally {
              setBusy(false);
            }
          }}
        >
          {t.start}
        </Button>
      </Card>
    </div>
  );
}

function WizardBody({
  siteId,
  view,
  onView,
}: {
  siteId: string;
  view: WizardView;
  onView: (v: WizardView) => void;
}) {
  const { appDict, wizard } = useAssist();
  const t = appDict.setup.wizard;
  const errText = useSetupErrorText();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function run(
    key: string,
    fn: () => Promise<WizardView>,
    okText?: string
  ) {
    setBusy(key);
    setNotice(null);
    try {
      onView(await fn());
      if (okText) setNotice({ tone: 'success', text: okText });
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  const s = view.siteSummary;
  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      <p className="text-sm text-silver-500">{t.intro}</p>
      <NoticeBar notice={notice} />
      {view.status === 'done' && (
        <Alert tone="success">
          {t.done}
          <div className="mt-2">
            <Button
              variant="outline"
              onClick={() => navigate({ name: 'persona', siteId })}
            >
              {t.toPersona}
            </Button>
          </div>
        </Alert>
      )}
      {s && (
        <Card className="space-y-1 text-sm">
          <div className="font-semibold">{t.summary}</div>
          {s.about && <div>{s.about}</div>}
          {s.sections.length > 0 && (
            <div className="text-silver-500">
              {t.sections}: {s.sections.join(' · ')}
            </div>
          )}
          {(s.contacts.phones.length > 0 ||
            s.contacts.emails.length > 0 ||
            s.contacts.address) && (
            <div className="text-silver-500">
              {t.contacts}:{' '}
              {[...s.contacts.phones, ...s.contacts.emails, s.contacts.address]
                .filter(Boolean)
                .join(' · ')}
            </div>
          )}
          {s.hours && (
            <div className="text-silver-500">
              {t.hours}: {s.hours}
            </div>
          )}
        </Card>
      )}
      {view.status !== 'done' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            icon={<Sparkles size={16} />}
            loading={busy === 'drafts'}
            disabled={view.draftRunsLeft === 0}
            onClick={() => run('drafts', () => wizard.drafts(siteId))}
          >
            {t.drafts}
          </Button>
          <span className="text-xs text-silver-500">
            {fmt(t.draftsLeft, { n: view.draftRunsLeft })}
          </span>
        </div>
      )}
      {view.items.map((item) => (
        <WizardItem
          key={item.topic}
          item={item}
          busy={busy?.startsWith(`${item.topic}:`) ? busy : null}
          locked={view.status === 'done'}
          onAnswer={(status, answer) =>
            run(`${item.topic}:${status}`, () =>
              wizard.answer(
                siteId,
                item.topic,
                answer === undefined ? { status } : { status, answer }
              )
            )
          }
        />
      ))}
      {view.status !== 'done' && (
        <div className="space-y-1">
          <ConfirmButton
            variant="solid"
            hint={t.completeHint}
            loading={busy === 'complete'}
            onConfirm={() =>
              run('complete', () => wizard.complete(siteId), t.done)
            }
          >
            {t.complete}
          </ConfirmButton>
          <div className="text-xs text-silver-500">{t.completeHint}</div>
        </div>
      )}
    </div>
  );
}

function WizardItem({
  item,
  busy,
  locked,
  onAnswer,
}: {
  item: WizardItemView;
  busy: string | null;
  locked: boolean;
  onAnswer: (
    status: 'confirmed' | 'edited' | 'skipped',
    answer?: string
  ) => void;
}) {
  const { appDict } = useAssist();
  const t = appDict.setup.wizard;
  const [answer, setAnswer] = useState(item.answer ?? item.draft ?? '');
  const done = item.status !== 'pending';
  return (
    <Card className="space-y-2 text-sm">
      <div className="flex flex-wrap items-start gap-2">
        <div className="font-medium flex-1">{item.question}</div>
        <Badge
          tone={
            done
              ? item.status === 'skipped'
                ? 'neutral'
                : 'success'
              : 'warning'
          }
        >
          {t.status[item.status]}
        </Badge>
      </div>
      <div className="text-xs text-silver-500">{t.targets[item.target]}</div>
      <div className="rounded-lg bg-silver-100 dark:bg-silver-950 px-3 py-2">
        <div className="text-xs text-silver-500 mb-1">{t.draft}</div>
        {/* Черновик написан моделью по тексту чужого сайта — только как текст. */}
        <div className="whitespace-pre-wrap">{item.draft ?? t.noDraft}</div>
        {item.draftSources.length > 0 && (
          <div className="mt-1 text-xs text-silver-500 flex flex-wrap gap-2">
            <span>{t.sources}:</span>
            {item.draftSources.map((src, i) =>
              src.url ? (
                <a
                  key={i}
                  href={src.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 underline break-all"
                >
                  <ExternalLink size={12} /> {src.title ?? src.url}
                </a>
              ) : (
                <span key={i}>{src.title}</span>
              )
            )}
          </div>
        )}
      </div>
      {!locked && (
        <>
          <Field label={t.answer} htmlFor={`wz-${item.topic}`}>
            <textarea
              id={`wz-${item.topic}`}
              className={textareaClass}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            {item.draft && (
              <Button
                variant="outline"
                loading={busy === `${item.topic}:confirmed`}
                onClick={() => onAnswer('confirmed', item.draft ?? undefined)}
              >
                {t.yes}
              </Button>
            )}
            <Button
              variant="outline"
              loading={busy === `${item.topic}:edited`}
              disabled={!answer.trim()}
              onClick={() => onAnswer('edited', answer.trim())}
            >
              {t.saveAnswer}
            </Button>
            <Button
              variant="ghost"
              loading={busy === `${item.topic}:skipped`}
              onClick={() => onAnswer('skipped')}
            >
              {t.skip}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

/** «Полнота знаний» (§4-тер.9): чек-лист, не процент. На сводке знаний «Сайта». */
export function CompletenessCard({ siteId }: { siteId: string }) {
  const { account } = useKit();
  const { appDict, wizard } = useAssist();
  const t = appDict.setup.completeness;
  const ok = canManageWidget(account.me);
  const data = useAsync<CompletenessView | null>(async () => {
    if (!ok) return null;
    try {
      return await wizard.completeness(siteId);
    } catch {
      // Полнота — подсказка, а не экран: её сбой не ломает сводку знаний.
      return null;
    }
  }, [wizard, siteId, ok]);
  const c = data.data;
  if (!c) return null;
  const go = (n: CompletenessView['next'][number]) => {
    switch (n) {
      case 'run_wizard':
      case 'answer_topics':
        return navigate({ name: 'wizard', siteId });
      case 'review_quarantine':
        return navigate({
          name: 'knowledge',
          siteId,
          mode: 'site',
          tab: 'quarantine',
        });
      case 'add_documents':
        return navigate({
          name: 'knowledge',
          siteId,
          mode: 'site',
          tab: 'sources',
        });
      case 'publish_widget':
        return navigate({ name: 'widget', siteId, tab: 'look' });
    }
  };
  return (
    <Card className="space-y-2 text-sm">
      <div className="font-semibold">{t.title}</div>
      <div>
        {fmt(t.topics, { covered: c.topics.covered, total: c.topics.total })}
      </div>
      {c.topics.missing.length > 0 && (
        <div className="text-silver-500">
          {t.missing}: {c.topics.missing.map((m) => t.topicNames[m]).join(', ')}
        </div>
      )}
      <div className="text-silver-500">{fmt(t.pages, c.pages)}</div>
      <div className="text-silver-500">
        {c.quality.lastEvalAt && c.quality.passed !== null
          ? fmt(t.quality, {
              passed: c.quality.passed,
              failed: c.quality.failed ?? 0,
            })
          : t.qualityNone}
      </div>
      {c.goldenNeedsReview > 0 && (
        <div className="text-silver-500">
          {fmt(t.review, { n: c.goldenNeedsReview })}
        </div>
      )}
      {c.next.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {c.next.map((n) => (
            <Button key={n} variant="outline" onClick={() => go(n)}>
              {t.next[n]}
            </Button>
          ))}
        </div>
      )}
    </Card>
  );
}
