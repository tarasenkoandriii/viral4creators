import type { Metadata } from 'next';
import Link from 'next/link';
import { EntryActions } from '../../../components/EntryActions';
import { getDictionary } from '../../../lib/get-dictionary';
import { isLocale, locales, type Locale } from '../../../lib/i18n';
import { SITE_NAME, SITE_URL, TELEGRAM_BOT_USERNAME, TMA_URL } from '../../../lib/content';
import { normalizeBotUsername } from '../../../lib/telegram-entry';
import { OPEN_APP_COPY, OPEN_APP_ENTRY, OPEN_APP_SEGMENT } from './open-copy';

/**
 * «Открыть приложение» — страница-переход для действия виджета ИИ-помощника
 * (Ш5 (6), Р-Ш5-13): прямой `t.me` виджет выдать не может (только хосты
 * сайта), поэтому кнопка ведёт сюда, а отсюда — «Открыть в Telegram» и
 * браузер (те же ссылки, что у главной). Тексты и зачем — `open-copy.ts`.
 *
 * Служебная: `noindex` (не контент для поиска — дубль кнопок главной), в
 * sitemap её нет; каноническая — главная локали. Статическая, как
 * остальные страницы локали; клиентский код — только `EntryActions`
 * (код приглашения `?ref=` из адреса, как на главной).
 */
export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export function generateMetadata({ params }: { params: { locale: string } }): Metadata {
  if (!isLocale(params.locale)) return {};
  const t = OPEN_APP_COPY[params.locale];
  return {
    title: t.metaTitle,
    description: t.metaDescription,
    alternates: { canonical: `${SITE_URL}/${params.locale}` },
    robots: { index: false, follow: true },
  };
}

export default function OpenAppPage({ params }: { params: { locale: string } }) {
  // Локаль уже проверена в app/[locale]/layout.tsx (notFound() там же).
  const locale: Locale = isLocale(params.locale) ? params.locale : 'ru';
  const t = OPEN_APP_COPY[locale];
  const dict = getDictionary(locale);
  const hasTelegram = normalizeBotUsername(TELEGRAM_BOT_USERNAME) !== null;
  return (
    <main className="wrap referral-page" data-page={OPEN_APP_SEGMENT}>
      <p className="referral-kicker">{SITE_NAME}</p>
      <h1 className="referral-title">{t.title}</h1>
      <p className="referral-lead">{t.lead}</p>
      <div className="referral-actions entry-actions">
        <EntryActions
          entry={OPEN_APP_ENTRY}
          tmaUrl={TMA_URL}
          botUsername={TELEGRAM_BOT_USERNAME}
          browserLabel={t.browserCta}
          telegramLabel={dict.entryActions.telegramCta}
        />
      </div>
      {hasTelegram ? null : <p className="referral-hint">{t.browserOnlyHint}</p>}
      <p className="referral-about">
        <Link href={`/${locale}`}>{t.homeLink}</Link>
      </p>
    </main>
  );
}
