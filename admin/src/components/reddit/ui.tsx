'use client';

// Части вкладки «Reddit»: контекст (клиенты кабинета поверх маршрутов
// Админки, оператор, переходы между вкладками), загрузка/мутации с `opKey`
// попытки (правила кабинета: повтор после сети — тем же ключом), ошибки
// словами, CAS-перебазирование форм, безопасный предпросмотр markdown и
// копирование ровно переданной строки. Стили — классы `rx-*` (globals.css).

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  conflictValueText,
  csvFileText,
  describeAdminRedditError,
  markMutationError,
  fetchCsv,
  R,
  T,
  type AdminRedditStatus,
  type CsvList,
  type RedditClients,
  type RedditRoute,
} from '../../lib/reddit';
import type { Query } from '../../lib/reddit-shared/lib/publisher/common-pure';
import { opKeyAfter, opKeyFor, type OpKeyState } from '../../lib/reddit-shared/lib/publisher/common-pure';
import { copyText } from '../../lib/reddit-shared/kit/clipboard';
import {
  parseMarkdownSubset,
  wordCount,
  type MdInline,
} from '../../lib/reddit-shared/lib/publisher/reddit-studio-view';
import {
  httpsHref,
  isReloadable,
  rebaseForm,
  redditHref,
  verdictTone,
  type FieldConflict,
} from '../../lib/reddit-shared/lib/publisher/reddit-view';
import type { RedditGateView } from '../../lib/reddit-shared/lib/publisher/reddit-api';
import { confirmClick, fmtText, type Tone } from '../../lib/reddit-shared/lib/publisher/view';

// ── Контекст ──────────────────────────────────────────────────────────────

export interface RedditCtxValue {
  api: RedditClients;
  /** `User.id` оператора (актор `admin:<id>`). */
  userId: string | null;
  route: RedditRoute;
  go: (patch: Partial<RedditRoute>) => void;
  aiEnabled: boolean;
  /** Статус раздела (гейт AI и месяц — для студии). */
  status: AdminRedditStatus | null;
}

export const RedditCtx = createContext<RedditCtxValue | null>(null);

export function useRx(): RedditCtxValue {
  const v = useContext(RedditCtx);
  if (!v) throw new Error('useRx: нет RedditCtx');
  return v;
}

// ── Загрузка и мутации ────────────────────────────────────────────────────

export interface Loaded<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Загрузка с перезапуском по `deps`; поздний ответ старого запроса не
 * пишется. Пока идёт новая загрузка, `data` — прежние (без мигания при
 * перечитывании); карточки сверяют id записи сами (аудит ui-9).
 */
export function useLoad<T>(fn: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fnRef
      .current()
      .then((v) => {
        if (alive) setData(v);
      })
      .catch((e) => {
        if (alive) setError(e);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((x) => x + 1), []);
  return { data, error, loading, reload };
}

export interface Mutation {
  run: <T>(fn: (opKey: string) => Promise<T>, sig: string) => Promise<T | undefined>;
  busy: boolean;
  error: unknown;
  reset: () => void;
}

/**
 * Действие с `opKey` попытки (§11.1 кабинета): та же подпись после
 * повторяемой ошибки (сеть, `PUB_BUSY`) — тот же ключ; иначе — новый.
 */
export function useMutation(): Mutation {
  const key = useRef<OpKeyState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(async <T,>(fn: (opKey: string) => Promise<T>, sig: string): Promise<T | undefined> => {
    const state = opKeyFor(key.current, sig);
    key.current = state;
    setBusy(true);
    setError(null);
    try {
      const out = await fn(state.key);
      key.current = opKeyAfter(state, null);
      return out;
    } catch (e) {
      key.current = opKeyAfter(state, e);
      markMutationError(e);
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  const reset = useCallback(() => {
    key.current = null;
    setError(null);
  }, []);
  return { run, busy, error, reset };
}

export interface RebaseForm<F extends object> {
  v: F;
  set: (v: F) => void;
  base: F;
  conflicts: FieldConflict<F>[];
  resolve: (key: keyof F, pick: 'mine' | 'theirs') => void;
}

/**
 * Форма правки поверх серверного состояния (как `useRebaseForm` кабинета):
 * тело правки — от `base` (снимок на начало правки); новая `version`
 * (перечитали после 409 или сохранили) перебазирует форму — нетронутые
 * поля свежие, ввод пользователя остаётся, расхождения — явно.
 */
export function useRebaseForm<F extends object>(server: F, version: string | number): RebaseForm<F> {
  const [state, setState] = useState<{ base: F; v: F; seen: string | number; conflicts: FieldConflict<F>[] }>(() => ({
    base: server,
    v: server,
    seen: version,
    conflicts: [],
  }));
  if (state.seen !== version) {
    // Перебазирование во время рендера (паттерн «состояние от пропсов»).
    const res = rebaseForm(state.base, state.v, server);
    setState({ base: server, v: res.mine, seen: version, conflicts: res.conflicts });
  }
  const set = useCallback((v: F) => setState((s) => ({ ...s, v })), []);
  const resolve = useCallback((key: keyof F, pick: 'mine' | 'theirs') => {
    setState((s) => {
      const c = s.conflicts.find((x) => x.key === key);
      return {
        ...s,
        v: c && pick === 'theirs' ? { ...s.v, [key]: c.theirs } : s.v,
        conflicts: s.conflicts.filter((x) => x.key !== key),
      };
    });
  }, []);
  return { v: state.v, set, base: state.base, conflicts: state.conflicts, resolve };
}

// ── Разметка ──────────────────────────────────────────────────────────────

export function Section({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="card rx-section">
      <div className="rx-row rx-section-head">
        <h2>{title}</h2>
        {action}
      </div>
      <div className="rx-stack">{children}</div>
    </section>
  );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="rx-field">
      {/* Подсказка — вне <label>: она не должна входить в имя поля. */}
      <label className="rx-field">
        <span className="rx-label">{label}</span>
        {children}
      </label>
      {hint ? <span className="muted rx-hint">{hint}</span> : null}
    </div>
  );
}

export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="rx-kv">
      <span className="muted">{label}</span>
      <span className="rx-wrap">{children}</span>
    </div>
  );
}

const TONE_CLASS: Record<Tone, string> = {
  success: 'badge-status badge-status-ok',
  warning: 'badge-status badge-status-warning',
  danger: 'badge-status badge-status-critical',
  accent: 'badge-status badge-status-accent',
  neutral: 'badge-status badge-status-neutral',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={TONE_CLASS[tone]}>{children}</span>;
}

export function Alert({ tone = 'neutral', title, children }: { tone?: Tone; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`rx-alert rx-alert-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      {title ? <div className="rx-alert-title">{title}</div> : null}
      {children}
    </div>
  );
}

export function Notice({ text }: { text: string | null }) {
  return text ? (
    <p className="rx-notice" role="status">
      {text}
    </p>
  ) : null;
}

export function Loading() {
  return <p className="muted">{T.common.loading}</p>;
}

/**
 * Ошибка словами; 409 CAS — кнопка «Перечитать» (ввод формы не теряется);
 * у загрузчика (`onRetry`) при сети/таймауте/5xx — «Повторить» (аудит ui-7).
 */
export function ErrorAlert({
  error,
  onReload,
  onRetry,
  statusLabels,
  onExisting,
}: {
  error: unknown;
  onReload?: () => void;
  /** Повтор загрузки (GET): кнопка — только для повторяемых ошибок. */
  onRetry?: () => void;
  statusLabels?: Record<string, string>;
  /** 409 дубль: открыть существующую запись (`details.existingId`). */
  onExisting?: (id: string) => void;
}) {
  if (!error) return null;
  const v = describeAdminRedditError(error, statusLabels);
  return (
    <Alert tone={v.conflict ? 'warning' : 'danger'} title={v.title}>
      {v.lines.length > 0 && (
        <ul className="rx-list">
          {v.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {v.conflict && onReload && (
        <button type="button" onClick={onReload}>
          {T.common.reload}
        </button>
      )}
      {onRetry && !(v.conflict && onReload) && isReloadable(error) && (
        <button type="button" data-reddit-retry="" onClick={onRetry}>
          {T.common.retry}
        </button>
      )}
      {v.existingId && onExisting && (
        <button type="button" onClick={() => onExisting(v.existingId as string)}>
          {R.common.existing}
        </button>
      )}
    </Alert>
  );
}

/** Двухшаговое подтверждение (как `ConfirmButton` кабинета). */
export function ConfirmButton({
  children,
  onConfirm,
  disabled,
  busy,
  danger,
  confirmText = T.common.confirmAgain,
}: {
  children: ReactNode;
  onConfirm: () => void;
  disabled?: boolean;
  busy?: boolean;
  danger?: boolean;
  confirmText?: string;
}) {
  // Момент взвода (null — не взведена): второй щелчок двойного клика и
  // нажатие раньше паузы подтверждением не считаются (аудит ui-3).
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const armed = armedAt !== null;
  useEffect(() => {
    if (armedAt === null) return;
    const t = setTimeout(() => setArmedAt(null), 5000);
    return () => clearTimeout(t);
  }, [armedAt]);
  return (
    <button
      type="button"
      className={danger || armed ? 'button-danger' : undefined}
      disabled={disabled || busy}
      onClick={(e) => {
        const now = Date.now();
        const step = confirmClick(armedAt, now, e.detail);
        if (step === 'arm') {
          setArmedAt(now);
          return;
        }
        if (step === 'ignore') return;
        setArmedAt(null);
        onConfirm();
      }}
    >
      {busy ? T.common.loading : armed ? confirmText : children}
    </button>
  );
}

/** Текст пользователя/Reddit — только текстом (никакой разметки и ссылок). */
export function PlainText({ text, label }: { text: string; label?: string }) {
  return (
    <pre className="rx-pre" tabIndex={0} role="region" aria-label={label ?? R.common.textRegion}>
      {text}
    </pre>
  );
}

/** «Открыть на Reddit» — только сохранённый канонический URL (`redditHref`). */
export function RedditLink({ url, children }: { url: string | null | undefined; children: ReactNode }) {
  const href = redditHref(url);
  if (!href) return null;
  return (
    <a className="rx-link" href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
      {children} ↗
    </a>
  );
}

export function ConflictPanel<F extends object>({
  conflicts,
  label,
  resolve,
  show,
}: {
  conflicts: FieldConflict<F>[];
  label: (key: keyof F) => string;
  resolve: (key: keyof F, pick: 'mine' | 'theirs') => void;
  /** Своё представление значения (как `show` кабинета); иначе — `conflictValueText`. */
  show?: (key: keyof F, value: F[keyof F]) => string;
}) {
  if (!conflicts.length) return null;
  const fmtOf = (k: keyof F, x: F[keyof F]) => (show ? show(k, x) : conflictValueText(x));
  return (
    <Alert tone="warning" title={R.common.conflictTitle}>
      <ul className="rx-list" data-reddit-conflicts="">
        {conflicts.map((c) => (
          <li key={String(c.key)}>
            <b>{label(c.key)}</b>
            <div className="rx-wrap">
              {R.common.conflictTheirs}: {fmtOf(c.key, c.theirs) || R.common.none}
            </div>
            <div className="rx-wrap">
              {R.common.conflictMine}: {fmtOf(c.key, c.mine) || R.common.none}
            </div>
            <div className="rx-row">
              <button type="button" onClick={() => resolve(c.key, 'theirs')}>
                {R.common.takeTheirs}
              </button>
              <button type="button" onClick={() => resolve(c.key, 'mine')}>
                {R.common.keepMine}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Alert>
  );
}

function Inline({ c }: { c: MdInline[] }) {
  return (
    <>
      {c.map((x, i) =>
        x.t === 'strong' ? (
          <strong key={i}>{x.v}</strong>
        ) : x.t === 'em' ? (
          <em key={i}>{x.v}</em>
        ) : x.t === 'code' ? (
          <code key={i}>{x.v}</code>
        ) : (
          <span key={i}>{x.v}</span>
        ),
      )}
    </>
  );
}

/**
 * Предпросмотр подмножества Reddit-markdown: только React-текст из дерева
 * `parseMarkdownSubset` (без `dangerouslySetInnerHTML`); ссылки, картинки и
 * HTML остаются буквальным текстом.
 */
export function MarkdownPreview({ text }: { text: string }) {
  const blocks = parseMarkdownSubset(text);
  return (
    <div className="rx-stack">
      <span className="muted rx-hint">{R.studio.preview.note}</span>
      <div className="rx-preview" data-reddit-preview="" tabIndex={0} role="region" aria-label={R.studio.preview.title}>
        {blocks.map((b, i) =>
          b.t === 'p' ? (
            <p key={i}>
              <Inline c={b.c} />
            </p>
          ) : b.t === 'quote' ? (
            <blockquote key={i}>
              <Inline c={b.c} />
            </blockquote>
          ) : b.t === 'ul' ? (
            <ul key={i}>
              {b.items.map((it, j) => (
                <li key={j}>
                  <Inline c={it} />
                </li>
              ))}
            </ul>
          ) : (
            <ol key={i}>
              {b.items.map((it, j) => (
                <li key={j}>
                  <Inline c={it} />
                </li>
              ))}
            </ol>
          ),
        )}
      </div>
    </div>
  );
}

export function WordCount({ text }: { text: string }) {
  const w = wordCount(text);
  return (
    <span className="muted rx-hint" aria-live="polite">
      {fmtText(R.studio.draft.words, { words: w.words, chars: w.chars })}
    </span>
  );
}

/**
 * Текст как есть + кнопка, копирующая РОВНО эту строку (`copyText` кита:
 * Clipboard API, запасной путь — `execCommand`; не вышло — выделить вручную).
 */
export function CopyBlock({ label, text, buttonLabel }: { label: string; text: string; buttonLabel: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <div className="rx-stack">
      <div className="rx-row">
        <span className="muted rx-grow">{label}</span>
        <button type="button" onClick={async () => setState((await copyText(text)) ? 'ok' : 'fail')}>
          {state === 'ok' ? R.studio.copy.copied : buttonLabel}
        </button>
      </div>
      {state === 'fail' && <Alert tone="warning">{R.studio.copy.failed}</Alert>}
      <pre className="rx-pre rx-select" data-reddit-approved="" tabIndex={0} role="region" aria-label={label}>
        {text}
      </pre>
    </div>
  );
}

/** Подпись актора: `admin:<id>` — «Админка», `member:<id>` — участник. */
export function ActorText({ actor, userId }: { actor: string | null | undefined; userId: string | null }) {
  if (!actor) return <>{R.common.none}</>;
  if (userId && actor === `admin:${userId}`) return <>вы (Админка)</>;
  if (actor.startsWith('admin:')) return <>оператор Админки {actor.slice(6, 14)}…</>;
  return <>{actor}</>;
}

/** Выбор из закрытого списка с подписями. */
export function Select<V extends string>({
  value,
  options,
  labels,
  empty,
  onChange,
  ariaLabel,
}: {
  value: V | '';
  options: readonly V[];
  labels: Record<string, string>;
  empty?: string;
  onChange: (v: V | '') => void;
  ariaLabel?: string;
}) {
  return (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value as V | '')}>
      {empty !== undefined && <option value="">{empty}</option>}
      {options.map((o) => (
        <option key={o} value={o}>
          {labels[o] ?? o}
        </option>
      ))}
    </select>
  );
}

// ── Списки с курсором ─────────────────────────────────────────────────────

export interface Paged<T> {
  items: T[];
  error: unknown;
  loading: boolean;
  hasMore: boolean;
  more: () => void;
  reload: () => void;
  /** Повтор после ошибки: первой страницы — перечитать, «ещё» — дочитать. */
  retry: () => void;
}

/** Первая страница по `deps`, дальше — «Показать ещё» по `nextBefore`. */
export function usePaged<T>(
  fn: (before?: string) => Promise<{ items: T[]; nextBefore: string | null }>,
  deps: readonly unknown[],
): Paged<T> {
  const first = useLoad(() => fn(), deps);
  const [extra, setExtra] = useState<{ key: unknown; items: T[]; next: string | null | undefined }>({
    key: null,
    items: [],
    next: undefined,
  });
  const [busy, setBusy] = useState(false);
  // Ошибка «ещё» — тоже от своей первой страницы (сменился фильтр — не видна).
  const [moreFail, setMoreFail] = useState<{ key: unknown; error: unknown }>({ key: null, error: null });
  // Новая первая страница — хвост прошлой выборки сбрасывается.
  const sameKey = extra.key === first.data;
  const moreError = moreFail.key === first.data ? moreFail.error : null;
  const items = [...(first.data?.items ?? []), ...(sameKey ? extra.items : [])];
  const next = sameKey && extra.next !== undefined ? extra.next : (first.data?.nextBefore ?? null);
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const more = () => {
    if (!next || busy) return;
    setBusy(true);
    const key = first.data;
    setMoreFail({ key: null, error: null });
    fnRef
      .current(next)
      .then((p) => setExtra((x) => ({ key, items: [...(x.key === key ? x.items : []), ...p.items], next: p.nextBefore })))
      .catch((error: unknown) => setMoreFail({ key, error }))
      .finally(() => setBusy(false));
  };
  return {
    items,
    error: first.error ?? moreError,
    loading: first.loading || busy,
    hasMore: !!next,
    more,
    reload: first.reload,
    retry: () => (first.error ? first.reload() : more()),
  };
}

export function PagedFooter<T>({ page, empty }: { page: Paged<T>; empty: string }) {
  return (
    <>
      {page.error ? <ErrorAlert error={page.error} onRetry={page.retry} /> : null}
      {page.loading && !page.items.length ? <Loading /> : null}
      {!page.loading && !page.error && page.items.length === 0 ? <p className="muted">{empty}</p> : null}
      {page.hasMore && (
        <button type="button" disabled={page.loading} onClick={page.more}>
          {T.common.more}
        </button>
      )}
    </>
  );
}

// ── Гейт, цитаты, первоисточник, отзыв ────────────────────────────────────

/** Вердикт гейта и причины словами (зелёный — только «можно»). */
export function GateBlock({ gate, label }: { gate: RedditGateView; label?: string }) {
  return (
    <div className="rx-stack">
      <div className="rx-row">
        {label ? <span className="muted">{label}:</span> : null}
        <Badge tone={verdictTone(gate.verdict)}>{R.gate.verdicts[gate.verdict]}</Badge>
      </div>
      {gate.reasons.length + gate.warnings.length > 0 && (
        <ul className="rx-list">
          {gate.reasons.map((x) => (
            <li key={x}>{R.gate.reasons[x] ?? x}</li>
          ))}
          {gate.warnings.map((x) => (
            <li key={x} className="rx-warn">
              {R.gate.warnings[x] ?? x}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Цитата (выдержка правил/треда) — только текстом; пометка «похоже на команду». */
export function PlainQuote({ text, injectionFlag, label }: { text: string; injectionFlag?: string | null; label?: string }) {
  return (
    <div className="rx-stack">
      {injectionFlag ? <Alert tone="warning">{fmtText(R.rules.injectionFlag, { flag: injectionFlag })}</Alert> : null}
      <pre className="rx-pre" data-reddit-quote="" tabIndex={0} role="region" aria-label={label ?? R.common.textRegion}>
        {text}
      </pre>
    </div>
  );
}

/** Ссылка на первоисточник правил: только https, иначе — текстом. */
export function SourceLink({ url }: { url: string }) {
  if (url === '') return <span className="muted">{R.rules.noSource}</span>;
  const href = httpsHref(url);
  if (!href) return <span className="rx-wrap">{url}</span>;
  return (
    <a className="rx-link rx-wrap" href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
      {url} ↗
    </a>
  );
}

/**
 * Отзыв доказательства (первоисточник правил, редакция выдержки): причина
 * обязательна, отзыв необратим; после — данные перечитываются.
 */
export function RevokeEvidence({ sourceId, label, onDone }: { sourceId: string; label: string; onDone: () => void }) {
  const { api } = useRx();
  const m = useMutation();
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(false);
  return (
    <div className="rx-stack">
      <span className="muted rx-hint">{R.common.revokeHint}</span>
      <Field label={R.common.revokeReason}>
        <textarea rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorAlert error={m.error} onReload={onDone} />
      {done && <Alert tone="success">{R.common.revoked}</Alert>}
      <ConfirmButton
        busy={m.busy}
        disabled={!reason.trim()}
        onConfirm={async () => {
          setDone(false);
          const x = await m.run((k) => api.content.revokeSource(sourceId, reason.trim(), k), `revoke:${sourceId}:${reason.trim()}`);
          if (x) {
            setReason('');
            setDone(true);
            onDone();
          }
        }}
      >
        {label}
      </ConfirmButton>
    </div>
  );
}

// ── Выгрузка CSV ──────────────────────────────────────────────────────────

/**
 * Сохранить текст файлом у оператора (Blob + `a[download]`). CSV — с BOM
 * (`csvFileText`): иначе Excel читает UTF-8 как ANSI (аудит ui-11).
 */
export function saveText(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  const body = /^text\/csv\b/i.test(type) ? csvFileText(text) : text;
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** «Выгрузить CSV» списка с текущим фильтром (файл отдаёт backend). */
export function CsvButton({ list, query }: { list: CsvList; query: Query }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const [truncated, setTruncated] = useState<number | null>(null);
  return (
    <>
      <button
        type="button"
        disabled={busy}
        data-csv={list}
        onClick={async () => {
          setBusy(true);
          setError(null);
          setDone(null);
          setTruncated(null);
          try {
            const f = await fetchCsv(list, query);
            saveText(f.filename, f.text);
            setDone(`${T.common.exported} ${f.filename}${f.parts > 1 ? ` (частей: ${f.parts})` : ''}`);
            setTruncated(f.truncated ? f.parts : null);
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? T.common.loading : T.common.exportCsv}
      </button>
      {done ? <span className="rx-notice rx-hint">{done}</span> : null}
      {truncated !== null ? (
        <Alert tone="warning">
          <span data-csv-truncated="">{fmtText(T.common.csvTruncated, { parts: truncated })}</span>
        </Alert>
      ) : null}
      {error ? <ErrorAlert error={error} /> : null}
    </>
  );
}
