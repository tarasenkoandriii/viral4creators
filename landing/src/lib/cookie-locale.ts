import { cookies } from 'next/headers';
import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from './i18n';

/**
 * Локаль из cookie переключателя языка — для страниц вне `[locale]`,
 * которые рендерятся по запросу (`app/r/[code]`). Единственный источник,
 * который лендинг считает явным выбором человека (см. middleware.ts).
 * Вызывать только из динамических маршрутов: `cookies()` снимает статику.
 */
export async function cookieLocale(): Promise<Locale> {
  const raw = (await cookies()).get(LOCALE_COOKIE)?.value;
  return raw && isLocale(raw) ? raw : defaultLocale;
}
