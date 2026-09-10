/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  // Telegram dev-login (Docker local stand only) — см.
  // doc/TELEGRAM-ADMIN.md и src/lib/telegram.ts. Optional: undefined
  // outside the dev stand, exactly like the backend's ALLOW_DEV_AUTH.
  readonly VITE_ALLOW_DEV_AUTH?: string;
  readonly VITE_DEV_USER_ID?: string;
  // Bot username (без @) для кнопки «Войти через Telegram» на этой
  // странице (Telegram Login Widget) — см. src/lib/telegram-login.ts и
  // doc/TELEGRAM-ADMIN.md. Без него кнопка просто не рендерится (не
  // ошибка — обычный анонимный сценарий работает и без неё).
  readonly VITE_TELEGRAM_BOT_USERNAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
