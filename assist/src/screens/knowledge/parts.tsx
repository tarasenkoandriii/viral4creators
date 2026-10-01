import { useEffect, useState, type ReactNode } from 'react';
import { useKit } from '../../kit';
import { Alert, Button } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { useErrorText } from '../../lib/use-error-text';

export type Notice = { tone: 'success' | 'warning' | 'danger'; text: string };

export function NoticeBar({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <div className="mb-3">
      <Alert tone={notice.tone}>{notice.text}</Alert>
    </div>
  );
}

export function LoadError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const { dict } = useKit();
  const text = useErrorText();
  return (
    <Alert tone="danger" title={dict.common.error}>
      {text(error)}
      <div className="mt-2">
        <Button variant="outline" onClick={onRetry}>
          {dict.common.retry}
        </Button>
      </div>
    </Alert>
  );
}

/**
 * Кнопка необратимого действия в два нажатия: первое — «Точно?» на 4 с,
 * второе — действие. Не `window.confirm`: в части WebView Telegram он
 * заблокирован и молча возвращает false.
 */
export function ConfirmButton({
  children,
  onConfirm,
  variant = 'outline',
  hint,
  loading,
  disabled,
  icon,
}: {
  children: ReactNode;
  onConfirm: () => void;
  variant?: 'outline' | 'danger' | 'solid' | 'ghost';
  hint?: string;
  loading?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  const { appDict } = useAssist();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        variant={armed ? 'danger' : variant}
        loading={loading}
        disabled={disabled}
        icon={icon}
        onClick={() => {
          if (armed) {
            setArmed(false);
            onConfirm();
          } else {
            setArmed(true);
          }
        }}
      >
        {armed ? appDict.knowledge.confirm : children}
      </Button>
      {armed && hint && (
        <span className="text-xs text-silver-500 max-w-xs">{hint}</span>
      )}
    </span>
  );
}

export const textareaClass =
  'w-full rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 text-sm min-h-[88px]';
