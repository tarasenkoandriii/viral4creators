/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/ui/LanguageSwitcher.tsx */
import { useKit } from '../kit-context';
import { LOCALES, LOCALE_LABELS, isLocale } from '../i18n';

export function LanguageSwitcher() {
  const { locale, setLocale, dict } = useKit();
  return (
    <select
      aria-label={dict.common.language}
      value={locale}
      onChange={(e) => {
        if (isLocale(e.target.value)) setLocale(e.target.value);
      }}
      className="rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-2 py-1 text-sm min-h-[36px]"
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {LOCALE_LABELS[l]}
        </option>
      ))}
    </select>
  );
}
