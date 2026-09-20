'use client';

/**
 * «Войти через Telegram» — единственный путь идентификации в маркетплейсе
 * (в отличие от frontend/, здесь нет initData). Строки — из словаря
 * (ТЗ §20 №15), сам виджет-инжект не менялся.
 */

import { useEffect, useRef, useState } from 'react';
import {
  devLoginTelegram,
  fetchTelegramLoginMe,
  logoutTelegram,
  telegramLoginCallback,
  TelegramLoginWidgetPayload,
} from '../lib/telegram-login';
import { useDictionary } from '../lib/dictionary-context';

const BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
const ALLOW_DEV_AUTH = process.env.NEXT_PUBLIC_ALLOW_DEV_AUTH === 'true';
const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID || '123';

declare global {
  interface Window {
    onTelegramAuth?: (user: TelegramLoginWidgetPayload) => void;
  }
}

export function TelegramLoginButton({ onLoggedIn }: { onLoggedIn?: () => void }) {
  const { dict } = useDictionary();
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
    const result = await fetchTelegramLoginMe();
    setMe(
      result.loggedIn
        ? { telegramId: result.telegramId!, firstName: result.firstName, username: result.username }
        : null,
    );
    setLoading(false);
    if (result.loggedIn) onLoggedIn?.();
  };

  useEffect(() => {
    void refetchMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    window.onTelegramAuth = async (payload) => {
      setSubmitting(true);
      setError(null);
      try {
        await telegramLoginCallback(payload);
        await refetchMe();
      } catch {
        setError(dict.login.loginFailed);
      } finally {
        setSubmitting(false);
      }
    };
    return () => {
      window.onTelegramAuth = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dict.login.loginFailed]);

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
      setError(dict.login.devLoginFailed);
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    setSubmitting(true);
    try {
      await logoutTelegram();
      setMe(null);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return null;

  if (!me && !BOT_USERNAME && !ALLOW_DEV_AUTH) {
    return <p className="mp-hint">{dict.login.notConfigured}</p>;
  }

  if (me) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
        <span>{me.firstName || (me.username ? `@${me.username}` : me.telegramId)}</span>
        <button type="button" className="mp-cta-secondary" onClick={() => void handleLogout()} disabled={submitting}>
          {dict.login.logout}
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {BOT_USERNAME && <div ref={containerRef} />}
      {ALLOW_DEV_AUTH && (
        <button type="button" className="mp-cta-secondary" onClick={() => void handleDevLogin()} disabled={submitting}>
          {dict.login.devLoginAs.replace('{{id}}', DEV_USER_ID)}
        </button>
      )}
      {error && <span style={{ color: '#e05252', fontSize: 13 }}>{error}</span>}
    </div>
  );
}
