/**
 * «Удалить всё» (ТЗ Greeting 2.0 §4.9): селфи, ролик проверки, образы,
 * скетчи и голос персоны. Готовые ролики остаются у автора, личные
 * бренд-буки — без персоны. Опубликованные страницы с человеком сервер
 * перечисляет в ответе, и экран предлагает снять их тут же
 * (`PersonaSharesPanel`) — иначе «удалил себя» оставляло бы лицо на
 * открытых страницах.
 */

import { useState } from 'react';
import { ExternalLink, Trash2 } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
} from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { openExternalLink } from '../../lib/telegram';
import { errorMessage } from '../../services/projects-api';
import { deletePersona, unpublishShare } from '../../services/persona-api';
import { splitShares, type PublishedShare } from '../../lib/persona-flow';

export function PersonaDelete({
  onDeleted,
}: {
  onDeleted: (shares: PublishedShare[]) => void;
}) {
  const { dict } = useI18n();
  const t = dict.persona;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await deletePersona();
      setOpen(false);
      onDeleted(res.publishedSharesWithPersona);
    } catch (e) {
      setError(errorMessage(e, undefined, dict.errors));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4 sm:p-5">
      <CardHeader title={t.deleteTitle} hint={t.deleteLead} />
      {error && (
        <Alert tone="error" className="mb-3" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}
      <Button
        variant="danger"
        icon={<Trash2 size={14} />}
        onClick={() => setOpen(true)}
      >
        {t.deleteButton}
      </Button>
      <ConfirmDialog
        open={open}
        title={t.deleteConfirmTitle}
        confirmLabel={t.deleteButton}
        cancelLabel={t.cancel}
        busy={busy}
        onConfirm={() => void run()}
        onCancel={() => setOpen(false)}
      >
        {t.deleteLead} {t.deleteConfirmBody}
      </ConfirmDialog>
    </Card>
  );
}

/** Страницы, которые остались опубликованными после удаления персоны. */
export function PersonaSharesPanel({
  shares,
  onDone,
}: {
  shares: PublishedShare[];
  onDone: () => void;
}) {
  const { dict } = useI18n();
  const t = dict.persona;
  const { removable, linkOnly } = splitShares(shares);
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = async (list: PublishedShare[]) => {
    setError(null);
    for (const s of list) {
      if (removed.has(s.id)) continue;
      setBusy(s.id);
      try {
        await unpublishShare(s);
        setRemoved((prev) => new Set(prev).add(s.id));
      } catch (e) {
        setError(errorMessage(e, undefined, dict.errors));
        break;
      }
    }
    setBusy(null);
  };

  const left = removable.filter((s) => !removed.has(s.id));

  return (
    <Card className="p-4 sm:p-5">
      <CardHeader title={t.sharesTitle} hint={t.sharesLead} />
      {error && (
        <Alert tone="error" className="mb-3" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}
      <ul className="space-y-2" role="list">
        {[...removable, ...linkOnly].map((s) => {
          const done = removed.has(s.id);
          const canRemove = !!s.sessionId;
          return (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-silver-200/60 p-2 text-xs dark:border-silver-800"
            >
              <span className="min-w-0 flex-1 truncate">{s.url}</span>
              <div className="flex shrink-0 gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<ExternalLink size={13} />}
                  aria-label={`${t.openShare}: ${s.url}`}
                  onClick={() => openExternalLink(s.url)}
                />
                {canRemove ? (
                  <Button
                    variant="outline"
                    size="sm"
                    loading={busy === s.id}
                    disabled={done || busy !== null}
                    data-assist="never"
                    onClick={() => void remove([s])}
                  >
                    {done ? t.unpublished : t.unpublish}
                  </Button>
                ) : (
                  <span className="self-center text-silver-400">
                    {t.sharesLinkOnly}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        {left.length > 1 && (
          <Button
            loading={busy !== null}
            data-assist="never"
            onClick={() => void remove(left)}
          >
            {t.unpublishAll}
          </Button>
        )}
        <Button variant="ghost" disabled={busy !== null} onClick={onDone}>
          {t.sharesDone}
        </Button>
      </div>
    </Card>
  );
}
