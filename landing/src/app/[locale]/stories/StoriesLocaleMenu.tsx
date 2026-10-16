'use client';

import { useRef } from 'react';
import { LOCALE_COOKIE, LOCALE_LABELS, locales, type Locale } from '../../../lib/i18n';

/**
 * Выбор языка Story‑Tales: `<details>` со ссылками на пять локалей.
 *
 * Почему не общий `LocaleSwitcher` (`<select>` + `router.push`):
 *
 *  - без JavaScript `<select>` не делает ничего, а ссылки работают всегда
 *    (страница статическая, и клавиатура/скринридер получают обычный
 *    список ссылок с `hreflang`);
 *  - ТЗ §7 требует, чтобы переключение СОХРАНЯЛО ПОЗИЦИЮ на странице, а
 *    `router.push('/<locale>')` теряет якорь (`#faq`).
 *
 * Якорь дописывается к `href` заранее — на нажатии кнопки мыши
 * (`mousedown`, любой кнопкой) и на фокусе с клавиатуры, то есть ДО
 * того, как браузер прочитает адрес. Поэтому он сохраняется и при обычном
 * клике, и при Enter, и при открытии в новой вкладке средней кнопкой
 * (та шлёт `auxclick`, а не `click` — раньше этот случай терял якорь,
 * находка S3-10 аудита). Cookie `NEXT_LOCALE` — явный выбор человека,
 * который читает `middleware.ts`, — пишется только на сам выбор
 * (`click`/`auxclick`), не на фокус.
 *
 * Esc закрывает открытое меню и возвращает фокус на кнопку — у
 * `<details>` этого поведения по умолчанию нет.
 *
 * Ссылки относительные (`/<locale>`): на поддомене это и есть канонический
 * адрес; на главном домене `/<locale>/stories` уводит на поддомен
 * middleware, а пересчёт ниже сохраняет текущий путь.
 */
export function StoriesLocaleMenu({ current, label }: { current: Locale; label: string }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);

  function withHash(anchor: HTMLAnchorElement, next: Locale) {
    try {
      const { pathname, hash } = window.location;
      const rest = pathname.replace(new RegExp(`^/${current}(?=/|$)`), '');
      anchor.href = `/${next}${rest}${hash}`;
    } catch {
      // Не удалось — остаётся обычная ссылка без якоря.
    }
  }

  function remember(next: Locale) {
    try {
      document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    } catch {
      // Без cookie язык всё равно сменится — адресом.
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDetailsElement>) {
    const details = detailsRef.current;
    if (event.key === 'Escape' && details?.open) {
      event.preventDefault();
      details.open = false;
      summaryRef.current?.focus();
    }
  }

  return (
    <details className="st-lang" ref={detailsRef} onKeyDown={onKeyDown}>
      <summary ref={summaryRef}>
        <span className="sr-only">
          {label}: {LOCALE_LABELS[current]}
        </span>
        <span aria-hidden="true">{current.toUpperCase()}</span>
      </summary>
      <ul>
        {locales.map((l) => (
          <li key={l}>
            <a
              href={`/${l}`}
              hrefLang={l}
              lang={l}
              aria-current={l === current ? 'true' : undefined}
              onMouseDown={(event) => withHash(event.currentTarget, l)}
              onFocus={(event) => withHash(event.currentTarget, l)}
              onClick={(event) => {
                withHash(event.currentTarget, l);
                remember(l);
              }}
              onAuxClick={() => remember(l)}
            >
              {LOCALE_LABELS[l]}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
