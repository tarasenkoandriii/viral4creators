/**
 * AI Publisher (P-R) — части экранов раздела «Reddit»: ошибка P-R
 * человеческим текстом (409 с перезагрузкой, дубль — ссылкой на запись),
 * цитата Reddit ТОЛЬКО текстом (`<pre>`, без markdown/HTML, A14), ссылка
 * «Открыть на Reddit» — обычная `<a rel="noopener noreferrer">` на
 * сохранённый URL (без превью/oEmbed/favicon, Р-RD-0), гейт и его причины,
 * выбор проекта и сообщества.
 */
import { useState, type ReactNode } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { Alert, Badge, Button, inputClass } from '../../../kit/ui';
import type {
  RedditCommunityView,
  RedditGateView,
  RedditPolicyReason,
  RedditPolicyVerdict,
  RedditPolicyWarning,
  RedditProjectView,
} from '../../../lib/publisher/reddit-api';
import {
  describeRedditError,
  type FieldConflict,
  httpsHref,
  redditHref,
  verdictTone,
} from '../../../lib/publisher/reddit-view';
import { fmtText, type Tone } from '../../../lib/publisher/view';
import { usePubApis, useMutation } from '../hooks';
import { ConfirmButton, Field, RecordLink, TextArea } from '../parts';
import { useReddit } from './reddit-hooks';

/** Ошибка API раздела: причины гейта словами; дубль — ссылкой. */
export function RedditErrorAlert({
  error,
  onReload,
  existingTab,
  statusLabels,
}: {
  error: unknown;
  onReload?: () => void;
  /** Вкладка карточки существующей записи при дубле (409 `existingId`). */
  existingTab?: string;
  statusLabels?: Record<string, string>;
}) {
  const { t, r } = useReddit();
  if (!error) return null;
  const v = describeRedditError(error, t, r, statusLabels);
  return (
    <Alert tone={v.conflict ? 'warning' : 'danger'} title={v.title}>
      {v.lines.length > 0 && (
        <ul className="list-disc pl-5 space-y-0.5">
          {v.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {v.existingId && existingTab && (
        <div className="mt-1">
          <RecordLink
            section="reddit"
            id={v.existingId}
            query={{ tab: existingTab }}
          >
            {r.common.existing}
          </RecordLink>
        </div>
      )}
      {v.conflict && (
        <div className="mt-2">
          <Button
            variant="outline"
            icon={<RefreshCw size={16} />}
            onClick={onReload ?? (() => window.location.reload())}
          >
            {t.common.reload}
          </Button>
        </div>
      )}
    </Alert>
  );
}

/**
 * Цитата Reddit: React-текст в `<pre>` (никакой разметки, ссылки не
 * активны); пометка «похоже на команду модели» — отдельной плашкой.
 */
export function PlainQuote({
  text,
  injectionFlag,
  label,
}: {
  text: string;
  injectionFlag?: string | null;
  /** Имя прокручиваемой области (axe `scrollable-region-focusable`). */
  label?: string;
}) {
  const { r } = useReddit();
  return (
    <div className="space-y-1">
      {injectionFlag && (
        <Alert tone="warning">
          {fmtText(r.rules.injectionFlag, { flag: injectionFlag })}
        </Alert>
      )}
      <pre
        data-reddit-quote=""
        tabIndex={0}
        role="region"
        aria-label={label ?? r.common.textRegion}
        className="text-sm whitespace-pre-wrap break-words font-sans rounded-lg bg-silver-100 dark:bg-silver-950 px-3 py-2 max-h-72 overflow-auto"
      >
        {text}
      </pre>
      <div className="text-xs text-silver-500">{r.common.plainText}</div>
    </div>
  );
}

/** «Открыть на Reddit» — сохранённый канонический URL, без превью. */
export function RedditLink({
  url,
  children,
}: {
  url: string;
  children?: ReactNode;
}) {
  const { r } = useReddit();
  const href = redditHref(url);
  if (!href) return <span className="break-all text-xs">{url}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent hover:underline inline-flex items-center gap-1 break-all text-sm"
    >
      {children ?? r.common.openOnReddit}
      <ExternalLink size={12} aria-hidden="true" />
    </a>
  );
}

/** Первоисточник правил (любой https-адрес; не загружается). */
export function SourceLink({ url }: { url: string }) {
  const { r } = useReddit();
  if (url === '')
    return <span className="text-silver-500">{r.rules.noSource}</span>;
  const href = httpsHref(url);
  if (!href) return <span className="break-all">{url}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent hover:underline inline-flex items-center gap-1 break-all"
    >
      {url}
      <ExternalLink size={12} aria-hidden="true" />
    </a>
  );
}

export function VerdictBadge({
  verdict,
  label,
  tone,
}: {
  verdict: RedditPolicyVerdict | null | undefined;
  /** Подпись вместо «Policy Gate» («Гейт сейчас», «На момент оценки»). */
  label?: string;
  /** Тон вместо вычисленного (исторический вердикт — без зелёного). */
  tone?: Tone;
}) {
  const { r } = useReddit();
  return (
    <Badge tone={tone ?? verdictTone(verdict)}>
      {label ?? r.gate.title}:{' '}
      {verdict ? r.gate.verdicts[verdict] : r.common.unknown}
    </Badge>
  );
}

/** Причины BLOCK/перепроверки и предупреждения — списком словами. */
export function GateReasons({
  reasons,
  warnings = [],
}: {
  reasons: readonly RedditPolicyReason[];
  warnings?: readonly RedditPolicyWarning[];
}) {
  const { r } = useReddit();
  if (!reasons.length && !warnings.length) return null;
  return (
    <ul className="text-xs list-disc pl-5 space-y-0.5">
      {reasons.map((x) => (
        <li key={x} className="text-rose-700 dark:text-rose-400">
          {r.gate.reasons[x]}
        </li>
      ))}
      {warnings.map((x) => (
        <li key={x} className="text-amber-700 dark:text-amber-400">
          {r.gate.warnings[x]}
        </li>
      ))}
    </ul>
  );
}

export function GateBlock({ gate }: { gate: RedditGateView }) {
  return (
    <div className="space-y-1">
      <VerdictBadge verdict={gate.verdict} />
      <GateReasons reasons={gate.reasons} warnings={gate.warnings} />
    </div>
  );
}

/** Выбор проекта (фильтр или форма); пустое — «все»/«выберите». */
export function ProjectSelect({
  projects,
  value,
  onChange,
  empty,
  label,
  activeOnly,
}: {
  projects: readonly RedditProjectView[];
  value: string;
  onChange: (v: string) => void;
  empty: string;
  label: string;
  activeOnly?: boolean;
}) {
  const { r } = useReddit();
  const list = projects.filter(
    (p) => !activeOnly || p.status === 'active' || p.id === value
  );
  return (
    <label className="text-xs text-silver-500 flex flex-col gap-1 min-w-0">
      {label}
      <select
        className={`${inputClass} w-auto max-w-full`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{empty}</option>
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title}
            {p.status === 'archived' ? ` (${r.statuses.archived})` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CommunitySelect({
  communities,
  value,
  onChange,
  empty,
  label,
  activeOnly,
}: {
  communities: readonly RedditCommunityView[];
  value: string;
  onChange: (v: string) => void;
  empty: string;
  label: string;
  activeOnly?: boolean;
}) {
  const { r } = useReddit();
  const list = communities.filter(
    (c) => !activeOnly || c.status === 'active' || c.id === value
  );
  return (
    <label className="text-xs text-silver-500 flex flex-col gap-1 min-w-0">
      {label}
      <select
        className={`${inputClass} w-auto max-w-full`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{empty}</option>
        {list.map((c) => (
          <option key={c.id} value={c.id}>
            r/{c.subreddit}
            {c.status === 'archived' ? ` (${r.statuses.archived})` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Поиск по подстроке (`q`): применяется кнопкой/Enter, не на каждую букву. */
export function SearchBox({
  value,
  onChange,
  onApply,
}: {
  value: string;
  onChange: (v: string) => void;
  onApply: () => void;
}) {
  const { r } = useReddit();
  return (
    <form
      className="flex items-end gap-2 min-w-0"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onApply();
      }}
    >
      <label className="text-xs text-silver-500 flex flex-col gap-1 min-w-0">
        {r.common.search}
        <input
          className={`${inputClass} w-44 max-w-full`}
          type="search"
          value={value}
          maxLength={200}
          placeholder={r.common.searchHint}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      <Button variant="outline" type="submit">
        {r.common.apply}
      </Button>
    </form>
  );
}

/**
 * Отзыв доказательства Reddit (выдержка треда, первоисточник правил) —
 * `POST /sources/:id/revoke` (`source.manage`). Ответ отзыва у источников
 * Reddit урезан (url/title = null, fragment = '') — экран его не
 * показывает, а перечитывает карточку (`onDone`).
 */
export function RevokeEvidence({
  sourceId,
  label,
  onDone,
  context,
}: {
  sourceId: string;
  label: string;
  onDone: () => void;
  /** Что отзывается («редакція 2», «v3») — в доступное имя поля причины. */
  context?: string;
}) {
  const { r, can } = useReddit();
  const apis = usePubApis();
  const m = useMutation();
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(false);
  if (!can('source.manage')) return null;
  return (
    <div className="space-y-2">
      <div className="text-xs text-silver-500">{r.common.revokeHint}</div>
      <Field
        label={
          <>
            {context && <span className="sr-only">{context}: </span>}
            {r.common.revokeReason}
          </>
        }
      >
        <TextArea
          value={reason}
          rows={2}
          maxLength={2000}
          onChange={setReason}
        />
      </Field>
      <RedditErrorAlert error={m.error} onReload={onDone} />
      {done && <Alert tone="success">{r.common.revoked}</Alert>}
      <ConfirmButton
        variant="outline"
        loading={m.busy}
        disabled={!reason.trim()}
        onConfirm={async () => {
          setDone(false);
          const x = await m.run(
            (k) => apis.content.revokeSource(sourceId, reason.trim(), k),
            `revoke:${sourceId}:${reason.trim()}`
          );
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

/**
 * Расхождения после перечитывания (UI-аудит S2-1): поле изменили и вы, и
 * кто-то другой — показываются оба значения, выбор обязателен.
 */
export function ConflictPanel<F extends object>({
  conflicts,
  label,
  show,
  resolve,
}: {
  conflicts: FieldConflict<F>[];
  label: (key: keyof F) => string;
  show?: (key: keyof F, value: F[keyof F]) => string;
  resolve: (key: keyof F, pick: 'mine' | 'theirs') => void;
}) {
  const { r } = useReddit();
  if (!conflicts.length) return null;
  const fmt = (k: keyof F, x: F[keyof F]) =>
    show ? show(k, x) : Array.isArray(x) ? x.join(', ') : String(x ?? '');
  return (
    <Alert tone="warning" title={r.common.conflictTitle}>
      <ul className="space-y-2" data-reddit-conflicts="">
        {conflicts.map((c) => (
          <li key={String(c.key)} className="space-y-1">
            <div className="font-medium">{label(c.key)}</div>
            <div className="text-xs whitespace-pre-wrap break-words">
              {r.common.conflictTheirs}: {fmt(c.key, c.theirs) || r.common.none}
            </div>
            <div className="text-xs whitespace-pre-wrap break-words">
              {r.common.conflictMine}: {fmt(c.key, c.mine) || r.common.none}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => resolve(c.key, 'theirs')}
              >
                {r.common.takeTheirs}
              </Button>
              <Button variant="outline" onClick={() => resolve(c.key, 'mine')}>
                {r.common.keepMine}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Alert>
  );
}

/** Пользовательский текст в заголовке: длинные «слова» переносятся. */
export function Wrap({ children }: { children: ReactNode }) {
  return (
    <span className="break-words [overflow-wrap:anywhere]">{children}</span>
  );
}

/** Подсказка «только просмотр» для ролей без `reddit.manage`. */
export function ReadOnlyNote() {
  const { r } = useReddit();
  return <Alert tone="neutral">{r.common.readOnly}</Alert>;
}
