'use client';

// Telegram Login Widget — официальный виджет Telegram для обычных
// веб-сайтов (не Mini App). window.onTelegramAuth — callback, который
// сам виджет вызывает после успешного входа, с подписанным payload
// (data-onauth атрибут ниже ссылается на это же имя).
//
// НЕ используется next/script здесь: telegram-widget.js вставляет саму
// кнопку логина ОТНОСИТЕЛЬНО позиции своего собственного <script>-тега
// в DOM — next/script со strategy "afterInteractive"/"lazyOnload"
// переносит сам script-тег в конец <body>, не оставляет его в месте
// JSX-дерева. Обход — создать <script> вручную через DOM API и добавить
// его child-узлом внутрь ref'нутого контейнера.
//
// Перенесено из проекта Devil's Advocate
// (apps/admin/src/app/login/page.tsx), с редиректом на /sessions вместо
// /moderation/library — у этого продукта нет модерации контента, см.
// doc/TELEGRAM-ADMIN.md.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { devLogin, telegramCallback, TelegramLoginWidgetPayload } from '../../lib/endpoints';
import { ApiRequestError } from '../../lib/admin-api';

const BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

// Сравнение со строкой, а не Boolean(...) — NEXT_PUBLIC_* подставляются
// в бандл как строки, и "false" — истинная строка; Boolean('false') ===
// true молча включил бы кнопку в проде. Это ТОЛЬКО про видимость кнопки:
// реальный запрет живёт на бэкенде (404 при ALLOW_DEV_AUTH!=true /
// NODE_ENV=production).
const ALLOW_DEV_AUTH = process.env.NEXT_PUBLIC_ALLOW_DEV_AUTH === 'true';
const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID ?? '123';

declare global {
  interface Window {
    onTelegramAuth?: (user: TelegramLoginWidgetPayload) => void;
  }
}

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const handleDevLogin = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await devLogin(DEV_USER_ID);
      router.replace('/sessions');
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? `${err.message} (dev-вход включается переменной ALLOW_DEV_AUTH=true на стороне backend/)`
          : 'Не удалось войти',
      );
      setSubmitting(false);
    }
  };

  useEffect(() => {
    window.onTelegramAuth = async (payload: TelegramLoginWidgetPayload) => {
      setSubmitting(true);
      setError(null);
      try {
        await telegramCallback(payload);
        router.replace('/sessions');
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Не удалось войти');
        setSubmitting(false);
      }
    };
    return () => {
      window.onTelegramAuth = undefined;
    };
  }, [router]);

  useEffect(() => {
    if (!BOT_USERNAME || !containerRef.current) return;
    const container = containerRef.current;

    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-login', BOT_USERNAME);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-onauth', 'onTelegramAuth(user)');
    script.setAttribute('data-request-access', 'write');
    container.appendChild(script);

    return () => {
      container.innerHTML = '';
    };
  }, []);

  return (
    <div className="page" style={{ maxWidth: 420, paddingTop: 120 }}>
      <div className="card" style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: 18, marginBottom: 8 }}>Вход в админ-панель</h1>
        <p className="muted" style={{ marginBottom: 24, fontSize: 13 }}>
          Вход через Telegram не требует прав доступа — увидите ли вы список сессий, зависит от
          флага isOperator на вашем аккаунте.
        </p>

        {!BOT_USERNAME && !ALLOW_DEV_AUTH && (
          <p style={{ color: 'var(--signal-critical)', fontSize: 13 }}>
            NEXT_PUBLIC_TELEGRAM_BOT_USERNAME не задан — виджет не может отобразиться.
          </p>
        )}

        {BOT_USERNAME && (
          <div ref={containerRef} style={{ display: 'flex', justifyContent: 'center', minHeight: 40 }} />
        )}

        {ALLOW_DEV_AUTH && (
          <div style={{ marginTop: BOT_USERNAME ? 20 : 0 }}>
            {BOT_USERNAME && (
              <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
                — или —
              </div>
            )}
            <button type="button" onClick={() => void handleDevLogin()} disabled={submitting} style={{ width: '100%' }}>
              Войти как dev-{DEV_USER_ID} (локальный стенд)
            </button>
            <p className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
              Telegram Login Widget не работает на localhost (домен виджета задаётся боту через
              /setdomain, localhost туда не принимается) — поэтому в докер-стенде вход только
              такой. Тот же аккаунт, что и <code>X-Dev-User-Id: {DEV_USER_ID}</code> в TMA.
            </p>
          </div>
        )}

        {error && (
          <p style={{ color: 'var(--signal-critical)', fontSize: 13, marginTop: 16 }}>{error}</p>
        )}
      </div>
    </div>
  );
}
