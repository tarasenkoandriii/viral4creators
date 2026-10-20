import { useRef, useState } from 'react';
import { AlertTriangle, Copy, Link2 } from 'lucide-react';
import { Alert, Button } from '../../components/ui';
import { api } from '../../services/api';
import { useI18n } from '../../lib/i18n-context';
import { usePlanState } from '../../lib/plan-context';
import { navigate, routes } from '../../lib/router';
import { storyErrorText } from './story-errors';
import { useStoryConfirm } from './StoryConfirm';
import { useStoryAccess } from './story-access-context';
import {
  fill,
  formatStoryDate,
  parseStoryShare,
  storyChargeLine,
  storyAccessCode,
  storyCode,
  storyNarratorConsentPending,
  storyNarratorConsentRequired,
  storyShareBody,
  storyCreditsRequiredText,
  storyShareKnown,
  storySharedUntil,
  storyShareConfirm,
  storyUnshareConfirm,
  type StoryCharge,
  type StoryShare,
} from './story-pilot';

/** Цена до запуска (бриф ST3, п. 2): кредиты, эквивалент $, «бесплатно». */
export function StoryChargeLine({ charge }: { charge: StoryCharge | null }) {
  const { dict, locale } = useI18n();
  if (!charge) return null;
  return (
    <p className="text-sm font-medium" data-story-charge>
      {storyChargeLine(charge, dict.storyTales, locale)}
      {charge.credits > 0 && !charge.free && (
        <span className="block text-xs font-normal text-silver-700 dark:text-silver-300">
          {dict.storyTales.charge.note}
        </span>
      )}
    </p>
  );
}

/** 402 `STORY_CREDITS_REQUIRED`: «нужно N, у вас M» и переход к покупке. */
export function StoryCreditsNotice({
  info,
}: {
  info: { required: number | null; balance: number | null } | null;
}) {
  const { dict, locale } = useI18n();
  const plan = usePlanState();
  if (!info) return null;
  return (
    <div role="alert" className="space-y-2">
      <Alert tone="warning">
        {storyCreditsRequiredText(
          info,
          dict.storyTales,
          locale,
          plan?.credits?.balance ?? null
        )}
      </Alert>
      <Button variant="outline" onClick={() => navigate(routes.credits())}>
        {dict.storyTales.charge.buy}
      </Button>
    </div>
  );
}

/** «Будет удалено <дата>» с предложением скачать (бриф ST3, п. 4). */
export function StoryRetentionNotice({
  warning,
  audio,
}: {
  warning: { title: string; body: string; link: boolean } | null;
  audio?: string | null;
}) {
  const { dict } = useI18n();
  if (!warning) return null;
  return (
    <Alert tone="warning" title={warning.title}>
      <span className="block">{warning.body}</span>
      {audio && !warning.link && (
        <a
          className="mt-1 inline-flex min-h-[44px] items-center text-sky-800 underline underline-offset-2 dark:text-sky-300"
          href={audio}
          download="story-tales.mp3"
        >
          {dict.storyTales.retention.download}
        </a>
      )}
    </Alert>
  );
}

/** Метка в списке «Мои сказки». */
export function StoryRetentionBadge({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-500/20 dark:text-amber-200">
      <AlertTriangle size={12} aria-hidden="true" />
      {text}
    </span>
  );
}

/**
 * Публикация по ссылке (бриф ST3, п. 3; ТЗ §11.3). Ссылка выдаётся только
 * после подтверждения текста §11.3 (`acknowledgePublic: true`); снятие —
 * тоже через диалог. Сервер хранит только хеш токена, поэтому сама ссылка
 * видна лишь сразу после выдачи — об этом говорит подсказка.
 */
export function StorySharePanel({
  giftId,
  gift,
  onChanged,
  readOnly = false,
}: {
  giftId: string;
  gift: unknown;
  /** Перечитать карточку (срок ссылки и хранения) после выдачи/снятия. */
  onChanged?: () => void;
  /** ST3-U-01: доступ отозван — только снять с публикации, новой ссылки нет. */
  readOnly?: boolean;
}) {
  const { dict, locale } = useI18n();
  const t = dict.storyTales;
  const storyAccess = useStoryAccess();
  const confirm = useStoryConfirm();
  const [share, setShare] = useState<StoryShare | null>(null);
  const [withdrawn, setWithdrawn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const knownUntil = withdrawn ? null : storySharedUntil(gift);
  const until = share?.expiresAt ?? knownUntil;
  // Сервер не прислал состояние публикации (`share` нет в карточке) —
  // «Снять с публикации» доступно всегда: DELETE идемпотентен.
  const unknown = !withdrawn && !storyShareKnown(gift);
  const published = !!share || !!knownUntil;
  /** Первая выдача ссылки: флажок согласия, если в сказке голос/образ. */
  const narratorConsent = storyNarratorConsentRequired(gift);
  /** Согласие для новой одобренной версии сохранено в этой сессии. */
  const [consentSaved, setConsentSaved] = useState(false);
  /** ST3-U-15: просить согласие — только пока оно не дано (Pending). */
  const consentPending = storyNarratorConsentPending(gift) && !consentSaved;

  async function act(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      const code = storyCode(e);
      const status = (e as { response?: { status?: number } } | null)?.response
        ?.status;
      if (storyAccessCode(e)) storyAccess.refresh();
      setError(
        code === 'STORY_NARRATOR_PUBLIC_CONSENT_REQUIRED'
          ? t.share.narratorConsentError
          : status === 409 && !code
            ? // Ссылка уже выдана (сервер отвечает текстом без кода).
              t.share.reissueHint
            : storyErrorText(e, {
                fallback: t.access.actionError,
                noResponse: t.access.actionNoResponse,
                locale,
                ui: dict.storyUi,
              })
      );
      // Требование согласия могло появиться после загрузки карточки.
      if (code === 'STORY_NARRATOR_PUBLIC_CONSENT_REQUIRED') onChanged?.();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function copy() {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setNotice(t.share.copied);
    } catch {
      setNotice(t.share.copyFailed);
    }
  }

  // Только чтение и ссылки нет — показывать нечего.
  if (readOnly && !published && !unknown) return null;
  return (
    <section
      className="space-y-3 rounded-xl border border-silver-300 p-3 dark:border-silver-700"
      aria-label={t.share.linkLabel}
    >
      {share && (
        <div className="space-y-2">
          <label className="block text-sm font-medium">
            {t.share.linkLabel}
            <input
              readOnly
              className="mt-1 block w-full max-w-full rounded-lg border border-silver-300 bg-white p-2 font-mono text-xs text-silver-900 dark:border-silver-700 dark:bg-silver-900 dark:text-silver-100"
              value={share.url}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <Button
            variant="outline"
            size="sm"
            icon={<Copy size={14} />}
            onClick={() => void copy()}
          >
            {t.share.copy}
          </Button>
          <p className="text-xs text-silver-700 dark:text-silver-300">
            {t.share.keepLink}
          </p>
        </div>
      )}
      {published && until && (
        <p className="text-sm">
          {fill(share ? t.share.expires : t.share.shared, {
            date: formatStoryDate(until, locale),
          })}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {error && (
        <div role="alert">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      {published && !share && !readOnly && (
        <p className="text-xs text-silver-700 dark:text-silver-300">
          {t.share.reissueHint}
        </p>
      )}
      {/* ST3-U-02: новая одобренная версия с голосом или образом рассказчика
          попадает на действующую ссылку только с его согласием. */}
      {published && consentPending && !readOnly && (
        <div className="space-y-2">
          <p className="text-sm">{t.share.consentNeeded}</p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              confirm.ask(
                storyShareConfirm(t, true),
                () =>
                  void act(async () => {
                    const r = await api.post<StoryShare>(
                      `/story-gifts/${giftId}/share`,
                      storyShareBody(true)
                    );
                    const next = parseStoryShare(r.data);
                    if (next) setShare(next);
                    setConsentSaved(true);
                    setNotice(t.share.consentSaved);
                    onChanged?.();
                  })
              )
            }
          >
            {t.share.consentButton}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {/* Вторая ссылка — только после снятия прежней (сервер ответит 409). */}
        {!published && !readOnly && (
          <Button
            icon={<Link2 size={14} />}
            disabled={busy}
            onClick={() =>
              confirm.ask(
                storyShareConfirm(t, narratorConsent),
                () =>
                  void act(async () => {
                    const r = await api.post<StoryShare>(
                      `/story-gifts/${giftId}/share`,
                      storyShareBody(narratorConsent)
                    );
                    const next = parseStoryShare(r.data);
                    if (!next) throw new Error('share');
                    setWithdrawn(false);
                    setShare(next);
                    onChanged?.();
                  })
              )
            }
          >
            {t.share.button}
          </Button>
        )}
        {(published || unknown) && (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              confirm.ask(
                storyUnshareConfirm(t),
                () =>
                  void act(async () => {
                    await api.delete(`/story-gifts/${giftId}/share`);
                    setShare(null);
                    setWithdrawn(true);
                    setNotice(t.share.unshared);
                    onChanged?.();
                  })
              )
            }
          >
            {t.share.unshare}
          </Button>
        )}
      </div>
      {confirm.dialog}
    </section>
  );
}
