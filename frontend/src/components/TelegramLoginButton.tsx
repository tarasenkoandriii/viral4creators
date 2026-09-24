/**
 * «Войти через Telegram» — видна только вне Telegram (внутри Telegram
 * идентификация уже автоматическая через initData, см. lib/telegram.ts —
 * кнопка там просто не нужна). Вход опционален и ничего не блокирует:
 * обычный анонимный сценарий работает и без него, ровно как раньше.
 *
 * Виджет-инжект — тот же паттерн, что уже отработан в admin/src/app/login/page.tsx
 * (telegram-widget.js сам вставляет кнопку ОТНОСИТЕЛЬНО своего
 * <script>-тега в DOM, поэтому скрипт создаётся вручную через DOM API, а
 * не декларативным <script> в JSX). См. doc/TELEGRAM-ADMIN.md.
 */

import { useEffect, useRef, useState } from 'react';
import { isTelegramWebAppAvailable } from '../lib/telegram';
import {
  devLoginTelegram,
  fetchTelegramLoginMe,
  logoutTelegram,
  telegramLoginCallback,
  TelegramLoginWidgetPayload,
} from '../lib/telegram-login';
import { claimStoredReferral } from '../services/invite-api';
import { useI18n } from '../lib/i18n-context';

const BOT_USERNAME = import.meta.env.VITE_TELEGRAM_BOT_USERNAME;
const ALLOW_DEV_AUTH = import.meta.env.VITE_ALLOW_DEV_AUTH === 'true';
const DEV_USER_ID = import.meta.env.VITE_DEV_USER_ID || '123';

declare global {
  interface Window {
    onTelegramAuth?: (user: TelegramLoginWidgetPayload) => void;
  }
}

export function TelegramLoginButton() {
  const { dict } = useI18n();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [me, setMe] = useState<{
    telegramId: string;
    firstName?: string | null;
    username?: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const refetchMe = async () => {
    try {
      const result = await fetchTelegramLoginMe();
      setMe(
        result.loggedIn
          ? {
              telegramId: result.telegramId!,
              firstName: result.firstName,
              username: result.username,
            }
          : null
      );
    } catch {
      // Сетевая ошибка тут не критична — просто показываем состояние
      // "не вошли", как для анонимного пользователя.
      setMe(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refetchMe();
  }, []);

  useEffect(() => {
    window.onTelegramAuth = async (payload: TelegramLoginWidgetPayload) => {
      setSubmitting(true);
      setError(null);
      try {
        await telegramLoginCallback(payload);
        await refetchMe();
        // Вторая (и для браузера единственная работающая) попытка
        // привязать приглашение — сразу после входа, этап 134. До
        // аудита её не было: попытка при запуске приложения у
        // анонимного получала 401 и не повторялась, а первый ролик
        // человека успевал завершиться раньше следующего запуска —
        // момент, который единственный засчитывает приглашение,
        // проходил впустую. Не `await`: вход не должен ждать учёта.
        void claimStoredReferral();
      } catch {
        setError(dict.telegramLoginButton.loginFailed);
      } finally {
        setSubmitting(false);
      }
    };
    return () => {
      window.onTelegramAuth = undefined;
    };
    // dict.telegramLoginButton.loginFailed: переустановка обработчика при
    // смене языка — иначе виджет показал бы ошибку на языке, который был
    // при монтировании, а не текущий (этап 56).
  }, [dict.telegramLoginButton.loginFailed]);

  useEffect(() => {
    if (me || !BOT_USERNAME || !containerRef.current) return;
    const container = containerRef.current;

    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-login', BOT_USERNAME);
    script.setAttribute('data-size', 'medium');
    script.setAttribute('data-onauth', 'onTelegramAuth(user)');
    script.setAttribute('data-request-access', 'write');
    container.appendChild(script);

    return () => {
      container.innerHTML = '';
    };
  }, [me]);

  const handleDevLogin = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await devLoginTelegram(DEV_USER_ID);
      await refetchMe();
    } catch {
      setError(dict.telegramLoginButton.devLoginFailed);
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    setSubmitting(true);
    try {
      await logoutTelegram();
      await refetchMe();
    } finally {
      setSubmitting(false);
    }
  };

  // Внутри Telegram идентификация уже автоматическая — кнопка не нужна.
  if (isTelegramWebAppAvailable() || loading) return null;

  // Ни бот не настроен, ни dev-вход не включён — рендерить нечего,
  // анонимный сценарий продолжает работать как обычно.
  if (!me && !BOT_USERNAME && !ALLOW_DEV_AUTH) return null;

  if (me) {
    return (
      <div className="flex items-center gap-2 text-xs text-silver-400">
        <span className="truncate max-w-[10rem]">
          {me.firstName || (me.username ? `@${me.username}` : me.telegramId)}
        </span>
        <button
          type="button"
          onClick={() => void handleLogout()}
          disabled={submitting}
          className="text-accent hover:underline disabled:opacity-50"
        >
          {dict.telegramLoginButton.logout}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {BOT_USERNAME && <div ref={containerRef} />}
      {ALLOW_DEV_AUTH && (
        <button
          type="button"
          onClick={() => void handleDevLogin()}
          disabled={submitting}
          className="rounded-lg border border-silver-300 dark:border-silver-700 px-2 py-1 text-xs text-silver-500 hover:border-accent hover:text-accent disabled:opacity-50 transition-colors"
        >
          {dict.telegramLoginButton.devLoginAs.replace('{{id}}', DEV_USER_ID)}
        </button>
      )}
      {error && <span className="text-xs text-rose-500">{error}</span>}
    </div>
  );
}
