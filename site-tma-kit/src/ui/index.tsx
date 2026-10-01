/**
 * Минимальный UI-кит кабинета — рецепты `frontend/src/components/ui`
 * (Button/Card/Badge/Alert), чтобы два TMA выглядели как одна семья с
 * генератором. Цвета — токены `silver-*`/`accent` из tailwind-конфига
 * приложения (переменные по темам).
 */

import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';

type Variant = 'solid' | 'ghost' | 'outline' | 'danger';

const base =
  'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all focus:outline-none focus:ring-2 focus:ring-accent/60 disabled:opacity-50 disabled:cursor-not-allowed select-none px-4 py-2 text-sm min-h-[44px]';

const variants: Record<Variant, string> = {
  solid: 'bg-accent text-accent-on hover:brightness-105',
  ghost:
    'text-silver-600 dark:text-silver-300 hover:bg-silver-200/60 dark:hover:bg-silver-800/60',
  outline:
    'border border-silver-300 dark:border-silver-700 text-silver-700 dark:text-silver-200 hover:border-accent',
  danger: 'border border-rose-500/40 text-rose-500 hover:bg-rose-500/10',
};

export function Button({
  variant = 'solid',
  loading,
  block,
  icon,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  loading?: boolean;
  block?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`${base} ${variants[variant]} ${block ? 'w-full' : ''} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 size={16} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-silver-200/70 dark:border-silver-800 bg-white/70 dark:bg-silver-900/60 p-4 ${className}`}
    >
      {children}
    </div>
  );
}

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

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
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Alert({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className={`rounded-xl px-3 py-2 text-sm ${tones[tone]}`}
      role="status"
    >
      {title && <div className="font-semibold mb-0.5">{title}</div>}
      {children}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-silver-500 text-sm py-6 justify-center">
      <Loader2 size={18} className="animate-spin" />
      {label}
    </div>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // WebView Telegram на части Android без clipboard API — запасной путь.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Поле «значение + Копировать» для инструкций подтверждения. */
export function CopyField({
  label,
  value,
  copyLabel,
  copiedLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <div className="text-xs text-silver-500">{label}</div>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 min-w-0 break-all rounded-lg bg-silver-100 dark:bg-silver-950 px-3 py-2 font-mono text-xs select-all">
          {value}
        </code>
        <Button
          variant="outline"
          aria-label={copyLabel}
          icon={copied ? <Check size={16} /> : <Copy size={16} />}
          onClick={async () => {
            if (await copyText(value)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
        >
          <span className="sr-only sm:not-sr-only">
            {copied ? copiedLabel : copyLabel}
          </span>
        </Button>
      </div>
    </div>
  );
}

export function ScreenTitle({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <h1 className="text-xl font-bold tracking-tight flex-1 min-w-0">
        {children}
      </h1>
      {action}
    </div>
  );
}
