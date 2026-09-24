import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getDictionary } from '../../../lib/get-dictionary';
import {
  defaultLocale,
  isLocale,
  LOCALE_COOKIE,
  type Locale,
} from '../../../lib/i18n';
import { ogImageUrl, socialMeta } from '../../../lib/social-meta';
import {
  SITE_URL,
  SITE_NAME,
  TMA_URL,
  TELEGRAM_BOT_USERNAME,
} from '../../../lib/content';
import {
  appInviteLink,
  isLinkPreviewAgent,
  normalizeCode,
  registerReferralVisit,
  telegramInviteLink,
} from '../../../lib/referral';

/**
 * Страница приглашения — «Условно бесплатный Lite» §5.1, этап 134.
 *
 * НЕТ `[locale]`-сегмента — намеренно, как у `video/[id]` и `feed` (см.
 * middleware.ts): это ссылка, которой делятся, и язык человека не должен
 * зависеть от адреса, которым его позвали. Локаль берётся из cookie
 * переключателя языка — единственного источника, который на этом
 * лендинге считается ЯВНЫМ выбором человека (см. middleware.ts: ни
 * `Accept-Language`, ни страна по IP здесь не гадаются).
 *
 * Страница делает ровно три вещи (§5.1):
 *
 *  1. **считает переход** — серверным кодом, до всякого JavaScript,
 *     поэтому счётчик не зависит от блокировщиков;
 *  2. **показывает, что человека ждёт** — вместе с Open Graph-превью,
 *     которое здесь уже есть от петли шеринга (этап 60);
 *  3. **даёт две дороги** — «Открыть в Telegram» (`t.me` со `startapp`)
 *     и «Продолжить здесь» (`TMA_URL?ref=`).
 *
 * Клиентского кода на странице нет ни строки: и кнопки, и ссылки —
 * обычные `<a>`. Приглашение открывают из мессенджеров, во встроенных
 * webview, где скрипт может не выполниться, — та же причина, по которой
 * без JS сделана заставка поздравления (`video/[id]/page.tsx`).
 */

/**
 * Каждый переход обязан быть посчитан, поэтому страница не кешируется
 * ни на секунду: ISR отдал бы второму пришедшему готовый HTML, и
 * `registerReferralVisit` для него бы не вызвался.
 */
export const dynamic = 'force-dynamic';

function currentLocale(): Locale {
  const raw = cookies().get(LOCALE_COOKIE)?.value;
  return raw && isLocale(raw) ? raw : defaultLocale;
}

export function generateMetadata({
  params,
}: {
  params: { code: string };
}): Metadata {
  const code = normalizeCode(params.code);
  if (!code) return {};
  const locale = currentLocale();
  const t = getDictionary(locale).referral;
  return {
    title: t.metaTitle,
    description: t.metaDescription,
    // Каноническая — сам лендинг, а не эта страница: у каждого
    // пригласившего свой адрес, и сколько угодно таких страниц в
    // индексе — это столько же дублей одного и того же текста.
    alternates: { canonical: SITE_URL },
    // Та же пара og+twitter, что у всех остальных страниц (находка Ф-7:
    // заданный порознь `twitter` разъезжается с `openGraph` и молча
    // наследует заголовок главной).
    ...socialMeta({
      title: t.metaTitle,
      description: t.metaDescription,
      url: `${SITE_URL}/r/${code}`,
      locale,
      image: ogImageUrl(SITE_URL, 'main', locale),
    }),
    // Личная ссылка одного человека — не контент для поиска. Превью в
    // мессенджере от `noindex` не страдает: его рисует не поисковик.
    robots: { index: false, follow: true },
  };
}

export default async function ReferralPage({
  params,
}: {
  params: { code: string };
}) {
  const code = normalizeCode(params.code);
  // Форма кода известна заранее — мусор отсекается здесь, а не походом
  // в API: маршрут анонимный, и перебирать им коды не должно быть
  // дёшево. Существующий ли это код, страница не выясняет и не
  // показывает: приглашённому это знать незачем (см. ReferralPublicController).
  if (!code) notFound();

  // Переход считаем только за человека. Мессенджер, увидев ссылку в
  // переписке, сам идёт за Open Graph-карточкой — и без этой проверки
  // отправленное в три чата приглашение показывало бы три перехода
  // раньше, чем его кто-нибудь открыл (а §12.1 делит на это число).
  if (!isLinkPreviewAgent(headers().get('user-agent'))) {
    await registerReferralVisit(code);
  }

  const locale = currentLocale();
  const dict = getDictionary(locale);
  const t = dict.referral;
  const telegramUrl = TELEGRAM_BOT_USERNAME
    ? telegramInviteLink(code, TELEGRAM_BOT_USERNAME)
    : null;

  return (
    <main className="wrap referral-page">
      <p className="referral-kicker">{SITE_NAME}</p>
      <h1 className="referral-title">{t.title}</h1>
      <p className="referral-lead">{t.lead}</p>

      <div className="referral-gift">
        <p className="referral-gift-title">{t.giftTitle}</p>
        <p className="referral-gift-text">{t.giftText}</p>
      </div>

      <div className="referral-actions">
        {/* Порядок кнопок не случаен: в Telegram человек попадает в
            мини-апп, где он уже опознан, и приглашение засчитывается
            без единого лишнего шага. Браузерная дорога честно работает
            тоже, но вход там — отдельное действие. */}
        {telegramUrl && (
          <a className="cta" href={telegramUrl}>
            {t.telegramCta}
          </a>
        )}
        <a className="cta cta-ghost" href={appInviteLink(code, TMA_URL)}>
          {t.browserCta}
        </a>
      </div>

      <p className="referral-hint">
        {telegramUrl ? t.bothHint : t.browserOnlyHint}
      </p>

      <p className="referral-code">
        {t.codeLabel}: <span className="referral-code-value">{code}</span>
      </p>

      <p className="referral-about">
        <Link href="/">{t.aboutLink}</Link>
      </p>
    </main>
  );
}
