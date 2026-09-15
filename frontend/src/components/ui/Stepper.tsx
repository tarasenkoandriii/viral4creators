import { Check } from 'lucide-react';

/**
 * Compact step indicator (replaces the old boxy ProgressIndicator card).
 * Completed = accent check, current = accent ring, upcoming = muted.
 */
export function Stepper({
  steps,
  current,
  onSelect,
  selectable,
}: {
  steps: string[];
  current: number;
  /** When given, completed steps become clickable (revisit). */
  onSelect?: (index: number) => void;
  /**
   * Какие шаги можно выбрать (этап 52, В-1.5). Без этого списка
   * кликабельны только пройденные (`i < current`) — и, вернувшись на
   * первый шаг, дальше по степперу было не уйти.
   */
  selectable?: boolean[];
}) {
  return (
    // mb-3, а не прежние mb-5: тач-цель шага выросла с 24 до 44px
    // (А-3.7), и с прежним отступом индикатор оторвался бы от карточки.
    <ol className="flex items-center gap-1 mb-3">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        const clickable =
          !!onSelect && !active && (selectable ? selectable[i] === true : done);
        return (
          <li key={label} className="flex items-center gap-1 flex-1 min-w-0">
            <button
              type="button"
              disabled={!clickable}
              onClick={() => onSelect?.(i)}
              // Пройденный шаг — кнопка возврата, и промахнуться по кружку
              // 24px легко. Кружок остаётся 24px, растёт только область
              // нажатия вокруг него (А-3.7).
              className={`flex min-h-[44px] items-center gap-1.5 min-w-0 ${clickable ? 'cursor-pointer' : 'cursor-default'}`}
            >
              <span
                className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold tabular transition-colors ${
                  done
                    ? 'bg-accent text-accent-on'
                    : active
                      ? 'ring-2 ring-accent text-accent'
                      : clickable
                        ? // Вернулись назад по степперу на уже пройденный
                          // шаг (этап 52) — следующий шаг остаётся
                          // доступным (`selectable`), но красился как
                          // самый обычный недостижимый: тонкая рамка
                          // отличает «можно кликнуть и продолжить» от
                          // «сначала пройдите предыдущие».
                          'border border-accent/50 text-accent/80'
                        : 'bg-silver-200/60 dark:bg-silver-800/60 text-silver-500'
                }`}
              >
                {done ? <Check size={12} /> : i + 1}
              </span>
              <span
                className={`hidden sm:block truncate text-xs ${
                  active
                    ? 'text-silver-900 dark:text-silver-100 font-medium'
                    : 'text-silver-400'
                }`}
              >
                {label}
              </span>
            </button>
            {i < steps.length - 1 && (
              <span
                className={`h-px flex-1 ${done ? 'bg-accent/60' : 'bg-silver-200 dark:bg-silver-800'}`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
