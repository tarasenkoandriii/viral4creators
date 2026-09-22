import type { Metadata } from 'next';
import Image from 'next/image';
import { Faq } from '../../../components/Faq';
import { CompetitorComparisonTable } from '../../../components/CompetitorComparisonTable';
import { getDictionary } from '../../../lib/get-dictionary';
import { OG_LOCALES, isLocale, locales, type Locale } from '../../../lib/i18n';
import { tutorialPageUrl } from '../../../lib/tutorial-host';
import { SITE_URL, TMA_URL } from '../../../lib/content';

/**
 * Посадочная страница третьего типа проекта — обучающего видео по сайту
 * заказчика (`docs-tz/TZ-Client-Site-Tutorial-Landing.md`, аудит —
 * `docs-tz/AUDIT-Client-Site-Tutorial-Landing.md`).
 *
 * Живёт в том же приложении, что и главный лендинг, и показывается по
 * собственному поддомену `tutorial.viral4creators.app/<locale>`;
 * `/<locale>/site-tutorial` на обоих хостах сводится туда 308-м
 * редиректом. Один адрес — один canonical, дубля контента нет (тот же
 * приём, что у поздравлений, вынесен в таблицу `SUBDOMAIN_SITES` в
 * middleware).
 *
 * ## Чем эта страница отличается от `/greetings` — и почему
 *
 * Аудитория другая (§1 ТЗ): там человек покупает подарок и решает за
 * минуты, здесь — маркетолог, агентство или служба поддержки, которые
 * ПЕРЕД покупкой сравнивают инструменты таблицами. Отсюда порядок
 * секций: сначала механика («как это выглядит»), потом сравнение, и
 * только потом — кому это нужно. Витрины примеров нет вовсе, и это не
 * забывчивость: подать в неё обучалку сегодня физически нечем
 * (находка Б-3 аудита — публичная страница строится из `Session`, а
 * обучалка идёт другим конвейером).
 *
 * ## Чего здесь НЕТ и почему
 *
 *  - ИИ-консультанта. Его база знаний собрана по шагам, тарифам и FAQ
 *    ГЛАВНОГО лендинга, а действия `{kind:'faq', faqIndex}` адресуют
 *    вопросы главного словаря. Здесь он отвечал бы про другое и
 *    прокручивал не туда (находка С-2). Чтобы он появился честно, нужен
 *    третий вариант `page` на бэкенде и своя база — отдельная работа.
 *  - `HowItWorks` с главной. Компонент принимает конкретный раздел
 *    главного словаря на десять шагов рекламного пайплайна и выводит
 *    имена иконок из НОМЕРА шага — четыре шага обучалки молча получили
 *    бы чужие картинки (находка С-1). Поэтому свои карточки.
 *  - Обещаний аналитики вовлечённости, встраиваемого виджета,
 *    персонализации демо под зрителя и автообновления при смене вёрстки
 *    сайта: ничего этого в продукте нет (§4 обзора конкурентов).
 *    Первые две строчки честно стоят в сравнительной таблице как наш
 *    проигрыш, остальные две не упоминаются вовсе — сравнивать себя с
 *    рынком по ним не на чем.
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
  const t = getDictionary(locale).siteTutorialLanding;
  return {
    title: t.meta.title,
    description: t.meta.description,
    // Canonical — адрес на ПОДДОМЕНЕ, а не путь, по которому этот файл
    // лежит в приложении: `/<locale>/site-tutorial` на обоих хостах
    // отвечает редиректом и самостоятельным адресом не является.
    alternates: { canonical: tutorialPageUrl(locale) },
    openGraph: {
      title: t.meta.title,
      description: t.meta.description,
      url: tutorialPageUrl(locale),
      locale: OG_LOCALES[locale],
      type: 'website',
    },
    robots: { index: true, follow: true },
  };
}

export default function SiteTutorialLandingPage({
  params,
}: {
  params: { locale: string };
}) {
  const locale = localeOf(params.locale);
  const dict = getDictionary(locale);
  const t = dict.siteTutorialLanding;
  /**
   * Метка источника для воронки — и, в отличие от прошлого раза, её
   * теперь ЧИТАЮТ: `ProjectCreateScreen` открывает мастер сразу на
   * третьем типе проекта (`landing-entry.ts`, находка Б-1). До этой
   * правки параметр писался и не читался нигде, и ссылка отсюда вела бы
   * на форму товарного ролика.
   */
  const ctaHref = `${TMA_URL}?entry=site-tutorial#/projects/new`;

  return (
    <>
      <main id="top">
        <section className="hero">
          <div className="wrap">
            <span className="badge">{t.hero.badge}</span>
            <h1>{t.hero.title}</h1>
            <p>{t.hero.subtitle}</p>
            <div className="hero-actions">
              <a className="cta" href={ctaHref}>
                {t.hero.cta}
              </a>
            </div>
            <p className="hero-note">{t.hero.note}</p>
          </div>
        </section>

        {/* Самая важная секция для этой аудитории (§5 п.2 ТЗ): она
            технически подкована и не купится на абстрактную анимацию —
            нужен сам цикл «вставили ссылку → увидели экран → заполнили
            → следующий экран».

            Честная оговорка прямо в тексте (`how.lead`): это СХЕМЫ
            интерфейса, а не скриншоты. Настоящий кадр визарда
            показывает сайт заказчика, и взять его здесь неоткуда —
            выдавать рисунок за снимок экрана на странице, которая
            продаёт достоверность, было бы ровно тем, против чего она
            написана. */}
        <section className="frames" id="how">
          <div className="wrap">
            <h2>{t.how.title}</h2>
            <p className="section-lead">{t.how.lead}</p>
            <ol className="frames-grid">
              {t.how.items.map((item, index) => (
                <li className="frame-card" key={item.title}>
                  <Image
                    src={`/illustrations/tutorial-frame-${index + 1}.svg`}
                    alt=""
                    width={560}
                    height={360}
                    unoptimized
                  />
                  <div className="frame-card-body">
                    <span className="step-number">{index + 1}</span>
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.text}</p>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="compare" id="compare">
          <div className="wrap">
            <h2>{t.compare.title}</h2>
            <p className="section-lead">{t.compare.lead}</p>
            <CompetitorComparisonTable
              ourColumn={t.compare.ourColumn}
              theirColumn={t.compare.theirColumn}
              rows={t.compare.rows}
            />
            <p className="compare-note">{t.compare.note}</p>
          </div>
        </section>

        <section className="audience" id="audience">
          <div className="wrap">
            <h2>{t.audience.title}</h2>
            <div className="audience-grid">
              {t.audience.items.map((item) => (
                <article className="audience-card" key={item.title}>
                  <strong>{item.title}</strong>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Первый вопрос этой аудитории — сайты за логином (SaaS-кабинеты,
            личные кабинеты). Снятый заранее, он экономит отказ на этапе
            регистрации (§5 п.5 ТЗ). */}
        <section className="details" id="login">
          <div className="wrap">
            <h2>{t.login.title}</h2>
            <p className="section-lead">{t.login.lead}</p>
            <div className="login-grid">
              {t.login.items.map((item) => (
                <article className="login-card" key={item.title}>
                  <strong>{item.title}</strong>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>
            {/* Предупреждение слово в слово повторяет то, что продукт
                пишет человеку на своём же экране (`plainValuesWarning` в
                словаре визарда): лендинг и продукт не должны говорить
                разное про шифрование (находка Т-3 аудита). */}
            <p className="login-warning">{t.login.warning}</p>
          </div>
        </section>

        <section className="details" id="price">
          <div className="wrap">
            <h2>{t.price.title}</h2>
            {/* Текст НЕ скопирован с `/greetings` (находка Т-6): там
                признак `greetingVideo` включён на всех тарифах, здесь
                `siteTutorial` — Standard и выше, и «всё бесплатно» стало
                бы ложью в день включения оплаты. */}
            <p className="section-lead">{t.price.text}</p>
          </div>
        </section>

        <section className="faq" id="faq">
          <div className="wrap">
            <h2>{t.faq.title}</h2>
            {/* Свой набор вопросов; `data-faq-index` при этом не
                выводится, чтобы не спорить с адресацией ИИ-консультанта
                главной страницы (см. Faq.tsx). */}
            <Faq items={t.faq.items} />
          </div>
        </section>

        <section className="final-cta">
          <div className="wrap">
            <h2>{t.finalCta.title}</h2>
            <p>{t.finalCta.text}</p>
            <a className="cta" href={ctaHref}>
              {t.finalCta.cta}
            </a>
          </div>
        </section>
      </main>

      {/* Свой футер, а не общий `components/Footer.tsx`: страница на
          поддомене, и относительные ссылки общего футера (`/legal/offer`)
          увели бы на несуществующий адрес поддомена. Та же причина, что
          у страницы поздравлений. */}
      <footer>
        <div className="wrap footer-inner">
          <span>© {new Date().getFullYear()} viral4creators</span>
          <nav className="footer-links">
            <a href={`${SITE_URL}/${locale}`}>{t.backToMain}</a>
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
