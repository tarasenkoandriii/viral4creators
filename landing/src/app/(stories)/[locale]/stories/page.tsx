import type { Metadata, Viewport } from 'next';
import { isLocale, locales, type Locale } from '../../../../lib/i18n';
import { localeAlternates } from '../../../../lib/alternates';
import { SITE_URL, TELEGRAM_BOT_USERNAME, TMA_URL } from '../../../../lib/content';
import { isReachableOrigin } from '../../../../lib/site-origin';
import { browserEntryLink, normalizeBotUsername, telegramEntryLink } from '../../../../lib/telegram-entry';
import { ogImageUrl, socialMeta } from '../../../../lib/social-meta';
import { STORIES_REFERRER_POLICY, STORIES_ROBOTS, STORIES_SITE_URL, storiesPageUrl } from '../../../../lib/stories-host';
import { BRAND, getStoriesCopy, type StoriesCopy } from '../../../../lib/stories/copy';
import { loadStoryRelease, type LegalLinkKind, type StoryRelease } from '../../../../lib/stories/release';
import { ANCHORS, V1_READINESS, resolveStoryView, type CtaAction, type StoryAppLinks } from '../../../../lib/stories/cta';
import {
  isStoriesIndexable,
  isStoriesOpen,
  storiesLandingMode,
  type StoriesLandingMode,
} from '../../../../lib/stories/landing-mode';
import {
  STATIC_STORY_CAPABILITIES,
  loadStoryCapabilities,
  taleTitle,
  type StoryCapabilities,
} from '../../../../lib/stories/capabilities';
import { HeroIllustration } from './HeroIllustration';
import { StoriesLocaleMenu } from './StoriesLocaleMenu';

/**
 * Лендинг Story‑Tales — «сказка с обращением близкого человека»
 * (ТЗ `doc/STORY-TALES-LANDING-SPEC.md`, адаптация
 * `doc/STORY-TALES-LANDING-ADAPTED.md`, решения 16.10 вечер).
 *
 * Живёт в `landing/`, как поздравления и обучалка, и показывается по
 * собственному поддомену `story-tales.viral4creators.app/<locale>`
 * (`lib/stories-host.ts`, таблица `SUBDOMAIN_SITES` в `middleware.ts`);
 * `/<locale>/stories` на обоих хостах сводится туда 308-м редиректом.
 *
 * ## Чем эта страница отличается от соседних
 *
 *  - **Не индексируется никогда** (§12): meta robots здесь, HTTP
 *    `X-Robots-Tag` — `next.config.js` + `middleware.ts`, в картах сайта
 *    её нет. `robots: { index: true }` из `[locale]/layout.tsx` здесь
 *    ЗАМЕЩАЕТСЯ строкой `STORIES_ROBOTS` — это и есть исключение.
 *  - **Режим выпуска из конфига** (`lib/stories/release.json`): в v1 —
 *    технический `prep` (§5.1). Без демо, без Play, без формы, без цены и
 *    покупки. В текстах — «Скоро запуск», слова «пилот» на странице нет
 *    (Р-STL-15). Основное действие — «Открыть в Telegram» в раздел
 *    `#/stories` (Р-STL-17), «Как это работает» — вторым; без бота и
 *    адреса TMA основным становится якорь. Какие кнопки видны, решает
 *    чистая функция `resolveStoryView` (`lib/stories/cta.ts`), а не
 *    условия в разметке.
 *  - **Без аналитики** (Р-STL-8): ни счётчиков, ни пикселей, ни
 *    ИИ-консультанта (его база — про рекламный продукт). На лендинге нет
 *    глобальных счётчиков, поэтому исключать нечего; не добавлять сюда —
 *    стережёт `scripts/stories-page.test.ts`.
 *  - **Своя шапка, свой подвал, свои тексты** (`lib/stories/copy`): здесь
 *    не показываются QA, API и товарная генерация (§4); платформа — одна
 *    ненавязчивая ссылка в подвале.
 *  - **Почти без JavaScript**: единственный клиентский компонент — выбор
 *    языка (сохраняет якорь); FAQ — `<details>`.
 *
 * ## Режим лендинга (`STORY_TALES_LANDING`, Р-ST3-6, 20.10.2026)
 *
 * Ортогонален режиму выпуска из `release.json` (тот — про демо, форму и
 * мастер на САМОЙ странице и остаётся `prep`: ни плеера, ни формы, ни
 * покупки здесь нет). Режим лендинга решает, отдаётся ли страница вообще
 * (`closed` — 404 в middleware) и что о доступе говорят тексты:
 *
 *  - `closed` — тексты `prep` как были («Скоро запуск», без «пилота»);
 *  - `pilot` — «пилот по приглашению, до 15 семей» (`copy.access.pilot`),
 *    основное действие — тот же вход в раздел `#/stories` приложения
 *    (`startapp=e_stories`), где оставляют заявку; формы с личными данными
 *    на странице нет; noindex сохраняется;
 *  - `public` — тексты `copy.access.public`, без noindex и без пункта о
 *    закрытой индексации.
 *
 * В `pilot`/`public` каталог показывает блок «что доступно» из публичного
 * API (`lib/stories/capabilities.ts`): на сборке и раз в
 * `revalidate` секунд, с откатом на статические данные — сборка без
 * backend'а не падает. Событий нет: у лендинга нет механизма событий с
 * согласием (Р-ST3-ADM+LND-5), счётчик посещений Story‑Tales не учитывает.
 */

/**
 * ISR для блока «что доступно» — литералом (Next 15 читает конфиг
 * сегмента по исходнику, см. `scripts/segment-config.test.ts`); равен
 * `STORY_CAPABILITIES_REVALIDATE_SECONDS` и `max-age` ответа API. Явно, а
 * не только через `fetch`: неудачный запрос на сборке не должен сделать
 * страницу вечной статикой с откатом.
 */
export const revalidate = 300;

/**
 * Что в `pilot`/`public` замещается по месту (ответы и пункты, которые в
 * `prep` говорят будущим временем о том, что уже работает): FAQ — голос,
 * ссылка, языки, цена; рассказчик — семейный голос; приватность — снятие
 * ссылки; синтетический образ рассказчика — только у владельца (ST3-U-16):
 * FAQ о фото/скетче и предпросмотре, шаг проверки, блок «Фото или скетч».
 * Вопросы и порядок — те же (сверяет `stories-copy.test.ts`).
 */
const FAQ_VOICE_INDEX = 1;
const FAQ_LOOK_INDEX = 2;
const FAQ_LINK_INDEX = 5;
const FAQ_PREVIEW_INDEX = 7;
const HOW_CHECK_STEP_INDEX = 2;
const FAQ_LANGUAGES_INDEX = 6;
const FAQ_PRICE_INDEX = 8;
const NARRATOR_FAMILY_VOICE_INDEX = 2;
const PRIVACY_LINK_INDEX = 3;

/**
 * Готовность того, чего нет в конфиге: плеера (§9) и обработчика заявок
 * (§10). В v1 обоих нет — даже правка `release.json` на `pilot` не
 * покажет демо и форму, пока здесь `false` (см. `resolveStoryView`).
 */
const READINESS = V1_READINESS;

export const viewport: Viewport = {
  // Цвет системной полосы — бумага страницы, а не тёмный фон лендинга.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbf6ec' },
    { media: '(prefers-color-scheme: dark)', color: '#1b1814' },
  ],
  colorScheme: 'light dark',
  // Содержимое под вырезами экрана — отступы `env(safe-area-inset-*)`
  // в `stories.css` (шапка, поля, подвал).
  viewportFit: 'cover',
};

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

function localeOf(raw: string): Locale {
  return isLocale(raw) ? raw : 'ru';
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const locale = localeOf((await params).locale);
  const t = getStoriesCopy(locale);
  const mode = storiesLandingMode();
  const description = isStoriesOpen(mode) ? accessCopy(t, mode).metaDescription : t.meta.description;
  return {
    title: t.meta.title,
    description,
    // Ключевые слова главной (`[locale]/layout.tsx`) сюда не наследуются.
    keywords: null,
    // Canonical — адрес на поддомене (адрес выбран, §12 это разрешает), и
    // hreflang между пятью существующими локалями. `alternates` замещает
    // объект layout'а целиком — `languages` обязательны (находка Ф-1).
    alternates: localeAlternates(storiesPageUrl, (l) => `/${l}`, locale),
    // Своя карточка (Р-STL-18): `public/og/stories-<locale>.jpg` —
    // рисунок первого экрана, марка, слоган и заголовок
    // (`scripts/og-stories-cards.tsx`). Явно, чтобы не унаследовать
    // картинку главной от layout.
    ...socialMeta({
      title: t.meta.title,
      description,
      url: storiesPageUrl(locale),
      locale,
      image: ogImageUrl(STORIES_SITE_URL, 'stories', locale),
    }),
    // До `public` — noindex (второй замок — `X-Robots-Tag`); в `public`
    // явное `index`, раз общий layout локали сюда больше не наследуется.
    robots: isStoriesIndexable(mode) ? { index: true, follow: true } : STORIES_ROBOTS,
    referrer: STORIES_REFERRER_POLICY,
  };
}

/** Тексты доступа режима; в `closed` их нет — там тексты `prep`. */
function accessCopy(t: StoriesCopy, mode: Exclude<StoriesLandingMode, 'closed'>) {
  return mode === 'pilot' ? t.access.pilot : t.access.public;
}

/** Сумма «цена от» — в валюте API, по правилам языка страницы. */
function formatUsd(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(value);
}

/**
 * Блок «что доступно»: языки, истории, форматы и «цена от» — из API;
 * при откате — только языки и честная подпись, что список — в приложении.
 */
function CapabilitiesBlock({
  caps,
  title,
  t,
  locale,
}: {
  caps: StoryCapabilities;
  title: string;
  t: StoriesCopy['capabilities'];
  locale: Locale;
}) {
  const formats = caps.formats.map((f) => t.formatNames[f]);
  return (
    <div className="st-card st-capabilities" data-capabilities={caps.source}>
      <h3>{title}</h3>
      <p className="st-note">{caps.source === 'api' ? t.lead : t.staticLead}</p>
      <dl className="st-capability-list">
        <dt>{t.languagesLabel}</dt>
        <dd>{caps.languages.map((l) => t.languageNames[l]).join(', ')}</dd>
        <dt>{t.talesLabel}</dt>
        <dd>
          {caps.tales.length ? (
            <ul>
              {caps.tales.map((tale) => (
                <li key={tale.slug} data-tale={tale.slug}>
                  {taleTitle(tale, locale)} ({tale.languages.map((l) => t.languageNames[l]).join(', ')})
                </li>
              ))}
            </ul>
          ) : (
            t.talesEmpty
          )}
        </dd>
        {formats.length ? (
          <>
            <dt>{t.formatsLabel}</dt>
            <dd>{formats.join(', ')}</dd>
          </>
        ) : null}
        {caps.priceFromUsd !== null ? (
          <>
            <dt>{t.priceLabel}</dt>
            <dd data-price-from={caps.priceFromUsd}>
              {t.priceFrom.replace('{price}', formatUsd(caps.priceFromUsd, locale))}. {t.priceNote}
            </dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

/** Ссылка на юридический документ: главный домен, если он известен. */
function legalHref(slug: string): string {
  return isReachableOrigin(SITE_URL) ? `${SITE_URL}/legal/${slug}` : `/legal/${slug}`;
}

/**
 * Ссылки подвала из конфига. Если «Условия» и «Приватность» указывают на
 * один документ (так в v1: приватность — раздел 7 Условий), ссылка одна,
 * с общей подписью, а не два одинаковых адреса подряд.
 */
function legalLinks(release: StoryRelease, t: StoriesCopy): Array<{ href: string; label: string }> {
  const { offer, terms, privacy, narratorConsent } = release.legalLinks;
  const out: Array<{ href: string; label: string }> = [];
  const add = (slug: string | undefined, kind: LegalLinkKind | 'termsAndPrivacy') => {
    if (slug) out.push({ href: legalHref(slug), label: t.footer[kind] });
  };
  add(offer, 'offer');
  if (terms && terms === privacy) {
    add(terms, 'termsAndPrivacy');
  } else {
    add(terms, 'terms');
    add(privacy, 'privacy');
  }
  add(narratorConsent, 'narratorConsent');
  return out;
}

export default async function StoriesLandingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const locale = localeOf((await params).locale);
  const t = getStoriesCopy(locale);
  const mode = storiesLandingMode();
  const access = isStoriesOpen(mode) ? accessCopy(t, mode) : null;
  // В `closed` страница не отдаётся (404 в middleware) — в API не ходим.
  const caps = access ? await loadStoryCapabilities() : STATIC_STORY_CAPABILITIES;
  const openAnswers: Record<number, string> = access
    ? {
        [FAQ_VOICE_INDEX]: t.opened.faqVoice,
        [FAQ_LOOK_INDEX]: t.opened.faqLook,
        [FAQ_LINK_INDEX]: t.opened.faqLink,
        [FAQ_PREVIEW_INDEX]: t.opened.faqPreview,
        [FAQ_LANGUAGES_INDEX]: access.faqLanguages,
        [FAQ_PRICE_INDEX]: access.faqPrice,
      }
    : {};
  const faqItems = t.faq.items.map((item, i) => (openAnswers[i] ? { ...item, answer: openAnswers[i] } : item));
  const narratorItems = access
    ? t.narrator.items.map((item, i) => (i === NARRATOR_FAMILY_VOICE_INDEX ? { ...item, text: t.opened.narratorFamilyVoice } : item))
    : t.narrator.items;
  // ST3-U-16: синтетический образ рассказчика — только у владельца.
  const howSteps = access ? t.how.steps.map((step, i) => (i === HOW_CHECK_STEP_INDEX ? t.opened.stepCheck : step)) : t.how.steps;
  const sketchText = access ? t.opened.sketchText : t.narrator.sketch.text;
  const basePrivacy = access
    ? t.privacy.items.map((item, i) => (i === PRIVACY_LINK_INDEX ? t.opened.privacyLink : item))
    : t.privacy.items;
  const privacyItems = isStoriesIndexable(mode) ? basePrivacy : [...basePrivacy, t.privacy.noindex];
  const release = loadStoryRelease({ tmaUrl: TMA_URL, botUsername: TELEGRAM_BOT_USERNAME });
  /**
   * Раздел TMA `#/stories` (Р-STL-10/17): только метка `stories`, никаких
   * данных семьи в адресе. Telegram — если задан бот; браузерный адрес —
   * если TMA_URL настоящий (в боевой сборке localhost-дефолт не годится:
   * мёртвый адрес хуже отсутствующего). Нет обоих — `resolveStoryView`
   * сделает основным якорь «Как это работает».
   */
  const links: StoryAppLinks = {
    telegramHref: telegramEntryLink('stories', TELEGRAM_BOT_USERNAME),
    browserHref:
      isReachableOrigin(TMA_URL) || process.env.NODE_ENV !== 'production'
        ? browserEntryLink('stories', TMA_URL)
        : null,
  };
  const view = resolveStoryView(release, READINESS, links);
  const label = (cta: CtaAction) => t.cta[cta.id];
  const primaryIsApp = view.primary.id === 'telegram' || view.primary.id === 'app';
  /** Ссылки в раздел для блока «Как это работает» — если основным стала не она. */
  const howLinks = primaryIsApp
    ? []
    : [
        links.browserHref ? { href: links.browserHref, text: t.how.appLink } : null,
        links.telegramHref ? { href: links.telegramHref, text: t.how.telegramLink } : null,
      ].filter((l): l is { href: string; text: string } => l !== null && view.app !== null);
  const platformHref = isReachableOrigin(SITE_URL) ? `${SITE_URL}/${locale}` : null;
  const footerLinks = legalLinks(release, t);
  const contactBot = normalizeBotUsername(TELEGRAM_BOT_USERNAME);

  return (
    <div className="st-root" data-release-mode={view.mode} data-landing-mode={mode} data-content-version={release.contentVersion}>
      <a className="st-skip" href="#content">
        {t.skipLink}
      </a>

      {/* Шапка §6.1: марка, два якоря (на телефоне — скрыты), язык и одно
          действие режима. Восьми ссылок на телефоне нет. */}
      <header className="st-header">
        <div className="wrap st-header-inner">
          <a className="st-brand" href="#top" aria-label={t.header.brandHome}>
            {BRAND}
          </a>
          <nav className="st-nav" aria-label={t.header.navAriaLabel}>
            {view.showExampleNav ? (
              <a className="st-nav-link" href={ANCHORS.example}>
                {t.header.example}
              </a>
            ) : null}
            <a className="st-nav-link" href={ANCHORS.how}>
              {t.header.how}
            </a>
            <a className="st-nav-link" href="#faq">
              {t.header.faq}
            </a>
            <StoriesLocaleMenu current={locale} label={t.header.languageLabel} />
            <a className="cta cta-small" href={view.primary.href} data-cta={view.primary.id} data-entry={primaryIsApp ? 'stories' : undefined}>
              {label(view.primary)}
            </a>
          </nav>
        </div>
      </header>

      <main id="content" className="st-main">
        {/* 6.2 Hero. */}
        <section className="st-hero" id="top">
          <div className="wrap st-hero-grid">
            <div>
              <span className="badge">{access ? access.badge : t.hero.badge}</span>
              {/* Слоган владельца (Р-STL-16) — над заголовком, как надпись,
                  а не обещание. */}
              <p className="st-tagline">{t.tagline}</p>
              <h1>{t.hero.title}</h1>
              <p className="st-hero-subtitle">{t.hero.subtitle}</p>
              <div className="st-actions">
                <a className="cta" href={view.primary.href} data-cta={view.primary.id} data-entry={primaryIsApp ? 'stories' : undefined}>
                  {label(view.primary)}
                </a>
                {view.secondary.map((cta) => (
                  <a key={cta.id} className="cta cta-ghost" href={cta.href} data-cta={cta.id}>
                    {label(cta)}
                  </a>
                ))}
              </div>
              {/* Честная подпись у кнопки в приложение: что там уже есть. */}
              {primaryIsApp ? <p className="st-app-note">{access ? access.appNote : t.hero.appNote}</p> : null}
              <p className="st-micro">{t.hero.micro}</p>
            </div>
            <HeroIllustration
              alt={t.hero.illustrationAlt}
              caption={t.hero.illustrationCaption}
              narratorLabel={t.hero.narratorCardLabel}
              taleLabel={t.hero.taleCardLabel}
            />
          </div>
        </section>

        {/* 6.3 Пример: в `prep` — схема без медиа и честная подпись. */}
        <section className="st-section st-section-alt" id="example" aria-labelledby="st-example-title">
          <div className="wrap">
            <h2 id="st-example-title">{t.example.title}</h2>
            <p className="st-lead">{t.example.lead}</p>
            <ol className="st-scheme" aria-label={t.example.schemeLabel}>
              {t.example.parts.map((part) => (
                <li className="st-card" key={part.title}>
                  <h3>{part.title}</h3>
                  <p>{part.text}</p>
                </li>
              ))}
            </ol>
            <p className="st-note">{t.example.caption}</p>
          </div>
        </section>

        {/* 6.4 Кому подойдёт — три карточки, без фото детей. */}
        <section className="st-section" id="audience" aria-labelledby="st-audience-title">
          <div className="wrap">
            <h2 id="st-audience-title">{t.audience.title}</h2>
            <ul className="st-grid st-grid-3">
              {t.audience.items.map((item) => (
                <li className="st-card" key={item.title}>
                  <h3>{item.title}</h3>
                  <p>{item.situation}</p>
                  <p className="st-result">
                    <strong>{t.audience.resultLabel}</strong>
                    {item.result}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* 6.5 Как это работает — планируемый путь, не форма. */}
        <section className="st-section st-section-alt" id="how" aria-labelledby="st-how-title">
          <div className="wrap">
            <span className="st-tag">{access ? access.howBadge : t.how.plannedBadge}</span>
            <h2 id="st-how-title">{t.how.title}</h2>
            <p className="st-lead">{access ? access.howLead : t.how.lead}</p>
            <ol className="st-grid st-grid-4 st-steps">
              {howSteps.map((step) => (
                <li className="st-card" key={step}>
                  <p>{step}</p>
                </li>
              ))}
            </ol>
            {/* Основным действием раздел приложения уже стоит в первом
                экране; здесь — только если основным стало другое. */}
            {howLinks.length ? (
              <div className="st-app">
                <p>{access ? access.howAppLead : t.how.appLead}</p>
                {howLinks.map((link) => (
                  <a key={link.href} className="cta cta-ghost cta-small" href={link.href} data-entry="stories">
                    {link.text}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        </section>

        {/* 6.6 Рассказчик. */}
        <section className="st-section" id="narrator" aria-labelledby="st-narrator-title">
          <div className="wrap">
            <h2 id="st-narrator-title">{t.narrator.title}</h2>
            <p className="st-lead">{t.narrator.lead}</p>
            <ul className="st-grid st-grid-3">
              {narratorItems.map((item) => (
                <li className="st-card" key={item.title}>
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                </li>
              ))}
            </ul>
            <div className="st-card st-sketch">
              <h3>{t.narrator.sketch.title}</h3>
              <p>{sketchText}</p>
            </div>
          </div>
        </section>

        {/* 6.7 Каталог: «готовится», без декоративных обложек. */}
        <section className="st-section st-section-alt" id="catalog" aria-labelledby="st-catalog-title">
          <div className="wrap">
            <span className="st-tag">{access ? access.catalogStatus : t.catalog.status}</span>
            <h2 id="st-catalog-title">{t.catalog.title}</h2>
            <p className="st-lead">{access ? access.catalogText : t.catalog.text}</p>
            {access ? (
              <CapabilitiesBlock caps={caps} title={access.capabilitiesTitle} t={t.capabilities} locale={locale} />
            ) : (
              <ul className="st-points">
                {t.catalog.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* 6.8 Контроль взрослого и приватность. */}
        <section className="st-section" id="privacy" aria-labelledby="st-privacy-title">
          <div className="wrap">
            <h2 id="st-privacy-title">{t.privacy.title}</h2>
            <ul className="st-grid st-grid-2">
              {privacyItems.map((item) => (
                <li className="st-card" key={item}>
                  <p>{item}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* 6.9 Запуск (Р-STL-15): честный статус — что есть сейчас и что
            появится; без цен. Слово «пилот» — только в режиме `pilot`
            (Р-ST3-6). */}
        <section className="st-section st-section-alt" id="launch" aria-labelledby="st-launch-title">
          <div className="wrap">
            <h2 id="st-launch-title">{t.launch.title}</h2>
            <p className="st-status">
              <span>{t.launch.statusLabel}:</span>
              <strong>{access ? access.status : t.launch.status}</strong>
            </p>
            <div className="st-grid st-grid-2">
              <div className="st-card">
                <h3>{t.launch.availableTitle}</h3>
                <ul className="st-points">
                  {/* Про приложение — только когда путь туда есть на
                      странице (находка S3-5 аудита). */}
                  {(access
                    ? primaryIsApp
                      ? access.available
                      : access.availableNeutral
                    : primaryIsApp
                      ? t.launch.available
                      : t.launch.availableNeutral
                  ).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div className="st-card">
                <h3>{access ? access.comingTitle : t.launch.comingTitle}</h3>
                <ul className="st-points">
                  {(access ? access.coming : t.launch.coming).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="st-note">{access ? access.note : t.launch.note}</p>
          </div>
        </section>

        {/* 6.10 FAQ — все десять вопросов, `<details>` без JS. */}
        <section className="st-section" id="faq" aria-labelledby="st-faq-title">
          <div className="wrap">
            <h2 id="st-faq-title">{t.faq.title}</h2>
            <div className="st-faq">
              {faqItems.map((item) => (
                <details key={item.question}>
                  <summary>{item.question}</summary>
                  <p>{item.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* 6.11 Финал: одно основное действие. */}
        <section className="st-section st-section-alt st-final" aria-labelledby="st-final-title">
          <div className="wrap">
            <p className="st-tagline">{t.tagline}</p>
            <h2 id="st-final-title">{t.final.title}</h2>
            <p>
              {access
                ? primaryIsApp
                  ? access.finalText
                  : access.finalTextNeutral
                : primaryIsApp
                  ? t.final.text
                  : t.final.textNeutral}
            </p>
            <div className="st-actions">
              <a className="cta" href={view.primary.href} data-cta={view.primary.id} data-entry={primaryIsApp ? 'stories' : undefined}>
                {label(view.primary)}
              </a>
            </div>
          </div>
        </section>
      </main>

      {/* Подвал §6.11 / Р-STL-14: оператор — из опубликованной оферты,
          ссылки — только на существующие `/legal/<slug>`. Правила
          Story‑Tales (приложение к оферте, `/legal/story-tales-rules`,
          20.10.2026) — ссылкой `narratorConsent` из `release.json`; без неё
          — пометка словами, а не пустая ссылка. Платформа — одна
          ненавязчивая ссылка. */}
      <footer>
        <div className="wrap st-footer-grid">
          <p>
            <span>{t.footer.operatorLabel}: </span>
            {t.footer.operator}
          </p>
          {/* Рабочий контакт (Р-STL-19) — Telegram-бот платформы, тот же,
              что у основной кнопки. Реквизиты оферты пока не заполнены
              (doc/legal/offer.md §12), поэтому на них не ссылаемся. Нет
              бота — нет и строки: выдуманный контакт хуже отсутствующего. */}
          {contactBot ? (
            <p>
              <span>{t.footer.contactLabel}: </span>
              <a href={`https://t.me/${contactBot}`} data-contact="telegram">
                {t.footer.contactBot} @{contactBot}
              </a>
            </p>
          ) : null}
          <nav className="footer-links" aria-label={t.footer.navAriaLabel}>
            {footerLinks.map((link) => (
              <a key={link.href + link.label} href={link.href}>
                {link.label}
              </a>
            ))}
            {platformHref ? <a href={platformHref}>{t.footer.platform}</a> : null}
          </nav>
          {release.legalLinks.narratorConsent ? null : <p>{t.footer.consentNote}</p>}
          {locale !== 'ru' ? <p className="legal-notice">{t.footer.legalNoticeOtherLocale}</p> : null}
          <p>© {new Date().getFullYear()} viral4creators</p>
        </div>
      </footer>
    </div>
  );
}
