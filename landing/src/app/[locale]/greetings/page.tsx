import type { Metadata } from 'next';
import { Faq } from '../../../components/Faq';
import { GreetingOccasionGrid } from '../../../components/GreetingOccasionGrid';
import { GreetingSampleGallery } from '../../../components/GreetingSampleGallery';
import { IllustrationIcon } from '../../../components/IllustrationIcon';
import { getDictionary } from '../../../lib/get-dictionary';
import { OG_LOCALES, isLocale, locales, type Locale } from '../../../lib/i18n';
import { greetingPageUrl } from '../../../lib/greeting-host';
import { SITE_URL, TMA_URL } from '../../../lib/content';

/**
 * Посадочная страница четвёртого типа проекта — роликов-поздравлений
 * (docs-tz/TZ-Greeting-Video-Landing.md, этап 3 плана
 * docs-tz/AUDIT-Greeting-Landing-And-Upgrade-Plan.md).
 *
 * Живёт в том же приложении, что и главный лендинг, но показывается по
 * собственному поддомену: `middleware.ts` отдаёт её на
 * `greeting.viral4creators.app/<locale>`, а `/<locale>/greetings` на
 * обоих хостах сводит туда же 308-м редиректом. Один адрес — один
 * canonical, никакого дубля контента (находка 1.6 аудита).
 *
 * Чего здесь НЕТ и почему:
 *
 *  - демо-ролика с главной (`DEMO_YOUTUBE_EMBED_URL`) — это реклама
 *    товара, а человек пришёл за поздравлением (§7 ТЗ);
 *  - секции `features` главной — она описывает разбор референса и
 *    анализ аудитории, к поздравлению неприменимые (§7 ТЗ);
 *  - ИИ-консультанта. Его база знаний собирается из шагов, тарифов и
 *    FAQ ГЛАВНОГО лендинга, а действия вида `{kind:'faq', faqIndex}`
 *    адресуют вопросы по главному словарю. На этой странице он отвечал
 *    бы про другое и прокручивал не туда (находка 1.3 аудита). Чтобы он
 *    появился здесь честно, ему нужен третий вариант `page` на бэкенде
 *    и своя база — это отдельная работа, а не строчка в разметке;
 *  - секции группового режима (§4 п.5 ТЗ) — фичи №10 компаньон-ТЗ пока
 *    нет, а ТЗ прямо требует не публиковать пустое обещание.
 */

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

function localeOf(raw: string): Locale {
  return isLocale(raw) ? raw : 'ru';
}

export function generateMetadata({
  params,
}: {
  params: { locale: string };
}): Metadata {
  const locale = localeOf(params.locale);
  const dict = getDictionary(locale);
  const g = dict.greetingsLanding;
  return {
    title: g.meta.title,
    description: g.meta.description,
    keywords: g.meta.keywords,
    // Canonical — адрес на ПОДДОМЕНЕ, а не тот путь, по которому этот
    // файл лежит в приложении: путь `/<locale>/greetings` на обоих
    // хостах отвечает редиректом и самостоятельным адресом не является.
    alternates: { canonical: greetingPageUrl(locale) },
    openGraph: {
      title: g.meta.title,
      description: g.meta.description,
      url: greetingPageUrl(locale),
      locale: OG_LOCALES[locale],
      type: 'website',
    },
    robots: { index: true, follow: true },
  };
}

export default function GreetingsLandingPage({
  params,
}: {
  params: { locale: string };
}) {
  const locale = localeOf(params.locale);
  const dict = getDictionary(locale);
  const g = dict.greetingsLanding;
  // Метка источника для воронки (§4 п.1 ТЗ) — по ней потом отличить
  // трафик этой страницы от общего входа в мастер.
  const ctaHref = `${TMA_URL}?entry=greetings#/projects/new`;

  return (
    <>
      <main id="top">
        <section className="hero">
          <div className="wrap">
            <span className="badge">{g.hero.badge}</span>
            <h1>{g.hero.title}</h1>
            <p>{g.hero.subtitle}</p>
            <div className="hero-actions">
              <a className="cta" href={ctaHref}>
                {g.hero.cta}
              </a>
            </div>
            <p className="hero-note">{g.hero.note}</p>
          </div>
        </section>

        {/* Витрина сразу под hero (§4 п.2 ТЗ): для этого запроса «покажи,
            что получится» убеждает раньше, чем перечисление возможностей.
            Секции не будет вовсе, пока оператор ничего не отобрал. */}
        {/* @ts-expect-error Async Server Component — поддерживается Next
            App Router, но типы JSX в React 18 ещё не выражают async-узел */}
        <GreetingSampleGallery
          dict={dict}
          title={g.samples.title}
          lead={g.samples.lead}
        />

        <section className="occasions" id="occasions">
          <div className="wrap">
            <h2>{g.occasions.title}</h2>
            <p className="section-lead">{g.occasions.lead}</p>
            <GreetingOccasionGrid
              occasions={dict.sharedVideo.occasion}
              sensitiveNote={g.occasions.sensitiveNote}
            />
          </div>
        </section>

        <section className="steps" id="how">
          <div className="wrap">
            <h2>{g.steps.title}</h2>
            <p className="section-lead">{g.steps.lead}</p>
            {/* Свои четыре шага, а не компонент HowItWorks с главной: тот
                выводит имя иконки из номера шага и нарисован под десять
                шагов рекламного пайплайна — четыре шага поздравления
                молча получили бы чужие картинки (находка 1.4 аудита). */}
            <ol className="steps-grid">
              {g.steps.items.map((step, index) => (
                <li className="step-card" key={step.title}>
                  <div className="step-card-head">
                    <span className="step-number">{index + 1}</span>
                    <span className="feature-icon" aria-hidden="true">
                      <IllustrationIcon
                        name={`greet-step-${index + 1}`}
                        size={16}
                      />
                    </span>
                    <strong>{step.title}</strong>
                  </div>
                  <p>{step.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="details" id="price">
          <div className="wrap">
            <h2>{g.price.title}</h2>
            <p className="section-lead">{g.price.text}</p>
          </div>
        </section>

        <section className="faq" id="faq">
          <div className="wrap">
            <h2>{g.faq.title}</h2>
            {/* Свой набор вопросов — проп появился этапом 3; индексы
                `data-faq-index` при этом не выводятся, чтобы не спорить с
                адресацией ИИ-консультанта главной страницы. */}
            <Faq items={g.faq.items} />
          </div>
        </section>

        <section className="final-cta">
          <div className="wrap">
            <h2>{g.finalCta.title}</h2>
            <p>{g.finalCta.text}</p>
            <a className="cta" href={ctaHref}>
              {g.finalCta.cta}
            </a>
          </div>
        </section>
      </main>

      {/* Свой футер, а НЕ общий `components/Footer.tsx` (С-3 аудита
          обучалки): эта страница живёт на поддомене, и ссылки в общем
          футере относительные — `/legal/offer` увёл бы на несуществующий
          адрес поддомена, а ссылка «поздравления» вела бы сама на себя.
          Общий компонент правильный для главного хоста, этот — для
          поддомена; сводить их в один с флагом значит завести в нём
          ветку «на каком мы сайте», которая уже есть в middleware. */}
      <footer>
        <div className="wrap footer-inner">
          <span>© {new Date().getFullYear()} viral4creators</span>
          <nav className="footer-links">
            {/* Абсолютная ссылка: с поддомена главный сайт — другой хост. */}
            <a href={`${SITE_URL}/${locale}`}>{g.backToMain}</a>
            {/* Тоже абсолютные: `/legal/*` исключён из middleware (там
                одна редакция на все локали), поэтому с поддомена он
                отдавался бы по второму адресу. Своими ссылками этот
                дубль не создаём. */}
            <a href={`${SITE_URL}/legal/offer`}>{dict.footer.offer}</a>
            <a href={`${SITE_URL}/legal/terms-of-use`}>{dict.footer.terms}</a>
          </nav>
          {locale !== 'ru' && (
            <p className="legal-notice">{dict.footer.legalNoticeOtherLocale}</p>
          )}
        </div>
      </footer>
    </>
  );
}
