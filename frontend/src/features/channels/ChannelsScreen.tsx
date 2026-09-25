/**
 * ChannelsScreen (#/channels) — управление подключёнными каналами выгрузки
 * (ТЗ §14.2/14.4, этап 61). Отдельный экран верхнего уровня, как #/plan —
 * не вложен в «Проекты»/«Бренд»/«Генерацию»: три вкладки уже упираются в
 * ширину 390px (см. App.tsx), а подключение канала — редкое действие.
 * Ссылка сюда — из подвала и из PublishPanel, когда канал ещё не найден.
 *
 * OAuth-старт — обычный POST с identity-заголовками, а не голая ссылка
 * (решение 3 плана этапа 61): identity в проекте передаётся заголовками
 * на каждый axios-запрос, а не cookie, поэтому обычная навигация браузера
 * их не унесёт. `startChannelOAuth()` возвращает authorize-URL, а
 * дальнейший переход на площадку делает `openExternalLink` — Г-1.4
 * (аудит round4, этап 64): раньше это был `window.location.href`,
 * навигация ВНУТРИ WebView Telegram, а Google OAuth такие WebView
 * блокирует (403 disallowed_userAgent). Обратно бэкенд ведёт на
 * `#/channels?oauth=ok|error&msg=` (см. resultPage() в
 * publishing-channel.controller.ts) — экран разбирает результат при
 * монтировании (см. useEffect ниже) вместо молчаливой перезагрузки.
 */

import { useEffect, useState } from 'react';
import { Captions, Music2, PlugZap, Unplug, Youtube } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  LockedNote,
  Spinner,
} from '../../components/ui';
import {
  disconnectChannel,
  errorMessage,
  isUnauthorized,
  listChannels,
  startChannelOAuth,
} from '../../services/projects-api';
import { useAsync } from '../../lib/useAsync';
import { openExternalLink } from '../../lib/telegram';
import { useFeature } from '../../lib/plan-context';
import { useI18n } from '../../lib/i18n-context';
import type { Dictionary } from '../../lib/get-dictionary';
import { LoadError, ScreenHeader } from '../projects/shared';
import type {
  ChannelStatus,
  PublicationPlatform,
  PublishingChannel,
} from '../../types';

const PLATFORMS: PublicationPlatform[] = ['YOUTUBE', 'TIKTOK'];

const PLATFORM_LABEL: Record<PublicationPlatform, string> = {
  YOUTUBE: 'YouTube',
  TIKTOK: 'TikTok',
};

function platformIcon(p: PublicationPlatform) {
  return p === 'YOUTUBE' ? <Youtube size={16} /> : <Music2 size={16} />;
}

function statusMeta(
  dict: Dictionary
): Record<
  ChannelStatus,
  { label: string; tone: 'success' | 'warning' | 'danger' }
> {
  return {
    ACTIVE: { label: dict.channelsScreen.statusActive, tone: 'success' },
    REVOKED: { label: dict.channelsScreen.statusRevoked, tone: 'danger' },
    EXPIRED: { label: dict.channelsScreen.statusExpired, tone: 'warning' },
  };
}

export function ChannelsScreen() {
  const { dict } = useI18n();
  const STATUS = statusMeta(dict);
  // ТЗ §23: подключение каналов — та же тарифная граница, что и сама
  // публикация (см. PublicationService.approve() и Feature 'publication').
  const feature = useFeature('publication');
  const { data, loading, error, reload } = useAsync(listChannels, []);
  const [connecting, setConnecting] = useState<PublicationPlatform | null>(
    null
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Г-1.4: разбор результата OAuth-callback'а после возврата в приложение
  // (`?oauth=ok|error&msg=` — реальный query, ПЕРЕД хешем, см. комментарий
  // у resultPage() в publishing-channel.controller.ts). Строку убираем
  // сразу же — иначе она переживёт reload и покажет тот же результат
  // повторно.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get('oauth');
    const msg = params.get('msg');
    if (!oauth) return;
    if (oauth === 'ok') setNotice(msg || dict.channelsScreen.title);
    else setActionError(msg || dict.channelsScreen.emptyHint);
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.hash
    );
    reload();
    // Однократно при монтировании — намеренно без зависимостей.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `openLink` (Г-1.4) открывает OAuth в СИСТЕМНОМ браузере отдельной
  // вкладкой/приложением — сам Mini App никуда не уходит и не
  // перезагружается, поэтому «идёт подключение…» на кнопке иначе висело
  // бы вечно, если человек просто вернулся в Telegram, не увидев здесь
  // же результат (тот появляется в ДРУГОЙ вкладке — см. комментарий выше
  // про resultPage()). Возврат фокуса — сигнал «мог что-то поменяться»:
  // снимаем спиннер и подтягиваем список каналов заново.
  useEffect(() => {
    if (!connecting) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        setConnecting(null);
        reload();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connecting]);

  const connect = async (platform: PublicationPlatform, extended = false) => {
    setActionError(null);
    setNotice(null);
    setConnecting(platform);
    try {
      const url = await startChannelOAuth(platform, extended);
      openExternalLink(url);
    } catch (err) {
      setActionError(errorMessage(err));
      setConnecting(null);
    }
  };

  const disconnect = async (channel: PublishingChannel) => {
    if (
      !window.confirm(
        dict.channelsScreen.disconnectConfirm.replace(
          '{{title}}',
          channel.title
        )
      )
    )
      return;
    setActionError(null);
    setBusy(channel.id);
    try {
      await disconnectChannel(channel.id);
      reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (error !== null && isUnauthorized(error)) {
    return (
      <div className="animate-fadeIn">
        <ScreenHeader
          title={dict.channelsScreen.title}
          hint={dict.channelsScreen.hint}
        />
        <Card className="p-5">
          <CardHeader
            icon={<PlugZap size={18} className="text-accent" />}
            title={dict.channelsScreen.title}
            hint={dict.channelsScreen.unauthHint}
          />
          <Alert tone="info">{dict.channelsScreen.unauthAlert}</Alert>
        </Card>
      </div>
    );
  }

  return (
    <div className="animate-fadeIn">
      <ScreenHeader
        title={dict.channelsScreen.title}
        hint={dict.channelsScreen.hint}
      />

      {!feature.allowed && !feature.loading && (
        <div className="mb-3">
          <LockedNote
            title={dict.channelsScreen.lockedTitle}
            lock={feature.lock}
          >
            {dict.channelsScreen.lockedBody}
          </LockedNote>
        </div>
      )}

      {feature.allowed && (
        <>
          {notice && (
            <Alert
              tone="success"
              className="mb-3"
              onDismiss={() => setNotice(null)}
            >
              {notice}
            </Alert>
          )}
          {actionError && (
            <Alert
              tone="error"
              className="mb-3"
              onDismiss={() => setActionError(null)}
            >
              {actionError}
            </Alert>
          )}

          <Card className="mb-4 p-4">
            <p className="mb-3 text-xs text-silver-400">
              {dict.channelsScreen.connectHint}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              {PLATFORMS.map((p) => (
                <Button
                  key={p}
                  variant="outline"
                  icon={platformIcon(p)}
                  loading={connecting === p}
                  disabled={connecting !== null && connecting !== p}
                  onClick={() => void connect(p)}
                  block
                >
                  {dict.channelsScreen.connectButton.replace(
                    '{{platform}}',
                    PLATFORM_LABEL[p]
                  )}
                </Button>
              ))}
            </div>
          </Card>

          {loading && (
            <div className="flex justify-center py-8">
              <Spinner size={26} />
            </div>
          )}
          {!loading && error ? (
            <LoadError error={error} onRetry={reload} />
          ) : null}

          {!loading && !error && data && data.length === 0 && (
            <EmptyState
              icon={<PlugZap size={28} />}
              title={dict.channelsScreen.emptyTitle}
              hint={dict.channelsScreen.emptyHint}
            />
          )}

          {!loading && !error && data && data.length > 0 && (
            <div className="space-y-2">
              {data.map((c) => {
                const st = STATUS[c.status];
                return (
                  <Card key={c.id} className="p-4">
                    <div className="flex items-center gap-3">
                      {c.avatarUrl ? (
                        <img
                          src={c.avatarUrl}
                          alt=""
                          className="h-9 w-9 shrink-0 rounded-full object-cover"
                        />
                      ) : (
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-silver-200/60 text-silver-400 dark:bg-silver-800/60">
                          {platformIcon(c.platform)}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-semibold">
                            {c.title}
                          </p>
                          <Badge tone={st.tone}>{st.label}</Badge>
                        </div>
                        <p className="text-xs text-silver-400">
                          {PLATFORM_LABEL[c.platform]}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Unplug size={14} />}
                        loading={busy === c.id}
                        onClick={() => void disconnect(c)}
                      >
                        {dict.channelsScreen.disconnect}
                      </Button>
                    </div>
                    {/* Этап 137 (ТЗ TZ-Multilingual-YouTube.md §4):
                        субтитры требуют отдельного, более широкого
                        согласия Google. Канал без него работает ровно
                        как раньше — грузит ролики и ничего не теряет, —
                        поэтому здесь не предупреждение, а предложение, и
                        рядом сказано, что именно продукт этим правом
                        делает. Ничего не удаляет. */}
                    {c.platform === 'YOUTUBE' &&
                      c.status === 'ACTIVE' &&
                      !c.captionsAllowed && (
                        <div className="mt-3 border-t border-silver-200/60 pt-3 dark:border-silver-800/60">
                          <p className="mb-2 text-xs text-silver-400">
                            {dict.channelsScreen.captionsHint}
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            icon={<Captions size={14} />}
                            loading={connecting === c.platform}
                            onClick={() => void connect(c.platform, true)}
                          >
                            {dict.channelsScreen.captionsButton}
                          </Button>
                        </div>
                      )}
                    {c.platform === 'YOUTUBE' && c.captionsAllowed && (
                      <p className="mt-3 border-t border-silver-200/60 pt-3 text-xs text-silver-400 dark:border-silver-800/60">
                        {dict.channelsScreen.captionsAllowed}
                      </p>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
