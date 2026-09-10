/**
 * ShareVideoPanel — «Публичная страница» (ТЗ §40, этап 60): петля
 * шеринга и бесплатного привлечения пользователей. Устроена как
 * PublishPanel (§8/§11) — кнопка никогда не публикует сама, а ставит
 * ролик в ту же по духу очередь на модерацию; оператор одобряет или
 * отклоняет её в админке. После одобрения на `landing/` появляется
 * страница `/video/:id` с плеером, OG-превью и кнопкой «Сделать такой
 * же» — сюда просто выводится готовая ссылка для копирования/шеринга.
 *
 * В отличие от PublishPanel: нет выбора платформы (страница одна), и
 * «Удалить» работает в ЛЮБОМ статусе, а не только для PENDING —
 * §40, решение 2: отзыв — это hard delete записи и её копий в хранилище.
 *
 * Needs identity (публичная страница — не бывает без владельца): анонимная
 * быстрая сессия видит то же предупреждение, что и у публикации.
 */

import { useEffect, useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Globe2,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
} from '../../components/ui';
import {
  createSharedVideo,
  errorMessage,
  isUnauthorized,
  listSharedVideos,
  withdrawSharedVideo,
} from '../../services/projects-api';
import type { SharedVideoPage, SharedVideoStatus } from '../../types';
import { useI18n } from '../../lib/i18n-context';
import type { Dictionary } from '../../lib/get-dictionary';

const LANDING_URL = (
  import.meta.env.VITE_LANDING_URL || 'http://localhost:3003'
).replace(/\/+$/, '');

function pageUrl(id: string): string {
  return `${LANDING_URL}/video/${id}`;
}

function statusMeta(
  dict: Dictionary
): Record<
  SharedVideoStatus,
  { label: string; tone: 'warning' | 'success' | 'danger' }
> {
  return {
    PENDING: { label: dict.shareVideoPanel.statusPending, tone: 'warning' },
    PUBLISHED: { label: dict.shareVideoPanel.statusPublished, tone: 'success' },
    REJECTED: { label: dict.shareVideoPanel.statusRejected, tone: 'danger' },
  };
}

export function ShareVideoPanel({
  sessionId,
  generatedVideoId,
  productName,
}: {
  sessionId: string;
  generatedVideoId: string;
  productName: string | null;
}) {
  const { dict } = useI18n();
  const STATUS = statusMeta(dict);
  const [pages, setPages] = useState<SharedVideoPage[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(productName ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listSharedVideos(sessionId)
      .then((r) => alive && setPages(r))
      .catch((e) => {
        if (!alive) return;
        setPages([]);
        setLoadError(e);
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const forThisVideo =
    pages?.filter((p) => p.generatedVideoId === generatedVideoId) ?? [];
  // §40, решение 3: одна активная (PENDING/PUBLISHED) страница на видео —
  // блокировка на бэкенде та же, кнопка здесь просто не даёт открыть
  // вторую форму поверх уже идущей заявки.
  const hasOpen = forThisVideo.some(
    (p) => p.status === 'PENDING' || p.status === 'PUBLISHED'
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError(dict.shareVideoPanel.titleRequired);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await createSharedVideo(sessionId, title.trim());
      setPages((p) => [created, ...(p ?? [])]);
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const withdraw = async (p: SharedVideoPage) => {
    if (!window.confirm(dict.shareVideoPanel.withdrawConfirm)) return;
    setBusy(p.id);
    try {
      await withdrawSharedVideo(sessionId, p.id);
      setPages((list) => (list ?? []).filter((x) => x.id !== p.id));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async (p: SharedVideoPage) => {
    const url = pageUrl(p.id);
    try {
      if (navigator.share) {
        await navigator.share({ title: p.title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopiedId(p.id);
      setTimeout(() => setCopiedId((id) => (id === p.id ? null : id)), 2000);
    } catch {
      // Пользователь закрыл системный шаринг — не ошибка.
    }
  };

  if (loadError !== null && isUnauthorized(loadError)) {
    return (
      <Card className="p-5">
        <CardHeader
          icon={<Globe2 size={18} className="text-accent" />}
          title={dict.shareVideoPanel.title}
          hint={dict.shareVideoPanel.unauthHint}
        />
        <Alert tone="info">{dict.shareVideoPanel.unauthAlert}</Alert>
      </Card>
    );
  }

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<Globe2 size={18} className="text-accent" />}
        title={dict.shareVideoPanel.title}
        hint={dict.shareVideoPanel.hint}
      />

      {!open && (
        <Button
          block
          className="mb-4"
          icon={<Globe2 size={14} />}
          onClick={() => setOpen(true)}
          disabled={submitting || hasOpen}
        >
          {dict.shareVideoPanel.publishButton}
        </Button>
      )}

      {error && (
        <Alert tone="error" className="mb-3" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {open && (
        <form
          onSubmit={submit}
          className="mb-4 space-y-3 rounded-xl border border-accent/30 bg-accent/5 p-3"
        >
          <Alert tone="warning">{dict.shareVideoPanel.warning}</Alert>
          <Field
            label={dict.shareVideoPanel.titleLabel}
            htmlFor="share-title"
            counter={`${title.length}/100`}
          >
            <Input
              id="share-title"
              value={title}
              maxLength={100}
              onChange={(e) => setTitle(e.target.value)}
              disabled={submitting}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              {dict.shareVideoPanel.cancel}
            </Button>
            <Button type="submit" size="sm" loading={submitting}>
              {dict.shareVideoPanel.submitToModeration}
            </Button>
          </div>
        </form>
      )}

      {pages !== null && forThisVideo.length === 0 && !open && (
        <p className="text-xs text-silver-400">
          {dict.shareVideoPanel.noPagesYet}
        </p>
      )}

      {forThisVideo.length > 0 && (
        <ul className="space-y-2">
          {forThisVideo.map((p) => {
            const st = STATUS[p.status];
            return (
              <li
                key={p.id}
                className="rounded-xl border border-silver-200/70 p-3 text-xs dark:border-silver-800"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={st.tone}>
                    {p.status === 'PENDING' && <Clock size={10} />}
                    {p.status === 'PUBLISHED' && <CheckCircle2 size={10} />}
                    {p.status === 'REJECTED' && <XCircle size={10} />}
                    {st.label}
                  </Badge>
                  {p.status === 'PUBLISHED' && (
                    <span className="ml-auto text-[11px] text-silver-400 tabular">
                      {p.viewCount} {dict.shareVideoPanel.viewsLabel} ·{' '}
                      {p.firstGenerationCount}{' '}
                      {dict.shareVideoPanel.conversionsLabel}
                    </span>
                  )}
                </div>
                <p className="mt-1 truncate font-medium">{p.title}</p>
                {p.status === 'REJECTED' && p.rejectReason && (
                  <p className="mt-1 text-rose-500">
                    {dict.shareVideoPanel.rejectReasonPrefix} {p.rejectReason}
                  </p>
                )}
                {p.status === 'PUBLISHED' && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <a
                      href={pageUrl(p.id)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-accent underline"
                    >
                      <ExternalLink size={12} />
                      {dict.shareVideoPanel.openPage}
                    </a>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Copy size={12} />}
                      onClick={() => void copyLink(p)}
                    >
                      {copiedId === p.id
                        ? dict.shareVideoPanel.linkCopied
                        : dict.shareVideoPanel.copyLink}
                    </Button>
                  </div>
                )}
                <div className="mt-2 flex justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 size={12} />}
                    loading={busy === p.id}
                    onClick={() => void withdraw(p)}
                  >
                    {dict.shareVideoPanel.withdraw}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
