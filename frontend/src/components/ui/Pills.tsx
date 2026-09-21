import type { ReactNode } from 'react';
import { haptic } from '../../lib/telegram';
import { pillColumns } from './pill-columns';

/**
 * Segmented control — SilverFinance's "metal pills" from the TMA page
 * (`rounded-xl py-2 text-xs font-medium`, active = accent fill).
 */
export interface PillOption<T extends string> {
  value: T;
  label: ReactNode;
  sub?: ReactNode;
  /**
   * Вариант виден, но не выбирается — так закрыт режимом (ТЗ §23).
   * Показать и погасить честнее, чем убрать: убранного варианта для
   * пользователя не существует, и он не узнает, что режим что-то даёт.
   */
  disabled?: boolean;
}

export function Pills<T extends string>({
  value,
  options,
  onChange,
  disabled,
  columns,
  ariaLabel,
}: {
  value: T;
  options: PillOption<T>[];
  onChange: (v: T) => void;
  disabled?: boolean;
  columns?: number;
  /** Подпись группы для скринридера (аудит 14.09.2026, М-7.6). */
  ariaLabel?: string;
}) {
  return (
    <div
      // М-7.6: группа — radiogroup, каждая пилюля — radio с aria-checked,
      // иначе скринридер читал набор одинаковых кнопок без выбранного.
      role="radiogroup"
      aria-label={ariaLabel}
      className="grid gap-2"
      style={{
        gridTemplateColumns: `repeat(${pillColumns(options, columns)}, minmax(0, 1fr))`,
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled || o.disabled}
            onClick={() => {
              onChange(o.value);
              haptic();
            }}
            // min-h-44: палец не попадает в 32 пиксела (этап 44 задал этот
            // минимум кнопкам, но пилюли остались короткими — с одной
            // строкой текста они складывались ровно в 32).
            // `break-words` — вторая половина той же починки: колонка
            // с `minmax(0, 1fr)` не растягивается, но содержимое без
            // разрыва длинных слов всё равно вылезает за фон кнопки.
            className={`flex min-h-[44px] flex-col justify-center break-words rounded-xl px-2 py-2 text-xs font-medium transition-colors disabled:opacity-50 ${
              active
                ? 'bg-accent text-accent-on'
                : 'bg-silver-200/60 dark:bg-silver-800/60 text-silver-500 hover:text-silver-700 dark:hover:text-silver-300'
            }`}
          >
            <div>{o.label}</div>
            {o.sub && (
              <div
                className={`text-[11px] ${active ? 'opacity-70' : 'opacity-60'}`}
              >
                {o.sub}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
