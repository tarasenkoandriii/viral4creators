import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Loader2, Send, ShieldCheck } from 'lucide-react';
import { ApiError, fmt, formatDate, useKit } from '../kit';
import { Alert, Badge, Button, Card, Spinner } from '../kit/ui';
import { useAssist } from '../lib/assist-context';
import type {
  SandboxMessageView,
  SandboxSourceRef,
  SandboxView,
} from '../lib/knowledge-types';
import {
  SANDBOX_QUESTION_MAX,
  canUseSandbox,
  pollDelayMs,
  questionsLeft,
  sandboxPhase,
  sourceRefLabel,
  takePendingQuestion,
} from '../lib/knowledge-view';
import { navigate } from '../lib/router';
import { LoadError } from './knowledge/parts';
import { useErrorText } from '../lib/use-error-text';

type Load =
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'error'; error: unknown }
  | { state: 'ok'; view: SandboxView };

/**
 * Онбординг, шаг 3 (ТЗ §3.1): песочница-чат по 1–10 страницам сайта ДО
 * подтверждения владения — только внутри кабинета, кода виджета нет.
 * Пока сервер читает сайт — «читаю сайт… N страниц» с опросом; потом чат
 * со ссылками на источники. 20 вопросов, 7 дней, без знаний «Админки».
 */
export function SandboxScreen({ siteId }: { siteId: string }) {
  const { account, dict, locale } = useKit();
  const { knowledge, appDict } = useAssist();
  const t = appDict.sandbox;
  const errText = useErrorText();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState(() => takePendingQuestion() ?? '');
  const [asking, setAsking] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  // Сообщения, отправленные после последнего GET (сервер их тоже хранит,
  // но перечитывать песочницу после каждого вопроса незачем).
  const [local, setLocal] = useState<SandboxMessageView[]>([]);
  const attempt = useRef(0);
  const allowed = canUseSandbox(account.me);

  const fetchView = useCallback(async () => {
    try {
      const view = await knowledge.sandbox(siteId);
      setLocal([]);
      setLoad({ state: 'ok', view });
    } catch (e) {
      // Песочницы ещё нет (SANDBOX_NOT_FOUND) — «запустить»; чужой или
      // удалённый сайт (SITE_NOT_FOUND) — ошибка, а не кнопка.
      if (
        e instanceof ApiError &&
        e.status === 404 &&
        e.code !== 'SITE_NOT_FOUND'
      ) {
        setLoad({ state: 'none' });
      } else setLoad({ state: 'error', error: e });
    }
  }, [knowledge, siteId]);

  useEffect(() => {
    if (allowed) void fetchView();
  }, [allowed, fetchView]);

  const view = load.state === 'ok' ? load.view : null;
  const phase = view ? sandboxPhase(view, new Date()) : null;

  // Опрос подготовки: «читаю сайт…» должно двигаться само.
  useEffect(() => {
    if (phase !== 'preparing') {
      attempt.current = 0;
      return;
    }
    const h = setTimeout(() => {
      attempt.current += 1;
      void fetchView();
    }, pollDelayMs(attempt.current));
    return () => clearTimeout(h);
  }, [phase, view, fetchView]);

  if (!allowed) {
    return (
      <Alert tone="warning">{dict.errors.api.ACCOUNT_ROLE_REQUIRED}</Alert>
    );
  }

  async function create() {
    setBusy(true);
    try {
      const v = await knowledge.createSandbox(siteId);
      setLocal([]);
      setLoad({ state: 'ok', view: v });
    } catch (e) {
      setLoad({ state: 'error', error: e });
    } finally {
      setBusy(false);
    }
  }

  async function ask(q: string) {
    const text = q.trim();
    if (!text || !view) return;
    if (text.length > SANDBOX_QUESTION_MAX) {
      setChatError(fmt(t.tooLong, { n: SANDBOX_QUESTION_MAX }));
      return;
    }
    setAsking(true);
    setChatError(null);
    const now = new Date().toISOString();
    setLocal((m) => [
      ...m,
      { role: 'visitor', text, sources: [], createdAt: now },
    ]);
    setQuestion('');
    try {
      const a = await knowledge.sandboxChat(siteId, text);
      setLocal((m) => [
        ...m,
        {
          role: 'assistant',
          text: a.refused && !a.answer ? t.refused : a.answer,
          sources: a.sources,
          createdAt: new Date().toISOString(),
        },
      ]);
      setLoad({
        state: 'ok',
        view: {
          ...view,
          questions: Math.max(0, view.questionsLimit - a.questionsLeft),
        },
      });
    } catch (e) {
      setChatError(errText(e));
      setQuestion(text);
      setLocal((m) => m.slice(0, -1));
      if (
        e instanceof ApiError &&
        (e.code === 'SANDBOX_QUESTIONS_EXHAUSTED' ||
          e.code === 'SANDBOX_EXPIRED')
      ) {
        void fetchView();
      }
    } finally {
      setAsking(false);
    }
  }

  const header = (
    <div className="space-y-1">
      <h1 className="text-xl font-bold tracking-tight">{t.title}</h1>
      <p className="text-sm text-silver-500">{t.intro}</p>
    </div>
  );

  if (load.state === 'loading') {
    return (
      <div className="space-y-4">
        {header}
        <Spinner label={dict.common.loading} />
      </div>
    );
  }
  if (load.state === 'error') {
    return (
      <div className="space-y-4">
        {header}
        <LoadError error={load.error} onRetry={() => void fetchView()} />
      </div>
    );
  }
  if (load.state === 'none' || !view || !phase) {
    return (
      <div className="space-y-4">
        {header}
        <Alert tone="accent">{appDict.onboarding.rule}</Alert>
        <Button block loading={busy} onClick={create}>
          {t.start}
        </Button>
      </div>
    );
  }

  const messages = [...view.messages, ...local];
  const left = questionsLeft(view);
  const ctas = (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        icon={<ShieldCheck size={16} />}
        onClick={() => navigate({ name: 'site', siteId })}
      >
        {t.verify}
      </Button>
      <Button
        variant="ghost"
        icon={<BookOpen size={16} />}
        onClick={() =>
          navigate({ name: 'knowledge', siteId, mode: 'site', tab: 'overview' })
        }
      >
        {t.knowledge}
      </Button>
    </div>
  );

  return (
    <div className="space-y-4">
      {header}
      <Card className="space-y-1 text-sm">
        {view.themeColor && (
          // Цвет темы сайта — уже проверенный `#rgb`/`#rrggbb` (safeColor).
          <div
            className="h-1 w-12 rounded-full"
            style={{ backgroundColor: view.themeColor }}
            aria-hidden
          />
        )}
        <div className="font-semibold truncate">{view.title || view.host}</div>
        <div className="font-mono text-xs text-silver-500 break-all">
          {view.host}
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <Badge tone="accent">
            {view.answersFrom === 'knowledge' ? t.fromKnowledge : t.fromSandbox}
          </Badge>
          {view.answersFrom === 'sandbox' && (
            <Badge>
              {fmt(t.pages, { read: view.pagesRead, limit: view.pagesLimit })}
            </Badge>
          )}
          <Badge tone={left > 0 ? 'neutral' : 'warning'}>
            {fmt(t.questionsLeft, { n: left, limit: view.questionsLimit })}
          </Badge>
        </div>
        {view.expiresAt && (
          <div className="text-xs text-silver-500">
            {fmt(t.expires, { date: formatDate(view.expiresAt, locale) })}
          </div>
        )}
      </Card>

      {phase === 'preparing' && <Preparing view={view} />}

      {(phase === 'failed' || phase === 'blocked' || phase === 'expired') && (
        <Alert
          tone={phase === 'expired' ? 'warning' : 'danger'}
          title={t[phase]}
        >
          {view.statusReason && fmt(t.reason, { reason: view.statusReason })}
          <div className="mt-2">
            <Button variant="outline" loading={busy} onClick={create}>
              {t.restart}
            </Button>
          </div>
        </Alert>
      )}

      {messages.length > 0 && (
        <div className="space-y-2" aria-live="polite">
          {messages.map((m, i) => (
            <Bubble key={`${m.createdAt}-${i}`} m={m} />
          ))}
          {asking && (
            <div className="flex items-center gap-2 text-sm text-silver-500">
              <Loader2 size={14} className="animate-spin" />
              {t.thinking}
            </div>
          )}
        </div>
      )}

      {phase === 'ready' && (
        <>
          {view.suggestedQuestions.length > 0 && messages.length === 0 && (
            <div className="space-y-2">
              <div className="text-sm text-silver-500">{t.suggested}</div>
              <div className="flex flex-wrap gap-2">
                {view.suggestedQuestions.map((q) => (
                  <button
                    key={q}
                    type="button"
                    disabled={asking}
                    onClick={() => void ask(q)}
                    className="rounded-full border border-silver-300 dark:border-silver-700 px-3 py-1.5 text-sm text-left hover:border-accent"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
          {chatError && <Alert tone="danger">{chatError}</Alert>}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(question);
            }}
          >
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={t.placeholder}
              maxLength={SANDBOX_QUESTION_MAX}
              disabled={asking}
              className="flex-1 min-w-0 rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 min-h-[44px] text-sm"
            />
            <Button
              type="submit"
              icon={<Send size={16} />}
              loading={asking}
              disabled={!question.trim()}
              aria-label={t.send}
            >
              <span className="sr-only sm:not-sr-only">{t.send}</span>
            </Button>
          </form>
        </>
      )}

      {phase === 'exhausted' && <Alert tone="warning">{t.exhausted}</Alert>}

      {ctas}
    </div>
  );
}

function Preparing({ view }: { view: SandboxView }) {
  const { appDict } = useAssist();
  const t = appDict.sandbox;
  const p = view.progress;
  const line =
    view.status === 'queued'
      ? t.queued
      : view.status === 'indexing'
        ? t.indexing
        : p.found > 0
          ? fmt(t.reading, { read: p.read, found: p.found })
          : t.readingStart;
  return (
    <Card className="space-y-2 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <Loader2 size={16} className="animate-spin text-accent" />
        {line}
      </div>
      {p.sitemap && <div className="text-silver-500">{t.sitemap}</div>}
      {p.titles.length > 0 && (
        <ul className="text-xs text-silver-500 space-y-0.5">
          {p.titles.slice(-5).map((title, i) => (
            <li key={`${i}-${title}`} className="truncate">
              · {title}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Bubble({ m }: { m: SandboxMessageView }) {
  const { appDict } = useAssist();
  const mine = m.role === 'visitor';
  return (
    <div
      className={`w-fit max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
        mine
          ? 'ml-auto rounded-br-sm bg-accent text-accent-on'
          : 'rounded-bl-sm bg-silver-100 dark:bg-silver-800'
      }`}
    >
      {m.text}
      {m.sources.length > 0 && (
        <div className="mt-2 space-y-0.5 text-xs">
          <div className="text-silver-500">{appDict.sandbox.sources}</div>
          {m.sources.map((s) => (
            <SourceLink key={`${s.n}-${s.url}`} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function SourceLink({ s }: { s: SandboxSourceRef }) {
  const label = sourceRefLabel(s);
  // url уже прошёл safeHttpUrl: только http(s), иначе — текст без ссылки.
  return s.url ? (
    <a
      href={s.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block truncate text-accent hover:underline"
    >
      {label}
    </a>
  ) : (
    <div className="truncate">{label}</div>
  );
}
