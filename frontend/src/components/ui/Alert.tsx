import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useI18n } from '../../lib/i18n-context';

type Tone = 'error' | 'warning' | 'info' | 'success';

const tones: Record<Tone, { box: string; icon: ReactNode }> = {
  error: {
    box: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400',
    icon: <XCircle size={16} />,
  },
  warning: {
    box: 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-400',
    icon: <AlertTriangle size={16} />,
  },
  info: {
    box: 'border-accent/30 bg-accent/10 text-accent',
    icon: <Info size={16} />,
  },
  success: {
    box: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-400',
    icon: <CheckCircle2 size={16} />,
  },
};

export function Alert({
  tone = 'info',
  title,
  children,
  onDismiss,
  className = '',
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  const { dict } = useI18n();
  const t = tones[tone];
  return (
    <div
      className={`flex items-start gap-2 rounded-lg border p-3 text-sm animate-fadeIn ${t.box} ${className}`}
    >
      <span className="mt-0.5 shrink-0">{t.icon}</span>
      <div className="min-w-0 flex-1">
        {title && <div className="font-medium">{title}</div>}
        {children && (
          <div
            className={`${title ? 'mt-0.5' : ''} text-silver-700 dark:text-silver-200`}
          >
            {children}
          </div>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 opacity-70 hover:opacity-100"
          aria-label={dict.common.close}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
