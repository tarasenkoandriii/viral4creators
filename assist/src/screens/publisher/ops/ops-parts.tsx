/**
 * AI Publisher (P-G2) — мелкие части экранов денег, заявок и отчётов
 * поверх общих частей P-G1 (`../parts.tsx`): метка «план/прогноз/факт/
 * неизвестно», выбор участника, ввод суммы, раскрывающийся блок действия,
 * подвал списка с «показать ещё».
 */
import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge, inputClass } from '../../../kit/ui';
import {
  parseMoneyInput,
  type AmountKind,
} from '../../../lib/publisher/ops-view';
import { EmptyState, LoadMore, PubErrorAlert } from '../parts';
import { useMembers, useOps, type Paged } from './ops-hooks';

/** «план / прогноз / факт / неизвестно» — различимы (ТЗ §8.4). */
export function KindBadge({ kind }: { kind: AmountKind | 'preliminary' }) {
  const { o } = useOps();
  const tone =
    kind === 'fact' ? 'neutral' : kind === 'plan' ? 'accent' : 'warning';
  return <Badge tone={tone}>{o.common.kinds[kind]}</Badge>;
}

/**
 * Участник кабинета: список (владелец/менеджер видят всех) или ручной id.
 * `allowNone` — пустое значение «не назначен».
 */
export function MemberPicker({
  value,
  onChange,
  allowNone,
}: {
  value: string;
  onChange: (v: string) => void;
  allowNone?: boolean;
}) {
  const { o, memberId } = useOps();
  const members = useMembers();
  if (!members) {
    return (
      <div className="flex gap-2">
        <input
          className={inputClass}
          value={value}
          placeholder={o.common.memberId}
          onChange={(e) => onChange(e.target.value.trim())}
        />
        <button
          type="button"
          className="text-xs text-accent shrink-0"
          onClick={() => onChange(memberId)}
        >
          {o.common.me}
        </button>
      </div>
    );
  }
  const known = !value || members.some((m) => m.memberId === value);
  return (
    <select
      className={inputClass}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{allowNone ? o.common.nobody : o.common.choose}</option>
      {!known && <option value={value}>{value}</option>}
      {members.map((m) => (
        <option key={m.memberId} value={m.memberId}>
          {m.memberId === memberId ? `${o.common.me} · ${m.label}` : m.label}
        </option>
      ))}
    </select>
  );
}

/** Ввод суммы человеком; наружу — минимальные единицы или null. */
export function MoneyInput({
  value,
  onChange,
  allowNegative,
}: {
  value: string;
  onChange: (raw: string, minor: string | null) => void;
  allowNegative?: boolean;
}) {
  const minor = parseMoneyInput(value);
  const bad =
    value !== '' &&
    (minor === null || (!allowNegative && minor.startsWith('-')));
  return (
    <input
      className={`${inputClass} ${bad ? 'border-rose-500' : ''}`}
      inputMode="decimal"
      value={value}
      placeholder="0,00"
      onChange={(e) => {
        const raw = e.target.value;
        const m = parseMoneyInput(raw);
        onChange(
          raw,
          m !== null && !allowNegative && m.startsWith('-') ? null : m
        );
      }}
    />
  );
}

/** Раскрывающийся блок действия (формы шагов машин). */
export function ActionBlock({
  title,
  children,
  defaultOpen = false,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-silver-200/70 dark:border-silver-800">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-left min-h-[44px]"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        {title}
      </button>
      {open && <div className="px-3 pb-3 space-y-2">{children}</div>}
    </div>
  );
}

/** Подвал списка: ошибка, пусто, «показать ещё». */
export function PagedFooter<T>({
  page,
  empty,
}: {
  page: Paged<T>;
  empty: string;
}) {
  return (
    <>
      {page.error ? (
        <PubErrorAlert error={page.error} onReload={page.reload} />
      ) : null}
      {!page.loading && !page.error && page.items.length === 0 && (
        <EmptyState>{empty}</EmptyState>
      )}
      <LoadMore next={page.next} onMore={page.more} loading={page.loading} />
    </>
  );
}

/** Строка таблицы-списка: заголовок-ссылка + бейджи + подписи. */
export function ListRow({
  title,
  badges,
  children,
}: {
  title: ReactNode;
  badges?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="py-2 border-b border-silver-200/60 dark:border-silver-800 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium min-w-0 break-words">{title}</span>
        {badges}
      </div>
      {children && (
        <div className="text-xs text-silver-500 mt-0.5 space-y-0.5">
          {children}
        </div>
      )}
    </li>
  );
}
