/**
 * SketchBadge — бейдж «ИИ-скетч» и меню карточки слота (§3.3).
 *
 * Три пункта различаются необратимостью, и это отражено в интерфейсе:
 * «Показать оригинал» ничего не меняет (просмотр поверх экрана),
 * «Вернуть оригинал» переключает активный вариант и откатывается тем же
 * скетчем из ленты, «Удалить оригинал» — единственное необратимое
 * действие, и только у него подтверждение. В подтверждении прямо сказано,
 * что уже созданные ролики не изменятся (§4, п. 10): оригинал в них уже
 * «запечён», и пользователь не должен думать, что удаление их чинит.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Eye, MoreVertical, RotateCcw, Trash2, X } from 'lucide-react';
import { Alert, Badge, Card, ConfirmDialog } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { errorMessage } from '../../services/projects-api';
import { deleteSketchOriginal, revertSketch } from '../../services/sketch-api';
import type { SketchSlotView, SketchTarget } from '../../types/sketch';

export function SketchBadge({
  target,
  slot,
  originalUrl,
  onChanged,
}: {
  target: SketchTarget;
  slot: SketchSlotView;
  /** Что показать по «Показать оригинал»; без него пункт не нужен. */
  originalUrl?: string | null;
  onChanged: (slot: SketchSlotView) => void;
}) {
  const { dict } = useI18n();
  const t = dict.sketch;
  const [menu, setMenu] = useState(false);
  const [showing, setShowing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // Меню закрывается кликом вне и по Esc — иначе на узком экране оно
  // остаётся висеть поверх соседних карточек (аудит A-15).
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!root.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const run = async (fn: () => Promise<SketchSlotView>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      setMenu(false);
      setConfirming(false);
      onChanged(next);
    } catch (e) {
      setError(errorMessage(e, t.errFailed, dict.errors));
    } finally {
      setBusy(false);
    }
  };

  const canShowOriginal = !slot.originalDeleted && !!originalUrl;
  // Оригинал удалён — в меню не осталось ни одного пункта; показываем
  // один бейдж без кнопки, чтобы не открывалась пустая карточка.
  const hasMenu = canShowOriginal || !slot.originalDeleted;

  return (
    <div ref={root} className="relative inline-flex items-center gap-1">
      <Badge tone="accent">{t.badge}</Badge>
      {slot.originalDeleted && <Badge>{t.originalDeleted}</Badge>}

      {hasMenu && (
        <button
          type="button"
          aria-label={t.menuAria}
          aria-expanded={menu}
          onClick={() => setMenu((v) => !v)}
          disabled={busy}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg p-1.5 text-silver-400 hover:text-accent disabled:opacity-50"
        >
          <MoreVertical size={14} />
        </button>
      )}

      {menu && (
        // `max-w`/`min-w` вместо фиксированной ширины: в двухколоночной
        // сетке сцен на 360 px карточка 224 px вылезала за экран.
        <Card className="absolute right-0 top-full z-30 mt-1 w-56 max-w-[min(14rem,calc(100vw-2rem))] p-1.5">
          {canShowOriginal && (
            <MenuItem
              icon={<Eye size={13} />}
              label={t.showOriginal}
              disabled={busy}
              onClick={() => {
                setShowing(true);
                setMenu(false);
              }}
            />
          )}
          {!slot.originalDeleted && (
            <MenuItem
              icon={<RotateCcw size={13} />}
              label={t.revert}
              disabled={busy}
              onClick={() => void run(() => revertSketch(target))}
            />
          )}
          {!slot.originalDeleted && (
            <MenuItem
              icon={<Trash2 size={13} />}
              label={t.deleteOriginal}
              danger
              disabled={busy}
              onClick={() => {
                setConfirming(true);
                setMenu(false);
              }}
            />
          )}
          {error && (
            <Alert tone="error" className="mt-1">
              {error}
            </Alert>
          )}
        </Card>
      )}

      {showing && originalUrl && (
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm animate-fadeIn"
          onClick={() => setShowing(false)}
        >
          <button
            type="button"
            aria-label={dict.common.close}
            onClick={() => setShowing(false)}
            className="absolute right-4 top-4 rounded-lg bg-black/40 p-2 text-white"
          >
            <X size={16} />
          </button>
          <img
            src={originalUrl}
            alt={t.compareOriginal}
            data-qa-mask="sketch-original"
            className="max-h-[80vh] max-w-full rounded-xl object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        busy={busy}
        title={t.deleteOriginal}
        confirmLabel={t.deleteOriginal}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          void run(async () => (await deleteSketchOriginal(target)).slot)
        }
      >
        {t.deleteOriginalConfirm}
      </ConfirmDialog>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  danger = false,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full min-h-[44px] items-center gap-2 rounded-lg px-2.5 text-left text-xs transition-colors disabled:opacity-50 ${
        danger
          ? 'text-rose-500 hover:bg-rose-500/10'
          : 'text-silver-600 hover:bg-silver-200/60 dark:text-silver-300 dark:hover:bg-silver-800/60'
      }`}
    >
      <span className="shrink-0">{icon}</span>
      {label}
    </button>
  );
}
