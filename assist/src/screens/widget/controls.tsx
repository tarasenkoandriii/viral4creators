import type { ReactNode } from 'react';
import { fmt, formatDate, useKit } from '../../kit';
import { Badge, Card, inputClass } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import type { ConfigHistoryItem } from '../../lib/widget-types';
import { ConfirmButton } from '../knowledge/parts';

/** Подпись + поле + подсказка. */
export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <div className="text-xs text-silver-500">{hint}</div>}
    </div>
  );
}

/** Выпадающий список значений перечня (подписи — из словаря). */
export function Select<T extends string>({
  id,
  value,
  options,
  labels,
  onChange,
}: {
  id?: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (v: T) => void;
}) {
  return (
    <select
      id={id}
      className={inputClass}
      value={value}
      onChange={(e) => {
        const v = e.target.value as T;
        if (options.includes(v)) onChange(v);
      }}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {labels[o]}
        </option>
      ))}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm min-h-[36px]">
      <input
        type="checkbox"
        className="h-4 w-4 accent-current"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function NumberInput({
  id,
  value,
  min,
  max,
  onChange,
}: {
  id?: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      className={inputClass}
      value={value}
      min={min}
      max={max}
      onChange={(e) => {
        const n = Math.round(Number(e.target.value));
        if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
      }}
    />
  );
}

/** История публикаций с откатом в два нажатия (вид и персона). */
export function HistoryList({
  history,
  current,
  busy,
  onRollback,
}: {
  history: ConfigHistoryItem[];
  current: number;
  busy: number | null;
  onRollback: (version: number) => void;
}) {
  const { locale } = useKit();
  const { appDict } = useAssist();
  const t = appDict.setup.common;
  return (
    <Card className="space-y-2 text-sm">
      <div className="font-semibold">{t.history}</div>
      {history.length === 0 && (
        <div className="text-silver-500">{t.historyEmpty}</div>
      )}
      {history.map((h) => (
        <div
          key={h.version}
          className="flex flex-wrap items-center gap-2 border-t border-silver-200/70 dark:border-silver-800 pt-2"
        >
          <span className="font-medium">
            {fmt(t.version, { n: h.version })}
          </span>
          {h.version === current && (
            <Badge tone="success">
              {fmt(t.publishedLabel, { n: h.version })}
            </Badge>
          )}
          <span className="text-xs text-silver-500 flex-1">
            {formatDate(h.publishedAt, locale)}
            {h.rolledBackFrom !== null &&
              ` · ${fmt(t.rolledBackFrom, { n: h.rolledBackFrom })}`}
          </span>
          {h.version !== current && (
            <ConfirmButton
              variant="ghost"
              hint={t.rollbackHint}
              loading={busy === h.version}
              onConfirm={() => onRollback(h.version)}
            >
              {t.rollback}
            </ConfirmButton>
          )}
        </div>
      ))}
    </Card>
  );
}
