import type { Dictionary } from '../lib/get-dictionary';
import type { Locale } from '../lib/i18n';
import { GREETING_SITE_URL } from '../lib/greeting-host';
import { TUTORIAL_SITE_URL } from '../lib/tutorial-host';
import {
  CLAUDE_REFERRAL_URL,
  GITHUB_REPO_URL,
  MARKETPLACE_URL,
  SPEC_KIT_URL,
} from '../lib/content';

/**
 * Общий футер лендинга.
 *
 * Вынесен по находке С-3 аудита
 * `docs-tz/AUDIT-Client-Site-Tutorial-Landing.md`. До этого футер был
 * заинлайнен в `app/[locale]/page.tsx`, у страницы поздравлений стоял
 * свой сокращённый (она на другом хосте — см. ниже), а у
 * `/how-it-works` футера НЕ БЫЛО ВООБЩЕ: страница с этапа 79
 * заканчивалась последним шагом блок-схемы, без ссылок на правовые
 * документы и без копирайта. Это не украшение — оферта и условия
 * использования должны быть достижимы с любой страницы сайта.
 *
 * Год берётся на рендере. Лендинг собирается статически, то есть в
 * сборке января год и останется январским до следующего деплоя;
 * это тот же компромисс, что был во встроенной версии, и он
 * сознательный: альтернатива — держать страницу динамической ради
 * четырёх цифр.
 *
 * `demoHref` — якорь ссылки «Демо» на главной: главная знает, есть ли
 * ролики для локали (та же загрузка, что у галереи), и без них ведёт к
 * шагам (`#how`). Остальные страницы ленту не грузят (how-it-works
 * статическая) — у них ссылка на `#demo` главной, где без роликов стоит
 * текст со ссылкой на шаги.
 */
export function Footer({ dict, locale, demoHref = '#demo' }: { dict: Dictionary; locale: Locale; demoHref?: '#demo' | '#how' }) {
  return (
    <footer>
      <div className="wrap footer-inner">
        <span>© {new Date().getFullYear()} viral4creators</span>
        <nav className="footer-links">
          <a href={`/${locale}${demoHref}`}>
            {dict.footer.demo}
          </a>
          <a href={`${GREETING_SITE_URL}/${locale}`}>{dict.footer.greetings}</a>
          {/* Перелинковка на мини-лендинги поддоменов — абсолютными
              адресами: это другие хосты, относительная ссылка увела бы
              на несуществующий путь текущего. */}
          <a href={`${TUTORIAL_SITE_URL}/${locale}`}>
            {dict.footer.siteTutorial}
          </a>
          <a href={MARKETPLACE_URL}>{dict.footer.marketplace}</a>
          <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
            {dict.footer.github}
          </a>
          {/* Обычные `<a>`, не `next/link`: у `/legal` свой корневой
              документ (`app/legal/layout.tsx` рисует свой `<html>`), и
              переход туда — всё равно полная загрузка страницы; `Link`
              добавил бы только префетч. Правило `no-html-link-for-pages`
              видит `app/` с eslint-config-next 15 (в 14 — только `pages/`). */}
          {/* eslint-disable @next/next/no-html-link-for-pages */}
          <a href="/legal/offer">{dict.footer.offer}</a>
          <a href="/legal/terms-of-use">{dict.footer.terms}</a>
          {/* eslint-enable @next/next/no-html-link-for-pages */}
          <a href={SPEC_KIT_URL} target="_blank" rel="noreferrer">
            {dict.footer.builtWith}
          </a>
          {/* Доп. запрос владельца продукта: та же реферальная ссылка
              Claude, что уже в футере TMA (frontend/src/App.tsx) — тот
              же текст словаря переиспользован, а не переведён заново. */}
          <a href={CLAUDE_REFERRAL_URL} target="_blank" rel="noreferrer">
            {dict.footer.madeWithClaude}
          </a>
        </nav>
        {/* Юридические документы намеренно одноязычные (см. middleware.ts,
            lib/i18n.ts) — на неродной для них локали честно об этом
            предупреждаем прямо у ссылок, а не молчим. */}
        {locale !== 'ru' && (
          <p className="legal-notice">{dict.footer.legalNoticeOtherLocale}</p>
        )}
      </div>
    </footer>
  );
}
