/**
 * InviteScreen (#/invite) — кабинет «Пригласить», этап 133.
 *
 * Пока это половина кабинета: сколько генераций осталось и один способ
 * получить ещё — подписка на канал. Приглашения, лестница и список
 * приведённых приезжают этапом 134 и встают НИЖЕ подписки, не меняя
 * того, что уже есть на экране.
 *
 * Порядок блоков задан жёстко и будет расти сверху вниз: сначала
 * состояние («сколько у меня»), потом способы («как получить ещё»).
 * Человек приходит сюда со стены, то есть уже с вопросом «что делать», —
 * и первое, что он должен увидеть, это ответ, а не объяснение правил.
 */

import { useCallback, useEffect, useState } from 'react';
import { Gift, Send, Youtube } from 'lucide-react';
import { Alert, Button, Card, CardHeader, Spinner } from '../../components/ui';
import {
  confirmTelegramSubscription,
  confirmYoutubeSubscription,
  getInviteState,
  recordInviteEvent,
  startYoutubeUnlock,
  type InviteState,
} from '../../services/invite-api';
import { errorMessage } from '../../services/projects-api';
import { referralLink, telegramReferralLink } from '../../lib/referral';
import { useAsync } from '../../lib/useAsync';
import { useI18n } from '../../lib/i18n-context';
import { openExternalLink, openTelegramLink } from '../../lib/telegram';
import { ScreenHeader, LoadError } from '../projects/shared';

/** Тот же адрес лендинга, что у панели шеринга и ленты. */
const LANDING_URL = import.meta.env.VITE_LANDING_URL || 'http://localhost:3003';

/** Тот же бот, что у кнопки логина (`TelegramLoginButton.tsx`). */
const BOT_USERNAME = import.meta.env.VITE_TELEGRAM_BOT_USERNAME;

export function InviteScreen() {
  const { dict } = useI18n();
  const t = dict.invite;
  const { data, loading, error, reload } = useAsync(getInviteState, []);
  const [state, setState] = useState<InviteState | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const view = state ?? data;

  // «Открыл кабинет» (§12.2). Один раз на заход, а не на каждый рендер:
  // пустой список зависимостей — это и есть «при монтировании».
  useEffect(() => {
    recordInviteEvent('cabinet');
  }, []);

  // Возврат из Google (этап 140): прослойка приводит сюда с
  // `?youtube=ok|error` ПЕРЕД хешем — параметр после `#/invite` клиент
  // бы не увидел. Строку убираем сразу же, иначе она переживёт
  // перезагрузку и покажет тот же результат повторно.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('youtube');
    if (!result) return;
    if (result !== 'ok') setCheckError(params.get('msg') || '');
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.hash
    );
    // Вход состоялся — состояние кабинета изменилось: теперь «Проверить»
    // доступно без повторного входа.
    reload();
    // Однократно при монтировании — намеренно без зависимостей.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signInYoutube = useCallback(async () => {
    setBusy(true);
    setCheckError(null);
    try {
      openExternalLink(await startYoutubeUnlock());
    } catch (e) {
      setCheckError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const checkYoutube = useCallback(async () => {
    setBusy(true);
    setCheckError(null);
    try {
      setState(await confirmYoutubeSubscription());
    } catch (e) {
      setCheckError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const check = useCallback(async () => {
    setBusy(true);
    setCheckError(null);
    try {
      setState(await confirmTelegramSubscription());
    } catch (e) {
      setCheckError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  if (loading) return <Spinner />;
  if (error || !view) return <LoadError error={error} onRetry={reload} />;

  const r = view.referrals;
  // Ссылка собирается на клиенте: серверу незачем знать адрес лендинга,
  // а лендинг у стендов разный.
  const link = referralLink(r.code, LANDING_URL);
  // Копируем лендинговую, а делимся внутри Telegram — `t.me`-вариантом
  // (§5.1): в мессенджере он разворачивается карточкой бота и открывает
  // мини-апп на месте, а лендинговая увела бы получателя в браузер и
  // обратно. Имени бота нет — делимся лендинговой: она работает везде.
  const shareLink = telegramReferralLink(r.code, BOT_USERNAME) ?? link;
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(shareLink)}&text=${encodeURIComponent(t.shareText)}`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      recordInviteEvent('copy');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Буфер обмена может быть закрыт политикой — ссылка видна рядом,
      // и переписать её человек может руками.
    }
  };

  const channel = view.subscription.telegramChannel;
  // Ссылку строим только для @имени. Канал можно настроить и числовым
  // идентификатором (`-100…`) — для приватных это единственный способ, —
  // и `t.me/-100…` ведёт в никуда. Молча дать битую ссылку хуже, чем
  // честно показать, что открывать нечего: кнопку «Проверить» это не
  // отнимает, подписаться человек может и из поиска.
  const channelUrl =
    channel && channel.startsWith('@')
      ? `https://t.me/${channel.slice(1)}`
      : null;

  const yt = view.subscription.youtube;
  // Ссылка на канал собирается из его id: @имени у нас нет, а
  // `youtube.com/channel/UC…` работает всегда.
  const youtubeChannelUrl = yt?.channelId
    ? `https://www.youtube.com/channel/${yt.channelId}`
    : null;

  return (
    <div className="space-y-4">
      <ScreenHeader title={t.title} />

      <Card className="p-5">
        <CardHeader title={t.availableTitle} />
        <p className="text-3xl font-semibold">{view.generationsAvailable}</p>
        <p className="muted mt-1 text-sm">
          {view.unlocked ? t.unlockedHint : t.availableHint}
        </p>
        {/* Стена выключена — говорим об этом прямо. Экран, обещающий
            условия, которых сейчас нет, хуже отсутствующего экрана. */}
        {!view.wallEnabled && (
          <Alert tone="info" className="mt-3">
            {t.wallOffNotice}
          </Alert>
        )}
      </Card>

      <Card className="p-5">
        <CardHeader title={t.subscriptionTitle} icon={<Send size={16} />} />
        {view.subscription.confirmed ? (
          <Alert tone="success">{t.subscriptionConfirmed}</Alert>
        ) : channel ? (
          <>
            <p className="muted text-sm">{t.subscriptionHint}</p>
            {checkError && (
              <Alert tone="error" className="mt-3">
                {checkError}
              </Alert>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {channelUrl && (
                <Button
                  variant="outline"
                  icon={<Send size={16} />}
                  onClick={() => openTelegramLink(channelUrl)}
                >
                  {t.openChannel}
                </Button>
              )}
              <Button loading={busy} onClick={() => void check()}>
                {t.checkSubscription}
              </Button>
            </div>
          </>
        ) : (
          <p className="muted text-sm">{t.subscriptionUnavailable}</p>
        )}
      </Card>

      {/* Второй способ заплатить (этап 140) — рядом с первым, не вместо
          него: у человека в Telegram подписка на канал дешевле по
          трению, а у пришедшего с лендинга Google может оказаться
          единственным. Карточка не показывается вовсе, пока способ не
          настроен на стенде: обещать условие, которого нет, хуже, чем
          не обещать ничего. */}
      {yt?.available && !view.subscription.confirmed && (
        <Card className="p-5">
          <CardHeader title={t.youtubeTitle} icon={<Youtube size={16} />} />
          <p className="muted text-sm">{t.youtubeHint}</p>
          {checkError && (
            <Alert tone="error" className="mt-3">
              {checkError}
            </Alert>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {youtubeChannelUrl && (
              <Button
                variant="outline"
                icon={<Youtube size={16} />}
                onClick={() => openExternalLink(youtubeChannelUrl)}
              >
                {t.youtubeOpenChannel}
              </Button>
            )}
            {/* Вход не предлагается тем, у кого нужное право уже есть:
                подключённый канал выгрузки давал `youtube.readonly`
                вместе с правом на загрузку. Лишний экран согласия здесь
                стоит дороже, чем код, который его обходит. */}
            {!yt.ready && (
              <Button
                variant="outline"
                loading={busy}
                onClick={() => void signInYoutube()}
              >
                {t.youtubeSignIn}
              </Button>
            )}
            <Button
              loading={busy}
              disabled={!yt.ready}
              onClick={() => void checkYoutube()}
            >
              {t.checkSubscription}
            </Button>
          </div>
          {yt.viaConnectedChannel && (
            <p className="muted mt-2 text-xs">{t.youtubeViaChannel}</p>
          )}
        </Card>
      )}

      <Card className="p-5">
        <CardHeader title={t.referralsTitle} icon={<Gift size={16} />} />

        {/* Лестница, а не одна полоса до семи: человек видит, что он уже
            получил и что получит следующим шагом. Полоса «3 из 7» ниже
            остаётся, но она больше не единственный источник смысла —
            даже первый приведённый превращается в генерацию. */}
        <ul className="mt-2 space-y-1 text-sm">
          <li>{t.ladderRegistration}</li>
          <li>
            {view.subscription.confirmed ? '✓ ' : '· '}
            {t.ladderSubscription}
          </li>
          <li>
            · {t.ladderPerInvite}{' '}
            <span className="muted">
              ({r.funnel.generated} / {r.target})
            </span>
          </li>
          <li className="muted">{t.ladderUnlock}</li>
        </ul>

        <p className="muted mt-3 text-sm">
          {t.funnelVisited}: {r.funnel.visited} · {t.funnelIdentified}:{' '}
          {r.funnel.identified} · {t.funnelGenerated}: {r.funnel.generated}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code className="rounded bg-surface-2 px-2 py-1 text-sm">{link}</code>
          <Button variant="outline" onClick={() => void copyLink()}>
            {copied ? t.copied : t.copy}
          </Button>
          <Button
            variant="outline"
            icon={<Send size={16} />}
            onClick={() => {
              recordInviteEvent('share');
              openTelegramLink(shareUrl);
            }}
          >
            {t.share}
          </Button>
        </div>

        {/* Список — СОБЫТИЯ, а не люди: ни имён, ни аватарок. Показать
            имя значило бы раздать персональные данные третьей стороне за
            то, что человек открыл ссылку, — а мы даже не спросили его.
            Заодно исчезает соблазн «написать тому, кто застрял». */}
        {r.invitees.length > 0 && (
          <ul className="mt-4 space-y-1 text-sm">
            {r.invitees.map((inv) => (
              <li key={inv.joinedAt} className="flex justify-between gap-3">
                <span className="muted">
                  {new Date(inv.joinedAt).toLocaleDateString()}
                </span>
                <span className={inv.counted ? 'font-medium' : 'muted'}>
                  {inv.counted ? t.inviteeGenerated : t.inviteeJoined}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
