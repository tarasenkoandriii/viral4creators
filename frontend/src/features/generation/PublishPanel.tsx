/**
 * PublishPanel — «Опубликовать» from spec §11 → §8: the button never
 * publishes anything itself. It files a request into the moderation
 * queue; an operator approves or rejects it in the admin panel, and the
 * actual upload to the channel is a separate ТЗ (OAuth). What the user
 * sees here: a short form (platform, title, description, tags — all
 * pre-filled from the product, category always tagged), then the status
 * of their requests for this video, with the operator's reason on a
 * rejection.
 *
 * Needs identity (a channel has an owner): the anonymous quick path is
 * told so and keeps download.
 */

import { useEffect, useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  Clock,
  Send,
  ShieldCheck,
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
  Pills,
  Textarea,
} from '../../components/ui';
import {
  errorMessage,
  isUnauthorized,
  listChannels,
  listPublications,
  requestPublication,
  withdrawPublication,
} from '../../services/projects-api';
import type {
  PublicationPlatform,
  PublicationRequest,
  PublicationStatus,
  PublishingChannel,
} from '../../types';
import { useI18n } from '../../lib/i18n-context';
import type { Dictionary } from '../../lib/get-dictionary';
import { navigate, routes } from '../../lib/router';
import { queueState } from '../../lib/publication-queue';
import { formatRunTime } from '../../lib/intl-locale';
import { LoadError } from '../projects/shared';

const PLATFORM_LABEL: Record<PublicationPlatform, string> = {
  YOUTUBE: 'YouTube',
  TIKTOK: 'TikTok',
};

function statusMeta(
  dict: Dictionary
): Record<
  PublicationStatus,
  { label: string; tone: 'warning' | 'success' | 'danger' | 'neutral' }
> {
  return {
    PENDING: { label: dict.publishPanel.statusPending, tone: 'warning' },
    APPROVED: { label: dict.publishPanel.statusApproved, tone: 'success' },
    REJECTED: { label: dict.publishPanel.statusRejected, tone: 'danger' },
    PUBLISHED: { label: dict.publishPanel.statusPublished, tone: 'success' },
    FAILED: { label: dict.publishPanel.statusFailed, tone: 'danger' },
  };
}

export function PublishPanel({
  sessionId,
  generatedVideoId,
  productName,
  productDescription,
  category,
}: {
  sessionId: string;
  generatedVideoId: string;
  productName: string | null;
  productDescription: string | null;
  category: string | null;
}) {
  const { dict, locale } = useI18n();
  const STATUS = statusMeta(dict);
  const [requests, setRequests] = useState<PublicationRequest[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  // Каналы выгрузки (этап 61) — нужны только для подсказки под платформой
  // (подключён/нет); ошибку молча проглатываем, это не критично для формы.
  const [channels, setChannels] = useState<PublishingChannel[] | null>(null);
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState<PublicationPlatform>('YOUTUBE');
  const [title, setTitle] = useState(productName ?? '');
  const [description, setDescription] = useState(productDescription ?? '');
  const [tags, setTags] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [loadNonce, setLoadNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoadError(null);
    listPublications(sessionId)
      .then((r) => {
        if (!alive) return;
        setRequests(r);
        setLoadError(null);
      })
      .catch((e) => {
        // НЕ пустой список (этап 121). Пустой означал бы «очередь
        // свободна», кнопка звала бы отправлять — и человек получал бы
        // ровно тот 409 про невидимую заявку, ради которого этот этап и
        // делается, только теперь ещё и на пустом месте.
        if (!alive) return;
        setRequests(null);
        setLoadError(e);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, loadNonce]);

  useEffect(() => {
    let alive = true;
    listChannels()
      .then((cs) => alive && setChannels(cs))
      .catch(() => {
        if (alive) setChannels([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Б-2.6 (этап 121): занятость очереди — по СЕССИИ и площадке, ровно
  // как на сервере. Экран считал её по текущему ролику, и после
  // перегенерации заявка на прежнюю версию исчезала с глаз: кнопка
  // звала, сервер отвечал 409 про заявку, которой на экране нет и
  // которую поэтому нельзя отозвать.
  //
  // Показываем при этом ВСЕ заявки сессии, помечая относящиеся к другой
  // версии: иначе «отзовите ту заявку» было бы советом про невидимое.
  const all = requests ?? [];
  const queueFor = (p: PublicationPlatform) =>
    queueState(all, p, generatedVideoId);
  const openFor = (p: PublicationPlatform) => queueFor(p).request;
  const hasActiveChannel = (p: PublicationPlatform) =>
    (channels ?? []).some((c) => c.platform === p && c.status === 'ACTIVE');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError(dict.publishPanel.titleRequired);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await requestPublication(sessionId, {
        platform,
        title: title.trim(),
        description: description.trim() || undefined,
        tags: tags
          .split(/[,\n]/)
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setRequests((r) => [created, ...(r ?? [])]);
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const withdraw = async (r: PublicationRequest) => {
    if (
      !window.confirm(
        dict.publishPanel.withdrawConfirm.replace(
          '{{platform}}',
          PLATFORM_LABEL[r.platform]
        )
      )
    )
      return;
    setBusy(r.id);
    try {
      await withdrawPublication(sessionId, r.id);
      setRequests((list) => (list ?? []).filter((x) => x.id !== r.id));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (loadError !== null && isUnauthorized(loadError)) {
    return (
      <Card className="p-5">
        <CardHeader
          icon={<Send size={18} className="text-accent" />}
          title={dict.publishPanel.title}
          hint={dict.publishPanel.unauthHint}
        />
        <Alert tone="info">{dict.publishPanel.unauthAlert}</Alert>
      </Card>
    );
  }

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<Send size={18} className="text-accent" />}
        title={dict.publishPanel.title}
        hint={dict.publishPanel.hint}
      />

      {!open && requests !== null && (
        <Button
          block
          className="mb-4"
          icon={<Send size={14} />}
          onClick={() => setOpen(true)}
          disabled={submitting}
        >
          {dict.publishPanel.publishButton}
        </Button>
      )}

      {error && (
        <Alert tone="error" className="mb-3" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Список заявок не доехал — говорим об этом и даём повтор, а не
          показываем пустую очередь (этап 121). */}
      {loadError !== null && (
        <div className="mb-3">
          <LoadError
            error={loadError}
            onRetry={() => setLoadNonce((n) => n + 1)}
          />
        </div>
      )}

      {/* Очередь занята заявкой на ПРЕЖНЮЮ версию ролика (Б-2.6, этап
          121). Раньше этот случай выглядел как «заявок нет»: человек
          отправлял новую и получал 409 про невидимую. Теперь говорим
          прямо и, если заявку ещё можно отозвать, даём это сделать
          отсюда же. */}
      {(['YOUTUBE', 'TIKTOK'] as const).map((p) => {
        const state = queueFor(p);
        if (state.kind !== 'blocked-by-other' || !state.request) return null;
        return (
          <Alert key={p} tone="warning" className="mb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {(state.withdrawable
                  ? dict.publishPanel.olderVersionQueued
                  : dict.publishPanel.olderVersionApproved
                ).replace('{{platform}}', PLATFORM_LABEL[p])}
              </span>
              {state.withdrawable && (
                <Button
                  size="sm"
                  variant="outline"
                  icon={<Trash2 size={12} />}
                  loading={busy === state.request.id}
                  disabled={busy !== null && busy !== state.request.id}
                  onClick={() => void withdraw(state.request!)}
                >
                  {dict.publishPanel.withdraw}
                </Button>
              )}
            </div>
          </Alert>
        );
      })}

      {open && (
        <form
          onSubmit={submit}
          className="mb-4 space-y-3 rounded-xl border border-accent/30 bg-accent/5 p-3"
        >
          <div>
            <span className="label">{dict.publishPanel.platform}</span>
            <Pills
              value={platform}
              onChange={setPlatform}
              options={[
                {
                  value: 'YOUTUBE',
                  label: 'YouTube',
                  sub: openFor('YOUTUBE')
                    ? dict.publishPanel.alreadyQueued
                    : hasActiveChannel('YOUTUBE')
                      ? dict.publishPanel.channelConnected
                      : dict.publishPanel.channelNotConnected,
                },
                {
                  value: 'TIKTOK',
                  label: 'TikTok',
                  sub: openFor('TIKTOK')
                    ? dict.publishPanel.alreadyQueued
                    : hasActiveChannel('TIKTOK')
                      ? dict.publishPanel.channelConnected
                      : dict.publishPanel.channelNotConnected,
                },
              ]}
            />
            {channels !== null && !hasActiveChannel(platform) && (
              <button
                type="button"
                className="mt-1 text-[11px] text-accent underline"
                onClick={() => navigate(routes.channels())}
              >
                {dict.publishPanel.connectChannelsLink}
              </button>
            )}
          </div>
          <Field
            label={dict.publishPanel.titleLabel}
            htmlFor="pub-title"
            counter={`${title.length}/100`}
          >
            <Input
              id="pub-title"
              value={title}
              maxLength={100}
              onChange={(e) => setTitle(e.target.value)}
              disabled={submitting}
            />
          </Field>
          <Field
            label={dict.publishPanel.descriptionLabel}
            htmlFor="pub-desc"
            hint={dict.publishPanel.descriptionHint}
          >
            <Textarea
              id="pub-desc"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 5000))}
              disabled={submitting}
            />
          </Field>
          <Field
            label={dict.publishPanel.tagsLabel}
            htmlFor="pub-tags"
            hint={
              category
                ? dict.publishPanel.tagsHintWithCategory.replace(
                    '{{category}}',
                    category
                  )
                : dict.publishPanel.tagsHint
            }
          >
            <Input
              id="pub-tags"
              value={tags}
              placeholder={dict.publishPanel.tagsPlaceholder}
              onChange={(e) => setTags(e.target.value)}
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
              {dict.publishPanel.cancel}
            </Button>
            <Button
              type="submit"
              size="sm"
              icon={<ShieldCheck size={14} />}
              loading={submitting}
              disabled={!!openFor(platform)}
            >
              {dict.publishPanel.submitToModeration}
            </Button>
          </div>
        </form>
      )}

      {requests !== null && all.length === 0 && !open && (
        <p className="text-xs text-silver-400">
          {dict.publishPanel.noRequestsYet}
        </p>
      )}

      {all.length > 0 && (
        <ul className="space-y-2">
          {all.map((r) => {
            const st = STATUS[r.status];
            return (
              <li
                key={r.id}
                className="rounded-xl border border-silver-200/70 p-3 text-xs dark:border-silver-800"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">
                    {PLATFORM_LABEL[r.platform]}
                  </span>
                  <Badge tone={st.tone}>
                    {r.status === 'PENDING' && <Clock size={10} />}
                    {(r.status === 'APPROVED' || r.status === 'PUBLISHED') && (
                      <CheckCircle2 size={10} />
                    )}
                    {(r.status === 'REJECTED' || r.status === 'FAILED') && (
                      <XCircle size={10} />
                    )}
                    {st.label}
                  </Badge>
                  <span className="ml-auto text-[11px] text-silver-400 tabular">
                    {formatRunTime(r.createdAt, locale)}
                  </span>
                </div>
                {r.generatedVideoId &&
                  generatedVideoId &&
                  r.generatedVideoId !== generatedVideoId && (
                    <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                      {dict.publishPanel.olderVersionBadge}
                    </p>
                  )}
                <p className="mt-1 truncate font-medium">{r.title}</p>
                {r.tags.length > 0 && (
                  <p className="mt-0.5 truncate text-silver-400">
                    {r.tags.map((t) => `#${t}`).join(' ')}
                  </p>
                )}
                {r.status === 'REJECTED' && r.rejectReason && (
                  <p className="mt-1 text-rose-500">
                    {dict.publishPanel.rejectReasonPrefix} {r.rejectReason}
                  </p>
                )}
                {r.status === 'APPROVED' && r.channelId && (
                  <p className="mt-1 text-silver-400">
                    {dict.publishPanel.approvedNote}
                  </p>
                )}
                {r.status === 'APPROVED' && !r.channelId && (
                  <div className="mt-1">
                    <p className="text-amber-600 dark:text-amber-400">
                      {dict.publishPanel.noChannelNote}
                    </p>
                    <button
                      type="button"
                      className="text-accent underline"
                      onClick={() => navigate(routes.channels())}
                    >
                      {dict.publishPanel.connectChannelsLink}
                    </button>
                  </div>
                )}
                {r.status === 'FAILED' && r.publishError && (
                  <p className="mt-1 text-rose-500">
                    {dict.publishPanel.publishErrorPrefix} {r.publishError}
                  </p>
                )}
                {r.externalUrl && (
                  <a
                    href={r.externalUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-block text-accent underline"
                  >
                    {dict.publishPanel.openPublication}
                  </a>
                )}
                {r.status === 'PENDING' && (
                  <div className="mt-2 flex justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 size={12} />}
                      loading={busy === r.id}
                      disabled={busy !== null && busy !== r.id}
                      onClick={() => void withdraw(r)}
                    >
                      {dict.publishPanel.withdraw}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
