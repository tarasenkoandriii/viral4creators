'use client';

import { useEffect } from 'react';
import { initTelegramWebApp } from '../lib/telegram';

/**
 * Вызывает Telegram.WebApp.ready()/expand() один раз при монтировании —
 * безопасный no-op вне Telegram (lib/telegram.ts). Тот же паттерн, что
 * SetHtmlLang: маленький клиентский эффект, смонтированный в
 * [locale]/layout.tsx, а не что-то, что серверный компонент layout мог
 * бы сделать сам.
 */
export function TelegramInit() {
  useEffect(() => {
    initTelegramWebApp();
  }, []);
  return null;
}
