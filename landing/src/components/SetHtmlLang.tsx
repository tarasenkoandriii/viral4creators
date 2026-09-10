'use client';

import { useEffect } from 'react';
import type { Locale } from '../lib/i18n';

/**
 * `<html lang>` рендерится один раз в настоящем корневом layout
 * (app/layout.tsx) и оттуда его не переписать декларативно из вложенного
 * app/[locale]/layout.tsx — React Server Components не дают двум layout'ам
 * писать в один и тот же DOM-узел. Маленький клиентский эффект — самый
 * простой рабочий обход: правит атрибут после гидратации, СЕО это не
 * задевает (поисковики строят разметку страницы по generateStaticParams +
 * пререндеру, а не по значению atрибута `lang` после гидратации), а для
 * скринридеров и переводчиков браузера атрибут правится раньше первого
 * взаимодействия с страницей.
 */
export function SetHtmlLang({ locale }: { locale: Locale }) {
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return null;
}
