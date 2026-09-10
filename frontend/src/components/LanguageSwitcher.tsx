import { useI18n } from '../lib/i18n-context';
import { locales, LOCALE_LABELS, type Locale } from '../lib/i18n';

/**
 * Переключатель языка интерфейса (этап 55). Компактный `<select>`, а не
 * Pills (components/ui/Pills.tsx): пять вариантов пилюлями не помещаются
 * в шапку на 390px рядом с режимом и входом через Telegram — тот же
 * компромисс, который уже сделан для режима (кружок-бейдж, а не
 * четвёртая вкладка, см. комментарий в App.tsx).
 */
export function LanguageSwitcher() {
  const { locale, setLocale, dict } = useI18n();

  return (
    <select
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      aria-label={dict.localeSwitcher.label}
      className="min-h-[44px] rounded-full border-0 bg-silver-200/60 dark:bg-silver-800/60 px-2 text-[11px] font-medium text-silver-600 dark:text-silver-300"
    >
      {locales.map((l) => (
        <option key={l} value={l}>
          {LOCALE_LABELS[l]}
        </option>
      ))}
    </select>
  );
}
