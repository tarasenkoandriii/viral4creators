import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Flag, UserCheck } from 'lucide-react';
import { fmt, formatDate, useAsync, useKit } from '../../kit';
import {
  Alert,
  Badge,
  Button,
  Card,
  ScreenTitle,
  Spinner,
  Tabs,
} from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import {
  DIALOG_POLL_MS,
  dialogViews,
  handoffActions,
  hasAssist,
  isAssistManager,
  shouldPollDialog,
} from '../../lib/e3-view';
import type {
  ConversationListItem,
  ConversationMessageView,
  ConversationView,
  ConversationViewKind,
  HandoffDraft,
  HandoffState,
} from '../../lib/handoff-types';
import { navigate } from '../../lib/router';
import { useE3ErrorText } from '../../lib/use-error-text';
import {
  LoadError,
  textareaClass,
  type Notice,
  NoticeBar,
} from '../knowledge/parts';
import { openExternal } from '../../lib/open-link';
import { SiteE3Buttons, SitePickerScreen } from './parts';

const STATE_TONE: Record<
  HandoffState,
  'accent' | 'warning' | 'neutral' | 'danger'
> = {
  waiting: 'warning',
  active: 'accent',
  closed: 'neutral',
  missed: 'danger',
  cancelled: 'neutral',
};

/** Раздел «Диалоги» из навигации: выбор сайта. */
export function DialogsHome() {
  const { account } = useKit();
  const { appDict } = useAssist();
  const t = appDict.e3.dialogs;
  if (!hasAssist(account.me)) {
    return <Alert tone="warning">{appDict.e3.common.noAccessManager}</Alert>;
  }
  return (
    <div className="space-y-4">
      <SitePickerScreen
        title={t.title}
        intro={t.intro}
        render={(s) => <SiteE3Buttons siteId={s.id} />}
      />
      {isAssistManager(account.me) && (
        <Button
          variant="outline"
          onClick={() => navigate({ name: 'stats-sites' })}
        >
          {appDict.e3.stats.sitesTitle}
        </Button>
      )}
    </div>
  );
}

/** Лента диалогов сайта (§5-тер.6 «Диалоги»): передачи / мои / все. */
export function DialogsScreen({ siteId }: { siteId: string }) {
  const { account, dict, locale } = useKit();
  const { appDict, handoff } = useAssist();
  const t = appDict.e3.dialogs;
  const errText = useE3ErrorText();
  const views = dialogViews(account.me);
  const [view, setView] = useState<ConversationViewKind>('handoff');
  const [flagged, setFlagged] = useState(false);
  const [items, setItems] = useState<ConversationListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(
    async (after: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const r = await handoff.list(siteId, {
          view,
          cursor: after,
          flagged: flagged ? true : null,
          limit: 30,
        });
        setItems((prev) => (after ? [...prev, ...r.items] : r.items));
        setCursor(r.nextCursor);
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
      }
    },
    [handoff, siteId, view, flagged]
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  if (!hasAssist(account.me)) {
    return <Alert tone="warning">{appDict.e3.common.noAccessManager}</Alert>;
  }

  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      <Tabs
        label={t.title}
        active={view}
        onChange={setView}
        tabs={views.map((k) => ({ key: k, label: t.views[k] }))}
      />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={flagged}
          onChange={(e) => setFlagged(e.target.checked)}
        />
        {t.flaggedOnly}
      </label>
      {error !== null && (
        <Alert tone="danger">
          {errText(error)}
          <div className="mt-2">
            <Button variant="outline" onClick={() => void load(null)}>
              {dict.common.retry}
            </Button>
          </div>
        </Alert>
      )}
      {items.length === 0 && !loading && error === null && (
        <Card className="text-sm text-silver-500">{t.empty}</Card>
      )}
      {items.map((c) => (
        <Card key={c.id} className="space-y-1">
          <button
            type="button"
            className="w-full text-left space-y-1"
            onClick={() => navigate({ name: 'dialog', siteId, cid: c.id })}
          >
            <div className="flex flex-wrap items-center gap-2 text-xs text-silver-500">
              <span>{formatDate(c.lastMessageAt, locale)}</span>
              {c.handoff && (
                <Badge tone={STATE_TONE[c.handoff.state]}>
                  {t.states[c.handoff.state]}
                </Badge>
              )}
              {c.handoff?.assignedToMe && (
                <span className="inline-flex items-center gap-1">
                  <UserCheck size={12} /> {t.takenByMe}
                </span>
              )}
              {c.flagged && (
                <span className="inline-flex items-center gap-1">
                  <Flag size={12} /> {t.flagged}
                </span>
              )}
              {c.hasLead && <span>{t.lead}</span>}
              <span>{fmt(t.messages, { n: c.messages })}</span>
            </div>
            <div className="text-sm line-clamp-2 break-words">
              {c.preview || '—'}
            </div>
          </button>
        </Card>
      ))}
      {loading && <Spinner label={dict.common.loading} />}
      {cursor && !loading && (
        <Button variant="outline" onClick={() => void load(cursor)}>
          {t.more}
        </Button>
      )}
    </div>
  );
}

function MessageBubble({
  m,
  showTrace,
}: {
  m: ConversationMessageView;
  showTrace: boolean;
}) {
  const { locale } = useKit();
  const { appDict } = useAssist();
  const t = appDict.e3.dialogs;
  const [why, setWhy] = useState(false);
  const mine = m.role === 'operator' || m.role === 'assistant';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 space-y-1 text-sm ${
          m.role === 'visitor'
            ? 'bg-silver-200/70 dark:bg-silver-800/70'
            : m.role === 'operator'
              ? 'bg-accent/15'
              : m.role === 'system'
                ? 'bg-transparent border border-silver-300 dark:border-silver-700 text-silver-500'
                : 'bg-silver-100 dark:bg-silver-900'
        }`}
      >
        <div className="text-[11px] text-silver-500">
          {t.roles[m.role]}
          {m.authorIsMe && ` (${t.you})`} · {formatDate(m.createdAt, locale)}
        </div>
        <div className="whitespace-pre-wrap break-words">{m.text}</div>
        {m.translation && (
          <div className="border-t border-silver-300/60 dark:border-silver-700/60 pt-1 text-silver-600 dark:text-silver-300">
            <div className="text-[11px] text-silver-500">
              {fmt(t.translation, { lang: m.translation.lang })}
            </div>
            <div className="whitespace-pre-wrap break-words">
              {m.translation.text}
            </div>
          </div>
        )}
        {m.sources.length > 0 && (
          <div className="text-[11px] text-silver-500 space-y-0.5">
            <div>{t.sources}</div>
            {m.sources.map((s) =>
              s.url ? (
                <button
                  key={`${s.n}-${s.url}`}
                  type="button"
                  className="flex items-center gap-1 underline text-left"
                  onClick={() => openExternal(s.url as string)}
                >
                  <ExternalLink size={11} /> [{s.n}] {s.title ?? s.url}
                </button>
              ) : (
                <div key={s.n}>
                  [{s.n}] {s.title ?? ''}
                </div>
              )
            )}
          </div>
        )}
        {showTrace && m.trace && (
          <div className="text-[11px]">
            <button
              type="button"
              className="underline text-silver-500"
              onClick={() => setWhy((v) => !v)}
              aria-expanded={why}
            >
              {t.why}
            </button>
            {why && (
              <ul className="mt-1 space-y-0.5 text-silver-600 dark:text-silver-300">
                <li>
                  {t.trace.path}: {t.paths[m.trace.path]}
                </li>
                <li>
                  {fmt(t.trace.versions, {
                    k: m.trace.knowledgeVersion,
                    c: m.trace.configVersion,
                  })}
                </li>
                <li>{fmt(t.trace.chunks, { n: m.trace.chunkIds.length })}</li>
                {m.trace.faqId && (
                  <li>{fmt(t.trace.faq, { id: m.trace.faqId })}</li>
                )}
                {m.trace.rule && (
                  <li>{fmt(t.trace.rule, { rule: m.trace.rule })}</li>
                )}
                {m.trace.cache && <li>{t.trace.cache}</li>}
                {m.trace.translated && <li>{t.trace.translated}</li>}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Диалог: сообщения, передача (взять/ответить/черновик/закрыть), кандидат. */
export function DialogScreen({ siteId, cid }: { siteId: string; cid: string }) {
  const { account, dict } = useKit();
  const { appDict, handoff, learning } = useAssist();
  const t = appDict.e3.dialogs;
  const errText = useE3ErrorText();
  const loaded = useAsync(
    () => handoff.get(siteId, cid),
    [handoff, siteId, cid]
  );
  const [conv, setConv] = useState<ConversationView | null>(null);
  const c = conv ?? loaded.data;
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [noTranslate, setNoTranslate] = useState(false);
  const [draft, setDraft] = useState<HandoffDraft | null>(null);
  const [templates, setTemplates] = useState<
    Array<{ id: string; title: string; text: string }>
  >([]);
  const manager = isAssistManager(account.me);

  const refresh = useCallback(async () => {
    try {
      setConv(await handoff.get(siteId, cid));
    } catch {
      /* опрос: следующий тик повторит */
    }
  }, [handoff, siteId, cid]);

  // Пока передача ждёт или идёт — подтягиваем новые сообщения (3 с).
  useEffect(() => {
    if (!shouldPollDialog(c?.handoff ?? null)) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, DIALOG_POLL_MS);
    return () => clearInterval(timer);
  }, [c?.handoff, refresh]);

  // Шаблоны ответов — из настроек передачи (только менеджеру доступны).
  useEffect(() => {
    if (!manager) return;
    handoff.settings(siteId).then(
      (s) => setTemplates(s.config.templates),
      () => setTemplates([])
    );
  }, [handoff, siteId, manager]);

  if (loaded.loading && !c) return <Spinner label={dict.common.loading} />;
  if (!c) return <LoadError error={loaded.error} onRetry={loaded.reload} />;

  const h = c.handoff;
  const can = handoffActions(h, account.me);

  async function act(name: string, job: () => Promise<void>) {
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

  const take = () =>
    act('take', async () => {
      const r = await handoff.take(siteId, cid);
      setNotice({
        tone: r.result === 'taken' ? 'success' : 'warning',
        text:
          r.result === 'taken'
            ? t.taken
            : r.result === 'already_taken'
              ? t.alreadyTaken
              : t.notWaiting,
      });
      await refresh();
    });

  const send = () =>
    act('reply', async () => {
      const text = reply.trim();
      if (!text) return;
      const r = await handoff.reply(siteId, cid, {
        text,
        ...(noTranslate ? { noTranslate: true } : {}),
      });
      setReply('');
      setDraft(null);
      setNotice({
        tone: 'success',
        text: r.translated
          ? fmt(t.sentTranslated, { text: r.sentText })
          : t.sent,
      });
      await refresh();
    });

  const getDraft = () =>
    act('draft', async () => {
      const d = await handoff.draft(siteId, cid);
      setDraft(d);
      if (!d || !d.text) setNotice({ tone: 'warning', text: t.draftEmpty });
    });

  const close = () =>
    act('close', async () => {
      await handoff.close(siteId, cid);
      setNotice({ tone: 'success', text: t.closed });
      await refresh();
    });

  const propose = (messageId: string) =>
    act(`prop-${messageId}`, async () => {
      await learning.propose(siteId, { messageId });
      setNotice({ tone: 'success', text: t.proposed });
    });

  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      <NoticeBar notice={notice} />
      {c.pageUrl && (
        <div className="text-xs text-silver-500 break-all">
          {fmt(t.page, { url: c.pageUrl })}
        </div>
      )}
      {h && (
        <Card className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATE_TONE[h.state]}>{t.states[h.state]}</Badge>
            <span className="text-silver-500">{t.reasons[h.reason]}</span>
            {h.escalation && (
              <span className="text-silver-500">
                · {t.escalation[h.escalation]}
              </span>
            )}
          </div>
          {h.identity.present && (
            <div className="text-xs">
              {h.identity.verified ? t.identity.verified : t.identity.claimed}
            </div>
          )}
          {h.summary && (
            <div className="space-y-1">
              <div className="text-xs text-silver-500">
                {h.summary.source === 'model' ? t.summary : t.summaryFallback}
              </div>
              <div className="whitespace-pre-wrap break-words">
                {h.summary.text}
              </div>
            </div>
          )}
          {c.lead && (
            <div className="text-xs text-silver-500">
              {fmt(t.leadFields, { fields: c.lead.fieldNames.join(', ') })}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {can.take && (
              <Button loading={busy === 'take'} onClick={() => void take()}>
                {t.take}
              </Button>
            )}
            {can.close && (
              <Button
                variant="outline"
                loading={busy === 'close'}
                onClick={() => void close()}
              >
                {t.close}
              </Button>
            )}
          </div>
          {shouldPollDialog(h) && (
            <div className="text-[11px] text-silver-500">
              {appDict.e3.common.autoRefresh}
            </div>
          )}
        </Card>
      )}

      <div className="space-y-2">
        {c.messages.map((m) => (
          <div key={m.id} className="space-y-1">
            <MessageBubble m={m} showTrace={manager} />
            {m.role === 'operator' && m.authorIsMe && (
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  loading={busy === `prop-${m.id}`}
                  onClick={() => void propose(m.id)}
                >
                  {t.propose}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>

      {can.reply && (
        <Card className="space-y-2">
          <label htmlFor="reply" className="block text-sm font-medium">
            {t.replyLabel}
          </label>
          {templates.length > 0 && (
            <select
              aria-label={t.template}
              className="w-full rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 text-sm"
              value=""
              onChange={(e) => {
                const tpl = templates.find((x) => x.id === e.target.value);
                if (tpl) setReply(tpl.text);
              }}
            >
              <option value="">{t.template}</option>
              {templates.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title || x.text.slice(0, 40)}
                </option>
              ))}
            </select>
          )}
          <textarea
            id="reply"
            className={textareaClass}
            placeholder={t.replyPlaceholder}
            maxLength={4000}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={noTranslate}
              onChange={(e) => setNoTranslate(e.target.checked)}
            />
            {t.noTranslate}
          </label>
          {draft && draft.text && (
            <div className="rounded-lg border border-dashed border-silver-300 dark:border-silver-700 p-2 text-sm space-y-1">
              <div className="text-xs text-silver-500">{t.draft}</div>
              <div className="whitespace-pre-wrap break-words">
                {draft.text}
              </div>
              <Button variant="outline" onClick={() => setReply(draft.text)}>
                {t.useDraft}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              loading={busy === 'reply'}
              disabled={!reply.trim()}
              onClick={() => void send()}
            >
              {t.send}
            </Button>
            {can.draft && (
              <Button
                variant="outline"
                loading={busy === 'draft'}
                onClick={() => void getDraft()}
              >
                {t.draft}
              </Button>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
