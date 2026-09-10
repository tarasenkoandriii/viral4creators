import type { HTMLAttributes, ReactNode } from 'react';

/** Card — SilverFinance `components/ui/Card.tsx`, verbatim recipe. */
export function Card({
  children,
  className = '',
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-2xl border border-silver-200/70 dark:border-silver-800 bg-white/70 dark:bg-silver-900/60 backdrop-blur shadow-card ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Card header: title + optional hint + optional right-side action. */
export function CardHeader({
  title,
  hint,
  action,
  icon,
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    // Кнопка действия перестала отбирать ширину у заголовка. В карточке
    // 288px (телефон 320px) заголовку оставалось 126px: «Сцены бренда»
    // ломалось на две строки, иконка отрывалась от текста, а подпись
    // сыпалась на четыре узких строки — при том, что под кнопкой пустовало
    // ~90px (аудит 2026-09-06, А-3.6). Теперь строка переносится: пока
    // заголовку хватает basis-40 (160px), кнопка стоит справа как раньше;
    // как только не хватает — она уходит на свою строку, а заголовок с
    // подписью получают всю ширину карточки.
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2 mb-4">
      <div className="min-w-0 flex-1 basis-40">
        <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">
          {icon}
          {title}
        </h2>
        {hint && <p className="text-xs text-silver-400 mt-0.5">{hint}</p>}
      </div>
      {/* ml-auto держит кнопку у правого края и после переноса — без него
          на своей строке она встала бы слева. */}
      {action && <div className="ml-auto shrink-0">{action}</div>}
    </div>
  );
}

/**
 * Feature panel — the accent-tinted box SilverFinance uses for its AI /
 * Lens / 3D blocks in AuctionForm (`rounded-lg border-accent/30 bg-accent/5`).
 */
export function FeaturePanel({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-accent/30 bg-accent/5 p-3 ${className}`}
    >
      {children}
    </div>
  );
}
