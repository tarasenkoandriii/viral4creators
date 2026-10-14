/**
 * Копирование в буфер обмена (общий помощник TMA): Clipboard API, запасной
 * путь — `execCommand('copy')` через скрытый `textarea` (WebView Telegram на
 * части Android без Clipboard API). `false` — скопировать не удалось (экран
 * предлагает выделить текст вручную). Копируется ровно переданная строка.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // WebView Telegram на части Android без clipboard API — запасной путь.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
