import type { ReactNode } from 'react';

/** Small status pill — SilverFinance's `rounded-full bg-amber-500/15 text-amber-500 text-[11px]`. */
type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

/*
 * Этап 50 (В-5.9): контраст меряется парой «чернила / подложка бейджа»,
 * а не «чернила / фон страницы». На 15 %-заливке цветные -500 давали
 * 1,85–2,83 в светлой теме («бесплатно» — 2,17). Заливка поднята до 20 %,
 * чернила в светлой теме — до -700/-800 (4,5–6,4), в тёмной — -400
 * (5,0–6,8). Пары посчитаны по формуле WCAG, не на глаз.
 */
const tones: Record<Tone, string> = {
  neutral:
    'bg-silver-200/60 dark:bg-silver-800/60 text-silver-600 dark:text-silver-400',
  accent: 'bg-accent/20 text-sky-800 dark:text-accent',
  success: 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-400',
  warning: 'bg-amber-500/20 text-amber-800 dark:text-amber-400',
  danger: 'bg-rose-500/20 text-rose-700 dark:text-rose-400',
};

export function Badge({
  tone = 'neutral',
  children,
  className = '',
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
