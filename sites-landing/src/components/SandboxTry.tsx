'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { PRODUCT_NAMES } from '../brand';
import {
  MAX_POLLS,
  SANDBOX_PUBLIC_LIMITS,
  SESSION_KEY,
  answerSegments,
  isWorking,
  parseAnswer,
  parseCreated,
  parseEnvelope,
  parseSession,
  parseView,
  pollDelayMs,
  precheckUrl,
  safeSourceHref,
  safeThemeColor,
  serializeSession,
  sourceLabel,
  tmaSandboxLink,
  withoutUrlParam,
  type SandboxProblem,
  type SandboxSession,
  type SandboxSourceRef,
  type SandboxView,
  type UrlProblem,
} from '../lib/sandbox';
import { track } from '../lib/track';
import { autoTextColor, tmaStartLink } from '../lib/widget-draft';

export interface SandboxStrings {
  formLabel: string;
  urlLabel: string;
  urlHint: string;
  urlPlaceholder: string;
  terms: string;
  start: string;
  starting: string;
  urlProblems: Record<UrlProblem, string>;
  waitingHeading: string;
  waitingQueued: string;
  waitingSitemap: string;
  waitingProgress: string;
  waitingIndexing: string;
  waitingTitles: string;
  waitingSlow: string;
  resultHeading: string;
  mockLabel: string;
  mockCaption: string;
  mockBadge: string;
  chatHeading: string;
  suggestedLabel: string;
  questionLabel: string;
  ask: string;
  asking: string;
  you: string;
  assistant: string;
  sources: string;
  sourceNoLink: string;
  refused: string;
  questionsLeft: string;
  sandboxNote: string;
  connect: string;
  connectNoBot: string;
  customize: string;
  restart: string;
  expires: string;
  problems: Record<SandboxProblem | 'failed', string>;
  pilotCta: string;
  telegramCta: string;
}

type Phase =
  | { kind: 'form' }
  | { kind: 'starting' }
  | { kind: 'waiting'; view: SandboxView | null; polls: number }
  | { kind: 'ready'; view: SandboxView }
  | { kind: 'problem'; problem: SandboxProblem | 'failed' };

interface ChatItem {
  role: 'visitor' | 'assistant';
  text: string;
  sources: SandboxSourceRef[];
  refused?: boolean;
}

function readSession(): SandboxSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    const s = parseSession(raw, Date.now());
    if (raw && !s) window.sessionStorage.removeItem(SESSION_KEY);
    return s;
  } catch {
    return null;
  }
}
function writeSession(s: SandboxSession | null) {
  try {
    if (s) window.sessionStorage.setItem(SESSION_KEY, serializeSession(s));
    else window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* хранилище недоступно — песочница живёт до перезагрузки вкладки */
  }
}

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/**
 * Песочница по URL (Л4, §6): поле адреса → экран ожидания с честным
 * прогрессом (`role="status"`) → макет сайта с подписью «не установлено»
 * и чат с безопасным рендером ответов → перенос в TMA (`sb_`).
 *
 * Скриншота нет (воркера QA нет, §6.4): фон — макет в цвете `theme-color`
 * их сайта, наш виджет нарисован DOM поверх, подпись не снимается.
 * Результат живёт только в этой вкладке (`sessionStorage`), публичной
 * ссылки нет.
 */
export function SandboxTry(props: {
  strings: SandboxStrings;
  endpoint: string;
  botUsername: string | null;
  pilotHref: string;
  widgetHref: string | null;
  brandName: string;
  locale: string;
}) {
  const t = props.strings;
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [url, setUrl] = useState('');
  const [urlProblem, setUrlProblem] = useState<UrlProblem | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [chatProblem, setChatProblem] = useState<SandboxProblem | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const session = useRef<SandboxSession | null>(null);
  const timer = useRef<number | null>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);
  const problemRef = useRef<HTMLParagraphElement>(null);

  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const fail = useCallback((problem: SandboxProblem | 'failed') => {
    stop();
    if (problem === 'gone' || problem === 'failed') {
      writeSession(null);
      session.current = null;
    }
    setPhase({ kind: 'problem', problem });
  }, []);

  // Фокус — после того как результат/отказ отрисован (§12: «результат фокусируется»).
  useEffect(() => {
    if (phase.kind === 'ready') resultRef.current?.focus();
    if (phase.kind === 'problem') problemRef.current?.focus();
  }, [phase.kind]);

  const poll = useCallback(
    async (polls: number) => {
      const s = session.current;
      if (!s) return;
      let env;
      try {
        const res = await fetch(`${props.endpoint}/${encodeURIComponent(s.id)}`, {
          credentials: 'omit',
          cache: 'no-store',
          headers: { [PRODUCT_NAMES.sandboxKeyHeader]: s.key },
        });
        env = parseEnvelope(res.status, await res.json().catch(() => null), parseView);
      } catch {
        env = { ok: false as const, problem: 'network' as const, code: null };
      }
      if (session.current !== s) return;
      if (!env.ok) {
        if (env.problem === 'network' && polls < MAX_POLLS) {
          timer.current = window.setTimeout(() => void poll(polls + 1), pollDelayMs(polls));
          return;
        }
        return fail(env.problem);
      }
      const view = env.data;
      if (isWorking(view.status)) {
        if (polls >= MAX_POLLS) return fail('failed');
        setPhase({ kind: 'waiting', view, polls });
        timer.current = window.setTimeout(() => void poll(polls + 1), pollDelayMs(polls));
        return;
      }
      if (view.status === 'ready') {
        setPhase({ kind: 'ready', view });
        setChat(view.messages.map((m) => ({ role: m.role, text: m.text, sources: m.sources })));
        setLeft(Math.max(0, view.questionsLimit - view.questions));
        track('sandbox_ready');
        return;
      }
      if (view.status === 'blocked' && view.statusReason === 'budget') {
        track('sandbox_limit_hit', { kind: 'budget' });
        return fail('unavailable');
      }
      if (view.status === 'expired') return fail('gone');
      return fail('failed');
    },
    [props.endpoint, fail],
  );

  // Восстановление в той же вкладке + адрес из hero (`?url=`).
  useEffect(() => {
    const s = readSession();
    if (s) {
      session.current = s;
      setPhase({ kind: 'waiting', view: null, polls: 0 });
      void poll(0);
    } else {
      const fromHero = new URLSearchParams(window.location.search).get('url');
      if (fromHero) setUrl(fromHero.slice(0, SANDBOX_PUBLIC_LIMITS.maxUrlChars));
    }
    // Адрес сайта посетителя не остаётся в адресной строке (§10.1: параметр
    // снимается после чтения) — ни в истории, ни в просмотрах аналитики, ни в
    // Referer внутренних переходов.
    const clean = withoutUrlParam(window.location.href);
    if (clean) {
      try {
        window.history.replaceState(window.history.state, '', clean);
      } catch {
        /* не критично: поле уже заполнено */
      }
    }
    return stop;
  }, [poll]);

  async function onStart(e: FormEvent) {
    e.preventDefault();
    const pre = precheckUrl(url);
    if (!pre.ok) {
      setUrlProblem(pre.problem);
      return;
    }
    setUrlProblem(null);
    setPhase({ kind: 'starting' });
    let env;
    try {
      const res = await fetch(props.endpoint, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: pre.url }),
      });
      env = parseEnvelope(res.status, await res.json().catch(() => null), parseCreated);
    } catch {
      env = { ok: false as const, problem: 'network' as const, code: null };
    }
    if (!env.ok) {
      const p = env.problem;
      const result =
        p === 'unavailable' ? 'unavailable' : p === 'limit-ip' || p === 'limit-domain' ? 'limit' : p === 'rejected' ? 'rejected' : p === 'opted-out' ? 'opted_out' : p === 'blocked' ? 'blocked' : 'error';
      track('sandbox_start', { result });
      if (p === 'limit-ip') track('sandbox_limit_hit', { kind: 'ip' });
      if (p === 'limit-domain') track('sandbox_limit_hit', { kind: 'domain' });
      if (env.code === 'SANDBOX_BUDGET') track('sandbox_limit_hit', { kind: 'budget' });
      return fail(p);
    }
    track('sandbox_start', { result: 'ok' });
    const s = { id: env.data.id, key: env.data.sandboxKey, createdAt: Date.now() };
    session.current = s;
    writeSession(s);
    setChat([]);
    setPhase({ kind: 'waiting', view: null, polls: 0 });
    void poll(0);
  }

  async function ask(text: string, source: 'suggested' | 'typed') {
    const s = session.current;
    const q = text.trim().slice(0, SANDBOX_PUBLIC_LIMITS.maxQuestionChars);
    if (!s || !q || asking) return;
    setAsking(true);
    setChatProblem(null);
    setChat((c) => [...c, { role: 'visitor', text: q, sources: [] }]);
    track('sandbox_question', { source });
    let env;
    try {
      const res = await fetch(`${props.endpoint}/${encodeURIComponent(s.id)}/chat`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json', [PRODUCT_NAMES.sandboxKeyHeader]: s.key },
        body: JSON.stringify({ question: q }),
      });
      env = parseEnvelope(res.status, await res.json().catch(() => null), parseAnswer);
    } catch {
      env = { ok: false as const, problem: 'network' as const, code: null };
    }
    setAsking(false);
    if (!env.ok) {
      if (env.problem === 'exhausted') {
        setLeft(0);
        track('sandbox_limit_hit', { kind: 'questions' });
      }
      if (env.problem === 'gone') return fail('gone');
      setChatProblem(env.problem);
      return;
    }
    const a = env.data;
    setChat((c) => [...c, { role: 'assistant', text: a.answer, sources: a.sources, refused: a.refused }]);
    setLeft(a.questionsLeft);
    setQuestion('');
  }

  function restart() {
    stop();
    writeSession(null);
    session.current = null;
    setChat([]);
    setLeft(null);
    setChatProblem(null);
    setPhase({ kind: 'form' });
  }

  // ── Рендер ──
  if (phase.kind === 'form' || phase.kind === 'starting') {
    const busy = phase.kind === 'starting';
    return (
      <form className="sb-form" onSubmit={onStart} aria-label={t.formLabel} noValidate>
        <label htmlFor="sb-url">{t.urlLabel}</label>
        <div className="sb-row">
          <input
            id="sb-url"
            name="url"
            type="text"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            placeholder={t.urlPlaceholder}
            value={url}
            maxLength={SANDBOX_PUBLIC_LIMITS.maxUrlChars}
            aria-describedby={urlProblem ? 'sb-url-error sb-url-hint' : 'sb-url-hint'}
            aria-invalid={urlProblem ? true : undefined}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="button" type="submit" disabled={busy}>
            {busy ? t.starting : t.start}
          </button>
        </div>
        <p id="sb-url-hint" className="field-hint">
          {t.urlHint}
        </p>
        {urlProblem && (
          <p id="sb-url-error" className="field-error" role="alert">
            {t.urlProblems[urlProblem]}
          </p>
        )}
        <p className="note">{t.terms}</p>
      </form>
    );
  }

  if (phase.kind === 'problem') {
    const p = phase.problem;
    return (
      <div className="sb-problem" data-testid="sb-problem" data-problem={p}>
        <p ref={problemRef} tabIndex={-1} role="alert" className={p === 'unavailable' ? 'sb-soft' : 'form-status-error'}>
          {t.problems[p]}
        </p>
        <p className="actions">
          {(p === 'unavailable' || p === 'limit-domain') && (
            <a className="button" href={props.pilotHref} data-cta="try">
              {t.pilotCta}
            </a>
          )}
          {p === 'limit-ip' && props.botUsername && (
            <a className="button" href={tmaStartLink(props.botUsername, 'lp_sandbox_limit')} data-tma="lp" data-cta="try" rel="noopener">
              {t.telegramCta}
            </a>
          )}
          <button type="button" className="button button-secondary" onClick={restart}>
            {t.restart}
          </button>
        </p>
      </div>
    );
  }

  if (phase.kind === 'waiting') {
    const v = phase.view;
    const lines: string[] = [];
    if (!v || v.status === 'queued') lines.push(t.waitingQueued);
    else {
      if (v.progress.sitemap) lines.push(t.waitingSitemap);
      lines.push(fill(t.waitingProgress, { found: v.progress.found, read: v.progress.read, limit: v.pagesLimit }));
      if (v.status === 'indexing') lines.push(t.waitingIndexing);
    }
    if (phase.polls > 20) lines.push(t.waitingSlow);
    return (
      <section className="sb-waiting" aria-labelledby="sb-wait-h" data-testid="sb-waiting">
        <h2 id="sb-wait-h">{fill(t.waitingHeading, { host: v?.host ?? '' }).trim()}</h2>
        <div role="status" aria-live="polite" className="sb-status">
          {lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
        {v && v.progress.titles.length > 0 && (
          <>
            <p className="note">{t.waitingTitles}</p>
            <ul className="sb-titles">
              {v.progress.titles.slice(0, SANDBOX_PUBLIC_LIMITS.pages).map((title, i) => (
                <li key={i}>{title}</li>
              ))}
            </ul>
          </>
        )}
        <p className="sb-bar" aria-hidden="true">
          <span style={{ width: `${v ? Math.min(100, Math.round(((v.status === 'indexing' ? v.pagesLimit : v.progress.read) / Math.max(1, v.pagesLimit)) * 100)) : 5}%` }} />
        </p>
        <button type="button" className="button button-secondary" onClick={restart}>
          {t.restart}
        </button>
      </section>
    );
  }

  // ready
  const v = phase.view;
  const color = safeThemeColor(v.themeColor) ?? '#475569';
  const style = { '--sb-c': color, '--sb-t': autoTextColor(color) } as CSSProperties;
  const exhausted = left === 0;
  const tmaHref = props.botUsername ? tmaSandboxLink(props.botUsername, v.id) : null;
  const expires = new Date(v.expiresAt);
  return (
    <section className="sb-result" aria-labelledby="sb-result-h" data-testid="sb-result">
      <h2 id="sb-result-h" ref={resultRef} tabIndex={-1}>
        {fill(t.resultHeading, { host: v.host })}
      </h2>
      <p className="note">{t.sandboxNote}</p>
      <div className="sb-grid">
        <figure className="sb-mock" style={style} data-testid="sb-mock">
          <div className="sb-mock-frame" role="img" aria-label={fill(t.mockLabel, { host: v.host })}>
            <div className="sb-mock-bar">
              <span className="sb-mock-dots" aria-hidden="true" />
              <span className="sb-mock-host">{v.host}</span>
            </div>
            <div className="sb-mock-page">
              <span className="sb-mock-nav" />
              <span className="sb-mock-title">{v.title ?? v.host}</span>
              <span className="sb-mock-l1" />
              <span className="sb-mock-l2" />
              <span className="sb-mock-card" />
            </div>
            <span className="sb-mock-launcher" aria-hidden="true" />
            <span className="badge-mock sb-mock-badge">{t.mockBadge}</span>
          </div>
          <figcaption className="sb-mock-caption" data-testid="sb-caption">
            {fill(t.mockCaption, { host: v.host, brand: props.brandName })}
          </figcaption>
        </figure>

        <div className="sb-chat" aria-labelledby="sb-chat-h">
          <h3 id="sb-chat-h">{t.chatHeading}</h3>
          {v.suggestedQuestions.length > 0 && !exhausted && (
            <div className="sb-suggested" role="group" aria-label={t.suggestedLabel}>
              {v.suggestedQuestions.map((q) => (
                <button key={q} type="button" className="button button-secondary button-small" disabled={asking} onClick={() => void ask(q, 'suggested')}>
                  {q}
                </button>
              ))}
            </div>
          )}
          <ol className="sb-log" aria-live="polite" data-testid="sb-log">
            {chat.map((m, i) => (
              <li key={i} className={m.role === 'visitor' ? 'sb-msg sb-msg-visitor' : 'sb-msg sb-msg-assistant'}>
                <span className="sb-who">{m.role === 'visitor' ? t.you : t.assistant}</span>
                <p className="sb-text">
                  {m.role === 'assistant'
                    ? answerSegments(m.text, m.sources).map((seg, j) => (seg.kind === 'text' ? <span key={j}>{seg.text}</span> : <sup key={j}>[{seg.n}]</sup>))
                    : m.text}
                </p>
                {m.refused && <p className="note">{t.refused}</p>}
                {m.role === 'assistant' && m.sources.length > 0 && (
                  <div className="sb-sources">
                    <span className="sb-sources-h">{t.sources}</span>
                    <ol>
                      {m.sources.map((s) => {
                        const href = safeSourceHref(s.url, v.host);
                        return (
                          <li key={s.n} value={s.n}>
                            {href ? (
                              <a href={href} target="_blank" rel="noopener noreferrer nofollow ugc">
                                {sourceLabel(s)}
                              </a>
                            ) : (
                              <span title={t.sourceNoLink}>{sourceLabel(s)}</span>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                )}
              </li>
            ))}
          </ol>
          {chatProblem && (
            <p className={chatProblem === 'unavailable' ? 'sb-soft' : 'form-status-error'} role="alert">
              {t.problems[chatProblem]}
            </p>
          )}
          <form
            className="sb-ask"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(question, 'typed');
            }}
          >
            <label htmlFor="sb-q">{t.questionLabel}</label>
            <div className="sb-row">
              <input
                id="sb-q"
                type="text"
                value={question}
                maxLength={SANDBOX_PUBLIC_LIMITS.maxQuestionChars}
                disabled={exhausted}
                onChange={(e) => setQuestion(e.target.value)}
                aria-describedby="sb-left"
              />
              <button className="button" type="submit" disabled={asking || exhausted || !question.trim()}>
                {asking ? t.asking : t.ask}
              </button>
            </div>
            <p id="sb-left" className="field-hint" data-testid="sb-left">
              {exhausted ? t.problems.exhausted : fill(t.questionsLeft, { left: left ?? v.questionsLimit - v.questions })}
            </p>
          </form>
        </div>
      </div>

      <div className="sb-next">
        {tmaHref ? (
          <a className="button" href={tmaHref} data-tma="sb" data-cta="try" rel="noopener" data-testid="sb-connect">
            {t.connect}
          </a>
        ) : (
          <p className="note">{t.connectNoBot}</p>
        )}
        {props.widgetHref && (
          <a className="button button-secondary" href={props.widgetHref} data-cta="try">
            {t.customize}
          </a>
        )}
        <button type="button" className="button button-secondary" onClick={restart}>
          {t.restart}
        </button>
        <p className="note">
          {fill(t.expires, {
            time: Number.isNaN(expires.getTime()) ? '' : expires.toLocaleString(props.locale, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }),
          })}
        </p>
      </div>
    </section>
  );
}
