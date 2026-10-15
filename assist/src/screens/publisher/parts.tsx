/**
 * AI Publisher (P-G1) — общие части экранов раздела (P-G1 и P-G2):
 * ошибки `PUB_*`, плашка неполноты, «не рассчитывается», статусы без
 * «зелёного при неизвестном», гейты, деньги, ссылки на связанные записи,
 * панель фильтров с выгрузкой CSV (ТЗ §8.4). Хуки — `hooks.ts`.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Download, ExternalLink, RefreshCw } from 'lucide-react';
import { useKit } from '../../kit';
import { Alert, Badge, Button, Card, Spinner, inputClass } from '../../kit/ui';
import type { Completeness, Computable } from '../../lib/publisher/decode';
import type { GateResult } from '../../lib/publisher/core-api';
import { describePubError } from '../../lib/publisher/errors';
import type { GateName } from '../../lib/publisher/states';
import {
  completenessTone,
  computableText,
  confirmClick,
  fmtDate,
  fmtDateTime,
  fmtMinor,
  fmtText,
  gateDetailLabel,
  gateTone,
  missingLabel,
  ownerOptions,
  safeHref,
  statusLabel,
  statusTone,
  type Tone,
} from '../../lib/publisher/view';
import { CSV_MAX_PARTS, type Query } from '../../lib/publisher/common-api';
import { useCsvExport } from './hooks';
import { usePublisher, type PubQuery } from './publisher-context';

/** Ошибка API человеческим текстом; `PUB_CONFLICT` — перезагрузка. */
export function PubErrorAlert({
  error,
  onReload,
  manualHint,
}: {
  error: unknown;
  onReload?: () => void;
  /** Подсказка ручного пути для AI-ошибок (`PUB_AI_DISABLED` и др.). */
  manualHint?: ReactNode;
}) {
  const { t } = usePublisher();
  if (!error) return null;
  const v = describePubError(error, t);
  return (
    <Alert
      tone={v.conflict || v.manualPath ? 'warning' : 'danger'}
      title={v.title}
    >
      {v.lines.length > 0 && (
        <ul className="list-disc pl-5 space-y-0.5">
          {v.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {v.manualPath && manualHint && <div className="mt-1">{manualHint}</div>}
      {v.conflict && (
        <div className="mt-2">
          <Button
            variant="outline"
            icon={<RefreshCw size={16} />}
            // Без перезагрузки данных экрана — перезагрузка страницы (маршрут
            // в hash сохраняется): у 409 кнопка есть всегда (аудит G S3-11).
            onClick={onReload ?? (() => window.location.reload())}
          >
            {t.common.reload}
          </Button>
        </div>
      )}
    </Alert>
  );
}

/** Загрузка / ошибка / данные — одинаково на всех экранах. */
export function Loadable<T>({
  state,
  children,
}: {
  state: {
    data: T | null;
    error: Error | null;
    loading: boolean;
    reload: () => void;
  };
  children: (data: T) => ReactNode;
}) {
  const { t } = usePublisher();
  if (state.loading && !state.data) return <Spinner label={t.common.loading} />;
  if (state.error) {
    return (
      <div className="space-y-2">
        <PubErrorAlert error={state.error} onReload={state.reload} />
        <Button variant="outline" onClick={state.reload}>
          {t.common.retry}
        </Button>
      </div>
    );
  }
  if (!state.data) return <Spinner label={t.common.loading} />;
  return <>{children(state.data)}</>;
}

export function StatusBadge({
  status,
  labels,
  tone,
}: {
  status: string | null | undefined;
  labels?: Record<string, string>;
  tone?: Tone;
}) {
  const { t } = usePublisher();
  return (
    <Badge tone={tone ?? statusTone(status)}>
      {statusLabel(status ?? 'unknown', labels, t.status)}
    </Badge>
  );
}

/** Плашка неполноты (ТЗ §8.4: «явная неполнота данных»). */
export function CompletenessBanner({
  completeness,
}: {
  completeness: Completeness | null | undefined;
}) {
  const { t } = usePublisher();
  if (
    completeness &&
    completeness.state === 'complete' &&
    !completeness.missing.length
  ) {
    return null;
  }
  const state = completeness?.state ?? 'unknown';
  return (
    <Alert tone={completenessTone(completeness)} title={t.completeness[state]}>
      {completeness &&
        completeness.missing.length > 0 &&
        fmtText(t.completeness.missing, {
          list: completeness.missing
            .map((x) => missingLabel(x, t.completeness))
            .join(', '),
        })}
    </Alert>
  );
}

/** Значение метрики: `not_computable` — словами, не ноль (AT-CORE-18). */
export function ComputableText<T>({
  value,
  format,
}: {
  value: Computable<T> | null | undefined;
  format: (v: T) => string;
}) {
  const { t } = usePublisher();
  const c = computableText(value, format, t.computable, t.common.unknown);
  return (
    <span className="inline-flex flex-col">
      <span
        className={
          c.tone === 'warning' ? 'text-amber-700 dark:text-amber-400' : ''
        }
      >
        {c.text}
      </span>
      {c.note && <span className="text-xs text-silver-500">{c.note}</span>}
    </span>
  );
}

/** Сумма в минимальных единицах; `null` — «неизвестно», не 0. */
export function MoneyText({
  minor,
  currency,
}: {
  minor: string | null | undefined;
  currency?: string | null;
}) {
  const { locale, t } = usePublisher();
  const known = minor !== null && minor !== undefined;
  return (
    <span className={known ? '' : 'text-amber-700 dark:text-amber-400'}>
      {fmtMinor(minor, currency, locale, t.common.unknown)}
    </span>
  );
}

export function DateText({
  iso,
  time = false,
}: {
  iso: string | null | undefined;
  time?: boolean;
}) {
  const { locale, t } = usePublisher();
  if (!iso) return <span className="text-silver-500">{t.common.none}</span>;
  return <>{time ? fmtDateTime(iso, locale) : fmtDate(iso, locale)}</>;
}

/** Гейт: зелёный только без пунктов; пункты — списком (§10). */
export function GateCard({ result }: { result: GateResult | null }) {
  const { t } = usePublisher();
  if (!result) {
    return <Badge tone="warning">{t.gates.unknown}</Badge>;
  }
  const tone = gateTone(result);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="font-medium flex-1">{t.gates.names[result.gate]}</span>
        <Badge tone={tone}>
          {tone === 'success' ? t.gates.open : t.gates.closed}
        </Badge>
      </div>
      {result.missing.length > 0 && (
        <ul className="text-xs text-silver-600 dark:text-silver-400 list-disc pl-5">
          {result.missing.map((m, i) => (
            <li key={i}>
              {t.gates.missingKinds[m.kind]}:{' '}
              {m.kind === 'parameter'
                ? statusLabel(m.key, t.params.keys)
                : m.key}
              {m.detail
                ? ` — ${gateDetailLabel(m.detail, t, t.params.statuses)}`
                : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function GateBrief({
  gate,
  value,
}: {
  gate: GateName;
  value: { open: boolean; missingCount: number } | undefined;
}) {
  const { t } = usePublisher();
  const ok = !!value && value.open && value.missingCount === 0;
  return (
    <Badge tone={!value ? 'warning' : ok ? 'success' : 'danger'}>
      {t.gates.names[gate]}:{' '}
      {!value
        ? t.gates.unknown
        : ok
          ? t.gates.open
          : fmtText(t.gates.missingCount, { n: value.missingCount })}
    </Badge>
  );
}

/** Ссылка на связанную запись раздела (ТЗ §8.4). */
export function RecordLink({
  section,
  id,
  query,
  children,
}: {
  section: string;
  id?: string | null;
  query?: PubQuery;
  children: ReactNode;
}) {
  const { href } = usePublisher();
  return (
    <a
      href={href(section, id ?? null, query)}
      className="text-accent hover:underline inline-flex items-center gap-1 break-all"
    >
      {children}
    </a>
  );
}

export function ExternalUrl({ url }: { url: string | null | undefined }) {
  const { t } = usePublisher();
  if (!url) return <span className="text-silver-500">{t.common.none}</span>;
  const href = safeHref(url);
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent hover:underline inline-flex items-center gap-1 break-all"
    >
      {url}
      <ExternalLink size={12} />
    </a>
  ) : (
    <span className="break-all">{url}</span>
  );
}

export function EmptyState({ children }: { children?: ReactNode }) {
  const { t } = usePublisher();
  return (
    <div className="text-sm text-silver-500 py-4 text-center">
      {children ?? t.common.empty}
    </div>
  );
}

/**
 * Панель списка: фильтр по статусу и ответственному + выгрузка CSV тем же
 * фильтром (ТЗ §8.4). Ответственный — свободный id участника или «я».
 */
export function ListToolbar({
  statuses,
  status,
  onStatus,
  statusLabels,
  owner,
  onOwner,
  csvPath,
  csvQuery,
  extra,
  ownerNone,
}: {
  statuses?: readonly string[];
  status?: string;
  onStatus?: (v: string) => void;
  statusLabels?: Record<string, string>;
  owner?: string;
  onOwner?: (v: string) => void;
  csvPath?: string;
  csvQuery?: Query;
  extra?: ReactNode;
  /** Вариант «без ответственного» (`none`) — у списков, где сервер его понимает. */
  ownerNone?: boolean;
}) {
  const { t, memberId } = usePublisher();
  const { account } = useKit();
  const members = (account.members ?? [])
    .filter((m) => m.memberId)
    .map((m) => ({
      memberId: m.memberId,
      label: m.telegramId ? `tg ${m.telegramId}` : m.memberId,
    }));
  const csv = useCsvExport(csvPath ?? '', csvQuery);
  return (
    <div className="space-y-2 mb-3">
      <div className="flex flex-wrap items-end gap-2">
        {statuses && onStatus && (
          <label className="text-xs text-silver-500 flex flex-col gap-1">
            {t.common.status}
            <select
              className={`${inputClass} w-auto`}
              value={status ?? ''}
              onChange={(e) => onStatus(e.target.value)}
            >
              <option value="">{t.common.all}</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s, statusLabels, t.status)}
                </option>
              ))}
            </select>
          </label>
        )}
        {onOwner && (
          <label className="text-xs text-silver-500 flex flex-col gap-1">
            {t.common.owner}
            <select
              className={`${inputClass} w-auto`}
              value={owner ?? ''}
              onChange={(e) => onOwner(e.target.value)}
            >
              {ownerOptions(owner ?? '', memberId, members, ownerNone).map(
                (x) => (
                  <option key={x.value} value={x.value}>
                    {x.value === ''
                      ? t.common.anyOwner
                      : x.value === 'none'
                        ? t.common.noOwner
                        : x.value === memberId
                          ? t.common.me
                          : x.label}
                  </option>
                )
              )}
            </select>
          </label>
        )}
        {extra}
        {csvPath && (
          <Button
            variant="outline"
            icon={<Download size={16} />}
            loading={csv.busy}
            onClick={() => void csv.run()}
          >
            {t.common.exportCsv}
          </Button>
        )}
      </div>
      {csv.error ? <PubErrorAlert error={csv.error} /> : null}
      {csv.truncated ? (
        <Alert tone="warning">
          {fmtText(t.common.csvTruncated, { parts: CSV_MAX_PARTS })}
        </Alert>
      ) : null}
    </div>
  );
}

/** Подпись + поле (формы экранов). */
export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-silver-500">{label}</span>
      {children}
      {hint && <span className="block text-xs text-silver-500">{hint}</span>}
    </label>
  );
}

export function TextArea({
  value,
  onChange,
  rows = 3,
  placeholder,
  maxLength,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <textarea
      className={`${inputClass} min-h-[88px]`}
      value={value}
      rows={rows}
      placeholder={placeholder}
      maxLength={maxLength}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  maxLength,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  maxLength?: number;
}) {
  return (
    <input
      className={inputClass}
      type={type}
      value={value}
      placeholder={placeholder}
      maxLength={maxLength}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function Select<K extends string>({
  value,
  options,
  onChange,
  labels,
  empty,
  ariaLabel,
}: {
  value: K | '';
  options: readonly K[];
  onChange: (v: K | '') => void;
  labels?: Record<string, string>;
  empty?: string;
  /** Подпись для читалок, когда выбор не обёрнут в `Field`. */
  ariaLabel?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className={inputClass}
      value={value}
      onChange={(e) => onChange(e.target.value as K | '')}
    >
      {empty !== undefined && <option value="">{empty}</option>}
      {options.map((o) => (
        <option key={o} value={o}>
          {labels && Object.prototype.hasOwnProperty.call(labels, o)
            ? labels[o]
            : o}
        </option>
      ))}
    </select>
  );
}

/**
 * Необратимое — двойным нажатием (как `MembersScreen` кита: в части
 * WebView Telegram `window.confirm` заблокирован).
 */
export function ConfirmButton({
  onConfirm,
  children,
  loading,
  disabled,
  variant = 'danger',
}: {
  onConfirm: () => void;
  children: ReactNode;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'danger' | 'outline' | 'solid';
}) {
  const { t } = usePublisher();
  // Момент взвода (null — не взведена): подтверждение раньше паузы или
  // вторым щелчком двойного клика не засчитывается (аудит ui-3).
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const armed = armedAt !== null;
  useEffect(() => {
    if (armedAt === null) return;
    const timer = setTimeout(() => setArmedAt(null), 4000);
    return () => clearTimeout(timer);
  }, [armedAt]);
  return (
    <Button
      variant={armed ? 'danger' : variant}
      loading={loading}
      disabled={disabled}
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
      <span aria-live="polite">{armed ? t.common.confirmAgain : children}</span>
    </Button>
  );
}

export function Section({
  title,
  action,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold flex-1 min-w-0">{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

/** Строка «ключ: значение» карточки. */
export function Row({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap gap-x-2 text-sm">
      <span className="text-silver-500">{label}:</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

/** Подсказка «нет прав» (кнопка скрыта, решает сервер — AT-CORE-11). */
export function NoPermission({ children }: { children?: ReactNode }) {
  const { t } = usePublisher();
  return <Alert tone="neutral">{children ?? t.common.noPermission}</Alert>;
}

/** Успешное сообщение после мутации. */
export function Notice({ text }: { text: string | null }) {
  if (!text) return null;
  return <Alert tone="success">{text}</Alert>;
}

/** JSON-значение для показа (параметры, факты бренда). */
export function JsonView({ value }: { value: unknown }) {
  return (
    <pre className="text-xs whitespace-pre-wrap break-all rounded-lg bg-silver-100 dark:bg-silver-950 px-3 py-2 max-h-64 overflow-auto">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** «Показать ещё» по курсору `nextBefore`. */
export function LoadMore({
  next,
  onMore,
  loading,
}: {
  next: string | null;
  onMore: (before: string) => void;
  loading?: boolean;
}) {
  const { t } = usePublisher();
  if (!next) return null;
  return (
    <div className="pt-2">
      <Button variant="ghost" loading={loading} onClick={() => onMore(next)}>
        {t.common.more}
      </Button>
    </div>
  );
}
