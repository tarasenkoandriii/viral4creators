import type { Metadata } from 'next';
import Image from 'next/image';
import { Fragment, type ReactNode } from 'react';
import { Faq } from '../../../components/Faq';
import { GreetingSampleGallery } from '../../../components/GreetingSampleGallery';
import { TutorialDemoGallery } from '../../../components/TutorialDemoGallery';
import { HeroPicture } from '../../../components/HeroPicture';
import { IllustrationIcon } from '../../../components/IllustrationIcon';
import { getDictionary } from '../../../lib/get-dictionary';
import { isLocale, locales, type Locale } from '../../../lib/i18n';
import { GREETING_SITE_URL, greetingPageUrl } from '../../../lib/greeting-host';
import { ogImageUrl, socialMeta } from '../../../lib/social-meta';
import { localeAlternates } from '../../../lib/alternates';
import { SubdomainHeader } from '../../../components/SubdomainHeader';
import { CLAUDE_REFERRAL_URL, SITE_URL, TELEGRAM_BOT_USERNAME, TMA_URL } from '../../../lib/content';
import { EntryActions } from '../../../components/EntryActions';
import { browserEntryLink } from '../../../lib/telegram-entry';
import {
  greetingFrame,
  greetingFramesAreReal,
} from '../../../lib/greeting-frames';
import { frameSizes } from '../../../lib/tutorial-frames';
import {
  greetingPrivacyItems,
  greetingSectionOrder,
  type GreetingSectionId,
} from '../../../lib/greeting-sections';
import { CompareSection } from './CompareSection';
import { OccasionGroups } from './OccasionGroups';
import { PersonaSection } from './PersonaSection';

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
 *  - рекламных демо с главной — это реклама
 *    товара, а человек пришёл за поздравлением (§7 ТЗ);
 *  - секции `features` ГЛАВНОЙ — она описывает разбор референса и
 *    анализ аудитории, к поздравлению неприменимые (§7 ТЗ). Своя
 *    секция возможностей у страницы теперь есть (этап 5 плана), и
 *    сделана она отдельным словарём и отдельными иконками — ровно по
 *    тому же доводу, по которому шаги не берут компонент с главной;
 *  - ИИ-консультанта. Его база знаний собирается из шагов, тарифов и
 *    FAQ ГЛАВНОГО лендинга, а действия вида `{kind:'faq', faqIndex}`
 *    адресуют вопросы по главному словарю. На этой странице он отвечал
 *    бы про другое и прокручивал не туда (находка 1.3 аудита). Чтобы он
 *    появился здесь честно, ему нужен третий вариант `page` на бэкенде
 *    и своя база — это отдельная работа, а не строчка в разметке;
 *  - секции группового режима (§4 п.5 ТЗ) — фичи №10 компаньон-ТЗ пока
 *    нет, а ТЗ прямо требует не публиковать пустое обещание;
 *  - секции «Вы в кадре» (§5.2 п.5 ТЗ Greeting 2.0) — пока. Режим «Я в
 *    кадре» в коде есть, но в проде за выключенным `PERSONA_ENABLED`.
 *    Секция построена на этапе J (`PersonaSection.tsx`, тексты
 *    `greetingsLanding.persona`) и включается одной константой в
 *    `lib/greeting-sections.ts`; до того её нет в разметке (тест
 *    `scripts/greeting-sections.test.ts`);
 *  - таблицы сравнения с рынком — пока. Обзор конкурентов сделан
 *    (`docs-tz/OBZOR-Konkurentov-Greetings.md`, В-8), секция построена
 *    (`CompareSection.tsx`, тексты `greetingsLanding.compare`) и
 *    сравнивает с КАТЕГОРИЯМИ, без названий и чужих цен; но факты о
 *    рынке подтверждает владелец, поэтому она за выключенной константой
 *    `COMPARE_SECTION_ENABLED` в `lib/greeting-sections.ts` (тест
 *    `scripts/greeting-compare.test.ts`).
 *
 * ## Этап H (ТЗ `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §5)
 *
 * Страница приведена к образцу обучалки: область стилей `.greeting-page`,
 * кадр в первом экране, «Как это работает» — четыре кадра в оправе
 * `.frame-shot` вместо карточек с иконкой, поводы — группами по регистру,
 * секции «Для кого» и «Данные и деликатные поводы». Порядок секций —
 * §5.2, из `greetingSectionOrder()`.
 *
 * Тексты сверены с кодом, а не с прошлой редакцией страницы. Две правки
 * из этой сверки стоит знать до того, как «возвращать как было»:
 *
 *  - «Без регистрации» убрано. Поздравление — проект, а все маршруты
 *    проектов закрыты `TelegramIdentityGuard` (`project.controller.ts`,
 *    `greeting-brief.controller.ts`): в обычном браузере без входа через
 *    Telegram мастер отвечает 401. Честно — «вход через Telegram, без
 *    отдельной регистрации»;
 *  - «перегенерация ничего не стоит» стало «денег не стоит: есть купленные
 *    генерации — тратится одна, иначе попытка идёт в суточный лимит».
 *    Рендер проходит `RenderAccessService.assertCanRender`: при
 *    выключенной стене (`FREE_TIER_WALL_ENABLED`) СНАЧАЛА списывается
 *    купленный кредит (`render-charge.ts`, путь `credit-or-limit`), и
 *    только без него срабатывает суточный потолок расхода режима
 *    (`PlanService.assertCanSpendUser`, `common/spend-limits.ts`);
 *  - «оплаты нет» стало «режимы сейчас бесплатны»: пакеты генераций
 *    покупаются независимо от `PLANS_BILLING_ENABLED`, бесплатна только
 *    смена режима — и лишь пока этот флаг выключен, поэтому «сейчас».
 *
 * Секция `steps` словаря на странице больше не выводится, но из словаря
 * НЕ удалена: её четыре пункта — источник тем обучалок по мастеру
 * поздравления в базе ИИ-консультанта
 * (`backend/scripts/build-assistant-knowledge.ts`, `greetingTopicsFor`).
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
    // `languages` — находка Ф-1 аудита живого лендинга: `alternates`
    // замещает унаследованный от layout объект целиком, и страница с
    // одним `canonical` оставляла пять локалей без hreflang.
    alternates: localeAlternates(greetingPageUrl, (l) => `/${l}`, locale),
    // См. Ф-7 в lib/social-meta.ts: без явного `twitter` страница
    // наследовала заголовок и описание главной.
    ...socialMeta({
      title: g.meta.title,
      description: g.meta.description,
      url: greetingPageUrl(locale),
      locale,
      image: ogImageUrl(GREETING_SITE_URL, 'greetings', locale),
    }),
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
  // трафик этой страницы от общего входа в мастер. Рядом с браузерной
  // кнопкой — «Открыть в Telegram» с тем же сценарием
  // (`startapp=e_greetings`, `lib/telegram-entry.ts`).
  const ctaHref = browserEntryLink('greetings', TMA_URL);
  /** Сняты ли для локали настоящие кадры — см. `lib/greeting-frames.ts`. */
  const realFrames = greetingFramesAreReal(locale);

  /**
   * Каждая секция — по своему идентификатору из `lib/greeting-sections.ts`.
   * Таблица полная (`Record`): новый идентификатор в списке не соберётся,
   * пока у него нет строки здесь. Строка `persona` есть всегда (этап J),
   * но вызывается, только если `persona` есть в `greetingSectionOrder()`,
   * то есть только при включённой `PERSONA_SECTION_ENABLED`.
   */
  const sections: Record<GreetingSectionId, () => ReactNode> = {
    /* Первый экран по образцу обучалки: текст слева, кадр справа на
       ≥900px, ниже — под текстом (`.hero-grid`, `.hero-shot` — общие
       правила этапа E обучалки). Кадр — статичный файл из `public/`, а
       не ролик из витрины: витрину меняет оператор, а лица из роликов
       пользователей в рекламном первом экране требуют отдельного
       согласия (§5.2 п.1). Без `priority`: на телефоне кадр ниже первого
       экрана, предзагрузка с высоким приоритетом там только мешала;
       `loading="eager"` — на десктопе кадр в первом экране. */
    hero: () => (
      <section className="hero">
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <span className="badge">{g.hero.badge}</span>
            <h1>{g.hero.title}</h1>
            <p>{g.hero.subtitle}</p>
            <div className="hero-actions">
              <EntryActions
                entry="greetings"
                tmaUrl={TMA_URL}
                botUsername={TELEGRAM_BOT_USERNAME}
                browserLabel={g.hero.cta}
                telegramLabel={dict.entryActions.telegramCta}
              />
            </div>
            <p className="hero-note">{g.hero.note}</p>
          </div>
          <div className="hero-shot frame-shot">
            <HeroPicture name="greetings-hero-v2" />
          </div>
        </div>
      </section>
    ),

    /* Витрина сразу под hero (§4 п.2 ТЗ лендинга): для этого запроса
       «покажи, что получится» убеждает раньше перечисления возможностей.
       Секции не будет вовсе, пока оператор ничего не отобрал. */
    samples: () => (
      /* @ts-expect-error Async Server Component — поддерживается Next
         App Router, но типы JSX в React 18 ещё не выражают async-узел */
      <GreetingSampleGallery
        dict={dict}
        title={g.samples.title}
        lead={g.samples.lead}
      />
    ),

    /* Четыре кадра мастера: повод и бриф → «Характер ролика» → сценарий →
       готовый ролик. Оговорка «это схемы» и картинки переключаются ОДНИМ
       списком (`GREETING_REAL_FRAME_LOCALES`), как у обучалки: страница,
       которая обещает только правду, не может сначала поменять картинки,
       а текст потом. У схемы `alt` пустой — смысл несёт подпись; у
       настоящего снимка — нет. */
    how: () => (
      <>
      <section className="frames" id="how">
        <div className="wrap">
          <h2>{g.how.title}</h2>
          <p className="section-lead">
            {realFrames ? g.how.leadReal : g.how.lead}
          </p>
          <ol className="frames-grid">
            {g.how.items.map((item, index) => {
              const frame = greetingFrame(locale, index + 1);
              return (
                <li
                  className={
                    frame.real ? 'frame-card frame-card-shot' : 'frame-card'
                  }
                  key={item.title}
                >
                  <div className="frame-shot">
                    <Image
                      src={frame.src}
                      alt={frame.real ? `${g.how.shotAlt}: ${item.title}` : ''}
                      aria-hidden={frame.real ? undefined : true}
                      width={frame.width}
                      height={frame.height}
                      sizes={frameSizes(frame.real)}
                      unoptimized={!frame.real}
                    />
                    <span className="step-number">{index + 1}</span>
                  </div>
                  <div className="frame-card-body">
                    <strong>{item.title}</strong>
                    <p>{item.text}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </section>
      <TutorialDemoGallery scenario="greetings" locale={locale} dict={dict} />
      </>
    ),

    occasions: () => (
      <section className="occasions" id="occasions">
        <div className="wrap">
          <h2>{g.occasions.title}</h2>
          <p className="section-lead">{g.occasions.lead}</p>
          <OccasionGroups
            occasions={g.occasions}
            labels={dict.sharedVideo.occasion}
          />
        </div>
      </section>
    ),

    /* «Вы в кадре» (§5.2 п.5). Тексты — только из раздела
       `greetingsLanding.persona`; вне этой строки и дополнений к
       «Данным» ниже страница их не читает (тест секций). */
    persona: () => <PersonaSection texts={g.persona} />,

    /* Возможности — то, что реально отличает ролик-поздравление от
       открытки (этап 5 плана docs-tz/AUDIT-Greeting-Landing-And-
       Upgrade-Plan.md). Обещано только то, что работает у ЛЮБОГО
       человека на любом режиме; голос отправителя назван вместе с
       режимом, где он доступен (Standard).

       Чего здесь намеренно НЕТ: наклеек и поиска музыки по свободным
       библиотекам. Обе фичи включаются ключами стенда (PIXABAY_API_KEY,
       JAMENDO/FREESOUND/MUBERT), и пока ключи не заданы, страница
       обещала бы то, чего человек не увидит.

       Иконки свои (`greet-feature-1…5`), а не `feature-N` с главной:
       те нарисованы под рекламный конвейер (находка 1.4 аудита). */
    features: () => (
      <section className="features" id="features">
        <div className="wrap">
          <h2>{g.features.title}</h2>
          <p className="section-lead">{g.features.lead}</p>
          <div className="features-grid">
            {g.features.items.map((feature, index) => (
              <div className="feature" key={feature.title}>
                <div className="feature-icon" aria-hidden="true">
                  <IllustrationIcon
                    name={`greet-feature-${index + 1}`}
                    size={20}
                  />
                </div>
                <h3>{feature.title}</h3>
                <p>{feature.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    ),

    /* «Для кого» — те же карточки `.audience-grid`, что у обучалки. */
    audience: () => (
      <section className="audience" id="audience">
        <div className="wrap">
          <h2>{g.audience.title}</h2>
          <div className="audience-grid">
            {g.audience.items.map((item) => (
              <article className="audience-card" key={item.title}>
                <strong>{item.title}</strong>
                <p>{item.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
    ),

    /* Ответ на главное возражение (§5.1): что будет с именем, фото,
       сюрпризом и соболезнованием. Каждая строка сверена с кодом:
       имя не попадает в заголовок публичной страницы само
       (`shared-video.service.ts`, заголовок по умолчанию — повод или его
       описание); удалённое фото стирается из хранилища
       (`GreetingReferenceService.remove` → `deleteBlob`); заставка
       «Открыть» на публичной странице (`app/video/[id]/page.tsx`);
       траурный регистр и проверка текста (`REGISTER_POLICY`,
       `textFitsRegister`); снятие страницы удаляет её файлы
       (`SharedVideoService.withdraw`); витрина — только отбор оператора
       (`showcasedAt`). Про лицо и голос — только вместе с секцией «Вы в
       кадре», той же константой (`greetingPrivacyItems`): проверка лица
       на фото тоже живёт за `PERSONA_ENABLED`. */
    privacy: () => (
      <section className="details" id="privacy">
        <div className="wrap">
          <h2>{g.privacy.title}</h2>
          <p className="section-lead">{g.privacy.lead}</p>
          <div className="login-grid">
            {greetingPrivacyItems(g.privacy.items, g.persona.privacy).map(
              (item) => (
                <article className="login-card" key={item.title}>
                  <strong>{item.title}</strong>
                  <p>{item.text}</p>
                </article>
              ),
            )}
          </div>
        </div>
      </section>
    ),

    /* «Сравнение» (§5.5, В-8): строка есть всегда, но вызывается, только
       если `compare` есть в `greetingSectionOrder()`, то есть при
       включённой `COMPARE_SECTION_ENABLED`. Тексты раздела страница
       больше нигде не читает (тест сравнения). */
    compare: () => <CompareSection texts={g.compare} />,

    /* Цена — по итогам сверки с кодом (§2 «Проверить на проде»), см.
       шапку файла: «сейчас», разрешение по режиму (`MAX_RESOLUTION` в
       `project/greeting-config.ts`, с фото — потолок 720p у
       reference-to-video) и суточный лимит. */
    price: () => (
      <section className="details" id="price">
        <div className="wrap">
          <h2>{g.price.title}</h2>
          <p className="section-lead">{g.price.text}</p>
        </div>
      </section>
    ),

    /* Свой набор вопросов; `data-faq-index` не выводится, чтобы не
       спорить с адресацией ИИ-консультанта главной страницы. */
    faq: () => (
      <section className="faq" id="faq">
        <div className="wrap">
          <h2>{g.faq.title}</h2>
          <Faq items={g.faq.items} />
        </div>
      </section>
    ),

    finalCta: () => (
      <section className="final-cta">
        <div className="wrap">
          <h2>{g.finalCta.title}</h2>
          <p>{g.finalCta.text}</p>
          <div className="entry-actions">
            <EntryActions
              entry="greetings"
              tmaUrl={TMA_URL}
              botUsername={TELEGRAM_BOT_USERNAME}
              browserLabel={g.finalCta.cta}
              telegramLabel={dict.entryActions.telegramCta}
            />
          </div>
        </div>
      </section>
    ),
  };

  return (
    <>
      {/* Шапка добавлена по находке Ф-2 того же аудита: переключателя
          языка на поддомене не было вовсе, и пять локалей существовали
          только для того, кто угадает адрес. */}
      <SubdomainHeader dict={dict} locale={locale} ctaHref={ctaHref} />
      {/* `greeting-page` — область действия типографики и первого экрана
          этапа H: `globals.css` один на все площадки, и правила для
          `h1`/`h2` или `.hero` без этой обёртки уехали бы на главную,
          обучалку, блог и правовые страницы. */}
      <main id="top" className="greeting-page">
        {greetingSectionOrder().map((id) => (
          <Fragment key={id}>{sections[id]()}</Fragment>
        ))}
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
            {/* Доп. запрос владельца продукта: реферальная ссылка Claude
                стоит во ВСЕХ футерах, а не только на главном хосте —
                поддомены посещают отдельно, и сокращённый футер здесь
                сокращён ради навигации, а не ради этой строки. Тот же
                ключ словаря и тот же адрес из `lib/content`, что у
                общего футера. */}
            <a href={CLAUDE_REFERRAL_URL} target="_blank" rel="noreferrer">
              {dict.footer.madeWithClaude}
            </a>
          </nav>
          {locale !== 'ru' && (
            <p className="legal-notice">{dict.footer.legalNoticeOtherLocale}</p>
          )}
        </div>
      </footer>
    </>
  );
}
