import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

/** Underline tabs — SilverFinance AuctionForm's `border-b-2 border-accent text-accent`. */
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  disabled,
  compact,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: ReactNode }[];
  disabled?: boolean;
  /** Tighter padding/type for tabs inside a narrow panel. */
  compact?: boolean;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const activeTab = useRef<HTMLButtonElement>(null);
  /** Есть ли вкладки за левым/правым краем — от этого зависит затенение. */
  const [more, setMore] = useState({ left: false, right: false });

  const syncEdges = useCallback(() => {
    const box = strip.current;
    if (!box) return;
    const max = box.scrollWidth - box.clientWidth;
    setMore({ left: box.scrollLeft > 1, right: box.scrollLeft < max - 1 });
  }, []);

  // На 320px четыре вкладки выбора референса требуют 308px при доступных
  // 246 — полоса прокручивается, и активная вкладка вполне может лежать за
  // правым краем. Хуже всего это было при заходе на #/generate без товара:
  // активной по умолчанию оказывалась последняя, «Файл», и человек видел
  // три невыделенные вкладки и дропзону непонятно откуда (аудит
  // 2026-09-06, А-3.5). Подтягиваем активную в видимую часть — и на первом
  // рендере, и при программной смене вкладки.
  useLayoutEffect(() => {
    const box = strip.current;
    const tab = activeTab.current;
    if (!box || !tab) return;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < box.scrollLeft) box.scrollLeft = Math.max(0, left - 8);
    else if (right > box.scrollLeft + box.clientWidth)
      box.scrollLeft = right - box.clientWidth + 8;
    syncEdges();
  }, [value, tabs.length, syncEdges]);

  // Ширина полосы меняется и без смены вкладки — поворот телефона,
  // раскрытие соседнего блока. Без пересчёта затенение врёт.
  useEffect(() => {
    const box = strip.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(syncEdges);
    ro.observe(box);
    return () => ro.disconnect();
  }, [syncEdges]);

  return (
    <div
      ref={strip}
      onScroll={syncEdges}
      // `tab-strip-more-*` гасит край, за которым ещё есть вкладки: без
      // такой подсказки прокручиваемая полоса читается как «здесь всё».
      className={`mb-4 flex gap-1.5 border-b border-silver-200/60 dark:border-silver-800 overflow-x-auto ${
        more.left ? 'tab-strip-more-left' : ''
      } ${more.right ? 'tab-strip-more-right' : ''}`}
    >
      {tabs.map((t) => (
        <button
          key={t.value}
          ref={value === t.value ? activeTab : undefined}
          type="button"
          disabled={disabled}
          onClick={() => onChange(t.value)}
          // min-h-[44px] — рекомендованная тач-цель: до этого вкладка была
          // высотой 30px (компактный вариант) и промахнуться было легко.
          className={`${compact ? 'px-2 py-2 text-xs' : 'px-4 py-2 text-sm'} min-h-[44px] font-medium -mb-px border-b-2 whitespace-nowrap transition-colors disabled:opacity-50 ${
            value === t.value
              ? 'border-accent text-accent'
              : 'border-transparent text-silver-400 hover:text-silver-700 dark:hover:text-silver-200'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
