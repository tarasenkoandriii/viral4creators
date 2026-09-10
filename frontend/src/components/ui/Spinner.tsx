import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

export function Spinner({
  size = 20,
  className = '',
}: {
  size?: number;
  className?: string;
}) {
  return (
    <Loader2 size={size} className={`animate-spin text-accent ${className}`} />
  );
}

/** Centered busy state with a title and an optional secondary line. */
export function Busy({ title, hint }: { title: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center animate-fadeIn">
      <Spinner size={28} className="mb-3" />
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="text-xs text-silver-400 mt-1">{hint}</p>}
    </div>
  );
}
