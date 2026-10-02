import { href } from '../lib/pages';
import type { Locale } from '../lib/i18n';

/**
 * Поле «адрес вашего сайта» в hero и в финальном CTA (§3.2 блоки 1 и 13) —
 * обычная GET-форма без клиентского JS: `/try?url=…`, песочница подставит
 * адрес в поле (но не запустит сама — запуск — явное действие человека,
 * §13). Canonical `/try` — без параметра, дублей нет.
 */
export function TryForm({ locale, id, place, strings }: { locale: Locale; id: string; place: string; strings: { label: string; placeholder: string; submit: string } }) {
  return (
    <form className="try-form" method="get" action={href(locale, 'try')} aria-label={strings.label}>
      <label htmlFor={id} className="sr-only">
        {strings.label}
      </label>
      <input id={id} name="url" type="text" inputMode="url" autoComplete="url" spellCheck={false} placeholder={strings.placeholder} maxLength={2048} />
      <button className="button" type="submit" data-cta={place}>
        {strings.submit}
      </button>
    </form>
  );
}
