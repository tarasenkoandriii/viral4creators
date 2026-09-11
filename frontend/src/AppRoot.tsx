import App from './App';
import { I18nContext, useI18nValue } from './lib/i18n-context';
import { ThemeContext, useThemeValue } from './lib/theme-context';

/**
 * Провайдер локали и темы вокруг `<App/>` — в отдельном файле, а не в
 * main.tsx: main.tsx не должен экспортировать компонент (react-refresh/
 * only-export-components считает файл без экспортов «не компонентным» и
 * ругается на локальный JSX-компонент внутри); не в lib/i18n-context.ts
 * или lib/theme-context.ts — оба намеренно `.ts`, без JSX (см.
 * комментарий там же, тот же приём, что и у PlanContext в App.tsx).
 */
export function AppRoot() {
  const i18n = useI18nValue();
  const theme = useThemeValue();
  return (
    <I18nContext.Provider value={i18n}>
      <ThemeContext.Provider value={theme}>
        <App />
      </ThemeContext.Provider>
    </I18nContext.Provider>
  );
}
