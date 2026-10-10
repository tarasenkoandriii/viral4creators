import { useEffect, useRef, useState } from 'react';
import type { Dictionary } from '../dictionaries/ru';
import {
  TELEGRAM_LOGIN_WIDGET_SRC,
  type TelegramLoginPayload,
} from '../web-auth';
import { Alert, Card, Spinner } from '../ui';
import { readTelegramWidgetMessage } from '../telegram-widget-message';

/**
 * Вход в веб-кабинет — Telegram Login Widget, как у главной админки
 * проекта (`admin/src/app/login/page.tsx`).
 *
 * Скрипт виджета создаётся вручную внутри контейнера: telegram-widget.js
 * вставляет кнопку (iframe oauth.telegram.org) РЯДОМ со своим
 * `<script>`-тегом. `data-request-access` не просим: писать человеку от
 * имени бота кабинету не нужно.
 *
 * Виджет работает только на домене, заданном боту через /setdomain
 * (localhost туда не принимается) — на дев-стенде вход через
 * `VITE_ALLOW_DEV_AUTH`.
 */
export function WebLoginScreen({
  dict,
  botUsername,
  onAuth,
  hint,
}: {
  dict: Dictionary;
  botUsername: string | null;
  /** Колбэк виджета → `POST /sites/auth/web-login`; бросает при отказе. */
  onAuth: (payload: TelegramLoginPayload) => Promise<void>;
  /** Дополнительная строка (например, «вы войдёте по приглашению»). */
  hint?: string;
}) {
  const t = dict.auth;
  const ref = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Обработчик сообщений читает свежий onAuth через ref.
  const onAuthRef = useRef(onAuth);
  onAuthRef.current = onAuth;
  const failText = t.loginFailed;

  useEffect(() => {
    const box = ref.current;
    if (!botUsername || !box) return;
    const script = document.createElement('script');
    script.async = true;
    script.src = TELEGRAM_LOGIN_WIDGET_SRC;
    script.setAttribute('data-telegram-login', botUsername.replace(/^@/, ''));
    script.setAttribute('data-size', 'large');
    // data-onauth is parsed with eval by Telegram's script. Receive the
    // same signed payload through its iframe message instead; keep CSP strict.
    const handleMessage = (event: MessageEvent) => {
      const frame = box.querySelector('iframe');
      const user = readTelegramWidgetMessage(
        event,
        frame?.contentWindow ?? null
      );
      if (!user) return;
      setBusy(true);
      setError(null);
      onAuthRef.current(user).catch(() => {
        setError(failText);
        setBusy(false);
      });
    };
    window.addEventListener('message', handleMessage);
    box.appendChild(script);
    return () => {
      window.removeEventListener('message', handleMessage);
      box.innerHTML = '';
    };
  }, [botUsername, failText]);

  return (
    <div className="mx-auto max-w-md px-4 pt-16 md:pt-24">
      <Card className="space-y-4 text-center">
        <h1 className="text-xl font-bold tracking-tight">{t.webTitle}</h1>
        <p className="text-sm text-silver-500">{t.webIntro}</p>
        {hint && <Alert tone="accent">{hint}</Alert>}
        {botUsername ? (
          <div ref={ref} className="flex justify-center min-h-[48px]" />
        ) : (
          <Alert tone="danger">{t.webNoBot}</Alert>
        )}
        {busy && <Spinner label={t.signingIn} />}
        {error && <Alert tone="danger">{error}</Alert>}
      </Card>
    </div>
  );
}
