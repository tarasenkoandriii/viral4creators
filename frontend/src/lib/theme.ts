/**
 * Явный выбор темы человеком (этап 81) — по тому же образцу, что и
 * lib/i18n.ts (readStoredLocale/storeLocale): чистые функции без React,
 * localStorage, тихий фолбэк на приватный режим/запрещённое хранилище.
 *
 * До этого этапа тема была ТОЛЬКО автоматической (см. applyTheme() в
 * telegram.ts: следует tg.colorScheme внутри Telegram, системной теме
 * вне его) — переключателя не было вовсе. Явный выбор (см. ThemeToggle
 * в components/ThemeToggle.tsx, по образцу apps/admin/ThemeToggle.tsx
 * проекта Solar Shop — простой бинарный light/dark, без «авто») —
 * ВСЕГДА приоритетнее автоматики, ровно как явный выбор языка приоритетнее
 * initData Telegram. Обратного пути к «авто» переключатель не даёт — тот
 * же интерфейс, что и у Solar Shop (там тоже нет кнопки «сбросить»).
 */

export type ThemePreference = 'light' | 'dark';

const STORAGE_KEY = 'v4c_theme';

export function readStoredThemePreference(): ThemePreference | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    return null; // приватный режим/запрещённое хранилище — не блокирующая ошибка
  }
}

export function storeThemePreference(theme: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* см. readStoredThemePreference */
  }
}
