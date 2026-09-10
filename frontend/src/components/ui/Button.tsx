import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Button — ported from SilverFinance `components/ui/Button.tsx` (same base
 * recipe and solid/ghost/outline variants), plus `danger`, sizes and a
 * built-in loading spinner that this app's async-heavy flows need.
 */
type Variant = 'solid' | 'ghost' | 'outline' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  active?: boolean;
  loading?: boolean;
  icon?: ReactNode;
  block?: boolean;
}

const base =
  'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all focus:outline-none focus:ring-2 focus:ring-accent/60 disabled:opacity-50 disabled:cursor-not-allowed select-none';

/**
 * Б-4.8: тач-цели. Этап 40 поднял навигацию, вкладки и степпер, но не
 * общую кнопку: `md` давал 36px, `sm` — 28px при норме 44×44. Через
 * `md` идут «Скачать», «Ещё один ролик», «Создать проект»,
 * «Прослушать» — то есть почти все действия экрана.
 *
 * `min-h` вместо увеличенного `py`: высота гарантирована, а вертикальные
 * отступы остаются прежними, поэтому плотные ряды кнопок не разъезжаются.
 */
const sizes: Record<Size, string> = {
  // Этап 50 (В-5.8): `sm` тоже 44 — через него идут «Удалить проект»,
  // «Прослушать», «Скачать», «Своя сцена»: самостоятельные действия, а не
  // декор. Ширина при этом прежняя.
  sm: 'px-3 py-1.5 text-xs min-h-[44px]',
  md: 'px-4 py-2 text-sm min-h-[44px]',
  lg: 'px-5 py-3 text-sm min-h-[44px]',
};

const variants: Record<Variant, string> = {
  solid: 'bg-accent text-accent-on hover:shadow-glow hover:brightness-105',
  ghost:
    'text-silver-600 dark:text-silver-300 hover:bg-silver-200/60 dark:hover:bg-silver-800/60',
  outline:
    'border border-silver-300 dark:border-silver-700 text-silver-700 dark:text-silver-200 hover:border-accent',
  danger: 'border border-rose-500/40 text-rose-500 hover:bg-rose-500/10',
};

export function Button({
  variant = 'solid',
  size = 'md',
  active,
  loading,
  icon,
  block,
  className = '',
  children,
  disabled,
  ...rest
}: Props) {
  return (
    <button
      className={`${base} ${sizes[size]} ${variants[variant]} ${
        active ? 'ring-2 ring-accent bg-accent/15 text-accent' : ''
      } ${
        // Кнопка из одной иконки («Удалить манифест») без подписи была
        // 38px шириной — цель нажатия квадратом 44 (этап 50, В-5.8).
        children === undefined || children === null ? 'min-w-[44px]' : ''
      } ${block ? 'w-full' : ''} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 size={16} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}
