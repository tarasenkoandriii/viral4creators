import { getTelegramWebApp } from '../kit';

/**
 * Ссылка во внешнем браузере: в TMA — `openLink` (WebView Telegram не
 * должен уводить сам кабинет), иначе новая вкладка без opener. Только https.
 */
export function openExternal(url: string): void {
  if (!/^https:\/\//.test(url)) return;
  const tg = getTelegramWebApp() as
    { openLink?: (u: string) => void } | null | undefined;
  if (tg?.openLink) tg.openLink(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}
