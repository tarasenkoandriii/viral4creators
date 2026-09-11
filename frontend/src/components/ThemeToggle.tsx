import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../lib/theme-context';
import { useI18n } from '../lib/i18n-context';

/**
 * Переключатель темы (этап 81, по запросу владельца продукта — «как в
 * Solar Shop»: тот же UX, что и apps/admin/src/components/ThemeToggle.tsx
 * проекта Solar Shop — иконка без подписи, показывает ТЕКУЩЕЕ состояние
 * (не то, во что переключит), клик меняет на противоположное. Значки —
 * lucide-react (Sun/Moon), а не эмодзи оригинала: весь остальной nav
 * этого приложения (App.tsx — FolderKanban/Palette/Zap) уже на
 * lucide-react, эмодзи здесь были бы единственным исключением.
 *
 * Компактная круглая кнопка, а не `<select>`: на 390px рядом с
 * LanguageSwitcher (тоже компактной) места на ещё один текстовый
 * контрол уже нет — тот же компромисс, что описан в комментарии самого
 * LanguageSwitcher.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const { dict } = useI18n();
  const label =
    theme === 'light'
      ? dict.themeToggle.switchToDark
      : dict.themeToggle.switchToLight;

  return (
    <button
      type="button"
      onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
      aria-label={label}
      title={label}
      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-silver-200/60 text-silver-600 dark:bg-silver-800/60 dark:text-silver-300"
    >
      {theme === 'light' ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}
