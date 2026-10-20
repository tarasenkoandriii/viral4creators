import { useRef, useState } from 'react';
import { ConfirmDialog } from '../../components/ui';
import type { StoryConfirmText } from './story-confirm';

/**
 * Подтверждение действия раздела Story‑Tales (ST2-U-01, ST2-U-07): тот же
 * `ConfirmDialog`, что у удаления образа рассказчика, с возвратом фокуса
 * на кнопку, которая открыла диалог. Действие запускается только после
 * «подтвердить»; «Отмена», Esc и клик по фону ничего не отправляют.
 * Тело — темнее стандартного `text-silver-500` диалога: поверх
 * затемнения он давал 4,42:1 (axe), перечень последствий должен читаться.
 */
export function useStoryConfirm() {
  const [pending, setPending] = useState<{
    text: StoryConfirmText;
    action: () => void;
  } | null>(null);
  const back = useRef<HTMLElement | null>(null);
  const [checked, setChecked] = useState(false);
  const ask = (text: StoryConfirmText, action: () => void) => {
    back.current = document.activeElement as HTMLElement | null;
    setChecked(false);
    setPending({ text, action });
  };
  const close = () => {
    setPending(null);
    const el = back.current;
    back.current = null;
    if (el?.isConnected) setTimeout(() => el.focus(), 0);
  };
  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      danger={pending?.text.danger ?? true}
      title={pending?.text.title ?? ''}
      confirmLabel={pending?.text.confirmLabel}
      confirmDisabled={!!pending?.text.requiredCheck && !checked}
      onCancel={close}
      onConfirm={() => {
        const current = pending;
        if (current?.text.requiredCheck && !checked) return;
        close();
        current?.action();
      }}
    >
      {pending && (
        <div className="space-y-1.5 text-silver-700 dark:text-silver-200">
          {pending.text.body.map((p) => (
            <p key={p}>{p}</p>
          ))}
          {pending.text.items.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4">
              {pending.text.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          {pending.text.note && <p>{pending.text.note}</p>}
          {pending.text.requiredCheck && (
            <label className="flex min-h-[44px] items-start gap-2 pt-1 font-medium">
              <input
                type="checkbox"
                className="mt-0.5 h-5 w-5 shrink-0"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
              />
              <span className="min-w-0 break-words">
                {pending.text.requiredCheck}
              </span>
            </label>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
  return { ask, dialog };
}
